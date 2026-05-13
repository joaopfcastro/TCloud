from __future__ import annotations

from copy import deepcopy

VALID_GRANT_MODES = {"allow", "deny", "ask_each_time"}

PERMISSION_CATALOG = {
    "files.list": {
        "label": "Listar arquivos",
        "group": "files",
        "dangerous": False,
        "description": "Permite listar diretorios e itens do TCloud.",
    },
    "files.read": {
        "label": "Ler arquivos",
        "group": "files",
        "dangerous": False,
        "description": "Permite ler conteudo e metadados de arquivos.",
    },
    "files.write": {
        "label": "Criar arquivos",
        "group": "files",
        "dangerous": True,
        "description": "Permite criar arquivos no TCloud.",
    },
    "files.edit": {
        "label": "Editar arquivos",
        "group": "files",
        "dangerous": True,
        "description": "Permite substituir conteudo de arquivos.",
    },
    "files.delete": {
        "label": "Apagar arquivos",
        "group": "files",
        "dangerous": True,
        "description": "Permite excluir arquivos do TCloud.",
    },
    "files.rename": {
        "label": "Renomear arquivos",
        "group": "files",
        "dangerous": True,
        "description": "Permite renomear arquivos existentes.",
    },
    "files.move": {
        "label": "Mover arquivos",
        "group": "files",
        "dangerous": True,
        "description": "Permite mover arquivos entre diretorios.",
    },
    "files.copy": {
        "label": "Copiar arquivos",
        "group": "files",
        "dangerous": True,
        "description": "Permite copiar arquivos.",
    },
    "folders.create": {
        "label": "Criar pastas",
        "group": "folders",
        "dangerous": True,
        "description": "Permite criar diretorios.",
    },
    "folders.rename": {
        "label": "Renomear pastas",
        "group": "folders",
        "dangerous": True,
        "description": "Permite renomear diretorios.",
    },
    "folders.delete": {
        "label": "Apagar pastas",
        "group": "folders",
        "dangerous": True,
        "description": "Permite excluir diretorios.",
    },
    "metadata.read": {
        "label": "Ler metadados",
        "group": "metadata",
        "dangerous": False,
        "description": "Permite consultar informacoes detalhadas de itens.",
    },
    "thumbnails.read": {
        "label": "Ler thumbnails",
        "group": "metadata",
        "dangerous": False,
        "description": "Permite acessar miniaturas e previews.",
    },
    "search.read": {
        "label": "Pesquisar",
        "group": "navigation",
        "dangerous": False,
        "description": "Permite pesquisar itens no TCloud.",
    },
    "favorites.read": {
        "label": "Ler favoritos",
        "group": "navigation",
        "dangerous": False,
        "description": "Permite listar favoritos.",
    },
    "favorites.write": {
        "label": "Editar favoritos",
        "group": "navigation",
        "dangerous": True,
        "description": "Permite marcar ou desmarcar favoritos.",
    },
    "recents.read": {
        "label": "Ler recentes",
        "group": "navigation",
        "dangerous": False,
        "description": "Permite listar itens recentes.",
    },
    "storage.offline.pin": {
        "label": "Fixar no servidor",
        "group": "storage",
        "dangerous": True,
        "description": "Permite marcar itens para retencao permanente.",
    },
    "storage.offline.unpin": {
        "label": "Remover do servidor",
        "group": "storage",
        "dangerous": True,
        "description": "Permite remover retencao permanente.",
    },
    "storage.cache.evict": {
        "label": "Limpar cache",
        "group": "storage",
        "dangerous": True,
        "description": "Permite limpar cache local de itens.",
    },
    "downloads.create": {
        "label": "Criar downloads",
        "group": "transfers",
        "dangerous": True,
        "description": "Permite iniciar downloads.",
    },
    "downloads.read": {
        "label": "Ler downloads",
        "group": "transfers",
        "dangerous": False,
        "description": "Permite consultar estado dos downloads.",
    },
    "uploads.create": {
        "label": "Criar uploads",
        "group": "transfers",
        "dangerous": True,
        "description": "Permite iniciar uploads.",
    },
    "uploads.read": {
        "label": "Ler uploads",
        "group": "transfers",
        "dangerous": False,
        "description": "Permite consultar estado dos uploads.",
    },
    "stream.read": {
        "label": "Abrir streams",
        "group": "media",
        "dangerous": False,
        "description": "Permite obter URLs de streaming e playback.",
    },
    "pdf.state.read": {
        "label": "Ler estado de PDFs",
        "group": "documents",
        "dangerous": False,
        "description": "Permite restaurar abas e progresso de leitura de PDFs.",
    },
    "pdf.state.write": {
        "label": "Salvar estado de PDFs",
        "group": "documents",
        "dangerous": False,
        "description": "Permite salvar abas e progresso de leitura de PDFs na nuvem.",
    },
    "settings.read": {
        "label": "Ler configuracoes",
        "group": "settings",
        "dangerous": False,
        "description": "Permite ler schema e valores de configuracao.",
    },
    "settings.write": {
        "label": "Editar configuracoes",
        "group": "settings",
        "dangerous": True,
        "description": "Permite alterar configuracoes do TCloud.",
    },
    "diagnostics.read": {
        "label": "Ler diagnosticos",
        "group": "diagnostics",
        "dangerous": False,
        "description": "Permite consultar status e diagnosticos.",
    },
    "logs.read": {
        "label": "Ler logs",
        "group": "diagnostics",
        "dangerous": True,
        "description": "Permite acessar trilhas de auditoria e logs.",
    },
    "apps.read": {
        "label": "Ler apps",
        "group": "apps",
        "dangerous": False,
        "description": "Permite listar e inspecionar apps.",
    },
    "apps.install": {
        "label": "Instalar apps",
        "group": "apps",
        "dangerous": True,
        "description": "Permite instalar apps por ZIP ou GitHub.",
    },
    "apps.update": {
        "label": "Atualizar apps",
        "group": "apps",
        "dangerous": True,
        "description": "Permite atualizar apps instalados.",
    },
    "apps.uninstall": {
        "label": "Desinstalar apps",
        "group": "apps",
        "dangerous": True,
        "description": "Permite desinstalar apps.",
    },
    "apps.permissions.read": {
        "label": "Ler permissoes de apps",
        "group": "apps",
        "dangerous": False,
        "description": "Permite revisar permissoes de apps.",
    },
    "apps.permissions.write": {
        "label": "Editar permissoes de apps",
        "group": "apps",
        "dangerous": True,
        "description": "Permite conceder e revogar permissoes de apps.",
    },
    "shell.open_app": {
        "label": "Abrir apps na shell",
        "group": "shell",
        "dangerous": False,
        "description": "Permite pedir abertura de apps na shell.",
    },
    "shell.open_path": {
        "label": "Abrir caminhos na shell",
        "group": "shell",
        "dangerous": False,
        "description": "Permite abrir um caminho no Finder do TCloud.",
    },
    "shell.notifications.show": {
        "label": "Mostrar notificacoes",
        "group": "shell",
        "dangerous": False,
        "description": "Permite exibir toasts na shell.",
    },
    "shell.preferences.read": {
        "label": "Ler preferencias da shell",
        "group": "shell",
        "dangerous": False,
        "description": "Permite ler preferencias locais da shell.",
    },
    "shell.preferences.write": {
        "label": "Editar preferencias da shell",
        "group": "shell",
        "dangerous": True,
        "description": "Permite alterar preferencias locais da shell.",
    },
}

