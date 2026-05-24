function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizePath(path) {
  const clean = String(path || "/").replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!clean || clean === ".") return "/";
  if (!clean.startsWith("/")) return `/${clean}`;
  return clean.length > 1 ? clean.replace(/\/$/, "") : clean;
}

const _EXT_KIND = {
  mp4:'video', mkv:'video', avi:'video', mov:'video', webm:'video', flv:'video', m4v:'video', wmv:'video',
  mp3:'audio', flac:'audio', ogg:'audio', aac:'audio', wav:'audio', wma:'audio', m4a:'audio', opus:'audio',
  jpg:'image', jpeg:'image', png:'image', gif:'image', bmp:'image', svg:'image', webp:'image', heic:'image', ico:'image',
  pdf:'pdf',
  doc:'document', docx:'document', odt:'document', rtf:'document',
  xls:'spreadsheet', xlsx:'spreadsheet', ods:'spreadsheet', csv:'spreadsheet',
  ppt:'presentation', pptx:'presentation', odp:'presentation', key:'presentation',
  txt:'text', md:'text', log:'text',
  json:'code', xml:'code', yaml:'code', yml:'code', toml:'code', ini:'code', js:'code', ts:'code', jsx:'code', tsx:'code', py:'code', java:'code', kt:'code', sh:'code', css:'code', html:'code', htm:'code', sql:'code', rb:'code', go:'code', rs:'code', swift:'code', c:'code', cpp:'code', h:'code',
  srt:'subtitle', ass:'subtitle', ssa:'subtitle', vtt:'subtitle',
  zip:'archive', rar:'archive', '7z':'archive', tar:'archive', gz:'archive', bz2:'archive', xz:'archive', zst:'archive',
  dmg:'disk-image', iso:'disk-image', img:'disk-image',
  apk:'app-package', exe:'app-package', msi:'app-package', app:'app-package', deb:'app-package', rpm:'app-package', pkg:'app-package',
  torrent:'torrent',
};

const _COMPOSITE_EXTS = [
  ['tar.gz', 'archive'],
  ['tar.bz2', 'archive'],
  ['tar.xz', 'archive'],
  ['tar.zst', 'archive'],
];

const _KIND_ICON = {
  folder:         { icon: 'ph-fill ph-folder',                  cls: 'folder-icon'  },
  video:          { icon: 'ph-fill ph-film-strip',              cls: 'video-icon'   },
  audio:          { icon: 'ph-fill ph-music-notes-simple',      cls: 'audio-icon'   },
  image:          { icon: 'ph-fill ph-image',                   cls: 'image-icon'   },
  pdf:            { icon: 'ph-fill ph-file-text',               cls: 'pdf-icon'     },
  document:       { icon: 'ph-fill ph-file-text',               cls: 'doc-icon'     },
  spreadsheet:    { icon: 'ph-fill ph-table',                   cls: 'xls-icon'     },
  presentation:   { icon: 'ph-fill ph-presentation-chart',      cls: 'ppt-icon'     },
  text:           { icon: 'ph-fill ph-file-text',               cls: 'text-icon'    },
  code:           { icon: 'ph-fill ph-code',                    cls: 'code-icon'    },
  subtitle:       { icon: 'ph-fill ph-chat-circle-text',        cls: 'sub-icon'     },
  archive:        { icon: 'ph-fill ph-archive-box',             cls: 'archive-icon' },
  'disk-image':   { icon: 'ph-fill ph-disc',                    cls: 'disc-icon'    },
  'app-package':  { icon: 'ph-fill ph-app-window',              cls: 'app-icon'     },
  torrent:        { icon: 'ph-fill ph-magnet',                  cls: 'torrent-icon' },
  'generic-file': { icon: 'ph-fill ph-file',                    cls: 'file-icon'    },
};

const _KIND_LABEL_PT = {
  folder:         'Pasta',
  video:          'Vídeo',
  audio:          'Áudio',
  image:          'Imagem',
  pdf:            'PDF',
  document:       'Documento',
  spreadsheet:    'Planilha',
  presentation:   'Apresentação',
  text:           'Texto',
  code:           'Código',
  subtitle:       'Legenda',
  archive:        'Compactado',
  'disk-image':   'Imagem de disco',
  'app-package':  'Aplicativo',
  torrent:        'Torrent',
  'generic-file': 'Arquivo',
};

