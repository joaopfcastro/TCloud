# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/notes-block-focus.spec.ts >> TCloud Notes Block Focus and Alignment >> aligns plus/settings drag handle with paragraph block center
- Location: tests/notes-block-focus.spec.ts:84:7

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: apiRequestContext.post: Request context disposed.
Call log:
  - → POST http://127.0.0.1:8080/api/notes
    - user-agent: Playwright/1.60.0 (arm64; macOS 26.5) node/25.5
    - accept: */*
    - accept-encoding: gzip,deflate,br
    - Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0Y2xvdWQiLCJpYXQiOjE3ODI3MDc1NDAsImV4cCI6MTgxNDI0MzU0MH0.QAjIFApVgrBlKQgsx1ye-Y_ZuCnin4UVCwz9HqGN1pA
    - content-type: application/json
    - content-length: 208

```

# Test source

```ts
  1   | import { expect, test, type APIRequestContext, type Page } from "playwright/test";
  2   | 
  3   | const BASE_URL = process.env.TCLOUD_BASE_URL || "http://127.0.0.1:8080";
  4   | const USERNAME = process.env.TCLOUD_USER || "tcloud";
  5   | const PASSWORD = process.env.TCLOUD_PASSWORD || "tcloud123";
  6   | 
  7   | async function login(request: APIRequestContext) {
  8   |   const response = await request.post(`${BASE_URL}/api/auth/login`, {
  9   |     data: { username: USERNAME, password: PASSWORD, remember: true },
  10  |   });
  11  |   expect(response.ok()).toBeTruthy();
  12  |   const body = await response.json();
  13  |   expect(body.token).toBeTruthy();
  14  |   return body.token as string;
  15  | }
  16  | 
  17  | async function createFocusNote(request: APIRequestContext, token: string) {
  18  |   const blocks = [
  19  |     {
  20  |       type: "paragraph",
  21  |       data: { text: "QA cores 1779675342100" },
  22  |     },
  23  |     {
  24  |       type: "paragraph",
  25  |       data: { text: "Paragraph" },
  26  |     },
  27  |   ];
> 28  |   const response = await request.post(`${BASE_URL}/api/notes`, {
      |                                  ^ Error: apiRequestContext.post: Request context disposed.
  29  |     headers: { Authorization: `Bearer ${token}` },
  30  |     data: {
  31  |       title: `QA cores ${Date.now()}`,
  32  |       content: { time: Date.now(), blocks, version: "2.31.6" },
  33  |     },
  34  |   });
  35  |   expect(response.ok()).toBeTruthy();
  36  |   const body = await response.json();
  37  |   expect(body.note?.id).toBeTruthy();
  38  |   return body.note.id as string;
  39  | }
  40  | 
  41  | async function openNote(page: Page, token: string, noteId: string, width: number, height: number) {
  42  |   await page.setViewportSize({ width, height });
  43  |   await page.addInitScript((authToken) => {
  44  |     window.localStorage.setItem("tcloud_token", authToken as string);
  45  |   }, token);
  46  |   await page.goto(`${BASE_URL}/apps/notes/index.html#note=${noteId}`);
  47  |   await page.waitForSelector(".editorjs-host .codex-editor", { state: "visible" });
  48  |   await page.waitForSelector(".ce-block", { state: "visible" });
  49  | }
  50  | 
  51  | async function activeEditorBlockText(page: Page) {
  52  |   return page.evaluate(() => document.activeElement?.closest(".ce-block")?.textContent?.trim() || "");
  53  | }
  54  | 
  55  | async function activeColonIconIndex(page: Page) {
  56  |   return page.evaluate(() => {
  57  |     const options = Array.from(document.querySelectorAll("#colon-icon-menu [data-icon-value]"));
  58  |     return options.findIndex((option) => option.classList.contains("is-active"));
  59  |   });
  60  | }
  61  | 
  62  | async function clickVisibleControl(page: Page, selector: string) {
  63  |   const point = await page.locator(selector).evaluate((_, controlSelector) => {
  64  |     const controls = Array.from(document.querySelectorAll(controlSelector as string)) as HTMLElement[];
  65  |     const visible = controls
  66  |       .map((control) => ({ control, rect: control.getBoundingClientRect() }))
  67  |       .filter(({ rect }) => rect.width > 8 && rect.height > 8 && rect.top >= 0 && rect.bottom <= window.innerHeight)
  68  |       .sort((a, b) => {
  69  |         const aArea = a.rect.width * a.rect.height;
  70  |         const bArea = b.rect.width * b.rect.height;
  71  |         return bArea - aArea;
  72  |       })[0];
  73  |     if (!visible) return null;
  74  |     return {
  75  |       x: visible.rect.left + visible.rect.width / 2,
  76  |       y: visible.rect.top + visible.rect.height / 2,
  77  |     };
  78  |   }, selector);
  79  |   expect(point).toBeTruthy();
  80  |   await page.mouse.click(point!.x, point!.y);
  81  | }
  82  | 
  83  | test.describe("TCloud Notes Block Focus and Alignment", () => {
  84  |   test("aligns plus/settings drag handle with paragraph block center", async ({ page, request }) => {
  85  |     const token = await login(request);
  86  |     const noteId = await createFocusNote(request, token);
  87  |     await openNote(page, token, noteId, 1024, 768);
  88  | 
  89  |     // Hover the second paragraph block to trigger the toolbar
  90  |     const paragraphs = page.locator(".editorjs-host .ce-block");
  91  |     const targetParagraph = paragraphs.nth(1);
  92  |     await targetParagraph.hover();
  93  |     await page.waitForTimeout(100);
  94  | 
  95  |     const dragHandle = page.locator(".ce-toolbar__settings-btn");
  96  |     await expect(dragHandle).toBeVisible();
  97  | 
  98  |     const blockBox = await targetParagraph.boundingBox();
  99  |     const dragHandleLocator = page.locator(".ce-toolbar__settings-btn");
  100 |     const handleBox = await dragHandleLocator.boundingBox();
  101 | 
  102 |     console.log("Block bounding box:", JSON.stringify(blockBox));
  103 |     console.log("Handle bounding box:", JSON.stringify(handleBox));
  104 | 
  105 |     expect(blockBox).toBeTruthy();
  106 |     expect(handleBox).toBeTruthy();
  107 | 
  108 |     const blockCenterY = blockBox!.y + blockBox!.height / 2;
  109 |     const handleCenterY = handleBox!.y + handleBox!.height / 2;
  110 | 
  111 |     const diff = Math.abs(blockCenterY - handleCenterY);
  112 |     console.log(`Block Y center: ${blockCenterY}, Handle Y center: ${handleCenterY}, Diff: ${diff}`);
  113 | 
  114 |     expect(diff).toBeLessThanOrEqual(10);
  115 |   });
  116 | 
  117 |   test("keeps colon icon menu open long enough to insert an emoji", async ({ page, request }) => {
  118 |     const token = await login(request);
  119 |     const noteId = await createFocusNote(request, token);
  120 |     await openNote(page, token, noteId, 1180, 760);
  121 | 
  122 |     const targetEditable = page.locator(".editorjs-host [contenteditable='true']").nth(1);
  123 |     await targetEditable.click();
  124 |     await page.keyboard.press("End");
  125 |     await page.keyboard.type(" :heart");
  126 |     await page.waitForSelector('#colon-icon-menu.is-open [data-icon-value="❤️"]', { state: "visible" });
  127 |     await page.locator('#colon-icon-menu [data-icon-value="❤️"]').click();
  128 | 
```