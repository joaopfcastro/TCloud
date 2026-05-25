import { EditorAdapter, buildBlock, normalizeEditorData } from "./editor-adapter.js";
import { NotesApi } from "./notes-api.js";
import { NotesFilePicker } from "./file-picker.js";
import { IMPORT_ACCEPT, isSupportedImportFile, readFileAsText } from "./export-import.js";
import { blocksToMarkdownPreview } from "./markdown-converter.js";
import { installWikiLinkAutocomplete } from "./relations.js";
import {
  buildBulkSelectionActions,
  buildEditorMoreActions,
  buildNoteMenuActions,
  getNoteContext,
} from "./menu-actions.mjs";

const AUTOSAVE_DELAY_MS = 1200;
const SEARCH_DELAY_MS = 260;
const SAVE_STATUS_TICK_MS = 1000;
const APPEARANCE_PROPERTY_KEY = "__tcloudAppearance";

const ATTACHMENT_BLOCKS = {
  file: "tcloudFile",
  image: "tcloudImage",
  video: "tcloudVideo",
  audio: "tcloudAudio",
  pdf: "tcloudPdf",
  folder: "tcloudFolder",
};

const SLASH_OPTIONS = [
  { id: "text", icon: "T", group: "Básico", label: "Texto", hint: "Parágrafo simples", type: "paragraph", data: { text: "" } },
  { id: "heading", icon: "H", group: "Básico", label: "Título", hint: "Seção ou subtítulo", type: "header", data: { level: 2, text: "" } },
  { id: "list", icon: "•", group: "Básico", label: "Lista", hint: "Itens com marcadores", type: "list", data: { style: "unordered", items: [""] } },
  { id: "todo", icon: "✓", group: "Básico", label: "Checklist", hint: "Tarefas marcáveis", type: "todo", data: { text: "", checked: false } },
  { id: "quote", icon: "”", group: "Básico", label: "Citação", hint: "Destaque com fonte", type: "quote", data: { text: "", caption: "" } },
  { id: "code", icon: "{ }", group: "Básico", label: "Código", hint: "Bloco monoespaçado", type: "codeBlock", data: { code: "" } },
  { id: "divider", icon: "—", group: "Básico", label: "Divisor", hint: "Separador visual", type: "divider", data: {} },
  { id: "file", icon: "F", group: "TCloud", label: "Arquivo", hint: "Referencia do TCloud", picker: { kinds: ["file", "image", "video", "audio", "pdf"], blockType: "tcloudFile" } },
  { id: "image", icon: "I", group: "TCloud", label: "Imagem", hint: "Imagem do TCloud", picker: { kinds: ["image"], blockType: "tcloudImage" } },
  { id: "folder", icon: "P", group: "TCloud", label: "Pasta", hint: "Pasta ou colecao", picker: { kinds: ["folder"], allowFolders: true, blockType: "tcloudFolder" } },
  { id: "pdf", icon: "PDF", group: "TCloud", label: "PDF", hint: "Documento PDF", picker: { kinds: ["pdf"], blockType: "tcloudPdf" } },
];

const COVER_PRESETS = {
  gradient: { type: "gradient", value: "blue-green" },
  color: { type: "color", value: "#2c2c2e" },
  none: { type: "none", value: "" },
};

function templateContent(blocks) {
  return normalizeEditorData({ time: Date.now(), blocks });
}

const TEMPLATES = [
  {
    id: "blank",
    label: "Em branco",
    description: "Página vazia para começar rápido.",
    title: "Sem título",
    content: templateContent([buildBlock("paragraph", { text: "" })]),
  },
  {
    id: "meeting",
    label: "Reunião",
    description: "Agenda, tópicos e próximos passos.",
    title: "Reunião",
    content: templateContent([
      buildBlock("header", { level: 1, text: "Reunião" }),
      buildBlock("header", { level: 2, text: "Agenda" }),
      buildBlock("list", { style: "unordered", items: ["Contexto", "Decisões", "Pendências"] }),
      buildBlock("header", { level: 2, text: "Notas" }),
      buildBlock("paragraph", { text: "" }),
      buildBlock("header", { level: 2, text: "Próximos passos" }),
      buildBlock("todo", { text: "Definir responsáveis", checked: false }),
    ]),
  },
  {
    id: "checklist",
    label: "Checklist",
    description: "Lista de tarefas simples em blocos.",
    title: "Checklist",
    content: templateContent([
      buildBlock("header", { level: 1, text: "Checklist" }),
      buildBlock("todo", { text: "Primeiro item", checked: false }),
      buildBlock("todo", { text: "Segundo item", checked: false }),
      buildBlock("todo", { text: "Terceiro item", checked: false }),
    ]),
  },
  {
    id: "study",
    label: "Estudo",
    description: "Resumo, referências e perguntas.",
    title: "Sessão de estudo",
    content: templateContent([
      buildBlock("header", { level: 1, text: "Sessão de estudo" }),
      buildBlock("header", { level: 2, text: "Objetivo" }),
      buildBlock("paragraph", { text: "" }),
      buildBlock("header", { level: 2, text: "Resumo" }),
      buildBlock("paragraph", { text: "" }),
      buildBlock("header", { level: 2, text: "Perguntas abertas" }),
      buildBlock("list", { style: "unordered", items: [""] }),
    ]),
  },
  {
    id: "journal",
    label: "Diário",
    description: "Reflexões, humor e destaques do dia.",
    title: "Diário",
    content: templateContent([
      buildBlock("header", { level: 1, text: "Diário" }),
      buildBlock("quote", { text: "Como estou chegando hoje?", caption: "Reflexão" }),
      buildBlock("header", { level: 2, text: "O que aconteceu" }),
      buildBlock("paragraph", { text: "" }),
      buildBlock("header", { level: 2, text: "Aprendizados" }),
      buildBlock("list", { style: "unordered", items: [""] }),
    ]),
  },
  {
    id: "project",
    label: "Projeto",
    description: "Contexto, entregas, riscos e status.",
    title: "Projeto",
    content: templateContent([
      buildBlock("header", { level: 1, text: "Projeto" }),
      buildBlock("header", { level: 2, text: "Objetivo" }),
      buildBlock("paragraph", { text: "" }),
      buildBlock("header", { level: 2, text: "Entregas" }),
      buildBlock("todo", { text: "Marco 1", checked: false }),
      buildBlock("todo", { text: "Marco 2", checked: false }),
      buildBlock("header", { level: 2, text: "Riscos" }),
      buildBlock("quote", { text: "", caption: "O que pode travar?" }),
    ]),
  },
];

const state = {
  api: new NotesApi(),
  editor: null,
  picker: null,
  notes: [],
  revisions: [],
  attachments: [],
  currentNoteId: "",
  currentNote: null,
  loadingNote: false,
  saveTimer: 0,
  searchTimer: 0,
  statusTimer: 0,
  dirtyTitle: false,
  dirtyContent: false,
  dirtyMeta: false,
  isSaving: false,
  lastLoadedQuery: "",
  filters: {
    view: "active",
    tag: "",
  },
  saveState: {
    mode: "idle",
    at: 0,
    error: "",
  },
  modal: "",
  pendingConfirmAction: null,
  slashMenu: {
    open: false,
    index: 0,
    replaceCurrent: true,
    filteredOptions: null,
  },
  ui: {
    sidebarCollapsed: false,
    compactWindow: false,
  },
  compactWindowObserver: null,
  bootAttempt: 0,
  favoriteSaving: false,
  floatingSearch: {
    visible: false,
    query: "",
    index: -1,
    highlights: [],
  },
  selectedNoteIds: new Set(),
  lastClickedNoteId: null,
  currentListRequestId: 0,
  currentOpenNoteRequestId: 0,
};

const els = {
  app: document.querySelector(".notes-app"),
  searchInput: document.getElementById("search-input"),
  newNoteButton: document.getElementById("new-note-button"),
  sidebarToggleButton: document.getElementById("sidebar-toggle-button"),
  sidebarOpenButton: document.getElementById("sidebar-open-button"),
  templatesButton: document.getElementById("templates-button"),
  importButton: document.getElementById("import-button"),
  exportButton: document.getElementById("export-button"),
  backupButton: document.getElementById("backup-button"),
  notesList: document.getElementById("notes-list"),
  listMeta: document.getElementById("list-meta"),
  titleInput: document.getElementById("note-title"),
  favoriteButton: document.getElementById("favorite-button"),
  saveStatus: document.getElementById("save-status"),
  noteMeta: document.getElementById("note-meta"),
  deleteButton: document.getElementById("delete-note-button"),
  restoreNoteButton: document.getElementById("restore-note-button"),
  revisionsButton: document.getElementById("revisions-button"),
  archiveButton: document.getElementById("archive-note-button"),
  emptyState: document.getElementById("editor-empty-state"),
  emptyEyebrow: document.getElementById("empty-eyebrow"),
  emptyTitle: document.getElementById("empty-title"),
  emptyDescription: document.getElementById("empty-description"),
  editorPanel: document.getElementById("editor-panel"),
  editorHolder: document.getElementById("editorjs"),
  tagInput: document.getElementById("tag-input"),
  noteTags: document.getElementById("note-tags"),
  filterAll: document.getElementById("filter-all"),
  filterFavorites: document.getElementById("filter-favorites"),
  filterArchived: document.getElementById("filter-archived"),
  filterTrash: document.getElementById("filter-trash"),
  templatesModal: document.getElementById("templates-modal"),
  templatesGrid: document.getElementById("templates-grid"),
  emptyTemplateGrid: document.getElementById("empty-template-grid"),
  revisionsModal: document.getElementById("revisions-modal"),
  revisionsSummary: document.getElementById("revisions-summary"),
  revisionsList: document.getElementById("revisions-list"),
  importExportModal: document.getElementById("import-export-modal"),
  importFileInput: document.getElementById("import-file-input"),
  importConfirmButton: document.getElementById("import-confirm-button"),
  exportPreview: document.getElementById("export-preview"),
  exportJsonButton: document.getElementById("export-json-button"),
  exportMarkdownButton: document.getElementById("export-markdown-button"),
  exportHtmlButton: document.getElementById("export-html-button"),
  filePickerModal: document.getElementById("file-picker-modal"),
  confirmModal: document.getElementById("confirm-modal"),
  confirmEyebrow: document.getElementById("confirm-eyebrow"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmDescription: document.getElementById("confirm-description"),
  confirmCancelButton: document.getElementById("confirm-cancel-button"),
  confirmAcceptButton: document.getElementById("confirm-accept-button"),
  slashMenu: document.getElementById("slash-menu"),
  noteCover: document.getElementById("note-cover"),
  noteCoverButton: document.getElementById("note-cover-button"),
  noteCoverMenu: document.getElementById("note-cover-menu"),
  noteIconButton: document.getElementById("note-icon-button"),
  noteIconMenu: document.getElementById("note-icon-menu"),
  sidebarContextMenu: document.getElementById("sidebar-context-menu"),
  editorContextMenu: document.getElementById("editor-context-menu"),
  searchBarFloating: document.getElementById("search-bar-floating"),
  floatingSearchInput: document.getElementById("floating-search-input"),
  searchCounter: document.getElementById("search-counter"),
  searchPrev: document.getElementById("search-prev"),
  searchNext: document.getElementById("search-next"),
  searchClose: document.getElementById("search-close"),
  bulkState: document.getElementById("editor-bulk-state"),
};

function showToast(message, kind = "info") {
  state.api.showToast(message, kind);
}

function noteHash(noteId = "") {
  return noteId ? `#note=${encodeURIComponent(noteId)}` : "";
}

function readNoteIdFromHash() {
  const hash = String(window.location.hash || "").replace(/^#/, "");
  if (!hash) return "";
  const params = new URLSearchParams(hash);
  return String(params.get("note") || "").trim();
}

function syncNoteHash(noteId = "") {
  const nextHash = noteHash(noteId);
  if (window.location.hash === nextHash) return;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
}

function buildCurrentNoteUrl(noteId = state.currentNote?.id || state.currentNoteId) {
  if (!noteId) return window.location.href;
  const url = new URL(window.location.href);
  url.hash = noteHash(noteId);
  return url.toString();
}

async function copyToClipboard(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Nada para copiar.");
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.warn("Clipboard API indisponivel, usando fallback.", error);
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "true");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Nao foi possivel copiar o link da nota.");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function defaultAppearance() {
  return {
    cover: { type: "gradient", value: "blue-green" },
    icon: { type: "symbol", value: "▰" },
  };
}

function normalizeCover(rawCover) {
  const cover = rawCover && typeof rawCover === "object" ? rawCover : {};
  const type = ["none", "gradient", "color", "image"].includes(cover.type) ? cover.type : "gradient";
  const value = String(cover.value || "").trim();
  if (type === "none") return { type: "none", value: "" };
  if (type === "color") return { type: "color", value: value || COVER_PRESETS.color.value };
  if (type === "image") return { type: "image", value };
  return { type: "gradient", value: value || "blue-green" };
}

function normalizeIcon(rawIcon) {
  const icon = rawIcon && typeof rawIcon === "object" ? rawIcon : {};
  const type = ["none", "emoji", "symbol"].includes(icon.type) ? icon.type : "symbol";
  const value = String(icon.value || "").trim();
  if (type === "none") return { type: "none", value: "" };
  return { type, value: value.slice(0, 4) || "▰" };
}

function normalizeAppearance(rawAppearance) {
  const fallback = defaultAppearance();
  const raw = rawAppearance && typeof rawAppearance === "object" ? rawAppearance : {};
  return {
    cover: normalizeCover(raw.cover ?? fallback.cover),
    icon: normalizeIcon(raw.icon ?? fallback.icon),
  };
}

function currentAppearance() {
  const properties = state.currentNote?.properties || {};
  const hasDedicatedAppearance = state.currentNote && ("cover" in state.currentNote || "icon" in state.currentNote);
  const rawAppearance = hasDedicatedAppearance
    ? { cover: state.currentNote?.cover, icon: state.currentNote?.icon }
    : (properties[APPEARANCE_PROPERTY_KEY] || properties.tcloudAppearance || properties.appearance || null);
  return normalizeAppearance(rawAppearance);
}

function coverBackground(cover) {
  if (cover.type === "none") return "";
  if (cover.type === "color") return cover.value || COVER_PRESETS.color.value;
  if (cover.type === "image" && cover.value) {
    return `linear-gradient(180deg, rgba(28, 28, 30, 0.04), rgba(28, 28, 30, 0.36)), url("${buildDirectStreamPath(cover.value)}")`;
  }
  return "linear-gradient(135deg, rgba(10, 132, 255, 0.34), rgba(48, 209, 88, 0.14)), #242426";
}

function renderAppearance() {
  const appearance = currentAppearance();
  if (els.noteCover) {
    els.noteCover.dataset.coverType = appearance.cover.type;
    els.noteCover.classList.toggle("is-hidden", appearance.cover.type === "none");
    els.noteCover.style.background = coverBackground(appearance.cover);
    els.noteCover.style.backgroundSize = appearance.cover.type === "image" ? "cover" : "";
    els.noteCover.style.backgroundPosition = appearance.cover.type === "image" ? "center" : "";
  }
  if (els.noteIconButton) {
    const empty = appearance.icon.type === "none";
    els.noteIconButton.classList.toggle("is-empty", empty);
    els.noteIconButton.textContent = empty ? "Adicionar ícone" : appearance.icon.value;
    els.noteIconButton.setAttribute("aria-label", empty ? "Adicionar ícone da nota" : "Trocar ícone da nota");
  }
}

function updateCurrentProperties(nextProperties) {
  if (!state.currentNote) return;
  state.currentNote.properties = { ...(nextProperties || {}) };
}

async function setAppearancePatch(patch, toastMessage = "Aparência atualizada.") {
  if (!state.currentNote || state.currentNote.deleted_at) return;
  const nextAppearance = normalizeAppearance({ ...currentAppearance(), ...patch });
  const nextProperties = {
    ...(state.currentNote.properties || {}),
    [APPEARANCE_PROPERTY_KEY]: nextAppearance,
  };
  updateCurrentProperties(nextProperties);
  state.currentNote.cover = nextAppearance.cover;
  state.currentNote.icon = nextAppearance.icon;
  renderAppearance();
  upsertNoteSummary(state.currentNote);
  renderNotesList();
  markDirty("meta");
  await saveCurrentNote({ force: true });
  showToast(toastMessage, "success");
}

function closeCoverMenu() {
  els.noteCoverMenu?.classList.add("hidden");
  if (els.noteCoverMenu) {
    els.noteCoverMenu.style.position = "";
    els.noteCoverMenu.style.left = "";
    els.noteCoverMenu.style.right = "";
    els.noteCoverMenu.style.top = "";
  }
  els.noteCoverButton?.setAttribute("aria-expanded", "false");
}

function closeIconMenu() {
  els.noteIconMenu?.classList.add("hidden");
  els.noteIconButton?.setAttribute("aria-expanded", "false");
}

function openCoverMenuAt(x, y) {
  if (!els.noteCoverMenu || !state.currentNote || state.currentNote.deleted_at) return;
  closeIconMenu();
  els.noteCoverMenu.classList.remove("hidden");
  els.noteCoverButton?.setAttribute("aria-expanded", "true");

  const menuWidth = els.noteCoverMenu.offsetWidth || 180;
  const menuHeight = els.noteCoverMenu.offsetHeight || 120;
  const left = clamp(Number(x) || 0, 8, Math.max(8, window.innerWidth - menuWidth - 8));
  const top = clamp(Number(y) || 0, 8, Math.max(8, window.innerHeight - menuHeight - 8));
  els.noteCoverMenu.style.position = "fixed";
  els.noteCoverMenu.style.left = `${left}px`;
  els.noteCoverMenu.style.right = "auto";
  els.noteCoverMenu.style.top = `${top}px`;
}

function noteStateLabels(note) {
  const labels = [];
  if (note?.favorite) labels.push("Favorita");
  if (note?.archived) labels.push("Arquivada");
  if (note?.deleted_at) labels.push("Na lixeira");
  return labels;
}

function stripMarkdownPreview(value) {
  return String(value || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+\[(?: |x)\]\s+/gim, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/`{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanLegacyExcerpt(value) {
  return String(value || "")
    .replace(/\b\d{12,}\b/g, " ")
    .replace(/\b\d+\.\d+\.\d+\b/g, " ")
    .replace(/\b(?:paragraph|header|list|todo|quote|codeBlock|divider|tcloudFile|tcloudImage|tcloudVideo|tcloudAudio|tcloudPdf|tcloudFolder)\b/gi, " ")
    .replace(/\b[a-f0-9]{8,}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function notePreviewText(note) {
  const blocks = Array.isArray(note?.content?.blocks) ? note.content.blocks : [];
  const fromContent = stripMarkdownPreview(blocksToMarkdownPreview(blocks));
  if (fromContent) return fromContent;
  const fallback = cleanLegacyExcerpt(note?.excerpt || "");
  return fallback || "Nota vazia";
}

function extractAttachmentsFromContent(content) {
  const blocks = Array.isArray(content?.blocks) ? content.blocks : [];
  const seen = new Set();
  const attachments = [];
  blocks.forEach((block) => {
    const type = String(block?.type || "");
    if (!type.startsWith("tcloud")) return;
    const data = block?.data && typeof block.data === "object" ? block.data : {};
    const path = String(data.path || "").trim();
    if (!path) return;
    const kind = String(data.kind || "").trim().toLowerCase() || "file";
    const key = `${kind}:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push({
      path,
      name: String(data.name || "").trim(),
      mime: String(data.mime || "").trim(),
      size: Number(data.size || 0) || 0,
      kind,
    });
  });
  return attachments;
}

