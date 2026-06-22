import { jest, describe, beforeEach, afterEach, test, expect } from "@jest/globals";
import { TCloudBlockSelectionController } from "../editor-adapter.js";

function buildEditorDom(blockTexts = ["Bloco 1", "Bloco 2", "Bloco 3", "Bloco 4"]) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.className = "editorjs-host";
  blockTexts.forEach((text, index) => {
    const block = document.createElement("div");
    block.className = "ce-block";
    block.dataset.id = `block-${index}`;
    const content = document.createElement("div");
    content.className = "ce-block__content";
    content.contentEditable = "true";
    content.textContent = text;
    block.appendChild(content);
    host.appendChild(block);
  });
  document.body.appendChild(host);
  return host;
}

function buildAdapterMock(host) {
  return {
    holder: host,
    lastSavedContent: {
      blocks: Array.from(host.querySelectorAll(".ce-block")).map((block, index) => ({
        id: `block-${index}`,
        type: "paragraph",
        data: { text: block.querySelector(".ce-block__content").textContent },
      })),
    },
    deleteSelectedBlocks: jest.fn(async () => ({ changed: true, changedCount: 3, skippedCount: 0 })),
    currentBlockIndex: jest.fn(async () => 0),
  };
}

function rangeFromTo(host, startIndex, endIndex) {
  const blocks = host.querySelectorAll(".ce-block");
  const range = document.createRange();
  range.setStartBefore(blocks[startIndex]);
  range.setEndAfter(blocks[endIndex]);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

describe("TCloudBlockSelectionController — estado de seleção", () => {
  let host;
  let adapter;
  let controller;

  beforeEach(() => {
    host = buildEditorDom(["Bloco 1", "Bloco 2", "Bloco 3", "Bloco 4"]);
    adapter = buildAdapterMock(host);
    controller = new TCloudBlockSelectionController(adapter);
  });

  afterEach(() => {
    controller.destroy();
  });

  test("drag do Bloco 1 ao Bloco 3 popula indexes [0,1,2]", () => {
    const range = rangeFromTo(host, 0, 2);
    controller.captureFromRange(range, "drag");
    const snapshot = controller.getSnapshot();
    expect(snapshot.indexes).toEqual([0, 1, 2]);
    expect(snapshot.ids).toEqual(["block-0", "block-1", "block-2"]);
    expect(snapshot.anchorIndex).toBe(0);
    expect(snapshot.focusIndex).toBe(2);
  });

  test("bloco intermediário é 100% selecionado quando extremos são parciais", () => {
    const range = rangeFromTo(host, 0, 2);
    controller.captureFromRange(range, "partial-edges");
    const snapshot = controller.getSnapshot();
    expect(snapshot.indexes).toHaveLength(3);
    expect(snapshot.indexes).toContain(1);
  });

  test("hasMultiBlockSelection retorna false para seleção colapsada", () => {
    const selection = window.getSelection();
    selection.removeAllRanges();
    expect(controller.hasMultiBlockSelection(null)).toBe(false);
  });
});

describe("TCloudBlockSelectionController — renderização visual (CSS)", () => {
  let host;
  let adapter;
  let controller;

  beforeEach(() => {
    host = buildEditorDom(["A", "B", "C"]);
    adapter = buildAdapterMock(host);
    controller = new TCloudBlockSelectionController(adapter);
  });

  afterEach(() => controller.destroy());

  test("classe is-tcloud-range-selected aplicada aos blocos afetados", () => {
    const range = rangeFromTo(host, 0, 2);
    controller.captureFromRange(range, "visual");
    const blocks = host.querySelectorAll(".ce-block");
    expect(blocks[0].classList.contains("is-tcloud-range-selected")).toBe(true);
    expect(blocks[1].classList.contains("is-tcloud-range-selected")).toBe(true);
    expect(blocks[2].classList.contains("is-tcloud-range-selected")).toBe(true);
    expect(blocks[0].classList.contains("is-tcloud-selection-start")).toBe(true);
    expect(blocks[2].classList.contains("is-tcloud-selection-end")).toBe(true);
  });

  test("host recebe classe has-tcloud-multiblock-selection", () => {
    const range = rangeFromTo(host, 0, 2);
    controller.captureFromRange(range, "host-class");
    expect(host.classList.contains("has-tcloud-multiblock-selection")).toBe(true);
  });

  test("clearVisualSelection remove todas as classes is-selected", () => {
    const range = rangeFromTo(host, 0, 2);
    controller.captureFromRange(range, "before-clear");
    controller.clearVisualSelection();
    host.querySelectorAll(".ce-block").forEach((block) => {
      expect(block.classList.contains("is-tcloud-range-selected")).toBe(false);
      expect(block.classList.contains("is-tcloud-selection-start")).toBe(false);
      expect(block.classList.contains("is-tcloud-selection-end")).toBe(false);
    });
    expect(host.classList.contains("has-tcloud-multiblock-selection")).toBe(false);
  });
});

describe("TCloudBlockSelectionController — deleção em lote (Backspace/Delete)", () => {
  let host;
  let adapter;
  let controller;

  beforeEach(() => {
    host = buildEditorDom(["A", "B", "C", "D"]);
    adapter = buildAdapterMock(host);
    controller = new TCloudBlockSelectionController(adapter);
  });

  afterEach(() => controller.destroy());

  function dispatchKeyDown(key) {
    const content = host.querySelector(".ce-block__content");
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: content });
    document.dispatchEvent(event);
    return event;
  }

  test("Backspace com seleção múltipla chama deleteSelectedBlocks", () => {
    const range = rangeFromTo(host, 0, 2);
    controller.captureFromRange(range, "delete-setup");
    controller.freeze("delete-setup");
    dispatchKeyDown("Backspace");
    expect(adapter.deleteSelectedBlocks).toHaveBeenCalled();
  });

  test("Delete com seleção múltipla chama deleteSelectedBlocks", () => {
    const range = rangeFromTo(host, 1, 3);
    controller.captureFromRange(range, "delete-setup");
    controller.freeze("delete-setup");
    dispatchKeyDown("Delete");
    expect(adapter.deleteSelectedBlocks).toHaveBeenCalled();
  });

  test("Backspace sem seleção múltipla NÃO chama deleteSelectedBlocks", () => {
    const selection = window.getSelection();
    selection.removeAllRanges();
    dispatchKeyDown("Backspace");
    expect(adapter.deleteSelectedBlocks).not.toHaveBeenCalled();
  });
});

