function noteIsTrash(ctx = {}) {
  return Boolean(ctx.note?.deleted_at) || ctx.view === "trash";
}

function noteIsArchived(ctx = {}) {
  return Boolean(ctx.note?.archived) && !noteIsTrash(ctx);
}

function hasNote(ctx = {}) {
  return Boolean(ctx.note?.id);
}

function hasFolder(ctx = {}) {
  return Boolean(ctx.folder?.id);
}

export const commands = {
  "note.open": {
    id: "note.open",
    label: "Abrir",
    icon: "ph-arrow-square-in",
    run: (ctx) => ctx.actions.openNote(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx),
    isEnabled: hasNote,
  },
  "note.openTab": {
    id: "note.openTab",
    label: "Abrir em nova aba",
    icon: "ph-arrow-square-out",
    run: (ctx) => ctx.actions.openNoteInNewTab(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx) && !noteIsArchived(ctx),
    isEnabled: hasNote,
  },
  "note.rename": {
    id: "note.rename",
    label: "Renomear",
    icon: "ph-pencil-simple",
    run: (ctx) => ctx.actions.renameNote(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx) && !noteIsArchived(ctx),
    isEnabled: hasNote,
  },
  "note.duplicate": {
    id: "note.duplicate",
    label: "Duplicar",
    icon: "ph-copy-simple",
    run: (ctx) => ctx.actions.duplicateNote(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx) && !noteIsArchived(ctx),
    isEnabled: hasNote,
  },
  "note.move": {
    id: "note.move",
    label: "Mover para...",
    icon: "ph-folder-simple-arrow-right",
    run: (ctx) => ctx.actions.moveNote(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx),
    isEnabled: hasNote,
  },
  "note.favorite.toggle": {
    id: "note.favorite.toggle",
    label: (ctx) => ctx.note?.favorite ? "Desfavoritar" : "Favoritar",
    icon: "ph-star",
    run: (ctx) => ctx.actions.toggleFavorite(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx) && !noteIsArchived(ctx),
    isEnabled: hasNote,
  },
  "note.archive": {
    id: "note.archive",
    label: "Arquivar",
    icon: "ph-archive",
    run: (ctx) => ctx.actions.toggleArchive(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx) && !noteIsArchived(ctx),
    isEnabled: hasNote,
  },
  "note.unarchive": {
    id: "note.unarchive",
    label: "Restaurar do arquivo",
    icon: "ph-archive-tray",
    run: (ctx) => ctx.actions.toggleArchive(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && noteIsArchived(ctx),
    isEnabled: hasNote,
  },
  "note.trash": {
    id: "note.trash",
    label: "Mover para lixeira",
    icon: "ph-trash",
    variant: "danger",
    separatorBefore: true,
    run: (ctx) => ctx.actions.trashNote(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx),
    isEnabled: hasNote,
  },
  "note.restore": {
    id: "note.restore",
    label: "Restaurar",
    icon: "ph-arrow-counter-clockwise",
    variant: "primary",
    run: (ctx) => ctx.actions.restoreNote(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && noteIsTrash(ctx),
    isEnabled: hasNote,
  },
  "note.deletePermanent": {
    id: "note.deletePermanent",
    label: "Excluir definitivamente",
    icon: "ph-trash",
    variant: "danger",
    separatorBefore: true,
    run: (ctx) => ctx.actions.purgeNote(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && noteIsTrash(ctx),
    isEnabled: hasNote,
  },
  "note.copyLink": {
    id: "note.copyLink",
    label: "Copiar link da nota",
    icon: "ph-link-simple",
    run: (ctx) => ctx.actions.copyNoteLink(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx),
    isEnabled: hasNote,
  },
  "note.revisions": {
    id: "note.revisions",
    label: "Histórico da nota",
    icon: "ph-clock-counter-clockwise",
    run: (ctx) => ctx.actions.openRevisions(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx),
    isEnabled: hasNote,
  },
  "note.info": {
    id: "note.info",
    label: "Informações da nota",
    icon: "ph-info",
    run: (ctx) => ctx.actions.openInfo(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx),
    isEnabled: hasNote,
  },
  "note.export": {
    id: "note.export",
    label: "Exportar",
    icon: "ph-export",
    run: (ctx) => ctx.actions.openExport(ctx.note?.id),
    isVisible: (ctx) => hasNote(ctx) && !noteIsTrash(ctx),
    isEnabled: hasNote,
  },
  "folder.create": {
    id: "folder.create",
    label: "Nova pasta",
    icon: "ph-folder-plus",
    run: (ctx) => ctx.actions.createFolder(ctx.folder?.id || ctx.targetFolderId || null),
    isVisible: () => true,
    isEnabled: () => true,
  },
  "folder.createChild": {
    id: "folder.createChild",
    label: "Nova subpasta",
    icon: "ph-folder-plus",
    run: (ctx) => ctx.actions.createFolder(ctx.folder?.id),
    isVisible: hasFolder,
    isEnabled: hasFolder,
  },
  "folder.createNote": {
    id: "folder.createNote",
    label: "Nova nota dentro",
    icon: "ph-note-pencil",
    run: (ctx) => ctx.actions.createNote(ctx.folder?.id || null),
    isVisible: hasFolder,
    isEnabled: hasFolder,
  },
  "folder.rename": {
    id: "folder.rename",
    label: "Renomear",
    icon: "ph-pencil-simple",
    run: (ctx) => ctx.actions.renameFolder(ctx.folder?.id),
    isVisible: hasFolder,
    isEnabled: hasFolder,
  },
  "folder.move": {
    id: "folder.move",
    label: "Mover para...",
    icon: "ph-folder-simple-arrow-right",
    run: (ctx) => ctx.actions.moveFolder(ctx.folder?.id),
    isVisible: hasFolder,
    isEnabled: hasFolder,
  },
  "folder.delete": {
    id: "folder.delete",
    label: "Excluir pasta",
    icon: "ph-trash",
    variant: "danger",
    separatorBefore: true,
    run: (ctx) => ctx.actions.deleteFolder(ctx.folder?.id),
    isVisible: hasFolder,
    isEnabled: hasFolder,
  },
  "note.create": {
    id: "note.create",
    label: "Nova nota",
    icon: "ph-plus",
    run: (ctx) => ctx.actions.createNote(ctx.targetFolderId || null),
    isVisible: () => true,
    isEnabled: () => true,
  },
  "sidebar.expandAll": {
    id: "sidebar.expandAll",
    label: "Expandir tudo",
    icon: "ph-caret-down",
    run: (ctx) => ctx.actions.expandAll(),
    isVisible: () => true,
    isEnabled: () => true,
  },
  "sidebar.collapseAll": {
    id: "sidebar.collapseAll",
    label: "Recolher tudo",
    icon: "ph-caret-right",
    run: (ctx) => ctx.actions.collapseAll(),
    isVisible: () => true,
    isEnabled: () => true,
  },
  "sidebar.toggle": {
    id: "sidebar.toggle",
    label: "Sidebar",
    icon: "ph-sidebar",
    run: (ctx) => ctx.actions.toggleSidebar(),
    isVisible: () => true,
    isEnabled: () => true,
  },
  "app.search": {
    id: "app.search",
    label: "Buscar",
    icon: "ph-magnifying-glass",
    run: (ctx) => ctx.actions.search(),
    isVisible: () => true,
    isEnabled: () => true,
  },
};

export function normalizeCommand(command, context = {}) {
  if (!command) return null;
  const visible = command.isVisible ? command.isVisible(context) : true;
  const enabled = command.isEnabled ? command.isEnabled(context) : true;
  if (!visible) return null;
  return {
    id: command.id,
    label: typeof command.label === "function" ? command.label(context) : command.label,
    icon: typeof command.icon === "function" ? command.icon(context) : command.icon,
    variant: command.variant,
    separatorBefore: command.separatorBefore,
    disabled: !enabled,
  };
}

export function getAvailableCommands(ids = [], context = {}) {
  return ids
    .map((id) => normalizeCommand(commands[id], context))
    .filter(Boolean);
}

export async function runCommand(id, context = {}) {
  const command = commands[id];
  if (!command) return false;
  if (command.isVisible && !command.isVisible(context)) return false;
  if (command.isEnabled && !command.isEnabled(context)) return false;
  await command.run(context);
  return true;
}
