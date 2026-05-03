from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


def get_audit_path(runtime_dir: Path) -> Path:
    return Path(runtime_dir) / "logs" / "app_audit.jsonl"


def append_audit_event(runtime_dir: Path, event_type: str, *, app_id: str | None = None, details: dict | None = None) -> None:
    path = get_audit_path(runtime_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event_type,
        "app_id": app_id or "",
        "details": details or {},
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n")


def load_audit_events(runtime_dir: Path, *, app_id: str | None = None, limit: int = 50) -> list[dict]:
    path = get_audit_path(runtime_dir)
    if not path.exists():
        return []

    events = []
    with path.open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            raw = line.strip()
            if not raw:
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if app_id and event.get("app_id") != app_id:
                continue
            events.append(event)
    return list(reversed(events[-limit:]))

