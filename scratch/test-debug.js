const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const logs = [];
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[PAGEERROR] ${err.message}\n${err.stack}`));

  await page.goto("http://localhost:9999/scratch/test-formatting.html", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__editorReady === true || window.__editorError, {}, { timeout: 10000 });

  console.log("Editor initialized OK");
  await page.waitForTimeout(500);

  // Detailed debug of the multi-block detection
  const debug = await page.evaluate(async () => {
    const adapter = window.__adapter;
    const ctrl = adapter.blockSelectionController;
    const root = document.getElementById("editorjs");
    const blocks = Array.from(root.querySelectorAll(".ce-block"));

    const firstEditable = blocks[0].querySelector("[contenteditable='true']");
    const lastEditable = blocks[2].querySelector("[contenteditable='true']");

    const range = document.createRange();
    range.setStart(firstEditable.firstChild, 0);
    range.setEnd(lastEditable.firstChild, 3);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const result = {};

    // Check root
    result.ctrlRoot = ctrl?.root?.id || ctrl?.root?.tagName || "null";
    result.ctrlRootContainsBlocks = ctrl?.root ? ctrl.root.querySelectorAll(".ce-block").length : -1;
    result.adapterHolder = adapter.holder;

    // Check rangeInsideEditor
    // We can't call it directly but we can check via indexesFromRange
    result.indexesFromRange = ctrl.indexesFromRange(range);

    // Check rangeIntersectsElement for each block
    // We can't call it directly, but we can check via the controller's blocks
    result.blockCount = blocks.length;
    result.blockTexts = blocks.map((b) => b.querySelector("[contenteditable='true']")?.textContent);

    // Check selection
    result.selectionRangeCount = sel.rangeCount;
    result.selectionText = sel.toString();

    // Check getSelectedIndexes
    result.getSelectedIndexes = ctrl.getSelectedIndexes(range);

    // Check hasMultiBlockSelection
    result.hasMulti = adapter.hasMultiBlockSelection(range);
    result.getSelectedBlockIndexes = adapter.getSelectedBlockIndexes(range);

    // Check snapshot state
    result.snapshotActive = ctrl.selectionSnapshot?.active;
    result.snapshotIndexes = ctrl.selectionSnapshot?.indexes;
    result.snapshotFrozen = ctrl.selectionSnapshot?.frozen;

    // Check visualIndexes
    result.visualIndexes = ctrl.visualIndexes();

    // Check indexesFromCurrentSelection
    result.indexesFromCurrentSelection = ctrl.indexesFromCurrentSelection();

    return result;
  });

  console.log("\n=== DEBUG ===");
  console.log(JSON.stringify(debug, null, 2));
  console.log("\n=== LOGS ===");
  console.log(logs.join("\n"));

  await browser.close();
})();
