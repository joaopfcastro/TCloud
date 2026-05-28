import {
  CodeBlockTool,
  DividerTool,
  QuoteTool,
  TextColorTool,
  TodoTool,
  applyInlineStyle,
  getSelectedInlineState,
  normalizeHex,
} from "./editor-tools.js?v=notes-inline-toolbar-contextual-20260527-7";
import {
  TCloudAudioTool,
  TCloudFileTool,
  TCloudFolderTool,
  TCloudImageTool,
  TCloudPdfTool,
  TCloudVideoTool,
  buildTCloudBlock,
  isTCloudBlockType,
} from "./tcloud-blocks.js";

const TCLOUD_INDENT_MAX = 6;
const INLINE_SANITIZER_RULES = {
  br: true,
  b: true,
  strong: true,
  i: true,
  em: true,
  u: true,
  s: true,
  strike: true,
  code: true,
  span: { style: true },
  a: { href: true, target: true, rel: true },
};

function blockId() {
  const raw = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return raw.replace(/-/g, "").slice(0, 10);
}

function defaultEditorData() {
  return {
    time: Date.now(),
    blocks: [
      {
        id: blockId(),
        type: "paragraph",
        data: { text: "" },
      },
    ],
    version: "2.31.6",
  };
}

function paragraphToolWithInlineSanitizer() {
  return class TCloudParagraphTool extends window.Paragraph {
    static get sanitize() {
      return { text: INLINE_SANITIZER_RULES };
    }
  };
}

function headerToolWithInlineSanitizer() {
  return class TCloudHeaderTool extends window.Header {
    static get sanitize() {
      return { level: false, text: INLINE_SANITIZER_RULES };
    }
  };
}

function clampIndentLevel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(TCLOUD_INDENT_MAX, Math.round(number)));
}

function normalizeBlockIndent(data = {}) {
  const raw = data?.tcloudIndent;
  const level = clampIndentLevel(
    typeof raw === "object" && raw !== null
      ? raw.level
      : raw,
  );
  if (!level) return {};
  return { tcloudIndent: { level } };
}

function copyIndentData(data = {}) {
  return normalizeBlockIndent(data);
}

export function buildBlock(type, data = {}) {
  const indent = copyIndentData(data);
  if (type === "paragraph") {
    return { id: blockId(), type, data: { text: data.text || "", ...indent } };
  }
  if (type === "header") {
    return { id: blockId(), type, data: { text: data.text || "", level: Number(data.level || 2), ...indent } };
  }
  if (type === "list") {
    return {
      id: blockId(),
      type,
      data: {
        style: data.style || "unordered",
        items: Array.isArray(data.items) ? data.items : [""],
        ...indent,
      },
    };
  }
  if (type === "todo") {
    return { id: blockId(), type, data: { text: data.text || "", checked: Boolean(data.checked), ...indent } };
  }
  if (type === "quote") {
    return { id: blockId(), type, data: { text: data.text || "", caption: data.caption || "", ...indent } };
  }
  if (type === "codeBlock") {
    return { id: blockId(), type, data: { code: data.code || "", ...indent } };
  }
  if (type === "divider") {
    return { id: blockId(), type, data: {} };
  }
  if (isTCloudBlockType(type)) {
    return { id: blockId(), type, data: buildTCloudBlock(type, data) };
  }
  return { id: blockId(), type: "paragraph", data: { text: "" } };
}

function blockPlainText(block) {
  if (!block || typeof block !== "object") return "";
  const data = block.data || {};
  if (typeof data.text === "string") return data.text;
  if (typeof data.code === "string") return data.code;
  if (Array.isArray(data.items)) return data.items.join("\n");
  return "";
}

function convertBlockData(type, sourceText = "", data = {}) {
  const text = String(sourceText || "").trim();
  const indent = copyIndentData(data);
  if (type === "paragraph") return { text, ...indent };
  if (type === "header") return { level: Number(data.level || 2), text, ...indent };
  if (type === "list") return { style: data.style || "unordered", items: text ? text.split(/\n+/) : [""], ...indent };
  if (type === "todo") return { text, checked: Boolean(data.checked), ...indent };
  if (type === "quote") return { text, caption: data.caption || "", ...indent };
  if (type === "codeBlock") return { code: sourceText || "", ...indent };
  if (type === "divider") return {};
  if (isTCloudBlockType(type)) return buildTCloudBlock(type, data);
  return data;
}

function normalizeBlock(block) {
  if (!block || typeof block !== "object") return buildBlock("paragraph", { text: "" });
  const data = block.data && typeof block.data === "object" ? { ...block.data } : {};
  const level = clampIndentLevel(data.tcloudIndent?.level ?? data.tcloudIndent);
  if (level) {
    data.tcloudIndent = { level };
  } else {
    delete data.tcloudIndent;
  }
  return {
    ...block,
    id: block.id || blockId(),
    type: block.type || "paragraph",
    data,
  };
}

const INLINE_TOOLBAR_MARGIN = 10;
const INLINE_TOOLBAR_GAP = 8;
const INLINE_COLOR_PRESETS = {
  text: [
    ["Cinza", "#6B7280"],
    ["Vermelho", "#E5484D"],
    ["Laranja", "#F97316"],
    ["Amarelo", "#CA8A04"],
    ["Verde", "#16A34A"],
    ["Azul", "#2563EB"],
    ["Roxo", "#7C3AED"],
    ["Rosa", "#DB2777"],
    ["Preto", "#111827"],
    ["Branco", "#F8FAFC"],
  ],
  background: [
    ["Cinza", "#E5E7EB"],
    ["Vermelho", "#FEE2E2"],
    ["Laranja", "#FFEDD5"],
    ["Amarelo", "#FEF3C7"],
    ["Verde", "#DCFCE7"],
    ["Azul", "#DBEAFE"],
    ["Roxo", "#EDE9FE"],
    ["Rosa", "#FCE7F3"],
    ["Preto", "#111827"],
    ["Branco", "#FFFFFF"],
  ],
};

function holderElement(holder) {
  return typeof holder === "string" ? document.getElementById(holder) : holder;
}

function nodeToElement(node) {
  if (!node) return null;
  return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(Number(value) || min, max));
}

function editorEditableForNode(node, root) {
  const element = nodeToElement(node);
  if (element?.closest?.(".tcloud-inline-toolbar, .ce-inline-toolbar, .tcloud-inline-toolbar__menu, .ce-popover, .ce-settings, .ce-toolbar, .tcloud-context-menu, .modal, .sidebar, .tcloud-block-card.is-image")) {
    return null;
  }
  const editable = element?.closest?.("[contenteditable='true']");
  return editable && root?.contains(editable) ? editable : null;
}

function rangeInsideEditor(range, root) {
  if (!range || !root) return false;
  try {
    return Boolean(
      editorEditableForNode(range.startContainer, root) &&
      editorEditableForNode(range.endContainer, root),
    );
  } catch (error) {
    return false;
  }
}

