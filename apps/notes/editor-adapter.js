import { CodeBlockTool, DividerTool, QuoteTool, TextColorTool, TodoTool } from "./editor-tools.js?v=notes-editor-visual-polish-20260526-9";
import {
  TCloudAudioTool,
  TCloudFileTool,
  TCloudFolderTool,
  TCloudImageTool,
  TCloudPdfTool,
  TCloudVideoTool,
  buildTCloudBlock,
  isTCloudBlockType,
} from "./tcloud-blocks.js";

function blockId() {
  const raw = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return raw.replace(/-/g, "").slice(0, 10);
}

function defaultEditorData() {
  return {
    time: Date.now(),
    blocks: [
      {
        id: blockId(),
        type: "paragraph",
        data: { text: "" },
      },
    ],
    version: "2.31.6",
  };
}

export function buildBlock(type, data = {}) {
  if (type === "paragraph") {
    return { id: blockId(), type, data: { text: data.text || "" } };
  }
  if (type === "header") {
    return { id: blockId(), type, data: { text: data.text || "", level: Number(data.level || 2) } };
  }
  if (type === "list") {
    return {
      id: blockId(),
      type,
      data: {
        style: data.style || "unordered",
        items: Array.isArray(data.items) ? data.items : [""],
      },
    };
  }
  if (type === "todo") {
    return { id: blockId(), type, data: { text: data.text || "", checked: Boolean(data.checked) } };
  }
  if (type === "quote") {
    return { id: blockId(), type, data: { text: data.text || "", caption: data.caption || "" } };
  }
  if (type === "codeBlock") {
    return { id: blockId(), type, data: { code: data.code || "" } };
  }
  if (type === "divider") {
    return { id: blockId(), type, data: {} };
  }
  if (isTCloudBlockType(type)) {
    return { id: blockId(), type, data: buildTCloudBlock(type, data) };
  }
  return { id: blockId(), type: "paragraph", data: { text: "" } };
}

function blockPlainText(block) {
  if (!block || typeof block !== "object") return "";
  const data = block.data || {};
  if (typeof data.text === "string") return data.text;
  if (typeof data.code === "string") return data.code;
  if (Array.isArray(data.items)) return data.items.join("\n");
  return "";
}

function convertBlockData(type, sourceText = "", data = {}) {
  const text = String(sourceText || "").trim();
  if (type === "paragraph") return { text };
  if (type === "header") return { level: Number(data.level || 2), text };
  if (type === "list") return { style: data.style || "unordered", items: text ? text.split(/\n+/) : [""] };
  if (type === "todo") return { text, checked: Boolean(data.checked) };
  if (type === "quote") return { text, caption: data.caption || "" };
  if (type === "codeBlock") return { code: sourceText || "" };
  if (type === "divider") return {};
  if (isTCloudBlockType(type)) return buildTCloudBlock(type, data);
  return data;
}

export class EditorAdapter {
  constructor({ holder, onChange, blockConfig = {} }) {
    this.holder = holder;
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.blockConfig = blockConfig;
    this.editor = null;
    this.readyPromise = null;
    this.rendering = false;
    this.history = [];
    this.historyIndex = -1;
    this.maxHistorySize = 100;
    this.historyDebounceTimeout = null;
    this.isUndoingOrRedoing = false;
  }

