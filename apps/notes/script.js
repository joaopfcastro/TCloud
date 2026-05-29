import { EditorAdapter, buildBlock, normalizeEditorData } from "./editor-adapter.js?v=notes-inline-selection-20260529-1";
import { NotesApi } from "./notes-api.js";
import { NotesFilePicker } from "./file-picker.js";
import { IMPORT_ACCEPT, isSupportedImportFile, readFileAsText } from "./export-import.js";
import { blocksToMarkdownPreview } from "./markdown-converter.js";
import { installWikiLinkAutocomplete } from "./relations.js?v=notes-audit-overlays-20260526-1";
import {
  buildBulkSelectionActions,
  buildEditorMoreActions,
  buildNoteMenuActions,
  getNoteContext,
} from "./menu-actions.mjs";
import { getAvailableCommands, runCommand } from "./commands.js";
import {
  buildFolderOptions,
  isFolderDescendant,
  loadSidebarUiState,
  renderSidebarTree,
  saveSidebarUiState,
} from "./sidebar-tree.js";

const AUTOSAVE_DELAY_MS = 1200;
const SEARCH_DELAY_MS = 260;
const SAVE_STATUS_TICK_MS = 1000;
const APPEARANCE_PROPERTY_KEY = "__tcloudAppearance";

const ATTACHMENT_BLOCKS = {
  file: "tcloudFile",
  image: "tcloudImage",
  video: "tcloudVideo",
  audio: "tcloudAudio",
  pdf: "tcloudPdf",
  folder: "tcloudFolder",
};

const SLASH_OPTIONS = [
  { id: "text", icon: "T", group: "Básico", label: "Texto", hint: "Parágrafo simples", type: "paragraph", data: { text: "" } },
  { id: "heading", icon: "H", group: "Básico", label: "Título", hint: "Seção ou subtítulo", type: "header", data: { level: 2, text: "" } },
  { id: "list", icon: "•", group: "Básico", label: "Lista", hint: "Itens com marcadores", type: "list", data: { style: "unordered", items: [""] } },
  { id: "todo", icon: "✓", group: "Básico", label: "Checklist", hint: "Tarefas marcáveis", type: "todo", data: { text: "", checked: false } },
  { id: "quote", icon: "”", group: "Básico", label: "Citação", hint: "Destaque com fonte", type: "quote", data: { text: "", caption: "" } },
  { id: "code", icon: "{ }", group: "Básico", label: "Código", hint: "Bloco monoespaçado", type: "codeBlock", data: { code: "" } },
  { id: "divider", icon: "—", group: "Básico", label: "Divisor", hint: "Separador visual", type: "divider", data: {} },
  { id: "file", icon: "F", group: "TCloud", label: "Arquivo", hint: "Referencia do TCloud", picker: { kinds: ["file", "image", "video", "audio", "pdf"], blockType: "tcloudFile" } },
  { id: "image", icon: "I", group: "TCloud", label: "Imagem", hint: "Imagem do TCloud", picker: { kinds: ["image"], blockType: "tcloudImage" } },
  { id: "folder", icon: "P", group: "TCloud", label: "Pasta", hint: "Pasta ou colecao", picker: { kinds: ["folder"], allowFolders: true, blockType: "tcloudFolder" } },
  { id: "pdf", icon: "PDF", group: "TCloud", label: "PDF", hint: "Documento PDF", picker: { kinds: ["pdf"], blockType: "tcloudPdf" } },
];

const COVER_PRESETS = {
  gradient: { type: "gradient", value: "blue-green" },
  color: { type: "color", value: "#2c2c2e" },
  none: { type: "none", value: "" },
};

const COVER_GRADIENTS = [
  { id: "blue-green", label: "Azul sereno", css: "linear-gradient(135deg, rgba(10, 132, 255, 0.34), rgba(48, 209, 88, 0.16)), #242a31" },
  { id: "graphite", label: "Grafite", css: "linear-gradient(135deg, #23272f, #606874)" },
  { id: "rose", label: "Aurora", css: "linear-gradient(135deg, #f8b4c8, #f7d8a8)" },
  { id: "mint", label: "Menta", css: "linear-gradient(135deg, #b7ecd5, #dcead8)" },
  { id: "sky", label: "Céu", css: "linear-gradient(135deg, #9fd3ff, #d9ecff)" },
  { id: "ink", label: "Tinta", css: "linear-gradient(135deg, #1f2937, #405064)" },
];

const NOTE_ICON_CATALOG = [
  // Recentes (kept for legacy support, but updated or mapped nicely)
  { value: "▰", label: "Bloco", group: "Sugestões", aliases: ["bloco", "quadrado", "padrao", "padrão", "default", "note"] },
  { value: "⭐", label: "Estrela", group: "Sugestões", aliases: ["estrela", "favorito", "favorite", "star"] },
  { value: "✅", label: "Check", group: "Sugestões", aliases: ["check", "feito", "ok", "done", "concluido", "concluído", "tarefa"] },
  { value: "📌", label: "Pin", group: "Sugestões", aliases: ["pin", "fixar", "fixado", "importante"] },
  { value: "🧠", label: "Cérebro", group: "Sugestões", aliases: ["cerebro", "cérebro", "mente", "neurologia", "psico"] },
  { value: "📚", label: "Livros", group: "Sugestões", aliases: ["livro", "livros", "book", "books", "estudo", "academico", "acadêmico"] },

  // Saúde
  { value: "🧬", label: "Genética", group: "Saúde", aliases: ["genetica", "genética", "dna", "science", "ciencia"] },
  { value: "🦠", label: "Vírus", group: "Saúde", aliases: ["virus", "vírus", "bacteria", "microbio", "doenca"] },
  { value: "💊", label: "Remédio", group: "Saúde", aliases: ["remedio", "remédio", "pilula", "medicine", "pill", "medicamento"] },
  { value: "💉", label: "Vacina", group: "Saúde", aliases: ["vacina", "seringa", "syringe", "vaccine", "sangue"] },
  { value: "🏥", label: "Hospital", group: "Saúde", aliases: ["hospital", "clinica", "clínica", "medical", "saude"] },
  { value: "🫀", label: "Coração anatômico", group: "Saúde", aliases: ["coracao", "coração", "heart", "anatomico", "cardiologia"] },
  { value: "🫁", label: "Pulmão", group: "Saúde", aliases: ["pulmao", "pulmão", "lungs", "respirar", "pneumo"] },
  { value: "🦷", label: "Dente", group: "Saúde", aliases: ["dente", "tooth", "odonto", "dentista"] },
  { value: "👁️", label: "Olho", group: "Saúde", aliases: ["olho", "eye", "visao", "visão", "oftalmo"] },
  { value: "🩸", label: "Sangue", group: "Saúde", aliases: ["sangue", "blood", "doacao", "hemo"] },
  { value: "⚕️", label: "Símbolo de Saúde", group: "Saúde", aliases: ["saude", "saúde", "medico", "médico", "medical", "hospital", "medicina", "caduceu"] },
  { value: "🩺", label: "Medicina", group: "Saúde", aliases: ["medicina", "medical", "medico", "médico", "saude", "saúde", "estetoscopio", "estetoscópio"] },
  { value: "🤰", label: "Obstetrícia", group: "Saúde", aliases: ["obstetricia", "obstetrícia", "gestante", "gestacao", "gestação", "gravidez", "pregnancy"] },

  // Trabalho
  { value: "💼", label: "Trabalho", group: "Trabalho", aliases: ["trabalho", "work", "pasta", "maleta", "negocios", "job"] },
  { value: "📊", label: "Gráfico", group: "Trabalho", aliases: ["grafico", "gráfico", "chart", "analytics", "dashboard"] },
  { value: "📈", label: "Crescimento", group: "Trabalho", aliases: ["crescimento", "alta", "chart", "upward", "subindo", "sucesso", "investimento"] },
  { value: "📉", label: "Queda", group: "Trabalho", aliases: ["queda", "perda", "downward", "descendo", "despesa"] },
  { value: "📅", label: "Calendário", group: "Trabalho", aliases: ["calendario", "calendário", "calendar", "agenda", "data", "compromisso"] },
  { value: "🧾", label: "Recibo", group: "Trabalho", aliases: ["recibo", "nota fiscal", "invoice", "pagamento", "financas"] },
  { value: "📎", label: "Anexo", group: "Trabalho", aliases: ["anexo", "clip", "paperclip", "documento"] },
  { value: "🗂️", label: "Arquivo", group: "Trabalho", aliases: ["arquivo", "card", "organizar", "index"] },
  { value: "🖥️", label: "Computador", group: "Trabalho", aliases: ["computador", "desktop", "tela", "screen", "tecnologia"] },

  // Estudo
  { value: "📖", label: "Leitura", group: "Estudo", aliases: ["leitura", "ler", "livro", "book", "read"] },
  { value: "🧪", label: "Laboratório", group: "Estudo", aliases: ["laboratorio", "laboratório", "quimica", "química", "chemistry", "ciencia"] },
  { value: "🔬", label: "Microscópio", group: "Estudo", aliases: ["microscopio", "microscópio", "biologia", "pesquisa", "science"] },
  { value: "✏️", label: "Lápis", group: "Estudo", aliases: ["lapis", "lápis", "pencil", "escrever", "write", "draft"] },
  { value: "🎓", label: "Graduação", group: "Estudo", aliases: ["graduacao", "graduação", "formatura", "college", "universidade", "diploma"] },
  { value: "📝", label: "Anotação", group: "Estudo", aliases: ["anotacao", "anotação", "nota", "note", "rascunho"] },

  // Organização
  { value: "📁", label: "Pasta", group: "Organização", aliases: ["pasta", "folder", "arquivo", "organizar", "categoria"] },
  { value: "🗃️", label: "Caixa de Arquivos", group: "Organização", aliases: ["caixa", "box", "arquivo", "archive"] },
  { value: "🏷️", label: "Etiqueta", group: "Organização", aliases: ["tag", "etiqueta", "hashtag", "categoria", "label"] },
  { value: "📋", label: "Checklist", group: "Organização", aliases: ["checklist", "clipboard", "lista", "list", "tarefas"] },
  { value: "🗓️", label: "Agenda", group: "Organização", aliases: ["agenda", "calendario", "compromisso"] },
  { value: "🔍", label: "Busca", group: "Organização", aliases: ["busca", "procura", "search", "lupa"] },

  // Finanças
  { value: "💰", label: "Dinheiro", group: "Finanças", aliases: ["dinheiro", "money", "saco", "ouro", "gold", "riqueza"] },
  { value: "💳", label: "Cartão", group: "Finanças", aliases: ["cartao", "cartão", "credit", "card", "banco", "pagamento"] },
  { value: "🏦", label: "Banco", group: "Finanças", aliases: ["banco", "bank", "instituicao", "financas"] },
  { value: "🧮", label: "Cálculo", group: "Finanças", aliases: ["calculo", "cálculo", "calculadora", "math", "contas"] },

  // Casa
  { value: "🏠", label: "Casa", group: "Casa", aliases: ["casa", "home", "lar", "house", "moradia"] },
  { value: "🛒", label: "Compras", group: "Casa", aliases: ["compras", "carrinho", "cart", "supermercado", "shop"] },
  { value: "🍽️", label: "Comida", group: "Casa", aliases: ["comida", "prato", "restaurante", "food", "jantar", "almoco"] },
  { value: "🚗", label: "Carro", group: "Casa", aliases: ["carro", "car", "veiculo", "viagem", "transporte"] },
  { value: "✈️", label: "Viagem", group: "Casa", aliases: ["viagem", "aviao", "avião", "flight", "travel", "turismo"] },

  // Pessoas
  { value: "👤", label: "Usuário", group: "Pessoas", aliases: ["usuario", "usuário", "user", "perfil", "pessoa", "profile"] },
  { value: "👥", label: "Grupo", group: "Pessoas", aliases: ["grupo", "team", "equipe", "pessoas", "people"] },
  { value: "❤️", label: "Coração", group: "Pessoas", aliases: ["coracao", "coração", "heart", "amor", "saude", "saúde"] },
  { value: "👍", label: "Joia", group: "Pessoas", aliases: ["joia", "curtir", "like", "thumbs up", "ok", "positivo"] },

  // Ideias
  { value: "💡", label: "Ideia", group: "Ideias", aliases: ["ideia", "lampada", "lâmpada", "insight", "lightbulb", "criatividade"] },
  { value: "💭", label: "Pensamento", group: "Ideias", aliases: ["pensamento", "bubble", "nuvem", "thought", "ideias"] },
  { value: "💬", label: "Balão", group: "Ideias", aliases: ["balao", "balão", "chat", "conversa", "feedback", "comentario"] },
  { value: "📣", label: "Megafone", group: "Ideias", aliases: ["megafone", "anuncio", "aviso", "novidade", "alerta"] },

  // Status
  { value: "🔥", label: "Fogo", group: "Status", aliases: ["fogo", "urgente", "hot", "importante", "fire"] },
  { value: "⚠️", label: "Alerta", group: "Status", aliases: ["alerta", "aviso", "perigo", "warning", "atencao", "atenção"] },
  { value: "💡", label: "Insight", group: "Status", aliases: ["insight", "ideia", "lampada"] },
  { value: "❗", label: "Importante", group: "Status", aliases: ["importante", "atencao", "exclamacao", "perigo"] },
  { value: "❓", label: "Dúvida", group: "Status", aliases: ["duvida", "dúvida", "pergunta", "question"] },
  { value: "⏳", label: "Pendente", group: "Status", aliases: ["pendente", "ampulheta", "espera", "waiting", "time"] },
  { value: "🚧", label: "Em andamento", group: "Status", aliases: ["construcao", "andamento", "progresso", "work"] },
  { value: "🟢", label: "Ok", group: "Status", aliases: ["ok", "verde", "green", "sucesso", "ativo"] },
  { value: "🔴", label: "Crítico", group: "Status", aliases: ["critico", "crítico", "erro", "danger", "cancelado", "parado"] },

  // Símbolos
  { value: "●", label: "Círculo Cheio", group: "Símbolos", aliases: ["circulo", "círculo", "circle", "bolinha", "dot"] },
  { value: "○", label: "Círculo Vazio", group: "Símbolos", aliases: ["circulo", "círculo", "circle", "bolinha", "vazio"] },
  { value: "■", label: "Quadrado Cheio", group: "Símbolos", aliases: ["quadrado", "square", "cheio"] },
  { value: "□", label: "Quadrado Vazio", group: "Símbolos", aliases: ["quadrado", "square", "vazio"] },
  { value: "▲", label: "Triângulo Cheio", group: "Símbolos", aliases: ["triangulo", "triângulo", "triangle"] },
  { value: "△", label: "Triângulo Vazio", group: "Símbolos", aliases: ["triangulo", "triângulo", "triangle", "vazio"] },
  { value: "◆", label: "Losango Cheio", group: "Símbolos", aliases: ["losango", "diamante", "diamond"] },
  { value: "◇", label: "Losango Vazio", group: "Símbolos", aliases: ["losango", "diamante", "diamond", "vazio"] },
  { value: "✦", label: "Brilho Quatro Pontas", group: "Símbolos", aliases: ["brilho", "sparkle", "estrela"] },
  { value: "✧", label: "Brilho Vazio", group: "Símbolos", aliases: ["brilho", "sparkle", "estrela", "vazio"] },
  { value: "#", label: "Hashtag", group: "Símbolos", aliases: ["tag", "hashtag", "numero", "número"] },
  { value: "!", label: "Exclamação", group: "Símbolos", aliases: ["exclamacao", "exclamação", "perigo", "alerta"] },
  { value: "?", label: "Interrogação", group: "Símbolos", aliases: ["pergunta", "duvida", "dúvida", "question", "interrogacao"] },
  { value: "+", label: "Mais", group: "Símbolos", aliases: ["mais", "plus", "adicionar", "soma"] },
  { value: "−", label: "Menos", group: "Símbolos", aliases: ["menos", "minus", "subtracao", "remover"] },
];

function templateContent(blocks) {
  return normalizeEditorData({ time: Date.now(), blocks });
}

const TEMPLATES = [
  {
    id: "blank",
    label: "Em branco",
    description: "Página vazia para começar rápido.",
    title: "Sem título",
    content: templateContent([buildBlock("paragraph", { text: "" })]),
  },
  {
    id: "meeting",
    label: "Reunião",
    description: "Agenda, tópicos e próximos passos.",
    title: "Reunião",
    content: templateContent([
      buildBlock("header", { level: 1, text: "Reunião" }),
      buildBlock("header", { level: 2, text: "Agenda" }),
      buildBlock("list", { style: "unordered", items: ["Contexto", "Decisões", "Pendências"] }),
      buildBlock("header", { level: 2, text: "Notas" }),
      buildBlock("paragraph", { text: "" }),
      buildBlock("header", { level: 2, text: "Próximos passos" }),
      buildBlock("todo", { text: "Definir responsáveis", checked: false }),
    ]),
  },
  {
    id: "checklist",
    label: "Checklist",
    description: "Lista de tarefas simples em blocos.",
    title: "Checklist",
    content: templateContent([
      buildBlock("header", { level: 1, text: "Checklist" }),
      buildBlock("todo", { text: "Primeiro item", checked: false }),
      buildBlock("todo", { text: "Segundo item", checked: false }),
      buildBlock("todo", { text: "Terceiro item", checked: false }),
    ]),
  },
  {
    id: "study",
    label: "Estudo",
    description: "Resumo, referências e perguntas.",
    title: "Sessão de estudo",
    content: templateContent([
      buildBlock("header", { level: 1, text: "Sessão de estudo" }),
      buildBlock("header", { level: 2, text: "Objetivo" }),
      buildBlock("paragraph", { text: "" }),
      buildBlock("header", { level: 2, text: "Resumo" }),
      buildBlock("paragraph", { text: "" }),
      buildBlock("header", { level: 2, text: "Perguntas abertas" }),
      buildBlock("list", { style: "unordered", items: [""] }),
    ]),
  },
  {
    id: "journal",
    label: "Diário",
    description: "Reflexões, humor e destaques do dia.",
    title: "Diário",
    content: templateContent([
      buildBlock("header", { level: 1, text: "Diário" }),
      buildBlock("quote", { text: "Como estou chegando hoje?", caption: "Reflexão" }),
      buildBlock("header", { level: 2, text: "O que aconteceu" }),
      buildBlock("paragraph", { text: "" }),
      buildBlock("header", { level: 2, text: "Aprendizados" }),
      buildBlock("list", { style: "unordered", items: [""] }),
    ]),
  },
  {
    id: "project",
    label: "Projeto",
    description: "Contexto, entregas, riscos e status.",
    title: "Projeto",
    content: templateContent([
      buildBlock("header", { level: 1, text: "Projeto" }),
      buildBlock("header", { level: 2, text: "Objetivo" }),
      buildBlock("paragraph", { text: "" }),
      buildBlock("header", { level: 2, text: "Entregas" }),
      buildBlock("todo", { text: "Marco 1", checked: false }),
      buildBlock("todo", { text: "Marco 2", checked: false }),
      buildBlock("header", { level: 2, text: "Riscos" }),
      buildBlock("quote", { text: "", caption: "O que pode travar?" }),
    ]),
  },
];

const state = {
  api: new NotesApi(),
  editor: null,
  picker: null,
  notes: [],
  folders: [],
  tree: {
    folders: [],
    notes: [],
    favorites: [],
    recent: [],
    archived: [],
    trash: [],
  },
  revisions: [],
  attachments: [],
  currentNoteId: "",
  currentNote: null,
  loadingNote: false,
  saveTimer: 0,
  searchTimer: 0,
  statusTimer: 0,
  dirtyTitle: false,
  dirtyContent: false,
  dirtyMeta: false,
  isSaving: false,
  lastLoadedQuery: "",
  filters: {
    view: "active",
    tag: "",
  },
  selectedFolderId: "",
  expandedFolderIds: new Set(),
  saveState: {
    mode: "idle",
    at: 0,
    error: "",
  },
  modal: "",
  pendingConfirmAction: null,
  folderNameRequest: null,
  moveDestinationRequest: null,
  slashMenu: {
    open: false,
    index: 0,
    replaceCurrent: true,
    filteredOptions: null,
  },
  ui: {
    sidebarCollapsed: false,
    compactWindow: false,
    mobileSidebarDrawer: false,
    chromeMode: "standalone",
    iconQuery: "",
    coverColorDraft: "",
  },
  compactWindowObserver: null,
  bootAttempt: 0,
  favoriteSaving: false,
  floatingSearch: {
    visible: false,
    query: "",
    index: -1,
    highlights: [],
  },
  selectedNoteIds: new Set(),
  lastClickedNoteId: null,
  contextMenuTargetNoteId: "",
  contextMenuTargetFolderId: "",
  contextMenuTargetBlock: null,
  currentListRequestId: 0,
  currentOpenNoteRequestId: 0,
};

