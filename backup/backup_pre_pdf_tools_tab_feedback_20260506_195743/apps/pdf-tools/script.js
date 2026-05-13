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
  wheelAccumulator: 0,
  fitMode: "page",
  presentationActive: false,
  presentationZoomBefore: null,
  presentationFitModeBefore: "page",
  renderGeneration: 0,
  textStatus: "idle",
  textStatusReason: "",
  thumbsCollapsed: (() => {
    try {
      return localStorage.getItem("pdf-tools.thumbsCollapsed") === "1";
    } catch (error) {
      return false;
    }
  })(),
  externalTabs: false,
};

const els = {
  picker: document.getElementById("picker"),
  tabs: document.getElementById("tabs"),
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
  shell: document.querySelector(".app-shell"),
  openPicker: document.getElementById("open-picker"),
  closePicker: document.getElementById("close-picker"),
  emptyOpenPicker: document.getElementById("empty-open-picker"),
};

const DEFAULT_EMPTY_HTML = els.empty.innerHTML;
const PDF_RANGE_CHUNK_SIZE = 65536;

function debugPerfEnabled() {
  try {
    return localStorage.getItem("pdf-tools.debugPerf") === "1";
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

function syncEmptyState() {
  const shouldShow = app.tabs.length === 0;
  els.empty.classList.toggle("hidden", !shouldShow);
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
  loading.textContent = "Carregando PDF";

  const pageLayer = document.createElement("div");
  pageLayer.className = "page-layer";

  const canvas = document.createElement("canvas");
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  textLayer.setAttribute("aria-label", "Texto da pagina");

  pageLayer.append(canvas, textLayer);
  view.append(loading, pageLayer);
  els.documentHost.appendChild(view);

  return { view, loading, pageLayer, canvas, textLayer, thumbsList: null };
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
    textLayerTask: null,
    renderedThumbs: new Set(),
    thumbObserver: null,
    stream: null,
    error: null,
    hasRender: false,
    destroyed: false,
    textStatus: "idle",
    textStatusReason: "",
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
  els.picker.classList.add("open");
  setTimeout(() => els.search.focus(), 0);
}

function closePicker() {
  els.picker.classList.remove("open");
  els.stage.focus();
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
  markPdfPerf("tab:switch-click", { documentKey });
  await flushState("troca de aba");
  app.activeKey = documentKey;
  renderTabs();
  await saveTabs();
  closePicker();
  const session = activateSession(documentKey, { keepPreviousVisibleUntilReady: true });
  if (!session) return;
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
  await saveTabs();
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
  await saveTabs();
  const session = activateSession(documentKey, { keepPreviousVisibleUntilReady: true });
  await ensureSessionLoaded(session);
  if (app.activeKey === documentKey) {
    activateSession(documentKey);
    setSync("Sincronizado");
  }
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
  activateSession(tab.document_key, { keepPreviousVisibleUntilReady: true });
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
  session.elements.loading.textContent = "Carregando PDF";
  session.elements.view.classList.add("loading");
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
      const savedState = saved.state || {};
      session.page = Math.min(session.totalPages, Math.max(1, Number(savedState.page || 1)));
      session.fitMode = "page";
      session.zoom = await computeFitPageZoom(session, session.page);
      renderThumbs(session);
      await renderPage(session, session.page);
      if (session.destroyed) return session;
      session.status = "ready";
      session.error = null;
      session.elements.view.classList.remove("loading");
      session.elements.view.classList.add("has-render");
      if (session.documentKey === app.activeKey) {
        syncLegacyDocumentState(session);
        updateToolbar();
      }
      return session;
    } catch (error) {
      session.status = "error";
      session.error = error;
      session.elements.view.classList.remove("loading");
      session.elements.loading.textContent = "Nao foi possivel abrir";
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

function publishState() {
  window.parent.postMessage(
    {
      type: "tcloud-app-state",
      app_id: "pdf-tools",
      page: app.page || 1,
      total_pages: app.totalPages || 0,
      zoom: app.zoom || 1,
      sync: els.sync?.textContent || "Pronto",
      text_status: app.textStatus || "idle",
      text_status_reason: app.textStatusReason || "",
      active_document_key: app.activeKey || "",
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
  const { canvas, pageLayer, textLayer } = session.elements;
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
  return { cssWidth, cssHeight };
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
  setTextStatus("loading", "", session);
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
  await renderTextLayer(session, page, viewport, generation);
  if (generation !== session.renderGeneration || session.destroyed) return;
  session.page = pageNumber;
  session.hasRender = true;
  session.elements.view.classList.add("has-render");
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
  const available = Math.max(320, els.stage.clientWidth - 72);
  session.zoom = Math.max(0.45, Math.min(3.5, available / viewport.width));
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
  const availableWidth = Math.max(320, els.stage.clientWidth - horizontalPadding);
  const availableHeight = Math.max(320, els.stage.clientHeight - verticalPadding);
  return Math.max(0.35, Math.min(3.5, availableWidth / viewport.width, availableHeight / viewport.height));
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
  if (session.elements.thumbsList && session.elements.thumbsList.childElementCount > 0) {
    showThumbsForSession(session);
    return;
  }
  const list = createThumbsList(session);
  session.thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        renderThumb(session, Number(entry.target.dataset.page), entry.target);
      }
    });
  }, { root: list, rootMargin: "160px" });

  for (let page = 1; page <= session.totalPages; page += 1) {
    const button = document.createElement("button");
    button.className = "thumb";
    button.type = "button";
    button.dataset.page = String(page);
    button.innerHTML = `<canvas></canvas><span>Pagina ${page}</span>`;
    button.onclick = () => goToPage(page, session);
    list.appendChild(button);
    session.thumbObserver.observe(button);
  }
  showThumbsForSession(session);
}

