import {
  CodeBlockTool,
  DividerTool,
  INLINE_SANITIZER_RULES,
  QuoteTool,
  TextColorTool,
  TodoTool,
  applyHtmlInlineStyle,
  applyInlineStyle,
  clearHtmlInlineFormatting,
  getSelectedInlineState,
  normalizeHex,
} from "./editor-tools.js?v=notes-multiblock-snapshot-20260609-1";
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
import { EditorJsPopoverController } from "./editor-popovers.js?v=notes-menu-system-clear-20260704-3";

const TCLOUD_INDENT_MAX = 6;
const CONVERTIBLE_BLOCK_TYPES = new Set(["paragraph", "header", "list", "todo", "quote", "codeBlock"]);
const TEXT_FORMAT_COMPATIBLE_BLOCK_TYPES = new Set(["paragraph", "header", "list", "todo", "quote"]);
const TEXT_FIELDS_BY_BLOCK_TYPE = {
  paragraph: ["text"],
  header: ["text"],
  todo: ["text"],
  quote: ["text", "caption"],
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

function listToolWithInlineSanitizer() {
  return class TCloudListTool extends window.EditorjsList {
    static get sanitize() {
      return { style: false, items: INLINE_SANITIZER_RULES, meta: false };
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

// Mapeia um item do popover "Converter para" (Editor.js v2.31) para
// (type, data). O vendor popula o MESMO data-item-name="list" para os tres
// estilos (marcadores/numerada/checklist) e "header" para todos os niveis;
// a distincao so esta no titulo localizado. Sem este mapeamento,
// convertCurrentBlock("list") sem style sempre vira "marcadores".
function resolveConversionPayload(dataName, title = "") {
  const t = String(title || "").trim();
  if (dataName === "header") {
    const m = t.match(/(\d+)/);
    return { type: "header", data: { level: m ? Number(m[1]) : 2 } };
  }
  if (dataName === "list") {
    if (/numerada/i.test(t)) return { type: "list", data: { style: "ordered" } };
    if (/checklist/i.test(t)) return { type: "todo", data: {} };
    return { type: "list", data: { style: "unordered" } };
  }
  return { type: dataName, data: {} };
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

function isConvertibleBlock(block) {
  return Boolean(block && CONVERTIBLE_BLOCK_TYPES.has(block.type));
}

function isTextFormatCompatibleBlock(block) {
  return Boolean(block && TEXT_FORMAT_COMPATIBLE_BLOCK_TYPES.has(block.type));
}

function applyToBlockTextFields(block, transform) {
  if (!block?.data || typeof transform !== "function") return false;
  let changed = false;
  if (block.type === "list" && Array.isArray(block.data.items)) {
    block.data.items = block.data.items.map((item) => {
      const current = typeof item === "string" ? item : "";
      const next = transform(current);
      if (next !== current) changed = true;
      return next;
    });
    return changed;
  }

  const fields = TEXT_FIELDS_BY_BLOCK_TYPE[block.type] || [];
  fields.forEach((field) => {
    if (typeof block.data[field] !== "string") return;
    const current = block.data[field];
    const next = transform(current);
    if (next !== current) {
      block.data[field] = next;
      changed = true;
    }
  });
  return changed;
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

function isBlockedInlineToolbarTarget(element) {
  return Boolean(element?.closest?.(
    ".tcloud-inline-toolbar, " +
    ".ce-inline-toolbar, " +
    ".tcloud-inline-toolbar__menu, " +
    ".ce-popover, " +
    ".ce-settings, " +
    ".ce-toolbar, " +
    ".ce-conversion-toolbar, " +
    ".tcloud-context-menu, " +
    ".modal, " +
    ".sidebar, " +
    ".appearance-popover, " +
    "#slash-menu, " +
    "#colon-icon-menu, " +
    ".colon-icon-menu",
  ));
}

const PROTECTED_POPOVER_TARGETS = [
  ".ce-toolbar__plus",
  ".ce-toolbar__settings-btn",
  ".ce-popover",
  ".ce-settings",
  ".ce-conversion-toolbar",
  ".ce-settings__button",
  ".ce-conversion-tool",
  ".ce-popover-item",
  "#slash-menu",
  "#colon-icon-menu",
  ".colon-icon-menu",
  ".tcloud-context-menu",
  ".modal",
].join(", ");

function editorEditableForNode(node, root) {
  const element = nodeToElement(node);
  if (isBlockedInlineToolbarTarget(element)) return null;
  const editable = element?.closest?.("[contenteditable='true']");
  return editable && root?.contains(editable) ? editable : null;
}

function rangeInsideEditor(range, root) {
  if (!range || !root) return false;
  try {
    const startElement = nodeToElement(range.startContainer);
    const endElement = nodeToElement(range.endContainer);
    const commonElement = nodeToElement(range.commonAncestorContainer);

    if (!commonElement || !root.contains(commonElement)) return false;
    if (
      isBlockedInlineToolbarTarget(startElement) ||
      isBlockedInlineToolbarTarget(endElement) ||
      isBlockedInlineToolbarTarget(commonElement)
    ) {
      return false;
    }

    const text = range.toString().replace(/\u200B/g, "").trim();
    if (!text) return false;

    const editable =
      editorEditableForNode(range.startContainer, root) ||
      editorEditableForNode(range.endContainer, root) ||
      commonElement.closest?.("[contenteditable='true']") ||
      commonElement.closest?.(
        ".ce-block, .ce-block__content, .codex-editor__redactor, .editorjs-host, .codex-editor",
      );

    return Boolean(
      editable &&
      root.contains(editable) &&
      !isBlockedInlineToolbarTarget(editable),
    );
  } catch (error) {
    return false;
  }
}

function restoreRange(range, root, { allowCollapsed = false } = {}) {
  if (!range || (!allowCollapsed && range.collapsed) || !rangeInsideEditor(range, root)) return false;
  const selection = window.getSelection();
  
  const common = range.commonAncestorContainer;
  if (common) {
    const editable = common.nodeType === Node.ELEMENT_NODE
      ? common.closest?.("[contenteditable='true']")
      : common.parentElement?.closest?.("[contenteditable='true']");
    
    if (editable && document.activeElement !== editable) {
      editable.focus({ preventScroll: true });
    }
  }

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
  if (!rects.length) {
    const commonElement = nodeToElement(range.commonAncestorContainer);
    const fallbackElement = commonElement?.closest?.(
      "[contenteditable='true'], .ce-block, .ce-block__content, .codex-editor__redactor",
    );
    if (fallbackElement && !isBlockedInlineToolbarTarget(fallbackElement)) {
      rects = Array.from(fallbackElement.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
    }
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

function rectFromBox(box) {
  if (!box) return null;
  const left = Number(box.left);
  const top = Number(box.top);
  const right = Number(box.right);
  const bottom = Number(box.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { left, top, right, bottom, width, height };
}

function unionRects(rects = []) {
  const normalized = rects.map((rect) => rectFromBox(rect)).filter(Boolean);
  if (!normalized.length) return null;
  const left = Math.min(...normalized.map((rect) => rect.left));
  const top = Math.min(...normalized.map((rect) => rect.top));
  const right = Math.max(...normalized.map((rect) => rect.right));
  const bottom = Math.max(...normalized.map((rect) => rect.bottom));
  return rectFromBox({ left, top, right, bottom });
}

function expandRect(rect, padding = 0) {
  const normalized = rectFromBox(rect);
  if (!normalized) return null;
  return rectFromBox({
    left: normalized.left - padding,
    top: normalized.top - padding,
    right: normalized.right + padding,
    bottom: normalized.bottom + padding,
  });
}

function rectsIntersect(leftRect, rightRect) {
  const left = rectFromBox(leftRect);
  const right = rectFromBox(rightRect);
  if (!left || !right) return false;
  return !(
    left.right <= right.left ||
    left.left >= right.right ||
    left.bottom <= right.top ||
    left.top >= right.bottom
  );
}

function visibleElement(element) {
  if (!element || !element.isConnected || !document.documentElement.contains(element)) return false;
  if (element.hidden || element.getAttribute?.("aria-hidden") === "true" || element.classList?.contains("hidden")) return false;
  for (let node = element; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement) {
    if (node.hidden || node.getAttribute?.("aria-hidden") === "true" || node.classList?.contains("hidden")) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  }
  const rects = Array.from(element.getClientRects()).filter((rect) => rect.width >= 4 && rect.height >= 4);
  if (!rects.length) return false;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0;
  const top = viewport?.offsetTop || 0;
  const right = left + (viewport?.width || window.innerWidth);
  const bottom = top + (viewport?.height || window.innerHeight);
  return rects.some((rect) => rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom);
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

function findInlineWrapperInRange(range, selector) {
  if (!range) return null;
  const ancestor = closestInlineTag(range, selector);
  if (ancestor && ancestor.textContent === range.toString()) return ancestor;
  const common = range.commonAncestorContainer;
  if (common?.nodeType === Node.ELEMENT_NODE) {
    const matchingChildren = Array.from(common.children).filter((el) => el.matches?.(selector));
    if (matchingChildren.length === 1 && matchingChildren[0].textContent === range.toString()) {
      return matchingChildren[0];
    }
  }
  return null;
}

function unwrapInlineElement(element) {
  const parent = element?.parentNode;
  if (!parent) return false;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
  parent.normalize?.();
  return true;
}

function unwrapAllInlineInRange(range, selector) {
  if (!range) return false;
  let changed = false;
  const common = range.commonAncestorContainer;
  const root = common?.nodeType === Node.ELEMENT_NODE ? common : common?.parentElement;
  if (!root) return false;
  const candidates = Array.from(root.querySelectorAll(selector));
  candidates.forEach((el) => {
    if (!range.intersectsNode || !range.intersectsNode(el)) {
      if (!intersectsRangeFallback(range, el)) return;
    }
    changed = unwrapInlineElement(el) || changed;
  });
  return changed;
}

function intersectsRangeFallback(range, el) {
  const elRange = document.createRange();
  elRange.selectNode(el);
  return range.compareBoundaryPoints(Range.START_TO_END, elRange) > 0 &&
    range.compareBoundaryPoints(Range.END_TO_START, elRange) < 0;
}

function toggleInlineElement(range, selector, tagName, attributes = {}) {
  const existing = closestInlineTag(range, selector);
  if (existing && existing.textContent === range.toString()) {
    return unwrapInlineElement(existing) ? range.cloneRange() : null;
  }
  return wrapRangeWithElement(range, tagName, attributes);
}

export class TCloudInlineToolbarController {
  constructor(adapter) {
    this.adapter = adapter;
    this.root = holderElement(adapter.holder);
    this.savedRange = null;
    this.closedSelectionSignature = null;
    this.submenu = null;
    this.lastReason = "";
    this.selectionFrame = null;
    this.pendingPointerSelectionFrame = null;
    this.pointerSelectionRange = null;
    this.isExternalEditorMenuActive = false;
    this.isPointerSelecting = false;
    this.isDragSelecting = false;
    this.isExecutingCommand = false;
    this.lastPointerActionAt = 0;
    this.lastExternalMenuInteractionAt = 0;
    this.lastPointerDownAt = 0;
    this.pendingSelectionReason = "";
    this.toolbar = this.buildToolbar();
    this.onSelectionChange = () => this.scheduleSelectionSync("selectionchange");
    this.onPointerDown = (event) => this.handlePointerDown(event);
    this.onPointerUp = () => this.handlePointerUp();
    this.onPointerCancel = () => this.handlePointerUp("pointercancel-selection");
    this.onEditorPopoverOpen = () => this.setExternalEditorMenuOpen(true, "editor-popover");
    this.onEditorPopoverClose = () => this.setExternalEditorMenuOpen(false, "editor-popover");
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
      if (this.isPointerSelecting) return;
      if (this.isExecutingCommand) return;
      if (!this.toolbar.classList.contains("is-open")) return;
      const range = this.savedRange;
      if (!range || !this.updateToolbarPosition(range)) this.hideInlineToolbar("viewport-change");
      else this.positionSubmenu();
    };

    document.body.appendChild(this.toolbar);
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("pointerup", this.onPointerUp, true);
    document.addEventListener("pointercancel", this.onPointerCancel, true);
    document.addEventListener("input", this.onInput, true);
    document.addEventListener("focusin", this.onFocusIn, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("tcloud-editor-popover-open", this.onEditorPopoverOpen);
    document.addEventListener("tcloud-editor-popover-close", this.onEditorPopoverClose);
    window.addEventListener("resize", this.onViewportChange, { passive: true });
    window.addEventListener("scroll", this.onViewportChange, true);
    window.visualViewport?.addEventListener("resize", this.onViewportChange, { passive: true });
    window.visualViewport?.addEventListener("scroll", this.onViewportChange, { passive: true });
    this.installPopoverDelegation();
    this.hideNativeInlineToolbar();
  }

  destroy() {
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("pointerup", this.onPointerUp, true);
    document.removeEventListener("pointercancel", this.onPointerCancel, true);
    document.removeEventListener("input", this.onInput, true);
    document.removeEventListener("focusin", this.onFocusIn, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("tcloud-editor-popover-open", this.onEditorPopoverOpen);
    document.removeEventListener("tcloud-editor-popover-close", this.onEditorPopoverClose);
    window.removeEventListener("resize", this.onViewportChange);
    window.removeEventListener("scroll", this.onViewportChange, true);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
    window.visualViewport?.removeEventListener("scroll", this.onViewportChange);
    if (this.popoverDelegationInstalled && this.popoverDelegateClick) {
      document.removeEventListener("click", this.popoverDelegateClick, true);
      this.popoverDelegationInstalled = false;
      this.popoverDelegateClick = null;
    }
    if (this.selectionFrame) cancelAnimationFrame(this.selectionFrame);
    if (this.pendingPointerSelectionFrame) cancelAnimationFrame(this.pendingPointerSelectionFrame);
    this.isExecutingCommand = false;
    this.closeAllInlineSubmenus();
    this.toolbar.remove();
  }

  installPopoverDelegation() {
    if (this.popoverDelegationInstalled) return;
    this.popoverDelegationInstalled = true;

    // Mapeamento data-item-name → ação do tune (Editor.js v2.31.6)
    const TUNE_NAMES = new Set(["move-up", "move-down", "delete"]);
    // Mapeamento data-name → tipo de conversão (submenu "Converter para")
    // O vendor popula data-item-name com o nome da tool (header, list, todo, etc.)
    const CONVERSION_NAMES = new Set([
      "paragraph", "header", "list", "todo", "quote", "codeBlock", "divider",
      "tcloudFile", "tcloudImage", "tcloudVideo", "tcloudAudio", "tcloudPdf", "tcloudFolder",
    ]);

    this.popoverDelegateClick = (event) => {
      // Editor.js v2.31 usa .ce-popover-item para TODOS os items (tunes e conversões)
      const item = event.target?.closest?.(".ce-popover-item");
      if (!item) return;

      const dataName = item.dataset?.itemName || item.dataset?.name || "";
      const title = (item.querySelector?.(".ce-popover-item__title")?.textContent || item.textContent || "").trim();

      // 1) Tune "delete" com confirmação de 2 cliques
      //    Vendor mostra "Clique para excluir" no 2º clique. Só disparamos no estado confirmado.
      if (dataName === "delete" || title === "Excluir") {
        const isConfirming = item.classList.contains("ce-popover-item--confirmation")
          || title === "Clique para excluir"
          || item.getAttribute("data-confirmed") === "true";
        if (!isConfirming) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.adapter.runBlockTune?.("delete", { preferredRange: this.savedRange })
          ?.catch((error) => console.warn("[TCloud Notes] runBlockTune delete falhou", error));
        return;
      }

      // 2) Tunes move-up / move-down (sem confirmação)
      if (dataName === "move-up" || title === "Mover para cima") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.adapter.runBlockTune?.("moveUp", { preferredRange: this.savedRange })
          ?.catch((error) => console.warn("[TCloud Notes] runBlockTune moveUp falhou", error));
        return;
      }
      if (dataName === "move-down" || title === "Mover para baixo") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.adapter.runBlockTune?.("moveDown", { preferredRange: this.savedRange })
          ?.catch((error) => console.warn("[TCloud Notes] runBlockTune moveDown falhou", error));
        return;
      }

      // 3) Conversão (submenu "Converter para" ou toolbox) — data-item-name
      //    contém o nome da tool. Para "list"/"header" o nome é ambíguo, então
      //    derivamos style/level a partir do título localizado.
      if (CONVERSION_NAMES.has(dataName)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const range = this.savedRange;
        const { type: convType, data: convData } = resolveConversionPayload(dataName, title);
        if (this.adapter.hasMultiBlockSelection?.(range) && typeof this.adapter.convertSelectedBlocks === "function") {
          this.adapter.convertSelectedBlocks?.(convType, convData, range)
            ?.catch((error) => console.warn("[TCloud Notes] convertSelectedBlocks falhou", error));
        } else {
          this.adapter.convertCurrentBlock?.(convType, convData)
            ?.catch((error) => console.warn("[TCloud Notes] convertCurrentBlock falhou", error));
        }
        return;
      }

      // 4) Outros tunes (ex.: "convert-to" que abre submenu, future "duplicate", etc.)
      //    Deixamos o vendor agir normalmente.
      // Se não é tune nem conversão, return (vendor pode capturar).
    };

    document.addEventListener("click", this.popoverDelegateClick, true);
  }

  buildToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "tcloud-inline-toolbar tcloud-inline-toolbar--custom";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Formatação do texto selecionado");
    toolbar.setAttribute("aria-hidden", "true");
    toolbar.hidden = true;
    toolbar.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.adapter.blockSelectionController?.freeze?.("toolbar-mousedown");
    });
    toolbar.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.adapter.blockSelectionController?.freeze?.("toolbar-pointerdown");
      if (this.selectionFrame) {
        cancelAnimationFrame(this.selectionFrame);
        this.selectionFrame = null;
      }
      const target = event.target.closest("[data-tcloud-action]");
      if (target && !target.disabled) {
        this.lastPointerActionAt = performance.now();
        this.runAction(target.dataset.tcloudAction, target).catch(console.warn);
      }
    });
    toolbar.addEventListener("click", (event) => {
      const target = event.target.closest("[data-tcloud-action]");
      if (!target || target.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      if (performance.now() - this.lastPointerActionAt < 400) return;
      this.runAction(target.dataset.tcloudAction, target).catch(console.warn);
    });

    const blockGroup = document.createElement("div");
    blockGroup.className = "tcloud-inline-toolbar__group";
    const blockButton = createToolbarButton({
      action: "block-menu",
      label: "Texto",
      title: "Tipo de bloco",
      icon: '<span class="tcloud-inline-toolbar__block-label" data-tcloud-block-label>Texto</span><span class="tcloud-inline-toolbar__block-chevron" aria-hidden="true">⌄</span>',
      menu: true,
    });
    blockButton.classList.add("tcloud-inline-toolbar__block-button");
    blockGroup.appendChild(blockButton);

    const selectionCount = document.createElement("span");
    selectionCount.className = "tcloud-inline-toolbar__selection-count";
    selectionCount.dataset.tcloudSelectionCount = "true";
    selectionCount.hidden = true;
    selectionCount.setAttribute("aria-live", "polite");

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
      selectionCount,
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
    if (this.isPointerSelecting || !range || !rangeInsideEditor(range, this.root)) return false;
    if (this.isExternalEditorMenuActive) {
      if (this.externalEditorMenuOpen()) return false;
      this.clearExternalMenuState();
    }
    if (this.externalEditorMenuOpen()) return false;
    const signature = rangeSignature(range);
    return !sameRangeSignature(signature, this.closedSelectionSignature);
  }

  scheduleSelectionSync(reason = "selectionchange") {
    if (this.isExecutingCommand) return;
    this.pendingSelectionReason = reason;
    if (this.isPointerSelecting && reason !== "pointerup-selection" && reason !== "pointercancel-selection") {
      if (reason === "selectionchange") {
        this.isDragSelecting = true;
        const liveRange = this.getValidEditorSelection();
        if (liveRange) {
          this.pointerSelectionRange = liveRange.cloneRange();
          this.savedRange = liveRange.cloneRange();
        }
      }
      return;
    }
    if (this.selectionFrame) return;
    this.selectionFrame = requestAnimationFrame(() => {
      this.selectionFrame = null;
      this.syncFromSelection(this.pendingSelectionReason || reason);
    });
  }

  syncFromSelection(reason = "selectionchange") {
    if (this.isExecutingCommand) return;
    if (this.isPointerSelecting && reason !== "pointerup-selection" && reason !== "pointercancel-selection") {
      if (reason === "selectionchange") {
        this.isDragSelecting = true;
        const liveRange = this.getValidEditorSelection();
        if (liveRange) {
          this.pointerSelectionRange = liveRange.cloneRange();
          this.savedRange = liveRange.cloneRange();
        }
      }
      return;
    }
    this.hideNativeInlineToolbar();
    if (this.isExternalEditorMenuActive) {
      if (this.externalEditorMenuOpen()) {
        this.hideInlineToolbar("editor-menu");
        return;
      }
      this.clearExternalMenuState();
    }
    const range = this.getValidEditorSelection();
    if (range) {
      this.pointerSelectionRange = null;
      const signature = rangeSignature(range);
      if (!sameRangeSignature(signature, this.closedSelectionSignature)) {
        this.closedSelectionSignature = null;
      }
      if (this.shouldShowInlineToolbar(range)) this.showInlineToolbar(range);
      else if (!this.submenu) this.hideInlineToolbar(reason);
      this.isDragSelecting = false;
      return;
    }
    const fallbackRange =
      (reason === "pointerup-selection" || reason === "pointercancel-selection") &&
      rangeInsideEditor(this.pointerSelectionRange, this.root)
        ? this.pointerSelectionRange.cloneRange()
        : null;
    this.pointerSelectionRange = null;
    if (this.adapter.blockSelectionController?.hasMultiBlockSelection?.(null)) {
      this.closedSelectionSignature = null;
      if (this.showInlineToolbarForBlockSelection()) {
        this.isDragSelecting = false;
        return;
      }
    }
    if (fallbackRange && fallbackRange.toString().replace(/\u200B/g, "").trim()) {
      this.closedSelectionSignature = null;
      if (this.shouldShowInlineToolbar(fallbackRange)) {
        this.showInlineToolbar(fallbackRange);
        this.isDragSelecting = false;
        return;
      }
    }
    if (this.submenu && rangeInsideEditor(this.savedRange, this.root) && this.isToolbarTarget(document.activeElement)) {
      this.updateToolbarPosition(this.savedRange);
      this.isDragSelecting = false;
      return;
    }
    this.isDragSelecting = false;
    this.closedSelectionSignature = null;
    this.hideInlineToolbar(reason);
  }

  showInlineToolbar(range) {
    if (!rangeInsideEditor(range, this.root)) return;
    this.savedRange = range.cloneRange();
    this.adapter.blockSelectionController?.captureFromRange?.(this.savedRange, "inline-toolbar");
    this.toolbar.hidden = false;
    this.toolbar.classList.add("is-open");
    this.toolbar.setAttribute("aria-hidden", "false");
    this.updateToolbarState();
    if (!this.updateToolbarPosition(this.savedRange)) {
      this.hideInlineToolbar("position-failed");
    }
  }

  buildRangeFromSelectedBlocks(indexes, blocks) {
    if (!indexes?.length || !blocks?.length) return null;
    const first = blocks[indexes[0]];
    const last = blocks[indexes[indexes.length - 1]];
    if (!first || !last) return null;
    const firstHost = first.querySelector("[contenteditable='true']") || first;
    const lastHost = last.querySelector("[contenteditable='true']") || last;
    const startNode = firstHost.firstChild || firstHost;
    const endNode = lastHost.lastChild || lastHost;
    try {
      const range = document.createRange();
      range.setStart(startNode, 0);
      const endOffset = endNode.nodeType === Node.TEXT_NODE
        ? (endNode.textContent || "").length
        : (endNode.childNodes?.length || 0);
      range.setEnd(endNode, endOffset);
      return range;
    } catch (error) {
      return null;
    }
  }

  showInlineToolbarForBlockSelection({ skipCapture = false } = {}) {
    const ctrl = this.adapter.blockSelectionController;
    if (!ctrl) return false;
    if (!skipCapture) ctrl.captureFromCurrentSelection?.("inline-toolbar");
    const indexes = ctrl.getSelectedIndexes?.(null);
    if (!indexes || indexes.length <= 1) return false;
    const blocks = ctrl.blocks?.() || [];
    const syntheticRange = this.buildRangeFromSelectedBlocks(indexes, blocks);
    const blockRects = indexes.map((index) => rectFromBox(blocks[index]?.getBoundingClientRect?.())).filter(Boolean);
    const anchorRect = unionRects(blockRects) ||
      (syntheticRange && rangeSelectionRect(syntheticRange));
    if (!anchorRect) return false;
    const signature = rangeSignature(syntheticRange) || { blockIndexes: indexes.slice() };
    if (sameRangeSignature(signature, this.closedSelectionSignature)) return false;
    this.closedSelectionSignature = null;
    this.savedRange = syntheticRange;
    if (syntheticRange && !skipCapture) ctrl.captureFromRange?.(syntheticRange, "inline-toolbar");
    this.pointerSelectionRange = null;
    this.toolbar.hidden = false;
    this.toolbar.classList.add("is-open");
    this.toolbar.setAttribute("aria-hidden", "false");
    this.updateToolbarState();
    if (!this.updateToolbarPosition(this.savedRange, anchorRect)) {
      this.hideInlineToolbar("position-failed");
      return false;
    }
    return true;
  }

  hideInlineToolbar(reason = "manual", { suppressSelection = false, clearSelection = false } = {}) {
    const preserveClosedSelectionSignature =
      suppressSelection &&
      !clearSelection &&
      reason !== "pointerdown-selection";
    if (preserveClosedSelectionSignature) {
      const range = this.savedRange || this.getValidEditorSelection();
      this.closedSelectionSignature = rangeSignature(range);
    }
    this.lastReason = reason;
    this.closeAllInlineSubmenus();
    this.toolbar.classList.remove("is-open");
    this.toolbar.hidden = true;
    this.toolbar.setAttribute("aria-hidden", "true");
    this.toolbar.querySelectorAll("[aria-expanded='true']").forEach((button) => button.setAttribute("aria-expanded", "false"));
    if (clearSelection) {
      window.getSelection()?.removeAllRanges();
      this.adapter.blockSelectionController?.clearSnapshot?.(reason);
    }
    if (!suppressSelection || clearSelection) this.savedRange = null;
    this.hideNativeInlineToolbar();
    this.isExecutingCommand = false;
  }

  prepareCommandExecution(reason = "toolbar-command") {
    this.isExecutingCommand = true;
    if (this.savedRange) {
      this.adapter.blockSelectionController?.captureFromRange?.(this.savedRange, reason);
    }
    this.adapter.blockSelectionController?.freeze?.(reason);
    // Stash the current selection indexes so refreshAfterBatchAction can
    // restore them even after render() clears the snapshot.
    const ctrl = this.adapter.blockSelectionController;
    this.stashedSelectionIndexes = ctrl
      ? ctrl.normalizeIndexes(ctrl.selectionSnapshot.indexes)
      : [];
    // Tell the native popover controller to ignore the corrective micro-scroll
    // that follows batch formatting (prevents the editor menu from jumping).
    this.adapter.popoverController?.markBatchAction?.(true);
  }

  refreshAfterBatchAction(reason = "post-action", overrideIndexes = null) {
    this.isExecutingCommand = false;
    const ctrl = this.adapter.blockSelectionController;
    if (!ctrl) {
      this.hideInlineToolbar(reason);
      return;
    }
    const indexes = ctrl.normalizeIndexes(overrideIndexes || this.stashedSelectionIndexes || ctrl.selectionSnapshot.indexes);
    this.stashedSelectionIndexes = null;
    if (indexes.length <= 1) {
      this.hideInlineToolbar(`${reason}-single`, { suppressSelection: true });
      return;
    }

    const savedScrollTop = this.root?.scrollTop;
    const savedWindowScrollY = window.scrollY;

    // Rebuild the DOM selection range across the selected blocks so
    // anchor rect calculations use valid geometry instead of stale/zero rects
    const blocks = ctrl.blocks?.() || [];
    const firstBlock = blocks[indexes[0]];
    const lastBlock = blocks[indexes[indexes.length - 1]];
    let rebuiltRange = null;
    if (firstBlock && lastBlock) {
      try {
        rebuiltRange = document.createRange();
        rebuiltRange.setStartBefore(firstBlock);
        rebuiltRange.setEndAfter(lastBlock);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(rebuiltRange);
      } catch (rangeError) {
        rebuiltRange = null;
      }
    }

    // Re-capture by indexes (IDs may have changed after conversion/render)
    ctrl.captureFromIndexes(indexes, reason, rebuiltRange);
    ctrl.freeze(reason);
    // Reset closedSelectionSignature so the toolbar can re-open for the same blocks
    this.closedSelectionSignature = null;

    // Restore editor focus to the last selected block's editable area
    // without collapsing the multi-block selection
    const focusTarget = lastBlock?.querySelector("[contenteditable='true']");
    if (focusTarget && typeof focusTarget.focus === "function") {
      focusTarget.focus({ preventScroll: true });
    }

    // Re-show toolbar anchored to the still-selected blocks (skip re-capture;
    // we already set the snapshot above with fresh IDs after conversion)
    if (!this.showInlineToolbarForBlockSelection({ skipCapture: true })) {
      this.hideInlineToolbar(`${reason}-position`, { suppressSelection: true });
    }

    // Restore scroll synchronously and via double-rAF to guarantee
    // preservation even after deferred layout recalcs from render().
    const restoreScroll = () => {
      if (this.root && savedScrollTop !== undefined) {
        this.root.scrollTop = savedScrollTop;
      }
      if (savedWindowScrollY !== undefined) {
        window.scrollTo(0, savedWindowScrollY);
      }
    };
    restoreScroll();
    requestAnimationFrame(() => {
      restoreScroll();
      requestAnimationFrame(restoreScroll);
    });

    // Batch action finished: release the viewport-change suppression so the
    // native editor popover can re-anchor on real user scrolls again.
    this.adapter.popoverController?.markBatchAction?.(false);
  }

  setExternalEditorMenuOpen(isOpen, reason = "external-menu") {
    if (isOpen) {
      this.isExternalEditorMenuActive = true;
      this.lastExternalMenuInteractionAt = performance.now();
      this.closedSelectionSignature = null;
      this.hideInlineToolbar(reason, { suppressSelection: true });
      return;
    }
    if (!this.isExternalEditorMenuActive) return;
    this.isExternalEditorMenuActive = false;
    this.lastExternalMenuInteractionAt = 0;
    this.closedSelectionSignature = null;
    if (["editor-menu", "external-menu", "editor-popover"].includes(this.lastReason)) this.lastReason = "";
  }

  clearExternalMenuState() {
    this.setExternalEditorMenuOpen(false, "external-menu");
  }

  selectedBlockRects(range) {
    if (!this.root) return [];
    return Array.from(
      this.root.querySelectorAll(".ce-block--selected, .ce-block.is-tcloud-range-selected"),
    )
      .filter((block) => (range
        ? rangeIntersectsElement(range, block)
        : (block.classList.contains("ce-block--selected") || block.classList.contains("is-tcloud-range-selected"))))
      .map((block) => rectFromBox(block.getBoundingClientRect()))
      .filter(Boolean);
  }

  selectionAvoidanceRect(range, anchorRect) {
    const blockRects = this.selectedBlockRects(range);
    if (blockRects.length <= 1) return anchorRect;
    return unionRects([anchorRect, ...blockRects]) || anchorRect;
  }

  selectionSpansMultipleBlocks(range, anchorRect) {
    if (!anchorRect) return false;
    const blockRects = this.selectedBlockRects(range);
    if (blockRects.length > 1) return true;
    if (!range) return anchorRect.height > 48;
    try {
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
      if (rects.length > 1) return true;
    } catch (error) {
      // Ignore selection rect read errors and fall back to the merged selection bounds.
    }
    return anchorRect.height > 48;
  }

  viewportBounds() {
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    return rectFromBox({
      left,
      top,
      right: left + width,
      bottom: top + height,
    });
  }

  normalizeToolbarCandidate(candidate, width, height, viewportRect) {
    if (!candidate || !viewportRect) return null;
    const minLeft = viewportRect.left + INLINE_TOOLBAR_MARGIN;
    const maxLeft = Math.max(minLeft, viewportRect.right - INLINE_TOOLBAR_MARGIN - width);
    const minTop = viewportRect.top + INLINE_TOOLBAR_MARGIN;
    const maxTop = Math.max(minTop, viewportRect.bottom - INLINE_TOOLBAR_MARGIN - height);
    const left = clampNumber(candidate.left, minLeft, maxLeft);
    const top = clampNumber(candidate.top, minTop, maxTop);
    return {
      placement: candidate.placement,
      rect: rectFromBox({
        left,
        top,
        right: left + width,
        bottom: top + height,
      }),
    };
  }

  toolbarPlacementCandidates(range, avoidanceRect, width, height, viewportRect, gap = INLINE_TOOLBAR_GAP) {
    const centerLeft = avoidanceRect.left + (avoidanceRect.width - width) / 2;
    const middleTop = avoidanceRect.top + (avoidanceRect.height - height) / 2;
    const candidates = [
      {
        placement: "top",
        left: centerLeft,
        top: avoidanceRect.top - height - gap,
      },
      {
        placement: "bottom",
        left: centerLeft,
        top: avoidanceRect.bottom + gap,
      },
    ];

    if (this.selectionSpansMultipleBlocks(range, avoidanceRect)) {
      candidates.push(
        {
          placement: "right",
          left: avoidanceRect.right + gap,
          top: middleTop,
        },
        {
          placement: "left",
          left: avoidanceRect.left - width - gap,
          top: middleTop,
        },
      );
    }

    const floatingTop = viewportRect.top + INLINE_TOOLBAR_MARGIN;
    candidates.push(
      { placement: "floating", left: viewportRect.left + INLINE_TOOLBAR_MARGIN, top: floatingTop },
      { placement: "floating", left: centerLeft, top: floatingTop },
      { placement: "floating", left: viewportRect.right - width - INLINE_TOOLBAR_MARGIN, top: floatingTop },
      { placement: "floating", left: viewportRect.left + INLINE_TOOLBAR_MARGIN, top: viewportRect.bottom - height - INLINE_TOOLBAR_MARGIN },
      { placement: "floating", left: viewportRect.right - width - INLINE_TOOLBAR_MARGIN, top: viewportRect.bottom - height - INLINE_TOOLBAR_MARGIN },
    );

    return candidates
      .map((candidate) => this.normalizeToolbarCandidate(candidate, width, height, viewportRect))
      .filter(Boolean);
  }

  updateToolbarPosition(range, explicitAnchorRect = null) {
    if (this.isExecutingCommand) return false;
    if (!this.toolbar.classList.contains("is-open")) return false;
    const explicit = rectFromBox(explicitAnchorRect);
    if (!range && !explicit) return false;
    if (explicit && !this.root) return false;
    if (range && !rangeInsideEditor(range, this.root) && !explicit) return false;
    if (range && range.collapsed && !explicit) return false;
    const anchor = explicit || rangeSelectionRect(range);
    if (!anchor) return false;
    // Guard clause: reject zero-area anchor rects (indicates lost selection / blur)
    if (anchor.width === 0 && anchor.height === 0) {
      this.toolbar.hidden = true;
      return false;
    }
    // Guard clause: reject anchor rects at exact origin (0,0) with no meaningful area
    if (anchor.left === 0 && anchor.top === 0 && anchor.right === 0 && anchor.bottom === 0) {
      this.toolbar.hidden = true;
      return false;
    }
    const viewportRect = this.viewportBounds();
    if (!viewportRect) return false;
    const usesBlockAvoidance = (explicit ? true : this.selectedBlockRects(range).length > 1);
    const avoidanceRect = expandRect(explicit || this.selectionAvoidanceRect(range, anchor), usesBlockAvoidance ? 6 : 0) || anchor;
    const toolbarGap = usesBlockAvoidance ? INLINE_TOOLBAR_GAP : 4;

    this.toolbar.style.visibility = "hidden";
    this.toolbar.hidden = false;
    const toolbarRect = this.toolbar.getBoundingClientRect();
    const width = Math.min(
      toolbarRect.width || 1,
      Math.max(1, viewportRect.width - INLINE_TOOLBAR_MARGIN * 2),
    );
    const height = toolbarRect.height || 44;
    const placement = this.toolbarPlacementCandidates(range, avoidanceRect, width, height, viewportRect, toolbarGap)
      .find((candidate) => !rectsIntersect(candidate.rect, avoidanceRect));
    if (!placement?.rect) {
      this.toolbar.style.visibility = "";
      this.toolbar.hidden = true;
      return false;
    }

    this.toolbar.style.left = `${Math.round(placement.rect.left)}px`;
    this.toolbar.style.top = `${Math.round(placement.rect.top)}px`;
    this.toolbar.dataset.placement = placement.placement;
    this.toolbar.style.visibility = "";
    return true;
  }

  handlePointerDown(event) {
    const target = event.target;
    if (this.isToolbarTarget(target)) return;
    // Whitelist: alvos internos do popover (tunes, conversão) não devem fechar
    // a barra inline nem disparar o fluxo de "pointer-outside". Sem isso, o
    // `EditorJsPopoverController` porta os popovers para `document.body` e o
    // capture global deste listener consome o clique antes do `onActivate` do
    // vendor rodar, quebrando Mover/Excluir/Converter.
    if (target?.closest?.(PROTECTED_POPOVER_TARGETS)) {
      this.pointerSelectionRange = null;
      this.setExternalEditorMenuOpen(true, "popover-item");
      return;
    }
    this.closeAllInlineSubmenus();
    if (target?.closest?.(".ce-toolbar__plus, .ce-toolbar__settings-btn")) {
      this.pointerSelectionRange = null;
      this.setExternalEditorMenuOpen(true, "external-menu");
      return;
    }
    if (this.isEditorTarget(target)) {
      this.isPointerSelecting = true;
      this.isDragSelecting = false;
      this.pointerSelectionRange = null;
      this.lastPointerDownAt = performance.now();
      if (this.selectionFrame) {
        cancelAnimationFrame(this.selectionFrame);
        this.selectionFrame = null;
      }
      if (this.pendingPointerSelectionFrame) {
        cancelAnimationFrame(this.pendingPointerSelectionFrame);
        this.pendingPointerSelectionFrame = null;
      }
      this.hideInlineToolbar("pointerdown-selection", { suppressSelection: true });
      return;
    }
    this.pointerSelectionRange = null;
    this.hideInlineToolbar("pointer-outside");
  }

  handlePointerUp(reason = "pointerup-selection") {
    if (!this.isPointerSelecting) return;
    this.isPointerSelecting = false;
    this.isDragSelecting = false;
    if (this.pendingPointerSelectionFrame) cancelAnimationFrame(this.pendingPointerSelectionFrame);
    this.pendingPointerSelectionFrame = requestAnimationFrame(() => {
      this.pendingPointerSelectionFrame = requestAnimationFrame(() => {
        this.pendingPointerSelectionFrame = null;
        this.scheduleSelectionSync(reason);
      });
    });
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
    if (event.key === ":" || event.key === "/") {
      this.hideInlineToolbar(event.key === ":" ? "colon-key" : "slash-key", { suppressSelection: true });
      return;
    }

    const isCmdOrCtrl = event.metaKey || event.ctrlKey;
    if (!this.isEditorTarget(event.target) && !rangeInsideEditor(this.savedRange, this.root)) return;
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      this.adapter.changeSelectedBlocksIndent(event.shiftKey ? -1 : 1, this.savedRange).catch(console.warn);
      this.hideInlineToolbar("indent-shortcut", { suppressSelection: true });
      return;
    }
    if (isCmdOrCtrl && (event.key === "]" || event.key === "[")) {
      event.preventDefault();
      event.stopPropagation();
      this.adapter.changeSelectedBlocksIndent(event.key === "]" ? 1 : -1, this.savedRange).catch(console.warn);
      this.hideInlineToolbar("indent-shortcut", { suppressSelection: true });
    }
  }

  async runAction(action, target) {
    if (!action) return;
    this.prepareCommandExecution(`action:${action}`);
    if (action === "block-menu") {
      this.openBlockMenu(target);
      return;
    }
    if (action === "more") {
      this.openMoreMenu(target);
      return;
    }
    if (action === "text-color") {
      this.openColorMenu(target, "text");
      return;
    }
    if (action === "highlight-color") {
      this.openColorMenu(target, "background");
      return;
    }
    if (action.startsWith("color:")) {
      const [, mode, value = ""] = action.split(":");
      await this.applyColor(mode, value);
      return;
    }

    if (action.startsWith("block:")) {
      const [, type, variant] = action.split(":");
      if (this.adapter.hasMultiBlockSelection(this.savedRange)) {
        await this.adapter.convertSelectedBlocks(type, {
          level: Number(variant || 2),
          style: variant || "unordered",
        }, this.savedRange);
        this.refreshAfterBatchAction("block-convert");
        return;
      }
      if (!restoreRange(this.savedRange, this.root)) {
        this.hideInlineToolbar("invalid-range");
        return;
      }
      await this.adapter.convertCurrentBlock(type, {
        level: Number(variant || 2),
        style: variant || "unordered",
      });
      this.hideInlineToolbar("block-convert", { suppressSelection: true });
      return;
    }

    const batchInlineActions = new Set(["bold", "italic", "underline", "strike", "inline-code", "clear"]);
    if (batchInlineActions.has(action) && this.adapter.hasMultiBlockSelection(this.savedRange)) {
      await this.adapter.applyInlineActionToSelectedBlocks(action, this.savedRange);
      this.refreshAfterBatchAction(action);
      return;
    }

    if ((action === "indent" || action === "outdent") && this.adapter.hasMultiBlockSelection(this.savedRange)) {
      await this.adapter.changeSelectedBlocksIndent(action === "indent" ? 1 : -1, this.savedRange);
      this.refreshAfterBatchAction(action);
      return;
    }

    if (!restoreRange(this.savedRange, this.root)) {
      this.hideInlineToolbar("invalid-range");
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
      await this.adapter.changeSelectedBlocksIndent(1, this.savedRange);
      if (this.adapter.hasMultiBlockSelection(this.savedRange)) this.refreshAfterBatchAction("indent");
      else this.hideInlineToolbar("indent", { suppressSelection: true });
      return;
    }
    if (action === "outdent") {
      await this.adapter.changeSelectedBlocksIndent(-1, this.savedRange);
      if (this.adapter.hasMultiBlockSelection(this.savedRange)) this.refreshAfterBatchAction("outdent");
      else this.hideInlineToolbar("outdent", { suppressSelection: true });
      return;
    }
    if (action === "clear") changed = document.execCommand("removeFormat");
    if (action === "copy") {
      const text = this.adapter.hasMultiBlockSelection(this.savedRange)
        ? this.adapter.getSelectedBlocksPlainText(this.savedRange)
        : window.getSelection()?.toString() || this.savedRange.toString() || "";
      await navigator.clipboard?.writeText?.(text);
      this.refreshAfterBatchAction("copy");
      return;
    }
    if (action === "duplicate-blocks") {
      await this.adapter.duplicateSelectedBlocks(this.savedRange);
      this.refreshAfterBatchAction("duplicate-blocks");
      return;
    }
    if (action === "delete-blocks") {
      await this.adapter.deleteSelectedBlocks(this.savedRange);
      this.hideInlineToolbar("delete-blocks", { suppressSelection: true, clearSelection: true });
      return;
    }

    if (changed) await this.adapter.notifyManualChange();
    if (this.adapter.hasMultiBlockSelection(this.savedRange)) {
      this.refreshAfterBatchAction(action);
    } else {
      this.hideInlineToolbar(action, { suppressSelection: true, clearSelection: false });
      if (this.savedRange) {
        restoreRange(this.savedRange, this.root);
      }
    }
  }

  async applyColor(mode, value) {
    if (this.adapter.hasMultiBlockSelection(this.savedRange)) {
      await this.adapter.applyColorToSelectedBlocks(mode, value, this.savedRange);
      this.refreshAfterBatchAction("color");
      return;
    }
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
    this.hideInlineToolbar("color", { suppressSelection: true, clearSelection: false });
    if (this.savedRange) {
      restoreRange(this.savedRange, this.root);
    }
  }

  openSubmenu(anchor, menu) {
    this.prepareCommandExecution(`open-menu:${menu.dataset.menuType || "submenu"}`);
    const wasSame = this.submenu?.dataset.menuType === menu.dataset.menuType;
    this.closeAllInlineSubmenus();
    if (wasSame) {
      this.isExecutingCommand = false;
      return;
    }
    this.submenu = menu;
    this.submenu.addEventListener("mousedown", (event) => {
      if (!event.target.matches?.("input")) event.preventDefault();
      event.stopPropagation();
      this.adapter.blockSelectionController?.freeze?.("submenu-mousedown");
    });
    this.submenu.addEventListener("pointerdown", (event) => {
      if (!event.target.matches?.("input")) event.preventDefault();
      event.stopPropagation();
      this.adapter.blockSelectionController?.freeze?.("submenu-pointerdown");
      if (this.selectionFrame) {
        cancelAnimationFrame(this.selectionFrame);
        this.selectionFrame = null;
      }
      const target = event.target.closest("[data-tcloud-action]");
      if (target && !target.disabled) {
        this.lastPointerActionAt = performance.now();
        this.runAction(target.dataset.tcloudAction, target).catch(console.warn);
      }
    });
    this.submenu.addEventListener("click", (event) => {
      const target = event.target.closest("[data-tcloud-action]");
      if (!target || target.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      if (performance.now() - this.lastPointerActionAt < 400) return;
      this.runAction(target.dataset.tcloudAction, target).catch(console.warn);
    });
    document.body.appendChild(this.submenu);
    this.activeAnchor = anchor;
    anchor?.setAttribute("aria-expanded", "true");
    this.positionSubmenu();
    this.isExecutingCommand = false;
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
    const actions = [
      ["copy", "Copiar seleção", '<i class="ph ph-copy" aria-hidden="true"></i>'],
      ["clear", "Limpar formatação", '<i class="ph ph-eraser" aria-hidden="true"></i>'],
    ];
    if (this.adapter.hasMultiBlockSelection(this.savedRange)) {
      actions.push(
        ["duplicate-blocks", "Duplicar blocos", '<i class="ph ph-copy-simple" aria-hidden="true"></i>'],
        ["delete-blocks", "Excluir blocos", '<i class="ph ph-trash" aria-hidden="true"></i>'],
      );
    }
    actions.forEach(([action, label, icon]) => menu.appendChild(createMenuButton({ action, label, icon })));
    this.openSubmenu(anchor, menu);
  }

  openColorMenu(anchor, mode) {
    const menu = document.createElement("div");
    menu.className = "tcloud-inline-toolbar__menu tcloud-inline-toolbar__color-menu";
    menu.dataset.menuType = `color-${mode}`;
    menu.dataset.colorMode = mode;
    menu.setAttribute("role", "menu");
    const state = rangeInsideEditor(this.savedRange, this.root) ? getSelectedInlineState(this.savedRange) : { color: "", backgroundColor: "" };

    const title = document.createElement("div");
    title.className = "tcloud-inline-toolbar__menu-title";
    title.textContent = mode === "background" ? "Marca-texto" : "Cores";
    menu.appendChild(title);
    if (mode === "text") {
      menu.appendChild(this.colorSection("Cor do texto", "text", INLINE_COLOR_PRESETS.text, state.color));
    } else {
      menu.appendChild(this.colorSection("Marca-texto", "background", INLINE_COLOR_PRESETS.background, state.backgroundColor));
    }
    menu.appendChild(this.customColorSection(mode));
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

  customColorSection(mode = "text") {
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
    const error = document.createElement("span");
    error.className = "tcloud-inline-toolbar__color-error hidden";
    error.dataset.tcloudColorError = "true";
    error.textContent = "HEX inválido";

    visual.addEventListener("input", () => {
      input.value = normalizeHex(visual.value) || visual.value;
      input.classList.remove("is-invalid");
      error.classList.add("hidden");
    });
    visual.addEventListener("change", () => {
      const normalized = normalizeHex(visual.value);
      if (normalized) this.applyColor(mode, normalized).catch(console.warn);
    });
    input.addEventListener("input", () => {
      const normalized = normalizeHex(input.value);
      input.classList.toggle("is-invalid", Boolean(input.value.trim()) && !normalized);
      error.classList.toggle("hidden", Boolean(normalized) || !input.value.trim());
      if (normalized) {
        visual.value = normalized;
        this.applyColor(mode, normalized).catch(console.warn);
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeAllInlineSubmenus();
        this.toolbar.focus?.();
      }
    });
    row.append(visual, input);
    section.append(label, row, error);
    return section;
  }

  externalEditorMenuOpen() {
    return this.isExternalEditorMenuActive;
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
    const summary = this.adapter.getSelectionSummary(range);
    const isMultiBlock = summary.hasMultiple;
    const blockIndex = this.adapter.blockIndexFromRange(range);
    const block = this.adapter.lastSavedContent?.blocks?.[blockIndex];
    const selectedBlocks = summary.indexes
      .map((index) => this.adapter.lastSavedContent?.blocks?.[index])
      .filter(Boolean);
    const canOutdent = isMultiBlock
      ? selectedBlocks.some((selectedBlock) => clampIndentLevel(selectedBlock?.data?.tcloudIndent?.level) > 0)
      : this.adapter.currentIndentLevelSync(range) > 0 || block?.type === "list";
    const inlineState = !isMultiBlock && rangeInsideEditor(range, this.root) ? getSelectedInlineState(range) : { color: "", backgroundColor: "" };
    const activeLink = !isMultiBlock && Boolean(closestInlineTag(range, "a"));
    const activeCode = !isMultiBlock && Boolean(closestInlineTag(range, "code"));
    const boldState = isMultiBlock ? this.adapter.getMultiBlockFormatState(range, "strong,b") : (Boolean(closestInlineTag(range, "strong,b")) ? "all" : "none");
    const italicState = isMultiBlock ? this.adapter.getMultiBlockFormatState(range, "em,i") : (Boolean(closestInlineTag(range, "em,i")) ? "all" : "none");
    const underlineState = isMultiBlock ? this.adapter.getMultiBlockFormatState(range, "u") : (Boolean(closestInlineTag(range, "u")) ? "all" : "none");
    const strikeState = isMultiBlock ? this.adapter.getMultiBlockFormatState(range, "s,strike") : (Boolean(closestInlineTag(range, "s,strike")) ? "all" : "none");
    const codeState = isMultiBlock ? this.adapter.getMultiBlockFormatState(range, "code") : (activeCode ? "all" : "none");
    const states = {
      bold: boldState === "all",
      italic: italicState === "all",
      underline: underlineState === "all",
      strike: strikeState === "all",
      "inline-code": codeState === "all",
      link: activeLink,
      "text-color": Boolean(inlineState.color),
      "highlight-color": Boolean(inlineState.backgroundColor),
    };
    const partialStates = {
      bold: boldState === "partial",
      italic: italicState === "partial",
      underline: underlineState === "partial",
      strike: strikeState === "partial",
      "inline-code": codeState === "partial",
    };
    Object.entries(states).forEach(([action, active]) => {
      const button = this.toolbar.querySelector(`[data-tcloud-action="${action}"]`);
      button?.classList.toggle("is-active", Boolean(active));
      button?.setAttribute("aria-pressed", active ? "true" : "false");
    });
    Object.entries(partialStates).forEach(([action, partial]) => {
      const button = this.toolbar.querySelector(`[data-tcloud-action="${action}"]`);
      button?.classList.toggle("is-partial", Boolean(partial));
    });
    const unlink = this.toolbar.querySelector('[data-tcloud-action="unlink"]');
    if (unlink) {
      unlink.disabled = !activeLink;
      unlink.setAttribute("aria-disabled", activeLink ? "false" : "true");
    }
    const link = this.toolbar.querySelector('[data-tcloud-action="link"]');
    if (link) {
      link.disabled = isMultiBlock;
      link.setAttribute("aria-disabled", isMultiBlock ? "true" : "false");
    }
    const outdent = this.toolbar.querySelector('[data-tcloud-action="outdent"]');
    if (outdent) {
      outdent.disabled = !canOutdent;
      outdent.setAttribute("aria-disabled", canOutdent ? "false" : "true");
    }
    const hasTextCompatibleBlocks = !isMultiBlock || summary.textCompatibleCount > 0;
    ["bold", "italic", "underline", "strike", "inline-code", "clear", "text-color", "highlight-color"].forEach((action) => {
      const button = this.toolbar.querySelector(`[data-tcloud-action="${action}"]`);
      if (!button) return;
      button.disabled = !hasTextCompatibleBlocks;
      button.setAttribute("aria-disabled", hasTextCompatibleBlocks ? "false" : "true");
    });
    const blockButton = this.toolbar.querySelector('[data-tcloud-action="block-menu"]');
    if (blockButton) {
      const canConvert = !isMultiBlock || summary.compatibleCount > 0;
      blockButton.disabled = !canConvert;
      blockButton.setAttribute("aria-disabled", canConvert ? "false" : "true");
    }
    const blockLabel = this.toolbar.querySelector("[data-tcloud-block-label]");
    if (blockLabel) blockLabel.textContent = this.currentBlockLabel();
    const selectionCount = this.toolbar.querySelector("[data-tcloud-selection-count]");
    if (selectionCount) {
      selectionCount.hidden = !isMultiBlock;
      const skipped = summary.incompatibleCount;
      selectionCount.textContent = skipped
        ? `${summary.count} blocos · ${skipped} ignorado${skipped === 1 ? "" : "s"}`
        : `${summary.count} blocos`;
    }
  }

  currentBlockLabel() {
    if (this.adapter.hasMultiBlockSelection(this.savedRange)) return "Blocos";
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

function rangeIntersectsElement(range, element) {
  if (!range || !element) return false;
  try {
    return range.intersectsNode(element);
  } catch (error) {
    return false;
  }
}

function rangeIntersection(range, element) {
  if (!range || !element || range.collapsed) return null;
  try {
    if (!range.intersectsNode(element)) return null;

    const intersection = range.cloneRange();

    const startCmp = range.comparePoint(element, 0);
    if (startCmp >= 0) {
      intersection.setStart(element, 0);
    }

    const endCmp = range.comparePoint(element, element.childNodes.length);
    if (endCmp <= 0) {
      intersection.setEnd(element, element.childNodes.length);
    }

    if (intersection.collapsed) return null;
    return intersection;
  } catch (error) {
    return null;
  }
}

function rangeLooksLikeMultiBlockSelection(range, blocks = [], visualSelected = new Set()) {
  if (!range || !visualSelected.size) return false;
  try {
    const rect = rangeSelectionRect(range);
    if (rect?.height > 48) return true;
  } catch (error) {
    // Fall through to text matching.
  }

  const rangeText = range.toString().replace(/\s+/g, " ").trim().toLowerCase();
  if (!rangeText) return false;
  let matchingBlocks = 0;
  visualSelected.forEach((index) => {
    const text = (blocks[index]?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (text && rangeText.includes(text.slice(0, Math.min(text.length, 24)))) matchingBlocks++;
  });
  return matchingBlocks > 1;
}

export class TCloudBlockSelectionController {
  constructor(adapter) {
    this.adapter = adapter;
    this.root = holderElement(adapter.holder);
    this.frame = null;
    this.selectionSnapshot = this.emptySnapshot();

    this.onSelectionChange = () => this.scheduleSync();
    this.onPointerDown = (event) => this.handlePointerDown(event);
    this.onPointerUp = () => this.scheduleSync();
    this.onKeyUp = (event) => this.handleKeyUp(event);
    this.onKeyDown = (event) => this.handleKeyDown(event);
    this.onCopy = (event) => this.handleCopy(event);
    this.onFocusIn = () => this.scheduleSync();

    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("pointerup", this.onPointerUp, true);
    document.addEventListener("keyup", this.onKeyUp, true);
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("copy", this.onCopy, true);
    document.addEventListener("focusin", this.onFocusIn, true);

    this.scheduleSync();
  }

  destroy() {
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("pointerdown", this.onPointerDown, true);
    document.removeEventListener("pointerup", this.onPointerUp, true);
    document.removeEventListener("keyup", this.onKeyUp, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("copy", this.onCopy, true);
    document.removeEventListener("focusin", this.onFocusIn, true);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.clear();
  }

  emptySnapshot() {
    return {
      active: false,
      source: "",
      indexes: [],
      ids: [],
      anchorIndex: -1,
      focusIndex: -1,
      range: null,
      rect: null,
      text: "",
      createdAt: 0,
      frozen: false,
      frozenReason: "",
    };
  }

  blocks() {
    return Array.from(this.root?.querySelectorAll(".ce-block") || []);
  }

  normalizeIndexes(indexes = []) {
    const blocks = this.blocks();
    return Array.from(new Set(indexes))
      .map((index) => Number(index))
      .filter((index) => (
        Number.isInteger(index) &&
        index >= 0 &&
        index < blocks.length
      ))
      .sort((a, b) => a - b);
  }

  indexesFromRange(range) {
    if (!range || !this.root || !rangeInsideEditor(range, this.root)) return [];
    return this.blocks()
      .map((block, index) => (rangeIntersectsElement(range, block) ? index : -1))
      .filter((index) => index >= 0);
  }

  indexesFromCurrentSelection() {
    const blocks = this.blocks();
    const selected = new Set();
    blocks.forEach((block, index) => {
      if (block.classList.contains("ce-block--selected")) selected.add(index);
    });
    const selection = window.getSelection();
    if (selection?.rangeCount && !selection.isCollapsed) {
      this.indexesFromRange(selection.getRangeAt(0)).forEach((index) => selected.add(index));
    }
    return this.normalizeIndexes(Array.from(selected));
  }

  visualIndexes() {
    return this.normalizeIndexes(
      this.blocks()
        .map((block, index) => (
          block.classList.contains("is-tcloud-range-selected") ||
          block.classList.contains("ce-block--selected")
            ? index
            : -1
        ))
        .filter((index) => index >= 0)
    );
  }

  snapshotIsValid(snapshot = this.selectionSnapshot) {
    if (!snapshot?.active) return false;
    const indexes = this.normalizeIndexes(snapshot.indexes);
    if (!indexes.length) return false;
    const contentBlocks = this.adapter.lastSavedContent?.blocks || [];
    if (contentBlocks.length && snapshot.ids?.length === indexes.length) {
      const stillSameBlocks = indexes.every((index, offset) => {
        const expectedId = snapshot.ids[offset];
        return !expectedId || contentBlocks[index]?.id === expectedId;
      });
      if (!stillSameBlocks) return false;
    }
    return true;
  }

  cloneSnapshot(snapshot = this.selectionSnapshot) {
    return {
      ...snapshot,
      indexes: [...(snapshot.indexes || [])],
      ids: [...(snapshot.ids || [])],
      range: snapshot.range?.cloneRange?.() || null,
      rect: snapshot.rect ? { ...snapshot.rect } : null,
    };
  }

  captureFromIndexes(indexes = [], reason = "selectionchange", range = null) {
    const normalized = this.normalizeIndexes(indexes);
    if (normalized.length <= 1) {
      if (!this.selectionSnapshot.frozen) this.selectionSnapshot = this.emptySnapshot();
      return this.getSnapshot();
    }
    const contentBlocks = this.adapter.lastSavedContent?.blocks || [];
    const frozen = Boolean(this.selectionSnapshot.frozen);
    this.selectionSnapshot = {
      active: true,
      source: reason,
      indexes: normalized,
      ids: normalized.map((index) => contentBlocks[index]?.id || ""),
      anchorIndex: normalized[0],
      focusIndex: normalized[normalized.length - 1],
      range: range?.cloneRange?.() || null,
      rect: rangeSelectionRect(range) || unionRects(
        normalized
          .map((index) => rectFromBox(this.blocks()[index]?.getBoundingClientRect?.()))
          .filter(Boolean)
      ),
      text: range?.toString?.() || normalized.map((index) => blockPlainText(contentBlocks[index])).join("\n"),
      createdAt: Date.now(),
      frozen,
      frozenReason: frozen ? this.selectionSnapshot.frozenReason : "",
    };
    this.renderSelectionSnapshot();
    return this.getSnapshot();
  }

  captureFromCurrentSelection(reason = "selectionchange") {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    return this.captureFromIndexes(this.indexesFromCurrentSelection(), reason, range);
  }

  captureFromRange(range, reason = "saved-range") {
    const indexes = this.indexesFromRange(range);
    if (!indexes.length) return this.getSnapshot();
    return this.captureFromIndexes(indexes, reason, range);
  }

  getSnapshot() {
    if (!this.snapshotIsValid()) return this.emptySnapshot();
    const normalized = this.normalizeIndexes(this.selectionSnapshot.indexes);
    const snapshot = this.cloneSnapshot(this.selectionSnapshot);
    snapshot.indexes = normalized;
    snapshot.active = normalized.length > 0;
    return snapshot;
  }

  getSelectedIndexes(preferredRange = null, { allowSnapshot = true } = {}) {
    if (allowSnapshot && this.snapshotIsValid()) {
      const snapshotIndexes = this.normalizeIndexes(this.selectionSnapshot.indexes);
      if (snapshotIndexes.length > 1) return snapshotIndexes;
    }
    const preferredIndexes = this.indexesFromRange(preferredRange);
    if (preferredIndexes.length) return this.normalizeIndexes(preferredIndexes);
    const currentIndexes = this.indexesFromCurrentSelection();
    if (currentIndexes.length) return currentIndexes;
    return this.visualIndexes();
  }

  hasMultiBlockSelection(preferredRange = null) {
    return this.getSelectedIndexes(preferredRange).length > 1;
  }

  freeze(reason = "toolbar") {
    if (!this.snapshotIsValid()) {
      if (reason === "saved-range") return this.getSnapshot();
      this.captureFromCurrentSelection(reason);
    }
    if (this.snapshotIsValid()) {
      this.selectionSnapshot.frozen = true;
      this.selectionSnapshot.frozenReason = reason;
      this.renderSelectionSnapshot();
    }
    return this.getSnapshot();
  }

  unfreeze(reason = "manual") {
    if (!this.selectionSnapshot.active) return;
    this.selectionSnapshot.frozen = false;
    this.selectionSnapshot.frozenReason = reason;
  }

  clearSnapshot(reason = "manual", { render = true } = {}) {
    this.selectionSnapshot = this.emptySnapshot();
    this.selectionSnapshot.source = reason;
    if (render) this.clearVisualSelection();
  }

  scheduleSync() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.sync();
    });
  }

  clearVisualSelection() {
    this.root?.classList.remove(
      "has-tcloud-active-block",
      "has-tcloud-single-block-selection",
      "has-tcloud-multiblock-selection"
    );

    this.root?.querySelectorAll(
      ".ce-block.is-tcloud-active-block, " +
      ".ce-block.is-tcloud-range-selected, " +
      ".ce-block.is-tcloud-selection-start, " +
      ".ce-block.is-tcloud-selection-end"
    ).forEach((block) => {
      block.classList.remove(
        "is-tcloud-active-block",
        "is-tcloud-range-selected",
        "is-tcloud-selection-start",
        "is-tcloud-selection-end"
      );
      block.removeAttribute("data-tcloud-selected-index");
    });
  }

  clear() {
    this.clearSnapshot("clear", { render: false });
    this.clearVisualSelection();
  }

  renderSelectionSnapshot() {
    if (!this.root || !document.contains(this.root)) return;
    const indexes = this.normalizeIndexes(this.selectionSnapshot.indexes);
    this.clearVisualSelection();
    if (indexes.length <= 1) return;

    const blocks = this.blocks();
    this.root.classList.add("has-tcloud-multiblock-selection");
    indexes.forEach((blockIndex, ordinal) => {
      const block = blocks[blockIndex];
      if (!block) return;
      block.classList.add("is-tcloud-range-selected");
      block.dataset.tcloudSelectedIndex = String(ordinal);
    });
    blocks[indexes[0]]?.classList.add("is-tcloud-selection-start");
    blocks[indexes[indexes.length - 1]]?.classList.add("is-tcloud-selection-end");
  }

  handlePointerDown(event) {
    const target = event.target;
    if (target?.closest?.(PROTECTED_POPOVER_TARGETS)) {
      this.freeze("popover-pointerdown");
      return;
    }
    if (target?.closest?.(".tcloud-inline-toolbar--custom, .tcloud-inline-toolbar__menu, .tcloud-context-menu")) {
      this.freeze("toolbar-pointerdown");
      return;
    }
    if (this.root?.contains(target)) {
      if (event.button === 2) {
        this.freeze("editor-context-pointerdown");
        return;
      }
      this.clearSnapshot("editor-pointerdown", { render: false });
      return;
    }
    if (!isBlockedInlineToolbarTarget(nodeToElement(target))) {
      this.clearSnapshot("pointer-outside");
    }
  }

  handleKeyUp(event) {
    if (event.key === "Escape") {
      this.clearSnapshot("escape");
      return;
    }
    this.scheduleSync();
  }

  handleKeyDown(event) {
    if (!this.root || !document.contains(this.root)) return;
    const target = event.target;
    const insideEditor = Boolean(target?.closest?.(".editorjs-host, .codex-editor") && this.root?.contains(target));
    if (!insideEditor) return;

    const isShiftArrow = event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown");
    const isBulkDelete = (event.key === "Backspace" || event.key === "Delete") && this.hasMultiBlockSelection(null);

    if (isShiftArrow) {
      event.preventDefault();
      event.stopPropagation();
      this.expandSelectionWithArrow(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (isBulkDelete) {
      event.preventDefault();
      event.stopPropagation();
      this.adapter.deleteSelectedBlocks(this.selectionSnapshot.range).catch((error) => {
        console.warn("[TCloud] Falha ao deletar blocos selecionados via teclado:", error);
      });
      return;
    }
  }

  expandSelectionWithArrow(direction) {
    const blocks = this.blocks();
    if (!blocks.length) return;

    const currentSnapshot = this.snapshotIsValid() ? this.getSnapshot() : null;
    let anchorIndex;
    let focusIndex;

    if (currentSnapshot && currentSnapshot.indexes.length > 1) {
      anchorIndex = currentSnapshot.anchorIndex;
      focusIndex = currentSnapshot.focusIndex + direction;
    } else {
      anchorIndex = this.currentBlockIndexSync();
      focusIndex = anchorIndex + direction;
    }

    if (focusIndex < 0 || focusIndex >= blocks.length) return;

    const start = Math.min(anchorIndex, focusIndex);
    const end = Math.max(anchorIndex, focusIndex);
    const indexes = [];
    for (let i = start; i <= end; i++) indexes.push(i);

    const range = this.buildRangeAcrossBlocks(start, end);
    if (range) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }

    this.captureFromIndexes(indexes, "keyboard-arrow", range);
    this.freeze("keyboard-arrow");
    if (typeof blocks[focusIndex]?.scrollIntoView === "function") {
      blocks[focusIndex].scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  buildRangeAcrossBlocks(startIndex, endIndex) {
    const blocks = this.blocks();
    const startBlock = blocks[startIndex];
    const endBlock = blocks[endIndex];
    if (!startBlock || !endBlock) return null;
    try {
      const range = document.createRange();
      range.setStartBefore(startBlock);
      range.setEndAfter(endBlock);
      return range;
    } catch (error) {
      return null;
    }
  }

  currentBlockIndexSync() {
    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const node = selection.getRangeAt(0).commonAncestorContainer;
      const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const blockElement = element?.closest?.(".ce-block");
      if (blockElement && this.root?.contains(blockElement)) {
        const blocks = this.blocks();
        const domIndex = blocks.indexOf(blockElement);
        if (domIndex >= 0) return domIndex;
      }
    }
    const activeBlock = this.root?.querySelector(".ce-block.is-tcloud-active-block");
    if (activeBlock) {
      const blocks = this.blocks();
      const domIndex = blocks.indexOf(activeBlock);
      if (domIndex >= 0) return domIndex;
    }
    return 0;
  }

  handleCopy(event) {
    if (!this.root || !document.contains(this.root)) return;
    if (!this.hasMultiBlockSelection(null)) return;
    const snapshot = this.getSnapshot();
    if (!snapshot?.indexes?.length) return;

    const contentBlocks = this.adapter.lastSavedContent?.blocks || [];
    const text = snapshot.indexes
      .map((index) => blockPlainText(contentBlocks[index]))
      .filter(Boolean)
      .join("\n");

    const json = JSON.stringify({
      tcloudNotesBlocks: snapshot.indexes.map((index) => contentBlocks[index]).filter(Boolean),
    });

    if (event.clipboardData) {
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
      event.clipboardData.setData("application/x-tcloud-notes-blocks", json);
    }
  }

  sync() {
    if (!this.root || !document.contains(this.root)) return;

    const selection = window.getSelection();
    const blocks = Array.from(this.root.querySelectorAll(".ce-block"));

    if (this.selectionSnapshot.frozen && this.snapshotIsValid()) {
      this.renderSelectionSnapshot();
      return;
    }

    this.clearVisualSelection();

    // 1. Gather blocks selected by Editor.js native mechanisms
    const editorSelectedBlocks = blocks.filter((block) =>
      block.classList.contains("ce-block--selected")
    );

    // 2. Gather blocks intersected by native DOM text selection range
    let nativeSelectedBlocks = [];
    let startElement = null;
    let endElement = null;
    let range = null;

    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      range = selection.getRangeAt(0);
      startElement = nodeToElement(range.startContainer);
      endElement = nodeToElement(range.endContainer);

      if (this.root.contains(startElement) && this.root.contains(endElement)) {
        if (
          !isBlockedInlineToolbarTarget(startElement) &&
          !isBlockedInlineToolbarTarget(endElement)
        ) {
          nativeSelectedBlocks = blocks.filter((block) =>
            rangeIntersectsElement(range, block)
          );
        }
      }
    }

    const selectedSet = new Set([...nativeSelectedBlocks, ...editorSelectedBlocks]);
    const selectedBlocks = blocks.filter((block) => selectedSet.has(block));

    if (selectedBlocks.length > 1) {
      this.captureFromIndexes(
        selectedBlocks.map((block) => blocks.indexOf(block)),
        "sync",
        range
      );
      return;
    }

    if (this.selectionSnapshot.active && !this.selectionSnapshot.frozen) {
      this.clearSnapshot("sync-single-or-empty", { render: false });
    }

    // 3. Fallback: single active block focused by cursor (collapsed range or focused element)
    let activeBlock = null;
    if (selectedBlocks.length === 1) {
      activeBlock = selectedBlocks[0];
    } else if (range && startElement) {
      activeBlock = startElement.closest(".ce-block");
    } else if (document.activeElement) {
      activeBlock = document.activeElement.closest(".ce-block");
    }

    if (activeBlock && this.root.contains(activeBlock)) {
      // Bloco ativo (caret): marca handles laterais visíveis sem pintar fundo.
      activeBlock.classList.add("is-tcloud-active-block");
      if (range && !range.collapsed) {
        this.root.classList.add("has-tcloud-single-block-selection");
        activeBlock.classList.add("is-tcloud-range-selected");
        activeBlock.dataset.tcloudSelectedIndex = "0";
      }
    }
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
    this.popoverController = null;
    this.blockSelectionController = null;
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
            Divider: "Divisor",
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
          class: listToolWithInlineSanitizer(),
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
    this.lastSavedContent = normalizeEditorData(initialData);
    if (!this.toolbarController) {
      this.toolbarController = new TCloudInlineToolbarController(this);
    }
    if (!this.blockSelectionController) {
      this.blockSelectionController = new TCloudBlockSelectionController(this);
    }
    if (!this.popoverController) {
      const root = holderElement(this.holder);
      this.popoverController = new EditorJsPopoverController({
        root,
        viewportRoot: root?.closest?.(".notes-app") || document.body,
        onOpen: () => this.toolbarController?.setExternalEditorMenuOpen(true, "editor-popover"),
        onClose: () => this.toolbarController?.setExternalEditorMenuOpen(false, "editor-popover"),
      });
      this.popoverController.connect();
    }
    this.applyIndentAttributes(normalizeEditorData(initialData));
    return this.editor;
  }

  async render(data, { isNewNote = false } = {}) {
    await this.init(data);
    this.blockSelectionController?.clearSnapshot?.("render");
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
    this.refreshLayout("note-rendered");
  }

  refreshLayout(reason = "manual") {
    const root = holderElement(this.holder);
    if (!root || !this.editor) return;

    const run = () => {
      this.blockSelectionController?.scheduleSync?.();
      this.toolbarController?.scheduleSelectionSync?.(`layout:${reason}`);
      this.toolbarController?.updateToolbarState?.();
      this.popoverController?.handleViewportChange?.();
    };

    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
  }

  openNativeBlockToolbar(reason = "manual") {
    const root = holderElement(this.holder);
    if (!root || !this.editor?.toolbar?.open) return;

    requestAnimationFrame(() => {
      if (!document.contains(root) || !this.editor?.toolbar?.open) return;
      this.blockSelectionController?.scheduleSync?.();
      try {
        this.editor.toolbar.open();
      } catch (error) {
        console.warn("[Notes] Falha ao reabrir toolbar do Editor.js", { reason, error });
      }
      this.popoverController?.handleViewportChange?.();
    });
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

  freezeBlockSelection(preferredRange = null, reason = "manual") {
    if (preferredRange) this.blockSelectionController?.captureFromRange?.(preferredRange, reason);
    return this.blockSelectionController?.freeze?.(reason);
  }

  clearBlockSelection(reason = "manual") {
    this.blockSelectionController?.clearSnapshot?.(reason);
  }

  async focus() {
    await this.init();
    if (typeof this.editor.caret?.setToLastBlock === "function") {
      this.editor.caret.setToLastBlock("end");
    }
  }

  async focusFirstBlock() {
    await this.init();
    if (typeof this.editor.caret?.setToFirstBlock === "function") {
      this.editor.caret.setToFirstBlock("end");
    } else if (typeof this.editor.caret?.setToBlock === "function") {
      this.editor.caret.setToBlock(0, "end");
    }
  }

  async currentBlockIndex() {
    await this.init();
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);

    const selection = window.getSelection();
    if (selection?.rangeCount) {
      const node = selection.getRangeAt(0).commonAncestorContainer;
      const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const blockElement = element?.closest?.(".ce-block");
      const domIndex = blocks.indexOf(blockElement);
      if (domIndex >= 0) return domIndex;
    }

    if (typeof this.editor.blocks?.getCurrentBlockIndex === "function") {
      const apiIndex = this.editor.blocks.getCurrentBlockIndex();
      if (Number.isInteger(apiIndex) && apiIndex >= 0) return apiIndex;
    }

    // Fallbacks: quando o popover de bloco rouba o foco da seleção, a API do
    // Editor.js e o range do browser podem nao apontar para um bloco. Usamos
    // os mesmos marcadores visiveis que o resto do adapter mantem.
    const activeBlock = holderElement?.querySelector?.(
      ".ce-block.is-tcloud-active-block, .ce-block--selected"
    );
    if (activeBlock) {
      const idx = blocks.indexOf(activeBlock);
      if (idx >= 0) return idx;
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

  async duplicateBlockByElement(element) {
    await this.init();
    const blockElement = element?.closest?.(".ce-block");
    if (!blockElement) {
      await this.duplicateBlock();
      return;
    }
    const holderElement = typeof this.holder === "string" ? document.getElementById(this.holder) : this.holder;
    const blocks = Array.from(holderElement?.querySelectorAll(".ce-block") || []);
    const index = blocks.indexOf(blockElement);
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
    await this.onChange();
    this.triggerHistorySave();
  }

  async duplicateSelectedBlocks(preferredRange = null) {
    const indexes = this.getSelectedBlockIndexes(preferredRange);
    if (indexes.length <= 1) {
      await this.duplicateBlock();
      return { changed: true, changedCount: indexes.length || 1, skippedCount: 0 };
    }

    const insertAt = indexes[indexes.length - 1] + 1;
    return this.mutateBlocksTransaction((content) => {
      const clones = indexes
        .map((index) => content.blocks[index])
        .filter(Boolean)
        .map((block) => ({
          ...JSON.parse(JSON.stringify(block)),
          id: blockId(),
        }));
      if (!clones.length) return { changedCount: 0, skippedCount: indexes.length, lastChangedIndex: -1 };
      content.blocks.splice(insertAt, 0, ...clones);
      return {
        changedCount: clones.length,
        skippedCount: Math.max(0, indexes.length - clones.length),
        lastChangedIndex: insertAt + clones.length - 1,
      };
    }, {
      focusIndex: insertAt,
      reason: "duplicate-selected-blocks",
    });
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

  async deleteSelectedBlocks(preferredRange = null) {
    const indexes = this.getSelectedBlockIndexes(preferredRange);
    if (indexes.length <= 1) {
      await this.deleteBlock();
      this.blockSelectionController?.clearSnapshot?.("delete-selected-blocks");
      return { changed: true, changedCount: indexes.length || 1, skippedCount: 0 };
    }

    const focusIndex = Math.max(0, indexes[0] - 1);
    const result = await this.mutateBlocksTransaction((content) => {
      let changedCount = 0;
      indexes
        .slice()
        .sort((a, b) => b - a)
        .forEach((index) => {
          if (!content.blocks[index]) return;
          content.blocks.splice(index, 1);
          changedCount++;
        });
      if (!content.blocks.length) {
        content.blocks = [buildBlock("paragraph", { text: "" })];
      }
      return {
        changedCount,
        skippedCount: Math.max(0, indexes.length - changedCount),
        lastChangedIndex: Math.min(focusIndex, content.blocks.length - 1),
      };
    }, {
      focusIndex,
      reason: "delete-selected-blocks",
    });
    this.blockSelectionController?.clearSnapshot?.("delete-selected-blocks");
    return result;
  }

  async deleteBlock() {
    await this.deleteBlockAtIndex(await this.currentBlockIndex());
  }

  async runBlockTune(tuneName, options = {}) {
    await this.init();
    const preferredRange = options.preferredRange || null;

    if (tuneName === "delete") {
      if (this.blockSelectionController?.hasMultiBlockSelection?.(preferredRange)) {
        return this.deleteSelectedBlocks(preferredRange);
      }
      return this.deleteBlock();
    }

    if (tuneName === "moveUp" || tuneName === "moveDown") {
      const direction = tuneName === "moveUp" ? -1 : 1;
      const indexes = this.getSelectedBlockIndexes(preferredRange);
      if (indexes.length > 1) {
        return this.shiftSelectedBlocks(direction, preferredRange);
      }
      const index = await this.currentBlockIndex();
      if (!Number.isInteger(index) || index < 0) return { changed: false, reason: "no-current-block" };
      const total = this.lastSavedContent?.blocks?.length || 0;
      if (!total) return { changed: false, reason: "empty-editor" };
      const target = index + direction;
      if (target < 0) return { changed: false, reason: "first-block" };
      if (target >= total) return { changed: false, reason: "last-block" };
      return this.swapBlocks(index, target);
    }

    return { changed: false, reason: "unknown-tune" };
  }

  async swapBlocks(fromIndex, toIndex) {
    await this.init();
    if (fromIndex === toIndex) return { changed: false, reason: "same-index" };
    return this.mutateBlocksTransaction((content) => {
      const [moved] = content.blocks.splice(fromIndex, 1);
      if (!moved) return { changedCount: 0, skippedCount: 1, lastChangedIndex: fromIndex };
      content.blocks.splice(toIndex, 0, moved);
      return { changedCount: 1, skippedCount: 0, lastChangedIndex: toIndex };
    }, {
      focusIndex: toIndex,
      reason: "swap-blocks",
    });
  }

  async shiftSelectedBlocks(direction, preferredRange = null) {
    await this.init();
    const indexes = this.getSelectedBlockIndexes(preferredRange);
    if (indexes.length <= 1) return { changed: false, reason: "single-or-none" };
    // Para moveUp, mover do maior índice para o menor evita colisão.
    // Para moveDown, do menor para o maior.
    const ordered = (direction < 0)
      ? [...indexes].sort((a, b) => b - a)
      : [...indexes].sort((a, b) => a - b);
    return this.mutateBlocksTransaction((content) => {
      let changedCount = 0;
      let lastChangedIndex = ordered[ordered.length - 1];
      ordered.forEach((index) => {
        const target = index + direction;
        if (target < 0 || target >= content.blocks.length) return;
        const [moved] = content.blocks.splice(index, 1);
        if (!moved) return;
        content.blocks.splice(target, 0, moved);
        changedCount++;
        lastChangedIndex = target;
      });
      return { changedCount, skippedCount: indexes.length - changedCount, lastChangedIndex };
    }, {
      focusIndex: ordered[0] + direction,
      reason: `shift-selected-blocks-${direction < 0 ? "up" : "down"}`,
    });
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

  getSelectedBlockIndexes(preferredRange = null) {
    const snapshotIndexes = this.blockSelectionController?.getSelectedIndexes?.(preferredRange, {
      allowSnapshot: true,
    });
    if (snapshotIndexes?.length) return snapshotIndexes;

    const holder = holderElement(this.holder);
    const blocks = Array.from(holder?.querySelectorAll(".ce-block") || []);
    const selected = new Set();
    const visualSelected = new Set();

    blocks.forEach((block, index) => {
      if (block.classList.contains("is-tcloud-range-selected")) {
        visualSelected.add(index);
        selected.add(index);
      }
      if (block.classList.contains("ce-block--selected")) {
        selected.add(index);
      }
    });

    const selection = window.getSelection();
    const range = preferredRange || (selection?.rangeCount ? selection.getRangeAt(0) : null);
    if (range && !range.collapsed) {
      const rangeIndexes = [];
      blocks.forEach((block, index) => {
        if (rangeIntersectsElement(range, block)) rangeIndexes.push(index);
      });
      if (
        rangeIndexes.length === 1 &&
        (visualSelected.size <= 1 || !rangeLooksLikeMultiBlockSelection(range, blocks, visualSelected))
      ) {
        return rangeIndexes;
      }
      rangeIndexes.forEach((index) => selected.add(index));
    }

    return Array.from(selected)
      .filter((index) => Number.isInteger(index) && index >= 0)
      .sort((a, b) => a - b);
  }

  hasMultiBlockSelection(preferredRange = null) {
    return Boolean(
      this.blockSelectionController?.hasMultiBlockSelection?.(preferredRange) ||
      this.getSelectedBlockIndexes(preferredRange).length > 1
    );
  }

  getSelectionSummary(preferredRange = null) {
    const indexes = this.getSelectedBlockIndexes(preferredRange);
    const blocks = indexes.map((index) => this.lastSavedContent?.blocks?.[index]).filter(Boolean);
    const compatibleCount = blocks.filter(isConvertibleBlock).length;
    const textCompatibleCount = blocks.filter(isTextFormatCompatibleBlock).length;
    return {
      indexes,
      count: indexes.length,
      hasMultiple: indexes.length > 1,
      compatibleCount,
      textCompatibleCount,
      incompatibleCount: Math.max(0, indexes.length - compatibleCount),
      textIncompatibleCount: Math.max(0, indexes.length - textCompatibleCount),
      firstIndex: indexes[0] ?? -1,
      lastIndex: indexes[indexes.length - 1] ?? -1,
    };
  }

  getSelectedBlocksPlainText(preferredRange = null) {
    const indexes = this.getSelectedBlockIndexes(preferredRange);
    return indexes
      .map((index) => blockPlainText(this.lastSavedContent?.blocks?.[index]))
      .filter((text) => text.trim())
      .join("\n");
  }

  getMultiBlockFormatState(preferredRange, selector) {
    const indexes = this.getSelectedBlockIndexes(preferredRange);
    if (indexes.length <= 1) return "none";
    const root = holderElement(this.holder);
    if (!root) return "none";
    const blockEls = Array.from(root.querySelectorAll(".ce-block"));
    let baseRange = (preferredRange && rangeInsideEditor(preferredRange, root)) ? preferredRange : null;
    if (!baseRange) {
      const snapshotRange = this.blockSelectionController?.getSnapshot?.()?.range;
      if (snapshotRange && rangeInsideEditor(snapshotRange, root)) baseRange = snapshotRange;
    }
    if (!baseRange) return "none";
    let allHave = true;
    let anyHave = false;
    let compatible = 0;
    indexes.forEach((index) => {
      const blockEl = blockEls[index];
      if (!blockEl) return;
      const blockData = this.lastSavedContent?.blocks?.[index];
      if (!isTextFormatCompatibleBlock(blockData)) return;
      const editables = Array.from(blockEl.querySelectorAll("[contenteditable='true']"));
      if (!editables.length) return;
      compatible++;
      let blockHasFormat = false;
      let hasSubRange = false;
      editables.forEach((editable) => {
        const subRange = rangeIntersection(baseRange, editable);
        if (!subRange) return;
        hasSubRange = true;
        if (findInlineWrapperInRange(subRange, selector)) blockHasFormat = true;
      });
      if (hasSubRange && blockHasFormat) anyHave = true;
      if (hasSubRange && !blockHasFormat) allHave = false;
    });
    if (compatible === 0) return "none";
    if (allHave) return "all";
    if (anyHave) return "partial";
    return "none";
  }

  async notifyManualChange() {
    await this.onChange();
    if (!this.isUndoingOrRedoing) this.triggerHistorySave();
  }

  async mutateBlocksTransaction(mutator, { focusIndex = null, reason = "batch" } = {}) {
    await this.init();
    const content = normalizeEditorData(await this.save());
    const beforeContent = JSON.parse(JSON.stringify(content));
    const before = JSON.stringify(content.blocks);
    const transactionHistory = this.history.slice(0, this.historyIndex + 1);
    const currentHistory = transactionHistory[transactionHistory.length - 1];
    if (!currentHistory || JSON.stringify(currentHistory.blocks) !== before) {
      transactionHistory.push(beforeContent);
    }
    const result = await mutator(content);
    const after = JSON.stringify(content.blocks);
    if (before === after) return { changed: false, ...result };

    content.time = Date.now();
    const wasUndoingOrRedoing = this.isUndoingOrRedoing;
    this.isUndoingOrRedoing = true;
    const holderEl = holderElement(this.holder);
    const savedScrollTop = holderEl?.scrollTop;
    const savedWindowScrollY = window.scrollY;
    try {
      await this.render(content);
    } finally {
      this.isUndoingOrRedoing = wasUndoingOrRedoing;
    }
    // Restore scroll immediately after render, then again in rAF and
    // double-rAF to survive any deferred layout or paint that the
    // Editor.js render pipeline may trigger.
    if (holderEl && savedScrollTop !== undefined) {
      holderEl.scrollTop = savedScrollTop;
      if (savedWindowScrollY !== undefined) window.scrollTo(0, savedWindowScrollY);
      requestAnimationFrame(() => {
        holderEl.scrollTop = savedScrollTop;
        if (savedWindowScrollY !== undefined) window.scrollTo(0, savedWindowScrollY);
        requestAnimationFrame(() => {
          holderEl.scrollTop = savedScrollTop;
          if (savedWindowScrollY !== undefined) window.scrollTo(0, savedWindowScrollY);
        });
      });
    }
    transactionHistory.push(JSON.parse(JSON.stringify(content)));
    while (transactionHistory.length > this.maxHistorySize) transactionHistory.shift();
    this.history = transactionHistory;
    this.historyIndex = this.history.length - 1;

    const targetIndex = Number.isInteger(focusIndex) ? focusIndex : result?.lastChangedIndex;
    if (
      Number.isInteger(targetIndex) &&
      content.blocks.length &&
      typeof this.editor.caret?.setToBlock === "function"
    ) {
      try {
        this.editor.caret.setToBlock(Math.min(targetIndex, content.blocks.length - 1), "end");
      } catch (error) {
        await this.focus();
      }
    } else {
      await this.focus();
    }

    // Restore scroll immediately after caret positioning (setToBlock may
    // have triggered a scroll-into-view internally)
    if (holderEl && savedScrollTop !== undefined) {
      holderEl.scrollTop = savedScrollTop;
      if (savedWindowScrollY !== undefined) window.scrollTo(0, savedWindowScrollY);
    }

    await this.notifyManualChange();
    this.refreshLayout(reason);
    return { changed: true, ...result };
  }

  async convertSelectedBlocks(type, data = {}, preferredRange = null) {
    const indexes = this.getSelectedBlockIndexes(preferredRange);
    if (indexes.length <= 1) return this.convertCurrentBlock(type, data);
    const savedContent = normalizeEditorData(this.lastSavedContent);

    return this.mutateBlocksTransaction((content) => {
      const holder = holderElement(this.holder);
      const domBlocks = Array.from(holder?.querySelectorAll(".ce-block") || []);
      let changedCount = 0;
      let skippedCount = 0;
      let lastChangedIndex = indexes[indexes.length - 1];

      indexes.forEach((index) => {
        const currentBlock = content.blocks[index];
        if (!isConvertibleBlock(currentBlock)) {
          skippedCount++;
          return;
        }

        const sourceText = blockPlainText(currentBlock);
        const domIndent = clampIndentLevel(domBlocks[index]?.dataset?.tcloudIndent);
        const currentIndent = copyIndentData(currentBlock.data || {});
        const savedIndent = copyIndentData(savedContent.blocks[index]?.data || {});
        const inheritedIndent = domIndent
          ? { tcloudIndent: { level: domIndent } }
          : Object.keys(currentIndent).length
            ? currentIndent
            : savedIndent;
        const nextOptions = {
          ...data,
          ...inheritedIndent,
        };
        if (type === "todo" && currentBlock.type === "todo") {
          nextOptions.checked = Boolean(currentBlock.data?.checked);
        }

        const nextData = convertBlockData(type, sourceText, nextOptions);
        const nextBlock = buildBlock(type, nextData);
        nextBlock.id = currentBlock.id || nextBlock.id;
        nextBlock.data = { ...(nextBlock.data || {}), ...inheritedIndent };
        content.blocks[index] = nextBlock;
        changedCount++;
        lastChangedIndex = index;
      });

      return { changedCount, skippedCount, lastChangedIndex };
    }, {
      focusIndex: indexes[indexes.length - 1],
      reason: "convert-selected-blocks",
    });
  }

  async changeSelectedBlocksIndent(delta, preferredRange = null) {
    const indexes = this.getSelectedBlockIndexes(preferredRange);
    if (indexes.length <= 1) return this.changeBlockIndent(delta, preferredRange);

    return this.mutateBlocksTransaction((content) => {
      let changedCount = 0;
      let skippedCount = 0;
      let lastChangedIndex = indexes[indexes.length - 1];

      indexes.forEach((index) => {
        const block = content.blocks[index];
        if (!block?.data || block.type === "divider" || isTCloudBlockType(block.type)) {
          skippedCount++;
          return;
        }

        const current = clampIndentLevel(block.data?.tcloudIndent?.level ?? block.data?.tcloudIndent);
        const next = clampIndentLevel(current + Number(delta || 0));
        if (next) {
          block.data.tcloudIndent = { level: next };
        } else {
          delete block.data.tcloudIndent;
        }
        changedCount++;
        lastChangedIndex = index;
      });

      return { changedCount, skippedCount, lastChangedIndex };
    }, {
      focusIndex: indexes[indexes.length - 1],
      reason: "indent-selected-blocks",
    });
  }

  async applyInlineActionToSelectedBlocks(action, preferredRange = null) {
    const indexes = this.getSelectedBlockIndexes(preferredRange);
    if (indexes.length <= 1) return null;
    const safeIndexes = [...indexes];

    if (action === "clear") {
      return this.mutateBlocksTransaction((content) => {
        let changedCount = 0;
        let skippedCount = 0;
        let lastChangedIndex = safeIndexes[safeIndexes.length - 1];

        safeIndexes.forEach((index) => {
          const block = content.blocks[index];
          if (!isTextFormatCompatibleBlock(block)) {
            skippedCount++;
            return;
          }

          const changed = applyToBlockTextFields(block, (html) => clearHtmlInlineFormatting(html));
          if (changed) {
            changedCount++;
            lastChangedIndex = index;
          }
        });

        return { changedCount, skippedCount, lastChangedIndex };
      }, {
        focusIndex: safeIndexes[safeIndexes.length - 1],
        reason: `inline-${action}-selected-blocks`,
      });
    }

    const toggleActions = {
      bold: { selector: "strong,b", tag: "strong" },
      italic: { selector: "em,i", tag: "em" },
      underline: { selector: "u", tag: "u" },
      strike: { selector: "s,strike", tag: "s" },
      "inline-code": { selector: "code", tag: "code" },
    };
    const toggle = toggleActions[action];
    if (!toggle) return null;

    const root = holderElement(this.holder);
    if (!root) return null;
    const blocks = Array.from(root.querySelectorAll(".ce-block"));

    let baseRange = (preferredRange && rangeInsideEditor(preferredRange, root))
      ? preferredRange
      : null;
    if (!baseRange) {
      const snapshotRange = this.blockSelectionController?.getSnapshot?.()?.range;
      if (snapshotRange && rangeInsideEditor(snapshotRange, root)) baseRange = snapshotRange;
    }
    if (!baseRange) return null;

    let changedCount = 0;
    let skippedCount = 0;
    let lastChangedIndex = safeIndexes[safeIndexes.length - 1];

    const blockChecks = [];
    let compatibleCount = 0;
    let allHaveFormat = true;

    safeIndexes.forEach((index) => {
      const blockEl = blocks[index];
      if (!blockEl) { skippedCount++; return; }
      const blockData = this.lastSavedContent?.blocks?.[index];
      if (!isTextFormatCompatibleBlock(blockData)) { skippedCount++; return; }
      const editables = Array.from(blockEl.querySelectorAll("[contenteditable='true']"));
      if (!editables.length) { skippedCount++; return; }

      compatibleCount++;
      let blockHasFormat = true;
      let hasSubRange = false;
      editables.forEach((editable) => {
        const subRange = rangeIntersection(baseRange, editable);
        if (!subRange) return;
        hasSubRange = true;
        const existing = findInlineWrapperInRange(subRange, toggle.selector);
        if (!existing) blockHasFormat = false;
      });
      if (!hasSubRange) blockHasFormat = false;
      if (!blockHasFormat) allHaveFormat = false;
      blockChecks.push({ index, editables });
    });

    const targetApply = compatibleCount > 0 ? !allHaveFormat : false;

    blockChecks.forEach(({ index, editables }) => {
      let blockChanged = false;
      editables.forEach((editable) => {
        const subRange = rangeIntersection(baseRange, editable);
        if (!subRange) return;
        if (targetApply) {
          const existing = findInlineWrapperInRange(subRange, toggle.selector);
          if (!existing) {
            const nextRange = wrapRangeWithElement(subRange, toggle.tag);
            if (nextRange) blockChanged = true;
          }
        } else {
          if (unwrapAllInlineInRange(subRange, toggle.selector)) blockChanged = true;
        }
      });

      if (blockChanged) {
        changedCount++;
        lastChangedIndex = index;
      }
    });

    if (changedCount > 0) {
      // Rebuild the selection range across the affected blocks so the
      // block selection controller and inline toolbar can re-anchor
      // correctly after the DOM mutations.
      const updatedBlocks = Array.from(root.querySelectorAll(".ce-block"));
      const firstBlock = updatedBlocks[safeIndexes[0]];
      const lastBlock = updatedBlocks[safeIndexes[safeIndexes.length - 1]];
      if (firstBlock && lastBlock) {
        try {
          const rebuiltRange = document.createRange();
          rebuiltRange.setStartBefore(firstBlock);
          rebuiltRange.setEndAfter(lastBlock);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(rebuiltRange);
        } catch (rangeError) {
          // Best-effort: if range rebuild fails, continue anyway
        }
      }

      // Re-sync the block selection controller with the still-selected indexes
      if (this.blockSelectionController) {
        const currentRange = window.getSelection()?.rangeCount
          ? window.getSelection().getRangeAt(0)
          : null;
        this.blockSelectionController.captureFromIndexes(safeIndexes, `inline-${action}`, currentRange);
        this.blockSelectionController.freeze(`inline-${action}`);
      }

      // Restore editor focus without collapsing the selection
      const focusTarget = updatedBlocks[safeIndexes[safeIndexes.length - 1]]?.querySelector("[contenteditable='true']");
      if (focusTarget && typeof focusTarget.focus === "function") {
        focusTarget.focus({ preventScroll: true });
      }

      await this.notifyManualChange();
    }

    return { changedCount, skippedCount, lastChangedIndex };
  }

  async applyColorToSelectedBlocks(mode, value, preferredRange = null) {
    const indexes = this.getSelectedBlockIndexes(preferredRange);
    if (indexes.length <= 1) return null;
    const safeIndexes = [...indexes];

    const styleKey = mode === "background" ? "backgroundColor" : "color";
    const normalized = normalizeHex(value);
    if (value && !normalized) return { changed: false, reason: "invalid-color" };

    const root = holderElement(this.holder);
    if (!root) return null;
    const blocks = Array.from(root.querySelectorAll(".ce-block"));

    let baseRange = (preferredRange && rangeInsideEditor(preferredRange, root))
      ? preferredRange
      : null;
    if (!baseRange) {
      const snapshotRange = this.blockSelectionController?.getSnapshot?.()?.range;
      if (snapshotRange && rangeInsideEditor(snapshotRange, root)) baseRange = snapshotRange;
    }

    let changedCount = 0;
    let skippedCount = 0;
    let lastChangedIndex = safeIndexes[safeIndexes.length - 1];

    safeIndexes.forEach((index) => {
      const blockEl = blocks[index];
      if (!blockEl) { skippedCount++; return; }
      const blockData = this.lastSavedContent?.blocks?.[index];
      if (!isTextFormatCompatibleBlock(blockData)) { skippedCount++; return; }
      const editables = Array.from(blockEl.querySelectorAll("[contenteditable='true']"));
      if (!editables.length) { skippedCount++; return; }

      let blockChanged = false;
      editables.forEach((editable) => {
        let subRange = baseRange ? rangeIntersection(baseRange, editable) : null;
        if (!subRange) {
          subRange = document.createRange();
          subRange.selectNodeContents(editable);
        }
        const nextRange = applyInlineStyle(subRange, { [styleKey]: normalized || null });
        if (nextRange) blockChanged = true;
      });

      if (blockChanged) {
        changedCount++;
        lastChangedIndex = index;
      }
    });

    if (changedCount > 0) {
      const updatedBlocks = Array.from(root.querySelectorAll(".ce-block"));
      const firstBlock = updatedBlocks[safeIndexes[0]];
      const lastBlock = updatedBlocks[safeIndexes[safeIndexes.length - 1]];
      if (firstBlock && lastBlock) {
        try {
          const rebuiltRange = document.createRange();
          rebuiltRange.setStartBefore(firstBlock);
          rebuiltRange.setEndAfter(lastBlock);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(rebuiltRange);
        } catch (rangeError) {
          // Best-effort
        }
      }

      if (this.blockSelectionController) {
        const currentRange = window.getSelection()?.rangeCount
          ? window.getSelection().getRangeAt(0)
          : null;
        this.blockSelectionController.captureFromIndexes(safeIndexes, `color-${mode}`, currentRange);
        this.blockSelectionController.freeze(`color-${mode}`);
      }

      const focusTarget = updatedBlocks[safeIndexes[safeIndexes.length - 1]]?.querySelector("[contenteditable='true']");
      if (focusTarget && typeof focusTarget.focus === "function") {
        focusTarget.focus({ preventScroll: true });
      }

      await this.notifyManualChange();
    }

    return { changedCount, skippedCount, lastChangedIndex };
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
    const index = await this.currentBlockIndex();
    if (!Number.isInteger(index) || index < 0) return;

    // Native path: Editor.js v2.31 api.blocks.convert() faz o swap real da
    // tool instance (replace), evitando o revert que acontece quando usamos
    // apenas editor.blocks.render() com o mesmo block id (a tool Header
    // interna nao e trocada e o DOM volta para header no proximo save/caret).
    const block = this.editor.blocks?.getBlockByIndex?.(index);
    const blockId = block?.id;
    if (blockId && typeof this.editor.blocks?.convert === "function") {
      try {
        const converted = await this.editor.blocks.convert(blockId, type, data);
        const target = converted || index;
        if (typeof this.editor.caret?.setToBlock === "function") {
          try {
            this.editor.caret.setToBlock(target, "end");
          } catch (error) {
            await this.focus();
          }
        }
        await this.notifyManualChange();
        return;
      } catch (error) {
        console.warn("[TCloud Notes] api.blocks.convert falhou, fallback para render", error);
      }
    }

    // Fallback: re-render baseado em content (cenario sem API nativa).
    const content = normalizeEditorData(await this.save());
    if (!content.blocks[index]) return;
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

// TCloud Notes — Active Block Tracking removed, managed by TCloudBlockSelectionController instead
