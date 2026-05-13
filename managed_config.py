from __future__ import annotations

import json
import os
import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = "2026-04-12-settings-v1"

SETTINGS_SCHEMA = {
    "API_ID": {
        "group": "telegram",
        "label": "Telegram API ID",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Identificador da API do Telegram usado pelo backend.",
    },
    "API_HASH": {
        "group": "telegram",
        "label": "Telegram API Hash",
        "type": "string",
        "mutable": True,
        "secret": True,
        "apply_mode": "restart_required",
        "description": "Chave privada da API do Telegram.",
    },
    "BOT_TOKENS": {
        "group": "telegram",
        "label": "Tokens dos Bots",
        "type": "csv",
        "mutable": True,
        "secret": True,
        "apply_mode": "restart_required",
        "description": "Lista de tokens dos bots separada por virgula.",
    },
    "CHAT_ID": {
        "group": "telegram",
        "label": "Chat ID",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Canal ou chat principal de armazenamento.",
    },
    "TELEGRAM_OPAQUE_FILENAMES": {
        "group": "telegram",
        "label": "Nomes opacos no Telegram",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Oculta nomes originais dos arquivos salvos no Telegram.",
    },
    "MONGODB_URI": {
        "group": "database",
        "label": "MongoDB URI",
        "type": "string",
        "mutable": True,
        "secret": True,
        "apply_mode": "restart_required",
        "description": "URI de conexao com o MongoDB.",
    },
    "DB_NAME": {
        "group": "database",
        "label": "Nome do banco",
        "type": "string",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Nome do banco de dados usado pelo TCloud.",
    },
    "FTP_HOST": {
        "group": "server",
        "label": "FTP Host",
        "type": "string",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Endereco do servidor FTP.",
    },
    "FTP_PORT": {
        "group": "server",
        "label": "FTP Porta",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Porta de escuta do FTP.",
    },
    "FTP_USER": {
        "group": "server",
        "label": "FTP Usuario",
        "type": "string",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Usuario padrao do FTP.",
    },
    "FTP_PASS": {
        "group": "server",
        "label": "FTP Senha",
        "type": "string",
        "mutable": True,
        "secret": True,
        "apply_mode": "restart_required",
        "description": "Senha padrao do FTP.",
    },
    "PASSIVE_PORTS": {
        "group": "server",
        "label": "Portas passivas FTP",
        "type": "string",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Faixa de portas passivas no formato inicio-fim.",
    },
    "HTTP_HOST": {
        "group": "server",
        "label": "HTTP Host",
        "type": "string",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Endereco do servidor HTTP.",
    },
    "HTTP_PORT": {
        "group": "server",
        "label": "HTTP Porta",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Porta do servidor HTTP.",
    },
    "AUTH_ENABLED": {
        "group": "access",
        "label": "Autenticacao habilitada",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Ativa autenticacao JWT na Web e nas APIs protegidas.",
    },
    "AUTH_USERNAME": {
        "group": "access",
        "label": "Usuario de login",
        "type": "string",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Usuario usado no login web.",
    },
    "AUTH_PASSWORD": {
        "group": "access",
        "label": "Senha de login",
        "type": "string",
        "mutable": True,
        "secret": True,
        "apply_mode": "restart_required",
        "description": "Senha usada no login web.",
    },
    "JWT_EXPIRY_HOURS": {
        "group": "access",
        "label": "Expiracao JWT (horas)",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Duracao padrao do token JWT em horas.",
    },
    "JWT_SECRET": {
        "group": "access",
        "label": "JWT Secret",
        "type": "string",
        "mutable": True,
        "secret": True,
        "apply_mode": "restart_required",
        "description": "Segredo usado para assinar tokens JWT.",
    },
    "SSL_CERT": {
        "group": "access",
        "label": "Certificado SSL",
        "type": "string",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Caminho do certificado TLS.",
    },
    "SSL_KEY": {
        "group": "access",
        "label": "Chave SSL",
        "type": "string",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Caminho da chave privada TLS.",
    },
    "MAX_WORKERS": {
        "group": "performance",
        "label": "Maximo de workers",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Concorrencia principal de upload/download.",
    },
    "CHUNK_SIZE_MB": {
        "group": "performance",
        "label": "Tamanho do chunk (MB)",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Tamanho padrao dos chunks no Telegram.",
    },
    "MAX_RETRIES": {
        "group": "performance",
        "label": "Maximo de tentativas",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Numero maximo de retries em operacoes de rede.",
    },
    "MAX_STAGING_AGE": {
        "group": "performance",
        "label": "Idade maxima do staging",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Tempo maximo de permanencia de arquivos temporarios em segundos.",
    },
    "CACHE_MAX_GB": {
        "group": "cache",
        "label": "Cache maximo (GB)",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Limite maximo do cache em disco.",
    },
    "CACHE_PREFETCH_CHUNKS": {
        "group": "cache",
        "label": "Prefetch de chunks",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Quantidade de chunks pre-carregados no cache.",
    },
    "PDF_THUMB_MAX_MB": {
        "group": "cache",
        "label": "PDF thumb maximo (MB)",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Tamanho maximo do PDF para gerar thumb.",
    },
    "PDF_THUMB_CONCURRENCY": {
        "group": "cache",
        "label": "Concorrencia de thumbs PDF",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Concorrencia usada pelo renderizador de thumbs PDF.",
    },
    "PDF_THUMB_NEGATIVE_CACHE_TTL": {
        "group": "cache",
        "label": "TTL cache negativo PDF",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Tempo do cache negativo de falhas de thumbs PDF em segundos.",
    },
    "ARCHIVE_ENABLED": {
        "group": "archive",
        "label": "Arquivamento habilitado",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Ativa extração e compactação multiformato na Web.",
    },
    "ARCHIVE_MAX_SOURCE_MB": {
        "group": "archive",
        "label": "Arquivo fonte máximo (MB)",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Tamanho máximo aceito para o arquivo compactado de entrada.",
    },
    "ARCHIVE_MAX_EXTRACTED_MB": {
        "group": "archive",
        "label": "Conteúdo extraído máximo (MB)",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Limite total do material extraído em staging antes do upload.",
    },
    "ARCHIVE_MAX_ENTRY_COUNT": {
        "group": "archive",
        "label": "Máximo de itens por arquivo",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Quantidade máxima de arquivos e diretórios permitidos por operação.",
    },
    "ARCHIVE_UPLOAD_CONCURRENCY": {
        "group": "archive",
        "label": "Concorrência de upload pós-extração",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Concorrência reservada para publicar resultados de arquivamento.",
    },
    "ARCHIVE_DEFAULT_FORMAT": {
        "group": "archive",
        "label": "Formato padrão de compactação",
        "type": "enum",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "options": ["zip", "7z", "tar.gz"],
        "description": "Formato sugerido por padrão no modal de compactação.",
    },
    "ARCHIVE_DEFAULT_OVERWRITE_MODE": {
        "group": "archive",
        "label": "Política padrão de conflito",
        "type": "enum",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "options": ["skip", "replace", "auto_rename"],
        "description": "Comportamento padrão quando o destino já existe.",
    },
    "ARCHIVE_DEFAULT_EXTRACT_MODE": {
        "group": "archive",
        "label": "Modo padrão de extração",
        "type": "enum",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "options": ["here", "new_folder"],
        "description": "Define se a extração ocorre na pasta atual ou em nova pasta.",
    },
    "ARCHIVE_ALLOW_PASSWORD_INPUT": {
        "group": "archive",
        "label": "Permitir senha no arquivamento",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Exibe campo de senha para abrir arquivos protegidos quando suportado.",
    },
    "PUBLIC_SHARE_ENABLED": {
        "group": "sharing",
        "label": "Compartilhamento público habilitado",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Permite criar e acessar links públicos de arquivos e pastas.",
    },
    "PUBLIC_SHARE_ALLOW_FILE_SHARING": {
        "group": "sharing",
        "label": "Permitir compartilhar arquivos",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Autoriza a criação de links públicos diretos para arquivos.",
    },
    "PUBLIC_SHARE_ALLOW_FOLDER_SHARING": {
        "group": "sharing",
        "label": "Permitir compartilhar pastas",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Autoriza a criação de links públicos diretos para pastas.",
    },
    "PUBLIC_SHARE_REQUIRE_PASSWORD_BY_DEFAULT": {
        "group": "sharing",
        "label": "Senha por padrão",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Abre o modal de novo compartilhamento com proteção por senha habilitada.",
    },
    "PUBLIC_SHARE_DEFAULT_EXPIRY_HOURS": {
        "group": "sharing",
        "label": "Expiração padrão (horas)",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Validade padrão para novos links. Use 0 para não expirar automaticamente.",
    },
    "PUBLIC_SHARE_MAX_EXPIRY_HOURS": {
        "group": "sharing",
        "label": "Expiração máxima (horas)",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Teto para validade customizada de links. Use 0 para sem teto.",
    },
    "PUBLIC_SHARE_DEFAULT_MAX_ACCESS": {
        "group": "sharing",
        "label": "Limite padrão de acessos",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Quantidade padrão de acessos para novos links. Use 0 para ilimitado.",
    },
    "PUBLIC_SHARE_MAX_ACCESS_LIMIT": {
        "group": "sharing",
        "label": "Teto de acessos por link",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Maior valor aceito para limite de acessos. Use 0 para sem teto.",
    },
    "PUBLIC_SHARE_ALLOW_ZIP_DOWNLOAD": {
        "group": "sharing",
        "label": "Permitir ZIP público",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Permite baixar pastas e seleções públicas como arquivo ZIP.",
    },
    "PUBLIC_SHARE_SESSION_TTL_SECONDS": {
        "group": "sharing",
        "label": "TTL de sessão pública (s)",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Tempo de vida da sessão anônima criada ao abrir um link público.",
    },
    "PUBLIC_SHARE_METRICS_TTL_SECONDS": {
        "group": "sharing",
        "label": "TTL das métricas públicas (s)",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Tempo de cache das métricas recursivas de páginas públicas.",
    },
    "PUBLIC_SHARE_METRICS_CONCURRENCY": {
        "group": "sharing",
        "label": "Concorrência de métricas públicas",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Número máximo de cálculos de métricas públicas em paralelo.",
    },
    "PUBLIC_SHARE_SHOW_MEDIA_PREVIEW": {
        "group": "sharing",
        "label": "Prévia de mídia pública",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Permite previews e player nas páginas públicas quando o arquivo suporta visualização.",
    },
    "PUBLIC_SHARE_AUDIT_LOG_ENABLED": {
        "group": "sharing",
        "label": "Auditoria de compartilhamento",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Habilita logs operacionais de criação, acesso, bloqueio e revogação de links públicos.",
    },
    "SYNC_ENABLED": {
        "group": "sync",
        "label": "TCloud Sync habilitado",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Ativa a pasta de sincronizacao local.",
    },
    "SYNC_DIR": {
        "group": "sync",
        "label": "Diretorio do Sync",
        "type": "string",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Caminho da pasta de sincronizacao do TCloud.",
    },
    "FUSE_ENABLED": {
        "group": "sync",
        "label": "FUSE habilitado",
        "type": "bool",
        "mutable": True,
        "secret": False,
        "apply_mode": "restart_required",
        "description": "Ativa montagem FUSE quando suportado.",
    },
    "LOG_LEVEL": {
        "group": "diagnostics",
        "label": "Nivel de log",
        "type": "enum",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "options": ["DEBUG", "INFO", "WARNING", "ERROR"],
        "description": "Nivel global de logging do processo.",
    },
    "WEB_SUBTITLE_EXTRACT_TIMEOUT_SECONDS": {
        "group": "web_playback",
        "label": "Timeout de extracao de legenda",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Tempo maximo de extracao de legenda na Web.",
    },
    "WEB_VIDEO_TRANSCODE_MODE": {
        "group": "web_playback",
        "label": "Modo de playback web",
        "type": "enum",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "options": ["hls_session", "prepared_mp4_variant", "pipe_mse"],
        "description": "Estratégia de entrega de video transcodificado no player Web.",
    },
    "WEB_PLAYBACK_SESSION_TTL": {
        "group": "web_playback",
        "label": "TTL da sessao Web",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Tempo de vida das sessoes Web em segundos.",
    },
    "WEB_PLAYBACK_RETIRE_GRACE_SECONDS": {
        "group": "web_playback",
        "label": "Grace period de sessao Web",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Janela de aposentadoria da sessao Web em segundos.",
    },
    "WEB_PLAYBACK_HLS_SUBTITLES_MODE": {
        "group": "web_playback",
        "label": "Modo de legenda HLS",
        "type": "enum",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "options": ["off", "hybrid", "native"],
        "description": "Modo de entrega de legendas HLS na Web.",
    },
    "WEB_PLAYBACK_HLS_SUBTITLE_SEGMENT_DURATION": {
        "group": "web_playback",
        "label": "Duracao de segmento da legenda HLS",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Duracao dos segmentos de subtitle HLS em segundos.",
    },
    "WEB_PLAYBACK_HLS_SEGMENT_TYPE": {
        "group": "web_playback",
        "label": "Tipo de segmento HLS",
        "type": "enum",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "options": ["mpegts", "fmp4"],
        "description": "Formato do segmento HLS gerado no backend.",
    },
    "WEB_PLAYBACK_HLS_CLOUD_INPUT_MODE": {
        "group": "web_playback",
        "label": "Input cloud HLS",
        "type": "enum",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "options": ["http_range", "pipe", "auto"],
        "description": "Modo de entrada usado pelo FFmpeg para HLS cloud.",
    },
    "WEB_PLAYBACK_HLS_STARTUP_TIMEOUT_SECONDS": {
        "group": "web_playback",
        "label": "Timeout startup HLS",
        "type": "int",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Tempo maximo para o HLS Web ficar pronto.",
    },
    "RELATED_SUBTITLE_DIR_NAMES": {
        "group": "web_playback",
        "label": "Pastas relacionadas de legenda",
        "type": "csv",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "description": "Lista de nomes de pastas usadas para buscar legendas relacionadas.",
    },
    "MKV_UPLOAD_EXTERNALIZE_SUBTITLES_MODE": {
        "group": "web_playback",
        "label": "Externalizacao de legendas MKV",
        "type": "enum",
        "mutable": True,
        "secret": False,
        "apply_mode": "hot_reload",
        "options": ["off", "compatible", "strict"],
        "description": "Modo de externalizacao de legendas no upload de MKV.",
    },
}

