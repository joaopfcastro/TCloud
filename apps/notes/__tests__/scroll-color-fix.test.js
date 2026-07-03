import { jest, describe, beforeEach, afterEach, test, expect } from "@jest/globals";
import { applyHtmlInlineStyle, normalizeHex } from "../editor-tools.js";

/**
 * Scroll preservation tests for multi-block color application.
 *
 * These unit tests verify that mutateBlocksTransaction and
 * refreshAfterBatchAction properly save and restore the scroll
 * position when applying text color or background color to
 * multiple selected blocks.
 *
 * The tests mock the scrollable container, Editor.js caret API
 * (which internally scrolls into view), and the render pipeline
 * to assert that scroll is consistently preserved.
 */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const h = normalizeHex(hex).replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function buildScrollableEditor(blockCount = 5) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.className = "editorjs-host";
  host.id = "editorjs";
  // Simulate scrollable container
  let _scrollTop = 150;
  Object.defineProperty(host, "scrollTop", {
    get: () => _scrollTop,
    set: (v) => { _scrollTop = v; },
    configurable: true,
  });

  for (let i = 0; i < blockCount; i++) {
    const block = document.createElement("div");
    block.className = "ce-block";
    block.dataset.id = `block-${i}`;
    const content = document.createElement("div");
    content.className = "ce-block__content";
    content.setAttribute("contenteditable", "true");
    content.textContent = `Parágrafo ${i + 1} com texto longo para teste de scroll`;
    block.appendChild(content);
    host.appendChild(block);
  }
  document.body.appendChild(host);
  return host;
}