  async init(initialData) {
    if (this.readyPromise) return this.readyPromise;

    if (!window.EditorJS || !window.Paragraph || !window.Header || !window.EditorjsList) {
      throw new Error("Editor.js vendorizado nao carregou corretamente.");
    }

    this.editor = new window.EditorJS({
      holder: this.holder,
      autofocus: false,
      placeholder: "Escreva aqui. Use / para inserir blocos.",
      data: normalizeEditorData(initialData),
      i18n: {
        messages: {
          toolNames: {
            Text: "Texto",
            Heading: "Título",
            List: "Lista",
            "Unordered List": "Lista",
            "Ordered List": "Lista numerada",
            Checklist: "Checklist",
            Quote: "Citação",
            Code: "Código",
            Bold: "Negrito",
            Italic: "Itálico",
            Link: "Link",
            Color: "Cor",
            TextColor: "Cor",
            textColor: "Cor",
            "Convert to": "Converter para",
            "Inline Code": "Código inline",
            text: "Texto",
            heading: "Título",
            list: "Lista",
            ordered: "Lista numerada",
            unordered: "Lista",
            Ordered: "Lista numerada",
            Unordered: "Lista",
            checklist: "Checklist",
            quote: "Citação",
            code: "Código",
            bold: "Negrito",
            italic: "Itálico",
            link: "Link",
            tcloudFile: "Arquivo do TCloud",
            tcloudImage: "Imagem do TCloud",
            tcloudVideo: "Vídeo do TCloud",
            tcloudAudio: "Áudio do TCloud",
            tcloudPdf: "PDF do TCloud",
            tcloudFolder: "Pasta do TCloud",
          },
          tools: {
            link: {
              "Add a link": "Inserir link",
              "Link": "Link",
            },
            bold: {
              "Bold": "Negrito",
            },
            italic: {
              "Italic": "Itálico",
            },
          },
          blockTunes: {
            delete: {
              Delete: "Excluir",
              "Click to delete": "Clique para excluir",
            },
            moveUp: {
              "Move up": "Mover para cima",
              "Move Up": "Mover para cima",
            },
            moveDown: {
              "Move down": "Mover para baixo",
              "Move Down": "Mover para baixo",
            },
          },
          ui: {
            blockTunes: {
              toggler: {
                "Click to tune": "Ajustar bloco",
                "or drag to move": "ou arraste para mover",
              },
            },
            inlineToolbar: {
              converter: {
                "Convert to": "Converter para",
              },
            },
            toolbar: {
              toolbox: {
                Add: "Adicionar",
              },
            },
            popover: {
              Filter: "Filtrar",
              "Nothing found": "Nada encontrado",
              "Convert to": "Converter para",
              "Tune": "Ajustar",
              "Add": "Adicionar",
              "Move up": "Mover para cima",
              "Move down": "Mover para baixo",
              "Delete": "Excluir",
            },
          },
        },
      },
      tools: {
        paragraph: {
          class: window.Paragraph,
          inlineToolbar: ["bold", "italic", "link", "textColor"],
          config: {
            preserveBlank: true,
          },
        },
        header: {
          class: window.Header,
          inlineToolbar: ["bold", "italic", "link", "textColor"],
          config: {
            levels: [1, 2, 3],
            defaultLevel: 2,
          },
        },
        list: {
          class: window.EditorjsList,
          inlineToolbar: ["bold", "italic", "link", "textColor"],
          config: {
            defaultStyle: "unordered",
          },
        },
        textColor: {
          class: TextColorTool,
          config: {
            onInlineChange: () => {
              if (this.rendering) return;
              Promise.resolve(this.onChange()).catch((error) => {
                console.warn("Falha ao registrar alteracao inline", error);
              });
              if (!this.isUndoingOrRedoing) {
                this.triggerHistorySave();
              }
            },
          },
        },
        todo: {
          class: TodoTool,
        },
        quote: {
          class: QuoteTool,
        },
        codeBlock: {
          class: CodeBlockTool,
        },
        divider: {
          class: DividerTool,
        },
        tcloudFile: {
          class: TCloudFileTool,
          config: this.blockConfig,
        },
        tcloudImage: {
          class: TCloudImageTool,
          config: this.blockConfig,
        },
        tcloudVideo: {
          class: TCloudVideoTool,
          config: this.blockConfig,
        },
        tcloudAudio: {
          class: TCloudAudioTool,
          config: this.blockConfig,
        },
        tcloudPdf: {
          class: TCloudPdfTool,
          config: this.blockConfig,
        },
        tcloudFolder: {
          class: TCloudFolderTool,
          config: this.blockConfig,
        },
      },
      onChange: async () => {
        if (this.rendering) return;
        await this.onChange();
        if (!this.isUndoingOrRedoing) {
          this.triggerHistorySave();
        }
      },
    });

    this.readyPromise = this.editor.isReady;
    await this.readyPromise;
    return this.editor;
  }

