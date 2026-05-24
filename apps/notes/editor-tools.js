function editableText(initialValue, className, placeholder) {
  const element = document.createElement("div");
  element.className = className;
  element.contentEditable = "true";
  element.spellcheck = true;
  element.dataset.placeholder = placeholder;
  element.innerHTML = initialValue || "";
  return element;
}

const TEXT_COLORS = [
  ["Default", ""],
  ["Cinza", "#9B9B9B"],
  ["Marrom", "#BA8564"],
  ["Laranja", "#FF8C42"],
  ["Amarelo", "#E6C547"],
  ["Verde", "#5BB98C"],
  ["Azul", "#5A9BD5"],
  ["Roxo", "#A57FC9"],
  ["Rosa", "#D96C9B"],
  ["Vermelho", "#E06B65"],
];

const BG_COLORS = [
  ["Default", ""],
  ["Cinza", "#9B9B9B33"],
  ["Marrom", "#BA856433"],
  ["Laranja", "#FF8C4233"],
  ["Amarelo", "#E6C54733"],
  ["Verde", "#5BB98C33"],
  ["Azul", "#5A9BD533"],
  ["Roxo", "#A57FC933"],
  ["Rosa", "#D96C9B33"],
  ["Vermelho", "#E06B6533"],
];

function isHex(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""));
}

function wrapRange(range, style) {
  if (!range || range.collapsed) return;
  const span = document.createElement("span");
  Object.assign(span.style, style);
  span.appendChild(range.extractContents());
  range.insertNode(span);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  const nextRange = document.createRange();
  nextRange.selectNodeContents(span);
  selection?.addRange(nextRange);
}

class ColorInlineTool {
  static get isInline() {
    return true;
  }

  static get sanitize() {
    return { span: { style: true } };
  }

  constructor({ api }) {
    this.api = api;
    this.button = null;
    this.popover = null;
    this.savedRange = null;
    this.onSelectionChange = () => {
      const selection = window.getSelection();
      if (selection?.rangeCount && !selection.getRangeAt(0).collapsed) {
        this.savedRange = selection.getRangeAt(0).cloneRange();
      }
    };
    document.addEventListener("selectionchange", this.onSelectionChange);
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = "tcloud-color-tool";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "ce-inline-tool tcloud-color-tool-button";
    this.button.title = "Cor";
    this.button.textContent = "A";
    this.popover = this.renderPopover();
    wrapper.append(this.button);
    document.querySelectorAll(".tcloud-color-popover:not(.is-open)").forEach((node) => node.remove());
    document.body.appendChild(this.popover);
    this.button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.saveSelection();
    });
    this.button.addEventListener("click", (event) => {
      event.preventDefault();
      this.saveSelection();
      const rect = this.button.getBoundingClientRect();
      this.popover.style.left = `${Math.max(12, rect.right - 246)}px`;
      this.popover.style.top = `${Math.max(12, rect.top - 292)}px`;
      this.popover.classList.toggle("is-open");
    });
    return wrapper;
  }

  renderPopover() {
    const popover = document.createElement("div");
    popover.className = "tcloud-color-popover";
    popover.addEventListener("mousedown", (event) => event.preventDefault());
    popover.append(this.renderPalette("Texto", TEXT_COLORS, "color"));
    popover.append(this.renderPalette("Fundo", BG_COLORS, "backgroundColor"));

    const custom = document.createElement("div");
    custom.className = "tcloud-color-custom";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = "#5A9BD5";
    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.value = "#5A9BD5";
    hexInput.maxLength = 7;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = "HEX";
    const applyHex = () => {
      const hex = String(hexInput.value || "").trim();
      if (isHex(hex)) this.applyStyle({ color: hex });
    };
    colorInput.addEventListener("input", () => {
      hexInput.value = colorInput.value.toUpperCase();
      this.applyStyle({ color: colorInput.value });
    });
    hexInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") applyHex();
    });
    apply.addEventListener("click", applyHex);
    custom.append(colorInput, hexInput, apply);
    popover.append(custom);
    return popover;
  }

  renderPalette(title, colors, styleKey) {
    const section = document.createElement("section");
    section.className = "tcloud-color-section";
    const label = document.createElement("span");
    label.textContent = title;
    const grid = document.createElement("div");
    grid.className = "tcloud-color-grid";
    colors.forEach(([name, hex]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.title = `${title}: ${name}`;
      button.dataset.colorName = name;
      button.innerHTML = `<span class="tcloud-color-swatch"></span>`;
      const swatch = button.querySelector(".tcloud-color-swatch");
      if (hex) swatch.style.background = hex;
      button.addEventListener("click", () => {
        if (styleKey === "color") this.setColor(hex);
        if (styleKey === "backgroundColor") this.setHighlight(hex);
      });
      grid.appendChild(button);
    });
    section.append(label, grid);
    return section;
  }

  saveSelection() {
    const selection = window.getSelection();
    if (selection?.rangeCount) this.savedRange = selection.getRangeAt(0).cloneRange();
  }

  applyStyle(style) {
    const range = this.savedRange;
    if (!range) return;
    const cleanStyle = {};
    if (Object.prototype.hasOwnProperty.call(style, "color")) cleanStyle.color = style.color || "";
    if (Object.prototype.hasOwnProperty.call(style, "backgroundColor")) cleanStyle.backgroundColor = style.backgroundColor || "";
    wrapRange(range, cleanStyle);
    this.popover?.classList.remove("is-open");
    this.api?.toolbar?.close?.();
  }

  setColor(hex) {
    this.applyStyle({ color: hex || "" });
  }

  setHighlight(hex) {
    this.applyStyle({ backgroundColor: hex || "" });
  }

  surround(range) {
    this.savedRange = range?.cloneRange?.() || null;
  }

  checkState(selection) {
    const node = selection?.anchorNode?.parentElement;
    this.button?.classList.toggle("ce-inline-tool--active", Boolean(node?.closest("span[style]")));
  }
}