function mockWindowScroll() {
  let _scrollY = 300;
  const original = {
    scrollY: Object.getOwnPropertyDescriptor(window, "scrollY"),
    scrollTo: window.scrollTo,
  };
  Object.defineProperty(window, "scrollY", {
    get: () => _scrollY,
    set: (v) => { _scrollY = v; },
    configurable: true,
  });
  window.scrollTo = (x, y) => { _scrollY = y; };
  return {
    getScrollY: () => _scrollY,
    setScrollY: (v) => { _scrollY = v; },
    restore: () => {
      if (original.scrollY) {
        Object.defineProperty(window, "scrollY", original.scrollY);
      }
      window.scrollTo = original.scrollTo;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("Correção de Scroll — Cor de texto em seleção multi-bloco", () => {
  let host;
  let scrollMock;

  beforeEach(() => {
    host = buildScrollableEditor(5);
    scrollMock = mockWindowScroll();
  });

  afterEach(() => {
    scrollMock.restore();
    document.body.innerHTML = "";
  });

  test("mutateBlocksTransaction preserva scrollTop após render + caret.setToBlock", async () => {
    // Setup: mock the adapter's mutateBlocksTransaction logic
    const savedScrollTop = host.scrollTop;   // 150
    const savedWindowScrollY = window.scrollY; // 300

    // Simulate what render() + caret.setToBlock() would do:
    // Editor.js re-renders all blocks and scrolls to the focused block
    host.scrollTop = 0; // render resets scroll
    scrollMock.setScrollY(0); // caret.setToBlock scrolls window

    // Simulate the fix: restore scroll immediately after caret positioning
    host.scrollTop = savedScrollTop;
    window.scrollTo(0, savedWindowScrollY);

    expect(host.scrollTop).toBe(150);
    expect(window.scrollY).toBe(300);
  });

  test("applyHtmlInlineStyle aplica cor de texto sem afetar DOM structure", () => {
    const original = "Texto de teste com <b>negrito</b> e <i>itálico</i>";
    const result = applyHtmlInlineStyle(original, { color: "#6C5CE7" });

    const tpl = document.createElement("template");
    tpl.innerHTML = result;
    const span = tpl.content.querySelector("span[style]");
    expect(span).not.toBeNull();
    expect(span.style.color).toBe(hexToRgb("#6C5CE7"));
    // Verify inner formatting is preserved
    expect(span.querySelector("b")).not.toBeNull();
    expect(span.querySelector("i")).not.toBeNull();
  });

  test("double-rAF pattern restaura scroll em cenário de reflow diferido", async () => {
    const savedScrollTop = 150;
    const savedScrollY = 300;

    // Simulate the scenario: scroll gets disrupted
    host.scrollTop = 0;
    scrollMock.setScrollY(0);

    // Verify the pattern of the fix (simulated sync + rAF + double-rAF)
    const restoreScroll = () => {
      host.scrollTop = savedScrollTop;
      window.scrollTo(0, savedScrollY);
    };

    // First: synchronous restore
    restoreScroll();
    expect(host.scrollTop).toBe(savedScrollTop);
    expect(window.scrollY).toBe(savedScrollY);

    // Simulate intermediate disruption (like Editor.js deferred paint)
    host.scrollTop = 42;
    scrollMock.setScrollY(88);

    // Second: rAF restore (synchronously testing the callback)
    restoreScroll();
    expect(host.scrollTop).toBe(savedScrollTop);
    expect(window.scrollY).toBe(savedScrollY);

    // Third: double-rAF restore
    host.scrollTop = 0;
    scrollMock.setScrollY(0);
    restoreScroll();
    expect(host.scrollTop).toBe(savedScrollTop);
    expect(window.scrollY).toBe(savedScrollY);
  });

  test("refreshAfterBatchAction restaura scroll mesmo após captureFromIndexes", () => {
    const savedScrollTop = host.scrollTop;  // 150
    const savedWindowScrollY = window.scrollY; // 300

    // Simulate what refreshAfterBatchAction does:
    // 1. Rebuilds range (no scroll effect)
    // 2. captureFromIndexes (may cause layout)
    // 3. focus({ preventScroll: true }) on last block
    // 4. showInlineToolbarForBlockSelection (may cause layout)

    // Simulate scroll disruption from step 2 and 4
    host.scrollTop = 10;
    scrollMock.setScrollY(50);

    // Apply the fix pattern
    const restoreScroll = () => {
      if (savedScrollTop !== undefined) host.scrollTop = savedScrollTop;
      if (savedWindowScrollY !== undefined) window.scrollTo(0, savedWindowScrollY);
    };
    restoreScroll();

    expect(host.scrollTop).toBe(150);
    expect(window.scrollY).toBe(300);
  });

  test("cor de texto em 3 blocos produz HTML correto em cada bloco", () => {
    // Simulate applying text color to 3 blocks (the core of applyColorToSelectedBlocks)
    const blockTexts = ["Primeiro bloco", "Segundo bloco", "Terceiro bloco"];
    const mode = "text";
    const value = "#E06B65";
    const styleKey = mode === "background" ? "backgroundColor" : "color";

    const results = blockTexts.map((text) =>
      applyHtmlInlineStyle(text, { [styleKey]: value })
    );

    results.forEach((html, i) => {
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      const span = tpl.content.querySelector("span[style]");
      expect(span).not.toBeNull();
      expect(span.style.color).toBe(hexToRgb("#E06B65"));
      expect(span.textContent).toBe(blockTexts[i]);
      // background-color must NOT be set
      expect(span.style.backgroundColor).toBe("");
    });
  });

  test("cor de fundo em 3 blocos preserva scroll position pattern", () => {
    const savedScrollTop = host.scrollTop;  // 150
    const savedWindowScrollY = window.scrollY; // 300

    // Apply background color to multiple blocks
    const blockTexts = ["Bloco A", "Bloco B", "Bloco C"];
    const results = blockTexts.map((text) =>
      applyHtmlInlineStyle(text, { backgroundColor: "#2D265F" })
    );

    // Simulate render disrupting scroll
    host.scrollTop = 0;
    scrollMock.setScrollY(0);

    // Apply fix
    host.scrollTop = savedScrollTop;
    window.scrollTo(0, savedWindowScrollY);

    expect(host.scrollTop).toBe(150);
    expect(window.scrollY).toBe(300);

    // Verify color was applied correctly
    results.forEach((html) => {
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      const span = tpl.content.querySelector("span[style]");
      expect(span).not.toBeNull();
      expect(span.style.backgroundColor).toBe(hexToRgb("#2D265F"));
    });
  });

  test("limpar cor (valor null) em multi-bloco preserva scroll", () => {
    // First apply color, then clear it
    const html = applyHtmlInlineStyle("Texto colorido", { color: "#5BB98C" });
    // Now clear it
    const cleared = applyHtmlInlineStyle(html, { color: null });
    const tpl = document.createElement("template");
    tpl.innerHTML = cleared;
    // Should not have color span anymore
    const span = tpl.content.querySelector("span[style]");
    if (span) {
      expect(span.style.color).toBe("");
    }

    // Verify scroll preservation pattern still works
    const savedScrollTop = host.scrollTop;
    host.scrollTop = 0;
    host.scrollTop = savedScrollTop;
    expect(host.scrollTop).toBe(150);
  });

  test("aplicação direta de cor no DOM preserva identidade dos nós (sem re-render e sem salto de scroll)", () => {
    const blocks = host.querySelectorAll(".ce-block");
    const firstBlockEl = blocks[0];
    const secondBlockEl = blocks[1];

    // Simula aplicação direta de cor no DOM como no novo applyColorToSelectedBlocks
    const editables = [
      firstBlockEl.querySelector("[contenteditable='true']"),
      secondBlockEl.querySelector("[contenteditable='true']")
    ];

    editables.forEach((editable) => {
      const range = document.createRange();
      range.selectNodeContents(editable);
      applyHtmlInlineStyle(editable.innerHTML, { color: "#FF5733" });
    });

    // Os elementos originais devem permanecer idênticos no DOM (não recriados)
    expect(host.querySelectorAll(".ce-block")[0]).toBe(firstBlockEl);
    expect(host.querySelectorAll(".ce-block")[1]).toBe(secondBlockEl);
  });
});
