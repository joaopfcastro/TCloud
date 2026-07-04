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

  test("clique em .ce-popover-item[data-item-name='delete'] confirmado chama runBlockTune('delete') e previne default", () => {
    const item = makePopoverItem("delete", "Clique para excluir", { confirmation: true });

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);

    expect(adapter.runBlockTune).toHaveBeenCalledTimes(1);
    expect(adapter.runBlockTune).toHaveBeenCalledWith("delete", { preferredRange: null });
    expect(event.defaultPrevented).toBe(true);
  });

  test("1o clique em .ce-popover-item[data-item-name='delete'] (sem confirmação) NÃO dispara runBlockTune", () => {
    const item = makePopoverItem("delete", "Excluir");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(event);
    expect(adapter.runBlockTune).not.toHaveBeenCalled();
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
