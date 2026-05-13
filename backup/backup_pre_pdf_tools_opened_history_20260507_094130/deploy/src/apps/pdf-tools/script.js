const PDF_TOOLS_PREFERENCES_KEY = "pdf-tools.preferences.v1";
const PDF_TOOLS_RECENTS_LOOKUP_LIMIT = 200;
const PDF_TOOLS_DEFAULT_PREFERENCES = {
  pageSpread: "single",
  scrollMode: "continuous",
  defaultFitMode: "page",
  thumbsCollapsed: false,
  openBehavior: "new_tab",
};
const PDF_TOOLS_PREFERENCE_VALUES = {
  pageSpread: new Set(["single", "double"]),
  scrollMode: new Set(["continuous", "paged"]),
  defaultFitMode: new Set(["page", "width", "custom"]),
  openBehavior: new Set(["new_tab", "replace_current"]),
};
const PDF_SPREAD_GAP = 18;
const initialPreferences = loadPdfToolsPreferences();

const app = {
  session: null,
  pdfjs: null,
  tabs: [],
  activeKey: "",
  visibleKey: "",
  documents: new Map(),
  switchGeneration: 0,
  pdf: null,
  page: 1,
  totalPages: 0,
  zoom: 1,
  currentPath: "/",
  renderTask: null,
  textLayerTask: null,
  thumbObserver: null,
  renderedThumbs: new Set(),
  saveTimer: null,
  deviceId: `web:${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)}`,
  pendingLaunches: [],
  recentPdfs: [],
  recentPdfsTimer: null,
  wheelAccumulator: 0,
  fitMode: "page",
  preferences: initialPreferences,
  settingsOpen: false,
  presentationActive: false,
  presentationZoomBefore: null,
  presentationFitModeBefore: "page",
  renderGeneration: 0,
  textStatus: "idle",
  textStatusReason: "",
  thumbsCollapsed: initialPreferences.thumbsCollapsed,
  externalTabs: false,
};

const els = {
  picker: document.getElementById("picker"),
  tabs: document.getElementById("tabs"),
  toolbar: document.getElementById("pdf-toolbar"),
  recentPdfsStrip: document.getElementById("recent-pdfs-strip"),
  settingsPanel: document.getElementById("pdf-settings-panel"),
  settingsToggle: document.getElementById("pdf-settings-toggle"),
  settingsToggleHome: document.getElementById("pdf-settings-toggle-home"),
  settingsClose: document.getElementById("pdf-settings-close"),
  fileList: document.getElementById("file-list"),
  search: document.getElementById("pdf-search"),
  currentPath: document.getElementById("current-path"),
  thumbs: document.getElementById("thumbs"),
  stage: document.getElementById("page-stage"),
  documentHost: document.getElementById("document-host"),
  pageLayer: null,
  canvas: null,
  textLayer: null,
  empty: document.getElementById("empty-state"),
  pageInput: document.getElementById("page-input"),
  pageTotal: document.getElementById("page-total"),
  sync: document.getElementById("sync-state"),
  zoomReset: document.getElementById("zoom-reset"),
  fitPage: document.getElementById("fit-page"),
  fitWidth: document.getElementById("fit-width"),
  presentationMode: document.getElementById("presentation-mode"),
  presentationHud: document.getElementById("presentation-hud"),
  presentationPage: document.getElementById("presentation-page"),
  findPanel: document.getElementById("pdf-find-panel"),
  findInput: document.getElementById("pdf-find-input"),
  findCounter: document.getElementById("pdf-find-counter"),
  findStatus: document.getElementById("pdf-find-status"),
  findPrev: document.getElementById("pdf-find-prev"),
  findNext: document.getElementById("pdf-find-next"),
  findClose: document.getElementById("pdf-find-close"),
  shell: document.querySelector(".app-shell"),
  openPicker: document.getElementById("open-picker"),
  openPickerReader: document.getElementById("open-picker-reader"),
  closePicker: document.getElementById("close-picker"),
  emptyOpenPicker: document.getElementById("empty-open-picker"),
};

const DEFAULT_EMPTY_HTML = els.empty.innerHTML;
const PDF_RANGE_CHUNK_SIZE = 65536;
const THUMB_GENERIC_SKELETONS = 7;
const PDF_FIND_QUERY_MAX_CHARS = 80;
const PDF_FIND_MIN_QUERY_CHARS = 2;
const PDF_FIND_MAX_RESULTS = 5000;
const PDF_FIND_MAX_MATCHES_PER_PAGE = 50;
const PDF_FIND_DEBOUNCE_MS = 220;

function createSearchState() {
  return {
    open: false,
    query: "",
    normalizedQuery: "",
    generation: 0,
    status: "idle",
    indexedPages: 0,
    textPages: 0,
    totalPages: 0,
    pages: new Map(),
    results: [],
    activeIndex: -1,
    runningPromise: null,
    abortController: null,
    debounceTimer: null,
    lastShellPublishAt: 0,
  };
}

function debugPerfEnabled() {
  try {
    return new URLSearchParams(window.location.search).get("debugPerf") === "1"
      || localStorage.getItem("pdf-tools.debugPerf") === "1";
  } catch (error) {
    return false;
  }
}

function markPdfPerf(event, payload = {}) {
  if (!debugPerfEnabled()) return;
  const data = {
    at: Math.round(performance.now()),
    activeKey: app.activeKey,
    visibleKey: app.visibleKey,
    tabs: app.tabs.length,
    ...payload,
  };
  console.info(`[PDF Tools perf] ${event}`, data);
  if (event === "empty:shown" && app.tabs.length > 0) {
    console.warn("[PDF Tools perf] empty state shown while tabs are active", data);
  }
}

function normalizePdfToolsPreferences(input = {}) {
  const next = { ...PDF_TOOLS_DEFAULT_PREFERENCES };
  const raw = input && typeof input === "object" ? input : {};
  Object.keys(PDF_TOOLS_PREFERENCE_VALUES).forEach((key) => {
    if (PDF_TOOLS_PREFERENCE_VALUES[key].has(raw[key])) next[key] = raw[key];
  });
  if (typeof raw.thumbsCollapsed === "boolean") next.thumbsCollapsed = raw.thumbsCollapsed;
  return next;
}

function loadPdfToolsPreferences() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PDF_TOOLS_PREFERENCES_KEY) || "{}");
    const preferences = normalizePdfToolsPreferences(parsed);
    if (!Object.prototype.hasOwnProperty.call(parsed, "thumbsCollapsed")) {
      preferences.thumbsCollapsed = localStorage.getItem("pdf-tools.thumbsCollapsed") === "1";
    }
    return preferences;
  } catch (error) {
    return { ...PDF_TOOLS_DEFAULT_PREFERENCES };
  }
}

function savePdfToolsPreferences(next) {
  app.preferences = normalizePdfToolsPreferences(next);
  app.thumbsCollapsed = app.preferences.thumbsCollapsed;
  try {
    localStorage.setItem(PDF_TOOLS_PREFERENCES_KEY, JSON.stringify(app.preferences));
  } catch (error) {
    console.warn("Nao foi possivel salvar preferencias do PDF Tools", error);
  }
  syncSettingsUi();
  publishState();
  return app.preferences;
}

function toolbarMode() {
  return app.tabs.length > 0 ? "reader" : "home";
}

function syncEmptyState() {
  const shouldShow = app.tabs.length === 0;
  els.empty.classList.toggle("hidden", !shouldShow);
  els.shell.classList.toggle("no-document", shouldShow);
  els.shell.dataset.toolbarMode = toolbarMode();
  markPdfPerf(shouldShow ? "empty:shown" : "empty:hidden");
  return shouldShow;
}

function resetEmptyState() {
  if (els.empty.innerHTML !== DEFAULT_EMPTY_HTML) {
    els.empty.innerHTML = DEFAULT_EMPTY_HTML;
    els.emptyOpenPicker = document.getElementById("empty-open-picker");
    if (els.emptyOpenPicker) els.emptyOpenPicker.onclick = openPicker;
  }
}

function getSession(documentKey) {
  return app.documents.get(documentKey) || null;
}

function getActiveSession() {
  return getSession(app.activeKey);
}

function getVisibleSession() {
  return getSession(app.visibleKey) || getActiveSession();
}

function syncLegacyDocumentState(session = getActiveSession()) {
  app.pdf = session?.pdf || null;
  app.page = session?.page || 1;
  app.totalPages = session?.totalPages || 0;
  app.zoom = session?.zoom || 1;
  app.fitMode = session?.fitMode || "page";
  app.renderTask = session?.renderTask || null;
  app.textLayerTask = session?.textLayerTask || null;
  app.thumbObserver = session?.thumbObserver || null;
  app.renderedThumbs = session?.renderedThumbs || new Set();
  app.renderGeneration = session?.renderGeneration || 0;
  app.textStatus = session?.textStatus || "idle";
  app.textStatusReason = session?.textStatusReason || "";
  els.pageLayer = session?.elements.pageLayer || null;
  els.canvas = session?.elements.canvas || null;
  els.textLayer = session?.elements.textLayer || null;
}

function createSessionElements(tab) {
  const view = document.createElement("div");
  view.className = "document-view loading";
  view.dataset.documentKey = tab.document_key;

  const loading = document.createElement("div");
  loading.className = "document-loading";
  loading.innerHTML = `
    <span class="document-loading-spinner" aria-hidden="true"></span>
    <span class="document-loading-text">Carregando PDF</span>
  `;

  const skeleton = document.createElement("div");
  skeleton.className = "document-skeleton";
  skeleton.setAttribute("aria-hidden", "true");
  skeleton.innerHTML = `
    <div class="document-skeleton-page">
      <div class="document-skeleton-header"></div>
      <div class="document-skeleton-line document-skeleton-line-wide"></div>
      <div class="document-skeleton-line"></div>
      <div class="document-skeleton-block"></div>
      <div class="document-skeleton-line document-skeleton-line-short"></div>
      <div class="document-skeleton-line"></div>
      <div class="document-skeleton-footer"></div>
    </div>
  `;

  const spreadLayer = document.createElement("div");
  spreadLayer.className = "spread-layer";

  const pageLayer = document.createElement("div");
  pageLayer.className = "page-layer";

  const canvas = document.createElement("canvas");
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  textLayer.setAttribute("aria-label", "Texto da pagina");
  const searchHighlightLayer = document.createElement("div");
  searchHighlightLayer.className = "search-highlight-layer";
  searchHighlightLayer.setAttribute("aria-hidden", "true");

  const secondaryPageLayer = document.createElement("div");
  secondaryPageLayer.className = "page-layer secondary-page-layer";
  secondaryPageLayer.setAttribute("aria-hidden", "true");
  const secondaryCanvas = document.createElement("canvas");
  secondaryPageLayer.append(secondaryCanvas);

  pageLayer.append(canvas, textLayer, searchHighlightLayer);
  spreadLayer.append(pageLayer, secondaryPageLayer);
  view.append(loading, skeleton, spreadLayer);
  els.documentHost.appendChild(view);

  return {
    view,
    loading,
    skeleton,
    spreadLayer,
    pageLayer,
    canvas,
    textLayer,
    searchHighlightLayer,
    secondaryPageLayer,
    secondaryCanvas,
    thumbsList: null,
  };
}

function createDocumentSession(tab) {
  const existing = getSession(tab.document_key);
  if (existing) {
    existing.tab = tab;
    return existing;
  }
  const session = {
    documentKey: tab.document_key,
    tab,
    status: "idle",
    loadingTask: null,
    loadPromise: null,
    pdf: null,
    page: 1,
    totalPages: 0,
    zoom: 1,
    fitMode: "page",
    renderGeneration: 0,
    renderTask: null,
    secondaryRenderTask: null,
    textLayerTask: null,
    renderedThumbs: new Set(),
    thumbObserver: null,
    stream: null,
    error: null,
    hasRender: false,
    destroyed: false,
    textStatus: "idle",
    textStatusReason: "",
    search: createSearchState(),
    elements: createSessionElements(tab),
    lastActiveAt: Date.now(),
  };
  app.documents.set(tab.document_key, session);
  return session;
}