function attachmentKey(attachment) {
  const path = String(attachment?.path || "").trim();
  if (!path) return "";
  const kind = String(attachment?.kind || "file").trim().toLowerCase() || "file";
  return `${kind}:${path}`;
}

function removedAttachments(previousContent, nextContent) {
  const previous = extractAttachmentsFromContent(previousContent);
  const nextKeys = new Set(extractAttachmentsFromContent(nextContent).map(attachmentKey));
  return previous.filter((attachment) => {
    const key = attachmentKey(attachment);
    return key && !nextKeys.has(key);
  });
}

async function deleteRemovedAttachments(attachments) {
  const targets = Array.isArray(attachments) ? attachments.filter((attachment) => attachment?.path) : [];
  if (!targets.length) return;
  await Promise.all(targets.map((attachment) => state.api.deleteFile(attachment.path)));
}

function sanitizeContentForSave(content) {
  const normalized = normalizeEditorData(content);
  const filteredBlocks = (Array.isArray(normalized.blocks) ? normalized.blocks : []).filter((block) => {
    const type = String(block?.type || "");
    if (!type.startsWith("tcloud")) return true;
    const path = String(block?.data?.path || "").trim();
    return Boolean(path);
  });
  return {
    ...normalized,
    blocks: filteredBlocks.length ? filteredBlocks : [buildBlock("paragraph", { text: "" })],
  };
}