function kindFromMime(mime) {
  if (!mime) return undefined;
  if (mime === 'application/pdf') return 'pdf';
  if (mime.indexOf('video/') === 0) return 'video';
  if (mime.indexOf('audio/') === 0) return 'audio';
  if (mime.indexOf('image/') === 0) return 'image';
  return undefined;
}

function resolveKind(item) {
  if (item?.is_directory) return 'folder';
  const nameLower = (item?.name || '').toLowerCase();
  for (let ci = 0; ci < _COMPOSITE_EXTS.length; ci++) {
    if (nameLower.endsWith('.' + _COMPOSITE_EXTS[ci][0])) return _COMPOSITE_EXTS[ci][1];
  }
  const mimeKind = kindFromMime(item?.mime_type || item?.mime);
  if (mimeKind) return mimeKind;
  const dotIdx = nameLower.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = nameLower.substring(dotIdx + 1);
    if (_EXT_KIND[ext]) return _EXT_KIND[ext];
  }
  return 'generic-file';
}

function resolveBrowserItemPresentation(item) {
  const kind = resolveKind(item);
  const iconEntry = _KIND_ICON[kind] || _KIND_ICON['generic-file'];
  return {
    kind:          kind,
    labelPt:       _KIND_LABEL_PT[kind] || 'Arquivo',
    icon:          iconEntry.icon,
    iconClass:     iconEntry.cls,
    showThumbnail: kind === 'video' || kind === 'audio' || kind === 'image' || kind === 'pdf',
  };
}

