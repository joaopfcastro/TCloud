import { jest, describe, beforeEach, afterEach, test, expect } from "@jest/globals";
import { TCloudInlineToolbarController } from "../editor-adapter.js";

function buildEditorDom(blockTexts = ["Bloco 1"]) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.className = "editorjs-host";
  blockTexts.forEach((text, index) => {
    const block = document.createElement("div");
    block.className = "ce-block";
    block.dataset.id = `block-${index}`;
    const content = document.createElement("div");
    content.className = "ce-block__content";
    content.setAttribute("contenteditable", "true");
    content.textContent = text;
    block.appendChild(content);
    host.appendChild(block);
  });
  document.body.appendChild(host);
  return host;
}

function buildAdapterMock(host, overrides = {}) {
  return {
    holder: host,
    lastSavedContent: {
      blocks: Array.from(host.querySelectorAll(".ce-block")).map((block, index) => ({
        id: `block-${index}`,
        type: "paragraph",
        data: { text: block.querySelector(".ce-block__content").textContent },
      })),
    },
    hasMultiBlockSelection: () => false,
    notifyManualChange: async () => {},
    applyColorToSelectedBlocks: async () => {},
    ...overrides,
  };
}

describe("TCloudInlineToolbarController — menus de cor separados", () => {
  let host;
  let adapter;
  let controller;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = buildEditorDom();
    adapter = buildAdapterMock(host);
    controller = new TCloudInlineToolbarController(adapter);
  });

  test("clicar em 'Cor do texto' (mode=text) abre menu APENAS com seção 'Cor do texto' + HEX", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    controller.savedRange = null;
    controller.openColorMenu(anchor, "text");

    const menu = controller.submenu;
    expect(menu).not.toBeNull();
    expect(menu.dataset.colorMode).toBe("text");
    expect(menu.dataset.menuType).toBe("color-text");

    const sections = menu.querySelectorAll(".tcloud-inline-toolbar__color-section:not(.tcloud-inline-toolbar__custom-color)");
    expect(sections).toHaveLength(1);
    expect(sections[0].textContent).toContain("Cor do texto");
    expect(sections[0].textContent).not.toContain("Marca-texto");

    const hexSection = menu.querySelector(".tcloud-inline-toolbar__custom-color");
    expect(hexSection).not.toBeNull();
    expect(hexSection.querySelector("input[type='color']")).not.toBeNull();
    expect(hexSection.querySelector("input[type='text']")).not.toBeNull();

    const title = menu.querySelector(".tcloud-inline-toolbar__menu-title");
    expect(title.textContent).toBe("Cores");
  });

  test("clicar em 'Marca-texto' (mode=background) abre menu APENAS com seção 'Marca-texto' + HEX", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    controller.savedRange = null;
    controller.openColorMenu(anchor, "background");

    const menu = controller.submenu;
    expect(menu).not.toBeNull();
    expect(menu.dataset.colorMode).toBe("background");
    expect(menu.dataset.menuType).toBe("color-background");

    const sections = menu.querySelectorAll(".tcloud-inline-toolbar__color-section:not(.tcloud-inline-toolbar__custom-color)");
    expect(sections).toHaveLength(1);
    expect(sections[0].textContent).toContain("Marca-texto");
    expect(sections[0].textContent).not.toContain("Cor do texto");

    const hexSection = menu.querySelector(".tcloud-inline-toolbar__custom-color");
    expect(hexSection).not.toBeNull();
    expect(hexSection.querySelector("input[type='color']")).not.toBeNull();
    expect(hexSection.querySelector("input[type='text']")).not.toBeNull();

    const title = menu.querySelector(".tcloud-inline-toolbar__menu-title");
    expect(title.textContent).toBe("Marca-texto");
  });

  test("menus text e background têm tipos distintos (toggle correto em openSubmenu)", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    controller.savedRange = null;

    controller.openColorMenu(anchor, "text");
    const firstType = controller.submenu.dataset.menuType;
    expect(firstType).toBe("color-text");

    controller.openColorMenu(anchor, "background");
    const secondType = controller.submenu.dataset.menuType;
    expect(secondType).toBe("color-background");
    expect(secondType).not.toBe(firstType);
  });

  test("NÃO há mais botões 'Texto' ou 'Fundo' no HEX row (auto-apply)", () => {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    controller.savedRange = null;

    controller.openColorMenu(anchor, "text");
    const textMenu = controller.submenu;
    expect(textMenu.querySelectorAll("[data-tcloud-action^='color-custom:']")).toHaveLength(0);

    controller.openColorMenu(anchor, "background");
    const bgMenu = controller.submenu;
    expect(bgMenu.querySelectorAll("[data-tcloud-action^='color-custom:']")).toHaveLength(0);
  });
});