async function syncEditorAttachmentsPreview() {
  if (!state.editor || !state.currentNote) return;
  try {
    const content = sanitizeContentForSave(await state.editor.save());
    state.attachments = extractAttachmentsFromContent(content);
    if (state.currentNote) state.currentNote.attachments = state.attachments;
    renderHeaderMeta();
  } catch (error) {
    console.warn("Falha ao sincronizar anexos locais", error);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function currentQuery() {
  return els.searchInput.value.trim();
}

function currentDeletedFilter() {
  return state.filters.view === "trash" ? "only" : "active";
}

function currentFavoriteFilter() {
  return state.filters.view === "favorites";
}

function currentArchivedFilter() {
  if (state.filters.view === "archived") return "only";
  if (state.filters.view === "trash") return "all";
  return "exclude";
}

function listSummaryText() {
  const pieces = [];
  if (state.filters.view === "favorites") pieces.push("Favoritas");
  else if (state.filters.view === "archived") pieces.push("Arquivadas");
  else if (state.filters.view === "trash") pieces.push("Lixeira");
  else pieces.push("Minhas Notas");

  if (state.filters.tag) pieces.push(`#${state.filters.tag}`);
  const count = state.notes.length;
  const countLabel = count === 1 ? "1 nota" : `${count} notas`;
  if (state.lastLoadedQuery) {
    return `${pieces.join(" • ")} • ${countLabel} na busca`;
  }
  return `${pieces.join(" • ")} • ${countLabel}`;
}

function formatAbsoluteDate(isoValue) {
  if (!isoValue) return "Agora";
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "Agora";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function formatRelativeElapsed(timestamp) {
  if (!timestamp) return "Salvo agora";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "Salvo agora";
  if (seconds < 60) return `Salvo ha ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Salvo ha ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  return `Salvo ha ${hours}h`;
}

function setSaveState(mode, extra = {}) {
  state.saveState = {
    mode,
    at: extra.at || state.saveState.at || 0,
    error: extra.error || "",
  };
  renderSaveStatus();
}

function currentSaveStatusText() {
  if (state.saveState.mode === "saving") return "Salvando...";
  if (state.saveState.mode === "pending") return "Alterações pendentes";
  if (state.saveState.mode === "error") return "Erro ao salvar";
  if (state.saveState.mode === "saved") return formatRelativeElapsed(state.saveState.at);
  return "Pronto";
}

function hasShellWindowActions() {
  return window.parent !== window && typeof window.TCloudApp?.setWindowActions === "function";
}

function findNoteById(noteId) {
  return state.notes.find((note) => note.id === noteId)
    || (state.currentNote?.id === noteId ? state.currentNote : null);
}

function currentMenuContext(note, extra = {}) {
  return getNoteContext(note, {
    view: state.filters.view,
    notes: state.notes,
    selectedNoteIds: state.selectedNoteIds,
    compactWindow: state.ui.compactWindow,
    ...extra,
  });
}

function publishWindowActions() {
  if (!hasShellWindowActions()) return;

  const selectedCount = state.selectedNoteIds?.size || 0;
  const isCompactWindow = Boolean(state.ui.compactWindow);
  if (selectedCount > 1) {
    const actions = [
      {
        id: "sidebar.toggle",
        label: "Sidebar",
        icon: "ph-sidebar",
        pressed: !state.ui.sidebarCollapsed,
      },
      ...buildBulkSelectionActions(currentMenuContext(null, { compactWindow: isCompactWindow })),
    ];

    window.TCloudApp?.setWindowActions?.({
      statusText: isCompactWindow ? `${selectedCount} selecionadas` : `${selectedCount} notas selecionadas`,
      actions,
    });
    return;
  }

  const hasNote = Boolean(state.currentNote);
  const noteContext = currentMenuContext(state.currentNote);
  const trashed = noteContext.noteTrashed;
  const moreItems = buildEditorMoreActions(state.currentNote, noteContext);
  const actions = [
    {
      id: "sidebar.toggle",
      label: "Sidebar",
      icon: "ph-sidebar",
      pressed: !state.ui.sidebarCollapsed,
    },
    {
      id: "export.open",
      label: "Exportar",
      icon: "ph-export",
      variant: "primary",
      disabled: !hasNote,
    },
    {
      id: "share.open",
      label: "Compartilhar",
      icon: "ph-share-network",
      disabled: !hasNote || trashed,
    },
  ];
  if (moreItems.length) {
    actions.push({
      id: "more",
      label: "Mais",
      icon: "ph-dots-three",
      menuItems: moreItems,
    });
  }
  window.TCloudApp?.setWindowActions?.({
    statusText: currentSaveStatusText(),
    actions,
  });
}

function renderSaveStatus() {
  els.saveStatus?.classList.remove("is-error", "is-success");
  const statusText = currentSaveStatusText();
  if (state.saveState.mode === "saving") {
    if (els.saveStatus) els.saveStatus.textContent = statusText;
    publishWindowActions();
    return;
  }
  if (state.saveState.mode === "pending") {
    if (els.saveStatus) els.saveStatus.textContent = statusText;
    publishWindowActions();
    return;
  }
  if (state.saveState.mode === "error") {
    if (els.saveStatus) {
      els.saveStatus.textContent = statusText;
      els.saveStatus.classList.add("is-error");
    }
    publishWindowActions();
    return;
  }
  if (state.saveState.mode === "saved") {
    if (els.saveStatus) {
      els.saveStatus.textContent = statusText;
      els.saveStatus.classList.add("is-success");
    }
    publishWindowActions();
    return;
  }
  if (els.saveStatus) els.saveStatus.textContent = statusText;
  publishWindowActions();
}

function tickSaveStatus() {
  if (state.saveState.mode === "saved") renderSaveStatus();
}

function applyLayoutState() {
  els.app?.classList.toggle("sidebar-collapsed", Boolean(state.ui.sidebarCollapsed));
  els.app?.classList.toggle("is-compact-window", Boolean(state.ui.compactWindow));
  els.sidebarOpenButton?.setAttribute("aria-pressed", state.ui.sidebarCollapsed ? "false" : "true");
  els.sidebarToggleButton?.setAttribute("aria-expanded", state.ui.sidebarCollapsed ? "false" : "true");
  publishWindowActions();
}

function setSidebarCollapsed(collapsed) {
  state.ui.sidebarCollapsed = Boolean(collapsed);
  applyLayoutState();
}

function updateCompactWindowMode(width) {
  const nextCompact = Number(width || 0) > 0 && Number(width) < 820;
  if (state.ui.compactWindow === nextCompact) return;
  state.ui.compactWindow = nextCompact;
  applyLayoutState();
}

function setupCompactWindowObserver() {
  if (!els.app) return;
  if (typeof ResizeObserver === "undefined") {
    updateCompactWindowMode(els.app.getBoundingClientRect().width || window.innerWidth);
    window.addEventListener("resize", () => {
      updateCompactWindowMode(els.app.getBoundingClientRect().width || window.innerWidth);
    });
    return;
  }
  state.compactWindowObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect?.width || els.app.getBoundingClientRect().width;
    updateCompactWindowMode(width);
  });
  state.compactWindowObserver.observe(els.app);
}

function noteTagsLabel(note) {
  const tags = Array.isArray(note?.tags) ? note.tags : [];
  return tags.length ? tags.map((tag) => `#${tag}`).join(" ") : "Sem tags";
}

function renderHeaderMeta() {
  if (!state.currentNote) {
    els.noteMeta.textContent = "Nenhuma nota selecionada";
    return;
  }
  const pieces = [`v${state.currentNote.version || 1}`];
  if (!Array.isArray(state.currentNote.tags) || !state.currentNote.tags.length) pieces.push("Sem tags");
  if (state.currentNote.deleted_at) pieces.push("Na lixeira");
  if (state.currentNote.archived) pieces.push("Arquivada");
  if (state.currentNote.favorite) pieces.push("Favorita");
  els.noteMeta.textContent = pieces.join(" • ");
}

function renderEmptyState() {
  if (state.filters.view === "trash") {
    els.emptyEyebrow.textContent = "Lixeira";
    els.emptyTitle.textContent = "Notas excluidas aparecem aqui";
    els.emptyDescription.innerHTML = "Quando voce excluir uma nota, ela vai para a lixeira e podera ser restaurada depois.";
    els.emptyTemplateGrid.classList.add("hidden");
    return;
  }
  if (state.filters.view === "archived") {
    els.emptyEyebrow.textContent = "Arquivo";
    els.emptyTitle.textContent = "Notas arquivadas ficam fora do fluxo principal";
    els.emptyDescription.innerHTML = "Use esta area para revisar notas arquivadas e desarquivar quando quiser voltar a trabalhar nelas.";
    els.emptyTemplateGrid.classList.add("hidden");
    return;
  }
  if (state.filters.view === "favorites") {
    els.emptyEyebrow.textContent = "Favoritas";
    els.emptyTitle.textContent = "Nenhuma nota favorita";
    els.emptyDescription.innerHTML = "Marque uma nota com estrela para ela aparecer aqui.";
    els.emptyTemplateGrid.classList.add("hidden");
    return;
  }
  els.emptyEyebrow.textContent = "Notas";
  els.emptyTitle.textContent = "Crie sua primeira nota";
  els.emptyDescription.innerHTML = "Comece em branco ou use um template. Escreva, organize com tags e mantenha foco no conteúdo.";
  els.emptyTemplateGrid.classList.remove("hidden");
}

function setEditorVisibility(visible) {
  els.editorPanel.classList.toggle("hidden", !visible);
  els.emptyState.classList.toggle("hidden", visible);
  els.titleInput.disabled = !visible;
  els.favoriteButton.disabled = !visible;
  if (els.deleteButton) els.deleteButton.disabled = !visible;
  if (els.revisionsButton) els.revisionsButton.disabled = !visible;
  els.tagInput.disabled = !visible;
  if (els.restoreNoteButton) els.restoreNoteButton.disabled = !visible;
  if (els.archiveButton) els.archiveButton.disabled = !visible;
  if (els.exportButton) els.exportButton.disabled = !visible;
  if (els.backupButton) els.backupButton.disabled = !visible;
  if (!visible) renderEmptyState();
  applyLayoutState();
}

function renderActiveFilterTabs() {
  els.filterAll.classList.toggle("is-active", state.filters.view === "active");
  els.filterFavorites.classList.toggle("is-active", state.filters.view === "favorites");
  els.filterArchived.classList.toggle("is-active", state.filters.view === "archived");
  els.filterTrash.classList.toggle("is-active", state.filters.view === "trash");
}

function renderNoteTags() {
  els.noteTags.innerHTML = "";
  const tags = Array.isArray(state.currentNote?.tags) ? state.currentNote.tags : [];
  tags.forEach((tag) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.innerHTML = `<span>#${escapeHtml(tag)}</span>`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remover tag ${tag}`);
    remove.innerHTML = '<i class="ph ph-x"></i>';
    remove.addEventListener("click", () => removeTag(tag));
    chip.appendChild(remove);
    els.noteTags.appendChild(chip);
  });
}

function renderNotesList() {
  els.notesList.innerHTML = "";
  els.listMeta.textContent = listSummaryText();
  renderActiveFilterTabs();
  if (!state.notes.length) {
    const empty = document.createElement("div");
    empty.className = "notes-list-empty";
    empty.textContent = state.filters.view === "trash"
      ? "A lixeira esta vazia."
      : state.filters.view === "favorites"
        ? "Nenhuma nota favorita ainda."
      : state.lastLoadedQuery || state.filters.tag || state.filters.view === "favorites" || state.filters.view === "archived"
        ? "Nenhuma nota corresponde aos filtros atuais."
        : "Nenhuma nota ainda. Crie a primeira pela barra lateral.";
    els.notesList.appendChild(empty);
    return;
  }

  state.notes.forEach((note) => {
    const isSelected = state.selectedNoteIds.has(note.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `note-card${note.id === state.currentNoteId ? " is-active" : ""}${isSelected ? " is-selected" : ""}`;
    button.dataset.id = note.id;
    button.setAttribute("role", "listitem");
    const tags = Array.isArray(note.tags) ? note.tags.slice(0, 3) : [];
    const preview = notePreviewText(note);
    const stateLabels = noteStateLabels(note);
    button.innerHTML = `
      <div class="note-card-top">
        <div class="note-card-title-container">
          <input type="checkbox" class="note-card-checkbox" ${isSelected ? "checked" : ""}>
          <span class="note-card-title">${escapeHtml(note.title || "Sem título")}</span>
        </div>
        ${note.favorite ? '<span class="note-card-favorite" aria-hidden="true">★</span>' : ""}
      </div>
      <span class="note-card-excerpt">${escapeHtml(preview)}</span>
      ${stateLabels.length ? `<div class="advanced-list-row-meta">${stateLabels.map((label) => `<span class="advanced-list-row-label">${escapeHtml(label)}</span>`).join("")}</div>` : ""}
      <div class="note-card-bottom">
        <div class="note-card-tags">
          ${tags.map((tag) => `<span class="note-card-tag">#${escapeHtml(tag)}</span>`).join("")}
          ${note.archived ? '<span class="note-card-badge is-archived">Arquivada</span>' : ""}
          ${note.deleted_at ? '<span class="note-card-badge is-trash">Lixeira</span>' : ""}
        </div>
      </div>
    `;

    const checkbox = button.querySelector(".note-card-checkbox");
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleNoteSelection(note.id);
    });

    button.addEventListener("click", (event) => {
      const isCmdOrCtrl = event.metaKey || event.ctrlKey;
      const isShift = event.shiftKey;
      if (isCmdOrCtrl) {
        event.preventDefault();
        toggleNoteSelection(note.id);
      } else if (isShift) {
        event.preventDefault();
        selectNoteRange(note.id);
      } else {
        state.selectedNoteIds.clear();
        state.selectedNoteIds.add(note.id);
        state.lastClickedNoteId = note.id;
        openNote(note.id).then(() => {
          if (window.matchMedia("(max-width: 860px)").matches) setSidebarCollapsed(true);
        }).catch(handleUnexpectedError);
      }
    });

    els.notesList.appendChild(button);
  });
}

function renderTemplateGrid(container) {
  container.innerHTML = "";
  TEMPLATES.forEach((template) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "template-card";
    button.innerHTML = `
      <span class="template-card-title">${escapeHtml(template.label)}</span>
      <span class="template-card-desc">${escapeHtml(template.description)}</span>
    `;
    button.addEventListener("click", () => createNoteFromTemplate(template.id).catch(handleUnexpectedError));
    container.appendChild(button);
  });
}

function renderExportPreview() {
  if (!state.currentNote) {
    els.exportPreview.textContent = "Selecione uma nota para habilitar a exportação.";
    return;
  }
  const markdown = blocksToMarkdownPreview(state.currentNote.content?.blocks || []).slice(0, 260);
  els.exportPreview.innerHTML = `
    <strong>${escapeHtml(state.currentNote.title || "Sem título")}</strong><br>
    <span class="export-preview-code">${escapeHtml(markdown || "Nota vazia")}</span>
  `;
}

function setCurrentNote(note) {
  state.currentNote = note;
  state.currentNoteId = note?.id || "";
  state.attachments = Array.isArray(note?.attachments) ? note.attachments : [];
  els.titleInput.value = note?.title || "";
  els.favoriteButton.classList.toggle("is-active", Boolean(note?.favorite));
  els.favoriteButton.setAttribute("aria-pressed", note?.favorite ? "true" : "false");
  els.favoriteButton.innerHTML = note?.favorite ? '<i class="ph-fill ph-star"></i>' : '<i class="ph ph-star"></i>';
  renderAppearance();
  renderNoteTags();
  renderHeaderMeta();
  renderExportPreview();

  if (!note) {
    els.deleteButton?.classList.add("hidden");
    els.restoreNoteButton?.classList.add("hidden");
    els.archiveButton?.classList.add("hidden");
    publishWindowActions();
    return;
  }

  const noteContext = currentMenuContext(note);
  const trashed = noteContext.noteTrashed;
  const archived = noteContext.noteArchived;
  els.favoriteButton?.classList.toggle("hidden", trashed);
  els.deleteButton?.classList.toggle("hidden", trashed);
  els.restoreNoteButton?.classList.toggle("hidden", !trashed);
  els.archiveButton?.classList.toggle("hidden", trashed);
  if (els.archiveButton) els.archiveButton.textContent = archived ? "Desarquivar" : "Arquivar";
  publishWindowActions();
}

async function loadNotes({ preserveSelection = true } = {}) {
  const requestId = ++state.currentListRequestId;

  if (!preserveSelection) {
    state.selectedNoteIds.clear();
    state.lastClickedNoteId = null;
    state.currentOpenNoteRequestId++; // Invalidate pending openNote calls
    updateSelectionUI();
  }

  try {
    const response = await state.api.list({
      query: currentQuery(),
      limit: 100,
      favorite: currentFavoriteFilter(),
      tag: state.filters.tag,
      deleted: currentDeletedFilter(),
      archived: currentArchivedFilter(),
    });
    if (requestId !== state.currentListRequestId) return;

    state.notes = Array.isArray(response.notes) ? response.notes : [];
    state.lastLoadedQuery = currentQuery();

    // Keep only selected notes that are still in the loaded notes list
    const currentNoteIds = new Set(state.notes.map((n) => n.id));
    state.selectedNoteIds.forEach((id) => {
      if (!currentNoteIds.has(id)) {
        state.selectedNoteIds.delete(id);
      }
    });

    renderNotesList();

    if (!state.notes.length) {
      state.selectedNoteIds.clear();
      state.currentNoteId = "";
      setCurrentNote(null);
      setEditorVisibility(false);
      updateSelectionUI();
      return;
    }

    if (state.selectedNoteIds.size > 1) {
      updateSelectionUI();
      return;
    }

    // Fallback to single note selection if 0 or 1 notes are selected
    const desiredId = preserveSelection ? (Array.from(state.selectedNoteIds)[0] || state.currentNoteId) : "";
    const nextNote = state.notes.find((note) => note.id === desiredId) || state.notes[0];

    state.selectedNoteIds.clear();
    state.selectedNoteIds.add(nextNote.id);

    if (!state.currentNote || state.currentNote.id !== nextNote.id) {
      if (requestId !== state.currentListRequestId) return;
      await openNote(nextNote.id, { skipPendingSave: true });
    } else {
      if (requestId !== state.currentListRequestId) return;
      setCurrentNote({ ...state.currentNote, ...nextNote });
      updateSelectionUI();
    }
  } catch (error) {
    if (requestId === state.currentListRequestId) {
      handleUnexpectedError(error);
    }
  }
}

function toggleNoteSelection(noteId) {
  if (state.selectedNoteIds.has(noteId)) {
    state.selectedNoteIds.delete(noteId);
  } else {
    state.selectedNoteIds.add(noteId);
    state.lastClickedNoteId = noteId;
  }
  updateSelectionUI();
}

function selectNoteRange(noteId) {
  if (!state.lastClickedNoteId) {
    toggleNoteSelection(noteId);
    return;
  }
  const ids = state.notes.map((n) => n.id);
  const startIdx = ids.indexOf(state.lastClickedNoteId);
  const endIdx = ids.indexOf(noteId);
  if (startIdx === -1 || endIdx === -1) {
    toggleNoteSelection(noteId);
    return;
  }
  const min = Math.min(startIdx, endIdx);
  const max = Math.max(startIdx, endIdx);
  for (let i = min; i <= max; i++) {
    state.selectedNoteIds.add(ids[i]);
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const selectedCount = state.selectedNoteIds.size;
  const useShellActions = hasShellWindowActions();
  
  // 2. Controlar visibilidade do editor e do painel de lote
  if (selectedCount > 1) {
    els.editorPanel.classList.add("hidden");
    els.emptyState.classList.add("hidden");
    els.bulkState.classList.toggle("hidden", useShellActions);

    document.getElementById("bulk-title").textContent = `${selectedCount} notas selecionadas`;
    if (!useShellActions) renderBulkPanelButtons();
  } else {
    els.bulkState.classList.add("hidden");
    if (selectedCount === 1) {
      const singleId = Array.from(state.selectedNoteIds)[0];
      if (state.currentNoteId !== singleId) {
        openNote(singleId).catch(handleUnexpectedError);
      } else {
        setEditorVisibility(true);
      }
    } else {
      state.currentNoteId = "";
      setCurrentNote(null);
      setEditorVisibility(false);
    }
  }

  // 1. Atualizar estilos e checkboxes dos cards
  const cards = els.notesList.querySelectorAll(".note-card");
  cards.forEach((card) => {
    const id = card.dataset.id;
    const isSelected = state.selectedNoteIds.has(id);
    const isActive = (state.currentNoteId === id);
    card.classList.toggle("is-selected", isSelected);
    card.classList.toggle("is-active", isActive);
    const cb = card.querySelector(".note-card-checkbox");
    if (cb) cb.checked = isSelected;
  });

  // 3. Atualizar Window Actions (Menu Auxiliar)
  publishWindowActions();
}

function renderBulkPanelButtons() {
  const favBtn = document.getElementById("bulk-fav-btn");
  const arcBtn = document.getElementById("bulk-arc-btn");
  const delBtn = document.getElementById("bulk-del-btn");
  const rstBtn = document.getElementById("bulk-rst-btn");
  const purgeBtn = document.getElementById("bulk-purge-btn");
  const actionById = new Map(buildBulkSelectionActions(currentMenuContext(null, { compactWindow: false })).map((action) => [action.id, action]));
  const visible = (button, actionId) => button?.classList.toggle("hidden", !actionById.has(actionId));

  visible(favBtn, "bulk-favorite.run");
  visible(arcBtn, "bulk-archive.run");
  visible(delBtn, "bulk-delete.run");
  visible(rstBtn, "bulk-restore.run");
  visible(purgeBtn, "bulk-purge.run");

  const favAction = actionById.get("bulk-favorite.run");
  if (favBtn && favAction) {
    favBtn.querySelector(".label-text").textContent = favAction.label;
    favBtn.querySelector("i").className = favAction.label === "Desfavoritar" ? "ph-fill ph-star" : "ph ph-star";
  }

  const archiveAction = actionById.get("bulk-archive.run");
  if (arcBtn && archiveAction) {
    arcBtn.querySelector(".label-text").textContent = archiveAction.label;
    arcBtn.querySelector("i").className = `ph ${archiveAction.icon}`;
  }
}

async function handleBulkAction(command) {
  const selectedIds = Array.from(state.selectedNoteIds);
  if (!selectedIds.length && command !== "bulk-clear.run") return;

  if (command === "bulk-clear.run") {
    state.selectedNoteIds.clear();
    state.lastClickedNoteId = null;
    state.currentOpenNoteRequestId++; // Invalidate pending openNote calls
    updateSelectionUI();
    return;
  }

  if (command === "bulk-delete.run") {
    askConfirmation({
      eyebrow: "Ação em lote",
      title: "Mover notas para a lixeira?",
      description: `Deseja mover ${selectedIds.length} notas para a lixeira? Elas poderão ser restauradas depois.`,
      acceptLabel: "Mover para lixeira",
      acceptKind: "danger",
      onAccept: async () => {
        setSaveState("saving");
        await Promise.all(selectedIds.map((id) => state.api.remove(id)));
        showToast(`${selectedIds.length} notas enviadas para a lixeira.`, "info");
        state.selectedNoteIds.clear();
        await loadNotes({ preserveSelection: false });
        setSaveState("saved", { at: Date.now() });
      },
    });
    return;
  }

  if (command === "bulk-restore.run") {
    setSaveState("saving");
    await Promise.all(selectedIds.map((id) => state.api.restore(id)));
    showToast(`${selectedIds.length} notas restauradas.`, "success");
    state.selectedNoteIds.clear();
    state.filters.view = "active";
    await loadNotes({ preserveSelection: false });
    setSaveState("saved", { at: Date.now() });
    return;
  }

  if (command === "bulk-purge.run") {
    askConfirmation({
      eyebrow: "Exclusão definitiva",
      title: "Excluir definitivamente?",
      description: `Excluir definitivamente ${selectedIds.length} notas? Esta ação não pode ser desfeita.`,
      acceptLabel: "Excluir definitivamente",
      acceptKind: "danger",
      onAccept: async () => {
        setSaveState("saving");
        const response = await state.api.bulkPurge(selectedIds);
        const deletedCount = Number(response.deleted_count || response.result?.deleted_count || 0);
        const skipped = response.skipped || response.result?.skipped || [];
        if (state.currentNoteId && selectedIds.includes(state.currentNoteId)) {
          state.currentNoteId = "";
          setCurrentNote(null);
        }
        state.selectedNoteIds.clear();
        await loadNotes({ preserveSelection: false });
        showToast(
          skipped.length
            ? `${deletedCount} notas excluídas definitivamente; ${skipped.length} não foram excluídas.`
            : `${deletedCount} notas excluídas definitivamente.`,
          skipped.length ? "info" : "success",
        );
        setSaveState("saved", { at: Date.now() });
      },
    });
    return;
  }

  if (command === "bulk-favorite.run") {
    setSaveState("saving");
    const anyFav = selectedIds.some((id) => {
      const n = state.notes.find((x) => x.id === id);
      return n && n.favorite;
    });
    const targetFav = !anyFav;
    await Promise.all(selectedIds.map((id) => state.api.update(id, { favorite: targetFav })));
    showToast(targetFav ? `${selectedIds.length} notas favoritadas.` : `${selectedIds.length} notas desfavoritadas.`, "success");
    state.selectedNoteIds.clear();
    await loadNotes({ preserveSelection: true });
    setSaveState("saved", { at: Date.now() });
    return;
  }

  if (command === "bulk-archive.run") {
    setSaveState("saving");
    const isArchived = state.filters.view === "archived";
    const targetArchived = !isArchived;
    await Promise.all(selectedIds.map((id) => state.api.update(id, { archived: targetArchived })));
    showToast(targetArchived ? `${selectedIds.length} notas arquivadas.` : `${selectedIds.length} notas desarquivadas.`, "success");
    state.selectedNoteIds.clear();

    if (targetArchived && state.filters.view === "active") {
      await loadNotes({ preserveSelection: false });
    } else if (!targetArchived && state.filters.view === "archived") {
      state.filters.view = "active";
      await loadNotes({ preserveSelection: false });
    } else {
      await loadNotes({ preserveSelection: true });
    }
    setSaveState("saved", { at: Date.now() });
    return;
  }
}

function findTemplate(templateId) {
  return TEMPLATES.find((template) => template.id === templateId) || TEMPLATES[0];
}

async function createNoteFromTemplate(templateId = "blank") {
  await flushPendingSave();
  const template = findTemplate(templateId);
  setSaveState("saving");
  const response = await state.api.create({ title: template.title, content: template.content });
  setSaveState("saved", { at: Date.now() });
  els.searchInput.value = "";
  state.filters.view = "active";
  closeModal();
  await loadNotes({ preserveSelection: false });
  if (response.note?.id) await openNote(response.note.id, { skipPendingSave: true });
  showToast(`Nota criada com template "${template.label}".`, "success");
}

async function createBlankNote() {
  await createNoteFromTemplate("blank");
}

async function duplicateCurrentNote() {
  if (!state.currentNote || state.currentNote.deleted_at) return;
  await flushPendingSave();
  const duplicatedTitle = state.currentNote.title?.trim() ? `${state.currentNote.title} (cópia)` : "Sem título (cópia)";
  setSaveState("saving");
  const created = await state.api.create({
    title: duplicatedTitle,
    content: sanitizeContentForSave(state.currentNote.content),
    properties: { ...(state.currentNote.properties || {}) },
  });
  const duplicateId = created.note?.id;
  if (!duplicateId) throw new Error("Não foi possível duplicar a nota.");
  await state.api.update(duplicateId, {
    tags: Array.isArray(state.currentNote.tags) ? [...state.currentNote.tags] : [],
    archived: false,
    favorite: false,
    cover: state.currentNote.cover || currentAppearance().cover,
    icon: state.currentNote.icon || currentAppearance().icon,
    properties: { ...(state.currentNote.properties || {}) },
  });
  state.filters.view = "active";
  await loadNotes({ preserveSelection: false });
  await openNote(duplicateId, { skipPendingSave: true });
  setSaveState("saved", { at: Date.now() });
  showToast("Nota duplicada.", "success");
}

async function copyCurrentNoteLink() {
  if (!state.currentNote?.id) return;
  await copyToClipboard(buildCurrentNoteUrl(state.currentNote.id));
  showToast("Link da nota copiado.", "success");
}

function openShareDialog() {
  if (!state.currentNote?.id) return;
  const url = buildCurrentNoteUrl(state.currentNote.id);
  askConfirmation({
    eyebrow: "Compartilhar",
    title: "Link da nota",
    description: url,
    acceptLabel: "Copiar link",
    acceptKind: "primary",
    onAccept: async () => {
      await copyToClipboard(url);
      showToast("Link da nota copiado.", "success");
    },
  });
}

function openNoteInfo() {
  if (!state.currentNote) return;
  const attachmentCount = Array.isArray(state.currentNote.attachments) ? state.currentNote.attachments.length : state.attachments.length;
  askConfirmation({
    eyebrow: "Informações",
    title: state.currentNote.title || "Sem título",
    description: `Criada: ${formatAbsoluteDate(state.currentNote.created_at)}\nAtualizada: ${formatAbsoluteDate(state.currentNote.updated_at)}\nVersão: v${state.currentNote.version || 1}\nTags: ${(state.currentNote.tags || []).join(", ") || "Sem tags"}\nAnexos: ${attachmentCount}`,
    acceptLabel: "Fechar",
    acceptKind: "primary",
  });
}

async function openNote(noteId, options = {}) {
  if (!noteId) return;
  hideFloatingSearch();
  if (!options.skipPendingSave) await flushPendingSave();

  const requestId = ++state.currentOpenNoteRequestId;

  state.loadingNote = true;
  state.currentNoteId = noteId;

  // Clear multi-selection state and ensure only the opened note is in selectedNoteIds
  state.selectedNoteIds.clear();
  state.selectedNoteIds.add(noteId);
  state.lastClickedNoteId = noteId;

  renderNotesList();
  setSaveState("saving");

  try {
    const response = await state.api.get(noteId, { includeDeleted: currentDeletedFilter() === "only" });
    if (requestId !== state.currentOpenNoteRequestId) return;

    state.dirtyTitle = false;
    state.dirtyContent = false;
    state.dirtyMeta = false;
    setCurrentNote(response.note);
    setEditorVisibility(true);
    await state.editor.render(sanitizeContentForSave(response.note.content), { isNewNote: true });
    if (requestId !== state.currentOpenNoteRequestId) return;

    syncNoteHash(response.note.id);
    document.querySelector(".editor-shell")?.scrollTo({ top: 0, left: 0 });
    state.loadingNote = false;

    updateSelectionUI();

    renderNotesList();
    setSaveState("saved", { at: Date.now() });
  } catch (error) {
    if (requestId === state.currentOpenNoteRequestId) {
      state.loadingNote = false;
      handleUnexpectedError(error);
    }
  }
}

function scheduleAutosave() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => saveCurrentNote().catch(handleUnexpectedError), AUTOSAVE_DELAY_MS);
}

function markDirty(kind) {
  if (!state.currentNote || state.loadingNote || state.currentNote.deleted_at) return;
  if (kind === "title") state.dirtyTitle = true;
  if (kind === "content") state.dirtyContent = true;
  if (kind === "meta") state.dirtyMeta = true;
  setSaveState("pending");
  scheduleAutosave();
}

function noteTagsForSave() {
  return Array.isArray(state.currentNote?.tags) ? state.currentNote.tags : [];
}

async function saveCurrentNote({ force = false } = {}) {
  if (!state.currentNote || state.loadingNote || state.isSaving || state.currentNote.deleted_at) return;
  if (!force && !state.dirtyTitle && !state.dirtyContent && !state.dirtyMeta) return;

  state.isSaving = true;
  window.clearTimeout(state.saveTimer);
  setSaveState("saving");

  // Snapshot dirty flags before async work begins.
  // New changes may set these flags again during the await calls below.
  const wasDirtyTitle = state.dirtyTitle;
  const wasDirtyContent = state.dirtyContent;
  const wasDirtyMeta = state.dirtyMeta;

  try {
    let response = null;
    let attachmentsToDelete = [];
    if ((force || wasDirtyContent) && !wasDirtyTitle && !wasDirtyMeta) {
      const nextContent = sanitizeContentForSave(await state.editor.save());
      attachmentsToDelete = removedAttachments(state.currentNote.content, nextContent);
      state.attachments = extractAttachmentsFromContent(nextContent);
      response = await state.api.updateContent(state.currentNote.id, nextContent);
    } else {
      const payload = {};
      if (force || wasDirtyTitle) payload.title = els.titleInput.value;
      if (force || wasDirtyMeta) {
        payload.favorite = Boolean(state.currentNote.favorite);
        payload.archived = Boolean(state.currentNote.archived);
        payload.cover = state.currentNote.cover || { type: "none", value: "" };
        payload.icon = state.currentNote.icon || { type: "none", value: "" };
        payload.tags = noteTagsForSave();
        payload.properties = { ...(state.currentNote.properties || {}) };
      }
      if (force || wasDirtyContent) {
        payload.content = sanitizeContentForSave(await state.editor.save());
        attachmentsToDelete = removedAttachments(state.currentNote.content, payload.content);
        state.attachments = extractAttachmentsFromContent(payload.content);
      }
      response = await state.api.update(state.currentNote.id, payload);
    }
    await deleteRemovedAttachments(attachmentsToDelete);
    // Only clear the flags that were captured at save start.
    // If markDirty was called during the async save, the flag will still be true.
    if (wasDirtyTitle) state.dirtyTitle = false;
    if (wasDirtyContent) state.dirtyContent = false;
    if (wasDirtyMeta) state.dirtyMeta = false;
    setCurrentNote(response.note);
    upsertNoteSummary(response.note);
    renderNotesList();
    if (response.saved_content || force || state.saveState.mode === "saving") {
      setSaveState("saved", { at: Date.now() });
    }
    // If new changes arrived during save, re-schedule autosave.
    if (state.dirtyTitle || state.dirtyContent || state.dirtyMeta) {
      scheduleAutosave();
    }
  } catch (error) {
    // Restore dirty flags on error so changes are not lost.
    if (wasDirtyTitle) state.dirtyTitle = true;
    if (wasDirtyContent) state.dirtyContent = true;
    if (wasDirtyMeta) state.dirtyMeta = true;
    setSaveState("error", { error: error.message || "Erro ao salvar" });
    throw error;
  } finally {
    state.isSaving = false;
  }
}

function upsertNoteSummary(note) {
  if (!note?.id) return;
  const summary = {
    id: note.id,
    title: note.title,
    excerpt: note.excerpt,
    version: note.version,
    favorite: note.favorite,
    archived: note.archived,
    cover: note.cover,
    icon: note.icon,
    tags: note.tags,
    properties: note.properties,
    outgoing_links: note.outgoing_links,
    backlinks: note.backlinks,
    attachments: note.attachments,
    created_at: note.created_at,
    updated_at: note.updated_at,
    deleted_at: note.deleted_at,
  };
  const index = state.notes.findIndex((item) => item.id === note.id);
  if (index >= 0) state.notes.splice(index, 1, summary);
  else state.notes.unshift(summary);
  state.notes.sort((left, right) => new Date(right.updated_at || 0) - new Date(left.updated_at || 0));
}

async function flushPendingSave() {
  if (state.dirtyTitle || state.dirtyContent || state.dirtyMeta) {
    await saveCurrentNote({ force: true });
  }
}

async function deleteCurrentNote() {
  if (!state.currentNote) return;
  askConfirmation({
    eyebrow: "Lixeira",
    title: "Mover nota para a lixeira?",
    description: `A nota "${state.currentNote.title || "Sem título"}" poderá ser restaurada depois.`,
    acceptLabel: "Mover para lixeira",
    acceptKind: "danger",
    onAccept: async () => {
      await flushPendingSave();
      setSaveState("saving");
      const deletedNoteId = state.currentNote.id;
      await state.api.remove(deletedNoteId);
      showToast("Nota enviada para a lixeira.", "info");
      state.filters.view = "trash";
      state.currentNoteId = deletedNoteId;
      await loadNotes({ preserveSelection: true });
      setSaveState("saved", { at: Date.now() });
    },
  });
}

async function restoreCurrentNote() {
  if (!state.currentNote) return;
  setSaveState("saving");
  const response = await state.api.restore(state.currentNote.id);
  showToast("Nota restaurada da lixeira.", "success");
  state.filters.view = "active";
  await loadNotes({ preserveSelection: false });
  if (response.note?.id) await openNote(response.note.id, { skipPendingSave: true });
  setSaveState("saved", { at: Date.now() });
}

async function purgeCurrentNote() {
  if (!state.currentNote?.deleted_at) return;
  askConfirmation({
    eyebrow: "Exclusão definitiva",
    title: "Excluir definitivamente esta nota?",
    description: "Excluir definitivamente esta nota? Esta ação não pode ser desfeita.",
    acceptLabel: "Excluir definitivamente",
    acceptKind: "danger",
    onAccept: async () => {
      setSaveState("saving");
      const purgedNoteId = state.currentNote.id;
      await state.api.purge(purgedNoteId);
      showToast("Nota excluída definitivamente.", "success");
      state.selectedNoteIds.delete(purgedNoteId);
      state.currentNoteId = "";
      setCurrentNote(null);
      await loadNotes({ preserveSelection: false });
      setSaveState("saved", { at: Date.now() });
    },
  });
}

function normalizeTagValue(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

function addTagFromInput() {
  if (!state.currentNote) return;
  const tag = normalizeTagValue(els.tagInput.value);
  els.tagInput.value = "";
  if (!tag) return;
  const existing = new Set((state.currentNote.tags || []).map((item) => item.toLowerCase()));
  if (existing.has(tag.toLowerCase())) return;
  state.currentNote.tags = [...(state.currentNote.tags || []), tag].slice(0, 12);
  renderNoteTags();
  renderHeaderMeta();
  markDirty("meta");
}

function removeTag(tagToRemove) {
  if (!state.currentNote) return;
  state.currentNote.tags = (state.currentNote.tags || []).filter((tag) => tag !== tagToRemove);
  renderNoteTags();
  renderHeaderMeta();
  markDirty("meta");
}

function revisionPreviewText(revision) {
  return String(revision?.content_excerpt || revision?.excerpt || "").trim();
}

function normalizeDiffWords(text) {
  return String(text || "").toLowerCase().split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function diffSummary(currentText, previousText) {
  const currentWords = normalizeDiffWords(currentText);
  const previousWords = normalizeDiffWords(previousText);
  const previousSet = new Set(previousWords);
  const currentSet = new Set(currentWords);
  const added = currentWords.filter((word) => !previousSet.has(word)).slice(0, 8);
  const removed = previousWords.filter((word) => !currentSet.has(word)).slice(0, 8);
  return {
    addedCount: Math.max(0, currentWords.length - previousWords.length),
    removedCount: Math.max(0, previousWords.length - currentWords.length),
    addedPreview: added.join(", "),
    removedPreview: removed.join(", "),
  };
}

function renderRevisionsSummary() {
  if (!state.revisions.length) {
    els.revisionsSummary.textContent = "Nenhuma revisao registrada ainda.";
    return;
  }
  const latest = state.revisions[0];
  els.revisionsSummary.innerHTML = `
    <strong>${state.revisions.length} revisoes registradas</strong>
    <span>Ultima snapshot: v${escapeHtml(latest.version)} em ${escapeHtml(formatAbsoluteDate(latest.saved_at))}.</span>
    <span>Restaurar uma versao cria uma nova revisao com motivo <strong>restore</strong>.</span>
  `;
}

async function toggleArchive() {
  if (!state.currentNote || state.currentNote.deleted_at) return;
  state.currentNote.archived = !state.currentNote.archived;
  setCurrentNote(state.currentNote);
  markDirty("meta");
  await saveCurrentNote({ force: true });

  if (state.currentNote.archived && state.filters.view === "active") {
    await loadNotes({ preserveSelection: false });
  } else if (!state.currentNote.archived && state.filters.view === "archived") {
    state.filters.view = "active";
    await loadNotes({ preserveSelection: false });
  } else {
    upsertNoteSummary(state.currentNote);
    renderNotesList();
  }
  showToast(state.currentNote.archived ? "Nota arquivada." : "Nota desarquivada.", "success");
}

async function openRevisionsModal() {
  if (!state.currentNote) return;
  await flushPendingSave();
  const response = await state.api.listRevisions(state.currentNote.id, { limit: 50 });
  state.revisions = Array.isArray(response.revisions) ? response.revisions : [];
  renderRevisionsSummary();
  renderRevisionsList();
  openModal("revisions");
}

function renderRevisionsList() {
  els.revisionsList.innerHTML = "";
  if (!state.revisions.length) {
    const empty = document.createElement("div");
    empty.className = "revisions-empty";
    empty.textContent = "Nenhuma revisao registrada ainda.";
    els.revisionsList.appendChild(empty);
    return;
  }

  state.revisions.forEach((revision) => {
    const liveSnapshot = state.currentNote ? {
      version: state.currentNote.version,
      title: state.currentNote.title,
      tags: state.currentNote.tags,
      content_excerpt: state.currentNote.excerpt,
    } : null;
    const compareTarget = state.revisions.find((item) => item.version === revision.version + 1) || liveSnapshot;
    const summary = diffSummary(revisionPreviewText(compareTarget), revisionPreviewText(revision));
    const titleChanged = compareTarget && compareTarget.title !== revision.title;
    const tagsChanged = compareTarget && JSON.stringify(compareTarget.tags || []) !== JSON.stringify(revision.tags || []);
    const card = document.createElement("div");
    card.className = "revision-card";
    card.innerHTML = `
      <div class="revision-top">
        <strong>${escapeHtml(revision.title || "Sem título")} • v${revision.version}</strong>
        <span class="revision-badge">${escapeHtml(revision.reason || "update")}</span>
      </div>
      <div class="revision-excerpt">${escapeHtml(revisionPreviewText(revision) || "Sem resumo.")}</div>
      <div class="revision-diff">
        <div class="revision-diff-line"><strong>Comparado com ${compareTarget ? `v${compareTarget.version}` : "o estado atual"}:</strong> +${summary.addedCount} palavras, -${summary.removedCount} palavras.</div>
        ${summary.addedPreview ? `<div class="revision-diff-line"><strong>Entrou:</strong> ${escapeHtml(summary.addedPreview)}</div>` : ""}
        ${summary.removedPreview ? `<div class="revision-diff-line"><strong>Saiu:</strong> ${escapeHtml(summary.removedPreview)}</div>` : ""}
        ${titleChanged ? `<div class="revision-diff-line"><strong>Título:</strong> mudou de "${escapeHtml(compareTarget.title || "")}" para "${escapeHtml(revision.title || "")}".</div>` : ""}
        ${tagsChanged ? `<div class="revision-diff-line"><strong>Tags:</strong> ${escapeHtml((revision.tags || []).join(", ") || "sem tags")}</div>` : ""}
      </div>
      <div class="revision-bottom">
        <span class="note-meta">${escapeHtml(formatAbsoluteDate(revision.saved_at))}</span>
      </div>
    `;
    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "secondary-button";
    restoreButton.innerHTML = '<i class="ph ph-arrow-counter-clockwise"></i> Restaurar esta versão';
    restoreButton.addEventListener("click", () => restoreRevision(revision.version).catch(handleUnexpectedError));
    card.querySelector(".revision-bottom").appendChild(restoreButton);
    els.revisionsList.appendChild(card);
  });
}

async function restoreRevision(version) {
  if (!state.currentNote) return;
  askConfirmation({
    eyebrow: "Histórico",
    title: `Restaurar a versao ${version}?`,
    description: "Isso substitui o estado atual da nota e cria uma nova revisao com motivo restore.",
    acceptLabel: "Restaurar versao",
    acceptKind: "primary",
    onAccept: async () => {
      setSaveState("saving");
      const response = await state.api.restoreRevision(state.currentNote.id, version);
      setCurrentNote(response.note);
      upsertNoteSummary(response.note);
      await state.editor.render(response.note.content, { isNewNote: true });
      state.dirtyTitle = false;
      state.dirtyContent = false;
      state.dirtyMeta = false;
      renderNotesList();
      setSaveState("saved", { at: Date.now() });
      await openRevisionsModal();
      showToast(`Versao ${version} restaurada.`, "success");
    },
  });
}

function openModal(name) {
  state.modal = name;
  els.templatesModal.classList.toggle("hidden", name !== "templates");
  els.revisionsModal.classList.toggle("hidden", name !== "revisions");
  els.importExportModal.classList.toggle("hidden", name !== "import-export");
  els.confirmModal.classList.toggle("hidden", name !== "confirm");
}

function closeModal() {
  state.modal = "";
  els.templatesModal.classList.add("hidden");
  els.revisionsModal.classList.add("hidden");
  els.importExportModal.classList.add("hidden");
  els.confirmModal.classList.add("hidden");
  state.pendingConfirmAction = null;
}

function noteViewportBounds() {
  const pageRect = document.querySelector(".note-page")?.getBoundingClientRect();
  const shellRect = document.querySelector(".editor-shell")?.getBoundingClientRect();
  const baseRect = pageRect || shellRect || els.editorHolder.getBoundingClientRect();
  return {
    left: Math.max(12, baseRect.left),
    top: Math.max(12, shellRect?.top ?? baseRect.top),
    right: Math.min(window.innerWidth - 12, baseRect.right),
    bottom: Math.min(window.innerHeight - 12, shellRect?.bottom ?? window.innerHeight - 12),
  };
}

function closestBlockRect(node) {
  if (!(node instanceof Node)) return null;
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const block = element?.closest?.(".ce-block, .editor-todo, .editor-quote, .editor-code, .tcloud-block-card");
  if (!block) return null;
  const rect = block.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  return rect;
}

function askConfirmation({ eyebrow = "Confirmacao", title, description, acceptLabel = "Confirmar", acceptKind = "danger", onAccept }) {
  state.pendingConfirmAction = typeof onAccept === "function" ? onAccept : null;
  els.confirmEyebrow.textContent = eyebrow;
  els.confirmTitle.textContent = title;
  els.confirmDescription.textContent = description;
  els.confirmAcceptButton.textContent = acceptLabel;
  els.confirmAcceptButton.className = acceptKind === "danger" ? "ghost-danger-button" : "primary-button";
  openModal("confirm");
}

async function runPendingConfirmAction() {
  const action = state.pendingConfirmAction;
  closeModal();
  if (action) await action();
}

function normalizeStr(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function matchOption(option, query) {
  const q = normalizeStr(query);
  const label = normalizeStr(option.label || "");
  const id = normalizeStr(option.id || "");
  const hint = normalizeStr(option.hint || "");
  return label.includes(q) || id.includes(q) || hint.includes(q);
}

function getSlashQuery() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  
  let text = "";
  let offset = 0;
  if (node.nodeType === Node.TEXT_NODE) {
    text = node.textContent;
    offset = range.startOffset;
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    text = node.textContent || "";
    offset = text.length;
  } else {
    return null;
  }
  
  const textBeforeCursor = text.substring(0, offset);
  const lastSlashIndex = textBeforeCursor.lastIndexOf("/");
  if (lastSlashIndex === -1) return null;
  
  return textBeforeCursor.substring(lastSlashIndex + 1);
}

function updateSlashMenuFilter() {
  if (!state.slashMenu.open) return;
  const query = getSlashQuery();
  if (query === null) {
    closeSlashMenu();
    return;
  }
  const filtered = SLASH_OPTIONS.filter(option => matchOption(option, query));
  state.slashMenu.filteredOptions = filtered;
  state.slashMenu.index = filtered.length > 0 ? 0 : -1;
  renderSlashMenu();
}

function openSlashMenu(position, replaceCurrent = true) {
  state.slashMenu.open = true;
  state.slashMenu.index = 0;
  state.slashMenu.replaceCurrent = replaceCurrent;
  state.slashMenu.filteredOptions = [...SLASH_OPTIONS];
  const bounds = noteViewportBounds();
  const left = clamp(position.x, bounds.left + 8, Math.max(bounds.left + 8, bounds.right - 340));
  const top = clamp(position.y, bounds.top + 8, Math.max(bounds.top + 8, bounds.bottom - 360));
  els.slashMenu.style.left = `${left}px`;
  els.slashMenu.style.top = `${top}px`;
  renderSlashMenu();
  els.slashMenu.classList.remove("hidden");
}

function closeSlashMenu() {
  state.slashMenu.open = false;
  state.slashMenu.filteredOptions = null;
  els.slashMenu.classList.add("hidden");
}

function renderSlashMenu() {
  els.slashMenu.innerHTML = "";
  const options = state.slashMenu.filteredOptions || SLASH_OPTIONS;
  if (options.length === 0) {
    const noResults = document.createElement("div");
    noResults.className = "slash-no-results";
    noResults.textContent = "Nenhum resultado encontrado";
    els.slashMenu.appendChild(noResults);
    return;
  }
  let lastGroup = "";
  options.forEach((option, index) => {
    if (option.group && option.group !== lastGroup) {
      const group = document.createElement("div");
      group.className = "slash-group";
      group.textContent = option.group;
      els.slashMenu.appendChild(group);
      lastGroup = option.group;
    }
    const button = document.createElement("button");
    button.type = "button";
    if (index === state.slashMenu.index) button.classList.add("is-active");
    button.innerHTML = `
      <span class="slash-icon" aria-hidden="true">${escapeHtml(option.icon || "")}</span>
      <span class="slash-copy">
        <span class="slash-label">${escapeHtml(option.label)}</span>
        <span class="slash-hint">${escapeHtml(option.hint)}</span>
      </span>
    `;
    button.addEventListener("click", () => applySlashOption(option).catch(handleUnexpectedError));
    els.slashMenu.appendChild(button);
  });
}

function attachmentKindToBlockType(kind) {
  return ATTACHMENT_BLOCKS[String(kind || "").toLowerCase()] || ATTACHMENT_BLOCKS.file;
}

async function openAttachmentPicker({ kinds = ["file", "image", "video", "audio", "pdf"], allowFolders = false, replaceCurrent = false, forcedType = "" } = {}) {
  const selection = await state.picker.open({
    title: allowFolders ? "Selecionar arquivo ou pasta" : "Selecionar arquivo do TCloud",
    filterKinds: kinds,
    allowFolders,
  });
  if (!selection) return;
  const type = forcedType || attachmentKindToBlockType(selection.kind);
  await state.editor.insertSlashBlock(type, selection, { replaceCurrent });
  await syncEditorAttachmentsPreview();
  markDirty("content");
}

async function chooseCoverImage() {
  if (!state.currentNote) return;
  const selection = await state.picker.open({
    title: "Escolher imagem de capa",
    filterKinds: ["image"],
    allowFolders: false,
  });
  if (!selection?.path) return;
  await setAppearancePatch({ cover: { type: "image", value: selection.path } }, "Capa atualizada.");
}

async function applyCoverAction(action) {
  closeCoverMenu();
  if (action === "image") {
    await chooseCoverImage();
    return;
  }
  const cover = COVER_PRESETS[action] || COVER_PRESETS.gradient;
  await setAppearancePatch({ cover }, action === "none" ? "Capa removida." : "Capa atualizada.");
  closeCoverMenu();
}

async function applyIconValue(value) {
  const normalized = String(value || "").trim();
  closeIconMenu();
  if (!normalized || normalized === "none") {
    await setAppearancePatch({ icon: { type: "none", value: "" } }, "Ícone removido.");
    return;
  }
  const type = normalized.length <= 2 ? "emoji" : "symbol";
  await setAppearancePatch({ icon: { type, value: normalized } }, "Ícone atualizado.");
}

async function applySlashOption(option) {
  const replaceCurrent = state.slashMenu.replaceCurrent;
  closeSlashMenu();
  if (option.picker) {
    await openAttachmentPicker({
      kinds: option.picker.kinds,
      allowFolders: Boolean(option.picker.allowFolders),
      replaceCurrent: replaceCurrent,
      forcedType: option.picker.blockType || "",
    });
  } else {
    await state.editor.insertSlashBlock(option.type, option.data, { replaceCurrent: replaceCurrent });
    markDirty("content");
  }
}

function selectionPosition() {
  const selection = window.getSelection();
  if (selection && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
    const rect = rects[rects.length - 1] || range.getBoundingClientRect();
    const blockRect = closestBlockRect(selection.anchorNode) || closestBlockRect(selection.focusNode);
    const bounds = noteViewportBounds();
    const anchorRect = rect && (rect.left || rect.top || rect.width || rect.height) ? rect : blockRect;
    if (anchorRect) {
      const xBase = anchorRect.left + Math.min(Math.max(anchorRect.width * 0.2, 18), 34);
      const yBase = anchorRect.bottom + 12;
      return {
        x: clamp(xBase, bounds.left + 12, Math.max(bounds.left + 12, bounds.right - 340)),
        y: clamp(yBase, bounds.top + 12, Math.max(bounds.top + 12, bounds.bottom - 360)),
      };
    }
  }
  const bounds = noteViewportBounds();
  return { x: bounds.left + 28, y: bounds.top + 96 };
}

function eventShouldOpenSlashMenu(event) {
  if (event.key !== "/" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !state.currentNote || state.currentNote.deleted_at) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest(".editorjs-host")) return false;
  const block = target.closest(".ce-block, .editor-todo, .editor-quote, .editor-code, .tcloud-block-card");
  if (!block) return false;
  if (target.tagName === "TEXTAREA") return false;
  return true;
}

function shouldOpenEditorContextMenu(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (!target.closest(".editorjs-host")) return false;
  if (target.closest("button, input, textarea, select")) return false;
  return Boolean(target.closest(".ce-block, .codex-editor__redactor, .editor-todo, .editor-quote, .editor-code, .tcloud-block-card"));
}

async function toggleFavorite() {
  if (!state.currentNote || state.currentNote.deleted_at || state.favoriteSaving) return;
  state.favoriteSaving = true;
  const noteId = state.currentNote.id;
  const previous = Boolean(state.currentNote.favorite);
  const nextFavorite = !previous;
  try {
    if (state.dirtyTitle || state.dirtyContent || state.dirtyMeta) {
      await flushPendingSave();
    }
    state.currentNote.favorite = nextFavorite;
    setCurrentNote(state.currentNote);
    upsertNoteSummary(state.currentNote);
    renderNotesList();
    setSaveState("saving");
    const response = await state.api.update(noteId, {
      favorite: nextFavorite,
      archived: Boolean(state.currentNote.archived),
      tags: noteTagsForSave(),
      properties: { ...(state.currentNote.properties || {}) },
    });
    state.dirtyMeta = false;
    setCurrentNote(response.note);
    upsertNoteSummary(response.note);
    if (state.filters.view === "favorites" && !response.note.favorite) {
      await loadNotes({ preserveSelection: false });
    } else {
      renderNotesList();
    }
    setSaveState("saved", { at: Date.now() });
    showToast(response.note.favorite ? "Nota adicionada às favoritas." : "Nota removida das favoritas.", "success");
  } catch (error) {
    if (state.currentNote?.id === noteId) {
      state.currentNote.favorite = previous;
      setCurrentNote(state.currentNote);
      upsertNoteSummary(state.currentNote);
      renderNotesList();
    }
    setSaveState("error", { error: error.message || "Erro ao favoritar" });
    throw error;
  } finally {
    state.favoriteSaving = false;
  }
}

function buildDirectStreamPath(path) {
  const rawPath = `/stream${String(path || "").split("/").map((part) => encodeURIComponent(part)).join("/").replaceAll("%2F", "/")}`;
  return state.api.authUrl(rawPath);
}

async function openAttachment(attachment) {
  if (!attachment?.path) return;
  if (attachment.kind === "folder") {
    revealAttachment(attachment);
    return;
  }
  if (attachment.kind === "pdf" || attachment.kind === "file") {
    window.open(buildDirectStreamPath(attachment.path), "_blank", "noopener");
    return;
  }
  if (["image", "video", "audio"].includes(String(attachment.kind || ""))) {
    window.open(buildDirectStreamPath(attachment.path), "_blank", "noopener");
    return;
  }
  revealAttachment(attachment);
}

function revealAttachment(attachment) {
  const rawPath = String(attachment?.path || "").trim();
  if (!rawPath) {
    showToast("Anexo sem caminho válido.", "error");
    return;
  }
  const normalized = rawPath.replace(/\/+$/, "") || "/";
  const revealPath = attachment.kind === "folder"
    ? normalized
    : normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/")) || "/"
      : "/";
  state.api.openPath(revealPath);
  if (attachment.kind !== "folder") {
    showToast(`Abrindo pasta do anexo: ${attachment.name || normalized.split("/").pop() || "arquivo"}.`, "info");
  }
}

async function resolveBlockPreview(data) {
  if (!data?.path) return null;
  const kind = String(data.kind || "").toLowerCase();
  if (kind === "folder" || kind === "file" || kind === "pdf") return null;
  if (kind === "image" && data.thumbnail_url) return { kind: "image", url: state.api.authUrl(data.thumbnail_url) };
  try {
    const url = await state.api.fetchThumbnail(data.path);
    if (url) return { kind: "thumbnail", url };
  } catch (error) {
    console.warn("Falha ao obter thumbnail", error);
  }
  if (kind === "image") return { kind: "image", url: buildDirectStreamPath(data.path) };
  return null;
}

async function openImportExportModal() {
  renderExportPreview();
  openModal("import-export");
}

async function pickerFromBlock(type, config = {}) {
  const selection = await state.picker.open({
    title: "Selecionar referencia do TCloud",
    filterKinds: Array.isArray(config.kinds) ? config.kinds : ["file", "image", "video", "audio", "pdf"],
    allowFolders: Boolean(config.allowFolders),
  });
  if (!selection) return null;
  const forcedType = type || attachmentKindToBlockType(selection.kind);
  return {
    ...selection,
    kind: selection.kind || String(forcedType).replace("tcloud", "").toLowerCase(),
  };
}

async function importSelectedFile() {
  const file = els.importFileInput.files?.[0];
  if (!file) throw new Error("Selecione um arquivo para importar.");
  if (!isSupportedImportFile(file.name)) throw new Error("Formato nao suportado para importacao.");
  const textContent = await readFileAsText(file);
  setSaveState("saving");
  const response = await state.api.importNote({ fileName: file.name, textContent });
  els.importFileInput.value = "";
  closeModal();
  await loadNotes({ preserveSelection: false });
  if (response.note?.id) await openNote(response.note.id, { skipPendingSave: true });
  showToast(`Arquivo "${file.name}" importado com sucesso.`, "success");
  setSaveState("saved", { at: Date.now() });
}

async function exportCurrentNote(format) {
  if (!state.currentNote) return;
  await flushPendingSave();
  await state.api.downloadExport(state.currentNote.id, format);
  showToast(`Exportacao ${format.toUpperCase()} concluida.`, "success");
}

async function backupCurrentNote() {
  if (!state.currentNote) return;
  await flushPendingSave();
  setSaveState("saving");
  const result = await state.api.backupNote(state.currentNote.id);
  showToast(`Backup salvo em ${result.path}.`, "success");
  setSaveState("saved", { at: Date.now() });
}

function handleUnexpectedError(error) {
  console.error(error);
  showToast(error.message || "Falha inesperada no TCloud Notes.", "error");
}

function handleWindowAction({ actionId, menuItemId } = {}) {
  const command = menuItemId || actionId;
  if (command && command.startsWith("bulk-")) {
    handleBulkAction(command).catch(handleUnexpectedError);
    return;
  }
  if (command === "sidebar.toggle") {
    setSidebarCollapsed(!state.ui.sidebarCollapsed);
    return;
  }
  if (command === "export.open" || command === "import.open") {
    openImportExportModal().catch(handleUnexpectedError);
    return;
  }
  if (command === "share.open") {
    openShareDialog();
    return;
  }
  if (command === "open-tab.run") {
    if (state.currentNoteId) window.open(`${window.location.origin}${window.location.pathname}#note=${state.currentNoteId}`, "_blank");
    return;
  }
  if (command === "favorite.run") {
    toggleFavorite().catch(handleUnexpectedError);
    return;
  }
  if (command === "duplicate.run") {
    duplicateCurrentNote().catch(handleUnexpectedError);
    return;
  }
  if (command === "archive.run") {
    toggleArchive().catch(handleUnexpectedError);
    return;
  }
  if (command === "copy-link.run") {
    copyCurrentNoteLink().catch(handleUnexpectedError);
    return;
  }
  if (command === "revisions.open") {
    openRevisionsModal().catch(handleUnexpectedError);
    return;
  }
  if (command === "info.open") {
    openNoteInfo();
    return;
  }
  if (command === "restore.run") {
    restoreCurrentNote().catch(handleUnexpectedError);
    return;
  }
  if (command === "purge.run") {
    purgeCurrentNote().catch(handleUnexpectedError);
    return;
  }
  if (command === "delete.run") {
    deleteCurrentNote().catch(handleUnexpectedError);
  }
}

function wireTemplateButtons() {
  renderTemplateGrid(els.templatesGrid);
  renderTemplateGrid(els.emptyTemplateGrid);
}

function wireEvents() {
  document.getElementById("bulk-fav-btn")?.addEventListener("click", () => handleBulkAction("bulk-favorite.run").catch(handleUnexpectedError));
  document.getElementById("bulk-arc-btn")?.addEventListener("click", () => handleBulkAction("bulk-archive.run").catch(handleUnexpectedError));
  document.getElementById("bulk-del-btn")?.addEventListener("click", () => handleBulkAction("bulk-delete.run").catch(handleUnexpectedError));
  document.getElementById("bulk-rst-btn")?.addEventListener("click", () => handleBulkAction("bulk-restore.run").catch(handleUnexpectedError));
  document.getElementById("bulk-purge-btn")?.addEventListener("click", () => handleBulkAction("bulk-purge.run").catch(handleUnexpectedError));
  document.getElementById("bulk-clear-btn")?.addEventListener("click", () => handleBulkAction("bulk-clear.run").catch(handleUnexpectedError));

  els.newNoteButton.addEventListener("click", () => createBlankNote().catch(handleUnexpectedError));
  els.sidebarToggleButton?.addEventListener("click", () => setSidebarCollapsed(true));
  els.sidebarOpenButton?.addEventListener("click", () => setSidebarCollapsed(!state.ui.sidebarCollapsed));
  els.templatesButton?.addEventListener("click", () => openModal("templates"));
  els.importButton?.addEventListener("click", () => openImportExportModal().catch(handleUnexpectedError));
  els.exportButton?.addEventListener("click", () => openImportExportModal().catch(handleUnexpectedError));
  els.backupButton?.addEventListener("click", () => backupCurrentNote().catch(handleUnexpectedError));
  els.deleteButton?.addEventListener("click", () => deleteCurrentNote().catch(handleUnexpectedError));
  els.restoreNoteButton?.addEventListener("click", () => restoreCurrentNote().catch(handleUnexpectedError));
  els.revisionsButton?.addEventListener("click", () => openRevisionsModal().catch(handleUnexpectedError));
  els.archiveButton?.addEventListener("click", () => toggleArchive().catch(handleUnexpectedError));
  els.favoriteButton.addEventListener("click", () => toggleFavorite().catch(handleUnexpectedError));
  document.querySelectorAll("[data-cover-action]").forEach((button) => {
    button.addEventListener("click", () => applyCoverAction(button.dataset.coverAction).catch(handleUnexpectedError));
  });
  els.noteCoverButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    const nextHidden = !els.noteCoverMenu?.classList.contains("hidden");
    closeIconMenu();
    if (els.noteCoverMenu) {
      els.noteCoverMenu.style.position = "";
      els.noteCoverMenu.style.left = "";
      els.noteCoverMenu.style.right = "";
      els.noteCoverMenu.style.top = "";
    }
    els.noteCoverMenu?.classList.toggle("hidden", nextHidden);
    els.noteCoverButton?.setAttribute("aria-expanded", nextHidden ? "false" : "true");
  });
  els.noteIconButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    const nextHidden = !els.noteIconMenu?.classList.contains("hidden");
    closeCoverMenu();
    els.noteIconMenu?.classList.toggle("hidden", nextHidden);
    els.noteIconButton?.setAttribute("aria-expanded", nextHidden ? "false" : "true");
  });
  els.importFileInput.setAttribute("accept", IMPORT_ACCEPT);
  els.importConfirmButton.addEventListener("click", () => importSelectedFile().catch(handleUnexpectedError));
  els.exportJsonButton.addEventListener("click", () => exportCurrentNote("json").catch(handleUnexpectedError));
  els.exportMarkdownButton.addEventListener("click", () => exportCurrentNote("markdown").catch(handleUnexpectedError));
  els.exportHtmlButton.addEventListener("click", () => exportCurrentNote("html").catch(handleUnexpectedError));

  els.filterAll.addEventListener("click", () => {
    state.filters.view = "active";
    loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
  });
  els.filterFavorites.addEventListener("click", () => {
    state.filters.view = "favorites";
    loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
  });
  els.filterArchived.addEventListener("click", () => {
    state.filters.view = "archived";
    loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
  });
  els.filterTrash.addEventListener("click", () => {
    state.filters.view = "trash";
    loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
  });

  els.searchInput.addEventListener("input", () => {
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      loadNotes({ preserveSelection: true }).catch(handleUnexpectedError);
    }, SEARCH_DELAY_MS);
  });

  els.titleInput.addEventListener("input", () => {
    if (state.currentNote) {
      state.currentNote.title = els.titleInput.value;
      renderHeaderMeta();
      renderExportPreview();
    }
    markDirty("title");
  });

  els.tagInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTagFromInput();
    }
  });
  els.tagInput.addEventListener("blur", () => addTagFromInput());

  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  els.confirmCancelButton.addEventListener("click", closeModal);
  els.confirmAcceptButton.addEventListener("click", () => runPendingConfirmAction().catch(handleUnexpectedError));

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const iconChoice = target.closest("[data-icon-value]");
    if (iconChoice) {
      event.preventDefault();
      applyIconValue(iconChoice.dataset.iconValue).catch(handleUnexpectedError);
      return;
    }
    if (state.slashMenu.open && !target.closest("#slash-menu")) closeSlashMenu();
    if (!target.closest("#note-icon-menu") && !target.closest("#note-icon-button")) closeIconMenu();
    if (!target.closest("#note-cover-menu") && !target.closest("#note-cover-button")) closeCoverMenu();
  });

  window.TCloudApp?.onWindowAction?.(handleWindowAction);
  window.TCloudApp?.ready?.().then(() => publishWindowActions()).catch(() => {});
  window.addEventListener("tcloud-app-session-changed", publishWindowActions);
  window.addEventListener("pageshow", publishWindowActions);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) publishWindowActions();
  });

  // Intercepta a tecla "/" na fase de captura para evitar que o EditorJS a processe e abra o popover nativo dele
  document.addEventListener("keydown", (event) => {
    if (eventShouldOpenSlashMenu(event)) {
      event.stopPropagation();
      event.stopImmediatePropagation();
      openSlashMenu(selectionPosition(), true);
    }
  }, true);

  document.addEventListener("input", () => {
    if (state.slashMenu.open) updateSlashMenuFilter();
  });

  document.addEventListener("keyup", (event) => {
    if (state.slashMenu.open && event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") {
      updateSlashMenuFilter();
    }
  });

  document.addEventListener("keydown", (event) => {
    const isCmdOrCtrl = event.metaKey || event.ctrlKey;
    const isInputTarget =
      event.target.tagName === "INPUT" ||
      event.target.tagName === "TEXTAREA" ||
      event.target.isContentEditable;
    const isEditorTarget = event.target.closest(".editor-shell") || event.target.closest(".codex-editor");
    const isEditorActive = state.currentNote && !state.currentNote.deleted_at;
    const isOtherInputFocused =
      (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.isContentEditable) &&
      !isEditorTarget;

    // Intercept Cmd/Ctrl + Z e Cmd/Ctrl + Y / Cmd/Ctrl + Shift + Z no Editor
    if (isEditorActive && !isOtherInputFocused && isCmdOrCtrl && state.editor) {
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          state.editor.redo().catch(handleUnexpectedError);
        } else {
          state.editor.undo().catch(handleUnexpectedError);
        }
        return;
      }
      if (key === "y") {
        event.preventDefault();
        event.stopPropagation();
        state.editor.redo().catch(handleUnexpectedError);
        return;
      }
    }

    if (isCmdOrCtrl && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrentNote({ force: true }).catch(handleUnexpectedError);
      return;
    }
    if (isCmdOrCtrl && event.key.toLowerCase() === "n") {
      event.preventDefault();
      createBlankNote().catch(handleUnexpectedError);
      return;
    }
    if (isCmdOrCtrl && event.key.toLowerCase() === "k") {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    if (isCmdOrCtrl && event.key.toLowerCase() === "f") {
      event.preventDefault();
      showFloatingSearch();
      return;
    }
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      state.filters.view = state.filters.view === "favorites" ? "active" : "favorites";
      loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
      return;
    }

    // Delete / Backspace para Sidebar
    if ((event.key === "Delete" || event.key === "Backspace") && !isInputTarget) {
      if (document.activeElement && (document.activeElement.closest(".sidebar") || document.activeElement.closest(".notes-list") || document.activeElement.closest(".note-card"))) {
        event.preventDefault();
        deleteCurrentNote().catch(handleUnexpectedError);
        return;
      }
    }

    // Tratar atalhos do Editor: C, X, V, Z
    if (isCmdOrCtrl && ["c", "x", "v", "z"].includes(event.key.toLowerCase())) {
      if (isInputTarget) {
        return;
      }

      const key = event.key.toLowerCase();

      if (isEditorTarget) {
        if (key === "c") {
          const selectedText = window.getSelection().toString();
          if (selectedText) {
            navigator.clipboard.writeText(selectedText).catch(() => {});
          }
        } else if (key === "x") {
          const selectedText = window.getSelection().toString();
          if (selectedText) {
            navigator.clipboard.writeText(selectedText).then(() => {
              document.execCommand("delete");
            }).catch(() => {});
          }
        } else if (key === "v") {
          navigator.clipboard.readText().then(text => {
            if (text && state.editor) {
              state.editor.insertSlashBlock("paragraph", { text }, { replaceCurrent: false }).catch(() => {});
            }
          }).catch(() => {});
        }
        return;
      }

      if (!isEditorTarget && state.currentNote) {
        if (key === "c") {
          event.preventDefault();
          const noteText = `${state.currentNote.title || "Sem título"}\n\n${state.currentNote.content || ""}`;
          navigator.clipboard.writeText(noteText).then(() => {
            showToast("Conteúdo da nota copiado.", "success");
          }).catch(() => {});
        } else if (key === "x") {
          event.preventDefault();
          const noteText = `${state.currentNote.title || "Sem título"}\n\n${state.currentNote.content || ""}`;
          navigator.clipboard.writeText(noteText).then(() => {
            showToast("Conteúdo da nota recortado.", "info");
            deleteCurrentNote().catch(handleUnexpectedError);
          }).catch(() => {});
        } else if (key === "v") {
          event.preventDefault();
          navigator.clipboard.readText().then(text => {
            if (text && state.editor) {
              state.editor.insertSlashBlock("paragraph", { text }, { replaceCurrent: false }).catch(() => {});
              showToast("Conteúdo colado no editor.", "success");
            }
          }).catch(() => {});
        }
        return;
      }
    }

    if (event.key === "Escape") {
      window.TCloudApp?.closeWindowMenus?.();
      if (state.floatingSearch.visible) {
        hideFloatingSearch();
        return;
      }
      if (state.slashMenu.open) {
        closeSlashMenu();
        return;
      }
      if (state.modal) closeModal();
      return;
    }

    if (state.slashMenu.open) {
      const options = state.slashMenu.filteredOptions || SLASH_OPTIONS;
      if (options.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          state.slashMenu.index = (state.slashMenu.index + 1) % options.length;
          renderSlashMenu();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          state.slashMenu.index = (state.slashMenu.index - 1 + options.length) % options.length;
          renderSlashMenu();
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (state.slashMenu.index >= 0 && state.slashMenu.index < options.length) {
            applySlashOption(options[state.slashMenu.index]).catch(handleUnexpectedError);
          }
        }
      }
      return;
    }
  });

  window.addEventListener("hashchange", () => {
    const noteId = readNoteIdFromHash();
    if (noteId && noteId !== state.currentNoteId) {
      openNote(noteId, { skipPendingSave: false }).catch(handleUnexpectedError);
    }
  });

  wireContextMenus();
  wireFloatingSearch();
}