const els = {
  app: document.querySelector(".notes-app"),
  searchInput: document.getElementById("search-input"),
  newNoteButton: document.getElementById("new-note-button"),
  newFolderButton: document.getElementById("new-folder-button"),
  sidebarToggleButton: document.getElementById("sidebar-toggle-button"),
  sidebarOpenButton: document.getElementById("sidebar-open-button"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  templatesButton: document.getElementById("templates-button"),
  importButton: document.getElementById("import-button"),
  exportButton: document.getElementById("export-button"),
  backupButton: document.getElementById("backup-button"),
  notesList: document.getElementById("notes-list"),
  listMeta: document.getElementById("list-meta"),
  titleInput: document.getElementById("note-title"),
  favoriteButton: document.getElementById("favorite-button"),
  saveStatus: document.getElementById("save-status"),
  noteBreadcrumb: document.getElementById("note-breadcrumb"),
  noteMeta: document.getElementById("note-meta"),
  noteStateBanner: document.getElementById("note-state-banner"),
  deleteButton: document.getElementById("delete-note-button"),
  restoreNoteButton: document.getElementById("restore-note-button"),
  revisionsButton: document.getElementById("revisions-button"),
  archiveButton: document.getElementById("archive-note-button"),
  emptyState: document.getElementById("editor-empty-state"),
  emptyEyebrow: document.getElementById("empty-eyebrow"),
  emptyTitle: document.getElementById("empty-title"),
  emptyDescription: document.getElementById("empty-description"),
  editorPanel: document.getElementById("editor-panel"),
  editorHolder: document.getElementById("editorjs"),
  tagInput: document.getElementById("tag-input"),
  noteTags: document.getElementById("note-tags"),
  filterAll: document.getElementById("filter-all"),
  filterFavorites: document.getElementById("filter-favorites"),
  filterRecent: document.getElementById("filter-recent"),
  filterArchived: document.getElementById("filter-archived"),
  filterTrash: document.getElementById("filter-trash"),
  templatesModal: document.getElementById("templates-modal"),
  templatesGrid: document.getElementById("templates-grid"),
  emptyTemplateGrid: document.getElementById("empty-template-grid"),
  revisionsModal: document.getElementById("revisions-modal"),
  revisionsSummary: document.getElementById("revisions-summary"),
  revisionsList: document.getElementById("revisions-list"),
  importExportModal: document.getElementById("import-export-modal"),
  importFileInput: document.getElementById("import-file-input"),
  importFileName: document.getElementById("import-file-name"),
  importStatus: document.getElementById("import-status"),
  importConfirmButton: document.getElementById("import-confirm-button"),
  exportPreview: document.getElementById("export-preview"),
  exportJsonButton: document.getElementById("export-json-button"),
  exportMarkdownButton: document.getElementById("export-markdown-button"),
  exportHtmlButton: document.getElementById("export-html-button"),
  filePickerModal: document.getElementById("file-picker-modal"),
  confirmModal: document.getElementById("confirm-modal"),
  confirmEyebrow: document.getElementById("confirm-eyebrow"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmDescription: document.getElementById("confirm-description"),
  confirmCancelButton: document.getElementById("confirm-cancel-button"),
  confirmAcceptButton: document.getElementById("confirm-accept-button"),
  moveItemModal: document.getElementById("move-item-modal"),
  moveItemTitle: document.getElementById("move-item-title"),
  moveItemDescription: document.getElementById("move-item-description"),
  moveDestinationList: document.getElementById("move-destination-list"),
  moveItemCancelButton: document.getElementById("move-item-cancel-button"),
  folderNameModal: document.getElementById("folder-name-modal"),
  folderNameEyebrow: document.getElementById("folder-name-eyebrow"),
  folderNameTitle: document.getElementById("folder-name-title"),
  folderNameDescription: document.getElementById("folder-name-description"),
  folderNameInput: document.getElementById("folder-name-input"),
  folderNameError: document.getElementById("folder-name-error"),
  folderNameCancelButton: document.getElementById("folder-name-cancel-button"),
  folderNameSubmitButton: document.getElementById("folder-name-submit-button"),
  slashMenu: document.getElementById("slash-menu"),
  noteCover: document.getElementById("note-cover"),
  noteCoverButton: document.getElementById("note-cover-button"),
  noteCoverMenu: document.getElementById("note-cover-menu"),
  noteIconButton: document.getElementById("note-icon-button"),
  noteIconMenu: document.getElementById("note-icon-menu"),
  sidebarContextMenu: document.getElementById("sidebar-context-menu"),
  editorContextMenu: document.getElementById("editor-context-menu"),
  noteMoreButton: document.getElementById("note-more-button"),
  searchBarFloating: document.getElementById("search-bar-floating"),
  floatingSearchInput: document.getElementById("floating-search-input"),
  searchCounter: document.getElementById("search-counter"),
  searchPrev: document.getElementById("search-prev"),
  searchNext: document.getElementById("search-next"),
  searchClose: document.getElementById("search-close"),
  bulkState: document.getElementById("editor-bulk-state"),
};

function showToast(message, kind = "info") {
  state.api.showToast(message, kind);
}

function noteHash(noteId = "") {
  return noteId ? `#note=${encodeURIComponent(noteId)}` : "";
}

function readNoteIdFromHash() {
  const hash = String(window.location.hash || "").replace(/^#/, "");
  if (!hash) return "";
  const params = new URLSearchParams(hash);
  return String(params.get("note") || "").trim();
}

function syncNoteHash(noteId = "") {
  const nextHash = noteHash(noteId);
  if (window.location.hash === nextHash) return;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
}

function buildCurrentNoteUrl(noteId = state.currentNote?.id || state.currentNoteId) {
  if (!noteId) return window.location.href;
  const url = new URL(window.location.href);
  url.hash = noteHash(noteId);
  return url.toString();
}

async function copyToClipboard(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Nada para copiar.");
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.warn("Clipboard API indisponivel, usando fallback.", error);
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "true");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Nao foi possivel copiar o link da nota.");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function menuShortcut(key) {
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
  return `${isMac ? "⌘" : "Ctrl+"}${key}`;
}

function defaultAppearance() {
  return {
    cover: { type: "gradient", value: "blue-green" },
    icon: { type: "symbol", value: "▰" },
  };
}

function normalizeCover(rawCover) {
  const cover = rawCover && typeof rawCover === "object" ? rawCover : {};
  const type = ["none", "gradient", "color", "image"].includes(cover.type) ? cover.type : "gradient";
  const value = String(cover.value || "").trim();
  if (type === "none") return { type: "none", value: "" };
  if (type === "color") return { type: "color", value: value || COVER_PRESETS.color.value };
  if (type === "image") return { type: "image", value };
  return { type: "gradient", value: value || "blue-green" };
}

function normalizeIcon(rawIcon) {
  const icon = rawIcon && typeof rawIcon === "object" ? rawIcon : {};
  const type = ["none", "emoji", "symbol"].includes(icon.type) ? icon.type : "symbol";
  const value = String(icon.value || "").trim();
  if (type === "none") return { type: "none", value: "" };
  return { type, value: value.slice(0, 4) || "▰" };
}

function normalizeAppearance(rawAppearance) {
  const fallback = defaultAppearance();
  const raw = rawAppearance && typeof rawAppearance === "object" ? rawAppearance : {};
  return {
    cover: normalizeCover(raw.cover ?? fallback.cover),
    icon: normalizeIcon(raw.icon ?? fallback.icon),
  };
}

function coverGradientCss(value) {
  const gradient = COVER_GRADIENTS.find((item) => item.id === value) || COVER_GRADIENTS[0];
  return gradient.css;
}

function currentAppearance() {
  const properties = state.currentNote?.properties || {};
  const hasDedicatedAppearance = state.currentNote && ("cover" in state.currentNote || "icon" in state.currentNote);
  const rawAppearance = hasDedicatedAppearance
    ? { cover: state.currentNote?.cover, icon: state.currentNote?.icon }
    : (properties[APPEARANCE_PROPERTY_KEY] || properties.tcloudAppearance || properties.appearance || null);
  return normalizeAppearance(rawAppearance);
}

function coverBackground(cover) {
  if (cover.type === "none") return "";
  if (cover.type === "color") return cover.value || COVER_PRESETS.color.value;
  if (cover.type === "image" && cover.value) {
    return `linear-gradient(180deg, rgba(28, 28, 30, 0.04), rgba(28, 28, 30, 0.36)), url("${buildDirectStreamPath(cover.value)}")`;
  }
  return coverGradientCss(cover.value || COVER_PRESETS.gradient.value);
}

function renderAppearance() {
  const appearance = currentAppearance();
  if (els.noteCover) {
    els.noteCover.dataset.coverType = appearance.cover.type;
    els.noteCover.classList.toggle("is-hidden", appearance.cover.type === "none");
    els.noteCover.style.background = coverBackground(appearance.cover);
    els.noteCover.style.backgroundSize = appearance.cover.type === "image" ? "cover" : "";
    els.noteCover.style.backgroundPosition = appearance.cover.type === "image" ? "center" : "";
  }
  if (els.noteIconButton) {
    const empty = appearance.icon.type === "none";
    els.noteIconButton.classList.toggle("is-empty", empty);
    els.noteIconButton.textContent = empty ? "Adicionar ícone" : appearance.icon.value;
    els.noteIconButton.setAttribute("aria-label", empty ? "Adicionar ícone da nota" : "Trocar ícone da nota");
  }
  renderAppearanceMenus();
}

function renderAppearanceMenus() {
  renderIconMenu();
  renderCoverMenu();
}

function normalizeIconSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function iconMatchesQuery(item, query) {
  const safeQuery = normalizeIconSearch(query);
  if (!safeQuery) return true;
  const haystack = [
    item?.value,
    item?.label,
    item?.group,
    ...(Array.isArray(item?.aliases) ? item.aliases : []),
  ].map(normalizeIconSearch).join(" ");
  return haystack.includes(safeQuery);
}

function filteredIconCatalog() {
  const query = state.ui.iconQuery;
  return NOTE_ICON_CATALOG.filter((item) => iconMatchesQuery(item, query));
}

const RECENT_ICONS_STORAGE_KEY = "tcloud-notes-recent-icons-v1";
const RECENT_ICONS_LIMIT = 12;

function readRecentIcons() {
  try {
    const stored = localStorage.getItem(RECENT_ICONS_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Error reading recent icons from localStorage:", e);
    return [];
  }
}

function writeRecentIcons(values) {
  try {
    localStorage.setItem(RECENT_ICONS_STORAGE_KEY, JSON.stringify(values));
  } catch (e) {
    console.error("Error writing recent icons to localStorage:", e);
  }
}

function pushRecentIcon(value) {
  if (!value || value === "none") return;
  const recent = readRecentIcons();
  const index = recent.indexOf(value);
  if (index !== -1) {
    recent.splice(index, 1);
  }
  recent.unshift(value);
  if (recent.length > RECENT_ICONS_LIMIT) {
    recent.length = RECENT_ICONS_LIMIT;
  }
  writeRecentIcons(recent);
}

function getRecentIconItems() {
  const recentValues = readRecentIcons();
  if (!recentValues.length) return [];
  return recentValues.map(val => {
    const found = NOTE_ICON_CATALOG.find(item => item.value === val);
    return found ? { ...found, group: "Recentes" } : { value: val, label: val, group: "Recentes", aliases: [] };
  });
}

function renderIconSection(label, items, selectedValue) {
  const buttons = items
    .map((item) => `
      <button class="appearance-icon-choice${item.value === selectedValue ? " is-selected" : ""}" type="button" role="menuitemradio" aria-checked="${item.value === selectedValue ? "true" : "false"}" data-icon-value="${escapeHtml(item.value)}" title="${escapeHtml(item.label)}" aria-label="${escapeHtml(item.label)}">
        <span class="appearance-icon-symbol">${escapeHtml(item.value)}</span>
      </button>
    `)
    .join("");
  if (!buttons) return "";
  return `
    <div class="appearance-section">
      <span class="appearance-section-label">${escapeHtml(label)}</span>
      <div class="appearance-icon-grid">${buttons}</div>
    </div>
  `;
}

function renderIconMenu() {
  if (!els.noteIconMenu) return;
  const appearance = currentAppearance();
  const selectedValue = appearance.icon.type === "none" ? "" : appearance.icon.value;
  const query = state.ui.iconQuery.trim();

  // Load real recents and filter them
  let recentItems = getRecentIconItems();
  if (query) {
    recentItems = recentItems.filter(item => iconMatchesQuery(item, query));
  }
  const recentSectionHtml = recentItems.length > 0 ? renderIconSection("Recentes", recentItems, selectedValue) : "";

  const grouped = filteredIconCatalog().reduce((map, item) => {
    const group = item.group || "Ícones";
    if (!map.has(group)) map.set(group, []);
    map.get(group).push(item);
    return map;
  }, new Map());

  const catalogSectionsHtml = Array.from(grouped.entries())
    .map(([label, items]) => renderIconSection(label, items, selectedValue))
    .filter(Boolean)
    .join("");

  const scrollContentHtml = `${recentSectionHtml}${catalogSectionsHtml}`;

  els.noteIconMenu.innerHTML = `
    <div class="appearance-popover-header">
      <strong>Ícone da nota</strong>
      <span>Escolha um símbolo</span>
    </div>
    <div class="appearance-search">
      <label class="visually-hidden" for="note-icon-search">Buscar ícone</label>
      <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
      <input id="note-icon-search" type="search" placeholder="Buscar emoji ou símbolo" value="${escapeHtml(state.ui.iconQuery)}" autocomplete="off">
      <button class="appearance-search-clear${query ? "" : " hidden"}" type="button" data-icon-clear aria-label="Limpar busca" title="Limpar busca">
        <i class="ph ph-x" aria-hidden="true"></i>
      </button>
    </div>
    <div class="note-icon-quick-actions">
      <button class="note-icon-remove-button${!selectedValue ? " is-selected" : ""}" type="button" data-icon-value="none" aria-label="Sem ícone" title="Sem ícone">
        <i class="ph ph-trash" aria-hidden="true"></i>
        <span>Sem ícone</span>
      </button>
    </div>
    <div class="note-icon-scroll">
      ${scrollContentHtml || `<div class="appearance-empty icon-empty-state" role="status">
        <span>Nenhum ícone encontrado${query ? ` para “${escapeHtml(query)}”` : ""}.</span>
        <small>Tente estrela, médico, livro, check, pasta ou tag.</small>
      </div>`}
      <button class="appearance-danger-action" type="button" role="menuitem" data-icon-value="none">
        <i class="ph ph-trash" aria-hidden="true"></i>
        <span>Remover ícone</span>
      </button>
    </div>
  `;
}

function refreshIconMenuAfterSearch() {
  if (!els.noteIconMenu || els.noteIconMenu.classList.contains("hidden")) return;
  renderIconMenu();
  positionAppearancePopover(els.noteIconMenu, els.noteIconButton, { align: "start", width: 340 });
  window.requestAnimationFrame(() => {
    const input = els.noteIconMenu?.querySelector("#note-icon-search");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  });
}

function visibleIconChoices() {
  return Array.from(els.noteIconMenu?.querySelectorAll(".appearance-icon-choice") || [])
    .filter((button) => !button.hidden);
}

function focusIconChoice(offset) {
  const choices = visibleIconChoices();
  if (!choices.length) return;
  const activeIndex = choices.findIndex((button) => button === document.activeElement);
  const nextIndex = activeIndex === -1 ? 0 : (activeIndex + offset + choices.length) % choices.length;
  choices[nextIndex]?.focus();
}

function renderCoverMenu() {
  if (!els.noteCoverMenu) return;
  const appearance = currentAppearance();
  const selectedGradient = appearance.cover.type === "gradient" ? appearance.cover.value : "";
  const selectedColor = appearance.cover.type === "color" ? appearance.cover.value : (state.ui.coverColorDraft || COVER_PRESETS.color.value);
  const gradientButtons = COVER_GRADIENTS.map((gradient) => `
    <button class="cover-gradient-choice${gradient.id === selectedGradient ? " is-selected" : ""}" type="button" role="menuitemradio" aria-checked="${gradient.id === selectedGradient ? "true" : "false"}" data-cover-gradient="${escapeHtml(gradient.id)}">
      <span class="cover-gradient-swatch" style="background: ${escapeHtml(gradient.css)}"></span>
      <span>${escapeHtml(gradient.label)}</span>
    </button>
  `).join("");
  els.noteCoverMenu.innerHTML = `
    <div class="appearance-popover-header">
      <strong>Capa</strong>
      <span>Escolha uma aparência</span>
    </div>
    <div class="appearance-section">
      <span class="appearance-section-label">Gradientes</span>
      <div class="cover-gradient-grid">${gradientButtons}</div>
    </div>
    <div class="appearance-section">
      <span class="appearance-section-label">Cor</span>
      <div class="cover-color-row">
        <label class="cover-color-preview" style="background: ${escapeHtml(selectedColor)}">
          <input id="cover-color-input" type="color" value="${escapeHtml(selectedColor)}" aria-label="Selecionar cor da capa">
        </label>
        <input id="cover-hex-input" class="cover-hex-input" type="text" value="${escapeHtml(selectedColor)}" maxlength="7" aria-label="Cor HEX da capa">
        <button class="secondary-button cover-color-apply" type="button" data-cover-color-apply>Aplicar</button>
      </div>
      <p id="cover-color-error" class="appearance-error hidden">Use uma cor no formato #RGB ou #RRGGBB.</p>
    </div>
    <div class="appearance-section">
      <button class="appearance-menu-action" type="button" role="menuitem" data-cover-action="image">
        <i class="ph ph-image" aria-hidden="true"></i>
        <span>Escolher imagem do TCloud</span>
      </button>
    </div>
    <button class="appearance-danger-action" type="button" role="menuitem" data-cover-action="none">
      <i class="ph ph-trash" aria-hidden="true"></i>
      <span>Remover capa</span>
    </button>
  `;
}

function updateCurrentProperties(nextProperties) {
  if (!state.currentNote) return;
  state.currentNote.properties = { ...(nextProperties || {}) };
}

async function setAppearancePatch(patch, toastMessage = "Aparência atualizada.") {
  if (!state.currentNote || state.currentNote.deleted_at) return;
  const nextAppearance = normalizeAppearance({ ...currentAppearance(), ...patch });
  const nextProperties = {
    ...(state.currentNote.properties || {}),
    [APPEARANCE_PROPERTY_KEY]: nextAppearance,
  };
  updateCurrentProperties(nextProperties);
  state.currentNote.cover = nextAppearance.cover;
  state.currentNote.icon = nextAppearance.icon;
  renderAppearance();
  upsertNoteSummary(state.currentNote);
  renderNotesList();
  markDirty("meta");
  await saveCurrentNote({ force: true });
  showToast(toastMessage, "success");
}

function positionFloatingElement(element, x, y, { width = 0, margin = 10 } = {}) {
  if (!element) return;
  element.style.position = "fixed";
  if (width) element.style.width = `${Math.min(width, window.innerWidth - (margin * 2))}px`;
  const rect = element.getBoundingClientRect();
  const menuWidth = rect.width || width || 240;
  const menuHeight = rect.height || 180;
  const left = clamp(Number(x) || margin, margin, Math.max(margin, window.innerWidth - menuWidth - margin));
  const top = clamp(Number(y) || margin, margin, Math.max(margin, window.innerHeight - menuHeight - margin));
  element.style.left = `${left}px`;
  element.style.right = "auto";
  element.style.top = `${top}px`;
  const keepInViewport = () => {
    if (!element.isConnected || element.classList.contains("hidden")) return;
    const edgeMargin = margin + 4;
    const rectNow = element.getBoundingClientRect();
    if (rectNow.right > window.innerWidth - edgeMargin) {
      element.style.left = `${Math.max(edgeMargin, window.innerWidth - rectNow.width - edgeMargin)}px`;
    }
    if (rectNow.bottom > window.innerHeight - edgeMargin) {
      element.style.top = `${Math.max(edgeMargin, window.innerHeight - rectNow.height - edgeMargin)}px`;
    }
  };
  keepInViewport();
  requestAnimationFrame(keepInViewport);
  setTimeout(keepInViewport, 80);
}

function positionAnchoredElement(element, anchor, { align = "start", gap = 8, width = 0 } = {}) {
  if (!element || !anchor) return;
  element.classList.remove("hidden");
  element.style.position = "fixed";
  element.style.left = "0";
  element.style.right = "auto";
  element.style.top = "0";
  if (width) element.style.width = `${Math.min(width, window.innerWidth - 20)}px`;
  const anchorRect = anchor.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const menuWidth = rect.width || width || 240;
  const menuHeight = rect.height || 180;
  const rawLeft = align === "end" ? anchorRect.right - menuWidth : anchorRect.left;
  const left = clamp(rawLeft, 10, Math.max(10, window.innerWidth - menuWidth - 10));
  const belowTop = anchorRect.bottom + gap;
  const aboveTop = anchorRect.top - menuHeight - gap;
  const top = belowTop + menuHeight > window.innerHeight - 10 && aboveTop >= 10
    ? aboveTop
    : clamp(belowTop, 10, Math.max(10, window.innerHeight - menuHeight - 10));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

function positionAppearancePopover(element, anchor, { align = "start", width = 0 } = {}) {
  positionAnchoredElement(element, anchor, { align, width });
  const titleRect = els.titleInput?.getBoundingClientRect();
  const rect = element?.getBoundingClientRect();
  if (!titleRect || !rect) return;
  const overlapsTitle = !(rect.right < titleRect.left || rect.left > titleRect.right || rect.bottom < titleRect.top || rect.top > titleRect.bottom);
  if (!overlapsTitle) return;
  const top = clamp(titleRect.bottom + 10, 10, Math.max(10, window.innerHeight - rect.height - 10));
  element.style.top = `${top}px`;
}

function closeCoverMenu() {
  els.noteCoverMenu?.classList.add("hidden");
  if (els.noteCoverMenu) {
    els.noteCoverMenu.style.position = "";
    els.noteCoverMenu.style.left = "";
    els.noteCoverMenu.style.right = "";
    els.noteCoverMenu.style.top = "";
  }
  els.noteCoverButton?.setAttribute("aria-expanded", "false");
  els.noteCoverButton?.classList.remove("is-active");
}

function closeIconMenu() {
  els.noteIconMenu?.classList.add("hidden");
  els.noteIconButton?.setAttribute("aria-expanded", "false");
  els.noteIconButton?.classList.remove("is-active");
}

function closeTransientOverlays() {
  state.editor?.hideInlineToolbar?.("transient-overlay");
  closeIconMenu();
  closeCoverMenu();
  closeSlashMenu();
  hideAllContextMenus();
  window.TCloudApp?.closeWindowMenus?.();
}

function openCoverMenuAt(x, y) {
  if (!els.noteCoverMenu || !state.currentNote || state.currentNote.deleted_at) return;
  closeIconMenu();
  renderCoverMenu();
  els.noteCoverMenu.classList.remove("hidden");
  els.noteCoverButton?.setAttribute("aria-expanded", "true");
  els.noteCoverButton?.classList.add("is-active");
  positionFloatingElement(els.noteCoverMenu, x, y, { width: 340 });
}

function openCoverMenuFromButton() {
  if (!els.noteCoverMenu || !els.noteCoverButton || !state.currentNote || state.currentNote.deleted_at) return;
  closeIconMenu();
  renderCoverMenu();
  positionAppearancePopover(els.noteCoverMenu, els.noteCoverButton, { align: "start", width: 340 });
  els.noteCoverButton.setAttribute("aria-expanded", "true");
  els.noteCoverButton.classList.add("is-active");
}

function openIconMenuFromButton() {
  if (!els.noteIconMenu || !els.noteIconButton || !state.currentNote || state.currentNote.deleted_at) return;
  closeCoverMenu();
  state.ui.iconQuery = "";
  renderIconMenu();
  positionAppearancePopover(els.noteIconMenu, els.noteIconButton, { align: "start", width: 340 });
  els.noteIconButton.setAttribute("aria-expanded", "true");
  els.noteIconButton.classList.add("is-active");
  window.setTimeout(() => els.noteIconMenu?.querySelector("#note-icon-search")?.focus(), 0);
}

function noteStateLabels(note) {
  const labels = [];
  if (note?.favorite) labels.push("Favorita");
  if (note?.archived) labels.push("Arquivada");
  if (note?.deleted_at) labels.push("Na lixeira");
  return labels;
}

function stripMarkdownPreview(value) {
  return String(value || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+\[(?: |x)\]\s+/gim, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/`{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanLegacyExcerpt(value) {
  return String(value || "")
    .replace(/\b\d{12,}\b/g, " ")
    .replace(/\b\d+\.\d+\.\d+\b/g, " ")
    .replace(/\b(?:paragraph|header|list|todo|quote|codeBlock|divider|tcloudFile|tcloudImage|tcloudVideo|tcloudAudio|tcloudPdf|tcloudFolder)\b/gi, " ")
    .replace(/\b[a-f0-9]{8,}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function notePreviewText(note) {
  const blocks = Array.isArray(note?.content?.blocks) ? note.content.blocks : [];
  const fromContent = stripMarkdownPreview(blocksToMarkdownPreview(blocks));
  if (fromContent) return fromContent;
  const fallback = cleanLegacyExcerpt(note?.excerpt || "");
  return fallback || "Nota vazia";
}

function extractAttachmentsFromContent(content) {
  const blocks = Array.isArray(content?.blocks) ? content.blocks : [];
  const seen = new Set();
  const attachments = [];
  blocks.forEach((block) => {
    const type = String(block?.type || "");
    if (!type.startsWith("tcloud")) return;
    const data = block?.data && typeof block.data === "object" ? block.data : {};
    const path = String(data.path || "").trim();
    if (!path) return;
    const kind = String(data.kind || "").trim().toLowerCase() || "file";
    const key = `${kind}:${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push({
      path,
      name: String(data.name || "").trim(),
      mime: String(data.mime || "").trim(),
      size: Number(data.size || 0) || 0,
      kind,
    });
  });
  return attachments;
}

function attachmentKey(attachment) {
  const path = String(attachment?.path || "").trim();
  if (!path) return "";
  const kind = String(attachment?.kind || "file").trim().toLowerCase() || "file";
  return `${kind}:${path}`;
}

function removedAttachments(previousContent, nextContent) {
  const previous = extractAttachmentsFromContent(previousContent);
  const nextKeys = new Set(extractAttachmentsFromContent(nextContent).map(attachmentKey));
  return previous.filter((attachment) => {
    const key = attachmentKey(attachment);
    return key && !nextKeys.has(key);
  });
}

async function deleteRemovedAttachments(attachments) {
  const targets = Array.isArray(attachments) ? attachments.filter((attachment) => attachment?.path) : [];
  if (!targets.length) return;
  await Promise.all(targets.map((attachment) => state.api.deleteFile(attachment.path)));
}

function sanitizeContentForSave(content) {
  const normalized = normalizeEditorData(content);
  const filteredBlocks = (Array.isArray(normalized.blocks) ? normalized.blocks : []).filter((block) => {
    const type = String(block?.type || "");
    if (!type.startsWith("tcloud")) return true;
    const path = String(block?.data?.path || "").trim();
    return Boolean(path);
  });
  return {
    ...normalized,
    blocks: filteredBlocks.length ? filteredBlocks : [buildBlock("paragraph", { text: "" })],
  };
}

async function syncEditorAttachmentsPreview() {
  if (!state.editor || !state.currentNote) return;
  try {
    const content = sanitizeContentForSave(await state.editor.save());
    state.attachments = extractAttachmentsFromContent(content);
    if (state.currentNote) state.currentNote.attachments = state.attachments;
    renderHeaderMeta();
  } catch (error) {
    console.warn("Falha ao sincronizar anexos locais", error);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function currentQuery() {
  return els.searchInput.value.trim();
}

function currentDeletedFilter() {
  return state.filters.view === "trash" ? "only" : "active";
}

function currentFavoriteFilter() {
  return state.filters.view === "favorites";
}

function currentArchivedFilter() {
  if (state.filters.view === "archived") return "only";
  if (state.filters.view === "trash") return "all";
  return "exclude";
}

function listSummaryText() {
  const pieces = [];
  if (state.filters.view === "favorites") pieces.push("Favoritas");
  else if (state.filters.view === "recent") pieces.push("Recentes");
  else if (state.filters.view === "archived") pieces.push("Arquivadas");
  else if (state.filters.view === "trash") pieces.push("Lixeira");
  else if (state.selectedFolderId) pieces.push(currentFolderLabel());
  else pieces.push("Minhas Notas");

  if (state.filters.tag) pieces.push(`#${state.filters.tag}`);
  const count = state.notes.length;
  const countLabel = count === 1 ? "1 nota" : `${count} notas`;
  if (state.lastLoadedQuery) {
    return `${pieces.join(" • ")} • ${countLabel} na busca`;
  }
  return `${pieces.join(" • ")} • ${countLabel}`;
}

function formatAbsoluteDate(isoValue) {
  if (!isoValue) return "Agora";
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "Agora";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function formatRelativeElapsed(timestamp) {
  if (!timestamp) return "Salvo agora";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "Salvo agora";
  if (seconds < 60) return `Salvo há ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Salvo há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  return `Salvo há ${hours}h`;
}

function setSaveState(mode, extra = {}) {
  state.saveState = {
    mode,
    at: extra.at || state.saveState.at || 0,
    error: extra.error || "",
  };
  renderSaveStatus();
}

function currentSaveStatusText() {
  if (state.saveState.mode === "saving") return "Salvando...";
  if (state.saveState.mode === "pending") return "Alterações pendentes";
  if (state.saveState.mode === "error") return "Erro ao salvar";
  if (state.saveState.mode === "saved") return formatRelativeElapsed(state.saveState.at);
  return "Pronto";
}

function hasShellWindowActions() {
  return window.parent !== window && typeof window.TCloudApp?.setWindowActions === "function";
}

function currentChromeMode() {
  return hasShellWindowActions() ? "shell" : "standalone";
}

function findNoteById(noteId) {
  return state.notes.find((note) => note.id === noteId)
    || state.tree.notes.find((note) => note.id === noteId)
    || state.tree.favorites.find((note) => note.id === noteId)
    || state.tree.archived.find((note) => note.id === noteId)
    || state.tree.trash.find((note) => note.id === noteId)
    || (state.currentNote?.id === noteId ? state.currentNote : null);
}

function normalizeFolderId(value) {
  return String(value || "").trim();
}

function findFolderById(folderId) {
  const safeId = normalizeFolderId(folderId);
  if (!safeId) return null;
  return state.folders.find((folder) => folder.id === safeId) || null;
}

function folderPath(folderId) {
  const path = [];
  const visited = new Set();
  let current = findFolderById(folderId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current);
    current = findFolderById(current.parent_id);
  }
  return path;
}

function currentFolderLabel(folderId = state.selectedFolderId) {
  const path = folderPath(folderId);
  return path.length ? path.map((folder) => folder.name).join(" / ") : "Minhas notas";
}

function folderTargetForCreation(folderId = state.selectedFolderId) {
  const safeFolderId = normalizeFolderId(folderId);
  return state.filters.view === "active" && safeFolderId ? safeFolderId : "";
}

function persistSidebarState() {
  saveSidebarUiState({
    expandedFolderIds: state.expandedFolderIds,
    sidebarCollapsed: state.ui.sidebarCollapsed,
    selectedFolderId: state.selectedFolderId,
  });
}

function setSelectedFolder(folderId = "") {
  closeTransientOverlays();
  state.selectedFolderId = normalizeFolderId(folderId);
  if (state.selectedFolderId) state.expandedFolderIds.add(state.selectedFolderId);
  persistSidebarState();
  state.selectedNoteIds.clear();
  state.currentNoteId = "";
  setCurrentNote(null);
  setEditorVisibility(false);
  loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
}

function renderBreadcrumb() {
  if (!els.noteBreadcrumb) return;
  const noteFolderId = normalizeFolderId(state.currentNote?.folder_id || state.selectedFolderId);
  const path = folderPath(noteFolderId);
  const pieces = [
    { label: "Minhas notas", folderId: "" },
    ...path.map((folder) => ({ label: folder.name || "Nova pasta", folderId: folder.id })),
  ];
  if (state.currentNote?.id) {
    pieces.push({
      label: state.currentNote.title || "Sem título",
      noteId: state.currentNote.id,
      current: true,
    });
  }
  els.noteBreadcrumb.innerHTML = pieces.map((piece, index) => {
    const separator = index ? '<span class="breadcrumb-separator" aria-hidden="true">/</span>' : "";
    const label = escapeHtml(piece.label || "Sem título");
    if (piece.current) {
      return `${separator}<span class="breadcrumb-current" title="${label}" aria-current="page">${label}</span>`;
    }
    return `${separator}<button class="breadcrumb-link" type="button" data-folder-id="${escapeHtml(piece.folderId || "")}" title="${label}">${label}</button>`;
  }).join("");
  els.noteBreadcrumb.querySelectorAll("[data-folder-id]").forEach((button) => {
    button.addEventListener("click", () => setSelectedFolder(button.dataset.folderId || ""));
  });
}

function currentMenuContext(note, extra = {}) {
  return getNoteContext(note, {
    view: state.filters.view,
    notes: state.notes,
    selectedNoteIds: state.selectedNoteIds,
    compactWindow: state.ui.compactWindow,
    folders: state.folders,
    selectedFolderId: state.selectedFolderId,
    ...extra,
  });
}

function publishWindowActions() {
  if (!hasShellWindowActions()) return;

  const selectedCount = state.selectedNoteIds?.size || 0;
  const isCompactWindow = Boolean(state.ui.compactWindow);
  if (selectedCount > 1) {
    const actions = [
      {
        id: "sidebar.toggle",
        label: "Sidebar",
        icon: "ph-sidebar",
        pressed: !state.ui.sidebarCollapsed,
      },
      ...buildBulkSelectionActions(currentMenuContext(null, { compactWindow: isCompactWindow })),
    ];

    window.TCloudApp?.setWindowActions?.({
      statusText: isCompactWindow ? `${selectedCount} selecionadas` : `${selectedCount} notas selecionadas`,
      actions,
    });
    return;
  }

  const hasNote = Boolean(state.currentNote);
  const noteContext = currentMenuContext(state.currentNote);
  const trashed = noteContext.noteTrashed;
  const directActionIds = new Set(trashed ? ["note.restore"] : ["note.export", "note.share"]);
  const moreItems = buildEditorMoreActions(state.currentNote, noteContext)
    .filter((action) => !directActionIds.has(action.id));
  const actions = [
    {
      id: "sidebar.toggle",
      label: "Sidebar",
      icon: "ph-sidebar",
      pressed: !state.ui.sidebarCollapsed,
    },
  ];
  if (hasNote && trashed) {
    actions.push({
      id: "note.restore",
      label: "Restaurar",
      icon: "ph-arrow-counter-clockwise",
      variant: "primary",
    });
  } else if (hasNote) {
    actions.push(
      {
        id: "note.export",
        label: "Exportar",
        icon: "ph-export",
        variant: "primary",
      },
      {
        id: "note.share",
        label: "Compartilhar",
        icon: "ph-share-network",
      },
    );
  }
  if (moreItems.length) {
    actions.push({
      id: "more",
      label: "Mais",
      icon: "ph-dots-three",
      menuItems: moreItems,
    });
  }
  window.TCloudApp?.setWindowActions?.({
    statusText: currentSaveStatusText(),
    actions,
  });
}

function renderSaveStatus() {
  els.saveStatus?.classList.remove("is-error", "is-success");
  const statusText = currentSaveStatusText();
  if (state.saveState.mode === "saving") {
    if (els.saveStatus) els.saveStatus.textContent = statusText;
    publishWindowActions();
    return;
  }
  if (state.saveState.mode === "pending") {
    if (els.saveStatus) els.saveStatus.textContent = statusText;
    publishWindowActions();
    return;
  }
  if (state.saveState.mode === "error") {
    if (els.saveStatus) {
      els.saveStatus.textContent = statusText;
      els.saveStatus.classList.add("is-error");
    }
    publishWindowActions();
    return;
  }
  if (state.saveState.mode === "saved") {
    if (els.saveStatus) {
      els.saveStatus.textContent = statusText;
      els.saveStatus.classList.add("is-success");
    }
    publishWindowActions();
    return;
  }
  if (els.saveStatus) els.saveStatus.textContent = statusText;
  publishWindowActions();
}

function tickSaveStatus() {
  if (state.saveState.mode === "saved") renderSaveStatus();
}

function applyLayoutState() {
  state.ui.chromeMode = currentChromeMode();
  document.documentElement.dataset.tcloudChrome = state.ui.chromeMode;
  els.app?.classList.toggle("is-shell-hosted", state.ui.chromeMode === "shell");
  els.app?.classList.toggle("is-standalone", state.ui.chromeMode === "standalone");
  els.app?.classList.toggle("sidebar-collapsed", Boolean(state.ui.sidebarCollapsed));
  els.app?.classList.toggle("is-compact-window", Boolean(state.ui.compactWindow));
  els.app?.classList.toggle("is-mobile-sidebar-drawer", Boolean(state.ui.mobileSidebarDrawer));
  const drawerOpen = Boolean(state.ui.mobileSidebarDrawer && !state.ui.sidebarCollapsed);
  els.app?.classList.toggle("has-sidebar-drawer-open", drawerOpen);
  els.sidebarBackdrop?.classList.toggle("hidden", !drawerOpen);
  els.sidebarBackdrop?.setAttribute("aria-hidden", drawerOpen ? "false" : "true");
  const shouldShowRestore = Boolean(state.ui.sidebarCollapsed);
  if (!shouldShowRestore && document.activeElement === els.sidebarOpenButton) {
    els.sidebarOpenButton.blur();
  }
  els.sidebarOpenButton?.classList.toggle("hidden", !shouldShowRestore);
  els.sidebarOpenButton?.setAttribute("aria-hidden", shouldShowRestore ? "false" : "true");
  els.sidebarOpenButton?.setAttribute("aria-expanded", state.ui.sidebarCollapsed ? "false" : "true");
  els.sidebarOpenButton?.setAttribute("title", state.ui.compactWindow ? "Mostrar sidebar" : "Reabrir sidebar");
  els.sidebarToggleButton?.setAttribute("aria-expanded", state.ui.sidebarCollapsed ? "false" : "true");
  publishWindowActions();
}

function setSidebarCollapsed(collapsed) {
  state.ui.sidebarCollapsed = Boolean(collapsed);
  applyLayoutState();
  persistSidebarState();
}

function updateCompactWindowMode(width) {
  const measuredWidth = Number(width || 0);
  const nextCompact = measuredWidth > 0 && measuredWidth < 900;
  const nextMobileDrawer = measuredWidth > 0 && measuredWidth < 900;
  if (state.ui.compactWindow === nextCompact && state.ui.mobileSidebarDrawer === nextMobileDrawer) return;
  state.ui.compactWindow = nextCompact;
  state.ui.mobileSidebarDrawer = nextMobileDrawer;
  if (nextCompact && !state.ui.sidebarCollapsed) {
    state.ui.sidebarCollapsed = true;
  }
  applyLayoutState();
}

function setupCompactWindowObserver() {
  if (!els.app) return;
  if (typeof ResizeObserver === "undefined") {
    updateCompactWindowMode(els.app.getBoundingClientRect().width || window.innerWidth);
    window.addEventListener("resize", () => {
      updateCompactWindowMode(els.app.getBoundingClientRect().width || window.innerWidth);
    });
    return;
  }
  state.compactWindowObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect?.width || els.app.getBoundingClientRect().width;
    updateCompactWindowMode(width);
  });
  state.compactWindowObserver.observe(els.app);
}

function noteTagsLabel(note) {
  const tags = Array.isArray(note?.tags) ? note.tags : [];
  return tags.length ? tags.map((tag) => `#${tag}`).join(" ") : "Sem tags";
}

function renderHeaderMeta() {
  if (!state.currentNote) {
    els.noteMeta.textContent = "Nenhuma nota selecionada";
    renderBreadcrumb();
    return;
  }
  const pieces = [`v${state.currentNote.version || 1}`];
  const folderLabel = currentFolderLabel(state.currentNote.folder_id);
  if (folderLabel) pieces.push(folderLabel);
  if (!Array.isArray(state.currentNote.tags) || !state.currentNote.tags.length) pieces.push("Sem tags");
  if (state.currentNote.deleted_at) pieces.push("Na lixeira");
  if (state.currentNote.archived) pieces.push("Arquivada");
  if (state.currentNote.favorite) pieces.push("Favorita");
  els.noteMeta.textContent = pieces.join(" • ");
  renderBreadcrumb();
}

function renderEmptyState() {
  if (state.filters.view === "trash") {
    els.emptyEyebrow.textContent = "Lixeira";
    els.emptyTitle.textContent = "Notas excluídas aparecem aqui";
    els.emptyDescription.innerHTML = "Quando você excluir uma nota, ela vai para a lixeira e poderá ser restaurada depois.";
    els.emptyTemplateGrid.classList.add("hidden");
    return;
  }
  if (state.filters.view === "archived") {
    els.emptyEyebrow.textContent = "Arquivo";
    els.emptyTitle.textContent = "Notas arquivadas ficam fora do fluxo principal";
    els.emptyDescription.innerHTML = "Use esta area para revisar notas arquivadas e desarquivar quando quiser voltar a trabalhar nelas.";
    els.emptyTemplateGrid.classList.add("hidden");
    return;
  }
  if (state.filters.view === "favorites") {
    els.emptyEyebrow.textContent = "Favoritas";
    els.emptyTitle.textContent = "Nenhuma nota favorita";
    els.emptyDescription.innerHTML = "Marque uma nota com estrela para ela aparecer aqui.";
    els.emptyTemplateGrid.classList.add("hidden");
    return;
  }
  if (state.filters.view === "recent") {
    els.emptyEyebrow.textContent = "Recentes";
    els.emptyTitle.textContent = "Nenhuma nota recente";
    els.emptyDescription.innerHTML = "As notas editadas recentemente aparecerão aqui.";
    els.emptyTemplateGrid.classList.add("hidden");
    return;
  }
  if (state.selectedFolderId) {
    els.emptyEyebrow.textContent = currentFolderLabel();
    els.emptyTitle.textContent = "Esta pasta está vazia";
    els.emptyDescription.innerHTML = "Crie uma nota aqui ou arraste uma nota para esta pasta.";
    els.emptyTemplateGrid.classList.remove("hidden");
    return;
  }
  els.emptyEyebrow.textContent = "Notas";
  els.emptyTitle.textContent = "Crie sua primeira nota";
  els.emptyDescription.innerHTML = "Comece em branco ou use um template. Escreva, organize com tags e mantenha foco no conteúdo.";
  els.emptyTemplateGrid.classList.remove("hidden");
}

function setEditorVisibility(visible) {
  const readOnly = Boolean(state.currentNote?.deleted_at);
  if (!visible) state.editor?.hideInlineToolbar?.("editor-hidden");
  els.editorPanel.classList.toggle("hidden", !visible);
  els.emptyState.classList.toggle("hidden", visible);
  els.titleInput.disabled = !visible || readOnly;
  els.favoriteButton.disabled = !visible || readOnly;
  if (els.deleteButton) els.deleteButton.disabled = !visible;
  if (els.revisionsButton) els.revisionsButton.disabled = !visible;
  els.tagInput.disabled = !visible || readOnly;
  if (els.restoreNoteButton) els.restoreNoteButton.disabled = !visible;
  if (els.archiveButton) els.archiveButton.disabled = !visible;
  if (els.exportButton) els.exportButton.disabled = !visible;
  if (els.backupButton) els.backupButton.disabled = !visible;
  if (els.noteMoreButton) els.noteMoreButton.disabled = !visible;
  if (!visible) renderEmptyState();
  applyLayoutState();
}

function renderActiveFilterTabs() {
  els.filterAll.classList.toggle("is-active", state.filters.view === "active");
  els.filterFavorites.classList.toggle("is-active", state.filters.view === "favorites");
  els.filterRecent?.classList.toggle("is-active", state.filters.view === "recent");
  els.filterArchived.classList.toggle("is-active", state.filters.view === "archived");
  els.filterTrash.classList.toggle("is-active", state.filters.view === "trash");
  [
    [els.filterAll, "active"],
    [els.filterFavorites, "favorites"],
    [els.filterRecent, "recent"],
    [els.filterArchived, "archived"],
    [els.filterTrash, "trash"],
  ].forEach(([button, view]) => {
    button?.setAttribute("aria-selected", state.filters.view === view ? "true" : "false");
    if (state.filters.view === view) button?.setAttribute("aria-current", "page");
    else button?.removeAttribute("aria-current");
  });

  const counts = {
    active: state.tree.notes?.length || 0,
    favorites: state.tree.favorites?.length || 0,
    recent: state.tree.recent?.length || 0,
    archived: state.tree.archived?.length || 0,
    trash: state.tree.trash?.length || 0,
  };
  [
    [els.filterAll, counts.active],
    [els.filterFavorites, counts.favorites],
    [els.filterRecent, counts.recent],
    [els.filterArchived, counts.archived],
    [els.filterTrash, counts.trash],
  ].forEach(([button, count]) => {
    if (!button) return;
    let badge = button.querySelector("small");
    if (!badge) {
      badge = document.createElement("small");
      button.appendChild(badge);
    }
    badge.textContent = String(count);
  });
}

function renderNoteTags() {
  els.noteTags.innerHTML = "";
  const tags = Array.isArray(state.currentNote?.tags) ? state.currentNote.tags : [];
  tags.forEach((tag) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.innerHTML = `<span>#${escapeHtml(tag)}</span>`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remover tag ${tag}`);
    remove.innerHTML = '<i class="ph ph-x"></i>';
    remove.addEventListener("click", () => removeTag(tag));
    chip.appendChild(remove);
    els.noteTags.appendChild(chip);
  });
}

function handleSidebarNoteClick(event, note) {
  const isCmdOrCtrl = event.metaKey || event.ctrlKey;
  const isShift = event.shiftKey;
  if (isCmdOrCtrl) {
    event.preventDefault();
    toggleNoteSelection(note.id);
    return;
  }
  if (isShift) {
    event.preventDefault();
    selectNoteRange(note.id);
    return;
  }
  state.selectedFolderId = normalizeFolderId(note.folder_id);
  state.selectedNoteIds.clear();
  state.selectedNoteIds.add(note.id);
  state.lastClickedNoteId = note.id;
  persistSidebarState();
  openNote(note.id).then(() => {
    if (window.matchMedia("(max-width: 860px)").matches) setSidebarCollapsed(true);
  }).catch(handleUnexpectedError);
}

function toggleFolderExpanded(folderId) {
  const safeId = normalizeFolderId(folderId);
  if (!safeId) return;
  if (state.expandedFolderIds.has(safeId)) state.expandedFolderIds.delete(safeId);
  else state.expandedFolderIds.add(safeId);
  persistSidebarState();
  renderNotesList();
}

function switchSmartView(view) {
  if (!view) return;
  state.filters.view = view;
  state.selectedFolderId = "";
  loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
}

function renderNotesList() {
  els.notesList.innerHTML = "";
  els.listMeta.textContent = listSummaryText();
  renderActiveFilterTabs();
  renderBreadcrumb();
  renderSidebarTree(els.notesList, state.tree, {
    view: state.filters.view,
    query: state.lastLoadedQuery,
    currentNoteId: state.currentNoteId,
    selectedNoteIds: state.selectedNoteIds,
    selectedFolderId: state.selectedFolderId,
    expandedFolderIds: state.expandedFolderIds,
    onToggleSelection: toggleNoteSelection,
    onNoteClick: handleSidebarNoteClick,
    onNoteContextMenu: openNoteContextMenu,
    onFolderToggle: toggleFolderExpanded,
    onFolderSelect: setSelectedFolder,
    onFolderRename: (folderId) => renameFolder(folderId).catch(handleUnexpectedError),
    onCreateNoteInFolder: (folderId) => createBlankNote(folderId).catch(handleUnexpectedError),
    onFolderContextMenu: openFolderContextMenu,
    onEmptyContextMenu: openSidebarEmptyContextMenu,
    onDropItem: handleSidebarDrop,
    onSmartView: switchSmartView,
  });
}

function renderTemplateGrid(container) {
  container.innerHTML = "";
  TEMPLATES.forEach((template) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "template-card";
    button.innerHTML = `
      <span class="template-card-title">${escapeHtml(template.label)}</span>
      <span class="template-card-desc">${escapeHtml(template.description)}</span>
    `;
    button.addEventListener("click", () => createNoteFromTemplate(template.id).catch(handleUnexpectedError));
    container.appendChild(button);
  });
}

function renderExportPreview() {
  if (!state.currentNote) {
    els.exportPreview.textContent = "Selecione uma nota para habilitar a exportação.";
    return;
  }
  const markdown = blocksToMarkdownPreview(state.currentNote.content?.blocks || []).slice(0, 260);
  els.exportPreview.innerHTML = `
    <strong>${escapeHtml(state.currentNote.title || "Sem título")}</strong><br>
    <span class="export-preview-code">${escapeHtml(markdown || "Nota vazia")}</span>
  `;
}

function setImportStatus(message = "", kind = "info") {
  if (!els.importStatus) return;
  const text = String(message || "").trim();
  els.importStatus.textContent = text;
  els.importStatus.classList.toggle("hidden", !text);
  els.importStatus.dataset.kind = kind;
}

function updateImportFileLabel() {
  if (!els.importFileName || !els.importFileInput) return;
  const file = els.importFileInput.files?.[0];
  els.importFileName.textContent = file
    ? file.name
    : "Arraste ou selecione .txt, .md ou .tcnote.json";
  setImportStatus("");
}

function setCurrentNote(note) {
  state.currentNote = note;
  state.currentNoteId = note?.id || "";
  if (note && !note.deleted_at) {
    state.selectedFolderId = normalizeFolderId(note.folder_id);
    if (state.selectedFolderId) state.expandedFolderIds.add(state.selectedFolderId);
    persistSidebarState();
  }
  state.attachments = Array.isArray(note?.attachments) ? note.attachments : [];
  els.titleInput.value = note?.title || "";
  els.favoriteButton.classList.toggle("is-active", Boolean(note?.favorite));
  els.favoriteButton.setAttribute("aria-pressed", note?.favorite ? "true" : "false");
  els.favoriteButton.innerHTML = note?.favorite ? '<i class="ph-fill ph-star"></i>' : '<i class="ph ph-star"></i>';
  renderAppearance();
  renderNoteTags();
  renderHeaderMeta();
  renderExportPreview();
  const noteContext = currentMenuContext(note);
  const trashed = noteContext.noteTrashed;
  const archived = noteContext.noteArchived;
  els.editorPanel?.classList.toggle("is-trash-note", Boolean(trashed));
  els.editorPanel?.classList.toggle("is-archived-note", Boolean(archived));
  if (els.noteStateBanner) {
    els.noteStateBanner.classList.toggle("hidden", !trashed && !archived);
    els.noteStateBanner.textContent = trashed
      ? "Esta nota está na lixeira. Restaure para voltar a editar."
      : archived
        ? "Nota arquivada."
        : "";
  }

  if (!note) {
    els.deleteButton?.classList.add("hidden");
    els.restoreNoteButton?.classList.add("hidden");
    els.archiveButton?.classList.add("hidden");
    publishWindowActions();
    return;
  }

  els.favoriteButton?.classList.toggle("hidden", trashed);
  els.deleteButton?.classList.toggle("hidden", trashed);
  els.restoreNoteButton?.classList.toggle("hidden", !trashed);
  els.archiveButton?.classList.toggle("hidden", trashed);
  els.exportButton?.classList.toggle("hidden", trashed);
  els.revisionsButton?.classList.toggle("hidden", trashed);
  if (els.archiveButton) {
    els.archiveButton.setAttribute("aria-label", archived ? "Restaurar do arquivo" : "Arquivar");
    els.archiveButton.innerHTML = archived ? '<i class="ph ph-archive-tray"></i>' : '<i class="ph ph-archive"></i>';
  }
  publishWindowActions();
}

async function loadNotes({ preserveSelection = true } = {}) {
  const requestId = ++state.currentListRequestId;

  if (!preserveSelection) {
    state.selectedNoteIds.clear();
    state.lastClickedNoteId = null;
    state.currentOpenNoteRequestId++; // Invalidate pending openNote calls
    updateSelectionUI();
  }

  try {
    const response = await state.api.getTree({
      query: currentQuery(),
      limit: 500,
    });
    if (requestId !== state.currentListRequestId) return;

    state.tree = {
      folders: Array.isArray(response.folders) ? response.folders : [],
      notes: Array.isArray(response.notes) ? response.notes : [],
      favorites: Array.isArray(response.favorites) ? response.favorites : [],
      recent: Array.isArray(response.recent) ? response.recent : [],
      archived: Array.isArray(response.archived) ? response.archived : [],
      trash: Array.isArray(response.trash) ? response.trash : [],
    };
    state.folders = state.tree.folders;
    state.notes = state.filters.view === "favorites"
      ? state.tree.favorites
      : state.filters.view === "recent"
        ? state.tree.recent
      : state.filters.view === "archived"
        ? state.tree.archived
        : state.filters.view === "trash"
          ? state.tree.trash
          : state.selectedFolderId
            ? state.tree.notes.filter((note) => normalizeFolderId(note.folder_id) === state.selectedFolderId)
            : state.tree.notes;
    state.lastLoadedQuery = currentQuery();

    // Keep only selected notes that are still in the loaded notes list
    const currentNoteIds = new Set(state.notes.map((n) => n.id));
    state.selectedNoteIds.forEach((id) => {
      if (!currentNoteIds.has(id)) {
        state.selectedNoteIds.delete(id);
      }
    });

    renderNotesList();

    if (!state.notes.length) {
      state.selectedNoteIds.clear();
      state.currentNoteId = "";
      setCurrentNote(null);
      setEditorVisibility(false);
      updateSelectionUI();
      return;
    }

    if (state.selectedNoteIds.size > 1) {
      updateSelectionUI();
      return;
    }

    // Fallback to single note selection if 0 or 1 notes are selected
    const desiredId = preserveSelection ? (Array.from(state.selectedNoteIds)[0] || state.currentNoteId) : "";
    const nextNote = state.notes.find((note) => note.id === desiredId) || state.notes[0];

    state.selectedNoteIds.clear();
    state.selectedNoteIds.add(nextNote.id);

    if (!state.currentNote || state.currentNote.id !== nextNote.id) {
      if (requestId !== state.currentListRequestId) return;
      await openNote(nextNote.id, { skipPendingSave: true });
    } else {
      if (requestId !== state.currentListRequestId) return;
      setCurrentNote({ ...state.currentNote, ...nextNote });
      updateSelectionUI();
    }
  } catch (error) {
    if (requestId === state.currentListRequestId) {
      handleUnexpectedError(error);
    }
  }
}

function toggleNoteSelection(noteId) {
  if (state.selectedNoteIds.has(noteId)) {
    state.selectedNoteIds.delete(noteId);
  } else {
    state.selectedNoteIds.add(noteId);
    state.lastClickedNoteId = noteId;
  }
  updateSelectionUI();
}

function selectNoteRange(noteId) {
  if (!state.lastClickedNoteId) {
    toggleNoteSelection(noteId);
    return;
  }
  const ids = state.notes.map((n) => n.id);
  const startIdx = ids.indexOf(state.lastClickedNoteId);
  const endIdx = ids.indexOf(noteId);
  if (startIdx === -1 || endIdx === -1) {
    toggleNoteSelection(noteId);
    return;
  }
  const min = Math.min(startIdx, endIdx);
  const max = Math.max(startIdx, endIdx);
  for (let i = min; i <= max; i++) {
    state.selectedNoteIds.add(ids[i]);
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const selectedCount = state.selectedNoteIds.size;
  const useShellActions = hasShellWindowActions();
  
  // 2. Controlar visibilidade do editor e do painel de lote
  if (selectedCount > 1) {
    els.editorPanel.classList.add("hidden");
    els.emptyState.classList.add("hidden");
    els.bulkState.classList.toggle("hidden", useShellActions);

    document.getElementById("bulk-title").textContent = `${selectedCount} notas selecionadas`;
    if (!useShellActions) renderBulkPanelButtons();
  } else {
    els.bulkState.classList.add("hidden");
    if (selectedCount === 1) {
      const singleId = Array.from(state.selectedNoteIds)[0];
      if (state.currentNoteId !== singleId) {
        openNote(singleId).catch(handleUnexpectedError);
      } else {
        setEditorVisibility(true);
      }
    } else {
      state.currentNoteId = "";
      setCurrentNote(null);
      setEditorVisibility(false);
    }
  }

  // 1. Atualizar estilos e checkboxes dos cards
  const cards = els.notesList.querySelectorAll(".note-card");
  cards.forEach((card) => {
    const id = card.dataset.id;
    const isSelected = state.selectedNoteIds.has(id);
    const isActive = (state.currentNoteId === id);
    card.classList.toggle("is-selected", isSelected);
    card.classList.toggle("is-active", isActive);
    const cb = card.querySelector(".note-card-checkbox");
    if (cb) cb.checked = isSelected;
  });

  // 3. Atualizar Window Actions (Menu Auxiliar)
  publishWindowActions();
}

function renderBulkPanelButtons() {
  const favBtn = document.getElementById("bulk-fav-btn");
  const arcBtn = document.getElementById("bulk-arc-btn");
  const delBtn = document.getElementById("bulk-del-btn");
  const rstBtn = document.getElementById("bulk-rst-btn");
  const purgeBtn = document.getElementById("bulk-purge-btn");
  const actionById = new Map(buildBulkSelectionActions(currentMenuContext(null, { compactWindow: false })).map((action) => [action.id, action]));
  const visible = (button, actionId) => button?.classList.toggle("hidden", !actionById.has(actionId));

  visible(favBtn, "bulk-favorite.run");
  visible(arcBtn, "bulk-archive.run");
  visible(delBtn, "bulk-delete.run");
  visible(rstBtn, "bulk-restore.run");
  visible(purgeBtn, "bulk-purge.run");

  const favAction = actionById.get("bulk-favorite.run");
  if (favBtn && favAction) {
    favBtn.querySelector(".label-text").textContent = favAction.label;
    favBtn.querySelector("i").className = favAction.label === "Desfavoritar" ? "ph-fill ph-star" : "ph ph-star";
  }

  const archiveAction = actionById.get("bulk-archive.run");
  if (arcBtn && archiveAction) {
    arcBtn.querySelector(".label-text").textContent = archiveAction.label;
    arcBtn.querySelector("i").className = `ph ${archiveAction.icon}`;
  }
}

async function handleBulkAction(command) {
  const selectedIds = Array.from(state.selectedNoteIds);
  if (!selectedIds.length && command !== "bulk-clear.run") return;

  if (command === "bulk-clear.run") {
    state.selectedNoteIds.clear();
    state.lastClickedNoteId = null;
    state.currentOpenNoteRequestId++; // Invalidate pending openNote calls
    updateSelectionUI();
    return;
  }

  if (command === "bulk-delete.run") {
    askConfirmation({
      eyebrow: "Ação em lote",
      title: "Mover notas para a lixeira?",
      description: `Deseja mover ${selectedIds.length} notas para a lixeira? Elas poderão ser restauradas depois.`,
      acceptLabel: "Mover para lixeira",
      acceptKind: "danger",
      onAccept: async () => {
        setSaveState("saving");
        await Promise.all(selectedIds.map((id) => state.api.remove(id)));
        showToast(`${selectedIds.length} notas enviadas para a lixeira.`, "info");
        state.selectedNoteIds.clear();
        await loadNotes({ preserveSelection: false });
        setSaveState("saved", { at: Date.now() });
      },
    });
    return;
  }

  if (command === "bulk-restore.run") {
    setSaveState("saving");
    await Promise.all(selectedIds.map((id) => state.api.restore(id)));
    showToast(`${selectedIds.length} notas restauradas.`, "success");
    state.selectedNoteIds.clear();
    state.filters.view = "active";
    await loadNotes({ preserveSelection: false });
    setSaveState("saved", { at: Date.now() });
    return;
  }

  if (command === "bulk-purge.run") {
    askConfirmation({
      eyebrow: "Exclusão definitiva",
      title: "Excluir definitivamente?",
      description: `Excluir definitivamente ${selectedIds.length} notas? Esta ação não pode ser desfeita.`,
      acceptLabel: "Excluir definitivamente",
      acceptKind: "danger",
      onAccept: async () => {
        setSaveState("saving");
        const response = await state.api.bulkPurge(selectedIds);
        const deletedCount = Number(response.deleted_count || response.result?.deleted_count || 0);
        const skipped = response.skipped || response.result?.skipped || [];
        if (state.currentNoteId && selectedIds.includes(state.currentNoteId)) {
          state.currentNoteId = "";
          setCurrentNote(null);
        }
        state.selectedNoteIds.clear();
        await loadNotes({ preserveSelection: false });
        showToast(
          skipped.length
            ? `${deletedCount} notas excluídas definitivamente; ${skipped.length} não foram excluídas.`
            : `${deletedCount} notas excluídas definitivamente.`,
          skipped.length ? "info" : "success",
        );
        setSaveState("saved", { at: Date.now() });
      },
    });
    return;
  }

  if (command === "bulk-favorite.run") {
    setSaveState("saving");
    const anyFav = selectedIds.some((id) => {
      const n = state.notes.find((x) => x.id === id);
      return n && n.favorite;
    });
    const targetFav = !anyFav;
    await Promise.all(selectedIds.map((id) => state.api.update(id, { favorite: targetFav })));
    showToast(targetFav ? `${selectedIds.length} notas favoritadas.` : `${selectedIds.length} notas desfavoritadas.`, "success");
    state.selectedNoteIds.clear();
    await loadNotes({ preserveSelection: true });
    setSaveState("saved", { at: Date.now() });
    return;
  }

  if (command === "bulk-archive.run") {
    setSaveState("saving");
    const isArchived = state.filters.view === "archived";
    const targetArchived = !isArchived;
    await Promise.all(selectedIds.map((id) => state.api.update(id, { archived: targetArchived })));
    showToast(targetArchived ? `${selectedIds.length} notas arquivadas.` : `${selectedIds.length} notas desarquivadas.`, "success");
    state.selectedNoteIds.clear();

    if (targetArchived && state.filters.view === "active") {
      await loadNotes({ preserveSelection: false });
    } else if (!targetArchived && state.filters.view === "archived") {
      state.filters.view = "active";
      await loadNotes({ preserveSelection: false });
    } else {
      await loadNotes({ preserveSelection: true });
    }
    setSaveState("saved", { at: Date.now() });
    return;
  }
}

function findTemplate(templateId) {
  return TEMPLATES.find((template) => template.id === templateId) || TEMPLATES[0];
}

async function createNoteFromTemplate(templateId = "blank", folderId = state.selectedFolderId) {
  await flushPendingSave();
  const template = findTemplate(templateId);
  const safeFolderId = normalizeFolderId(folderId);
  setSaveState("saving");
  const response = await state.api.create({ title: template.title, content: template.content, folder_id: safeFolderId || null });
  setSaveState("saved", { at: Date.now() });
  els.searchInput.value = "";
  state.filters.view = "active";
  state.selectedFolderId = safeFolderId;
  if (safeFolderId) state.expandedFolderIds.add(safeFolderId);
  persistSidebarState();
  closeModal();
  await loadNotes({ preserveSelection: false });
  if (response.note?.id) await openNote(response.note.id, { skipPendingSave: true });
  showToast(`Nota criada com template "${template.label}".`, "success");
}

async function createBlankNote(folderId = state.selectedFolderId) {
  await createNoteFromTemplate("blank", folderId);
}

async function duplicateCurrentNote() {
  if (!state.currentNote || state.currentNote.deleted_at) return;
  await flushPendingSave();
  const duplicatedTitle = state.currentNote.title?.trim() ? `${state.currentNote.title} (cópia)` : "Sem título (cópia)";
  setSaveState("saving");
  const created = await state.api.create({
    title: duplicatedTitle,
    content: sanitizeContentForSave(state.currentNote.content),
    properties: { ...(state.currentNote.properties || {}) },
    folder_id: normalizeFolderId(state.currentNote.folder_id) || null,
  });
  const duplicateId = created.note?.id;
  if (!duplicateId) throw new Error("Não foi possível duplicar a nota.");
  await state.api.update(duplicateId, {
    tags: Array.isArray(state.currentNote.tags) ? [...state.currentNote.tags] : [],
    archived: false,
    favorite: false,
    cover: state.currentNote.cover || currentAppearance().cover,
    icon: state.currentNote.icon || currentAppearance().icon,
    properties: { ...(state.currentNote.properties || {}) },
  });
  state.filters.view = "active";
  await loadNotes({ preserveSelection: false });
  await openNote(duplicateId, { skipPendingSave: true });
  setSaveState("saved", { at: Date.now() });
  showToast("Nota duplicada.", "success");
}

async function copyCurrentNoteLink() {
  if (!state.currentNote?.id) return;
  await copyToClipboard(buildCurrentNoteUrl(state.currentNote.id));
  showToast("Link da nota copiado.", "success");
}

function openShareDialog() {
  if (!state.currentNote?.id) return;
  const url = buildCurrentNoteUrl(state.currentNote.id);
  askConfirmation({
    eyebrow: "Compartilhar",
    title: "Link da nota",
    description: url,
    acceptLabel: "Copiar link",
    acceptKind: "primary",
    onAccept: async () => {
      await copyToClipboard(url);
      showToast("Link da nota copiado.", "success");
    },
  });
}

function resolveMoveDestinationRequest(value) {
  const request = state.moveDestinationRequest;
  state.moveDestinationRequest = null;
  if (request?.resolve) request.resolve(value);
}

function chooseFolderDestination({ excludeFolderId = "", title = "Mover para...", description = "Escolha uma pasta ou a raiz." } = {}) {
  const options = buildFolderOptions(state.folders).filter((option) => {
    if (!excludeFolderId) return true;
    if (option.id === excludeFolderId) return false;
    return !isFolderDescendant(excludeFolderId, option.id, state.folders);
  });
  return new Promise((resolve) => {
    state.moveDestinationRequest = { resolve };
    els.moveItemTitle.textContent = title;
    els.moveItemDescription.textContent = description;
    els.moveDestinationList.innerHTML = "";
    options.forEach((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "destination-item";
      button.dataset.folderId = option.id || "";
      button.setAttribute("role", "option");
      button.innerHTML = `
        <i class="ph ${option.id ? "ph-folder-simple" : "ph-house"}" aria-hidden="true"></i>
        <span>${escapeHtml(option.label)}</span>
      `;
      button.addEventListener("click", () => {
        resolveMoveDestinationRequest(option.id || "");
        closeModal();
      });
      els.moveDestinationList.appendChild(button);
    });
    openModal("move-item");
    window.setTimeout(() => els.moveDestinationList.querySelector("button")?.focus(), 0);
  });
}

async function createFolder(parentId = state.selectedFolderId) {
  const safeParentId = normalizeFolderId(parentId);
  const name = await openFolderNameModal({ mode: "create", parentId: safeParentId });
  if (name === null) return;
  try {
    const previousFolderId = state.selectedFolderId;
    const previousNoteId = state.currentNoteId;
    setSaveState("saving");
    const response = await state.api.createFolder({ name, parent_id: safeParentId || null, icon: "folder" });
    if (response.folder?.id) {
      state.filters.view = "active";
      state.expandedFolderIds.add(response.folder.id);
      if (safeParentId) state.expandedFolderIds.add(safeParentId);
      state.selectedFolderId = previousFolderId;
      if (previousNoteId) state.currentNoteId = previousNoteId;
      persistSidebarState();
    }
    await loadNotes({ preserveSelection: true });
    setSaveState("saved", { at: Date.now() });
    showToast("Pasta criada.", "success");
  } catch (error) {
    setSaveState("error", { error: error.message || "Erro ao criar pasta" });
    throw error;
  }
}

async function renameFolder(folderId) {
  const folder = findFolderById(folderId);
  if (!folder) return;
  const name = await openFolderNameModal({ mode: "rename", folder, parentId: folder.parent_id || "" });
  if (name === null) return;
  try {
    setSaveState("saving");
    await state.api.updateFolder(folder.id, { name });
    await loadNotes({ preserveSelection: true });
    setSaveState("saved", { at: Date.now() });
    showToast("Pasta renomeada.", "success");
  } catch (error) {
    setSaveState("error", { error: error.message || "Erro ao renomear pasta" });
    throw error;
  }
}

async function moveFolder(folderId) {
  const folder = findFolderById(folderId);
  if (!folder) return;
  const targetFolderId = await chooseFolderDestination({
    excludeFolderId: folder.id,
    title: `Mover "${folder.name || "Nova pasta"}" para...`,
  });
  if (targetFolderId === null) return;
  setSaveState("saving");
  await state.api.moveItems({ items: [{ type: "folder", id: folder.id }], target_folder_id: targetFolderId || null });
  if (targetFolderId) state.expandedFolderIds.add(targetFolderId);
  persistSidebarState();
  await loadNotes({ preserveSelection: true });
  setSaveState("saved", { at: Date.now() });
  showToast("Pasta movida.", "success");
}

async function deleteFolder(folderId) {
  const folder = findFolderById(folderId);
  if (!folder) return;
  askConfirmation({
    eyebrow: "Pasta",
    title: `Excluir "${folder.name || "Nova pasta"}"?`,
    description: "A pasta e subpastas serão removidas da árvore. As notas internas serão movidas para a raiz.",
    acceptLabel: "Excluir pasta",
    acceptKind: "danger",
    onAccept: async () => {
      setSaveState("saving");
      await state.api.deleteFolder(folder.id, { mode: "move_to_root" });
      if (state.selectedFolderId === folder.id || isFolderDescendant(folder.id, state.selectedFolderId, state.folders)) {
        state.selectedFolderId = "";
      }
      state.expandedFolderIds.delete(folder.id);
      persistSidebarState();
      await loadNotes({ preserveSelection: false });
      setSaveState("saved", { at: Date.now() });
      showToast("Pasta excluída. Notas internas foram movidas para a raiz.", "success");
    },
  });
}

async function moveNoteToFolder(noteId) {
  const note = findNoteById(noteId);
  if (!note || currentMenuContext(note).noteTrashed) return;
  const targetFolderId = await chooseFolderDestination({ title: `Mover "${note.title || "Sem título"}" para...` });
  if (targetFolderId === null) return;
  setSaveState("saving");
  await state.api.moveItems({ items: [{ type: "note", id: note.id }], target_folder_id: targetFolderId || null });
  state.selectedFolderId = targetFolderId || "";
  if (targetFolderId) state.expandedFolderIds.add(targetFolderId);
  persistSidebarState();
  await loadNotes({ preserveSelection: true });
  setSaveState("saved", { at: Date.now() });
  showToast("Nota movida.", "success");
}

async function renameNoteForId(noteId) {
  const note = findNoteById(noteId);
  if (!note || currentMenuContext(note).noteTrashed) return;
  if (state.currentNote?.id === noteId) {
    els.titleInput.focus();
    els.titleInput.select();
    return;
  }
  const title = window.prompt("Renomear nota", note.title || "Sem título");
  if (title === null) return;
  setSaveState("saving");
  await state.api.update(noteId, { title });
  await loadNotes({ preserveSelection: true });
  setSaveState("saved", { at: Date.now() });
}

function expandAllFolders() {
  state.folders.forEach((folder) => state.expandedFolderIds.add(folder.id));
  persistSidebarState();
  renderNotesList();
}

function collapseAllFolders() {
  state.expandedFolderIds.clear();
  persistSidebarState();
  renderNotesList();
}

function commandContext({ note = state.currentNote, folder = null, targetFolderId = folderTargetForCreation() } = {}) {
  return {
    ...currentMenuContext(note),
    note,
    folder,
    targetFolderId,
    actions: {
      openNote: (noteId) => openNote(noteId, { skipPendingSave: false }),
      openNoteInNewTab: (noteId) => {
        if (noteId) window.open(`${window.location.origin}${window.location.pathname}#note=${noteId}`, "_blank");
      },
      renameNote: renameNoteForId,
      duplicateNote: duplicateNoteForId,
      moveNote: moveNoteToFolder,
      toggleFavorite: toggleFavoriteForId,
      toggleArchive: toggleArchiveForId,
      trashNote: deleteNoteForId,
      restoreNote: restoreNoteForId,
      purgeNote: purgeNoteForId,
      copyNoteLink: copyNoteLinkForId,
      openRevisions: openRevisionsForId,
      openInfo: () => openNoteInfo(),
      openExport: () => openImportExportModal().catch(handleUnexpectedError),
      shareNote: () => openShareDialog(),
      createFolder,
      createNote: createBlankNote,
      renameFolder,
      moveFolder,
      deleteFolder,
      expandAll: expandAllFolders,
      collapseAll: collapseAllFolders,
      toggleSidebar: () => setSidebarCollapsed(!state.ui.sidebarCollapsed),
      search: () => {
        els.searchInput.focus();
        els.searchInput.select();
      },
    },
  };
}

function runNotesCommand(commandId, context = {}) {
  return runCommand(commandId, commandContext(context));
}

function openNoteInfo() {
  if (!state.currentNote) return;
  const attachmentCount = Array.isArray(state.currentNote.attachments) ? state.currentNote.attachments.length : state.attachments.length;
  askConfirmation({
    eyebrow: "Informações",
    title: state.currentNote.title || "Sem título",
    description: `Criada: ${formatAbsoluteDate(state.currentNote.created_at)}\nAtualizada: ${formatAbsoluteDate(state.currentNote.updated_at)}\nVersão: v${state.currentNote.version || 1}\nTags: ${(state.currentNote.tags || []).join(", ") || "Sem tags"}\nAnexos: ${attachmentCount}`,
    acceptLabel: "Fechar",
    acceptKind: "primary",
  });
}

async function openNote(noteId, options = {}) {
  if (!noteId) return;
  hideFloatingSearch();
  closeTransientOverlays();
  if (!options.skipPendingSave) await flushPendingSave();

  const requestId = ++state.currentOpenNoteRequestId;

  state.loadingNote = true;
  state.currentNoteId = noteId;

  // Clear multi-selection state and ensure only the opened note is in selectedNoteIds
  state.selectedNoteIds.clear();
  state.selectedNoteIds.add(noteId);
  state.lastClickedNoteId = noteId;

  renderNotesList();
  setSaveState("saving");

  try {
    const response = await state.api.get(noteId, { includeDeleted: currentDeletedFilter() === "only" });
    if (requestId !== state.currentOpenNoteRequestId) return;

    state.dirtyTitle = false;
    state.dirtyContent = false;
    state.dirtyMeta = false;
    setCurrentNote(response.note);
    setEditorVisibility(true);
    await state.editor.render(sanitizeContentForSave(response.note.content), { isNewNote: true });
    if (requestId !== state.currentOpenNoteRequestId) return;

    syncNoteHash(response.note.id);
    document.querySelector(".editor-shell")?.scrollTo({ top: 0, left: 0 });
    state.loadingNote = false;

    updateSelectionUI();

    renderNotesList();
    setSaveState("saved", { at: Date.now() });
  } catch (error) {
    if (requestId === state.currentOpenNoteRequestId) {
      state.loadingNote = false;
      handleUnexpectedError(error);
    }
  }
}

function scheduleAutosave() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => saveCurrentNote().catch(handleUnexpectedError), AUTOSAVE_DELAY_MS);
}

function markDirty(kind) {
  if (!state.currentNote || state.loadingNote || state.currentNote.deleted_at) return;
  if (kind === "title") state.dirtyTitle = true;
  if (kind === "content") state.dirtyContent = true;
  if (kind === "meta") state.dirtyMeta = true;
  setSaveState("pending");
  scheduleAutosave();
}

function noteTagsForSave() {
  return Array.isArray(state.currentNote?.tags) ? state.currentNote.tags : [];
}

async function saveCurrentNote({ force = false } = {}) {
  if (!state.currentNote || state.loadingNote || state.isSaving || state.currentNote.deleted_at) return;
  if (!force && !state.dirtyTitle && !state.dirtyContent && !state.dirtyMeta) return;

  state.isSaving = true;
  window.clearTimeout(state.saveTimer);
  setSaveState("saving");

  // Snapshot dirty flags before async work begins.
  // New changes may set these flags again during the await calls below.
  const wasDirtyTitle = state.dirtyTitle;
  const wasDirtyContent = state.dirtyContent;
  const wasDirtyMeta = state.dirtyMeta;

  try {
    let response = null;
    let attachmentsToDelete = [];
    if ((force || wasDirtyContent) && !wasDirtyTitle && !wasDirtyMeta) {
      const nextContent = sanitizeContentForSave(await state.editor.save());
      attachmentsToDelete = removedAttachments(state.currentNote.content, nextContent);
      state.attachments = extractAttachmentsFromContent(nextContent);
      response = await state.api.updateContent(state.currentNote.id, nextContent);
    } else {
      const payload = {};
      if (force || wasDirtyTitle) payload.title = els.titleInput.value;
      if (force || wasDirtyMeta) {
        payload.favorite = Boolean(state.currentNote.favorite);
        payload.archived = Boolean(state.currentNote.archived);
        payload.cover = state.currentNote.cover || { type: "none", value: "" };
        payload.icon = state.currentNote.icon || { type: "none", value: "" };
        payload.tags = noteTagsForSave();
        payload.properties = { ...(state.currentNote.properties || {}) };
      }
      if (force || wasDirtyContent) {
        payload.content = sanitizeContentForSave(await state.editor.save());
        attachmentsToDelete = removedAttachments(state.currentNote.content, payload.content);
        state.attachments = extractAttachmentsFromContent(payload.content);
      }
      response = await state.api.update(state.currentNote.id, payload);
    }
    await deleteRemovedAttachments(attachmentsToDelete);
    // Only clear the flags that were captured at save start.
    // If markDirty was called during the async save, the flag will still be true.
    if (wasDirtyTitle) state.dirtyTitle = false;
    if (wasDirtyContent) state.dirtyContent = false;
    if (wasDirtyMeta) state.dirtyMeta = false;
    setCurrentNote(response.note);
    upsertNoteSummary(response.note);
    renderNotesList();
    if (response.saved_content || force || state.saveState.mode === "saving") {
      setSaveState("saved", { at: Date.now() });
    }
    // If new changes arrived during save, re-schedule autosave.
    if (state.dirtyTitle || state.dirtyContent || state.dirtyMeta) {
      scheduleAutosave();
    }
  } catch (error) {
    // Restore dirty flags on error so changes are not lost.
    if (wasDirtyTitle) state.dirtyTitle = true;
    if (wasDirtyContent) state.dirtyContent = true;
    if (wasDirtyMeta) state.dirtyMeta = true;
    setSaveState("error", { error: error.message || "Erro ao salvar" });
    throw error;
  } finally {
    state.isSaving = false;
  }
}

function upsertNoteSummary(note) {
  if (!note?.id) return;
  const summary = {
    id: note.id,
    title: note.title,
    excerpt: note.excerpt,
    version: note.version,
    favorite: note.favorite,
    archived: note.archived,
    folder_id: note.folder_id,
    previous_folder_id: note.previous_folder_id,
    position: note.position,
    cover: note.cover,
    icon: note.icon,
    tags: note.tags,
    properties: note.properties,
    outgoing_links: note.outgoing_links,
    backlinks: note.backlinks,
    attachments: note.attachments,
    created_at: note.created_at,
    updated_at: note.updated_at,
    deleted_at: note.deleted_at,
  };
  const index = state.notes.findIndex((item) => item.id === note.id);
  if (index >= 0) state.notes.splice(index, 1, summary);
  else state.notes.unshift(summary);
  state.notes.sort((left, right) => new Date(right.updated_at || 0) - new Date(left.updated_at || 0));
}

async function flushPendingSave() {
  if (state.dirtyTitle || state.dirtyContent || state.dirtyMeta) {
    await saveCurrentNote({ force: true });
  }
}

async function deleteCurrentNote() {
  if (!state.currentNote) return;
  askConfirmation({
    eyebrow: "Lixeira",
    title: "Mover nota para a lixeira?",
    description: `A nota "${state.currentNote.title || "Sem título"}" poderá ser restaurada depois.`,
    acceptLabel: "Mover para lixeira",
    acceptKind: "danger",
    onAccept: async () => {
      await flushPendingSave();
      setSaveState("saving");
      const deletedNoteId = state.currentNote.id;
      await state.api.remove(deletedNoteId);
      showToast("Nota enviada para a lixeira.", "info");
      state.filters.view = "trash";
      state.currentNoteId = deletedNoteId;
      await loadNotes({ preserveSelection: true });
      setSaveState("saved", { at: Date.now() });
    },
  });
}

async function restoreCurrentNote() {
  if (!state.currentNote) return;
  setSaveState("saving");
  const response = await state.api.restore(state.currentNote.id);
  showToast("Nota restaurada da lixeira.", "success");
  state.filters.view = "active";
  await loadNotes({ preserveSelection: false });
  if (response.note?.id) await openNote(response.note.id, { skipPendingSave: true });
  setSaveState("saved", { at: Date.now() });
}

async function purgeCurrentNote() {
  if (!state.currentNote?.deleted_at) return;
  askConfirmation({
    eyebrow: "Exclusão definitiva",
    title: "Excluir definitivamente esta nota?",
    description: "Excluir definitivamente esta nota? Esta ação não pode ser desfeita.",
    acceptLabel: "Excluir definitivamente",
    acceptKind: "danger",
    onAccept: async () => {
      setSaveState("saving");
      const purgedNoteId = state.currentNote.id;
      await state.api.purge(purgedNoteId);
      showToast("Nota excluída definitivamente.", "success");
      state.selectedNoteIds.delete(purgedNoteId);
      state.currentNoteId = "";
      setCurrentNote(null);
      await loadNotes({ preserveSelection: false });
      setSaveState("saved", { at: Date.now() });
    },
  });
}

function normalizeTagValue(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

function addTagFromInput() {
  if (!state.currentNote) return;
  const tag = normalizeTagValue(els.tagInput.value);
  els.tagInput.value = "";
  if (!tag) return;
  const existing = new Set((state.currentNote.tags || []).map((item) => item.toLowerCase()));
  if (existing.has(tag.toLowerCase())) return;
  state.currentNote.tags = [...(state.currentNote.tags || []), tag].slice(0, 12);
  renderNoteTags();
  renderHeaderMeta();
  markDirty("meta");
}

function removeTag(tagToRemove) {
  if (!state.currentNote) return;
  state.currentNote.tags = (state.currentNote.tags || []).filter((tag) => tag !== tagToRemove);
  renderNoteTags();
  renderHeaderMeta();
  markDirty("meta");
}

function revisionPreviewText(revision) {
  return String(revision?.content_excerpt || revision?.excerpt || "").trim();
}

function normalizeDiffWords(text) {
  return String(text || "").toLowerCase().split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function diffSummary(currentText, previousText) {
  const currentWords = normalizeDiffWords(currentText);
  const previousWords = normalizeDiffWords(previousText);
  const previousSet = new Set(previousWords);
  const currentSet = new Set(currentWords);
  const added = currentWords.filter((word) => !previousSet.has(word)).slice(0, 8);
  const removed = previousWords.filter((word) => !currentSet.has(word)).slice(0, 8);
  return {
    addedCount: Math.max(0, currentWords.length - previousWords.length),
    removedCount: Math.max(0, previousWords.length - currentWords.length),
    addedPreview: added.join(", "),
    removedPreview: removed.join(", "),
  };
}

function renderRevisionsSummary() {
  if (!state.revisions.length) {
    els.revisionsSummary.textContent = "Nenhuma revisao registrada ainda.";
    return;
  }
  const latest = state.revisions[0];
  els.revisionsSummary.innerHTML = `
    <strong>${state.revisions.length} revisoes registradas</strong>
    <span>Ultima snapshot: v${escapeHtml(latest.version)} em ${escapeHtml(formatAbsoluteDate(latest.saved_at))}.</span>
    <span>Restaurar uma versao cria uma nova revisao com motivo <strong>restore</strong>.</span>
  `;
}

async function toggleArchive() {
  if (!state.currentNote || state.currentNote.deleted_at) return;
  state.currentNote.archived = !state.currentNote.archived;
  setCurrentNote(state.currentNote);
  markDirty("meta");
  await saveCurrentNote({ force: true });

  if (state.currentNote.archived && state.filters.view === "active") {
    await loadNotes({ preserveSelection: false });
  } else if (!state.currentNote.archived && state.filters.view === "archived") {
    state.filters.view = "active";
    await loadNotes({ preserveSelection: false });
  } else {
    upsertNoteSummary(state.currentNote);
    renderNotesList();
  }
  showToast(state.currentNote.archived ? "Nota arquivada." : "Nota desarquivada.", "success");
}

async function openRevisionsModal() {
  if (!state.currentNote) return;
  await flushPendingSave();
  const response = await state.api.listRevisions(state.currentNote.id, { limit: 50 });
  state.revisions = Array.isArray(response.revisions) ? response.revisions : [];
  renderRevisionsSummary();
  renderRevisionsList();
  openModal("revisions");
}

function renderRevisionsList() {
  els.revisionsList.innerHTML = "";
  if (!state.revisions.length) {
    const empty = document.createElement("div");
    empty.className = "revisions-empty";
    empty.textContent = "Nenhuma revisao registrada ainda.";
    els.revisionsList.appendChild(empty);
    return;
  }

  state.revisions.forEach((revision) => {
    const liveSnapshot = state.currentNote ? {
      version: state.currentNote.version,
      title: state.currentNote.title,
      tags: state.currentNote.tags,
      content_excerpt: state.currentNote.excerpt,
    } : null;
    const compareTarget = state.revisions.find((item) => item.version === revision.version + 1) || liveSnapshot;
    const summary = diffSummary(revisionPreviewText(compareTarget), revisionPreviewText(revision));
    const titleChanged = compareTarget && compareTarget.title !== revision.title;
    const tagsChanged = compareTarget && JSON.stringify(compareTarget.tags || []) !== JSON.stringify(revision.tags || []);
    const card = document.createElement("div");
    card.className = "revision-card";
    card.innerHTML = `
      <div class="revision-top">
        <strong>${escapeHtml(revision.title || "Sem título")} • v${revision.version}</strong>
        <span class="revision-badge">${escapeHtml(revision.reason || "update")}</span>
      </div>
      <div class="revision-excerpt">${escapeHtml(revisionPreviewText(revision) || "Sem resumo.")}</div>
      <div class="revision-diff">
        <div class="revision-diff-line"><strong>Comparado com ${compareTarget ? `v${compareTarget.version}` : "o estado atual"}:</strong> +${summary.addedCount} palavras, -${summary.removedCount} palavras.</div>
        ${summary.addedPreview ? `<div class="revision-diff-line"><strong>Entrou:</strong> ${escapeHtml(summary.addedPreview)}</div>` : ""}
        ${summary.removedPreview ? `<div class="revision-diff-line"><strong>Saiu:</strong> ${escapeHtml(summary.removedPreview)}</div>` : ""}
        ${titleChanged ? `<div class="revision-diff-line"><strong>Título:</strong> mudou de "${escapeHtml(compareTarget.title || "")}" para "${escapeHtml(revision.title || "")}".</div>` : ""}
        ${tagsChanged ? `<div class="revision-diff-line"><strong>Tags:</strong> ${escapeHtml((revision.tags || []).join(", ") || "sem tags")}</div>` : ""}
      </div>
      <div class="revision-bottom">
        <span class="note-meta">${escapeHtml(formatAbsoluteDate(revision.saved_at))}</span>
      </div>
    `;
    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "secondary-button";
    restoreButton.innerHTML = '<i class="ph ph-arrow-counter-clockwise"></i> Restaurar esta versão';
    restoreButton.addEventListener("click", () => restoreRevision(revision.version).catch(handleUnexpectedError));
    card.querySelector(".revision-bottom").appendChild(restoreButton);
    els.revisionsList.appendChild(card);
  });
}

async function restoreRevision(version) {
  if (!state.currentNote) return;
  askConfirmation({
    eyebrow: "Histórico",
    title: `Restaurar a versao ${version}?`,
    description: "Isso substitui o estado atual da nota e cria uma nova revisao com motivo restore.",
    acceptLabel: "Restaurar versao",
    acceptKind: "primary",
    onAccept: async () => {
      setSaveState("saving");
      const response = await state.api.restoreRevision(state.currentNote.id, version);
      setCurrentNote(response.note);
      upsertNoteSummary(response.note);
      await state.editor.render(response.note.content, { isNewNote: true });
      state.dirtyTitle = false;
      state.dirtyContent = false;
      state.dirtyMeta = false;
      renderNotesList();
      setSaveState("saved", { at: Date.now() });
      await openRevisionsModal();
      showToast(`Versao ${version} restaurada.`, "success");
    },
  });
}

function openModal(name) {
  state.editor?.hideInlineToolbar?.("modal");
  state.modal = name;
  els.templatesModal.classList.toggle("hidden", name !== "templates");
  els.revisionsModal.classList.toggle("hidden", name !== "revisions");
  els.importExportModal.classList.toggle("hidden", name !== "import-export");
  els.moveItemModal?.classList.toggle("hidden", name !== "move-item");
  els.folderNameModal?.classList.toggle("hidden", name !== "folder-name");
  els.confirmModal.classList.toggle("hidden", name !== "confirm");
}

function closeModal() {
  if (state.modal === "folder-name") {
    resolveFolderNameRequest(null);
  }
  if (state.modal === "move-item") {
    resolveMoveDestinationRequest(null);
  }
  state.modal = "";
  els.templatesModal.classList.add("hidden");
  els.revisionsModal.classList.add("hidden");
  els.importExportModal.classList.add("hidden");
  els.moveItemModal?.classList.add("hidden");
  els.folderNameModal?.classList.add("hidden");
  els.confirmModal.classList.add("hidden");
  state.pendingConfirmAction = null;
}

function noteViewportBounds() {
  const pageRect = document.querySelector(".note-page")?.getBoundingClientRect();
  const shellRect = document.querySelector(".editor-shell")?.getBoundingClientRect();
  const baseRect = pageRect || shellRect || els.editorHolder.getBoundingClientRect();
  return {
    left: Math.max(12, baseRect.left),
    top: Math.max(12, shellRect?.top ?? baseRect.top),
    right: Math.min(window.innerWidth - 12, baseRect.right),
    bottom: Math.min(window.innerHeight - 12, shellRect?.bottom ?? window.innerHeight - 12),
  };
}

function closestBlockRect(node) {
  if (!(node instanceof Node)) return null;
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const block = element?.closest?.(".ce-block, .editor-todo, .editor-quote, .editor-code, .tcloud-block-card");
  if (!block) return null;
  const rect = block.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  return rect;
}

function askConfirmation({ eyebrow = "Confirmacao", title, description, acceptLabel = "Confirmar", acceptKind = "danger", onAccept }) {
  state.pendingConfirmAction = typeof onAccept === "function" ? onAccept : null;
  els.confirmEyebrow.textContent = eyebrow;
  els.confirmTitle.textContent = title;
  els.confirmDescription.textContent = description;
  els.confirmAcceptButton.textContent = acceptLabel;
  els.confirmAcceptButton.className = acceptKind === "danger" ? "ghost-danger-button" : "primary-button";
  openModal("confirm");
}

function resolveFolderNameRequest(value) {
  const request = state.folderNameRequest;
  state.folderNameRequest = null;
  if (request?.resolve) request.resolve(value);
}

function openFolderNameModal({ mode = "create", parentId = "", folder = null } = {}) {
  return new Promise((resolve) => {
    const safeParentId = normalizeFolderId(parentId);
    const parentLabel = currentFolderLabel(safeParentId);
    state.folderNameRequest = { resolve, mode, parentId: safeParentId, folderId: folder?.id || "" };
    els.folderNameEyebrow.textContent = mode === "rename" ? "Renomear pasta" : safeParentId ? "Nova subpasta" : "Nova pasta";
    els.folderNameTitle.textContent = mode === "rename" ? "Renomear pasta" : safeParentId ? "Criar subpasta" : "Criar pasta";
    els.folderNameDescription.textContent = mode === "rename"
      ? "Atualize o nome desta pasta."
      : `Destino: ${parentLabel}`;
    els.folderNameInput.value = mode === "rename" ? (folder?.name || "") : "";
    els.folderNameInput.placeholder = safeParentId ? "Nome da subpasta" : "Nome da pasta";
    els.folderNameError.classList.add("hidden");
    els.folderNameError.textContent = "Informe um nome para a pasta.";
    openModal("folder-name");
    window.setTimeout(() => {
      els.folderNameInput.focus();
      els.folderNameInput.select();
    }, 0);
  });
}

function submitFolderNameModal() {
  const value = els.folderNameInput.value.trim();
  if (!value) {
    els.folderNameError.textContent = "Informe um nome para a pasta.";
    els.folderNameError.classList.remove("hidden");
    els.folderNameInput.focus();
    return;
  }
  resolveFolderNameRequest(value);
  closeModal();
}

async function runPendingConfirmAction() {
  const action = state.pendingConfirmAction;
  closeModal();
  if (action) await action();
}

function normalizeStr(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function matchOption(option, query) {
  const q = normalizeStr(query);
  const label = normalizeStr(option.label || "");
  const id = normalizeStr(option.id || "");
  const hint = normalizeStr(option.hint || "");
  return label.includes(q) || id.includes(q) || hint.includes(q);
}

function getSlashQuery() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  
  let text = "";
  let offset = 0;
  if (node.nodeType === Node.TEXT_NODE) {
    text = node.textContent;
    offset = range.startOffset;
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    text = node.textContent || "";
    offset = text.length;
  } else {
    return null;
  }
  
  const textBeforeCursor = text.substring(0, offset);
  const lastSlashIndex = textBeforeCursor.lastIndexOf("/");
  if (lastSlashIndex === -1) return null;
  
  return textBeforeCursor.substring(lastSlashIndex + 1);
}

function updateSlashMenuFilter() {
  if (!state.slashMenu.open) return;
  const query = getSlashQuery();
  if (query === null) {
    closeSlashMenu();
    return;
  }
  const filtered = SLASH_OPTIONS.filter(option => matchOption(option, query));
  state.slashMenu.filteredOptions = filtered;
  state.slashMenu.index = filtered.length > 0 ? 0 : -1;
  renderSlashMenu();
}

function closeEditorJsMenusForSlashOnly() {
  document.querySelectorAll(".ce-popover:not(.ce-popover--inline), .ce-settings, .ce-conversion-toolbar").forEach((element) => {
    element.setAttribute("aria-hidden", "true");
    element.hidden = true;
    element.style.display = "none";
    element.classList.add("hidden");
  });
}

function openSlashMenu(position, replaceCurrent = true) {
  state.editor?.hideInlineToolbar?.("slash-menu");
  closeEditorJsMenusForSlashOnly();
  requestAnimationFrame(closeEditorJsMenusForSlashOnly);
  state.slashMenu.open = true;
  state.slashMenu.index = 0;
  state.slashMenu.replaceCurrent = replaceCurrent;
  state.slashMenu.filteredOptions = [...SLASH_OPTIONS];
  const bounds = noteViewportBounds();
  const left = clamp(position.x, bounds.left + 8, Math.max(bounds.left + 8, bounds.right - 340));
  const top = clamp(position.y, bounds.top + 8, Math.max(bounds.top + 8, bounds.bottom - 360));
  els.slashMenu.style.left = `${left}px`;
  els.slashMenu.style.top = `${top}px`;
  renderSlashMenu();
  els.slashMenu.classList.remove("hidden");
}

function closeSlashMenu() {
  state.slashMenu.open = false;
  state.slashMenu.filteredOptions = null;
  els.slashMenu.classList.add("hidden");
}

function renderSlashMenu() {
  els.slashMenu.innerHTML = "";
  const options = state.slashMenu.filteredOptions || SLASH_OPTIONS;
  if (options.length === 0) {
    const noResults = document.createElement("div");
    noResults.className = "slash-no-results";
    noResults.textContent = "Nenhum resultado encontrado";
    els.slashMenu.appendChild(noResults);
    return;
  }
  let lastGroup = "";
  options.forEach((option, index) => {
    if (option.group && option.group !== lastGroup) {
      const group = document.createElement("div");
      group.className = "slash-group";
      group.textContent = option.group;
      els.slashMenu.appendChild(group);
      lastGroup = option.group;
    }
    const button = document.createElement("button");
    button.type = "button";
    if (index === state.slashMenu.index) button.classList.add("is-active");
    button.innerHTML = `
      <span class="slash-icon" aria-hidden="true">${escapeHtml(option.icon || "")}</span>
      <span class="slash-copy">
        <span class="slash-label">${escapeHtml(option.label)}</span>
        <span class="slash-hint">${escapeHtml(option.hint)}</span>
      </span>
    `;
    button.addEventListener("click", () => applySlashOption(option).catch(handleUnexpectedError));
    els.slashMenu.appendChild(button);
  });
}

function attachmentKindToBlockType(kind) {
  return ATTACHMENT_BLOCKS[String(kind || "").toLowerCase()] || ATTACHMENT_BLOCKS.file;
}

async function openAttachmentPicker({ kinds = ["file", "image", "video", "audio", "pdf"], allowFolders = false, replaceCurrent = false, forcedType = "" } = {}) {
  const selection = await state.picker.open({
    title: allowFolders ? "Selecionar arquivo ou pasta" : "Selecionar arquivo do TCloud",
    filterKinds: kinds,
    allowFolders,
  });
  if (!selection) return;
  const type = forcedType || attachmentKindToBlockType(selection.kind);
  await state.editor.insertSlashBlock(type, selection, { replaceCurrent });
  await syncEditorAttachmentsPreview();
  markDirty("content");
}

async function chooseCoverImage() {
  if (!state.currentNote) return;
  const selection = await state.picker.open({
    title: "Escolher imagem de capa",
    filterKinds: ["image"],
    allowFolders: false,
  });
  if (!selection?.path) return;
  await setAppearancePatch({ cover: { type: "image", value: selection.path } }, "Capa atualizada.");
}

async function applyCoverAction(action) {
  closeCoverMenu();
  if (action === "image") {
    await chooseCoverImage();
    return;
  }
  const cover = COVER_PRESETS[action] || COVER_PRESETS.gradient;
  await setAppearancePatch({ cover }, action === "none" ? "Capa removida." : "Capa atualizada.");
  closeCoverMenu();
}

function normalizeHexColor(value) {
  const raw = String(value || "").trim();
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  if (/^#[0-9a-f]{3}$/i.test(withHash)) {
    return `#${withHash.slice(1).split("").map((char) => `${char}${char}`).join("")}`.toUpperCase();
  }
  if (/^#[0-9a-f]{6}$/i.test(withHash)) return withHash.toUpperCase();
  return "";
}

async function applyCoverGradient(gradientId) {
  const gradient = COVER_GRADIENTS.find((item) => item.id === gradientId) || COVER_GRADIENTS[0];
  closeCoverMenu();
  await setAppearancePatch({ cover: { type: "gradient", value: gradient.id } }, "Capa atualizada.");
}

async function applyCoverColorFromMenu() {
  const input = els.noteCoverMenu?.querySelector("#cover-hex-input");
  const error = els.noteCoverMenu?.querySelector("#cover-color-error");
  const normalized = normalizeHexColor(input?.value);
  if (!normalized) {
    input?.classList.add("is-invalid");
    error?.classList.remove("hidden");
    input?.focus();
    return;
  }
  state.ui.coverColorDraft = normalized;
  closeCoverMenu();
  await setAppearancePatch({ cover: { type: "color", value: normalized } }, "Capa atualizada.");
}

async function applyIconValue(value) {
  const normalized = String(value || "").trim();
  closeIconMenu();
  if (!normalized || normalized === "none") {
    await setAppearancePatch({ icon: { type: "none", value: "" } }, "Ícone removido.");
    return;
  }
  const type = normalized.length <= 2 ? "emoji" : "symbol";
  pushRecentIcon(normalized);
  await setAppearancePatch({ icon: { type, value: normalized } }, "Ícone atualizado.");
}

async function applySlashOption(option) {
  const replaceCurrent = state.slashMenu.replaceCurrent;
  closeSlashMenu();
  if (option.picker) {
    await openAttachmentPicker({
      kinds: option.picker.kinds,
      allowFolders: Boolean(option.picker.allowFolders),
      replaceCurrent: replaceCurrent,
      forcedType: option.picker.blockType || "",
    });
  } else {
    await state.editor.insertSlashBlock(option.type, option.data, { replaceCurrent: replaceCurrent });
    markDirty("content");
  }
}

function selectionPosition() {
  const selection = window.getSelection();
  if (selection && selection.rangeCount) {
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
    const rect = rects[rects.length - 1] || range.getBoundingClientRect();
    const blockRect = closestBlockRect(selection.anchorNode) || closestBlockRect(selection.focusNode);
    const bounds = noteViewportBounds();
    const anchorRect = rect && (rect.left || rect.top || rect.width || rect.height) ? rect : blockRect;
    if (anchorRect) {
      const xBase = anchorRect.left + Math.min(Math.max(anchorRect.width * 0.2, 18), 34);
      const yBase = anchorRect.bottom + 12;
      return {
        x: clamp(xBase, bounds.left + 12, Math.max(bounds.left + 12, bounds.right - 340)),
        y: clamp(yBase, bounds.top + 12, Math.max(bounds.top + 12, bounds.bottom - 360)),
      };
    }
  }
  const bounds = noteViewportBounds();
  return { x: bounds.left + 28, y: bounds.top + 96 };
}

function eventShouldOpenSlashMenu(event) {
  if (event.key !== "/" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || !state.currentNote || state.currentNote.deleted_at) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest(".editorjs-host")) return false;
  const block = target.closest(".ce-block, .editor-todo, .editor-quote, .editor-code, .tcloud-block-card");
  if (!block) return false;
  if (target.tagName === "TEXTAREA") return false;
  return true;
}

function shouldOpenEditorContextMenu(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (!target.closest(".editorjs-host")) return false;
  if (target.closest("button, input, textarea, select")) return false;
  return Boolean(target.closest(".ce-block, .codex-editor__redactor, .editor-todo, .editor-quote, .editor-code, .tcloud-block-card"));
}

async function toggleFavorite() {
  if (!state.currentNote || state.currentNote.deleted_at || state.favoriteSaving) return;
  state.favoriteSaving = true;
  const noteId = state.currentNote.id;
  const previous = Boolean(state.currentNote.favorite);
  const nextFavorite = !previous;
  try {
    if (state.dirtyTitle || state.dirtyContent || state.dirtyMeta) {
      await flushPendingSave();
    }
    state.currentNote.favorite = nextFavorite;
    setCurrentNote(state.currentNote);
    upsertNoteSummary(state.currentNote);
    renderNotesList();
    setSaveState("saving");
    const response = await state.api.update(noteId, {
      favorite: nextFavorite,
      archived: Boolean(state.currentNote.archived),
      tags: noteTagsForSave(),
      properties: { ...(state.currentNote.properties || {}) },
    });
    state.dirtyMeta = false;
    setCurrentNote(response.note);
    upsertNoteSummary(response.note);
    if (state.filters.view === "favorites" && !response.note.favorite) {
      await loadNotes({ preserveSelection: false });
    } else {
      renderNotesList();
    }
    setSaveState("saved", { at: Date.now() });
    showToast(response.note.favorite ? "Nota adicionada às favoritas." : "Nota removida das favoritas.", "success");
  } catch (error) {
    if (state.currentNote?.id === noteId) {
      state.currentNote.favorite = previous;
      setCurrentNote(state.currentNote);
      upsertNoteSummary(state.currentNote);
      renderNotesList();
    }
    setSaveState("error", { error: error.message || "Erro ao favoritar" });
    throw error;
  } finally {
    state.favoriteSaving = false;
  }
}

function buildDirectStreamPath(path) {
  const rawPath = `/stream${String(path || "").split("/").map((part) => encodeURIComponent(part)).join("/").replaceAll("%2F", "/")}`;
  return state.api.authUrl(rawPath);
}

async function openAttachment(attachment) {
  if (!attachment?.path) return;
  if (attachment.kind === "folder") {
    revealAttachment(attachment);
    return;
  }
  if (attachment.kind === "pdf" || attachment.kind === "file") {
    window.open(buildDirectStreamPath(attachment.path), "_blank", "noopener");
    return;
  }
  if (["image", "video", "audio"].includes(String(attachment.kind || ""))) {
    window.open(buildDirectStreamPath(attachment.path), "_blank", "noopener");
    return;
  }
  revealAttachment(attachment);
}

function revealAttachment(attachment) {
  const rawPath = String(attachment?.path || "").trim();
  if (!rawPath) {
    showToast("Anexo sem caminho válido.", "error");
    return;
  }
  const normalized = rawPath.replace(/\/+$/, "") || "/";
  const revealPath = attachment.kind === "folder"
    ? normalized
    : normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/")) || "/"
      : "/";
  state.api.openPath(revealPath);
  if (attachment.kind !== "folder") {
    showToast(`Abrindo pasta do anexo: ${attachment.name || normalized.split("/").pop() || "arquivo"}.`, "info");
  }
}

async function resolveBlockPreview(data) {
  if (!data?.path) return null;
  const kind = String(data.kind || "").toLowerCase();
  if (kind === "folder" || kind === "file" || kind === "pdf") return null;
  if (kind === "image" && data.thumbnail_url) return { kind: "image", url: state.api.authUrl(data.thumbnail_url) };
  try {
    const url = await state.api.fetchThumbnail(data.path);
    if (url) return { kind: "thumbnail", url };
  } catch (error) {
    console.warn("Falha ao obter thumbnail", error);
  }
  if (kind === "image") return { kind: "image", url: buildDirectStreamPath(data.path) };
  return null;
}

async function openImportExportModal() {
  renderExportPreview();
  updateImportFileLabel();
  setImportStatus("");
  openModal("import-export");
}

async function pickerFromBlock(type, config = {}) {
  const selection = await state.picker.open({
    title: "Selecionar referencia do TCloud",
    filterKinds: Array.isArray(config.kinds) ? config.kinds : ["file", "image", "video", "audio", "pdf"],
    allowFolders: Boolean(config.allowFolders),
  });
  if (!selection) return null;
  const forcedType = type || attachmentKindToBlockType(selection.kind);
  return {
    ...selection,
    kind: selection.kind || String(forcedType).replace("tcloud", "").toLowerCase(),
  };
}

async function importSelectedFile() {
  const file = els.importFileInput.files?.[0];
  if (!file) {
    setImportStatus("Selecione um arquivo para importar.", "error");
    throw new Error("Selecione um arquivo para importar.");
  }
  if (!isSupportedImportFile(file.name)) {
    setImportStatus("Formato não suportado para importação.", "error");
    throw new Error("Formato não suportado para importação.");
  }
  const textContent = await readFileAsText(file);
  setImportStatus("Importando arquivo...", "info");
  setSaveState("saving");
  const response = await state.api.importNote({ fileName: file.name, textContent, folderId: folderTargetForCreation() });
  els.importFileInput.value = "";
  updateImportFileLabel();
  closeModal();
  await loadNotes({ preserveSelection: false });
  if (response.note?.id) await openNote(response.note.id, { skipPendingSave: true });
  showToast(`Arquivo "${file.name}" importado com sucesso.`, "success");
  setSaveState("saved", { at: Date.now() });
}

async function exportCurrentNote(format) {
  if (!state.currentNote || state.currentNote.deleted_at) return;
  await flushPendingSave();
  await state.api.downloadExport(state.currentNote.id, format);
  showToast(`Exportacao ${format.toUpperCase()} concluida.`, "success");
}

async function backupCurrentNote() {
  if (!state.currentNote) return;
  await flushPendingSave();
  setSaveState("saving");
  const result = await state.api.backupNote(state.currentNote.id);
  showToast(`Backup salvo em ${result.path}.`, "success");
  setSaveState("saved", { at: Date.now() });
}

function handleUnexpectedError(error) {
  console.error(error);
  showToast(error.message || "Falha inesperada no TCloud Notes.", "error");
}

function handleWindowAction({ actionId, menuItemId } = {}) {
  const command = menuItemId || actionId;
  if (command && command.startsWith("bulk-")) {
    handleBulkAction(command).catch(handleUnexpectedError);
    return;
  }
  const aliases = {
    "export.open": "note.export",
    "share.open": "note.share",
    "open-tab.run": "note.openTab",
    "favorite.run": "note.favorite.toggle",
    "duplicate.run": "note.duplicate",
    "archive.run": state.currentNote?.archived ? "note.unarchive" : "note.archive",
    "copy-link.run": "note.copyLink",
    "revisions.open": "note.revisions",
    "info.open": "note.info",
    "restore.run": "note.restore",
    "purge.run": "note.deletePermanent",
    "delete.run": "note.trash",
  };
  const commandId = aliases[command] || command;
  if (commandId?.startsWith("note.") || commandId?.startsWith("folder.") || commandId?.startsWith("sidebar.") || commandId === "app.search") {
    runNotesCommand(commandId).catch(handleUnexpectedError);
    return;
  }
  if (command === "sidebar.toggle") {
    setSidebarCollapsed(!state.ui.sidebarCollapsed);
    return;
  }
  if (command === "export.open" || command === "import.open") {
    openImportExportModal().catch(handleUnexpectedError);
    return;
  }
  if (command === "share.open") {
    openShareDialog();
    return;
  }
  if (command === "open-tab.run") {
    if (state.currentNoteId) window.open(`${window.location.origin}${window.location.pathname}#note=${state.currentNoteId}`, "_blank");
    return;
  }
  if (command === "favorite.run") {
    toggleFavorite().catch(handleUnexpectedError);
    return;
  }
  if (command === "duplicate.run") {
    duplicateCurrentNote().catch(handleUnexpectedError);
    return;
  }
  if (command === "archive.run") {
    toggleArchive().catch(handleUnexpectedError);
    return;
  }
  if (command === "copy-link.run") {
    copyCurrentNoteLink().catch(handleUnexpectedError);
    return;
  }
  if (command === "revisions.open") {
    openRevisionsModal().catch(handleUnexpectedError);
    return;
  }
  if (command === "info.open") {
    openNoteInfo();
    return;
  }
  if (command === "restore.run") {
    restoreCurrentNote().catch(handleUnexpectedError);
    return;
  }
  if (command === "purge.run") {
    purgeCurrentNote().catch(handleUnexpectedError);
    return;
  }
  if (command === "delete.run") {
    deleteCurrentNote().catch(handleUnexpectedError);
  }
}

function wireTemplateButtons() {
  renderTemplateGrid(els.templatesGrid);
  renderTemplateGrid(els.emptyTemplateGrid);
}

function wireEvents() {
  document.getElementById("bulk-fav-btn")?.addEventListener("click", () => handleBulkAction("bulk-favorite.run").catch(handleUnexpectedError));
  document.getElementById("bulk-arc-btn")?.addEventListener("click", () => handleBulkAction("bulk-archive.run").catch(handleUnexpectedError));
  document.getElementById("bulk-del-btn")?.addEventListener("click", () => handleBulkAction("bulk-delete.run").catch(handleUnexpectedError));
  document.getElementById("bulk-rst-btn")?.addEventListener("click", () => handleBulkAction("bulk-restore.run").catch(handleUnexpectedError));
  document.getElementById("bulk-purge-btn")?.addEventListener("click", () => handleBulkAction("bulk-purge.run").catch(handleUnexpectedError));
  document.getElementById("bulk-clear-btn")?.addEventListener("click", () => handleBulkAction("bulk-clear.run").catch(handleUnexpectedError));

  els.newNoteButton.addEventListener("click", () => runNotesCommand("note.create", { targetFolderId: folderTargetForCreation() }).catch(handleUnexpectedError));
  els.newFolderButton?.addEventListener("click", () => runNotesCommand("folder.create", { targetFolderId: folderTargetForCreation() }).catch(handleUnexpectedError));
  els.sidebarToggleButton?.addEventListener("click", () => setSidebarCollapsed(true));
  els.sidebarOpenButton?.addEventListener("click", () => setSidebarCollapsed(false));
  els.templatesButton?.addEventListener("click", () => openModal("templates"));
  els.importButton?.addEventListener("click", () => openImportExportModal().catch(handleUnexpectedError));
  els.exportButton?.addEventListener("click", () => runNotesCommand("note.export").catch(handleUnexpectedError));
  els.backupButton?.addEventListener("click", () => backupCurrentNote().catch(handleUnexpectedError));
  els.deleteButton?.addEventListener("click", () => runNotesCommand("note.trash").catch(handleUnexpectedError));
  els.restoreNoteButton?.addEventListener("click", () => runNotesCommand("note.restore").catch(handleUnexpectedError));
  els.revisionsButton?.addEventListener("click", () => runNotesCommand("note.revisions").catch(handleUnexpectedError));
  els.archiveButton?.addEventListener("click", () => runNotesCommand(state.currentNote?.archived ? "note.unarchive" : "note.archive").catch(handleUnexpectedError));
  els.favoriteButton.addEventListener("click", () => runNotesCommand("note.favorite.toggle").catch(handleUnexpectedError));
  els.noteMoreButton?.addEventListener("click", openNoteMoreMenu);
  els.folderNameCancelButton?.addEventListener("click", closeModal);
  els.folderNameSubmitButton?.addEventListener("click", submitFolderNameModal);
  els.moveItemCancelButton?.addEventListener("click", closeModal);
  els.folderNameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitFolderNameModal();
    }
  });
  els.noteCoverButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = !els.noteCoverMenu?.classList.contains("hidden");
    if (isOpen) closeCoverMenu();
    else openCoverMenuFromButton();
  });
  els.noteIconButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = !els.noteIconMenu?.classList.contains("hidden");
    if (isOpen) closeIconMenu();
    else openIconMenuFromButton();
  });
  els.importFileInput.setAttribute("accept", IMPORT_ACCEPT);
  els.importFileInput.addEventListener("change", updateImportFileLabel);
  els.importConfirmButton.addEventListener("click", () => importSelectedFile().catch(handleUnexpectedError));
  els.exportJsonButton.addEventListener("click", () => exportCurrentNote("json").catch(handleUnexpectedError));
  els.exportMarkdownButton.addEventListener("click", () => exportCurrentNote("markdown").catch(handleUnexpectedError));
  els.exportHtmlButton.addEventListener("click", () => exportCurrentNote("html").catch(handleUnexpectedError));

  els.filterAll.addEventListener("click", () => {
    state.filters.view = "active";
    loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
  });
  els.filterFavorites.addEventListener("click", () => {
    state.filters.view = "favorites";
    loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
  });
  els.filterRecent?.addEventListener("click", () => {
    state.filters.view = "recent";
    loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
  });
  els.filterArchived.addEventListener("click", () => {
    state.filters.view = "archived";
    loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
  });
  els.filterTrash.addEventListener("click", () => {
    state.filters.view = "trash";
    loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
  });

  els.searchInput.addEventListener("input", () => {
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      loadNotes({ preserveSelection: true }).catch(handleUnexpectedError);
    }, SEARCH_DELAY_MS);
  });

  els.titleInput.addEventListener("input", () => {
    if (state.currentNote) {
      state.currentNote.title = els.titleInput.value;
      renderHeaderMeta();
      renderExportPreview();
    }
    markDirty("title");
  });

  els.tagInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTagFromInput();
    }
  });
  els.tagInput.addEventListener("blur", () => addTagFromInput());

  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", closeModal));
  els.confirmCancelButton.addEventListener("click", closeModal);
  els.confirmAcceptButton.addEventListener("click", () => runPendingConfirmAction().catch(handleUnexpectedError));

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const iconClear = target.closest("[data-icon-clear]");
    if (iconClear) {
      event.preventDefault();
      state.ui.iconQuery = "";
      refreshIconMenuAfterSearch();
      return;
    }
    const iconChoice = target.closest("[data-icon-value]");
    if (iconChoice) {
      event.preventDefault();
      applyIconValue(iconChoice.dataset.iconValue).catch(handleUnexpectedError);
      return;
    }
    const coverGradient = target.closest("[data-cover-gradient]");
    if (coverGradient) {
      event.preventDefault();
      applyCoverGradient(coverGradient.dataset.coverGradient).catch(handleUnexpectedError);
      return;
    }
    const coverAction = target.closest("[data-cover-action]");
    if (coverAction) {
      event.preventDefault();
      applyCoverAction(coverAction.dataset.coverAction).catch(handleUnexpectedError);
      return;
    }
    if (target.closest("[data-cover-color-apply]")) {
      event.preventDefault();
      applyCoverColorFromMenu().catch(handleUnexpectedError);
      return;
    }
    if (state.slashMenu.open && !target.closest("#slash-menu")) closeSlashMenu();
    if (!target.closest("#note-icon-menu") && !target.closest("#note-icon-button")) closeIconMenu();
    if (!target.closest("#note-cover-menu") && !target.closest("#note-cover-button")) closeCoverMenu();
  });

  els.noteIconMenu?.addEventListener("input", (event) => {
    if (event.target?.id !== "note-icon-search") return;
    state.ui.iconQuery = event.target.value;
    refreshIconMenuAfterSearch();
  });

  els.noteIconMenu?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeIconMenu();
      els.noteIconButton?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusIconChoice(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusIconChoice(-1);
      return;
    }
    if (event.key === "Enter" && event.target?.id === "note-icon-search") {
      const [first] = visibleIconChoices();
      if (first?.dataset.iconValue) {
        event.preventDefault();
        applyIconValue(first.dataset.iconValue).catch(handleUnexpectedError);
      }
    }
  });

  els.noteCoverMenu?.addEventListener("input", (event) => {
    if (event.target?.id === "cover-color-input") {
      const value = normalizeHexColor(event.target.value);
      const hexInput = els.noteCoverMenu.querySelector("#cover-hex-input");
      const preview = els.noteCoverMenu.querySelector(".cover-color-preview");
      if (hexInput && value) hexInput.value = value;
      if (preview && value) preview.style.background = value;
      state.ui.coverColorDraft = value;
    }
    if (event.target?.id === "cover-hex-input") {
      const value = normalizeHexColor(event.target.value);
      const preview = els.noteCoverMenu.querySelector(".cover-color-preview");
      event.target.classList.toggle("is-invalid", Boolean(event.target.value.trim()) && !value);
      els.noteCoverMenu.querySelector("#cover-color-error")?.classList.toggle("hidden", Boolean(value) || !event.target.value.trim());
      if (preview && value) preview.style.background = value;
      state.ui.coverColorDraft = value || event.target.value;
    }
  });

  els.sidebarBackdrop?.addEventListener("click", () => setSidebarCollapsed(true));

  window.TCloudApp?.onWindowAction?.(handleWindowAction);
  window.TCloudApp?.ready?.().then(() => publishWindowActions()).catch(() => {});
  window.addEventListener("tcloud-app-session-changed", publishWindowActions);
  window.addEventListener("pageshow", publishWindowActions);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) publishWindowActions();
  });

  // Intercepta a tecla "/" na fase de captura para evitar que o EditorJS a processe e abra o popover nativo dele
  document.addEventListener("keydown", (event) => {
    if (eventShouldOpenSlashMenu(event)) {
      event.stopPropagation();
      event.stopImmediatePropagation();
      openSlashMenu(selectionPosition(), true);
    }
  }, true);

  document.addEventListener("input", () => {
    if (state.slashMenu.open) updateSlashMenuFilter();
  });

  document.addEventListener("keyup", (event) => {
    if (state.slashMenu.open && event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") {
      updateSlashMenuFilter();
    }
  });

  document.addEventListener("keydown", (event) => {
    const isCmdOrCtrl = event.metaKey || event.ctrlKey;
    const isInputTarget =
      event.target.tagName === "INPUT" ||
      event.target.tagName === "TEXTAREA" ||
      event.target.isContentEditable;
    const isEditorTarget = event.target.closest(".editor-shell") || event.target.closest(".codex-editor");
    const isEditorActive = state.currentNote && !state.currentNote.deleted_at;
    const isOtherInputFocused =
      (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.isContentEditable) &&
      !isEditorTarget;

    // Intercept Cmd/Ctrl + Z e Cmd/Ctrl + Y / Cmd/Ctrl + Shift + Z no Editor
    if (isEditorActive && !isOtherInputFocused && isCmdOrCtrl && state.editor) {
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          state.editor.redo().catch(handleUnexpectedError);
        } else {
          state.editor.undo().catch(handleUnexpectedError);
        }
        return;
      }
      if (key === "y") {
        event.preventDefault();
        event.stopPropagation();
        state.editor.redo().catch(handleUnexpectedError);
        return;
      }
    }

    if (isCmdOrCtrl && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrentNote({ force: true }).catch(handleUnexpectedError);
      return;
    }
    if (isCmdOrCtrl && event.key.toLowerCase() === "n") {
      event.preventDefault();
      createBlankNote().catch(handleUnexpectedError);
      return;
    }
    if (isCmdOrCtrl && event.key.toLowerCase() === "k") {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    if (isCmdOrCtrl && event.key.toLowerCase() === "f") {
      event.preventDefault();
      showFloatingSearch();
      return;
    }
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      state.filters.view = state.filters.view === "favorites" ? "active" : "favorites";
      loadNotes({ preserveSelection: false }).catch(handleUnexpectedError);
      return;
    }

    // Delete / Backspace para Sidebar
    if ((event.key === "Delete" || event.key === "Backspace") && !isInputTarget) {
      if (document.activeElement && (document.activeElement.closest(".sidebar") || document.activeElement.closest(".notes-list") || document.activeElement.closest(".note-card"))) {
        event.preventDefault();
        deleteCurrentNote().catch(handleUnexpectedError);
        return;
      }
    }

    // Tratar atalhos do Editor: C, X, V, Z
    if (isCmdOrCtrl && ["c", "x", "v", "z"].includes(event.key.toLowerCase())) {
      if (isInputTarget) {
        return;
      }

      const key = event.key.toLowerCase();

      if (isEditorTarget) {
        if (key === "c") {
          const selectedText = window.getSelection().toString();
          if (selectedText) {
            navigator.clipboard.writeText(selectedText).catch(() => {});
          }
        } else if (key === "x") {
          const selectedText = window.getSelection().toString();
          if (selectedText) {
            navigator.clipboard.writeText(selectedText).then(() => {
              document.execCommand("delete");
            }).catch(() => {});
          }
        } else if (key === "v") {
          navigator.clipboard.readText().then(text => {
            if (text && state.editor) {
              state.editor.insertSlashBlock("paragraph", { text }, { replaceCurrent: false }).catch(() => {});
            }
          }).catch(() => {});
        }
        return;
      }

      if (!isEditorTarget && state.currentNote) {
        const noteText = `${state.currentNote.title || "Sem título"}\n\n${blocksToMarkdownPreview(state.currentNote.content?.blocks || []) || "Nota vazia"}`;
        if (key === "c") {
          event.preventDefault();
          navigator.clipboard.writeText(noteText).then(() => {
            showToast("Conteúdo da nota copiado.", "success");
          }).catch(() => {});
        } else if (key === "x") {
          event.preventDefault();
          navigator.clipboard.writeText(noteText).then(() => {
            showToast("Conteúdo da nota recortado.", "info");
            deleteCurrentNote().catch(handleUnexpectedError);
          }).catch(() => {});
        } else if (key === "v") {
          event.preventDefault();
          navigator.clipboard.readText().then(text => {
            if (text && state.editor) {
              state.editor.insertSlashBlock("paragraph", { text }, { replaceCurrent: false }).catch(() => {});
              showToast("Conteúdo colado no editor.", "success");
            }
          }).catch(() => {});
        }
        return;
      }
    }

    if (event.key === "Escape") {
      window.TCloudApp?.closeWindowMenus?.();
      if (state.ui.compactWindow && !state.ui.sidebarCollapsed) {
        setSidebarCollapsed(true);
        return;
      }
      if (!els.noteIconMenu?.classList.contains("hidden")) {
        closeIconMenu();
        return;
      }
      if (!els.noteCoverMenu?.classList.contains("hidden")) {
        closeCoverMenu();
        return;
      }
      if (state.floatingSearch.visible) {
        hideFloatingSearch();
        return;
      }
      if (state.slashMenu.open) {
        closeSlashMenu();
        return;
      }
      if (state.modal) closeModal();
      return;
    }

    if (state.slashMenu.open) {
      const options = state.slashMenu.filteredOptions || SLASH_OPTIONS;
      if (options.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          state.slashMenu.index = (state.slashMenu.index + 1) % options.length;
          renderSlashMenu();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          state.slashMenu.index = (state.slashMenu.index - 1 + options.length) % options.length;
          renderSlashMenu();
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (state.slashMenu.index >= 0 && state.slashMenu.index < options.length) {
            applySlashOption(options[state.slashMenu.index]).catch(handleUnexpectedError);
          }
        }
      }
      return;
    }
  });

  window.addEventListener("hashchange", () => {
    const noteId = readNoteIdFromHash();
    if (noteId && noteId !== state.currentNoteId) {
      openNote(noteId, { skipPendingSave: false }).catch(handleUnexpectedError);
    }
  });

  wireContextMenus();
  wireFloatingSearch();
}

