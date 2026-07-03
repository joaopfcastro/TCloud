import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on('console', msg => { if (msg.type() === 'warning' || msg.type() === 'error') console.log('CONSOLE:', msg.text().substring(0, 200)); });
await page.goto("http://localhost:8080/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const passField = page.locator('#login-pass').first();
if (await passField.count() && await passField.isVisible().catch(() => false)) {
  await page.evaluate(() => {
    document.getElementById('login-user').value = 'tcloud';
    document.getElementById('login-pass').value = 'tcloud123';
  });
  await passField.press("Enter");
  await page.waitForTimeout(5000);
}
await page.locator('#nav-app-notes').first().click({ timeout: 5000 });
await page.waitForTimeout(5000);
const frame = page.frameLocator('iframe[src*="/apps/notes/"]').first();
const notesFrame = page.frames().find(f => f.url().includes('/apps/notes/'));

// Criar nota nova
const newBtn = frame.locator('#new-note-button').first();
if (await newBtn.count()) { await newBtn.click(); await page.waitForTimeout(800); }
const title = frame.locator('#note-title').first();
if (await title.count()) { await title.fill("Teste Acoes"); await page.waitForTimeout(300); }
const firstBlock = frame.locator('.ce-block .ce-block__content').first();
await firstBlock.click();
await page.keyboard.type("Alpha");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
await page.keyboard.type("Beta");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
await page.keyboard.type("Gamma");
await page.waitForTimeout(500);

// Re-click no bloco 2 (Beta) para testar moveUp
const block2 = frame.locator('.ce-block .ce-block__content').nth(1);
await block2.click();
await page.waitForTimeout(500);
const blockBox = await block2.boundingBox();
if (blockBox) { await page.mouse.move(blockBox.x + blockBox.width / 2, blockBox.y + 5); await page.waitForTimeout(800); }

// Abrir engrenagem
const settingsBtn = frame.locator('.ce-toolbar__settings-btn').first();
if (!await settingsBtn.isVisible().catch(() => false)) { console.log("FAIL: engrenagem invisível"); await browser.close(); process.exit(1); }
await settingsBtn.click({ force: true });
await page.waitForTimeout(2000);

// Capturar texto dos blocos ANTES
const beforeTexts = await notesFrame.evaluate(() => Array.from(document.querySelectorAll('.ce-block .ce-block__content')).map(el => el.textContent.trim()));
console.log("ANTES:", JSON.stringify(beforeTexts));

// Clicar em "Mover para cima"
const moveUpBtn = frame.locator('.ce-popover-item[data-item-name="move-up"]').first();
if (await moveUpBtn.count() > 0) {
  await moveUpBtn.click({ force: true });
  await page.waitForTimeout(1500);
  const afterTexts = await notesFrame.evaluate(() => Array.from(document.querySelectorAll('.ce-block .ce-block__content')).map(el => el.textContent.trim()));
  const moved = JSON.stringify(beforeTexts) !== JSON.stringify(afterTexts);
  console.log("DEPOIS:", JSON.stringify(afterTexts));
  console.log(moved ? "PASS: Mover para cima funcionou" : "FAIL: Mover para cima não mudou ordem");
} else {
  console.log("FAIL: botão move-up não encontrado");
}

// Re-abrir engrenagem e testar Excluir
const block1 = frame.locator('.ce-block .ce-block__content').first();
await block1.click();
await page.waitForTimeout(500);
const box = await block1.boundingBox();
if (box) { await page.mouse.move(box.x + box.width / 2, box.y + 5); await page.waitForTimeout(800); }
await frame.locator('.ce-toolbar__settings-btn').first().click({ force: true });
await page.waitForTimeout(2000);

const blocksBeforeDelete = await notesFrame.evaluate(() => document.querySelectorAll('.ce-block').length);
console.log("\nBlocos antes do delete:", blocksBeforeDelete);

const deleteBtn = frame.locator('.ce-popover-item[data-item-name="delete"]').first();
if (await deleteBtn.count() > 0) {
  // 1º clique — vendor mostra confirmação
  await deleteBtn.click({ force: true });
  await page.waitForTimeout(800);
  // 2º clique — exclui de verdade
  await deleteBtn.click({ force: true });
  await page.waitForTimeout(1500);
  const blocksAfterDelete = await notesFrame.evaluate(() => document.querySelectorAll('.ce-block').length);
  console.log("Blocos depois do delete:", blocksAfterDelete);
  console.log(blocksAfterDelete < blocksBeforeDelete ? "PASS: Excluir funcionou" : "FAIL: Excluir não removeu");
} else {
  console.log("FAIL: botão delete não encontrado");
}

// Testar conversão para Citação
await frame.locator('.ce-block .ce-block__content').first().click();
await page.waitForTimeout(500);
const box2 = await frame.locator('.ce-block .ce-block__content').first().boundingBox();
if (box2) { await page.mouse.move(box2.x + box2.width / 2, box2.y + 5); await page.waitForTimeout(800); }
await frame.locator('.ce-toolbar__settings-btn').first().click({ force: true });
await page.waitForTimeout(2000);
const convertItem = frame.locator('.ce-popover-item[data-item-name="convert-to"]').first();
await convertItem.hover();
await page.waitForTimeout(2500);
const quoteBtn = frame.locator('.ce-popover--nested .ce-popover-item[data-item-name="quote"]').first();
if (await quoteBtn.count() > 0) {
  await quoteBtn.click({ force: true });
  await page.waitForTimeout(1500);
  const blockType = await notesFrame.evaluate(() => {
    const block = document.querySelector('.ce-block');
    if (!block) return 'none';
    if (block.querySelector('.editor-quote')) return 'quote';
    if (block.querySelector('.editor-code')) return 'code';
    if (block.querySelector('.editor-divider')) return 'divider';
    return 'paragraph';
  });
  console.log("\nTipo do bloco após converter para quote:", blockType);
  console.log(blockType === 'quote' ? "PASS: Conversão para Citação funcionou" : "FAIL: Conversão não funcionou (tipo: " + blockType + ")");
} else {
  console.log("FAIL: botão quote não encontrado no submenu");
}

await browser.close();
