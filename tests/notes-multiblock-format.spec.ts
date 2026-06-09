import { expect, test, type APIRequestContext, type Page } from "playwright/test";

const BASE_URL = process.env.TCLOUD_BASE_URL || "http://127.0.0.1:8080";
const USERNAME = process.env.TCLOUD_USER || "tcloud";
const PASSWORD = process.env.TCLOUD_PASSWORD || "tcloud123";

type NoteBlock = {
  id?: string;
  type: string;
  data: Record<string, unknown>;
};

async function login(request: APIRequestContext) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { username: USERNAME, password: PASSWORD, remember: true },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.token).toBeTruthy();
  return body.token as string;
}

async function createNote(request: APIRequestContext, token: string, blocks: NoteBlock[]) {
  const response = await request.post(`${BASE_URL}/api/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `QA multiblocos ${Date.now()}`,
      content: { time: Date.now(), blocks, version: "2.31.6" },
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.note?.id).toBeTruthy();
  return body.note.id as string;
}

async function openNote(page: Page, token: string, noteId: string, width = 1280, height = 900) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((authToken) => {
    window.localStorage.setItem("tcloud_token", authToken as string);
  }, token);
  await page.goto(`${BASE_URL}/apps/notes/index.html#note=${noteId}`);
  await page.waitForSelector(".editorjs-host .codex-editor", { state: "visible" });
  await page.waitForSelector(".ce-block", { state: "visible" });
}

async function selectBlocks(page: Page, startIndex: number, endIndex: number) {
  await page.evaluate(({ startIndex: start, endIndex: end }) => {
    const blocks = Array.from(document.querySelectorAll(".editorjs-host .ce-block"));
    const startEditable = blocks[start]?.querySelector("[contenteditable='true']");
    const endEditable = blocks[end]?.querySelector("[contenteditable='true']");
    const textNodeFor = (node: Element | null) => {
      if (!node) return null;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      return walker.nextNode() || node;
    };
    const startNode = textNodeFor(startEditable);
    const endNode = textNodeFor(endEditable);
    if (!startNode || !endNode) return false;

    blocks.forEach((block, index) => {
      block.classList.toggle("ce-block--selected", index >= start && index <= end);
    });

    const range = document.createRange();
    range.setStart(startNode, 0);
    range.setEnd(endNode, endNode.nodeType === Node.TEXT_NODE ? (endNode.textContent || "").length : endNode.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    const editor = (window as any).state?.editor;
    editor?.blockSelectionController?.sync?.();
    if (editor?.toolbarController) {
      editor.toolbarController.closedSelectionSignature = null;
      editor.toolbarController.showInlineToolbar?.(range);
    }
    return true;
  }, { startIndex, endIndex });

  await expect.poll(async () => page.locator(".editorjs-host .ce-block.is-tcloud-range-selected").count()).toBe(endIndex - startIndex + 1);
  await expect(page.locator(".tcloud-inline-toolbar--custom.is-open")).toHaveCount(1);
}

async function selectNativeRangeOnly(page: Page, startIndex: number, endIndex: number) {
  await page.evaluate(({ startIndex: start, endIndex: end }) => {
    const blocks = Array.from(document.querySelectorAll(".editorjs-host .ce-block")) as HTMLElement[];
    const targetEditable = blocks[start]?.querySelector("[contenteditable='true']");
    const endEditable = blocks[end]?.querySelector("[contenteditable='true']");
    const walker = targetEditable ? document.createTreeWalker(targetEditable, NodeFilter.SHOW_TEXT) : null;
    const endWalker = endEditable ? document.createTreeWalker(endEditable, NodeFilter.SHOW_TEXT) : null;
    const startNode = walker?.nextNode() || targetEditable;
    const endNode = endWalker?.nextNode() || endEditable;
    if (!startNode || !endNode) return false;

    const range = document.createRange();
    range.setStart(startNode, 0);
    range.setEnd(endNode, endNode.nodeType === Node.TEXT_NODE ? (endNode.textContent || "").length : endNode.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    blocks.forEach((block) => {
      block.classList.remove("ce-block--selected", "is-tcloud-range-selected", "is-tcloud-selection-start", "is-tcloud-selection-end");
      block.removeAttribute("data-tcloud-selected-index");
    });

    const editor = (window as any).state?.editor;
    if (editor?.toolbarController) {
      editor.toolbarController.closedSelectionSignature = null;
      editor.toolbarController.showInlineToolbar?.(range);
    }
    return true;
  }, { startIndex, endIndex });

  await expect(page.locator(".tcloud-inline-toolbar--custom.is-open")).toHaveCount(1);
}

async function savedBlocks(page: Page) {
  return page.evaluate(async () => {
    const content = await (window as any).state.editor.save();
    return content.blocks;
  }) as Promise<NoteBlock[]>;
}

async function persistedBlocks(request: APIRequestContext, token: string, noteId: string) {
  const response = await request.get(`${BASE_URL}/api/notes/${encodeURIComponent(noteId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  const content = body.note?.content || body.content;
  const parsed = typeof content === "string" ? JSON.parse(content) : content;
  return parsed.blocks as NoteBlock[];
}

async function clickBlockAction(page: Page, action: string) {
  await page.locator('.tcloud-inline-toolbar--custom [data-tcloud-action="block-menu"]').click();
  await page.locator(`.tcloud-inline-toolbar__block-menu [data-tcloud-action="${action}"]`).click();
}

test.describe("TCloud Notes multiblock formatting", () => {
  test("converts selected paragraphs to checklist and undo restores them as one operation", async ({ page, request }) => {
    const token = await login(request);
    const blocks = Array.from({ length: 5 }, (_, index) => ({
      id: `para${index}`,
      type: "paragraph",
      data: { text: `Linha ${index + 1}` },
    }));
    const noteId = await createNote(request, token, blocks);
    await openNote(page, token, noteId);

    await selectBlocks(page, 0, 4);
    await expect(page.locator("[data-tcloud-selection-count]")).toHaveText("5 blocos");
    await clickBlockAction(page, "block:todo");

    await expect.poll(async () => (await savedBlocks(page)).map((block) => block.type)).toEqual([
      "todo",
      "todo",
      "todo",
      "todo",
      "todo",
    ]);
    await expect.poll(async () => page.evaluate(() => (window as any).state.editor.historyIndex)).toBeGreaterThan(0);
    expect((await savedBlocks(page)).map((block) => block.id)).toEqual(blocks.map((block) => block.id));

    await page.evaluate(() => (window as any).state.editor.undo());
    await expect.poll(async () => (await savedBlocks(page)).map((block) => block.type)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
  });

  test("converts compatible blocks and preserves protected blocks, ids, and indent", async ({ page, request }) => {
    const token = await login(request);
    const blocks: NoteBlock[] = [
      { id: "txt1", type: "paragraph", data: { text: "Primeiro" } },
      { id: "file1", type: "tcloudFile", data: { name: "arquivo.pdf", path: "/qa/arquivo.pdf", mime: "application/pdf" } },
      { id: "div1", type: "divider", data: {} },
      { id: "txt2", type: "paragraph", data: { text: "Segundo", tcloudIndent: { level: 2 } } },
    ];
    const noteId = await createNote(request, token, blocks);
    await openNote(page, token, noteId);
    await page.evaluate(() => {
      const block = document.querySelectorAll(".editorjs-host .ce-block")[3] as HTMLElement | undefined;
      block?.setAttribute("data-tcloud-indent", "2");
      block?.style.setProperty("--tcloud-indent-level", "2");
      const contentBlock = (window as any).state.editor.lastSavedContent.blocks[3];
      contentBlock.data.tcloudIndent = { level: 2 };
    });

    await selectBlocks(page, 0, 3);
    await expect(page.locator("[data-tcloud-selection-count]")).toHaveText("4 blocos · 2 ignorados");
    await clickBlockAction(page, "block:header:2");
    await expect.poll(async () => page.evaluate(() => (window as any).state.editor.historyIndex)).toBeGreaterThan(0);

    const result = await savedBlocks(page);
    expect(result.map((block) => block.type)).toEqual(["header", "tcloudFile", "divider", "header"]);
    expect(result.map((block) => block.id)).toEqual(blocks.map((block) => block.id));
    expect(result[3].data.tcloudIndent).toEqual({ level: 2 });
  });

  test("applies text color and highlight to selected blocks and persists after reload", async ({ page, request }) => {
    const token = await login(request);
    const blocks = [0, 1, 2].map((index) => ({
      id: `color${index}`,
      type: "paragraph",
      data: { text: `Cor ${index + 1}` },
    }));
    const noteId = await createNote(request, token, blocks);
    await openNote(page, token, noteId, 900, 620);

    await selectBlocks(page, 0, 2);
    await page.evaluate(() => {
      const editor = (window as any).state.editor;
      return editor.applyColorToSelectedBlocks("text", "#E5484D", editor.toolbarController.savedRange);
    });
    await expect.poll(async () => {
      const current = await savedBlocks(page);
      return current.every((block) => String(block.data.text).includes("color"));
    }).toBeTruthy();

    await selectBlocks(page, 0, 2);
    await page.evaluate(() => {
      const editor = (window as any).state.editor;
      return editor.applyColorToSelectedBlocks("background", "#FEE2E2", editor.toolbarController.savedRange);
    });

    await expect.poll(async () => {
      const current = await savedBlocks(page);
      return current.every((block) => String(block.data.text).includes("span") && String(block.data.text).includes("background"));
    }).toBeTruthy();
    await expect.poll(async () => {
      const current = await persistedBlocks(request, token, noteId);
      return current.every((block) => String(block.data.text).includes("span") && String(block.data.text).includes("background"));
    }, { timeout: 5000 }).toBeTruthy();

    await page.reload();
    await page.waitForSelector(".editorjs-host .codex-editor", { state: "visible" });
    await expect.poll(async () => page.locator(".editorjs-host .ce-block span[style]").count()).toBeGreaterThanOrEqual(3);
  });

  test("syncs native multi-block range before toolbar actions", async ({ page, request }) => {
    const token = await login(request);
    const blocks = [0, 1, 2, 3].map((index) => ({
      id: `visual${index}`,
      type: "paragraph",
      data: { text: `Visual ${index + 1}` },
    }));
    const noteId = await createNote(request, token, blocks);
    await openNote(page, token, noteId);

    await selectNativeRangeOnly(page, 1, 3);
    await expect(page.locator("[data-tcloud-selection-count]")).toHaveText("3 blocos");
    await page.locator('.tcloud-inline-toolbar--custom [data-tcloud-action="bold"]').click();

    await expect.poll(async () => {
      const current = await savedBlocks(page);
      return [1, 2, 3].every((index) => /<(strong|b)>/.test(String(current[index].data.text)));
    }).toBeTruthy();
    expect(/<(strong|b)>/.test(String((await savedBlocks(page))[0].data.text))).toBeFalsy();
  });

  test("toggles bold and clears inline formatting across selected blocks", async ({ page, request }) => {
    const token = await login(request);
    const blocks = [0, 1, 2].map((index) => ({
      id: `fmt${index}`,
      type: "paragraph",
      data: { text: `Formato ${index + 1}` },
    }));
    const noteId = await createNote(request, token, blocks);
    await openNote(page, token, noteId);

    await selectBlocks(page, 0, 2);
    await page.evaluate(() => {
      const editor = (window as any).state.editor;
      return editor.applyInlineActionToSelectedBlocks("bold", editor.toolbarController.savedRange);
    });
    await expect.poll(async () => {
      const current = await savedBlocks(page);
      return current.every((block) => /<(strong|b)>/.test(String(block.data.text)));
    }).toBeTruthy();

    await selectBlocks(page, 0, 2);
    await page.evaluate(() => {
      const editor = (window as any).state.editor;
      return editor.applyInlineActionToSelectedBlocks("clear", editor.toolbarController.savedRange);
    });

    await expect.poll(async () => {
      const current = await savedBlocks(page);
      return current.every((block) => !/<(strong|b|span|em|i|u|s|strike|code)(\\s|>)/.test(String(block.data.text)));
    }).toBeTruthy();
  });
});
