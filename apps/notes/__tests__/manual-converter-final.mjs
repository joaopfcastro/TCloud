import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:8080";
const SCREENSHOT_DIR = "/tmp/tcloud-converter-final";
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
  await page.locator('#nav-app-notes').first().click({ timeout: 5000 });
  await page.waitForTimeout(5000);
  return page.frameLocator(`iframe[src*="/apps/notes/"]`).first();
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    const frame = await waitForAppReady(page);

    const newBtn = frame.locator('#new-note-button').first();
    if (await newBtn.count()) {
      await newBtn.click();
      await page.waitForTimeout(800);
    }
    const title = frame.locator('#note-title').first();
    if (await title.count()) {
      await title.fill("Teste Ajustar Bloco v2");
      await page.waitForTimeout(500);
    }
    const firstBlock = frame.locator('.ce-block .ce-block__content').first();
    await firstBlock.click();
    await page.keyboard.type("Bloco 1 - Alpha");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    await page.keyboard.type("Bloco 2 - Beta");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    await page.keyboard.type("Bloco 3 - Gamma");
    await page.waitForTimeout(500);

    // Re-click no bloco para garantir que o cursor está dentro
    await firstBlock.click();
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-nota.png`, fullPage: true });

    const blockBox = await firstBlock.boundingBox();
    if (blockBox) {
      await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + 5);
      await page.waitForTimeout(1200);
    }

    const settingsBtn = frame.locator('.ce-toolbar__settings-btn').first();
    const settingsVisible = await settingsBtn.isVisible().catch(() => false);
    record("engrenagem-visivel", settingsVisible);
    if (!settingsVisible) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/ERRO.png`, fullPage: true });
      await browser.close();
      process.exit(1);
    }
    await settingsBtn.click({ force: true });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-ajustar-bloco.png`, fullPage: true });

    const notesFrame = page.frames().find(f => f.url().includes('/apps/notes/'));
    const settingsItems = await notesFrame.evaluate(() => {
      const buttons = document.querySelectorAll('.ce-popover-item[data-item-name="move-up"], .ce-popover-item[data-item-name="delete"], .ce-popover-item[data-item-name="move-down"], .ce-popover-item[data-item-name="convert-to"]');
      return Array.from(buttons).map(b => b.textContent.trim());
    });
    record("tunes-do-menu", settingsItems.length === 4, `4 items: ${settingsItems.join(", ")}`);

    const convertItem = frame.locator('.ce-popover-item[data-item-name="convert-to"]').first();
    await convertItem.hover();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-converter-para.png`, fullPage: true });

    const submenuItems = await notesFrame.evaluate(() => {
      const nested = document.querySelector('.ce-popover--nested .ce-popover__items');
      if (!nested) return null;
      return Array.from(nested.querySelectorAll('.ce-popover-item')).map(i => ({
        text: i.textContent.trim(),
        visible: i.getBoundingClientRect().height > 0,
      }));
    });
    console.log("\n=== Submenu 'Converter para' (nested) ===");
    if (submenuItems) {
      submenuItems.forEach((it, i) => {
        console.log(`  ${i + 1}. "${it.text}" ${it.visible ? "✓" : "✗"}`);
      });
    } else {
      console.log("  NENHUM SUBMENU ENCONTRADO");
    }

    const expectedLabels = ["Título", "Lista", "Lista numerada", "Checklist", "Citação", "Código", "Divisor"];
    const hasTodos = expectedLabels.every(label => submenuItems?.some(it => it.text === label));
    record("submenu-tem-todos", hasTodos, `esperado: ${expectedLabels.join(", ")}`);

    const visibleCount = submenuItems?.filter(it => it.visible).length || 0;
    record("todos-visiveis", visibleCount >= 7, `${visibleCount} items visíveis (esperado ≥ 7)`);

    const criticalErrors = consoleErrors.filter((e) =>
      !e.includes("favicon") && !e.includes("manifest") && !e.includes("DevTools")
      && !e.includes("AUTH_REQUIRED") && !e.includes("Failed to load resource")
    );
    record("console-limpo", criticalErrors.length === 0,
      criticalErrors.length === 0 ? "sem erros críticos" : `${criticalErrors.length} erros`);

    console.log("\n=== RESUMO ===");
    const passed = results.filter((r) => r.ok).length;
    console.log(`${passed}/${results.length} cenários passaram`);
    console.log(`Screenshots: ${SCREENSHOT_DIR}/`);
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