describe("TCloudBlockSelectionController — expansão por teclado (Shift+Arrow)", () => {
  let host;
  let adapter;
  let controller;

  beforeEach(() => {
    host = buildEditorDom(["A", "B", "C", "D", "E"]);
    adapter = buildAdapterMock(host);
    controller = new TCloudBlockSelectionController(adapter);
  });

  afterEach(() => controller.destroy());

  function dispatchShiftArrow(key) {
    const content = host.querySelector(".ce-block__content");
    const event = new KeyboardEvent("keydown", {
      key,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: content });
    document.dispatchEvent(event);
    return event;
  }

  test("Shift+ArrowDown expande seleção em um bloco", () => {
    controller.expandSelectionWithArrow(1);
    const snapshot = controller.getSnapshot();
    expect(snapshot.indexes).toEqual([0, 1]);
    controller.expandSelectionWithArrow(1);
    const snapshot2 = controller.getSnapshot();
    expect(snapshot2.indexes).toEqual([0, 1, 2]);
  });

  test("Shift+ArrowUp recolhe seleção em um bloco", () => {
    controller.expandSelectionWithArrow(1);
    controller.expandSelectionWithArrow(1);
    expect(controller.getSnapshot().indexes).toEqual([0, 1, 2]);
    controller.expandSelectionWithArrow(-1);
    expect(controller.getSnapshot().indexes).toEqual([0, 1]);
  });

  test("expansão não ultrapassa limites do documento", () => {
    controller.expandSelectionWithArrow(-1);
    expect(controller.getSnapshot().active).toBe(false);
  });
});

describe("TCloudBlockSelectionController — copy interceptado (Ctrl/Cmd+C)", () => {
  let host;
  let adapter;
  let controller;

  beforeEach(() => {
    host = buildEditorDom(["Alpha", "Beta", "Gamma"]);
    adapter = buildAdapterMock(host);
    controller = new TCloudBlockSelectionController(adapter);
  });

  afterEach(() => controller.destroy());

  test("copy extrai texto dos blocos selecionados", () => {
    const range = rangeFromTo(host, 0, 2);
    controller.captureFromRange(range, "copy-setup");
    controller.freeze("copy-setup");

    const clipboardData = {
      data: {},
      setData(format, value) {
        this.data[format] = value;
      },
    };
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    Object.defineProperty(event, "target", { value: host.querySelector(".ce-block__content") });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(clipboardData.data["text/plain"]).toContain("Alpha");
    expect(clipboardData.data["text/plain"]).toContain("Beta");
    expect(clipboardData.data["text/plain"]).toContain("Gamma");
    expect(clipboardData.data["application/x-tcloud-notes-blocks"]).toBeDefined();
    const parsed = JSON.parse(clipboardData.data["application/x-tcloud-notes-blocks"]);
    expect(parsed.tcloudNotesBlocks).toHaveLength(3);
  });

  test("copy sem seleção múltipla não intercepta", () => {
    const selection = window.getSelection();
    selection.removeAllRanges();
    const clipboardData = {
      data: {},
      setData: jest.fn(),
    };
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    Object.defineProperty(event, "target", { value: host.querySelector(".ce-block__content") });
    document.dispatchEvent(event);
    expect(clipboardData.setData).not.toHaveBeenCalled();
  });
});