async function toggleFavoriteForId(noteId) {
  if (state.favoriteSaving) return;
  const targetNote = state.notes.find(n => n.id === noteId) || (state.currentNote && state.currentNote.id === noteId ? state.currentNote : null);
  if (!targetNote || targetNote.deleted_at) return;

  state.favoriteSaving = true;
  const previous = Boolean(targetNote.favorite);
  const nextFavorite = !previous;
  
  try {
    if (state.currentNote && state.currentNote.id === noteId && (state.dirtyTitle || state.dirtyContent || state.dirtyMeta)) {
      await flushPendingSave();
    }
    targetNote.favorite = nextFavorite;
    if (state.currentNote && state.currentNote.id === noteId) {
      setCurrentNote(targetNote);
    }
    upsertNoteSummary(targetNote);
    renderNotesList();
    setSaveState("saving");
    
    const response = await state.api.update(noteId, {
      favorite: nextFavorite,
      archived: Boolean(targetNote.archived),
      tags: Array.isArray(targetNote.tags) ? targetNote.tags : [],
      properties: { ...(targetNote.properties || {}) },
    });
    
    if (state.currentNote && state.currentNote.id === noteId) {
      state.dirtyMeta = false;
      setCurrentNote(response.note);
    }
    upsertNoteSummary(response.note);
    if (state.filters.view === "favorites" && !response.note.favorite) {
      await loadNotes({ preserveSelection: false });
    } else {
      renderNotesList();
    }
    setSaveState("saved", { at: Date.now() });
    showToast(response.note.favorite ? "Nota adicionada às favoritas." : "Nota removida das favoritas.", "success");
  } catch (error) {
    targetNote.favorite = previous;
    if (state.currentNote && state.currentNote.id === noteId) {
      setCurrentNote(targetNote);
    }
    upsertNoteSummary(targetNote);
    renderNotesList();
    setSaveState("error", { error: error.message || "Erro ao favoritar" });
    throw error;
  } finally {
    state.favoriteSaving = false;
  }
}