function restoreRange(range, root, { allowCollapsed = false } = {}) {
  if (!range || (!allowCollapsed && range.collapsed) || !rangeInsideEditor(range, root)) return false;
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

function rangeSignature(range) {
  if (!range) return null;
  try {
    return {
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
      text: range.toString(),
    };
  } catch (error) {
    return null;
  }
}

function sameRangeSignature(left, right) {
  return Boolean(
    left &&
    right &&
    left.startContainer === right.startContainer &&
    left.endContainer === right.endContainer &&
    left.startOffset === right.startOffset &&
    left.endOffset === right.endOffset &&
    left.text === right.text,
  );
}

function rangeSelectionRect(range) {
  if (!range) return null;
  let rects = [];
  try {
    rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  } catch (error) {
    return null;
  }
  if (!rects.length) {
    const rect = range.getBoundingClientRect();
    if (rect?.width || rect?.height) rects = [rect];
  }
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const width = right - left;
  const height = bottom - top;
  if (!width && !height) return null;
  return { left, top, right, bottom, width, height };
}

function visibleElement(element) {
  if (!element || element.hidden || element.getAttribute?.("aria-hidden") === "true" || element.classList?.contains("hidden")) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return Boolean(rect.width || rect.height);
}

function restoreEditorJsTransientMenus() {
  document.querySelectorAll(".ce-popover:not(.ce-popover--inline), .ce-settings, .ce-conversion-toolbar").forEach((element) => {
    element.hidden = false;
    element.style.display = "";
    element.removeAttribute("aria-hidden");
    element.classList.remove("hidden");
  });
}

function resetStickyNativeInlineCommands(root) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return;
  const element = nodeToElement(selection.anchorNode);
  if (!element || !root?.contains(element)) return;
  if (element.closest("strong,b,em,i,u,s,strike,code,a,span[style]")) return;
  [
    "bold",
    "italic",
    "underline",
    "strikeThrough",
  ].forEach((command) => {
    try {
      if (document.queryCommandState?.(command)) {
        document.execCommand(command, false, null);
      }
    } catch (error) {
      // Native command state is best-effort cleanup for stale browser formatting.
    }
  });
}

function createToolbarButton({ label, icon, title, action, active = false, disabled = false, pressed = false, menu = false }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tcloud-inline-toolbar__button";
  button.title = title || label;
  button.setAttribute("aria-label", title || label);
  button.dataset.tcloudAction = action;
  button.innerHTML = icon || label;
  button.disabled = Boolean(disabled);
  button.classList.toggle("is-active", Boolean(active));
  button.setAttribute("aria-pressed", active || pressed ? "true" : "false");
  button.setAttribute("aria-disabled", disabled ? "true" : "false");
  if (menu) {
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
  }
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  return button;
}

function createMenuButton({ action, label, title, icon = "" }) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.tcloudAction = action;
  button.setAttribute("role", "menuitem");
  button.title = title || label;
  button.setAttribute("aria-label", title || label);
  button.innerHTML = icon ? `<span aria-hidden="true">${icon}</span><span>${label}</span>` : label;
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  return button;
}

function wrapRangeWithElement(range, tagName, attributes = {}) {
  if (!range || range.collapsed) return null;
  const activeRange = range.cloneRange();
  const wrapper = document.createElement(tagName);
  Object.entries(attributes).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== "") wrapper.setAttribute(key, value);
  });
  wrapper.appendChild(activeRange.extractContents());
  activeRange.insertNode(wrapper);
  const nextRange = document.createRange();
  nextRange.selectNodeContents(wrapper);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(nextRange);
  return nextRange.cloneRange();
}

function closestInlineTag(range, selector) {
  const element = nodeToElement(range?.startContainer);
  return element?.closest?.(selector) || null;
}

function unwrapInlineElement(element) {
  const parent = element?.parentNode;
  if (!parent) return false;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
  parent.normalize?.();
  return true;
}

function toggleInlineElement(range, selector, tagName, attributes = {}) {
  const existing = closestInlineTag(range, selector);
  if (existing && existing.textContent === range.toString()) {
    return unwrapInlineElement(existing) ? range.cloneRange() : null;
  }
  return wrapRangeWithElement(range, tagName, attributes);
}

