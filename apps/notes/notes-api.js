const RUNTIME_READY_TIMEOUT_MS = 2500;

let parentToken = "";
let authBridgeReady = false;
let runtimeMode = null;

function attachAuthBridge() {
  if (authBridgeReady) return;
  authBridgeReady = true;

  try {
    parentToken = window.localStorage.getItem("tcloud_token") || 
                  window.parent?.localStorage?.getItem("tcloud_token") || "";
  } catch (e) {
    // Ignorar se houver restrições de segurança ou cross-origin
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === "tcloud-auth") {
      parentToken = String(event.data.token || "");
    }
  });
}

async function detectRuntimeMode() {
  if (runtimeMode === true) return true;
  attachAuthBridge();

  if (!window.TCloudApp || typeof window.TCloudApp.call !== "function" || typeof window.TCloudApp.ready !== "function") {
    return false;
  }

  try {
    await Promise.race([
      window.TCloudApp.ready(),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("runtime-timeout")), RUNTIME_READY_TIMEOUT_MS)),
    ]);
    runtimeMode = true;
    return true;
  } catch (error) {
    return false;
  }
}

async function apiFetch(url, options = {}) {
  attachAuthBridge();
  const headers = new Headers(options.headers || {});
  if (parentToken) headers.set("Authorization", `Bearer ${parentToken}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers });
  return response;
}

async function apiJson(url, options = {}) {
  const response = await apiFetch(url, options);
  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Falha ao comunicar com a API de notas.");
  }
  return data;
}

function buildListParams({ query = "", limit = 100, favorite = false, tag = "", deleted = "active", includeDeleted = false, archived = "all" } = {}) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (limit) params.set("limit", String(limit));
  if (favorite) params.set("favorite", "true");
  if (tag) params.set("tag", tag);
  if (deleted && deleted !== "active") params.set("deleted", deleted);
  if (archived && archived !== "all") params.set("archived", archived);
  if (includeDeleted) params.set("include_deleted", "true");
  return params;
}

function buildTreeParams({ query = "", limit = 300 } = {}) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (limit) params.set("limit", String(limit));
  return params;
}

function quotePath(path) {
  return String(path || "").split("/").map((part) => encodeURIComponent(part)).join("/");
}

function makeDownload({ filename, content, contentType }) {
  const blob = new Blob([content], { type: contentType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class NotesApi {
  authUrl(url = "") {
    attachAuthBridge();
    const value = String(url || "").trim();
    if (!value || !parentToken || value.startsWith("data:") || value.includes("token=")) return value;
    const separator = value.includes("?") ? "&" : "?";
    return `${value}${separator}token=${encodeURIComponent(parentToken)}`;
  }

  async list({ query = "", limit = 100, favorite = false, tag = "", deleted = "active", includeDeleted = false, archived = "all" } = {}) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.list", {
        query,
        limit,
        favorite,
        tag,
        deleted,
        archived,
        include_deleted: includeDeleted,
      });
    }
    const params = buildListParams({ query, limit, favorite, tag, deleted, includeDeleted, archived });
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return apiJson(`/api/notes${suffix}`);
  }

  async create(payload = {}) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.create", payload);
    }
    return apiJson("/api/notes", { method: "POST", body: JSON.stringify(payload) });
  }

  async getTree({ query = "", limit = 300 } = {}) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.tree", { query, limit });
    }
    const params = buildTreeParams({ query, limit });
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return apiJson(`/api/notes/tree${suffix}`);
  }

  async createFolder(payload = {}) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.folders.create", payload);
    }
    return apiJson("/api/notes/folders", { method: "POST", body: JSON.stringify(payload) });
  }

  async updateFolder(folderId, payload = {}) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.folders.update", { folder_id: folderId, ...payload });
    }
    return apiJson(`/api/notes/folders/${encodeURIComponent(folderId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  async deleteFolder(folderId, { mode = "move_to_root" } = {}) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.folders.delete", { folder_id: folderId, mode });
    }
    return apiJson(`/api/notes/folders/${encodeURIComponent(folderId)}`, {
      method: "DELETE",
      body: JSON.stringify({ mode }),
    });
  }

  async moveItems(payload = {}) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.move", payload);
    }
    return apiJson("/api/notes/move", { method: "POST", body: JSON.stringify(payload) });
  }

  async moveItem(item = {}, targetFolderId = null, extra = {}) {
    return this.moveItems({
      ...extra,
      items: [item],
      target_folder_id: targetFolderId || null,
    });
  }

  async get(noteId, { includeDeleted = false } = {}) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.get", { note_id: noteId, include_deleted: includeDeleted });
    }
    const suffix = includeDeleted ? "?include_deleted=true" : "";
    return apiJson(`/api/notes/${encodeURIComponent(noteId)}${suffix}`);
  }

  async update(noteId, payload = {}) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.update", { note_id: noteId, ...payload });
    }
    return apiJson(`/api/notes/${encodeURIComponent(noteId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  async updateContent(noteId, content) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.update", { note_id: noteId, content });
    }
    return apiJson(`/api/notes/${encodeURIComponent(noteId)}/content`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
  }

  async remove(noteId) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.delete", { note_id: noteId });
    }
    return apiJson(`/api/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" });
  }

  async restore(noteId) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.restore", { note_id: noteId });
    }
    return apiJson(`/api/notes/${encodeURIComponent(noteId)}/restore`, { method: "POST" });
  }

  async purge(noteId) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.purge", { note_id: noteId });
    }
    return apiJson(`/api/notes/${encodeURIComponent(noteId)}/permanent`, { method: "DELETE" });
  }

  async bulkPurge(noteIds = []) {
    const uniqueIds = Array.from(new Set((Array.isArray(noteIds) ? noteIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)));
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.bulkPurge", { note_ids: uniqueIds });
    }
    return apiJson("/api/notes/bulk-permanent-delete", {
      method: "POST",
      body: JSON.stringify({ note_ids: uniqueIds }),
    });
  }

  async listRevisions(noteId, { limit = 50 } = {}) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.revisions", { note_id: noteId, limit });
    }
    return apiJson(`/api/notes/${encodeURIComponent(noteId)}/revisions?limit=${encodeURIComponent(limit)}`);
  }

  async restoreRevision(noteId, version) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.restoreRevision", { note_id: noteId, version });
    }
    return apiJson(`/api/notes/${encodeURIComponent(noteId)}/revisions/${encodeURIComponent(version)}/restore`, {
      method: "POST",
    });
  }

  async importNote({ fileName, textContent, folderId = "" }) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.import", { file_name: fileName, text_content: textContent, folder_id: folderId || null });
    }
    return apiJson("/api/notes/import", {
      method: "POST",
      body: JSON.stringify({ file_name: fileName, text_content: textContent, folder_id: folderId || null }),
    });
  }

  async exportNote(noteId, format = "json") {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.export", { note_id: noteId, format });
    }
    const response = await apiFetch(`/api/notes/${encodeURIComponent(noteId)}/export?format=${encodeURIComponent(format)}`);
    if (!response.ok) {
      let error = "Falha ao exportar nota.";
      try {
        const data = await response.json();
        error = data.error || error;
      } catch (jsonError) {
        error = await response.text();
      }
      throw new Error(error);
    }
    const content = await response.text();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    return {
      content,
      filename: match ? match[1] : `nota.${format}`,
      content_type: response.headers.get("Content-Type") || "application/octet-stream",
      format,
    };
  }

  async downloadExport(noteId, format = "json") {
    const result = await this.exportNote(noteId, format);
    makeDownload({
      filename: result.filename,
      content: result.content,
      contentType: result.content_type,
    });
    return result;
  }

  async backupNote(noteId) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.backup", { note_id: noteId });
    }
    return apiJson(`/api/notes/${encodeURIComponent(noteId)}/backup`, { method: "POST" });
  }

  async searchRelations(query = "", limit = 20) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("notes.relations.search", { query, limit });
    }
    return apiJson(`/api/notes/relations/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`);
  }

  async listDirectory(path = "/") {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("files.listDirectory", { path });
    }
    return apiJson(`/api/files?path=${encodeURIComponent(path)}`);
  }

  async getStreamUrl(path) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("files.getStreamUrl", { path });
    }
    return {
      url: `/stream/${quotePath(path).replaceAll("%2F", "/")}`,
      headers: {},
      contentType: "",
      supportsRange: true,
    };
  }

  async fetchThumbnail(path) {
    if (await detectRuntimeMode()) {
      const result = await window.TCloudApp.call("thumbnail.fetch", { path });
      return this.authUrl(result?.url || "");
    }
    return this.authUrl(`/api/thumbnail?path=${encodeURIComponent(path)}`);
  }

  async deleteFile(path) {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return null;
    const deleteResponse = await apiFetch(`/api/files/${encodeURIComponent(normalizedPath)}`, { method: "DELETE" });
    if (deleteResponse.ok) {
      try {
        return await deleteResponse.json();
      } catch (error) {
        return { ok: true };
      }
    }
    if (deleteResponse.status !== 404 && deleteResponse.status !== 405) {
      let message = "Falha ao excluir arquivo.";
      try {
        const data = await deleteResponse.json();
        message = data.error || message;
      } catch (error) {
        message = await deleteResponse.text() || message;
      }
      throw new Error(message);
    }
    return apiJson("/api/delete", {
      method: "POST",
      body: JSON.stringify({ path: normalizedPath }),
    });
  }

  async searchFiles(query, limit = 25) {
    if (await detectRuntimeMode()) {
      return window.TCloudApp.call("search.query", { query, limit });
    }
    return apiJson(`/api/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`);
  }

  openPath(path) {
    if (window.TCloudApp && typeof window.TCloudApp.openPath === "function") {
      window.TCloudApp.openPath(path);
    }
  }

  showToast(message, kind = "info", duration = 2400) {
    if (window.TCloudApp && typeof window.TCloudApp.showToast === "function") {
      window.TCloudApp.showToast(message, kind, duration);
    }
  }
}