async function renderThumb(session, pageNumber, node) {
  if (!session?.pdf || session.renderedThumbs.has(pageNumber) || session.destroyed) return;
  session.renderedThumbs.add(pageNumber);
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
  } catch (error) {
    console.warn("Falha ao renderizar miniatura", error);
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

async function goToPage(pageNumber, session = getActiveSession()) {
  if (!session?.pdf) return;
  const target = Math.min(session.totalPages, Math.max(1, Number(pageNumber || 1)));
  if (!target || target === session.page) return;
  if (app.presentationActive || session.fitMode === "page") {
    session.zoom = await computeFitPageZoom(session, target);
  } else if (session.fitMode === "width") {
    const page = await session.pdf.getPage(target);
    const viewport = page.getViewport({ scale: 1 });
    const available = Math.max(320, els.stage.clientWidth - 72);
    session.zoom = Math.max(0.45, Math.min(3.5, available / viewport.width));
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
  if (canStageScroll(event.deltaY)) return;
  event.preventDefault();
  app.wheelAccumulator += event.deltaY;
  if (Math.abs(app.wheelAccumulator) < 72) return;
  const direction = app.wheelAccumulator > 0 ? 1 : -1;
  app.wheelAccumulator = 0;
  goToPage(session.page + direction, session);
}

function handlePageKeyboard(event) {
  if (els.picker.classList.contains("open")) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePicker();
    }
    return;
  }

  const tagName = String(event.target?.tagName || "").toLowerCase();
  if (tagName === "input" || tagName === "textarea" || event.target?.isContentEditable || event.metaKey || event.ctrlKey || event.altKey) return;

  const key = event.key;
  if (app.presentationActive && key === "Escape") {
    event.preventDefault();
    exitPresentationMode().catch(showError);
    return;
  }
  const session = getActiveSession();

  if (key === "ArrowDown" || key === "ArrowRight" || key === "PageDown" || key === " ") {
    event.preventDefault();
    goToPage((session?.page || app.page) + 1, session);
  } else if (key === "ArrowUp" || key === "ArrowLeft" || key === "PageUp") {
    event.preventDefault();
    goToPage((session?.page || app.page) - 1, session);
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
  els.closePicker.onclick = closePicker;
  if (els.emptyOpenPicker) els.emptyOpenPicker.onclick = openPicker;
  els.picker.addEventListener("mousedown", (event) => {
    if (event.target === els.picker) closePicker();
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
  if (command === "first") return goToPage(1);
  if (command === "prev") return goToPage(app.page - 1);
  if (command === "next") return goToPage(app.page + 1);
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
  setThumbsCollapsed(app.thumbsCollapsed, { persist: false, refit: false });
  setSync("Conectando");
  app.session = await window.TCloudApp.ready();
  await ensurePdfJs();
  await Promise.all([loadDirectory("/"), loadTabs()]);
  await consumeLaunches();
  setSync("Pronto");
}

start().catch(showError);
