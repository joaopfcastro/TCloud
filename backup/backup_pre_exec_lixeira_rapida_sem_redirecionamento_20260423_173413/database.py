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

        # Create indexes
        await self._files.create_index("path", unique=True)
        await self._directories.create_index("path", unique=True)
        await self._directories.create_index("parent")
        await self._trash_files.create_index("trash_entry_id", unique=True)
        await self._trash_files.create_index("trash_root_entry_id")
        await self._trash_files.create_index("original_path")
        await self._trash_files.create_index("trashed_at")
        await self._trash_directories.create_index("trash_entry_id", unique=True)
        await self._trash_directories.create_index("trash_root_entry_id")
        await self._trash_directories.create_index("original_path")
        await self._trash_directories.create_index("trashed_at")

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
                "chunks": f.get("chunks", []),
                "is_favorite": f.get("is_favorite", False),
                "is_offline": f.get("is_offline", False),
            })

        items.sort(
            key=lambda item: item.get("trashed_at") or item.get("modified_at") or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )
        return items

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