class TCloudInlineToolbarController {
  constructor(adapter) {
    this.adapter = adapter;
    this.root = holderElement(adapter.holder);
    this.savedRange = null;
    this.closedSelectionSignature = null;
    this.submenu = null;
    this.lastReason = "";
    this.selectionFrame = null;
    this.pendingSelectionReason = "";
    this.toolbar = this.buildToolbar();
    this.onSelectionChange = () => this.scheduleSelectionSync("selectionchange");
    this.onPointerDown = (event) => this.handlePointerDown(event);
    this.onPointerUp = () => this.scheduleSelectionSync("pointerup");
    this.onMouseUp = () => this.scheduleSelectionSync("mouseup");
    this.onTouchEnd = () => this.scheduleSelectionSync("touchend");
    this.onKeyUp = () => this.scheduleSelectionSync("keyup");
    this.onInput = (event) => {
      if (this.isEditorTarget(event.target)) this.scheduleSelectionSync("input");
    };
    this.onFocusIn = (event) => {
      if (this.isEditorTarget(event.target)) {
        resetStickyNativeInlineCommands(this.root);
        return;
      }
      if (!this.isToolbarTarget(event.target)) {
        this.hideInlineToolbar("focus-outside");
      }
    };
    this.onKeyDown = (event) => this.handleKeyDown(event);
    this.onViewportChange = () => {
      if (!this.toolbar.classList.contains("is-open")) return;
      const range = this.savedRange;
      if (!range || !this.updateToolbarPosition(range)) this.hideInlineToolbar("viewport-change");
      else this.positionSubmenu();
    };

    document.body.appendChild(this.toolbar);
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("pointerup", this.onPointerUp, true);
    document.addEventListener("mouseup", this.onMouseUp, true);
    document.addEventListener("touchend", this.onTouchEnd, true);
    document.addEventListener("keyup", this.onKeyUp, true);
    document.addEventListener("input", this.onInput, true);
    document.addEventListener("focusin", this.onFocusIn, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("resize", this.onViewportChange, { passive: true });
    window.addEventListener("scroll", this.onViewportChange, true);
    window.visualViewport?.addEventListener("resize", this.onViewportChange, { passive: true });
    window.visualViewport?.addEventListener("scroll", this.onViewportChange, { passive: true });
    this.observer = new MutationObserver(() => {
      this.hideNativeInlineToolbar();
      if (this.externalEditorMenuOpen()) this.hideInlineToolbar("editor-menu");
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.hideNativeInlineToolbar();
  }

  destroy() {
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("pointerup", this.onPointerUp, true);
    document.removeEventListener("mouseup", this.onMouseUp, true);
    document.removeEventListener("touchend", this.onTouchEnd, true);
    document.removeEventListener("keyup", this.onKeyUp, true);
    document.removeEventListener("input", this.onInput, true);
    document.removeEventListener("focusin", this.onFocusIn, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("resize", this.onViewportChange);
    window.removeEventListener("scroll", this.onViewportChange, true);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
    window.visualViewport?.removeEventListener("scroll", this.onViewportChange);
    if (this.selectionFrame) cancelAnimationFrame(this.selectionFrame);
    this.observer?.disconnect();
    this.closeAllInlineSubmenus();
    this.toolbar.remove();
  }

  buildToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "tcloud-inline-toolbar tcloud-inline-toolbar--custom";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Formatação do texto selecionado");
    toolbar.setAttribute("aria-hidden", "true");
    toolbar.hidden = true;
    toolbar.addEventListener("mousedown", (event) => event.preventDefault());
    toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
    toolbar.addEventListener("click", (event) => {
      const target = event.target.closest("[data-tcloud-action]");
      if (!target || target.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      this.runAction(target.dataset.tcloudAction, target).catch(console.warn);
    });

    const blockGroup = document.createElement("div");
    blockGroup.className = "tcloud-inline-toolbar__group";
    const blockButton = createToolbarButton({
      action: "block-menu",
      label: "Texto",
      title: "Tipo de bloco",
      icon: '<span data-tcloud-block-label>Texto</span>',
      menu: true,
    });
    blockButton.classList.add("tcloud-inline-toolbar__block-button");
    blockGroup.appendChild(blockButton);

    const formatGroup = document.createElement("div");
    formatGroup.className = "tcloud-inline-toolbar__group";
    [
      { action: "bold", label: "B", title: "Negrito", icon: '<i class="ph ph-text-b" aria-hidden="true"></i>' },
      { action: "italic", label: "I", title: "Itálico", icon: '<i class="ph ph-text-italic" aria-hidden="true"></i>' },
      { action: "underline", label: "U", title: "Sublinhado", icon: '<i class="ph ph-text-underline" aria-hidden="true"></i>' },
      { action: "strike", label: "S", title: "Tachado", icon: '<i class="ph ph-text-strikethrough" aria-hidden="true"></i>' },
      { action: "inline-code", label: "</>", title: "Código inline", icon: '<i class="ph ph-code" aria-hidden="true"></i>' },
    ].forEach((item) => formatGroup.appendChild(createToolbarButton(item)));

    const linkGroup = document.createElement("div");
    linkGroup.className = "tcloud-inline-toolbar__group";
    [
      { action: "link", label: "Link", title: "Criar ou editar link", icon: '<i class="ph ph-link-simple" aria-hidden="true"></i>' },
      { action: "unlink", label: "Remover link", title: "Remover link", icon: '<i class="ph ph-link-break" aria-hidden="true"></i>' },
    ].forEach((item) => linkGroup.appendChild(createToolbarButton(item)));

    const colorGroup = document.createElement("div");
    colorGroup.className = "tcloud-inline-toolbar__group";
    [
      { action: "text-color", label: "A", title: "Cor do texto", icon: '<span class="tcloud-inline-toolbar__text-color-icon">A</span>', menu: true },
      { action: "highlight-color", label: "Marca-texto", title: "Cor de fundo / marca-texto", icon: '<i class="ph ph-highlighter-circle" aria-hidden="true"></i>', menu: true },
    ].forEach((item) => colorGroup.appendChild(createToolbarButton(item)));

    const indentGroup = document.createElement("div");
    indentGroup.className = "tcloud-inline-toolbar__group";
    [
      { action: "outdent", label: "Voltar recuo", title: "Recuar para a esquerda", icon: '<i class="ph ph-text-outdent" aria-hidden="true"></i>' },
      { action: "indent", label: "Recuar", title: "Recuar para a direita", icon: '<i class="ph ph-text-indent" aria-hidden="true"></i>' },
    ].forEach((item) => indentGroup.appendChild(createToolbarButton(item)));

    const moreGroup = document.createElement("div");
    moreGroup.className = "tcloud-inline-toolbar__group";
    moreGroup.appendChild(createToolbarButton({
      action: "more",
      label: "Mais",
      title: "Mais ações",
      icon: '<i class="ph ph-dots-three" aria-hidden="true"></i>',
      menu: true,
    }));

    toolbar.append(
      blockGroup,
      this.divider(),
      formatGroup,
      this.divider(),
      linkGroup,
      this.divider(),
      colorGroup,
      this.divider(),
      indentGroup,
      this.divider(),
      moreGroup,
    );
    return toolbar;
  }

  isEditorTarget(target) {
    return Boolean(target?.closest?.(".editorjs-host, .codex-editor") && this.root?.contains(target));
  }

  isToolbarTarget(target) {
    return Boolean(target?.closest?.(".tcloud-inline-toolbar--custom, .tcloud-inline-toolbar__menu"));
  }

  isSelectionInsideEditor(selection) {
    if (!selection?.rangeCount || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    return rangeInsideEditor(range, this.root);
  }

  getValidEditorSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    if (!this.isSelectionInsideEditor(selection)) return null;
    const range = selection.getRangeAt(0);
    const text = range.toString().replace(/\u200B/g, "").trim();
    if (!text) return null;
    if (!rangeSelectionRect(range)) return null;
    return range.cloneRange();
  }

  shouldShowInlineToolbar(range = this.getValidEditorSelection()) {
    if (!range || !rangeInsideEditor(range, this.root)) return false;
    if (this.externalEditorMenuOpen()) return false;
    const signature = rangeSignature(range);
    return !sameRangeSignature(signature, this.closedSelectionSignature);
  }

  scheduleSelectionSync(reason = "selectionchange") {
    this.pendingSelectionReason = reason;
    if (this.selectionFrame) return;
    this.selectionFrame = requestAnimationFrame(() => {
      this.selectionFrame = null;
      this.syncFromSelection(this.pendingSelectionReason || reason);
    });
  }

  syncFromSelection(reason = "selectionchange") {
    this.hideNativeInlineToolbar();
    const range = this.getValidEditorSelection();
    if (range) {
      const signature = rangeSignature(range);
      if (!sameRangeSignature(signature, this.closedSelectionSignature)) {
        this.closedSelectionSignature = null;
      }
      if (this.shouldShowInlineToolbar(range)) this.showInlineToolbar(range);
      else if (!this.submenu) this.hideInlineToolbar(reason);
      return;
    }
    if (this.submenu && rangeInsideEditor(this.savedRange, this.root) && this.isToolbarTarget(document.activeElement)) {
      this.updateToolbarPosition(this.savedRange);
      return;
    }
    this.closedSelectionSignature = null;
    this.hideInlineToolbar(reason);
  }

  showInlineToolbar(range) {
    if (!rangeInsideEditor(range, this.root)) return;
    this.savedRange = range.cloneRange();
    this.toolbar.hidden = false;
    this.toolbar.classList.add("is-open");
    this.toolbar.setAttribute("aria-hidden", "false");
    this.updateToolbarState();
    if (!this.updateToolbarPosition(this.savedRange)) {
      this.hideInlineToolbar("position-failed");
    }
  }

  hideInlineToolbar(reason = "manual", { suppressSelection = false, clearSelection = false } = {}) {
    if (suppressSelection) {
      const range = this.savedRange || this.getValidEditorSelection();
      this.closedSelectionSignature = rangeSignature(range);
    }
    this.lastReason = reason;
    this.closeAllInlineSubmenus();
    this.toolbar.classList.remove("is-open");
    this.toolbar.hidden = true;
    this.toolbar.setAttribute("aria-hidden", "true");
    this.toolbar.querySelectorAll("[aria-expanded='true']").forEach((button) => button.setAttribute("aria-expanded", "false"));
    if (clearSelection) window.getSelection()?.removeAllRanges();
    if (!suppressSelection || clearSelection) this.savedRange = null;
    this.hideNativeInlineToolbar();
  }

  updateToolbarPosition(range) {
    if (!rangeInsideEditor(range, this.root)) return false;
    const anchor = rangeSelectionRect(range);
    if (!anchor) return false;
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width || window.innerWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const offsetLeft = viewport?.offsetLeft || 0;
    const offsetTop = viewport?.offsetTop || 0;
    const maxRight = offsetLeft + viewportWidth - INLINE_TOOLBAR_MARGIN;
    const maxBottom = offsetTop + viewportHeight - INLINE_TOOLBAR_MARGIN;

    this.toolbar.style.visibility = "hidden";
    this.toolbar.hidden = false;
    const toolbarRect = this.toolbar.getBoundingClientRect();
    const width = Math.min(toolbarRect.width || 1, viewportWidth - INLINE_TOOLBAR_MARGIN * 2);
    const height = toolbarRect.height || 44;
    const center = anchor.left + anchor.width / 2;
    const left = clampNumber(center - width / 2, offsetLeft + INLINE_TOOLBAR_MARGIN, maxRight - width);
    const topAbove = anchor.top - height - INLINE_TOOLBAR_GAP;
    const topBelow = anchor.bottom + INLINE_TOOLBAR_GAP;
    const hasRoomAbove = topAbove >= offsetTop + INLINE_TOOLBAR_MARGIN;
    const top = hasRoomAbove
      ? topAbove
      : clampNumber(topBelow, offsetTop + INLINE_TOOLBAR_MARGIN, maxBottom - height);

    this.toolbar.style.left = `${Math.round(left)}px`;
    this.toolbar.style.top = `${Math.round(top)}px`;
    this.toolbar.dataset.placement = hasRoomAbove ? "top" : "bottom";
    this.toolbar.style.visibility = "";
    return true;
  }

  handlePointerDown(event) {
    const target = event.target;
    if (this.isToolbarTarget(target)) return;
    this.closeAllInlineSubmenus();
    if (target?.closest?.(".ce-toolbar__plus, .ce-toolbar__settings-btn")) {
      restoreEditorJsTransientMenus();
      this.hideInlineToolbar("external-menu");
      return;
    }
    if (target?.closest?.(".ce-toolbar__plus, .ce-toolbar__settings-btn, .ce-popover, .ce-settings, .ce-conversion-toolbar, #slash-menu, .tcloud-context-menu, .modal")) {
      this.hideInlineToolbar("external-menu");
      return;
    }
    if (!this.isEditorTarget(target)) this.hideInlineToolbar("pointer-outside");
  }

  handleKeyDown(event) {
    if (this.isEditorTarget(event.target)) {
      resetStickyNativeInlineCommands(this.root);
    }
    if (event.key === "Escape") {
      if (this.toolbar.classList.contains("is-open")) {
        event.preventDefault();
        event.stopPropagation();
        this.hideInlineToolbar("escape", { suppressSelection: true, clearSelection: true });
      }
      return;
    }
    if (event.key === "/") {
      this.hideInlineToolbar("slash-key", { suppressSelection: true });
      return;
    }

    const isCmdOrCtrl = event.metaKey || event.ctrlKey;
    if (!this.isEditorTarget(event.target) && !rangeInsideEditor(this.savedRange, this.root)) return;
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      this.adapter.changeBlockIndent(event.shiftKey ? -1 : 1).catch(console.warn);
      this.hideInlineToolbar("indent-shortcut", { suppressSelection: true });
      return;
    }
    if (isCmdOrCtrl && (event.key === "]" || event.key === "[")) {
      event.preventDefault();
      event.stopPropagation();
      this.adapter.changeBlockIndent(event.key === "]" ? 1 : -1).catch(console.warn);
      this.hideInlineToolbar("indent-shortcut", { suppressSelection: true });
    }
  }

  async runAction(action, target) {
    if (!action) return;
    if (action === "block-menu") {
      this.openBlockMenu(target);
      return;
    }
    if (action === "more") {
      this.openMoreMenu(target);
      return;
    }
    if (action === "text-color" || action === "highlight-color") {
      this.openColorMenu(target);
      return;
    }
    if (action.startsWith("color-custom:")) {
      this.applyCustomColor(action.split(":")[1]);
      return;
    }
    if (action.startsWith("color:")) {
      const [, mode, value = ""] = action.split(":");
      await this.applyColor(mode, value);
      return;
    }

    if (!restoreRange(this.savedRange, this.root)) {
      this.hideInlineToolbar("invalid-range");
      return;
    }

    if (action.startsWith("block:")) {
      const [, type, variant] = action.split(":");
      await this.adapter.convertCurrentBlock(type, {
        level: Number(variant || 2),
        style: variant || "unordered",
      });
      this.hideInlineToolbar("block-convert", { suppressSelection: true });
      return;
    }

    let changed = false;
    if (action === "bold") {
      const nextRange = toggleInlineElement(this.savedRange, "strong,b", "strong");
      if (nextRange) {
        this.savedRange = nextRange;
        changed = true;
      }
    }
    if (action === "italic") {
      const nextRange = toggleInlineElement(this.savedRange, "em,i", "em");
      if (nextRange) {
        this.savedRange = nextRange;
        changed = true;
      }
    }
    if (action === "underline") {
      const nextRange = toggleInlineElement(this.savedRange, "u", "u");
      if (nextRange) {
        this.savedRange = nextRange;
        changed = true;
      }
    }
    if (action === "strike") {
      const nextRange = toggleInlineElement(this.savedRange, "s,strike", "s");
      if (nextRange) {
        this.savedRange = nextRange;
        changed = true;
      }
    }
    if (action === "inline-code") {
      const nextRange = toggleInlineElement(this.savedRange, "code", "code");
      if (nextRange) {
        this.savedRange = nextRange;
        changed = true;
      }
    }
    if (action === "link") {
      const currentHref = closestInlineTag(this.savedRange, "a")?.getAttribute("href") || "https://";
      const href = window.prompt("Link", currentHref);
      if (href && restoreRange(this.savedRange, this.root)) {
        const nextRange = wrapRangeWithElement(this.savedRange, "a", {
          href: href.trim(),
          target: "_blank",
          rel: "noopener noreferrer",
        });
        if (nextRange) {
          this.savedRange = nextRange;
          changed = true;
        }
      }
    }
    if (action === "unlink") {
      changed = unwrapInlineElement(closestInlineTag(this.savedRange, "a"));
    }
    if (action === "indent") {
      await this.adapter.changeBlockIndent(1, this.savedRange);
      changed = true;
    }
    if (action === "outdent") {
      await this.adapter.changeBlockIndent(-1, this.savedRange);
      changed = true;
    }
    if (action === "clear") changed = document.execCommand("removeFormat");
    if (action === "copy") {
      await navigator.clipboard?.writeText?.(window.getSelection()?.toString() || this.savedRange.toString() || "");
      this.hideInlineToolbar("copy", { suppressSelection: true, clearSelection: true });
      return;
    }

    if (changed) await this.adapter.notifyManualChange();
    this.hideInlineToolbar(action, { suppressSelection: true, clearSelection: true });
  }

  async applyColor(mode, value) {
    const styleKey = mode === "background" ? "backgroundColor" : "color";
    const normalized = normalizeHex(value);
    if (value && !normalized) return;
    if (!restoreRange(this.savedRange, this.root)) {
      this.hideInlineToolbar("invalid-color-range");
      return;
    }
    const nextRange = applyInlineStyle(this.savedRange, { [styleKey]: normalized || null });
    if (nextRange) this.savedRange = nextRange;
    await this.adapter.notifyManualChange();
    this.hideInlineToolbar("color", { suppressSelection: true, clearSelection: true });
  }

  applyCustomColor(mode) {
    const input = this.submenu?.querySelector("[data-tcloud-color-hex]");
    const error = this.submenu?.querySelector("[data-tcloud-color-error]");
    const normalized = normalizeHex(input?.value);
    if (!normalized) {
      input?.classList.add("is-invalid");
      error?.classList.remove("hidden");
      input?.focus();
      return;
    }
    this.applyColor(mode, normalized).catch(console.warn);
  }

  openSubmenu(anchor, menu) {
    const wasSame = this.submenu?.dataset.menuType === menu.dataset.menuType;
    this.closeAllInlineSubmenus();
    if (wasSame) return;
    this.submenu = menu;
    this.submenu.addEventListener("mousedown", (event) => {
      if (!event.target.matches?.("input")) event.preventDefault();
    });
    this.submenu.addEventListener("pointerdown", (event) => {
      if (!event.target.matches?.("input")) event.preventDefault();
    });
    this.submenu.addEventListener("click", (event) => {
      const target = event.target.closest("[data-tcloud-action]");
      if (!target || target.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      this.runAction(target.dataset.tcloudAction, target).catch(console.warn);
    });
    document.body.appendChild(this.submenu);
    this.activeAnchor = anchor;
    anchor?.setAttribute("aria-expanded", "true");
    this.positionSubmenu();
  }

  positionSubmenu() {
    if (!this.submenu?.isConnected) return;
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width || window.innerWidth;
    const viewportHeight = viewport?.height || window.innerHeight;
    const offsetLeft = viewport?.offsetLeft || 0;
    const offsetTop = viewport?.offsetTop || 0;
    const anchorRect = this.activeAnchor?.getBoundingClientRect?.() || this.toolbar.getBoundingClientRect();
    const toolbarRect = this.toolbar.getBoundingClientRect();
    this.submenu.style.visibility = "hidden";
    const menuRect = this.submenu.getBoundingClientRect();
    const width = menuRect.width || 220;
    const height = menuRect.height || 160;
    const left = clampNumber(anchorRect.left, offsetLeft + INLINE_TOOLBAR_MARGIN, offsetLeft + viewportWidth - width - INLINE_TOOLBAR_MARGIN);
    const belowTop = toolbarRect.bottom + INLINE_TOOLBAR_GAP;
    const aboveTop = toolbarRect.top - height - INLINE_TOOLBAR_GAP;
    const top = belowTop + height <= offsetTop + viewportHeight - INLINE_TOOLBAR_MARGIN
      ? belowTop
      : clampNumber(aboveTop, offsetTop + INLINE_TOOLBAR_MARGIN, offsetTop + viewportHeight - height - INLINE_TOOLBAR_MARGIN);
    this.submenu.style.left = `${Math.round(left)}px`;
    this.submenu.style.top = `${Math.round(top)}px`;
    this.submenu.style.visibility = "";
  }

  closeAllInlineSubmenus() {
    this.submenu?.remove();
    this.submenu = null;
    this.activeAnchor?.setAttribute("aria-expanded", "false");
    this.activeAnchor = null;
  }

  openBlockMenu(anchor) {
    const menu = document.createElement("div");
    menu.className = "tcloud-inline-toolbar__menu tcloud-inline-toolbar__block-menu";
    menu.dataset.menuType = "block";
    menu.setAttribute("role", "menu");
    [
      ["block:paragraph", "Texto", '<i class="ph ph-text-aa" aria-hidden="true"></i>'],
      ["block:header:1", "Título 1", '<i class="ph ph-text-h-one" aria-hidden="true"></i>'],
      ["block:header:2", "Título 2", '<i class="ph ph-text-h-two" aria-hidden="true"></i>'],
      ["block:header:3", "Título 3", '<i class="ph ph-text-h-three" aria-hidden="true"></i>'],
      ["block:list:unordered", "Lista com marcadores", '<i class="ph ph-list-bullets" aria-hidden="true"></i>'],
      ["block:list:ordered", "Lista numerada", '<i class="ph ph-list-numbers" aria-hidden="true"></i>'],
      ["block:todo", "Checklist", '<i class="ph ph-check-square" aria-hidden="true"></i>'],
      ["block:quote", "Citação", '<i class="ph ph-quotes" aria-hidden="true"></i>'],
      ["block:codeBlock", "Código", '<i class="ph ph-code-block" aria-hidden="true"></i>'],
    ].forEach(([action, label, icon]) => menu.appendChild(createMenuButton({ action, label, icon })));
    this.openSubmenu(anchor, menu);
  }

  openMoreMenu(anchor) {
    const menu = document.createElement("div");
    menu.className = "tcloud-inline-toolbar__menu tcloud-inline-toolbar__more-menu";
    menu.dataset.menuType = "more";
    menu.setAttribute("role", "menu");
    [
      ["copy", "Copiar seleção", '<i class="ph ph-copy" aria-hidden="true"></i>'],
      ["clear", "Limpar formatação", '<i class="ph ph-eraser" aria-hidden="true"></i>'],
    ].forEach(([action, label, icon]) => menu.appendChild(createMenuButton({ action, label, icon })));
    this.openSubmenu(anchor, menu);
  }

  openColorMenu(anchor) {
    const menu = document.createElement("div");
    menu.className = "tcloud-inline-toolbar__menu tcloud-inline-toolbar__color-menu";
    menu.dataset.menuType = "color";
    menu.setAttribute("role", "menu");
    const state = rangeInsideEditor(this.savedRange, this.root) ? getSelectedInlineState(this.savedRange) : { color: "", backgroundColor: "" };

    const title = document.createElement("div");
    title.className = "tcloud-inline-toolbar__menu-title";
    title.textContent = "Cores";
    menu.appendChild(title);
    menu.appendChild(this.colorSection("Cor do texto", "text", INLINE_COLOR_PRESETS.text, state.color));
    menu.appendChild(this.colorSection("Marca-texto", "background", INLINE_COLOR_PRESETS.background, state.backgroundColor));
    menu.appendChild(this.customColorSection());
    this.openSubmenu(anchor, menu);
  }

  colorSection(label, mode, colors, activeValue) {
    const section = document.createElement("section");
    section.className = "tcloud-inline-toolbar__color-section";
    const heading = document.createElement("span");
    heading.textContent = label;
    const grid = document.createElement("div");
    grid.className = "tcloud-inline-toolbar__color-grid";

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "tcloud-inline-toolbar__color-clear";
    clear.dataset.tcloudAction = `color:${mode}:`;
    clear.title = mode === "background" ? "Remover marca-texto" : "Remover cor";
    clear.setAttribute("aria-label", clear.title);
    clear.innerHTML = '<span class="is-empty"></span>';
    clear.addEventListener("mousedown", (event) => event.preventDefault());
    clear.addEventListener("pointerdown", (event) => event.preventDefault());
    grid.appendChild(clear);

    colors.forEach(([name, hex]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tcloudAction = `color:${mode}:${hex}`;
      button.title = `${label}: ${name}`;
      button.setAttribute("aria-label", button.title);
      button.innerHTML = `<span style="background:${hex}"></span>`;
      button.classList.toggle("is-active", Boolean(activeValue && normalizeHex(activeValue) === normalizeHex(hex)));
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      grid.appendChild(button);
    });
    section.append(heading, grid);
    return section;
  }

  customColorSection() {
    const section = document.createElement("section");
    section.className = "tcloud-inline-toolbar__color-section tcloud-inline-toolbar__custom-color";
    const label = document.createElement("span");
    label.textContent = "HEX";
    const row = document.createElement("div");
    row.className = "tcloud-inline-toolbar__hex-row";
    const visual = document.createElement("input");
    visual.type = "color";
    visual.value = "#2563EB";
    visual.setAttribute("aria-label", "Seletor visual de cor");
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "#2563EB";
    input.value = "#2563EB";
    input.maxLength = 7;
    input.dataset.tcloudColorHex = "true";
    input.setAttribute("aria-label", "Cor hexadecimal");
    const applyText = createMenuButton({ action: "color-custom:text", label: "Texto" });
    const applyBackground = createMenuButton({ action: "color-custom:background", label: "Fundo" });
    const error = document.createElement("span");
    error.className = "tcloud-inline-toolbar__color-error hidden";
    error.dataset.tcloudColorError = "true";
    error.textContent = "HEX inválido";

    visual.addEventListener("input", () => {
      input.value = normalizeHex(visual.value) || visual.value;
      input.classList.remove("is-invalid");
      error.classList.add("hidden");
    });
    input.addEventListener("input", () => {
      const normalized = normalizeHex(input.value);
      input.classList.toggle("is-invalid", Boolean(input.value.trim()) && !normalized);
      error.classList.toggle("hidden", Boolean(normalized) || !input.value.trim());
      if (normalized) visual.value = normalized;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeAllInlineSubmenus();
        this.toolbar.focus?.();
      }
    });
    row.append(visual, input, applyText, applyBackground);
    section.append(label, row, error);
    return section;
  }

  externalEditorMenuOpen() {
    const selectors = [
      "#slash-menu:not(.hidden)",
      ".tcloud-context-menu:not(.hidden)",
      ".modal:not(.hidden)",
      ".appearance-popover:not(.hidden)",
      ".ce-popover:not(.ce-popover--inline)",
      ".ce-settings",
      ".ce-conversion-toolbar",
    ];
    return selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some(visibleElement));
  }

  hideNativeInlineToolbar() {
    document.querySelectorAll(".ce-inline-toolbar:not(.tcloud-inline-toolbar--custom)").forEach((toolbar) => {
      if (toolbar.getAttribute("aria-hidden") !== "true") toolbar.setAttribute("aria-hidden", "true");
      if (!toolbar.classList.contains("tcloud-native-inline-toolbar-hidden")) {
        toolbar.classList.add("tcloud-native-inline-toolbar-hidden");
      }
    });
  }

  updateToolbarState() {
    const range = this.savedRange;
    const blockIndex = this.adapter.blockIndexFromRange(range);
    const block = this.adapter.lastSavedContent?.blocks?.[blockIndex];
    const canOutdent = this.adapter.currentIndentLevelSync(range) > 0 || block?.type === "list";
    const inlineState = rangeInsideEditor(range, this.root) ? getSelectedInlineState(range) : { color: "", backgroundColor: "" };
    const activeLink = Boolean(closestInlineTag(range, "a"));
    const activeCode = Boolean(closestInlineTag(range, "code"));
    const states = {
      bold: Boolean(closestInlineTag(range, "strong,b")),
      italic: Boolean(closestInlineTag(range, "em,i")),
      underline: Boolean(closestInlineTag(range, "u")),
      strike: Boolean(closestInlineTag(range, "s,strike")),
      "inline-code": activeCode,
      link: activeLink,
      "text-color": Boolean(inlineState.color),
      "highlight-color": Boolean(inlineState.backgroundColor),
    };
    Object.entries(states).forEach(([action, active]) => {
      const button = this.toolbar.querySelector(`[data-tcloud-action="${action}"]`);
      button?.classList.toggle("is-active", Boolean(active));
      button?.setAttribute("aria-pressed", active ? "true" : "false");
    });
    const unlink = this.toolbar.querySelector('[data-tcloud-action="unlink"]');
    if (unlink) {
      unlink.disabled = !activeLink;
      unlink.setAttribute("aria-disabled", activeLink ? "false" : "true");
    }
    const outdent = this.toolbar.querySelector('[data-tcloud-action="outdent"]');
    if (outdent) {
      outdent.disabled = !canOutdent;
      outdent.setAttribute("aria-disabled", canOutdent ? "false" : "true");
    }
    const blockLabel = this.toolbar.querySelector("[data-tcloud-block-label]");
    if (blockLabel) blockLabel.textContent = this.currentBlockLabel();
  }

  currentBlockLabel() {
    const index = this.adapter.blockIndexFromRange(this.savedRange);
    const block = this.adapter.lastSavedContent?.blocks?.[index];
    if (!block) return "Texto";
    if (block.type === "header") return `Título ${Number(block.data?.level || 2)}`;
    if (block.type === "list") return String(block.data?.style || "") === "ordered" ? "Lista numerada" : "Lista";
    if (block.type === "todo") return "Checklist";
    if (block.type === "quote") return "Citação";
    if (block.type === "codeBlock") return "Código";
    return "Texto";
  }

  divider() {
    const divider = document.createElement("span");
    divider.className = "tcloud-inline-toolbar__divider";
    divider.setAttribute("aria-hidden", "true");
    return divider;
  }
}

export class EditorAdapter {
  constructor({ holder, onChange, blockConfig = {} }) {
    this.holder = holder;
    this.onChange = typeof onChange === "function" ? onChange : () => {};
    this.blockConfig = blockConfig;
    this.editor = null;
    this.readyPromise = null;
    this.rendering = false;
    this.history = [];
    this.historyIndex = -1;
    this.maxHistorySize = 100;
    this.historyDebounceTimeout = null;
    this.isUndoingOrRedoing = false;
    this.toolbarController = null;
    this.lastSavedContent = normalizeEditorData(null);
  }

  async init(initialData) {
    if (this.readyPromise) return this.readyPromise;

    if (!window.EditorJS || !window.Paragraph || !window.Header || !window.EditorjsList) {
      throw new Error("Editor.js vendorizado nao carregou corretamente.");
    }

    this.editor = new window.EditorJS({
      holder: this.holder,
      autofocus: false,
      inlineToolbar: false,
      placeholder: "Escreva aqui. Use / para inserir blocos.",
      data: normalizeEditorData(initialData),
      sanitizer: INLINE_SANITIZER_RULES,
      i18n: {
        messages: {
          toolNames: {
            Text: "Texto",
            Heading: "Título",
            List: "Lista",
            "Unordered List": "Lista",
            "Ordered List": "Lista numerada",
            Checklist: "Checklist",
            Quote: "Citação",
            Code: "Código",
            Bold: "Negrito",
            Italic: "Itálico",
            Link: "Link",
            Color: "Cor",
            TextColor: "Cor",
            textColor: "Cor",
            "Convert to": "Converter para",
            "Inline Code": "Código inline",
            text: "Texto",
            heading: "Título",
            list: "Lista",
            ordered: "Lista numerada",
            unordered: "Lista",
            Ordered: "Lista numerada",
            Unordered: "Lista",
            checklist: "Checklist",
            quote: "Citação",
            code: "Código",
            bold: "Negrito",
            italic: "Itálico",
            link: "Link",
            tcloudFile: "Arquivo do TCloud",
            tcloudImage: "Imagem do TCloud",
            tcloudVideo: "Vídeo do TCloud",
            tcloudAudio: "Áudio do TCloud",
            tcloudPdf: "PDF do TCloud",
            tcloudFolder: "Pasta do TCloud",
          },
          tools: {
            link: {
              "Add a link": "Inserir link",
              "Link": "Link",
            },
            bold: {
              "Bold": "Negrito",
            },
            italic: {
              "Italic": "Itálico",
            },
          },
          blockTunes: {
            delete: {
              Delete: "Excluir",
              "Click to delete": "Clique para excluir",
            },
            moveUp: {
              "Move up": "Mover para cima",
              "Move Up": "Mover para cima",
            },
            moveDown: {
              "Move down": "Mover para baixo",
              "Move Down": "Mover para baixo",
            },
          },
          ui: {
            blockTunes: {
              toggler: {
                "Click to tune": "Ajustar bloco",
                "or drag to move": "ou arraste para mover",
              },
            },
            inlineToolbar: {
              converter: {
                "Convert to": "Converter para",
              },
            },
            toolbar: {
              toolbox: {
                Add: "Adicionar",
              },
            },
            popover: {
              Filter: "Filtrar",
              "Nothing found": "Nada encontrado",
              "Convert to": "Converter para",
              "Tune": "Ajustar",
              "Add": "Adicionar",
              "Move up": "Mover para cima",
              "Move down": "Mover para baixo",
              "Delete": "Excluir",
            },
          },
        },
      },
      tools: {
        paragraph: {
          class: paragraphToolWithInlineSanitizer(),
          inlineToolbar: false,
          config: {
            preserveBlank: true,
          },
        },
        header: {
          class: headerToolWithInlineSanitizer(),
          inlineToolbar: false,
          config: {
            levels: [1, 2, 3],
            defaultLevel: 2,
          },
        },
        list: {
          class: window.EditorjsList,
          inlineToolbar: false,
          config: {
            defaultStyle: "unordered",
          },
        },
        textColor: {
          class: TextColorTool,
          config: {
            onInlineChange: () => {
              if (this.rendering) return;
              Promise.resolve(this.onChange()).catch((error) => {
                console.warn("Falha ao registrar alteracao inline", error);
              });
              if (!this.isUndoingOrRedoing) {
                this.triggerHistorySave();
              }
            },
          },
        },
        todo: {
          class: TodoTool,
        },
        quote: {
          class: QuoteTool,
        },
        codeBlock: {
          class: CodeBlockTool,
        },
        divider: {
          class: DividerTool,
        },
        tcloudFile: {
          class: TCloudFileTool,
          config: this.blockConfig,
        },
        tcloudImage: {
          class: TCloudImageTool,
          config: this.blockConfig,
        },
        tcloudVideo: {
          class: TCloudVideoTool,
          config: this.blockConfig,
        },
        tcloudAudio: {
          class: TCloudAudioTool,
          config: this.blockConfig,
        },
        tcloudPdf: {
          class: TCloudPdfTool,
          config: this.blockConfig,
        },
        tcloudFolder: {
          class: TCloudFolderTool,
          config: this.blockConfig,
        },
      },
      onChange: async () => {
        if (this.rendering) return;
        await this.onChange();
        if (!this.isUndoingOrRedoing) {
          this.triggerHistorySave();
        }
      },
    });

    this.readyPromise = this.editor.isReady;
    await this.readyPromise;
    if (!this.toolbarController) {
      this.toolbarController = new TCloudInlineToolbarController(this);
    }
    this.applyIndentAttributes(normalizeEditorData(initialData));
    return this.editor;
  }

  async render(data, { isNewNote = false } = {}) {
    await this.init(data);
    this.hideInlineToolbar("render");
    this.rendering = true;
    try {
      const normalized = normalizeEditorData(data);
      await this.editor.blocks.render(normalized);
      this.lastSavedContent = normalized;
      this.applyIndentAttributes(normalized);
      if (isNewNote) {
        this.history = [JSON.parse(JSON.stringify(normalized))];
        this.historyIndex = 0;
      } else if (!this.isUndoingOrRedoing) {
        this.pushHistoryState(normalized);
      }
    } finally {
      this.rendering = false;
    }
  }

  async saveHistoryImmediate() {
    try {
      const content = await this.save();
      const contentStr = JSON.stringify(content.blocks);
      const currentStr = this.history[this.historyIndex] ? JSON.stringify(this.history[this.historyIndex].blocks) : "";
      if (contentStr !== currentStr) {
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(JSON.parse(JSON.stringify(content)));
        this.historyIndex++;
        if (this.history.length > this.maxHistorySize) {
          this.history.shift();
          this.historyIndex--;
        }
      }
    } catch (e) {
      console.warn("Falha ao salvar estado do historico", e);
    }
  }

  triggerHistorySave() {
    clearTimeout(this.historyDebounceTimeout);
    this.historyDebounceTimeout = setTimeout(async () => {
      this.historyDebounceTimeout = null;
      await this.saveHistoryImmediate();
    }, 400);
  }

  pushHistoryState(content) {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(JSON.parse(JSON.stringify(content)));
    this.historyIndex++;
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
      this.historyIndex--;
    }
  }

  async undo() {
    if (this.historyDebounceTimeout) {
      clearTimeout(this.historyDebounceTimeout);
      this.historyDebounceTimeout = null;
      await this.saveHistoryImmediate();
    }

    if (this.historyIndex <= 0) {
      return;
    }
    
    let focusedIndex = await this.currentBlockIndex();

    this.historyIndex--;
    const stateToRestore = this.history[this.historyIndex];
    if (stateToRestore) {
      this.isUndoingOrRedoing = true;
      try {
        await this.render(stateToRestore);
        const blocksCount = stateToRestore.blocks.length;
        if (focusedIndex >= 0 && blocksCount > 0) {
          const targetIndex = Math.min(focusedIndex, blocksCount - 1);
          if (typeof this.editor.caret?.setToBlock === "function") {
            try {
              this.editor.caret.setToBlock(targetIndex, "end");
            } catch (err) {
              await this.focus();
            }
          }
        } else {
          await this.focus();
        }
      } finally {
        this.isUndoingOrRedoing = false;
      }
    }
  }

  async redo() {
    if (this.historyIndex >= this.history.length - 1) {
      return;
    }
    
    let focusedIndex = await this.currentBlockIndex();
    
    this.historyIndex++;
    const stateToRestore = this.history[this.historyIndex];
    if (stateToRestore) {
      this.isUndoingOrRedoing = true;
      try {
        await this.render(stateToRestore);
        const blocksCount = stateToRestore.blocks.length;
        if (focusedIndex >= 0 && blocksCount > 0) {
          const targetIndex = Math.min(focusedIndex, blocksCount - 1);
          if (typeof this.editor.caret?.setToBlock === "function") {
            try {
              this.editor.caret.setToBlock(targetIndex, "end");
            } catch (err) {
              await this.focus();
            }
          }
        } else {
          await this.focus();
        }
      } finally {
        this.isUndoingOrRedoing = false;
      }
    }
  }

  async save() {
    await this.init();
    const content = normalizeEditorData(await this.editor.save());
    this.mergeIndentFromDom(content);
    this.lastSavedContent = content;
    this.applyIndentAttributes(content);
    return content;
  }

  async clear() {
    this.hideInlineToolbar("clear");
    await this.render(defaultEditorData());
  }

  hideInlineToolbar(reason = "manual") {
    this.toolbarController?.hideInlineToolbar(reason);
  }

  async focus() {
    await this.init();
    if (typeof this.editor.caret?.setToLastBlock === "function") {
      this.editor.caret.setToLastBlock("end");
    }
  }

  async currentBlockIndex() {
    await this.init();
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const node = selection.getRangeAt(0).commonAncestorContainer;
      const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const blockElement = element?.closest?.(".ce-block");
      const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
      const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
      const domIndex = blocks.indexOf(blockElement);
      if (domIndex >= 0) return domIndex;
    }
    if (typeof this.editor.blocks?.getCurrentBlockIndex === "function") {
      return this.editor.blocks.getCurrentBlockIndex();
    }
    return -1;
  }

