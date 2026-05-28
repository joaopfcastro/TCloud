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
  ["Automático", ""],
  ["Roxo", "#6C5CE7"],
  ["Azul", "#5A9BD5"],
  ["Verde", "#5BB98C"],
  ["Amarelo", "#E6C547"],
  ["Laranja", "#FF8C42"],
  ["Vermelho", "#E06B65"],
  ["Rosa", "#D96C9B"],
  ["Cinza", "#B5BAC1"],
  ["Branco", "#F5F5F7"],
  ["Grafite", "#2C2F33"],
];

const BG_COLORS = [
  ["Sem fundo", ""],
  ["Roxo", "#2D265F"],
  ["Azul", "#1D4265"],
  ["Verde", "#214D3B"],
  ["Amarelo", "#4B4019"],
  ["Laranja", "#56331E"],
  ["Vermelho", "#5A2A2A"],
  ["Rosa", "#542B43"],
  ["Cinza", "#3A3F45"],
  ["Branco", "#F5F5F7"],
  ["Grafite", "#2C2F33"],
];

const RECENT_COLORS_KEY = "tcloud.notes.recentColors";

export function normalizeHex(value) {
  if (!value) return "";
  let raw = String(value).trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    raw = raw.split("").map((char) => char + char).join("");
  }
  if (!/^[0-9a-f]{6}$/i.test(raw)) return "";
  return `#${raw.toUpperCase()}`;
}

