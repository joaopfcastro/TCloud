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

  test("clique em .ce-settings__button[data-item-name='delete'] confirmado chama runBlockTune('delete') e previne default", () => {
    const button = document.createElement("button");
    button.className = "ce-settings__button ce-settings__button--confirm";
    button.setAttribute("data-item-name", "delete");
    button.title = "Clique para excluir";
    document.body.appendChild(button);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(adapter.runBlockTune).toHaveBeenCalledTimes(1);
    expect(adapter.runBlockTune).toHaveBeenCalledWith("delete", { preferredRange: null });
    expect(event.defaultPrevented).toBe(true);
  });

  test("clique em .ce-conversion-tool[data-item-name='quote'] chama convertCurrentBlock('quote') e previne default", () => {
    const tool = document.createElement("div");
    tool.className = "ce-conversion-tool";
    tool.setAttribute("data-item-name", "quote");
    document.body.appendChild(tool);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    tool.dispatchEvent(event);

    expect(adapter.convertCurrentBlock).toHaveBeenCalledTimes(1);
    expect(adapter.convertCurrentBlock).toHaveBeenCalledWith("quote");
    expect(event.defaultPrevented).toBe(true);
  });

  test("clique em .ce-settings__button sem data-item-name e sem title reconhecido NÃO chama runBlockTune", () => {
    const button = document.createElement("button");
    button.className = "ce-settings__button";
    button.title = "Duplicar";
    document.body.appendChild(button);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

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
