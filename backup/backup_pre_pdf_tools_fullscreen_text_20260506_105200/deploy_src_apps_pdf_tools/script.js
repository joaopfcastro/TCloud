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
  thumbObserver: null,
  renderedThumbs: new Set(),
  saveTimer: null,
  deviceId: `web:${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)}`,
  pendingLaunches: [],
  wheelAccumulator: 0,
};

const els = {
  picker: document.getElementById("picker"),
  tabs: document.getElementById("tabs"),
  fileList: document.getElementById("file-list"),
  search: document.getElementById("pdf-search"),
  currentPath: document.getElementById("current-path"),
  thumbs: document.getElementById("thumbs"),
  stage: document.getElementById("page-stage"),
  canvas: document.getElementById("pdf-canvas"),
  empty: document.getElementById("empty-state"),
  pageInput: document.getElementById("page-input"),
  pageTotal: document.getElementById("page-total"),
  sync: document.getElementById("sync-state"),
  zoomReset: document.getElementById("zoom-reset"),
  openPicker: document.getElementById("open-picker"),
  closePicker: document.getElementById("close-picker"),
  emptyOpenPicker: document.getElementById("empty-open-picker"),
};

function setSync(text) {
  els.sync.textContent = text;
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
}

async function switchTab(documentKey) {
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
  app.zoom = Math.max(0.5, Math.min(3, Number(savedState.zoom || 1)));
  updateToolbar();
  renderThumbs();
  await renderPage(app.page);
  setSync("Sincronizado");
}

function clearRenderState(removeTabs = true) {
  if (app.renderTask) {
    app.renderTask.cancel();
    app.renderTask = null;
  }
  if (app.thumbObserver) {
    app.thumbObserver.disconnect();
    app.thumbObserver = null;
  }
  app.renderedThumbs.clear();
  app.pdf = null;
  app.page = 1;
  app.totalPages = 0;
  els.thumbs.innerHTML = "";
  els.canvas.style.display = "none";
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
  els.pageInput.value = String(app.page || 1);
  els.pageInput.max = String(app.totalPages || 1);
  els.pageTotal.textContent = `/ ${app.totalPages || 0}`;
  els.zoomReset.textContent = `${Math.round((app.zoom || 1) * 100)}%`;
}

async function renderPage(pageNumber) {
  if (!app.pdf) return;
  if (app.renderTask) {
    app.renderTask.cancel();
    app.renderTask = null;
  }
  const page = await app.pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: app.zoom * window.devicePixelRatio });
  const cssViewport = page.getViewport({ scale: app.zoom });
  const context = els.canvas.getContext("2d", { alpha: false });
  els.canvas.width = Math.floor(viewport.width);
  els.canvas.height = Math.floor(viewport.height);
  els.canvas.style.width = `${Math.floor(cssViewport.width)}px`;
  els.canvas.style.height = `${Math.floor(cssViewport.height)}px`;
  els.canvas.style.display = "block";
  els.empty.classList.add("hidden");
  app.renderTask = page.render({ canvasContext: context, viewport });
  await app.renderTask.promise;
  app.renderTask = null;
  app.page = pageNumber;
  els.stage.scrollTop = 0;
  els.stage.scrollLeft = 0;
  updateToolbar();
  markActiveThumb();
  scheduleSave("pagina");
}

function renderThumbs() {
  els.thumbs.innerHTML = "";
  if (!app.pdf) return;
  app.thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        renderThumb(Number(entry.target.dataset.page), entry.target);
      }
    });
  }, { root: els.thumbs, rootMargin: "160px" });

  for (let page = 1; page <= app.totalPages; page += 1) {
    const button = document.createElement("button");
    button.className = "thumb";
    button.type = "button";
    button.dataset.page = String(page);
    button.innerHTML = `<canvas></canvas><span>Pagina ${page}</span>`;
    button.onclick = () => goToPage(page);
    els.thumbs.appendChild(button);
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
    canvas.style.height = `${Math.max(88, Math.floor(cssViewport.height))}px`;
    await page.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport,
    }).promise;
  } catch (error) {
    console.warn("Falha ao renderizar miniatura", error);
  }
}

function markActiveThumb() {
  els.thumbs.querySelectorAll(".thumb").forEach((node) => {
    node.classList.toggle("active", Number(node.dataset.page) === app.page);
  });
  const active = els.thumbs.querySelector(".thumb.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

async function goToPage(pageNumber) {
  const target = Math.min(app.totalPages, Math.max(1, Number(pageNumber || 1)));
  if (!target || target === app.page) return;
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
      zoom: app.zoom,
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
  document.getElementById("refresh-list").onclick = () => loadDirectory(app.currentPath).catch(showError);
  document.getElementById("go-root").onclick = () => loadDirectory("/").catch(showError);
  els.openPicker.onclick = openPicker;
  els.closePicker.onclick = closePicker;
  if (els.emptyOpenPicker) els.emptyOpenPicker.onclick = openPicker;
  els.picker.addEventListener("mousedown", (event) => {
    if (event.target === els.picker) closePicker();
  });
  document.getElementById("prev-page").onclick = () => goToPage(app.page - 1);
  document.getElementById("next-page").onclick = () => goToPage(app.page + 1);
  document.getElementById("zoom-out").onclick = async () => {
    app.zoom = Math.max(0.5, app.zoom - 0.15);
    await renderPage(app.page);
  };
  document.getElementById("zoom-in").onclick = async () => {
    app.zoom = Math.min(3, app.zoom + 0.15);
    await renderPage(app.page);
  };
  document.getElementById("zoom-reset").onclick = async () => {
    app.zoom = 1;
    await renderPage(app.page);
  };
  els.pageInput.onchange = () => goToPage(els.pageInput.value);
  els.search.oninput = () => {
    clearTimeout(els.search._timer);
    els.search._timer = setTimeout(() => searchPdfs(els.search.value).catch(showError), 250);
  };
  els.stage.addEventListener("wheel", handlePageWheel, { passive: false });
  els.thumbs.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  document.addEventListener("keydown", handlePageKeyboard);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushState("visibilitychange");
  });
  window.addEventListener("pagehide", () => flushState("pagehide"));
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type !== "tcloud-app-launch") return;
    const payload = event.data.payload || {};
    if (payload.path) {
      app.pendingLaunches.push(payload);
      consumeLaunches().catch(showError);
    }
  });
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
  setSync("Conectando");
  app.session = await window.TCloudApp.ready();
  await ensurePdfJs();
  await Promise.all([loadDirectory("/"), loadTabs()]);
  await consumeLaunches();
  setSync("Pronto");
}

start().catch(showError);
