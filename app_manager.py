# TCloud — App Manager
# Discovers bundled and runtime-installed apps, merges registry state,
# and exposes metadata for the shell and the Apps panel.

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from app_audit import load_audit_events
from app_permissions import (
    FUNCTION_CATALOG,
    compute_allowed_functions,
    compute_granted_permissions,
    function_catalog_payload,
    normalize_permission_policy,
    normalize_requested_functions,
    normalize_requested_permissions,
    permission_catalog_payload,
)
from app_registry import build_registry_entry, load_registry, save_registry

logger = logging.getLogger("tcloud.apps")

REQUIRED_MANIFEST_FIELDS = {"id", "name", "icon"}
DEFAULT_MANIFEST_FIELDS = {
    "description": "",
    "version": "1.0.0",
    "author": "",
    "order": 999,
    "default": False,
    "featured": False,
    "category": "custom",
    "capabilities": [],
    "accent_color": "",
    "requested_permissions": [],
    "functions": [],
    "system": False,
    "protected": False,
    "trust_level": "scoped",
    "entry": "index.html",
    "min_shell_schema": 3,
}


class AppManager:
    """Scans bundled/runtime apps and overlays the persisted registry state."""

    def __init__(self, apps_dir: Path | None = None, runtime_dir: Path | None = None):
        self._apps_dir = apps_dir or Path(__file__).parent / "apps"
        self._runtime_dir = Path(runtime_dir or os.getenv("TCLOUD_RUNTIME_DIR", str(Path(__file__).parent / "staging")))
        self._runtime_apps_dir = self._runtime_dir / "apps"
        self._apps: dict[str, dict] = {}
        self._registry_payload: dict = {}
        self._scan()

    def _scan_manifest_dirs(self, base_dir: Path, source_type: str) -> list[dict]:
        manifests = []
        if not base_dir.is_dir():
            return manifests

        for entry in sorted(base_dir.iterdir()):
            if not entry.is_dir() or entry.name.startswith("_"):
                continue

            manifest_path = entry / "manifest.json"
            index_path = entry / "index.html"
            if not manifest_path.exists() or not index_path.exists():
                continue

            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                logger.warning("Invalid manifest in %s: %s", entry.name, exc)
                continue

            missing = REQUIRED_MANIFEST_FIELDS - set(manifest.keys())
            if missing:
                logger.warning("App '%s' missing manifest fields: %s", entry.name, sorted(missing))
                continue

            manifests.append(
                {
                    "dir": entry,
                    "manifest": manifest,
                    "source_type": source_type,
                }
            )
        return manifests

    def _normalize_manifest(self, manifest: dict) -> dict:
        normalized = dict(manifest)
        for key, default_value in DEFAULT_MANIFEST_FIELDS.items():
            normalized.setdefault(key, default_value)

        normalized["id"] = str(normalized.get("id") or "").strip().lower()
        normalized["system"] = bool(normalized.get("system") or normalized["id"] == "settings")
        normalized["protected"] = bool(normalized.get("protected") or normalized["system"])
        normalized["trust_level"] = str(
            normalized.get("trust_level") or ("system" if normalized["system"] else "scoped")
        ).strip().lower()
        if normalized["trust_level"] not in {"system", "trusted", "scoped"}:
            normalized["trust_level"] = "system" if normalized["system"] else "scoped"

        normalized["requested_permissions"] = normalize_requested_permissions(normalized)
        normalized["functions"] = normalize_requested_functions(normalized)
        if normalized["system"] and not normalized["functions"]:
            normalized["functions"] = [
                function_id
                for function_id, meta in FUNCTION_CATALOG.items()
                if meta.get("permission") in set(normalized["requested_permissions"])
            ]
        return normalized

    def _compose_app(self, manifest: dict, registry_entry: dict, app_dir: Path) -> dict:
        permission_policies = registry_entry.get("permission_policies") or {}
        requested_permissions = registry_entry.get("requested_permissions") or manifest.get("requested_permissions") or []
        requested_functions = registry_entry.get("requested_functions") or manifest.get("functions") or []
        granted_permissions = compute_granted_permissions(permission_policies, requested_permissions)
        allowed_functions = compute_allowed_functions(requested_functions, permission_policies)

        source = registry_entry.get("source") or {}
        state = registry_entry.get("state") or {}
        app = {
            **manifest,
            "requested_permissions": requested_permissions,
            "requested_functions": requested_functions,
            "permission_policies": permission_policies,
            "granted_permissions": granted_permissions,
            "allowed_functions": allowed_functions,
            "requested_permission_count": len(requested_permissions),
            "granted_permission_count": len(granted_permissions),
            "requested_function_count": len(requested_functions),
            "allowed_function_count": len(allowed_functions),
            "has_pending_permissions": len(granted_permissions) != len(requested_permissions),
            "enabled": bool(state.get("enabled", True)),
            "protected": bool(state.get("protected", manifest.get("protected"))),
            "system": bool(state.get("system", manifest.get("system"))),
            "install_id": registry_entry.get("install_id") or f"{source.get('type', 'app')}-{manifest['id']}",
            "trust_level": registry_entry.get("trust_level") or manifest.get("trust_level"),
            "source_type": source.get("type", "bundled"),
            "source_location": source.get("location", ""),
            "source_url": source.get("url", ""),
            "source_repo": source.get("repo", ""),
            "source_ref": source.get("ref", ""),
            "source_subdir": source.get("subdir", ""),
            "source_checksum": source.get("checksum", ""),
            "installed_at": state.get("installed_at"),
            "updated_at": state.get("updated_at"),
            "_dir": str(app_dir.resolve()),
        }
        return app

    def _scan(self):
        self._runtime_apps_dir.mkdir(parents=True, exist_ok=True)
        registry = load_registry(self._runtime_dir)
        registry.setdefault("apps", {})
        registry_changed = False

        manifests = []
        manifests.extend(self._scan_manifest_dirs(self._apps_dir, "bundled"))
        manifests.extend(self._scan_manifest_dirs(self._runtime_apps_dir, "runtime"))

        next_apps: dict[str, dict] = {}
        present_app_ids = set()
        for candidate in manifests:
            manifest = self._normalize_manifest(candidate["manifest"])
            app_id = manifest["id"]
            present_app_ids.add(app_id)
            existing = registry["apps"].get(app_id)
            existing_source = (existing or {}).get("source") or {}
            source = {
                "type": existing_source.get("type", candidate["source_type"]),
                "location": str(candidate["dir"]),
            }
            built_entry = build_registry_entry(
                manifest,
                source=source,
                existing=existing,
                install_id=(existing or {}).get("install_id"),
            )
            if existing != built_entry:
                registry["apps"][app_id] = built_entry
                registry_changed = True
            next_apps[app_id] = self._compose_app(manifest, registry["apps"][app_id], candidate["dir"])
            logger.info("App loaded: %s (id=%s, source=%s)", manifest["name"], app_id, candidate["source_type"])

        stale_app_ids = [
            app_id
            for app_id, entry in (registry.get("apps") or {}).items()
            if app_id not in present_app_ids and (entry.get("source") or {}).get("type") != "bundled"
        ]
        for stale_app_id in stale_app_ids:
            registry["apps"].pop(stale_app_id, None)
            registry_changed = True

        if registry_changed:
            save_registry(self._runtime_dir, registry)

        self._registry_payload = registry
        self._apps = next_apps
        logger.info("Discovered %s app(s)", len(self._apps))

    def _sorted_apps(self, apps: list[dict]) -> list[dict]:
        apps.sort(
            key=lambda manifest: (
                0 if manifest.get("default") else 1,
                0 if manifest.get("featured") else 1,
                0 if manifest.get("system") else 1,
                int(manifest.get("order", 999)),
                str(manifest.get("name", "")).lower(),
            )
        )
        winner = None
        for manifest in apps:
            if manifest.get("enabled", True):
                winner = manifest["id"]
                break
        for manifest in apps:
            manifest["default"] = manifest["id"] == winner and bool(manifest.get("default"))
        return apps

    def _serialize_app(self, app: dict, *, include_details: bool = False) -> dict:
        public = {key: value for key, value in app.items() if not key.startswith("_")}
        if not include_details:
            for key in ("permission_policies", "requested_permissions", "requested_functions", "allowed_functions", "granted_permissions"):
                public.pop(key, None)
        return public

    def get_apps(self, *, include_disabled: bool = False, include_details: bool = False) -> list[dict]:
        result = []
        for app in self._apps.values():
            if not include_disabled and not app.get("enabled", True):
                continue
            result.append(self._serialize_app(app, include_details=include_details))
        return self._sorted_apps(result)

    def get_app(self, app_id: str, *, include_details: bool = False) -> dict | None:
        app = self._apps.get(app_id)
        if not app:
            return None
        return self._serialize_app(app, include_details=include_details)

    def get_default_app_id(self) -> str | None:
        apps = self.get_apps(include_disabled=False, include_details=False)
        for manifest in apps:
            if manifest.get("default"):
                return manifest["id"]
        return apps[0]["id"] if apps else None

    def get_app_dir(self, app_id: str, *, include_disabled: bool = False) -> Path | None:
        app = self._apps.get(app_id)
        if not app:
            return None
        if not include_disabled and not app.get("enabled", True):
            return None
        return Path(app["_dir"])

    def get_admin_payload(self) -> dict:
        return {
            "apps": self.get_apps(include_disabled=True, include_details=True),
            "permission_catalog": permission_catalog_payload(),
            "function_catalog": function_catalog_payload(),
            "registry_path": str(self._runtime_dir / "config" / "apps_registry.json"),
            "runtime_apps_dir": str(self._runtime_apps_dir),
            "audit_path": str(self._runtime_dir / "logs" / "app_audit.jsonl"),
            "default_app_id": self.get_default_app_id(),
            "schema_version": 3,
        }

    def get_permissions_payload(self, app_id: str) -> dict:
        app = self.get_app(app_id, include_details=True)
        if not app:
            raise KeyError("app nao encontrado")
        return {
            "app": app,
            "permission_catalog": permission_catalog_payload(),
            "function_catalog": function_catalog_payload(),
        }

    def get_audit_payload(self, app_id: str, *, limit: int = 50) -> dict:
        if app_id not in self._apps:
            raise KeyError("app nao encontrado")
        return {
            "app_id": app_id,
            "events": load_audit_events(self._runtime_dir, app_id=app_id, limit=limit),
        }

    def update_permission_policies(self, app_id: str, raw_policies: dict) -> dict:
        app = self._apps.get(app_id)
        if not app:
            raise KeyError("app nao encontrado")

        requested_permissions = app.get("requested_permissions") or []
        normalized = {}
        for permission_id in requested_permissions:
            normalized[permission_id] = normalize_permission_policy(
                permission_id,
                (raw_policies or {}).get(permission_id),
                auto_grant=bool(app.get("trust_level") == "system"),
            )

        registry = load_registry(self._runtime_dir)
        entry = (registry.get("apps") or {}).get(app_id)
        if not entry:
            raise KeyError("registro do app nao encontrado")

        entry["permission_policies"] = normalized
        entry["granted_permissions"] = compute_granted_permissions(normalized, requested_permissions)
        entry["allowed_functions"] = compute_allowed_functions(app.get("requested_functions") or [], normalized)
        registry["apps"][app_id] = entry
        save_registry(self._runtime_dir, registry)
        self.reload()
        return self.get_permissions_payload(app_id)

    def set_enabled(self, app_id: str, enabled: bool) -> dict:
        registry = load_registry(self._runtime_dir)
        entry = (registry.get("apps") or {}).get(app_id)
        if not entry:
            raise KeyError("app nao encontrado")
        state = entry.setdefault("state", {})
        if not enabled and state.get("protected"):
            raise ValueError("app protegido nao pode ser desabilitado")
        state["enabled"] = bool(enabled)
        registry["apps"][app_id] = entry
        save_registry(self._runtime_dir, registry)
        self.reload()
        app = self.get_app(app_id, include_details=True)
        if not app:
            raise KeyError("app nao encontrado apos recarga")
        return app

    def is_protected(self, app_id: str) -> bool:
        app = self._apps.get(app_id)
        return bool(app and app.get("protected"))

    def reload(self):
        self._scan()