function detectKind(item) {
  return resolveKind(item);
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let current = size;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(current >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export class NotesFilePicker {
  constructor({ api, root }) {
    this.api = api;
    this.root = root;
    this.resolve = null;
    this.state = {
      path: "/",
      title: "Selecionar referencia",
      query: "",
      filterKinds: [],
      allowFolders: false,
      viewMode: "grid", // 'grid' ou 'list'
    };
    this.renderBase();
  }

  renderBase() {
    this.root.innerHTML = `
      <div class="modal-backdrop" data-picker-close="1"></div>
      <div class="modal-card modal-card-wide picker-card">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Arquivos TCloud</p>
            <h3 id="picker-title">Selecionar referencia</h3>
          </div>
          <button class="icon-close-button" type="button" data-picker-close="1" aria-label="Fechar">×</button>
        </div>
        <div class="picker-toolbar">
          <div class="picker-toolbar-left">
            <button id="picker-back-button" class="secondary-button" type="button">Voltar</button>
            <div id="picker-breadcrumbs" class="picker-breadcrumbs"></div>
          </div>
          <div class="picker-view-toggles">
            <button id="picker-view-grid" class="view-btn is-active" type="button" title="Grade">
              <i class="ph ph-squares-four"></i>
            </button>
            <button id="picker-view-list" class="view-btn" type="button" title="Lista">
              <i class="ph ph-list"></i>
            </button>
          </div>
        </div>
        <div class="picker-toolbar picker-toolbar-search">
          <input id="picker-search-input" class="tag-input" type="search" placeholder="Buscar no TCloud">
          <div id="picker-filter-pills" class="picker-filter-pills"></div>
        </div>
        <div id="picker-status" class="list-meta">Carregando...</div>
        <div id="picker-results" class="picker-results view-grid"></div>
      </div>
    `;
    this.titleEl = this.root.querySelector("#picker-title");
    this.backButton = this.root.querySelector("#picker-back-button");
    this.breadcrumbs = this.root.querySelector("#picker-breadcrumbs");
    this.searchInput = this.root.querySelector("#picker-search-input");
    this.filterPills = this.root.querySelector("#picker-filter-pills");
    this.statusEl = this.root.querySelector("#picker-status");
    this.resultsEl = this.root.querySelector("#picker-results");
    
    this.btnViewGrid = this.root.querySelector("#picker-view-grid");
    this.btnViewList = this.root.querySelector("#picker-view-list");

    this.root.querySelectorAll("[data-picker-close]").forEach((element) => {
      element.addEventListener("click", () => this.close(null));
    });
    this.backButton.addEventListener("click", () => this.goUp().catch(() => {}));
    this.searchInput.addEventListener("input", () => this.refresh().catch(() => {}));

    this.btnViewGrid.addEventListener("click", () => {
      this.state.viewMode = "grid";
      this.btnViewGrid.classList.add("is-active");
      this.btnViewList.classList.remove("is-active");
      this.resultsEl.className = "picker-results view-grid";
      this.refresh().catch(() => {});
    });

    this.btnViewList.addEventListener("click", () => {
      this.state.viewMode = "list";
      this.btnViewList.classList.add("is-active");
      this.btnViewGrid.classList.remove("is-active");
      this.resultsEl.className = "picker-results view-list";
      this.refresh().catch(() => {});
    });
  }

  async open(options = {}) {
    let allowedKinds = Array.isArray(options.filterKinds) ? [...options.filterKinds] : [];
    let filterKinds = [...allowedKinds];
    if (filterKinds.length > 0 && !filterKinds.includes("folder")) {
      filterKinds.push("folder");
    }
    this.state = {
      path: normalizePath(options.path || "/"),
      title: String(options.title || "Selecionar referencia"),
      query: "",
      filterKinds,
      allowedKinds,
      allowFolders: Boolean(options.allowFolders),
      viewMode: this.state.viewMode || "grid",
    };
    this.searchInput.value = "";
    this.titleEl.textContent = this.state.title;
    this.renderFilters();
    this.root.classList.remove("hidden");
    
    if (this.state.viewMode === "grid") {
      this.btnViewGrid.classList.add("is-active");
      this.btnViewList.classList.remove("is-active");
      this.resultsEl.className = "picker-results view-grid";
    } else {
      this.btnViewList.classList.add("is-active");
      this.btnViewGrid.classList.remove("is-active");
      this.resultsEl.className = "picker-results view-list";
    }

    await this.refresh();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  close(result) {
    this.root.classList.add("hidden");
    const resolver = this.resolve;
    this.resolve = null;
    if (resolver) resolver(result);
  }

  async goUp() {
    if (this.state.path === "/") return;
    const parts = this.state.path.split("/").filter(Boolean);
    parts.pop();
    this.state.path = parts.length ? `/${parts.join("/")}` : "/";
    await this.refresh();
  }

  renderFilters() {
    this.filterPills.innerHTML = "";
    const labels = [
      { kind: "file", label: "Arquivos" },
      { kind: "image", label: "Imagens" },
      { kind: "video", label: "Videos" },
      { kind: "audio", label: "Audios" },
      { kind: "pdf", label: "PDFs" },
      { kind: "folder", label: "Pastas" },
    ];
    const allowed = this.state.allowedKinds && this.state.allowedKinds.length > 0
      ? labels.filter(({ kind }) => kind === "folder" || this.state.allowedKinds.includes(kind))
      : labels;

    allowed.forEach(({ kind, label }) => {
      const enabled = !this.state.filterKinds.length || this.state.filterKinds.includes(kind);
      const pill = document.createElement("span");
      pill.className = `tag-filter-chip${enabled ? " is-active" : ""}`;
      pill.textContent = label;
      
      pill.addEventListener("click", () => {
        if (this.state.filterKinds.includes(kind)) {
          this.state.filterKinds = this.state.filterKinds.filter((k) => k !== kind);
        } else {
          this.state.filterKinds.push(kind);
        }
        this.renderFilters();
        this.refresh().catch(() => {});
      });

      this.filterPills.appendChild(pill);
    });
  }

  renderBreadcrumbs() {
    const segments = this.state.path.split("/").filter(Boolean);
    const crumbs = [{ label: "/", path: "/" }];
    segments.forEach((segment, index) => {
      crumbs.push({
        label: segment,
        path: `/${segments.slice(0, index + 1).join("/")}`,
      });
    });
    this.breadcrumbs.innerHTML = "";
    crumbs.forEach((crumb) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = crumb.label;
      button.addEventListener("click", () => {
        this.state.path = crumb.path;
        this.refresh().catch(() => {});
      });
      this.breadcrumbs.appendChild(button);
    });
  }

  async refresh() {
    const query = this.searchInput.value.trim();
    this.state.query = query;
    this.renderBreadcrumbs();
    this.statusEl.textContent = "Carregando...";
    this.resultsEl.innerHTML = "";
    const response = query
      ? await this.api.searchFiles(query, 60)
      : await this.api.listDirectory(this.state.path);
    const items = Array.isArray(response.items) ? response.items : [];
    const filtered = items.filter((item) => {
      const kind = detectKind(item);
      if (query && !String(item.path || "").startsWith("/")) return false;
      if (!this.state.filterKinds.length) return true;
      return this.state.filterKinds.includes(kind);
    });
    filtered.sort((left, right) => {
      if (Boolean(right.is_directory) !== Boolean(left.is_directory)) {
        return left.is_directory ? -1 : 1;
      }
      return String(left.name || "").localeCompare(String(right.name || ""), "pt-BR", { sensitivity: "base" });
    });
    this.renderResults(filtered, query);
  }

  renderResults(items, query) {
    this.resultsEl.innerHTML = "";
    this.statusEl.textContent = query
      ? `${items.length} resultado(s) para "${query}"`
      : `${items.length} item(ns) em ${this.state.path}`;

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "notes-list-empty";
      empty.textContent = query ? "Nenhum item encontrado." : "Esta pasta esta vazia.";
      this.resultsEl.appendChild(empty);
      return;
    }

    if (this.state.viewMode === "list") {
      const header = document.createElement("div");
      header.className = "picker-list-header";
      header.innerHTML = `
        <div class="picker-list-col-name">Nome</div>
        <div class="picker-list-col-type">Tipo</div>
        <div class="picker-list-col-size">Tamanho</div>
        <div class="picker-list-col-actions">Ações</div>
      `;
      this.resultsEl.appendChild(header);
    }

    items.forEach((item) => {
      const kind = detectKind(item);
      const pres = resolveBrowserItemPresentation(item);
      const isAllowed = !this.state.allowedKinds || !this.state.allowedKinds.length || this.state.allowedKinds.includes(pres.kind);
      const canSelect = item.is_directory ? (this.state.allowFolders || this.state.filterKinds.includes("folder")) : isAllowed;

      if (this.state.viewMode === "grid") {
        const card = document.createElement("div");
        card.className = "picker-grid-item";
        if (!canSelect) card.classList.add("disabled");

        card.innerHTML = `
          <div class="picker-grid-thumb-wrapper">
            <div class="picker-grid-thumb-fallback">
              <i class="${pres.icon} ${pres.iconClass}"></i>
            </div>
            <div class="picker-grid-thumb-img-container hidden">
              <img class="picker-grid-thumb-img" alt="${escapeHtml(item.name)}">
            </div>
          </div>
          <div class="picker-grid-info">
            <span class="picker-grid-name" title="${escapeHtml(item.name || item.path)}">${escapeHtml(item.name || item.path)}</span>
            <span class="picker-grid-meta">${escapeHtml(item.is_directory ? "Pasta" : formatBytes(item.size))}</span>
          </div>
          <div class="picker-grid-hover-actions">
            ${item.is_directory ? `<button type="button" class="view-btn enter-btn" title="Entrar"><i class="ph ph-folder-open"></i></button>` : ''}
            ${canSelect ? `<button type="button" class="view-btn select-btn" title="Selecionar"><i class="ph ph-check"></i></button>` : ''}
          </div>
        `;

        if (pres.showThumbnail && !item.is_directory) {
          const img = card.querySelector(".picker-grid-thumb-img");
          const container = card.querySelector(".picker-grid-thumb-img-container");
          const fallback = card.querySelector(".picker-grid-thumb-fallback");

          const showThumb = () => {
            container.classList.remove("hidden");
            fallback.classList.add("hidden");
          };

          const handleStreamFallback = () => {
            img.onerror = null; // prevent infinite loop
            this.api.getStreamUrl(item.path).then((res) => {
              if (res && res.url) {
                img.onload = showThumb;
                img.src = this.api.authUrl(res.url);
              }
            }).catch(() => {});
          };

          this.api.fetchThumbnail(item.path).then((url) => {
            if (url) {
              img.onload = showThumb;
              img.onerror = handleStreamFallback;
              img.src = url;
            } else {
              handleStreamFallback();
            }
          }).catch((err) => {
            console.warn("Erro ao buscar miniatura para", item.path, err);
            handleStreamFallback();
          });
        }

        card.addEventListener("click", (e) => {
          if (e.target.closest(".picker-grid-hover-actions button")) return;

          if (item.is_directory) {
            this.state.path = normalizePath(item.path);
            this.refresh().catch(() => {});
          } else if (canSelect) {
            this.close({
              path: item.path,
              name: item.name,
              mime: item.mime_type || "",
              size: Number(item.size || 0),
              kind,
              is_directory: false,
            });
          }
        });

        const enterBtn = card.querySelector(".enter-btn");
        if (enterBtn) {
          enterBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.state.path = normalizePath(item.path);
            this.refresh().catch(() => {});
          });
        }

        const selectBtn = card.querySelector(".select-btn");
        if (selectBtn) {
          selectBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.close({
              path: item.path,
              name: item.name,
              mime: item.mime_type || "",
              size: Number(item.size || 0),
              kind,
              is_directory: Boolean(item.is_directory),
            });
          });
        }

        this.resultsEl.appendChild(card);
      } else {
        // List Mode
        const row = document.createElement("div");
        row.className = "picker-list-item";
        if (!canSelect) row.classList.add("disabled");

        row.innerHTML = `
          <div class="picker-list-col-name">
            <div class="picker-list-icon-wrapper">
              <div class="picker-list-fallback-icon">
                <i class="${pres.icon} ${pres.iconClass}"></i>
              </div>
              <div class="picker-list-thumb-container hidden">
                <img class="picker-list-thumb-img" alt="${escapeHtml(item.name)}">
              </div>
            </div>
            <span class="picker-list-name-text" title="${escapeHtml(item.name || item.path)}">${escapeHtml(item.name || item.path)}</span>
          </div>
          <div class="picker-list-col-type">${escapeHtml(pres.labelPt)}</div>
          <div class="picker-list-col-size">${escapeHtml(item.is_directory ? "--" : formatBytes(item.size))}</div>
          <div class="picker-list-col-actions">
            ${item.is_directory ? `<button type="button" class="secondary-button compact-btn enter-btn">Entrar</button>` : ''}
            ${canSelect ? `<button type="button" class="primary-button compact-btn select-btn">Selecionar</button>` : ''}
          </div>
        `;

        if (pres.showThumbnail && !item.is_directory) {
          const img = row.querySelector(".picker-list-thumb-img");
          const container = row.querySelector(".picker-list-thumb-container");
          const fallback = row.querySelector(".picker-list-fallback-icon");

          const showThumb = () => {
            container.classList.remove("hidden");
            fallback.classList.add("hidden");
          };

          const handleStreamFallback = () => {
            img.onerror = null; // prevent infinite loop
            this.api.getStreamUrl(item.path).then((res) => {
              if (res && res.url) {
                img.onload = showThumb;
                img.src = this.api.authUrl(res.url);
              }
            }).catch(() => {});
          };

          this.api.fetchThumbnail(item.path).then((url) => {
            if (url) {
              img.onload = showThumb;
              img.onerror = handleStreamFallback;
              img.src = url;
            } else {
              handleStreamFallback();
            }
          }).catch(() => {
            handleStreamFallback();
          });
        }

        row.addEventListener("click", (e) => {
          if (e.target.closest(".picker-list-col-actions button")) return;

          if (item.is_directory) {
            this.state.path = normalizePath(item.path);
            this.refresh().catch(() => {});
          } else if (canSelect) {
            this.close({
              path: item.path,
              name: item.name,
              mime: item.mime_type || "",
              size: Number(item.size || 0),
              kind,
              is_directory: false,
            });
          }
        });

        const listEnterBtn = row.querySelector(".enter-btn");
        if (listEnterBtn) {
          listEnterBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.state.path = normalizePath(item.path);
            this.refresh().catch(() => {});
          });
        }

        const listSelectBtn = row.querySelector(".select-btn");
        if (listSelectBtn) {
          listSelectBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.close({
              path: item.path,
              name: item.name,
              mime: item.mime_type || "",
              size: Number(item.size || 0),
              kind,
              is_directory: Boolean(item.is_directory),
            });
          });
        }

        this.resultsEl.appendChild(row);
      }
    });
  }
}
