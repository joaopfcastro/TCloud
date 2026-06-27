const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on("console", (msg) => console.log(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`[PAGEERROR] ${err.message}`));

  await page.goto("http://localhost:9999/scratch/test-formatting.html", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__editorReady === true, {}, { timeout: 10000 });
  await page.waitForTimeout(500);

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

    // Wait for sync to run
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    // Test indexesFromRange directly
    const indexesFromRange = ctrl.indexesFromRange(range);

    // Test intersectsNode directly on blocks
    const intersectsResults = blocks.map((b, i) => {
      try { return range.intersectsNode(b); } catch (e) { return "err:" + e.message; }
    });

    // Test normalizeIndexes
    const normalized = ctrl.normalizeIndexes([0, 1, 2]);

    // Check lastSavedContent
    const contentBlocks = adapter.lastSavedContent?.blocks || [];
    const contentBlockCount = contentBlocks.length;
    const contentBlockTypes = contentBlocks.map((b) => b?.type);

    // Check blocks count
    const blocksCount = blocks.length;

    // Check snapshot after sync
    const snapshotAfter = {
      active: ctrl.selectionSnapshot?.active,
      indexes: ctrl.selectionSnapshot?.indexes,
      frozen: ctrl.selectionSnapshot?.frozen,
    };

    // Check getSelectedIndexes
    const getSelectedIndexes = ctrl.getSelectedIndexes(range);

    // Check indexesFromCurrentSelection
    const indexesFromCurrentSelection = ctrl.indexesFromCurrentSelection();

    // Check visualIndexes
    const visualIndexes = ctrl.visualIndexes();

    return {
      intersectsResults,
      indexesFromRange,
      normalized,
      contentBlockCount,
      contentBlockTypes,
      blocksCount,
      snapshotAfter,
      getSelectedIndexes,
      indexesFromCurrentSelection,
      visualIndexes,
    };
  });

  console.log(JSON.stringify(debug, null, 2));
  await browser.close();
})();