async function toggleFavoriteForId(noteId) {
  if (state.favoriteSaving) return;
  const targetNote = state.notes.find(n => n.id === noteId) || (state.currentNote && state.currentNote.id === noteId ? state.currentNote : null);
  if (!targetNote || targetNote.deleted_at) return;

  state.favoriteSaving = true;
  const previous = Boolean(targetNote.favorite);
  const nextFavorite = !previous;
  
  try {
    if (state.currentNote && state.currentNote.id === noteId && (state.dirtyTitle || state.dirtyContent || state.dirtyMeta)) {
      await flushPendingSave();
    }
    targetNote.favorite = nextFavorite;
    if (state.currentNote && state.currentNote.id === noteId) {
      setCurrentNote(targetNote);
    }
    upsertNoteSummary(targetNote);
    renderNotesList();
    setSaveState("saving");
    
    const response = await state.api.update(noteId, {
      favorite: nextFavorite,
      archived: Boolean(targetNote.archived),
      tags: Array.isArray(targetNote.tags) ? targetNote.tags : [],
      properties: { ...(targetNote.properties || {}) },
    });
    
    if (state.currentNote && state.currentNote.id === noteId) {
      state.dirtyMeta = false;
      setCurrentNote(response.note);
    }
    upsertNoteSummary(response.note);
    if (state.filters.view === "favorites" && !response.note.favorite) {
      await loadNotes({ preserveSelection: false });
    } else {
      renderNotesList();
    }
    setSaveState("saved", { at: Date.now() });
    showToast(response.note.favorite ? "Nota adicionada às favoritas." : "Nota removida das favoritas.", "success");
  } catch (error) {
    targetNote.favorite = previous;
    if (state.currentNote && state.currentNote.id === noteId) {
      setCurrentNote(targetNote);
    }
    upsertNoteSummary(targetNote);
    renderNotesList();
    setSaveState("error", { error: error.message || "Erro ao favoritar" });
    throw error;
  } finally {
    state.favoriteSaving = false;
  }
}

