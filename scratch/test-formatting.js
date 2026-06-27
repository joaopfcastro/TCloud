const { chromium } = require("playwright");

async function renderBlocks(page, blocks) {
  await page.evaluate(async (blkData) => {
    const adapter = window.__adapter;
    await adapter.render({
      blocks: blkData.map((text) => ({ type: "paragraph", data: { text } })),
    });
  }, blocks);
  await page.waitForTimeout(400);
}

async function selectRange(page, startBlock, startOffset, endBlock, endOffset) {
  await page.evaluate(({ sB, sO, eB, eO}) => {
    const root = document.getElementById("editorjs");
    const blocks = Array.from(root.querySelectorAll(".ce-block"));
    const sEdit = blocks[sB].querySelector("[contenteditable='true']");
    const eEdit = blocks[eB].querySelector("[contenteditable='true']");
    const range = document.createRange();
    range.setStart(sEdit.firstChild, sO);
    range.setEnd(eEdit.firstChild, eO);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    window.__testRange = range;
  }, { sB: startBlock, sO: startOffset, eB: endBlock, eO: endOffset });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const logs = [];
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[PAGEERROR] ${err.message}`));

  await page.goto("http://localhost:9999/scratch/test-formatting.html", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__editorReady === true, {}, { timeout: 10000 });
  await page.waitForTimeout(500);

  let allPass = true;

  // === TEST 1: Multi-block bold (full blocks) ===
  console.log("=== TEST 1: Multi-block bold (full blocks) ===");
  await renderBlocks(page, ["def", "ghj", "ijk"]);
  await selectRange(page, 0, 0, 2, 3);

  const result1 = await page.evaluate(async () => {
    const adapter = window.__adapter;
    const range = window.__testRange;
    const hasMulti = adapter.hasMultiBlockSelection(range);
    const indexes = adapter.getSelectedBlockIndexes(range);
    const applyResult = await adapter.applyInlineActionToSelectedBlocks("bold", range);
    const content = await adapter.save();
    return { hasMulti, indexes, applyResult, blockTexts: content.blocks.map((b) => b.data.text) };
  });
  console.log("hasMulti:", result1.hasMulti, "indexes:", JSON.stringify(result1.indexes));
  console.log("applyResult:", JSON.stringify(result1.applyResult));
  console.log("blockTexts:", JSON.stringify(result1.blockTexts));
  const t1Pass = result1.blockTexts.every((t) => t === "<strong>def</strong>" || t === "<strong>ghj</strong>" || t === "<strong>ijk</strong>");
  console.log("PASS:", t1Pass);
  if (!t1Pass) { allPass = false; console.log("Expected all blocks wrapped in <strong>"); }

  // === TEST 2: Toggle off (unbold) ===
  console.log("\n=== TEST 2: Toggle off (unbold) ===");
  const result2 = await page.evaluate(async () => {
    const adapter = window.__adapter;
    const root = document.getElementById("editorjs");
    const blocks = Array.from(root.querySelectorAll(".ce-block"));
    const sEdit = blocks[0].querySelector("[contenteditable='true']");
    const eEdit = blocks[2].querySelector("[contenteditable='true']");
    const range = document.createRange();
    range.setStart(sEdit, 0);
    range.setEnd(eEdit, eEdit.childNodes.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const applyResult = await adapter.applyInlineActionToSelectedBlocks("bold", range);
    const content = await adapter.save();
    return { applyResult, blockTexts: content.blocks.map((b) => b.data.text) };
  });
  console.log("applyResult:", JSON.stringify(result2.applyResult));
  console.log("blockTexts:", JSON.stringify(result2.blockTexts));
  const t2Pass = result2.blockTexts.every((t) => !t.includes("<strong>"));
  console.log("PASS:", t2Pass);
  if (!t2Pass) { allPass = false; }

  // === TEST 3: Partial multi-block selection ===
  console.log("\n=== TEST 3: Partial multi-block selection ===");
  await renderBlocks(page, ["abcdef", "ghijkl", "mnopqr"]);
  await selectRange(page, 0, 2, 2, 4);

  const result3 = await page.evaluate(async () => {
    const adapter = window.__adapter;
    const range = window.__testRange;
    const applyResult = await adapter.applyInlineActionToSelectedBlocks("italic", range);
    const content = await adapter.save();
    return { applyResult, blockTexts: content.blocks.map((b) => b.data.text) };
  });
  console.log("applyResult:", JSON.stringify(result3.applyResult));
  console.log("blockTexts:", JSON.stringify(result3.blockTexts));
  const t3Pass =
    result3.blockTexts[0] === "ab<em>cdef</em>" &&
    result3.blockTexts[1] === "<em>ghijkl</em>" &&
    result3.blockTexts[2] === "<em>mnop</em>qr";
  console.log("PASS:", t3Pass);
  if (!t3Pass) { allPass = false; console.log("Expected: ab<em>cdef</em>, <em>ghijkl</em>, <em>mnop</em>qr"); }

  // === TEST 4: Single-block not detected as multi (regression) ===
  console.log("\n=== TEST 4: Single-block regression ===");
  await renderBlocks(page, ["hello world"]);
  await selectRange(page, 0, 0, 0, 5);

  const result4 = await page.evaluate(() => {
    const adapter = window.__adapter;
    const range = window.__testRange;
    return { hasMulti: adapter.hasMultiBlockSelection(range) };
  });
  console.log("hasMulti:", result4.hasMulti);
  const t4Pass = result4.hasMulti === false;
  console.log("PASS:", t4Pass);
  if (!t4Pass) { allPass = false; }

  // === TEST 5: Underline multi-block ===
  console.log("\n=== TEST 5: Underline multi-block ===");
  await renderBlocks(page, ["aaa", "bbb", "ccc"]);
  await selectRange(page, 0, 0, 2, 3);

  const result5 = await page.evaluate(async () => {
    const adapter = window.__adapter;
    const range = window.__testRange;
    await adapter.applyInlineActionToSelectedBlocks("underline", range);
    const content = await adapter.save();
    return { blockTexts: content.blocks.map((b) => b.data.text) };
  });
  console.log("blockTexts:", JSON.stringify(result5.blockTexts));
  const t5Pass = result5.blockTexts.every((t) => t.includes("<u>"));
  console.log("PASS:", t5Pass);
  if (!t5Pass) { allPass = false; }

  // === TEST 6: Strikethrough multi-block ===
  console.log("\n=== TEST 6: Strikethrough multi-block ===");
  await renderBlocks(page, ["xxx", "yyy"]);
  await selectRange(page, 0, 0, 1, 3);

  const result6 = await page.evaluate(async () => {
    const adapter = window.__adapter;
    const range = window.__testRange;
    await adapter.applyInlineActionToSelectedBlocks("strike", range);
    const content = await adapter.save();
    return { blockTexts: content.blocks.map((b) => b.data.text) };
  });
  console.log("blockTexts:", JSON.stringify(result6.blockTexts));
  const t6Pass = result6.blockTexts.every((t) => t.includes("<s>"));
  console.log("PASS:", t6Pass);
  if (!t6Pass) { allPass = false; }

  // === TEST 7: Clear formatting multi-block ===
  console.log("\n=== TEST 7: Clear formatting multi-block ===");
  await renderBlocks(page, ["<strong>bold1</strong>", "<em>italic2</em>", "<u>under3</u>"]);
  // Select entire blocks (contenteditable-level, not text-node level)
  await page.evaluate(() => {
    const root = document.getElementById("editorjs");
    const blocks = Array.from(root.querySelectorAll(".ce-block"));
    const sEdit = blocks[0].querySelector("[contenteditable='true']");
    const eEdit = blocks[2].querySelector("[contenteditable='true']");
    const range = document.createRange();
    range.setStart(sEdit, 0);
    range.setEnd(eEdit, eEdit.childNodes.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    window.__testRange = range;
  });

  const result7 = await page.evaluate(async () => {
    const adapter = window.__adapter;
    const range = window.__testRange;
    await adapter.applyInlineActionToSelectedBlocks("clear", range);
    const content = await adapter.save();
    return { blockTexts: content.blocks.map((b) => b.data.text) };
  });
  console.log("blockTexts:", JSON.stringify(result7.blockTexts));
  const t7Pass = result7.blockTexts.every((t) => !t.includes("<strong>") && !t.includes("<em>") && !t.includes("<u>"));
  console.log("PASS:", t7Pass);
  if (!t7Pass) { allPass = false; }

  console.log("\n=== ALL LOGS ===");
  console.log(logs.join("\n"));
  console.log("\n=== SUMMARY ===");
  console.log("All tests passed:", allPass);

  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
