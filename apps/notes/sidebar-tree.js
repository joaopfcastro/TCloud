export const SIDEBAR_STATE_KEY = "tcloud.notes.sidebar.state";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function folderIcon(folder) {
  const value = String(folder?.icon || "").trim();
  if (!value || value === "folder") return '<i class="ph ph-folder-simple" aria-hidden="true"></i>';
  return escapeHtml(value);
}

function byPositionThenName(left, right) {
  const leftPos = Number(left?.position || 0);
  const rightPos = Number(right?.position || 0);
  if (leftPos !== rightPos) return leftPos - rightPos;
  return String(left?.name || left?.title || "").localeCompare(String(right?.name || right?.title || ""), "pt-BR");
}

function byRecent(left, right) {
  return String(right?.updated_at || "").localeCompare(String(left?.updated_at || ""));
}

function normalizeFolderId(value) {
  const text = String(value || "").trim();
  return text || "";
}

function createSection(title, { muted = "", view = "", active = false } = {}) {
  const section = document.createElement("section");
  section.className = "sidebar-section";
  if (view) section.dataset.view = view;
  section.innerHTML = `
    <button class="sidebar-section-title${active ? " is-active" : ""}" type="button" ${view ? `data-smart-view="${escapeHtml(view)}"` : ""}>
      <span>${escapeHtml(title)}</span>
      ${muted ? `<small>${escapeHtml(muted)}</small>` : ""}
    </button>
  `;
  return section;
}

function createEmpty(label, description = "") {
  const node = document.createElement("div");
  node.className = "notes-list-empty";
  node.innerHTML = `<strong>${escapeHtml(label)}</strong>${description ? `<span>${escapeHtml(description)}</span>` : ""}`;
  return node;
}

export function loadSidebarUiState() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SIDEBAR_STATE_KEY) || "{}");
    return {
      expandedFolderIds: new Set(Array.isArray(parsed.expandedFolderIds) ? parsed.expandedFolderIds : []),
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      selectedFolderId: normalizeFolderId(parsed.selectedFolderId),
    };
  } catch (error) {
    return { expandedFolderIds: new Set(), sidebarCollapsed: false, selectedFolderId: "" };
  }
}

export function saveSidebarUiState({ expandedFolderIds, sidebarCollapsed = false, selectedFolderId = "" } = {}) {
  const payload = {
    expandedFolderIds: Array.from(expandedFolderIds || []),
    sidebarCollapsed: Boolean(sidebarCollapsed),
    selectedFolderId: normalizeFolderId(selectedFolderId),
  };
  window.localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(payload));
}

export function buildFolderOptions(folders = []) {
  const sorted = [...folders].sort(byPositionThenName);
  return [
    { id: "", label: "Raiz" },
    ...sorted.map((folder) => ({ id: folder.id, label: folder.name || "Nova pasta" })),
  ];
}

export function isFolderDescendant(folderId, targetParentId, folders = []) {
  const safeFolderId = normalizeFolderId(folderId);
  let current = normalizeFolderId(targetParentId);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  while (current) {
    if (current === safeFolderId) return true;
    current = normalizeFolderId(byId.get(current)?.parent_id);
  }
  return false;
}

function renderNoteRow(note, options = {}, depth = 0) {
  const selected = options.selectedNoteIds?.has(note.id);
  const active = options.currentNoteId === note.id;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `note-card note-tree-item tree-note${active ? " is-active" : ""}${selected ? " is-selected" : ""}`;
  button.dataset.id = note.id;
  button.dataset.folderId = normalizeFolderId(note.folder_id);
  button.draggable = !note.deleted_at;
  button.setAttribute("role", "treeitem");
  if (active) button.setAttribute("aria-current", "page");
  button.style.setProperty("--tree-depth", String(depth));
  button.innerHTML = `
    <span class="tree-row-main">
      <input type="checkbox" class="note-card-checkbox" aria-label="Selecionar nota" ${selected ? "checked" : ""}>
      <i class="ph ph-note" aria-hidden="true"></i>
      <span class="note-card-title">${escapeHtml(note.title || "Sem título")}</span>
      ${note.favorite ? '<i class="ph-fill ph-star note-card-favorite" aria-hidden="true"></i>' : ""}
    </span>
    <span class="tree-row-actions">
      <span class="tree-row-muted">${escapeHtml(note.archived ? "Arquivo" : note.deleted_at ? "Lixeira" : "")}</span>
      <span class="tree-menu-dot" aria-hidden="true">...</span>
    </span>
  `;
  button.querySelector(".note-card-checkbox")?.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onToggleSelection?.(note.id);
  });
  button.addEventListener("click", (event) => options.onNoteClick?.(event, note));
  button.addEventListener("contextmenu", (event) => options.onNoteContextMenu?.(event, note));
  button.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("application/x-tcloud-note", note.id);
    event.dataTransfer?.setData("text/plain", note.id);
    event.dataTransfer?.setDragImage?.(button, 12, 12);
  });
  return button;
}

