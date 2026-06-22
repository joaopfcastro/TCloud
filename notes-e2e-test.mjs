import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:8080";
const SCREENSHOT_DIR = "/tmp/tcloud-notes-screens";
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const results = [];
function log(msg) { console.log(msg); }
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
}

async function waitForAppReady(page) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const passField = page.locator('#login-pass').first();
  if (await passField.count() && await passField.isVisible().catch(() => false)) {
    await page.evaluate(() => {
      document.getElementById('login-user').value = 'tcloud';
      document.getElementById('login-pass').value = 'tcloud123';
    });
    await passField.press("Enter");
    await page.waitForTimeout(3000);
    if (await page.locator('#login-overlay.active').count()) {
      await page.locator('form:has(#login-pass) button[type="submit"]').first().click().catch(() => {});
      await page.waitForTimeout(3000);
    }
  }

  // Find and click the Notes app in the desktop/dock
  const notesCandidates = [
    '#nav-app-notes',
    '[data-app-id="notes"]',
    'button:has-text("TCloud Notes")',
    '[aria-label*="TCloud Notes"]',
  ];
  let opened = false;
  for (const sel of notesCandidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() && await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(2500);
        opened = true;
        break;
      }
    } catch (e) { /* try next */ }
  }
  if (!opened) {
    console.log("Não encontrou botão Notes, tentando iframe direto...");
  }

  // Find the Notes app iframe (opened as a separate window, not #app-viewer-frame)
  let notesFrame = null;
  for (let attempt = 0; attempt < 10 && !notesFrame; attempt++) {
    await page.waitForTimeout(500);
    const iframes = page.frames();
    for (const f of iframes) {
      if (f.url().includes("/apps/notes/")) {
        notesFrame = f;
        break;
      }
    }
  }
  if (!notesFrame) {
    throw new Error("Não foi possível encontrar o iframe do app Notes");
  }
  // Wrap as frameLocator-like using the frame directly
  const frame = {
    locator: (sel) => page.frameLocator(`iframe[src*="/apps/notes/"]`).first().locator(sel),
  };
  await page.waitForTimeout(2000);
  return frame;
}

async function createTestNote(frame, page) {
  const newBtn = frame.locator('#new-note-button').first();
  await newBtn.click();
  await page.waitForTimeout(800);
  const title = frame.locator('#note-title').first();
  await title.fill("Teste Seleção Múltipla");
  await page.waitForTimeout(500);

  // Add several blocks
  const editor = frame.locator('#editorjs .codex-editor__redactor').first();
  const firstBlock = frame.locator('.ce-block .ce-block__content').first();
  if (await firstBlock.count()) {
    await firstBlock.click();
    await page.keyboard.type("Bloco 1 - Alpha");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await page.keyboard.type("Bloco 2 - Beta");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await page.keyboard.type("Bloco 3 - Gamma");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await page.keyboard.type("Bloco 4 - Delta");
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-note-created.png` });
}

async function testFloatingToolbarMouseDrag(frame, page) {
  log("\n[Teste 1] Menu flutuante via mouse drag entre blocos");
  const blocks = frame.locator('.ce-block .ce-block__content');
  const count = await blocks.count();
  if (count < 3) {
    record("Mouse drag — blocos suficientes", false, `apenas ${count} blocos`);
    return;
  }
  const b1 = blocks.nth(0);
  const b3 = blocks.nth(2);
  const box1 = await b1.boundingBox();
  const box3 = await b3.boundingBox();
  if (!box1 || !box3) { record("Mouse drag — bounding box", false); return; }

  // Drag from block 1 to block 3
  await page.mouse.move(box1.x + 20, box1.y + box1.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(100);
  // move through block 2
  await page.mouse.move(box1.x + 20, box1.y + box1.height + 10, { steps: 5 });
  await page.waitForTimeout(100);
  await page.mouse.move(box3.x + 40, box3.y + box3.height / 2, { steps: 10 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(1000);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-after-drag.png` });

  // Check selection classes
  const selectedCount = await frame.locator('.ce-block.is-tcloud-range-selected').count();
  record("Mouse drag — blocos selecionados", selectedCount >= 3, `${selectedCount} blocos com is-tcloud-range-selected`);

  // Check floating toolbar (lives inside the Notes iframe, not the parent page)
  const toolbar = frame.locator('.tcloud-inline-toolbar--custom.is-open').first();
  const toolbarVisible = await toolbar.isVisible().catch(() => false);
  record("Mouse drag — toolbar visível", toolbarVisible);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-toolbar-after-drag.png` });
}

async function ensureBlocks(frame, page, n = 4) {
  const blocks = frame.locator('.ce-block .ce-block__content');
  let count = await blocks.count();
  if (count >= n) return;
  // Click last block and add more
  const last = blocks.last();
  if (await last.count()) {
    await last.click();
    // Move caret to end
    await page.keyboard.press("End");
    while (count < n) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      await page.keyboard.type(`Extra ${count + 1}`);
      await page.waitForTimeout(200);
      count = await frame.locator('.ce-block .ce-block__content').count();
    }
  }
}

async function testFloatingToolbarKeyboardShiftArrow(frame, page) {
  log("\n[Teste 2] Menu flutuante via Shift+ArrowDown");
  // Ensure we have blocks (previous test may have consumed selection)
  await ensureBlocks(frame, page, 3);
  // Click first block, place caret
  const firstBlock = frame.locator('.ce-block .ce-block__content').first();
  await firstBlock.click();
  await page.waitForTimeout(300);

  // Press Shift+ArrowDown twice
  await page.keyboard.press("Shift+ArrowDown");
  await page.waitForTimeout(500);
  await page.keyboard.press("Shift+ArrowDown");
  await page.waitForTimeout(1000);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-after-shift-arrow.png` });
  const selectedCount = await frame.locator('.ce-block.is-tcloud-range-selected').count();
  record("Shift+ArrowDown — blocos selecionados", selectedCount >= 2, `${selectedCount} blocos`);

  const toolbar = frame.locator('.tcloud-inline-toolbar--custom.is-open').first();
  const toolbarVisible = await toolbar.isVisible().catch(() => false);
  record("Shift+ArrowDown — toolbar visível", toolbarVisible);
  // Clear selection for next test
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

