const BLOCK_META = {
  tcloudFile: { kind: "file", label: "Arquivo", badge: "FILE" },
  tcloudImage: { kind: "image", label: "Imagem", badge: "IMG" },
  tcloudVideo: { kind: "video", label: "Video", badge: "VID" },
  tcloudAudio: { kind: "audio", label: "Audio", badge: "AUD" },
  tcloudPdf: { kind: "pdf", label: "PDF", badge: "PDF" },
  tcloudFolder: { kind: "folder", label: "Pasta", badge: "DIR" },
};

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function isTCloudBlockType(type) {
  return Object.prototype.hasOwnProperty.call(BLOCK_META, String(type || ""));
}

export function normalizeTCloudBlockData(type, data = {}) {
  const meta = BLOCK_META[type] || BLOCK_META.tcloudFile;
  const size = Number(data.size || 0);
  const result = {
    path: String(data.path || "").trim(),
    name: String(data.name || "").trim(),
    mime: String(data.mime || "").trim(),
    size: Number.isFinite(size) && size > 0 ? size : 0,
    kind: String(data.kind || meta.kind).trim().toLowerCase(),
    thumbnail_url: String(data.thumbnail_url || "").trim(),
  };
  if (type === "tcloudImage") {
    result.width = data.width ? String(data.width) : "";
  }
  return result;
}

export function buildTCloudBlock(type, item = {}) {
  return normalizeTCloudBlockData(type, item);
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
  const digits = current >= 10 || index === 0 ? 0 : 1;
  return `${current.toFixed(digits)} ${units[index]}`;
}

function extensionLabel(name = "", path = "") {
  const source = String(name || path || "").trim();
  const token = source.split("/").pop() || "";
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return "Arquivo";
  return token.slice(dot + 1, dot + 7).toUpperCase();
}

function pickerConfigForType(type) {
  if (type === "tcloudImage") return { kinds: ["image"], allowFolders: false };
  if (type === "tcloudVideo") return { kinds: ["video"], allowFolders: false };
  if (type === "tcloudAudio") return { kinds: ["audio"], allowFolders: false };
  if (type === "tcloudPdf") return { kinds: ["pdf"], allowFolders: false };
  if (type === "tcloudFolder") return { kinds: ["folder"], allowFolders: true };
  return { kinds: ["file", "image", "video", "audio", "pdf"], allowFolders: false };
}

class TCloudReferenceTool {
  static get isReadOnlySupported() {
    return true;
  }

  constructor({ data = {}, config = {}, api, readOnly, type = "tcloudFile" } = {}) {
    this.type = type;
    this.meta = BLOCK_META[type] || BLOCK_META.tcloudFile;
    this.config = config || {};
    this.api = api;
    this.readOnly = readOnly;
    this.data = normalizeTCloudBlockData(type, data);
    this.wrapper = null;
    this.preview = null;
  }

  renderPreviewImage(url) {
    if (!this.preview || !url) return;
    const image = document.createElement("img");
    image.className = "tcloud-block-image";
    image.alt = "";
    image.loading = "lazy";
    image.src = url;
    image.addEventListener("load", () => {
      if (!this.preview) return;
      this.preview.classList.add("has-preview");
      this.preview.innerHTML = "";
      this.preview.appendChild(image);
    });
    image.addEventListener("error", () => this.renderFallbackPreview());
  }

  renderFallbackPreview() {
    if (!this.preview) return;
    this.preview.classList.remove("has-preview");
    this.preview.innerHTML = `
      <div class="tcloud-block-cover-copy">
        <div class="tcloud-block-icon">${escapeHtml(this.meta.badge)}</div>
        <div class="tcloud-block-cover-meta">
          <span class="tcloud-block-cover-badge">${escapeHtml(this.meta.label)}</span>
          <strong class="tcloud-block-cover-title">${escapeHtml(extensionLabel(this.data.name, this.data.path))}</strong>
          <span class="tcloud-block-cover-subtitle">${escapeHtml(this.data.mime || this.data.name || "Preview indisponível")}</span>
        </div>
      </div>
    `;
  }

