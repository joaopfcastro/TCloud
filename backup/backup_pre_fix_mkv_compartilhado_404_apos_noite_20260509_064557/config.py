"""
TCloud - Configuration Module
Loads and validates settings from .env file.
"""

from __future__ import annotations

import os
import sys
import logging
import secrets
from copy import deepcopy
from pathlib import Path
from dotenv import load_dotenv
from managed_config import (
    SETTINGS_SCHEMA,
    env_mirror_enabled,
    get_env_path,
    inspect_env_mirror,
    load_store,
    normalize_value,
    public_schema,
    save_env_updates,
    serialize_env_value,
)

# Load .env from project root
load_dotenv(Path(__file__).parent / ".env")

logger = logging.getLogger("tcloud.config")


class Config:
    """Singleton configuration loaded from environment variables."""

    # === Telegram ===
    API_ID: int = 0
    API_HASH: str = ""
    BOT_TOKENS: list[str] = []
    CHAT_ID: int = 0

    # === MongoDB ===
    MONGODB_URI: str = "mongodb://localhost:27017"
    DB_NAME: str = "tcloud"

    # === FTP Server ===
    FTP_HOST: str = "0.0.0.0"
    FTP_PORT: int = 2121
    FTP_USER: str = "tcloud"
    FTP_PASS: str = "tcloud123"
    PASSIVE_PORTS: range = range(60000, 60101)

    # === HTTP Streaming Server ===
    HTTP_HOST: str = "::"
    HTTP_PORT: int = 8080

    # === Authentication ===
    AUTH_ENABLED: bool = False
    AUTH_USERNAME: str = ""
    AUTH_PASSWORD: str = ""
    JWT_SECRET: str = ""
    JWT_EXPIRY_HOURS: int = 72

    # === SSL/TLS ===
    SSL_CERT: str = ""
    SSL_KEY: str = ""

    # === Performance ===
    MAX_WORKERS: int = 6
    CHUNK_SIZE_MB: int = 64
    CHUNK_SIZE_BYTES: int = 64 * 1024 * 1024
    MAX_RETRIES: int = 5
    MAX_STAGING_AGE: int = 3600  # seconds
    TELEGRAM_OPAQUE_FILENAMES: bool = True

    # === Download Cache ===
    CACHE_DIR: Path = Path(__file__).parent / "staging" / "cache"
    CACHE_MAX_GB: int = 10
    CACHE_PREFETCH_CHUNKS: int = 4
    PDF_THUMB_MAX_MB: int = 80
    PDF_THUMB_CONCURRENCY: int = 1
    PDF_THUMB_NEGATIVE_CACHE_TTL: int = 1800

    # === Archive ===
    ARCHIVE_ENABLED: bool = True
    ARCHIVE_MAX_SOURCE_MB: int = 4096
    ARCHIVE_MAX_EXTRACTED_MB: int = 8192
    ARCHIVE_MAX_ENTRY_COUNT: int = 5000
    ARCHIVE_UPLOAD_CONCURRENCY: int = 2
    ARCHIVE_DEFAULT_FORMAT: str = "zip"
    ARCHIVE_DEFAULT_OVERWRITE_MODE: str = "auto_rename"
    ARCHIVE_DEFAULT_EXTRACT_MODE: str = "new_folder"
    ARCHIVE_ALLOW_PASSWORD_INPUT: bool = True
    ARCHIVE_STREAMING_COMPRESS_ENABLED: bool = True
    ARCHIVE_STREAMING_COMPRESS_FORMATS: str = "zip,tar.gz"
    ARCHIVE_STREAMING_EXTRACT_ENABLED: bool = True
    ARCHIVE_STREAMING_EXTRACT_FORMATS: str = "zip,tar.gz"
    ARCHIVE_STREAMING_EXTRACT_BACKEND: str = "bsdtar"

    # === Public Sharing ===
    PUBLIC_SHARE_ENABLED: bool = True
    PUBLIC_SHARE_ALLOW_FILE_SHARING: bool = True
    PUBLIC_SHARE_ALLOW_FOLDER_SHARING: bool = True
    PUBLIC_SHARE_REQUIRE_PASSWORD_BY_DEFAULT: bool = False
    PUBLIC_SHARE_DEFAULT_EXPIRY_HOURS: int = 0
    PUBLIC_SHARE_MAX_EXPIRY_HOURS: int = 0
    PUBLIC_SHARE_DEFAULT_MAX_ACCESS: int = 0
    PUBLIC_SHARE_MAX_ACCESS_LIMIT: int = 100000
    PUBLIC_SHARE_ALLOW_ZIP_DOWNLOAD: bool = True
    PUBLIC_SHARE_SESSION_TTL_SECONDS: int = 1800
    PUBLIC_SHARE_METRICS_TTL_SECONDS: int = 60
    PUBLIC_SHARE_METRICS_CONCURRENCY: int = 2
    PUBLIC_SHARE_SHOW_MEDIA_PREVIEW: bool = True
    PUBLIC_SHARE_AUDIT_LOG_ENABLED: bool = True

    # === TCloud Sync Drive ===
    SYNC_ENABLED: bool = True
    SYNC_DIR: Path = Path.home() / "TCloud_Sync"
    FUSE_ENABLED: bool = sys.platform == "darwin"

    # === Logging ===
    LOG_LEVEL: str = "INFO"

    # === Paths ===
    BASE_DIR: Path = Path(__file__).parent
    STAGING_DIR: Path = Path(__file__).parent / "staging"
    RUNTIME_DIR: Path = Path(__file__).parent / "staging"

    _loaded: bool = False
    _managed_store_payload: dict = {}
    _managed_keys: set[str] = set()
    _pending_restart_keys: set[str] = set()
    _last_persistence_report: dict = {}

    @classmethod
    def load(cls) -> None:
        """Load configuration from environment variables."""
        if cls._loaded:
            return

        cls.RUNTIME_DIR = Path(
            os.getenv("TCLOUD_RUNTIME_DIR", str(cls.BASE_DIR / "staging"))
        ).expanduser()
        cls.STAGING_DIR = cls.RUNTIME_DIR

        # --- Required fields ---
        cls.API_ID = cls._require_int("API_ID")
        cls.API_HASH = cls._require("API_HASH")

        tokens_raw = cls._require("BOT_TOKENS")
        cls.BOT_TOKENS = [t.strip() for t in tokens_raw.split(",") if t.strip()]
        if not cls.BOT_TOKENS:
            cls._fatal("BOT_TOKENS must contain at least one bot token")

        cls.CHAT_ID = cls._require_int("CHAT_ID")
        cls.TELEGRAM_OPAQUE_FILENAMES = os.getenv(
            "TELEGRAM_OPAQUE_FILENAMES",
            str(cls.TELEGRAM_OPAQUE_FILENAMES)
        ).lower() in ("true", "1", "yes")

        # --- Optional fields ---
        cls.MONGODB_URI = os.getenv("MONGODB_URI", cls.MONGODB_URI)
        cls.DB_NAME = os.getenv("DB_NAME", cls.DB_NAME)

        cls.FTP_HOST = os.getenv("FTP_HOST", cls.FTP_HOST)
        cls.FTP_PORT = int(os.getenv("FTP_PORT", str(cls.FTP_PORT)))
        cls.FTP_USER = os.getenv("FTP_USER", cls.FTP_USER)
        cls.FTP_PASS = os.getenv("FTP_PASS", cls.FTP_PASS)

        passive_raw = os.getenv("PASSIVE_PORTS", "60000-60100")
        try:
            start, end = passive_raw.split("-")
            cls.PASSIVE_PORTS = range(int(start), int(end) + 1)
        except ValueError:
            cls._fatal(f"PASSIVE_PORTS format invalid: '{passive_raw}'. Expected: start-end")

        cls.MAX_WORKERS = int(os.getenv("MAX_WORKERS", str(cls.MAX_WORKERS)))
        cls.CHUNK_SIZE_MB = int(os.getenv("CHUNK_SIZE_MB", str(cls.CHUNK_SIZE_MB)))
        cls.CHUNK_SIZE_BYTES = cls.CHUNK_SIZE_MB * 1024 * 1024
        cls.MAX_RETRIES = int(os.getenv("MAX_RETRIES", str(cls.MAX_RETRIES)))
        cls.MAX_STAGING_AGE = int(os.getenv("MAX_STAGING_AGE", str(cls.MAX_STAGING_AGE)))

        cls.CACHE_MAX_GB = int(os.getenv("CACHE_MAX_GB", str(cls.CACHE_MAX_GB)))
        cls.CACHE_PREFETCH_CHUNKS = int(os.getenv("CACHE_PREFETCH_CHUNKS", str(cls.CACHE_PREFETCH_CHUNKS)))
        cls.PDF_THUMB_MAX_MB = int(os.getenv("PDF_THUMB_MAX_MB", str(cls.PDF_THUMB_MAX_MB)))
        cls.PDF_THUMB_CONCURRENCY = max(1, int(os.getenv("PDF_THUMB_CONCURRENCY", str(cls.PDF_THUMB_CONCURRENCY))))
        cls.PDF_THUMB_NEGATIVE_CACHE_TTL = max(60, int(os.getenv("PDF_THUMB_NEGATIVE_CACHE_TTL", str(cls.PDF_THUMB_NEGATIVE_CACHE_TTL))))
        cls.ARCHIVE_ENABLED = os.getenv("ARCHIVE_ENABLED", str(cls.ARCHIVE_ENABLED)).lower() in ("true", "1", "yes")
        cls.ARCHIVE_MAX_SOURCE_MB = max(64, int(os.getenv("ARCHIVE_MAX_SOURCE_MB", str(cls.ARCHIVE_MAX_SOURCE_MB))))
        cls.ARCHIVE_MAX_EXTRACTED_MB = max(128, int(os.getenv("ARCHIVE_MAX_EXTRACTED_MB", str(cls.ARCHIVE_MAX_EXTRACTED_MB))))
        cls.ARCHIVE_MAX_ENTRY_COUNT = max(1, int(os.getenv("ARCHIVE_MAX_ENTRY_COUNT", str(cls.ARCHIVE_MAX_ENTRY_COUNT))))
        cls.ARCHIVE_UPLOAD_CONCURRENCY = max(1, int(os.getenv("ARCHIVE_UPLOAD_CONCURRENCY", str(cls.ARCHIVE_UPLOAD_CONCURRENCY))))
        cls.ARCHIVE_DEFAULT_FORMAT = os.getenv("ARCHIVE_DEFAULT_FORMAT", cls.ARCHIVE_DEFAULT_FORMAT).strip().lower() or "zip"
        cls.ARCHIVE_DEFAULT_OVERWRITE_MODE = os.getenv("ARCHIVE_DEFAULT_OVERWRITE_MODE", cls.ARCHIVE_DEFAULT_OVERWRITE_MODE).strip().lower() or "auto_rename"
        cls.ARCHIVE_DEFAULT_EXTRACT_MODE = os.getenv("ARCHIVE_DEFAULT_EXTRACT_MODE", cls.ARCHIVE_DEFAULT_EXTRACT_MODE).strip().lower() or "new_folder"
        cls.ARCHIVE_ALLOW_PASSWORD_INPUT = os.getenv("ARCHIVE_ALLOW_PASSWORD_INPUT", str(cls.ARCHIVE_ALLOW_PASSWORD_INPUT)).lower() in ("true", "1", "yes")
        cls.ARCHIVE_STREAMING_COMPRESS_ENABLED = os.getenv(
            "ARCHIVE_STREAMING_COMPRESS_ENABLED",
            str(cls.ARCHIVE_STREAMING_COMPRESS_ENABLED),
        ).lower() in ("true", "1", "yes")
        cls.ARCHIVE_STREAMING_COMPRESS_FORMATS = (
            os.getenv("ARCHIVE_STREAMING_COMPRESS_FORMATS", cls.ARCHIVE_STREAMING_COMPRESS_FORMATS).strip().lower()
            or "zip,tar.gz"
        )
        cls.ARCHIVE_STREAMING_EXTRACT_ENABLED = os.getenv(
            "ARCHIVE_STREAMING_EXTRACT_ENABLED",
            str(cls.ARCHIVE_STREAMING_EXTRACT_ENABLED),
        ).lower() in ("true", "1", "yes")
        cls.ARCHIVE_STREAMING_EXTRACT_FORMATS = (
            os.getenv("ARCHIVE_STREAMING_EXTRACT_FORMATS", cls.ARCHIVE_STREAMING_EXTRACT_FORMATS).strip().lower()
            or "zip,tar.gz,7z,rar"
        )
        cls.ARCHIVE_STREAMING_EXTRACT_BACKEND = (
            os.getenv("ARCHIVE_STREAMING_EXTRACT_BACKEND", cls.ARCHIVE_STREAMING_EXTRACT_BACKEND).strip()
            or "bsdtar"
        )
        cls.PUBLIC_SHARE_ENABLED = os.getenv("PUBLIC_SHARE_ENABLED", str(cls.PUBLIC_SHARE_ENABLED)).lower() in ("true", "1", "yes")
        cls.PUBLIC_SHARE_ALLOW_FILE_SHARING = os.getenv("PUBLIC_SHARE_ALLOW_FILE_SHARING", str(cls.PUBLIC_SHARE_ALLOW_FILE_SHARING)).lower() in ("true", "1", "yes")
        cls.PUBLIC_SHARE_ALLOW_FOLDER_SHARING = os.getenv("PUBLIC_SHARE_ALLOW_FOLDER_SHARING", str(cls.PUBLIC_SHARE_ALLOW_FOLDER_SHARING)).lower() in ("true", "1", "yes")
        cls.PUBLIC_SHARE_REQUIRE_PASSWORD_BY_DEFAULT = os.getenv("PUBLIC_SHARE_REQUIRE_PASSWORD_BY_DEFAULT", str(cls.PUBLIC_SHARE_REQUIRE_PASSWORD_BY_DEFAULT)).lower() in ("true", "1", "yes")
        cls.PUBLIC_SHARE_DEFAULT_EXPIRY_HOURS = max(0, int(os.getenv("PUBLIC_SHARE_DEFAULT_EXPIRY_HOURS", str(cls.PUBLIC_SHARE_DEFAULT_EXPIRY_HOURS))))
        cls.PUBLIC_SHARE_MAX_EXPIRY_HOURS = max(0, int(os.getenv("PUBLIC_SHARE_MAX_EXPIRY_HOURS", str(cls.PUBLIC_SHARE_MAX_EXPIRY_HOURS))))
        cls.PUBLIC_SHARE_DEFAULT_MAX_ACCESS = max(0, int(os.getenv("PUBLIC_SHARE_DEFAULT_MAX_ACCESS", str(cls.PUBLIC_SHARE_DEFAULT_MAX_ACCESS))))
        cls.PUBLIC_SHARE_MAX_ACCESS_LIMIT = max(0, int(os.getenv("PUBLIC_SHARE_MAX_ACCESS_LIMIT", str(cls.PUBLIC_SHARE_MAX_ACCESS_LIMIT))))
        cls.PUBLIC_SHARE_ALLOW_ZIP_DOWNLOAD = os.getenv("PUBLIC_SHARE_ALLOW_ZIP_DOWNLOAD", str(cls.PUBLIC_SHARE_ALLOW_ZIP_DOWNLOAD)).lower() in ("true", "1", "yes")
        cls.PUBLIC_SHARE_SESSION_TTL_SECONDS = max(60, int(os.getenv("PUBLIC_SHARE_SESSION_TTL_SECONDS", str(cls.PUBLIC_SHARE_SESSION_TTL_SECONDS))))
        cls.PUBLIC_SHARE_METRICS_TTL_SECONDS = max(5, int(os.getenv("PUBLIC_SHARE_METRICS_TTL_SECONDS", str(cls.PUBLIC_SHARE_METRICS_TTL_SECONDS))))
        cls.PUBLIC_SHARE_METRICS_CONCURRENCY = max(1, int(os.getenv("PUBLIC_SHARE_METRICS_CONCURRENCY", str(cls.PUBLIC_SHARE_METRICS_CONCURRENCY))))
        cls.PUBLIC_SHARE_SHOW_MEDIA_PREVIEW = os.getenv("PUBLIC_SHARE_SHOW_MEDIA_PREVIEW", str(cls.PUBLIC_SHARE_SHOW_MEDIA_PREVIEW)).lower() in ("true", "1", "yes")
        cls.PUBLIC_SHARE_AUDIT_LOG_ENABLED = os.getenv("PUBLIC_SHARE_AUDIT_LOG_ENABLED", str(cls.PUBLIC_SHARE_AUDIT_LOG_ENABLED)).lower() in ("true", "1", "yes")
        cache_dir_env = os.getenv("CACHE_DIR")
        if cache_dir_env:
            cls.CACHE_DIR = Path(cache_dir_env).expanduser()
        else:
            cls.CACHE_DIR = cls.STAGING_DIR / "cache"
        cls.CACHE_DIR.mkdir(parents=True, exist_ok=True)

        cls.HTTP_HOST = os.getenv("HTTP_HOST", cls.HTTP_HOST)
        cls.HTTP_PORT = int(os.getenv("HTTP_PORT", str(cls.HTTP_PORT)))

        # --- Authentication ---
        cls.AUTH_ENABLED = os.getenv("AUTH_ENABLED", "false").lower() in ("true", "1", "yes")
        cls.AUTH_USERNAME = os.getenv("AUTH_USERNAME", cls.FTP_USER)
        cls.AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", cls.FTP_PASS)
        cls.JWT_SECRET = os.getenv("JWT_SECRET", "")
        if not cls.JWT_SECRET:
            cls.JWT_SECRET = secrets.token_hex(32)
            env_result = save_env_updates(cls.BASE_DIR, {"JWT_SECRET": cls.JWT_SECRET}, create_if_missing=True)
            if env_result.get("ok"):
                logger.info("🔑 JWT_SECRET auto-generated and saved to .env")
            elif env_result.get("skipped"):
                logger.warning(
                    "JWT_SECRET auto-generated (env mirror skipped: %s)",
                    env_result.get("reason") or "unknown",
                )
            else:
                logger.warning(
                    "JWT_SECRET auto-generated (could not save to .env: %s)",
                    env_result.get("error") or env_result.get("reason") or "unknown",
                )
        cls.JWT_EXPIRY_HOURS = int(os.getenv("JWT_EXPIRY_HOURS", str(cls.JWT_EXPIRY_HOURS)))

        # --- SSL/TLS ---
        cls.SSL_CERT = os.getenv("SSL_CERT", "")
        cls.SSL_KEY = os.getenv("SSL_KEY", "")

        cls.SYNC_ENABLED = os.getenv("SYNC_ENABLED", "true").lower() in ("true", "1", "yes")
        sync_dir_env = os.getenv("SYNC_DIR")
        if sync_dir_env:
            cls.SYNC_DIR = Path(sync_dir_env).expanduser()
        
        # Ensure Sync directory exists
        if cls.SYNC_ENABLED:
            cls.SYNC_DIR.mkdir(parents=True, exist_ok=True)
            
        cls.FUSE_ENABLED = os.getenv("FUSE_ENABLED", str(cls.FUSE_ENABLED)).lower() in ("true", "1", "yes")

        cls.LOG_LEVEL = os.getenv("LOG_LEVEL", cls.LOG_LEVEL).upper()

        # Ensure staging directory exists
        cls.STAGING_DIR.mkdir(parents=True, exist_ok=True)

        cls._apply_managed_overrides()

        cls._loaded = True
        cls._print_config()

    @classmethod
    def _apply_managed_overrides(cls) -> None:
        from managed_config import save_store

        payload = load_store(cls.RUNTIME_DIR)
        cls._managed_store_payload = payload
        cls._managed_keys = set()
        had_pending_restart = bool(payload.get("pending_restart_keys"))
        cls._pending_restart_keys = set()
        values = payload.get("values") or {}
        for key, raw_value in values.items():
            if key not in SETTINGS_SCHEMA:
                continue
            try:
                normalized = normalize_value(key, raw_value)
            except Exception:
                continue
            cls._set_config_attr(key, normalized)
            os.environ[key] = serialize_env_value(key, normalized)
            cls._managed_keys.add(key)
        if had_pending_restart:
            payload["pending_restart_keys"] = []
            save_store(cls.RUNTIME_DIR, payload)
            cls._managed_store_payload = payload

    @classmethod
    def _set_config_attr(cls, key: str, value) -> None:
        if key == "BOT_TOKENS":
            cls.BOT_TOKENS = list(value)
            return
        if key == "PASSIVE_PORTS":
            start, end = str(value).split("-", 1)
            cls.PASSIVE_PORTS = range(int(start), int(end) + 1)
            return
        if key == "CHUNK_SIZE_MB":
            cls.CHUNK_SIZE_MB = int(value)
            cls.CHUNK_SIZE_BYTES = cls.CHUNK_SIZE_MB * 1024 * 1024
            return
        if key in {"CACHE_DIR", "STAGING_DIR", "RUNTIME_DIR"}:
            setattr(cls, key, Path(value).expanduser())
            return
        if key in {
            "PUBLIC_SHARE_DEFAULT_EXPIRY_HOURS",
            "PUBLIC_SHARE_MAX_EXPIRY_HOURS",
            "PUBLIC_SHARE_DEFAULT_MAX_ACCESS",
            "PUBLIC_SHARE_MAX_ACCESS_LIMIT",
        }:
            setattr(cls, key, max(0, int(value)))
            return
        if key == "PUBLIC_SHARE_SESSION_TTL_SECONDS":
            cls.PUBLIC_SHARE_SESSION_TTL_SECONDS = max(60, int(value))
            return
        if key == "PUBLIC_SHARE_METRICS_TTL_SECONDS":
            cls.PUBLIC_SHARE_METRICS_TTL_SECONDS = max(5, int(value))
            return
        if key == "PUBLIC_SHARE_METRICS_CONCURRENCY":
            cls.PUBLIC_SHARE_METRICS_CONCURRENCY = max(1, int(value))
            return
        setattr(cls, key, value)

    @classmethod
    def settings_schema(cls) -> dict:
        return public_schema()

    @classmethod
    def runtime_store_path(cls) -> Path:
        from managed_config import get_store_path
        return get_store_path(cls.RUNTIME_DIR)

    @classmethod
    def runtime_apps_dir(cls) -> Path:
        return cls.RUNTIME_DIR / "apps"

    @classmethod
    def runtime_apps_registry_path(cls) -> Path:
        return cls.RUNTIME_DIR / "config" / "apps_registry.json"

    @classmethod
    def runtime_app_audit_path(cls) -> Path:
        return cls.RUNTIME_DIR / "logs" / "app_audit.jsonl"

    @classmethod
    def _get_configured_setting_value(cls, key: str):
        managed_values = (cls._managed_store_payload or {}).get("values") or {}
        if key in managed_values:
            return managed_values[key], "managed"
        return getattr(cls, key, None), "env"

    @classmethod
    def runtime_env_path(cls) -> Path:
        return get_env_path(cls.BASE_DIR)

    @classmethod
    def settings_persistence_status(cls) -> dict:
        managed_values = (cls._managed_store_payload or {}).get("values") or {}
        env_status = inspect_env_mirror(cls.BASE_DIR, managed_values)
        store_path = cls.runtime_store_path()
        return {
            "store": {
                "path": str(store_path),
                "exists": store_path.exists(),
                "managed_key_count": len(managed_values),
                "updated_at": (cls._managed_store_payload or {}).get("updated_at"),
                "schema_version": (cls._managed_store_payload or {}).get("schema_version"),
            },
            "env": {
                **env_status,
                "mirror_enabled": env_mirror_enabled(),
                "last_result": deepcopy(cls._last_persistence_report) if cls._last_persistence_report else None,
            },
        }

    @classmethod
    def settings_payload(cls) -> dict:
        payload = []
        managed_values = (cls._managed_store_payload or {}).get("values") or {}
        env_divergent_keys = set((cls.settings_persistence_status().get("env") or {}).get("divergent_keys") or [])
        for key, spec in SETTINGS_SCHEMA.items():
            configured_value, source = cls._get_configured_setting_value(key)
            effective_value = getattr(cls, key, None)
            is_secret = bool(spec.get("secret"))
            pending_restart = key in cls._pending_restart_keys
            payload.append(
                {
                    "key": key,
                    "group": spec["group"],
                    "label": spec["label"],
                    "type": spec["type"],
                    "mutable": bool(spec["mutable"]),
                    "secret": is_secret,
                    "apply_mode": spec["apply_mode"],
                    "description": spec.get("description", ""),
                    "pending_restart": pending_restart,
                    "source": source,
                    "configured": key in managed_values or effective_value not in (None, "", []),
                    "masked": is_secret,
                    "value": cls._serialize_public_value(configured_value, is_secret),
                    "effective_value": cls._serialize_public_value(effective_value, is_secret),
                    "has_secret_value": bool(configured_value) if is_secret else False,
                    "env_diverged": key in env_divergent_keys,
                }
            )
        return {
            "runtime_dir": str(cls.RUNTIME_DIR),
            "store_path": str(cls.runtime_store_path()),
            "env_path": str(cls.runtime_env_path()),
            "pending_restart_keys": sorted(cls._pending_restart_keys),
            "persistence": cls.settings_persistence_status(),
            "settings": payload,
        }

    @classmethod
    def _serialize_public_value(cls, value, is_secret: bool):
        if is_secret:
            return None
        if isinstance(value, range):
            return f"{value.start}-{value.stop - 1}"
        if isinstance(value, Path):
            return str(value)
        if isinstance(value, list):
            return list(value)
        return value

    @classmethod
    def secret_value_payload(cls, key: str) -> dict:
        if not cls._loaded:
            cls.load()

        spec = SETTINGS_SCHEMA.get(key)
        if not spec:
            raise KeyError("chave desconhecida")
        if not spec.get("secret"):
            raise ValueError("campo nao e secreto")

        configured_value, source = cls._get_configured_setting_value(key)
        has_value = configured_value not in (None, "", [])
        return {
            "key": key,
            "label": spec.get("label", key),
            "value": serialize_env_value(key, configured_value) if has_value else "",
            "source": source,
            "has_value": has_value,
        }

    @classmethod
    def update_managed_settings(cls, changes: dict) -> dict:
        from managed_config import save_store

        if not cls._loaded:
            cls.load()

        field_errors = {}
        normalized_changes = {}

        for key, raw_value in (changes or {}).items():
            spec = SETTINGS_SCHEMA.get(key)
            if not spec:
                field_errors[key] = "chave desconhecida"
                continue
            if not spec.get("mutable"):
                field_errors[key] = "campo nao editavel"
                continue
            if spec.get("secret") and str(raw_value or "").strip() == "":
                field_errors[key] = "valor secreto nao pode ser vazio"
                continue
            try:
                normalized_changes[key] = normalize_value(key, raw_value)
            except Exception as exc:
                field_errors[key] = str(exc)

        if field_errors:
            return {"ok": False, "field_errors": field_errors}

        payload = load_store(cls.RUNTIME_DIR)
        values = dict(payload.get("values") or {})
        pending_restart = set(str(item) for item in payload.get("pending_restart_keys") or [])
        applied_keys = []

        for key, normalized in normalized_changes.items():
            values[key] = normalized
            apply_mode = SETTINGS_SCHEMA[key]["apply_mode"]
            if apply_mode == "hot_reload":
                pending_restart.discard(key)
                applied_keys.append(key)
            else:
                pending_restart.add(key)

        payload["values"] = values
        payload["last_known_good_values"] = dict(values)
        payload["pending_restart_keys"] = sorted(pending_restart)
        try:
            save_store(cls.RUNTIME_DIR, payload)
        except OSError as exc:
            logger.error("Failed to persist managed settings store: %s", exc)
            return {"ok": False, "error": "falha ao persistir configuracao no runtime"}

        env_updates = {key: serialize_env_value(key, normalized) for key, normalized in normalized_changes.items()}
        env_result = save_env_updates(cls.BASE_DIR, env_updates)
        cls._last_persistence_report = deepcopy(env_result)

        cls._managed_store_payload = payload
        cls._managed_keys = set(values.keys())
        cls._pending_restart_keys = set(payload["pending_restart_keys"])

        for key in applied_keys:
            normalized = normalized_changes[key]
            cls._set_config_attr(key, normalized)
            os.environ[key] = serialize_env_value(key, normalized)

        if "LOG_LEVEL" in applied_keys:
            logging.getLogger().setLevel(getattr(logging, cls.LOG_LEVEL, logging.INFO))

        return {
            "ok": True,
            "applied_keys": sorted(applied_keys),
            "pending_restart_keys": sorted(cls._pending_restart_keys),
            "persistence": cls.settings_persistence_status(),
            "settings": cls.settings_payload(),
        }

    @classmethod
    def _require(cls, key: str) -> str:
        value = os.getenv(key)
        if not value:
            cls._fatal(f"Required env variable '{key}' is missing. Check your .env file.")
        return value

    @classmethod
    def _require_int(cls, key: str) -> int:
        raw = cls._require(key)
        try:
            return int(raw)
        except ValueError:
            cls._fatal(f"Env variable '{key}' must be an integer, got: '{raw}'")
            return 0  # unreachable

    @classmethod
    def _fatal(cls, message: str) -> None:
        logger.critical(message)
        print(f"\n❌ FATAL: {message}\n", file=sys.stderr)
        sys.exit(1)

    @classmethod
    def _print_config(cls) -> None:
        logger.info("=" * 50)
        logger.info("  TCloud Configuration")
        logger.info("=" * 50)
        logger.info(f"  Telegram API ID : {cls.API_ID}")
        logger.info(f"  Bot tokens      : {len(cls.BOT_TOKENS)} bot(s)")
        logger.info(f"  Chat ID         : {cls.CHAT_ID}")
        logger.info(f"  Opaque names    : {'Enabled' if cls.TELEGRAM_OPAQUE_FILENAMES else 'Disabled'}")
        logger.info(f"  MongoDB URI     : {cls.MONGODB_URI}")
        logger.info(f"  FTP             : {cls.FTP_HOST}:{cls.FTP_PORT}")
        logger.info(f"  HTTP            : {cls.HTTP_HOST}:{cls.HTTP_PORT}")
        logger.info(f"  Auth            : {'Enabled' if cls.AUTH_ENABLED else 'Disabled'}")
        logger.info(f"  SSL/TLS         : {'Enabled' if cls.SSL_CERT else 'Disabled'}")
        logger.info(f"  Chunk size      : {cls.CHUNK_SIZE_MB} MB")
        logger.info(f"  Max workers     : {cls.MAX_WORKERS}")
        logger.info(f"  Cache           : {cls.CACHE_DIR} (max {cls.CACHE_MAX_GB} GB)")
        logger.info(
            f"  PDF thumbs      : {cls.PDF_THUMB_MAX_MB} MB max, "
            f"{cls.PDF_THUMB_CONCURRENCY} concurrent, "
            f"negative TTL {cls.PDF_THUMB_NEGATIVE_CACHE_TTL}s"
        )
        logger.info(f"  TCloud Sync     : {'Enabled' if cls.SYNC_ENABLED else 'Disabled'} → {cls.SYNC_DIR}")
        logger.info(f"  FUSE Drive      : {'Enabled' if cls.FUSE_ENABLED else 'Disabled'}")
        logger.info(f"  Log level       : {cls.LOG_LEVEL}")
        logger.info("=" * 50)
