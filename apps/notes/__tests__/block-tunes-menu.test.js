import {
  jest,
  describe,
  beforeEach,
  afterEach,
  test,
  expect,
} from "@jest/globals";
import {
  TCloudInlineToolbarController,
  EditorAdapter,
} from "../editor-adapter.js";
import { QuoteTool, CodeBlockTool, DividerTool } from "../editor-tools.js";

function buildEditorDom(blockTexts = ["Bloco 1", "Bloco 2", "Bloco 3"]) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.className = "editorjs-host";
  blockTexts.forEach((text, index) => {
    const block = document.createElement("div");
    block.className = "ce-block";
    block.dataset.id = `block-${index}`;
    const content = document.createElement("div");
    content.className = "ce-block__content";
    content.setAttribute("contenteditable", "true");
    content.textContent = text;
    block.appendChild(content);
    host.appendChild(block);
  });
  document.body.appendChild(host);
  return host;
}

function buildTuneAdapterMock(host) {
  return {
    holder: host,
    lastSavedContent: {
      blocks: Array.from(host.querySelectorAll(".ce-block")).map((block, index) => ({
        id: `block-${index}`,
        type: "paragraph",
        data: { text: block.querySelector(".ce-block__content").textContent },
      })),
    },
    init: jest.fn(async () => {}),
    deleteBlock: jest.fn(async () => ({ changed: true })),
    deleteSelectedBlocks: jest.fn(async (preferredRange) => ({
      changed: true,
      changedCount: 2,
      skippedCount: 0,
      preferredRange,
    })),
    swapBlocks: jest.fn(async (from, to) => ({ changed: true, from, to })),
    shiftSelectedBlocks: jest.fn(async (direction, preferredRange) => ({
      changed: true,
      direction,
      preferredRange,
    })),
    getSelectedBlockIndexes: jest.fn(() => [0]),
    currentBlockIndex: jest.fn(async () => 1),
    blockSelectionController: {
      hasMultiBlockSelection: jest.fn(() => false),
    },
  };
}

describe("Stream C — runBlockTune delega corretamente", () => {
  let host;
  let adapter;

  beforeEach(() => {
    host = buildEditorDom(["Alpha", "Beta", "Gamma", "Delta"]);
    adapter = buildTuneAdapterMock(host);
    adapter.runBlockTune = EditorAdapter.prototype.runBlockTune.bind(adapter);
  });

  test("runBlockTune('delete') em bloco único chama adapter.deleteBlock()", async () => {
    adapter.blockSelectionController.hasMultiBlockSelection.mockReturnValue(false);
    const result = await adapter.runBlockTune("delete");
    expect(adapter.deleteBlock).toHaveBeenCalledTimes(1);
    expect(adapter.deleteSelectedBlocks).not.toHaveBeenCalled();
    expect(result).toEqual({ changed: true });
  });

  test("runBlockTune('delete') em multi-seleção chama adapter.deleteSelectedBlocks()", async () => {
    adapter.blockSelectionController.hasMultiBlockSelection.mockReturnValue(true);
    const range = document.createRange();
    const result = await adapter.runBlockTune("delete", { preferredRange: range });
    expect(adapter.deleteSelectedBlocks).toHaveBeenCalledTimes(1);
    expect(adapter.deleteSelectedBlocks).toHaveBeenCalledWith(range);
    expect(adapter.deleteBlock).not.toHaveBeenCalled();
    expect(result.changed).toBe(true);
  });

  test("runBlockTune('moveUp') em bloco único chama adapter.swapBlocks(index, target)", async () => {
    adapter.blockSelectionController.hasMultiBlockSelection.mockReturnValue(false);
    adapter.getSelectedBlockIndexes.mockReturnValue([1]);
    adapter.currentBlockIndex.mockResolvedValue(1);
    await adapter.runBlockTune("moveUp");
    expect(adapter.swapBlocks).toHaveBeenCalledTimes(1);
    expect(adapter.swapBlocks).toHaveBeenCalledWith(1, 0);
    expect(adapter.shiftSelectedBlocks).not.toHaveBeenCalled();
  });

  test("runBlockTune('moveDown') em multi-seleção chama adapter.shiftSelectedBlocks(1, range)", async () => {
    adapter.getSelectedBlockIndexes.mockReturnValue([0, 1]);
    const range = document.createRange();
    await adapter.runBlockTune("moveDown", { preferredRange: range });
    expect(adapter.shiftSelectedBlocks).toHaveBeenCalledTimes(1);
    expect(adapter.shiftSelectedBlocks).toHaveBeenCalledWith(1, range);
    expect(adapter.swapBlocks).not.toHaveBeenCalled();
  });
});

