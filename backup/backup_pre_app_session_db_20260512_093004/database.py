"""
TCloud - Database Layer
MongoDB async driver for managing file and directory metadata.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId
from pymongo import ReturnDocument

from config import Config

logger = logging.getLogger("tcloud.database")


class Database:
    """
    Async MongoDB layer for TCloud.
    Manages two collections: 'files' (file metadata) and 'directories' (virtual dir tree).
    """

    def __init__(self):
        self._client: AsyncIOMotorClient | None = None
        self._db = None
        self._files = None
        self._directories = None
        self._trash_files = None
        self._trash_directories = None
        self._pdf_reader_progress = None
        self._pdf_reader_tabs = None
        self._window_layouts = None
        self._finder_sessions = None

    @staticmethod
    def _visible_files_filter(extra: dict | None = None) -> dict:
        query = {"meta.hidden_system_file": {"$ne": True}}
        if extra:
            query.update(extra)
        return query

    async def connect(self) -> None:
        """Connect to MongoDB and initialize collections with indexes."""
        self._client = AsyncIOMotorClient(Config.MONGODB_URI)
        self._db = self._client[Config.DB_NAME]
        self._files = self._db["files"]
        self._directories = self._db["directories"]
        self._trash_files = self._db["trash_files"]
        self._trash_directories = self._db["trash_directories"]
        self._pdf_reader_progress = self._db["pdf_reader_progress"]
        self._pdf_reader_tabs = self._db["pdf_reader_tabs"]
        self._window_layouts = self._db["window_layouts"]
        self._finder_sessions = self._db["finder_sessions"]

        # Create indexes
        await self._files.create_index("path", unique=True)
        await self._files.create_index("sharing.public_id", unique=True, sparse=True)
        await self._directories.create_index("path", unique=True)
        await self._directories.create_index("sharing.public_id", unique=True, sparse=True)
        await self._directories.create_index("parent")
        await self._trash_files.create_index("trash_entry_id", unique=True)
        await self._trash_files.create_index("trash_root_entry_id")
        await self._trash_files.create_index("original_path")
        await self._trash_files.create_index("trashed_at")
        await self._trash_directories.create_index("trash_entry_id", unique=True)
        await self._trash_directories.create_index("trash_root_entry_id")
        await self._trash_directories.create_index("original_path")
        await self._trash_directories.create_index("trashed_at")
        await self._pdf_reader_progress.create_index(
            [("owner_id", 1), ("document_key", 1)],
            unique=True,
        )
        await self._pdf_reader_progress.create_index([("owner_id", 1), ("updated_at", -1)])
        await self._pdf_reader_tabs.create_index(
            [("owner_id", 1), ("app_id", 1)],
            unique=True,
        )
        await self._pdf_reader_tabs.create_index("updated_at")
        await self._window_layouts.create_index(
            [("owner_id", 1), ("window_id", 1)],
            unique=True,
        )
        await self._window_layouts.create_index([("owner_id", 1), ("updated_at", -1)])
        await self._window_layouts.create_index("app_id")
        await self._finder_sessions.create_index("owner_id", unique=True)
        await self._finder_sessions.create_index("updated_at")

        # Ensure root directory exists
        root = await self._directories.find_one({"path": "/"})
        if not root:
            await self._directories.insert_one({
                "path": "/",
                "parent": None,
                "created_at": datetime.now(timezone.utc),
            })

        # Verify connection
        await self._client.admin.command("ping")
        logger.info(f"✅ MongoDB connected: {Config.DB_NAME}")

    async def disconnect(self) -> None:
        """Close MongoDB connection."""
        if self._client:
            self._client.close()
            logger.info("🔌 MongoDB disconnected")

    # ===================== FILE OPERATIONS =====================

    async def create_file(
        self,
        path: str,
        filename: str,
        size: int,
        chunks: list[dict],
        meta: dict = None,
        storage_id: str | None = None,
        storage_scheme: str | None = None,
    ) -> dict:
        """
        Create a file metadata entry.

        Args:
            path: Full virtual path (e.g., '/documents/report.pdf')
            filename: File name
            size: Total file size in bytes
            chunks: List of {'index': int, 'message_id': int, 'size': int}
            meta: Audio metadata (title, artist, etc.)

        Returns:
            The inserted document.
        """
        now = datetime.now(timezone.utc)
        doc = {
            "path": self._normalize_path(path),
            "filename": filename,
            "size": size,
            "chunks": chunks,
            "meta": meta or {},
            "is_directory": False,
            "created_at": now,
            "modified_at": now,
        }
        if storage_id:
            doc["storage_id"] = storage_id
        if storage_scheme:
            doc["storage_scheme"] = storage_scheme
        # Upsert: if file already exists at this path, replace it
        await self._files.replace_one(
            {"path": doc["path"]},
            doc,
            upsert=True,
        )
        logger.info(f"📝 File created: {path} ({len(chunks)} chunk(s), {size} bytes)")
        return doc

    async def get_file(self, path: str) -> dict | None:
        """Get file metadata by virtual path. Tries multiple Unicode normalizations."""
        import unicodedata
        normalized = self._normalize_path(path)
        
        # Try exact match first
        result = await self._files.find_one({"path": normalized})
        if result:
            return result
        
        # Try NFC normalization
        nfc_path = unicodedata.normalize('NFC', normalized)
        result = await self._files.find_one({"path": nfc_path})
        if result:
            return result
        
        # Try NFD normalization (macOS stores paths as NFD)
        nfd_path = unicodedata.normalize('NFD', normalized)
        result = await self._files.find_one({"path": nfd_path})
        if result:
            return result
        
        # LAST RESORT: Mixed encoding fallback
        # Some files have paths with mixed NFC+NFD characters (e.g. macOS copies).
        # We normalize BOTH query and stored values to NFC in Python for comparison.
        filename = normalized.rsplit("/", 1)[-1] if "/" in normalized else normalized
        parent = normalized.rsplit("/", 1)[0] if "/" in normalized[1:] else "/"
        nfc_filename = unicodedata.normalize('NFC', filename)
        nfc_parent = unicodedata.normalize('NFC', parent)
        
        # Search by parent directory regex to narrow down candidates
        if parent == "/":
            regex = r"^/[^/]+$"
        else:
            escaped = re.escape(unicodedata.normalize('NFC', parent))
            escaped_nfd = re.escape(unicodedata.normalize('NFD', parent))
            regex = f"^({escaped}|{escaped_nfd})/[^/]+$"
        
        async for doc in self._files.find({"path": {"$regex": regex}}):
            stored_fn = unicodedata.normalize('NFC', doc.get("filename", ""))
            if stored_fn == nfc_filename:
                return doc
        
        return None

    async def get_file_by_public_id(self, public_id: str) -> dict | None:
        public_id = str(public_id or "").strip()
        if not public_id:
            return None
        return await self._files.find_one({"sharing.public_id": public_id})

    async def delete_file(self, path: str) -> dict | None:
        """
        Delete a file metadata entry and return it (for cleanup).

        Returns:
            The deleted document, or None if not found.
        """
        result = await self._files.find_one_and_delete(
            {"path": self._normalize_path(path)}
        )
        if result:
            logger.info(f"🗑️ File deleted from DB: {path}")
        return result

    async def rename_file(self, old_path: str, new_path: str) -> bool:
        """Rename/move a file by updating its path."""
        old_path = self._normalize_path(old_path)
        new_path = self._normalize_path(new_path)
        new_filename = new_path.rsplit("/", 1)[-1]

        result = await self._files.update_one(
            {"path": old_path},
            {
                "$set": {
                    "path": new_path,
                    "filename": new_filename,
                    "modified_at": datetime.now(timezone.utc),
                }
            },
        )
        return result.modified_count > 0

    async def file_exists(self, path: str) -> bool:
        """Check if a file exists at the given path."""
        doc = await self._files.find_one(
            {"path": self._normalize_path(path)},
            {"_id": 1},
        )
        return doc is not None

    async def update_file_meta_fields(
        self,
        path: str,
        set_fields: dict | None = None,
        unset_fields: list[str] | None = None,
    ) -> bool:
        """Update nested file metadata fields while preserving the rest of the document."""
        target_doc = await self.get_file(path)
        if not target_doc:
            return False

        normalized_set_fields = {
            f"meta.{str(key).removeprefix('meta.')}": value
            for key, value in (set_fields or {}).items()
            if isinstance(key, str) and key.strip()
        }
        normalized_unset_fields = {
            f"meta.{str(key).removeprefix('meta.')}": ""
            for key in (unset_fields or [])
            if isinstance(key, str) and key.strip()
        }
        if not normalized_set_fields and not normalized_unset_fields:
            return False

        update_doc: dict[str, dict] = {
            "$set": {
                "modified_at": datetime.now(timezone.utc),
                **normalized_set_fields,
            }
        }
        if normalized_unset_fields:
            update_doc["$unset"] = normalized_unset_fields

        result = await self._files.update_one({"_id": target_doc["_id"]}, update_doc)
        return result.matched_count > 0

    # ===================== DIRECTORY OPERATIONS =====================

    async def create_directory(self, path: str) -> dict:
        """Create a virtual directory."""
        path = self._normalize_path(path)
        parent = self._parent_path(path)

        doc = {
            "path": path,
            "parent": parent,
            "created_at": datetime.now(timezone.utc),
        }

        try:
            await self._directories.insert_one(doc)
            logger.info(f"📁 Directory created: {path}")
        except Exception:
            # Already exists, that's fine
            pass

        return doc

    async def directory_exists(self, path: str) -> bool:
        """Check if a directory exists. Tries multiple Unicode normalizations."""
        import unicodedata
        normalized = self._normalize_path(path)
        
        # Try exact match first
        doc = await self._directories.find_one({"path": normalized}, {"_id": 1})
        if doc:
            return True
        
        # Try NFC
        nfc_path = unicodedata.normalize('NFC', normalized)
        doc = await self._directories.find_one({"path": nfc_path}, {"_id": 1})
        if doc:
            return True
        
        # Try NFD (macOS stores paths as NFD)
        nfd_path = unicodedata.normalize('NFD', normalized)
        doc = await self._directories.find_one({"path": nfd_path}, {"_id": 1})
        return doc is not None

    async def get_directory_doc(self, path: str) -> dict | None:
        """Get a directory document by virtual path. Tries common Unicode variants."""
        import unicodedata

        normalized = self._normalize_path(path)
        for candidate in (
            normalized,
            unicodedata.normalize("NFC", normalized),
            unicodedata.normalize("NFD", normalized),
        ):
            doc = await self._directories.find_one({"path": candidate})
            if doc:
                return doc
        return None

    async def get_directory_by_public_id(self, public_id: str) -> dict | None:
        public_id = str(public_id or "").strip()
        if not public_id:
            return None
        return await self._directories.find_one({"sharing.public_id": public_id})

    async def get_entry(self, path: str) -> tuple[str | None, dict | None]:
        file_doc = await self.get_file(path)
        if file_doc:
            return "file", file_doc

        dir_doc = await self.get_directory_doc(path)
        if dir_doc:
            return "directory", dir_doc

        return None, None

    async def public_id_exists(self, public_id: str) -> bool:
        public_id = str(public_id or "").strip()
        if not public_id:
            return False
        file_doc = await self._files.find_one({"sharing.public_id": public_id}, {"_id": 1})
        if file_doc:
            return True
        dir_doc = await self._directories.find_one({"sharing.public_id": public_id}, {"_id": 1})
        return dir_doc is not None

    async def find_shared_target(self, public_id: str) -> tuple[str | None, dict | None]:
        file_doc = await self.get_file_by_public_id(public_id)
        if file_doc:
            return "file", file_doc

        dir_doc = await self.get_directory_by_public_id(public_id)
        if dir_doc:
            return "directory", dir_doc

        return None, None

    @staticmethod
    def _serialize_pdf_reader_doc(doc: dict | None) -> dict | None:
        if not doc:
            return None
        serialized = {k: v for k, v in doc.items() if k != "_id"}
        for key, value in list(serialized.items()):
            if isinstance(value, ObjectId):
                serialized[key] = str(value)
            elif isinstance(value, datetime):
                serialized[key] = value.astimezone(timezone.utc).isoformat()
        return serialized

    @staticmethod
    def _parse_pdf_reader_timestamp(value) -> datetime | None:
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        if not value:
            return None
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    @staticmethod
    def _normalize_pdf_page_rotations(value) -> dict:
        if not isinstance(value, dict):
            return {}
        rotations = {}
        for raw_page, raw_rotation in list(value.items())[:1000]:
            try:
                page = max(1, int(raw_page))
                rotation = int(round(float(raw_rotation) / 90.0) * 90) % 360
            except (TypeError, ValueError):
                continue
            if rotation:
                rotations[str(page)] = rotation
        return rotations

    @staticmethod
    def _normalize_window_layout_id(value: str, *, field_name: str = "window_id") -> str:
        normalized = str(value or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9:_-]{1,96}", normalized):
            raise ValueError(f"{field_name} invalido")
        return normalized

    @staticmethod
    def _normalize_window_layout_rect(raw: dict | None, *, fallback: dict | None = None) -> dict:
        source = raw if isinstance(raw, dict) else {}
        fallback_source = fallback if isinstance(fallback, dict) else {}

        def number_for(key: str, default: float) -> float:
            try:
                value = float(source.get(key, fallback_source.get(key, default)))
            except (TypeError, ValueError):
                value = default
            if value != value or value in (float("inf"), float("-inf")):
                value = default
            return value

        width = max(1.0, min(10000.0, number_for("width", 900.0)))
        height = max(1.0, min(10000.0, number_for("height", 620.0)))
        x = max(-10000.0, min(10000.0, number_for("x", 0.0)))
        y = max(-10000.0, min(10000.0, number_for("y", 0.0)))
        return {"x": x, "y": y, "width": width, "height": height}

    @staticmethod
    def _normalize_window_layout_viewport(raw: dict | None) -> dict:
        source = raw if isinstance(raw, dict) else {}

        def positive_number(key: str, default: float) -> float:
            try:
                value = float(source.get(key, default))
            except (TypeError, ValueError):
                value = default
            if value != value or value in (float("inf"), float("-inf")):
                value = default
            return max(0.0, min(10000.0, value))

        return {
            "width": positive_number("width", 0.0),
            "height": positive_number("height", 0.0),
            "devicePixelRatio": max(0.1, min(8.0, positive_number("devicePixelRatio", 1.0) or 1.0)),
        }

    @classmethod
    def _serialize_window_layout_doc(cls, doc: dict | None) -> dict | None:
        return cls._serialize_pdf_reader_doc(doc)

    async def get_window_layout(self, owner_id: str, window_id: str) -> dict | None:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        window_id = self._normalize_window_layout_id(window_id)
        doc = await self._window_layouts.find_one({"owner_id": owner_id, "window_id": window_id})
        return self._serialize_window_layout_doc(doc)

    async def list_window_layouts(self, owner_id: str) -> dict:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        layouts: dict[str, dict] = {}
        latest_updated_at = None
        cursor = self._window_layouts.find({"owner_id": owner_id}).sort("updated_at", -1)
        async for doc in cursor:
            serialized = self._serialize_window_layout_doc(doc)
            if not serialized:
                continue
            window_id = str(serialized.get("window_id") or "").strip()
            if not window_id:
                continue
            layouts[window_id] = serialized
            if latest_updated_at is None:
                latest_updated_at = serialized.get("updated_at")
        return {"layouts": layouts, "updated_at": latest_updated_at}

    async def save_window_layout(self, owner_id: str, window_id: str, payload: dict) -> dict:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        window_id = self._normalize_window_layout_id(window_id)
        payload = dict(payload or {})
        now = datetime.now(timezone.utc)

        status = str(payload.get("status") or "normal").strip().lower()
        if status not in {"normal", "maximized", "snapped"}:
            raise ValueError("status de janela invalido")

        snap_side = str(payload.get("snapSide") or payload.get("snap_side") or "").strip().lower()
        allowed_snap_sides = {
            "",
            "left",
            "right",
            "top",
            "bottom",
            "top-left",
            "top-right",
            "bottom-left",
            "bottom-right",
        }
        if snap_side not in allowed_snap_sides:
            raise ValueError("snapSide invalido")
        if status != "snapped":
            snap_side = ""

        app_id = str(payload.get("app_id") or payload.get("appId") or "").strip()
        if app_id:
            app_id = self._normalize_window_layout_id(app_id, field_name="app_id")

        rect = self._normalize_window_layout_rect(payload.get("rect"))
        restore_rect = self._normalize_window_layout_rect(payload.get("restoreRect") or payload.get("restore_rect"), fallback=rect)
        viewport = self._normalize_window_layout_viewport(payload.get("viewport"))
        last_reason = str(payload.get("last_reason") or payload.get("reason") or "").strip()[:64]
        last_device_id = str(payload.get("last_device_id") or payload.get("device_id") or "").strip()[:128]
        incoming_updated_at = self._parse_pdf_reader_timestamp(payload.get("updated_at"))

        existing = await self._window_layouts.find_one({"owner_id": owner_id, "window_id": window_id})
        existing_updated_at = self._parse_pdf_reader_timestamp((existing or {}).get("updated_at"))
        existing_device_id = str((existing or {}).get("last_device_id") or "").strip()
        if (
            existing
            and incoming_updated_at
            and existing_updated_at
            and incoming_updated_at < existing_updated_at
            and last_device_id
            and existing_device_id
            and last_device_id != existing_device_id
        ):
            return {"layout": self._serialize_window_layout_doc(existing), "conflict": True}

        update_payload = {
            "owner_id": owner_id,
            "window_id": window_id,
            "app_id": app_id,
            "schema_version": 1,
            "status": status,
            "snapSide": snap_side or None,
            "rect": rect,
            "restoreRect": restore_rect,
            "viewport": viewport,
            "last_reason": last_reason,
            "last_device_id": last_device_id,
            "updated_at": now,
        }
        doc = await self._window_layouts.find_one_and_update(
            {"owner_id": owner_id, "window_id": window_id},
            {"$set": update_payload, "$setOnInsert": {"created_at": now}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        logger.debug(
            "window_layout.save owner=%s window=%s status=%s reason=%s",
            owner_id,
            window_id,
            status,
            last_reason,
        )
        return {"layout": self._serialize_window_layout_doc(doc), "conflict": False}

    async def delete_window_layout(self, owner_id: str, window_id: str) -> bool:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        window_id = self._normalize_window_layout_id(window_id)
        result = await self._window_layouts.delete_one({"owner_id": owner_id, "window_id": window_id})
        return bool(getattr(result, "deleted_count", 0))

    @staticmethod
    def _normalize_finder_session_tab(raw: dict | None) -> dict | None:
        if not isinstance(raw, dict):
            return None
        tab_id = str(raw.get("id") or "").strip()[:96]
        mode = str(raw.get("mode") or "cloud").strip().lower()
        if mode not in {"cloud", "local"}:
            mode = "cloud"
        path = str(raw.get("path") or ("/" if mode == "cloud" else ".")).strip()
        if not path:
            path = "/" if mode == "cloud" else "."
        view = str(raw.get("view") or "grid").strip().lower()
        if view not in {"grid", "list"}:
            view = "grid"
        sort = raw.get("sort") if isinstance(raw.get("sort"), dict) else {}
        sort_key = str(sort.get("key") or "type").strip().lower()
        if sort_key not in {"type", "name", "size", "date", "path"}:
            sort_key = "type"
        title = str(raw.get("title") or path.split("/")[-1] or "TCloud").strip()[:160]
        return {
            "id": tab_id or f"file-tab-{abs(hash((mode, path, title))) % 100000000}",
            "title": title,
            "mode": mode,
            "path": path[:2048],
            "view": view,
            "sort": {"key": sort_key, "asc": bool(sort.get("asc", True))},
            "searchQuery": str(raw.get("searchQuery") or "")[:256],
        }

    @classmethod
    def _normalize_finder_session_payload(cls, payload: dict | None) -> dict:
        source = payload if isinstance(payload, dict) else {}
        windows_in = source.get("windows") if isinstance(source.get("windows"), list) else []
        windows: list[dict] = []
        for raw_window in windows_in[:8]:
            if not isinstance(raw_window, dict):
                continue
            window_id = str(raw_window.get("id") or "finder-window-main").strip()[:96] or "finder-window-main"
            tabs_in = raw_window.get("tabs") if isinstance(raw_window.get("tabs"), list) else []
            tabs = [tab for tab in (cls._normalize_finder_session_tab(item) for item in tabs_in[:16]) if tab]
            if not tabs:
                tabs = [cls._normalize_finder_session_tab({"mode": "cloud", "path": "/"})]
            tab_ids = [tab["id"] for tab in tabs]
            raw_order = raw_window.get("tabOrder") if isinstance(raw_window.get("tabOrder"), list) else []
            tab_order = [str(tab_id) for tab_id in raw_order if str(tab_id) in tab_ids]
            for tab_id in tab_ids:
                if tab_id not in tab_order:
                    tab_order.append(tab_id)
            active_tab_id = str(raw_window.get("activeTabId") or tab_order[0])
            if active_tab_id not in tab_order:
                active_tab_id = tab_order[0]
            windows.append({
                "id": window_id,
                "activeTabId": active_tab_id,
                "tabOrder": tab_order,
                "tabs": tabs,
                "isPrimary": bool(raw_window.get("isPrimary", window_id == "finder-window-main")),
            })
        if not windows:
            windows = [{
                "id": "finder-window-main",
                "activeTabId": "file-tab-root",
                "tabOrder": ["file-tab-root"],
                "tabs": [cls._normalize_finder_session_tab({"id": "file-tab-root", "mode": "cloud", "path": "/"})],
                "isPrimary": True,
            }]
        active_window_id = str(source.get("activeWindowId") or windows[0]["id"]).strip()
        if active_window_id not in {item["id"] for item in windows}:
            active_window_id = windows[0]["id"]
        finder_windows: list[dict] = []
        raw_finder_windows = source.get("finderWindows") if isinstance(source.get("finderWindows"), list) else []
        for raw_window in raw_finder_windows[:4]:
            if not isinstance(raw_window, dict):
                continue
            mode = str(raw_window.get("mode") or "cloud").strip().lower()
            if mode not in {"cloud", "local"}:
                mode = "cloud"
            path = str(raw_window.get("path") or ("/" if mode == "cloud" else ".")).strip()
            if not path:
                path = "/" if mode == "cloud" else "."
            finder_windows.append({
                "id": str(raw_window.get("id") or "")[:96],
                "path": path[:2048],
                "mode": mode,
            })
        return {
            "version": 1,
            "activeWindowId": active_window_id,
            "windows": windows,
            "finderWindows": finder_windows,
        }

    async def get_finder_session(self, owner_id: str) -> dict | None:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        doc = await self._finder_sessions.find_one({"owner_id": owner_id})
        serialized = self._serialize_pdf_reader_doc(doc)
        return serialized.get("session") if serialized else None

    async def save_finder_session(self, owner_id: str, payload: dict) -> dict:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        now = datetime.now(timezone.utc)
        session = self._normalize_finder_session_payload(payload)
        doc = await self._finder_sessions.find_one_and_update(
            {"owner_id": owner_id},
            {
                "$set": {
                    "owner_id": owner_id,
                    "schema_version": 1,
                    "session": session,
                    "updated_at": now,
                },
                "$setOnInsert": {"created_at": now},
            },
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        serialized = self._serialize_pdf_reader_doc(doc) or {}
        return {"session": serialized.get("session"), "updated_at": serialized.get("updated_at")}

    async def delete_finder_session(self, owner_id: str) -> bool:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        result = await self._finder_sessions.delete_one({"owner_id": owner_id})
        return bool(getattr(result, "deleted_count", 0))

    async def get_pdf_reader_state(self, owner_id: str, document_key: str) -> dict | None:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        document_key = str(document_key or "").strip()
        if not document_key:
            return None
        doc = await self._pdf_reader_progress.find_one(
            {"owner_id": owner_id, "document_key": document_key}
        )
        return self._serialize_pdf_reader_doc(doc)

    async def save_pdf_reader_state(self, owner_id: str, document_key: str, payload: dict) -> dict:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        document_key = str(document_key or "").strip()
        if not document_key:
            raise ValueError("document_key ausente")

        payload = dict(payload or {})
        now = datetime.now(timezone.utc)
        incoming_updated_at = self._parse_pdf_reader_timestamp(payload.get("updated_at"))
        last_device_id = str(payload.get("last_device_id") or payload.get("device_id") or "").strip()

        existing = await self._pdf_reader_progress.find_one(
            {"owner_id": owner_id, "document_key": document_key}
        )
        existing_updated_at = self._parse_pdf_reader_timestamp((existing or {}).get("updated_at"))
        existing_device_id = str((existing or {}).get("last_device_id") or "").strip()
        if (
            existing
            and incoming_updated_at
            and existing_updated_at
            and incoming_updated_at < existing_updated_at
            and last_device_id
            and existing_device_id
            and last_device_id != existing_device_id
        ):
            return {"state": self._serialize_pdf_reader_doc(existing), "conflict": True}

        update_payload = {
            "owner_id": owner_id,
            "document_key": document_key,
            "path": str(payload.get("path") or "").strip(),
            "name": str(payload.get("name") or "").strip(),
            "storage_id_masked": str(payload.get("storage_id_masked") or "").strip(),
            "size_bytes": max(0, int(payload.get("size_bytes") or 0)),
            "modified_at": str(payload.get("modified_at") or "").strip(),
            "page": max(1, int(payload.get("page") or 1)),
            "total_pages": max(0, int(payload.get("total_pages") or 0)),
            "zoom": max(0.25, min(4.0, float(payload.get("zoom") or 1.0))),
            "scroll_ratio": max(0.0, min(1.0, float(payload.get("scroll_ratio") or 0.0))),
            "sidebar_open": bool(payload.get("sidebar_open", True)),
            "last_device_id": last_device_id,
            "updated_at": now,
        }
        if "page_rotations" in payload:
            update_payload["page_rotations"] = self._normalize_pdf_page_rotations(payload.get("page_rotations"))
        doc = await self._pdf_reader_progress.find_one_and_update(
            {"owner_id": owner_id, "document_key": document_key},
            {"$set": update_payload, "$setOnInsert": {"created_at": now}},
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        return {"state": self._serialize_pdf_reader_doc(doc), "conflict": False}

    async def get_pdf_reader_tabs(self, owner_id: str, app_id: str = "pdf-tools") -> dict:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        app_id = str(app_id or "pdf-tools").strip() or "pdf-tools"
        doc = await self._pdf_reader_tabs.find_one({"owner_id": owner_id, "app_id": app_id})
        serialized = self._serialize_pdf_reader_doc(doc) or {}
        return {
            "app_id": app_id,
            "active_document_key": str(serialized.get("active_document_key") or ""),
            "tabs": list(serialized.get("tabs") or []),
            "recent_pdfs": list(serialized.get("recent_pdfs") or []),
            "updated_at": serialized.get("updated_at"),
        }

    @staticmethod
    def _normalize_pdf_reader_recent(raw_recent: dict) -> dict | None:
        recent = dict(raw_recent or {})
        path = str(recent.get("path") or "").strip()
        if not path:
            return None
        name = str(recent.get("name") or path.rsplit("/", 1)[-1] or "PDF").strip()
        opened_at = str(recent.get("opened_at") or recent.get("updated_at") or "").strip()
        return {
            "document_key": str(recent.get("document_key") or "").strip(),
            "path": path,
            "name": name,
            "opened_at": opened_at,
        }

    @classmethod
    def _normalize_pdf_reader_recents(cls, raw_recents: list, limit: int = 12) -> list[dict]:
        normalized = []
        seen = set()
        for raw_recent in list(raw_recents or [])[:50]:
            recent = cls._normalize_pdf_reader_recent(raw_recent)
            if not recent:
                continue
            key = recent["path"].lower()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(recent)
            if len(normalized) >= limit:
                break
        return normalized

    async def save_pdf_reader_tabs(self, owner_id: str, app_id: str, payload: dict) -> dict:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        app_id = str(app_id or "pdf-tools").strip() or "pdf-tools"
        payload = dict(payload or {})
        tabs = []
        for raw_tab in list(payload.get("tabs") or [])[:12]:
            tab = dict(raw_tab or {})
            document_key = str(tab.get("document_key") or "").strip()
            path = str(tab.get("path") or "").strip()
            if not document_key or not path:
                continue
            tabs.append(
                {
                    "document_key": document_key,
                    "path": path,
                    "name": str(tab.get("name") or path.rsplit("/", 1)[-1] or "PDF").strip(),
                    "pinned": bool(tab.get("pinned", False)),
                    "opened_at": str(tab.get("opened_at") or "").strip(),
                    "updated_at": str(tab.get("updated_at") or "").strip(),
                }
            )

        active_document_key = str(payload.get("active_document_key") or "").strip()
        if tabs and active_document_key not in {tab["document_key"] for tab in tabs}:
            active_document_key = tabs[0]["document_key"]
        if not tabs:
            active_document_key = ""

        now = datetime.now(timezone.utc)
        doc = await self._pdf_reader_tabs.find_one_and_update(
            {"owner_id": owner_id, "app_id": app_id},
            {
                "$set": {
                    "owner_id": owner_id,
                    "app_id": app_id,
                    "active_document_key": active_document_key,
                    "tabs": tabs,
                    "updated_at": now,
                },
                "$setOnInsert": {"created_at": now},
            },
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        return self._serialize_pdf_reader_doc(doc) or {"app_id": app_id, "tabs": []}

    async def get_pdf_reader_recents(self, owner_id: str, app_id: str = "pdf-tools", limit: int = 3) -> dict:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        app_id = str(app_id or "pdf-tools").strip() or "pdf-tools"
        safe_limit = max(1, min(int(limit or 3), 12))
        doc = await self._pdf_reader_tabs.find_one({"owner_id": owner_id, "app_id": app_id})
        recents = self._normalize_pdf_reader_recents((doc or {}).get("recent_pdfs") or [], safe_limit)
        return {
            "app_id": app_id,
            "recent_pdfs": recents,
            "updated_at": self._serialize_pdf_reader_doc(doc or {}).get("updated_at") if doc else None,
        }

    async def record_pdf_reader_recent(self, owner_id: str, app_id: str, payload: dict) -> dict:
        owner_id = str(owner_id or "owner:default").strip() or "owner:default"
        app_id = str(app_id or "pdf-tools").strip() or "pdf-tools"
        payload = dict(payload or {})
        path = str(payload.get("path") or "").strip()
        if not path:
            raise ValueError("path ausente")
        now = datetime.now(timezone.utc)
        recent = self._normalize_pdf_reader_recent(
            {
                "document_key": str(payload.get("document_key") or "").strip(),
                "path": path,
                "name": str(payload.get("name") or path.rsplit("/", 1)[-1] or "PDF").strip(),
                "opened_at": now.isoformat(),
            }
        )
        if not recent:
            raise ValueError("PDF recente invalido")

        existing = await self._pdf_reader_tabs.find_one({"owner_id": owner_id, "app_id": app_id})
        existing_recents = (existing or {}).get("recent_pdfs") or []
        recent_pdfs = self._normalize_pdf_reader_recents([recent, *existing_recents], 12)
        doc = await self._pdf_reader_tabs.find_one_and_update(
            {"owner_id": owner_id, "app_id": app_id},
            {
                "$set": {
                    "owner_id": owner_id,
                    "app_id": app_id,
                    "recent_pdfs": recent_pdfs,
                    "updated_at": now,
                },
                "$setOnInsert": {
                    "created_at": now,
                    "active_document_key": "",
                    "tabs": [],
                },
            },
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )
        serialized = self._serialize_pdf_reader_doc(doc) or {}
        return {
            "app_id": app_id,
            "recent_pdfs": self._normalize_pdf_reader_recents(serialized.get("recent_pdfs") or [], 3),
            "updated_at": serialized.get("updated_at"),
        }

    async def list_shared_entries(self, limit: int = 500) -> list[tuple[str, dict]]:
        """List owner-visible entries that have a direct public share id."""
        safe_limit = max(1, min(int(limit or 500), 1000))
        shared_query = {"sharing.public_id": {"$exists": True, "$nin": ["", None]}}
        entries: list[tuple[str, dict]] = []

        file_projection = {
            "path": 1,
            "filename": 1,
            "size": 1,
            "meta": 1,
            "chunks": 1,
            "created_at": 1,
            "modified_at": 1,
            "sharing": 1,
            "is_favorite": 1,
            "is_offline": 1,
        }
        async for doc in self._files.find(self._visible_files_filter(shared_query), file_projection).sort("modified_at", -1).limit(safe_limit + 1):
            entries.append(("file", doc))

        remaining = max(0, safe_limit + 1 - len(entries))
        if remaining:
            directory_projection = {
                "path": 1,
                "parent": 1,
                "created_at": 1,
                "modified_at": 1,
                "sharing": 1,
                "is_favorite": 1,
                "is_offline": 1,
            }
            async for doc in self._directories.find(shared_query, directory_projection).sort("modified_at", -1).limit(remaining):
                if doc.get("path") == "/":
                    continue
                entries.append(("directory", doc))

        def sort_key(entry: tuple[str, dict]) -> datetime:
            value = entry[1].get("modified_at") or entry[1].get("created_at")
            return value if isinstance(value, datetime) else datetime.min.replace(tzinfo=timezone.utc)

        entries.sort(key=sort_key, reverse=True)
        return entries[: safe_limit + 1]

    async def set_sharing(self, path: str, sharing: dict) -> tuple[str | None, dict | None]:
        normalized = self._normalize_path(path)
        sharing_payload = dict(sharing or {})

        file_doc = await self._files.find_one_and_update(
            {"path": normalized},
            {"$set": {"sharing": sharing_payload, "modified_at": datetime.now(timezone.utc)}},
            return_document=ReturnDocument.AFTER,
        )
        if file_doc:
            return "file", file_doc

        dir_doc = await self._directories.find_one_and_update(
            {"path": normalized},
            {"$set": {"sharing": sharing_payload}},
            return_document=ReturnDocument.AFTER,
        )
        if dir_doc:
            return "directory", dir_doc

        return None, None

    async def set_share_inheritance_override(self, path: str, override: str) -> tuple[str | None, dict | None]:
        normalized = self._normalize_path(path)
        normalized_override = str(override or "").strip().lower()
        if normalized_override not in {"inherit", "hidden", "direct"}:
            normalized_override = "inherit"

        if normalized_override == "inherit":
            file_update = {
                "$unset": {"sharing.inheritance_override": ""},
                "$set": {"modified_at": datetime.now(timezone.utc)},
            }
            dir_update = {"$unset": {"sharing.inheritance_override": ""}}
        else:
            file_update = {
                "$set": {
                    "sharing.inheritance_override": normalized_override,
                    "modified_at": datetime.now(timezone.utc),
                }
            }
            dir_update = {"$set": {"sharing.inheritance_override": normalized_override}}

        file_doc = await self._files.find_one_and_update(
            {"path": normalized},
            file_update,
            return_document=ReturnDocument.AFTER,
        )
        if file_doc:
            return "file", file_doc

        dir_doc = await self._directories.find_one_and_update(
            {"path": normalized},
            dir_update,
            return_document=ReturnDocument.AFTER,
        )
        if dir_doc:
            return "directory", dir_doc

        return None, None

    async def clear_sharing(self, path: str) -> bool:
        normalized = self._normalize_path(path)

        file_result = await self._files.update_one(
            {"path": normalized},
            {
                "$unset": {
                    "sharing.public_id": "",
                    "sharing.password": "",
                    "sharing.expires_at": "",
                    "sharing.max_access": "",
                    "sharing.access_count": "",
                },
                "$set": {"modified_at": datetime.now(timezone.utc)},
            },
        )
        if file_result.matched_count > 0:
            return True

        dir_result = await self._directories.update_one(
            {"path": normalized},
            {
                "$unset": {
                    "sharing.public_id": "",
                    "sharing.password": "",
                    "sharing.expires_at": "",
                    "sharing.max_access": "",
                    "sharing.access_count": "",
                }
            },
        )
        return dir_result.matched_count > 0

    @staticmethod
    def _share_access_filter(public_id: str, now: datetime) -> dict:
        return {
            "sharing.public_id": str(public_id or "").strip(),
            "$and": [
                {
                    "$or": [
                        {"sharing.expires_at": {"$exists": False}},
                        {"sharing.expires_at": None},
                        {"sharing.expires_at": {"$gt": now}},
                    ]
                },
                {
                    "$or": [
                        {"sharing.max_access": {"$exists": False}},
                        {"sharing.max_access": None},
                        {
                            "$expr": {
                                "$lt": [
                                    {"$ifNull": ["$sharing.access_count", 0]},
                                    "$sharing.max_access",
                                ]
                            }
                        },
                    ]
                },
            ],
        }

    async def claim_share_access(self, public_id: str, now: datetime | None = None) -> tuple[str | None, dict | None]:
        current_time = now or datetime.now(timezone.utc)
        query = self._share_access_filter(public_id, current_time)
        update = {"$inc": {"sharing.access_count": 1}}

        file_doc = await self._files.find_one_and_update(
            query,
            {"$set": {"modified_at": current_time}, **update},
            return_document=ReturnDocument.AFTER,
        )
        if file_doc:
            return "file", file_doc

        dir_doc = await self._directories.find_one_and_update(
            query,
            update,
            return_document=ReturnDocument.AFTER,
        )
        if dir_doc:
            return "directory", dir_doc

        return None, None

    async def delete_directory(self, path: str) -> bool:
        """
        Delete a directory. Only succeeds if directory is empty.

        Returns:
            True if deleted, False if not empty or not found.
        """
        path = self._normalize_path(path)

        if path == "/":
            logger.warning("Cannot delete root directory")
            return False

        # Check for child files
        child_file = await self._files.find_one(
            {"path": {"$regex": f"^{self._escape_regex(path)}/"}},
            {"_id": 1},
        )
        if child_file:
            logger.warning(f"Directory not empty (has files): {path}")
            return False

        # Check for child directories
        child_dir = await self._directories.find_one(
            {"parent": path},
            {"_id": 1},
        )
        if child_dir:
            logger.warning(f"Directory not empty (has subdirectories): {path}")
            return False

        result = await self._directories.delete_one({"path": path})
        if result.deleted_count > 0:
            logger.info(f"🗑️ Directory deleted: {path}")
            return True
        return False

    async def delete_directory_recursive(self, path: str) -> int:
        """
        Recursively delete a directory and all contents.

        Returns:
            Number of items deleted (files + directories).
        """
        path = self._normalize_path(path)
        if path == "/":
            return 0

        count = 0

        # Delete all files under this path
        result = await self._files.delete_many(
            {"path": {"$regex": f"^{self._escape_regex(path)}/"}}
        )
        count += result.deleted_count

        # Delete all subdirectories
        result = await self._directories.delete_many(
            {"path": {"$regex": f"^{self._escape_regex(path)}/"}}
        )
        count += result.deleted_count

        # Delete the directory itself
        result = await self._directories.delete_one({"path": path})
        count += result.deleted_count

        logger.info(f"🗑️ Recursive delete: {path} ({count} items)")
        return count

    async def list_directory_tree(self, path: str) -> dict:
        """
        Return the full tree of descendants under a directory (read-only).
        Does NOT delete anything — used by FileManager to orchestrate cleanup.

        Returns:
            {"files": [file_docs...], "directories": [dir_docs...]}
        """
        path = self._normalize_path(path)
        escaped = self._escape_regex(path)

        files = []
        async for f in self._files.find({"path": {"$regex": f"^{escaped}/"}}):
            files.append(f)

        directories = []
        async for d in self._directories.find({"path": {"$regex": f"^{escaped}/"}}):
            directories.append(d)

        return {"files": files, "directories": directories}

    async def rename_directory(self, old_path: str, new_path: str) -> bool:
        """Rename/move a directory and update all children paths."""
        old_path = self._normalize_path(old_path)
        new_path = self._normalize_path(new_path)
        new_parent = self._parent_path(new_path)

        # Update the directory itself
        result = await self._directories.update_one(
            {"path": old_path},
            {"$set": {
                "path": new_path, 
                "parent": new_parent,
                "modified_at": datetime.now(timezone.utc)
            }},
        )
        if result.modified_count == 0:
            return False

        # Update all child directories
        prefix = old_path + "/"
        now = datetime.now(timezone.utc)
        
        async for child in self._directories.find(
            {"path": {"$regex": f"^{self._escape_regex(prefix)}"}}
        ):
            new_child_path = new_path + child["path"][len(old_path):]
            new_child_parent = self._parent_path(new_child_path)
            await self._directories.update_one(
                {"_id": child["_id"]},
                {"$set": {
                    "path": new_child_path, 
                    "parent": new_child_parent,
                    "modified_at": now
                }},
            )

        # Update all child files
        async for f in self._files.find(
            {"path": {"$regex": f"^{self._escape_regex(prefix)}"}}
        ):
            new_file_path = new_path + f["path"][len(old_path):]
            new_filename = new_file_path.rsplit("/", 1)[-1]
            await self._files.update_one(
                {"_id": f["_id"]},
                {"$set": {
                    "path": new_file_path, 
                    "filename": new_filename,
                    "modified_at": now
                }},
            )

        return True

    # ===================== LISTING =====================

    async def list_directory(self, path: str) -> list[dict]:
        """
        List all direct children (files and directories) of a given directory.

        Returns:
            List of dicts with keys: name, path, is_directory, size, modified_at
        """
        path = self._normalize_path(path)
        items = []

        # List subdirectories
        async for d in self._directories.find({"parent": path}):
            name = d["path"].rsplit("/", 1)[-1]
            items.append({
                "name": name,
                "path": d["path"],
                "is_directory": True,
                "size": 0,
                "created_at": d.get("created_at", datetime.now(timezone.utc)),
                "modified_at": d.get("created_at", datetime.now(timezone.utc)),
                "is_favorite": d.get("is_favorite", False),
                "is_offline": d.get("is_offline", False),
                "sharing": d.get("sharing"),
            })

        # List files — match files whose path is directly under this directory
        if path == "/":
            # Files in root: path like /filename (no more slashes)
            regex = r"^/[^/]+$"
        else:
            # Files under path: /path/filename (no trailing slashes beyond)
            regex = f"^{self._escape_regex(path)}/[^/]+$"

        async for f in self._files.find(self._visible_files_filter({"path": {"$regex": regex}})):
            items.append({
                "name": f["filename"],
                "path": f["path"],
                "is_directory": False,
                "size": f["size"],
                "created_at": f.get("created_at", datetime.now(timezone.utc)),
                "modified_at": f.get("modified_at", datetime.now(timezone.utc)),
                "meta": f.get("meta", {}),
                "chunks": f.get("chunks", []),
                "is_favorite": f.get("is_favorite", False),
                "is_offline": f.get("is_offline", False),
                "sharing": f.get("sharing"),
            })

        return items

    async def get_disk_usage(self) -> int:
        """Get total storage used across all files (in bytes)."""
        pipeline = [{"$group": {"_id": None, "total": {"$sum": "$size"}}}]
        async for result in self._files.aggregate(pipeline):
            return result.get("total", 0)
        return 0

    # ===================== FAVORITES =====================

    async def set_favorite(self, path: str, is_favorite: bool) -> bool:
        """Set the favorite status of a file or directory."""
        path = self._normalize_path(path)
        
        # Try file first
        res = await self._files.update_one(
            {"path": path},
            {"$set": {"is_favorite": is_favorite}}
        )
        if res.matched_count > 0:
            return True

        # Try directory
        res = await self._directories.update_one(
            {"path": path},
            {"$set": {"is_favorite": is_favorite}}
        )
        return res.matched_count > 0

    # ===================== OFFLINE =====================

    async def set_offline(self, path: str, is_offline: bool) -> bool:
        """Set the offline status of a file or directory."""
        path = self._normalize_path(path)
        
        # Try file first
        res = await self._files.update_one(
            {"path": path},
            {"$set": {"is_offline": is_offline}}
        )
        if res.matched_count > 0:
            return True

        # Try directory
        res = await self._directories.update_one(
            {"path": path},
            {"$set": {"is_offline": is_offline}}
        )
        return res.matched_count > 0

    async def get_offline_files(self) -> list[dict]:
        """Get all offline files and directories."""
        items = []
        
        # Get offline directories
        async for d in self._directories.find({"is_offline": True}):
            name = d["path"].rsplit("/", 1)[-1]
            if not name: continue # Skip root
            items.append({
                "name": name,
                "path": d["path"],
                "is_directory": True,
                "size": 0,
                "created_at": d.get("created_at"),
                "modified_at": d.get("modified_at"),
                "is_offline": True,
                "is_favorite": d.get("is_favorite", False),
            })

        # Get offline files
        async for f in self._files.find(self._visible_files_filter({"is_offline": True})):
            items.append({
                "name": f["filename"],
                "path": f["path"],
                "is_directory": False,
                "size": f["size"],
                "created_at": f.get("created_at"),
                "modified_at": f.get("modified_at"),
                "meta": f.get("meta", {}),
                "chunks": f.get("chunks", []),
                "is_offline": True,
                "is_favorite": f.get("is_favorite", False),
            })
            
        return items

    async def get_favorites(self) -> list[dict]:
        """Get all favorite files and directories."""
        items = []
        
        # Get favorite directories
        async for d in self._directories.find({"is_favorite": True}):
            name = d["path"].rsplit("/", 1)[-1]
            if not name: continue # Skip root
            items.append({
                "name": name,
                "path": d["path"],
                "is_directory": True,
                "size": 0,
                "created_at": d.get("created_at"),
                "modified_at": d.get("modified_at"),
                "is_offline": d.get("is_offline", False),
                "is_favorite": True,
            })

        # Get favorite files
        async for f in self._files.find(self._visible_files_filter({"is_favorite": True})):
            items.append({
                "name": f["filename"],
                "path": f["path"],
                "is_directory": False,
                "size": f["size"],
                "created_at": f.get("created_at"),
                "modified_at": f.get("modified_at"),
                "meta": f.get("meta", {}),
                "chunks": f.get("chunks", []),
                "is_offline": f.get("is_offline", False),
                "is_favorite": True,
            })
            
        return items

    async def get_recents(self, limit: int = 50) -> list[dict]:
        """Get the most recently modified/created files, sorted by modified_at descending."""
        items = []
        cursor = self._files.find(
            self._visible_files_filter()
        ).sort("modified_at", -1).limit(limit)
        async for f in cursor:
            items.append({
                "name": f["filename"],
                "path": f["path"],
                "is_directory": False,
                "size": f["size"],
                "created_at": f.get("created_at"),
                "modified_at": f.get("modified_at"),
                "meta": f.get("meta", {}),
                "is_favorite": f.get("is_favorite", False),
                "is_offline": f.get("is_offline", False),
                "chunks": f.get("chunks", []),
            })
        return items

    async def get_storage_candidates(self) -> list[dict]:
        """Get visible file candidates that can appear in storage inventory."""
        items = []
        projection = {
            "path": 1,
            "filename": 1,
            "size": 1,
            "modified_at": 1,
            "meta": 1,
            "chunks": 1,
            "is_offline": 1,
            "storage_id": 1,
            "storage_scheme": 1,
        }
        cursor = self._files.find(
            self._visible_files_filter({"chunks.0": {"$exists": True}}),
            projection,
        ).sort("modified_at", -1)
        async for f in cursor:
            items.append({
                "name": f.get("filename"),
                "filename": f.get("filename"),
                "path": f.get("path"),
                "is_directory": False,
                "size": f.get("size", 0),
                "modified_at": f.get("modified_at"),
                "meta": f.get("meta", {}),
                "chunks": f.get("chunks", []),
                "is_offline": f.get("is_offline", False),
                "storage_id": f.get("storage_id"),
                "storage_scheme": f.get("storage_scheme"),
            })
        return items

    async def get_all_files(self) -> list[dict]:
        """Get all files in the database (used for sync)."""
        items = []
        async for f in self._files.find():
            items.append(f)
        return items

    # ===================== TRASH =====================

    async def move_file_to_trash(
        self,
        path: str,
        *,
        trash_root_entry_id: str | None = None,
        trash_entry_id: str | None = None,
        original_root_path: str | None = None,
        relative_path: str = "",
    ) -> dict | None:
        file_doc = await self.get_file(path)
        if not file_doc:
            return None

        root_entry_id = str(trash_root_entry_id or ObjectId())
        entry_id = str(trash_entry_id or ObjectId())
        normalized_path = self._normalize_path(file_doc.get("path") or path)
        root_original = self._normalize_path(original_root_path or normalized_path)
        now = datetime.now(timezone.utc)
        trash_doc = {
            key: value
            for key, value in file_doc.items()
            if key != "_id"
        }
        trash_doc.update({
            "trash_entry_id": entry_id,
            "trash_root_entry_id": root_entry_id,
            "original_path": normalized_path,
            "original_parent": self._parent_path(normalized_path),
            "original_root_path": root_original,
            "relative_path": str(relative_path or ""),
            "trashed_at": now,
        })

        await self._trash_files.insert_one(trash_doc)
        await self._files.delete_one({"_id": file_doc["_id"]})
        return trash_doc

    async def move_directory_tree_to_trash(
        self,
        path: str,
        *,
        trash_root_entry_id: str | None = None,
    ) -> dict:
        root_doc = await self.get_directory_doc(path)
        if not root_doc:
            raise FileNotFoundError(f"Directory not found: {path}")

        normalized_root = self._normalize_path(path)
        root_entry_id = str(trash_root_entry_id or ObjectId())
        now = datetime.now(timezone.utc)
        tree = await self.list_directory_tree(normalized_root)
        dir_docs = [root_doc, *tree["directories"]]
        file_docs = list(tree["files"])

        trash_dirs = []
        for doc in dir_docs:
            original_path = self._normalize_path(doc.get("path") or normalized_root)
            relative_path = "" if original_path == normalized_root else original_path[len(normalized_root):].lstrip("/")
            entry_id = root_entry_id if original_path == normalized_root else str(ObjectId())
            payload = {
                key: value
                for key, value in doc.items()
                if key != "_id"
            }
            payload.update({
                "trash_entry_id": entry_id,
                "trash_root_entry_id": root_entry_id,
                "original_path": original_path,
                "original_parent": self._parent_path(original_path),
                "original_root_path": normalized_root,
                "relative_path": relative_path,
                "trashed_at": now,
            })
            trash_dirs.append(payload)

        trash_files = []
        for doc in file_docs:
            original_path = self._normalize_path(doc.get("path") or "")
            relative_path = original_path[len(normalized_root):].lstrip("/")
            payload = {
                key: value
                for key, value in doc.items()
                if key != "_id"
            }
            payload.update({
                "trash_entry_id": str(ObjectId()),
                "trash_root_entry_id": root_entry_id,
                "original_path": original_path,
                "original_parent": self._parent_path(original_path),
                "original_root_path": normalized_root,
                "relative_path": relative_path,
                "trashed_at": now,
            })
            trash_files.append(payload)

        if trash_dirs:
            await self._trash_directories.insert_many(trash_dirs, ordered=True)
        if trash_files:
            await self._trash_files.insert_many(trash_files, ordered=True)

        dir_ids = [doc["_id"] for doc in dir_docs if doc.get("_id") is not None]
        file_ids = [doc["_id"] for doc in file_docs if doc.get("_id") is not None]
        if file_ids:
            await self._files.delete_many({"_id": {"$in": file_ids}})
        if dir_ids:
            await self._directories.delete_many({"_id": {"$in": dir_ids}})

        return {
            "trash_root_entry_id": root_entry_id,
            "trashed_directories": len(trash_dirs),
            "trashed_files": len(trash_files),
        }

    async def list_trash_roots(self) -> list[dict]:
        items = []

        async for d in self._trash_directories.find({
            "trash_entry_id": {"$exists": True},
            "trash_root_entry_id": {"$exists": True},
        }, {
            "trash_entry_id": 1,
            "trash_root_entry_id": 1,
            "path": 1,
            "original_path": 1,
            "original_parent": 1,
            "created_at": 1,
            "modified_at": 1,
            "trashed_at": 1,
            "meta": 1,
        }):
            if d.get("trash_entry_id") != d.get("trash_root_entry_id"):
                continue
            name = d.get("path", "").rsplit("/", 1)[-1] or d.get("original_path", "").rsplit("/", 1)[-1]
            items.append({
                "trash_entry_id": d.get("trash_entry_id"),
                "trash_root_entry_id": d.get("trash_root_entry_id"),
                "name": name,
                "path": d.get("original_path") or d.get("path"),
                "original_path": d.get("original_path") or d.get("path"),
                "original_parent": d.get("original_parent"),
                "is_directory": True,
                "size": 0,
                "created_at": d.get("created_at"),
                "modified_at": d.get("modified_at"),
                "trashed_at": d.get("trashed_at"),
                "meta": d.get("meta", {}),
            })

        async for f in self._trash_files.find({
            "trash_entry_id": {"$exists": True},
            "trash_root_entry_id": {"$exists": True},
            "meta.hidden_system_file": {"$ne": True},
        }, {
            "trash_entry_id": 1,
            "trash_root_entry_id": 1,
            "filename": 1,
            "path": 1,
            "original_path": 1,
            "original_parent": 1,
            "size": 1,
            "created_at": 1,
            "modified_at": 1,
            "trashed_at": 1,
            "meta": 1,
            "is_favorite": 1,
            "is_offline": 1,
        }):
            if f.get("trash_entry_id") != f.get("trash_root_entry_id"):
                continue
            items.append({
                "trash_entry_id": f.get("trash_entry_id"),
                "trash_root_entry_id": f.get("trash_root_entry_id"),
                "name": f.get("filename") or f.get("path", "").rsplit("/", 1)[-1],
                "path": f.get("original_path") or f.get("path"),
                "original_path": f.get("original_path") or f.get("path"),
                "original_parent": f.get("original_parent"),
                "is_directory": False,
                "size": f.get("size", 0),
                "created_at": f.get("created_at"),
                "modified_at": f.get("modified_at"),
                "trashed_at": f.get("trashed_at"),
                "meta": f.get("meta", {}),
                "is_favorite": f.get("is_favorite", False),
                "is_offline": f.get("is_offline", False),
            })

        items.sort(
            key=lambda item: item.get("trashed_at") or item.get("modified_at") or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )
        return items

    async def count_trash_descendants_by_root_ids(self, root_ids: list[str]) -> dict[str, dict]:
        normalized_ids = [str(root_id).strip() for root_id in (root_ids or []) if str(root_id).strip()]
        if not normalized_ids:
            return {}

        counts = {
            root_id: {"files": 0, "directories": 0}
            for root_id in dict.fromkeys(normalized_ids)
        }

        async def collect(collection, key: str) -> None:
            pipeline = [
                {"$match": {"trash_root_entry_id": {"$in": normalized_ids}}},
                {"$group": {"_id": "$trash_root_entry_id", "count": {"$sum": 1}}},
            ]
            async for row in collection.aggregate(pipeline):
                root_id = str(row.get("_id") or "").strip()
                if not root_id:
                    continue
                counts.setdefault(root_id, {"files": 0, "directories": 0})
                counts[root_id][key] = int(row.get("count") or 0)

        await collect(self._trash_files, "files")
        await collect(self._trash_directories, "directories")
        return counts

    async def get_trash_tree(self, trash_root_entry_id: str) -> dict:
        root_id = str(trash_root_entry_id or "").strip()
        if not root_id:
            return {"files": [], "directories": []}

        files = []
        async for doc in self._trash_files.find({"trash_root_entry_id": root_id}):
            files.append(doc)

        directories = []
        async for doc in self._trash_directories.find({"trash_root_entry_id": root_id}):
            directories.append(doc)

        return {"files": files, "directories": directories}

    async def delete_trash_roots(self, entry_ids: list[str]) -> dict:
        normalized_ids = [str(entry_id).strip() for entry_id in (entry_ids or []) if str(entry_id).strip()]
        if not normalized_ids:
            return {"deleted_files": 0, "deleted_directories": 0}

        file_result = await self._trash_files.delete_many({"trash_root_entry_id": {"$in": normalized_ids}})
        dir_result = await self._trash_directories.delete_many({"trash_root_entry_id": {"$in": normalized_ids}})
        return {
            "deleted_files": int(file_result.deleted_count),
            "deleted_directories": int(dir_result.deleted_count),
        }

    # ===================== HELPERS =====================

    @staticmethod
    def _normalize_path(path: str) -> str:
        """Normalize a virtual path: ensure leading /, no trailing /, no double //."""
        if not path:
            return "/"
        path = "/" + path.strip("/")
        # Collapse multiple slashes
        while "//" in path:
            path = path.replace("//", "/")
        return path if path != "" else "/"

    @staticmethod
    def _parent_path(path: str) -> str:
        """Get the parent directory of a path."""
        if path == "/":
            return None
        parent = path.rsplit("/", 1)[0]
        return parent if parent else "/"

    @staticmethod
    def _escape_regex(text: str) -> str:
        """Escape special regex characters in a string."""
        import re
        return re.escape(text)