  async insertSlashBlock(type, data = {}, { replaceCurrent = true } = {}) {
    const content = normalizeEditorData(await this.save());
    let index = await this.currentBlockIndex();
    if (!Number.isInteger(index) || index < 0) {
      index = content.blocks.length - 1;
    }
    const currentBlock = content.blocks[index];
    let sourceText = blockPlainText(currentBlock);
    if (replaceCurrent) {
      const lastSlash = sourceText.lastIndexOf("/");
      if (lastSlash !== -1) {
        sourceText = sourceText.substring(0, lastSlash);
      }
    }
    const inheritedIndent = copyIndentData(currentBlock?.data || {});
    const nextBlock = buildBlock(type, replaceCurrent ? convertBlockData(type, sourceText, { ...data, ...inheritedIndent }) : { ...data, ...inheritedIndent });
    const shouldInsertTextAfter = isTCloudBlockType(type);
    let caretIndex = index;

    if (replaceCurrent && content.blocks[index]) {
      content.blocks.splice(index, 1, nextBlock);
    } else {
      content.blocks.splice(index + 1, 0, nextBlock);
      index += 1;
    }

    caretIndex = index;
    if (shouldInsertTextAfter) {
      const next = content.blocks[index + 1];
      const nextHasEditableText = next && ["paragraph", "header", "list", "todo", "quote", "codeBlock"].includes(next.type);
      if (!nextHasEditableText) {
        content.blocks.splice(index + 1, 0, buildBlock("paragraph", { text: "" }));
      }
      caretIndex = index + 1;
    }

    content.time = Date.now();
    await this.render(content);
    if (typeof this.editor.caret?.setToBlock === "function") {
      try {
        this.editor.caret.setToBlock(caretIndex, "end");
      } catch (error) {
        await this.focus();
      }
    } else {
      await this.focus();
    }
  }