describe("Stream C — installPopoverDelegation do TCloudInlineToolbarController", () => {
  let host;
  let adapter;
  let controller;

  beforeEach(() => {
    host = buildEditorDom(["Alpha", "Beta", "Gamma"]);
    adapter = {
      holder: host,
      runBlockTune: jest.fn(async () => ({ changed: true })),
      convertCurrentBlock: jest.fn(async () => ({ changed: true })),
      blockSelectionController: {
        freeze: jest.fn(),
        captureFromRange: jest.fn(),
        captureFromCurrentSelection: jest.fn(),
        hasMultiBlockSelection: jest.fn(() => false),
        getSelectedIndexes: jest.fn(() => []),
        blocks: jest.fn(() => []),
      },
    };
    controller = new TCloudInlineToolbarController(adapter);
  });

  afterEach(() => {
    if (controller) controller.destroy();
  });

  function makePopoverItem(name, label, { confirmation = false } = {}) {
    const item = document.createElement("div");
    item.className = "ce-popover-item";
    if (confirmation) item.classList.add("ce-popover-item--confirmation");
    if (name) item.dataset.itemName = name;
    const title = document.createElement("div");
    title.className = "ce-popover-item__title";
    title.textContent = label;
    item.appendChild(title);
    document.body.appendChild(item);
    return item;
  }

  test("clique em .ce-popover-item[data-item-name='delete'] exclui imediatamente e previne default", () => {
    const item = makePopoverItem("delete", "Excluir");

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.runBlockTune).toHaveBeenCalledTimes(1);
    expect(adapter.runBlockTune).toHaveBeenCalledWith("delete", { preferredRange: null });
    expect(event.defaultPrevented).toBe(true);
  });

  test("clique em .ce-popover-item[data-item-name='quote'] chama convertCurrentBlock('quote', {}) e previne default", () => {
    const item = makePopoverItem("quote", "Citação");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.convertCurrentBlock).toHaveBeenCalledTimes(1);
    expect(adapter.convertCurrentBlock).toHaveBeenCalledWith("quote", {});
    expect(event.defaultPrevented).toBe(true);
  });

  test("clique em 'Lista numerada' (data-item-name='list') converte para list style='ordered'", () => {
    const item = makePopoverItem("list", "Lista numerada");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.convertCurrentBlock).toHaveBeenCalledWith("list", { style: "ordered" });
  });

  test("clique em 'Checklist' (data-item-name='list') converte para tool 'todo' (nao list)", () => {
    const item = makePopoverItem("list", "Checklist");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.convertCurrentBlock).toHaveBeenCalledWith("todo", {});
  });

  test("clique em 'Lista' (data-item-name='list') converte para list style='unordered'", () => {
    const item = makePopoverItem("list", "Lista");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.convertCurrentBlock).toHaveBeenCalledWith("list", { style: "unordered" });
  });

  test("clique em 'Título 1' (data-item-name='header') converte para header level=1", () => {
    const item = makePopoverItem("header", "Título 1");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.convertCurrentBlock).toHaveBeenCalledWith("header", { level: 1 });
  });

  test("clique em .ce-popover-item sem data-item-name e com título desconhecido NÃO chama runBlockTune/convertCurrentBlock", () => {
    const item = makePopoverItem("", "Duplicar");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.runBlockTune).not.toHaveBeenCalled();
    expect(adapter.convertCurrentBlock).not.toHaveBeenCalled();
  });
});

describe("Stream C — conversionConfig das tools de bloco", () => {
  test("QuoteTool.conversionConfig === { export: 'text', import: 'text' }", () => {
    expect(QuoteTool.conversionConfig).toEqual({ export: "text", import: "text" });
  });

  test("CodeBlockTool.conversionConfig === { export: 'code', import: 'code' }", () => {
    expect(CodeBlockTool.conversionConfig).toEqual({ export: "code", import: "code" });
  });

  test("DividerTool.conversionConfig === { export: 'text', import: 'text' }", () => {
    expect(DividerTool.conversionConfig).toEqual({ export: "text", import: "text" });
  });
});