  async render(data, { isNewNote = false } = {}) {
    await this.init(data);
    this.rendering = true;
    try {
      const normalized = normalizeEditorData(data);
      await this.editor.blocks.render(normalized);
      if (isNewNote) {
        this.history = [JSON.parse(JSON.stringify(normalized))];
        this.historyIndex = 0;
      } else if (!this.isUndoingOrRedoing) {
        this.pushHistoryState(normalized);
      }
    } finally {
      this.rendering = false;
    }
  }

  async saveHistoryImmediate() {
    try {
      const content = await this.save();
      const contentStr = JSON.stringify(content.blocks);
      const currentStr = this.history[this.historyIndex] ? JSON.stringify(this.history[this.historyIndex].blocks) : "";
      if (contentStr !== currentStr) {
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(JSON.parse(JSON.stringify(content)));
        this.historyIndex++;
        if (this.history.length > this.maxHistorySize) {
          this.history.shift();
          this.historyIndex--;
        }
      }
    } catch (e) {
      console.warn("Falha ao salvar estado do historico", e);
    }
  }

  triggerHistorySave() {
    clearTimeout(this.historyDebounceTimeout);
    this.historyDebounceTimeout = setTimeout(async () => {
      this.historyDebounceTimeout = null;
      await this.saveHistoryImmediate();
    }, 400);
  }

