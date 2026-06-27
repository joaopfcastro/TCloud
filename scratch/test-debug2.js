const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const logs = [];
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[PAGEERROR] ${err.message}\n${err.stack}`));

  await page.goto("http://localhost:9999/scratch/test-formatting.html", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__editorReady === true, {}, { timeout: 10000 });
  await page.waitForTimeout(500);

  const debug = await page.evaluate(async () => {
    const root = document.getElementById("editorjs");
    const blocks = Array.from(root.querySelectorAll(".ce-block"));
    const firstEditable = blocks[0].querySelector("[contenteditable='true']");
    const lastEditable = blocks[2].querySelector("[contenteditable='true']");

    const range = document.createRange();
    range.setStart(firstEditable.firstChild, 0);
    range.setEnd(lastEditable.firstChild, 3);

    const rangeStrBefore = range.toString();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const rangeStrAfter = range.toString();
    const selStr = sel.toString();

    // Check range details
    const startContainer = range.startContainer?.nodeType === 3 ? "#text:" + range.startContainer.textContent : range.startContainer?.tagName;
    const endContainer = range.endContainer?.nodeType === 3 ? "#text:" + range.endContainer.textContent : range.endContainer?.tagName;
    const commonAncestor = range.commonAncestorContainer?.nodeType === 3
      ? "#text:" + range.commonAncestorContainer.textContent?.slice(0, 20)
      : range.commonAncestorContainer?.tagName + "." + range.commonAncestorContainer?.className;

    // Check if root contains common ancestor
    const commonEl = range.commonAncestorContainer?.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer?.parentElement;
    const rootContainsCommon = root.contains(commonEl);

    // Test rangeIntersectsElement logic manually
    function testIntersects(r, el) {
      const er = document.createRange();
      er.selectNodeContents(el);
      const r1 = r.compareBoundaryPoints(Range.END_TO_START, er);
      const r2 = r.compareBoundaryPoints(Range.START_TO_END, er);
      return { r1, r2, intersects: !(r1 <= 0 || r2 >= 0) };
    }

    const intersects = blocks.map((b, i) => testIntersects(range, b));

    // Check nodeToElement equivalent
    const startEl = range.startContainer?.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const endEl = range.endContainer?.nodeType === 3 ? range.endContainer.parentElement : range.endContainer;
    const startEditable = startEl?.closest?.("[contenteditable='true']");
    const endEditable = endEl?.closest?.("[contenteditable='true']");

    // Check isBlockedInlineToolbarTarget equivalent
    function isBlocked(el) {
      return Boolean(el?.closest?.(
        ".tcloud-inline-toolbar, .ce-inline-toolbar, .tcloud-inline-toolbar__menu, " +
        ".ce-popover, .ce-settings, .ce-toolbar, .ce-conversion-toolbar, " +
        ".tcloud-context-menu, .modal, .sidebar, .appearance-popover, " +
        "#slash-menu, #colon-icon-menu, .colon-icon-menu"
      ));
    }

    return {
      rangeStrBefore,
      rangeStrAfter,
      selStr,
      startContainer,
      endContainer,
      commonAncestor,
      rootContainsCommon,
      intersects,
      startEditable: startEditable?.tagName,
      endEditable: endEditable?.tagName,
      startBlocked: isBlocked(startEl),
      endBlocked: isBlocked(endEl),
      commonBlocked: isBlocked(commonEl),
    };
  });

  console.log(JSON.stringify(debug, null, 2));
  console.log("\nLOGS:\n" + logs.join("\n"));
  await browser.close();
})();
