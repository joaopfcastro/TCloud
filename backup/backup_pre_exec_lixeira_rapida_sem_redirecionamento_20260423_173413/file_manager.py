"""
TCloud - File Manager
Orchestrates file operations: chunking, upload/download via Telegram, metadata via MongoDB.
"""

from __future__ import annotations

import asyncio
import io
import logging
import mimetypes
import os
import random
import re
import secrets
import shutil
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import aiofiles
import mutagen
from bson import ObjectId
from mutagen import File
from mutagen.id3 import ID3, APIC
from mutagen.mp3 import MP3
from mutagen.easyid3 import EasyID3
from mutagen.flac import FLAC
from mutagen.mp4 import MP4, MP4Cover
try:
    from PIL import ExifTags, Image, ImageOps
except Exception:  # pragma: no cover - optional dependency at runtime
    ExifTags = None
    Image = None
    ImageOps = None
try:
    import fitz
except Exception:  # pragma: no cover - optional dependency at runtime
    fitz = None

from config import Config
from telegram_client import TelegramManager
from database import Database
from download_manager import DownloadCache
from media_track_labels import build_subtitle_label

logger = logging.getLogger("tcloud.file_manager")

_PDF_THUMB_TRANSIENT_FAILURE_REASONS = {
    "download_failed",
    "exception",
    "source_unavailable",
}
_PDF_THUMB_PERMANENT_FAILURE_REASONS = {
    "encrypted",
    "missing_renderer",
    "render_failed",
    "size_limit_exceeded",
}

_PDF_LITERAL_RE = rb"((?:\\.|[^\\)])*)"
_PDF_PAGE_RE = re.compile(rb"/Type\s*/Page\b")
_PDF_CREATOR_RE = re.compile(rb"/Creator\s*\(" + _PDF_LITERAL_RE + rb"\)", re.DOTALL)
_PDF_PRODUCER_RE = re.compile(rb"/Producer\s*\(" + _PDF_LITERAL_RE + rb"\)", re.DOTALL)
_PDF_VERSION_RE = re.compile(rb"%PDF-(\d\.\d)")
_PDF_ENCRYPT_RE = re.compile(rb"/Encrypt\b")
_IMAGE_ORIENTATION_MAP = {
    1: "Normal",
    2: "Espelhada horizontalmente",
    3: "Rotacionada 180°",
    4: "Espelhada verticalmente",
    5: "Espelhada e rotacionada 90° anti-horário",
    6: "Rotacionada 90° horário",
    7: "Espelhada e rotacionada 90° horário",
    8: "Rotacionada 90° anti-horário",
}

EXTERNALIZABLE_MKV_SUBTITLE_CODECS = {
    "ass",
    "mov_text",
    "srt",
    "ssa",
    "subrip",
    "text",
    "webvtt",
}

_STATIC_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".heic"}


def _sanitize_generated_token(value: str, fallback: str = "") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", ".", str(value or "").strip()).strip(".-_")
    return cleaned or fallback


def _build_generated_subtitle_filename(
    video_filename: str,
    *,
    track_index: int,
    language: str = "",
    forced: bool = False,
    default: bool = False,
    extension: str = ".vtt",
) -> str:
    video_stem = Path(video_filename or "video.mkv").stem or "video"
    suffix_tokens = [f"tcloud.embedded.{int(track_index)}"]
    normalized_language = _sanitize_generated_token(language.lower(), "")
    if normalized_language:
        suffix_tokens.append(normalized_language)
    if forced:
        suffix_tokens.append("forced")
    if default:
        suffix_tokens.append("default")
    ext = extension if str(extension or "").startswith(".") else f".{extension}"
    return f"{video_stem}.{'.'.join(suffix_tokens)}{ext or '.vtt'}"


def _build_externalized_subtitle_label(
    *,
    language: str,
    title: str,
    track_index: int,
    filename: str,
    path: str = "",
    forced: bool = False,
    default: bool = False,
    hearing_impaired: bool = False,
    comment: bool = False,
    captions: bool = False,
) -> str:
    return build_subtitle_label(
        language=language,
        title=title,
        index=track_index,
        filename=filename,
        src=path or filename,
        forced=forced,
        default=default,
        hearing_impaired=hearing_impaired,
        comment=comment,
        captions=captions,
    )


def _coerce_float(value):
    try:
        if value in (None, "", "N/A"):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_int(value):
    try:
        if value in (None, "", "N/A"):
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _parse_ffprobe_rate(value):
    if not value or value in ("0/0", "N/A"):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value)
    if "/" in text:
        num, den = text.split("/", 1)
        numerator = _coerce_float(num)
        denominator = _coerce_float(den)
        if numerator is None or not denominator:
            return None
        return numerator / denominator
    return _coerce_float(text)


def _decode_pdf_literal(value: bytes | None) -> str | None:
    if not value:
        return None
    raw = value
    raw = raw.replace(b"\\n", b"\n").replace(b"\\r", b"\r").replace(b"\\t", b"\t")
    raw = raw.replace(b"\\(", b"(").replace(b"\\)", b")").replace(b"\\\\", b"\\")

    def _replace_octal(match: re.Match[bytes]) -> bytes:
        try:
            return bytes([int(match.group(1), 8)])
        except Exception:
            return match.group(0)

    raw = re.sub(rb"\\([0-7]{1,3})", _replace_octal, raw)
    text = raw.decode("utf-8", "ignore").strip()
    return text or None


def scan_pdf_metadata(file_path: Path, max_scan_bytes: int = 64 * 1024 * 1024) -> dict:
    meta = {
        "page_count": None,
        "creator": None,
        "producer": None,
        "encrypted": None,
        "pdf_version": None,
    }

    try:
        if not file_path.exists() or not file_path.is_file():
            return meta

        with file_path.open("rb") as handle:
            header = handle.read(1024)

        version_match = _PDF_VERSION_RE.search(header)
        if version_match:
            meta["pdf_version"] = version_match.group(1).decode("ascii", "ignore")

        file_size = file_path.stat().st_size
        if file_size > max_scan_bytes:
            return meta

        data = file_path.read_bytes()
        meta["page_count"] = len(_PDF_PAGE_RE.findall(data)) or None
        meta["encrypted"] = bool(_PDF_ENCRYPT_RE.search(data))

        creator_match = _PDF_CREATOR_RE.search(data)
        producer_match = _PDF_PRODUCER_RE.search(data)
        meta["creator"] = _decode_pdf_literal(creator_match.group(1)) if creator_match else None
        meta["producer"] = _decode_pdf_literal(producer_match.group(1)) if producer_match else None
    except Exception as exc:
        logger.debug(f"PDF metadata extraction failed for {file_path.name}: {exc}")

    return meta


def scan_image_metadata(file_path: Path) -> dict:
    meta = {
        "width": None,
        "height": None,
        "image_format": None,
        "camera_make": None,
        "camera_model": None,
        "captured_at": None,
        "orientation": None,
    }

    if Image is None:
        return meta

    try:
        with Image.open(file_path) as img:
            meta["width"], meta["height"] = img.size
            meta["image_format"] = (img.format or "").upper() or None
            exif = img.getexif() if hasattr(img, "getexif") else None
            if exif:
                for tag_id, value in exif.items():
                    tag_name = ExifTags.TAGS.get(tag_id, tag_id) if ExifTags else tag_id
                    if tag_name == "Make" and value:
                        meta["camera_make"] = str(value).strip() or None
                    elif tag_name == "Model" and value:
                        meta["camera_model"] = str(value).strip() or None
                    elif tag_name in {"DateTimeOriginal", "DateTime"} and value and not meta["captured_at"]:
                        meta["captured_at"] = str(value).strip() or None
                    elif tag_name == "Orientation":
                        orientation_value = _coerce_int(value)
                        if orientation_value:
                            meta["orientation"] = _IMAGE_ORIENTATION_MAP.get(orientation_value) or str(orientation_value)
    except Exception as exc:
        logger.debug(f"Image metadata extraction failed for {file_path.name}: {exc}")

    return meta


def _image_format_to_content_type(image_format: str | None) -> str | None:
    if not image_format:
        return None
    normalized = str(image_format).strip().upper()
    return {
        "JPEG": "image/jpeg",
        "JPG": "image/jpeg",
        "PNG": "image/png",
        "GIF": "image/gif",
        "WEBP": "image/webp",
        "BMP": "image/bmp",
        "ICO": "image/x-icon",
        "TIFF": "image/tiff",
        "HEIF": "image/heif",
        "HEIC": "image/heic",
    }.get(normalized)


def _detect_image_content_type(data: bytes) -> str | None:
    if not data:
        return None

    if Image is not None:
        try:
            with Image.open(io.BytesIO(data)) as img:
                detected = _image_format_to_content_type(getattr(img, "format", None))
                if detected:
                    return detected
        except Exception:
            pass

    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"BM"):
        return "image/bmp"
    return None


def _render_image_source_to_jpeg_bytes(source: Path | bytes, *, max_size: tuple[int, int] = (320, 320)) -> bytes | None:
    if Image is None:
        return None

    try:
        image_source = source if isinstance(source, Path) else io.BytesIO(source)
        with Image.open(image_source) as img:
            working = ImageOps.exif_transpose(img) if ImageOps is not None else img

            if max_size:
                resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
                working.thumbnail(max_size, resampling)

            has_alpha = "A" in working.getbands() or working.info.get("transparency") is not None
            if has_alpha:
                rgba = working.convert("RGBA")
                background = Image.new("RGB", rgba.size, (24, 24, 24))
                background.paste(rgba, mask=rgba.getchannel("A"))
                working = background
            elif working.mode != "RGB":
                working = working.convert("RGB")

            buffer = io.BytesIO()
            working.save(buffer, format="JPEG", quality=82, optimize=True)
            return buffer.getvalue()
    except Exception as exc:
        logger.debug(f"Thumbnail normalization failed: {exc}")
        return None


def _finalize_thumbnail_payload(data: bytes | None) -> tuple[bytes, str] | None:
    if not data:
        return None

    normalized = _render_image_source_to_jpeg_bytes(data)
    if normalized:
        return normalized, "image/jpeg"

    content_type = _detect_image_content_type(data)
    if content_type:
        return data, content_type

    return None


def _render_pdf_first_page_to_jpeg_bytes(file_path: Path, *, max_size: tuple[int, int] = (320, 320)) -> bytes | None:
    if fitz is None or Image is None:
        return None

    document = None
    try:
        document = fitz.open(file_path)
        if getattr(document, "needs_pass", False):
            logger.info(f"PDF thumbnail skipped for encrypted file: {file_path}")
            return None
        if getattr(document, "page_count", 0) <= 0:
            return None

        page = document.load_page(0)
        page_rect = page.rect
        longest_edge = max(float(page_rect.width or 0), float(page_rect.height or 0), 1.0)
        scale = min(2.0, max(1.0, 900.0 / longest_edge))
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        return _render_image_source_to_jpeg_bytes(pixmap.tobytes("png"), max_size=max_size)
    except Exception as exc:
        logger.debug(f"PDF thumbnail rendering failed for {file_path.name}: {exc}")
        return None
    finally:
        if document is not None:
            try:
                document.close()
            except Exception:
                pass