async function duplicateNoteForId(noteId) {
  const targetNote = state.notes.find(n => n.id === noteId) || (state.currentNote && state.currentNote.id === noteId ? state.currentNote : null);
  if (!targetNote || targetNote.deleted_at) return;

  if (state.currentNote && state.currentNote.id === noteId) {
    await flushPendingSave();
  }
  const duplicatedTitle = targetNote.title?.trim() ? `${targetNote.title} (cópia)` : "Sem título (cópia)";
  setSaveState("saving");
  const created = await state.api.create({
    title: duplicatedTitle,
    content: sanitizeContentForSave(targetNote.content),
    properties: { ...(targetNote.properties || {}) },
    folder_id: normalizeFolderId(targetNote.folder_id) || null,
  });
  const duplicateId = created.note?.id;
  if (!duplicateId) throw new Error("Não foi possível duplicar a nota.");
  await state.api.update(duplicateId, {
    tags: Array.isArray(targetNote.tags) ? [...targetNote.tags] : [],
    archived: false,
    favorite: false,
    cover: targetNote.cover || currentAppearance().cover,
    icon: targetNote.icon || currentAppearance().icon,
    properties: { ...(targetNote.properties || {}) },
  });
  state.filters.view = "active";
  await loadNotes({ preserveSelection: false });
  await openNote(duplicateId, { skipPendingSave: true });
  setSaveState("saved", { at: Date.now() });
  showToast("Nota duplicada.", "success");
}