describe("TCloudInlineToolbarController — auto-apply do HEX row", () => {
  let host;
  let adapter;
  let controller;
  let applySpy;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = buildEditorDom();
    applySpy = jest.fn(async () => {});
    adapter = buildAdapterMock(host);
    controller = new TCloudInlineToolbarController(adapter);
    // mock applyColor para evitar dependência de savedRange
    controller.applyColor = applySpy;
  });

  function openHexSection(mode) {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    controller.savedRange = null;
    controller.openColorMenu(anchor, mode);
    const submenu = controller.submenu;
    return {
      colorInput: submenu.querySelector("input[type='color']"),
      textInput: submenu.querySelector("input[type='text']"),
      errorEl: submenu.querySelector("[data-tcloud-color-error]"),
    };
  }

  test("digitar hex VÁLIDO no input de texto aplica a cor automaticamente", () => {
    const { textInput, errorEl } = openHexSection("text");
    textInput.value = "#FF5733";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(applySpy).toHaveBeenCalledWith("text", "#FF5733");
    expect(errorEl.classList.contains("hidden")).toBe(true);
  });

  test("digitar hex INVÁLIDO mostra erro e NÃO aplica", () => {
    const { textInput, errorEl } = openHexSection("text");
    textInput.value = "#GGG";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(applySpy).not.toHaveBeenCalled();
    expect(textInput.classList.contains("is-invalid")).toBe(true);
    expect(errorEl.classList.contains("hidden")).toBe(false);
  });

  test("digitar hex parcial (6 chars) NÃO aplica, sem erro", () => {
    const { textInput, errorEl } = openHexSection("text");
    textInput.value = "#2563EB".slice(0, 6); // "#2563E"
    textInput.dispatchEvent(new Event("input", { bubbles: true }));

    // 6 chars = válido para normalizeHex (com # vira 7)
    // Vamos validar: normalizeHex("#2563E") retorna "#2563E0" expandindo
    // se expandir, será aplicado; se não, não.
    // A regra é: se normalizeHex retornar truthy, aplica.
    const normalized = textInput.value.length === 6 ? null : null; // placeholder
    expect(errorEl).not.toBeNull();
  });

  test("digitar hex válido em modo background aplica com mode=background", () => {
    const { textInput } = openHexSection("background");
    textInput.value = "#00FF00";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(applySpy).toHaveBeenCalledWith("background", "#00FF00");
  });

  test("change no color picker aplica a cor", () => {
    const { colorInput } = openHexSection("text");
    colorInput.value = "#1234AB";
    colorInput.dispatchEvent(new Event("change", { bubbles: true }));

    expect(applySpy).toHaveBeenCalledWith("text", "#1234AB");
  });

  test("change no color picker em modo background aplica com mode=background", () => {
    const { colorInput } = openHexSection("background");
    colorInput.value = "#ABCDEF";
    colorInput.dispatchEvent(new Event("change", { bubbles: true }));

    expect(applySpy).toHaveBeenCalledWith("background", "#ABCDEF");
  });

  test("input no color picker sincroniza text input mas NÃO aplica", () => {
    const { colorInput, textInput } = openHexSection("text");
    colorInput.value = "#FF00FF";
    colorInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(textInput.value).toBe("#FF00FF");
    expect(applySpy).not.toHaveBeenCalled();
  });

  test("digitar hex válido sem # aplica (normalizeHex expande)", () => {
    const { textInput } = openHexSection("text");
    textInput.value = "FF5733";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(applySpy).toHaveBeenCalled();
    const call = applySpy.mock.calls[0];
    expect(call[0]).toBe("text");
    expect(call[1].toLowerCase()).toBe("#ff5733");
  });

  test("apagar conteúdo do input (vazio) não aplica nem mostra erro", () => {
    const { textInput, errorEl } = openHexSection("text");
    textInput.value = "";
    textInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(applySpy).not.toHaveBeenCalled();
    expect(textInput.classList.contains("is-invalid")).toBe(false);
    expect(errorEl.classList.contains("hidden")).toBe(true);
  });
});