function createOrGetSession(tab) {
  if (!tab) return null;
  return createDocumentSession(tab);
}

function setDocumentHostVisibility(documentKey, options = {}) {
  const target = getSession(documentKey);
  const currentVisible = getVisibleSession();
  const keepCurrent = options.keepPreviousVisibleUntilReady && target && !target.hasRender && currentVisible?.hasRender;
  const visibleKey = keepCurrent ? currentVisible.documentKey : documentKey;
  app.visibleKey = visibleKey || "";
  app.documents.forEach((session) => {
    session.elements.view.classList.toggle("active", session.documentKey === app.visibleKey);
  });
}

function activateSession(documentKey, options = {}) {
  let session = getSession(documentKey);
  if (!session) {
    const tab = app.tabs.find((item) => item.document_key === documentKey);
    session = createOrGetSession(tab);
  }
  if (!session) {
    syncLegacyDocumentState(null);
    syncEmptyState();
    updateToolbar();
    return null;
  }
  session.lastActiveAt = Date.now();
  setDocumentHostVisibility(documentKey, options);
  syncLegacyDocumentState(session);
  renderTabs();
  showThumbsForSession(session);
  syncEmptyState();
  updateToolbar();
  return session;
}

function setSync(text) {
  els.sync.textContent = text;
  publishState();
}

function setDocumentLoadingText(session, text) {
  const loadingText = session?.elements.loading.querySelector(".document-loading-text");
  if (loadingText) loadingText.textContent = text;
}

function setTextStatus(status, reason = "", session = getActiveSession()) {
  if (session) {
    session.textStatus = status;
    session.textStatusReason = reason;
    if (session.documentKey === app.activeKey) {
      app.textStatus = status;
      app.textStatusReason = reason;
    }
  } else {
    app.textStatus = status;
    app.textStatusReason = reason;
  }
  const textLayer = session?.elements.textLayer || els.textLayer;
  if (textLayer) {
    textLayer.dataset.textStatus = status;
  }
  if (els.sync) {
    els.sync.title = textStatusLabel(status, reason);
  }
  publishState();
}

function textStatusLabel(status, reason = "") {
  const labels = {
    idle: "Texto ainda nao analisado",
    loading: "Carregando texto da pagina",
    native_text_ok: "Texto nativo selecionavel",
    native_text_suspect: "Texto nativo suspeito; OCR pode estar incorreto",
    no_text: "Pagina sem texto selecionavel detectado",
    render_error: "Falha ao renderizar texto selecionavel",
  };
  const label = labels[status] || "Estado do texto desconhecido";
  return reason ? `${label}: ${reason}` : label;
}

function debugTextLayerEnabled() {
  try {
    return localStorage.getItem("pdf-tools.debugTextLayer") === "1";
  } catch (error) {
    return false;
  }
}

function cancelTextLayerTask(session = getActiveSession()) {
  if (session?.textLayerTask) {
    session.textLayerTask.cancel();
    session.textLayerTask = null;
    if (session.documentKey === app.activeKey) {
      app.textLayerTask = null;
    }
  }
  const textLayer = session?.elements.textLayer || els.textLayer;
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) {
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (textLayer && ((anchorNode && textLayer.contains(anchorNode)) || (focusNode && textLayer.contains(focusNode)))) {
      selection.removeAllRanges();
    }
  }
}

function analyzeTextContent(textContent, textLayerElement, viewport) {
  const items = Array.isArray(textContent?.items) ? textContent.items : [];
  const textItems = items.filter((item) => typeof item?.str === "string");
  const strings = textItems.map((item) => String(item.str || ""));
  const usefulText = strings.join(" ").replace(/\s+/g, " ").trim();
  const usefulChars = usefulText.length;
  const emptyItems = strings.filter((value) => !value.trim()).length;
  const spans = Array.from(textLayerElement.querySelectorAll("span:not(.markedContent)"));
  const zeroSizeSpans = spans.filter((span) => {
    const rect = span.getBoundingClientRect();
    return rect.width <= 0.5 || rect.height <= 0.5;
  }).length;
  const emptyRatio = textItems.length ? emptyItems / textItems.length : 1;
  const zeroRatio = spans.length ? zeroSizeSpans / spans.length : 0;
  const pageArea = Math.max(1, Number(viewport?.width || 0) * Number(viewport?.height || 0));
  const spanArea = spans.reduce((total, span) => {
    const rect = span.getBoundingClientRect();
    return total + Math.max(0, rect.width) * Math.max(0, rect.height);
  }, 0);
  const areaRatio = spanArea / pageArea;

  if (!items.length || usefulChars < 20) {
    return { status: "no_text", reason: "poucos caracteres extraidos", usefulChars, items: textItems.length, spans: spans.length };
  }
  if (emptyRatio > 0.7) {
    return { status: "native_text_suspect", reason: "muitos itens textuais vazios", usefulChars, items: textItems.length, spans: spans.length };
  }
  if (spans.length && zeroRatio > 0.6) {
    return { status: "native_text_suspect", reason: "muitos spans sem dimensao", usefulChars, items: textItems.length, spans: spans.length };
  }
  if (textItems.length > 80 && usefulChars < 120) {
    return { status: "native_text_suspect", reason: "texto extraido curto para pagina densa", usefulChars, items: textItems.length, spans: spans.length };
  }
  if (spans.length > 40 && areaRatio < 0.002) {
    return { status: "native_text_suspect", reason: "area textual muito baixa", usefulChars, items: textItems.length, spans: spans.length };
  }
  return { status: "native_text_ok", reason: "camada textual nativa consistente", usefulChars, items: textItems.length, spans: spans.length };
}

function debugTextLayer(event, payload) {
  if (!debugTextLayerEnabled()) return;
  console.info(`[PDF Tools] ${event}`, payload);
}

function rectSnapshot(rect) {
  if (!rect) return null;
  return {
    left: Number(rect.left.toFixed(2)),
    top: Number(rect.top.toFixed(2)),
    width: Number(rect.width.toFixed(2)),
    height: Number(rect.height.toFixed(2)),
  };
}

function selectionInsideTextLayer(selection) {
  const session = getVisibleSession();
  const textLayer = session?.elements.textLayer || els.textLayer;
  if (!selection || selection.isCollapsed || !textLayer) return false;
  const nodes = [selection.anchorNode, selection.focusNode];
  if (nodes.some((node) => node && textLayer.contains(node))) return true;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (range.commonAncestorContainer && textLayer.contains(range.commonAncestorContainer)) return true;
  }
  return false;
}

function nearestTextSpan(node) {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return element?.closest?.(".textLayer span:not(.markedContent)") || null;
}

function layerGeometrySnapshot(session = getVisibleSession()) {
  const canvasEl = session?.elements.canvas || els.canvas;
  const textLayerEl = session?.elements.textLayer || els.textLayer;
  if (!canvasEl || !textLayerEl || !els.stage) return null;
  const canvas = canvasEl.getBoundingClientRect();
  const textLayer = textLayerEl.getBoundingClientRect();
  const deltas = {
    left: Math.abs(canvas.left - textLayer.left),
    top: Math.abs(canvas.top - textLayer.top),
    width: Math.abs(canvas.width - textLayer.width),
    height: Math.abs(canvas.height - textLayer.height),
  };
  return {
    canvas: rectSnapshot(canvas),
    textLayer: rectSnapshot(textLayer),
    stage: rectSnapshot(els.stage.getBoundingClientRect()),
    maxDelta: Number(Math.max(deltas.left, deltas.top, deltas.width, deltas.height).toFixed(2)),
  };
}

function clearSelectionDebugRects(session = getVisibleSession()) {
  const pageLayer = session?.elements.pageLayer || els.pageLayer;
  pageLayer?.querySelector(".text-debug-overlay")?.remove();
}