async function deleteNoteForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || currentMenuContext(targetNote).noteTrashed) return;

  askConfirmation({
    eyebrow: "Lixeira",
    title: "Mover nota para a lixeira?",
    description: `A nota "${targetNote.title || "Sem título"}" poderá ser restaurada depois.`,
    acceptLabel: "Mover para lixeira",
    acceptKind: "danger",
    onAccept: async () => {
      if (state.currentNote && state.currentNote.id === noteId) {
        await flushPendingSave();
      }
      setSaveState("saving");
      await state.api.remove(noteId);
      showToast("Nota enviada para a lixeira.", "info");
      state.filters.view = "trash";
      state.currentNoteId = noteId;
      await loadNotes({ preserveSelection: true });
      setSaveState("saved", { at: Date.now() });
    },
  });
}

async function restoreNoteForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || !currentMenuContext(targetNote).noteTrashed) return;
  if (state.currentNote?.id === noteId) {
    await restoreCurrentNote();
    return;
  }
  setSaveState("saving");
  const response = await state.api.restore(noteId);
  showToast("Nota restaurada da lixeira.", "success");
  state.filters.view = "active";
  state.selectedNoteIds.delete(noteId);
  await loadNotes({ preserveSelection: false });
  if (response.note?.id) await openNote(response.note.id, { skipPendingSave: true });
  setSaveState("saved", { at: Date.now() });
}

