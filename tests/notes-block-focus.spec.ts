import { expect, test, type APIRequestContext, type Page } from "playwright/test";

const BASE_URL = process.env.TCLOUD_BASE_URL || "http://127.0.0.1:8080";
const USERNAME = process.env.TCLOUD_USER || "tcloud";
const PASSWORD = process.env.TCLOUD_PASSWORD || "tcloud123";

async function login(request: APIRequestContext) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { username: USERNAME, password: PASSWORD, remember: true },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.token).toBeTruthy();
  return body.token as string;
}

async function createFocusNote(request: APIRequestContext, token: string) {
  const blocks = [
    {
      type: "paragraph",
      data: { text: "QA cores 1779675342100" },
    },
    {
      type: "paragraph",
      data: { text: "Paragraph" },
    },
  ];
  const response = await request.post(`${BASE_URL}/api/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `QA cores ${Date.now()}`,
      content: { time: Date.now(), blocks, version: "2.31.6" },
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.note?.id).toBeTruthy();
  return body.note.id as string;
}

async function openNote(page: Page, token: string, noteId: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((authToken) => {
    window.localStorage.setItem("tcloud_token", authToken as string);
  }, token);
  await page.goto(`${BASE_URL}/apps/notes/index.html#note=${noteId}`);
  await page.waitForSelector(".editorjs-host .codex-editor", { state: "visible" });
  await page.waitForSelector(".ce-block", { state: "visible" });
}

async function activeEditorBlockText(page: Page) {
  return page.evaluate(() => document.activeElement?.closest(".ce-block")?.textContent?.trim() || "");
}

async function activeColonIconIndex(page: Page) {
  return page.evaluate(() => {
    const options = Array.from(document.querySelectorAll("#colon-icon-menu [data-icon-value]"));
    return options.findIndex((option) => option.classList.contains("is-active"));
  });
}

async function clickVisibleControl(page: Page, selector: string) {
  const point = await page.locator(selector).evaluate((_, controlSelector) => {
    const controls = Array.from(document.querySelectorAll(controlSelector as string)) as HTMLElement[];
    const visible = controls
      .map((control) => ({ control, rect: control.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 8 && rect.height > 8 && rect.top >= 0 && rect.bottom <= window.innerHeight)
      .sort((a, b) => {
        const aArea = a.rect.width * a.rect.height;
        const bArea = b.rect.width * b.rect.height;
        return bArea - aArea;
      })[0];
    if (!visible) return null;
    return {
      x: visible.rect.left + visible.rect.width / 2,
      y: visible.rect.top + visible.rect.height / 2,
    };
  }, selector);
  expect(point).toBeTruthy();
  await page.mouse.click(point!.x, point!.y);
}

test.describe("TCloud Notes Block Focus and Alignment", () => {
  test("aligns plus/settings drag handle with paragraph block center", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createFocusNote(request, token);
    await openNote(page, token, noteId, 1024, 768);

    // Hover the second paragraph block to trigger the toolbar
    const paragraphs = page.locator(".editorjs-host .ce-block");
    const targetParagraph = paragraphs.nth(1);
    await targetParagraph.hover();
    await page.waitForTimeout(100);

    const dragHandle = page.locator(".ce-toolbar__settings-btn");
    await expect(dragHandle).toBeVisible();

    const blockBox = await targetParagraph.boundingBox();
    const dragHandleLocator = page.locator(".ce-toolbar__settings-btn");
    const handleBox = await dragHandleLocator.boundingBox();

    console.log("Block bounding box:", JSON.stringify(blockBox));
    console.log("Handle bounding box:", JSON.stringify(handleBox));

    expect(blockBox).toBeTruthy();
    expect(handleBox).toBeTruthy();

    const blockCenterY = blockBox!.y + blockBox!.height / 2;
    const handleCenterY = handleBox!.y + handleBox!.height / 2;

    const diff = Math.abs(blockCenterY - handleCenterY);
    console.log(`Block Y center: ${blockCenterY}, Handle Y center: ${handleCenterY}, Diff: ${diff}`);

    expect(diff).toBeLessThanOrEqual(10);
  });

  test("keeps colon icon menu open long enough to insert an emoji", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createFocusNote(request, token);
    await openNote(page, token, noteId, 1180, 760);

    const targetEditable = page.locator(".editorjs-host [contenteditable='true']").nth(1);
    await targetEditable.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" :heart");
    await page.waitForSelector('#colon-icon-menu.is-open [data-icon-value="❤️"]', { state: "visible" });
    await page.locator('#colon-icon-menu [data-icon-value="❤️"]').click();

    await expect(targetEditable).toContainText("❤️");
    await expect(page.locator("#colon-icon-menu")).toHaveClass(/hidden/);
  });

  test("keeps colon icon keyboard isolated and preserves Editor.js block controls", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createFocusNote(request, token);
    await openNote(page, token, noteId, 1180, 760);

    const targetBlock = page.locator(".editorjs-host .ce-block").nth(1);
    const targetEditable = page.locator(".editorjs-host [contenteditable='true']").nth(1);
    await targetEditable.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" :heart");
    await page.waitForSelector('#colon-icon-menu.is-open [data-icon-value="❤️"]', { state: "visible" });

    const beforeBlock = await activeEditorBlockText(page);
    const beforeIndex = await activeColonIconIndex(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");

    expect(await activeEditorBlockText(page)).toBe(beforeBlock);
    expect(await activeColonIconIndex(page)).not.toBe(beforeIndex);

    await page.keyboard.press("Enter");
    await expect(targetEditable).toContainText("❤️");
    await expect(page.locator("#colon-icon-menu")).toHaveClass(/hidden/);
    await expect.poll(() => activeEditorBlockText(page)).toContain("❤️");

    await targetBlock.hover();
    await clickVisibleControl(page, ".ce-toolbar__plus");
    await expect(page.locator(".tcloud-editor-popover-positioned .cdx-search-field").first()).toBeVisible();

    await page.keyboard.press("Escape");
    await targetBlock.hover();
    await clickVisibleControl(page, ".ce-toolbar__settings-btn");
    await expect(page.locator(".tcloud-editor-popover-positioned").first()).toContainText(/Mover|Excluir|Converter/);
  });

  test("closes colon icon menu with Escape without moving the active block", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createFocusNote(request, token);
    await openNote(page, token, noteId, 1180, 760);

    const targetEditable = page.locator(".editorjs-host [contenteditable='true']").nth(1);
    await targetEditable.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" :heart");
    await page.waitForSelector('#colon-icon-menu.is-open [data-icon-value="❤️"]', { state: "visible" });

    const beforeBlock = await activeEditorBlockText(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");

    await expect(page.locator("#colon-icon-menu")).toHaveClass(/hidden/);
    expect(await activeEditorBlockText(page)).toBe(beforeBlock);
  });

});