async function duplicateNoteForId(noteId) {
  const targetNote = state.notes.find(n => n.id === noteId) || (state.currentNote && state.currentNote.id === noteId ? state.currentNote : null);
  if (!targetNote || targetNote.deleted_at) return;

  if (state.currentNote && state.currentNote.id === noteId) {
    await flushPendingSave();
  }
  const duplicatedTitle = targetNote.title?.trim() ? `${targetNote.title} (cópia)` : "Sem título (cópia)";
  setSaveState("saving");
  const created = await state.api.create({
    title: duplicatedTitle,
    content: sanitizeContentForSave(targetNote.content),
    properties: { ...(targetNote.properties || {}) },
  });
  const duplicateId = created.note?.id;
  if (!duplicateId) throw new Error("Não foi possível duplicar a nota.");
  await state.api.update(duplicateId, {
    tags: Array.isArray(targetNote.tags) ? [...targetNote.tags] : [],
    archived: false,
    favorite: false,
    cover: targetNote.cover || currentAppearance().cover,
    icon: targetNote.icon || currentAppearance().icon,
    properties: { ...(targetNote.properties || {}) },
  });
  state.filters.view = "active";
  await loadNotes({ preserveSelection: false });
  await openNote(duplicateId, { skipPendingSave: true });
  setSaveState("saved", { at: Date.now() });
  showToast("Nota duplicada.", "success");
}