async function purgeNoteForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || !currentMenuContext(targetNote).noteTrashed) return;
  askConfirmation({
    eyebrow: "Exclusão definitiva",
    title: "Excluir definitivamente esta nota?",
    description: "Excluir definitivamente esta nota? Esta ação não pode ser desfeita.",
    acceptLabel: "Excluir definitivamente",
    acceptKind: "danger",
    onAccept: async () => {
      setSaveState("saving");
      await state.api.purge(noteId);
      showToast("Nota excluída definitivamente.", "success");
      state.selectedNoteIds.delete(noteId);
      if (state.currentNoteId === noteId) {
        state.currentNoteId = "";
        setCurrentNote(null);
      }
      await loadNotes({ preserveSelection: false });
      setSaveState("saved", { at: Date.now() });
    },
  });
}

async function toggleArchiveForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || currentMenuContext(targetNote).noteTrashed) return;
  if (state.currentNote?.id === noteId) {
    await toggleArchive();
    return;
  }

  const targetArchived = !Boolean(targetNote.archived);
  setSaveState("saving");
  const response = await state.api.update(noteId, {
    archived: targetArchived,
    favorite: Boolean(targetNote.favorite),
    tags: Array.isArray(targetNote.tags) ? targetNote.tags : [],
    properties: { ...(targetNote.properties || {}) },
  });
  upsertNoteSummary(response.note);
  if (targetArchived && state.filters.view === "active") {
    await loadNotes({ preserveSelection: false });
  } else if (!targetArchived && state.filters.view === "archived") {
    state.filters.view = "active";
    await loadNotes({ preserveSelection: false });
  } else {
    renderNotesList();
  }
  setSaveState("saved", { at: Date.now() });
  showToast(targetArchived ? "Nota arquivada." : "Nota desarquivada.", "success");
}

