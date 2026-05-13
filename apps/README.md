# 🧩 TCloud Apps — Guia do Desenvolvedor

Crie aplicativos que se integram nativamente à interface do TCloud!

## Estrutura de um App

Cada app é uma **pasta** dentro de `apps/` com no mínimo 2 arquivos:

```
apps/
└── meu-app/
    ├── manifest.json    ← Metadados do app (obrigatório)
    ├── index.html       ← Interface do app (obrigatório)
    ├── style.css        ← Estilos adicionais (opcional)
    ├── script.js        ← Lógica adicional (opcional)
    └── assets/          ← Imagens, fontes, etc. (opcional)
```

Pastas que começam com `_` são tratadas como exemplos internos e não aparecem na sidebar de apps por padrão.

## manifest.json

O manifesto define as informações do seu app:

```json
{
  "id": "meu-app",
  "name": "Meu App",
  "icon": "ph-rocket",
  "description": "Descrição curta do app",
  "version": "1.0.0",
  "author": "Seu Nome"
}
```

### Campos Obrigatórios

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | string | Identificador único (sem espaços, lowercase) |
| `name` | string | Nome exibido na sidebar |
| `icon` | string | Classe do ícone [Phosphor Icons](https://phosphoricons.com/) |

### Campos Opcionais

| Campo | Tipo | Descrição |
|---|---|---|
| `description` | string | Tooltip ao passar o mouse no sidebar |
| `version` | string | Versão do app (semver) |
| `author` | string | Nome do desenvolvedor |
| `order` | number | Ordem na sidebar (menor aparece antes) |
| `default` | boolean | Marca o app principal do grupo Aplicativos |
| `featured` | boolean | Destaca o app na shell |
| `category` | string | Categoria lógica (`system`, `media`, `utility`, `custom`) |
| `capabilities` | string[] | Capacidades declaradas do app |
| `accent_color` | string | Cor de destaque opcional |
| `system` | boolean | Marca app first-party de sistema |
| `protected` | boolean | Impede desinstalação e disable |
| `trust_level` | string | `system`, `trusted` ou `scoped` |
| `requested_permissions` | string[] | Permissões que o app pede no runtime |
| `functions` | string[] | Funções do catálogo do TCloud que o app quer usar |
| `entry` | string | Arquivo de entrada do app |

### Exemplo de manifesto v2

```json
{
  "id": "meu-app",
  "name": "Meu App",
  "icon": "ph-rocket",
  "category": "utility",
  "trust_level": "scoped",
  "requested_permissions": [
    "files.list",
    "metadata.read",
    "shell.notifications.show"
  ],
  "functions": [
    "files.listDirectory",
    "files.getInfo",
    "shell.showToast"
  ]
}
```

## Ícones Disponíveis

Usamos a biblioteca [Phosphor Icons](https://phosphoricons.com). Use o formato `ph-nome-do-icone`.

Exemplos: `ph-chart-bar`, `ph-gear`, `ph-music-notes`, `ph-game-controller`, `ph-terminal`, `ph-palette`

## API do TCloud

Seu app roda dentro de um `<iframe>` com acesso same-origin à API do TCloud.

## Runtime Seguro

Apps instalados por ZIP/GitHub nao devem depender do JWT bruto da shell. Em vez disso, carregue o SDK oficial e use o runtime token escopado:

```html
<script src="/static/tcloud-app-runtime.js"></script>
```

```javascript
await window.TCloudApp.ready();

const ctx = await window.TCloudApp.getContext();
const listing = await window.TCloudApp.call('files.listDirectory', { path: '/' });
window.TCloudApp.showToast(`App ${ctx.app_id} carregado`, 'info', 2500);
```

O runtime entrega ao app apenas:

- `runtime_token`
- `granted_permissions`
- `allowed_functions`

### Streams e estado cloud para documentos

Apps que precisam ler bytes de arquivos sem receber o JWT bruto devem pedir `stream.read` e usar `files.getStreamUrl`. O retorno inclui uma URL runtime e headers escopados, com suporte a `Range` quando o backend puder servir o arquivo progressivamente.

O app bundled `PDF Tools` usa esse contrato para abrir PDFs com `pdf.js` local em `apps/pdf-tools/vendor/pdfjs/`. Ele tambem usa as funcoes `pdf.getState`, `pdf.saveState`, `pdf.getTabs` e `pdf.saveTabs` para manter pagina atual, zoom e abas no MongoDB. `localStorage` nao deve ser usado como fonte de verdade para progresso ou abas, porque o requisito e sincronizar entre dispositivos.

Dependencias de apps bundled podem usar licencas permissivas como MIT, BSD, ISC e Apache-2.0. Quando uma biblioteca for vendorizada, mantenha a versao fixa e preserve o arquivo de licenca no bundle. CDN, pacote sem licenca clara, licenca comercial nao aprovada e copyleft forte como GPL/AGPL continuam bloqueados para apps padrao.

### ⚠️ Autenticação

O bridge `tcloud-auth` abaixo continua existindo para apps `system` durante a migracao. Evite usar esse fluxo em apps instalados por usuario.

```javascript
// Recebe o token de autenticação do TCloud via postMessage
let _parentToken = '';

function apiFetch(url, opts = {}) {
    if (_parentToken) {
        if (!opts.headers) opts.headers = {};
        opts.headers['Authorization'] = `Bearer ${_parentToken}`;
    }
    return fetch(url, opts);
}

// Ouve o token enviado pelo TCloud
window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'tcloud-auth') {
        _parentToken = event.data.token || '';
        init(); // Sua função principal — recarrega com auth
    }
});

// Se auth estiver desligada, inicia normalmente após 500ms
setTimeout(() => { if (!_parentToken) init(); }, 500);
```

Depois, use `apiFetch()` no lugar de `fetch()` para todas as chamadas à API:

### Endpoints Disponíveis

```javascript
// Listar arquivos de um diretório
const files = await apiFetch('/api/files?path=/').then(r => r.json());

// Uso do disco
const usage = await apiFetch('/api/usage').then(r => r.json());

// Listar favoritos
const favs = await apiFetch('/api/favorites').then(r => r.json());

// Listar recentes
const recents = await apiFetch('/api/recents').then(r => r.json());

// Listar arquivos cacheados no servidor
const cached = await apiFetch('/api/cached').then(r => r.json());

// Thumbnails
const thumb = await apiFetch('/api/thumbnail?path=/foto.jpg');

// Streaming de mídia
// <video src="/stream/caminho/do/video.mp4">
```

### Exemplo Completo

```javascript
// Auth via postMessage (obrigatório)
let _parentToken = '';
function apiFetch(url, opts = {}) {
    if (_parentToken) {
        if (!opts.headers) opts.headers = {};
        opts.headers['Authorization'] = `Bearer ${_parentToken}`;
    }
    return fetch(url, opts);
}
window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'tcloud-auth') {
        _parentToken = event.data.token || '';
        init();
    }
});
setTimeout(() => { if (!_parentToken) init(); }, 500);

async function init() {
    const [usage, files] = await Promise.all([
        apiFetch('/api/usage').then(r => r.json()),
        apiFetch('/api/files?path=/').then(r => r.json()),
    ]);

    const totalGB = (usage.total_bytes / 1e9).toFixed(2);
    const fileCount = files.items.filter(i => !i.is_directory).length;

    document.body.innerHTML = `
        <h1>Total: ${totalGB} GB</h1>
        <p>${fileCount} arquivos na raiz</p>
    `;
}
```

## Estilo Recomendado

Para manter a consistência visual com o TCloud:

```css
body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    background: #1a1d23;
    color: #e4e4e7;
    padding: 24px;
}
```

### Cores do TCloud

| Variável | Valor | Uso |
|---|---|---|
| Background | `#1a1d23` | Fundo principal |
| Card | `rgba(255,255,255,0.04)` | Cards e containers |
| Borda | `rgba(255,255,255,0.08)` | Bordas sutis |
| Texto | `#e4e4e7` | Texto principal |
| Secundário | `#71717a` | Texto secundário |
| Accent | `#6C5CE7` | Cor de destaque/marca |

## Instalando um App

1. Crie uma pasta dentro de `apps/` com o `id` do seu app
2. Adicione `manifest.json` e `index.html`
3. Reinicie o TCloud (ou recarregue a página)
4. Seu app aparecerá automaticamente na sidebar sob **APLICATIVOS**

## Exemplo

O app first-party principal agora é `apps/settings/`.
O exemplo em `apps/_example/` continua versionado para desenvolvimento, mas não entra na sidebar por padrão.
