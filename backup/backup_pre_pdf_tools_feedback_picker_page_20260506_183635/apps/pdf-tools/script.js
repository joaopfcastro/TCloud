const app = {
  session: null,
  pdfjs: null,
  tabs: [],
  activeKey: "",
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
  pageLayer: document.getElementById("page-layer"),
  canvas: document.getElementById("pdf-canvas"),
  textLayer: document.getElementById("text-layer"),
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

function setSync(text) {
  els.sync.textContent = text;
  publishState();
}

function setTextStatus(status, reason = "") {
  app.textStatus = status;
  app.textStatusReason = reason;
  if (els.textLayer) {
    els.textLayer.dataset.textStatus = status;
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

function cancelTextLayerTask() {
  if (app.textLayerTask) {
    app.textLayerTask.cancel();
    app.textLayerTask = null;
  }
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) {
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if ((anchorNode && els.textLayer.contains(anchorNode)) || (focusNode && els.textLayer.contains(focusNode))) {
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
  if (!selection || selection.isCollapsed || !els.textLayer) return false;
  const nodes = [selection.anchorNode, selection.focusNode];
  if (nodes.some((node) => node && els.textLayer.contains(node))) return true;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (range.commonAncestorContainer && els.textLayer.contains(range.commonAncestorContainer)) return true;
  }
  return false;
}

function nearestTextSpan(node) {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return element?.closest?.(".textLayer span:not(.markedContent)") || null;
}

function layerGeometrySnapshot() {
  if (!els.canvas || !els.textLayer || !els.stage) return null;
  const canvas = els.canvas.getBoundingClientRect();
  const textLayer = els.textLayer.getBoundingClientRect();
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

function clearSelectionDebugRects() {
  els.pageLayer?.querySelector(".text-debug-overlay")?.remove();
}

function drawSelectionDebugRects(rects) {
  if (!debugTextLayerEnabled() || !els.pageLayer) return;
  clearSelectionDebugRects();
  const pageRect = els.pageLayer.getBoundingClientRect();
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
  els.pageLayer.appendChild(overlay);
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
  const selection = document.getSelection();
  if (!selectionInsideTextLayer(selection)) return;
  const rawText = selection.toString();
  const copiedText = normalizeCopiedText(rawText);
  if (copiedText.length < 2 || !event.clipboardData) return;
  event.clipboardData.setData("text/plain", copiedText);
  event.preventDefault();
  debugTextLayer("copy", {
    page: app.page,
    rawText,
    copiedText,
    geometry: layerGeometrySnapshot(),
  });
}

function logCurrentSelection(selection) {
  if (!selectionInsideTextLayer(selection)) return;
  const rects = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    rects.push(...Array.from(selection.getRangeAt(index).getClientRects()));
  }
  const anchorSpan = nearestTextSpan(selection.anchorNode);
  const focusSpan = nearestTextSpan(selection.focusNode);
  drawSelectionDebugRects(rects);
  debugTextLayer("selection", {
    page: app.page,
    selectionText: selection.toString(),
    selectionLength: selection.toString().length,
    rangeCount: selection.rangeCount,
    rangeRects: rects.map(rectSnapshot),
    geometry: layerGeometrySnapshot(),
    zoom: app.zoom,
    fitMode: app.fitMode,
    presentationActive: app.presentationActive,
    devicePixelRatio: window.devicePixelRatio || 1,
    textStatus: app.textStatus,
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
  await flushState("troca de aba");
  app.activeKey = documentKey;
  renderTabs();
  await saveTabs();
  closePicker();
  await loadActiveTab();
}

async function closeTab(documentKey) {
  if (documentKey === app.activeKey) {
    await flushState("fechar aba");
  }
  app.tabs = app.tabs.filter((tab) => tab.document_key !== documentKey);
  if (app.activeKey === documentKey) {
    app.activeKey = app.tabs[0]?.document_key || "";
  }
  renderTabs();
  await saveTabs();
  if (app.activeKey) {
    await loadActiveTab();
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
      app.tabs.shift();
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
  await loadActiveTab();
}

async function loadActiveTab() {
  const tab = activeTab();
  if (!tab) {
    clearDocument();
    return;
  }

  setSync("Carregando");
  clearRenderState(false);
  const pdfjs = await ensurePdfJs();
  const stream = await runtime("files.getStreamUrl", { path: tab.path });
  const url = new URL(stream.url, window.location.origin).toString();
  app.pdf = await pdfjs.getDocument({
    url,
    httpHeaders: stream.headers || {},
    withCredentials: false,
    rangeChunkSize: 65536,
  }).promise;
  app.totalPages = app.pdf.numPages;
  const saved = await runtime("pdf.getState", {
    path: tab.path,
    document_key: tab.document_key,
  });
  const savedState = saved.state || {};
  app.page = Math.min(app.totalPages, Math.max(1, Number(savedState.page || 1)));
  app.zoom = await computeFitPageZoom(app.page);
  app.fitMode = "page";
  updateToolbar();
  renderThumbs();
  await renderPage(app.page);
  setSync("Sincronizado");
}

function clearRenderState(removeTabs = true) {
  app.renderGeneration += 1;
  if (app.renderTask) {
    app.renderTask.cancel();
    app.renderTask = null;
  }
  cancelTextLayerTask();
  setTextStatus("idle");
  if (app.thumbObserver) {
    app.thumbObserver.disconnect();
    app.thumbObserver = null;
  }
  app.renderedThumbs.clear();
  app.pdf = null;
  app.page = 1;
  app.totalPages = 0;
  renderThumbsChrome();
  els.pageLayer.style.display = "none";
  els.textLayer.replaceChildren();
  els.empty.classList.remove("hidden");
  if (removeTabs) {
    app.tabs = [];
    app.activeKey = "";
    renderTabs();
  }
  updateToolbar();
}

function clearDocument() {
  clearRenderState(false);
  els.empty.classList.remove("hidden");
  setSync("Pronto");
}

function updateToolbar() {
  if (document.activeElement !== els.pageInput) {
    els.pageInput.value = String(app.page || 1);
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
  const cleaned = numericInputText(input.value);
  if (input.value !== cleaned) {
    input.value = cleaned;
  }
}

async function commitPageInput(input = els.pageInput, options = {}) {
  if (!input) return;
  const target = parsePageInputValue(input.value, app.page);
  input.value = String(target);
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

function applyPageGeometry(viewport, outputScale, pageNumber, generation) {
  const cssWidth = `${viewport.width}px`;
  const cssHeight = `${viewport.height}px`;
  els.canvas.width = Math.ceil(viewport.width * outputScale);
  els.canvas.height = Math.ceil(viewport.height * outputScale);
  els.canvas.style.width = cssWidth;
  els.canvas.style.height = cssHeight;
  els.pageLayer.style.width = cssWidth;
  els.pageLayer.style.height = cssHeight;
  els.pageLayer.style.display = "block";
  els.pageLayer.dataset.zoom = String(app.zoom || viewport.scale || 1);
  els.pageLayer.dataset.outputScale = String(outputScale);
  els.textLayer.style.width = cssWidth;
  els.textLayer.style.height = cssHeight;
  els.textLayer.style.setProperty("--total-scale-factor", String(viewport.scale || app.zoom || 1));
  els.textLayer.style.setProperty("--scale-round-x", "1px");
  els.textLayer.style.setProperty("--scale-round-y", "1px");
  els.textLayer.dataset.page = String(pageNumber);
  els.textLayer.dataset.generation = String(generation);
  els.textLayer.setAttribute("data-main-rotation", String(viewport.rotation || 0));
  return { cssWidth, cssHeight };
}

async function renderPage(pageNumber) {
  if (!app.pdf) return;
  const generation = app.renderGeneration + 1;
  app.renderGeneration = generation;
  if (app.renderTask) {
    app.renderTask.cancel();
    app.renderTask = null;
  }
  cancelTextLayerTask();
  clearSelectionDebugRects();
  setTextStatus("loading");
  const page = await app.pdf.getPage(pageNumber);
  if (generation !== app.renderGeneration) return;
  const viewport = page.getViewport({ scale: app.zoom });
  const outputScale = Math.max(1, window.devicePixelRatio || 1);
  const context = els.canvas.getContext("2d", { alpha: false });
  const { cssWidth, cssHeight } = applyPageGeometry(viewport, outputScale, pageNumber, generation);
  els.textLayer.replaceChildren();
  els.empty.classList.add("hidden");
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  app.renderTask = page.render({ canvasContext: context, viewport, transform });
  debugTextLayer("renderPage:start", {
    pageNumber,
    zoom: app.zoom,
    outputScale,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    canvasWidth: els.canvas.width,
    canvasHeight: els.canvas.height,
    cssWidth,
    cssHeight,
  });
  try {
    await app.renderTask.promise;
  } catch (error) {
    if (generation === app.renderGeneration) app.renderTask = null;
    if (error?.name === "RenderingCancelledException") return;
    throw error;
  }
  if (generation !== app.renderGeneration) return;
  app.renderTask = null;
  await renderTextLayer(page, viewport, generation);
  if (generation !== app.renderGeneration) return;
  app.page = pageNumber;
  els.stage.scrollTop = 0;
  els.stage.scrollLeft = 0;
  updateToolbar();
  markActiveThumb();
  scheduleSave("pagina");
}

async function renderTextLayer(page, viewport, generation) {
  cancelTextLayerTask();
  clearSelectionDebugRects();
  els.textLayer.replaceChildren();
  els.textLayer.setAttribute("data-main-rotation", String(viewport.rotation || 0));
  const textContent = await page.getTextContent({ includeMarkedContent: true });
  if (generation !== app.renderGeneration) return;
  const textLayer = new app.pdfjs.TextLayer({
    textContentSource: textContent,
    container: els.textLayer,
    viewport,
  });
  app.textLayerTask = textLayer;
  try {
    await textLayer.render();
    if (generation !== app.renderGeneration) return;
    const analysis = analyzeTextContent(textContent, els.textLayer, viewport);
    const geometry = layerGeometrySnapshot();
    if (geometry && geometry.maxDelta > 0.75) {
      setTextStatus("native_text_suspect", `camada textual desalinhada (${geometry.maxDelta}px)`);
    } else {
      setTextStatus(analysis.status, analysis.reason);
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
      if (generation === app.renderGeneration) {
        setTextStatus("render_error", error.message || String(error));
      }
    }
  } finally {
    if (app.textLayerTask === textLayer) {
      app.textLayerTask = null;
    }
  }
}

async function fitPageWidth() {
  if (!app.pdf) return;
  app.fitMode = "width";
  const page = await app.pdf.getPage(app.page);
  const viewport = page.getViewport({ scale: 1 });
  const available = Math.max(320, els.stage.clientWidth - 72);
  app.zoom = Math.max(0.45, Math.min(3.5, available / viewport.width));
  await renderPage(app.page);
}

async function computeFitPageZoom(pageNumber = app.page) {
  if (!app.pdf) return 1;
  const page = await app.pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const horizontalPadding = app.presentationActive ? 24 : 56;
  const verticalPadding = app.presentationActive ? 24 : 56;
  const availableWidth = Math.max(320, els.stage.clientWidth - horizontalPadding);
  const availableHeight = Math.max(320, els.stage.clientHeight - verticalPadding);
  return Math.max(0.35, Math.min(3.5, availableWidth / viewport.width, availableHeight / viewport.height));
}

async function fitPageToView() {
  if (!app.pdf) return;
  app.fitMode = "page";
  app.zoom = await computeFitPageZoom(app.page);
  await renderPage(app.page);
}

async function enterPresentationMode() {
  if (!app.pdf || app.presentationActive) return;
  app.presentationActive = true;
  app.presentationZoomBefore = app.zoom;
  app.presentationFitModeBefore = app.fitMode;
  els.shell.classList.add("presentation");
  try {
    await els.shell.requestFullscreen?.();
  } catch (error) {
    console.warn("Fullscreen API indisponivel para apresentacao", error);
  }
  await fitPageToView();
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
    app.zoom = app.presentationZoomBefore;
    app.fitMode = app.presentationFitModeBefore || "custom";
    app.presentationZoomBefore = null;
    await renderPage(app.page);
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
  const list = document.createElement("div");
  list.className = "thumbs-list";
  els.thumbsList = list;

  els.thumbs.append(header, list);
  updateThumbsToggle();
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

  if (options.refit !== false && app.pdf) {
    setTimeout(() => {
      if (app.presentationActive || app.fitMode === "page") {
        fitPageToView().catch(showError);
      } else if (app.fitMode === "width") {
        fitPageWidth().catch(showError);
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
  if (changed && enabled && app.pdf && (app.presentationActive || app.fitMode === "page")) {
    setTimeout(() => fitPageToView().catch(showError), 0);
  }
}

function renderThumbs() {
  renderThumbsChrome();
  if (!app.pdf) return;
  const list = els.thumbsList || els.thumbs;
  app.thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        renderThumb(Number(entry.target.dataset.page), entry.target);
      }
    });
  }, { root: list, rootMargin: "160px" });

  for (let page = 1; page <= app.totalPages; page += 1) {
    const button = document.createElement("button");
    button.className = "thumb";
    button.type = "button";
    button.dataset.page = String(page);
    button.innerHTML = `<canvas></canvas><span>Pagina ${page}</span>`;
    button.onclick = () => goToPage(page);
    list.appendChild(button);
    app.thumbObserver.observe(button);
  }
  markActiveThumb();
}

async function renderThumb(pageNumber, node) {
  if (!app.pdf || app.renderedThumbs.has(pageNumber)) return;
  app.renderedThumbs.add(pageNumber);
  try {
    const page = await app.pdf.getPage(pageNumber);
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

function markActiveThumb() {
  const list = els.thumbsList || els.thumbs;
  list.querySelectorAll(".thumb").forEach((node) => {
    node.classList.toggle("active", Number(node.dataset.page) === app.page);
  });
  const active = list.querySelector(".thumb.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

async function goToPage(pageNumber) {
  const target = Math.min(app.totalPages, Math.max(1, Number(pageNumber || 1)));
  if (!target || target === app.page) return;
  if (app.presentationActive || app.fitMode === "page") {
    app.zoom = await computeFitPageZoom(target);
  } else if (app.fitMode === "width") {
    const page = await app.pdf.getPage(target);
    const viewport = page.getViewport({ scale: 1 });
    const available = Math.max(320, els.stage.clientWidth - 72);
    app.zoom = Math.max(0.45, Math.min(3.5, available / viewport.width));
  }
  await renderPage(target);
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
  if (!app.pdf || event.ctrlKey || event.metaKey) return;
  if (canStageScroll(event.deltaY)) return;
  event.preventDefault();
  app.wheelAccumulator += event.deltaY;
  if (Math.abs(app.wheelAccumulator) < 72) return;
  const direction = app.wheelAccumulator > 0 ? 1 : -1;
  app.wheelAccumulator = 0;
  goToPage(app.page + direction);
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
  if (tagName === "input" || tagName === "textarea" || event.metaKey || event.ctrlKey || event.altKey) return;

  const key = event.key;
  if (app.presentationActive && key === "Escape") {
    event.preventDefault();
    exitPresentationMode().catch(showError);
    return;
  }

  if (key === "ArrowDown" || key === "ArrowRight" || key === "PageDown" || key === " ") {
    event.preventDefault();
    goToPage(app.page + 1);
  } else if (key === "ArrowUp" || key === "ArrowLeft" || key === "PageUp") {
    event.preventDefault();
    goToPage(app.page - 1);
  } else if (key === "Home") {
    event.preventDefault();
    goToPage(1);
  } else if (key === "End") {
    event.preventDefault();
    goToPage(app.totalPages);
  } else if (key === "+" || key === "=") {
    event.preventDefault();
    app.zoom = Math.min(3.5, app.zoom + 0.15);
    renderPage(app.page);
  } else if (key === "-") {
    event.preventDefault();
    app.zoom = Math.max(0.45, app.zoom - 0.15);
    renderPage(app.page);
  } else if (key === "0") {
    event.preventDefault();
    app.zoom = 1;
    app.fitMode = "custom";
    renderPage(app.page);
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
  if (!tab || !app.pdf) return;
  try {
    const result = await runtime("pdf.saveState", {
      document_key: tab.document_key,
      path: tab.path,
      name: tab.name,
      page: app.page,
      total_pages: app.totalPages,
      zoom: app.presentationActive ? (app.presentationZoomBefore || app.zoom) : app.zoom,
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
        openPdf(item.path, item.name).catch(showError);
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
  els.empty.classList.remove("hidden");
  els.empty.innerHTML = "";
  const title = document.createElement("h1");
  const message = document.createElement("p");
  title.textContent = "Nao foi possivel abrir";
  message.textContent = error.message || String(error);
  els.empty.append(title, message);
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
  document.getElementById("prev-page").onclick = () => goToPage(app.page - 1);
  document.getElementById("next-page").onclick = () => goToPage(app.page + 1);
  document.getElementById("last-page").onclick = () => goToPage(app.totalPages);
  document.getElementById("zoom-out").onclick = async () => {
    app.zoom = Math.max(0.5, app.zoom - 0.15);
    app.fitMode = "custom";
    await renderPage(app.page);
  };
  document.getElementById("zoom-in").onclick = async () => {
    app.zoom = Math.min(3, app.zoom + 0.15);
    app.fitMode = "custom";
    await renderPage(app.page);
  };
  document.getElementById("zoom-reset").onclick = async () => {
    app.zoom = 1;
    app.fitMode = "custom";
    await renderPage(app.page);
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
  els.pageInput.onchange = () => commitPageInput(els.pageInput).catch(showError);
  els.pageInput.onblur = () => {
    els.pageInput.value = String(app.page || 1);
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
        const previousZoom = app.presentationZoomBefore;
        app.presentationZoomBefore = null;
        app.zoom = previousZoom;
        app.fitMode = app.presentationFitModeBefore || "custom";
        renderPage(app.page).catch(showError);
      }
    }
  });
  window.addEventListener("resize", () => {
    if (!app.pdf) return;
    clearTimeout(app.resizeTimer);
    app.resizeTimer = setTimeout(() => {
      if (app.presentationActive || app.fitMode === "page") {
        fitPageToView().catch(showError);
      } else if (app.fitMode === "width") {
        fitPageWidth().catch(showError);
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
    app.zoom = Math.max(0.5, app.zoom - 0.15);
    app.fitMode = "custom";
    return renderPage(app.page);
  }
  if (command === "zoomIn") {
    app.zoom = Math.min(3, app.zoom + 0.15);
    app.fitMode = "custom";
    return renderPage(app.page);
  }
  if (command === "zoomReset") {
    app.zoom = 1;
    app.fitMode = "custom";
    return renderPage(app.page);
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