  async duplicateBlock() {
    await this.init();
    const index = await this.currentBlockIndex();
    if (index === -1) return;
    const content = normalizeEditorData(await this.save());
    const targetBlock = content.blocks[index];
    if (!targetBlock) return;
    const duplicatedBlock = buildBlock(targetBlock.type, JSON.parse(JSON.stringify(targetBlock.data)));
    content.blocks.splice(index + 1, 0, duplicatedBlock);
    content.time = Date.now();
    await this.render(content);
    if (typeof this.editor.caret?.setToBlock === "function") {
      try {
        this.editor.caret.setToBlock(index + 1, "end");
      } catch (error) {
        await this.focus();
      }
    } else {
      await this.focus();
    }
  }

  async deleteBlockAtIndex(index) {
    await this.init();
    if (index === -1) return;
    const content = normalizeEditorData(await this.save());
    if (content.blocks.length <= 1) {
      content.blocks = [buildBlock("paragraph", { text: "" })];
    } else {
      content.blocks.splice(index, 1);
    }
    content.time = Date.now();
    await this.render(content);
    const newFocusIndex = Math.min(index, content.blocks.length - 1);
    if (typeof this.editor.caret?.setToBlock === "function") {
      try {
        this.editor.caret.setToBlock(newFocusIndex, "end");
      } catch (error) {
        await this.focus();
      }
    } else {
      await this.focus();
    }
    await this.onChange();
    this.triggerHistorySave();
  }