function renderFolderNode(folder, tree, options = {}, depth = 0) {
  const expanded = options.expandedFolderIds?.has(folder.id);
  const selected = normalizeFolderId(options.selectedFolderId) === folder.id;
  const wrapper = document.createElement("div");
  wrapper.className = "tree-folder-node";
  wrapper.dataset.folderId = folder.id;

  const row = document.createElement("div");
  row.className = `tree-row tree-folder${selected ? " is-active" : ""}`;
  row.dataset.folderId = folder.id;
  row.draggable = true;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-expanded", expanded ? "true" : "false");
  row.style.setProperty("--tree-depth", String(depth));
  row.innerHTML = `
    <button class="tree-disclosure" type="button" aria-label="${expanded ? "Recolher pasta" : "Expandir pasta"}">
      <i class="ph ph-caret-right" aria-hidden="true"></i>
    </button>
    <button class="tree-folder-label" type="button">
      <span class="tree-folder-icon">${folderIcon(folder)}</span>
      <span>${escapeHtml(folder.name || "Nova pasta")}</span>
    </button>
    <span class="tree-row-actions">
      <button class="tree-inline-action" type="button" data-folder-action="note" aria-label="Criar nota em ${escapeHtml(folder.name || "pasta")}"><i class="ph ph-plus"></i></button>
      <button class="tree-inline-action" type="button" data-folder-action="menu" aria-label="Mais ações"><i class="ph ph-dots-three"></i></button>
    </span>
  `;
  row.querySelector(".tree-disclosure")?.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onFolderToggle?.(folder.id);
  });
  row.querySelector(".tree-folder-label")?.addEventListener("click", () => options.onFolderSelect?.(folder.id));
  row.querySelector('[data-folder-action="note"]')?.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onCreateNoteInFolder?.(folder.id);
  });
  row.querySelector('[data-folder-action="menu"]')?.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onFolderContextMenu?.(event, folder);
  });
  row.addEventListener("contextmenu", (event) => options.onFolderContextMenu?.(event, folder));
  row.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("application/x-tcloud-folder", folder.id);
    event.dataTransfer?.setData("text/plain", folder.id);
  });
  row.addEventListener("dragover", (event) => {
    event.preventDefault();
    row.classList.add("is-drag-over");
  });
  row.addEventListener("dragleave", () => row.classList.remove("is-drag-over"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("is-drag-over");
    options.onDropItem?.(event, folder.id);
  });
  wrapper.appendChild(row);

  const children = document.createElement("div");
  children.className = `tree-children${expanded ? "" : " hidden"}`;
  children.setAttribute("role", "group");
  const childFolders = (tree.foldersByParent.get(folder.id) || []).sort(byPositionThenName);
  const childNotes = (tree.notesByFolder.get(folder.id) || []).sort(byPositionThenName);
  childFolders.forEach((child) => children.appendChild(renderFolderNode(child, tree, options, depth + 1)));
  childNotes.forEach((note) => children.appendChild(renderNoteRow(note, options, depth + 1)));
  if (!childFolders.length && !childNotes.length) {
    children.appendChild(createEmpty("Nenhuma nota nesta pasta", "Crie uma nota aqui ou arraste uma nota para cá."));
  }
  wrapper.appendChild(children);
  return wrapper;
}

function buildTree(folders = [], notes = []) {
  const foldersByParent = new Map();
  const notesByFolder = new Map();
  folders.forEach((folder) => {
    const parentId = normalizeFolderId(folder.parent_id);
    if (!foldersByParent.has(parentId)) foldersByParent.set(parentId, []);
    foldersByParent.get(parentId).push(folder);
  });
  notes.forEach((note) => {
    const folderId = normalizeFolderId(note.folder_id);
    if (!notesByFolder.has(folderId)) notesByFolder.set(folderId, []);
    notesByFolder.get(folderId).push(note);
  });
  return { foldersByParent, notesByFolder };
}

