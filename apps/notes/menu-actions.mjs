import { getAvailableCommands } from "./commands.js";

function toIdSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

export function isNoteInTrash(note, view = "") {
  return Boolean(note?.deleted_at) || (Boolean(note) && view === "trash");
}

export function getNoteContext(note, options = {}) {
  const view = String(options.view || "active");
  const selectedNoteIds = toIdSet(options.selectedNoteIds);
  const notes = Array.isArray(options.notes) ? options.notes : [];
  const selectedNotes = notes.filter((item) => selectedNoteIds.has(item.id));
  const selectedCount = selectedNoteIds.size;
  const noteTrashed = isNoteInTrash(note, view);

  return {
    view,
    notes,
    selectedNoteIds,
    selectedNotes,
    selectedCount,
    compactWindow: Boolean(options.compactWindow),
    hasBulkSelection: selectedCount > 1,
    targetSelected: Boolean(note?.id && selectedNoteIds.has(note.id)),
    noteTrashed,
    noteArchived: Boolean(note?.archived) && !noteTrashed,
    noteFavorited: Boolean(note?.favorite),
    trashView: view === "trash",
    archivedView: view === "archived",
  };
}

function selectedNotesAreTrash(context) {
  if (context.trashView) return true;
  return context.selectedNotes.length > 0
    && context.selectedNotes.every((note) => isNoteInTrash(note, context.view));
}

function hasAnyFavorite(context) {
  return context.selectedNotes.some((note) => Boolean(note?.favorite));
}

function buildCompactDangerMenu(id, label) {
  return {
    id: "bulk-more",
    label: "Mais",
    icon: "ph-dots-three",
    menuItems: [
      { id, label, icon: "ph-trash", variant: "danger" },
    ],
  };
}

export function buildBulkSelectionActions(context = {}) {
  const bulkContext = {
    ...context,
    selectedNotes: Array.isArray(context.selectedNotes) ? context.selectedNotes : [],
    view: String(context.view || "active"),
  };
  const trashSelection = selectedNotesAreTrash(bulkContext);
  const actions = [];

  if (trashSelection) {
    actions.push({
      id: "bulk-restore.run",
      label: "Restaurar selecionadas",
      icon: "ph-arrow-counter-clockwise",
      variant: "primary",
    });
    actions.push(
      bulkContext.compactWindow
        ? buildCompactDangerMenu("bulk-purge.run", "Excluir definitivamente")
        : { id: "bulk-purge.run", label: "Excluir definitivamente", icon: "ph-trash", variant: "danger" },
    );
  } else {
    actions.push({
      id: "bulk-favorite.run",
      label: hasAnyFavorite(bulkContext) ? "Desfavoritar" : "Favoritar",
      icon: hasAnyFavorite(bulkContext) ? "ph-star" : "ph-star",
    });
    actions.push({
      id: "bulk-archive.run",
      label: bulkContext.archivedView ? "Desarquivar" : "Arquivar",
      icon: bulkContext.archivedView ? "ph-archive-tray" : "ph-archive",
    });
    actions.push(
      bulkContext.compactWindow
        ? buildCompactDangerMenu("bulk-delete.run", "Mover para lixeira")
        : { id: "bulk-delete.run", label: "Mover para lixeira", icon: "ph-trash", variant: "danger" },
    );
  }

  actions.push({
    id: "bulk-clear.run",
    label: "Limpar seleção",
    icon: "ph-x",
  });
  return actions;
}

const SIDEBAR_NOTE_COMMANDS = [
  "note.open",
  "note.rename",
  "note.duplicate",
  "note.move",
  "note.favorite.toggle",
  "note.archive",
  "note.unarchive",
  "note.restore",
  "note.deletePermanent",
  "note.trash",
];

const EDITOR_MORE_COMMANDS = [
  "note.rename",
  "note.duplicate",
  "note.move",
  "note.favorite.toggle",
  "note.archive",
  "note.unarchive",
  "note.restore",
  "note.deletePermanent",
  "note.copyLink",
  "note.revisions",
  "note.info",
  "note.export",
  "note.trash",
];

export function buildNoteMenuActions(note, options = {}) {
  const context = getNoteContext(note, options);
  if (context.hasBulkSelection && context.targetSelected) {
    return buildBulkSelectionActions(context);
  }
  if (!note) return [];
  return getAvailableCommands(SIDEBAR_NOTE_COMMANDS, { ...context, note });
}

export function buildEditorMoreActions(note, options = {}) {
  const context = getNoteContext(note, options);
  if (!note) return [];
  return getAvailableCommands(EDITOR_MORE_COMMANDS, { ...context, note });
}