async function deleteNoteForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || currentMenuContext(targetNote).noteTrashed) return;

  askConfirmation({
    eyebrow: "Lixeira",
    title: "Mover nota para a lixeira?",
    description: `A nota "${targetNote.title || "Sem título"}" poderá ser restaurada depois.`,
    acceptLabel: "Mover para lixeira",
    acceptKind: "danger",
    onAccept: async () => {
      if (state.currentNote && state.currentNote.id === noteId) {
        await flushPendingSave();
      }
      setSaveState("saving");
      await state.api.remove(noteId);
      showToast("Nota enviada para a lixeira.", "info");
      state.filters.view = "trash";
      state.currentNoteId = noteId;
      await loadNotes({ preserveSelection: true });
      setSaveState("saved", { at: Date.now() });
    },
  });
}

async function restoreNoteForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || !currentMenuContext(targetNote).noteTrashed) return;
  if (state.currentNote?.id === noteId) {
    await restoreCurrentNote();
    return;
  }
  setSaveState("saving");
  const response = await state.api.restore(noteId);
  showToast("Nota restaurada da lixeira.", "success");
  state.filters.view = "active";
  state.selectedNoteIds.delete(noteId);
  await loadNotes({ preserveSelection: false });
  if (response.note?.id) await openNote(response.note.id, { skipPendingSave: true });
  setSaveState("saved", { at: Date.now() });
}

