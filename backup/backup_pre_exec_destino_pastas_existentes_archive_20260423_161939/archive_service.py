from __future__ import annotations

import asyncio
import gzip
import io
import logging
import os
import queue
import shlex
import shutil
import tarfile
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from config import Config

try:
    import py7zr  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    py7zr = None

try:
    import rarfile  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    rarfile = None


logger = logging.getLogger("tcloud.archive")


_ARCHIVE_STAGE_ORDER = {
    "compress": ("listing", "downloading", "compressing", "uploading"),
    "extract": ("downloading", "extracting", "uploading"),
}

_ARCHIVE_STAGE_WEIGHTS = {
    "compress": {
        "listing": 5,
        "downloading": 25,
        "compressing": 35,
        "uploading": 35,
    },
    "extract": {
        "downloading": 30,
        "extracting": 35,
        "uploading": 35,
    },
}


class ArchiveServiceError(RuntimeError):
    """Base error for archive operations."""


class ArchiveValidationError(ArchiveServiceError):
    """Raised when a requested archive operation is invalid or unsafe."""


class ArchiveCapabilityError(ArchiveServiceError):
    """Raised when the required backend/tooling is not available."""


class ArchiveJobCancelled(ArchiveServiceError):
    """Raised when an archive job is canceled by the user."""


class ArchiveJobTimeoutError(ArchiveServiceError):
    """Raised when an archive step stops responding for too long."""


def _normalize_virtual_path(path: str | None) -> str:
    text = str(path or "").replace("\\", "/").strip()
    if not text or text == ".":
        return "/"
    normalized = "/".join(part for part in text.split("/") if part)
    if not normalized:
        return "/"
    return f"/{normalized}"


def _join_virtual_path(parent: str, name: str) -> str:
    base = _normalize_virtual_path(parent)
    child = str(name or "").replace("\\", "/").strip("/")
    if not child:
        return base
    if base == "/":
        return f"/{child}"
    return f"{base}/{child}"


def _strip_archive_suffix(filename: str) -> str:
    lowered = str(filename or "").lower()
    for suffix in (".tar.gz", ".tgz", ".zip", ".7z", ".rar"):
        if lowered.endswith(suffix):
            return filename[: -len(suffix)] or "arquivo"
    return Path(filename).stem or "arquivo"


def _detect_archive_format(filename: str) -> str:
    lowered = str(filename or "").lower()
    if lowered.endswith(".tar.gz") or lowered.endswith(".tgz"):
        return "tar.gz"
    if lowered.endswith(".zip"):
        return "zip"
    if lowered.endswith(".7z"):
        return "7z"
    if lowered.endswith(".rar"):
        return "rar"
    raise ArchiveValidationError("Formato de arquivo compactado não suportado.")


def _sanitize_archive_name(name: str, archive_format: str) -> str:
    text = str(name or "").strip().replace("\\", "/").split("/")[-1]
    cleaned = "".join(ch if ch not in '<>:"\\|?*\x00' else "_" for ch in text).strip().strip(".")
    if not cleaned:
        cleaned = "arquivo"

    expected_suffix = {
        "zip": ".zip",
        "7z": ".7z",
        "tar.gz": ".tar.gz",
    }[archive_format]

    lowered = cleaned.lower()
    if archive_format == "tar.gz":
        if not (lowered.endswith(".tar.gz") or lowered.endswith(".tgz")):
            cleaned += expected_suffix
    elif not lowered.endswith(expected_suffix):
        cleaned += expected_suffix
    return cleaned


def _relative_path_for_archive(source_path: str, base_path: str | None) -> PurePosixPath:
    source_parts = PurePosixPath(_normalize_virtual_path(source_path)).parts[1:]
    if not source_parts:
        raise ArchiveValidationError("Não é possível compactar a raiz inteira.")

    normalized_base = _normalize_virtual_path(base_path)
    if normalized_base != "/":
        base_parts = PurePosixPath(normalized_base).parts[1:]
        if source_parts[: len(base_parts)] == base_parts:
            relative_parts = source_parts[len(base_parts):]
            if relative_parts:
                return PurePosixPath(*relative_parts)
    return PurePosixPath(*source_parts)


def _compression_level_for_zip(level: str) -> int:
    return {
        "store": 0,
        "fast": 1,
        "normal": 6,
        "maximum": 9,
    }.get(str(level or "").strip().lower(), 6)


def _compression_level_for_tar(level: str) -> int:
    return {
        "store": 1,
        "fast": 3,
        "normal": 6,
        "maximum": 9,
    }.get(str(level or "").strip().lower(), 6)


def _parse_streaming_formats(raw_value: str) -> set[str]:
    values = {part.strip().lower() for part in str(raw_value or "").split(",") if part.strip()}
    return values or {"zip", "tar.gz"}


class _QueueBackedSyncReader:
    _SENTINEL = object()

    def __init__(self, *, max_pending_chunks: int = 8):
        self._queue: queue.Queue[object] = queue.Queue(maxsize=max(1, max_pending_chunks))
        self._buffer = bytearray()
        self._eof = False
        self._error: Exception | None = None

    async def pump(self, async_iterable) -> None:
        try:
            async for chunk in async_iterable:
                if not chunk:
                    continue
                await asyncio.to_thread(self._queue.put, bytes(chunk))
        except Exception as exc:
            self._error = exc
        finally:
            await asyncio.to_thread(self._queue.put, self._SENTINEL)

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            chunks = []
            if self._buffer:
                chunks.append(bytes(self._buffer))
                self._buffer.clear()
            while not self._eof:
                item = self._queue.get()
                if item is self._SENTINEL:
                    self._eof = True
                    break
                chunks.append(item)
            if not chunks and self._error:
                raise self._error
            return b"".join(chunks)

        while len(self._buffer) < size and not self._eof:
            item = self._queue.get()
            if item is self._SENTINEL:
                self._eof = True
                break
            self._buffer.extend(item)

        if not self._buffer and self._eof:
            if self._error:
                raise self._error
            return b""

        if size < 0 or size >= len(self._buffer):
            payload = bytes(self._buffer)
            self._buffer.clear()
            return payload

        payload = bytes(self._buffer[:size])
        del self._buffer[:size]
        return payload


class _ChunkBackedSeekableReader(io.RawIOBase):
    def __init__(self, *, file_manager, loop: asyncio.AbstractEventLoop, virtual_path: str, file_meta: dict, name: str = "archive"):
        super().__init__()
        chunks = sorted(file_meta.get("chunks") or [], key=lambda chunk: int(chunk.get("index") or 0))
        if not chunks:
            raise RuntimeError(f"File metadata has no chunks: {virtual_path}")
        self._file_manager = file_manager
        self._loop = loop
        self._virtual_path = virtual_path
        self._file_meta = file_meta
        self._position = 0
        self._size = 0
        self._chunk_windows: list[tuple[int, int, dict]] = []
        for chunk in chunks:
            chunk_size = max(0, int(chunk.get("size") or 0))
            chunk_start = self._size
            chunk_end = chunk_start + chunk_size
            self._chunk_windows.append((chunk_start, chunk_end, chunk))
            self._size = chunk_end
        self.name = name

    def readable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        self._ensure_open()
        return self._position

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        self._ensure_open()
        if whence == os.SEEK_SET:
            target = int(offset)
        elif whence == os.SEEK_CUR:
            target = self._position + int(offset)
        elif whence == os.SEEK_END:
            target = self._size + int(offset)
        else:
            raise ValueError("Invalid whence value")
        if target < 0:
            raise ValueError("Negative seek position")
        self._position = target
        return self._position

    def read(self, size: int = -1) -> bytes:
        self._ensure_open()
        if self._position >= self._size:
            return b""
        if size is None or size < 0:
            target_end = self._size
        else:
            target_end = min(self._size, self._position + int(size))
        if target_end <= self._position:
            return b""

        start = self._position
        parts: list[bytes] = []
        for chunk_start, chunk_end, chunk_meta in self._chunk_windows:
            if chunk_end <= start:
                continue
            if chunk_start >= target_end:
                break
            local_start = max(0, start - chunk_start)
            local_end = min(chunk_end, target_end) - chunk_start
            if local_end <= local_start:
                continue
            chunk_path = self._get_chunk_path(chunk_meta)
            with open(chunk_path, "rb") as handle:
                handle.seek(local_start)
                payload = handle.read(local_end - local_start)
            if not payload:
                break
            parts.append(payload)
            start += len(payload)
            if start >= target_end:
                break

        self._position = start
        return b"".join(parts)

    def readinto(self, buffer) -> int:
        payload = self.read(len(buffer))
        size = len(payload)
        buffer[:size] = payload
        return size

    def _ensure_open(self) -> None:
        if self.closed:
            raise ValueError("I/O operation on closed file.")

    def _get_chunk_path(self, chunk_meta: dict) -> Path:
        future = asyncio.run_coroutine_threadsafe(
            self._file_manager.get_archive_chunk_cache_path(
                self._virtual_path,
                chunk_meta,
                file_meta=self._file_meta,
            ),
            self._loop,
        )
        return Path(future.result())


class _QueueBackedArchiveWriter:
    _SENTINEL = object()

    def __init__(self, *, max_pending_chunks: int = 8):
        self._queue: queue.Queue[object] = queue.Queue(maxsize=max(1, max_pending_chunks))
        self._error: Exception | None = None
        self._closed = False
        self._bytes_written = 0

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def tell(self) -> int:
        return self._bytes_written

    def flush(self) -> None:
        return None

    def write(self, data) -> int:
        if self._error is not None:
            raise self._error
        if self._closed:
            raise ValueError("Archive writer already closed")
        payload = bytes(data)
        if not payload:
            return 0
        self._queue.put(payload)
        self._bytes_written += len(payload)
        return len(payload)

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._queue.put(self._SENTINEL)

    @property
    def error(self) -> Exception | None:
        return self._error

    def is_sentinel(self, item: object) -> bool:
        return item is self._SENTINEL

    def abort(self, exc: Exception) -> None:
        self._error = exc
        if not self._closed:
            self._closed = True
            self._queue.put(self._SENTINEL)

    async def read_next(self):
        return await asyncio.to_thread(self._queue.get)


