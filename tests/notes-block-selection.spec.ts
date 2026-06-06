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

async function createMultiBlockNote(request: APIRequestContext, token: string) {
  const blocks = [
    {
      type: "paragraph",
      data: { text: "QA cores 1779675342100" },
    },
    {
      type: "paragraph",
      data: { text: "Paragraph" },
    },
    {
      type: "paragraph",
      data: { text: "JBJHBH" },
    },
    {
      type: "paragraph",
      data: { text: "BJHGHHHG" },
    },
    {
      type: "paragraph",
      data: { text: "JKHKJ" },
    },
  ];
  const response = await request.post(`${BASE_URL}/api/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `QA cores multi ${Date.now()}`,
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

test.describe("TCloud Notes Block Selection and Highlighting", () => {
  test("single active block has visible active class", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createMultiBlockNote(request, token);
    await openNote(page, token, noteId, 1024, 768);

    // Click inside the second paragraph to focus it
    const paragraph = page.locator(".editorjs-host .ce-block").nth(1).locator("[contenteditable='true']");
    await paragraph.click();
    await page.waitForTimeout(200);

    const activeBlockCount = await page.locator(".ce-block.is-tcloud-active-block").count();
    expect(activeBlockCount).toBe(1);

    const activeContainerCount = await page.locator(".editorjs-host.has-tcloud-active-block").count();
    expect(activeContainerCount).toBe(1);
  });

  test("multi-block selection marks every intersected block and forms group", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createMultiBlockNote(request, token);
    await openNote(page, token, noteId, 1024, 768);

    // Add native Editor.js block selection class programmatically to simulate selection
    await page.evaluate(() => {
      const blocks = document.querySelectorAll(".editorjs-host .ce-block");
      blocks[1].classList.add("ce-block--selected");
      blocks[2].classList.add("ce-block--selected");
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.waitForTimeout(500);

    // Expect blocks to be marked as selected in range
    const selectedCount = await page.locator(".ce-block.is-tcloud-range-selected").count();
    expect(selectedCount).toBe(2);

    // Expect start and end classes to be applied correctly
    const hasStart = await page.locator(".ce-block.is-tcloud-selection-start").count();
    expect(hasStart).toBe(1);

    const hasEnd = await page.locator(".ce-block.is-tcloud-selection-end").count();
    expect(hasEnd).toBe(1);

    const hasMultiClass = await page.locator(".editorjs-host.has-tcloud-multiblock-selection").count();
    expect(hasMultiClass).toBe(1);
  });

  test("native text range also applies range selection classes", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createMultiBlockNote(request, token);
    await openNote(page, token, noteId, 1024, 768);

    await page.evaluate(() => {
      const blocks = document.querySelectorAll(".editorjs-host .ce-block");
      const range = document.createRange();
      const firstTextNode = blocks[1].querySelector("[contenteditable='true']").firstChild || blocks[1].querySelector("[contenteditable='true']");
      const lastTextNode = blocks[3].querySelector("[contenteditable='true']").firstChild || blocks[3].querySelector("[contenteditable='true']");

      range.setStart(firstTextNode, 0);
      range.setEnd(lastTextNode, 1);
      
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      
      document.dispatchEvent(new Event("selectionchange"));
    });

    await page.waitForTimeout(300);

    const selectedCount = await page.locator(".ce-block.is-tcloud-range-selected").count();
    expect(selectedCount).toBe(3);
  });
});
