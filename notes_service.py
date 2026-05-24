from __future__ import annotations

import html
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pymongo import ReturnDocument


class NotesService:
    PROPERTY_TYPES = {"text", "number", "select", "multi_select", "checkbox", "date", "url", "relation"}
    FILTER_OPERATORS = {
        "equals",
        "not_equals",
        "contains",
        "not_contains",
        "is_empty",
        "is_not_empty",
        "greater_than",
        "less_than",
        "before",
        "after",
        "on_or_before",
        "on_or_after",
    }
    ATTACHMENT_BLOCK_TYPES = {
        "tcloudFile": "file",
        "tcloudImage": "image",
        "tcloudVideo": "video",
        "tcloudAudio": "audio",
        "tcloudPdf": "pdf",
        "tcloudFolder": "folder",
    }

    def __init__(self, db, file_manager=None):
        self._db = db
        self._file_manager = file_manager

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    @staticmethod
    def _owner_id(value: str | None) -> str:
        owner_id = str(value or "owner:default").strip() or "owner:default"
        return owner_id

    @staticmethod
    def _to_iso(value):
        if hasattr(value, "isoformat"):
            return value.isoformat()
        return value or None

    @staticmethod
    def _parse_date(value):
        if not value:
            return None
        if hasattr(value, "timestamp"):
            return value
        text = str(value).strip()
        if not text:
            return None
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None

    @staticmethod
    def _trimmed_title(value) -> str:
        title = str(value or "").strip()
        return title[:240] or "Sem título"

    @staticmethod
    def _strip_html(value) -> str:
        return re.sub(r"<[^>]+>", " ", str(value or ""))

    @classmethod
    def _slugify(cls, value: str) -> str:
        base = re.sub(r"[^a-z0-9]+", "-", cls._strip_html(value).lower()).strip("-")
        return base[:64] or "nota"

    @staticmethod
    def _as_bool(value, *, default: bool = False) -> bool:
        if isinstance(value, bool):
            return value
        if value in (None, ""):
            return default
        return str(value).strip().lower() in {"1", "true", "yes", "on", "sim"}

    @classmethod
    def _normalize_tags(cls, tags) -> list[str]:
        if not isinstance(tags, list):
            return []
        seen = set()
        normalized = []
        for item in tags:
            tag = re.sub(r"\s+", " ", str(item or "").strip())
            if not tag:
                continue
            tag = tag[:40]
            key = tag.casefold()
            if key in seen:
                continue
            seen.add(key)
            normalized.append(tag)
        return normalized[:12]

    @staticmethod
    def _property_id(value: str | None = None) -> str:
        raw = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(value or "").strip()).strip("_")
        return (raw[:80] if raw else f"prop_{uuid.uuid4().hex[:10]}")

    @classmethod
    def _normalize_property_options(cls, options) -> list[dict]:
        normalized = []
        seen = set()
        if not isinstance(options, list):
            return normalized
        for index, item in enumerate(options[:80]):
            if isinstance(item, dict):
                label = str(item.get("label") or item.get("name") or item.get("value") or "").strip()
                value = str(item.get("value") or label).strip()
                color = str(item.get("color") or "").strip()
            else:
                label = str(item or "").strip()
                value = label
                color = ""
            if not label or not value:
                continue
            key = value.casefold()
            if key in seen:
                continue
            seen.add(key)
            normalized.append({
                "id": cls._property_id(value.lower()) or f"option_{index}",
                "label": label[:80],
                "value": value[:80],
                "color": color[:40],
            })
        return normalized

    @classmethod
    def _serialize_property_schema(cls, item: dict | None) -> dict | None:
        if not item:
            return None
        return {
            "id": str(item.get("_id") or item.get("id") or ""),
            "name": str(item.get("name") or "Propriedade"),
            "type": str(item.get("type") or "text"),
            "options": cls._normalize_property_options(item.get("options")),
            "position": int(item.get("position") or 0),
            "created_at": cls._to_iso(item.get("created_at")),
            "updated_at": cls._to_iso(item.get("updated_at")),
        }

    @classmethod
    def _serialize_view(cls, item: dict | None) -> dict | None:
        if not item:
            return None
        return {
            "id": str(item.get("_id") or item.get("id") or ""),
            "name": str(item.get("name") or "View"),
            "type": str(item.get("type") or "list"),
            "filters": list(item.get("filters") or []),
            "sorts": list(item.get("sorts") or []),
            "group_by": str(item.get("group_by") or ""),
            "visible_properties": list(item.get("visible_properties") or []),
            "position": int(item.get("position") or 0),
            "created_at": cls._to_iso(item.get("created_at")),
            "updated_at": cls._to_iso(item.get("updated_at")),
        }

    @classmethod
    def _normalize_schema_payload(cls, payload: dict | None, *, existing: dict | None = None, position: int = 0) -> dict:
        payload = dict(payload or {})
        existing = existing or {}
        prop_type = str(payload.get("type") or existing.get("type") or "text").strip().lower()
        if prop_type not in cls.PROPERTY_TYPES:
            raise ValueError("tipo de propriedade invalido")
        name = re.sub(r"\s+", " ", str(payload.get("name") or existing.get("name") or "Propriedade").strip())[:80]
        if not name:
            raise ValueError("nome da propriedade ausente")
        prop_id = cls._property_id(payload.get("id") or existing.get("_id") or existing.get("id"))
        return {
            "_id": prop_id,
            "name": name,
            "type": prop_type,
            "options": cls._normalize_property_options(payload.get("options", existing.get("options", []))),
            "position": int(payload.get("position", existing.get("position", position)) or 0),
        }

    @classmethod
    def _normalize_property_scalar(cls, value, schema: dict):
        prop_type = str(schema.get("type") or "text")
        if value in (None, ""):
            return None
        if prop_type in {"text", "url"}:
            return str(value).strip()[:2000]
        if prop_type == "number":
            try:
                number = float(value)
            except (TypeError, ValueError):
                raise ValueError(f"valor numerico invalido para {schema.get('name')}")
            return int(number) if number.is_integer() else number
        if prop_type == "checkbox":
            return cls._as_bool(value)
        if prop_type == "date":
            parsed = cls._parse_date(value)
            if not parsed:
                raise ValueError(f"data invalida para {schema.get('name')}")
            return parsed.date().isoformat()
        if prop_type == "select":
            text = str(value).strip()[:80]
            allowed = {str(option.get("value") or "").casefold(): option.get("value") for option in schema.get("options") or []}
            return allowed.get(text.casefold(), text)
        return value

    @classmethod
    def _property_search_text(cls, properties: dict | None) -> str:
        if not isinstance(properties, dict):
            return ""
        parts = []
        for key, value in properties.items():
            normalized_key = str(key or "")
            if normalized_key.startswith("__") or normalized_key == "tcloudAppearance":
                continue
            if isinstance(value, list):
                parts.extend(str(item) for item in value if item not in (None, ""))
            elif isinstance(value, bool):
                parts.append("true" if value else "false")
            elif value not in (None, ""):
                parts.append(str(value))
        return " ".join(parts)

    async def _schema_map(self, owner_id: str) -> dict[str, dict]:
        safe_owner_id = self._owner_id(owner_id)
        result = {}
        cursor = self._db.note_property_schema_collection.find({"owner_id": safe_owner_id}).sort("position", 1)
        async for item in cursor:
            result[str(item.get("_id"))] = item
        return result

    async def _normalize_properties(self, owner_id: str, properties, *, merge_existing: dict | None = None) -> dict:
        if properties is None:
            return dict(merge_existing or {})
        if not isinstance(properties, dict):
            raise ValueError("properties deve ser objeto")
        schema_map = await self._schema_map(owner_id)
        normalized = dict(merge_existing or {})
        for prop_id, raw_value in properties.items():
            safe_prop_id = str(prop_id or "").strip() if str(prop_id or "").startswith("__") else self._property_id(prop_id)
            schema = schema_map.get(safe_prop_id)
            if not schema:
                normalized[safe_prop_id] = raw_value
                continue
            prop_type = str(schema.get("type") or "text")
            if prop_type == "multi_select":
                values = raw_value if isinstance(raw_value, list) else [raw_value]
                normalized[safe_prop_id] = [
                    self._normalize_property_scalar(value, {**schema, "type": "select"})
                    for value in values
                    if value not in (None, "")
                ][:40]
            elif prop_type == "relation":
                ids = raw_value if isinstance(raw_value, list) else [raw_value]
                clean_ids = [str(item).strip() for item in ids if str(item or "").strip()]
                if clean_ids:
                    found = set()
                    async for note in self._db.notes_collection.find(
                        {"owner_id": self._owner_id(owner_id), "_id": {"$in": clean_ids}},
                        {"_id": 1},
                    ):
                        found.add(str(note.get("_id")))
                    missing = [item for item in clean_ids if item not in found]
                    if missing:
                        raise ValueError("relation contem nota inexistente")
                normalized[safe_prop_id] = clean_ids[:80]
            else:
                normalized[safe_prop_id] = self._normalize_property_scalar(raw_value, schema)
        return normalized

    @classmethod
    def _extract_note_link_titles(cls, content: dict) -> list[str]:
        text = cls._extract_plain_text(content)
        seen = set()
        titles = []
        for match in re.finditer(r"\[\[([^\]\n]{1,240})\]\]", text):
            title = re.sub(r"\s+", " ", match.group(1)).strip()
            key = title.casefold()
            if title and key not in seen:
                seen.add(key)
                titles.append(title)
        return titles[:100]

    async def _sync_note_links(self, owner_id: str, note_id: str, content: dict) -> list[str]:
        safe_owner_id = self._owner_id(owner_id)
        safe_note_id = str(note_id or "").strip()
        titles = self._extract_note_link_titles(content)
        outgoing = []
        if titles:
            title_filters = [{"title": {"$regex": f"^{re.escape(title)}$", "$options": "i"}} for title in titles]
            async for note in self._db.notes_collection.find(
                {"owner_id": safe_owner_id, "deleted_at": None, "$or": title_filters},
                {"_id": 1},
            ):
                target_id = str(note.get("_id"))
                if target_id != safe_note_id and target_id not in outgoing:
                    outgoing.append(target_id)

        await self._db.notes_collection.update_many(
            {"owner_id": safe_owner_id, "backlinks": safe_note_id},
            {"$pull": {"backlinks": safe_note_id}},
        )
        if outgoing:
            await self._db.notes_collection.update_many(
                {"owner_id": safe_owner_id, "_id": {"$in": outgoing}},
                {"$addToSet": {"backlinks": safe_note_id}},
            )
        await self._db.notes_collection.update_one(
            {"owner_id": safe_owner_id, "_id": safe_note_id},
            {"$set": {"outgoing_links": outgoing}},
        )
        return outgoing

    @classmethod
    def _default_content(cls) -> dict:
        return {
            "time": int(cls._now().timestamp() * 1000),
            "blocks": [
                {
                    "id": uuid.uuid4().hex[:10],
                    "type": "paragraph",
                    "data": {"text": ""},
                }
            ],
            "version": "2.31.6",
        }

    @classmethod
    def _normalize_content(cls, content) -> dict:
        if not isinstance(content, dict):
            return cls._default_content()

        normalized = {
            "time": int(content.get("time") or int(cls._now().timestamp() * 1000)),
            "blocks": content.get("blocks") if isinstance(content.get("blocks"), list) else [],
            "version": str(content.get("version") or "2.31.6"),
        }
        return normalized

    @classmethod
    def _extract_plain_text(cls, value) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return re.sub(r"<[^>]+>", " ", value)
        if isinstance(value, (int, float, bool)):
            return ""
        if isinstance(value, list):
            return " ".join(cls._extract_plain_text(item) for item in value)
        if isinstance(value, dict):
            if "blocks" in value and isinstance(value.get("blocks"), list):
                return " ".join(cls._extract_plain_text(item) for item in value.get("blocks") or [])
            if "type" in value and "data" in value:
                block_type = str(value.get("type") or "").strip()
                data = value.get("data") if isinstance(value.get("data"), dict) else {}
                attachment = cls._normalize_attachment(block_type, data)
                if attachment:
                    parts = [cls.ATTACHMENT_BLOCK_TYPES.get(block_type, "arquivo"), attachment.get("name") or ""]
                    return " ".join(part for part in parts if part).strip()
                if block_type == "header":
                    return cls._extract_plain_text(data.get("text"))
                if block_type == "list":
                    return " ".join(cls._extract_plain_text(item) for item in data.get("items") or [])
                if block_type == "todo":
                    return cls._extract_plain_text(data.get("text"))
                if block_type == "quote":
                    return " ".join(
                        part for part in [
                            cls._extract_plain_text(data.get("text")),
                            cls._extract_plain_text(data.get("caption")),
                        ] if part
                    )
                if block_type == "codeBlock":
                    return cls._extract_plain_text(data.get("code"))
            ordered = []
            for key in ("text", "title", "caption", "content", "items", "quote"):
                if key in value:
                    ordered.append(cls._extract_plain_text(value.get(key)))
            for key, item in value.items():
                if key in {"text", "title", "caption", "content", "items", "quote", "id", "time", "version", "type", "data"}:
                    continue
                ordered.append(cls._extract_plain_text(item))
            return " ".join(part for part in ordered if part)
        return str(value)

    @classmethod
    def _search_text(cls, title: str, content: dict, tags: list[str] | None = None, properties: dict | None = None) -> str:
        parts = [title, cls._extract_plain_text(content)]
        if tags:
            parts.extend(tags)
        prop_text = cls._property_search_text(properties)
        if prop_text:
            parts.append(prop_text)
        text = " ".join(part for part in parts if part)
        return re.sub(r"\s+", " ", text).strip()

    @classmethod
    def _normalize_attachment(cls, block_type: str, raw_data) -> dict | None:
        if block_type not in cls.ATTACHMENT_BLOCK_TYPES or not isinstance(raw_data, dict):
            return None
        path = str(raw_data.get("path") or "").strip()
        if not path:
            return None
        kind = str(raw_data.get("kind") or cls.ATTACHMENT_BLOCK_TYPES[block_type]).strip().lower()
        name = str(raw_data.get("name") or Path(path).name or path).strip()
        mime = str(raw_data.get("mime") or "").strip()
        try:
            size = int(raw_data.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        attachment = {
            "path": path,
            "name": name[:255] or Path(path).name or path,
            "mime": mime[:120],
            "size": max(0, size),
            "kind": kind or cls.ATTACHMENT_BLOCK_TYPES[block_type],
            "block_type": block_type,
        }
        if raw_data.get("thumbnail_url"):
            attachment["thumbnail_url"] = str(raw_data.get("thumbnail_url")).strip()[:1200]
        return attachment

    @classmethod
    def _extract_attachments(cls, content: dict) -> list[dict]:
        blocks = content.get("blocks") if isinstance(content, dict) else []
        if not isinstance(blocks, list):
            return []
        attachments = []
        seen = set()
        for block in blocks:
            if not isinstance(block, dict):
                continue
            block_type = str(block.get("type") or "").strip()
            attachment = cls._normalize_attachment(block_type, block.get("data"))
            if not attachment:
                continue
            key = (attachment["path"], attachment["kind"])
            if key in seen:
                continue
            seen.add(key)
            attachments.append(attachment)
        return attachments[:200]

    @staticmethod
    def _excerpt(search_text: str) -> str:
        if not search_text:
            return ""
        excerpt = search_text.strip()
        if len(excerpt) <= 180:
            return excerpt
        return f"{excerpt[:177].rstrip()}..."

    @classmethod
    def _content_excerpt(cls, content: dict, *, limit: int = 220) -> str:
        plain = re.sub(r"\s+", " ", cls._extract_plain_text(content)).strip()
        if len(plain) <= limit:
            return plain
        return f"{plain[: limit - 3].rstrip()}..."

    @classmethod
    def _normalize_cover(cls, raw_cover) -> dict:
        cover = raw_cover if isinstance(raw_cover, dict) else {}
        cover_type = str(cover.get("type") or "").strip().lower()
        cover_value = str(cover.get("value") or "").strip()
        if cover_type not in {"none", "gradient", "color", "image"}:
            return {"type": "gradient", "value": "blue-green"}
        if cover_type == "none":
            return {"type": "none", "value": ""}
        if cover_type == "color":
            return {"type": "color", "value": cover_value[:120] or "#2c2c2e"}
        return {"type": cover_type, "value": cover_value[:1200]}

    @classmethod
    def _normalize_icon(cls, raw_icon) -> dict:
        icon = raw_icon if isinstance(raw_icon, dict) else {}
        icon_type = str(icon.get("type") or "").strip().lower()
        icon_value = str(icon.get("value") or "").strip()
        if icon_type not in {"none", "emoji", "symbol"}:
            return {"type": "symbol", "value": "▰"}
        if icon_type == "none":
            return {"type": "none", "value": ""}
        return {"type": icon_type, "value": icon_value[:8] or "▰"}

    @classmethod
    def _normalize_note_appearance(cls, note: dict | None) -> tuple[dict, dict]:
        source = note if isinstance(note, dict) else {}
        properties = source.get("properties") if isinstance(source.get("properties"), dict) else {}
        legacy = properties.get("__tcloudAppearance") if isinstance(properties.get("__tcloudAppearance"), dict) else {}
        if not legacy and isinstance(properties.get("tcloudAppearance"), dict):
            legacy = properties.get("tcloudAppearance")
        if not legacy and isinstance(properties.get("appearance"), dict):
            legacy = properties.get("appearance")
        raw_cover = source.get("cover") if "cover" in source else legacy.get("cover")
        raw_icon = source.get("icon") if "icon" in source else legacy.get("icon")
        return cls._normalize_cover(raw_cover), cls._normalize_icon(raw_icon)

    @classmethod
    def _serialize_note(cls, note: dict | None, *, include_content: bool = True) -> dict | None:
        if not note:
            return None
        normalized_content = cls._normalize_content(note.get("content"))
        derived_excerpt = cls._content_excerpt(normalized_content)
        cover, icon = cls._normalize_note_appearance(note)
        payload = {
            "id": str(note.get("_id") or ""),
            "title": str(note.get("title") or "Sem título"),
            "excerpt": derived_excerpt or str(note.get("excerpt") or ""),
            "version": int(note.get("version") or 1),
            "favorite": bool(note.get("favorite", False)),
            "archived": bool(note.get("archived", False)),
            "cover": cover,
            "icon": icon,
            "tags": cls._normalize_tags(note.get("tags")),
            "properties": dict(note.get("properties") or {}),
            "outgoing_links": list(note.get("outgoing_links") or []),
            "backlinks": list(note.get("backlinks") or []),
            "created_at": cls._to_iso(note.get("created_at")),
            "updated_at": cls._to_iso(note.get("updated_at")),
            "deleted_at": cls._to_iso(note.get("deleted_at")),
            "attachments": list(note.get("attachments") or []),
        }
        if include_content:
            payload["content"] = normalized_content
        return payload

    @classmethod
    def _serialize_revision(cls, revision: dict | None) -> dict | None:
        if not revision:
            return None
        cover, icon = cls._normalize_note_appearance(revision)
        return {
            "id": str(revision.get("_id") or ""),
            "note_id": str(revision.get("note_id") or ""),
            "version": int(revision.get("version") or 1),
            "title": str(revision.get("title") or "Sem título"),
            "excerpt": cls._content_excerpt(cls._normalize_content(revision.get("content"))) or str(revision.get("excerpt") or ""),
            "content_excerpt": cls._content_excerpt(cls._normalize_content(revision.get("content"))),
            "reason": str(revision.get("reason") or "update"),
            "favorite": bool(revision.get("favorite", False)),
            "archived": bool(revision.get("archived", False)),
            "cover": cover,
            "icon": icon,
            "tags": cls._normalize_tags(revision.get("tags")),
            "properties": dict(revision.get("properties") or {}),
            "saved_at": cls._to_iso(revision.get("saved_at")),
            "attachments": list(revision.get("attachments") or []),
            "content": cls._normalize_content(revision.get("content")),
        }

    async def _create_revision(
        self,
        *,
        owner_id: str,
        note_id: str,
        version: int,
        title: str,
        content: dict,
        tags: list[str],
        favorite: bool,
        archived: bool,
        cover: dict | None = None,
        icon: dict | None = None,
        properties: dict | None = None,
        saved_at: datetime,
        reason: str,
    ) -> dict:
        search_text = self._search_text(title, content, tags, properties)
        attachments = self._extract_attachments(content)
        revision = {
            "_id": str(uuid.uuid4()),
            "owner_id": owner_id,
            "note_id": note_id,
            "version": int(version or 1),
            "title": title,
            "content": self._normalize_content(content),
            "excerpt": self._excerpt(search_text),
            "search_text": search_text,
            "tags": tags,
            "properties": dict(properties or {}),
            "favorite": bool(favorite),
            "archived": bool(archived),
            "cover": self._normalize_cover(cover),
            "icon": self._normalize_icon(icon),
            "attachments": attachments,
            "reason": str(reason or "update"),
            "saved_at": saved_at,
            "created_at": saved_at,
        }
        await self._db.note_revisions_collection.insert_one(revision)
        return revision

    @classmethod
    def _render_block_markdown(cls, block: dict) -> str:
        block_type = str((block or {}).get("type") or "")
        data = (block or {}).get("data") if isinstance((block or {}).get("data"), dict) else {}
        text = re.sub(r"\s+", " ", cls._strip_html(data.get("text") or "")).strip()
        if block_type == "header":
            level = max(1, min(int(data.get("level") or 2), 6))
            return f'{"#" * level} {text}'.rstrip()
        if block_type == "list":
            items = data.get("items") if isinstance(data.get("items"), list) else []
            prefix = "1." if str(data.get("style") or "") == "ordered" else "-"
            rendered_items = []
            for item in items:
                if not str(item or "").strip():
                    continue
                clean_item = re.sub(r"\s+", " ", cls._strip_html(item)).strip()
                rendered_items.append(f"{prefix} {clean_item}".rstrip())
            return "\n".join(rendered_items)
        if block_type == "todo":
            checked = "x" if bool(data.get("checked")) else " "
            return f"- [{checked}] {text}".rstrip()
        if block_type == "quote":
            caption = re.sub(r"\s+", " ", cls._strip_html(data.get("caption") or "")).strip()
            body = f"> {text}".rstrip()
            return f"{body}\n>\n> {caption}".rstrip() if caption else body
        if block_type == "codeBlock":
            code = str(data.get("code") or "")
            return f"```\n{code}\n```"
        if block_type == "divider":
            return "---"
        attachment = cls._normalize_attachment(block_type, data)
        if attachment:
            label = attachment["name"] or attachment["path"]
            return f"[{label}]({attachment['path']})"
        return text

    @classmethod
    def _render_block_html(cls, block: dict) -> str:
        block_type = str((block or {}).get("type") or "")
        data = (block or {}).get("data") if isinstance((block or {}).get("data"), dict) else {}
        text = html.escape(re.sub(r"\s+", " ", cls._strip_html(data.get("text") or "")).strip())
        if block_type == "header":
            level = max(1, min(int(data.get("level") or 2), 6))
            return f"<h{level}>{text}</h{level}>"
        if block_type == "list":
            items = data.get("items") if isinstance(data.get("items"), list) else []
            tag = "ol" if str(data.get("style") or "") == "ordered" else "ul"
            body_parts = []
            for item in items:
                if not str(item or "").strip():
                    continue
                clean_item = html.escape(re.sub(r"\s+", " ", cls._strip_html(item)).strip())
                body_parts.append(f"<li>{clean_item}</li>")
            body = "".join(body_parts)
            return f"<{tag}>{body}</{tag}>"
        if block_type == "todo":
            checked = " checked" if bool(data.get("checked")) else ""
            return f'<div class="note-check"><input type="checkbox" disabled{checked}> <span>{text}</span></div>'
        if block_type == "quote":
            caption = html.escape(re.sub(r"\s+", " ", cls._strip_html(data.get("caption") or "")).strip())
            footer = f"<footer>{caption}</footer>" if caption else ""
            return f"<blockquote><p>{text}</p>{footer}</blockquote>"
        if block_type == "codeBlock":
            return f"<pre><code>{html.escape(str(data.get('code') or ''))}</code></pre>"
        if block_type == "divider":
            return "<hr>"
        attachment = cls._normalize_attachment(block_type, data)
        if attachment:
            label = html.escape(attachment["name"] or attachment["path"])
            path = html.escape(attachment["path"])
            kind = html.escape(attachment["kind"])
            return f'<p><a href="{path}" data-kind="{kind}">{label}</a></p>'
        return f"<p>{text}</p>"

    @classmethod
    def _render_markdown(cls, note: dict) -> str:
        blocks = cls._normalize_content(note.get("content")).get("blocks", [])
        clean_title = re.sub(r"\s+", " ", cls._strip_html(note.get("title") or "Sem título")).strip()
        lines = [f"# {clean_title}"]
        tags = cls._normalize_tags(note.get("tags"))
        if tags:
            lines.append("")
            lines.append("Tags: " + ", ".join(f"#{tag}" for tag in tags))
        for block in blocks:
            chunk = cls._render_block_markdown(block).strip()
            if chunk:
                lines.extend(["", chunk])
        return "\n".join(lines).strip() + "\n"

    @classmethod
    def _render_html_document(cls, note: dict) -> str:
        title = html.escape(cls._trimmed_title(note.get("title")))
        tags = cls._normalize_tags(note.get("tags"))
        blocks = cls._normalize_content(note.get("content")).get("blocks", [])
        tag_html = ""
        if tags:
            tag_html = "<p><strong>Tags:</strong> " + " ".join(html.escape(f"#{tag}") for tag in tags) + "</p>"
        body = "\n".join(cls._render_block_html(block) for block in blocks if isinstance(block, dict))
        return (
            "<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"utf-8\">"
            f"<title>{title}</title>"
            "<style>body{font-family:Arial,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1f2937}"
            "pre{background:#111827;color:#f9fafb;padding:16px;border-radius:12px;overflow:auto}"
            "blockquote{border-left:4px solid #d97706;padding-left:16px;color:#4b5563}"
            "a{color:#b45309;text-decoration:none}hr{border:none;border-top:1px solid #d1d5db;margin:24px 0}"
            "</style></head><body>"
            f"<h1>{title}</h1>{tag_html}{body}</body></html>"
        )

    @classmethod
    def _export_filename(cls, note: dict, export_format: str) -> str:
        slug = cls._slugify(str(note.get("title") or "nota"))
        note_id = str(note.get("_id") or note.get("id") or "note")
        suffix = {
            "json": ".tcnote.json",
            "markdown": ".md",
            "html": ".html",
        }.get(export_format, ".txt")
        return f"{slug}-{note_id}{suffix}"

    @classmethod
    def _build_export_payload(cls, note: dict) -> dict:
        serialized = cls._serialize_note(note)
        return {
            "format": "tcloud-note",
            "version": 1,
            "exported_at": cls._to_iso(cls._now()),
            "note": serialized,
        }

    @classmethod
    def _blocks_from_plain_text(cls, text: str) -> list[dict]:
        chunks = [part.strip() for part in re.split(r"\n\s*\n", str(text or "")) if part.strip()]
        if not chunks:
            return cls._default_content()["blocks"]
        return [{"id": uuid.uuid4().hex[:10], "type": "paragraph", "data": {"text": html.escape(chunk)}} for chunk in chunks]

    @classmethod
    def _blocks_from_markdown(cls, text: str) -> list[dict]:
        lines = str(text or "").splitlines()
        blocks = []
        buffer = []
        in_code = False
        code_lines = []

        def flush_paragraph():
            nonlocal buffer
            content = "\n".join(buffer).strip()
            if content:
                blocks.append({"id": uuid.uuid4().hex[:10], "type": "paragraph", "data": {"text": html.escape(content)}})
            buffer = []

        for raw_line in lines:
            line = raw_line.rstrip("\n")
            stripped = line.strip()
            if stripped.startswith("```"):
                if in_code:
                    blocks.append({"id": uuid.uuid4().hex[:10], "type": "codeBlock", "data": {"code": "\n".join(code_lines)}})
                    code_lines = []
                    in_code = False
                else:
                    flush_paragraph()
                    in_code = True
                continue
            if in_code:
                code_lines.append(line)
                continue
            if not stripped:
                flush_paragraph()
                continue
            if re.fullmatch(r"---+", stripped):
                flush_paragraph()
                blocks.append({"id": uuid.uuid4().hex[:10], "type": "divider", "data": {}})
                continue
            header_match = re.match(r"^(#{1,3})\s+(.*)$", stripped)
            if header_match:
                flush_paragraph()
                blocks.append({
                    "id": uuid.uuid4().hex[:10],
                    "type": "header",
                    "data": {"level": len(header_match.group(1)), "text": html.escape(header_match.group(2).strip())},
                })
                continue
            todo_match = re.match(r"^[-*]\s+\[( |x|X)\]\s+(.*)$", stripped)
            if todo_match:
                flush_paragraph()
                blocks.append({
                    "id": uuid.uuid4().hex[:10],
                    "type": "todo",
                    "data": {"checked": todo_match.group(1).lower() == "x", "text": html.escape(todo_match.group(2).strip())},
                })
                continue
            list_match = re.match(r"^([-*]|\d+\.)\s+(.*)$", stripped)
            if list_match:
                flush_paragraph()
                style = "ordered" if list_match.group(1).endswith(".") and list_match.group(1)[:-1].isdigit() else "unordered"
                items = [html.escape(list_match.group(2).strip())]
                blocks.append({"id": uuid.uuid4().hex[:10], "type": "list", "data": {"style": style, "items": items}})
                continue
            quote_match = re.match(r"^>\s?(.*)$", stripped)
            if quote_match:
                flush_paragraph()
                blocks.append({"id": uuid.uuid4().hex[:10], "type": "quote", "data": {"text": html.escape(quote_match.group(1).strip()), "caption": ""}})
                continue
            buffer.append(line)

        if in_code:
            blocks.append({"id": uuid.uuid4().hex[:10], "type": "codeBlock", "data": {"code": "\n".join(code_lines)}})
        flush_paragraph()
        return blocks or cls._default_content()["blocks"]

    @classmethod
    def _import_note_payload(cls, file_name: str, text: str) -> tuple[str, dict]:
        safe_name = str(file_name or "").strip()
        suffix = Path(safe_name).suffix.lower()
        title_hint = Path(safe_name).stem if safe_name else "Importado"
        if safe_name.endswith(".tcnote.json") or suffix == ".json":
            payload = json.loads(text or "{}")
            note_payload = payload.get("note") if isinstance(payload, dict) and isinstance(payload.get("note"), dict) else payload
            title = cls._trimmed_title(note_payload.get("title") or title_hint)
            content = cls._normalize_content(note_payload.get("content"))
            return title, content
        if suffix == ".md":
            return cls._trimmed_title(title_hint), {
                "time": int(cls._now().timestamp() * 1000),
                "blocks": cls._blocks_from_markdown(text),
                "version": "2.31.6",
            }
        return cls._trimmed_title(title_hint), {
            "time": int(cls._now().timestamp() * 1000),
            "blocks": cls._blocks_from_plain_text(text),
            "version": "2.31.6",
        }

    async def get_property_schema(self, owner_id: str) -> dict:
        safe_owner_id = self._owner_id(owner_id)
        properties = []
        cursor = self._db.note_property_schema_collection.find({"owner_id": safe_owner_id}).sort("position", 1)
        async for item in cursor:
            properties.append(self._serialize_property_schema(item))
        if not properties:
            now = self._now()
            status = {
                "_id": "status",
                "owner_id": safe_owner_id,
                "name": "Status",
                "type": "select",
                "options": self._normalize_property_options(["Planejado", "Ativo", "Bloqueado", "Concluído"]),
                "position": 0,
                "created_at": now,
                "updated_at": now,
            }
            await self._db.note_property_schema_collection.insert_one(status)
            properties.append(self._serialize_property_schema(status))
        return {"properties": properties}

    async def update_property_schema(self, owner_id: str, payload: dict | None) -> dict:
        safe_owner_id = self._owner_id(owner_id)
        items = (payload or {}).get("properties") if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            raise ValueError("schema deve conter lista properties")
        now = self._now()
        seen = set()
        for index, item in enumerate(items[:80]):
            normalized = self._normalize_schema_payload(item, position=index)
            prop_id = normalized["_id"]
            if prop_id in seen:
                raise ValueError("ids de propriedades duplicados")
            seen.add(prop_id)
            normalized.update({"owner_id": safe_owner_id, "updated_at": now})
            await self._db.note_property_schema_collection.update_one(
                {"owner_id": safe_owner_id, "_id": prop_id},
                {"$set": normalized, "$setOnInsert": {"created_at": now}},
                upsert=True,
            )
        return await self.get_property_schema(safe_owner_id)

    async def create_property(self, owner_id: str, payload: dict | None) -> dict:
        safe_owner_id = self._owner_id(owner_id)
        count = await self._db.note_property_schema_collection.count_documents({"owner_id": safe_owner_id})
        normalized = self._normalize_schema_payload(payload, position=count)
        now = self._now()
        normalized.update({"owner_id": safe_owner_id, "created_at": now, "updated_at": now})
        await self._db.note_property_schema_collection.insert_one(normalized)
        return {"property": self._serialize_property_schema(normalized), **await self.get_property_schema(safe_owner_id)}

    async def update_property(self, owner_id: str, property_id: str, payload: dict | None) -> dict | None:
        safe_owner_id = self._owner_id(owner_id)
        safe_property_id = self._property_id(property_id)
        existing = await self._db.note_property_schema_collection.find_one({"owner_id": safe_owner_id, "_id": safe_property_id})
        if not existing:
            return None
        normalized = self._normalize_schema_payload(payload, existing=existing)
        normalized.update({"owner_id": safe_owner_id, "updated_at": self._now()})
        doc = await self._db.note_property_schema_collection.find_one_and_update(
            {"owner_id": safe_owner_id, "_id": safe_property_id},
            {"$set": normalized},
            return_document=ReturnDocument.AFTER,
        )
        return {"property": self._serialize_property_schema(doc), **await self.get_property_schema(safe_owner_id)}

    async def delete_property(self, owner_id: str, property_id: str) -> dict | None:
        safe_owner_id = self._owner_id(owner_id)
        safe_property_id = self._property_id(property_id)
        deleted = await self._db.note_property_schema_collection.find_one_and_delete({"owner_id": safe_owner_id, "_id": safe_property_id})
        if not deleted:
            return None
        return {"property": self._serialize_property_schema(deleted), **await self.get_property_schema(safe_owner_id)}

    @classmethod
    def _normalize_view_payload(cls, payload: dict | None, *, existing: dict | None = None, position: int = 0) -> dict:
        payload = dict(payload or {})
        existing = existing or {}
        view_type = str(payload.get("type") or existing.get("type") or "list").strip().lower()
        if view_type not in {"list", "table", "board", "gallery", "calendar"}:
            raise ValueError("tipo de view invalido")
        name = re.sub(r"\s+", " ", str(payload.get("name") or existing.get("name") or "View").strip())[:80]
        if not name:
            raise ValueError("nome da view ausente")
        return {
            "name": name,
            "type": view_type,
            "filters": list(payload.get("filters", existing.get("filters", [])) or [])[:30],
            "sorts": list(payload.get("sorts", existing.get("sorts", [])) or [])[:12],
            "group_by": str(payload.get("group_by", existing.get("group_by", "")) or "").strip()[:120],
            "visible_properties": [str(item) for item in list(payload.get("visible_properties", existing.get("visible_properties", [])) or [])[:80]],
            "position": int(payload.get("position", existing.get("position", position)) or 0),
        }

    async def list_views(self, owner_id: str) -> dict:
        safe_owner_id = self._owner_id(owner_id)
        views = []
        cursor = self._db.note_views_collection.find({"owner_id": safe_owner_id}).sort("position", 1)
        async for item in cursor:
            views.append(self._serialize_view(item))
        if not views:
            for index, (name, view_type) in enumerate((("Lista", "list"), ("Tabela", "table"), ("Quadro", "board"), ("Galeria", "gallery"), ("Calendário", "calendar"))):
                created = await self.create_view(safe_owner_id, {"name": name, "type": view_type, "position": index})
                views.append(created["view"])
        return {"views": views}

    async def create_view(self, owner_id: str, payload: dict | None) -> dict:
        safe_owner_id = self._owner_id(owner_id)
        count = await self._db.note_views_collection.count_documents({"owner_id": safe_owner_id})
        normalized = self._normalize_view_payload(payload, position=count)
        now = self._now()
        doc = {"_id": str(uuid.uuid4()), "owner_id": safe_owner_id, **normalized, "created_at": now, "updated_at": now}
        await self._db.note_views_collection.insert_one(doc)
        return {"view": self._serialize_view(doc)}

    async def get_view(self, owner_id: str, view_id: str) -> dict | None:
        doc = await self._db.note_views_collection.find_one({"owner_id": self._owner_id(owner_id), "_id": str(view_id or "").strip()})
        return {"view": self._serialize_view(doc)} if doc else None

    async def update_view(self, owner_id: str, view_id: str, payload: dict | None) -> dict | None:
        safe_owner_id = self._owner_id(owner_id)
        existing = await self._db.note_views_collection.find_one({"owner_id": safe_owner_id, "_id": str(view_id or "").strip()})
        if not existing:
            return None
        normalized = self._normalize_view_payload(payload, existing=existing)
        doc = await self._db.note_views_collection.find_one_and_update(
            {"owner_id": safe_owner_id, "_id": existing["_id"]},
            {"$set": {**normalized, "updated_at": self._now()}},
            return_document=ReturnDocument.AFTER,
        )
        return {"view": self._serialize_view(doc)}

    async def delete_view(self, owner_id: str, view_id: str) -> dict | None:
        doc = await self._db.note_views_collection.find_one_and_delete({"owner_id": self._owner_id(owner_id), "_id": str(view_id or "").strip()})
        return {"view": self._serialize_view(doc)} if doc else None

    async def duplicate_view(self, owner_id: str, view_id: str) -> dict | None:
        current = await self.get_view(owner_id, view_id)
        if not current:
            return None
        view = current["view"]
        view["name"] = f"{view['name']} copia"
        view.pop("id", None)
        return await self.create_view(owner_id, view)

    @staticmethod
    def _note_field_value(note: dict, field: str):
        if field.startswith("properties."):
            return (note.get("properties") or {}).get(field.split(".", 1)[1])
        return note.get(field)

    @classmethod
    def _value_empty(cls, value) -> bool:
        return value is None or value == "" or value == [] or value == {}

    @classmethod
    def _filter_matches(cls, note: dict, condition: dict) -> bool:
        field = str(condition.get("field") or condition.get("property") or "").strip()
        operator = str(condition.get("operator") or "equals").strip()
        expected = condition.get("value")
        if not field or operator not in cls.FILTER_OPERATORS:
            return True
        actual = cls._note_field_value(note, field)
        if operator == "is_empty":
            return cls._value_empty(actual)
        if operator == "is_not_empty":
            return not cls._value_empty(actual)
        if operator in {"contains", "not_contains"}:
            if isinstance(actual, list):
                result = any(str(expected).casefold() in str(item).casefold() for item in actual)
            else:
                result = str(expected).casefold() in str(actual or "").casefold()
            return result if operator == "contains" else not result
        if operator in {"greater_than", "less_than"}:
            try:
                left = float(actual)
                right = float(expected)
            except (TypeError, ValueError):
                return False
            return left > right if operator == "greater_than" else left < right
        if operator in {"before", "after", "on_or_before", "on_or_after"}:
            left = cls._parse_date(actual)
            right = cls._parse_date(expected)
            if not left or not right:
                return False
            left_value = left.date() if hasattr(left, "date") else left
            right_value = right.date() if hasattr(right, "date") else right
            if operator == "before":
                return left_value < right_value
            if operator == "after":
                return left_value > right_value
            if operator == "on_or_before":
                return left_value <= right_value
            return left_value >= right_value
        if isinstance(actual, list):
            result = any(str(item).casefold() == str(expected).casefold() for item in actual)
        else:
            result = str(actual).casefold() == str(expected).casefold()
        return result if operator == "equals" else not result

    async def query_notes(self, owner_id: str, payload: dict | None = None) -> dict:
        safe_owner_id = self._owner_id(owner_id)
        payload = dict(payload or {})
        result = await self.list_notes(
            safe_owner_id,
            query=str(payload.get("query") or payload.get("q") or "").strip(),
            limit=payload.get("limit", 200),
            include_deleted=bool(payload.get("include_deleted", False)),
            deleted=str(payload.get("deleted") or "").strip(),
            archived=str(payload.get("archived") or "exclude").strip(),
        )
        notes = []
        for summary in result.get("notes") or []:
            full = await self.get_note(safe_owner_id, summary["id"], include_deleted=bool(payload.get("include_deleted", False)))
            if full:
                notes.append(full["note"])

        filters = list(payload.get("filters") or [])
        if filters:
            notes = [note for note in notes if all(self._filter_matches(note, condition) for condition in filters if isinstance(condition, dict))]

        sorts = list(payload.get("sorts") or [])
        for sort in reversed(sorts):
            if not isinstance(sort, dict):
                continue
            field = str(sort.get("field") or "").strip()
            if not field:
                continue
            reverse = str(sort.get("direction") or sort.get("order") or "asc").lower().startswith("desc")
            notes.sort(key=lambda note: str(self._note_field_value(note, field) or "").casefold(), reverse=reverse)

        group_by = str(payload.get("group_by") or "").strip()
        groups = []
        if group_by:
            grouped = {}
            for note in notes:
                value = self._note_field_value(note, group_by)
                if isinstance(value, list):
                    key = ", ".join(str(item) for item in value) or "Vazio"
                elif isinstance(value, bool):
                    key = "Sim" if value else "Não"
                else:
                    key = str(value or "Vazio")
                grouped.setdefault(key, []).append(note)
            groups = [{"key": key, "notes": items, "count": len(items)} for key, items in grouped.items()]
        return {"notes": notes, "groups": groups, "total": len(notes), "schema": (await self.get_property_schema(safe_owner_id))["properties"]}

    async def search_relations(self, owner_id: str, query: str = "", limit: int = 20) -> dict:
        result = await self.list_notes(self._owner_id(owner_id), query=query, limit=limit, archived="exclude")
        return {"notes": result.get("notes") or []}

    async def list_backlinks(self, owner_id: str, note_id: str) -> dict | None:
        note = await self.get_note(owner_id, note_id, include_deleted=True)
        if not note:
            return None
        safe_owner_id = self._owner_id(owner_id)
        ids = list((note.get("note") or {}).get("backlinks") or [])
        links = []
        if ids:
            async for item in self._db.notes_collection.find({"owner_id": safe_owner_id, "_id": {"$in": ids}}, {"content": 0}).sort("updated_at", -1):
                links.append(self._serialize_note(item, include_content=False))
        return {"note_id": note_id, "backlinks": links}

    async def list_notes(
        self,
        owner_id: str,
        *,
        query: str = "",
        limit: int = 100,
        include_deleted: bool = False,
        favorite: bool | None = None,
        tag: str = "",
        deleted: str | None = None,
        archived: str | None = None,
    ) -> dict:
        safe_owner_id = self._owner_id(owner_id)
        safe_limit = max(1, min(int(limit or 100), 200))
        safe_query = str(query or "").strip()
        safe_tag = str(tag or "").strip()
        deleted_mode = str(deleted or "").strip().lower()
        archived_mode = str(archived or "").strip().lower()

        mongo_query = {"owner_id": safe_owner_id}
        if deleted_mode in {"only", "trash"}:
            mongo_query["deleted_at"] = {"$ne": None}
        elif deleted_mode in {"all", "*"} or include_deleted:
            pass
        else:
            mongo_query["deleted_at"] = None

        if favorite is True:
            mongo_query["favorite"] = True
        if safe_tag:
            mongo_query["tags"] = {"$elemMatch": {"$regex": f"^{re.escape(safe_tag)}$", "$options": "i"}}
        if archived_mode in {"only", "true", "1", "yes"}:
            mongo_query["archived"] = True
        elif archived_mode in {"exclude", "false", "0", "no"}:
            mongo_query["archived"] = {"$ne": True}

        projection = {
            "_id": 1,
            "title": 1,
            "excerpt": 1,
            "content": 1,
            "version": 1,
            "favorite": 1,
            "archived": 1,
            "cover": 1,
            "icon": 1,
            "tags": 1,
            "properties": 1,
            "outgoing_links": 1,
            "backlinks": 1,
            "attachments": 1,
            "created_at": 1,
            "updated_at": 1,
            "deleted_at": 1,
        }

        if safe_query:
            escaped = re.escape(safe_query)
            mongo_query["$or"] = [
                {"title": {"$regex": escaped, "$options": "i"}},
                {"search_text": {"$regex": escaped, "$options": "i"}},
                {"tags": {"$elemMatch": {"$regex": escaped, "$options": "i"}}},
            ]

        notes = []
        cursor = self._db.notes_collection.find(mongo_query, projection).sort("updated_at", -1).limit(safe_limit)
        async for note in cursor:
            notes.append(self._serialize_note(note, include_content=False))
        return {
            "notes": notes,
            "query": safe_query,
            "filters": {
                "favorite": favorite is True,
                "tag": safe_tag,
                "deleted": deleted_mode or ("all" if include_deleted else "active"),
                "archived": archived_mode or "all",
            },
        }

    async def list_tags(self, owner_id: str) -> dict:
        safe_owner_id = self._owner_id(owner_id)
        pipeline = [
            {"$match": {"owner_id": safe_owner_id, "deleted_at": None, "tags.0": {"$exists": True}}},
            {"$unwind": "$tags"},
            {"$group": {"_id": {"$toLower": "$tags"}, "tag": {"$first": "$tags"}, "count": {"$sum": 1}}},
            {"$sort": {"count": -1, "tag": 1}},
        ]
        tags = []
        async for item in self._db.notes_collection.aggregate(pipeline):
            tags.append({"tag": str(item.get("tag") or ""), "count": int(item.get("count") or 0)})
        return {"tags": tags}

    async def create_note(self, owner_id: str, *, title: str = "", content: dict | None = None, properties: dict | None = None) -> dict:
        safe_owner_id = self._owner_id(owner_id)
        normalized_title = self._trimmed_title(title)
        normalized_content = self._normalize_content(content)
        attachments = self._extract_attachments(normalized_content)
        tags = []
        normalized_properties = await self._normalize_properties(safe_owner_id, properties or {})
        search_text = self._search_text(normalized_title, normalized_content, tags, normalized_properties)
        now = self._now()
        note = {
            "_id": str(uuid.uuid4()),
            "owner_id": safe_owner_id,
            "title": normalized_title,
            "content": normalized_content,
            "search_text": search_text,
            "excerpt": self._excerpt(search_text),
            "version": 1,
            "favorite": False,
            "archived": False,
            "cover": self._normalize_cover(None),
            "icon": self._normalize_icon(None),
            "tags": tags,
            "properties": normalized_properties,
            "outgoing_links": [],
            "backlinks": [],
            "attachments": attachments,
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        await self._db.notes_collection.insert_one(note)
        await self._create_revision(
            owner_id=safe_owner_id,
            note_id=note["_id"],
            version=1,
            title=normalized_title,
            content=normalized_content,
            tags=tags,
            favorite=False,
            archived=False,
            cover=note["cover"],
            icon=note["icon"],
            properties=normalized_properties,
            saved_at=now,
            reason="create",
        )
        await self._sync_note_links(safe_owner_id, note["_id"], normalized_content)
        saved_note = await self._db.notes_collection.find_one({"_id": note["_id"], "owner_id": safe_owner_id}) or note
        return {"note": self._serialize_note(saved_note)}

    async def get_note(self, owner_id: str, note_id: str, *, include_deleted: bool = False) -> dict | None:
        safe_owner_id = self._owner_id(owner_id)
        safe_note_id = str(note_id or "").strip()
        if not safe_note_id:
            return None

        mongo_query = {"_id": safe_note_id, "owner_id": safe_owner_id}
        if not include_deleted:
            mongo_query["deleted_at"] = None
        note = await self._db.notes_collection.find_one(mongo_query)
        if not note:
            return None
        return {"note": self._serialize_note(note)}

    async def update_note(self, owner_id: str, note_id: str, payload: dict | None = None) -> dict | None:
        safe_owner_id = self._owner_id(owner_id)
        safe_note_id = str(note_id or "").strip()
        if not safe_note_id:
            raise ValueError("note_id ausente")

        existing = await self._db.notes_collection.find_one(
            {"_id": safe_note_id, "owner_id": safe_owner_id, "deleted_at": None}
        )
        if not existing:
            return None

        payload = dict(payload or {})
        next_title = self._trimmed_title(payload["title"]) if "title" in payload else str(existing.get("title") or "Sem título")
        next_content = self._normalize_content(payload["content"]) if "content" in payload else existing.get("content") or self._default_content()
        next_attachments = self._extract_attachments(next_content)
        next_tags = self._normalize_tags(payload["tags"]) if "tags" in payload else self._normalize_tags(existing.get("tags"))
        next_properties = await self._normalize_properties(
            safe_owner_id,
            payload.get("properties") if "properties" in payload else None,
            merge_existing=existing.get("properties") or {},
        )
        next_favorite = self._as_bool(payload.get("favorite"), default=bool(existing.get("favorite", False))) if "favorite" in payload else bool(existing.get("favorite", False))
        next_archived = self._as_bool(payload.get("archived"), default=bool(existing.get("archived", False))) if "archived" in payload else bool(existing.get("archived", False))
        existing_cover, existing_icon = self._normalize_note_appearance(existing)
        next_cover = self._normalize_cover(payload.get("cover")) if "cover" in payload else existing_cover
        next_icon = self._normalize_icon(payload.get("icon")) if "icon" in payload else existing_icon

        title_changed = next_title != str(existing.get("title") or "")
        current_content_json = json.dumps(self._normalize_content(existing.get("content")), ensure_ascii=False, sort_keys=True)
        next_content_json = json.dumps(self._normalize_content(next_content), ensure_ascii=False, sort_keys=True)
        content_changed = "content" in payload and next_content_json != current_content_json
        tags_changed = next_tags != self._normalize_tags(existing.get("tags"))
        properties_changed = json.dumps(next_properties, ensure_ascii=False, sort_keys=True) != json.dumps(existing.get("properties") or {}, ensure_ascii=False, sort_keys=True)
        favorite_changed = next_favorite != bool(existing.get("favorite", False))
        archived_changed = next_archived != bool(existing.get("archived", False))
        cover_changed = json.dumps(next_cover, ensure_ascii=False, sort_keys=True) != json.dumps(existing_cover, ensure_ascii=False, sort_keys=True)
        icon_changed = json.dumps(next_icon, ensure_ascii=False, sort_keys=True) != json.dumps(existing_icon, ensure_ascii=False, sort_keys=True)

        if not any((title_changed, content_changed, tags_changed, properties_changed, favorite_changed, archived_changed, cover_changed, icon_changed)):
            return {"note": self._serialize_note(existing), "saved_content": False}

        now = self._now()
        search_text = self._search_text(next_title, next_content, next_tags, next_properties)
        update_payload = {
            "title": next_title,
            "search_text": search_text,
            "excerpt": self._excerpt(search_text),
            "tags": next_tags,
            "properties": next_properties,
            "favorite": next_favorite,
            "archived": next_archived,
            "cover": next_cover,
            "icon": next_icon,
            "attachments": next_attachments,
            "updated_at": now,
        }
        saved_revision = None
        next_version = int(existing.get("version") or 1)
        revision_reason = "update"
        if content_changed:
            next_version += 1
            update_payload["content"] = next_content
            update_payload["version"] = next_version
            saved_revision = self._serialize_revision(
                await self._create_revision(
                    owner_id=safe_owner_id,
                    note_id=safe_note_id,
                    version=next_version,
                    title=next_title,
                    content=next_content,
                    tags=next_tags,
                    favorite=next_favorite,
                    archived=next_archived,
                    cover=next_cover,
                    icon=next_icon,
                    properties=next_properties,
                    saved_at=now,
                    reason=revision_reason,
                )
            )
        elif any((title_changed, tags_changed, properties_changed, favorite_changed, archived_changed, cover_changed, icon_changed)):
            update_payload["version"] = next_version

        doc = await self._db.notes_collection.find_one_and_update(
            {"_id": safe_note_id, "owner_id": safe_owner_id, "deleted_at": None},
            {"$set": update_payload},
            return_document=ReturnDocument.AFTER,
        )
        if content_changed or title_changed:
            await self._sync_note_links(safe_owner_id, safe_note_id, next_content)
            doc = await self._db.notes_collection.find_one({"_id": safe_note_id, "owner_id": safe_owner_id}) or doc

        return {
            "note": self._serialize_note(doc),
            "saved_content": content_changed,
            "revision": saved_revision,
        }

    async def delete_note(self, owner_id: str, note_id: str) -> dict | None:
        safe_owner_id = self._owner_id(owner_id)
        safe_note_id = str(note_id or "").strip()
        if not safe_note_id:
            raise ValueError("note_id ausente")

        now = self._now()
        doc = await self._db.notes_collection.find_one_and_update(
            {"_id": safe_note_id, "owner_id": safe_owner_id, "deleted_at": None},
            {"$set": {"deleted_at": now, "updated_at": now}},
            return_document=ReturnDocument.AFTER,
        )
        if not doc:
            return None
        return {"note": self._serialize_note(doc)}

    async def restore_note(self, owner_id: str, note_id: str) -> dict | None:
        safe_owner_id = self._owner_id(owner_id)
        safe_note_id = str(note_id or "").strip()
        if not safe_note_id:
            raise ValueError("note_id ausente")

        now = self._now()
        doc = await self._db.notes_collection.find_one_and_update(
            {"_id": safe_note_id, "owner_id": safe_owner_id, "deleted_at": {"$ne": None}},
            {"$set": {"deleted_at": None, "updated_at": now}},
            return_document=ReturnDocument.AFTER,
        )
        if not doc:
            return None
        return {"note": self._serialize_note(doc)}

    async def list_revisions(self, owner_id: str, note_id: str, *, limit: int = 50) -> dict | None:
        safe_owner_id = self._owner_id(owner_id)
        safe_note_id = str(note_id or "").strip()
        safe_limit = max(1, min(int(limit or 50), 100))
        if not safe_note_id:
            raise ValueError("note_id ausente")

        note = await self._db.notes_collection.find_one({"_id": safe_note_id, "owner_id": safe_owner_id})
        if not note:
            return None

        revisions = []
        cursor = self._db.note_revisions_collection.find(
            {"owner_id": safe_owner_id, "note_id": safe_note_id}
        ).sort("version", -1).limit(safe_limit)
        async for revision in cursor:
            revisions.append(self._serialize_revision(revision))
        return {"revisions": revisions, "note": self._serialize_note(note, include_content=False)}

    async def restore_revision(self, owner_id: str, note_id: str, version: int) -> dict | None:
        safe_owner_id = self._owner_id(owner_id)
        safe_note_id = str(note_id or "").strip()
        safe_version = int(version or 0)
        if not safe_note_id:
            raise ValueError("note_id ausente")
        if safe_version <= 0:
            raise ValueError("version invalida")

        note = await self._db.notes_collection.find_one(
            {"_id": safe_note_id, "owner_id": safe_owner_id, "deleted_at": None}
        )
        if not note:
            return None

        revision = await self._db.note_revisions_collection.find_one(
            {"owner_id": safe_owner_id, "note_id": safe_note_id, "version": safe_version}
        )
        if not revision:
            return None

        now = self._now()
        next_version = int(note.get("version") or 1) + 1
        next_title = self._trimmed_title(revision.get("title"))
        next_content = self._normalize_content(revision.get("content"))
        next_tags = self._normalize_tags(revision.get("tags"))
        next_properties = dict(revision.get("properties") or {})
        next_favorite = bool(revision.get("favorite", False))
        next_archived = bool(revision.get("archived", False))
        next_cover, next_icon = self._normalize_note_appearance(revision)
        next_attachments = self._extract_attachments(next_content)
        search_text = self._search_text(next_title, next_content, next_tags, next_properties)

        doc = await self._db.notes_collection.find_one_and_update(
            {"_id": safe_note_id, "owner_id": safe_owner_id, "deleted_at": None},
            {
                "$set": {
                    "title": next_title,
                    "content": next_content,
                    "tags": next_tags,
                    "properties": next_properties,
                    "favorite": next_favorite,
                    "archived": next_archived,
                    "cover": next_cover,
                    "icon": next_icon,
                    "attachments": next_attachments,
                    "search_text": search_text,
                    "excerpt": self._excerpt(search_text),
                    "version": next_version,
                    "updated_at": now,
                }
            },
            return_document=ReturnDocument.AFTER,
        )
        restored_revision = await self._create_revision(
            owner_id=safe_owner_id,
            note_id=safe_note_id,
            version=next_version,
            title=next_title,
            content=next_content,
            tags=next_tags,
            favorite=next_favorite,
            archived=next_archived,
            cover=next_cover,
            icon=next_icon,
            properties=next_properties,
            saved_at=now,
            reason="restore",
        )
        await self._sync_note_links(safe_owner_id, safe_note_id, next_content)
        doc = await self._db.notes_collection.find_one({"_id": safe_note_id, "owner_id": safe_owner_id}) or doc
        return {
            "note": self._serialize_note(doc),
            "revision": self._serialize_revision(restored_revision),
            "restored_from_version": safe_version,
        }

    async def list_attachments(self, owner_id: str, note_id: str) -> dict | None:
        result = await self.get_note(owner_id, note_id, include_deleted=True)
        if not result:
            return None
        return {
            "note_id": note_id,
            "attachments": list((result.get("note") or {}).get("attachments") or []),
        }

    async def export_note(self, owner_id: str, note_id: str, export_format: str) -> dict | None:
        safe_format = str(export_format or "json").strip().lower()
        note_result = await self.get_note(owner_id, note_id, include_deleted=True)
        if not note_result:
            return None
        note = note_result["note"]
        note_doc = {
            "_id": note["id"],
            **note,
        }
        if safe_format == "json":
            content = json.dumps(self._build_export_payload(note_doc), ensure_ascii=False, indent=2)
            content_type = "application/json; charset=utf-8"
        elif safe_format == "markdown":
            content = self._render_markdown(note_doc)
            content_type = "text/markdown; charset=utf-8"
        elif safe_format == "html":
            content = self._render_html_document(note_doc)
            content_type = "text/html; charset=utf-8"
        else:
            raise ValueError("formato de exportacao invalido")
        return {
            "format": safe_format,
            "filename": self._export_filename(note_doc, safe_format),
            "content_type": content_type,
            "content": content,
            "note": note,
        }

    async def import_note(self, owner_id: str, *, file_name: str, text_content: str) -> dict:
        title, content = self._import_note_payload(file_name, text_content)
        result = await self.create_note(owner_id, title=title, content=content)
        return {
            "note": result["note"],
            "source_file": str(file_name or ""),
        }

    async def backup_note(self, owner_id: str, note_id: str) -> dict | None:
        if not self._file_manager:
            raise NotImplementedError("backup no VFS indisponivel sem file_manager")
        export_payload = await self.export_note(owner_id, note_id, "json")
        if not export_payload:
            return None
        note = export_payload["note"]
        timestamp = self._now().strftime("%Y%m%d-%H%M%S")
        slug = self._slugify(note.get("title") or "nota")
        backup_dir = "/Notas/Backups"
        backup_path = f"{backup_dir}/{slug}-{note['id']}-{timestamp}.tcnote.json"
        await self._file_manager.create_directory("/Notas")
        await self._file_manager.create_directory(backup_dir)

        temp_path = ""
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".tcnote.json", delete=False, encoding="utf-8") as handle:
                handle.write(export_payload["content"])
                temp_path = handle.name
            await self._file_manager.upload_file(temp_path, backup_path)
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)

        return {
            "status": "ok",
            "path": backup_path,
            "filename": Path(backup_path).name,
            "note": note,
        }