async function copyNoteLinkForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || currentMenuContext(targetNote).noteTrashed) return;
  await copyToClipboard(buildCurrentNoteUrl(noteId));
  showToast("Link da nota copiado.", "success");
}

async function openRevisionsForId(noteId) {
  const targetNote = findNoteById(noteId);
  if (!targetNote || currentMenuContext(targetNote).noteTrashed) return;
  if (state.currentNote?.id !== noteId) {
    await openNote(noteId, { skipPendingSave: false });
  }
  await openRevisionsModal();
}

function showContextMenuAt(menu, x, y) {
  if (!menu) return;
  hideAllContextMenus();
  menu.classList.remove("hidden");
  positionFloatingElement(menu, x, y, { margin: 8 });
}

function openNoteContextMenu(event, note) {
  event.preventDefault();
  event.stopPropagation();
  if (!note) return;
  state.contextMenuTargetNoteId = note.id;
  state.contextMenuTargetFolderId = "";
  state.contextMenuTargetBlock = null;
  const actions = buildNoteMenuActions(note, currentMenuContext(note, { compactWindow: false }));
  if (!actions.length) return;
  renderContextMenuActions(els.sidebarContextMenu, actions);
  showContextMenuAt(els.sidebarContextMenu, event.pageX || event.clientX, event.pageY || event.clientY);
}