async function purgeNoteForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || !currentMenuContext(targetNote).noteTrashed) return;
  askConfirmation({
    eyebrow: "Exclusão definitiva",
    title: "Excluir definitivamente esta nota?",
    description: "Excluir definitivamente esta nota? Esta ação não pode ser desfeita.",
    acceptLabel: "Excluir definitivamente",
    acceptKind: "danger",
    onAccept: async () => {
      setSaveState("saving");
      await state.api.purge(noteId);
      showToast("Nota excluída definitivamente.", "success");
      state.selectedNoteIds.delete(noteId);
      if (state.currentNoteId === noteId) {
        state.currentNoteId = "";
        setCurrentNote(null);
      }
      await loadNotes({ preserveSelection: false });
      setSaveState("saved", { at: Date.now() });
    },
  });
}

async function toggleArchiveForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || currentMenuContext(targetNote).noteTrashed) return;
  if (state.currentNote?.id === noteId) {
    await toggleArchive();
    return;
  }

  const targetArchived = !Boolean(targetNote.archived);
  setSaveState("saving");
  const response = await state.api.update(noteId, {
    archived: targetArchived,
    favorite: Boolean(targetNote.favorite),
    tags: Array.isArray(targetNote.tags) ? targetNote.tags : [],
    properties: { ...(targetNote.properties || {}) },
  });
  upsertNoteSummary(response.note);
  if (targetArchived && state.filters.view === "active") {
    await loadNotes({ preserveSelection: false });
  } else if (!targetArchived && state.filters.view === "archived") {
    state.filters.view = "active";
    await loadNotes({ preserveSelection: false });
  } else {
    renderNotesList();
  }
  setSaveState("saved", { at: Date.now() });
  showToast(targetArchived ? "Nota arquivada." : "Nota desarquivada.", "success");
}