class FileManager:
    """
    High-level file operations bridging FTP, Telegram, and MongoDB.
    Handles chunked uploads/downloads, staging, and cleanup.
    """

    def __init__(self, telegram: TelegramManager, db: Database):
        self._telegram = telegram
        self._db = db
        self._upload_semaphore = asyncio.Semaphore(Config.MAX_WORKERS)
        self.active_uploads = {}  # {upload_id: {file_id, parts_count, ...}}
        self._cache = DownloadCache(telegram, db)
        
        # Lock to serialize FUSE concurrent read requests
        self._read_locks = {}
        
        # Thumbnail cache protection and memory storage
        self._thumb_locks: dict[str, asyncio.Lock] = {}
        self._thumb_mem_cache: dict[str, tuple[bytes, str]] = {}
        self._pdf_thumb_semaphore = asyncio.Semaphore(max(1, getattr(Config, "PDF_THUMB_CONCURRENCY", 1)))
        self._pdf_thumb_warmup_tasks: dict[str, asyncio.Task[None]] = {}
        logger.info(
            "PDF thumbnail renderer: %s",
            "enabled (PyMuPDF available)" if fitz is not None else "disabled (PyMuPDF missing)"
        )

    def _thumbnail_disk_path(self, virtual_path: str) -> Path:
        safe_name = virtual_path.replace('/', '_').strip('_')
        import hashlib
        file_hash = hashlib.md5(virtual_path.encode()).hexdigest()[:8]
        thumb_dir = Config.CACHE_DIR / ".thumbs"
        return thumb_dir / f"{safe_name}_{file_hash}.jpg"

    def _thumbnail_negative_cache_path(self, virtual_path: str) -> Path:
        return self._thumbnail_disk_path(virtual_path).with_suffix(".failed")

    def _clear_thumbnail_negative_cache(self, virtual_path: str) -> None:
        marker = self._thumbnail_negative_cache_path(virtual_path)
        if marker.exists():
            try:
                marker.unlink()
            except OSError:
                pass

    def _mark_thumbnail_failure(self, virtual_path: str, reason: str) -> None:
        marker = self._thumbnail_negative_cache_path(virtual_path)
        marker.parent.mkdir(parents=True, exist_ok=True)
        try:
            marker.write_text(f"{int(time.time())}:{reason}\n", encoding="utf-8")
        except OSError:
            pass

    def _thumbnail_failure_ttl(self, reason: str | None) -> int:
        if reason in _PDF_THUMB_TRANSIENT_FAILURE_REASONS:
            return 120
        if reason in _PDF_THUMB_PERMANENT_FAILURE_REASONS:
            return max(300, int(getattr(Config, "PDF_THUMB_NEGATIVE_CACHE_TTL", 1800)))
        return max(60, int(getattr(Config, "PDF_THUMB_NEGATIVE_CACHE_TTL", 1800)))

    def _read_thumbnail_failure_marker(self, virtual_path: str) -> tuple[int | None, str | None]:
        marker = self._thumbnail_negative_cache_path(virtual_path)
        if not marker.exists():
            return None, None

        try:
            raw = marker.read_text(encoding="utf-8", errors="ignore").strip()
        except OSError:
            return None, None

        if not raw:
            return None, None

        if ":" not in raw:
            return None, raw

        timestamp_raw, reason = raw.split(":", 1)
        try:
            return int(timestamp_raw), reason or None
        except ValueError:
            return None, reason or None

    def _is_thumbnail_failure_cached(self, virtual_path: str) -> bool:
        marker = self._thumbnail_negative_cache_path(virtual_path)
        if not marker.exists():
            return False

        _, reason = self._read_thumbnail_failure_marker(virtual_path)
        if reason == "missing_renderer" and fitz is not None:
            logger.info(
                "Ignoring stale PDF thumbnail negative cache for %s because the renderer is now available",
                virtual_path,
            )
            self._clear_thumbnail_negative_cache(virtual_path)
            return False

        ttl = self._thumbnail_failure_ttl(reason)
        try:
            if (time.time() - marker.stat().st_mtime) <= ttl:
                return True
            marker.unlink()
        except OSError:
            pass
        return False

    def _make_pdf_thumb_temp_path(self, virtual_path: str, suffix: str = ".pdf") -> Path:
        safe_stem = Path(virtual_path or "document").stem or "document"
        safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", safe_stem)[:80] or "document"
        thumb_dir = Config.STAGING_DIR / "thumbs"
        thumb_dir.mkdir(parents=True, exist_ok=True)
        return thumb_dir / f"{safe_stem}_{secrets.token_hex(6)}{suffix}"

    async def _cache_thumbnail_payload(self, virtual_path: str, payload: tuple[bytes, str], thumb_path: Path | None = None) -> None:
        disk_path = thumb_path or self._thumbnail_disk_path(virtual_path)
        payload_bytes, _ = payload
        disk_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            async with aiofiles.open(disk_path, "wb") as f:
                await f.write(payload_bytes)
        except Exception as e:
            logger.warning(f"Failed to cache thumbnail to disk: {e}")

        if len(self._thumb_mem_cache) > 2000:
            self._thumb_mem_cache.clear()
        self._thumb_mem_cache[virtual_path] = payload
        self._clear_thumbnail_negative_cache(virtual_path)

    async def _ensure_pdf_thumbnail_cached(self, virtual_path: str, file_meta: dict | None = None) -> tuple[bytes, str] | None:
        thumb_path = self._thumbnail_disk_path(virtual_path)
        lock = self._thumb_locks.setdefault(virtual_path, asyncio.Lock())

        async with lock:
            if virtual_path in self._thumb_mem_cache:
                return self._thumb_mem_cache[virtual_path]

            if thumb_path.exists():
                try:
                    async with aiofiles.open(thumb_path, "rb") as f:
                        data = await f.read()
                    payload = _finalize_thumbnail_payload(data)
                    if payload:
                        if len(self._thumb_mem_cache) > 2000:
                            self._thumb_mem_cache.clear()
                        self._thumb_mem_cache[virtual_path] = payload
                        return payload
                except OSError:
                    pass

            if self._is_thumbnail_failure_cached(virtual_path):
                return None

            if file_meta is None:
                file_meta = await self._db.get_file(virtual_path)
            if not file_meta or not file_meta.get("chunks"):
                return None

            preview_asset_path = self._get_preview_asset_path(file_meta)
            if preview_asset_path:
                preview_payload = await self._load_preview_asset_payload(preview_asset_path)
                if preview_payload:
                    await self._cache_thumbnail_payload(virtual_path, preview_payload, thumb_path=thumb_path)
                    return preview_payload

            chunks = file_meta.get("chunks", [])
            if chunks:
                thumb = await self._telegram.download_thumbnail(chunks[0]["message_id"])
                payload = _finalize_thumbnail_payload(thumb)
                if payload:
                    await self._cache_thumbnail_payload(virtual_path, payload, thumb_path=thumb_path)
                    return payload

            thumb_bytes = await self._get_pdf_thumbnail_bytes(virtual_path, file_meta)
            payload = _finalize_thumbnail_payload(thumb_bytes)
            if payload:
                await self._cache_thumbnail_payload(virtual_path, payload, thumb_path=thumb_path)
            return payload

    async def _run_pdf_thumbnail_warmup(self, virtual_path: str, file_meta: dict) -> None:
        try:
            await self._ensure_pdf_thumbnail_cached(virtual_path, file_meta)
        except Exception as exc:
            logger.warning(f"PDF thumbnail warmup failed for {virtual_path}: {exc}")
        finally:
            self._pdf_thumb_warmup_tasks.pop(virtual_path, None)

    def schedule_pdf_thumbnail_warmup(self, virtual_path: str, file_meta: dict | None) -> None:
        if not file_meta:
            return
        if Path(virtual_path).suffix.lower() != ".pdf":
            return
        if fitz is None:
            return
        if virtual_path in self._thumb_mem_cache:
            return
        if self._thumbnail_disk_path(virtual_path).exists():
            return

        existing_task = self._pdf_thumb_warmup_tasks.get(virtual_path)
        if existing_task and not existing_task.done():
            return

        self._pdf_thumb_warmup_tasks[virtual_path] = asyncio.create_task(
            self._run_pdf_thumbnail_warmup(virtual_path, file_meta)
        )

    def _stitch_cached_chunks_to_file(self, virtual_path: str, chunks: list[dict], dest_path: Path) -> Path:
        chunk_paths = self._cache.get_all_chunk_paths(virtual_path, chunks)
        with open(dest_path, "wb") as out_file:
            for chunk_path in chunk_paths:
                with open(chunk_path, "rb") as chunk_file:
                    shutil.copyfileobj(chunk_file, out_file, length=1024 * 1024)
        return dest_path

    async def _materialize_pdf_source(self, virtual_path: str, file_meta: dict) -> tuple[Path | None, bool, str | None]:
        cached_path = self.get_cached_file_path(file_meta, virtual_path)
        if cached_path and Path(cached_path).exists():
            return Path(cached_path), False, None

        chunks = file_meta.get("chunks", [])
        if chunks and self._cache.is_fully_cached(virtual_path, chunks):
            temp_path = self._make_pdf_thumb_temp_path(virtual_path)
            await asyncio.to_thread(self._stitch_cached_chunks_to_file, virtual_path, chunks, temp_path)
            return temp_path, True, None

        size_bytes = _coerce_int(file_meta.get("size")) or 0
        max_bytes = max(1, int(getattr(Config, "PDF_THUMB_MAX_MB", 80))) * 1024 * 1024
        if size_bytes > max_bytes:
            logger.info(
                "Skipping on-demand PDF thumbnail for %s: %s bytes exceeds %s bytes limit",
                virtual_path,
                size_bytes,
                max_bytes,
            )
            return None, False, "size_limit_exceeded"

        temp_path = self._make_pdf_thumb_temp_path(virtual_path)
        try:
            logger.info("🎬 Materializing PDF source for thumbnail: %s (%s MB)", virtual_path, size_bytes / 1024 / 1024)
            await self.download_file(virtual_path, temp_path)
            if not temp_path.exists() or temp_path.stat().st_size == 0:
                raise RuntimeError("Staged file is empty or missing")
            logger.info("✅ PDF source materialized for %s", virtual_path)
        except Exception as exc:
            logger.warning(f"❌ Failed to materialize PDF source for {virtual_path}: {exc}")
            try:
                if temp_path.exists():
                    temp_path.unlink()
            except OSError:
                pass
            return None, False, "download_failed"
        return temp_path, True, None

    async def _get_pdf_thumbnail_bytes(self, virtual_path: str, file_meta: dict) -> bytes | None:
        if fitz is None:
            logger.info("PDF thumbnail requested for %s but PyMuPDF is unavailable", virtual_path)
            self._mark_thumbnail_failure(virtual_path, "missing_renderer")
            return None

        async with self._pdf_thumb_semaphore:
            source_path = None
            should_cleanup = False
            started_at = time.perf_counter()
            try:
                source_path, should_cleanup, failure_reason = await self._materialize_pdf_source(virtual_path, file_meta)
                if source_path is None:
                    self._mark_thumbnail_failure(virtual_path, failure_reason or "source_unavailable")
                    return None

                thumb_bytes = await asyncio.to_thread(_render_pdf_first_page_to_jpeg_bytes, source_path)
                elapsed = time.perf_counter() - started_at
                if thumb_bytes:
                    logger.info("📄 PDF thumbnail rendered for %s in %.3fs", virtual_path, elapsed)
                    self._clear_thumbnail_negative_cache(virtual_path)
                    return thumb_bytes

                logger.info("PDF thumbnail unavailable for %s after %.3fs", virtual_path, elapsed)
                self._mark_thumbnail_failure(virtual_path, "render_failed")
                return None
            except Exception as exc:
                elapsed = time.perf_counter() - started_at
                logger.warning(f"PDF thumbnail generation failed for {virtual_path} after {elapsed:.3f}s: {exc}")
                self._mark_thumbnail_failure(virtual_path, "exception")
                return None
            finally:
                if should_cleanup and source_path and source_path.exists():
                    try:
                        source_path.unlink()
                    except OSError:
                        pass

    def _invalidate_thumbnail_cache(self, virtual_path: str) -> None:
        self._thumb_mem_cache.pop(virtual_path, None)
        self._clear_thumbnail_negative_cache(virtual_path)
        thumb_path = self._thumbnail_disk_path(virtual_path)
        if thumb_path.exists():
            try:
                thumb_path.unlink()
            except OSError:
                pass

    def _build_pdf_preview_sidecar_path(self, pdf_path: str, asset_id: str | None = None) -> str:
        token = _sanitize_generated_token(asset_id or secrets.token_hex(16), fallback=secrets.token_hex(16))
        return self._db._normalize_path(f"/.sys/pdf_thumbs/{token}.jpg")

    def _get_preview_asset_metadata(self, file_doc: dict | None) -> dict:
        meta = (file_doc or {}).get("meta") or {}
        preview_asset = meta.get("preview_asset")
        return preview_asset if isinstance(preview_asset, dict) else {}

    def _get_preview_asset_path(self, file_doc: dict | None) -> str:
        preview_asset = self._get_preview_asset_metadata(file_doc)
        path = preview_asset.get("path")
        return self._db._normalize_path(path) if isinstance(path, str) and path.strip() else ""

    def _build_pdf_preview_asset_failure(self, *, generated_from: str, reason: str) -> dict:
        return {
            "role": "pdf_thumbnail",
            "mime_type": "image/jpeg",
            "status": "failed",
            "generated_from": generated_from,
            "failure_reason": reason,
        }

    def _is_generated_pdf_preview_doc(self, file_doc: dict | None) -> bool:
        meta = (file_doc or {}).get("meta") or {}
        return str(meta.get("generated_role") or "").strip().lower() == "pdf_thumbnail"

    async def _list_generated_pdf_previews_for_file(self, pdf_path: str) -> list[dict]:
        normalized_path = self._db._normalize_path(pdf_path)
        cursor = self._db._files.find({
            "meta.generated_role": "pdf_thumbnail",
            "meta.generated_from_file_path": normalized_path,
        })
        items = []
        async for doc in cursor:
            items.append(doc)
        items.sort(key=lambda item: str(item.get("path") or ""))
        return items

    async def _rewrite_generated_pdf_preview_links(self, old_path: str, new_path: str) -> None:
        normalized_old = self._db._normalize_path(old_path)
        normalized_new = self._db._normalize_path(new_path)
        await self._db._files.update_many(
            {
                "meta.generated_role": "pdf_thumbnail",
                "meta.generated_from_file_path": normalized_old,
            },
            {
                "$set": {
                    "meta.generated_from_file_path": normalized_new,
                    "modified_at": datetime.now(timezone.utc),
                }
            },
        )

    async def _load_preview_asset_payload(self, asset_path: str) -> tuple[bytes, str] | None:
        normalized_asset_path = self._db._normalize_path(asset_path)
        if not normalized_asset_path:
            return None

        if normalized_asset_path in self._thumb_mem_cache:
            return self._thumb_mem_cache[normalized_asset_path]

        thumb_path = self._thumbnail_disk_path(normalized_asset_path)
        thumb_path.parent.mkdir(parents=True, exist_ok=True)
        lock = self._thumb_locks.setdefault(normalized_asset_path, asyncio.Lock())

        async with lock:
            if normalized_asset_path in self._thumb_mem_cache:
                return self._thumb_mem_cache[normalized_asset_path]

            if thumb_path.exists():
                try:
                    async with aiofiles.open(thumb_path, "rb") as f:
                        data = await f.read()
                    payload = _finalize_thumbnail_payload(data)
                    if payload:
                        if len(self._thumb_mem_cache) > 2000:
                            self._thumb_mem_cache.clear()
                        self._thumb_mem_cache[normalized_asset_path] = payload
                        return payload
                except OSError:
                    pass

            file_meta = await self._db.get_file(normalized_asset_path)
            if not file_meta or not file_meta.get("chunks"):
                return None

            read_length = int(file_meta.get("size") or 0)
            if read_length <= 0:
                return None

            try:
                source_bytes = await self.get_file_bytes_direct(normalized_asset_path, 0, read_length)
            except Exception as exc:
                logger.warning("Failed to read preview asset %s: %s", normalized_asset_path, exc)
                return None

            payload = _finalize_thumbnail_payload(source_bytes)
            if payload:
                await self._cache_thumbnail_payload(normalized_asset_path, payload, thumb_path=thumb_path)
            return payload

    def _build_pdf_preview_asset_metadata(self, sidecar_doc: dict, *, generated_from: str) -> dict:
        sidecar_meta = sidecar_doc.get("meta") or {}
        mime_type = sidecar_meta.get("mime_type") or mimetypes.guess_type(sidecar_doc.get("filename") or "")[0] or "image/jpeg"
        generated_at = sidecar_doc.get("created_at")
        if hasattr(generated_at, "isoformat"):
            generated_at = generated_at.isoformat()
        return {
            "path": sidecar_doc.get("path", ""),
            "role": "pdf_thumbnail",
            "mime_type": mime_type,
            "status": "ready",
            "width": sidecar_meta.get("width"),
            "height": sidecar_meta.get("height"),
            "generated_at": generated_at,
            "generated_from": generated_from,
            "size": sidecar_doc.get("size"),
        }

    async def _create_pdf_preview_sidecar(
        self,
        source_path: Path,
        pdf_virtual_path: str,
        *,
        pdf_storage_id: str | None = None,
        generated_from: str,
    ) -> dict | None:
        if fitz is None:
            return self._build_pdf_preview_asset_failure(
                generated_from=generated_from,
                reason="missing_renderer",
            )

        temp_thumb_path = self._make_pdf_thumb_temp_path(pdf_virtual_path, suffix=".jpg")
        sidecar_payload = None
        try:
            thumb_bytes = await asyncio.to_thread(_render_pdf_first_page_to_jpeg_bytes, source_path)
            payload = _finalize_thumbnail_payload(thumb_bytes)
            if not payload:
                return self._build_pdf_preview_asset_failure(
                    generated_from=generated_from,
                    reason="render_failed",
                )

            payload_bytes, _payload_content_type = payload
            await asyncio.to_thread(temp_thumb_path.write_bytes, payload_bytes)

            asset_id = secrets.token_hex(16)
            sidecar_path = self._build_pdf_preview_sidecar_path(pdf_virtual_path, asset_id=asset_id)
            metadata_override = {
                "generated_role": "pdf_thumbnail",
                "generated_from_file_path": self._db._normalize_path(pdf_virtual_path),
                "hidden_system_file": True,
                "source_document_mime": "application/pdf",
                "parent_storage_id": pdf_storage_id,
            }
            sidecar_payload = await self._upload_artifact_to_telegram(
                temp_thumb_path,
                sidecar_path,
                metadata_override=metadata_override,
                generate_thumbnail=False,
            )
            sidecar_doc = await self._db.create_file(
                path=sidecar_payload["path"],
                filename=sidecar_payload["filename"],
                size=sidecar_payload["size"],
                chunks=sidecar_payload["chunks"],
                meta=sidecar_payload["meta"],
                storage_id=sidecar_payload.get("storage_id"),
                storage_scheme=sidecar_payload.get("storage_scheme"),
            )
            await self._cache_thumbnail_payload(sidecar_doc["path"], payload)
            await self._cache_thumbnail_payload(self._db._normalize_path(pdf_virtual_path), payload)
            self._clear_thumbnail_negative_cache(pdf_virtual_path)
            return self._build_pdf_preview_asset_metadata(sidecar_doc, generated_from=generated_from)
        except Exception as exc:
            logger.warning("Failed to create PDF preview sidecar for %s: %s", pdf_virtual_path, exc, exc_info=True)
            if sidecar_payload and sidecar_payload.get("chunks"):
                try:
                    await self._delete_telegram_chunks(sidecar_payload["chunks"])
                except Exception:
                    logger.warning("Failed to rollback PDF preview sidecar for %s", pdf_virtual_path, exc_info=True)
            return self._build_pdf_preview_asset_failure(
                generated_from=generated_from,
                reason="sidecar_upload_failed",
            )
        finally:
            try:
                if temp_thumb_path.exists():
                    temp_thumb_path.unlink()
            except OSError:
                pass

    async def _delete_pdf_preview_sidecar_for_doc(self, file_doc: dict | None) -> None:
        preview_path = self._get_preview_asset_path(file_doc)
        current_path = self._db._normalize_path((file_doc or {}).get("path") or "")
        if preview_path and preview_path != current_path:
            await self.delete_file(preview_path)

    # ===================== STREAMING UPLOAD =====================

    TELEGRAM_PART_SIZE = 512 * 1024  # 512KB - Telegram's max part size
    OPAQUE_STORAGE_SCHEME = "telegram_opaque_v1"

    def _should_use_opaque_filenames(self) -> bool:
        return bool(getattr(Config, "TELEGRAM_OPAQUE_FILENAMES", True))

    def _generate_storage_id(self) -> str:
        return secrets.token_hex(16)

    def _resolve_storage_identity(
        self,
        existing: dict | None = None,
        preferred_storage_id: str | None = None,
    ) -> tuple[str | None, str | None]:
        existing = existing or {}
        existing_storage_id = existing.get("storage_id")
        if existing_storage_id:
            return existing_storage_id, existing.get("storage_scheme") or self.OPAQUE_STORAGE_SCHEME

        if preferred_storage_id:
            return preferred_storage_id, self.OPAQUE_STORAGE_SCHEME

        if not self._should_use_opaque_filenames():
            return None, None

        return self._generate_storage_id(), self.OPAQUE_STORAGE_SCHEME

    def _build_storage_name(
        self,
        logical_filename: str,
        chunk_index: int | None,
        total_chunks: int | None,
        storage_id: str | None = None,
        force_chunk_suffix: bool = False,
    ) -> str:
        safe_logical_name = Path(logical_filename or "upload.bin").name or "upload.bin"
        is_chunked = force_chunk_suffix
        if not is_chunked and chunk_index is not None:
            is_chunked = chunk_index > 0 or (total_chunks is not None and total_chunks > 1)
        if storage_id:
            if not is_chunked:
                return f"tc_{storage_id}.bin"
            return f"tc_{storage_id}_p{(chunk_index or 0):04d}.bin"
        if not is_chunked:
            return safe_logical_name
        return f"{safe_logical_name}.part{(chunk_index or 0):04d}"

    def _build_staging_chunk_name(
        self,
        logical_filename: str,
        chunk_index: int,
        storage_id: str | None = None,
    ) -> str:
        if storage_id:
            return f"tc_{storage_id}_local_p{chunk_index:04d}.bin"
        safe_logical_name = Path(logical_filename or "upload.bin").name or "upload.bin"
        return f"{safe_logical_name}.part{chunk_index:04d}"

    async def handle_stream_chunk(
        self,
        upload_id: str,
        chunk_index: int,
        chunk_data: bytes,
        file_path_for_metadata: Path,
        filename: str = "",
        total_chunks: int | None = None,
    ) -> None:
        """
        Handle a browser chunk in a streaming upload (pipeline mode):
        1. Write to local staging file (for metadata extraction later).
        2. Start Telegram upload as BACKGROUND TASK (fire-and-forget).
        
        The server returns immediately — browser can send next chunk
        while previous chunk is still uploading to Telegram.
        """
        file_path_for_metadata = Path(file_path_for_metadata)
        if upload_id not in self.active_uploads:
            storage_id, storage_scheme = self._resolve_storage_identity()
            self.active_uploads[upload_id] = {
                "chunks": [], "pending_tasks": [],
                "bytes_uploaded": 0,
                "bytes_total": 0,
                "storage_id": storage_id,
                "storage_scheme": storage_scheme,
                "total_chunks": max(1, total_chunks or 1),
            }
            logger.info(f"🚀 Started chunked direct upload: {upload_id}")

        if total_chunks:
            self.active_uploads[upload_id]["total_chunks"] = max(
                self.active_uploads[upload_id].get("total_chunks", 1),
                total_chunks,
            )

        chunk_size = len(chunk_data)
        file_id = random.getrandbits(63)
        chunk_telegram_parts = (chunk_size + self.TELEGRAM_PART_SIZE - 1) // self.TELEGRAM_PART_SIZE
        
        # Track total bytes across all chunks
        self.active_uploads[upload_id]["bytes_total"] += chunk_size

        # Write to disk immediately (for metadata extraction later)
        metadata_dir_missing = not file_path_for_metadata.parent.exists()
        file_path_for_metadata.parent.mkdir(parents=True, exist_ok=True)
        if metadata_dir_missing:
            logger.warning("Streaming metadata dir recreated on demand: %s", file_path_for_metadata.parent)
        async with aiofiles.open(file_path_for_metadata, "ab") as f:
            await f.write(chunk_data)

        # Scale workers with bot count
        bot_count = max(1, self._telegram.bot_count)
        PARALLEL_WORKERS = 15 * bot_count
        client_index = file_id % bot_count
        
        # Reference for closure
        upload_state = self.active_uploads[upload_id]

        async def upload_chunk_to_telegram():
            async with self._upload_semaphore:
                # Prepare all sub-parts
                parts = []
                pos = 0
                part_idx = 0
                while pos < chunk_size:
                    sub_part = chunk_data[pos:pos + self.TELEGRAM_PART_SIZE]
                    parts.append((part_idx, sub_part))
                    pos += self.TELEGRAM_PART_SIZE
                    part_idx += 1
                
                # Upload sub-parts in parallel
                part_semaphore = asyncio.Semaphore(PARALLEL_WORKERS)
                
                async def upload_single_part(idx, data):
                    async with part_semaphore:
                        await self._telegram.save_file_part(
                            file_id, idx, chunk_telegram_parts, data,
                            file_size=chunk_size, client_index=client_index
                        )
                        # Update shared progress counter (sub-part level)
                        upload_state["bytes_uploaded"] += len(data)
                
                await asyncio.gather(*[
                    upload_single_part(idx, data) for idx, data in parts
                ])
                
                # Finalize this chunk
                storage_name = self._build_storage_name(
                    logical_filename=filename,
                    chunk_index=chunk_index,
                    total_chunks=upload_state.get("total_chunks"),
                    storage_id=upload_state.get("storage_id"),
                    force_chunk_suffix=True,
                )
                logger.info(
                    "📦 Stream chunk naming: logical=%s storage=%s storage_id=%s",
                    filename,
                    storage_name,
                    upload_state.get("storage_id"),
                )
                message_id = await self._telegram.finish_upload(
                    file_id, storage_name, chunk_telegram_parts,
                    file_size=chunk_size, client_index=client_index
                )
                logger.info(f"📦 Chunk {chunk_index} uploaded: msg_id={message_id}, size={chunk_size}")
                return message_id

        # Fire-and-forget: start Telegram upload in background
        task = asyncio.create_task(upload_chunk_to_telegram())
        self.active_uploads[upload_id]["pending_tasks"].append({
            "task": task,
            "chunk_index": chunk_index,
            "chunk_size": chunk_size
        })

    async def finish_stream_upload(self, virtual_path: str, upload_id: str, filename: str,
                                     file_path_for_metadata: Path,
                                     progress_callback=None) -> dict:
        """
        Finalize the streaming upload:
        1. Await all pending background Telegram uploads (with sub-part progress).
        2. Extract metadata from staged file.
        3. Save to DB.
        
        progress_callback: async fn(bytes_done, bytes_total) for streaming progress.
        """
        file_path_for_metadata = Path(file_path_for_metadata)
        if upload_id not in self.active_uploads:
             raise ValueError(f"Upload ID {upload_id} not found in active uploads")
        
        pending = self.active_uploads[upload_id].get("pending_tasks", [])
        total_size = self.active_uploads[upload_id]["bytes_total"]
        upload_state = self.active_uploads[upload_id]
        
        # Gather all tasks (they're already running in background)
        all_tasks = asyncio.gather(*[p["task"] for p in pending], return_exceptions=True)
        
        # Poll progress while waiting for tasks to complete
        if progress_callback:
            last_reported = -1
            while not all_tasks.done() if hasattr(all_tasks, 'done') else True:
                current = upload_state.get("bytes_uploaded", 0)
                if current != last_reported:
                    await progress_callback(min(current, total_size), total_size)
                    last_reported = current
                # Check if all tasks are done
                all_done = all(p["task"].done() for p in pending)
                if all_done:
                    break
                await asyncio.sleep(0.3)
            # Final progress update
            await progress_callback(total_size, total_size)
        
        # Await results and collect message_ids
        results = await all_tasks
        for i, p in enumerate(pending):
            result = results[i]
            if isinstance(result, Exception):
                logger.error(f"Chunk {p['chunk_index']} failed: {result}")
                raise result
            self.active_uploads[upload_id]["chunks"].append({
                "index": p["chunk_index"],
                "message_id": result,
                "size": p["chunk_size"]
            })
        
        chunks = sorted(self.active_uploads[upload_id]["chunks"], key=lambda c: c["index"])
        
        # Extract metadata from the full staged file
        metadata = await self._extract_metadata(file_path_for_metadata)
        duration = metadata.pop("duration", None)
        if duration:
            metadata["duration"] = duration

        normalized_virtual_path = self._db._normalize_path(virtual_path)
        if Path(filename).suffix.lower() == ".pdf":
            preview_asset = await self._create_pdf_preview_sidecar(
                file_path_for_metadata,
                normalized_virtual_path,
                pdf_storage_id=upload_state.get("storage_id"),
                generated_from="upload_chunked",
            )
            if preview_asset:
                metadata["preview_asset"] = preview_asset
        
        try:
            await self._db.create_file(
                path=normalized_virtual_path,
                filename=filename,
                size=total_size,
                chunks=chunks,
                meta=metadata,
                storage_id=upload_state.get("storage_id"),
                storage_scheme=upload_state.get("storage_scheme"),
            )
            logger.info(f"✅ Stream upload completed: {virtual_path} ({len(chunks)} chunk(s), {total_size} bytes)")
            
            del self.active_uploads[upload_id]
            return {"path": virtual_path, "chunks": len(chunks)}
            
        except Exception as e:
            logger.error(f"Failed to finish stream upload: {e}")
            raise
        finally:
            # Clean up staging file
            if file_path_for_metadata.exists():
                os.remove(file_path_for_metadata)

    async def abort_stream_upload(self, upload_id: str, file_path_for_metadata: str | Path | None = None) -> None:
        """Cancel and clean up an unfinished streaming upload."""
        upload_state = self.active_uploads.pop(upload_id, None)
        metadata_path = Path(file_path_for_metadata) if file_path_for_metadata else None
        if not upload_state:
            if metadata_path and metadata_path.exists():
                try:
                    metadata_path.unlink()
                except OSError:
                    pass
            return

        pending = upload_state.get("pending_tasks") or []
        tasks = [entry.get("task") for entry in pending if entry.get("task") is not None]
        for task in tasks:
            if not task.done():
                task.cancel()

        results = await asyncio.gather(*tasks, return_exceptions=True) if tasks else []
        uploaded_ids = [result for result in results if isinstance(result, int)]
        if uploaded_ids:
            await self._telegram.delete_files(uploaded_ids)

        if metadata_path and metadata_path.exists():
            try:
                metadata_path.unlink()
            except OSError:
                pass

    # ===================== UPLOAD =====================

    async def upload_file(self, local_path: str | Path, virtual_path: str, progress_callback=None, resume: bool = False) -> dict:
        """
        Upload a local file to Telegram, save metadata to MongoDB.

        Args:
            local_path: Path to the staged local file.
            virtual_path: Virtual FTP path (e.g., '/documents/report.pdf').

        Returns:
            The file metadata document from MongoDB.
        """
        local_path = Path(local_path)
        prepared_artifacts = await self._prepare_upload_artifacts(local_path, virtual_path)
        if prepared_artifacts.get("mode") == "externalized":
            logger.info(
                "🎬 Externalizing MKV subtitles during upload: path=%s group=%s subtitle_tracks=%s",
                virtual_path,
                prepared_artifacts.get("generated_group_id", ""),
                len(prepared_artifacts.get("subtitle_artifacts") or []),
            )
            return await self._upload_externalized_mkv_group(prepared_artifacts, virtual_path, progress_callback=progress_callback)

        if prepared_artifacts.get("mode") == "fallback_original":
            logger.info(
                "⏭️ Falling back to original upload for %s: %s",
                virtual_path,
                prepared_artifacts.get("reason", "unknown"),
            )

        file_size = local_path.stat().st_size
        filename = virtual_path.rsplit("/", 1)[-1]

        logger.info(f"📤 Upload starting: {virtual_path} ({file_size / 1024 / 1024:.1f} MB)")

        # Delete existing file at this path if any
        existing = await self._db.get_file(virtual_path)
        existing_chunks = []
        if existing:
            if resume:
                existing_chunks = existing.get("chunks", [])
                if self._should_use_opaque_filenames() and existing_chunks and not existing.get("storage_id"):
                    logger.warning(
                        "Restarting legacy resume for %s because existing chunks have no storage_id",
                        virtual_path,
                    )
                    self._cache.invalidate(virtual_path, existing_chunks)
                    self._invalidate_thumbnail_cache(virtual_path)
                    await self._delete_telegram_chunks(existing_chunks)
                    await self._db.delete_file(virtual_path)
                    existing = None
                    existing_chunks = []
                else:
                    logger.info(f"🔄 Resuming upload for {virtual_path} with {len(existing_chunks)} existing chunks")
            else:
                self._cache.invalidate(virtual_path, existing.get("chunks", []))
                self._invalidate_thumbnail_cache(virtual_path)
                await self._delete_telegram_chunks(existing.get("chunks", []))
                await self._db.delete_file(virtual_path)
                existing = None

        storage_id, storage_scheme = self._resolve_storage_identity(existing=existing if resume else None)
        logger.info(
            "🗂️ Storage naming: virtual=%s logical=%s storage_id=%s scheme=%s",
            virtual_path,
            filename,
            storage_id,
            storage_scheme or "legacy",
        )

        # Symlink logic to ensure extension detection
        process_path = local_path
        symlink_created = False
        virtual_ext = Path(filename).suffix.lower()
        
        if virtual_ext and local_path.suffix.lower() != virtual_ext:
            # Create symlink: /tmp/random -> /tmp/random.mp3
            process_path = local_path.with_name(local_path.name + "_sym" + virtual_ext)
            try:
                if not process_path.exists():
                    os.symlink(local_path, process_path)
                    symlink_created = True
                    logger.debug(f"Created symlink for processing: {process_path}")
            except OSError as e:
                logger.warning(f"Could not create symlink {process_path}: {e}")
                process_path = local_path

        chunks_metadata = []
        metadata = {}
        thumb_path = None

        try:
            # Extract metadata and thumbnail (audio art, PDF cover, or video frame)
            try:
                if process_path.suffix.lower() in (
                    '.mp3', '.m4a', '.flac',
                    '.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.wmv', '.flv',
                    '.pdf',
                ):
                    metadata = await self._extract_metadata(process_path)
                    thumb_path = await self._extract_thumbnail(process_path)
                    if thumb_path:
                        logger.info(f"🖼 Found album art: {thumb_path}")
            except Exception as e:
                logger.warning(f"Metadata extraction failed: {e}")

            if file_size <= Config.CHUNK_SIZE_BYTES:
                # Single chunk — upload directly
                if resume and existing_chunks and len(existing_chunks) == 1 and existing_chunks[0]["size"] == file_size:
                    chunks_metadata = existing_chunks
                    if progress_callback:
                        progress_callback(file_size, file_size)
                else:
                    try:
                        result_meta = await self._upload_chunk(
                            process_path,
                            filename,
                            0,
                            total_chunks=1,
                            storage_id=storage_id,
                            thumb=thumb_path,
                            progress_callback=progress_callback,
                        )
                        chunks_metadata.append(result_meta)
                    finally:
                        if thumb_path and thumb_path.exists():
                            try:
                                os.remove(thumb_path)
                            except OSError:
                                pass
            else:
                # Multiple chunks — split and upload concurrently
                chunk_paths = await self._split_file(local_path, filename, storage_id=storage_id)
                try:
                    tasks = []
                    total_chunks = len(chunk_paths)
                    
                    uploaded_indices = {c["index"]: c for c in existing_chunks} if resume else {}

                    # For multi-chunk, create an aggregator for progress
                    chunk_progress = {}
                    
                    if resume:
                        for idx, c in uploaded_indices.items():
                            chunk_progress[idx] = c["size"]
                            
                    def make_chunk_progress_cb(idx, chunk_size):
                        def cb(current, total):
                            chunk_progress[idx] = current
                            if progress_callback:
                                aggregate = sum(chunk_progress.values())
                                aggregate_total = file_size
                                progress_callback(aggregate, aggregate_total)
                        return cb

                    if resume and progress_callback and chunk_progress:
                        progress_callback(sum(chunk_progress.values()), file_size)

                    for i, chunk_path in enumerate(chunk_paths):
                        if i in uploaded_indices:
                            continue
                        current_thumb = thumb_path if i == 0 else None
                        cb = make_chunk_progress_cb(i, chunk_path.stat().st_size) if progress_callback else None
                        tasks.append(
                            self._upload_chunk(
                                chunk_path,
                                filename,
                                i,
                                total_chunks=total_chunks,
                                storage_id=storage_id,
                                thumb=current_thumb,
                                progress_callback=cb,
                            )
                        )

                    results = await asyncio.gather(*tasks, return_exceptions=True)

                    chunks_metadata = list(uploaded_indices.values())

                    for result in results:
                        if isinstance(result, Exception):
                            # Cleanup any uploaded chunks on failure
                            uploaded_ids = [
                                c["message_id"]
                                for c in chunks_metadata if c.get("index") not in uploaded_indices
                            ]
                            if uploaded_ids:
                                await self._telegram.delete_files(uploaded_ids)
                            raise result
                        chunks_metadata.append(result)

                    # Sort by index to ensure order
                    chunks_metadata.sort(key=lambda c: c["index"])

                finally:
                    # Clean up chunk files and thumbnail
                    for cp in chunk_paths:
                        try:
                            os.remove(cp)
                        except OSError:
                            pass
                    
                    if thumb_path and thumb_path.exists():
                        try:
                            os.remove(thumb_path)
                        except OSError:
                            pass
        finally:
            if symlink_created:
                try:
                    os.remove(process_path)
                except OSError:
                    pass

        normalized_virtual_path = self._db._normalize_path(virtual_path)
        if Path(filename).suffix.lower() == ".pdf":
            preview_asset = await self._create_pdf_preview_sidecar(
                process_path if process_path.exists() else local_path,
                normalized_virtual_path,
                pdf_storage_id=storage_id,
                generated_from="upload_classic",
            )
            if preview_asset:
                metadata["preview_asset"] = preview_asset

        # Save metadata to MongoDB
        doc = await self._db.create_file(
            path=normalized_virtual_path,
            filename=filename,
            size=file_size,
            chunks=chunks_metadata,
            meta=metadata,
            storage_id=storage_id,
            storage_scheme=storage_scheme,
        )

        logger.info(
            f"✅ Upload complete: {virtual_path} "
            f"({len(chunks_metadata)} chunk(s), {file_size} bytes)"
        )
        return doc

    async def _upload_chunk(
        self,
        chunk_path: Path,
        logical_filename: str,
        index: int,
        total_chunks: int,
        storage_id: str | None = None,
        thumb: Path = None,
        progress_callback=None,
    ) -> dict:
        """Upload a single chunk using parallel 512KB sub-parts and bot affinity."""
        async with self._upload_semaphore:
            chunk_size = chunk_path.stat().st_size
            telegram_filename = self._build_storage_name(
                logical_filename=logical_filename,
                chunk_index=index,
                total_chunks=total_chunks,
                storage_id=storage_id,
            )
            logger.info(
                "📤 Telegram chunk naming: logical=%s index=%s storage=%s storage_id=%s",
                logical_filename,
                index,
                telegram_filename,
                storage_id,
            )
            
            # Unify upload strategy: slice into chunks and use parallel API
            import random
            import aiofiles
            file_id = random.getrandbits(63)
            bot_count = max(1, self._telegram.bot_count)
            client_index = file_id % bot_count
            
            TELEGRAM_PART_SIZE = 512 * 1024
            total_parts = (chunk_size + TELEGRAM_PART_SIZE - 1) // TELEGRAM_PART_SIZE
            
            async with aiofiles.open(chunk_path, "rb") as f:
                chunk_data = await f.read()

            parts = []
            pos = 0
            part_idx = 0
            while pos < chunk_size:
                parts.append((part_idx, chunk_data[pos:pos + TELEGRAM_PART_SIZE]))
                pos += TELEGRAM_PART_SIZE
                part_idx += 1
                
            PARALLEL_WORKERS = 15 * bot_count
            part_semaphore = asyncio.Semaphore(PARALLEL_WORKERS)
            
            bytes_uploaded = [0]
            
            async def upload_single_part(idx, data):
                async with part_semaphore:
                    await self._telegram.save_file_part(
                        file_id, idx, total_parts, data,
                        file_size=chunk_size, client_index=client_index
                    )
                    bytes_uploaded[0] += len(data)
                    if progress_callback:
                        progress_callback(bytes_uploaded[0], chunk_size)
                        
            # Upload all parts in parallel
            await asyncio.gather(*[
                upload_single_part(idx, data) for idx, data in parts
            ])
            
            # Finalize using the same bot assigned
            message_id = await self._telegram.finish_upload(
                file_id, telegram_filename, total_parts,
                file_size=chunk_size, thumb=thumb, client_index=client_index
            )
            
            return {
                "index": index,
                "message_id": message_id,
                "size": chunk_size
            }

    async def _split_file(self, local_path: Path, filename: str, storage_id: str | None = None) -> list[Path]:
        """Split a large file into smaller chunks for parallel Telegram upload."""
        chunk_size = Config.CHUNK_SIZE_BYTES

        chunk_dir_label = f"tc_{storage_id}" if storage_id else filename
        chunks_dir = Config.STAGING_DIR / f"chunks_{chunk_dir_label}_{int(time.time())}"
        chunks_dir.mkdir(parents=True, exist_ok=True)
        
        def do_split():
            paths = []
            with open(local_path, "rb") as f:
                index = 0
                while True:
                    data = f.read(chunk_size)
                    if not data:
                        break
                    part_path = chunks_dir / self._build_staging_chunk_name(filename, index, storage_id)
                    with open(part_path, "wb") as pf:
                        pf.write(data)
                    paths.append(part_path)
                    index += 1
            return paths
            
        return await asyncio.to_thread(do_split)

    async def _probe_media_streams(self, file_path: Path) -> dict:
        try:
            proc = await asyncio.create_subprocess_exec(
                "ffprobe",
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                "-show_streams",
                str(file_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("ffprobe não está disponível no ambiente") from exc

        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(
                f"ffprobe falhou para {file_path.name}: {stderr.decode('utf-8', 'ignore').strip() or proc.returncode}"
            )

        import json

        return json.loads(stdout or b"{}")

    def _is_mkv_subtitle_externalization_enabled(self) -> bool:
        mode = (os.getenv("MKV_UPLOAD_EXTERNALIZE_SUBTITLES_MODE", "compatible").strip().lower() or "compatible")
        return mode != "off"

    def _is_mkv_subtitle_externalization_strict(self) -> bool:
        mode = (os.getenv("MKV_UPLOAD_EXTERNALIZE_SUBTITLES_MODE", "compatible").strip().lower() or "compatible")
        return mode == "strict"

    async def _run_ffmpeg_command(self, *cmd: str) -> tuple[bytes, str]:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("ffmpeg não está disponível no ambiente") from exc

        stdout, stderr = await proc.communicate()
        stderr_text = stderr.decode("utf-8", "ignore").strip()
        if proc.returncode != 0:
            raise RuntimeError(stderr_text or f"ffmpeg exited with status {proc.returncode}")
        return stdout, stderr_text

    def _subtitle_stream_is_externalizable(self, stream: dict) -> bool:
        codec_name = str(stream.get("codec_name") or "").strip().lower()
        return codec_name in EXTERNALIZABLE_MKV_SUBTITLE_CODECS

    def _extract_subtitle_stream_artifact_meta(self, stream: dict, track_index: int) -> dict:
        tags = stream.get("tags") or {}
        disposition = stream.get("disposition") or {}
        title = (
            str(tags.get("title") or "").strip()
            or str(tags.get("handler_name") or "").strip()
            or str(tags.get("HANDLER_NAME") or "").strip()
        )
        language = str(tags.get("language") or "").strip().lower()
        return {
            "track_index": int(track_index),
            "stream_index": stream.get("index"),
            "codec": str(stream.get("codec_name") or "").strip().lower(),
            "language": language,
            "title": title,
            "forced": disposition.get("forced", 0) == 1,
            "default": disposition.get("default", 0) == 1,
            "hearing_impaired": disposition.get("hearing_impaired", 0) == 1,
            "comment": disposition.get("comment", 0) == 1,
            "captions": disposition.get("captions", 0) == 1,
        }

    async def _prepare_upload_artifacts(self, staged_path: Path, virtual_path: str) -> dict:
        if not self._is_mkv_subtitle_externalization_enabled():
            return {"mode": "passthrough", "reason": "feature_disabled"}

        if staged_path.suffix.lower() != ".mkv":
            return {"mode": "passthrough", "reason": "not_mkv"}

        probe_data = await self._probe_media_streams(staged_path)
        subtitle_streams = [
            stream
            for stream in (probe_data.get("streams") or [])
            if str(stream.get("codec_type") or "").strip().lower() == "subtitle"
        ]
        if not subtitle_streams:
            return {"mode": "passthrough", "reason": "no_embedded_subtitles"}

        supported_tracks = []
        unsupported_tracks = []
        for subtitle_index, stream in enumerate(subtitle_streams):
            track_meta = self._extract_subtitle_stream_artifact_meta(stream, subtitle_index)
            if self._subtitle_stream_is_externalizable(stream):
                supported_tracks.append(track_meta)
            else:
                unsupported_tracks.append(track_meta)

        if unsupported_tracks:
            reason = "unsupported_subtitle_codec"
            if self._is_mkv_subtitle_externalization_strict():
                raise RuntimeError(
                    f"Strict MKV subtitle externalization aborted for {virtual_path}: unsupported codecs="
                    f"{', '.join(sorted({item['codec'] for item in unsupported_tracks}))}"
                )
            logger.info(
                "⏭️ MKV subtitle externalization skipped: path=%s reason=%s codecs=%s",
                virtual_path,
                reason,
                ",".join(sorted({item["codec"] for item in unsupported_tracks})),
            )
            return {
                "mode": "fallback_original",
                "reason": reason,
                "unsupported_tracks": unsupported_tracks,
                "source_probe": probe_data,
            }

        artifact_group_id = f"mkvsubs_{secrets.token_hex(8)}"
        temp_dir = Config.STAGING_DIR / f"{artifact_group_id}_{int(time.time())}"
        temp_dir.mkdir(parents=True, exist_ok=True)

        subtitle_artifacts = []
        try:
            for track_meta in supported_tracks:
                subtitle_filename = _build_generated_subtitle_filename(
                    Path(virtual_path).name,
                    track_index=track_meta["track_index"],
                    language=track_meta.get("language", ""),
                    forced=track_meta.get("forced", False),
                    default=track_meta.get("default", False),
                )
                subtitle_temp_path = temp_dir / subtitle_filename
                await self._run_ffmpeg_command(
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel", "warning",
                    "-nostdin",
                    "-i", str(staged_path),
                    "-map", f"0:s:{track_meta['track_index']}",
                    "-f", "webvtt",
                    str(subtitle_temp_path),
                )
                subtitle_artifacts.append({
                    **track_meta,
                    "filename": subtitle_filename,
                    "local_path": subtitle_temp_path,
                    "virtual_path": self._db._normalize_path(str(Path(virtual_path).with_name(subtitle_filename))),
                })

            cleaned_video_path = temp_dir / Path(virtual_path).name
            await self._run_ffmpeg_command(
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel", "warning",
                "-nostdin",
                "-i", str(staged_path),
                "-map", "0",
                "-map", "-0:s",
                "-c", "copy",
                str(cleaned_video_path),
            )

            return {
                "mode": "externalized",
                "generated_group_id": artifact_group_id,
                "video_artifact": {
                    "filename": Path(virtual_path).name,
                    "local_path": cleaned_video_path,
                    "virtual_path": self._db._normalize_path(virtual_path),
                },
                "subtitle_artifacts": subtitle_artifacts,
                "source_probe": probe_data,
                "cleanup_dir": temp_dir,
            }
        except Exception:
            if self._is_mkv_subtitle_externalization_strict():
                raise
            logger.warning(
                "⚠️ MKV subtitle externalization failed for %s, falling back to original upload",
                virtual_path,
                exc_info=True,
            )
            shutil.rmtree(temp_dir, ignore_errors=True)
            return {
                "mode": "fallback_original",
                "reason": "externalization_failed",
                "source_probe": probe_data,
            }

    async def _upload_artifact_to_telegram(
        self,
        local_path: str | Path,
        virtual_path: str,
        *,
        progress_callback=None,
        metadata_override: dict | None = None,
        skip_metadata_extraction: bool = False,
        generate_thumbnail: bool = True,
    ) -> dict:
        local_path = Path(local_path)
        file_size = local_path.stat().st_size
        filename = virtual_path.rsplit("/", 1)[-1]

        storage_id, storage_scheme = self._resolve_storage_identity(existing=None)
        process_path = local_path
        symlink_created = False
        virtual_ext = Path(filename).suffix.lower()

        if virtual_ext and local_path.suffix.lower() != virtual_ext:
            process_path = local_path.with_name(local_path.name + "_sym" + virtual_ext)
            try:
                if not process_path.exists():
                    os.symlink(local_path, process_path)
                    symlink_created = True
            except OSError:
                process_path = local_path

        chunks_metadata = []
        metadata = {}
        thumb_path = None

        try:
            if not skip_metadata_extraction:
                try:
                    metadata = await self._extract_metadata(process_path)
                except Exception as exc:
                    logger.warning("Metadata extraction failed for %s: %s", virtual_path, exc)

                if generate_thumbnail:
                    try:
                        thumb_path = await self._extract_thumbnail(process_path)
                    except Exception as exc:
                        logger.warning("Thumbnail extraction failed for %s: %s", virtual_path, exc)

            if metadata_override:
                metadata.update(metadata_override)

            if file_size <= Config.CHUNK_SIZE_BYTES:
                result_meta = await self._upload_chunk(
                    process_path,
                    filename,
                    0,
                    total_chunks=1,
                    storage_id=storage_id,
                    thumb=thumb_path,
                    progress_callback=progress_callback,
                )
                chunks_metadata.append(result_meta)
            else:
                chunk_paths = await self._split_file(local_path, filename, storage_id=storage_id)
                try:
                    tasks = []
                    total_chunks = len(chunk_paths)
                    chunk_progress = {}

                    def make_chunk_progress_cb(idx):
                        def cb(current, _total):
                            chunk_progress[idx] = current
                            if progress_callback:
                                progress_callback(sum(chunk_progress.values()), file_size)
                        return cb

                    for index, chunk_path in enumerate(chunk_paths):
                        current_thumb = thumb_path if index == 0 else None
                        cb = make_chunk_progress_cb(index) if progress_callback else None
                        tasks.append(
                            self._upload_chunk(
                                chunk_path,
                                filename,
                                index,
                                total_chunks=total_chunks,
                                storage_id=storage_id,
                                thumb=current_thumb,
                                progress_callback=cb,
                            )
                        )

                    results = await asyncio.gather(*tasks, return_exceptions=True)
                    for result in results:
                        if isinstance(result, Exception):
                            uploaded_ids = [chunk["message_id"] for chunk in chunks_metadata if chunk.get("message_id")]
                            if uploaded_ids:
                                await self._telegram.delete_files(uploaded_ids)
                            raise result
                        chunks_metadata.append(result)

                    chunks_metadata.sort(key=lambda item: item["index"])
                finally:
                    for chunk_path in chunk_paths:
                        try:
                            os.remove(chunk_path)
                        except OSError:
                            pass
        finally:
            if thumb_path and thumb_path.exists():
                try:
                    os.remove(thumb_path)
                except OSError:
                    pass
            if symlink_created:
                try:
                    os.remove(process_path)
                except OSError:
                    pass

        return {
            "path": self._db._normalize_path(virtual_path),
            "filename": filename,
            "size": file_size,
            "chunks": chunks_metadata,
            "meta": metadata,
            "storage_id": storage_id,
            "storage_scheme": storage_scheme,
        }

    async def _rollback_uploaded_artifact_group(self, payloads: list[dict], committed_paths: list[str], existing_docs: dict[str, dict | None]) -> None:
        for payload in payloads:
            chunks = payload.get("chunks", [])
            if chunks:
                try:
                    await self._delete_telegram_chunks(chunks)
                except Exception:
                    logger.warning("Failed to delete uploaded chunks during rollback for %s", payload.get("path"), exc_info=True)

        for path in committed_paths:
            existing_doc = existing_docs.get(path)
            try:
                if existing_doc:
                    await self._db._files.replace_one({"path": existing_doc["path"]}, existing_doc, upsert=True)
                else:
                    await self._db._files.delete_one({"path": self._db._normalize_path(path)})
            except Exception:
                logger.warning("Failed to restore DB state during rollback for %s", path, exc_info=True)

    async def _finalize_uploaded_artifact_group(self, payloads: list[dict], existing_docs: dict[str, dict | None]) -> list[dict]:
        committed_paths = []
        docs = []
        try:
            for payload in payloads:
                doc = await self._db.create_file(
                    path=payload["path"],
                    filename=payload["filename"],
                    size=payload["size"],
                    chunks=payload["chunks"],
                    meta=payload.get("meta") or {},
                    storage_id=payload.get("storage_id"),
                    storage_scheme=payload.get("storage_scheme"),
                )
                committed_paths.append(payload["path"])
                docs.append(doc)
        except Exception:
            await self._rollback_uploaded_artifact_group(payloads, committed_paths, existing_docs)
            raise

        for payload in payloads:
            previous_doc = existing_docs.get(payload["path"])
            if not previous_doc:
                continue
            old_chunks = previous_doc.get("chunks", [])
            self._cache.invalidate(payload["path"], old_chunks)
            self._invalidate_thumbnail_cache(payload["path"])
            await self._delete_telegram_chunks(old_chunks)

        return docs

    def _is_generated_sidecar_doc(self, file_doc: dict | None) -> bool:
        meta = (file_doc or {}).get("meta") or {}
        return str(meta.get("generated_role") or "").strip().lower() == "externalized_subtitle"

    def _is_externalized_video_doc(self, file_doc: dict | None) -> bool:
        meta = (file_doc or {}).get("meta") or {}
        return bool(meta.get("subtitles_externalized_on_upload"))

    async def _list_generated_sidecars_for_video(self, video_path: str) -> list[dict]:
        normalized_path = self._db._normalize_path(video_path)
        cursor = self._db._files.find({"meta.generated_from_video_path": normalized_path})
        items = []
        async for doc in cursor:
            items.append(doc)
        items.sort(key=lambda item: str(item.get("filename", "")).lower())
        return items

    async def _refresh_generated_video_metadata(self, video_path: str, *, touch_modified_at: bool = True) -> None:
        video_doc = await self._db.get_file(video_path)
        if not video_doc or not self._is_externalized_video_doc(video_doc):
            return

        sidecars = await self._list_generated_sidecars_for_video(video_path)
        meta = dict(video_doc.get("meta") or {})
        meta["generated_subtitle_files"] = [
            {
                "path": sidecar.get("path", ""),
                "language": (sidecar.get("meta") or {}).get("language", ""),
                "label": _build_externalized_subtitle_label(
                    language=(sidecar.get("meta") or {}).get("language", ""),
                    title=(sidecar.get("meta") or {}).get("title", ""),
                    track_index=int((sidecar.get("meta") or {}).get("source_track_index") or 0),
                    filename=str(sidecar.get("filename") or ""),
                    path=sidecar.get("path", ""),
                    forced=bool((sidecar.get("meta") or {}).get("forced", False)),
                    default=bool((sidecar.get("meta") or {}).get("default", False)),
                    hearing_impaired=bool((sidecar.get("meta") or {}).get("hearing_impaired", False)),
                    comment=bool((sidecar.get("meta") or {}).get("comment", False)),
                    captions=bool((sidecar.get("meta") or {}).get("captions", False)),
                ),
                "track_index": (sidecar.get("meta") or {}).get("source_track_index"),
                "codec": (sidecar.get("meta") or {}).get("source_codec", ""),
                "forced": bool((sidecar.get("meta") or {}).get("forced", False)),
                "default": bool((sidecar.get("meta") or {}).get("default", False)),
            }
            for sidecar in sidecars
        ]
        update_fields = {"meta": meta}
        if touch_modified_at:
            update_fields["modified_at"] = datetime.now(timezone.utc)

        await self._db._files.update_one(
            {"path": self._db._normalize_path(video_path)},
            {"$set": update_fields},
        )

    def _build_generated_sidecar_destination_path(self, video_path: str, sidecar_doc: dict) -> str:
        sidecar_meta = sidecar_doc.get("meta") or {}
        filename = _build_generated_subtitle_filename(
            Path(video_path).name,
            track_index=int(sidecar_meta.get("source_track_index") or 0),
            language=str(sidecar_meta.get("language") or ""),
            forced=bool(sidecar_meta.get("forced", False)),
            default=bool(sidecar_meta.get("default", False)),
            extension=Path(sidecar_doc.get("filename") or "").suffix.lower() or ".vtt",
        )
        return self._db._normalize_path(str(Path(video_path).with_name(filename)))

    async def _copy_file_document(self, file_doc: dict, dest_path: str, meta_override: dict | None = None) -> dict:
        old_chunks = file_doc.get("chunks", [])
        old_ids = []
        for chunk in old_chunks:
            if "id" in chunk:
                old_ids.append(chunk["id"])
            elif "message_id" in chunk:
                old_ids.append(chunk["message_id"])
            else:
                raise KeyError(f"Missing 'id' or 'message_id' in chunk: {chunk}")

        new_ids = []
        if old_ids:
            new_ids = await self._telegram.forward_messages(old_ids)
            if len(new_ids) != len(old_ids):
                await self._telegram.delete_files(new_ids)
                raise RuntimeError("Copy failed: Message forwarding mismatch")

        new_chunks = []
        for index, chunk in enumerate(old_chunks):
            new_chunks.append({
                "index": chunk.get("index", index),
                "message_id": new_ids[index],
                "size": chunk["size"],
            })

        new_doc = file_doc.copy()
        new_doc.pop("_id", None)
        new_doc["path"] = self._db._normalize_path(dest_path)
        new_doc["filename"] = Path(dest_path).name
        new_doc["chunks"] = new_chunks
        new_doc["modified_at"] = datetime.now(timezone.utc)
        if meta_override:
            new_doc["meta"] = {
                **(file_doc.get("meta") or {}),
                **meta_override,
            }

        await self._db._db.files.insert_one(new_doc)
        return new_doc

    async def _upload_externalized_mkv_group(self, prepared_artifacts: dict, virtual_path: str, progress_callback=None) -> dict:
        cleanup_dir = prepared_artifacts.get("cleanup_dir")
        generated_group_id = prepared_artifacts["generated_group_id"]
        subtitle_artifacts = prepared_artifacts.get("subtitle_artifacts") or []
        total_size = prepared_artifacts["video_artifact"]["local_path"].stat().st_size + sum(
            artifact["local_path"].stat().st_size for artifact in subtitle_artifacts
        )
        bytes_completed = 0

        subtitle_records = []
        for artifact in subtitle_artifacts:
            label = _build_externalized_subtitle_label(
                language=artifact.get("language", ""),
                title=artifact.get("title", ""),
                track_index=int(artifact["track_index"]),
                filename=artifact["filename"],
                path=artifact["virtual_path"],
                forced=bool(artifact.get("forced", False)),
                default=bool(artifact.get("default", False)),
                hearing_impaired=bool(artifact.get("hearing_impaired", False)),
                comment=bool(artifact.get("comment", False)),
                captions=bool(artifact.get("captions", False)),
            )
            subtitle_records.append({
                "path": artifact["virtual_path"],
                "language": artifact.get("language", ""),
                "label": label,
                "track_index": artifact["track_index"],
                "codec": artifact.get("codec", ""),
                "forced": bool(artifact.get("forced", False)),
                "default": bool(artifact.get("default", False)),
            })

        upload_specs = [
            {
                "local_path": prepared_artifacts["video_artifact"]["local_path"],
                "virtual_path": self._db._normalize_path(virtual_path),
                "metadata_override": {
                    "subtitles_externalized_on_upload": True,
                    "original_embedded_subtitle_track_count": len(subtitle_artifacts),
                    "generated_group_id": generated_group_id,
                    "generated_subtitle_files": subtitle_records,
                },
                "skip_metadata_extraction": False,
                "generate_thumbnail": True,
            }
        ]

        for artifact in subtitle_artifacts:
            label = _build_externalized_subtitle_label(
                language=artifact.get("language", ""),
                title=artifact.get("title", ""),
                track_index=int(artifact["track_index"]),
                filename=artifact["filename"],
                path=artifact["virtual_path"],
                forced=bool(artifact.get("forced", False)),
                default=bool(artifact.get("default", False)),
                hearing_impaired=bool(artifact.get("hearing_impaired", False)),
                comment=bool(artifact.get("comment", False)),
                captions=bool(artifact.get("captions", False)),
            )
            upload_specs.append({
                "local_path": artifact["local_path"],
                "virtual_path": artifact["virtual_path"],
                "metadata_override": {
                    "mime_type": "text/vtt",
                    "extension": ".vtt",
                    "language": artifact.get("language", ""),
                    "label": label,
                    "generated_role": "externalized_subtitle",
                    "generated_group_id": generated_group_id,
                    "generated_from_video_path": self._db._normalize_path(virtual_path),
                    "source_track_index": artifact["track_index"],
                    "source_stream_index": artifact.get("stream_index"),
                    "source_codec": artifact.get("codec", ""),
                    "forced": bool(artifact.get("forced", False)),
                    "default": bool(artifact.get("default", False)),
                    "hearing_impaired": bool(artifact.get("hearing_impaired", False)),
                    "comment": bool(artifact.get("comment", False)),
                    "captions": bool(artifact.get("captions", False)),
                    "title": artifact.get("title", ""),
                },
                "skip_metadata_extraction": True,
                "generate_thumbnail": False,
            })

        uploaded_payloads = []
        existing_docs = {}
        for spec in upload_specs:
            existing_docs[spec["virtual_path"]] = await self._db.get_file(spec["virtual_path"])

        try:
            for spec in upload_specs:
                artifact_size = Path(spec["local_path"]).stat().st_size

                def _artifact_progress(current, _total, offset=bytes_completed):
                    if progress_callback:
                        progress_callback(min(total_size, offset + current), total_size)

                payload = await self._upload_artifact_to_telegram(
                    spec["local_path"],
                    spec["virtual_path"],
                    progress_callback=_artifact_progress if progress_callback else None,
                    metadata_override=spec.get("metadata_override"),
                    skip_metadata_extraction=spec.get("skip_metadata_extraction", False),
                    generate_thumbnail=spec.get("generate_thumbnail", True),
                )
                uploaded_payloads.append(payload)
                bytes_completed += artifact_size
                if progress_callback:
                    progress_callback(bytes_completed, total_size)

            docs = await self._finalize_uploaded_artifact_group(uploaded_payloads, existing_docs)
            await self._refresh_generated_video_metadata(virtual_path)
            logger.info(
                "✅ Externalized MKV upload complete: %s (group=%s subtitles=%s)",
                virtual_path,
                generated_group_id,
                len(subtitle_artifacts),
            )
            return docs[0]
        except Exception:
            if uploaded_payloads:
                await self._rollback_uploaded_artifact_group(uploaded_payloads, [], {})
            raise
        finally:
            if cleanup_dir:
                shutil.rmtree(cleanup_dir, ignore_errors=True)

    async def _extract_metadata(self, file_path: Path) -> dict:
        """Extract durable metadata used by the web and mobile inspectors."""
        mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        meta = {
            "mime_type": mime_type,
            "extension": file_path.suffix.lower() or None,
            "title": None,
            "artist": None,
            "album": None,
            "year": None,
            "duration": None,
            "width": None,
            "height": None,
            "bitrate": None,
            "video_codec": None,
            "audio_codec": None,
            "sample_rate": None,
            "channels": None,
            "fps": None,
            "audio_track_count": 0,
            "subtitle_track_count": 0,
            "container": None,
            "page_count": None,
            "creator": None,
            "producer": None,
            "encrypted": None,
            "pdf_version": None,
            "image_format": None,
            "camera_make": None,
            "camera_model": None,
            "captured_at": None,
            "orientation": None,
        }

        # Step 1: Probe container/streams. This covers media and often images too.
        try:
            import json
            proc = await asyncio.create_subprocess_exec(
                'ffprobe', '-v', 'quiet', '-print_format', 'json',
                '-show_format', '-show_streams', str(file_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, _ = await proc.communicate()
            if proc.returncode == 0:
                probe_data = json.loads(stdout)
                fmt = probe_data.get('format', {})
                streams = probe_data.get('streams', [])
                duration_str = fmt.get('duration')
                if duration_str:
                    meta["duration"] = float(duration_str)

                meta["bitrate"] = _coerce_int(fmt.get("bit_rate"))
                meta["container"] = fmt.get("format_name")

                video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
                audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
                subtitle_streams = [stream for stream in streams if stream.get("codec_type") == "subtitle"]
                meta["audio_track_count"] = len(audio_streams)
                meta["subtitle_track_count"] = len(subtitle_streams)

                primary_video = video_streams[0] if video_streams else None
                primary_audio = audio_streams[0] if audio_streams else None

                if primary_video:
                    meta["width"] = _coerce_int(primary_video.get("width"))
                    meta["height"] = _coerce_int(primary_video.get("height"))
                    meta["video_codec"] = primary_video.get("codec_name")
                    meta["fps"] = _parse_ffprobe_rate(primary_video.get("avg_frame_rate") or primary_video.get("r_frame_rate"))

                if primary_audio:
                    meta["audio_codec"] = primary_audio.get("codec_name")
                    meta["sample_rate"] = _coerce_int(primary_audio.get("sample_rate"))
                    meta["channels"] = _coerce_int(primary_audio.get("channels"))

                tags = fmt.get('tags', {})
                meta["title"] = tags.get('title') or tags.get('TITLE')
                meta["artist"] = tags.get('artist') or tags.get('ARTIST')
                meta["album"] = tags.get('album') or tags.get('ALBUM')
                meta["year"] = tags.get('date') or tags.get('YEAR')
        except Exception as e:
            logger.debug(f"ffprobe duration extraction failed for {file_path.name}: {e}")
        
        is_audio_candidate = (
            mime_type.startswith("audio/")
            or file_path.suffix.lower() in {".mp3", ".m4a", ".flac", ".ogg", ".oga", ".wav", ".aac", ".opus", ".wma"}
        )

        def run_mutagen():
            try:
                f = File(file_path)
                if not f:
                    return meta

                # Check MP3 (ID3)
                if isinstance(f, MP3):
                    # Try EasyID3 first
                    try:
                        easy = EasyID3(file_path)
                        meta["title"] = easy.get("title", [None])[0]
                        meta["artist"] = easy.get("artist", [None])[0]
                        meta["album"] = easy.get("album", [None])[0]
                        meta["year"] = easy.get("date", [None])[0]
                    except Exception as e:
                        logger.warning(f"EasyID3 error for {file_path.name}: {e}")
                    
                    # Fallback/Supplemental from raw tags if missing
                    if not meta["title"]:
                        meta["title"] = str(f.tags.get("TIT2", "")) or None
                    if not meta["artist"]:
                        meta["artist"] = str(f.tags.get("TPE1", "")) or None
                    if not meta["album"]:
                        meta["album"] = str(f.tags.get("TALB", "")) or None
                    if not meta["year"]:
                        meta["year"] = str(f.tags.get("TDRC", "")) or None

                    meta["duration"] = f.info.length
                    meta["audio_codec"] = meta["audio_codec"] or "mp3"
                    meta["sample_rate"] = meta["sample_rate"] or _coerce_int(getattr(f.info, "sample_rate", None))
                    meta["bitrate"] = meta["bitrate"] or _coerce_int(getattr(f.info, "bitrate", None))
                    meta["channels"] = meta["channels"] or _coerce_int(getattr(f.info, "channels", None))

                # Check MP4/M4A
                elif isinstance(f, MP4):
                    # keys usually ©nam, ©ART, ©alb
                    tags = f.tags or {}
                    meta["title"] = tags.get("\xa9nam", [None])[0]
                    meta["artist"] = tags.get("\xa9ART", [None])[0]
                    meta["album"] = tags.get("\xa9alb", [None])[0]
                    meta["duration"] = f.info.length
                    meta["sample_rate"] = meta["sample_rate"] or _coerce_int(getattr(f.info, "sample_rate", None))
                    meta["bitrate"] = meta["bitrate"] or _coerce_int(getattr(f.info, "bitrate", None))
                    meta["channels"] = meta["channels"] or _coerce_int(getattr(f.info, "channels", None))
                # Check FLAC
                elif isinstance(f, FLAC):
                    tags = f.tags or {}
                    meta["title"] = tags.get("TITLE", [None])[0]
                    meta["artist"] = tags.get("ARTIST", [None])[0]
                    meta["album"] = tags.get("ALBUM", [None])[0]
                    meta["duration"] = f.info.length
                    meta["sample_rate"] = meta["sample_rate"] or _coerce_int(getattr(f.info, "sample_rate", None))
                    meta["bitrate"] = meta["bitrate"] or _coerce_int(getattr(f.info, "bitrate", None))
                    meta["channels"] = meta["channels"] or _coerce_int(getattr(f.info, "channels", None))

                logger.info(f"🎵 Extracted metadata for {file_path.name}: {meta}")
            except Exception as e:
                logger.warning(f"Error parsing metadata: {e}")
            return meta

        # Step 2: Use Mutagen for detailed tags (if not already found by ffprobe)
        if is_audio_candidate:
            mutagen_meta = await asyncio.to_thread(run_mutagen)

            # Merge results - prefer mutagen for tags, ffprobe for duration
            for key in ["title", "artist", "album", "year", "audio_codec", "sample_rate", "bitrate", "channels"]:
                if mutagen_meta.get(key):
                    meta[key] = mutagen_meta[key]

            if mutagen_meta.get("duration") and not meta["duration"]:
                meta["duration"] = mutagen_meta["duration"]

        # Step 3: Image-specific metadata.
        if mime_type.startswith("image/"):
            image_meta = await asyncio.to_thread(scan_image_metadata, file_path)
            for key, value in image_meta.items():
                if value is not None:
                    meta[key] = value

        # Step 4: PDF-specific metadata.
        if file_path.suffix.lower() == ".pdf":
            pdf_meta = await asyncio.to_thread(scan_pdf_metadata, file_path)
            for key, value in pdf_meta.items():
                if value is not None:
                    meta[key] = value

        return meta

    async def _extract_thumbnail(self, file_path: Path) -> Path:
        """Extract thumbnail: album art for audio, FFmpeg frame for video."""
        thumb_dir = Config.STAGING_DIR / "thumbs"
        thumb_dir.mkdir(parents=True, exist_ok=True)
        out_path = thumb_dir / f"{file_path.stem}_thumb.jpg"
        
        audio_exts = {'.mp3', '.m4a', '.flac', '.ogg', '.oga', '.wma', '.aac', '.wav'}
        image_exts = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic'}
        video_exts = {'.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.wmv', '.flv'}

        if file_path.suffix.lower() in image_exts:
            thumb_bytes = await asyncio.to_thread(_render_image_source_to_jpeg_bytes, file_path)
            if thumb_bytes:
                try:
                    with open(out_path, "wb") as img:
                        img.write(thumb_bytes)
                    return out_path
                except OSError as exc:
                    logger.warning(f"Error writing static image thumb: {exc}")

        if file_path.suffix.lower() == '.pdf':
            thumb_bytes = await asyncio.to_thread(_render_pdf_first_page_to_jpeg_bytes, file_path)
            if thumb_bytes:
                try:
                    with open(out_path, "wb") as img:
                        img.write(thumb_bytes)
                    return out_path
                except OSError as exc:
                    logger.warning(f"Error writing PDF thumb: {exc}")

        # Try audio album art extraction first
        if file_path.suffix.lower() in audio_exts:
            def extract_audio_art():
                try:
                    f = File(file_path)
                    if not f: return None
                    
                    art_data = None
                    
                    # ID3 (MP3)
                    if isinstance(f, MP3):
                        for key in f.tags.keys():
                            if key.startswith("APIC:"):
                                art_data = f.tags[key].data
                                break
                    # MP4 (M4A)
                    elif isinstance(f, MP4):
                        if "covr" in f.tags:
                            art_data = f.tags["covr"][0]
                    # FLAC
                    elif isinstance(f, FLAC):
                        if f.pictures:
                            art_data = f.pictures[0].data

                    if art_data:
                        thumb_bytes = _render_image_source_to_jpeg_bytes(art_data)
                        if thumb_bytes:
                            with open(out_path, "wb") as img:
                                img.write(thumb_bytes)
                            return out_path
                except Exception as e:
                    logger.warning(f"Error extracting audio thumb: {e}")
                return None

            result = await asyncio.to_thread(extract_audio_art)
            if result:
                return result
        
        # FFmpeg frame extraction for video files (and audio without album art).
        if file_path.suffix.lower() in video_exts or file_path.suffix.lower() in audio_exts:
            try:
                proc = await asyncio.create_subprocess_exec(
                    'ffmpeg', '-y', '-ss', '1', '-i', str(file_path),
                    '-vframes', '1',
                    '-vf', 'scale=320:320:force_original_aspect_ratio=decrease',
                    '-q:v', '5',
                    str(out_path),
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await proc.wait()
                if proc.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
                    logger.info(f"🖼 FFmpeg thumbnail extracted: {out_path}")
                    return out_path
                else:
                    # Clean up failed extraction
                    if out_path.exists():
                        out_path.unlink()
            except Exception as e:
                logger.warning(f"FFmpeg thumb extraction failed: {e}")

        return None



    # ===================== DOWNLOAD =====================

    async def get_thumbnail(self, virtual_path: str) -> tuple[bytes, str] | None:
        """Get thumbnail bytes and content type for a file."""
        ext = Path(virtual_path).suffix.lower()
        file_meta = None

        if ext == '.pdf':
            return await self._ensure_pdf_thumbnail_cached(virtual_path)

        if ext in _STATIC_IMAGE_EXTENSIONS:
            file_meta = await self._db.get_file(virtual_path)
            if self._is_generated_pdf_preview_doc(file_meta):
                return await self._load_preview_asset_payload(virtual_path)
        
        # 1. Look in Memory Cache (instant)
        if virtual_path in self._thumb_mem_cache:
            return self._thumb_mem_cache[virtual_path]

        lock = self._thumb_locks.setdefault(virtual_path, asyncio.Lock())
        async with lock:
            # Double-check after acquiring lock
            if virtual_path in self._thumb_mem_cache:
                return self._thumb_mem_cache[virtual_path]

            # 2. Look in Disk Cache
            thumb_path = self._thumbnail_disk_path(virtual_path)
            thumb_path.parent.mkdir(parents=True, exist_ok=True)

            if thumb_path.exists():
                try:
                    async with aiofiles.open(thumb_path, "rb") as f:
                        data = await f.read()
                    payload = _finalize_thumbnail_payload(data)
                    if payload:
                        payload_bytes, _ = payload
                        if payload_bytes != data:
                            try:
                                async with aiofiles.open(thumb_path, "wb") as f:
                                    await f.write(payload_bytes)
                            except OSError:
                                pass

                        if len(self._thumb_mem_cache) > 2000:
                            self._thumb_mem_cache.clear()
                        self._thumb_mem_cache[virtual_path] = payload
                        return payload
                except OSError:
                    pass

            # 3. Fetch from Telegram / Parse from media
            file_meta = file_meta or await self._db.get_file(virtual_path)
            if not file_meta or not file_meta.get("chunks"):
                return None
            
            chunk0 = file_meta["chunks"][0]
            thumb = await self._telegram.download_thumbnail(chunk0["message_id"])

            if not thumb:
                # Fallback: Extract ID3 tags for audio files on-the-fly without saving to disk
                filename = file_meta.get("filename", "")
                ext = Path(filename).suffix.lower()
                if ext in ('.mp3', '.m4a', '.flac'):
                    try:
                        data = await self.get_file_bytes_direct(virtual_path, 0, 256 * 1024)
                        if data:
                            import io
                            def extract_from_bio():
                                try:
                                    bio = io.BytesIO(data)
                                    if ext == '.mp3':
                                        from mutagen.mp3 import MP3
                                        f = MP3(bio)
                                        for key in f.tags.keys():
                                            if key.startswith("APIC:"):
                                                return f.tags[key].data
                                    elif ext == '.m4a':
                                        from mutagen.mp4 import MP4
                                        f = MP4(bio)
                                        if "covr" in f.tags:
                                            return f.tags["covr"][0]
                                    elif ext == '.flac':
                                        from mutagen.flac import FLAC
                                        f = FLAC(bio)
                                        if f.pictures:
                                            return f.pictures[0].data
                                except Exception:
                                    pass
                                return None
                                
                            thumb = await asyncio.to_thread(extract_from_bio)
                    except Exception as e:
                        logger.warning(f"On-the-fly thumb extraction failed for {filename}: {e}")

                if not thumb and ext in ('.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic'):
                    try:
                        read_length = min(file_meta.get("size", 0), Config.CHUNK_SIZE_BYTES)
                        if read_length > 0:
                            source_bytes = await self.get_file_bytes_direct(virtual_path, 0, read_length)
                            if source_bytes:
                                thumb = await asyncio.to_thread(_render_image_source_to_jpeg_bytes, source_bytes)
                    except Exception as e:
                        logger.warning(f"Static image thumb generation failed for {filename}: {e}")
            payload = _finalize_thumbnail_payload(thumb)
            if payload:
                await self._cache_thumbnail_payload(virtual_path, payload, thumb_path=thumb_path)

            return payload

    async def download_file(self, virtual_path: str, dest_path: str | Path) -> Path:
        """
        Download a file from Telegram, writing sequentially to dest_path.
        This allows streaming (LazyReader can read while this downloads).
        """
        dest_path = Path(dest_path)
        file_meta = await self._db.get_file(virtual_path)

        if not file_meta:
            raise FileNotFoundError(f"File not found in DB: {virtual_path}")

        chunks = file_meta.get("chunks", [])
        logger.info(
            f"📥 Download stream starting: {virtual_path} "
            f"({len(chunks)} chunk(s), {file_meta['size']} bytes)"
        )

        # Create empty file immediately
        dest_path.touch()

        chunks_sorted = sorted(chunks, key=lambda c: c["index"])

        try:
            async with aiofiles.open(dest_path, "wb") as outfile:
                for chunk in chunks_sorted:
                    logger.debug(f"📥 Streaming chunk {chunk['index']} (msg_id={chunk['message_id']})")
                    async for data in self._telegram.iter_download(chunk["message_id"]):
                        await outfile.write(data)
                        
            logger.info(f"✅ Download complete: {virtual_path}")
            return dest_path
            
        except Exception as e:
            # Cleanup on failure
            if dest_path.exists():
                dest_path.unlink()
            raise e

    async def stream_file_range(self, virtual_path: str, start: int = 0, end: int = None):
        """
        Stream a byte range using the disk cache.
        Chunks are fetched from Telegram on first access, then served from disk.
        """
        file_meta = await self._db.get_file(virtual_path)
        if not file_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")

        total_size = file_meta.get("size", 0)
        if end is None or end >= total_size:
            end = total_size - 1
        if start > end:
            return

        async for data in self._cache.serve_range(virtual_path, file_meta, start, end, interactive=True):
            yield data

    async def stream_file_range_direct(self, virtual_path: str, start: int = 0, end: int = None):
        """
        Stream a byte range directly from Telegram or existing disk cache.
        Does NOT write new chunks to the disk cache.
        Used for images to prevent disk spam.
        """
        file_meta = await self._db.get_file(virtual_path)
        if not file_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")

        total_size = file_meta.get("size", 0)
        if end is None or end >= total_size:
            end = total_size - 1
        if start > end:
            return

        chunk_size = Config.CHUNK_SIZE_BYTES
        start_chunk_idx = start // chunk_size
        end_chunk_idx = end // chunk_size

        chunks_list = sorted(file_meta.get("chunks", []), key=lambda c: c["index"])

        for chunk_meta in chunks_list:
            idx = chunk_meta["index"]
            if idx < start_chunk_idx or idx > end_chunk_idx:
                continue
                
            chunk_start_byte = idx * chunk_size
            chunk_end_byte = chunk_start_byte + chunk_meta["size"] - 1

            # Calculate read boundaries within this chunk
            read_start = max(start, chunk_start_byte)
            read_end = min(end, chunk_end_byte)
            
            if read_start > read_end:
                continue
                
            read_offset_in_chunk = read_start - chunk_start_byte
            read_length = read_end - read_start + 1

            # If chunk is already fully cached, serve it from disk to save bandwidth
            if self._cache.is_chunk_cached(virtual_path, idx, chunk_meta["size"]):
                async for data in self._cache.serve_range(virtual_path, file_meta, read_start, read_end):
                    yield data
                continue

            # Otherwise, read directly from Telegram without caching
            async for data in self._telegram.iter_download(
                message_id=chunk_meta["message_id"],
                offset=read_offset_in_chunk,
                limit=read_length,
                file_size=chunk_meta["size"]
            ):
                if data:
                    yield data

    async def get_file_bytes(self, virtual_path: str, offset: int, length: int) -> bytes:
        """
        Fetch a specific range of bytes using the caching pipeline (serve_range).
        Used by HTTP streaming — always caches and prefetches for speed.
        """
        file_meta = await self._db.get_file(virtual_path)
        if not file_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")
            
        total_size = file_meta.get("size", 0)
        
        # If offset is beyond EOF
        if offset >= total_size:
            return b""
            
        end = offset + length - 1
        if end >= total_size:
            end = total_size - 1
            
        chunks = []
        async for data in self._cache.serve_range(virtual_path, file_meta, offset, end, interactive=True):
            chunks.append(data)
            
        return b"".join(chunks)

    async def get_file_bytes_direct(self, virtual_path: str, offset: int, length: int) -> bytes:
        """
        Fetch bytes directly from Telegram WITHOUT triggering the caching pipeline.
        Used by FUSE for uncached files — zero disk writes, zero background downloads.
        Falls back to disk cache if the file is already cached.
        """
        file_meta = await self._db.get_file(virtual_path)
        if not file_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")
            
        total_size = file_meta.get("size", 0)
        if offset >= total_size:
            return b""
            
        actual_length = min(length, total_size - offset)
        
        # Determine which chunk contains our offset
        chunk_size = Config.CHUNK_SIZE_BYTES
        chunk_index = offset // chunk_size
        chunks_list = sorted(file_meta.get("chunks", []), key=lambda c: c["index"])
        
        # Find the chunk metadata
        chunk_meta = None
        for c in chunks_list:
            if c["index"] == chunk_index:
                chunk_meta = c
                break
        
        if not chunk_meta:
            return b""
        
        # Check if this chunk is already cached on disk (by the DownloadCache)
        if self._cache.is_chunk_cached(virtual_path, chunk_meta["index"], chunk_meta["size"]):
            # Serve from disk cache (fast!)
            result = []
            async for data in self._cache.serve_range(virtual_path, file_meta, offset, offset + actual_length - 1, interactive=True):
                result.append(data)
            return b"".join(result)
        
        # Not cached — fetch directly from Telegram (no disk write)
        chunk_start_byte = chunk_index * chunk_size
        read_offset_in_chunk = offset - chunk_start_byte
        
        result = []
        async for data in self._telegram.iter_download(
            message_id=chunk_meta["message_id"],
            offset=read_offset_in_chunk,
            limit=actual_length
        ):
            if not data:
                break
            result.append(data)
        
        return b"".join(result)

    async def save_playback_resume(self, virtual_path: str, payload: dict) -> dict | None:
        """Persist resumable playback metadata for a cloud-backed file."""
        file_doc = await self._db.get_file(virtual_path)
        if not file_doc or file_doc.get("is_directory"):
            return None

        position_seconds = max(0.0, float(payload.get("position_seconds") or 0.0))
        duration_seconds = _coerce_float(payload.get("duration_seconds"))
        percent = _coerce_float(payload.get("percent"))
        if percent is None and duration_seconds and duration_seconds > 0:
            percent = max(0.0, min(1.0, position_seconds / duration_seconds))

        resume_payload = {
            "position_seconds": position_seconds,
            "duration_seconds": duration_seconds if duration_seconds and duration_seconds > 0 else None,
            "percent": max(0.0, min(1.0, percent)) if percent is not None else None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "source": str(payload.get("source") or "web").strip() or "web",
        }
        await self._db.update_file_meta_fields(
            virtual_path,
            set_fields={"playback_resume": resume_payload},
        )
        return resume_payload

    async def clear_playback_resume(self, virtual_path: str) -> bool:
        """Remove resumable playback metadata for a cloud-backed file."""
        return await self._db.update_file_meta_fields(
            virtual_path,
            unset_fields=["playback_resume"],
        )

    async def get_file_meta(self, virtual_path: str):
        # Get file metadata from database.
        file_meta = await self._db.get_file(virtual_path)
        if file_meta:
            return file_meta

        normalized = self._db._normalize_path(virtual_path)
        filename = Path(normalized).name
        if not filename:
            return None

        parent = str(Path(normalized).parent)
        if parent in ("", "."):
            parent = "/"

        try:
            entries = await self._db.list_directory(parent)
        except Exception:
            return None

        filename_nfc = unicodedata.normalize("NFC", filename)
        filename_nfd = unicodedata.normalize("NFD", filename)

        for entry in entries:
            if entry.get("is_directory"):
                continue
            entry_name = str(entry.get("name") or "")
            if not entry_name:
                continue
            if (
                unicodedata.normalize("NFC", entry_name) != filename_nfc
                and unicodedata.normalize("NFD", entry_name) != filename_nfd
            ):
                continue
            resolved_path = str(entry.get("path") or "").strip()
            if not resolved_path:
                continue
            resolved_meta = await self._db.get_file(resolved_path)
            if resolved_meta:
                logger.info(
                    "📁 File meta fallback resolved by parent listing: requested=%s resolved=%s",
                    virtual_path,
                    resolved_path,
                )
                return resolved_meta

        return None

    async def stream_file_to_buffer(self, virtual_path: str, buffer: bytearray):
        """
        Stream entire file from Telegram directly into an in-memory buffer.
        Downloads all chunks sequentially, appending data as it arrives.
        No disk writes, no caching — pure RAM streaming.
        
        Args:
            virtual_path: Virtual file path
            buffer: bytearray to append downloaded data to (grows as data arrives)
        """
        file_meta = await self._db.get_file(virtual_path)
        if not file_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")
        
        chunks = sorted(file_meta.get("chunks", []), key=lambda c: c["index"])
        
        for chunk_meta in chunks:
            msg_id = chunk_meta["message_id"]
            chunk_size = chunk_meta["size"]
            
            async for data in self._telegram.iter_download(
                message_id=msg_id,
                offset=0,
                limit=chunk_size,
                file_size=chunk_size
            ):
                if data:
                    buffer.extend(data)

    async def get_all_files(self) -> list[dict]:
        """Get all files from the database."""
        return await self._db.get_all_files()

    async def get_cache_status(self, virtual_path: str):
        """Get cache status for a file."""
        file_meta = await self._db.get_file(virtual_path)
        if not file_meta:
            return None
        chunks = file_meta.get("chunks", [])
        return self._cache.get_cache_status(virtual_path, chunks)

    async def cache_file(self, virtual_path: str, is_offline_job: bool = False):
        """Trigger full caching of a file. Returns status."""
        file_meta = await self._db.get_file(virtual_path)
        if not file_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")
        return await self._cache.cache_entire_file(virtual_path, file_meta, is_offline_job=is_offline_job)

    async def ensure_file_cached(
        self,
        virtual_path: str,
        *,
        timeout: float | None = None,
        progress_callback=None,
    ) -> dict:
        """Ensure a cloud file is fully cached on disk before returning."""
        file_meta = await self._db.get_file(virtual_path)
        if not file_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")

        chunks = file_meta.get("chunks", [])
        total_bytes = sum(int(chunk.get("size") or 0) for chunk in chunks)
        if self._cache.is_fully_cached(virtual_path, chunks):
            status = self._cache.get_cache_status(virtual_path, chunks)
            if progress_callback:
                progress_callback(int(status.get("cached_bytes") or total_bytes), int(status.get("total_bytes") or total_bytes))
            return status

        await self._cache.cache_entire_file(virtual_path, file_meta)

        cache_task = self._cache._caching_tasks.get(virtual_path)
        if cache_task:
            if timeout is None and not progress_callback:
                await asyncio.shield(cache_task)
            else:
                deadline = (time.monotonic() + timeout) if timeout is not None else None
                last_reported: tuple[int, int] | None = None
                while True:
                    status = self._cache.get_cache_status(virtual_path, chunks)
                    current_bytes = int(status.get("cached_bytes") or 0)
                    total_status_bytes = int(status.get("total_bytes") or total_bytes)
                    if progress_callback and last_reported != (current_bytes, total_status_bytes):
                        progress_callback(current_bytes, total_status_bytes)
                        last_reported = (current_bytes, total_status_bytes)
                    if cache_task.done():
                        break
                    wait_timeout = 0.25
                    if deadline is not None:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise asyncio.TimeoutError()
                        wait_timeout = min(wait_timeout, remaining)
                    try:
                        await asyncio.wait_for(asyncio.shield(cache_task), timeout=wait_timeout)
                    except asyncio.TimeoutError:
                        continue
                await asyncio.shield(cache_task)

        if not self._cache.is_fully_cached(virtual_path, chunks):
            raise RuntimeError(f"File cache did not complete successfully: {virtual_path}")

        status = self._cache.get_cache_status(virtual_path, chunks)
        if progress_callback:
            progress_callback(int(status.get("cached_bytes") or total_bytes), int(status.get("total_bytes") or total_bytes))
        return status

    async def remove_from_cache(self, virtual_path: str):
        """Remove a file from the local disk cache."""
        file_meta = await self._db.get_file(virtual_path)
        if not file_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")
        chunks = file_meta.get("chunks", [])
        self._cache.invalidate(virtual_path, chunks)
        logger.info(f"🧹 Removed from cache: {virtual_path}")

    def is_file_cached(self, file_meta: dict, virtual_path: str) -> bool:
        """Check if a file is fully cached."""
        chunks = file_meta.get("chunks", [])
        return self._cache.is_fully_cached(virtual_path, chunks)

    def get_cached_file_path(self, file_meta: dict, virtual_path: str):
        """Get path for single-chunk cached files (for FileResponse)."""
        chunks = file_meta.get("chunks", [])
        return self._cache.get_full_file_path(virtual_path, chunks)

    async def materialize_cached_file_for_read(
        self,
        virtual_path: str,
        target_path: str | Path,
        *,
        file_meta: dict | None = None,
        timeout: float | None = None,
        progress_callback=None,
    ) -> tuple[Path, dict]:
        """Create a local readable file from cached chunks, including multi-chunk sources."""
        resolved_meta = file_meta or await self.get_file_meta(virtual_path)
        if not resolved_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")

        chunks = sorted(resolved_meta.get("chunks") or [], key=lambda chunk: int(chunk.get("index") or 0))
        if not chunks:
            raise RuntimeError(f"File metadata has no chunks: {virtual_path}")
        total_bytes = sum(int(chunk.get("size") or 0) for chunk in chunks)

        await self.ensure_file_cached(virtual_path, timeout=timeout, progress_callback=progress_callback)

        destination = Path(target_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            try:
                destination.unlink()
            except OSError:
                pass

        direct_path = self.get_cached_file_path(resolved_meta, virtual_path)
        direct_exists = bool(direct_path and Path(direct_path).exists())
        if direct_exists:
            source_path = Path(direct_path)
            try:
                os.link(source_path, destination)
            except OSError:
                shutil.copy2(source_path, destination)
            if progress_callback:
                progress_callback(total_bytes, total_bytes)
            return destination, {
                "mode": "direct_path",
                "chunk_count": len(chunks),
                "cache_percent": 100.0,
                "resolved_meta_path": str(resolved_meta.get("path") or virtual_path),
                "direct_cached_path_present": True,
            }

        if self._cache.is_fully_cached(virtual_path, chunks):
            temp_target = destination.with_suffix(destination.suffix + ".tmp")
            if temp_target.exists():
                try:
                    temp_target.unlink()
                except OSError:
                    pass
            await asyncio.to_thread(self._stitch_cached_chunks_to_file, virtual_path, chunks, temp_target)
            temp_target.replace(destination)
            if progress_callback:
                progress_callback(total_bytes, total_bytes)
            return destination, {
                "mode": "stitched_chunks",
                "chunk_count": len(chunks),
                "cache_percent": 100.0,
                "resolved_meta_path": str(resolved_meta.get("path") or virtual_path),
                "direct_cached_path_present": False,
            }

        cache_status = self._cache.get_cache_status(virtual_path, chunks)
        raise RuntimeError(
            "Arquivo sem cache disponível: "
            f"{virtual_path} "
            f"[chunks={len(chunks)} "
            f"cache_percent={cache_status.get('percent', 0)} "
            f"resolved_meta_path={resolved_meta.get('path') or virtual_path} "
            f"direct_cached_path_present={direct_exists}]"
        )

    async def iter_file_chunks_for_archive(
        self,
        virtual_path: str,
        file_meta: dict | None = None,
        *,
        prefer_cache: bool = True,
        disk_read_size: int = 1024 * 1024,
    ):
        """Yield sequential bytes for archive building, reusing chunk cache when possible."""
        resolved_meta = file_meta or await self.get_file_meta(virtual_path)
        if not resolved_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")

        chunks = sorted(resolved_meta.get("chunks") or [], key=lambda chunk: int(chunk.get("index") or 0))
        if not chunks:
            raise RuntimeError(f"File metadata has no chunks: {virtual_path}")

        for chunk in chunks:
            chunk_index = int(chunk.get("index") or 0)
            chunk_size = int(chunk.get("size") or 0)
            if prefer_cache and self._cache.is_chunk_cached(virtual_path, chunk_index, chunk_size):
                chunk_path = self._cache._chunk_path(virtual_path, chunk_index)
                async with aiofiles.open(chunk_path, "rb") as handle:
                    while True:
                        data = await handle.read(disk_read_size)
                        if not data:
                            break
                        yield data
                continue

            async for data in self._telegram.iter_download(
                message_id=chunk["message_id"],
                file_size=chunk_size,
            ):
                if data:
                    yield data

    async def get_archive_chunk_cache_path(
        self,
        virtual_path: str,
        chunk_meta: dict,
        *,
        file_meta: dict | None = None,
    ) -> Path:
        """Fetch a single archive chunk on demand and return its cache path."""
        resolved_meta = file_meta or await self.get_file_meta(virtual_path)
        if not resolved_meta:
            raise FileNotFoundError(f"File not found: {virtual_path}")

        chunks = sorted(resolved_meta.get("chunks") or [], key=lambda chunk: int(chunk.get("index") or 0))
        if not chunks:
            raise RuntimeError(f"File metadata has no chunks: {virtual_path}")

        current_index = int(chunk_meta.get("index") or 0)
        await self._cache.prefetch_chunks(virtual_path, chunks, current_index)
        return await self._cache.get_or_fetch_chunk(virtual_path, chunk_meta)

    async def cleanup_cache(self):
        """Run LRU cache eviction."""
        return await self._cache.cleanup_lru()

    async def evict_file_cache(self, virtual_path: str):
        """Remove cached chunks for a file (if not marked offline)."""
        file_meta = await self._db.get_file(virtual_path)
        if not file_meta:
            return
        # Don't evict if explicitly saved offline by user
        if file_meta.get("is_offline", False):
            return
        chunks = file_meta.get("chunks", [])
        if chunks:
            self._cache.evict_file_cache(virtual_path, chunks)

    async def list_directory(self, virtual_path: str):
        # List directory contents.
        items = await self._db.list_directory(virtual_path)
        
        # Proactively trigger PDF thumbnail warmup for files in this directory
        pdf_count = 0
        for item in items:
            if not item.get("is_directory") and str(item.get("name") or "").lower().endswith(".pdf"):
                self.schedule_pdf_thumbnail_warmup(item.get("path"), item)
                pdf_count += 1
        
        if pdf_count > 0:
             logger.debug("Scheduled PDF thumbnail warmup for %d files in %s", pdf_count, virtual_path)
             
        return items

    async def directory_exists(self, virtual_path: str):
        # Check if directory exists.
        return await self._db.directory_exists(virtual_path)

    def _strip_trash_metadata(self, doc: dict) -> dict:
        return {
            key: value
            for key, value in (doc or {}).items()
            if key not in {
                "_id",
                "trash_entry_id",
                "trash_root_entry_id",
                "original_path",
                "original_parent",
                "original_root_path",
                "relative_path",
                "trashed_at",
            }
        }

    async def _ensure_parent_directories(self, virtual_path: str) -> None:
        normalized = self._db._normalize_path(virtual_path)
        parent = self._db._parent_path(normalized)
        missing = []
        while parent and parent != "/" and not await self._db.directory_exists(parent):
            missing.append(parent)
            parent = self._db._parent_path(parent)

        for dir_path in reversed(missing):
            await self._db.create_directory(dir_path)

    async def _build_restore_target_path(self, requested_path: str, *, is_directory: bool) -> str:
        normalized = self._db._normalize_path(requested_path)
        if not await self.exists(normalized):
            return normalized

        parent = self._db._parent_path(normalized) or "/"
        name = normalized.rsplit("/", 1)[-1]
        stem = name if is_directory else (Path(name).stem or name)
        suffix = "" if is_directory else (Path(name).suffix or "")

        counter = 1
        while True:
            label = " (restaurado)" if counter == 1 else f" (restaurado {counter})"
            candidate_name = f"{stem}{label}{suffix}"
            candidate = self._db._normalize_path(
                f"/{candidate_name}" if parent == "/" else f"{parent}/{candidate_name}"
            )
            if not await self.exists(candidate):
                return candidate
            counter += 1

    def _replace_restore_prefix(self, original_path: str, original_root_path: str, restored_root_path: str) -> str:
        normalized_original = self._db._normalize_path(original_path)
        normalized_root = self._db._normalize_path(original_root_path)
        normalized_restored = self._db._normalize_path(restored_root_path)
        if normalized_original == normalized_root:
            return normalized_restored
        if normalized_original.startswith(f"{normalized_root}/"):
            suffix = normalized_original[len(normalized_root):]
            return self._db._normalize_path(f"{normalized_restored}{suffix}")
        return normalized_original

    def _build_restored_file_doc(
        self,
        trash_doc: dict,
        restored_path: str,
        *,
        original_root_path: str,
        restored_root_path: str,
    ) -> dict:
        doc = self._strip_trash_metadata(trash_doc)
        normalized_path = self._db._normalize_path(restored_path)
        doc["path"] = normalized_path
        doc["filename"] = normalized_path.rsplit("/", 1)[-1]
        meta = dict(doc.get("meta") or {})
        generated_from_video = str(meta.get("generated_from_video_path") or "").strip()
        if generated_from_video:
            meta["generated_from_video_path"] = self._replace_restore_prefix(
                generated_from_video,
                original_root_path,
                restored_root_path,
            )

        generated_from_file = str(meta.get("generated_from_file_path") or "").strip()
        if generated_from_file:
            meta["generated_from_file_path"] = self._replace_restore_prefix(
                generated_from_file,
                original_root_path,
                restored_root_path,
            )

        preview_asset = meta.get("preview_asset")
        if isinstance(preview_asset, dict):
            preview_copy = dict(preview_asset)
            generated_from = str(preview_copy.get("generated_from") or "").strip()
            if generated_from:
                preview_copy["generated_from"] = self._replace_restore_prefix(
                    generated_from,
                    original_root_path,
                    restored_root_path,
                )
            meta["preview_asset"] = preview_copy

        doc["meta"] = meta
        return doc

    def _build_restored_directory_doc(self, trash_doc: dict, restored_path: str) -> dict:
        doc = self._strip_trash_metadata(trash_doc)
        normalized_path = self._db._normalize_path(restored_path)
        doc["path"] = normalized_path
        doc["parent"] = self._db._parent_path(normalized_path)
        return doc

    async def _collect_related_file_trash_docs(self, file_doc: dict | None) -> list[dict]:
        items = []
        seen_paths = set()

        if not file_doc:
            return items

        if self._is_externalized_video_doc(file_doc):
            for sidecar_doc in await self._list_generated_sidecars_for_video(file_doc.get("path", "")):
                sidecar_path = self._db._normalize_path(sidecar_doc.get("path") or "")
                if sidecar_path and sidecar_path not in seen_paths:
                    seen_paths.add(sidecar_path)
                    items.append(sidecar_doc)

        preview_path = self._get_preview_asset_path(file_doc)
        if preview_path and preview_path not in seen_paths:
            preview_doc = await self._db.get_file(preview_path)
            if preview_doc:
                seen_paths.add(preview_path)
                items.append(preview_doc)

        return items

    async def trash_file(self, virtual_path: str) -> dict:
        normalized = self._db._normalize_path(virtual_path)
        file_doc = await self._db.get_file(normalized)
        if not file_doc:
            raise FileNotFoundError(f"File not found: {normalized}")

        root_id = str(ObjectId())
        related_docs = await self._collect_related_file_trash_docs(file_doc)

        root_trash_doc = await self._db.move_file_to_trash(
            normalized,
            trash_root_entry_id=root_id,
            trash_entry_id=root_id,
            original_root_path=normalized,
            relative_path="",
        )
        if not root_trash_doc:
            raise FileNotFoundError(f"File not found: {normalized}")

        moved_related = 0
        for related_doc in related_docs:
            related_path = self._db._normalize_path(related_doc.get("path") or "")
            if not related_path or related_path == normalized:
                continue
            moved = await self._db.move_file_to_trash(
                related_path,
                trash_root_entry_id=root_id,
                original_root_path=normalized,
                relative_path=related_path.lstrip("/"),
            )
            if moved:
                moved_related += 1
                self._invalidate_thumbnail_cache(related_path)

        self._invalidate_thumbnail_cache(normalized)

        if self._is_generated_sidecar_doc(file_doc):
            parent_video_path = str((file_doc.get("meta") or {}).get("generated_from_video_path") or "").strip()
            if parent_video_path:
                await self._refresh_generated_video_metadata(parent_video_path, touch_modified_at=False)

        if self._is_generated_pdf_preview_doc(file_doc):
            parent_file_path = str((file_doc.get("meta") or {}).get("generated_from_file_path") or "").strip()
            if parent_file_path:
                await self._db._files.update_one(
                    {"path": self._db._normalize_path(parent_file_path)},
                    {
                        "$unset": {"meta.preview_asset": ""},
                    },
                )

        logger.info("🗑️ Moved file to trash: %s", normalized)
        return {
            "trash_entry_id": root_id,
            "root_path": normalized,
            "trashed_related_files": moved_related,
        }

    async def trash_directory_tree(self, virtual_path: str) -> dict:
        normalized = self._db._normalize_path(virtual_path)
        if normalized == "/":
            raise ValueError("Cannot trash root directory")

        if not await self._db.directory_exists(normalized):
            raise FileNotFoundError(f"Directory not found: {normalized}")

        tree = await self._db.list_directory_tree(normalized)
        preview_paths = set()
        for file_doc in tree.get("files", []):
            preview_path = self._get_preview_asset_path(file_doc)
            if preview_path and not preview_path.startswith(f"{normalized}/"):
                preview_paths.add(preview_path)

        root_id = str(ObjectId())
        result = await self._db.move_directory_tree_to_trash(normalized, trash_root_entry_id=root_id)

        moved_related = 0
        for preview_path in sorted(preview_paths):
            moved = await self._db.move_file_to_trash(
                preview_path,
                trash_root_entry_id=root_id,
                original_root_path=normalized,
                relative_path=preview_path.lstrip("/"),
            )
            if moved:
                moved_related += 1
                self._invalidate_thumbnail_cache(preview_path)

        self._invalidate_thumbnail_cache(normalized)
        logger.info("🗑️ Moved directory tree to trash: %s", normalized)
        return {
            **result,
            "trashed_related_files": moved_related,
        }

    async def list_trash(self) -> list[dict]:
        roots = await self._db.list_trash_roots()
        items = []
        for root in roots:
            tree = await self._db.get_trash_tree(root.get("trash_root_entry_id") or root.get("trash_entry_id") or "")
            file_count = len(tree.get("files", []))
            directory_count = len(tree.get("directories", []))
            item = dict(root)
            item["descendant_counts"] = {
                "files": file_count,
                "directories": directory_count,
            }
            items.append(item)
        return items

    async def _resolve_trash_root_ids(
        self,
        entry_ids: list[str] | None = None,
        *,
        include_all: bool = False,
    ) -> list[str]:
        root_ids = [str(entry_id).strip() for entry_id in (entry_ids or []) if str(entry_id).strip()]
        if include_all:
            roots = await self._db.list_trash_roots()
            root_ids = [
                str(root.get("trash_root_entry_id") or root.get("trash_entry_id") or "").strip()
                for root in roots
                if str(root.get("trash_root_entry_id") or root.get("trash_entry_id") or "").strip()
            ]
        return list(dict.fromkeys(root_ids))

    async def _load_trash_trees(self, root_ids: list[str]) -> tuple[dict[str, dict], list[str]]:
        if not root_ids:
            return {}, []

        results = await asyncio.gather(
            *(self._db.get_trash_tree(root_id) for root_id in root_ids),
            return_exceptions=True,
        )
        tree_map: dict[str, dict] = {}
        errors = []
        for root_id, result in zip(root_ids, results):
            if isinstance(result, Exception):
                logger.error("Failed to load trash tree %s: %s", root_id, result, exc_info=True)
                errors.append(f"{root_id}: {result}")
                continue
            tree_map[root_id] = result
        return tree_map, errors

    async def restore_trash(self, entry_ids: list[str] | None = None, *, restore_all: bool = False) -> dict:
        root_ids = await self._resolve_trash_root_ids(entry_ids, include_all=restore_all)
        tree_map, errors = await self._load_trash_trees(root_ids)

        restored = []

        for root_id in root_ids:
            tree = tree_map.get(root_id)
            if tree is None:
                continue
            files = list(tree.get("files", []))
            directories = list(tree.get("directories", []))
            root_dir = next((doc for doc in directories if doc.get("trash_entry_id") == root_id), None)
            root_file = next((doc for doc in files if doc.get("trash_entry_id") == root_id), None)
            inserted_file_paths = []
            inserted_dir_paths = []

            if bool(root_dir) == bool(root_file):
                errors.append(f"Entrada de lixeira inválida: {root_id}")
                continue

            try:
                if root_dir:
                    original_root_path = self._db._normalize_path(root_dir.get("original_path") or root_dir.get("path") or "/")
                    restored_root_path = await self._build_restore_target_path(original_root_path, is_directory=True)
                    await self._ensure_parent_directories(restored_root_path)

                    sorted_dirs = sorted(
                        directories,
                        key=lambda doc: (str(doc.get("original_path") or doc.get("path") or "").count("/"), str(doc.get("original_path") or "")),
                    )
                    for dir_doc in sorted_dirs:
                        original_dir_path = self._db._normalize_path(dir_doc.get("original_path") or dir_doc.get("path") or original_root_path)
                        target_dir_path = self._replace_restore_prefix(
                            original_dir_path,
                            original_root_path,
                            restored_root_path,
                        )
                        await self._ensure_parent_directories(target_dir_path)
                        await self._db._directories.insert_one(self._build_restored_directory_doc(dir_doc, target_dir_path))
                        inserted_dir_paths.append(target_dir_path)

                    restored_video_paths = []
                    for file_doc in sorted(files, key=lambda doc: str(doc.get("original_path") or doc.get("path") or "")):
                        original_file_path = self._db._normalize_path(file_doc.get("original_path") or file_doc.get("path") or "")
                        target_file_path = original_file_path
                        if original_file_path.startswith(f"{original_root_path}/"):
                            target_file_path = self._replace_restore_prefix(
                                original_file_path,
                                original_root_path,
                                restored_root_path,
                            )
                        elif self._is_generated_pdf_preview_doc(file_doc) and await self.exists(target_file_path):
                            target_file_path = self._build_pdf_preview_sidecar_path(restored_root_path)
                        elif await self.exists(target_file_path):
                            target_file_path = await self._build_restore_target_path(target_file_path, is_directory=False)

                        await self._ensure_parent_directories(target_file_path)
                        restored_doc = self._build_restored_file_doc(
                            file_doc,
                            target_file_path,
                            original_root_path=original_root_path,
                            restored_root_path=restored_root_path,
                        )
                        await self._db._files.insert_one(restored_doc)
                        inserted_file_paths.append(target_file_path)
                        if self._is_externalized_video_doc(restored_doc):
                            restored_video_paths.append(target_file_path)

                    for video_path in restored_video_paths:
                        await self._refresh_generated_video_metadata(video_path, touch_modified_at=False)

                    await self._db.delete_trash_roots([root_id])
                    restored.append({
                        "trash_entry_id": root_id,
                        "original_path": original_root_path,
                        "final_path": restored_root_path,
                        "renamed": restored_root_path != original_root_path,
                        "is_directory": True,
                    })
                    continue

                original_root_path = self._db._normalize_path(root_file.get("original_path") or root_file.get("path") or "/")
                restored_root_path = await self._build_restore_target_path(original_root_path, is_directory=False)
                await self._ensure_parent_directories(restored_root_path)

                restored_root_doc = self._build_restored_file_doc(
                    root_file,
                    restored_root_path,
                    original_root_path=original_root_path,
                    restored_root_path=restored_root_path,
                )
                await self._db._files.insert_one(restored_root_doc)
                inserted_file_paths.append(restored_root_path)

                for file_doc in sorted(files, key=lambda doc: str(doc.get("original_path") or doc.get("path") or "")):
                    if file_doc.get("trash_entry_id") == root_id:
                        continue

                    target_file_path = self._db._normalize_path(file_doc.get("original_path") or file_doc.get("path") or "")
                    if str((file_doc.get("meta") or {}).get("generated_from_video_path") or "").strip() == original_root_path:
                        target_file_path = self._build_generated_sidecar_destination_path(restored_root_path, file_doc)
                    elif str((file_doc.get("meta") or {}).get("generated_from_file_path") or "").strip() == original_root_path:
                        if await self.exists(target_file_path):
                            target_file_path = self._build_pdf_preview_sidecar_path(restored_root_path)
                    elif await self.exists(target_file_path):
                        target_file_path = await self._build_restore_target_path(target_file_path, is_directory=False)

                    await self._ensure_parent_directories(target_file_path)
                    restored_doc = self._build_restored_file_doc(
                        file_doc,
                        target_file_path,
                        original_root_path=original_root_path,
                        restored_root_path=restored_root_path,
                    )
                    await self._db._files.insert_one(restored_doc)
                    inserted_file_paths.append(target_file_path)

                if self._is_externalized_video_doc(restored_root_doc):
                    await self._refresh_generated_video_metadata(restored_root_path, touch_modified_at=False)
                elif self._is_generated_sidecar_doc(restored_root_doc):
                    parent_video_path = str((restored_root_doc.get("meta") or {}).get("generated_from_video_path") or "").strip()
                    if parent_video_path:
                        await self._refresh_generated_video_metadata(parent_video_path, touch_modified_at=False)

                await self._db.delete_trash_roots([root_id])
                restored.append({
                    "trash_entry_id": root_id,
                    "original_path": original_root_path,
                    "final_path": restored_root_path,
                    "renamed": restored_root_path != original_root_path,
                    "is_directory": False,
                })
            except Exception as exc:
                logger.error("Failed to restore trash entry %s: %s", root_id, exc, exc_info=True)
                if inserted_file_paths:
                    await self._db._files.delete_many({"path": {"$in": inserted_file_paths}})
                if inserted_dir_paths:
                    await self._db._directories.delete_many({"path": {"$in": inserted_dir_paths}})
                errors.append(f"{root_id}: {exc}")

        return {
            "restored": restored,
            "errors": errors,
        }

    async def empty_trash(self, entry_ids: list[str] | None = None, *, purge_all: bool = False) -> dict:
        root_ids = await self._resolve_trash_root_ids(entry_ids, include_all=purge_all)
        tree_map, errors = await self._load_trash_trees(root_ids)

        purgeable_root_ids = []
        purged_files = 0
        purged_directories = 0
        all_chunks = []

        for root_id in root_ids:
            tree = tree_map.get(root_id)
            if tree is None:
                continue
            files = list(tree.get("files", []))
            directories = list(tree.get("directories", []))
            try:
                for file_doc in files:
                    original_path = self._db._normalize_path(file_doc.get("original_path") or file_doc.get("path") or "")
                    chunks = file_doc.get("chunks", [])
                    if original_path:
                        self._cache.invalidate(original_path, chunks)
                        self._invalidate_thumbnail_cache(original_path)
                    all_chunks.extend(chunks)

                purgeable_root_ids.append(root_id)
                purged_files += len(files)
                purged_directories += len(directories)
            except Exception as exc:
                logger.error("Failed to empty trash entry %s: %s", root_id, exc, exc_info=True)
                errors.append(f"{root_id}: {exc}")

        if all_chunks:
            await self._delete_telegram_chunks(all_chunks)

        purged_roots = 0
        if purgeable_root_ids:
            try:
                await self._db.delete_trash_roots(purgeable_root_ids)
                purged_roots = len(purgeable_root_ids)
            except Exception as exc:
                logger.error("Failed to delete trash roots in batch: %s", exc, exc_info=True)
                errors.append(f"batch_delete: {exc}")
                purged_files = 0
                purged_directories = 0

        return {
            "purged_roots": purged_roots,
            "purged_files": purged_files,
            "purged_directories": purged_directories,
            "errors": errors,
        }

    # ===================== DELETE =====================

    async def delete_file(self, virtual_path: str) -> bool:
        """Delete a file from both Telegram and MongoDB."""
        file_doc = await self._db.get_file(virtual_path)
        if file_doc and self._is_externalized_video_doc(file_doc):
            for sidecar_doc in await self._list_generated_sidecars_for_video(virtual_path):
                await self.delete_file(sidecar_doc.get("path", ""))
        if file_doc and self._get_preview_asset_path(file_doc):
            await self._delete_pdf_preview_sidecar_for_doc(file_doc)

        file_meta = await self._db.delete_file(virtual_path)
        if not file_meta:
            return False

        chunks = file_meta.get("chunks", [])
        self._cache.invalidate(virtual_path, chunks)
        self._invalidate_thumbnail_cache(virtual_path)
        await self._delete_telegram_chunks(chunks)
        if self._is_generated_sidecar_doc(file_meta):
            parent_video_path = str((file_meta.get("meta") or {}).get("generated_from_video_path") or "").strip()
            if parent_video_path:
                await self._refresh_generated_video_metadata(parent_video_path, touch_modified_at=False)
        if self._is_generated_pdf_preview_doc(file_meta):
            parent_file_path = str((file_meta.get("meta") or {}).get("generated_from_file_path") or "").strip()
            if parent_file_path:
                await self._db._files.update_one(
                    {"path": self._db._normalize_path(parent_file_path)},
                    {
                        "$unset": {"meta.preview_asset": ""},
                    },
                )
        logger.info(f"🗑️ File fully deleted: {virtual_path}")
        return True

    async def _delete_telegram_chunks(self, chunks: list[dict]) -> None:
        """Delete chunk messages from Telegram."""
        message_ids = []
        seen_ids = set()
        for chunk in chunks:
            raw_message_id = chunk.get("message_id", chunk.get("id"))
            try:
                message_id = int(raw_message_id)
            except (TypeError, ValueError):
                continue
            if message_id <= 0 or message_id in seen_ids:
                continue
            seen_ids.add(message_id)
            message_ids.append(message_id)
        if message_ids:
            await self._telegram.delete_files(message_ids)

    # ===================== DIRECTORY OPERATIONS =====================

    async def create_directory(self, virtual_path: str) -> dict:
        """Create a virtual directory."""
        return await self._db.create_directory(virtual_path)

    async def delete_directory(self, virtual_path: str) -> bool:
        """Delete an empty directory."""
        return await self._db.delete_directory(virtual_path)

    async def delete_directory_recursive(self, virtual_path: str) -> dict:
        """
        Recursively delete a directory and all its contents with full cleanup.
        
        For each file: removes Telegram chunks, invalidates cache, invalidates thumbnails.
        For directories: removes deepest-first, then the root directory last.
        
        Uses best-effort strategy: continues on individual file failures,
        but never returns silent success when errors occurred.
        
        Returns:
            {
                "deleted_files": int,
                "deleted_directories": int, 
                "errors": list[str]
            }
        """
        normalized = self._db._normalize_path(virtual_path)
        
        # Safety: never delete root
        if normalized == "/":
            raise ValueError("Cannot delete root directory")
        
        # Verify directory exists
        if not await self._db.directory_exists(normalized):
            raise FileNotFoundError(f"Directory not found: {normalized}")
        
        deleted_files = 0
        deleted_dirs = 0
        errors = []
        
        # 1. Enumerate the full tree (read-only)
        tree = await self._db.list_directory_tree(normalized)
        child_files = tree["files"]
        child_dirs = tree["directories"]
        
        logger.info(
            f"🗑️ Recursive delete starting: {normalized} "
            f"({len(child_files)} file(s), {len(child_dirs)} subdirectorie(s))"
        )
        
        # 2. Delete all files (each with full Telegram/cache/thumb cleanup)
        for file_doc in child_files:
            file_path = file_doc.get("path", "")
            try:
                if await self.delete_file(file_path):
                    deleted_files += 1
                    logger.debug(f"🗑️ Recursively deleted file: {file_path}")
            except Exception as e:
                err_msg = f"Failed to delete file {file_path}: {e}"
                logger.error(err_msg)
                errors.append(err_msg)
        
        # 3. Delete subdirectories (deepest first)
        sorted_dirs = sorted(child_dirs, key=lambda d: d["path"].count("/"), reverse=True)
        for dir_doc in sorted_dirs:
            dir_path = dir_doc.get("path", "")
            try:
                await self._db.delete_directory(dir_path)
                deleted_dirs += 1
                logger.debug(f"🗑️ Recursively deleted subdirectory: {dir_path}")
            except Exception as e:
                err_msg = f"Failed to delete directory {dir_path}: {e}"
                logger.error(err_msg)
                errors.append(err_msg)
        
        # 4. Delete the target directory itself
        try:
            # Force-delete via direct DB call since children are already removed
            result = await self._db._directories.delete_one({"path": normalized})
            if result.deleted_count > 0:
                deleted_dirs += 1
                logger.info(f"🗑️ Deleted target directory: {normalized}")
            else:
                errors.append(f"Target directory not found in DB: {normalized}")
        except Exception as e:
            err_msg = f"Failed to delete target directory {normalized}: {e}"
            logger.error(err_msg)
            errors.append(err_msg)
        
        result = {
            "deleted_files": deleted_files,
            "deleted_directories": deleted_dirs,
            "errors": errors
        }
        
        if errors:
            logger.warning(
                f"⚠️ Recursive delete completed with errors: {normalized} "
                f"(files={deleted_files}, dirs={deleted_dirs}, errors={len(errors)})"
            )
        else:
            logger.info(
                f"✅ Recursive delete completed: {normalized} "
                f"(files={deleted_files}, dirs={deleted_dirs})"
            )
        
        return result

    async def rename(self, old_path: str, new_path: str, auto_rename: bool = False) -> bool:
        """Rename/move a file or directory."""
        # Try file first
        file_doc = await self._db.get_file(old_path)
        if file_doc:
            # Auto-rename if destination already exists AND auto_rename is True
            if auto_rename and await self._db.file_exists(new_path):
                base = Path(new_path)
                stem = base.stem
                suffix = base.suffix
                parent = str(base.parent)
                if parent == ".": parent = "/"
                
                counter = 1
                while True:
                    label = " (cópia)" if counter == 1 else f" (cópia {counter})"
                    new_name = f"{stem}{label}{suffix}"
                    if parent == "/":
                        candidate = f"/{new_name}"
                    else:
                        candidate = f"{parent}/{new_name}"
                    if not await self._db.file_exists(candidate):
                        new_path = candidate
                        break
                    counter += 1
                logger.info(f"Auto-renamed move destination to: {new_path}")

            if self._is_externalized_video_doc(file_doc):
                sidecar_docs = await self._list_generated_sidecars_for_video(old_path)
                sidecar_targets = [(doc, self._build_generated_sidecar_destination_path(new_path, doc)) for doc in sidecar_docs]
                for doc, target_path in sidecar_targets:
                    if target_path != doc.get("path") and await self._db.file_exists(target_path):
                        raise FileExistsError(f"Generated subtitle destination already exists: {target_path}")

                renamed = await self._db.rename_file(old_path, new_path)
                for doc, target_path in sidecar_targets:
                    await self._db.rename_file(doc["path"], target_path)
                    await self._db._files.update_one(
                        {"path": self._db._normalize_path(target_path)},
                        {
                            "$set": {
                                "meta.generated_from_video_path": self._db._normalize_path(new_path),
                                "modified_at": datetime.now(timezone.utc),
                            }
                        },
                    )
                await self._refresh_generated_video_metadata(new_path)
                return renamed

            renamed = await self._db.rename_file(old_path, new_path)
            if renamed and self._get_preview_asset_path(file_doc):
                await self._rewrite_generated_pdf_preview_links(old_path, new_path)
            if renamed and self._is_generated_sidecar_doc(file_doc):
                meta = file_doc.get("meta") or {}
                if meta.get("generated_from_video_path"):
                    await self._refresh_generated_video_metadata(meta["generated_from_video_path"])
            return renamed

        # Try directory
        if await self._db.directory_exists(old_path):
            tree = await self._db.list_directory_tree(old_path)
            renamed = await self._db.rename_directory(old_path, new_path)
            if renamed:
                for file_doc in tree.get("files", []):
                    if not self._get_preview_asset_path(file_doc):
                        continue
                    original_file_path = file_doc.get("path", "")
                    rewritten_path = self._db._normalize_path(new_path + original_file_path[len(self._db._normalize_path(old_path)):])
                    await self._rewrite_generated_pdf_preview_links(original_file_path, rewritten_path)
            return renamed

        return False

    async def list_directory(self, virtual_path: str) -> list[dict]:
        """List directory contents."""
        items = await self._db.list_directory(virtual_path)
        pdf_count = 0
        for item in items:
            if not item.get("is_directory") and str(item.get("name") or "").lower().endswith(".pdf"):
                self.schedule_pdf_thumbnail_warmup(item.get("path"), item)
                pdf_count += 1
        if pdf_count > 0:
            logger.debug("Scheduled PDF thumbnail warmup for %d files in %s", pdf_count, virtual_path)
        return items

    async def exists(self, virtual_path: str) -> bool:
        """Check if a file or directory exists."""
        return (
            await self._db.file_exists(virtual_path)
            or await self._db.directory_exists(virtual_path)
        )

    async def is_file(self, virtual_path: str) -> bool:
        """Check if path is a file."""
        return await self._db.file_exists(virtual_path)

    async def is_directory(self, virtual_path: str) -> bool:
        """Check if path is a directory."""
        return await self._db.directory_exists(virtual_path)

    async def get_file_info(self, virtual_path: str) -> dict | None:
        """Get file metadata."""
        return await self._db.get_file(virtual_path)

    async def copy(self, source_path: str, dest_path: str, auto_rename: bool = False) -> bool:
        """
        Copy a file or directory recursively.
        
        Args:
            source_path: Path of the item to copy.
            dest_path: Destination path for the copy.
            auto_rename: If True, automatically rename file if destination exists.
        """
        logger.info(f"📋 Copying {source_path} -> {dest_path} (auto_rename={auto_rename})")
        
        # 1. Check if source is a file
        file_doc = await self._db.get_file(source_path)
        if file_doc:
            # Auto-rename if destination already exists AND auto_rename is True
            if auto_rename and await self._db.file_exists(dest_path):
                base = Path(dest_path)
                stem = base.stem
                suffix = base.suffix
                parent = str(base.parent)
                if parent == ".": parent = "/"
                
                counter = 1
                while True:
                    label = " (cópia)" if counter == 1 else f" (cópia {counter})"
                    new_name = f"{stem}{label}{suffix}"
                    if parent == "/":
                        candidate = f"/{new_name}"
                    else:
                        candidate = f"{parent}/{new_name}"
                    if not await self._db.file_exists(candidate):
                        dest_path = candidate
                        break
                    counter += 1
                logger.info(f"Auto-renamed copy destination to: {dest_path}")

            if self._is_externalized_video_doc(file_doc):
                new_group_id = f"mkvsubs_{secrets.token_hex(8)}"
                sidecar_docs = await self._list_generated_sidecars_for_video(source_path)
                copied_sidecars = []
                copied_video_doc = await self._copy_file_document(
                    file_doc,
                    dest_path,
                    meta_override={
                        "generated_group_id": new_group_id,
                        "generated_subtitle_files": [],
                    },
                )
                try:
                    for sidecar_doc in sidecar_docs:
                        companion_dest = self._build_generated_sidecar_destination_path(dest_path, sidecar_doc)
                        copied_companion = await self._copy_file_document(
                            sidecar_doc,
                            companion_dest,
                            meta_override={
                                "generated_group_id": new_group_id,
                                "generated_from_video_path": self._db._normalize_path(dest_path),
                            },
                        )
                        copied_sidecars.append(copied_companion)
                except Exception:
                    await self.delete_file(dest_path)
                    raise

                await self._refresh_generated_video_metadata(dest_path)
                return True

            has_pdf_preview_link = bool(self._get_preview_asset_path(file_doc))
            pdf_preview_docs = await self._list_generated_pdf_previews_for_file(source_path)
            try:
                await self._copy_file_document(
                    file_doc,
                    dest_path,
                    meta_override={"preview_asset": None} if has_pdf_preview_link else None,
                )
                if pdf_preview_docs:
                    preview_doc = pdf_preview_docs[0]
                    copied_preview_doc = await self._copy_file_document(
                        preview_doc,
                        self._build_pdf_preview_sidecar_path(dest_path),
                        meta_override={
                            "generated_role": "pdf_thumbnail",
                            "generated_from_file_path": self._db._normalize_path(dest_path),
                            "hidden_system_file": True,
                        },
                    )
                    await self._db._files.update_one(
                        {"path": self._db._normalize_path(dest_path)},
                        {
                            "$set": {
                                "meta.preview_asset": self._build_pdf_preview_asset_metadata(
                                    copied_preview_doc,
                                    generated_from="copy",
                                ),
                                "modified_at": datetime.now(timezone.utc),
                            }
                        },
                    )
            except Exception:
                await self.delete_file(dest_path)
                raise
            return True

        # 2. Check if source is a directory
        if await self._db.directory_exists(source_path):
            # Create the destination directory
            await self.create_directory(dest_path)
            
            # Iterate source children
            items = await self.list_directory(source_path)
            for item in items:
                child_source = item["path"] + "/" + item["name"] if item["path"] != "/" else "/" + item["name"]
                child_dest = dest_path + "/" + item["name"]
                # Recursive calling
                await self.copy(child_source, child_dest)
                
            return True
            
        # 3. Source not found
        logger.warning(f"Copy failed: Source not found '{source_path}'")
        raise FileNotFoundError(f"Source not found: {source_path}")

    async def set_offline(self, virtual_path: str, is_offline: bool) -> bool:
        """Set offline status and trigger caching/removal."""
        file_doc = await self._db.get_file(virtual_path)
        success = await self._db.set_offline(virtual_path, is_offline)
        if not success:
            raise FileNotFoundError(f"File not found: {virtual_path}")

        if is_offline:
            await self.cache_file(virtual_path, is_offline_job=True)
        else:
            await self.remove_from_cache(virtual_path)

        if file_doc and self._is_externalized_video_doc(file_doc):
            for sidecar_doc in await self._list_generated_sidecars_for_video(virtual_path):
                sidecar_path = sidecar_doc.get("path", "")
                if not sidecar_path:
                    continue
                sidecar_success = await self._db.set_offline(sidecar_path, is_offline)
                if not sidecar_success:
                    continue
                if is_offline:
                    await self.cache_file(sidecar_path, is_offline_job=True)
                else:
                    await self.remove_from_cache(sidecar_path)

        return True

    async def set_favorite(self, virtual_path: str, is_favorite: bool) -> bool:
        """Set favorite status."""
        return await self._db.set_favorite(virtual_path, is_favorite)

    async def get_favorites(self) -> list[dict]:
        """Get all favorites."""
        return await self._db.get_favorites()

    async def get_cached_files(self) -> list[dict]:
        """Get all files that are marked for offline availability (even if still downloading)."""
        all_files = await self._db.get_offline_files()
        cached_files = []
        for f in all_files:
            if not f.get("is_directory") and f.get("chunks"):
                # We include it in the offline tab regardless of whether it finished downloading
                # But we append its real cached status so the UI knows
                f["is_cached"] = self._cache.is_file_cached(f["path"], f["chunks"])
                cached_files.append(f)
        return cached_files

    async def get_storage_inventory(self) -> list[dict]:
        """Return the authoritative inventory for persistent and temporary cache items."""
        items = []
        candidates = await self._db.get_storage_candidates()

        for entry in candidates:
            path = str(entry.get("path") or "").strip()
            chunks = entry.get("chunks") or []
            if not path or not chunks:
                continue

            cache_status = self._cache.get_file_cache_snapshot(path, chunks)
            percent = float(cache_status.get("percent") or 0)
            retention_kind = "persistent" if entry.get("is_offline") else "temporary" if percent > 0 else ""
            if not retention_kind:
                continue

            is_ready = bool(cache_status.get("total_bytes")) and percent >= 100
            is_syncing = retention_kind == "persistent" and (
                bool(cache_status.get("active_offline")) or (0 < percent < 100)
            )
            modified_at = entry.get("modified_at")

            items.append(
                {
                    "name": entry.get("filename") or entry.get("name") or Path(path).name,
                    "path": path,
                    "size_bytes": int(entry.get("size") or 0),
                    "modified_at": modified_at.isoformat() if hasattr(modified_at, "isoformat") else str(modified_at or ""),
                    "mime_type": entry.get("meta", {}).get("mime_type"),
                    "status": {
                        "retention_kind": retention_kind,
                        "is_ready": is_ready,
                        "is_syncing": is_syncing,
                        "is_cached": is_ready,
                        "is_offline": retention_kind == "persistent",
                        "is_volatile": retention_kind == "temporary",
                    },
                    "storage": {
                        "origin": "cloud",
                        "chunk_count": len(chunks),
                        "storage_scheme": entry.get("storage_scheme"),
                        "storage_id_masked": entry.get("storage_id"),
                    },
                    "cache": {
                        "cached_bytes": int(cache_status.get("cached_bytes") or 0),
                        "total_bytes": int(cache_status.get("total_bytes") or 0),
                        "percent": percent,
                        "last_accessed_at": str(cache_status.get("last_accessed_at") or ""),
                    },
                    "actions": {
                        "can_remove_offline": retention_kind == "persistent",
                        "can_evict_cache": retention_kind == "temporary",
                        "can_inspect": True,
                    },
                }
            )

        items.sort(
            key=lambda entry: (
                entry.get("cache", {}).get("last_accessed_at") or "",
                entry.get("modified_at") or "",
            ),
            reverse=True,
        )
        return items

    async def get_disk_usage(self) -> int:
        """Get total storage used."""
        return await self._db.get_disk_usage()

    async def get_recents(self, limit: int = 50) -> list[dict]:
        """Get recently modified/created files."""
        return await self._db.get_recents(limit)

    # ===================== STAGING CLEANUP =====================

    async def cleanup_staging(self) -> int:
        """Remove old staging files beyond MAX_STAGING_AGE."""
        removed = 0
        now = time.time()
        staging = Config.STAGING_DIR

        if not staging.exists():
            return 0

        for item in staging.iterdir():
            try:
                age = now - item.stat().st_mtime
                if age > Config.MAX_STAGING_AGE:
                    if item.is_file():
                        item.unlink()
                    elif item.is_dir():
                        import shutil
                        shutil.rmtree(item)
                    removed += 1
            except OSError as e:
                logger.warning(f"Cleanup error: {e}")

        if removed > 0:
            logger.info(f"🧹 Cleaned {removed} staging item(s)")
        return removed