function cssColorToHex(value) {
  const normalized = normalizeHex(value);
  if (normalized) return normalized;
  const match = String(value || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?/i);
  if (!match) return "";
  if (match[4] !== undefined && Number(match[4]) === 0) return "";
  return `#${match.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function isTextInputTarget(target) {
  return target?.matches?.("input, textarea, select, [contenteditable='true']");
}

function nodeToElement(node) {
  if (!node) return null;
  return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
}

function editorRootForNode(node) {
  return nodeToElement(node)?.closest?.(".editorjs-host, #editorjs, .codex-editor") || null;
}

function isEditorContentElement(element) {
  if (!element) return false;
  if (element.closest?.(".ce-inline-toolbar, .tcloud-inline-toolbar, .tcloud-color-popover, .ce-popover, .ce-settings, .ce-toolbar, .tcloud-context-menu, .modal, .sidebar, .tcloud-block-card.is-image")) {
    return false;
  }
  return Boolean(element.closest?.("[contenteditable='true'], .ce-block__content"));
}

function isNodeInsideEditor(node) {
  const element = nodeToElement(node);
  return Boolean(editorRootForNode(node) && isEditorContentElement(element));
}

function isRangeInsideEditor(range) {
  if (!range || range.collapsed) return false;
  const startRoot = editorRootForNode(range.startContainer);
  const endRoot = editorRootForNode(range.endContainer);
  if (!startRoot || startRoot !== endRoot) return false;
  return isNodeInsideEditor(range.startContainer) && isNodeInsideEditor(range.endContainer);
}

function restoreSelection(range) {
  if (!isRangeInsideEditor(range)) return false;
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

function getCleanupRoot(range) {
  const element = nodeToElement(range?.commonAncestorContainer);
  return element?.closest?.("[contenteditable='true'], .ce-block__content, .editorjs-host") || element;
}

function sanitizeStyledElement(element) {
  if (!element?.style) return;
  const color = cssColorToHex(element.style.color);
  const backgroundColor = cssColorToHex(element.style.backgroundColor);
  element.removeAttribute("style");
  if (color) element.style.color = color;
  if (backgroundColor) element.style.backgroundColor = backgroundColor;
}

function sanitizeInlineStyles(root) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll("[style]").forEach(sanitizeStyledElement);
}

function unwrapElement(element) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

function unwrapEmptySpans(root) {
  if (!root?.querySelectorAll) return;
  Array.from(root.querySelectorAll("span")).reverse().forEach((span) => {
    const hasUsefulAttribute = Array.from(span.attributes).some((attribute) => {
      return attribute.name !== "style" && attribute.name !== "data-tcloud-temp";
    });
    if (!hasUsefulAttribute && !span.getAttribute("style")) {
      unwrapElement(span);
    }
  });
}

function spansCanMerge(left, right) {
  if (!left || !right || left.tagName !== "SPAN" || right.tagName !== "SPAN") return false;
  if (left.className || right.className) return false;
  return left.getAttribute("style") === right.getAttribute("style");
}

function mergeAdjacentSpans(root) {
  if (!root?.querySelectorAll) return;
  let didMerge = true;
  while (didMerge) {
    didMerge = false;
    root.querySelectorAll("span").forEach((span) => {
      const next = span.nextSibling;
      if (next?.nodeType === Node.ELEMENT_NODE && spansCanMerge(span, next)) {
        while (next.firstChild) span.appendChild(next.firstChild);
        next.remove();
        didMerge = true;
      }
    });
  }
}

function cleanupInlineSpans(root) {
  if (!root) return;
  sanitizeInlineStyles(root);
  unwrapEmptySpans(root);
  mergeAdjacentSpans(root);
  root.normalize?.();
}

function patchFragmentStyles(fragment, stylePatch) {
  if (!fragment?.querySelectorAll) return;
  fragment.querySelectorAll("[style]").forEach((element) => {
    sanitizeStyledElement(element);
    if (Object.prototype.hasOwnProperty.call(stylePatch, "color")) {
      element.style.color = "";
    }
    if (Object.prototype.hasOwnProperty.call(stylePatch, "backgroundColor")) {
      element.style.backgroundColor = "";
    }
    if (!element.getAttribute("style")) element.removeAttribute("style");
  });
}

export function applyInlineStyle(range, stylePatch) {
  if (!isRangeInsideEditor(range)) return null;
  const cleanupRoot = getCleanupRoot(range);
  const clearingKeys = Object.entries(stylePatch)
    .filter(([, value]) => value === null || value === "")
    .map(([key]) => key);
  if (clearingKeys.length) {
    const selectedText = range.toString();
    const styledElement = nodeToElement(range.commonAncestorContainer)?.closest?.("span[style]");
    if (styledElement && styledElement.textContent === selectedText) {
      clearingKeys.forEach((key) => {
        styledElement.style[key] = "";
      });
      if (!styledElement.getAttribute("style")) styledElement.removeAttribute("style");
      cleanupInlineSpans(cleanupRoot);
      return range.cloneRange();
    }
  }
  const activeRange = range.cloneRange();
  const fragment = activeRange.extractContents();
  patchFragmentStyles(fragment, stylePatch);

  const style = {};
  if (Object.prototype.hasOwnProperty.call(stylePatch, "color") && stylePatch.color) {
    style.color = normalizeHex(stylePatch.color);
  }
  if (Object.prototype.hasOwnProperty.call(stylePatch, "backgroundColor") && stylePatch.backgroundColor) {
    style.backgroundColor = normalizeHex(stylePatch.backgroundColor);
  }

  const span = document.createElement("span");
  span.dataset.tcloudTemp = "true";
  Object.assign(span.style, style);
  span.appendChild(fragment);
  activeRange.insertNode(span);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  const nextRange = document.createRange();
  nextRange.selectNodeContents(span);
  selection?.addRange(nextRange);
  span.removeAttribute("data-tcloud-temp");
  cleanupInlineSpans(cleanupRoot || span.parentElement);
  return nextRange.cloneRange();
}

function positionPopover(anchorEl, popoverEl) {
  if (!anchorEl || !popoverEl) return;
  const margin = 12;
  const gap = 8;
  const anchor = anchorEl.getBoundingClientRect();
  const popover = popoverEl.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportWidth = viewport?.width || window.innerWidth;
  const viewportHeight = viewport?.height || window.innerHeight;
  const offsetLeft = viewport?.offsetLeft || 0;
  const offsetTop = viewport?.offsetTop || 0;

  let left = anchor.left + anchor.width / 2 - popover.width / 2;
  left = Math.max(margin + offsetLeft, Math.min(left, offsetLeft + viewportWidth - popover.width - margin));

  const spaceBelow = offsetTop + viewportHeight - anchor.bottom;
  const spaceAbove = anchor.top - offsetTop;
  let top;
  if (spaceBelow >= popover.height + gap || spaceBelow >= spaceAbove) {
    top = anchor.bottom + gap;
    popoverEl.dataset.placement = "bottom";
  } else {
    top = anchor.top - popover.height - gap;
    popoverEl.dataset.placement = "top";
  }
  top = Math.max(margin + offsetTop, Math.min(top, offsetTop + viewportHeight - popover.height - margin));

  popoverEl.style.left = `${Math.round(left)}px`;
  popoverEl.style.top = `${Math.round(top)}px`;
}

function readRecentColors() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeHex).filter(Boolean).slice(0, 8) : [];
  } catch (error) {
    return [];
  }
}

function saveRecentColor(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return;
  const colors = [normalized, ...readRecentColors().filter((color) => color !== normalized)].slice(0, 8);
  localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(colors));
}

function rgbToHex(value) {
  return cssColorToHex(value);
}

export function getSelectedInlineState(range) {
  const element = nodeToElement(range?.startContainer);
  if (!element) return { color: "", backgroundColor: "" };
  const styled = element.closest("span[style]") || element;
  const computed = window.getComputedStyle(styled);
  return {
    color: rgbToHex(styled.style?.color || computed.color),
    backgroundColor: rgbToHex(styled.style?.backgroundColor || computed.backgroundColor),
  };
}

class ColorInlineTool {
  static openTool = null;

  static get isInline() {
    return true;
  }

  static get title() {
    return "Cor";
  }

  static get sanitize() {
    return { span: { style: true } };
  }

  constructor({ api, config = {} }) {
    this.api = api;
    this.config = config;
    this.button = null;
    this.popover = null;
    this.paletteGrid = null;
    this.recentGrid = null;
    this.clearButton = null;
    this.hexInput = null;
    this.colorInput = null;
    this.preview = null;
    this.error = null;
    this.applyButton = null;
    this.modeButtons = {};
    this.savedRange = null;
    this.activeColorMode = "text";
    this.currentHex = "#6C5CE7";
    this.reposition = () => {
      if (this.popover?.classList.contains("is-open")) positionPopover(this.button, this.popover);
    };
    this.closeOnOutsidePointer = (event) => {
      if (!this.popover?.classList.contains("is-open")) return;
      if (this.popover.contains(event.target) || this.button?.contains(event.target)) return;
      this.closePopover();
    };
    this.closeOnEscape = (event) => {
      if (event.key === "Escape" && this.popover?.classList.contains("is-open")) {
        event.preventDefault();
        this.closePopover();
      }
    };
    this.onSelectionChange = () => {
      const selection = window.getSelection();
      if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        if (!range.collapsed && isRangeInsideEditor(range)) {
          this.savedRange = range.cloneRange();
          return;
        }
      }
      if (!this.popover?.classList.contains("is-open")) this.savedRange = null;
    };
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("pointerdown", this.closeOnOutsidePointer, true);
    document.addEventListener("keydown", this.closeOnEscape, true);
    window.addEventListener("resize", this.reposition, { passive: true });
    window.addEventListener("scroll", this.reposition, true);
    window.visualViewport?.addEventListener("resize", this.reposition, { passive: true });
    window.visualViewport?.addEventListener("scroll", this.reposition, { passive: true });
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = "tcloud-color-tool";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "ce-inline-tool tcloud-color-tool-button";
    this.button.title = "Cor do texto";
    this.button.setAttribute("aria-label", "Abrir cores do texto");
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.setAttribute("aria-expanded", "false");
    this.button.textContent = "A";
    this.popover = this.renderPopover();
    wrapper.append(this.button);
    this.button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.saveSelection();
    });
    this.button.addEventListener("click", (event) => {
      event.preventDefault();
      this.saveSelection();
      if (this.popover.classList.contains("is-open")) {
        this.closePopover();
      } else {
        this.openPopover();
      }
    });
    return wrapper;
  }

  renderPopover() {
    const popover = document.createElement("div");
    popover.className = "tcloud-color-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Cores do texto selecionado");
    popover.addEventListener("pointerdown", (event) => {
      if (!isTextInputTarget(event.target)) event.preventDefault();
    });

    const header = document.createElement("div");
    header.className = "tcloud-color-header";
    const title = document.createElement("span");
    title.textContent = "Cor";
    const modes = document.createElement("div");
    modes.className = "tcloud-color-mode";
    [
      ["text", "Texto"],
      ["background", "Fundo"],
    ].forEach(([mode, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-pressed", mode === this.activeColorMode ? "true" : "false");
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => this.setMode(mode));
      this.modeButtons[mode] = button;
      modes.appendChild(button);
    });
    header.append(title, modes);

    this.clearButton = document.createElement("button");
    this.clearButton.type = "button";
    this.clearButton.className = "tcloud-color-clear";
    this.clearButton.addEventListener("pointerdown", (event) => event.preventDefault());
    this.clearButton.addEventListener("click", () => this.clearActiveMode());

    this.paletteGrid = document.createElement("div");
    this.paletteGrid.className = "tcloud-color-grid";

    const presetSection = document.createElement("section");
    presetSection.className = "tcloud-color-section";
    const presetLabel = document.createElement("span");
    presetLabel.textContent = "Paleta";
    presetSection.append(presetLabel, this.paletteGrid);

    const custom = this.renderCustomControls();

    this.recentGrid = document.createElement("div");
    this.recentGrid.className = "tcloud-color-grid tcloud-color-grid-recent";
    const recentSection = document.createElement("section");
    recentSection.className = "tcloud-color-section tcloud-color-recent-section";
    const recentLabel = document.createElement("span");
    recentLabel.textContent = "Recentes";
    recentSection.append(recentLabel, this.recentGrid);

    popover.append(header, this.clearButton, presetSection, custom, recentSection);
    this.updatePopoverState();
    return popover;
  }

  renderCustomControls() {
    const custom = document.createElement("section");
    custom.className = "tcloud-color-section tcloud-color-custom";
    const label = document.createElement("span");
    label.textContent = "Personalizada";
    const row = document.createElement("div");
    row.className = "tcloud-color-hex-row";

    this.preview = document.createElement("button");
    this.preview.type = "button";
    this.preview.className = "tcloud-color-preview";
    this.preview.title = "Abrir seletor visual";
    this.preview.setAttribute("aria-label", "Abrir seletor visual de cor");

    this.colorInput = document.createElement("input");
    this.colorInput.type = "color";
    this.colorInput.value = this.currentHex;
    this.colorInput.setAttribute("aria-label", "Seletor visual de cor");

    this.hexInput = document.createElement("input");
    this.hexInput.type = "text";
    this.hexInput.className = "tcloud-color-hex-input";
    this.hexInput.value = this.currentHex;
    this.hexInput.placeholder = "#6C5CE7";
    this.hexInput.maxLength = 7;
    this.hexInput.setAttribute("aria-label", "Cor hexadecimal");

    this.applyButton = document.createElement("button");
    this.applyButton.type = "button";
    this.applyButton.className = "tcloud-color-apply";
    this.applyButton.textContent = "Aplicar";

    this.error = document.createElement("span");
    this.error.className = "tcloud-color-error";
    this.error.textContent = "HEX inválido";

    this.preview.appendChild(this.colorInput);
    this.preview.addEventListener("pointerdown", (event) => event.preventDefault());
    this.preview.addEventListener("click", () => this.colorInput.click());
    this.colorInput.addEventListener("input", () => {
      this.setHexValue(this.colorInput.value, { validate: true });
    });
    this.hexInput.addEventListener("input", () => this.setHexValue(this.hexInput.value, { validate: false }));
    this.hexInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.applyCustomHex();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.closePopover();
      }
    });
    this.applyButton.addEventListener("pointerdown", (event) => event.preventDefault());
    this.applyButton.addEventListener("click", () => this.applyCustomHex());

    row.append(this.preview, this.hexInput, this.applyButton);
    custom.append(label, row, this.error);
    return custom;
  }

  renderSwatches(grid, colors, { includeEmpty = false, labelPrefix = "Aplicar cor" } = {}) {
    grid.innerHTML = "";
    colors.forEach(([name, hex]) => {
      if (!includeEmpty && !hex) return;
      const button = document.createElement("button");
      button.type = "button";
      button.title = name;
      button.setAttribute("aria-label", hex ? `${labelPrefix}: ${name}` : name);
      button.dataset.colorName = name;
      button.dataset.colorValue = hex;
      button.innerHTML = '<span class="tcloud-color-swatch"></span>';
      const swatch = button.querySelector(".tcloud-color-swatch");
      if (hex) {
        swatch.style.background = hex;
      } else {
        swatch.classList.add("is-empty");
      }
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        if (hex) {
          this.applyActiveColor(hex);
        } else {
          this.clearActiveMode();
        }
      });
      grid.appendChild(button);
    });
  }

  setMode(mode) {
    this.activeColorMode = mode === "background" ? "background" : "text";
    this.updatePopoverState();
  }

  setHexValue(value, { validate }) {
    const normalized = normalizeHex(value);
    const shouldShowInvalid = Boolean((validate || String(value || "").trim().length >= 3) && !normalized);
    if (validate || normalized) {
      this.currentHex = normalized || this.currentHex;
      this.hexInput.value = normalized || value;
      if (normalized) this.colorInput.value = normalized;
    }
    this.preview.style.background = normalized || this.currentHex;
    this.hexInput.classList.toggle("is-invalid", shouldShowInvalid);
    this.error.classList.toggle("is-visible", shouldShowInvalid);
    this.applyButton.disabled = !normalized;
    this.applyButton.setAttribute("aria-disabled", normalized ? "false" : "true");
  }

  updatePopoverState() {
    if (!this.paletteGrid) return;
    const isBackground = this.activeColorMode === "background";
    this.modeButtons.text?.setAttribute("aria-pressed", isBackground ? "false" : "true");
    this.modeButtons.background?.setAttribute("aria-pressed", isBackground ? "true" : "false");
    this.clearButton.textContent = isBackground ? "Remover fundo" : "Remover cor";
    this.clearButton.setAttribute(
      "aria-label",
      isBackground ? "Remover fundo customizado e voltar ao padrão" : "Remover cor customizada e voltar ao padrão",
    );
    this.clearButton.title = isBackground ? "Voltar ao fundo padrão" : "Voltar à cor padrão";
    this.renderSwatches(this.paletteGrid, isBackground ? BG_COLORS : TEXT_COLORS, {
      labelPrefix: isBackground ? "Aplicar fundo" : "Aplicar cor do texto",
    });
    const recentColors = readRecentColors().map((hex) => [hex, hex]);
    this.renderSwatches(this.recentGrid, recentColors, {
      labelPrefix: isBackground ? "Aplicar fundo recente" : "Aplicar cor recente",
    });
    this.recentGrid.parentElement?.classList.toggle("is-empty", !recentColors.length);
    this.markActiveSwatches();
  }

  markActiveSwatches() {
    const state = getSelectedInlineState(this.savedRange);
    const active = this.activeColorMode === "background" ? state.backgroundColor : state.color;
    this.popover?.querySelectorAll(".tcloud-color-grid button").forEach((button) => {
      button.classList.toggle("is-active", Boolean(active && button.dataset.colorValue === active));
    });
  }

  saveSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (isRangeInsideEditor(range)) {
      this.savedRange = range.cloneRange();
    } else if (!this.popover?.classList.contains("is-open")) {
      this.savedRange = null;
    }
  }

  openPopover() {
    if (!this.savedRange || !isRangeInsideEditor(this.savedRange)) this.saveSelection();
    if (!this.savedRange) return;
    if (ColorInlineTool.openTool && ColorInlineTool.openTool !== this) {
      ColorInlineTool.openTool.closePopover();
    }
    document.querySelectorAll(".tcloud-color-popover").forEach((node) => {
      if (node === this.popover) return;
      node.remove();
    });
    if (!this.popover.isConnected) document.body.appendChild(this.popover);
    const state = getSelectedInlineState(this.savedRange);
    this.currentHex = state.color || "#6C5CE7";
    this.popover.classList.add("is-open");
    ColorInlineTool.openTool = this;
    this.button?.classList.add("is-active");
    this.button?.setAttribute("aria-expanded", "true");
    this.setHexValue(this.currentHex, { validate: false });
    this.updatePopoverState();
    this.popover.style.visibility = "hidden";
    positionPopover(this.button, this.popover);
    requestAnimationFrame(() => {
      positionPopover(this.button, this.popover);
      this.popover.style.visibility = "";
    });
  }

  closePopover() {
    this.popover?.classList.remove("is-open");
    if (ColorInlineTool.openTool === this) ColorInlineTool.openTool = null;
    this.button?.classList.remove("is-active");
    this.button?.setAttribute("aria-expanded", "false");
    this.hexInput?.classList.remove("is-invalid");
    this.error?.classList.remove("is-visible");
    this.popover?.remove();
  }

  applyStyle(style) {
    const range = this.savedRange;
    if (!range || !restoreSelection(range)) return;
    const nextRange = applyInlineStyle(range, style);
    if (nextRange) this.savedRange = nextRange;
    this.notifyEditorChanged();
    this.closePopover();
    this.api?.toolbar?.close?.();
  }

  applyActiveColor(hex) {
    const normalized = normalizeHex(hex);
    if (!normalized) return;
    saveRecentColor(normalized);
    if (this.activeColorMode === "background") {
      this.applyStyle({ backgroundColor: normalized });
    } else {
      this.applyStyle({ color: normalized });
    }
  }

  applyCustomHex() {
    const normalized = normalizeHex(this.hexInput?.value);
    if (!normalized) {
      this.hexInput?.classList.add("is-invalid");
      this.error?.classList.add("is-visible");
      this.applyButton.disabled = true;
      this.applyButton.setAttribute("aria-disabled", "true");
      return;
    }
    this.setHexValue(normalized, { validate: false });
    this.applyActiveColor(normalized);
  }

  clearActiveMode() {
    if (this.activeColorMode === "background") {
      this.applyStyle({ backgroundColor: null });
    } else {
      this.applyStyle({ color: null });
    }
  }

  notifyEditorChanged() {
    const activeBlock = nodeToElement(this.savedRange?.commonAncestorContainer)?.closest?.("[contenteditable='true']");
    activeBlock?.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "formatSetBlockTextColor",
      data: null,
    }));
    this.config?.onInlineChange?.();
  }

  setColor(hex) {
    this.applyStyle({ color: normalizeHex(hex) || null });
  }

  setHighlight(hex) {
    this.applyStyle({ backgroundColor: normalizeHex(hex) || null });
  }

  surround(range) {
    this.savedRange = range?.cloneRange?.() || null;
  }

  checkState(selection) {
    const node = selection?.anchorNode?.parentElement;
    const isActive = Boolean(node?.closest("span[style]"));
    this.button?.classList.toggle("ce-inline-tool--active", isActive);
    this.button?.classList.toggle("is-active", this.popover?.classList.contains("is-open"));
  }

  destroy() {
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("pointerdown", this.closeOnOutsidePointer, true);
    document.removeEventListener("keydown", this.closeOnEscape, true);
    window.removeEventListener("resize", this.reposition);
    window.removeEventListener("scroll", this.reposition, true);
    window.visualViewport?.removeEventListener("resize", this.reposition);
    window.visualViewport?.removeEventListener("scroll", this.reposition);
    if (ColorInlineTool.openTool === this) ColorInlineTool.openTool = null;
    this.popover?.remove();
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