async function copyNoteLinkForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || currentMenuContext(targetNote).noteTrashed) return;
  await copyToClipboard(buildCurrentNoteUrl(noteId));
  showToast("Link da nota copiado.", "success");
}

async function openRevisionsForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || currentMenuContext(targetNote).noteTrashed) return;
  if (state.currentNote?.id !== noteId) {
    await openNote(noteId, { skipPendingSave: false });
  }
  await openRevisionsModal();
}

function hideAllContextMenus() {
  els.sidebarContextMenu?.classList.add("hidden");
  els.editorContextMenu?.classList.add("hidden");
}

function renderContextMenuActions(menu, actions) {
  const list = menu?.querySelector(".context-menu-list");
  if (!list) return;
  list.innerHTML = "";
  actions.forEach((action) => {
    if (action.separatorBefore && list.children.length) {
      const divider = document.createElement("li");
      divider.className = "context-menu-divider";
      list.appendChild(divider);
    }
    const item = document.createElement("li");
    item.className = `context-menu-item${action.variant === "danger" ? " danger" : ""}`;
    item.dataset.action = action.id;
    item.textContent = action.label;
    list.appendChild(item);
  });
}

function executeNoteMenuAction(action, noteId) {
  if (!action || !noteId) return;
  if (action.startsWith("bulk-")) {
    handleBulkAction(action).catch(handleUnexpectedError);
    return;
  }
  if (action === "open-tab.run") {
    window.open(`${window.location.origin}${window.location.pathname}#note=${noteId}`, "_blank");
    return;
  }
  if (action === "favorite.run") {
    toggleFavoriteForId(noteId).catch(handleUnexpectedError);
    return;
  }
  if (action === "duplicate.run") {
    duplicateNoteForId(noteId).catch(handleUnexpectedError);
    return;
  }
  if (action === "archive.run") {
    toggleArchiveForId(noteId).catch(handleUnexpectedError);
    return;
  }
  if (action === "copy-link.run") {
    copyNoteLinkForId(noteId).catch(handleUnexpectedError);
    return;
  }
  if (action === "revisions.open") {
    openRevisionsForId(noteId).catch(handleUnexpectedError);
    return;
  }
  if (action === "restore.run") {
    restoreNoteForId(noteId).catch(handleUnexpectedError);
    return;
  }
  if (action === "purge.run") {
    purgeNoteForId(noteId).catch(handleUnexpectedError);
    return;
  }
  if (action === "delete.run") {
    deleteNoteForId(noteId).catch(handleUnexpectedError);
  }
}

function wireContextMenus() {
  document.addEventListener("contextmenu", (event) => {
    hideAllContextMenus();

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    let targetMenu = null;
    const noteCard = target.closest(".note-card");
    const isEditorClick = shouldOpenEditorContextMenu(target);

    if (target.closest("#note-cover")) {
      event.preventDefault();
      event.stopPropagation();
      hideAllContextMenus();
      openCoverMenuAt(event.clientX, event.clientY);
      return;
    }

    if (noteCard) {
      state.contextMenuTargetNoteId = noteCard.dataset.id;
      const targetNote = findNoteById(state.contextMenuTargetNoteId);
      const actions = buildNoteMenuActions(targetNote, currentMenuContext(targetNote, { compactWindow: false }));
      if (!actions.length) return;
      renderContextMenuActions(els.sidebarContextMenu, actions);
      targetMenu = els.sidebarContextMenu;
    } else if (isEditorClick) {
      targetMenu = els.editorContextMenu;
    }

    if (targetMenu) {
      event.preventDefault();
      targetMenu.classList.remove("hidden");

      const menuWidth = targetMenu.offsetWidth || 160;
      const menuHeight = targetMenu.offsetHeight || 160;
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      let posX = event.pageX;
      let posY = event.pageY;

      // Prevenir transbordo/overflow horizontal
      if (posX + menuWidth > windowWidth) {
        posX = windowWidth - menuWidth - 8;
      }
      // Prevenir transbordo/overflow vertical
      if (posY + menuHeight > windowHeight) {
        posY = windowHeight - menuHeight - 8;
      }

      targetMenu.style.left = `${posX}px`;
      targetMenu.style.top = `${posY}px`;
    }
  });

  // Fechamentos automáticos
  document.addEventListener("click", (event) => {
    if (event.button === 0) { // Clique esquerdo
      hideAllContextMenus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideAllContextMenus();
    }
  });

  document.addEventListener("scroll", () => {
    hideAllContextMenus();
  }, { capture: true, passive: true });

  // Event Listeners para Sidebar Context Menu
  els.sidebarContextMenu?.addEventListener("click", (event) => {
    const item = event.target.closest(".context-menu-item");
    if (!item) return;
    const action = item.dataset.action;
    const noteId = state.contextMenuTargetNoteId;
    if (!noteId) {
      hideAllContextMenus();
      return;
    }

    executeNoteMenuAction(action, noteId);
    hideAllContextMenus();
  });

  // Event Listeners para Editor Context Menu
  els.editorContextMenu?.addEventListener("click", (event) => {
    const item = event.target.closest(".context-menu-item");
    if (!item) return;
    const action = item.dataset.action;
    console.log(`[Editor Context Menu] Ação disparada: ${action}`);

    if (action === "copy") {
      const selectedText = window.getSelection().toString();
      navigator.clipboard.writeText(selectedText)
        .then(() => console.log(`[Editor Context Menu] Copiado para a área de transferência: "${selectedText}"`))
        .catch(err => console.error("Erro ao copiar:", err));
    } else if (action === "cut") {
      const selectedText = window.getSelection().toString();
      navigator.clipboard.writeText(selectedText)
        .then(() => {
          console.log(`[Editor Context Menu] Recortado para a área de transferência: "${selectedText}"`);
          document.execCommand("delete");
        })
        .catch(err => console.error("Erro ao recortar:", err));
    } else if (action === "paste") {
      navigator.clipboard.readText()
        .then(text => {
          if (text && state.editor) {
            state.editor.insertSlashBlock("paragraph", { text }, { replaceCurrent: false }).catch(() => {});
          }
        })
        .catch(err => console.error("Erro ao colar:", err));
    } else if (action === "duplicate-block") {
      if (state.editor) {
        state.editor.duplicateBlock().catch(handleUnexpectedError);
      }
    } else if (action === "delete-block") {
      if (state.editor) {
        state.editor.deleteBlock().catch(handleUnexpectedError);
      }
    }

    hideAllContextMenus();
  });
}

async function init() {
  state.currentNoteId = readNoteIdFromHash();
  state.ui.sidebarCollapsed = false;
  updateCompactWindowMode(els.app?.getBoundingClientRect?.().width || window.innerWidth);
  setEditorVisibility(false);
  renderSaveStatus();
  setupCompactWindowObserver();
  wireTemplateButtons();
  state.statusTimer = window.setInterval(tickSaveStatus, SAVE_STATUS_TICK_MS);
  state.picker = new NotesFilePicker({ api: state.api, root: els.filePickerModal });
  state.editor = new EditorAdapter({
    holder: "editorjs",
    onChange: async () => markDirty("content"),
    blockConfig: {
      onOpen: (data) => openAttachment(data).catch(handleUnexpectedError),
      onReveal: (data) => revealAttachment(data),
      resolvePreview: (data) => resolveBlockPreview(data),
      onPick: (type, config) => pickerFromBlock(type, config),
      onChange: () => markDirty("content"),
      onDelete: (element) => state.editor.deleteBlockByElement(element).catch(handleUnexpectedError),
    },
  });
  await state.editor.init(normalizeEditorData(null));
  installWikiLinkAutocomplete({ root: els.editorHolder, api: state.api });
  wireEvents();
  await loadInitialData();
  setSaveState("saved", { at: Date.now() });
}

async function loadInitialData() {
  const attempts = [0, 300, 900];
  let lastError = null;
  for (const waitMs of attempts) {
    if (waitMs) {
      await new Promise((resolve) => window.setTimeout(resolve, waitMs));
    }
    try {
      await loadNotes({ preserveSelection: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Falha ao carregar dados iniciais do Notes.");
}

init().catch((error) => {
  setSaveState("error", { error: "Falha ao iniciar" });
  handleUnexpectedError(error);
});

function wireFloatingSearch() {
  els.floatingSearchInput.addEventListener("input", (e) => {
    state.floatingSearch.query = e.target.value;
    performFloatingSearch(state.floatingSearch.query);
  });

  els.floatingSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      hideFloatingSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        navigateFloatingSearch(-1);
      } else {
        navigateFloatingSearch(1);
      }
    }
  });

  els.searchNext.addEventListener("click", () => {
    navigateFloatingSearch(1);
  });

  els.searchPrev.addEventListener("click", () => {
    navigateFloatingSearch(-1);
  });

  els.searchClose.addEventListener("click", () => {
    hideFloatingSearch();
  });
}

function showFloatingSearch() {
  els.searchBarFloating.classList.remove("hidden");
  els.floatingSearchInput.focus();
  els.floatingSearchInput.select();
  state.floatingSearch.visible = true;
  if (state.floatingSearch.query) {
    performFloatingSearch(state.floatingSearch.query);
  }
}

function hideFloatingSearch() {
  els.searchBarFloating.classList.add("hidden");
  state.floatingSearch.visible = false;
  
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('tcloud-search');
    CSS.highlights.delete('tcloud-search-active');
  }
  
  state.floatingSearch.highlights = [];
  state.floatingSearch.index = -1;
  
  if (state.editor) {
    state.editor.focus();
  }
}

function performFloatingSearch(query) {
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('tcloud-search');
    CSS.highlights.delete('tcloud-search-active');
  }
  state.floatingSearch.highlights = [];
  state.floatingSearch.index = -1;

  if (!query) {
    els.searchCounter.textContent = '0/0';
    return;
  }

  const textNodes = [];
  const walk = document.createTreeWalker(els.editorHolder, NodeFilter.SHOW_TEXT, null, false);
  let n;
  while (n = walk.nextNode()) {
    const parent = n.parentNode;
    if (parent && parent.tagName !== 'SCRIPT' && parent.tagName !== 'STYLE') {
      textNodes.push(n);
    }
  }

  const queryLower = query.toLowerCase();
  const ranges = [];

  for (const node of textNodes) {
    const text = node.textContent;
    let startIdx = 0;
    while (true) {
      const idx = text.toLowerCase().indexOf(queryLower, startIdx);
      if (idx === -1) break;
      
      const range = new Range();
      range.setStart(node, idx);
      range.setEnd(node, idx + query.length);
      ranges.push(range);
      
      startIdx = idx + query.length;
    }
  }

  state.floatingSearch.highlights = ranges;

  if (ranges.length > 0) {
    state.floatingSearch.index = 0;
    updateFloatingSearchUI();
  } else {
    els.searchCounter.textContent = '0/0';
  }
}

function updateFloatingSearchUI() {
  const ranges = state.floatingSearch.highlights;
  const index = state.floatingSearch.index;
  const total = ranges.length;

  if (total === 0) {
    els.searchCounter.textContent = '0/0';
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete('tcloud-search');
      CSS.highlights.delete('tcloud-search-active');
    }
    return;
  }

  els.searchCounter.textContent = `${index + 1}/${total}`;

  if (typeof CSS !== 'undefined' && CSS.highlights) {
    const searchHighlight = new Highlight(...ranges);
    const activeHighlight = new Highlight(ranges[index]);
    CSS.highlights.set('tcloud-search', searchHighlight);
    CSS.highlights.set('tcloud-search-active', activeHighlight);
  }

  const activeRange = ranges[index];
  const rect = activeRange.getBoundingClientRect();
  const shell = document.querySelector('.editor-shell');
  if (shell && (rect.top !== 0 || rect.left !== 0)) {
    const shellRect = shell.getBoundingClientRect();
    shell.scrollTo({
      top: shell.scrollTop + rect.top - shellRect.top - (shell.clientHeight / 2),
      behavior: 'smooth'
    });
  }
}

function navigateFloatingSearch(direction) {
  const ranges = state.floatingSearch.highlights;
  if (ranges.length === 0) return;
  state.floatingSearch.index = (state.floatingSearch.index + direction + ranges.length) % ranges.length;
  updateFloatingSearchUI();
}

window.showFloatingSearch = showFloatingSearch;
window.hideFloatingSearch = hideFloatingSearch;
window.state = state;