function openFolderContextMenu(event, folder) {
  event.preventDefault();
  event.stopPropagation();
  if (!folder) return;
  state.contextMenuTargetNoteId = "";
  state.contextMenuTargetFolderId = folder.id;
  state.contextMenuTargetBlock = null;
  const actions = getAvailableCommands([
    "folder.createNote",
    "folder.createChild",
    "folder.rename",
    "folder.move",
    "folder.delete",
  ], { folder, view: state.filters.view });
  renderContextMenuActions(els.sidebarContextMenu, actions);
  showContextMenuAt(els.sidebarContextMenu, event.pageX || event.clientX, event.pageY || event.clientY);
}

function openSidebarEmptyContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  state.contextMenuTargetNoteId = "";
  state.contextMenuTargetFolderId = "";
  state.contextMenuTargetBlock = null;
  const actions = getAvailableCommands([
    "note.create",
    "folder.create",
    "sidebar.expandAll",
    "sidebar.collapseAll",
  ], { targetFolderId: folderTargetForCreation() });
  renderContextMenuActions(els.sidebarContextMenu, actions);
  showContextMenuAt(els.sidebarContextMenu, event.pageX || event.clientX, event.pageY || event.clientY);
}

function handleSidebarDrop(event, targetFolderId = "") {
  const noteId = event.dataTransfer?.getData("application/x-tcloud-note");
  const folderId = event.dataTransfer?.getData("application/x-tcloud-folder");
  const safeTargetFolderId = normalizeFolderId(targetFolderId);
  if (noteId) {
    state.api.moveItems({ items: [{ type: "note", id: noteId }], target_folder_id: safeTargetFolderId || null })
      .then(() => {
        state.selectedFolderId = safeTargetFolderId;
        if (safeTargetFolderId) state.expandedFolderIds.add(safeTargetFolderId);
        persistSidebarState();
        showToast("Nota movida.", "success");
        return loadNotes({ preserveSelection: true });
      })
      .catch(handleUnexpectedError);
    return;
  }
  if (folderId) {
    if (folderId === safeTargetFolderId || isFolderDescendant(folderId, safeTargetFolderId, state.folders)) {
      showToast("Uma pasta não pode ser movida para dentro dela mesma.", "error");
      return;
    }
    state.api.moveItems({ items: [{ type: "folder", id: folderId }], target_folder_id: safeTargetFolderId || null })
      .then(() => {
        if (safeTargetFolderId) state.expandedFolderIds.add(safeTargetFolderId);
        persistSidebarState();
        showToast("Pasta movida.", "success");
        return loadNotes({ preserveSelection: true });
      })
      .catch(handleUnexpectedError);
  }
}

function openNoteMoreMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  state.editor?.hideInlineToolbar?.("note-more-menu");
  const context = currentMenuContext(state.currentNote, { compactWindow: false });
  const directStandaloneIds = context.noteTrashed
    ? new Set(["note.restore"])
    : new Set(["note.favorite.toggle", "note.archive", "note.unarchive", "note.revisions", "note.export", "note.trash"]);
  const actions = buildEditorMoreActions(state.currentNote, context)
    .filter((action) => state.ui.chromeMode !== "standalone" || !directStandaloneIds.has(action.id));
  renderContextMenuActions(els.sidebarContextMenu, actions);
  state.contextMenuTargetNoteId = state.currentNote?.id || "";
  state.contextMenuTargetFolderId = "";
  state.contextMenuTargetBlock = null;
  const rect = els.noteMoreButton?.getBoundingClientRect();
  showContextMenuAt(els.sidebarContextMenu, rect?.left || event.pageX, (rect?.bottom || event.pageY) + 6);
  els.noteMoreButton?.setAttribute("aria-expanded", "true");
}

function buildEditorContextActions({ hasSelection = false, readOnly = false, hasBlock = false } = {}) {
  const hasNote = Boolean(state.currentNote?.id);
  const trashed = Boolean(state.currentNote?.deleted_at);
  const actions = [
    {
      id: "editor.copy",
      label: "Copiar",
      icon: "ph-copy",
      shortcut: menuShortcut("C"),
      disabled: !hasSelection,
    },
    {
      id: "editor.cut",
      label: "Recortar",
      icon: "ph-scissors",
      shortcut: menuShortcut("X"),
      disabled: readOnly || !hasSelection,
    },
    {
      id: "editor.paste",
      label: "Colar",
      icon: "ph-clipboard-text",
      shortcut: menuShortcut("V"),
      disabled: readOnly,
    },
    {
      id: "editor.duplicateBlock",
      label: "Duplicar bloco",
      icon: "ph-copy-simple",
      separatorBefore: true,
      disabled: readOnly || !hasBlock,
    },
    {
      id: "editor.deleteBlock",
      label: "Excluir bloco",
      icon: "ph-trash",
      variant: "danger",
      disabled: readOnly || !hasBlock,
    },
    {
      id: "editor.search",
      label: "Buscar nesta nota",
      icon: "ph-magnifying-glass",
      shortcut: menuShortcut("F"),
      separatorBefore: true,
      disabled: !hasNote,
    },
  ];

  if (trashed) {
    actions.push(
      {
        id: "note.restore",
        label: "Restaurar",
        icon: "ph-arrow-counter-clockwise",
        separatorBefore: true,
        disabled: !hasNote,
      },
      {
        id: "note.deletePermanent",
        label: "Excluir definitivamente",
        icon: "ph-trash",
        variant: "danger",
        disabled: !hasNote,
      },
      {
        id: "note.info",
        label: "Informações da nota",
        icon: "ph-info",
        disabled: !hasNote,
      },
    );
    return actions;
  }

  actions.push(
    {
      id: "note.copyLink",
      label: "Copiar link da nota",
      icon: "ph-link-simple",
      separatorBefore: true,
      disabled: !hasNote,
    },
    {
      id: "note.revisions",
      label: "Histórico da nota",
      icon: "ph-clock-counter-clockwise",
      disabled: !hasNote,
    },
    {
      id: "note.info",
      label: "Informações da nota",
      icon: "ph-info",
      disabled: !hasNote,
    },
  );
  return actions;
}

function hideAllContextMenus() {
  els.sidebarContextMenu?.classList.add("hidden");
  els.editorContextMenu?.classList.add("hidden");
  els.noteMoreButton?.setAttribute("aria-expanded", "false");
}

function normalizeActionIcon(action) {
  const fallback = action?.id?.endsWith(".move") || action?.id === "note.move" || action?.id === "folder.move"
    ? "ph-folder-simple"
    : "";
  const raw = String(action?.icon || fallback || "").trim();
  if (!raw) return { weight: "ph", name: "" };
  const parts = raw.split(/\s+/).filter(Boolean);
  const weight = parts.includes("ph-fill") ? "ph-fill" : "ph";
  const named = parts.find((part) => part.startsWith("ph-") && part !== "ph-fill") || parts[0];
  const name = named.startsWith("ph-") ? named : `ph-${named}`;
  return { weight, name };
}

function renderActionIcon(action) {
  const icon = normalizeActionIcon(action);
  if (!icon.name) return '<span class="context-menu-icon is-empty" aria-hidden="true"></span>';
  return `<span class="context-menu-icon" aria-hidden="true"><i class="${escapeHtml(icon.weight)} ${escapeHtml(icon.name)}"></i></span>`;
}

function renderContextMenuActions(menu, actions) {
  const list = menu?.querySelector(".context-menu-list");
  if (!list) return;
  list.innerHTML = "";
  actions.forEach((action) => {
    if (action.separatorBefore && list.children.length) {
      const divider = document.createElement("li");
      divider.className = "context-menu-divider";
      list.appendChild(divider);
    }
    const item = document.createElement("li");
    item.className = `context-menu-item${action.variant === "danger" ? " danger" : ""}`;
    item.dataset.action = action.id;
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    if (action.disabled) {
      item.classList.add("is-disabled");
      item.setAttribute("aria-disabled", "true");
    }
    item.innerHTML = [
      renderActionIcon(action),
      `<span class="context-menu-label">${escapeHtml(action.label)}</span>`,
      action.shortcut ? `<kbd class="context-menu-shortcut">${escapeHtml(action.shortcut)}</kbd>` : "",
    ].join("");
    list.appendChild(item);
  });
}

async function executeEditorContextAction(action) {
  const readOnly = Boolean(state.currentNote?.deleted_at);
  const selectedText = window.getSelection()?.toString() || "";

  if (action === "editor.copy") {
    if (!selectedText.trim()) return;
    await copyToClipboard(selectedText);
    showToast("Texto copiado.", "success");
    return;
  }

  if (action === "editor.cut") {
    if (readOnly || !selectedText.trim()) return;
    await copyToClipboard(selectedText);
    document.execCommand("delete");
    markDirty("content");
    showToast("Texto recortado.", "success");
    return;
  }

  if (action === "editor.paste") {
    if (readOnly) return;
    const text = await navigator.clipboard?.readText?.();
    if (text && state.editor) {
      await state.editor.insertSlashBlock("paragraph", { text }, { replaceCurrent: false });
      markDirty("content");
      showToast("Texto colado.", "success");
    }
    return;
  }

  if (action === "editor.duplicateBlock") {
    if (readOnly || !state.editor) return;
    if (state.contextMenuTargetBlock && typeof state.editor.duplicateBlockByElement === "function") {
      await state.editor.duplicateBlockByElement(state.contextMenuTargetBlock);
    } else {
      await state.editor.duplicateBlock();
    }
    markDirty("content");
    return;
  }

  if (action === "editor.deleteBlock") {
    if (readOnly || !state.editor) return;
    if (state.contextMenuTargetBlock && typeof state.editor.deleteBlockByElement === "function") {
      await state.editor.deleteBlockByElement(state.contextMenuTargetBlock);
    } else {
      await state.editor.deleteBlock();
    }
    markDirty("content");
    return;
  }

  if (action === "editor.search") {
    showFloatingSearch();
    return;
  }

  if (action === "note.info") {
    openNoteInfo();
    return;
  }

  if (action?.startsWith("note.")) {
    await runNotesCommand(action, { note: state.currentNote });
  }
}

function executeNoteMenuAction(action, noteId) {
  if (!action || !noteId) return;
  if (action.startsWith("bulk-")) {
    handleBulkAction(action).catch(handleUnexpectedError);
    return;
  }
  const note = findNoteById(noteId);
  runNotesCommand(action, { note }).catch(handleUnexpectedError);
}

function wireContextMenus() {
  document.addEventListener("contextmenu", (event) => {
    hideAllContextMenus();

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    let targetMenu = null;
    const noteCard = target.closest(".note-card");
    const isEditorClick = shouldOpenEditorContextMenu(target);

    if (target.closest("#note-cover")) {
      event.preventDefault();
      event.stopPropagation();
      hideAllContextMenus();
      openCoverMenuAt(event.clientX, event.clientY);
      return;
    }

    if (noteCard) {
      state.contextMenuTargetNoteId = noteCard.dataset.id;
      state.contextMenuTargetFolderId = "";
      state.contextMenuTargetBlock = null;
      const targetNote = findNoteById(state.contextMenuTargetNoteId);
      const actions = buildNoteMenuActions(targetNote, currentMenuContext(targetNote, { compactWindow: false }));
      if (!actions.length) return;
      renderContextMenuActions(els.sidebarContextMenu, actions);
      targetMenu = els.sidebarContextMenu;
    } else if (isEditorClick) {
      const selectionText = window.getSelection()?.toString() || "";
      const targetBlock = target.closest(".ce-block, .editor-todo, .editor-quote, .editor-code, .tcloud-block-card");
      state.contextMenuTargetNoteId = "";
      state.contextMenuTargetFolderId = "";
      state.contextMenuTargetBlock = targetBlock;
      renderContextMenuActions(els.editorContextMenu, buildEditorContextActions({
        hasSelection: Boolean(selectionText.trim()),
        readOnly: Boolean(state.currentNote?.deleted_at),
        hasBlock: Boolean(targetBlock),
      }));
      targetMenu = els.editorContextMenu;
    }

    if (targetMenu) {
      event.preventDefault();
      state.editor?.hideInlineToolbar?.("context-menu");
      showContextMenuAt(targetMenu, event.clientX, event.clientY);
    }
  });

  // Fechamentos automáticos
  document.addEventListener("click", (event) => {
    if (event.button === 0) { // Clique esquerdo
      hideAllContextMenus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideAllContextMenus();
    }
  });

  document.addEventListener("scroll", () => {
    hideAllContextMenus();
  }, { capture: true, passive: true });

  // Event Listeners para Sidebar Context Menu
  els.sidebarContextMenu?.addEventListener("click", (event) => {
    const item = event.target.closest(".context-menu-item");
    if (!item) return;
    if (item.classList.contains("is-disabled") || item.getAttribute("aria-disabled") === "true") return;
    const action = item.dataset.action;
    const noteId = state.contextMenuTargetNoteId;
    const folderId = state.contextMenuTargetFolderId;
    if (noteId) {
      executeNoteMenuAction(action, noteId);
    } else if (folderId) {
      runNotesCommand(action, { folder: findFolderById(folderId) }).catch(handleUnexpectedError);
    } else {
      runNotesCommand(action, { targetFolderId: folderTargetForCreation() }).catch(handleUnexpectedError);
    }
    hideAllContextMenus();
  });

  // Event Listeners para Editor Context Menu
  els.editorContextMenu?.addEventListener("click", (event) => {
    const item = event.target.closest(".context-menu-item");
    if (!item) return;
    if (item.classList.contains("is-disabled") || item.getAttribute("aria-disabled") === "true") return;
    const action = item.dataset.action;
    if (window.TCLOUD_NOTES_DEBUG_LAYOUT === true) console.debug(`[Editor Context Menu] Ação disparada: ${action}`);

    executeEditorContextAction(action).catch(handleUnexpectedError);

    hideAllContextMenus();
  });
}

async function init() {
  state.currentNoteId = readNoteIdFromHash();
  const savedSidebarState = loadSidebarUiState();
  state.ui.sidebarCollapsed = Boolean(savedSidebarState.sidebarCollapsed);
  state.selectedFolderId = savedSidebarState.selectedFolderId || "";
  state.expandedFolderIds = savedSidebarState.expandedFolderIds || new Set();
  updateCompactWindowMode(els.app?.getBoundingClientRect?.().width || window.innerWidth);
  setEditorVisibility(false);
  renderSaveStatus();
  setupCompactWindowObserver();
  wireTemplateButtons();
  state.statusTimer = window.setInterval(tickSaveStatus, SAVE_STATUS_TICK_MS);
  state.picker = new NotesFilePicker({ api: state.api, root: els.filePickerModal });
  state.editor = new EditorAdapter({
    holder: "editorjs",
    onChange: async () => markDirty("content"),
    blockConfig: {
      onOpen: (data) => openAttachment(data).catch(handleUnexpectedError),
      onReveal: (data) => revealAttachment(data),
      resolvePreview: (data) => resolveBlockPreview(data),
      onPick: (type, config) => pickerFromBlock(type, config),
      onChange: () => markDirty("content"),
      onDelete: (element) => state.editor.deleteBlockByElement(element).catch(handleUnexpectedError),
    },
  });
  await state.editor.init(normalizeEditorData(null));
  installWikiLinkAutocomplete({ root: els.editorHolder, api: state.api });
  wireEvents();
  await loadInitialData();
  setSaveState("saved", { at: Date.now() });
}

async function loadInitialData() {
  const attempts = [0, 300, 900];
  let lastError = null;
  for (const waitMs of attempts) {
    if (waitMs) {
      await new Promise((resolve) => window.setTimeout(resolve, waitMs));
    }
    try {
      await loadNotes({ preserveSelection: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Falha ao carregar dados iniciais do Notes.");
}

init().catch((error) => {
  setSaveState("error", { error: "Falha ao iniciar" });
  handleUnexpectedError(error);
});

function wireFloatingSearch() {
  els.floatingSearchInput.addEventListener("input", (e) => {
    state.floatingSearch.query = e.target.value;
    performFloatingSearch(state.floatingSearch.query);
  });

  els.floatingSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      hideFloatingSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        navigateFloatingSearch(-1);
      } else {
        navigateFloatingSearch(1);
      }
    }
  });

  els.searchNext.addEventListener("click", () => {
    navigateFloatingSearch(1);
  });

  els.searchPrev.addEventListener("click", () => {
    navigateFloatingSearch(-1);
  });

  els.searchClose.addEventListener("click", () => {
    hideFloatingSearch();
  });
}

function showFloatingSearch() {
  els.searchBarFloating.classList.remove("hidden");
  els.floatingSearchInput.focus();
  els.floatingSearchInput.select();
  state.floatingSearch.visible = true;
  if (state.floatingSearch.query) {
    performFloatingSearch(state.floatingSearch.query);
  }
}

function hideFloatingSearch() {
  els.searchBarFloating.classList.add("hidden");
  state.floatingSearch.visible = false;
  
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('tcloud-search');
    CSS.highlights.delete('tcloud-search-active');
  }
  
  state.floatingSearch.highlights = [];
  state.floatingSearch.index = -1;
  
  if (state.editor) {
    state.editor.focus();
  }
}

function performFloatingSearch(query) {
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('tcloud-search');
    CSS.highlights.delete('tcloud-search-active');
  }
  state.floatingSearch.highlights = [];
  state.floatingSearch.index = -1;

  if (!query) {
    els.searchCounter.textContent = '0/0';
    return;
  }

  const textNodes = [];
  const walk = document.createTreeWalker(els.editorHolder, NodeFilter.SHOW_TEXT, null, false);
  let n;
  while (n = walk.nextNode()) {
    const parent = n.parentNode;
    if (parent && parent.tagName !== 'SCRIPT' && parent.tagName !== 'STYLE') {
      textNodes.push(n);
    }
  }

  const queryLower = query.toLowerCase();
  const ranges = [];

  for (const node of textNodes) {
    const text = node.textContent;
    let startIdx = 0;
    while (true) {
      const idx = text.toLowerCase().indexOf(queryLower, startIdx);
      if (idx === -1) break;
      
      const range = new Range();
      range.setStart(node, idx);
      range.setEnd(node, idx + query.length);
      ranges.push(range);
      
      startIdx = idx + query.length;
    }
  }

  state.floatingSearch.highlights = ranges;

  if (ranges.length > 0) {
    state.floatingSearch.index = 0;
    updateFloatingSearchUI();
  } else {
    els.searchCounter.textContent = '0/0';
  }
}

function updateFloatingSearchUI() {
  const ranges = state.floatingSearch.highlights;
  const index = state.floatingSearch.index;
  const total = ranges.length;

  if (total === 0) {
    els.searchCounter.textContent = '0/0';
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete('tcloud-search');
      CSS.highlights.delete('tcloud-search-active');
    }
    return;
  }

  els.searchCounter.textContent = `${index + 1}/${total}`;

  if (typeof CSS !== 'undefined' && CSS.highlights) {
    const searchHighlight = new Highlight(...ranges);
    const activeHighlight = new Highlight(ranges[index]);
    CSS.highlights.set('tcloud-search', searchHighlight);
    CSS.highlights.set('tcloud-search-active', activeHighlight);
  }

  const activeRange = ranges[index];
  const rect = activeRange.getBoundingClientRect();
  const shell = document.querySelector('.editor-shell');
  if (shell && (rect.top !== 0 || rect.left !== 0)) {
    const shellRect = shell.getBoundingClientRect();
    shell.scrollTo({
      top: shell.scrollTop + rect.top - shellRect.top - (shell.clientHeight / 2),
      behavior: 'smooth'
    });
  }
}

function navigateFloatingSearch(direction) {
  const ranges = state.floatingSearch.highlights;
  if (ranges.length === 0) return;
  state.floatingSearch.index = (state.floatingSearch.index + direction + ranges.length) % ranges.length;
  updateFloatingSearchUI();
}

window.showFloatingSearch = showFloatingSearch;
window.hideFloatingSearch = hideFloatingSearch;
window.state = state;