FUNCTION_CATALOG = {
    "apps.list": {
        "label": "Listar apps",
        "permission": "apps.read",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "apps.getPermissions": {
        "label": "Ler permissoes do proprio app",
        "permission": "apps.permissions.read",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "apps.updatePermissions": {
        "label": "Editar permissoes de apps",
        "permission": "apps.permissions.write",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "apps.installZip": {
        "label": "Instalar app por ZIP",
        "permission": "apps.install",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "apps.installGithub": {
        "label": "Instalar app por GitHub",
        "permission": "apps.install",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "apps.enable": {
        "label": "Habilitar app",
        "permission": "apps.update",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "apps.disable": {
        "label": "Desabilitar app",
        "permission": "apps.update",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "apps.uninstall": {
        "label": "Desinstalar app",
        "permission": "apps.uninstall",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "diagnostics.status": {
        "label": "Ler status do runtime",
        "permission": "diagnostics.read",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "files.listDirectory": {
        "label": "Listar diretorio",
        "permission": "files.list",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "files.getInfo": {
        "label": "Ler informacoes do item",
        "permission": "metadata.read",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "files.getStreamUrl": {
        "label": "Obter URL de stream",
        "permission": "stream.read",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "files.rename": {
        "label": "Renomear item",
        "permission": "files.rename",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "files.move": {
        "label": "Mover item",
        "permission": "files.move",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "files.copy": {
        "label": "Copiar item",
        "permission": "files.copy",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "files.delete": {
        "label": "Apagar item",
        "permission": "files.delete",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "folders.create": {
        "label": "Criar pasta",
        "permission": "folders.create",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "folders.delete": {
        "label": "Apagar pasta",
        "permission": "folders.delete",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "metadata.fetch": {
        "label": "Ler metadados",
        "permission": "metadata.read",
        "transport": "backend",
        "implemented": False,
        "dangerous": False,
    },
    "thumbnail.fetch": {
        "label": "Ler thumbnail",
        "permission": "thumbnails.read",
        "transport": "backend",
        "implemented": False,
        "dangerous": False,
    },
    "search.query": {
        "label": "Pesquisar itens",
        "permission": "search.read",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "favorites.list": {
        "label": "Listar favoritos",
        "permission": "favorites.read",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "recents.list": {
        "label": "Listar recentes",
        "permission": "recents.read",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "pdf.getState": {
        "label": "Ler progresso de PDF",
        "permission": "pdf.state.read",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "pdf.saveState": {
        "label": "Salvar progresso de PDF",
        "permission": "pdf.state.write",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "pdf.getTabs": {
        "label": "Ler abas do PDF Tools",
        "permission": "pdf.state.read",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "pdf.saveTabs": {
        "label": "Salvar abas do PDF Tools",
        "permission": "pdf.state.write",
        "transport": "backend",
        "implemented": True,
        "dangerous": False,
    },
    "storage.pinOffline": {
        "label": "Fixar no servidor",
        "permission": "storage.offline.pin",
        "transport": "backend",
        "implemented": True,
        "dangerous": True,
    },
    "storage.unpinOffline": {
        "label": "Remover do servidor",
        "permission": "storage.offline.unpin",
        "transport": "backend",
        "implemented": True,
        "dangerous": True,
    },
    "storage.evictCache": {
        "label": "Limpar cache",
        "permission": "storage.cache.evict",
        "transport": "backend",
        "implemented": True,
        "dangerous": True,
    },
    "settings.read": {
        "label": "Ler configuracoes",
        "permission": "settings.read",
        "transport": "backend",
        "implemented": False,
        "dangerous": False,
    },
    "settings.write": {
        "label": "Editar configuracoes",
        "permission": "settings.write",
        "transport": "backend",
        "implemented": False,
        "dangerous": True,
    },
    "shell.openApp": {
        "label": "Abrir app na shell",
        "permission": "shell.open_app",
        "transport": "shell",
        "implemented": True,
        "dangerous": False,
    },
    "shell.closeApp": {
        "label": "Fechar app atual",
        "permission": "shell.open_app",
        "transport": "shell",
        "implemented": True,
        "dangerous": False,
    },
    "shell.openPath": {
        "label": "Abrir caminho no Finder",
        "permission": "shell.open_path",
        "transport": "shell",
        "implemented": True,
        "dangerous": False,
    },
    "shell.showToast": {
        "label": "Mostrar toast",
        "permission": "shell.notifications.show",
        "transport": "shell",
        "implemented": True,
        "dangerous": False,
    },
}

LEGACY_CAPABILITY_TO_PERMISSION = {
    "settings.read": "settings.read",
    "settings.write": "settings.write",
    "diagnostics.read": "diagnostics.read",
    "shell.preferences": "shell.preferences.write",
    "shell.preferences.read": "shell.preferences.read",
    "apps.read": "apps.read",
}


def permission_catalog_payload() -> list[dict]:
    payload = []
    for permission_id, meta in PERMISSION_CATALOG.items():
        payload.append(
            {
                "id": permission_id,
                "label": meta["label"],
                "group": meta["group"],
                "dangerous": bool(meta.get("dangerous")),
                "description": meta.get("description", ""),
            }
        )
    payload.sort(key=lambda item: (item["group"], item["label"]))
    return payload


def function_catalog_payload() -> list[dict]:
    payload = []
    for function_id, meta in FUNCTION_CATALOG.items():
        permission_id = meta.get("permission")
        permission_meta = PERMISSION_CATALOG.get(permission_id, {})
        payload.append(
            {
                "id": function_id,
                "label": meta["label"],
                "permission": permission_id,
                "transport": meta.get("transport", "backend"),
                "implemented": bool(meta.get("implemented")),
                "dangerous": bool(meta.get("dangerous", permission_meta.get("dangerous"))),
            }
        )
    payload.sort(key=lambda item: item["id"])
    return payload


def normalize_requested_permissions(manifest: dict) -> list[str]:
    requested = manifest.get("requested_permissions")
    if requested is None:
        requested = manifest.get("permissions")
    if requested is None:
        requested = []
        for capability in manifest.get("capabilities") or []:
            mapped = LEGACY_CAPABILITY_TO_PERMISSION.get(str(capability).strip())
            if mapped:
                requested.append(mapped)

    normalized = []
    seen = set()
    for raw in requested or []:
        permission_id = str(raw or "").strip()
        if permission_id not in PERMISSION_CATALOG or permission_id in seen:
            continue
        normalized.append(permission_id)
        seen.add(permission_id)
    return normalized


def normalize_requested_functions(manifest: dict) -> list[str]:
    requested = manifest.get("functions") or []
    normalized = []
    seen = set()
    for raw in requested:
        function_id = str(raw or "").strip()
        if function_id not in FUNCTION_CATALOG or function_id in seen:
            continue
        normalized.append(function_id)
        seen.add(function_id)
    return normalized


def default_policy_for_permission(permission_id: str, *, auto_grant: bool = False) -> dict:
    meta = PERMISSION_CATALOG.get(permission_id, {})
    return {
        "grant_mode": "allow" if auto_grant else "deny",
        "path_prefixes": ["/"],
        "allow_file_types": [],
        "max_file_size_mb": None,
        "dangerous": bool(meta.get("dangerous")),
        "reason": "",
    }


def normalize_permission_policy(permission_id: str, raw_policy: dict | None, *, auto_grant: bool = False) -> dict:
    policy = deepcopy(default_policy_for_permission(permission_id, auto_grant=auto_grant))
    raw_policy = raw_policy or {}

    grant_mode = str(raw_policy.get("grant_mode") or policy["grant_mode"]).strip()
    if grant_mode not in VALID_GRANT_MODES:
        grant_mode = policy["grant_mode"]
    policy["grant_mode"] = grant_mode

    path_prefixes = raw_policy.get("path_prefixes")
    if isinstance(path_prefixes, list):
        normalized_paths = []
        for item in path_prefixes:
            text = str(item or "").strip()
            if not text:
                continue
            if not text.startswith("/"):
                text = f"/{text.lstrip('/')}"
            normalized_paths.append(text)
        if normalized_paths:
            policy["path_prefixes"] = sorted(set(normalized_paths))

    allow_file_types = raw_policy.get("allow_file_types")
    if isinstance(allow_file_types, list):
        normalized_types = []
        for item in allow_file_types:
            text = str(item or "").strip().lower()
            if not text:
                continue
            if not text.startswith("."):
                text = f".{text.lstrip('.')}"
            normalized_types.append(text)
        policy["allow_file_types"] = sorted(set(normalized_types))

    max_file_size = raw_policy.get("max_file_size_mb")
    if max_file_size not in (None, ""):
        try:
            policy["max_file_size_mb"] = max(1, int(max_file_size))
        except (TypeError, ValueError):
            policy["max_file_size_mb"] = None

    reason = str(raw_policy.get("reason") or "").strip()
    policy["reason"] = reason[:500]
    policy["dangerous"] = bool(PERMISSION_CATALOG.get(permission_id, {}).get("dangerous"))
    return policy


def compute_granted_permissions(permission_policies: dict[str, dict], requested_permissions: list[str]) -> list[str]:
    granted = []
    for permission_id in requested_permissions:
        policy = permission_policies.get(permission_id) or {}
        if policy.get("grant_mode") == "allow":
            granted.append(permission_id)
    return granted


def compute_allowed_functions(requested_functions: list[str], permission_policies: dict[str, dict]) -> list[str]:
    allowed = []
    granted_permissions = set(compute_granted_permissions(permission_policies, list(permission_policies.keys())))
    for function_id in requested_functions:
        meta = FUNCTION_CATALOG.get(function_id)
        if not meta:
            continue
        permission_id = meta.get("permission")
        if permission_id and permission_id not in granted_permissions:
            continue
        allowed.append(function_id)
    return allowed


def is_path_allowed(policy: dict | None, path: str | None) -> bool:
    if not path:
        return True
    normalized_path = str(path).strip() or "/"
    prefixes = (policy or {}).get("path_prefixes") or ["/"]
    for prefix in prefixes:
        normalized_prefix = str(prefix or "").strip() or "/"
        if normalized_prefix == "/":
            return True
        if normalized_path == normalized_prefix or normalized_path.startswith(f"{normalized_prefix.rstrip('/')}/"):
            return True
    return False


def is_file_type_allowed(policy: dict | None, path: str | None) -> bool:
    allow_file_types = (policy or {}).get("allow_file_types") or []
    if not allow_file_types or not path:
        return True
    path_lower = str(path).lower()
    return any(path_lower.endswith(extension) for extension in allow_file_types)