async function testBackspaceBulkDelete(frame, page) {
  log("\n[Teste 3] Deleção em lote via Backspace");
  await ensureBlocks(frame, page, 4);
  // Re-select blocks
  const blocks = frame.locator('.ce-block .ce-block__content');
  const count = await blocks.count();
  if (count < 3) { record("Backspace — blocos suficientes", false); return; }

  const b1 = blocks.nth(0);
  const b3 = blocks.nth(2);
  const box1 = await b1.boundingBox();
  const box3 = await b3.boundingBox();
  await page.mouse.move(box1.x + 20, box1.y + box1.height / 2);
  await page.mouse.down();
  await page.mouse.move(box3.x + 40, box3.y + box3.height / 2, { steps: 10 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(1000);

  const before = await frame.locator('.ce-block').count();
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(1500);
  const after = await frame.locator('.ce-block').count();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-after-backspace.png` });
  record("Backspace — blocos deletados em lote", after < before, `antes=${before} depois=${after}`);
}

async function testCopyIntercept(frame, page) {
  log("\n[Teste 4] Interceptação Ctrl/Cmd+C");
  const blocks = frame.locator('.ce-block .ce-block__content');
  const count = await blocks.count();
  if (count < 2) {
    // create blocks to test
    const first = blocks.first();
    if (await first.count()) {
      await first.click();
      await page.keyboard.type("Copy Alpha");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      await page.keyboard.type("Copy Beta");
      await page.waitForTimeout(400);
    } else {
      record("Copy — blocos suficientes", false, "sem blocos");
      return;
    }
  }
  const allBlocks = frame.locator('.ce-block .ce-block__content');
  const b1 = allBlocks.nth(0);
  const b2 = allBlocks.nth(1);
  const box1 = await b1.boundingBox();
  const box2 = await b2.boundingBox();
  if (!box1 || !box2) { record("Copy — boxes", false); return; }
  // Re-select blocks via drag (we need a real multi-block selection)
  await page.mouse.move(box1.x + 10, box1.y + box1.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + 30, box2.y + box2.height / 2, { steps: 10 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(800);
  // Dispatch a synthetic copy event inside the iframe so our handler observes
  // what the controller writes to clipboardData.
  const notesFrame = page.frames().find((f) => f.url().includes("/apps/notes/"));
  await notesFrame?.evaluate(() => {
    window.__tcloudTestCopy = { called: false, plain: null, custom: null, prevented: null };
    const handler = (e) => {
      window.__tcloudTestCopy.called = true;
      window.__tcloudTestCopy.prevented = e.defaultPrevented;
      try {
        window.__tcloudTestCopy.plain = e.clipboardData?.getData?.('text/plain') || null;
        window.__tcloudTestCopy.custom = e.clipboardData?.getData?.('application/x-tcloud-notes-blocks') || null;
      } catch (err) { window.__tcloudTestCopy.error = String(err); }
    };
    window.addEventListener('copy', handler, { capture: true });
    // Dispatch synthetic copy event
    const ev = new ClipboardEvent('copy', { clipboardData: new DataTransfer() });
    document.dispatchEvent(ev);
    // Need to also call the controller's handler directly. Since we can't easily
    // synthesize a real clipboard gesture, the test confirms the controller's
    // handleCopy runs via our unit tests. Here we just verify selection exists.
    window.__tcloudTestCopy.selectionExists = Boolean(document.querySelector('.ce-block.is-tcloud-range-selected'));
    window.removeEventListener('copy', handler, { capture: true });
  }).catch(() => {});

  // Alternative: use the controller's handleCopy via the test by checking snapshot text
  const snapshotText = await notesFrame?.evaluate(() => {
    // Re-dispatch via the ClipboardEvent with a DataTransfer we can inspect
    const dt = new DataTransfer();
    const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    return {
      prevented: ev.defaultPrevented,
      plain: dt.getData('text/plain'),
      custom: dt.getData('application/x-tcloud-notes-blocks'),
      selectionExists: Boolean(document.querySelector('.ce-block.is-tcloud-range-selected')),
    };
  }).catch(() => null);
  console.log("Copy snapshot:", JSON.stringify(snapshotText));

  const clipboardText = snapshotText?.plain || "";
  const hasCustom = Boolean(snapshotText?.custom);
  record("Copy — seleção múltipla presente", Boolean(snapshotText?.selectionExists));
  record("Copy — texto copiado dos blocos", Boolean(clipboardText), `clipboard="${clipboardText.slice(0, 60)}"`);
  record("Copy — payload estruturado exportado", hasCustom);
}

async function testToolbarActionsBlockConvert(frame, page) {
  log("\n[Teste 5] Ação em lote — transformar em H1 via toolbar");
  await ensureBlocks(frame, page, 3);
  const blocks = frame.locator('.ce-block .ce-block__content');
  if (await blocks.count() < 2) { record("H1 — blocos suficientes", false); return; }
  const b1 = blocks.nth(0);
  const b2 = blocks.nth(1);
  const box1 = await b1.boundingBox();
  const box2 = await b2.boundingBox();
  await page.mouse.move(box1.x + 10, box1.y + box1.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + 30, box2.y + box2.height / 2, { steps: 10 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(1200);

  const toolbar = frame.locator('.tcloud-inline-toolbar--custom.is-open').first();
  const toolbarVisible = await toolbar.isVisible().catch(() => false);
  if (!toolbarVisible) {
    record("H1 — toolbar aberta", false, "toolbar não apareceu");
    return;
  }
  record("H1 — toolbar aberta", true);

  // Click block-menu button (the "Texto" button with label)
  const blockBtn = toolbar.locator('[data-tcloud-action="block-menu"]').first();
  if (await blockBtn.count()) {
    await blockBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/06-block-menu.png` });
    // Click "Título 1" / H1 option — menu is inside the frame
    const h1Option = frame.locator('.tcloud-inline-toolbar__menu button:has-text("Título 1"), .tcloud-inline-toolbar__menu button:has-text("Heading 1"), [data-tcloud-action^="block:header:1"]').first();
    if (await h1Option.count()) {
      await h1Option.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/07-after-h1-convert.png` });
      const headerCount = await frame.locator('.ce-block h1, .ce-block h2').count();
      record("H1 — blocos convertidos", headerCount > 0, `${headerCount} headers`);
      // Check if toolbar persists after H1 conversion
      const toolbarStillOpen = await frame.locator('.tcloud-inline-toolbar--custom.is-open').first().isVisible().catch(() => false);
      const selStillActive = await frame.locator('.ce-block.is-tcloud-range-selected').count();
      record("H1 — toolbar persiste após conversão", toolbarStillOpen, `open=${toolbarStillOpen} sel=${selStillActive}`);
      record("H1 — seleção persiste após conversão", selStillActive >= 2, `${selStillActive} blocos`);
    } else {
      record("H1 — opção encontrada", false, "Título 1 não localizado no menu");
    }
  } else {
    record("H1 — botão block-menu", false);
  }
}

async function testToolbarPersistsAfterAction(frame, page) {
  log("\n[Teste 6] Toolbar persiste após clicar ação (estilo Notion)");
  // Create a fresh note to avoid state from previous tests
  await frame.locator('#new-note-button').click();
  await page.waitForTimeout(1200);
  await frame.locator('#note-title').fill("Teste Persist Toolbar");
  await page.waitForTimeout(400);
  const firstBlock = frame.locator('.ce-block .ce-block__content').first();
  await firstBlock.click();
  await page.keyboard.type("Persist Alpha");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  await page.keyboard.type("Persist Beta");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  await page.keyboard.type("Persist Gamma");
  await page.waitForTimeout(700);

  const blocks = frame.locator('.ce-block .ce-block__content');
  const b1 = blocks.nth(0);
  const b2 = blocks.nth(2);
  const box1 = await b1.boundingBox();
  const box2 = await b2.boundingBox();
  if (!box1 || !box2) { record("Persist — boxes", false); return; }

  await page.mouse.move(box1.x + 15, box1.y + box1.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.move(box1.x + 15, box1.y + box1.height + 12, { steps: 5 });
  await page.waitForTimeout(80);
  await page.mouse.move(box2.x + 40, box2.y + box2.height / 2, { steps: 12 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForTimeout(1500);

  const toolbar = frame.locator('.tcloud-inline-toolbar--custom.is-open').first();
  const toolbarVisibleBefore = await toolbar.isVisible().catch(() => false);
  const selectedBefore = await frame.locator('.ce-block.is-tcloud-range-selected').count();
  record("Persist — toolbar aberta antes da ação", toolbarVisibleBefore && selectedBefore >= 2, `${selectedBefore} blocos selecionados`);

  if (!toolbarVisibleBefore || selectedBefore < 2) {
    await page.screenshot({ path: `${SCREENSHOT_DIR}/08-persist-setup-failed.png` });
    return;
  }

  // Click the Bold button
  const boldBtn = toolbar.locator('[data-tcloud-action="bold"]').first();
  if (!(await boldBtn.count())) { record("Persist — botão bold", false); return; }
  await boldBtn.click();
  await page.waitForTimeout(1500);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/08-after-bold-action.png` });

  const toolbarVisibleAfter = await toolbar.isVisible().catch(() => false);
  const selectedAfter = await frame.locator('.ce-block.is-tcloud-range-selected').count();
  record("Persist — toolbar permanece após bold", toolbarVisibleAfter, `open=${toolbarVisibleAfter} sel=${selectedAfter}`);
  record("Persist — seleção permanece após bold", selectedAfter >= 2, `${selectedAfter} blocos`);

  // Apply a second action — italic — to confirm multi-action workflow
  const italicBtn = toolbar.locator('[data-tcloud-action="italic"]').first();
  if (await italicBtn.count() && toolbarVisibleAfter) {
    await italicBtn.click();
    await page.waitForTimeout(900);
    const stillOpen = await toolbar.isVisible().catch(() => false);
    const stillSelected = await frame.locator('.ce-block.is-tcloud-range-selected').count();
    record("Persist — segunda ação (italic) funciona", stillOpen && stillSelected >= 2, `open=${stillOpen} sel=${stillSelected}`);
  }
  // Apply indent via toolbar to confirm batch action persistence
  const indentBtn = toolbar.locator('[data-tcloud-action="indent"]').first();
  if (await indentBtn.count()) {
    await indentBtn.click();
    await page.waitForTimeout(900);
    const openAfterIndent = await toolbar.isVisible().catch(() => false);
    const selAfterIndent = await frame.locator('.ce-block.is-tcloud-range-selected').count();
    record("Persist — indent em lote mantém toolbar+seleção", openAfterIndent && selAfterIndent >= 2, `open=${openAfterIndent} sel=${selAfterIndent}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Collect console errors
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[browser console error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => console.log(`[page error] ${err.message}`));

  let frame;
  try {
    log("Subindo TCloud e abrindo Notes app...");
    frame = await waitForAppReady(page);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/00-app-loaded.png` });
    log("App Notes aberto.");

    await createTestNote(frame, page);
    await testFloatingToolbarMouseDrag(frame, page);
    // Clear selection
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    // Run copy test early while selection is fresh
    await testCopyIntercept(frame, page);
    // Clear selection
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await testFloatingToolbarKeyboardShiftArrow(frame, page);
    await testToolbarActionsBlockConvert(frame, page);
    // Clear selection
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await testToolbarPersistsAfterAction(frame, page);
    await testBackspaceBulkDelete(frame, page);
  } catch (err) {
    console.log("ERRO fatal:", err.message, err.stack);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/error.png` }).catch(() => {});
  } finally {
    log("\n===== RESULTADO =====");
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    log(`Passaram: ${passed}/${results.length}; Falharam: ${failed}`);
    if (failed) {
      log("\nFalhas:");
      results.filter((r) => !r.ok).forEach((r) => log(` - ${r.name}: ${r.detail}`));
    }
    await browser.close();
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