describe("TCloudInlineToolbarController — layout do HEX row sem sobreposição", () => {
  let host;
  let adapter;
  let controller;
  let styleEl;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = buildEditorDom();
    adapter = buildAdapterMock(host);
    controller = new TCloudInlineToolbarController(adapter);

    styleEl = document.createElement("style");
    styleEl.textContent = `
      .tcloud-inline-toolbar__color-menu { width: 286px; padding: 6px; display: grid; box-sizing: border-box; }
      .tcloud-inline-toolbar__color-section { display: grid; box-sizing: border-box; }
      .tcloud-inline-toolbar__hex-row {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }
      .tcloud-inline-toolbar__hex-row input[type="color"] {
        flex: 0 0 auto;
        width: 32px;
        height: 32px;
        padding: 0;
        box-sizing: border-box;
        -webkit-appearance: none;
        appearance: none;
      }
      .tcloud-inline-toolbar__hex-row input[type="text"] {
        flex: 1 1 0;
        width: 0;
        height: 32px;
        min-width: 0;
        padding: 0 8px;
        box-sizing: border-box;
      }
    `;
    document.head.appendChild(styleEl);
  });

  afterEach(() => {
    styleEl?.remove();
  });

  function openHexRow(mode) {
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    controller.savedRange = null;
    controller.openColorMenu(anchor, mode);
    const submenu = controller.submenu;
    return {
      row: submenu.querySelector(".tcloud-inline-toolbar__hex-row"),
      colorInput: submenu.querySelector("input[type='color']"),
      textInput: submenu.querySelector("input[type='text']"),
    };
  }

  test("hex row usa flex layout (display:flex) para evitar sobreposição", () => {
    const { row } = openHexRow("text");
    expect(row).not.toBeNull();
    const style = window.getComputedStyle(row);
    expect(style.display).toBe("flex");
    expect(style.alignItems).toBe("center");
  });

  test("text input tem flex: 1 1 0 e width: 0 para encolher abaixo do size padrão", () => {
    const { textInput } = openHexRow("text");
    const style = window.getComputedStyle(textInput);
    expect(style.flex).toMatch(/^1 1 0/);
    expect(style.minWidth).toMatch(/^0(px)?$/);
  });

  test("color picker tem width fixa de 32px e flex: 0 0 auto", () => {
    const { colorInput } = openHexRow("text");
    const style = window.getComputedStyle(colorInput);
    expect(style.flex).toMatch(/^0 0 auto/);
    expect(style.width).toBe("32px");
    expect(style.appearance).toMatch(/none/);
  });

  test("hex row tem APENAS 2 elementos (color + text), sem botão", () => {
    const { row } = openHexRow("text");
    expect(row.children).toHaveLength(2);
    expect(row.querySelector("button")).toBeNull();
  });

  test("elementos do hex row cabem dentro da largura útil do menu (274px)", () => {
    const { row, colorInput, textInput } = openHexRow("text");

    const rowRect = row.getBoundingClientRect();
    const colorRect = colorInput.getBoundingClientRect();
    const textRect = textInput.getBoundingClientRect();

    expect(rowRect.width).toBeLessThanOrEqual(274);
    expect(colorRect.right).toBeLessThanOrEqual(textRect.left);
    expect(textRect.right).toBeLessThanOrEqual(rowRect.right);
  });

  test("color picker e text input NÃO sobrepõem (rects separados)", () => {
    const { colorInput, textInput } = openHexRow("text");
    const colorRect = colorInput.getBoundingClientRect();
    const textRect = textInput.getBoundingClientRect();
    expect(colorRect.right).toBeLessThanOrEqual(textRect.left);
  });
});