  pushHistoryState(content) {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(JSON.parse(JSON.stringify(content)));
    this.historyIndex++;
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
      this.historyIndex--;
    }
  }

  async undo() {
    if (this.historyDebounceTimeout) {
      clearTimeout(this.historyDebounceTimeout);
      this.historyDebounceTimeout = null;
      await this.saveHistoryImmediate();
    }

    if (this.historyIndex <= 0) {
      return;
    }
    
    let focusedIndex = await this.currentBlockIndex();

    this.historyIndex--;
    const stateToRestore = this.history[this.historyIndex];
    if (stateToRestore) {
      this.isUndoingOrRedoing = true;
      try {
        await this.render(stateToRestore);
        const blocksCount = stateToRestore.blocks.length;
        if (focusedIndex >= 0 && blocksCount > 0) {
          const targetIndex = Math.min(focusedIndex, blocksCount - 1);
          if (typeof this.editor.caret?.setToBlock === "function") {
            try {
              this.editor.caret.setToBlock(targetIndex, "end");
            } catch (err) {
              await this.focus();
            }
          }
        } else {
          await this.focus();
        }
      } finally {
        this.isUndoingOrRedoing = false;
      }
    }
  }

  async redo() {
    if (this.historyIndex >= this.history.length - 1) {
      return;
    }
    
    let focusedIndex = await this.currentBlockIndex();
    
    this.historyIndex++;
    const stateToRestore = this.history[this.historyIndex];
    if (stateToRestore) {
      this.isUndoingOrRedoing = true;
      try {
        await this.render(stateToRestore);
        const blocksCount = stateToRestore.blocks.length;
        if (focusedIndex >= 0 && blocksCount > 0) {
          const targetIndex = Math.min(focusedIndex, blocksCount - 1);
          if (typeof this.editor.caret?.setToBlock === "function") {
            try {
              this.editor.caret.setToBlock(targetIndex, "end");
            } catch (err) {
              await this.focus();
            }
          }
        } else {
          await this.focus();
        }
      } finally {
        this.isUndoingOrRedoing = false;
      }
    }
  }

  async save() {
    await this.init();
    return this.editor.save();
  }

  async clear() {
    await this.render(defaultEditorData());
  }

  async focus() {
    await this.init();
    if (typeof this.editor.caret?.setToLastBlock === "function") {
      this.editor.caret.setToLastBlock("end");
    }
  }

  async currentBlockIndex() {
    await this.init();
    if (typeof this.editor.blocks?.getCurrentBlockIndex === "function") {
      return this.editor.blocks.getCurrentBlockIndex();
    }
    return -1;
  }

  async insertSlashBlock(type, data = {}, { replaceCurrent = true } = {}) {
    const content = normalizeEditorData(await this.save());
    let index = await this.currentBlockIndex();
    if (!Number.isInteger(index) || index < 0) {
      index = content.blocks.length - 1;
    }
    const currentBlock = content.blocks[index];
    let sourceText = blockPlainText(currentBlock);
    if (replaceCurrent) {
      const lastSlash = sourceText.lastIndexOf("/");
      if (lastSlash !== -1) {
        sourceText = sourceText.substring(0, lastSlash);
      }
    }
    const nextBlock = buildBlock(type, replaceCurrent ? convertBlockData(type, sourceText, data) : data);

    if (replaceCurrent && content.blocks[index]) {
      content.blocks.splice(index, 1, nextBlock);
    } else {
      content.blocks.splice(index + 1, 0, nextBlock);
      index += 1;
    }

    content.time = Date.now();
    await this.render(content);
    if (typeof this.editor.caret?.setToBlock === "function") {
      try {
        this.editor.caret.setToBlock(index, "end");
      } catch (error) {
        await this.focus();
      }
    } else {
      await this.focus();
    }
  }

  async duplicateBlock() {
    await this.init();
    const index = await this.currentBlockIndex();
    if (index === -1) return;
    const content = normalizeEditorData(await this.save());
    const targetBlock = content.blocks[index];
    if (!targetBlock) return;
    const duplicatedBlock = buildBlock(targetBlock.type, JSON.parse(JSON.stringify(targetBlock.data)));
    content.blocks.splice(index + 1, 0, duplicatedBlock);
    content.time = Date.now();
    await this.render(content);
    if (typeof this.editor.caret?.setToBlock === "function") {
      try {
        this.editor.caret.setToBlock(index + 1, "end");
      } catch (error) {
        await this.focus();
      }
    } else {
      await this.focus();
    }
  }

  async deleteBlockAtIndex(index) {
    await this.init();
    if (index === -1) return;
    const content = normalizeEditorData(await this.save());
    if (content.blocks.length <= 1) {
      content.blocks = [buildBlock("paragraph", { text: "" })];
    } else {
      content.blocks.splice(index, 1);
    }
    content.time = Date.now();
    await this.render(content);
    const newFocusIndex = Math.min(index, content.blocks.length - 1);
    if (typeof this.editor.caret?.setToBlock === "function") {
      try {
        this.editor.caret.setToBlock(newFocusIndex, "end");
      } catch (error) {
        await this.focus();
      }
    } else {
      await this.focus();
    }
    await this.onChange();
    this.triggerHistorySave();
  }

  async deleteBlockByElement(element) {
    await this.init();
    const blockElement = element?.closest?.(".ce-block");
    if (!blockElement) return;
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
    const index = blocks.indexOf(blockElement);
    if (index === -1) return;
    await this.deleteBlockAtIndex(index);
  }

  async deleteBlock() {
    await this.deleteBlockAtIndex(await this.currentBlockIndex());
  }
}

export function normalizeEditorData(data) {
  if (!data || typeof data !== "object") {
    return defaultEditorData();
  }

  const blocks = Array.isArray(data.blocks) && data.blocks.length ? data.blocks : defaultEditorData().blocks;
  return {
    time: Number(data.time || Date.now()),
    blocks,
    version: String(data.version || "2.31.6"),
  };
}