  async deleteBlockByElement(element) {
    await this.init();
    const blockElement = element?.closest?.(".ce-block");
    if (!blockElement) return;
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
    const index = blocks.indexOf(blockElement);
    if (index === -1) return;
    await this.deleteBlockAtIndex(index);
  }

  async deleteBlock() {
    await this.deleteBlockAtIndex(await this.currentBlockIndex());
  }

  applyIndentAttributes(content = this.lastSavedContent) {
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
    const normalized = normalizeEditorData(content);
    blocks.forEach((element, index) => {
      const level = clampIndentLevel(normalized.blocks[index]?.data?.tcloudIndent?.level);
      element.dataset.tcloudIndent = String(level);
      element.style.setProperty("--tcloud-indent-level", String(level));
    });
  }

  mergeIndentFromDom(content) {
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
    content.blocks.forEach((block, index) => {
      const level = clampIndentLevel(blocks[index]?.dataset?.tcloudIndent);
      const data = block.data && typeof block.data === "object" ? block.data : {};
      if (level) {
        data.tcloudIndent = { level };
      } else {
        delete data.tcloudIndent;
      }
      block.data = data;
    });
  }

  currentIndentLevelSync(preferredRange = null) {
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const indexFromRange = this.blockIndexFromRange(preferredRange);
    if (indexFromRange >= 0) {
      const block = holderElement?.querySelectorAll(".ce-block")?.[indexFromRange];
      return clampIndentLevel(block?.dataset?.tcloudIndent);
    }
    const index = this.editor?.blocks?.getCurrentBlockIndex?.();
    if (Number.isInteger(index) && index >= 0) {
      const block = holderElement?.querySelectorAll(".ce-block")?.[index];
      return clampIndentLevel(block?.dataset?.tcloudIndent);
    }
    return 0;
  }