export const TextColorTool = ColorInlineTool;

export class TodoTool {
  static get toolbox() {
    return { title: "Checklist" };
  }

  constructor({ data = {} }) {
    this.data = {
      text: data.text || "",
      checked: Boolean(data.checked),
    };
    this.checkbox = null;
    this.textInput = null;
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = "editor-todo";

    this.checkbox = document.createElement("input");
    this.checkbox.type = "checkbox";
    this.checkbox.className = "editor-todo-checkbox";
    this.checkbox.checked = this.data.checked;

    this.textInput = editableText(this.data.text, "editor-todo-text", "Item da checklist");
    wrapper.append(this.checkbox, this.textInput);
    return wrapper;
  }

  save() {
    return {
      text: this.textInput?.innerHTML || "",
      checked: Boolean(this.checkbox?.checked),
    };
  }
}

export class QuoteTool {
  static get toolbox() {
    return { title: "Citação" };
  }

  constructor({ data = {} }) {
    this.data = {
      text: data.text || "",
      caption: data.caption || "",
    };
    this.textInput = null;
    this.captionInput = null;
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = "editor-quote";

    this.textInput = editableText(this.data.text, "editor-quote-text", "Escreva a citação");
    this.captionInput = editableText(this.data.caption, "editor-quote-caption", "Fonte ou contexto");

    wrapper.append(this.textInput, this.captionInput);
    return wrapper;
  }

  save() {
    return {
      text: this.textInput?.innerHTML || "",
      caption: this.captionInput?.innerHTML || "",
    };
  }
}

export class CodeBlockTool {
  static get toolbox() {
    return { title: "Código" };
  }

  constructor({ data = {} }) {
    this.data = {
      code: data.code || "",
    };
    this.textarea = null;
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = "editor-code";

    this.textarea = document.createElement("textarea");
    this.textarea.className = "editor-code-textarea";
    this.textarea.placeholder = "Cole ou escreva código";
    this.textarea.value = this.data.code;
    wrapper.appendChild(this.textarea);
    return wrapper;
  }

  save() {
    return {
      code: this.textarea?.value || "",
    };
  }
}

export class DividerTool {
  static get toolbox() {
    return { title: "Divisor" };
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = "editor-divider";
    const hr = document.createElement("hr");
    wrapper.appendChild(hr);
    return wrapper;
  }

  save() {
    return {};
  }
}