function drawSelectionDebugRects(rects, session = getVisibleSession()) {
  const pageLayer = session?.elements.pageLayer || els.pageLayer;
  if (!debugTextLayerEnabled() || !pageLayer) return;
  clearSelectionDebugRects(session);
  const pageRect = pageLayer.getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.className = "text-debug-overlay";
  rects.forEach((rect) => {
    const node = document.createElement("div");
    node.className = "text-debug-rect";
    node.style.left = `${rect.left - pageRect.left}px`;
    node.style.top = `${rect.top - pageRect.top}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
    overlay.appendChild(node);
  });
  pageLayer.appendChild(overlay);
}

function normalizeCopiedText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/-\n(?=\p{L})/gu, "")
    .trim();
}

function handlePdfTextCopy(event) {
  const session = getVisibleSession();
  const selection = document.getSelection();
  if (!selectionInsideTextLayer(selection)) return;
  const rawText = selection.toString();
  const copiedText = normalizeCopiedText(rawText);
  if (copiedText.length < 2 || !event.clipboardData) return;
  event.clipboardData.setData("text/plain", copiedText);
  event.preventDefault();
  debugTextLayer("copy", {
    page: session?.page || app.page,
    rawText,
    copiedText,
    geometry: layerGeometrySnapshot(session),
  });
}

function logCurrentSelection(selection) {
  const session = getVisibleSession();
  if (!selectionInsideTextLayer(selection)) return;
  const rects = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    rects.push(...Array.from(selection.getRangeAt(index).getClientRects()));
  }
  const anchorSpan = nearestTextSpan(selection.anchorNode);
  const focusSpan = nearestTextSpan(selection.focusNode);
  drawSelectionDebugRects(rects, session);
  debugTextLayer("selection", {
    page: session?.page || app.page,
    selectionText: selection.toString(),
    selectionLength: selection.toString().length,
    rangeCount: selection.rangeCount,
    rangeRects: rects.map(rectSnapshot),
    geometry: layerGeometrySnapshot(session),
    zoom: session?.zoom || app.zoom,
    fitMode: session?.fitMode || app.fitMode,
    presentationActive: app.presentationActive,
    devicePixelRatio: window.devicePixelRatio || 1,
    textStatus: session?.textStatus || app.textStatus,
    anchorSpanText: anchorSpan?.textContent || "",
    focusSpanText: focusSpan?.textContent || "",
  });
}

async function ensurePdfJs() {
  if (app.pdfjs) return app.pdfjs;
  app.pdfjs = await import("./vendor/pdfjs/pdf.mjs");
  app.pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";
  return app.pdfjs;
}

async function runtime(functionName, payload = {}) {
  return window.TCloudApp.call(functionName, payload);
}

function isPdf(item) {
  const name = String(item?.name || item?.path || "").toLowerCase();
  const mime = String(item?.mime_type || item?.mimeType || "").toLowerCase();
  return mime === "application/pdf" || name.endsWith(".pdf");
}

function normalizeRecentPdf(item) {
  const path = String(item?.path || "").trim();
  if (!path) return null;
  return {
    path,
    name: String(item?.name || item?.filename || path.split("/").pop() || "PDF"),
    size_bytes: Number(item?.size_bytes || item?.size || 0),
    modified_at: String(item?.modified_at || item?.updated_at || ""),
  };
}

async function loadRecentPdfs() {
  if (!app.session) return app.recentPdfs;
  try {
    const data = await runtime("recents.list", { limit: PDF_TOOLS_RECENTS_LOOKUP_LIMIT });
    const seen = new Set();
    app.recentPdfs = (data.items || [])
      .filter(isPdf)
      .map(normalizeRecentPdf)
      .filter(Boolean)
      .filter((item) => {
        if (seen.has(item.path)) return false;
        seen.add(item.path);
        return true;
      })
      .slice(0, 3);
  } catch (error) {
    console.warn("Nao foi possivel carregar PDFs recentes", error);
    app.recentPdfs = [];
  }
  renderRecentPdfs();
  publishState();
  return app.recentPdfs;
}

function refreshRecentPdfsSoon() {
  clearTimeout(app.recentPdfsTimer);
  app.recentPdfsTimer = setTimeout(() => {
    loadRecentPdfs().catch((error) => console.warn("Falha ao atualizar recentes", error));
  }, 350);
}

function stableDocumentKey(info) {
  const raw = [
    info.path || "",
    info.size_bytes || info.size || 0,
    info.modified_at || "",
    info.storage?.storage_id_masked || "",
  ].join("|");
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) + hash) ^ raw.charCodeAt(i);
  }
  return `pdf:${Math.abs(hash).toString(36)}:${raw.length.toString(36)}`;
}

function normalizeTab(input) {
  return {
    document_key: input.document_key,
    path: input.path,
    name: input.name || input.path.split("/").pop() || "PDF",
    opened_at: input.opened_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pinned: Boolean(input.pinned),
  };
}

function activeTab() {
  return app.tabs.find((tab) => tab.document_key === app.activeKey) || null;
}

function openPicker() {
  closeSettingsPanel({ focusStage: false });
  els.picker.classList.add("open");
  setTimeout(() => els.search.focus(), 0);
}

function closePicker() {
  els.picker.classList.remove("open");
  els.stage.focus();
}

function renderRecentPdfs() {
  if (!els.recentPdfsStrip) return;
  els.recentPdfsStrip.innerHTML = "";
  if (!app.recentPdfs.length) {
    const empty = document.createElement("span");
    empty.className = "recent-pdfs-empty";
    empty.textContent = "Sem PDFs recentes";
    els.recentPdfsStrip.appendChild(empty);
    return;
  }
  app.recentPdfs.forEach((item) => {
    const button = document.createElement("button");
    button.className = "recent-pdf-chip";
    button.type = "button";
    button.title = item.path;
    button.innerHTML = `<span class="recent-pdf-name"></span><span class="recent-pdf-meta"></span>`;
    button.querySelector(".recent-pdf-name").textContent = item.name;
    button.querySelector(".recent-pdf-meta").textContent = formatBytes(item.size_bytes || 0);
    button.onclick = () => openPdf(item.path, item.name).catch(showError);
    els.recentPdfsStrip.appendChild(button);
  });
}

function syncSettingsUi() {
  if (!els.settingsPanel) return;
  els.settingsPanel.classList.toggle("open", app.settingsOpen);
  els.settingsPanel.setAttribute("aria-hidden", app.settingsOpen ? "false" : "true");
  [els.settingsToggle, els.settingsToggleHome].forEach((button) => {
    if (!button) return;
    button.classList.toggle("active", app.settingsOpen);
    button.setAttribute("aria-expanded", app.settingsOpen ? "true" : "false");
  });
  els.settingsPanel.querySelectorAll(".pdf-settings-options").forEach((group) => {
    const key = group.dataset.preference;
    const current = String(app.preferences[key]);
    group.querySelectorAll(".pdf-settings-option").forEach((button) => {
      button.classList.toggle("active", button.dataset.value === current);
      button.setAttribute("aria-pressed", button.dataset.value === current ? "true" : "false");
    });
  });
}

function openSettingsPanel() {
  app.settingsOpen = true;
  closePicker();
  syncSettingsUi();
  publishState();
}

function closeSettingsPanel(options = {}) {
  if (!app.settingsOpen) return;
  app.settingsOpen = false;
  syncSettingsUi();
  publishState();
  if (options.focusStage !== false) els.stage.focus();
}

function toggleSettingsPanel() {
  if (app.settingsOpen) {
    closeSettingsPanel({ focusStage: false });
  } else {
    openSettingsPanel();
  }
}

async function applyPreferencesToSession(session = getActiveSession(), reason = "preferences") {
  if (!session?.pdf) return;
  setThumbsCollapsed(app.preferences.thumbsCollapsed, { persist: false, refit: false });
  if (app.preferences.defaultFitMode === "page") {
    await fitPageToView(session);
  } else if (app.preferences.defaultFitMode === "width") {
    await fitPageWidth(session);
  } else {
    await renderPage(session, session.page);
  }
  scheduleSave(reason);
}

function setPdfPreference(key, rawValue) {
  const next = { ...app.preferences };
  if (key === "thumbsCollapsed") {
    next.thumbsCollapsed = rawValue === true || rawValue === "true";
  } else if (PDF_TOOLS_PREFERENCE_VALUES[key]?.has(rawValue)) {
    next[key] = rawValue;
  } else {
    return;
  }
  savePdfToolsPreferences(next);
  if (key === "thumbsCollapsed") {
    setThumbsCollapsed(next.thumbsCollapsed);
  } else if (["pageSpread", "scrollMode", "defaultFitMode"].includes(key)) {
    applyPreferencesToSession(getActiveSession(), `preferencia:${key}`).catch(showError);
  }
}

async function saveTabs() {
  await runtime("pdf.saveTabs", {
    app_id: "pdf-tools",
    active_document_key: app.activeKey,
    tabs: app.tabs,
  });
}

async function loadTabs() {
  const data = await runtime("pdf.getTabs", { app_id: "pdf-tools" });
  app.tabs = Array.isArray(data.tabs) ? data.tabs.map(normalizeTab) : [];
  app.activeKey = data.active_document_key || app.tabs[0]?.document_key || "";
  renderTabs();
  if (app.activeKey) {
    await loadActiveTab();
  } else {
    clearDocument();
  }
  renderRecentPdfs();
}

function renderTabs() {
  els.tabs.innerHTML = "";
  els.tabs.style.setProperty("--pdf-tab-count", String(Math.max(1, app.tabs.length)));
  els.tabs.classList.toggle("many-tabs", app.tabs.length >= 4);
  els.tabs.classList.toggle("dense-tabs", app.tabs.length >= 7);
  els.tabs.classList.toggle("max-tabs", app.tabs.length >= 10);
  app.tabs.forEach((tab) => {
    const button = document.createElement("button");
    button.className = `tab${tab.document_key === app.activeKey ? " active" : ""}`;
    button.type = "button";
    button.innerHTML = `<span class="tab-name"></span><span class="tab-close" title="Fechar">×</span>`;
    button.querySelector(".tab-name").textContent = tab.name;
    button.onclick = () => switchTab(tab.document_key);
    button.querySelector(".tab-close").onclick = async (event) => {
      event.stopPropagation();
      await closeTab(tab.document_key);
    };
    els.tabs.appendChild(button);
  });
  publishState();
}

async function switchTab(documentKey) {
  if (!documentKey || !app.tabs.some((tab) => tab.document_key === documentKey)) return;
  if (documentKey === app.activeKey) return;
  const switchId = app.switchGeneration + 1;
  app.switchGeneration = switchId;
  const previousKey = app.activeKey;
  markPdfPerf("tab:switch-click", { documentKey });
  app.activeKey = documentKey;
  renderTabs();
  closePicker();
  const session = activateSession(documentKey);
  if (!session) return;
  setSync(session.hasRender ? "Sincronizado" : "Carregando");
  flushStateForKey(previousKey, "troca de aba").catch((error) => {
    console.warn("Falha ao salvar estado da aba anterior", error);
  });
  saveTabs().catch((error) => {
    console.warn("Falha ao salvar abas", error);
  });
  await ensureSessionLoaded(session);
  if (switchId === app.switchGeneration && app.activeKey === documentKey) {
    activateSession(documentKey);
    setSync("Sincronizado");
  }
}

async function closeTab(documentKey) {
  const closingIndex = app.tabs.findIndex((tab) => tab.document_key === documentKey);
  const wasActive = documentKey === app.activeKey;
  if (documentKey === app.activeKey) {
    await flushState("fechar aba");
  }
  app.tabs = app.tabs.filter((tab) => tab.document_key !== documentKey);
  if (wasActive) {
    app.activeKey = app.tabs[Math.min(Math.max(0, closingIndex), app.tabs.length - 1)]?.document_key || "";
  }
  if (app.visibleKey === documentKey) {
    app.visibleKey = app.activeKey || "";
  }
  renderTabs();
  saveTabs().catch((error) => {
    console.warn("Falha ao salvar abas", error);
  });
  destroySession(documentKey);
  if (app.activeKey) {
    const session = activateSession(app.activeKey);
    if (session && session.status !== "ready") {
      await ensureSessionLoaded(session);
      if (app.activeKey === session.documentKey) activateSession(session.documentKey);
    }
  } else {
    clearDocument();
  }
}

async function openPdf(path, name = "") {
  setSync("Abrindo");
  const info = await runtime("files.getInfo", { path });
  if (!isPdf(info)) {
    throw new Error("O arquivo selecionado nao e PDF.");
  }
  const documentKey = stableDocumentKey(info);
  let tab = app.tabs.find((item) => item.document_key === documentKey);
  if (!tab) {
    if (app.preferences.openBehavior === "replace_current" && app.activeKey) {
      const replacedKey = app.activeKey;
      app.tabs = app.tabs.filter((item) => item.document_key !== replacedKey);
      destroySession(replacedKey);
    }
    if (app.tabs.length >= 12) {
      const removed = app.tabs.shift();
      if (removed) destroySession(removed.document_key);
    }
    tab = normalizeTab({
      document_key: documentKey,
      path: info.path || path,
      name: name || info.name || path.split("/").pop(),
    });
    app.tabs.push(tab);
  }
  app.activeKey = documentKey;
  renderTabs();
  const session = activateSession(documentKey);
  setSync(session?.hasRender ? "Sincronizado" : "Carregando");
  saveTabs().catch((error) => {
    console.warn("Falha ao salvar abas", error);
  });
  await ensureSessionLoaded(session);
  if (app.activeKey === documentKey) {
    activateSession(documentKey);
    setSync("Sincronizado");
  }
  refreshRecentPdfsSoon();
}

async function loadActiveTab() {
  const tab = activeTab();
  if (!tab) {
    clearDocument();
    return;
  }

  setSync("Carregando");
  resetEmptyState();
  const session = createOrGetSession(tab);
  activateSession(tab.document_key);
  await ensureSessionLoaded(session);
  if (app.activeKey === tab.document_key) {
    activateSession(tab.document_key);
    setSync("Sincronizado");
  }
}

async function ensureSessionLoaded(session) {
  if (!session || session.destroyed) return null;
  if (session.status === "ready" && session.pdf) return session;
  if (session.loadPromise) return session.loadPromise;

  session.status = "loading";
  session.error = null;
  setDocumentLoadingText(session, "Preparando documento");
  session.elements.view.classList.remove("load-error");
  session.elements.view.classList.add("loading", "loading-document");
  if (!session.hasRender) renderThumbSkeletons(session, { totalPagesKnown: false });
  setTextStatus("loading", "carregando documento", session);
  syncEmptyState();
  markPdfPerf("document:load-start", { documentKey: session.documentKey });

  session.loadPromise = (async () => {
    try {
      const pdfjs = await ensurePdfJs();
      const [stream, saved] = await Promise.all([
        runtime("files.getStreamUrl", { path: session.tab.path }),
        runtime("pdf.getState", {
          path: session.tab.path,
          document_key: session.tab.document_key,
        }),
      ]);
      if (session.destroyed) return session;
      const url = new URL(stream.url, window.location.origin).toString();
      session.stream = stream;
      session.loadingTask = pdfjs.getDocument({
        url,
        httpHeaders: stream.headers || {},
        withCredentials: false,
        rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
      });
      session.pdf = await session.loadingTask.promise;
      if (session.destroyed) return session;
      markPdfPerf("document:pdf-ready", { documentKey: session.documentKey, pages: session.pdf.numPages });
      session.totalPages = session.pdf.numPages;
      session.elements.view.classList.remove("loading-document");
      session.elements.view.classList.add("rendering-page");
      setDocumentLoadingText(session, "Montando pagina");
      renderThumbSkeletons(session, { totalPagesKnown: true });
      const savedState = saved.state || {};
      session.page = Math.min(session.totalPages, Math.max(1, Number(savedState.page || 1)));
      session.fitMode = app.preferences.defaultFitMode === "width"
        ? "width"
        : app.preferences.defaultFitMode === "custom"
          ? "custom"
          : "page";
      markPdfPerf("document:fit-start", { documentKey: session.documentKey, page: session.page });
      if (session.fitMode === "width") {
        const page = await session.pdf.getPage(session.page);
        const viewport = page.getViewport({ scale: 1 });
        const spreadFactor = app.preferences.pageSpread === "double" ? 2 : 1;
        const available = Math.max(320, els.stage.clientWidth - 72 - (spreadFactor > 1 ? PDF_SPREAD_GAP : 0));
        session.zoom = Math.max(0.45, Math.min(3.5, available / (viewport.width * spreadFactor)));
      } else if (session.fitMode === "custom") {
        session.zoom = Math.max(0.45, Math.min(3.5, Number(savedState.zoom || 1)));
      } else {
        session.zoom = await computeFitPageZoom(session, session.page);
      }
      markPdfPerf("document:fit-ready", { documentKey: session.documentKey, zoom: session.zoom });
      await renderPage(session, session.page);
      markPdfPerf("document:first-paint-ready", { documentKey: session.documentKey });
      renderThumbs(session);
      if (session.destroyed) return session;
      session.status = "ready";
      session.error = null;
      session.elements.view.classList.remove("loading", "loading-document", "rendering-page", "load-error");
      session.elements.view.classList.add("has-render");
      if (session.documentKey === app.activeKey) {
        syncLegacyDocumentState(session);
        updateToolbar();
      }
      return session;
    } catch (error) {
      session.status = "error";
      session.error = error;
      session.elements.view.classList.remove("loading", "loading-document", "rendering-page");
      session.elements.view.classList.add("load-error");
      setDocumentLoadingText(session, "Nao foi possivel abrir");
      throw error;
    } finally {
      session.loadPromise = null;
    }
  })();

  return session.loadPromise;
}

function cancelSessionRender(session) {
  if (!session) return;
  session.renderGeneration += 1;
  if (session.renderTask) {
    session.renderTask.cancel();
    session.renderTask = null;
  }
  if (session.secondaryRenderTask) {
    session.secondaryRenderTask.cancel();
    session.secondaryRenderTask = null;
  }
  if (session.secondaryRenderTask) {
    session.secondaryRenderTask.cancel();
    session.secondaryRenderTask = null;
  }
  cancelTextLayerTask(session);
  if (session.thumbObserver) {
    session.thumbObserver.disconnect();
    session.thumbObserver = null;
  }
}

function destroySession(documentKey) {
  const session = getSession(documentKey);
  if (!session) return;
  session.destroyed = true;
  cancelFindSearch(session, { status: "cancelled" });
  resetFindResults(session, { clearPages: true });
  cancelSessionRender(session);
  if (session.loadingTask?.destroy) {
    try {
      session.loadingTask.destroy();
    } catch (error) {
      console.warn("Falha ao destruir carregamento PDF", error);
    }
  }
  if (session.pdf?.destroy) {
    try {
      session.pdf.destroy();
    } catch (error) {
      console.warn("Falha ao destruir PDF", error);
    }
  }
  session.elements.view.remove();
  session.elements.thumbsList?.remove();
  app.documents.delete(documentKey);
  if (app.activeKey === documentKey || app.visibleKey === documentKey) {
    syncLegacyDocumentState(getActiveSession());
  }
}

function destroyAllSessions() {
  Array.from(app.documents.keys()).forEach((documentKey) => destroySession(documentKey));
}

function clearRenderState(removeTabs = true) {
  cancelSessionRender(getActiveSession());
  cancelFindSearch(getActiveSession(), { status: "cancelled" });
  resetFindResults(getActiveSession());
  setTextStatus("idle");
  if (removeTabs) {
    destroyAllSessions();
    app.tabs = [];
    app.activeKey = "";
    app.visibleKey = "";
    renderTabs();
  }
  syncLegacyDocumentState(getActiveSession());
  syncEmptyState();
  updateToolbar();
}

function clearDocument() {
  resetEmptyState();
  syncLegacyDocumentState(null);
  if (!app.tabs.length) {
    app.activeKey = "";
    app.visibleKey = "";
  }
  syncEmptyState();
  showThumbsForSession(null);
  updateToolbar();
  setSync("Pronto");
}

function updateToolbar() {
  syncLegacyDocumentState(getActiveSession());
  els.shell.dataset.toolbarMode = toolbarMode();
  renderRecentPdfs();
  syncSettingsUi();
  if (document.activeElement !== els.pageInput) {
    setPageControlText(els.pageInput, String(app.page || 1));
  }
  els.pageInput.setAttribute("aria-valuemin", "1");
  els.pageInput.setAttribute("aria-valuemax", String(app.totalPages || 1));
  els.pageInput.setAttribute("aria-valuenow", String(app.page || 1));
  els.pageTotal.textContent = `/ ${app.totalPages || 0}`;
  els.zoomReset.textContent = `${Math.round((app.zoom || 1) * 100)}%`;
  if (els.presentationPage) {
    els.presentationPage.textContent = `${app.page || 1} / ${app.totalPages || 1}`;
  }
  updateFindUi(getActiveSession());
  publishState();
}

function numericInputText(value) {
  return String(value || "").replace(/\D+/g, "");
}

function getPageControlText(control) {
  if (!control) return "";
  return "value" in control ? control.value : control.textContent;
}

function setPageControlText(control, value) {
  if (!control) return;
  if ("value" in control) {
    control.value = String(value || "");
  } else {
    control.textContent = String(value || "");
  }
}

function parsePageInputValue(value, fallback = app.page) {
  const digits = numericInputText(value);
  if (!digits) return Math.min(app.totalPages || 1, Math.max(1, Number(fallback || 1)));
  const parsed = Number(digits);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.min(app.totalPages || 1, Math.max(1, Number(fallback || 1)));
  }
  return Math.min(app.totalPages || parsed, Math.max(1, parsed));
}

function sanitizePageInputValue(input) {
  if (!input) return;
  const cleaned = numericInputText(getPageControlText(input));
  if (getPageControlText(input) !== cleaned) {
    setPageControlText(input, cleaned);
  }
}

async function commitPageInput(input = els.pageInput, options = {}) {
  if (!input) return;
  const target = parsePageInputValue(getPageControlText(input), app.page);
  setPageControlText(input, String(target));
  await goToPage(target);
  if (options.blur) input.blur();
}

function isFindShortcut(event) {
  return Boolean((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key || "").toLowerCase() === "f");
}

function getFindInputText(input = els.findInput) {
  return String(input?.textContent || "");
}

function setFindInputText(value, input = els.findInput) {
  if (!input) return;
  input.textContent = String(value || "");
}

function sanitizeFindQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, PDF_FIND_QUERY_MAX_CHARS);
}

function foldFindText(value) {
  const lowered = String(value || "").toLocaleLowerCase();
  try {
    return lowered.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  } catch (error) {
    return lowered.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
}

function selectFindInput() {
  const input = els.findInput;
  if (!input) return;
  input.focus({ preventScroll: true });
  const selection = document.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(input);
  selection.removeAllRanges();
  selection.addRange(range);
}

function yieldToBrowser(timeout = 0) {
  if (typeof window.requestIdleCallback === "function") {
    return new Promise((resolve) => window.requestIdleCallback(resolve, { timeout: Math.max(40, timeout || 80) }));
  }
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

function clearSearchHighlights(session = getActiveSession()) {
  const layer = session?.elements.searchHighlightLayer;
  if (layer) layer.replaceChildren();
}

function findStatusText(search, session = getActiveSession()) {
  if (!session?.pdf) return "Abra um PDF para pesquisar";
  if (!search.query) return "Digite para pesquisar";
  if (search.query.length < PDF_FIND_MIN_QUERY_CHARS) return `Digite pelo menos ${PDF_FIND_MIN_QUERY_CHARS} caracteres`;
  if (search.status === "running") {
    return `${search.results.length} resultado${search.results.length === 1 ? "" : "s"} · ${search.indexedPages}/${search.totalPages || session.totalPages || 0} páginas`;
  }
  if (search.status === "complete") {
    if (search.results.length) return `${search.results.length} resultado${search.results.length === 1 ? "" : "s"} em ${search.indexedPages} páginas`;
    return search.textPages ? "Sem resultados" : "PDF sem texto pesquisável";
  }
  if (search.status === "cancelled") return "Pesquisa cancelada";
  if (search.status === "error") return "Falha ao pesquisar";
  return "Pronto";
}

function updateFindUi(session = getActiveSession()) {
  const search = session?.search || null;
  const isOpen = Boolean(search?.open);
  els.findPanel?.classList.toggle("open", isOpen);
  els.shell?.classList.toggle("find-open", isOpen);
  if (!search) {
    if (els.findCounter) els.findCounter.textContent = "0 / 0";
    if (els.findStatus) els.findStatus.textContent = "Abra um PDF para pesquisar";
    return;
  }

  if (els.findInput && document.activeElement !== els.findInput && getFindInputText() !== search.query) {
    setFindInputText(search.query);
  }

  const total = search.results.length;
  const active = total && search.activeIndex >= 0 ? search.activeIndex + 1 : 0;
  if (els.findCounter) els.findCounter.textContent = `${active} / ${total}`;
  if (els.findStatus) els.findStatus.textContent = findStatusText(search, session);
  const canNavigate = total > 0;
  if (els.findPrev) els.findPrev.disabled = !canNavigate;
  if (els.findNext) els.findNext.disabled = !canNavigate;
}

function publishFindStateThrottled(session = getActiveSession(), force = false) {
  if (!session?.search) return;
  const now = performance.now();
  if (!force && now - session.search.lastShellPublishAt < 250) return;
  session.search.lastShellPublishAt = now;
  publishState();
}

function cancelFindSearch(session = getActiveSession(), options = {}) {
  const search = session?.search;
  if (!search) return;
  clearTimeout(search.debounceTimer);
  search.debounceTimer = null;
  if (search.abortController) {
    search.abortController.abort();
    search.abortController = null;
  }
  if (options.bumpGeneration !== false) search.generation += 1;
  if (options.status) search.status = options.status;
}

function resetFindResults(session = getActiveSession(), options = {}) {
  const search = session?.search;
  if (!search) return;
  search.results = [];
  search.activeIndex = -1;
  search.indexedPages = 0;
  search.textPages = 0;
  if (options.clearPages) search.pages.clear();
  clearSearchHighlights(session);
}

function openFindPanel(options = {}) {
  const session = getActiveSession();
  if (!session) return;
  closeSettingsPanel({ focusStage: false });
  session.search.open = true;
  updateFindUi(session);
  markPdfPerf("find:open", { documentKey: session.documentKey });
  publishState();
  if (options.select !== false) {
    setTimeout(() => {
      if (session.documentKey === app.activeKey && session.search.open) selectFindInput();
    }, 0);
  }
}

function closeFindPanel(options = {}) {
  const session = getActiveSession();
  if (!session?.search) return;
  session.search.open = false;
  if (options.clearQuery) {
    cancelFindSearch(session, { status: "idle" });
    session.search.query = "";
    session.search.normalizedQuery = "";
    resetFindResults(session);
    setFindInputText("");
  }
  clearSearchHighlights(session);
  updateFindUi(session);
  publishState();
  els.stage?.focus({ preventScroll: true });
}

function pageSearchOrder(session) {
  const total = Math.max(0, Number(session?.totalPages || 0));
  const current = Math.min(total, Math.max(1, Number(session?.page || 1)));
  const pages = [];
  if (current) pages.push(current);
  for (let page = current + 1; page <= total; page += 1) pages.push(page);
  for (let page = 1; page < current; page += 1) pages.push(page);
  return pages;
}

async function extractSearchPageText(session, pageNumber, signal) {
  const cached = session.search.pages.get(pageNumber);
  if (cached?.status === "ready" || cached?.status === "empty" || cached?.status === "error") return cached;
  if (signal.aborted || session.destroyed) throw new DOMException("Pesquisa cancelada", "AbortError");
  const startedAt = performance.now();
  try {
    const page = await session.pdf.getPage(pageNumber);
    if (signal.aborted || session.destroyed) throw new DOMException("Pesquisa cancelada", "AbortError");
    const textContent = await page.getTextContent({ includeMarkedContent: false });
    if (signal.aborted || session.destroyed) throw new DOMException("Pesquisa cancelada", "AbortError");
    const strings = (textContent.items || []).map((item) => String(item?.str || "")).filter((value) => value.trim());
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    const record = {
      status: text ? "ready" : "empty",
      text,
      folded: foldFindText(text),
      itemCount: strings.length,
    };
    session.search.pages.set(pageNumber, record);
    const elapsed = performance.now() - startedAt;
    if (elapsed > 200) markPdfPerf("find:slow-page", { documentKey: session.documentKey, pageNumber, elapsed: Math.round(elapsed) });
    return record;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const record = { status: "error", text: "", folded: "", itemCount: 0, error: error?.message || String(error) };
    session.search.pages.set(pageNumber, record);
    return record;
  }
}

function scanSearchPage(session, pageNumber, pageRecord, generation) {
  const search = session.search;
  if (generation !== search.generation || !search.normalizedQuery || pageRecord.status !== "ready") return [];
  const matches = [];
  let fromIndex = 0;
  while (matches.length < PDF_FIND_MAX_MATCHES_PER_PAGE && search.results.length + matches.length < PDF_FIND_MAX_RESULTS) {
    const index = pageRecord.folded.indexOf(search.normalizedQuery, fromIndex);
    if (index < 0) break;
    matches.push({
      page: pageNumber,
      start: index,
      end: index + search.normalizedQuery.length,
      pageMatchIndex: matches.length,
      preview: pageRecord.text.slice(Math.max(0, index - 36), Math.min(pageRecord.text.length, index + search.normalizedQuery.length + 36)),
    });
    fromIndex = Math.max(index + search.normalizedQuery.length, index + 1);
  }
  return matches;
}

function scheduleFindSearch(session = getActiveSession()) {
  const search = session?.search;
  if (!search) return;
  clearTimeout(search.debounceTimer);
  search.debounceTimer = setTimeout(() => {
    commitFindQuery(getFindInputText()).catch(showError);
  }, PDF_FIND_DEBOUNCE_MS);
}

async function commitFindQuery(rawValue, session = getActiveSession()) {
  const search = session?.search;
  if (!search) return;
  const query = sanitizeFindQuery(rawValue);
  if (getFindInputText() !== query) setFindInputText(query);
  cancelFindSearch(session, { status: "idle" });
  search.query = query;
  search.normalizedQuery = foldFindText(query);
  search.totalPages = session.totalPages || 0;
  resetFindResults(session);

  if (!query) {
    search.status = "idle";
    updateFindUi(session);
    publishState();
    return;
  }
  if (query.length < PDF_FIND_MIN_QUERY_CHARS) {
    search.status = "idle";
    updateFindUi(session);
    publishState();
    return;
  }
  if (!session.pdf) {
    search.status = "idle";
    updateFindUi(session);
    publishState();
    return;
  }

  search.status = "running";
  const generation = search.generation;
  const controller = new AbortController();
  search.abortController = controller;
  updateFindUi(session);
  publishState();
  markPdfPerf("find:start", { documentKey: session.documentKey, queryLength: query.length, pages: session.totalPages });

  search.runningPromise = runFindSearch(session, generation, controller.signal)
    .catch((error) => {
      if (error?.name === "AbortError") return;
      search.status = "error";
      console.warn("Falha ao pesquisar no PDF", error);
    })
    .finally(() => {
      if (search.generation === generation) {
        search.abortController = null;
        search.runningPromise = null;
        updateFindUi(session);
        renderSearchHighlights(session);
        publishState();
      }
    });
}

async function runFindSearch(session, generation, signal) {
  const search = session.search;
  const pages = pageSearchOrder(session);
  search.totalPages = pages.length;
  for (const pageNumber of pages) {
    if (signal.aborted || session.destroyed || generation !== search.generation) {
      search.status = "cancelled";
      throw new DOMException("Pesquisa cancelada", "AbortError");
    }
    if (session.renderTask || session.textLayerTask) await yieldToBrowser(40);
    const pageRecord = await extractSearchPageText(session, pageNumber, signal);
    if (pageRecord.status === "ready") search.textPages += 1;
    const matches = scanSearchPage(session, pageNumber, pageRecord, generation);
    if (matches.length) {
      search.results.push(...matches);
      search.results.sort((a, b) => (a.page - b.page) || (a.start - b.start));
      search.results.forEach((result, index) => {
        result.globalIndex = index;
      });
      if (search.activeIndex < 0) search.activeIndex = 0;
    }
    search.indexedPages += 1;
    markPdfPerf("find:page-indexed", { documentKey: session.documentKey, pageNumber, matches: matches.length });
    updateFindUi(session);
    if (pageNumber === session.page) renderSearchHighlights(session);
    publishFindStateThrottled(session);
    await yieldToBrowser();
  }
  search.status = "complete";
  markPdfPerf("find:complete", { documentKey: session.documentKey, matches: search.results.length, indexedPages: search.indexedPages });
}

async function goToSearchResult(index, session = getActiveSession()) {
  const search = session?.search;
  if (!search?.results.length) return;
  const total = search.results.length;
  const targetIndex = ((index % total) + total) % total;
  const result = search.results[targetIndex];
  search.activeIndex = targetIndex;
  updateFindUi(session);
  if (result.page !== session.page) {
    await goToPage(result.page, session);
  }
  renderSearchHighlights(session);
  scrollActiveSearchHitIntoView(session);
  publishState();
}

function findNextResult() {
  const session = getActiveSession();
  const search = session?.search;
  if (!search?.results.length) return;
  goToSearchResult(search.activeIndex < 0 ? 0 : search.activeIndex + 1, session).catch(showError);
}

function findPreviousResult() {
  const session = getActiveSession();
  const search = session?.search;
  if (!search?.results.length) return;
  goToSearchResult(search.activeIndex < 0 ? search.results.length - 1 : search.activeIndex - 1, session).catch(showError);
}

function textNodeForSpan(span) {
  if (!span) return null;
  if (span.firstChild?.nodeType === Node.TEXT_NODE) return span.firstChild;
  return null;
}

function renderSearchHighlights(session = getActiveSession()) {
  if (!session?.search?.query || !session.elements.searchHighlightLayer || !session.elements.textLayer) return;
  const search = session.search;
  const layer = session.elements.searchHighlightLayer;
  layer.replaceChildren();
  if (!search.results.length || search.query.length < PDF_FIND_MIN_QUERY_CHARS) return;
  const pageResults = search.results.filter((result) => result.page === session.page);
  if (!pageResults.length) return;

  const spans = Array.from(session.elements.textLayer.querySelectorAll("span:not(.markedContent)"))
    .filter((span) => textNodeForSpan(span) && span.textContent);
  if (!spans.length) return;
  let combined = "";
  const segments = [];
  spans.forEach((span, index) => {
    if (index > 0) combined += " ";
    const start = combined.length;
    const text = span.textContent || "";
    combined += text;
    segments.push({ span, start, end: start + text.length });
  });
  const folded = foldFindText(combined);
  const matches = [];
  let fromIndex = 0;
  while (matches.length < PDF_FIND_MAX_MATCHES_PER_PAGE) {
    const index = folded.indexOf(search.normalizedQuery, fromIndex);
    if (index < 0) break;
    matches.push({ start: index, end: index + search.normalizedQuery.length });
    fromIndex = Math.max(index + search.normalizedQuery.length, index + 1);
  }

  const pageLayerRect = session.elements.pageLayer.getBoundingClientRect();
  const activeResult = search.results[search.activeIndex] || null;
  const activePageOrdinal = activeResult?.page === session.page ? pageResults.indexOf(activeResult) : -1;
  const range = document.createRange();
  matches.forEach((match, matchIndex) => {
    const relatedSegments = segments.filter((segment) => segment.end > match.start && segment.start < match.end);
    relatedSegments.forEach((segment) => {
      const node = textNodeForSpan(segment.span);
      if (!node) return;
      const startOffset = Math.max(0, match.start - segment.start);
      const endOffset = Math.min(node.textContent.length, match.end - segment.start);
      if (endOffset <= startOffset) return;
      try {
        range.setStart(node, startOffset);
        range.setEnd(node, endOffset);
        Array.from(range.getClientRects()).forEach((rect) => {
          if (rect.width <= 0.5 || rect.height <= 0.5) return;
          const hit = document.createElement("span");
          hit.className = `pdf-search-hit${matchIndex === activePageOrdinal ? " active" : ""}`;
          hit.style.left = `${rect.left - pageLayerRect.left}px`;
          hit.style.top = `${rect.top - pageLayerRect.top}px`;
          hit.style.width = `${rect.width}px`;
          hit.style.height = `${rect.height}px`;
          if (matchIndex === activePageOrdinal) hit.dataset.active = "1";
          layer.appendChild(hit);
        });
      } catch (error) {
        debugTextLayer("find:highlight-skip", { message: error?.message || String(error) });
      }
    });
  });
  range.detach?.();
}

function scrollActiveSearchHitIntoView(session = getActiveSession()) {
  const hit = session?.elements.searchHighlightLayer?.querySelector?.('.pdf-search-hit[data-active="1"]');
  if (!hit) return;
  hit.scrollIntoView({ block: "center", inline: "nearest" });
}

function publishState() {
  const session = getActiveSession();
  const search = session?.search || null;
  window.parent.postMessage(
    {
      type: "tcloud-app-state",
      app_id: "pdf-tools",
      has_document: app.tabs.length > 0,
      toolbar_mode: toolbarMode(),
      page: app.page || 1,
      total_pages: app.totalPages || 0,
      zoom: app.zoom || 1,
      sync: els.sync?.textContent || "Pronto",
      text_status: app.textStatus || "idle",
      text_status_reason: app.textStatusReason || "",
      active_document_key: app.activeKey || "",
      recent_pdfs: app.recentPdfs,
      preferences: app.preferences,
      settings_open: app.settingsOpen,
      find_open: Boolean(search?.open),
      find_query_length: search?.query?.length || 0,
      find_status: search?.status || "idle",
      find_match_count: search?.results?.length || 0,
      find_active_index: search?.activeIndex ?? -1,
      tabs: app.tabs.map((tab) => ({
        document_key: tab.document_key,
        name: tab.name,
        pinned: Boolean(tab.pinned),
      })),
      thumbs_collapsed: Boolean(app.thumbsCollapsed),
    },
    window.location.origin
  );
}

function applyPageGeometry(session, viewport, outputScale, pageNumber, generation) {
  const cssWidth = `${viewport.width}px`;
  const cssHeight = `${viewport.height}px`;
  const { canvas, pageLayer, textLayer, searchHighlightLayer } = session.elements;
  canvas.width = Math.ceil(viewport.width * outputScale);
  canvas.height = Math.ceil(viewport.height * outputScale);
  canvas.style.width = cssWidth;
  canvas.style.height = cssHeight;
  pageLayer.style.width = cssWidth;
  pageLayer.style.height = cssHeight;
  pageLayer.dataset.zoom = String(session.zoom || viewport.scale || 1);
  pageLayer.dataset.outputScale = String(outputScale);
  textLayer.style.width = cssWidth;
  textLayer.style.height = cssHeight;
  textLayer.style.setProperty("--total-scale-factor", String(viewport.scale || session.zoom || 1));
  textLayer.style.setProperty("--scale-round-x", "1px");
  textLayer.style.setProperty("--scale-round-y", "1px");
  textLayer.dataset.page = String(pageNumber);
  textLayer.dataset.generation = String(generation);
  textLayer.setAttribute("data-main-rotation", String(viewport.rotation || 0));
  if (searchHighlightLayer) {
    searchHighlightLayer.style.width = cssWidth;
    searchHighlightLayer.style.height = cssHeight;
  }
  session.elements.spreadLayer.classList.toggle("two-page", app.preferences.pageSpread === "double");
  session.elements.view.classList.toggle("two-page-view", app.preferences.pageSpread === "double");
  return { cssWidth, cssHeight };
}

function hideSecondaryPage(session) {
  if (!session?.elements?.secondaryPageLayer) return;
  session.elements.secondaryPageLayer.classList.remove("visible");
  session.elements.secondaryPageLayer.style.width = "";
  session.elements.secondaryPageLayer.style.height = "";
}

async function renderSecondarySpreadPage(session, pageNumber, generation) {
  const secondaryNumber = pageNumber + 1;
  if (app.preferences.pageSpread !== "double" || secondaryNumber > session.totalPages) {
    hideSecondaryPage(session);
    return;
  }
  try {
    const page = await session.pdf.getPage(secondaryNumber);
    if (generation !== session.renderGeneration || session.destroyed || app.preferences.pageSpread !== "double") return;
    const viewport = page.getViewport({ scale: session.zoom });
    const outputScale = Math.max(1, window.devicePixelRatio || 1);
    const canvas = session.elements.secondaryCanvas;
    const layer = session.elements.secondaryPageLayer;
    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    layer.dataset.page = String(secondaryNumber);
    layer.dataset.zoom = String(session.zoom || viewport.scale || 1);
    layer.classList.add("visible");
    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
    const context = canvas.getContext("2d", { alpha: false });
    session.secondaryRenderTask = page.render({ canvasContext: context, viewport, transform });
    await session.secondaryRenderTask.promise;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") {
      console.warn("Falha ao renderizar segunda pagina", error);
      hideSecondaryPage(session);
    }
  } finally {
    session.secondaryRenderTask = null;
  }
}

async function renderPage(sessionOrPageNumber, maybePageNumber) {
  const session = typeof sessionOrPageNumber === "object" ? sessionOrPageNumber : getActiveSession();
  const pageNumber = typeof sessionOrPageNumber === "object" ? maybePageNumber : sessionOrPageNumber;
  if (!session?.pdf) return;
  const generation = session.renderGeneration + 1;
  session.renderGeneration = generation;
  if (session.renderTask) {
    session.renderTask.cancel();
    session.renderTask = null;
  }
  cancelTextLayerTask(session);
  clearSelectionDebugRects(session);
  clearSearchHighlights(session);
  setTextStatus("loading", "", session);
  if (!session.hasRender) {
    session.elements.view.classList.add("loading", "rendering-page");
    session.elements.view.classList.remove("loading-document", "load-error");
    setDocumentLoadingText(session, "Montando pagina");
  }
  markPdfPerf("page:render-start", { documentKey: session.documentKey, pageNumber });
  const page = await session.pdf.getPage(pageNumber);
  if (generation !== session.renderGeneration || session.destroyed) return;
  const viewport = page.getViewport({ scale: session.zoom });
  const outputScale = Math.max(1, window.devicePixelRatio || 1);
  const context = session.elements.canvas.getContext("2d", { alpha: false });
  const { cssWidth, cssHeight } = applyPageGeometry(session, viewport, outputScale, pageNumber, generation);
  session.elements.textLayer.replaceChildren();
  syncEmptyState();
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  session.renderTask = page.render({ canvasContext: context, viewport, transform });
  if (session.documentKey === app.activeKey) app.renderTask = session.renderTask;
  debugTextLayer("renderPage:start", {
    pageNumber,
    zoom: session.zoom,
    outputScale,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    canvasWidth: session.elements.canvas.width,
    canvasHeight: session.elements.canvas.height,
    cssWidth,
    cssHeight,
  });
  try {
    await session.renderTask.promise;
  } catch (error) {
    if (generation === session.renderGeneration) session.renderTask = null;
    if (session.documentKey === app.activeKey) app.renderTask = session.renderTask;
    if (error?.name === "RenderingCancelledException") return;
    throw error;
  }
  if (generation !== session.renderGeneration || session.destroyed) return;
  session.renderTask = null;
  if (session.documentKey === app.activeKey) app.renderTask = null;
  session.page = pageNumber;
  if (app.preferences.pageSpread === "double") {
    renderSecondarySpreadPage(session, pageNumber, generation).catch((error) => {
      if (generation !== session.renderGeneration || error?.name === "RenderingCancelledException") return;
      console.warn("Falha ao renderizar segunda pagina do spread", error);
      hideSecondaryPage(session);
    });
  } else {
    hideSecondaryPage(session);
  }
  if (generation !== session.renderGeneration || session.destroyed) return;
  session.hasRender = true;
  session.elements.view.classList.add("has-render");
  session.elements.view.classList.remove("loading", "loading-document", "rendering-page", "load-error");
  if (session.documentKey === app.activeKey) {
    syncLegacyDocumentState(session);
    updateToolbar();
  }
  await renderTextLayer(session, page, viewport, generation);
  if (generation !== session.renderGeneration || session.destroyed) return;
  renderSearchHighlights(session);
  els.stage.scrollTop = 0;
  els.stage.scrollLeft = 0;
  markPdfPerf("page:render-complete", { documentKey: session.documentKey, pageNumber });
  if (session.documentKey === app.activeKey) {
    syncLegacyDocumentState(session);
    updateToolbar();
    markActiveThumb(session);
    scheduleSave("pagina");
  }
}

async function renderTextLayer(session, page, viewport, generation) {
  cancelTextLayerTask(session);
  clearSelectionDebugRects(session);
  const textLayerElement = session.elements.textLayer;
  textLayerElement.replaceChildren();
  textLayerElement.setAttribute("data-main-rotation", String(viewport.rotation || 0));
  const textContent = await page.getTextContent({ includeMarkedContent: true });
  if (generation !== session.renderGeneration || session.destroyed) return;
  const textLayer = new app.pdfjs.TextLayer({
    textContentSource: textContent,
    container: textLayerElement,
    viewport,
  });
  session.textLayerTask = textLayer;
  if (session.documentKey === app.activeKey) app.textLayerTask = textLayer;
  try {
    await textLayer.render();
    if (generation !== session.renderGeneration || session.destroyed) return;
    const analysis = analyzeTextContent(textContent, textLayerElement, viewport);
    const geometry = layerGeometrySnapshot(session);
    if (geometry && geometry.maxDelta > 0.75) {
      setTextStatus("native_text_suspect", `camada textual desalinhada (${geometry.maxDelta}px)`, session);
    } else {
      setTextStatus(analysis.status, analysis.reason, session);
    }
    debugTextLayer("renderTextLayer:complete", {
      status: app.textStatus,
      reason: app.textStatusReason,
      usefulChars: analysis.usefulChars,
      items: analysis.items,
      spans: analysis.spans,
      geometry,
      sample: textContent.items
        .map((item) => String(item?.str || "").trim())
        .filter(Boolean)
        .slice(0, 5),
    });
  } catch (error) {
    if (error?.name !== "AbortException") {
      console.warn("Falha ao renderizar texto selecionavel", error);
      if (generation === session.renderGeneration) {
        setTextStatus("render_error", error.message || String(error), session);
      }
    }
  } finally {
    if (session.textLayerTask === textLayer) {
      session.textLayerTask = null;
    }
    if (app.textLayerTask === textLayer) {
      app.textLayerTask = null;
    }
  }
}

async function fitPageWidth(session = getActiveSession()) {
  if (!session?.pdf) return;
  session.fitMode = "width";
  const page = await session.pdf.getPage(session.page);
  const viewport = page.getViewport({ scale: 1 });
  const spreadFactor = app.preferences.pageSpread === "double" ? 2 : 1;
  const available = Math.max(320, els.stage.clientWidth - 72 - (spreadFactor > 1 ? PDF_SPREAD_GAP : 0));
  session.zoom = Math.max(0.45, Math.min(3.5, available / (viewport.width * spreadFactor)));
  syncLegacyDocumentState(session);
  await renderPage(session, session.page);
}

async function computeFitPageZoom(sessionOrPageNumber = getActiveSession(), maybePageNumber) {
  const session = typeof sessionOrPageNumber === "object" ? sessionOrPageNumber : getActiveSession();
  const pageNumber = typeof sessionOrPageNumber === "object" ? (maybePageNumber || session?.page || 1) : sessionOrPageNumber;
  if (!session?.pdf) return 1;
  const page = await session.pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const horizontalPadding = app.presentationActive ? 24 : 56;
  const verticalPadding = app.presentationActive ? 24 : 56;
  const spreadFactor = !app.presentationActive && app.preferences.pageSpread === "double" ? 2 : 1;
  const availableWidth = Math.max(320, els.stage.clientWidth - horizontalPadding);
  const availableHeight = Math.max(320, els.stage.clientHeight - verticalPadding);
  const spreadGap = spreadFactor > 1 ? PDF_SPREAD_GAP : 0;
  return Math.max(0.35, Math.min(3.5, (availableWidth - spreadGap) / (viewport.width * spreadFactor), availableHeight / viewport.height));
}

async function fitPageToView(session = getActiveSession()) {
  if (!session?.pdf) return;
  session.fitMode = "page";
  session.zoom = await computeFitPageZoom(session, session.page);
  syncLegacyDocumentState(session);
  await renderPage(session, session.page);
}

async function enterPresentationMode() {
  const session = getActiveSession();
  if (!session?.pdf || app.presentationActive) return;
  app.presentationActive = true;
  app.presentationZoomBefore = session.zoom;
  app.presentationFitModeBefore = session.fitMode;
  els.shell.classList.add("presentation");
  try {
    await els.shell.requestFullscreen?.();
  } catch (error) {
    console.warn("Fullscreen API indisponivel para apresentacao", error);
  }
  await fitPageToView(session);
  els.stage.focus();
}

async function exitPresentationMode() {
  if (!app.presentationActive) return;
  app.presentationActive = false;
  els.shell.classList.remove("presentation");
  if (document.fullscreenElement === els.shell) {
    try {
      await document.exitFullscreen();
    } catch (error) {
      console.warn("Falha ao sair do fullscreen", error);
    }
  }
  if (app.presentationZoomBefore) {
    const session = getActiveSession();
    if (session) {
      session.zoom = app.presentationZoomBefore;
      session.fitMode = app.presentationFitModeBefore || "custom";
      syncLegacyDocumentState(session);
    }
    app.presentationZoomBefore = null;
    if (session) await renderPage(session, session.page);
  }
}

function renderThumbsToggleIcon(collapsed) {
  const chevron = collapsed
    ? '<path d="m10.5 8 3 3-3 3"></path>'
    : '<path d="m13.5 8-3 3 3 3"></path>';
  return `
    <svg class="thumbs-toggle-svg" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <rect x="3.5" y="4.5" width="15" height="13" rx="3"></rect>
      <path d="M8.5 5v12"></path>
      ${chevron}
    </svg>
  `;
}

function updateThumbsToggle() {
  const toggle = els.thumbs.querySelector(".thumbs-toggle");
  if (!toggle) return;
  const label = app.thumbsCollapsed ? "Expandir miniaturas" : "Recolher miniaturas";
  toggle.innerHTML = renderThumbsToggleIcon(app.thumbsCollapsed);
  toggle.classList.toggle("is-collapsed", app.thumbsCollapsed);
  toggle.title = label;
  toggle.setAttribute("aria-label", label);
  toggle.setAttribute("aria-expanded", app.thumbsCollapsed ? "false" : "true");
}

function renderThumbsChrome() {
  if (els.thumbsHeader && els.thumbsStack) {
    updateThumbsToggle();
    return;
  }
  els.thumbs.innerHTML = "";
  const header = document.createElement("div");
  header.className = "thumbs-header";

  const title = document.createElement("span");
  title.className = "thumbs-title";
  title.textContent = "Miniaturas";

  const toggle = document.createElement("button");
  toggle.className = "thumbs-toggle";
  toggle.type = "button";
  toggle.onclick = () => toggleThumbsCollapsed();

  header.append(title, toggle);
  const stack = document.createElement("div");
  stack.className = "thumbs-stack";
  els.thumbsHeader = header;
  els.thumbsStack = stack;
  els.thumbsList = null;

  els.thumbs.append(header, stack);
  updateThumbsToggle();
}

function createThumbsList(session) {
  renderThumbsChrome();
  if (session.elements.thumbsList) return session.elements.thumbsList;
  const list = document.createElement("div");
  list.className = "thumbs-list";
  list.dataset.documentKey = session.documentKey;
  session.elements.thumbsList = list;
  els.thumbsStack.appendChild(list);
  return list;
}

function createThumbButton(page, session) {
  const button = document.createElement("button");
  button.className = "thumb thumb-loading";
  button.type = "button";
  button.dataset.page = String(page);
  button.innerHTML = `<canvas></canvas><span>Pagina ${page}</span>`;
  button.onclick = () => goToPage(page, session);
  return button;
}

function renderThumbSkeletons(session = getActiveSession(), options = {}) {
  if (!session || session.destroyed) return null;
  const list = createThumbsList(session);
  const totalPagesKnown = Boolean(options.totalPagesKnown && session.totalPages);
  const count = totalPagesKnown ? session.totalPages : THUMB_GENERIC_SKELETONS;
  const mode = totalPagesKnown ? `pages:${session.totalPages}` : "generic";
  if (list.dataset.skeletonMode === mode && list.childElementCount === count) {
    showThumbsForSession(session);
    return list;
  }
  if (list.dataset.thumbsReady === "1" && totalPagesKnown) {
    showThumbsForSession(session);
    return list;
  }
  if (session.thumbObserver) {
    session.thumbObserver.disconnect();
    session.thumbObserver = null;
  }
  session.renderedThumbs.clear();
  list.replaceChildren();
  list.dataset.skeletonMode = mode;
  list.dataset.thumbsReady = "0";
  for (let page = 1; page <= count; page += 1) {
    list.appendChild(createThumbButton(page, session));
  }
  showThumbsForSession(session);
  return list;
}

function showThumbsForSession(session) {
  renderThumbsChrome();
  els.thumbsStack.querySelectorAll(".thumbs-list").forEach((list) => {
    list.classList.toggle("active", Boolean(session) && list.dataset.documentKey === session.documentKey);
  });
  els.thumbsList = session?.elements.thumbsList || null;
  if (session) markActiveThumb(session);
}

function setThumbsCollapsed(collapsed, options = {}) {
  app.thumbsCollapsed = Boolean(collapsed);
  els.shell.classList.toggle("thumbs-collapsed", app.thumbsCollapsed);
  updateThumbsToggle();

  if (options.persist !== false) {
    try {
      localStorage.setItem("pdf-tools.thumbsCollapsed", app.thumbsCollapsed ? "1" : "0");
    } catch (error) {
      console.warn("Nao foi possivel salvar preferencia de miniaturas", error);
    }
  }

  publishState();

  const session = getActiveSession();
  if (options.refit !== false && session?.pdf) {
    setTimeout(() => {
      if (app.presentationActive || session.fitMode === "page") {
        fitPageToView(session).catch(showError);
      } else if (session.fitMode === "width") {
        fitPageWidth(session).catch(showError);
      }
    }, 0);
  }
}

function toggleThumbsCollapsed() {
  setThumbsCollapsed(!app.thumbsCollapsed);
}

function setExternalTabs(enabled) {
  const changed = app.externalTabs !== Boolean(enabled);
  app.externalTabs = Boolean(enabled);
  els.shell.classList.toggle("external-tabs", app.externalTabs);
  const session = getActiveSession();
  if (changed && enabled && session?.pdf && (app.presentationActive || session.fitMode === "page")) {
    setTimeout(() => fitPageToView(session).catch(showError), 0);
  }
}

function renderThumbs(session = getActiveSession()) {
  if (!session?.pdf) return;
  const expectedMode = `pages:${session.totalPages}`;
  const hasPageSkeletons = session.elements.thumbsList?.dataset.skeletonMode === expectedMode;
  if (session.elements.thumbsList && session.elements.thumbsList.childElementCount > 0 && session.elements.thumbsList.dataset.thumbsReady === "1") {
    showThumbsForSession(session);
    return;
  }
  const list = hasPageSkeletons ? session.elements.thumbsList : renderThumbSkeletons(session, { totalPagesKnown: true });
  if (!list) return;
  if (session.thumbObserver) {
    session.thumbObserver.disconnect();
  }
  session.thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        renderThumb(session, Number(entry.target.dataset.page), entry.target);
      }
    });
  }, { root: list, rootMargin: "160px" });

  list.querySelectorAll(".thumb").forEach((button) => {
    session.thumbObserver.observe(button);
  });
  list.dataset.thumbsReady = "1";
  showThumbsForSession(session);
}

async function renderThumb(session, pageNumber, node) {
  if (!session?.pdf || session.renderedThumbs.has(pageNumber) || session.destroyed) return;
  session.renderedThumbs.add(pageNumber);
  node.classList.add("thumb-loading");
  node.classList.remove("thumb-ready", "thumb-error");
  try {
    const page = await session.pdf.getPage(pageNumber);
    const canvas = node.querySelector("canvas");
    const viewport = page.getViewport({ scale: 0.2 * window.devicePixelRatio });
    const cssViewport = page.getViewport({ scale: 0.2 });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.height = `${Math.max(app.thumbsCollapsed ? 52 : 88, Math.floor(cssViewport.height))}px`;
    await page.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport,
    }).promise;
    node.classList.remove("thumb-loading", "thumb-error");
    node.classList.add("thumb-ready");
  } catch (error) {
    console.warn("Falha ao renderizar miniatura", error);
    node.classList.remove("thumb-loading", "thumb-ready");
    node.classList.add("thumb-error");
    node.title = "Miniatura indisponivel";
  }
}

function markActiveThumb(session = getActiveSession()) {
  const list = session?.elements.thumbsList || els.thumbsList;
  if (!list) return;
  list.querySelectorAll(".thumb").forEach((node) => {
    node.classList.toggle("active", Number(node.dataset.page) === session.page);
  });
  const active = list.querySelector(".thumb.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function pageNavigationStep() {
  return app.preferences.pageSpread === "double" ? 2 : 1;
}

async function goToPage(pageNumber, session = getActiveSession()) {
  if (!session?.pdf) return;
  const target = Math.min(session.totalPages, Math.max(1, Number(pageNumber || 1)));
  if (!target || target === session.page) return;
  if (app.presentationActive || session.fitMode === "page") {
    session.zoom = await computeFitPageZoom(session, target);
  } else if (session.fitMode === "width") {
    const page = await session.pdf.getPage(target);
    const viewport = page.getViewport({ scale: 1 });
    const spreadFactor = app.preferences.pageSpread === "double" ? 2 : 1;
    const available = Math.max(320, els.stage.clientWidth - 72 - (spreadFactor > 1 ? PDF_SPREAD_GAP : 0));
    session.zoom = Math.max(0.45, Math.min(3.5, available / (viewport.width * spreadFactor)));
  }
  syncLegacyDocumentState(session);
  await renderPage(session, target);
}

function canStageScroll(deltaY) {
  if (!els.stage) return false;
  const maxScroll = els.stage.scrollHeight - els.stage.clientHeight;
  if (maxScroll <= 2) return false;
  if (deltaY > 0) return els.stage.scrollTop < maxScroll - 2;
  if (deltaY < 0) return els.stage.scrollTop > 2;
  return false;
}

function handlePageWheel(event) {
  const session = getActiveSession();
  if (!session?.pdf || event.ctrlKey || event.metaKey) return;
  if (app.preferences.scrollMode === "continuous" && canStageScroll(event.deltaY)) return;
  event.preventDefault();
  app.wheelAccumulator += event.deltaY;
  if (Math.abs(app.wheelAccumulator) < 72) return;
  const direction = app.wheelAccumulator > 0 ? 1 : -1;
  app.wheelAccumulator = 0;
  goToPage(session.page + (direction * pageNavigationStep()), session);
}

function handlePageKeyboard(event) {
  if (app.settingsOpen && event.key === "Escape") {
    event.preventDefault();
    closeSettingsPanel();
    return;
  }

  if (els.picker.classList.contains("open")) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePicker();
    }
    return;
  }

  if (isFindShortcut(event)) {
    event.preventDefault();
    openFindPanel({ select: true });
    return;
  }

  const key = event.key;
  if (getActiveSession()?.search?.open && key === "Escape") {
    event.preventDefault();
    closeFindPanel();
    return;
  }

  const tagName = String(event.target?.tagName || "").toLowerCase();
  if (tagName === "input" || tagName === "textarea" || event.target?.isContentEditable || event.metaKey || event.ctrlKey || event.altKey) return;

  if (app.presentationActive && key === "Escape") {
    event.preventDefault();
    exitPresentationMode().catch(showError);
    return;
  }
  const session = getActiveSession();
  const step = pageNavigationStep();

  if (key === "ArrowDown" || key === "ArrowRight" || key === "PageDown" || key === " ") {
    event.preventDefault();
    goToPage((session?.page || app.page) + step, session);
  } else if (key === "ArrowUp" || key === "ArrowLeft" || key === "PageUp") {
    event.preventDefault();
    goToPage((session?.page || app.page) - step, session);
  } else if (key === "Home") {
    event.preventDefault();
    goToPage(1, session);
  } else if (key === "End") {
    event.preventDefault();
    goToPage(session?.totalPages || app.totalPages, session);
  } else if (key === "+" || key === "=") {
    event.preventDefault();
    if (!session) return;
    session.zoom = Math.min(3.5, session.zoom + 0.15);
    session.fitMode = "custom";
    syncLegacyDocumentState(session);
    renderPage(session, session.page);
  } else if (key === "-") {
    event.preventDefault();
    if (!session) return;
    session.zoom = Math.max(0.45, session.zoom - 0.15);
    session.fitMode = "custom";
    syncLegacyDocumentState(session);
    renderPage(session, session.page);
  } else if (key === "0") {
    event.preventDefault();
    if (!session) return;
    session.zoom = 1;
    session.fitMode = "custom";
    syncLegacyDocumentState(session);
    renderPage(session, session.page);
  } else if (key === "f" || key === "F") {
    event.preventDefault();
    fitPageWidth().catch(showError);
  } else if (key === "p" || key === "P") {
    event.preventDefault();
    enterPresentationMode().catch(showError);
  } else if (key === "o" || key === "O") {
    event.preventDefault();
    openPicker();
  }
}

function scheduleSave(reason) {
  setSync("Salvando");
  clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => flushState(reason), 1200);
}

async function flushState(reason) {
  clearTimeout(app.saveTimer);
  const tab = activeTab();
  const session = getActiveSession();
  return flushStatePayload(tab, session, reason);
}

async function flushStateForKey(documentKey, reason) {
  clearTimeout(app.saveTimer);
  if (!documentKey) return;
  const tab = app.tabs.find((item) => item.document_key === documentKey) || getSession(documentKey)?.tab || null;
  const session = getSession(documentKey);
  return flushStatePayload(tab, session, reason);
}

async function flushStatePayload(tab, session, reason) {
  if (!tab || !session?.pdf) return;
  try {
    const result = await runtime("pdf.saveState", {
      document_key: tab.document_key,
      path: tab.path,
      name: tab.name,
      page: session.page,
      total_pages: session.totalPages,
      zoom: app.presentationActive ? (app.presentationZoomBefore || session.zoom) : session.zoom,
      scroll_ratio: 0,
      sidebar_open: true,
      last_device_id: app.deviceId,
      reason,
    });
    setSync(result.conflict ? "Estado remoto" : "Sincronizado");
  } catch (error) {
    setSync("Falha ao salvar");
    console.warn("Falha ao salvar estado", error);
  }
}

async function loadDirectory(path = "/") {
  app.currentPath = path || "/";
  els.currentPath.textContent = app.currentPath;
  const data = await runtime("files.listDirectory", { path: app.currentPath });
  renderFileList(data.items || []);
}

function renderFileList(items) {
  const filtered = items.filter((item) => item.is_directory || isPdf(item));
  if (!filtered.length) {
    els.fileList.innerHTML = '<div class="empty-state"><p>Nenhum PDF encontrado aqui.</p></div>';
    return;
  }
  els.fileList.innerHTML = "";
  filtered.forEach((item) => {
    const button = document.createElement("button");
    button.className = "file-row";
    button.type = "button";
    const icon = item.is_directory ? "📁" : "PDF";
    const meta = item.is_directory ? "Pasta" : formatBytes(item.size || item.size_bytes || 0);
    button.innerHTML = `<span>${icon}</span><span><span class="name"></span><span class="meta"></span></span>`;
    button.querySelector(".name").textContent = item.name || item.path;
    button.querySelector(".meta").textContent = meta;
    button.onclick = () => {
      if (item.is_directory) {
        loadDirectory(item.path);
      } else {
        openPdf(item.path, item.name)
          .then(closePicker)
          .catch(showError);
      }
    };
    els.fileList.appendChild(button);
  });
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function searchPdfs(query) {
  if (!query.trim()) {
    await loadDirectory(app.currentPath);
    return;
  }
  const data = await runtime("search.query", { query, limit: 60 });
  renderFileList((data.items || []).filter(isPdf));
}

function showError(error) {
  console.error(error);
  setSync("Erro");
  if (!app.tabs.length) {
    els.empty.classList.remove("hidden");
    els.empty.innerHTML = "";
    const title = document.createElement("h1");
    const message = document.createElement("p");
    title.textContent = "Nao foi possivel abrir";
    message.textContent = error.message || String(error);
    els.empty.append(title, message);
  } else {
    syncEmptyState();
  }
  if (window.TCloudApp?.showToast) {
    window.TCloudApp.showToast(error.message || "Falha ao abrir PDF", "error", 4000);
  }
}

function wireEvents() {
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button");
    if (button && event.detail > 0) {
      setTimeout(() => button.blur(), 0);
    }
  }, true);
  document.getElementById("refresh-list").onclick = () => loadDirectory(app.currentPath).catch(showError);
  document.getElementById("go-root").onclick = () => loadDirectory("/").catch(showError);
  els.openPicker.onclick = openPicker;
  if (els.openPickerReader) els.openPickerReader.onclick = openPicker;
  if (els.settingsToggle) els.settingsToggle.onclick = toggleSettingsPanel;
  if (els.settingsToggleHome) els.settingsToggleHome.onclick = toggleSettingsPanel;
  if (els.settingsClose) els.settingsClose.onclick = () => closeSettingsPanel();
  els.settingsPanel?.querySelectorAll(".pdf-settings-option").forEach((button) => {
    button.onclick = () => {
      const key = button.closest(".pdf-settings-options")?.dataset.preference;
      if (key) setPdfPreference(key, button.dataset.value);
    };
  });
  els.closePicker.onclick = closePicker;
  if (els.emptyOpenPicker) els.emptyOpenPicker.onclick = openPicker;
  els.picker.addEventListener("mousedown", (event) => {
    if (event.target === els.picker) closePicker();
  });
  document.addEventListener("mousedown", (event) => {
    if (!app.settingsOpen) return;
    const target = event.target;
    if (els.settingsPanel?.contains(target) || target?.closest?.(".pdf-settings-toggle")) return;
    closeSettingsPanel({ focusStage: false });
  });
  document.getElementById("first-page").onclick = () => goToPage(1);
  document.getElementById("prev-page").onclick = () => goToPage((getActiveSession()?.page || app.page) - 1);
  document.getElementById("next-page").onclick = () => goToPage((getActiveSession()?.page || app.page) + 1);
  document.getElementById("last-page").onclick = () => goToPage(getActiveSession()?.totalPages || app.totalPages);
  document.getElementById("zoom-out").onclick = async () => {
    const session = getActiveSession();
    if (!session) return;
    session.zoom = Math.max(0.5, session.zoom - 0.15);
    session.fitMode = "custom";
    syncLegacyDocumentState(session);
    await renderPage(session, session.page);
  };
  document.getElementById("zoom-in").onclick = async () => {
    const session = getActiveSession();
    if (!session) return;
    session.zoom = Math.min(3, session.zoom + 0.15);
    session.fitMode = "custom";
    syncLegacyDocumentState(session);
    await renderPage(session, session.page);
  };
  document.getElementById("zoom-reset").onclick = async () => {
    const session = getActiveSession();
    if (!session) return;
    session.zoom = 1;
    session.fitMode = "custom";
    syncLegacyDocumentState(session);
    await renderPage(session, session.page);
  };
  els.fitPage.onclick = () => fitPageToView().catch(showError);
  els.fitWidth.onclick = () => fitPageWidth().catch(showError);
  els.presentationMode.onclick = () => enterPresentationMode().catch(showError);
  els.pageInput.addEventListener("input", () => sanitizePageInputValue(els.pageInput));
  els.pageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitPageInput(els.pageInput, { blur: true }).catch(showError);
    }
  });
  els.pageInput.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = numericInputText(event.clipboardData?.getData("text") || "");
    document.execCommand("insertText", false, text);
  });
  els.pageInput.onblur = () => {
    if (numericInputText(getPageControlText(els.pageInput))) {
      commitPageInput(els.pageInput).catch(showError);
    } else {
      setPageControlText(els.pageInput, String(app.page || 1));
    }
  };
  els.search.oninput = () => {
    clearTimeout(els.search._timer);
    els.search._timer = setTimeout(() => searchPdfs(els.search.value).catch(showError), 250);
  };
  if (els.findInput) {
    els.findInput.addEventListener("input", () => {
      const query = sanitizeFindQuery(getFindInputText());
      if (getFindInputText() !== query) setFindInputText(query);
      scheduleFindSearch();
    });
    els.findInput.addEventListener("keydown", (event) => {
      if (isFindShortcut(event)) {
        event.preventDefault();
        selectFindInput();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) {
          findPreviousResult();
        } else {
          findNextResult();
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeFindPanel();
      }
    });
    els.findInput.addEventListener("paste", (event) => {
      event.preventDefault();
      const query = sanitizeFindQuery(event.clipboardData?.getData("text") || "");
      document.execCommand("insertText", false, query);
    });
  }
  if (els.findPrev) els.findPrev.onclick = () => findPreviousResult();
  if (els.findNext) els.findNext.onclick = () => findNextResult();
  if (els.findClose) els.findClose.onclick = () => closeFindPanel();
  els.stage.addEventListener("wheel", handlePageWheel, { passive: false });
  els.thumbs.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  document.addEventListener("keydown", handlePageKeyboard);
  document.addEventListener("copy", handlePdfTextCopy);
  document.addEventListener("selectionchange", () => {
    if (!debugTextLayerEnabled()) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return;
    logCurrentSelection(selection);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushState("visibilitychange");
  });
  document.addEventListener("fullscreenchange", () => {
    if (app.presentationActive && document.fullscreenElement !== els.shell) {
      app.presentationActive = false;
      els.shell.classList.remove("presentation");
      if (app.presentationZoomBefore) {
        const session = getActiveSession();
        const previousZoom = app.presentationZoomBefore;
        app.presentationZoomBefore = null;
        if (session) {
          session.zoom = previousZoom;
          session.fitMode = app.presentationFitModeBefore || "custom";
          syncLegacyDocumentState(session);
          renderPage(session, session.page).catch(showError);
        }
      }
    }
  });
  window.addEventListener("resize", () => {
    const session = getActiveSession();
    if (!session?.pdf) return;
    clearTimeout(app.resizeTimer);
    app.resizeTimer = setTimeout(() => {
      if (app.presentationActive || session.fitMode === "page") {
        fitPageToView(session).catch(showError);
      } else if (session.fitMode === "width") {
        fitPageWidth(session).catch(showError);
      }
    }, 150);
  });
  window.addEventListener("pagehide", () => flushState("pagehide"));
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === "tcloud-app-command") {
      handleShellCommand(event.data.command, event.data.payload || {}).catch(showError);
      return;
    }
    if (event.data?.type !== "tcloud-app-launch") return;
    const payload = event.data.payload || {};
    if (payload.path) {
      app.pendingLaunches.push(payload);
      consumeLaunches().catch(showError);
    }
  });
}

async function handleShellCommand(command, payload = {}) {
  if (command === "shellTabsReady") return setExternalTabs(true);
  if (command === "openPicker") return openPicker();
  if (command === "openFind") return openFindPanel({ select: true });
  if (command === "openSettings") return openSettingsPanel();
  if (command === "closeSettings") return closeSettingsPanel();
  if (command === "toggleSettings") return toggleSettingsPanel();
  if (command === "openRecentPdf") return openPdf(String(payload.path || ""), String(payload.name || ""));
  if (command === "setPdfPreference") return setPdfPreference(String(payload.key || ""), payload.value);
  if (command === "first") return goToPage(1);
  if (command === "prev") return goToPage(app.page - pageNavigationStep());
  if (command === "next") return goToPage(app.page + pageNavigationStep());
  if (command === "last") return goToPage(app.totalPages);
  if (command === "setPage") return goToPage(parsePageInputValue(payload.page, app.page));
  if (command === "fitPage") return fitPageToView();
  if (command === "fitWidth") return fitPageWidth();
  if (command === "zoomOut") {
    const session = getActiveSession();
    if (!session) return undefined;
    session.zoom = Math.max(0.5, session.zoom - 0.15);
    session.fitMode = "custom";
    syncLegacyDocumentState(session);
    return renderPage(session, session.page);
  }
  if (command === "zoomIn") {
    const session = getActiveSession();
    if (!session) return undefined;
    session.zoom = Math.min(3, session.zoom + 0.15);
    session.fitMode = "custom";
    syncLegacyDocumentState(session);
    return renderPage(session, session.page);
  }
  if (command === "zoomReset") {
    const session = getActiveSession();
    if (!session) return undefined;
    session.zoom = 1;
    session.fitMode = "custom";
    syncLegacyDocumentState(session);
    return renderPage(session, session.page);
  }
  if (command === "switchTab") return switchTab(String(payload.document_key || ""));
  if (command === "closeTab") return closeTab(String(payload.document_key || ""));
  if (command === "setThumbsCollapsed") return setThumbsCollapsed(Boolean(payload.collapsed));
  if (command === "toggleThumbsCollapsed") return toggleThumbsCollapsed();
  if (command === "presentation") return enterPresentationMode();
  return undefined;
}

async function consumeLaunches() {
  if (!app.session) return;
  while (app.pendingLaunches.length) {
    const payload = app.pendingLaunches.shift();
    await openPdf(String(payload.path || ""), String(payload.name || ""));
  }
}

async function start() {
  wireEvents();
  renderThumbsChrome();
  syncSettingsUi();
  setThumbsCollapsed(app.thumbsCollapsed, { persist: false, refit: false });
  setSync("Conectando");
  app.session = await window.TCloudApp.ready();
  await ensurePdfJs();
  await Promise.all([loadDirectory("/"), loadTabs(), loadRecentPdfs()]);
  await consumeLaunches();
  setSync("Pronto");
}

start().catch(showError);
