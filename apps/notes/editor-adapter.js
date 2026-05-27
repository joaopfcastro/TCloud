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

const TCLOUD_INDENT_MAX = 6;

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

function clampIndentLevel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(TCLOUD_INDENT_MAX, Math.round(number)));
}

function normalizeBlockIndent(data = {}) {
  const raw = data?.tcloudIndent;
  const level = clampIndentLevel(
    typeof raw === "object" && raw !== null
      ? raw.level
      : raw,
  );
  if (!level) return {};
  return { tcloudIndent: { level } };
}

function copyIndentData(data = {}) {
  return normalizeBlockIndent(data);
}

export function buildBlock(type, data = {}) {
  const indent = copyIndentData(data);
  if (type === "paragraph") {
    return { id: blockId(), type, data: { text: data.text || "", ...indent } };
  }
  if (type === "header") {
    return { id: blockId(), type, data: { text: data.text || "", level: Number(data.level || 2), ...indent } };
  }
  if (type === "list") {
    return {
      id: blockId(),
      type,
      data: {
        style: data.style || "unordered",
        items: Array.isArray(data.items) ? data.items : [""],
        ...indent,
      },
    };
  }
  if (type === "todo") {
    return { id: blockId(), type, data: { text: data.text || "", checked: Boolean(data.checked), ...indent } };
  }
  if (type === "quote") {
    return { id: blockId(), type, data: { text: data.text || "", caption: data.caption || "", ...indent } };
  }
  if (type === "codeBlock") {
    return { id: blockId(), type, data: { code: data.code || "", ...indent } };
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
  const indent = copyIndentData(data);
  if (type === "paragraph") return { text, ...indent };
  if (type === "header") return { level: Number(data.level || 2), text, ...indent };
  if (type === "list") return { style: data.style || "unordered", items: text ? text.split(/\n+/) : [""], ...indent };
  if (type === "todo") return { text, checked: Boolean(data.checked), ...indent };
  if (type === "quote") return { text, caption: data.caption || "", ...indent };
  if (type === "codeBlock") return { code: sourceText || "", ...indent };
  if (type === "divider") return {};
  if (isTCloudBlockType(type)) return buildTCloudBlock(type, data);
  return data;
}

function normalizeBlock(block) {
  if (!block || typeof block !== "object") return buildBlock("paragraph", { text: "" });
  const data = block.data && typeof block.data === "object" ? { ...block.data } : {};
  const level = clampIndentLevel(data.tcloudIndent?.level ?? data.tcloudIndent);
  if (level) {
    data.tcloudIndent = { level };
  } else {
    delete data.tcloudIndent;
  }
  return {
    ...block,
    id: block.id || blockId(),
    type: block.type || "paragraph",
    data,
  };
}

function getSelectionRange() {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  return selection.getRangeAt(0).cloneRange();
}

function restoreRange(range) {
  if (!range) return false;
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

function applyRangeInlineStyle(range, stylePatch) {
  if (!range) return null;
  const activeRange = range.cloneRange();
  const fragment = activeRange.extractContents();
  const span = document.createElement("span");
  Object.entries(stylePatch).forEach(([key, value]) => {
    if (value) span.style[key] = value;
  });
  span.appendChild(fragment);
  activeRange.insertNode(span);
  const nextRange = document.createRange();
  nextRange.selectNodeContents(span);
  restoreRange(nextRange);
  return nextRange.cloneRange();
}

function createToolbarButton({ label, icon, title, action, active = false, disabled = false }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tcloud-inline-toolbar__button";
  button.title = title || label;
  button.setAttribute("aria-label", title || label);
  button.dataset.tcloudAction = action;
  button.innerHTML = icon || label;
  button.disabled = Boolean(disabled);
  button.classList.toggle("is-active", Boolean(active));
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.addEventListener("mousedown", (event) => event.preventDefault());
  return button;
}

class TCloudInlineToolbarController {
  constructor(adapter) {
    this.adapter = adapter;
    this.savedRange = null;
    this.moreMenu = null;
    this.onSelectionChange = () => this.captureSelection();
    this.onPointerDown = (event) => {
      if (event.target.closest(".tcloud-inline-toolbar__menu, .ce-inline-toolbar, .tcloud-color-popover")) return;
      this.closeMenus();
    };
    this.onKeyDown = (event) => {
      if (event.key === "Escape") this.closeMenus();
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;
      if (!this.isEditorTarget(event.target) && !this.hasEditorSelection()) return;
      if (event.key === "Tab") {
        event.preventDefault();
        this.adapter.changeBlockIndent(event.shiftKey ? -1 : 1).catch(console.warn);
      } else if (isCmdOrCtrl && (event.key === "]" || event.key === "[")) {
        event.preventDefault();
        this.adapter.changeBlockIndent(event.key === "]" ? 1 : -1).catch(console.warn);
      }
    };
    this.onToolbarClick = (event) => {
      const target = event.target.closest("[data-tcloud-action]");
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      this.runAction(target.dataset.tcloudAction, target).catch(console.warn);
    };
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("click", this.onToolbarClick, true);
    this.observer = new MutationObserver(() => this.enhanceToolbar());
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  destroy() {
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("click", this.onToolbarClick, true);
    this.observer?.disconnect();
    this.closeMenus();
  }

  isEditorTarget(target) {
    return Boolean(target?.closest?.(".editorjs-host, .codex-editor"));
  }

  hasEditorSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const node = selection.getRangeAt(0).commonAncestorContainer;
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return this.isEditorTarget(element);
  }

  captureSelection() {
    const range = getSelectionRange();
    if (range && this.isEditorTarget(range.commonAncestorContainer?.parentElement || range.commonAncestorContainer)) {
      this.savedRange = range;
    }
    window.setTimeout(() => this.enhanceToolbar(), 0);
  }

  async runAction(action, target) {
    if (!action) return;
    if (this.savedRange) restoreRange(this.savedRange);
    if (action.startsWith("block:")) {
      const [, type, variant] = action.split(":");
      await this.adapter.convertCurrentBlock(type, {
        level: Number(variant || 2),
        style: variant || "unordered",
      });
      this.closeMenus();
      return;
    }
    if (action.startsWith("color:")) {
      const [, mode, value] = action.split(":");
      this.savedRange = applyRangeInlineStyle(this.savedRange, mode === "background" ? { backgroundColor: value } : { color: value });
    }
    if (action === "bold") document.execCommand("bold");
    if (action === "italic") document.execCommand("italic");
    if (action === "link") {
      const href = window.prompt("Link", "https://");
      if (href) document.execCommand("createLink", false, href);
    }
    if (action === "indent") await this.adapter.changeBlockIndent(1, this.savedRange);
    if (action === "outdent") await this.adapter.changeBlockIndent(-1, this.savedRange);
    if (action === "underline") document.execCommand("underline");
    if (action === "strike") document.execCommand("strikeThrough");
    if (action === "inline-code") document.execCommand("fontName", false, "monospace");
    if (action === "clear") document.execCommand("removeFormat");
    if (action === "copy") await navigator.clipboard?.writeText?.(window.getSelection()?.toString() || "");
    if (action === "more") this.toggleMoreMenu(target);
    if (action === "text-color") this.toggleColorMenu(target, "text");
    if (action === "highlight-color") this.toggleColorMenu(target, "background");
    if (!["more", "copy", "text-color", "highlight-color"].includes(action)) {
      await this.adapter.notifyManualChange();
      this.closeMenus();
    }
    this.enhanceToolbar();
  }

  closeMenus() {
    this.moreMenu?.remove();
    this.moreMenu = null;
    document.querySelectorAll(".tcloud-inline-toolbar__dropdown[open]").forEach((node) => node.removeAttribute("open"));
  }

  toggleMoreMenu(anchor) {
    if (this.moreMenu?.isConnected) {
      this.closeMenus();
      return;
    }
    const menu = document.createElement("div");
    menu.className = "tcloud-inline-toolbar__menu";
    menu.setAttribute("role", "menu");
    [
      ["copy", "Copiar seleção"],
      ["clear", "Limpar formatação"],
      ["block:paragraph", "Converter em texto"],
      ["block:quote", "Converter em citação"],
      ["block:codeBlock", "Converter em código"],
    ].forEach(([action, label]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.dataset.tcloudAction = action;
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.addEventListener("mousedown", (event) => event.preventDefault());
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(10, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 10));
    const top = Math.max(10, Math.min(rect.bottom + 8, window.innerHeight - menuRect.height - 10));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    this.moreMenu = menu;
  }

  toggleColorMenu(anchor, mode = "text") {
    if (this.moreMenu?.isConnected && this.moreMenu.dataset.mode === mode) {
      this.closeMenus();
      return;
    }
    this.closeMenus();
    const menu = document.createElement("div");
    menu.className = "tcloud-inline-toolbar__menu tcloud-inline-toolbar__color-grid";
    menu.dataset.mode = mode;
    menu.setAttribute("role", "menu");
    const colors = [
      ["Cinza", "#6B7280"],
      ["Vermelho", "#E5484D"],
      ["Laranja", "#F97316"],
      ["Amarelo", "#EAB308"],
      ["Verde", "#22C55E"],
      ["Azul", "#3478F6"],
      ["Roxo", "#8B5CF6"],
      ["Rosa", "#EC4899"],
      ["Preto", "#111827"],
      ["Branco", "#F8FAFC"],
    ];
    colors.forEach(([label, color]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.dataset.tcloudAction = `color:${mode}:${color}`;
      item.title = `${mode === "background" ? "Marca-texto" : "Cor"}: ${label}`;
      item.setAttribute("aria-label", item.title);
      item.innerHTML = `<span style="background:${color}"></span>`;
      item.addEventListener("mousedown", (event) => event.preventDefault());
      menu.appendChild(item);
    });
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(10, Math.min(rect.left, window.innerWidth - menuRect.width - 10));
    const top = Math.max(10, Math.min(rect.bottom + 8, window.innerHeight - menuRect.height - 10));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    this.moreMenu = menu;
  }

  blockTypeDropdown() {
    const details = document.createElement("details");
    details.className = "tcloud-inline-toolbar__dropdown";
    const summary = document.createElement("summary");
    summary.textContent = "Texto";
    summary.title = "Tipo de bloco";
    summary.setAttribute("aria-label", "Tipo de bloco");
    summary.addEventListener("mousedown", (event) => event.preventDefault());
    const menu = document.createElement("div");
    menu.className = "tcloud-inline-toolbar__dropdown-menu";
    [
      ["block:paragraph", "Texto normal"],
      ["block:header:1", "Título 1"],
      ["block:header:2", "Título 2"],
      ["block:header:3", "Título 3"],
      ["block:list:unordered", "Lista com marcadores"],
      ["block:list:ordered", "Lista numerada"],
      ["block:todo", "Checklist"],
      ["block:quote", "Citação"],
      ["block:codeBlock", "Código"],
    ].forEach(([action, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tcloudAction = action;
      button.textContent = label;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      menu.appendChild(button);
    });
    details.append(summary, menu);
    return details;
  }

  enhanceToolbar() {
    const toolbar = document.querySelector(".ce-inline-toolbar");
    if (!toolbar) return;
    if (toolbar.dataset.tcloudEnhanced === "true") {
      this.updateToolbarState(toolbar);
      return;
    }
    toolbar.dataset.tcloudEnhanced = "true";
    toolbar.classList.add("tcloud-inline-toolbar");
    const buttons = toolbar.querySelector(".ce-inline-toolbar__buttons") || toolbar;
    buttons.classList.add("tcloud-inline-toolbar__native");
    buttons.prepend(this.blockTypeDropdown(), this.divider());
    const extra = document.createElement("div");
    extra.className = "tcloud-inline-toolbar__group";
    const canOutdent = this.adapter.currentIndentLevelSync() > 0;
    [
      { action: "bold", label: "B", title: "Negrito", icon: "B", active: document.queryCommandState("bold") },
      { action: "italic", label: "I", title: "Itálico", icon: "<i>I</i>", active: document.queryCommandState("italic") },
      { action: "underline", label: "U", title: "Sublinhado", icon: "<u>U</u>", active: document.queryCommandState("underline") },
      { action: "strike", label: "S", title: "Tachado", icon: "<s>S</s>", active: document.queryCommandState("strikeThrough") },
      { action: "inline-code", label: "</>", title: "Código inline", icon: "&lt;/&gt;" },
      { action: "link", label: "Link", title: "Link", icon: "↗" },
      { action: "text-color", label: "A", title: "Cor do texto", icon: "A" },
      { action: "highlight-color", label: "Marca-texto", title: "Marca-texto", icon: "▱" },
      { action: "clear", label: "Tx", title: "Limpar formatação", icon: "Tx" },
      { action: "outdent", label: "←", title: "Recuar para a esquerda", icon: "⇤", disabled: !canOutdent },
      { action: "indent", label: "→", title: "Recuar para a direita", icon: "⇥" },
      { action: "more", label: "...", title: "Mais ações", icon: "•••" },
    ].forEach((item) => extra.appendChild(createToolbarButton(item)));
    buttons.append(this.divider(), extra);
    this.updateToolbarState(toolbar);
  }

  updateToolbarState(toolbar) {
    const canOutdent = this.adapter.currentIndentLevelSync() > 0;
    const outdent = toolbar.querySelector('[data-tcloud-action="outdent"]');
    if (outdent) {
      outdent.disabled = !canOutdent;
      outdent.setAttribute("aria-disabled", canOutdent ? "false" : "true");
    }
    toolbar.querySelector('[data-tcloud-action="underline"]')?.classList.toggle("is-active", document.queryCommandState("underline"));
    toolbar.querySelector('[data-tcloud-action="strike"]')?.classList.toggle("is-active", document.queryCommandState("strikeThrough"));
    toolbar.querySelector('[data-tcloud-action="bold"]')?.classList.toggle("is-active", document.queryCommandState("bold"));
    toolbar.querySelector('[data-tcloud-action="italic"]')?.classList.toggle("is-active", document.queryCommandState("italic"));
  }

  divider() {
    const divider = document.createElement("span");
    divider.className = "tcloud-inline-toolbar__divider";
    divider.setAttribute("aria-hidden", "true");
    return divider;
  }
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
    this.toolbarController = null;
    this.lastSavedContent = normalizeEditorData(null);
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
    if (!this.toolbarController) {
      this.toolbarController = new TCloudInlineToolbarController(this);
    }
    this.applyIndentAttributes(normalizeEditorData(initialData));
    return this.editor;
  }

  async render(data, { isNewNote = false } = {}) {
    await this.init(data);
    this.rendering = true;
    try {
      const normalized = normalizeEditorData(data);
      await this.editor.blocks.render(normalized);
      this.lastSavedContent = normalized;
      this.applyIndentAttributes(normalized);
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
    const content = normalizeEditorData(await this.editor.save());
    this.mergeIndentFromDom(content);
    this.lastSavedContent = content;
    this.applyIndentAttributes(content);
    return content;
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
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const node = selection.getRangeAt(0).commonAncestorContainer;
      const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const blockElement = element?.closest?.(".ce-block");
      const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
      const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
      const domIndex = blocks.indexOf(blockElement);
      if (domIndex >= 0) return domIndex;
    }
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
    const inheritedIndent = copyIndentData(currentBlock?.data || {});
    const nextBlock = buildBlock(type, replaceCurrent ? convertBlockData(type, sourceText, { ...data, ...inheritedIndent }) : { ...data, ...inheritedIndent });

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

  applyIndentAttributes(content = this.lastSavedContent) {
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
    const normalized = normalizeEditorData(content);
    blocks.forEach((element, index) => {
      const level = clampIndentLevel(normalized.blocks[index]?.data?.tcloudIndent?.level);
      element.dataset.tcloudIndent = String(level);
      element.style.setProperty("--tcloud-indent-level", String(level));
    });
  }

  mergeIndentFromDom(content) {
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
    content.blocks.forEach((block, index) => {
      const level = clampIndentLevel(blocks[index]?.dataset?.tcloudIndent);
      const data = block.data && typeof block.data === "object" ? block.data : {};
      if (level) {
        data.tcloudIndent = { level };
      } else {
        delete data.tcloudIndent;
      }
      block.data = data;
    });
  }

  currentIndentLevelSync() {
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const index = this.editor?.blocks?.getCurrentBlockIndex?.();
    if (Number.isInteger(index) && index >= 0) {
      const block = holderElement?.querySelectorAll(".ce-block")?.[index];
      return clampIndentLevel(block?.dataset?.tcloudIndent);
    }
    return 0;
  }

  blockIndexFromRange(range) {
    if (!range) return -1;
    const node = range.commonAncestorContainer;
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const blockElement = element?.closest?.(".ce-block");
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
    return blocks.indexOf(blockElement);
  }

  async notifyManualChange() {
    await this.onChange();
    if (!this.isUndoingOrRedoing) this.triggerHistorySave();
  }

  async changeBlockIndent(delta, preferredRange = null) {
    await this.init();
    const indexFromRange = this.blockIndexFromRange(preferredRange);
    const index = indexFromRange >= 0 ? indexFromRange : await this.currentBlockIndex();
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blockElement = holderElement?.querySelectorAll(".ce-block")?.[index];
    if (!blockElement) return 0;
    const nextLevel = clampIndentLevel(clampIndentLevel(blockElement.dataset.tcloudIndent) + Number(delta || 0));
    blockElement.dataset.tcloudIndent = String(nextLevel);
    blockElement.style.setProperty("--tcloud-indent-level", String(nextLevel));
    await this.notifyManualChange();
    return nextLevel;
  }

  async convertCurrentBlock(type, data = {}) {
    await this.init();
    const content = normalizeEditorData(await this.save());
    const index = await this.currentBlockIndex();
    if (!Number.isInteger(index) || index < 0 || !content.blocks[index]) return;
    const currentBlock = content.blocks[index];
    const sourceText = blockPlainText(currentBlock);
    const nextData = convertBlockData(type, sourceText, {
      ...data,
      ...copyIndentData(currentBlock.data || {}),
    });
    const nextBlock = buildBlock(type, nextData);
    nextBlock.id = currentBlock.id || nextBlock.id;
    content.blocks[index] = nextBlock;
    content.time = Date.now();
    await this.render(content);
    if (typeof this.editor.caret?.setToBlock === "function") {
      try {
        this.editor.caret.setToBlock(index, "end");
      } catch (error) {
        await this.focus();
      }
    }
    await this.notifyManualChange();
  }
}

export function normalizeEditorData(data) {
  if (!data || typeof data !== "object") {
    return defaultEditorData();
  }

  const blocks = Array.isArray(data.blocks) && data.blocks.length ? data.blocks.map(normalizeBlock) : defaultEditorData().blocks;
  return {
    time: Number(data.time || Date.now()),
    blocks,
    version: String(data.version || "2.31.6"),
  };
}
