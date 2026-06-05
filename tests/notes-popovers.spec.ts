import { expect, test, type APIRequestContext, type Page } from "playwright/test";

const BASE_URL = process.env.TCLOUD_BASE_URL || "http://127.0.0.1:8080";
const USERNAME = process.env.TCLOUD_USER || "tcloud";
const PASSWORD = process.env.TCLOUD_PASSWORD || "tcloud123";
const VIEWPORT_MARGIN = 1;

type PopoverBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  className: string;
  text: string;
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

async function createPopoverNote(request: APIRequestContext, token: string) {
  const blocks = Array.from({ length: 12 }, (_, index) => ({
    type: "paragraph",
    data: { text: `QA popovers bloco ${index + 1}` },
  }));
  const response = await request.post(`${BASE_URL}/api/notes`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title: `QA popovers ${Date.now()}`,
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

async function moveLastBlockNearBottom(page: Page) {
  const point = await page.evaluate(() => {
    const shell = document.querySelector(".editor-shell");
    const blocks = Array.from(document.querySelectorAll(".ce-block"));
    const target = blocks[blocks.length - 2] || blocks[blocks.length - 1];
    if (!shell || !target) return null;
    const shellRect = shell.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    shell.scrollTop += targetRect.bottom - shellRect.bottom + 82;
    const nextRect = target.getBoundingClientRect();
    return {
      x: Math.max(12, nextRect.left + 24),
      y: Math.min(window.innerHeight - 24, Math.max(24, nextRect.top + 18)),
    };
  });
  expect(point).toBeTruthy();
  await page.mouse.move(point!.x, point!.y);
  await page.waitForTimeout(50);
}

async function clickVisibleControl(page: Page, selector: string) {
  const box = await page.locator(selector).evaluate((_, controlSelector) => {
    const controls = Array.from(document.querySelectorAll(controlSelector as string)) as HTMLElement[];
    const visible = controls
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return { control, rect };
      })
      .filter(({ rect }) => rect.width > 8 && rect.height > 8 && rect.top >= 0 && rect.bottom <= window.innerHeight)
      .sort((a, b) => b.rect.top - a.rect.top)[0];
    if (!visible) return null;
    return {
      x: visible.rect.left + visible.rect.width / 2,
      y: visible.rect.top + visible.rect.height / 2,
    };
  }, selector);
  expect(box).toBeTruthy();
  await page.mouse.click(box!.x, box!.y);
}

async function activePopoverBox(page: Page): Promise<PopoverBox> {
  await page.waitForFunction(() => {
    return Boolean(document.querySelector(".tcloud-editor-popover-positioned"));
  });
  const box = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(".tcloud-editor-popover-positioned")) as HTMLElement[];
    const surfaces = nodes
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          className: node.className,
          text: node.textContent || "",
        };
      })
      .filter((rect) => rect.width > 8 && rect.height > 8)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return surfaces || null;
  });
  expect(box).toBeTruthy();
  return box!;
}

function expectBoxInsideViewport(box: PopoverBox, width: number, height: number) {
  expect(box.left).toBeGreaterThanOrEqual(-VIEWPORT_MARGIN);
  expect(box.top).toBeGreaterThanOrEqual(-VIEWPORT_MARGIN);
  expect(box.right).toBeLessThanOrEqual(width + VIEWPORT_MARGIN);
  expect(box.bottom).toBeLessThanOrEqual(height + VIEWPORT_MARGIN);
}

test.describe("TCloud Notes EditorJS popovers", () => {
  test("keeps plus and settings menus inside a small window", async ({ page, request }) => {
    const token = await login(request);
    const noteId = await createPopoverNote(request, token);
    await openNote(page, token, noteId, 720, 460);
    await moveLastBlockNearBottom(page);

    const plusStart = Date.now();
    await clickVisibleControl(page, ".ce-toolbar__plus");
    const plusBox = await activePopoverBox(page);
    const plusElapsed = Date.now() - plusStart;
    expectBoxInsideViewport(plusBox, 720, 460);
    const searchField = page.locator(".tcloud-editor-popover-positioned .cdx-search-field").first();
    await expect(searchField).toBeVisible();
    await searchField.click();
    await page.keyboard.type("tit", { delay: 150 });
    const filterText = await page.evaluate(() => {
      const active = document.activeElement as HTMLInputElement | HTMLElement | null;
      return "value" in (active || {}) ? (active as HTMLInputElement).value : active?.textContent || "";
    });
    expect(filterText).toContain("tit");
    expect(plusElapsed).toBeLessThan(120);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);

    const settingsStart = Date.now();
    await clickVisibleControl(page, ".ce-toolbar__settings-btn");
    const settingsBox = await activePopoverBox(page);
    const settingsElapsed = Date.now() - settingsStart;
    expectBoxInsideViewport(settingsBox, 720, 460);
    expect(settingsBox.text).toMatch(/Mover|Excluir|Converter/);
    expect(settingsElapsed).toBeLessThan(120);
  });
});
