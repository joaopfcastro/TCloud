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

async function createInlineToolbarSelectionNote(request: APIRequestContext, token: string) {
  const blocks = [
    {
      type: "paragraph",
      data: { text: "Primeiro bloco com texto suficiente para arrastar a selecao com seguranca." },
    },
    {
      type: "paragraph",
      data: { text: "Segundo bloco no meio da selecao para validar que a toolbar nao interrompe o drag." },
    },
    {
      type: "paragraph",
      data: { text: "Terceiro bloco fecha a selecao e precisa continuar completamente selecionavel." },
    },
    {
      type: "paragraph",
      data: { text: "Quarto bloco de apoio para manter a tela com espaco de editor real." },
    },
  ];
  const response = await request.post(`${BASE_URL}/api/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `QA toolbar drag ${Date.now()}`,
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
  test("active caret block does not apply visual active classes", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createMultiBlockNote(request, token);
    await openNote(page, token, noteId, 1024, 768);

    // Click inside the second paragraph to focus it
    const paragraph = page.locator(".editorjs-host .ce-block").nth(1).locator("[contenteditable='true']");
    await paragraph.click();
    await page.waitForTimeout(200);

    // After refactor: caret position must NOT paint any background
    const activeBlockCount = await page.locator(".ce-block.is-tcloud-active-block").count();
    expect(activeBlockCount).toBe(0);

    const activeContainerCount = await page.locator(".editorjs-host.has-tcloud-active-block").count();
    expect(activeContainerCount).toBe(0);
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

  test("inline toolbar waits until pointerup and stays outside a multi-block selection", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createInlineToolbarSelectionNote(request, token);
    await openNote(page, token, noteId, 1280, 900);

    const editables = page.locator(".editorjs-host .ce-block [contenteditable='true']");
    const startBox = await editables.nth(0).boundingBox();
    const endBox = await editables.nth(2).boundingBox();

    expect(startBox).toBeTruthy();
    expect(endBox).toBeTruthy();

    await page.mouse.move(
      startBox!.x + Math.min(160, Math.max(24, startBox!.width - 24)),
      startBox!.y + startBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      endBox!.x + Math.min(180, Math.max(28, endBox!.width - 20)),
      endBox!.y + endBox!.height / 2,
      { steps: 24 },
    );

    await expect(page.locator(".tcloud-inline-toolbar--custom.is-open")).toHaveCount(0);
    await page.mouse.up();

    await expect.poll(async () => page.locator(".ce-block.is-tcloud-range-selected").count()).toBe(3);

    // After the fix, the inline toolbar opens on multi-block selection even when the
    // browser normalizes the vertical drag into block selection without a live text range.
    const toolbar = page.locator(".tcloud-inline-toolbar--custom.is-open");
    await expect(toolbar).toHaveCount(1);

    const toolbarAvoidsSelection = await page.evaluate(() => {
      const toolbarElement = document.querySelector(".tcloud-inline-toolbar--custom.is-open");
      const selectedBlocks = Array.from(document.querySelectorAll(".editorjs-host .ce-block.is-tcloud-range-selected"));
      if (!toolbarElement || !selectedBlocks.length) return false;

      const toolbarRect = toolbarElement.getBoundingClientRect();
      const blockRects = selectedBlocks.map((block) => block.getBoundingClientRect());
      const selectionBounds = {
        left: Math.min(...blockRects.map((rect) => rect.left)),
        top: Math.min(...blockRects.map((rect) => rect.top)),
        right: Math.max(...blockRects.map((rect) => rect.right)),
        bottom: Math.max(...blockRects.map((rect) => rect.bottom)),
      };

      return (
        toolbarRect.bottom <= selectionBounds.top ||
        toolbarRect.top >= selectionBounds.bottom ||
        toolbarRect.right <= selectionBounds.left ||
        toolbarRect.left >= selectionBounds.right
      );
    });
    expect(toolbarAvoidsSelection).toBeTruthy();

    await page.evaluate(() => {
      document.querySelectorAll(".editorjs-host .ce-block").forEach((block) => {
        block.classList.remove("ce-block--selected", "is-tcloud-range-selected", "is-tcloud-selection-start", "is-tcloud-selection-end");
      });
      const editable = document.querySelector(".editorjs-host .ce-block [contenteditable='true']");
      const textNode = editable?.firstChild || editable;
      const content = textNode?.textContent || "";
      const start = content.indexOf("Primeiro");
      if (!textNode || start < 0) return;

      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + "Primeiro".length);

      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });

    await expect(toolbar).toHaveCount(1);
    await expect.poll(async () => page.evaluate(() => {
      const toolbarElement = document.querySelector(".tcloud-inline-toolbar--custom.is-open");
      const selection = window.getSelection();
      if (!toolbarElement || !selection?.rangeCount) return Number.POSITIVE_INFINITY;
      const selectionRect = selection.getRangeAt(0).getBoundingClientRect();
      const toolbarRect = toolbarElement.getBoundingClientRect();
      if (!selectionRect.width && !selectionRect.height) return Number.POSITIVE_INFINITY;
      if (toolbarRect.bottom <= selectionRect.top) return selectionRect.top - toolbarRect.bottom;
      if (toolbarRect.top >= selectionRect.bottom) return toolbarRect.top - selectionRect.bottom;
      return 0;
    })).toBeLessThanOrEqual(16);
    await page.locator('.tcloud-inline-toolbar--custom [data-tcloud-action="bold"]').click();

    await expect.poll(async () => page.evaluate(() => {
      const html = document.querySelector(".editorjs-host .ce-block [contenteditable='true']")?.innerHTML || "";
      return /<(strong|b)>Primeiro<\/(strong|b)>/.test(html);
    })).toBeTruthy();
  });
});