  tryNativeListIndent(delta, preferredRange = null) {
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    if (preferredRange && !restoreRange(preferredRange, holderElement, { allowCollapsed: true })) return false;
    const selection = window.getSelection();
    const element = nodeToElement(selection?.anchorNode);
    const listItem = element?.closest?.(".cdx-list__item, li");
    if (!listItem || !holderElement?.contains(listItem)) return false;
    const command = Number(delta || 0) > 0 ? "indent" : "outdent";
    if (document.queryCommandSupported && !document.queryCommandSupported(command)) return false;
    return Boolean(document.execCommand(command));
  }

  blockIndexFromRange(range) {
    if (!range) return -1;
    const node = range.commonAncestorContainer;
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const blockElement = element?.closest?.(".ce-block");
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
    return blocks.indexOf(blockElement);
  }

  async notifyManualChange() {
    await this.onChange();
    if (!this.isUndoingOrRedoing) this.triggerHistorySave();
  }

  async changeBlockIndent(delta, preferredRange = null) {
    await this.init();
    const indexFromRange = this.blockIndexFromRange(preferredRange);
    const index = indexFromRange >= 0 ? indexFromRange : await this.currentBlockIndex();
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blockElement = holderElement?.querySelectorAll(".ce-block")?.[index];
    if (!blockElement) return 0;
    if (this.lastSavedContent?.blocks?.[index]?.type === "list" && this.tryNativeListIndent(delta, preferredRange)) {
      await this.notifyManualChange();
      this.toolbarController?.updateToolbarState();
      return clampIndentLevel(blockElement.dataset.tcloudIndent);
    }
    const nextLevel = clampIndentLevel(clampIndentLevel(blockElement.dataset.tcloudIndent) + Number(delta || 0));
    blockElement.dataset.tcloudIndent = String(nextLevel);
    blockElement.style.setProperty("--tcloud-indent-level", String(nextLevel));
    await this.notifyManualChange();
    this.toolbarController?.updateToolbarState();
    return nextLevel;
  }