  render() {
    const wrapper = document.createElement("div");
    wrapper.className = `tcloud-block-card is-${this.meta.kind}`;
    wrapper.dataset.tcloudBlockType = this.type;
    this.wrapper = wrapper;
    this.refreshView();
    return wrapper;
  }

  refreshView() {
    if (!this.wrapper) return;
    const hasPath = Boolean(this.data.path);

    if (this.type === "tcloudImage" && hasPath) {
      const savedWidth = this.data.width || "";
      this.wrapper.innerHTML = `
        <div class="tcloud-image-container">
          <div class="tcloud-image-wrapper" tabindex="0" role="button" aria-label="Imagem ${escapeHtml(this.data.name || this.data.path || "")}" style="${savedWidth ? `width: ${savedWidth};` : ''}">
            <img class="tcloud-image-content" src="" alt="" loading="lazy" />
            <div class="tcloud-image-loading">
              Carregando imagem...
            </div>
            <div class="tcloud-image-resize-handle handle-tl" data-handle="tl"></div>
            <div class="tcloud-image-resize-handle handle-tr" data-handle="tr"></div>
            <div class="tcloud-image-resize-handle handle-bl" data-handle="bl"></div>
            <div class="tcloud-image-resize-handle handle-br" data-handle="br"></div>
            <div class="tcloud-image-resize-tooltip"></div>
            <div class="tcloud-image-overlay">
              <div class="tcloud-image-overlay-actions">
                <button type="button" class="overlay-action-btn tcloud-details-button" title="Detalhes da Imagem">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                </button>
                <button type="button" class="overlay-action-btn tcloud-change-button" title="Substituir Imagem">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.82 2.82 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      `;

      const img = this.wrapper.querySelector(".tcloud-image-content");
      const loading = this.wrapper.querySelector(".tcloud-image-loading");
      const detailsBtn = this.wrapper.querySelector(".tcloud-details-button");
      const changeBtn = this.wrapper.querySelector(".tcloud-change-button");
      const wrapperEl = this.wrapper.querySelector(".tcloud-image-wrapper");
      const tooltip = this.wrapper.querySelector(".tcloud-image-resize-tooltip");
      const handles = this.wrapper.querySelectorAll(".tcloud-image-resize-handle");

      detailsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showDetailsModal();
      });

      changeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pickReference().catch(() => {});
      });

      // Setup click focus for resizing
      wrapperEl.addEventListener("click", (e) => {
        e.stopPropagation();
        document.querySelectorAll(".tcloud-image-wrapper").forEach(w => {
          if (w !== wrapperEl) w.classList.remove("is-focused");
        });
        wrapperEl.classList.add("is-focused");
        wrapperEl.focus({ preventScroll: true });
      });
      wrapperEl.addEventListener("keydown", (e) => {
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof this.config.onDelete === "function") {
          this.config.onDelete(this.wrapper);
        }
      });

      const onDocumentClick = (e) => {
        if (!wrapperEl || !document.body.contains(wrapperEl)) {
          document.removeEventListener("click", onDocumentClick);
          return;
        }
        if (!wrapperEl.contains(e.target)) {
          wrapperEl.classList.remove("is-focused");
        }
      };
      document.addEventListener("click", onDocumentClick);

      // Setup drag resize logic
      handles.forEach(handle => {
        handle.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();

          const handleType = handle.getAttribute("data-handle");
          const initialWidth = wrapperEl.offsetWidth;
          const initialX = e.clientX;

          if (tooltip) {
            tooltip.textContent = `${initialWidth}px`;
            tooltip.classList.add("is-visible");
          }
          wrapperEl.classList.add("is-resizing");

          const onPointerMove = (moveEvent) => {
            const deltaX = moveEvent.clientX - initialX;
            let newWidth = initialWidth;

            if (handleType === "br" || handleType === "tr") {
              newWidth = initialWidth + deltaX;
            } else {
              newWidth = initialWidth - deltaX;
            }

            const containerWidth = wrapperEl.parentElement.offsetWidth || 800;
            const minWidth = 150;
            const maxWidth = containerWidth;

            if (newWidth < minWidth) newWidth = minWidth;
            if (newWidth > maxWidth) newWidth = maxWidth;

            wrapperEl.style.width = `${newWidth}px`;
            if (tooltip) {
              tooltip.textContent = `${newWidth}px`;
            }
          };

          const onPointerUp = () => {
            document.removeEventListener("pointermove", onPointerMove);
            document.removeEventListener("pointerup", onPointerUp);

            if (tooltip) {
              tooltip.classList.remove("is-visible");
            }
            wrapperEl.classList.remove("is-resizing");

            const finalWidth = wrapperEl.style.width;
            this.data.width = finalWidth;

            if (typeof this.config.onChange === "function") {
              this.config.onChange();
            }
          };

          document.addEventListener("pointermove", onPointerMove);
          document.addEventListener("pointerup", onPointerUp);
        });
      });

      if (typeof this.config.resolvePreview === "function") {
        this.config.resolvePreview(this.data, this.type).then((preview) => {
          if (preview?.url) {
            img.src = preview.url;
            img.addEventListener("load", () => {
              loading.style.display = "none";
              img.classList.add("loaded");
            });
            img.addEventListener("error", () => {
              loading.innerHTML = "Falha ao carregar a imagem";
            });
          } else {
            loading.innerHTML = "Visualização não disponível";
          }
        }).catch(() => {
          loading.innerHTML = "Erro ao carregar visualização";
        });
      }
      return;
    }

    this.wrapper.innerHTML = hasPath
      ? `
        <div class="tcloud-block-cover">
          <div class="tcloud-block-icon">${escapeHtml(this.meta.badge)}</div>
        </div>
        <div class="tcloud-block-body">
          <div class="tcloud-block-top">
            <span class="tcloud-block-kind">${escapeHtml(this.meta.label)}</span>
            <span class="tcloud-block-size">${escapeHtml(formatBytes(this.data.size))}</span>
          </div>
          <strong class="tcloud-block-title">${escapeHtml(this.data.name || this.data.path || "Referencia")}</strong>
          <div class="tcloud-block-path">${escapeHtml(this.data.path || "Caminho indisponivel")}</div>
          <div class="tcloud-block-actions">
            <button type="button" class="secondary-button tcloud-open-button">Abrir</button>
            <button type="button" class="secondary-button tcloud-reveal-button">Mostrar no TCloud</button>
            <button type="button" class="secondary-button tcloud-change-button">Trocar</button>
          </div>
        </div>
      `
      : `
        <div class="tcloud-block-cover">
          <div class="tcloud-block-icon">${escapeHtml(this.meta.badge)}</div>
        </div>
        <div class="tcloud-block-body">
          <div class="tcloud-block-top">
            <span class="tcloud-block-kind">${escapeHtml(this.meta.label)}</span>
            <span class="tcloud-block-size">Sem referencia</span>
          </div>
          <strong class="tcloud-block-title">Selecione um item do TCloud</strong>
          <div class="tcloud-block-path">Este bloco ainda nao aponta para nenhum arquivo ou pasta.</div>
          <div class="tcloud-block-actions">
            <button type="button" class="primary-button tcloud-pick-button">Escolher agora</button>
          </div>
        </div>
      `;
    this.preview = this.wrapper.querySelector(".tcloud-block-cover");
    this.renderFallbackPreview();
    this.wrapper.querySelector(".tcloud-open-button")?.addEventListener("click", () => {
      if (typeof this.config.onOpen === "function") this.config.onOpen(this.data);
    });
    this.wrapper.querySelector(".tcloud-reveal-button")?.addEventListener("click", () => {
      if (typeof this.config.onReveal === "function") this.config.onReveal(this.data);
    });
    this.wrapper.querySelector(".tcloud-change-button")?.addEventListener("click", () => {
      this.pickReference().catch(() => {});
    });
    this.wrapper.querySelector(".tcloud-pick-button")?.addEventListener("click", () => {
      this.pickReference().catch(() => {});
    });
    this.loadPreview().catch(() => {});
  }

  showDetailsModal() {
    const existing = document.getElementById("tcloud-details-modal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "tcloud-details-modal";
    modal.className = "modal";
    modal.setAttribute("aria-hidden", "false");

    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-card modal-card-compact">
        <div class="modal-header">
          <h3>Detalhes da Imagem</h3>
          <button class="icon-close-button" type="button" aria-label="Fechar">×</button>
        </div>
        <div class="modal-body tcloud-details-modal-body">
          <div class="details-field">
            <span class="details-label">Nome do Arquivo</span>
            <strong class="details-value">${escapeHtml(this.data.name || "Sem nome")}</strong>
          </div>
          <div class="details-field">
            <span class="details-label">Caminho no TCloud</span>
            <code class="details-value details-code">${escapeHtml(this.data.path || "/")}</code>
          </div>
          <div class="details-grid-half">
            <div class="details-field">
              <span class="details-label">Tamanho</span>
              <span class="details-value">${escapeHtml(formatBytes(this.data.size))}</span>
            </div>
            <div class="details-field">
              <span class="details-label">Tipo</span>
              <span class="details-value">${escapeHtml(this.data.mime || "Imagem")}</span>
            </div>
          </div>
        </div>
        <div class="modal-footer tcloud-details-modal-footer">
          <button type="button" class="secondary-button tcloud-modal-open-btn">Abrir</button>
          <button type="button" class="secondary-button tcloud-modal-reveal-btn">Mostrar no TCloud</button>
          <button type="button" class="primary-button tcloud-modal-change-btn">Trocar Imagem</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector(".icon-close-button");
    const backdrop = modal.querySelector(".modal-backdrop");
    const openBtn = modal.querySelector(".tcloud-modal-open-btn");
    const revealBtn = modal.querySelector(".tcloud-modal-reveal-btn");
    const changeBtn = modal.querySelector(".tcloud-modal-change-btn");

    const closeModal = () => {
      modal.remove();
    };

    closeBtn.addEventListener("click", closeModal);
    backdrop.addEventListener("click", closeModal);

    openBtn.addEventListener("click", () => {
      if (typeof this.config.onOpen === "function") this.config.onOpen(this.data);
      closeModal();
    });

    revealBtn.addEventListener("click", () => {
      if (typeof this.config.onReveal === "function") this.config.onReveal(this.data);
      closeModal();
    });

    changeBtn.addEventListener("click", () => {
      this.pickReference().catch(() => {});
      closeModal();
    });
  }

  async pickReference() {
    if (typeof this.config.onPick !== "function") return;
    const result = await this.config.onPick(this.type, pickerConfigForType(this.type));
    if (!result) return;
    this.data = normalizeTCloudBlockData(this.type, result);
    this.refreshView();
  }

  async loadPreview() {
    if (!this.preview || !this.data.path || typeof this.config.resolvePreview !== "function") return;
    const preview = await this.config.resolvePreview(this.data, this.type);
    if (!preview?.url) {
      this.renderFallbackPreview();
      return;
    }
    if (preview.kind === "image" || preview.kind === "thumbnail") {
      this.renderPreviewImage(preview.url);
      return;
    }
    this.renderFallbackPreview();
  }

  save() {
    return normalizeTCloudBlockData(this.type, this.data);
  }
}

function createToolClass(type) {
  return class extends TCloudReferenceTool {
    static get toolbox() {
      const meta = BLOCK_META[type];
      return { title: meta.label };
    }

    constructor(args) {
      super({ ...args, type });
    }
  };
}

export const TCloudFileTool = createToolClass("tcloudFile");
export const TCloudImageTool = createToolClass("tcloudImage");
export const TCloudVideoTool = createToolClass("tcloudVideo");
export const TCloudAudioTool = createToolClass("tcloudAudio");
export const TCloudPdfTool = createToolClass("tcloudPdf");
export const TCloudFolderTool = createToolClass("tcloudFolder");
