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

    // Diff should be less than or equal to 2 pixels for single line paragraph
    expect(diff).toBeLessThanOrEqual(2);
  });
});