  async convertCurrentBlock(type, data = {}) {
    await this.init();
    const content = normalizeEditorData(await this.save());
    const index = await this.currentBlockIndex();
    if (!Number.isInteger(index) || index < 0 || !content.blocks[index]) return;
    const currentBlock = content.blocks[index];
    const sourceText = blockPlainText(currentBlock);
    const nextData = convertBlockData(type, sourceText, {
      ...data,
      ...copyIndentData(currentBlock.data || {}),
    });
    const nextBlock = buildBlock(type, nextData);
    nextBlock.id = currentBlock.id || nextBlock.id;
    content.blocks[index] = nextBlock;
    content.time = Date.now();
    await this.render(content);
    if (typeof this.editor.caret?.setToBlock === "function") {
      try {
        this.editor.caret.setToBlock(index, "end");
      } catch (error) {
        await this.focus();
      }
    }
    await this.notifyManualChange();
  }
}

export function normalizeEditorData(data) {
  if (!data || typeof data !== "object") {
    return defaultEditorData();
  }

  const blocks = Array.isArray(data.blocks) && data.blocks.length ? data.blocks.map(normalizeBlock) : defaultEditorData().blocks;
  return {
    time: Number(data.time || Date.now()),
    blocks,
    version: String(data.version || "2.31.6"),
  };
}