function renderFlatNotes(notes, root, options, emptyLabel, emptyDescription) {
  const list = [...notes].sort(byRecent);
  if (!list.length) {
    root.appendChild(createEmpty(emptyLabel, emptyDescription));
    return;
  }
  list.forEach((note) => root.appendChild(renderNoteRow(note, options, 0)));
}

export function renderSidebarTree(root, data = {}, options = {}) {
  if (!root) return;
  root.innerHTML = "";
  root.setAttribute("role", "tree");

  const view = options.view || "active";
  const query = String(options.query || "").trim();
  const folders = Array.isArray(data.folders) ? data.folders : [];
  const notes = Array.isArray(data.notes) ? data.notes : [];
  const favorites = Array.isArray(data.favorites) ? data.favorites : [];
  const recent = Array.isArray(data.recent) ? data.recent : [];
  const archived = Array.isArray(data.archived) ? data.archived : [];
  const trash = Array.isArray(data.trash) ? data.trash : [];

  if (view === "favorites") {
    const section = createSection("Favoritas", { active: true });
    root.appendChild(section);
    renderFlatNotes(favorites, root, options, "Nenhuma nota favorita", "Marque uma nota com estrela para ela aparecer aqui.");
    return;
  }
  if (view === "archived") {
    const section = createSection("Arquivadas", { active: true });
    root.appendChild(section);
    renderFlatNotes(archived, root, options, "Nenhuma nota arquivada", "Notas arquivadas saem da lista principal, mas continuam acessíveis aqui.");
    return;
  }
  if (view === "trash") {
    const section = createSection("Lixeira", { active: true });
    root.appendChild(section);
    renderFlatNotes(trash, root, options, "Nada na lixeira", "Notas excluídas aparecerão aqui antes da exclusão definitiva.");
    return;
  }

  if (!query && favorites.length) {
    const section = createSection("Favoritas", { muted: `${favorites.length}`, view: "favorites" });
    root.appendChild(section);
    favorites.slice(0, 5).forEach((note) => root.appendChild(renderNoteRow(note, options, 0)));
  }

  const workspace = createSection("Minhas notas", { muted: `${notes.length}`, active: view === "active" });
  workspace.classList.add("tree-root-drop");
  workspace.addEventListener("dragover", (event) => event.preventDefault());
  workspace.addEventListener("drop", (event) => options.onDropItem?.(event, ""));
  workspace.addEventListener("contextmenu", (event) => options.onEmptyContextMenu?.(event));
  root.appendChild(workspace);

  const tree = buildTree(folders, notes);
  const rootFolders = (tree.foldersByParent.get("") || []).sort(byPositionThenName);
  const rootNotes = (tree.notesByFolder.get("") || []).sort(byPositionThenName);
  if (!rootFolders.length && !rootNotes.length) {
    root.appendChild(query
      ? createEmpty("Nenhum resultado encontrado", "A busca não encontrou notas ou pastas.")
      : createEmpty("Nenhuma nota ainda", "Crie uma nota ou uma pasta para começar a organizar seu workspace."));
  } else {
    rootFolders.forEach((folder) => root.appendChild(renderFolderNode(folder, tree, options, 0)));
    rootNotes.forEach((note) => root.appendChild(renderNoteRow(note, options, 0)));
  }

  if (!query && recent.length) {
    const section = createSection("Recentes", { muted: `${recent.length}` });
    root.appendChild(section);
    recent.slice(0, 6).forEach((note) => root.appendChild(renderNoteRow(note, options, 0)));
  }

  const footer = document.createElement("div");
  footer.className = "sidebar-smart-footer";
  footer.innerHTML = `
    <button type="button" class="filter-tab${view === "archived" ? " is-active" : ""}" data-smart-view="archived"><i class="ph ph-archive"></i><span>Arquivadas</span><small>${archived.length}</small></button>
    <button type="button" class="filter-tab${view === "trash" ? " is-active" : ""}" data-smart-view="trash"><i class="ph ph-trash"></i><span>Lixeira</span><small>${trash.length}</small></button>
  `;
  root.appendChild(footer);

  root.querySelectorAll("[data-smart-view]").forEach((button) => {
    button.addEventListener("click", () => options.onSmartView?.(button.dataset.smartView));
  });
}