describe("Regressão — currentBlockIndex com fallback quando popover rouba o foco", () => {
  let host;
  let adapter;

  beforeEach(() => {
    host = buildEditorDom(["Alpha", "Beta", "Gamma"]);
    adapter = {
      holder: host,
      editor: { blocks: { getCurrentBlockIndex: () => -1 } },
      root: host,
      init: jest.fn(async () => {}),
    };
    adapter.currentBlockIndex = EditorAdapter.prototype.currentBlockIndex.bind(adapter);
  });

  test("retorna índice do bloco .is-tcloud-active-block quando seleção e API falham", async () => {
    const blocks = host.querySelectorAll(".ce-block");
    blocks[1].classList.add("is-tcloud-active-block");
    // Sem seleção no editor e API retornando -1 (popover aberto roubou foco)
    const index = await adapter.currentBlockIndex();
    expect(index).toBe(1);
  });

  test("retorna índice do bloco .ce-block--selected quando não há active-block", async () => {
    const blocks = host.querySelectorAll(".ce-block");
    blocks[2].classList.add("ce-block--selected");
    const index = await adapter.currentBlockIndex();
    expect(index).toBe(2);
  });
});

describe("Stream D — Popover com multisseleção", () => {
  let host;
  let adapter;
  let controller;

  beforeEach(() => {
    host = buildEditorDom(["Alpha", "Beta", "Gamma", "Delta"]);
    adapter = {
      holder: host,
      lastSavedContent: {
        blocks: Array.from(host.querySelectorAll(".ce-block")).map((block, index) => ({
          id: `block-${index}`,
          type: "paragraph",
          data: { text: block.querySelector(".ce-block__content").textContent },
        })),
      },
      init: jest.fn(async () => {}),
      deleteBlock: jest.fn(async () => ({ changed: true })),
      deleteSelectedBlocks: jest.fn(async (preferredRange) => ({
        changed: true,
        changedCount: 2,
        skippedCount: 0,
        preferredRange,
      })),
      swapBlocks: jest.fn(async (from, to) => ({ changed: true, from, to })),
      shiftSelectedBlocks: jest.fn(async (direction, preferredRange) => ({
        changed: true,
        direction,
        preferredRange,
      })),
      getSelectedBlockIndexes: jest.fn(() => [0, 1]),
      currentBlockIndex: jest.fn(async () => 1),
      convertCurrentBlock: jest.fn(async () => ({ changed: true })),
      convertSelectedBlocks: jest.fn(async () => ({ changed: true })),
      hasMultiBlockSelection: jest.fn(() => false),
      popoverController: {
        markBatchAction: jest.fn(),
        clear: jest.fn(),
      },
      blockSelectionController: {
        hasMultiBlockSelection: jest.fn(() => false),
      },
    };
    adapter.runBlockTune = EditorAdapter.prototype.runBlockTune.bind(adapter);
    controller = new TCloudInlineToolbarController(adapter);
  });

  afterEach(() => {
    if (controller) controller.destroy();
  });

  function makePopoverItem(name, label) {
    const item = document.createElement("div");
    item.className = "ce-popover-item";
    if (name) item.dataset.itemName = name;
    const title = document.createElement("div");
    title.className = "ce-popover-item__title";
    title.textContent = label;
    item.appendChild(title);
    document.body.appendChild(item);
    return item;
  }

  test("runBlockTune('delete') multibloco chama markBatchAction(true) e deleteSelectedBlocks", async () => {
    adapter.blockSelectionController.hasMultiBlockSelection.mockReturnValue(true);
    const range = document.createRange();
    await adapter.runBlockTune("delete", { preferredRange: range });
    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(true);
    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(false);
    expect(adapter.deleteSelectedBlocks).toHaveBeenCalledWith(range);
  });

  test("runBlockTune('delete') bloco único NÃO chama markBatchAction", async () => {
    adapter.blockSelectionController.hasMultiBlockSelection.mockReturnValue(false);
    await adapter.runBlockTune("delete");
    expect(adapter.popoverController.markBatchAction).not.toHaveBeenCalled();
  });

  test("runBlockTune('moveUp') multibloco chama markBatchAction e shiftSelectedBlocks(-1, range)", async () => {
    adapter.blockSelectionController.hasMultiBlockSelection.mockReturnValue(true);
    adapter.getSelectedBlockIndexes.mockReturnValue([1, 2]);
    const range = document.createRange();
    await adapter.runBlockTune("moveUp", { preferredRange: range });
    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(true);
    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(false);
    expect(adapter.shiftSelectedBlocks).toHaveBeenCalledWith(-1, range);
    expect(adapter.swapBlocks).not.toHaveBeenCalled();
  });

  test("runBlockTune('moveDown') multibloco chama markBatchAction e shiftSelectedBlocks(1, range)", async () => {
    adapter.blockSelectionController.hasMultiBlockSelection.mockReturnValue(true);
    adapter.getSelectedBlockIndexes.mockReturnValue([0, 1]);
    const range = document.createRange();
    await adapter.runBlockTune("moveDown", { preferredRange: range });
    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(true);
    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(false);
    expect(adapter.shiftSelectedBlocks).toHaveBeenCalledWith(1, range);
  });

  test("runBlockTune('moveUp') bloco único NÃO chama markBatchAction", async () => {
    adapter.blockSelectionController.hasMultiBlockSelection.mockReturnValue(false);
    adapter.getSelectedBlockIndexes.mockReturnValue([1]);
    adapter.currentBlockIndex.mockResolvedValue(1);
    await adapter.runBlockTune("moveUp");
    expect(adapter.popoverController.markBatchAction).not.toHaveBeenCalled();
    expect(adapter.swapBlocks).toHaveBeenCalledWith(1, 0);
  });

  test("clique em 'Mover para cima' no popover limpa popoverController e chama runBlockTune('moveUp')", () => {
    adapter.runBlockTune = jest.fn(async () => ({ changed: true }));
    const item = makePopoverItem("move-up", "Mover para cima");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.popoverController.clear).toHaveBeenCalledWith("move-up-block");
    expect(adapter.runBlockTune).toHaveBeenCalledWith("moveUp", { preferredRange: null });
    expect(event.defaultPrevented).toBe(true);
  });

  test("clique em 'Mover para baixo' no popover limpa popoverController e chama runBlockTune('moveDown')", () => {
    adapter.runBlockTune = jest.fn(async () => ({ changed: true }));
    const item = makePopoverItem("move-down", "Mover para baixo");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.popoverController.clear).toHaveBeenCalledWith("move-down-block");
    expect(adapter.runBlockTune).toHaveBeenCalledWith("moveDown", { preferredRange: null });
    expect(event.defaultPrevented).toBe(true);
  });

  test("clique em 'Excluir' multibloco limpa popover e chama runBlockTune('delete')", () => {
    adapter.runBlockTune = jest.fn(async () => ({ changed: true }));
    adapter.hasMultiBlockSelection.mockReturnValue(true);
    const item = makePopoverItem("delete", "Excluir");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.popoverController.clear).toHaveBeenCalledWith("delete-block");
    expect(adapter.runBlockTune).toHaveBeenCalledWith("delete", { preferredRange: null });
    expect(event.defaultPrevented).toBe(true);
  });

  test("clique em 'Citação' multibloco chama convertSelectedBlocks e markBatchAction", async () => {
    adapter.hasMultiBlockSelection.mockReturnValue(true);
    const item = makePopoverItem("quote", "Citação");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(true);
    expect(adapter.convertSelectedBlocks).toHaveBeenCalledWith("quote", {}, null);
    expect(adapter.popoverController.clear).toHaveBeenCalledWith("convert-block");
    expect(event.defaultPrevented).toBe(true);
  });

  test("clique em 'Título 1' multibloco chama convertSelectedBlocks('header', {level:1})", async () => {
    adapter.hasMultiBlockSelection.mockReturnValue(true);
    const item = makePopoverItem("header", "Título 1");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(adapter.convertSelectedBlocks).toHaveBeenCalledWith("header", { level: 1 }, null);
    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(true);
    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(false);
  });

  test("clique em 'Citação' bloco único chama convertCurrentBlock (sem markBatchAction)", async () => {
    adapter.hasMultiBlockSelection.mockReturnValue(false);
    const item = makePopoverItem("quote", "Citação");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(adapter.convertCurrentBlock).toHaveBeenCalledWith("quote", {});
    expect(adapter.popoverController.markBatchAction).not.toHaveBeenCalled();
    expect(adapter.popoverController.clear).toHaveBeenCalledWith("convert-block");
  });

  test("runBlockTune com erro libera markBatchAction(false)", async () => {
    adapter.blockSelectionController.hasMultiBlockSelection.mockReturnValue(true);
    adapter.deleteSelectedBlocks.mockRejectedValueOnce(new Error("test"));
    await expect(adapter.runBlockTune("delete")).rejects.toThrow("test");
    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(true);
    expect(adapter.popoverController.markBatchAction).toHaveBeenCalledWith(false);
  });
});
