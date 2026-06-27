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

    // Print DOM structure of first block
    const block0HTML = blocks[0].outerHTML.slice(0, 300);
    const block2HTML = blocks[2].outerHTML.slice(0, 300);

    // Get range boundary details
    const startNode = range.startContainer;
    const endNode = range.endContainer;
    const startInfo = `${startNode.nodeType === 3 ? "text" : startNode.tagName}:"${startNode.textContent?.slice(0, 20)}" @${range.startOffset}`;
    const endInfo = `${endNode.nodeType === 3 ? "text" : endNode.tagName}:"${endNode.textContent?.slice(0, 20)}" @${range.endOffset}`;

    // Approach 1: compareBoundaryPoints with .ce-block
    function approach1(r, block) {
      const er = document.createRange();
      er.selectNodeContents(block);
      const r1 = r.compareBoundaryPoints(Range.END_TO_START, er);
      const r2 = r.compareBoundaryPoints(Range.START_TO_END, er);
      return { r1, r2, intersects: !(r1 <= 0 || r2 >= 0) };
    }

    // Approach 2: compareBoundaryPoints with contenteditable element
    function approach2(r, block) {
      const editable = block.querySelector("[contenteditable='true']");
      if (!editable) return { error: "no editable" };
      const er = document.createRange();
      er.selectNodeContents(editable);
      const r1 = r.compareBoundaryPoints(Range.END_TO_START, er);
      const r2 = r.compareBoundaryPoints(Range.START_TO_END, er);
      return { r1, r2, intersects: !(r1 <= 0 || r2 >= 0) };
    }

    // Approach 3: range.intersectsNode
    function approach3(r, block) {
      try {
        return { intersects: r.intersectsNode(block) };
      } catch (e) {
        return { error: e.message };
      }
    }

    // Approach 4: range.intersectsNode with contenteditable
    function approach4(r, block) {
      const editable = block.querySelector("[contenteditable='true']");
      if (!editable) return { error: "no editable" };
      try {
        return { intersects: r.intersectsNode(editable) };
      } catch (e) {
        return { error: e.message };
      }
    }

    // Approach 5: Bounding rect intersection
    function approach5(r, block) {
      const rRect = r.getBoundingClientRect();
      const bRect = block.getBoundingClientRect();
      const intersects = !(rRect.bottom <= bRect.top || rRect.top >= bRect.bottom);
      return { rRect: {top: rRect.top, bottom: rRect.bottom}, bRect: {top: bRect.top, bottom: bRect.bottom}, intersects };
    }

    // Approach 6: Check if range contains the block's editable
    function approach6(r, block) {
      const editable = block.querySelector("[contenteditable='true']");
      if (!editable) return { error: "no editable" };
      try {
        return { contains: r.intersectsNode(editable), startToEnd: r.comparePoint(editable, 0), endToStart: r.comparePoint(editable, editable.childNodes.length) };
      } catch (e) {
        return { error: e.message };
      }
    }

    return {
      block0HTML,
      block2HTML,
      startInfo,
      endInfo,
      rangeStr: range.toString(),
      approach1: blocks.map((b, i) => approach1(range, b)),
      approach2: blocks.map((b, i) => approach2(range, b)),
      approach3: blocks.map((b, i) => approach3(range, b)),
      approach4: blocks.map((b, i) => approach4(range, b)),
      approach5: blocks.map((b, i) => approach5(range, b)),
      approach6: blocks.map((b, i) => approach6(range, b)),
    };
  });

  console.log(JSON.stringify(debug, null, 2));
  await browser.close();
})();
