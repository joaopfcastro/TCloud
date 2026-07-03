import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:8080";
const SCREENSHOT_DIR = "/tmp/tcloud-block-tunes-test";
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
}

async function waitForAppReady(page) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const passField = page.locator('#login-pass').first();
  if (await passField.count() && await passField.isVisible().catch(() => false)) {
    await page.evaluate(() => {
      document.getElementById('login-user').value = 'tcloud';
      document.getElementById('login-pass').value = 'tcloud123';
    });
    await passField.press("Enter");
    await page.waitForTimeout(3000);
  }

  for (const sel of ['#nav-app-notes', '[data-app-id="notes"]', 'button:has-text("TCloud Notes")']) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() && await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(3000);
        break;
      }
    } catch (e) {}
  }

  let notesFrame = null;
  for (let attempt = 0; attempt < 12 && !notesFrame; attempt++) {
    await page.waitForTimeout(500);
    for (const f of page.frames()) {
      if (f.url().includes("/apps/notes/")) {
        notesFrame = f;
        break;
      }
    }
  }
  if (!notesFrame) throw new Error("Não foi possível encontrar o iframe do app Notes");
  await page.waitForTimeout(2500);
  return page.frameLocator(`iframe[src*="/apps/notes/"]`).first();
}

async function createTestNote(frame, page) {
  const newBtn = frame.locator('#new-note-button').first();
  if (await newBtn.count()) {
    await newBtn.click();
    await page.waitForTimeout(800);
  }
  const title = frame.locator('#note-title').first();
  if (await title.count()) {
    await title.fill("Teste Ajustar Bloco");
    await page.waitForTimeout(500);
  }
  const firstBlock = frame.locator('.ce-block .ce-block__content').first();
  if (await firstBlock.count()) {
    await firstBlock.click();
    await page.keyboard.type("Bloco 1 - Alpha");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    await page.keyboard.type("Bloco 2 - Beta");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    await page.keyboard.type("Bloco 3 - Gamma");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    await page.keyboard.type("Bloco 4 - Delta");
    await page.waitForTimeout(500);
  }
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    const frame = await waitForAppReady(page);
    await createTestNote(frame, page);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-inicial.png`, fullPage: true });

    // Clicar dentro do primeiro bloco para revelar a toolbar do Editor.js
    const firstBlock = frame.locator('.ce-block .ce-block__content').first();
    await firstBlock.click();
    await page.waitForTimeout(800);

    // Clicar no ícone de engrenagem (.ce-toolbar__settings-btn)
    const settingsBtn = frame.locator('.ce-toolbar__settings-btn').first();
    const settingsVisible = await settingsBtn.isVisible().catch(() => false);
    if (!settingsVisible) {
      record("engrenagem-visivel", false, "ícone .ce-toolbar__settings-btn não apareceu");
      await page.screenshot({ path: `${SCREENSHOT_DIR}/02-falha-engrenagem.png`, fullPage: true });
      await browser.close();
      process.exit(1);
    }
    record("engrenagem-visivel", true);
    await settingsBtn.click({ force: true });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-popover-aberto.png`, fullPage: true });

    // Coletar todos os itens do popover (dentro do iframe)
    const allItems = await page.evaluate(() => {
      for (const f of document.querySelectorAll('iframe')) {
        try {
          const doc = f.contentDocument;
          if (!doc) continue;
          const items = doc.querySelectorAll('.ce-popover-item');
          if (items.length > 0) {
            return Array.from(items).map(el => ({
              text: el.textContent.trim(),
              name: el.getAttribute('data-item-name') || null,
            }));
          }
        } catch (e) {}
      }
      return [];
    });

    console.log("\n=== Itens no popover ===");
    allItems.forEach((item, idx) => {
      console.log(`  ${idx + 1}. [${item.name || '?'}] ${item.text}`);
    });

    const labels = allItems.map(i => i.text);
    const names = allItems.map(i => i.name).filter(Boolean);

    // ===== VALIDAÇÕES DO FIX =====

    // Submenu "Converter para" tem 3 novos (Citação, Código, Divisor)
    record("converter-tem-citacao", labels.includes("Citação"), "Citação");
    record("converter-tem-codigo", labels.includes("Código"), "Código");
    record("converter-tem-divisor", labels.includes("Divisor"), "Divisor");

    // Tunes do "Ajustar bloco" estão visíveis
    record("tunes-mover-cima", names.includes("move-up"), "move-up");
    record("tunes-excluir", names.includes("delete"), "delete");
    record("tunes-mover-baixo", names.includes("move-down"), "move-down");
    record("tunes-converter-para", names.includes("convert-to"), "convert-to");

    // Total de opções do submenu "Converter para" (sem os tunes do settings)
    // = Texto, Título, Lista, Lista numerada, Checklist, Citação, Código, Divisor, + 6 TCloud
    const expectedMinimo = 8; // 4 originais + 3 novos (Quote, Code, Divider)
    const totalOpcoes = allItems.length;
    record("submenu-populado", totalOpcoes >= expectedMinimo,
      `${totalOpcoes} opções totais (mínimo esperado: ${expectedMinimo}, antes do fix: ~4)`);

    // Submenu "Converter para" tem os 4 originais (Título, Lista, Lista numerada, Checklist)
    record("origem-titulo", labels.includes("Título"));
    record("origem-lista", labels.includes("Lista"));
    record("origem-lista-numerada", labels.includes("Lista numerada"));
    record("origem-checklist", labels.includes("Checklist"));

    // Blocos TCloud também aparecem (bônus do fix)
    record("tcloud-arquivo", labels.includes("Arquivo"), "Arquivo (tcloudFile)");
    record("tcloud-imagem", labels.includes("Imagem"), "Imagem (tcloudImage)");

    // Cenário: Console limpo
    const criticalErrors = consoleErrors.filter((e) =>
      !e.includes("favicon") && !e.includes("manifest") && !e.includes("DevTools")
      && !e.includes("AUTH_REQUIRED") && !e.includes("Failed to load resource")
    );
    record("console-sem-erros", criticalErrors.length === 0,
      criticalErrors.length === 0 ? "limpo" : `${criticalErrors.length} erros: ${criticalErrors.slice(0, 2).join(" | ")}`);

    console.log("\n=== RESUMO ===");
    const passed = results.filter((r) => r.ok).length;
    console.log(`${passed}/${results.length} cenários passaram`);
    console.log(`Screenshots em: ${SCREENSHOT_DIR}/`);

    if (passed < results.length) {
      console.log("\nFalhas:");
      results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
    }
  } catch (error) {
    console.error("ERRO:", error.message);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/ERRO.png`, fullPage: true });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