GROUP_META = {
    "telegram": {"label": "Telegram", "order": 10},
    "database": {"label": "Banco de Dados", "order": 20},
    "server": {"label": "Servidor", "order": 30},
    "access": {"label": "Acesso e Seguranca", "order": 40},
    "performance": {"label": "Performance", "order": 50},
    "cache": {"label": "Cache e PDF", "order": 60},
    "archive": {"label": "Arquivamento", "order": 70},
    "sync": {"label": "Sync e FUSE", "order": 80},
    "sharing": {"label": "Compartilhamento", "order": 85},
    "web_playback": {"label": "Playback Web", "order": 90},
    "diagnostics": {"label": "Diagnostico", "order": 100},
}

ENV_KEY_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")


def get_store_path(runtime_dir: Path) -> Path:
    return Path(runtime_dir) / "config" / "managed_settings.json"


def env_mirror_enabled() -> bool:
    raw = str(os.getenv("TCLOUD_SETTINGS_ENV_MIRROR", "true") or "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def get_env_path(base_dir: Path) -> Path:
    return Path(base_dir) / ".env"


def load_env_lines(env_path: Path) -> list[str]:
    return env_path.read_text(encoding="utf-8").splitlines(keepends=True)


def _env_line_key(line: str) -> str | None:
    match = ENV_KEY_RE.match(line)
    return match.group(1) if match else None


def load_env_values(env_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not env_path.exists():
        return values
    for line in load_env_lines(env_path):
        key = _env_line_key(line)
        if not key:
            continue
        _, raw_value = line.split("=", 1)
        values[key] = raw_value.rstrip("\r\n").strip()
    return values


def inspect_env_mirror(base_dir: Path, managed_values: dict | None = None) -> dict:
    env_path = get_env_path(base_dir)
    enabled = env_mirror_enabled()
    exists = env_path.exists()
    parent = env_path.parent if env_path.parent.exists() else Path(base_dir)
    writable = bool(enabled and os.access(parent, os.W_OK))
    reason = ""
    read_error = ""
    env_values: dict[str, str] = {}
    divergent_keys: list[str] = []

    if not enabled:
        reason = "env_mirror_disabled"
    elif not exists:
        reason = "env_file_missing"

    if exists:
        try:
            env_values = load_env_values(env_path)
        except OSError as exc:
            read_error = str(exc)
            reason = "env_read_failed"
        else:
            for key, value in (managed_values or {}).items():
                if key not in SETTINGS_SCHEMA:
                    continue
                if env_values.get(key) != serialize_env_value(key, value):
                    divergent_keys.append(key)

    return {
        "enabled": enabled,
        "path": str(env_path),
        "exists": exists,
        "writable": writable,
        "reason": reason,
        "read_error": read_error,
        "divergent_keys": sorted(divergent_keys),
    }


def save_env_updates(base_dir: Path, updates: dict[str, str], *, create_if_missing: bool = False) -> dict:
    env_path = get_env_path(base_dir)
    status = inspect_env_mirror(base_dir)
    result = {
        "ok": False,
        "skipped": False,
        "reason": "",
        "error": "",
        "path": str(env_path),
        "created": False,
        "changed": False,
        "updated_keys": [],
        "added_keys": [],
        "unchanged_keys": [],
    }

    if not updates:
        result["ok"] = True
        return result

    if not status["enabled"]:
        result["skipped"] = True
        result["reason"] = status["reason"] or "env_mirror_disabled"
        return result

    if not env_path.exists() and not create_if_missing:
        result["skipped"] = True
        result["reason"] = "env_file_missing"
        return result

    try:
        lines = load_env_lines(env_path) if env_path.exists() else []
    except OSError as exc:
        result["error"] = str(exc)
        result["reason"] = "env_read_failed"
        return result

    for key, value in updates.items():
        rendered = f"{key}={value}\n"
        indexes = [index for index, line in enumerate(lines) if _env_line_key(line) == key]
        if indexes:
            line_index = indexes[0]
            duplicate_indexes = indexes[1:]
            if lines[line_index] == rendered and not duplicate_indexes:
                result["unchanged_keys"].append(key)
                continue
            lines[line_index] = rendered
            for duplicate_index in reversed(duplicate_indexes):
                del lines[duplicate_index]
            result["updated_keys"].append(key)
            result["changed"] = True
            continue

        if lines and not lines[-1].endswith("\n"):
            lines[-1] = f"{lines[-1]}\n"
        lines.append(rendered)
        result["added_keys"].append(key)
        result["changed"] = True

    if not env_path.exists():
        result["created"] = True
        result["changed"] = True

    if not result["changed"]:
        result["ok"] = True
        return result

    try:
        env_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = env_path.with_suffix(".tmp")
        tmp_path.write_text("".join(lines), encoding="utf-8")
        tmp_path.replace(env_path)
    except OSError as exc:
        result["error"] = str(exc)
        result["reason"] = "env_write_failed"
        return result

    result["ok"] = True
    return result


def default_store_payload() -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": None,
        "values": {},
        "pending_restart_keys": [],
        "last_known_good_values": {},
    }


def load_store(runtime_dir: Path) -> dict:
    path = get_store_path(runtime_dir)
    if not path.exists():
        return default_store_payload()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default_store_payload()
    payload = default_store_payload()
    if isinstance(raw, dict):
        payload.update({k: v for k, v in raw.items() if k in payload})
    if not isinstance(payload.get("values"), dict):
        payload["values"] = {}
    if not isinstance(payload.get("last_known_good_values"), dict):
        payload["last_known_good_values"] = {}
    if not isinstance(payload.get("pending_restart_keys"), list):
        payload["pending_restart_keys"] = []
    return payload


def save_store(runtime_dir: Path, payload: dict) -> Path:
    path = get_store_path(runtime_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = default_store_payload()
    normalized.update(deepcopy(payload))
    normalized["schema_version"] = SCHEMA_VERSION
    normalized["updated_at"] = datetime.now(timezone.utc).isoformat()
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(normalized, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf-8")
    tmp_path.replace(path)
    return path


def normalize_value(key: str, value):
    spec = SETTINGS_SCHEMA[key]
    value_type = spec["type"]

    if value_type == "bool":
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in {"true", "1", "yes", "on"}:
            return True
        if text in {"false", "0", "no", "off"}:
            return False
        raise ValueError("esperado booleano")

    if value_type == "int":
        return int(str(value).strip())

    if value_type == "csv":
        if isinstance(value, list):
            items = [str(item).strip() for item in value if str(item).strip()]
        else:
            text = str(value).replace("\n", ",")
            items = [item.strip() for item in text.split(",") if item.strip()]
        if key == "BOT_TOKENS" and not items:
            raise ValueError("ao menos um token e obrigatorio")
        return items

    if value_type == "enum":
        text = str(value).strip()
        options = spec.get("options") or []
        if text not in options:
            raise ValueError(f"valor invalido; esperado um de {', '.join(options)}")
        return text

    text = str(value).strip()
    if key == "PASSIVE_PORTS":
        if "-" not in text:
            raise ValueError("formato esperado: inicio-fim")
        start, end = text.split("-", 1)
        if int(start) > int(end):
            raise ValueError("intervalo invalido")
        return f"{int(start)}-{int(end)}"
    return text


def serialize_env_value(key: str, value) -> str:
    spec = SETTINGS_SCHEMA[key]
    value_type = spec["type"]
    if value_type == "bool":
        return "true" if value else "false"
    if value_type == "csv":
        return ",".join(str(item) for item in value)
    return str(value)


def public_schema() -> dict:
    groups: list[dict] = []
    grouped: dict[str, list[dict]] = {}
    for key, spec in SETTINGS_SCHEMA.items():
        group_id = spec["group"]
        grouped.setdefault(group_id, []).append(
            {
                "key": key,
                "label": spec["label"],
                "type": spec["type"],
                "mutable": bool(spec["mutable"]),
                "secret": bool(spec["secret"]),
                "apply_mode": spec["apply_mode"],
                "description": spec.get("description", ""),
                "options": list(spec.get("options") or []),
            }
        )
    for group_id, fields in sorted(grouped.items(), key=lambda item: GROUP_META.get(item[0], {}).get("order", 999)):
        groups.append(
            {
                "id": group_id,
                "label": GROUP_META.get(group_id, {}).get("label", group_id),
                "fields": sorted(fields, key=lambda field: field["label"].lower()),
            }
        )
    return {"schema_version": SCHEMA_VERSION, "groups": groups}
