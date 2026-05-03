from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from app_permissions import (
    compute_allowed_functions,
    compute_granted_permissions,
    normalize_permission_policy,
    normalize_requested_functions,
    normalize_requested_permissions,
)

SCHEMA_VERSION = "2026-04-13-apps-v1"


def get_registry_path(runtime_dir: Path) -> Path:
    return Path(runtime_dir) / "config" / "apps_registry.json"


def default_registry_payload() -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": None,
        "apps": {},
    }


def load_registry(runtime_dir: Path) -> dict:
    path = get_registry_path(runtime_dir)
    if not path.exists():
        return default_registry_payload()

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default_registry_payload()

    payload = default_registry_payload()
    if isinstance(raw, dict):
        payload.update({key: value for key, value in raw.items() if key in payload})
    if not isinstance(payload.get("apps"), dict):
        payload["apps"] = {}
    return payload


def save_registry(runtime_dir: Path, payload: dict) -> Path:
    path = get_registry_path(runtime_dir)
    path.parent.mkdir(parents=True, exist_ok=True)

    normalized = default_registry_payload()
    normalized.update(deepcopy(payload))
    normalized["schema_version"] = SCHEMA_VERSION
    normalized["updated_at"] = datetime.now(timezone.utc).isoformat()

    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(normalized, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf-8")
    tmp_path.replace(path)
    return path


def build_registry_entry(
    manifest: dict,
    *,
    source: dict,
    existing: dict | None = None,
    install_id: str | None = None,
) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    existing = deepcopy(existing or {})
    existing_source = existing.get("source") or {}
    requested_permissions = normalize_requested_permissions(manifest)
    requested_functions = normalize_requested_functions(manifest)

    system = bool(manifest.get("system"))
    protected = bool(manifest.get("protected")) or system
    trust_level = str(manifest.get("trust_level") or ("system" if system else "scoped")).strip().lower()
    if trust_level not in {"system", "trusted", "scoped"}:
        trust_level = "system" if system else "scoped"

    auto_grant = trust_level == "system"
    raw_policies = existing.get("permission_policies") or {}
    permission_policies = {}
    for permission_id in requested_permissions:
        permission_policies[permission_id] = normalize_permission_policy(
            permission_id,
            raw_policies.get(permission_id),
            auto_grant=auto_grant,
        )

    granted_permissions = compute_granted_permissions(permission_policies, requested_permissions)
    allowed_functions = compute_allowed_functions(requested_functions, permission_policies)

    state = existing.get("state") or {}
    entry = {
        "install_id": existing.get("install_id") or install_id or f"{source.get('type', 'app')}-{manifest['id']}",
        "manifest_snapshot": {
            "id": manifest["id"],
            "name": manifest.get("name", manifest["id"]),
            "version": manifest.get("version", "1.0.0"),
            "category": manifest.get("category", "custom"),
            "description": manifest.get("description", ""),
            "icon": manifest.get("icon", "ph-app-window"),
        },
        "source": {
            "type": source.get("type", existing_source.get("type", "bundled")),
            "location": source.get("location", existing_source.get("location", "")),
            "url": source.get("url", existing_source.get("url", "")),
            "repo": source.get("repo", existing_source.get("repo", "")),
            "ref": source.get("ref", existing_source.get("ref", "")),
            "subdir": source.get("subdir", existing_source.get("subdir", "")),
            "checksum": source.get("checksum", existing_source.get("checksum", "")),
        },
        "state": {
            "enabled": bool(state.get("enabled", True)),
            "protected": protected,
            "system": system,
            "installed_at": state.get("installed_at") or now,
            "updated_at": state.get("updated_at") or now,
            "disabled_at": state.get("disabled_at"),
        },
        "trust_level": trust_level,
        "requested_permissions": requested_permissions,
        "requested_functions": requested_functions,
        "permission_policies": permission_policies,
        "granted_permissions": granted_permissions,
        "allowed_functions": allowed_functions,
    }
    return entry
