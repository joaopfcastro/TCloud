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

async function createNote(request: APIRequestContext, token: string, title: string, blocks: NoteBlock[]) {
  const response = await request.post(`${BASE_URL}/api/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title,
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

test.describe("TCloud Notes Navigation", () => {
  test("focuses the first editor block after opening a note", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createNote(request, token, `QA nav focus ${Date.now()}`, [
      { type: "paragraph", data: { text: "Primeiro bloco para foco" } },
      { type: "paragraph", data: { text: "Segundo bloco" } },
    ]);
    await openNote(page, token, noteId);

    await expect.poll(async () => {
      return page.evaluate(() => {
        const active = document.activeElement;
        return Boolean(active?.closest?.(".editorjs-host .codex-editor"));
      });
    }, { timeout: 5000 }).toBeTruthy();
  });

  test("navigates the sidebar note list with ArrowDown and ArrowUp", async ({ page, request }) => {
    const token = await login(request);
    const note1Id = await createNote(request, token, `QA nav A ${Date.now()}`, [
      { type: "paragraph", data: { text: "Nota A" } },
    ]);
    await createNote(request, token, `QA nav B ${Date.now() + 1}`, [
      { type: "paragraph", data: { text: "Nota B" } },
    ]);
    await openNote(page, token, note1Id);

    await page.locator(".notes-list .note-card[data-id]").first().waitFor({ state: "attached" });
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(".notes-list .note-card[data-id]"));
      const visible = cards.filter((c) => c.offsetParent !== null && c.getClientRects().length > 0);
      if (visible.length) visible[0].focus({ preventScroll: true });
    });
    await page.waitForTimeout(500);

    const beforeId = await page.evaluate(() => {
      const active = document.activeElement;
      return active?.dataset?.id || active?.className || "";
    });

    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => {
      return page.evaluate(() => {
        const active = document.activeElement;
        return active?.dataset?.id || active?.className || "";
      });
    }, { timeout: 5000 }).not.toBe(beforeId);

    const downId = await page.evaluate(() => {
      const active = document.activeElement;
      return active?.dataset?.id || active?.className || "";
    });

    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => {
      return page.evaluate(() => {
        const active = document.activeElement;
        return active?.dataset?.id || active?.className || "";
      });
    }, { timeout: 5000 }).not.toBe(downId);
  });

  test("wiki-link autocomplete supports ArrowDown and Enter keyboard navigation", async ({ page, request }) => {
    const token = await login(request);
    const targetTitle = `Wiki Target ${Date.now()}`;
    await createNote(request, token, targetTitle, [
      { type: "paragraph", data: { text: "Conteudo alvo wiki" } },
    ]);
    const noteId = await createNote(request, token, `Wiki Source ${Date.now() + 1}`, [
      { type: "paragraph", data: { text: "Texto inicial" } },
    ]);
    await openNote(page, token, noteId);

    const editable = page.locator(".editorjs-host .ce-block [contenteditable='true']").first();
    await editable.click();
    await editable.press("End");
    await page.keyboard.type(" ", { delay: 50 });
    await page.keyboard.type("[", { delay: 50 });
    await page.keyboard.type("[", { delay: 50 });

    await expect(page.locator(".wiki-link-menu:not(.hidden)")).toBeVisible({ timeout: 8000 });

    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => {
      return page.evaluate((title) => {
        const active = document.querySelector(".wiki-link-menu button.is-active");
        return active?.textContent || "";
      }, targetTitle);
    }, { timeout: 5000 }).toContain(targetTitle);

    await page.keyboard.press("Enter");

    await expect.poll(async () => {
      return page.evaluate((title) => {
        const text = document.querySelector(".editorjs-host .ce-block [contenteditable='true']")?.textContent || "";
        return text.includes(`[[${title}]]`);
      }, targetTitle);
    }, { timeout: 5000 }).toBeTruthy();
  });
});