class ArchiveService:
    def __init__(self, file_manager):
        self._file_manager = file_manager
        self._lock = asyncio.Lock()
        self._jobs: dict[str, dict] = {}
        self._runtime_dir = Path(Config.STAGING_DIR) / "archives"
        self._runtime_dir.mkdir(parents=True, exist_ok=True)
        self._download_concurrency = 4
        self.refresh_settings()

    def refresh_settings(self) -> None:
        self._enabled = bool(getattr(Config, "ARCHIVE_ENABLED", True))
        self._max_source_bytes = max(64 * 1024 * 1024, int(getattr(Config, "ARCHIVE_MAX_SOURCE_MB", 4096)) * 1024 * 1024)
        self._max_extracted_bytes = max(128 * 1024 * 1024, int(getattr(Config, "ARCHIVE_MAX_EXTRACTED_MB", 8192)) * 1024 * 1024)
        self._max_entry_count = max(1, int(getattr(Config, "ARCHIVE_MAX_ENTRY_COUNT", 5000)))
        self._upload_concurrency = max(1, int(getattr(Config, "ARCHIVE_UPLOAD_CONCURRENCY", 2)))
        self._default_format = str(getattr(Config, "ARCHIVE_DEFAULT_FORMAT", "zip") or "zip").strip().lower()
        self._default_overwrite_mode = str(getattr(Config, "ARCHIVE_DEFAULT_OVERWRITE_MODE", "auto_rename") or "auto_rename").strip().lower()
        self._default_extract_mode = str(getattr(Config, "ARCHIVE_DEFAULT_EXTRACT_MODE", "new_folder") or "new_folder").strip().lower()
        self._allow_password_input = bool(getattr(Config, "ARCHIVE_ALLOW_PASSWORD_INPUT", True))
        self._streaming_compress_enabled = bool(getattr(Config, "ARCHIVE_STREAMING_COMPRESS_ENABLED", True))
        self._streaming_extract_enabled = bool(getattr(Config, "ARCHIVE_STREAMING_EXTRACT_ENABLED", True))
        self._meta_timeout_seconds = max(5.0, float(getattr(Config, "ARCHIVE_META_TIMEOUT_SECONDS", 20.0) or 20.0))
        self._tree_timeout_seconds = max(5.0, float(getattr(Config, "ARCHIVE_TREE_TIMEOUT_SECONDS", 45.0) or 45.0))
        self._materialize_timeout_seconds = max(10.0, float(getattr(Config, "ARCHIVE_MATERIALIZE_TIMEOUT_SECONDS", 120.0) or 120.0))
        self._streaming_compress_formats = _parse_streaming_formats(
            getattr(Config, "ARCHIVE_STREAMING_COMPRESS_FORMATS", "zip,tar.gz")
        )
        self._streaming_extract_formats = _parse_streaming_formats(
            getattr(Config, "ARCHIVE_STREAMING_EXTRACT_FORMATS", "zip,tar.gz,7z,rar")
        )
        self._streaming_extract_backend = str(
            getattr(Config, "ARCHIVE_STREAMING_EXTRACT_BACKEND", "bsdtar") or "bsdtar"
        ).strip()

    def _rar_backend(self) -> str:
        for candidate in ("unrar", "unar", "7zz", "7z", "bsdtar"):
            resolved = shutil.which(candidate)
            if resolved:
                return resolved
        return ""

    def _streaming_extract_backend_path(self) -> str:
        backend = str(self._streaming_extract_backend or "").strip() or "bsdtar"
        if os.path.sep in backend:
            return backend if os.path.exists(backend) else ""
        return shutil.which(backend) or ""

    def _effective_streaming_extract_formats(self) -> set[str]:
        if not self._streaming_extract_enabled:
            return set()
        backend_path = self._streaming_extract_backend_path()
        if not backend_path:
            return set()
        backend_name = Path(backend_path).name.lower()
        configured = set(self._streaming_extract_formats)
        if backend_name == "bsdtar":
            # In this host bsdtar can read zip/tar streams from stdin, but 7z/rar
            # require a seekable source and fail when fed by PIPE.
            return configured & {"zip", "tar.gz"}
        return configured

    def capabilities_payload(self) -> dict:
        rar_backend = self._rar_backend()
        streaming_extract_backend = self._streaming_extract_backend_path()
        seven_zip_available = py7zr is not None
        rar_available = bool(rarfile is not None and rar_backend)
        streaming_extract_formats = sorted(self._effective_streaming_extract_formats())
        extract_caps = {
            "zip": True,
            "tar.gz": True,
            "7z": seven_zip_available,
            "rar": rar_available,
        }
        for archive_format in streaming_extract_formats:
            extract_caps[archive_format] = True
        reasons = {
            "extract": {
                "7z": "" if extract_caps["7z"] else "Backend 7Z indisponível: py7zr não está instalado no ambiente atual.",
                "rar": "" if extract_caps["rar"] else (
                    "Backend RAR indisponível: rarfile não está instalado."
                    if rarfile is None
                    else "Backend RAR indisponível: nenhum extrator compatível (unrar, unar, 7zz, 7z, bsdtar) foi encontrado."
                ),
            },
            "compress": {
                "7z": "" if seven_zip_available else "Compactação 7Z indisponível: py7zr não está instalado no ambiente atual.",
                "rar": "Compactação RAR não é suportada pelo TCloud.",
            },
        }
        return {
            "enabled": self._enabled,
            "extract": extract_caps,
            "compress": {
                "zip": True,
                "tar.gz": True,
                "7z": seven_zip_available,
                "rar": False,
            },
            "reasons": reasons,
            "defaults": {
                "format": self._default_format,
                "overwrite_mode": self._default_overwrite_mode,
                "extract_mode": self._default_extract_mode,
                "allow_password_input": self._allow_password_input,
            },
            "limits": {
                "max_source_mb": int(self._max_source_bytes / 1024 / 1024),
                "max_extracted_mb": int(self._max_extracted_bytes / 1024 / 1024),
                "max_entry_count": self._max_entry_count,
                "upload_concurrency": self._upload_concurrency,
            },
            "backends": {
                "py7zr_installed": seven_zip_available,
                "rarfile_installed": rarfile is not None,
                "rar_backend_path": rar_backend,
                "streaming_compress_enabled": self._streaming_compress_enabled,
                "streaming_compress_formats": sorted(self._streaming_compress_formats),
                "streaming_extract_enabled": self._streaming_extract_enabled,
                "streaming_extract_backend_path": streaming_extract_backend,
                "streaming_extract_formats": streaming_extract_formats,
            },
        }

    def status_payload(self) -> dict:
        capabilities = self.capabilities_payload()
        jobs = self.list_jobs_sync()
        active_jobs = [job for job in jobs if job.get("status") in {"queued", "running"}]
        return {
            "enabled": capabilities["enabled"],
            "extract": capabilities["extract"],
            "compress": capabilities["compress"],
            "reasons": capabilities.get("reasons") or {},
            "backends": capabilities["backends"],
            "limits": capabilities["limits"],
            "active_job_count": len(active_jobs),
            "job_count": len(jobs),
        }

    def list_jobs_sync(self) -> list[dict]:
        items = []
        for job in self._jobs.values():
            items.append(self._serialize_job(job))
        items.sort(key=lambda item: item.get("created_at", ""), reverse=True)
        return items

    async def list_jobs(self) -> list[dict]:
        async with self._lock:
            return self.list_jobs_sync()

    async def get_job(self, job_id: str) -> dict | None:
        async with self._lock:
            job = self._jobs.get(job_id)
            return self._serialize_job(job) if job else None

    async def cancel_job(self, job_id: str) -> dict:
        async with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                raise KeyError(job_id)
            job["cancel_requested"] = True
            cancel_event = job.get("_cancel_event")
            if cancel_event:
                cancel_event.set()
            self._touch_job(job, message="Cancelamento solicitado.")
            return self._serialize_job(job)

    async def create_extract_job(
        self,
        *,
        archive_path: str,
        destination: str,
        extract_mode: str = "",
        overwrite_mode: str = "",
        password: str = "",
    ) -> dict:
        self._assert_enabled()
        job = self._new_job(
            job_type="extract",
            archive_path=_normalize_virtual_path(archive_path),
            destination=_normalize_virtual_path(destination),
            extract_mode=(extract_mode or self._default_extract_mode),
            overwrite_mode=(overwrite_mode or self._default_overwrite_mode),
            password=bool(password),
        )
        async with self._lock:
            self._jobs[job["id"]] = job
        job["_task"] = asyncio.create_task(self._run_extract_job(job, password=password or ""))
        return self._serialize_job(job)

    async def create_compress_job(
        self,
        *,
        source_paths: list[str],
        destination: str,
        archive_name: str,
        archive_format: str,
        compression_level: str = "normal",
        overwrite_mode: str = "",
        base_path: str | None = None,
    ) -> dict:
        self._assert_enabled()
        normalized_sources = [_normalize_virtual_path(path) for path in source_paths if str(path or "").strip()]
        if not normalized_sources:
            raise ArchiveValidationError("Selecione ao menos um arquivo ou pasta para compactar.")
        requested_format = str(archive_format or self._default_format).strip().lower()
        if requested_format not in {"zip", "7z", "tar.gz"}:
            raise ArchiveValidationError("Formato de compactação inválido.")

        archive_name = _sanitize_archive_name(archive_name, requested_format)
        job = self._new_job(
            job_type="compress",
            source_paths=normalized_sources,
            destination=_normalize_virtual_path(destination),
            archive_name=archive_name,
            archive_format=requested_format,
            compression_level=str(compression_level or "normal").strip().lower(),
            overwrite_mode=(overwrite_mode or self._default_overwrite_mode),
            base_path=_normalize_virtual_path(base_path or "/"),
        )
        async with self._lock:
            self._jobs[job["id"]] = job
        job["_task"] = asyncio.create_task(self._run_compress_job(job))
        return self._serialize_job(job)

    def _assert_enabled(self) -> None:
        if not self._enabled:
            raise ArchiveCapabilityError("O arquivamento está desabilitado nas configurações.")

    def _friendly_error_message_for_code(self, code: str, default_message: str) -> str:
        return {
            "archive_source_unavailable": "Falha ao compactar: arquivo indisponível para leitura no cache local.",
            "archive_source_not_found": "Falha ao compactar: arquivo não encontrado.",
            "archive_source_too_large": "Falha ao compactar: o arquivo excede o limite configurado.",
            "archive_stream_pipeline_failed": "Falha no arquivamento: erro interno no pipeline de streaming.",
            "archive_upload_failed": "Falha no arquivamento: não foi possível enviar o resultado final.",
            "archive_validation_failed": default_message,
            "archive_extract_unavailable": "Falha ao extrair: arquivo indisponível para leitura no cache local.",
            "archive_timeout": "Falha no arquivamento: a operação ficou sem resposta por tempo demais.",
        }.get(code, default_message)

    def _classify_job_error(self, exc: Exception | str, job: dict) -> tuple[str, str]:
        message = str(exc)
        archive_format = str(job.get("archive_format") or "").strip().lower()
        if isinstance(exc, ArchiveJobTimeoutError):
            return "archive_timeout", self._friendly_error_message_for_code("archive_timeout", message)
        if isinstance(exc, FileNotFoundError):
            return "archive_source_not_found", self._friendly_error_message_for_code("archive_source_not_found", message)
        if isinstance(exc, ArchiveValidationError):
            if "excede o limite" in message.lower():
                return "archive_source_too_large", self._friendly_error_message_for_code("archive_source_too_large", message)
            return "archive_validation_failed", self._friendly_error_message_for_code("archive_validation_failed", message)
        if "Arquivo sem cache disponível" in message or "indisponível para leitura" in message:
            code = "archive_extract_unavailable" if job.get("type") == "extract" else "archive_source_unavailable"
            return code, self._friendly_error_message_for_code(code, message)
        if "pipeline de streaming" in message.lower():
            return "archive_stream_pipeline_failed", self._friendly_error_message_for_code("archive_stream_pipeline_failed", message)
        if "não foi possível enviar" in message.lower() or "upload" in message.lower():
            return "archive_upload_failed", self._friendly_error_message_for_code("archive_upload_failed", message)
        if str(job.get("type") or "").strip().lower() == "compress" and self._is_streaming_compress_enabled_for_format(archive_format):
            return "archive_stream_pipeline_failed", self._friendly_error_message_for_code("archive_stream_pipeline_failed", message)
        if str(job.get("type") or "").strip().lower() == "extract" and self._is_streaming_extract_enabled_for_format(archive_format):
            return "archive_stream_pipeline_failed", self._friendly_error_message_for_code("archive_stream_pipeline_failed", message)
        return "archive_failed", message

    def _is_streaming_compress_enabled_for_format(self, archive_format: str) -> bool:
        return self._streaming_compress_enabled and archive_format in self._streaming_compress_formats

    def _is_streaming_extract_enabled_for_format(self, archive_format: str) -> bool:
        return archive_format in self._effective_streaming_extract_formats()

    def _is_seekable_stream_extract_enabled_for_format(self, archive_format: str) -> bool:
        return archive_format == "7z" and py7zr is not None

    def _uses_non_materializing_extract_backend(self, archive_format: str) -> bool:
        return (
            self._is_streaming_extract_enabled_for_format(archive_format)
            or self._is_seekable_stream_extract_enabled_for_format(archive_format)
        )

    def _extract_backend_name_for_format(self, archive_format: str) -> str:
        if self._is_streaming_extract_enabled_for_format(archive_format):
            return "bsdtar"
        if self._is_seekable_stream_extract_enabled_for_format(archive_format):
            return "py7zr-seekable"
        return "legacy"

    def _serialize_job(self, job: dict | None) -> dict | None:
        if not job:
            return None
        progress = dict(job.get("progress") or {})
        return {
            "id": job["id"],
            "type": job["type"],
            "status": job["status"],
            "archive_path": job.get("archive_path", ""),
            "archive_name": job.get("archive_name", ""),
            "archive_format": job.get("archive_format", ""),
            "source_paths": list(job.get("source_paths") or []),
            "destination": job.get("destination", ""),
            "output_path": job.get("output_path", ""),
            "extract_mode": job.get("extract_mode", ""),
            "overwrite_mode": job.get("overwrite_mode", ""),
            "compression_level": job.get("compression_level", ""),
            "message": job.get("message", ""),
            "progress": progress,
            "warnings": list(job.get("warnings") or []),
            "error": job.get("error", ""),
            "error_code": job.get("error_code", ""),
            "error_message": job.get("error_message", ""),
            "failed_stage": job.get("failed_stage", ""),
            "last_active_stage": job.get("last_active_stage", ""),
            "summary": dict(job.get("summary") or {}),
            "cancel_requested": bool(job.get("cancel_requested")),
            "created_at": job.get("created_at", ""),
            "updated_at": job.get("updated_at", ""),
            "started_at": job.get("started_at", ""),
            "finished_at": job.get("finished_at", ""),
            "revision": int(job.get("_revision") or 0),
            "terminal_ready": self._job_terminal_ready(job, progress=progress),
        }

    def _new_job(self, *, job_type: str, **payload) -> dict:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return {
            "id": f"archive_{uuid.uuid4().hex[:12]}",
            "type": job_type,
            "status": "queued",
            "message": "Aguardando execução...",
            "warnings": [],
            "error": "",
            "error_code": "",
            "error_message": "",
            "failed_stage": "",
            "last_active_stage": "",
            "summary": {},
            "progress": {
                "stage": "queued",
                "stage_label": "Na fila",
                "current": 0,
                "total": 0,
                "percent": 0,
                "overall_current": 0,
                "overall_total": 100,
                "overall_percent": 0,
                "current_file": "",
                "indeterminate": False,
                "unit": "steps",
                "detail": "",
                "bytes_done": 0,
                "bytes_total": 0,
                "chunks_done": 0,
                "chunks_total": 0,
                "heartbeat_at": now,
            },
            "cancel_requested": False,
            "created_at": now,
            "updated_at": now,
            "started_at": "",
            "finished_at": "",
            "_revision": 0,
            "_task": None,
            "_cancel_event": asyncio.Event(),
            "_last_progress_monotonic": time.monotonic(),
            **payload,
        }

    def _stage_label(self, job: dict, stage: str | None) -> str:
        stage_name = str(stage or "").strip().lower()
        job_type = str(job.get("type") or "").strip().lower()
        if stage_name == "queued":
            return "Na fila"
        if stage_name == "listing":
            return "Preparando arquivos..."
        if stage_name == "downloading":
            return "Baixando partes da nuvem..."
        if stage_name == "extracting":
            return "Extraindo arquivos..."
        if stage_name == "compressing":
            return "Compactando..."
        if stage_name == "uploading":
            return "Salvando no diretório..." if job_type == "extract" else "Fazendo upload para a nuvem..."
        if stage_name == "done":
            return "Concluído"
        if stage_name == "error":
            return "Erro"
        if stage_name == "canceled":
            return "Cancelado"
        return ""

    def _compute_overall_percent(self, job: dict) -> int:
        progress = job.get("progress") or {}
        stage = str(progress.get("stage") or "").strip().lower()
        if stage == "done":
            return 100

        job_type = str(job.get("type") or "").strip().lower()
        stage_order = _ARCHIVE_STAGE_ORDER.get(job_type, ())
        stage_weights = _ARCHIVE_STAGE_WEIGHTS.get(job_type, {})

        if not stage_order or stage not in stage_weights:
            return int(max(0, min(100, int(progress.get("percent") or 0))))

        completed_weight = 0
        for stage_name in stage_order:
            if stage_name == stage:
                break
            completed_weight += int(stage_weights.get(stage_name) or 0)

        local_percent = max(0, min(100, int(progress.get("percent") or 0)))
        stage_weight = int(stage_weights.get(stage) or 0)
        overall = completed_weight + ((stage_weight * local_percent) / 100.0)

        if str(job.get("status") or "") in {"queued", "running"}:
            overall = min(overall, 99)
        return int(max(0, min(100, round(overall))))

    def _job_terminal_ready(self, job: dict, *, progress: dict | None = None) -> bool:
        status = str(job.get("status") or "").strip().lower()
        if status not in {"done", "error", "canceled"}:
            return False

        if not str(job.get("finished_at") or "").strip():
            return False

        progress_payload = progress if progress is not None else dict(job.get("progress") or {})
        stage = str(progress_payload.get("stage") or "").strip().lower()
        expected_stage = status
        if stage != expected_stage:
            return False

        if status == "done" and str(job.get("type") or "").strip().lower() == "compress":
            return bool(str(job.get("output_path") or "").strip())
        return True

    def _touch_job(
        self,
        job: dict,
        *,
        message: str | None = None,
        stage: str | None = None,
        current: int | None = None,
        total: int | None = None,
        current_file: str | None = None,
        indeterminate: bool | None = None,
        unit: str | None = None,
        detail: str | None = None,
        bytes_done: int | None = None,
        bytes_total: int | None = None,
        chunks_done: int | None = None,
        chunks_total: int | None = None,
    ) -> None:
        if message is not None:
            job["message"] = message
        if stage is not None:
            job["progress"]["stage"] = stage
            if stage not in {"queued", "error", "done", "canceled"}:
                job["last_active_stage"] = stage
        if current is not None:
            job["progress"]["current"] = current
        if total is not None:
            job["progress"]["total"] = total
        if current_file is not None:
            job["progress"]["current_file"] = current_file
        if indeterminate is not None:
            job["progress"]["indeterminate"] = bool(indeterminate)
        if unit is not None:
            job["progress"]["unit"] = unit
        if detail is not None:
            job["progress"]["detail"] = detail
        total_value = int(job["progress"].get("total") or 0)
        current_value = int(job["progress"].get("current") or 0)
        job["progress"]["percent"] = int((current_value / total_value) * 100) if total_value > 0 else 0
        progress_unit = str(job["progress"].get("unit") or "")
        if bytes_done is not None:
            job["progress"]["bytes_done"] = max(0, int(bytes_done))
        elif progress_unit == "bytes":
            job["progress"]["bytes_done"] = max(0, current_value)
        elif stage is not None or unit is not None:
            job["progress"]["bytes_done"] = 0

        if bytes_total is not None:
            job["progress"]["bytes_total"] = max(0, int(bytes_total))
        elif progress_unit == "bytes":
            job["progress"]["bytes_total"] = max(0, total_value)
        elif stage is not None or unit is not None:
            job["progress"]["bytes_total"] = 0

        if chunks_done is not None:
            job["progress"]["chunks_done"] = max(0, int(chunks_done))
        elif progress_unit == "chunks":
            job["progress"]["chunks_done"] = max(0, current_value)
        elif stage is not None or unit is not None:
            job["progress"]["chunks_done"] = 0

        if chunks_total is not None:
            job["progress"]["chunks_total"] = max(0, int(chunks_total))
        elif progress_unit == "chunks":
            job["progress"]["chunks_total"] = max(0, total_value)
        elif stage is not None or unit is not None:
            job["progress"]["chunks_total"] = 0

        stage_name = str(job["progress"].get("stage") or "")
        job["progress"]["stage_label"] = self._stage_label(job, stage_name)
        overall_percent = self._compute_overall_percent(job)
        job["progress"]["overall_percent"] = overall_percent
        job["progress"]["overall_current"] = overall_percent
        job["progress"]["overall_total"] = 100
        heartbeat_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        job["progress"]["heartbeat_at"] = heartbeat_at
        job["updated_at"] = heartbeat_at
        job["_revision"] = int(job.get("_revision") or 0) + 1
        job["_last_progress_monotonic"] = time.monotonic()

    async def _await_archive_step(self, awaitable, *, timeout_seconds: float, timeout_message: str):
        if timeout_seconds <= 0:
            return await awaitable
        try:
            return await asyncio.wait_for(awaitable, timeout=timeout_seconds)
        except asyncio.TimeoutError as exc:
            raise ArchiveJobTimeoutError(timeout_message) from exc

    def _set_job_phase(
        self,
        job: dict,
        *,
        stage: str,
        message: str,
        current: int = 0,
        total: int = 0,
        current_file: str = "",
        indeterminate: bool = False,
        unit: str = "steps",
        detail: str = "",
        bytes_done: int | None = None,
        bytes_total: int | None = None,
        chunks_done: int | None = None,
        chunks_total: int | None = None,
    ) -> None:
        self._touch_job(
            job,
            message=message,
            stage=stage,
            current=current,
            total=total,
            current_file=current_file,
            indeterminate=indeterminate,
            unit=unit,
            detail=detail,
            bytes_done=bytes_done,
            bytes_total=bytes_total,
            chunks_done=chunks_done,
            chunks_total=chunks_total,
        )

    def _mark_job_running(self, job: dict, message: str) -> None:
        if job["status"] == "queued":
            job["started_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        job["status"] = "running"
        self._touch_job(job, message=message)

    def _mark_job_done(self, job: dict, *, message: str, summary: dict | None = None, output_path: str = "") -> None:
        job["status"] = "done"
        job["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if summary is not None:
            job["summary"] = summary
        if output_path:
            job["output_path"] = output_path
        self._set_job_phase(
            job,
            stage="done",
            message=message,
            current=1,
            total=1,
            current_file="",
            indeterminate=False,
            unit="items",
            detail="Operação concluída",
        )

    def _mark_job_error(self, job: dict, error: Exception | str) -> None:
        code, friendly_message = self._classify_job_error(error if isinstance(error, Exception) else RuntimeError(str(error)), job)
        message = str(error)
        previous_overall = int(job.get("progress", {}).get("overall_percent") or 0)
        job["status"] = "error"
        job["error"] = message
        job["error_code"] = code
        job["error_message"] = friendly_message
        job["failed_stage"] = str(job.get("progress", {}).get("stage") or job.get("last_active_stage") or "")
        job["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._set_job_phase(
            job,
            stage="error",
            message=message,
            current=0,
            total=0,
            current_file="",
            indeterminate=False,
            unit="items",
            detail=friendly_message,
        )
        job["progress"]["overall_percent"] = max(previous_overall, int(job["progress"].get("overall_percent") or 0))
        job["progress"]["overall_current"] = job["progress"]["overall_percent"]

    def _mark_job_canceled(self, job: dict, message: str = "Job cancelado.") -> None:
        previous_overall = int(job.get("progress", {}).get("overall_percent") or 0)
        job["status"] = "canceled"
        job["failed_stage"] = str(job.get("progress", {}).get("stage") or job.get("last_active_stage") or job.get("failed_stage") or "")
        job["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._set_job_phase(
            job,
            stage="canceled",
            message=message,
            current=0,
            total=0,
            current_file="",
            indeterminate=False,
            unit="items",
            detail="Operação cancelada",
        )
        job["progress"]["overall_percent"] = max(previous_overall, int(job["progress"].get("overall_percent") or 0))
        job["progress"]["overall_current"] = job["progress"]["overall_percent"]

    def _ensure_not_canceled(self, job: dict) -> None:
        if job.get("cancel_requested") or job["_cancel_event"].is_set():
            raise ArchiveJobCancelled("Operação cancelada pelo usuário.")

    async def _run_extract_job(self, job: dict, *, password: str) -> None:
        try:
            running_loop = asyncio.get_running_loop()
            archive_meta = await self._await_archive_step(
                self._file_manager.get_file_meta(job["archive_path"]),
                timeout_seconds=self._meta_timeout_seconds,
                timeout_message=f"A leitura dos metadados de {Path(job['archive_path']).name or job['archive_path']} demorou além do limite configurado.",
            )
            if not archive_meta:
                raise FileNotFoundError(f"Arquivo não encontrado: {job['archive_path']}")
            archive_size = int(archive_meta.get("size") or 0)
            if archive_size > self._max_source_bytes:
                raise ArchiveValidationError("O arquivo compactado excede o limite configurado.")

            archive_name = archive_meta.get("filename") or Path(job["archive_path"]).name
            archive_format = _detect_archive_format(archive_name)
            self._assert_extract_supported(archive_format)

            destination_root = await self._resolve_extract_destination(job, archive_name)
            with tempfile.TemporaryDirectory(prefix="extract_", dir=str(self._runtime_dir)) as temp_dir:
                extract_root = Path(temp_dir) / "payload"
                extract_root.mkdir(parents=True, exist_ok=True)
                self._mark_job_running(job, f"Preparando {archive_name} para extração...")
                if self._is_streaming_extract_enabled_for_format(archive_format):
                    await self._run_streaming_extract_job(
                        job,
                        archive_meta=archive_meta,
                        archive_name=archive_name,
                        archive_format=archive_format,
                        extract_root=extract_root,
                        password=password,
                    )
                elif self._is_seekable_stream_extract_enabled_for_format(archive_format):
                    self._touch_job(
                        job,
                        stage="extracting",
                        current=0,
                        total=archive_size,
                        message=f"Extraindo {archive_name}...",
                        current_file=archive_name,
                        unit="bytes",
                        detail="Lendo partes sob demanda...",
                        indeterminate=archive_size <= 0,
                        bytes_done=0,
                        bytes_total=archive_size,
                    )
                    await asyncio.to_thread(
                        self._extract_archive_from_seekable_source,
                        job["archive_path"],
                        archive_meta,
                        archive_name,
                        extract_root,
                        archive_format,
                        password,
                        job,
                        running_loop,
                    )
                else:
                    archive_local_path = Path(temp_dir) / archive_name

                    def _extract_materialize_progress(current: int, total: int) -> None:
                        total_bytes = max(0, int(total))
                        current_bytes = max(0, min(int(current), total_bytes or int(current)))
                        self._touch_job(
                            job,
                            stage="downloading",
                            current=current_bytes,
                            total=total_bytes,
                            message=f"Baixando partes da nuvem: {archive_name}",
                            current_file=archive_name,
                            unit="bytes",
                            detail="Baixando partes da nuvem...",
                            indeterminate=total_bytes <= 0,
                            bytes_done=current_bytes,
                            bytes_total=total_bytes,
                        )

                    self._touch_job(
                        job,
                        stage="downloading",
                        current=0,
                        total=archive_size,
                        message=f"Baixando partes da nuvem: {archive_name}",
                        current_file=archive_name,
                        unit="bytes",
                        detail="Baixando partes da nuvem...",
                        indeterminate=archive_size <= 0,
                        bytes_done=0,
                        bytes_total=archive_size,
                    )
                    await self._await_archive_step(
                        self._file_manager.materialize_cached_file_for_read(
                            job["archive_path"],
                            archive_local_path,
                            file_meta=archive_meta,
                            progress_callback=_extract_materialize_progress,
                        ),
                        timeout_seconds=self._materialize_timeout_seconds,
                        timeout_message=f"A preparação de {archive_name} para extração demorou além do limite configurado.",
                    )
                    self._touch_job(
                        job,
                        stage="downloading",
                        current=archive_size,
                        total=archive_size,
                        message=f"{archive_name} pronto para extração.",
                        current_file=archive_name,
                        unit="bytes",
                        detail="Origem pronta",
                        indeterminate=False,
                        bytes_done=archive_size,
                        bytes_total=archive_size,
                    )

                    self._touch_job(
                        job,
                        stage="extracting",
                        current=0,
                        total=0,
                        message=f"Extraindo {archive_name}...",
                        current_file=archive_name,
                        indeterminate=True,
                        detail=f"Extraindo {archive_name}",
                    )
                    await asyncio.to_thread(
                        self._extract_archive_to_directory,
                        archive_local_path,
                        extract_root,
                        archive_format,
                        password,
                        job,
                    )

                upload_result = await self._upload_extracted_tree(
                    job,
                    extract_root,
                    destination_root,
                    job.get("overwrite_mode") or self._default_overwrite_mode,
                )
                reveal_paths = list(upload_result.get("reveal_paths") or [])
                summary = {
                    "uploaded_files": int(upload_result.get("uploaded_files") or 0),
                    "destination_root": destination_root,
                    "reveal_paths": reveal_paths,
                    "warnings": len(job.get("warnings") or []),
                    "streaming": self._uses_non_materializing_extract_backend(archive_format),
                    "extract_backend": self._extract_backend_name_for_format(archive_format),
                }
                resolved_output_path = reveal_paths[0] if len(reveal_paths) == 1 else destination_root
                self._mark_job_done(job, message="Extração concluída.", summary=summary, output_path=resolved_output_path)
        except ArchiveJobCancelled:
            self._mark_job_canceled(job)
        except asyncio.CancelledError as exc:
            logger.warning(
                "Archive extract job canceled by asyncio: stage=%s archive=%s error=%s",
                job.get("progress", {}).get("stage") or job.get("last_active_stage") or "",
                job.get("archive_path") or "",
                exc,
            )
            self._mark_job_canceled(job, message="Extração cancelada.")
        except Exception as exc:
            logger.error("Archive extract job failed: %s", exc, exc_info=True)
            self._mark_job_error(job, exc)
        except BaseException as exc:
            logger.error("Archive extract job crashed: %s", exc, exc_info=True)
            self._mark_job_error(job, exc)

    async def _run_compress_job(self, job: dict) -> None:
        try:
            archive_format = str(job["archive_format"])
            archive_name = str(job.get("archive_name") or "arquivo")
            self._assert_compress_supported(archive_format)
            archive_manifest = await self._collect_archive_entries(
                job,
                source_paths=job["source_paths"],
                base_path=job.get("base_path") or "/",
            )
            if not archive_manifest["files"] and not archive_manifest["directories"]:
                raise ArchiveValidationError("Nenhum arquivo ou diretório foi encontrado para compactação.")

            target_path = await self._resolve_output_archive_path(
                destination_dir=job["destination"],
                archive_name=job["archive_name"],
                overwrite_mode=job.get("overwrite_mode") or self._default_overwrite_mode,
            )

            if self._is_streaming_compress_enabled_for_format(archive_format):
                summary = await self._run_streaming_compress_job(
                    job,
                    archive_manifest,
                    target_path=target_path,
                )
            else:
                with tempfile.TemporaryDirectory(prefix="compress_", dir=str(self._runtime_dir)) as temp_dir:
                    temp_root = Path(temp_dir)
                    staging_root = temp_root / "staging"
                    staging_root.mkdir(parents=True, exist_ok=True)
                    output_file = temp_root / job["archive_name"]

                    collected_files = await self._materialize_collected_entries(job, archive_manifest, staging_root)
                    self._touch_job(
                        job,
                        stage="compressing",
                        current=0,
                        total=collected_files,
                        message=f"Compactando {archive_name}...",
                        current_file="",
                        unit="items",
                        detail=f"Compactando {archive_name}",
                    )
                    await asyncio.to_thread(
                        self._compress_staging_tree,
                        staging_root,
                        output_file,
                        archive_format,
                        job.get("compression_level") or "normal",
                        job,
                    )

                    self._touch_job(
                        job,
                        stage="uploading",
                        current=0,
                        total=max(0, output_file.stat().st_size),
                        message=f"Enviando {archive_name} para o TCloud...",
                        current_file=archive_name,
                        unit="bytes",
                        detail="Fazendo upload para a nuvem...",
                        indeterminate=output_file.stat().st_size <= 0,
                        bytes_done=0,
                        bytes_total=max(0, output_file.stat().st_size),
                    )
                    def _staged_upload_progress(current: int, total: int) -> None:
                        total_bytes = max(0, int(total))
                        current_bytes = max(0, min(int(current), total_bytes or int(current)))
                        self._touch_job(
                            job,
                            stage="uploading",
                            current=current_bytes,
                            total=total_bytes,
                            message=f"Enviando {archive_name} para o TCloud...",
                            current_file=archive_name,
                            unit="bytes",
                            detail="Fazendo upload para a nuvem...",
                            indeterminate=total_bytes <= 0,
                            bytes_done=current_bytes,
                            bytes_total=total_bytes,
                        )
                    await self._file_manager.upload_file(output_file, target_path, progress_callback=_staged_upload_progress)
                    self._touch_job(
                        job,
                        stage="uploading",
                        current=max(0, output_file.stat().st_size),
                        total=max(0, output_file.stat().st_size),
                        message=f"{archive_name} enviado.",
                        current_file=archive_name,
                        unit="bytes",
                        detail="Upload concluído",
                        indeterminate=False,
                        bytes_done=max(0, output_file.stat().st_size),
                        bytes_total=max(0, output_file.stat().st_size),
                    )
                    summary = {
                        "source_count": len(job["source_paths"]),
                        "materialized_files": collected_files,
                        "archive_format": archive_format,
                        "streaming": False,
                        "directory_count": len(archive_manifest["directories"]),
                        "file_count": archive_manifest["file_count"],
                        "total_source_bytes": archive_manifest["total_bytes"],
                    }

            self._mark_job_done(job, message="Compactação concluída.", summary=summary, output_path=target_path)
        except ArchiveJobCancelled:
            self._mark_job_canceled(job)
        except asyncio.CancelledError as exc:
            logger.warning(
                "Archive compress job canceled by asyncio: stage=%s target=%s error=%s",
                job.get("progress", {}).get("stage") or job.get("last_active_stage") or "",
                job.get("archive_name") or "",
                exc,
            )
            self._mark_job_canceled(job, message="Compactação cancelada.")
        except Exception as exc:
            logger.error("Archive compress job failed: %s", exc, exc_info=True)
            self._mark_job_error(job, exc)
        except BaseException as exc:
            logger.error("Archive compress job crashed: %s", exc, exc_info=True)
            self._mark_job_error(job, exc)

    def _assert_extract_supported(self, archive_format: str) -> None:
        capability_payload = self.capabilities_payload()
        caps = capability_payload["extract"]
        if not caps.get(archive_format):
            reason = str((capability_payload.get("reasons") or {}).get("extract", {}).get(archive_format) or "").strip()
            suffix = f" {reason}" if reason else ""
            raise ArchiveCapabilityError(f"Extração de {archive_format} indisponível neste ambiente.{suffix}")

    def _assert_compress_supported(self, archive_format: str) -> None:
        capability_payload = self.capabilities_payload()
        caps = capability_payload["compress"]
        if not caps.get(archive_format):
            reason = str((capability_payload.get("reasons") or {}).get("compress", {}).get(archive_format) or "").strip()
            suffix = f" {reason}" if reason else ""
            raise ArchiveCapabilityError(f"Compactação em {archive_format} indisponível neste ambiente.{suffix}")

    async def _resolve_extract_destination(self, job: dict, archive_name: str) -> str:
        self._ensure_not_canceled(job)
        destination = _normalize_virtual_path(job.get("destination"))
        extract_mode = str(job.get("extract_mode") or self._default_extract_mode).strip().lower()
        overwrite_mode = str(job.get("overwrite_mode") or self._default_overwrite_mode).strip().lower()

        if extract_mode == "new_folder":
            base_name = _strip_archive_suffix(archive_name)
            target_root = _join_virtual_path(destination, base_name)
            target_root = await self._resolve_root_directory_path(target_root, overwrite_mode)
            await self._ensure_directory_path(target_root)
            return target_root

        await self._ensure_directory_path(destination)
        return destination

    async def _resolve_root_directory_path(self, path: str, overwrite_mode: str) -> str:
        normalized = _normalize_virtual_path(path)
        if not await self._file_manager.exists(normalized):
            return normalized
        if overwrite_mode == "replace":
            if await self._file_manager.is_file(normalized):
                await self._file_manager.delete_file(normalized)
            else:
                await self._file_manager.delete_directory_recursive(normalized)
            return normalized
        if overwrite_mode == "skip":
            raise ArchiveValidationError(f"O destino já existe: {normalized}")
        return await self._next_available_path(normalized)

    async def _resolve_output_archive_path(self, *, destination_dir: str, archive_name: str, overwrite_mode: str) -> str:
        destination_dir = _normalize_virtual_path(destination_dir)
        await self._ensure_directory_path(destination_dir)
        candidate = _join_virtual_path(destination_dir, archive_name)
        if not await self._file_manager.exists(candidate):
            return candidate
        if overwrite_mode == "replace":
            if await self._file_manager.is_file(candidate):
                await self._file_manager.delete_file(candidate)
            else:
                await self._file_manager.delete_directory_recursive(candidate)
            return candidate
        if overwrite_mode == "skip":
            raise ArchiveValidationError(f"O arquivo de saída já existe: {candidate}")
        return await self._next_available_path(candidate)

    async def _next_available_path(self, path: str) -> str:
        base = PurePosixPath(path)
        suffixes = list(base.suffixes)
        suffix = "".join(suffixes)
        stem = base.name[: -len(suffix)] if suffix else base.name
        parent = str(base.parent)
        if parent in {"", "."}:
            parent = "/"
        counter = 1
        while True:
            label = " (cópia)" if counter == 1 else f" (cópia {counter})"
            candidate = _join_virtual_path(parent, f"{stem}{label}{suffix}")
            if not await self._file_manager.exists(candidate):
                return candidate
            counter += 1

    async def _ensure_directory_path(self, path: str) -> None:
        normalized = _normalize_virtual_path(path)
        if normalized == "/":
            return
        current = "/"
        for part in PurePosixPath(normalized).parts[1:]:
            current = _join_virtual_path(current, part)
            if not await self._file_manager.exists(current):
                await self._file_manager.create_directory(current)
            elif await self._file_manager.is_file(current):
                raise ArchiveValidationError(f"Conflito de diretório no destino: {current}")

    async def _collect_archive_entries(self, job: dict, *, source_paths: list[str], base_path: str) -> dict:
        file_entries: list[dict] = []
        directory_entries: set[str] = set()
        top_level_targets: set[str] = set()

        self._mark_job_running(job, "Listando arquivos...")
        self._touch_job(
            job,
            stage="listing",
            current=0,
            total=len(source_paths),
            unit="items",
            detail="Varredura da seleção",
        )

        for idx, source_path in enumerate(source_paths, start=1):
            self._ensure_not_canceled(job)
            relative_target = _relative_path_for_archive(source_path, base_path)
            relative_text = relative_target.as_posix()
            if not relative_text.strip("."):
                raise ArchiveValidationError("Seleção inválida para compactação.")
            if relative_text in top_level_targets:
                raise ArchiveValidationError(f"Conflito de nomes ao compactar: {relative_text}")
            top_level_targets.add(relative_text)

            file_meta = await self._await_archive_step(
                self._file_manager.get_file_meta(source_path),
                timeout_seconds=self._meta_timeout_seconds,
                timeout_message=f"A leitura dos metadados de {Path(source_path).name or source_path} demorou além do limite configurado.",
            )
            if file_meta:
                file_entries.append({
                    "kind": "file",
                    "virtual_path": source_path,
                    "file_meta": file_meta,
                    "archive_path": relative_text,
                    "size": int(file_meta.get("size") or 0),
                })
                self._touch_job(
                    job,
                    stage="listing",
                    current=idx,
                    total=len(source_paths),
                    message=f"Listando: {Path(source_path).name}",
                    unit="items",
                    detail=f"{len(file_entries)} arquivo(s) coletados",
                )
                continue

            if not await self._file_manager.is_directory(source_path):
                raise FileNotFoundError(f"Item não encontrado: {source_path}")

            directory_entries.add(relative_text)
            tree = await self._await_archive_step(
                self._file_manager._db.list_directory_tree(source_path),
                timeout_seconds=self._tree_timeout_seconds,
                timeout_message=f"A listagem da pasta {Path(source_path).name or source_path} demorou além do limite configurado.",
            )
            for directory in sorted(tree.get("directories", []), key=lambda item: item.get("path", "").count("/")):
                original_path = directory.get("path") or ""
                rel_child = PurePosixPath(original_path).relative_to(PurePosixPath(_normalize_virtual_path(source_path)))
                directory_entries.add((relative_target / rel_child).as_posix())
            for child_file in tree.get("files", []):
                child_path = child_file.get("path") or ""
                rel_child = PurePosixPath(child_path).relative_to(PurePosixPath(_normalize_virtual_path(source_path)))
                file_entries.append({
                    "kind": "file",
                    "virtual_path": child_path,
                    "file_meta": child_file,
                    "archive_path": (relative_target / rel_child).as_posix(),
                    "size": int(child_file.get("size") or 0),
                })
            self._touch_job(
                job,
                stage="listing",
                current=idx,
                total=len(source_paths),
                message=f"Listando: {Path(source_path).name} ({len(file_entries)} arquivos)",
                unit="items",
                detail=f"{len(directory_entries)} diretório(s), {len(file_entries)} arquivo(s)",
            )

        return {
            "files": sorted(file_entries, key=lambda item: item["archive_path"]),
            "directories": sorted(directory_entries),
            "total_bytes": sum(int(item.get("size") or 0) for item in file_entries),
            "file_count": len(file_entries),
        }

    def _start_stream_entry_reader(self, loop, job: dict, entry: dict, progress_state: dict) -> tuple[_QueueBackedSyncReader, object]:
        reader = _QueueBackedSyncReader()
        file_name = Path(entry["virtual_path"]).name

        async def _producer():
            async for chunk in self._file_manager.iter_file_chunks_for_archive(
                entry["virtual_path"],
                entry["file_meta"],
            ):
                self._ensure_not_canceled(job)
                progress_state["current"] += len(chunk)
                upload_started = bool(progress_state.get("uploading_started"))
                phase_message = f"Enviando {file_name}..." if upload_started else f"Compactando {file_name}..."
                phase_detail = f"Enviando fluxo contínuo de {file_name}" if upload_started else f"Compactando {file_name}"
                self._set_job_phase(
                    job,
                    stage="uploading" if upload_started else "compressing",
                    message=phase_message,
                    current=progress_state["current"],
                    total=progress_state["total"],
                    current_file=file_name,
                    unit="bytes",
                    detail=phase_detail,
                    indeterminate=progress_state["total"] <= 0,
                )
                yield chunk

        producer_future = asyncio.run_coroutine_threadsafe(reader.pump(_producer()), loop)
        return reader, producer_future

    def _run_streaming_zip_archive(self, archive_manifest: dict, writer: _QueueBackedArchiveWriter, job: dict, compression_level: str, loop, progress_state: dict) -> None:
        compresslevel = _compression_level_for_zip(compression_level)
        compression_type = zipfile.ZIP_STORED if compresslevel == 0 else zipfile.ZIP_DEFLATED
        with zipfile.ZipFile(writer, "w", compression=compression_type, compresslevel=compresslevel) as archive:
            for directory in archive_manifest["directories"]:
                self._ensure_not_canceled(job)
                normalized_directory = str(directory or "").rstrip("/")
                if not normalized_directory:
                    continue
                archive.writestr(zipfile.ZipInfo(f"{normalized_directory}/"), b"")
            for entry in archive_manifest["files"]:
                self._ensure_not_canceled(job)
                zip_info = zipfile.ZipInfo(entry["archive_path"])
                zip_info.compress_type = compression_type
                reader, producer_future = self._start_stream_entry_reader(loop, job, entry, progress_state)
                try:
                    with archive.open(zip_info, "w", force_zip64=True) as archive_handle:
                        shutil.copyfileobj(reader, archive_handle, length=1024 * 1024)
                    producer_future.result()
                except Exception:
                    producer_future.cancel()
                    raise

    def _run_streaming_tar_archive(self, archive_manifest: dict, writer: _QueueBackedArchiveWriter, job: dict, compression_level: str, loop, progress_state: dict) -> None:
        compresslevel = _compression_level_for_tar(compression_level)
        with gzip.GzipFile(fileobj=writer, mode="wb", compresslevel=compresslevel, mtime=0) as gzip_writer:
            with tarfile.open(fileobj=gzip_writer, mode="w|") as archive:
                current_mtime = int(time.time())
                for directory in archive_manifest["directories"]:
                    self._ensure_not_canceled(job)
                    normalized_directory = str(directory or "").rstrip("/")
                    if not normalized_directory:
                        continue
                    info = tarfile.TarInfo(f"{normalized_directory}/")
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    info.mtime = current_mtime
                    archive.addfile(info)
                for entry in archive_manifest["files"]:
                    self._ensure_not_canceled(job)
                    info = tarfile.TarInfo(entry["archive_path"])
                    info.size = int(entry.get("size") or 0)
                    info.mode = 0o644
                    info.mtime = current_mtime
                    reader, producer_future = self._start_stream_entry_reader(loop, job, entry, progress_state)
                    try:
                        archive.addfile(info, reader)
                        producer_future.result()
                    except Exception:
                        producer_future.cancel()
                        raise

    async def _consume_archive_upload_stream(self, writer: _QueueBackedArchiveWriter, *, job: dict, target_path: str, archive_name: str, progress_state: dict | None = None) -> dict:
        upload_id = f"archive_stream_{job['id']}"
        runtime_dir_missing = not self._runtime_dir.exists()
        self._runtime_dir.mkdir(parents=True, exist_ok=True)
        if runtime_dir_missing:
            logger.warning("Archive runtime dir recreated before streaming upload: %s", self._runtime_dir)
        metadata_path = self._runtime_dir / f"{upload_id}.bin"
        chunk_index = 0
        buffer = bytearray()
        bytes_buffered = 0
        upload_stage_announced = False
        try:
            while True:
                item = await writer.read_next()
                if writer.is_sentinel(item):
                    break
                buffer.extend(item)
                bytes_buffered += len(item)
                if not upload_stage_announced:
                    upload_stage_announced = True
                    if progress_state is not None:
                        progress_state["uploading_started"] = True
                    self._touch_job(
                        job,
                        stage="uploading",
                        current=0,
                        total=0,
                        current_file=archive_name,
                        unit="bytes",
                        indeterminate=True,
                        detail=f"Enviando {archive_name} em streaming",
                        message=f"Enviando {archive_name} em streaming...",
                    )
                while len(buffer) >= Config.CHUNK_SIZE_BYTES:
                    payload = bytes(buffer[:Config.CHUNK_SIZE_BYTES])
                    del buffer[:Config.CHUNK_SIZE_BYTES]
                    await self._file_manager.handle_stream_chunk(
                        upload_id,
                        chunk_index,
                        payload,
                        metadata_path,
                        filename=archive_name,
                    )
                    chunk_index += 1
                    self._touch_job(
                        job,
                        stage="uploading",
                        current=bytes_buffered,
                        total=0,
                        current_file=archive_name,
                        unit="bytes",
                        indeterminate=True,
                        detail=f"{chunk_index} chunk(s) enviados em streaming",
                        message=f"Enviando {archive_name} em streaming...",
                    )

            if writer.error is not None:
                raise writer.error

            if buffer:
                await self._file_manager.handle_stream_chunk(
                    upload_id,
                    chunk_index,
                    bytes(buffer),
                    metadata_path,
                    filename=archive_name,
                )
                chunk_index += 1
                self._touch_job(
                    job,
                    stage="uploading",
                    current=bytes_buffered,
                    total=0,
                    current_file=archive_name,
                    unit="bytes",
                    indeterminate=True,
                    detail=f"{chunk_index} chunk(s) enviados em streaming",
                    message=f"Enviando {archive_name} em streaming...",
                )

            self._set_job_phase(
                job,
                stage="uploading",
                message=f"Enviando {archive_name} em streaming...",
                current=0,
                total=0,
                current_file=archive_name,
                unit="bytes",
                indeterminate=True,
                detail=f"Finalizando upload de {archive_name}",
            )

            async def _progress(current: int, total: int) -> None:
                self._set_job_phase(
                    job,
                    stage="uploading",
                    message=f"Enviando {archive_name}...",
                    current=current,
                    total=total,
                    current_file=archive_name,
                    unit="bytes",
                    indeterminate=False,
                    detail=f"Enviando {archive_name}",
                )

            return await self._file_manager.finish_stream_upload(
                target_path,
                upload_id,
                archive_name,
                metadata_path,
                progress_callback=_progress,
            )
        except Exception as exc:
            await self._file_manager.abort_stream_upload(upload_id, metadata_path)
            raise RuntimeError(f"Erro interno no pipeline de streaming: {exc}") from exc

    async def _run_streaming_compress_job(self, job: dict, archive_manifest: dict, *, target_path: str) -> dict:
        archive_format = str(job["archive_format"])
        archive_name = str(job.get("archive_name") or "arquivo")
        compression_level = str(job.get("compression_level") or "normal")
        writer = _QueueBackedArchiveWriter(max_pending_chunks=max(2, self._upload_concurrency + 2))
        progress_state = {
            "current": 0,
            "total": int(archive_manifest.get("total_bytes") or 0),
            "uploading_started": False,
        }
        upload_task = asyncio.create_task(
            self._consume_archive_upload_stream(
                writer,
                job=job,
                target_path=target_path,
                archive_name=archive_name,
                progress_state=progress_state,
            )
        )
        self._set_job_phase(
            job,
            stage="compressing",
            message=f"Compactando {archive_name}...",
            current=0,
            total=progress_state["total"],
            current_file="",
            unit="bytes",
            indeterminate=progress_state["total"] <= 0,
            detail=f"Compactando {archive_name}",
        )
        loop = asyncio.get_running_loop()
        try:
            if archive_format == "zip":
                await asyncio.to_thread(
                    self._run_streaming_zip_archive,
                    archive_manifest,
                    writer,
                    job,
                    compression_level,
                    loop,
                    progress_state,
                )
            elif archive_format == "tar.gz":
                await asyncio.to_thread(
                    self._run_streaming_tar_archive,
                    archive_manifest,
                    writer,
                    job,
                    compression_level,
                    loop,
                    progress_state,
                )
            else:
                raise ArchiveValidationError("Formato de compactação inválido para streaming.")
        except Exception as exc:
            writer.abort(exc if isinstance(exc, Exception) else RuntimeError(str(exc)))
            try:
                await upload_task
            except Exception:
                pass
            raise
        else:
            writer.close()

        upload_result = await upload_task
        return {
            "source_count": len(job["source_paths"]),
            "materialized_files": 0,
            "archive_format": archive_format,
            "streaming": True,
            "directory_count": len(archive_manifest["directories"]),
            "file_count": archive_manifest["file_count"],
            "total_source_bytes": archive_manifest["total_bytes"],
            "uploaded_chunks": int(upload_result.get("chunks") or 0),
        }

    async def _materialize_collected_entries(self, job: dict, archive_manifest: dict, staging_root: Path) -> int:
        for directory in archive_manifest["directories"]:
            (staging_root / PurePosixPath(directory)).mkdir(parents=True, exist_ok=True)

        total_files = len(archive_manifest["files"])
        if total_files == 0:
            return 0

        completed = {"count": 0}
        completed_bytes = {"count": 0}
        semaphore = asyncio.Semaphore(self._download_concurrency)
        total_bytes = max(0, int(archive_manifest.get("total_bytes") or 0))

        async def _download_one(entry: dict) -> None:
            async with semaphore:
                self._ensure_not_canceled(job)
                file_name = Path(entry["virtual_path"]).name
                entry_size = max(0, int(entry.get("size") or 0))
                def _materialize_progress(current: int, total: int) -> None:
                    local_total = max(entry_size, int(total or 0))
                    local_current = max(0, min(int(current), local_total or int(current)))
                    aggregate_bytes = completed_bytes["count"] + local_current
                    if total_bytes > 0:
                        self._touch_job(
                            job,
                            stage="downloading",
                            current=aggregate_bytes,
                            total=total_bytes,
                            message=f"Baixando do Telegram: {file_name} ({completed['count'] + 1}/{total_files})",
                            current_file=file_name,
                            unit="bytes",
                            detail="Baixando partes da nuvem...",
                            indeterminate=False,
                            bytes_done=aggregate_bytes,
                            bytes_total=total_bytes,
                        )
                self._touch_job(
                    job,
                    stage="downloading",
                    current=completed_bytes["count"] if total_bytes > 0 else completed["count"],
                    total=total_bytes if total_bytes > 0 else total_files,
                    message=f"Baixando do Telegram: {file_name} ({completed['count'] + 1}/{total_files})",
                    current_file=file_name,
                    unit="bytes" if total_bytes > 0 else "items",
                    detail="Baixando partes da nuvem...",
                    indeterminate=total_bytes <= 0,
                    bytes_done=completed_bytes["count"] if total_bytes > 0 else 0,
                    bytes_total=total_bytes,
                )
                await self._materialize_file(
                    entry["virtual_path"],
                    entry["file_meta"],
                    staging_root / PurePosixPath(entry["archive_path"]),
                    progress_callback=_materialize_progress if total_bytes > 0 else None,
                )
                completed_bytes["count"] += entry_size
                completed["count"] += 1
                self._touch_job(
                    job,
                    stage="downloading",
                    current=completed_bytes["count"] if total_bytes > 0 else completed["count"],
                    total=total_bytes if total_bytes > 0 else total_files,
                    message=f"Baixado: {file_name} ({completed['count']}/{total_files})",
                    current_file=file_name,
                    unit="bytes" if total_bytes > 0 else "items",
                    detail=f"{completed['count']} de {total_files} arquivo(s) materializados",
                    indeterminate=False,
                    bytes_done=completed_bytes["count"] if total_bytes > 0 else 0,
                    bytes_total=total_bytes,
                )

        self._touch_job(
            job,
            stage="downloading",
            current=0,
            total=total_bytes if total_bytes > 0 else total_files,
            message=f"Baixando {total_files} arquivo(s) do Telegram...",
            unit="bytes" if total_bytes > 0 else "items",
            detail="Baixando partes da nuvem...",
            indeterminate=total_bytes <= 0,
            bytes_done=0,
            bytes_total=total_bytes,
        )
        await asyncio.gather(*[_download_one(entry) for entry in archive_manifest["files"]])
        return total_files

    async def _materialize_sources_for_compression(self, job: dict, *, source_paths: list[str], base_path: str, staging_root: Path) -> int:
        archive_manifest = await self._collect_archive_entries(job, source_paths=source_paths, base_path=base_path)
        return await self._materialize_collected_entries(job, archive_manifest, staging_root)

    async def _materialize_file(self, virtual_path: str, file_meta: dict, target_path: Path, *, progress_callback=None) -> None:
        file_size = int(file_meta.get("size") or 0)
        if file_size > self._max_source_bytes:
            raise ArchiveValidationError(f"O arquivo excede o limite configurado: {virtual_path}")
        await self._file_manager.materialize_cached_file_for_read(
            virtual_path,
            target_path,
            file_meta=file_meta,
            progress_callback=progress_callback,
        )

    def _compress_staging_tree(self, staging_root: Path, output_file: Path, archive_format: str, compression_level: str, job: dict) -> None:
        entries = sorted([path for path in staging_root.rglob("*")], key=lambda item: (item.is_file(), str(item)))
        if archive_format == "zip":
            compresslevel = _compression_level_for_zip(compression_level)
            compression_type = zipfile.ZIP_STORED if compresslevel == 0 else zipfile.ZIP_DEFLATED
            with zipfile.ZipFile(output_file, "w", compression=compression_type, compresslevel=compresslevel) as archive:
                for index, entry in enumerate(entries, start=1):
                    self._ensure_not_canceled(job)
                    arcname = entry.relative_to(staging_root).as_posix()
                    entry_name = entry.name
                    if entry.is_dir():
                        if not any(entry.iterdir()):
                            info = zipfile.ZipInfo(f"{arcname}/")
                            archive.writestr(info, b"")
                    else:
                        archive.write(entry, arcname=arcname)
                    self._touch_job(job, stage="compressing", current=index, total=len(entries), message=f"Compactando: {entry_name} ({index}/{len(entries)})", current_file=entry_name)
            return

        if archive_format == "tar.gz":
            compresslevel = _compression_level_for_tar(compression_level)
            with tarfile.open(output_file, "w:gz", compresslevel=compresslevel) as archive:
                for index, entry in enumerate(entries, start=1):
                    self._ensure_not_canceled(job)
                    entry_name = entry.name
                    archive.add(entry, arcname=entry.relative_to(staging_root).as_posix(), recursive=False)
                    self._touch_job(job, stage="compressing", current=index, total=len(entries), message=f"Compactando: {entry_name} ({index}/{len(entries)})", current_file=entry_name)
            return

        if archive_format == "7z":
            if py7zr is None:
                raise ArchiveCapabilityError("py7zr não está instalado.")
            top_level_entries = sorted(list(staging_root.iterdir()), key=lambda item: item.name.lower())
            with py7zr.SevenZipFile(output_file, "w") as archive:  # pragma: no cover - depends on optional backend
                for index, entry in enumerate(top_level_entries, start=1):
                    self._ensure_not_canceled(job)
                    entry_name = entry.name
                    if entry.is_dir():
                        archive.writeall(entry, arcname=entry.name)
                    else:
                        archive.write(entry, arcname=entry.name)
                    self._touch_job(job, stage="compressing", current=index, total=len(top_level_entries), message=f"Compactando: {entry_name} ({index}/{len(top_level_entries)})", current_file=entry_name)
            return

        raise ArchiveValidationError("Formato de compactação inválido.")

    def _extract_archive_from_seekable_source(
        self,
        archive_path: str,
        archive_meta: dict,
        archive_name: str,
        extract_root: Path,
        archive_format: str,
        password: str,
        job: dict,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        with _ChunkBackedSeekableReader(
            file_manager=self._file_manager,
            loop=loop,
            virtual_path=archive_path,
            file_meta=archive_meta,
            name=archive_name,
        ) as archive_handle:
            self._extract_archive_to_directory(archive_handle, extract_root, archive_format, password, job)

    def _extract_archive_to_directory(self, archive_path: Path | io.IOBase, extract_root: Path, archive_format: str, password: str, job: dict) -> None:
        if archive_format == "zip":
            self._extract_zip(archive_path, extract_root, password, job)
        elif archive_format == "tar.gz":
            self._extract_tar(archive_path, extract_root, job)
        elif archive_format == "rar":
            self._extract_rar(archive_path, extract_root, password, job)
        elif archive_format == "7z":
            self._extract_7z(archive_path, extract_root, password, job)
        else:
            raise ArchiveValidationError("Formato de extração inválido.")

    def _validate_member_name(self, raw_name: str) -> str:
        normalized = str(raw_name or "").replace("\\", "/").strip()
        if not normalized or normalized in {".", "/"}:
            return ""
        if normalized.startswith("/") or normalized.startswith("../") or "/../" in normalized:
            raise ArchiveValidationError("O arquivo compactado contém path traversal.")
        if normalized.startswith("__MACOSX/"):
            return ""
        return normalized.rstrip("/")

    def _safe_extract_target(self, root: Path, member_name: str) -> Path:
        target = (root / member_name).resolve()
        if not str(target).startswith(str(root.resolve())):
            raise ArchiveValidationError("O arquivo compactado contém caminhos inseguros.")
        return target

    def _validate_post_extract_tree(self, root: Path) -> tuple[int, int]:
        total_entries = 0
        total_bytes = 0
        for path in root.rglob("*"):
            total_entries += 1
            if total_entries > self._max_entry_count:
                raise ArchiveValidationError("O arquivo compactado excede o limite de itens.")
            if path.is_symlink():
                raise ArchiveValidationError("O arquivo compactado contém links simbólicos, o que não é permitido.")
            if path.is_file():
                total_bytes += path.stat().st_size
                if total_bytes > self._max_extracted_bytes:
                    raise ArchiveValidationError("O conteúdo extraído excede o limite configurado.")
        return total_entries, total_bytes

    def _extract_zip(self, archive_path: Path | io.IOBase, extract_root: Path, password: str, job: dict) -> None:
        pwd = password.encode("utf-8") if password else None
        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            if len(infos) > self._max_entry_count:
                raise ArchiveValidationError("O arquivo ZIP excede o limite de itens.")
            total_uncompressed = sum(max(0, int(info.file_size or 0)) for info in infos if not info.is_dir())
            if total_uncompressed > self._max_extracted_bytes:
                raise ArchiveValidationError("O conteúdo extraído excede o limite configurado.")
            for index, info in enumerate(infos, start=1):
                self._ensure_not_canceled(job)
                member_name = self._validate_member_name(info.filename)
                if not member_name:
                    continue
                mode = info.external_attr >> 16
                if mode and (mode & 0o170000) == 0o120000:
                    raise ArchiveValidationError("O ZIP contém symlink, o que não é permitido.")
                target = self._safe_extract_target(extract_root, member_name)
                entry_name = Path(member_name).name or member_name
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info, pwd=pwd) as source_handle, target.open("wb") as target_handle:
                    shutil.copyfileobj(source_handle, target_handle)
                self._touch_job(job, stage="extracting", current=index, total=len(infos), message=f"Extraindo: {entry_name} ({index}/{len(infos)})", current_file=entry_name)
        self._validate_post_extract_tree(extract_root)

    def _extract_tar(self, archive_path: Path | io.IOBase, extract_root: Path, job: dict) -> None:
        with tarfile.open(archive_path, "r:*") as archive:
            members = archive.getmembers()
            if len(members) > self._max_entry_count:
                raise ArchiveValidationError("O TAR.GZ excede o limite de itens.")
            total_uncompressed = sum(max(0, int(member.size or 0)) for member in members if member.isfile())
            if total_uncompressed > self._max_extracted_bytes:
                raise ArchiveValidationError("O conteúdo extraído excede o limite configurado.")
            for index, member in enumerate(members, start=1):
                self._ensure_not_canceled(job)
                member_name = self._validate_member_name(member.name)
                if not member_name:
                    continue
                if member.issym() or member.islnk() or member.ischr() or member.isblk() or member.isfifo():
                    raise ArchiveValidationError("O TAR.GZ contém links ou devices, o que não é permitido.")
                target = self._safe_extract_target(extract_root, member_name)
                entry_name = Path(member_name).name or member_name
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                source_handle = archive.extractfile(member)
                if source_handle is None:
                    continue
                with source_handle, target.open("wb") as target_handle:
                    shutil.copyfileobj(source_handle, target_handle)
                self._touch_job(job, stage="extracting", current=index, total=len(members), message=f"Extraindo: {entry_name} ({index}/{len(members)})", current_file=entry_name)
        self._validate_post_extract_tree(extract_root)

    def _extract_rar(self, archive_path: Path | io.IOBase, extract_root: Path, password: str, job: dict) -> None:
        if rarfile is None:
            raise ArchiveCapabilityError("rarfile não está instalado.")
        backend = self._rar_backend()
        if not backend:
            raise ArchiveCapabilityError("Nenhum backend de RAR foi encontrado no sistema.")
        with rarfile.RarFile(archive_path) as archive:  # pragma: no cover - optional backend
            infos = archive.infolist()
            if len(infos) > self._max_entry_count:
                raise ArchiveValidationError("O arquivo RAR excede o limite de itens.")
            total_uncompressed = sum(max(0, int(getattr(info, "file_size", 0) or 0)) for info in infos if not info.isdir())
            if total_uncompressed > self._max_extracted_bytes:
                raise ArchiveValidationError("O conteúdo extraído excede o limite configurado.")
            for index, info in enumerate(infos, start=1):
                self._ensure_not_canceled(job)
                member_name = self._validate_member_name(getattr(info, "filename", ""))
                if not member_name:
                    continue
                if hasattr(info, "is_symlink") and info.is_symlink():
                    raise ArchiveValidationError("O arquivo RAR contém symlink, o que não é permitido.")
                target = self._safe_extract_target(extract_root, member_name)
                entry_name = Path(member_name).name or member_name
                if info.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info, pwd=(password or None)) as source_handle, target.open("wb") as target_handle:
                    shutil.copyfileobj(source_handle, target_handle)
                self._touch_job(job, stage="extracting", current=index, total=len(infos), message=f"Extraindo: {entry_name} ({index}/{len(infos)})", current_file=entry_name)
        self._validate_post_extract_tree(extract_root)

    def _extract_7z(self, archive_path: Path | io.IOBase, extract_root: Path, password: str, job: dict) -> None:
        if py7zr is None:
            raise ArchiveCapabilityError("py7zr não está instalado.")
        with py7zr.SevenZipFile(archive_path, mode="r", password=(password or None)) as archive:  # pragma: no cover - optional backend
            members = archive.list()
            if len(members) > self._max_entry_count:
                raise ArchiveValidationError("O arquivo 7Z excede o limite de itens.")
            total_uncompressed = 0
            for member in members:
                filename = getattr(member, "filename", "")
                self._validate_member_name(filename)
                total_uncompressed += max(0, int(getattr(member, "uncompressed", 0) or 0))
            if total_uncompressed > self._max_extracted_bytes:
                raise ArchiveValidationError("O conteúdo extraído excede o limite configurado.")
            self._touch_job(
                job,
                stage="extracting",
                current=0,
                total=len(members),
                message="Extraindo 7Z...",
                current_file="",
                unit="items",
                detail="Extraindo arquivos...",
                indeterminate=not bool(members),
            )
            archive.extractall(path=extract_root)
        total_entries, _ = self._validate_post_extract_tree(extract_root)
        self._touch_job(
            job,
            stage="extracting",
            current=total_entries,
            total=max(total_entries, len(members)),
            message="Extraindo 7Z...",
            unit="items",
            detail="Extraindo arquivos...",
            indeterminate=False,
        )

    async def _run_streaming_extract_job(
        self,
        job: dict,
        *,
        archive_meta: dict,
        archive_name: str,
        archive_format: str,
        extract_root: Path,
        password: str,
    ) -> None:
        backend_path = self._streaming_extract_backend_path()
        if not backend_path:
            raise ArchiveCapabilityError("Backend de extração streaming indisponível neste ambiente.")

        archive_size = max(0, int(archive_meta.get("size") or 0))
        state = {"bytes_fed": 0, "entries_seen": 0, "last_file": archive_name}
        stderr_lines: list[str] = []
        command = [
            backend_path,
            "-xvf",
            "-",
            "-C",
            str(extract_root),
            "--safe-writes",
        ]
        if password:
            command.extend(["--passphrase", password])

        logger.info(
            "Archive extract streaming started: backend=%s format=%s archive=%s",
            backend_path,
            archive_format,
            archive_name,
        )
        self._touch_job(
            job,
            stage="downloading",
            current=0,
            total=archive_size,
            message=f"Lendo {archive_name} da nuvem...",
            current_file=archive_name,
            unit="bytes",
            detail="Lendo archive da nuvem em streaming...",
            indeterminate=archive_size <= 0,
            bytes_done=0,
            bytes_total=archive_size,
        )
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        async def _pump_archive() -> None:
            try:
                async for chunk in self._file_manager.iter_file_chunks_for_archive(
                    job["archive_path"],
                    archive_meta,
                ):
                    self._ensure_not_canceled(job)
                    if process.stdin is None or process.stdin.is_closing():
                        break
                    process.stdin.write(chunk)
                    await process.stdin.drain()
                    state["bytes_fed"] += len(chunk)
                    stage_name = "extracting" if state["entries_seen"] > 0 else "downloading"
                    detail = (
                        f"Extraindo {state['last_file']}"
                        if stage_name == "extracting"
                        else "Lendo archive da nuvem em streaming..."
                    )
                    self._touch_job(
                        job,
                        stage=stage_name,
                        current=min(state["bytes_fed"], archive_size) if archive_size > 0 else state["bytes_fed"],
                        total=archive_size,
                        message=f"Extraindo {archive_name}...",
                        current_file=state["last_file"],
                        unit="bytes",
                        detail=detail,
                        indeterminate=archive_size <= 0,
                        bytes_done=min(state["bytes_fed"], archive_size) if archive_size > 0 else state["bytes_fed"],
                        bytes_total=archive_size,
                    )
            except (BrokenPipeError, ConnectionResetError):
                return
            finally:
                if process.stdin is not None and not process.stdin.is_closing():
                    process.stdin.close()
                    try:
                        await process.stdin.wait_closed()
                    except Exception:
                        pass

        async def _read_extract_output() -> None:
            if process.stderr is None:
                return
            while True:
                line = await process.stderr.readline()
                if not line:
                    break
                text = line.decode(errors="replace").strip()
                if not text:
                    continue
                stderr_lines.append(text)
                if len(stderr_lines) > 80:
                    stderr_lines.pop(0)
                if not text.startswith("x "):
                    continue
                raw_name = text[2:].strip()
                member_name = self._validate_member_name(raw_name)
                if not member_name:
                    continue
                state["entries_seen"] += 1
                state["last_file"] = Path(member_name).name or member_name
                self._touch_job(
                    job,
                    stage="extracting",
                    current=min(state["bytes_fed"], archive_size) if archive_size > 0 else state["bytes_fed"],
                    total=archive_size,
                    message=f"Extraindo {archive_name}...",
                    current_file=state["last_file"],
                    unit="bytes",
                    detail=f"Extraindo {state['last_file']}",
                    indeterminate=archive_size <= 0,
                    bytes_done=min(state["bytes_fed"], archive_size) if archive_size > 0 else state["bytes_fed"],
                    bytes_total=archive_size,
                )

        pump_task = asyncio.create_task(_pump_archive())
        output_task = asyncio.create_task(_read_extract_output())
        try:
            while process.returncode is None:
                self._ensure_not_canceled(job)
                try:
                    await asyncio.wait_for(process.wait(), timeout=0.2)
                except asyncio.TimeoutError:
                    continue
            await asyncio.gather(pump_task, output_task)
            if process.returncode != 0:
                stderr_text = "; ".join(stderr_lines[-10:])
                raise ArchiveServiceError(
                    "Erro interno no pipeline de streaming: "
                    f"backend={Path(backend_path).name} "
                    f"exit={process.returncode} "
                    f"cmd={shlex.join(command)} "
                    f"stderr={stderr_text or 'sem detalhes'}"
                )
        except Exception:
            for task in (pump_task, output_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(pump_task, output_task, return_exceptions=True)
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            raise

        total_entries, _ = self._validate_post_extract_tree(extract_root)
        self._touch_job(
            job,
            stage="extracting",
            current=archive_size,
            total=archive_size,
            message=f"{archive_name} extraído.",
            current_file=state["last_file"] if total_entries > 0 else archive_name,
            unit="bytes",
            detail=f"{total_entries} item(s) extraído(s)",
            indeterminate=False,
            bytes_done=archive_size,
            bytes_total=archive_size,
        )

    def _build_extract_reveal_paths(
        self,
        *,
        local_root: Path,
        destination_root: str,
        top_level_file_targets: dict[str, str],
    ) -> list[str]:
        reveal_paths: list[str] = []
        seen_paths: set[str] = set()
        if not local_root.exists():
            return reveal_paths

        for item in sorted(local_root.iterdir(), key=lambda entry: (entry.is_file(), str(entry).lower())):
            candidate = (
                top_level_file_targets.get(item.name)
                if item.is_file()
                else _join_virtual_path(destination_root, item.name)
            )
            normalized_candidate = _normalize_virtual_path(candidate)
            if not normalized_candidate or normalized_candidate in seen_paths:
                continue
            seen_paths.add(normalized_candidate)
            reveal_paths.append(normalized_candidate)
        return reveal_paths

    async def _upload_extracted_tree(self, job: dict, local_root: Path, destination_root: str, overwrite_mode: str) -> dict:
        paths = sorted(local_root.rglob("*"), key=lambda item: (item.is_file(), str(item)))
        files = [item for item in paths if item.is_file()]
        dirs = [item for item in paths if item.is_dir()]
        total_steps = len(dirs) + len(files)
        step = 0
        total_file_bytes = sum(max(0, item.stat().st_size) for item in files)
        uploaded_bytes = {"count": 0}
        top_level_file_targets: dict[str, str] = {}

        for directory in dirs:
            self._ensure_not_canceled(job)
            relative = directory.relative_to(local_root).as_posix()
            if not relative:
                continue
            target_dir = _join_virtual_path(destination_root, relative)
            await self._ensure_directory_path(target_dir)
            step += 1
            self._touch_job(
                job,
                stage="uploading",
                current=uploaded_bytes["count"] if total_file_bytes > 0 else step,
                total=total_file_bytes if total_file_bytes > 0 else total_steps,
                message=f"Criando pasta: {directory.name}",
                current_file=directory.name,
                unit="bytes" if total_file_bytes > 0 else "items",
                detail="Salvando no diretório...",
                indeterminate=total_file_bytes <= 0,
                bytes_done=uploaded_bytes["count"] if total_file_bytes > 0 else 0,
                bytes_total=total_file_bytes,
            )

        uploaded_files = 0
        for file_path in files:
            self._ensure_not_canceled(job)
            relative = file_path.relative_to(local_root).as_posix()
            file_name = file_path.name
            file_size = max(0, file_path.stat().st_size)
            target_path = _join_virtual_path(destination_root, relative)
            parent_dir = str(PurePosixPath(target_path).parent)
            if parent_dir in {"", "."}:
                parent_dir = "/"
            await self._ensure_directory_path(parent_dir)
            final_path = await self._resolve_file_target(target_path, overwrite_mode)
            if not final_path:
                job["warnings"].append(f"Conflito ignorado em {target_path}")
                uploaded_bytes["count"] += file_size
                step += 1
                self._touch_job(
                    job,
                    stage="uploading",
                    current=uploaded_bytes["count"] if total_file_bytes > 0 else step,
                    total=total_file_bytes if total_file_bytes > 0 else total_steps,
                    message=f"Conflito ignorado: {file_name}",
                    current_file=file_name,
                    unit="bytes" if total_file_bytes > 0 else "items",
                    detail="Salvando no diretório...",
                    indeterminate=False,
                    bytes_done=uploaded_bytes["count"] if total_file_bytes > 0 else 0,
                    bytes_total=total_file_bytes,
                )
                continue
            phase_base_bytes = uploaded_bytes["count"]
            self._touch_job(
                job,
                stage="uploading",
                current=phase_base_bytes if total_file_bytes > 0 else step,
                total=total_file_bytes if total_file_bytes > 0 else total_steps,
                message=f"Enviando: {file_name} ({uploaded_files + 1}/{len(files)})",
                current_file=file_name,
                unit="bytes" if total_file_bytes > 0 else "items",
                detail="Salvando no diretório...",
                indeterminate=total_file_bytes <= 0,
                bytes_done=phase_base_bytes if total_file_bytes > 0 else 0,
                bytes_total=total_file_bytes,
            )
            def _upload_progress(current: int, total: int) -> None:
                local_total = max(file_size, int(total or 0))
                local_current = max(0, min(int(current), local_total or int(current)))
                aggregate_bytes = phase_base_bytes + local_current
                self._touch_job(
                    job,
                    stage="uploading",
                    current=aggregate_bytes if total_file_bytes > 0 else step,
                    total=total_file_bytes if total_file_bytes > 0 else total_steps,
                    message=f"Enviando: {file_name} ({uploaded_files + 1}/{len(files)})",
                    current_file=file_name,
                    unit="bytes" if total_file_bytes > 0 else "items",
                    detail="Salvando no diretório...",
                    indeterminate=total_file_bytes <= 0,
                    bytes_done=aggregate_bytes if total_file_bytes > 0 else 0,
                    bytes_total=total_file_bytes,
                )
            await self._file_manager.upload_file(file_path, final_path, progress_callback=_upload_progress if total_file_bytes > 0 else None)
            relative_parts = PurePosixPath(relative).parts
            if len(relative_parts) == 1:
                top_level_file_targets[relative_parts[0]] = final_path
            uploaded_bytes["count"] = phase_base_bytes + file_size
            uploaded_files += 1
            step += 1
            self._touch_job(
                job,
                stage="uploading",
                current=uploaded_bytes["count"] if total_file_bytes > 0 else step,
                total=total_file_bytes if total_file_bytes > 0 else total_steps,
                message=f"Enviado: {file_name} ({uploaded_files}/{len(files)})",
                current_file=file_name,
                unit="bytes" if total_file_bytes > 0 else "items",
                detail="Salvando no diretório...",
                indeterminate=False,
                bytes_done=uploaded_bytes["count"] if total_file_bytes > 0 else 0,
                bytes_total=total_file_bytes,
            )
        return {
            "uploaded_files": uploaded_files,
            "reveal_paths": self._build_extract_reveal_paths(
                local_root=local_root,
                destination_root=destination_root,
                top_level_file_targets=top_level_file_targets,
            ),
        }

    async def _resolve_file_target(self, target_path: str, overwrite_mode: str) -> str | None:
        normalized = _normalize_virtual_path(target_path)
        if not await self._file_manager.exists(normalized):
            return normalized

        if overwrite_mode == "skip":
            return None

        if overwrite_mode == "replace":
            if await self._file_manager.is_file(normalized):
                await self._file_manager.delete_file(normalized)
            else:
                await self._file_manager.delete_directory_recursive(normalized)
            return normalized

        return await self._next_available_path(normalized)
