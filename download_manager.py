"""
TCloud - Download Cache Manager
Disk-backed chunk-level cache for accelerating downloads and enabling resume.
Fetches Telegram chunks to local disk and serves from there.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator

import aiofiles

from config import Config

logger = logging.getLogger("tcloud.cache")


class DownloadCache:
    """
    Chunk-level disk cache for TCloud downloads.

    Files in TCloud are split into 64MB Telegram chunks. This cache stores
    each chunk as a separate file on disk, enabling:
    - Instant resume (only missing chunks are re-fetched)
    - Fast delivery via disk reads (vs Telegram API)
    - Background prefetch of upcoming chunks
    """

    def __init__(self, telegram, db):
        self._telegram = telegram
        self._db = db
        self._cache_dir = Config.CACHE_DIR
        self._cache_dir.mkdir(parents=True, exist_ok=True)

        # Lock per chunk to prevent duplicate downloads
        self._chunk_locks: dict[str, asyncio.Lock] = {}
        # Track active prefetch tasks
        self._prefetch_tasks: dict[str, asyncio.Task] = {}
        # Access times for LRU eviction
        self._access_times: dict[str, float] = {}
        # Byte-level progress for in-flight chunk downloads
        self._chunk_progress: dict[str, int] = {}
        # Paths currently being cached
        self._active_caching: set[str] = set()
        # Paths currently being downloaded offline explicitly
        self._active_offline_downloads: set[str] = set()
        # Strong references to background caching tasks (prevents GC)
        self._caching_tasks: dict[str, asyncio.Task] = {}

        # Scan existing cache on startup
        self._scan_cache()

        logger.info(
            f"📦 Download cache initialized: {self._cache_dir} "
            f"(max {Config.CACHE_MAX_GB} GB, prefetch {Config.CACHE_PREFETCH_CHUNKS} chunks)"
        )

    def _scan_cache(self):
        """Scan cache directory and populate access times from mtime."""
        if not self._cache_dir.exists():
            return
        for item in self._cache_dir.iterdir():
            if item.is_file() and item.suffix == ".chunk":
                try:
                    self._access_times[str(item)] = item.stat().st_mtime
                except OSError:
                    pass

    def _chunk_key(self, virtual_path: str, chunk_index: int) -> str:
        """Generate a unique key for a chunk."""
        path_hash = hashlib.md5(virtual_path.encode()).hexdigest()[:12]
        safe_name = virtual_path.replace("/", "_").strip("_")[:40]
        return f"{safe_name}_{path_hash}_c{chunk_index}"

    def _chunk_path(self, virtual_path: str, chunk_index: int) -> Path:
        """Get the disk path for a cached chunk."""
        key = self._chunk_key(virtual_path, chunk_index)
        return self._cache_dir / f"{key}.chunk"

    def _get_lock(self, key: str) -> asyncio.Lock:
        """Get or create a lock for a chunk key."""
        if key not in self._chunk_locks:
            self._chunk_locks[key] = asyncio.Lock()
        return self._chunk_locks[key]

    def is_chunk_cached(self, virtual_path: str, chunk_index: int, expected_size: int) -> bool:
        """Check if a chunk is fully cached on disk."""
        path = self._chunk_path(virtual_path, chunk_index)
        if not path.exists():
            return False
        try:
            actual_size = path.stat().st_size
            return actual_size == expected_size
        except OSError:
            return False

    def is_file_cached(self, virtual_path: str, chunks: list[dict]) -> bool:
        """
        Check if an entire file is cached on disk.
        Always verifies actual disk presence to avoid false positives.
        """
        if not chunks:
            return False
        for chunk in chunks:
            if not self.is_chunk_cached(virtual_path, chunk["index"], chunk["size"]):
                # Clean up stale entry from _access_times if present
                path_str = str(self._chunk_path(virtual_path, chunk["index"]))
                self._access_times.pop(path_str, None)
                return False
        return True

    def evict_file_cache(self, virtual_path: str, chunks: list[dict]) -> int:
        """
        Remove all cached chunks for a file from disk.
        Returns the number of chunks removed.
        """
        removed = 0
        for chunk in chunks:
            chunk_path = self._chunk_path(virtual_path, chunk["index"])
            if chunk_path.exists():
                try:
                    chunk_path.unlink()
                    self._access_times.pop(str(chunk_path), None)
                    removed += 1
                except OSError as e:
                    logger.warning(f"Failed to evict chunk {chunk_path}: {e}")
        if removed > 0:
            logger.info(f"🧹 Evicted {removed} cached chunk(s) for: {virtual_path}")
        return removed

    async def get_or_fetch_chunk(self, virtual_path: str, chunk_meta: dict) -> Path:
        """
        Get a cached chunk or fetch it from Telegram.

        Args:
            virtual_path: Virtual file path
            chunk_meta: Dict with keys: index, message_id, size

        Returns:
            Path to the cached chunk file on disk
        """
        chunk_index = chunk_meta["index"]
        chunk_size = chunk_meta["size"]
        message_id = chunk_meta["message_id"]
        cache_path = self._chunk_path(virtual_path, chunk_index)
        lock_key = self._chunk_key(virtual_path, chunk_index)

        # Fast path: already cached
        if self.is_chunk_cached(virtual_path, chunk_index, chunk_size):
            self._touch(cache_path)
            return cache_path

        # Acquire lock to prevent duplicate downloads
        lock = self._get_lock(lock_key)
        async with lock:
            # Double-check after acquiring lock
            if self.is_chunk_cached(virtual_path, chunk_index, chunk_size):
                self._touch(cache_path)
                return cache_path

            # Download from Telegram to disk
            logger.info(
                f"⬇️  Cache miss: {virtual_path} chunk {chunk_index} "
                f"({chunk_size / 1024 / 1024:.1f} MB) — downloading from Telegram"
            )

            temp_path = cache_path.with_suffix(".tmp")
            progress_key = f"{virtual_path}:{chunk_index}"
            self._chunk_progress[progress_key] = 0
            try:
                # Ensure cache directory exists (may have been deleted at runtime)
                self._cache_dir.mkdir(parents=True, exist_ok=True)
                async with aiofiles.open(temp_path, "wb") as f:
                    async for data in self._telegram.iter_download(
                        message_id, file_size=chunk_size
                    ):
                        await f.write(data)
                        # The HTTP download path may tail this temp file while
                        # the chunk is still being fetched, so we need the bytes
                        # visible on disk before the whole chunk finishes.
                        await f.flush()
                        self._chunk_progress[progress_key] = (
                            self._chunk_progress.get(progress_key, 0) + len(data)
                        )

                # Atomic rename
                temp_path.rename(cache_path)
                self._touch(cache_path)
                self._chunk_progress.pop(progress_key, None)

                logger.info(
                    f"✅ Cached: {virtual_path} chunk {chunk_index} "
                    f"({chunk_size / 1024 / 1024:.1f} MB)"
                )
                return cache_path

            except Exception as e:
                # Cleanup partial download
                self._chunk_progress.pop(progress_key, None)
                if temp_path.exists():
                    temp_path.unlink()
                logger.error(f"❌ Cache download failed: {virtual_path} chunk {chunk_index}: {e}")
                raise

    def _touch(self, path: Path):
        """Update access time for LRU tracking."""
        self._access_times[str(path)] = time.time()
        try:
            path.touch()
        except OSError:
            pass

    async def prefetch_chunks(
        self, virtual_path: str, chunks: list[dict], from_index: int
    ):
        """
        Prefetch upcoming chunks in background.

        Args:
            virtual_path: Virtual file path
            chunks: List of chunk metadata dicts
            from_index: Start prefetching from this chunk index
        """
        prefetch_count = Config.CACHE_PREFETCH_CHUNKS
        target_chunks = [
            c for c in chunks
            if from_index < c["index"] <= from_index + prefetch_count
        ]

        for chunk_meta in target_chunks:
            task_key = self._chunk_key(virtual_path, chunk_meta["index"])

            # Skip if already cached or being fetched
            if self.is_chunk_cached(virtual_path, chunk_meta["index"], chunk_meta["size"]):
                continue
            if task_key in self._prefetch_tasks and not self._prefetch_tasks[task_key].done():
                continue

            # Start background fetch
            task = asyncio.create_task(
                self._prefetch_one(virtual_path, chunk_meta, task_key)
            )
            self._prefetch_tasks[task_key] = task

    async def _prefetch_one(self, virtual_path: str, chunk_meta: dict, task_key: str):
        """Prefetch a single chunk (runs as background task)."""
        try:
            await self.get_or_fetch_chunk(virtual_path, chunk_meta)
        except Exception as e:
            logger.warning(f"Prefetch failed for {virtual_path} chunk {chunk_meta['index']}: {e}")
        finally:
            self._prefetch_tasks.pop(task_key, None)

    async def serve_range(
        self,
        virtual_path: str,
        file_meta: dict,
        start: int,
        end: int,
        interactive: bool = False,
    ) -> AsyncIterator[bytes]:
        """
        Serve a byte range from cache, fetching missing chunks as needed.
        Always uses full caching + prefetch for maximum speed.

        Args:
            virtual_path: Virtual file path
            file_meta: File metadata from DB (with chunks list)
            start: Start byte (inclusive)
            end: End byte (inclusive)
            interactive: True when the request originates from a live HTTP stream.
                The flag currently exists to keep the internal API compatible with
                interactive streaming call sites while preserving the current cache
                and prefetch behavior.

        Yields:
            Byte chunks from cached files
        """
        total_size = file_meta["size"]
        chunks = sorted(file_meta.get("chunks", []), key=lambda c: c["index"])
        chunk_size = Config.CHUNK_SIZE_BYTES

        if end is None or end >= total_size:
            end = total_size - 1

        if start > end:
            return

        # Determine relevant chunk indices
        start_chunk_idx = start // chunk_size
        end_chunk_idx = end // chunk_size

        relevant_chunks = [
            c for c in chunks
            if start_chunk_idx <= c["index"] <= end_chunk_idx
        ]

        # Keep the current hot-path behavior for both interactive and non-interactive
        # callers. The interactive flag is accepted to stabilize the internal API and
        # leaves room for future tuning without changing call sites again.
        if relevant_chunks:
            await self.prefetch_chunks(virtual_path, chunks, relevant_chunks[-1]["index"])

        DISK_READ_SIZE = 256 * 1024  # 256KB disk reads

        for chunk_meta in relevant_chunks:
            chunk_start_byte = chunk_meta["index"] * chunk_size

            # Calculate what portion of this chunk we need
            read_start = max(0, start - chunk_start_byte)
            read_end = min(chunk_meta["size"], end - chunk_start_byte + 1)
            remaining = read_end - read_start

            if remaining <= 0:
                continue

            if self.is_chunk_cached(virtual_path, chunk_meta["index"], chunk_meta["size"]):
                # --- FAST CACHE PATH ---
                cache_path = self._chunk_path(virtual_path, chunk_meta["index"])
                async with aiofiles.open(cache_path, "rb") as f:
                    await f.seek(read_start)

                    while remaining > 0:
                        to_read = min(DISK_READ_SIZE, remaining)
                        data = await f.read(to_read)
                        if not data:
                            break
                        remaining -= len(data)
                        yield data
            else:
                # --- SMART CACHE-THEN-TAIL PATH (large reads only) ---
                # Launch ONE background download for the entire chunk (64MB),
                # then tail its .tmp file as it downloads.
                progress_key = f"{virtual_path}:{chunk_meta['index']}"
                temp_path = self._chunk_path(virtual_path, chunk_meta["index"]).with_suffix(".tmp")
                task_key = self._chunk_key(virtual_path, chunk_meta["index"])
                
                # Start downloading THIS chunk if nobody is doing it yet
                if task_key not in self._prefetch_tasks or self._prefetch_tasks[task_key].done():
                    if not self.is_chunk_cached(virtual_path, chunk_meta["index"], chunk_meta["size"]):
                        logger.info(f"🚀 Launching background download for current chunk: {virtual_path} chunk {chunk_meta['index']}")
                        task = asyncio.create_task(
                            self._prefetch_one(virtual_path, chunk_meta, task_key)
                        )
                        self._prefetch_tasks[task_key] = task
                
                # Wait for background download to start writing the .tmp file (up to 5 seconds)
                wait_loops = 0
                while wait_loops < 50 and not (progress_key in self._chunk_progress and temp_path.exists()):
                    await asyncio.sleep(0.1)
                    wait_loops += 1
                    
                if progress_key in self._chunk_progress and temp_path.exists():
                    # --- TAIL BACKGROUND CACHE STREAM ---
                    logger.info(f"⏳ Tailing background cache: {virtual_path} chunk {chunk_meta['index']} offset {read_start} limit {remaining}")
                    async with aiofiles.open(temp_path, "rb") as f:
                        await f.seek(read_start)
                        while remaining > 0:
                            to_read = min(DISK_READ_SIZE, remaining)
                            target_progress = read_start + to_read
                            
                            # Wait until background task has written enough bytes
                            loop_waits = 0
                            while self._chunk_progress.get(progress_key, 0) < target_progress and progress_key in self._chunk_progress:
                                await asyncio.sleep(0.05)
                                loop_waits += 1
                                if loop_waits > 600: # 30s timeout
                                    logger.warning(f"Tail timeout on {virtual_path}")
                                    break
                            
                            data = await f.read(to_read)
                            if not data:
                                if progress_key not in self._chunk_progress:
                                    break # Chunk finalized or failed
                                await asyncio.sleep(0.05)
                                continue
                                
                            remaining -= len(data)
                            read_start += len(data)
                            yield data

                    # If remaining > 0, chunk might have been finalized (renamed .tmp -> .chunk)
                    if remaining > 0 and self.is_chunk_cached(virtual_path, chunk_meta["index"], chunk_meta["size"]):
                        cache_path = self._chunk_path(virtual_path, chunk_meta["index"])
                        async with aiofiles.open(cache_path, "rb") as f:
                            await f.seek(read_start)
                            while remaining > 0:
                                data = await f.read(min(DISK_READ_SIZE, remaining))
                                if not data: break
                                remaining -= len(data)
                                yield data
                else:
                    # --- LAST RESORT FALLBACK ---
                    logger.warning(
                        f"⚡ Direct Stream (last resort): {virtual_path} chunk {chunk_meta['index']} "
                        f"offset {read_start} limit {remaining}"
                    )
                    try:
                        async for data in self._telegram.iter_download(
                            message_id=chunk_meta["message_id"],
                            offset=read_start,
                            limit=remaining
                        ):
                            if not data:
                                break
                            yield data
                    except Exception as e:
                        logger.error(f"Direct stream error: {e}", exc_info=True)
                        raise

    def get_cache_status(self, virtual_path: str, chunks: list[dict]) -> dict:
        """
        Get caching status for a file, including byte-level progress
        for chunks currently being downloaded.
        """
        cached = []
        cached_bytes = 0
        in_progress_bytes = 0
        total_bytes = sum(c["size"] for c in chunks)

        for chunk in chunks:
            if self.is_chunk_cached(virtual_path, chunk["index"], chunk["size"]):
                cached.append(chunk["index"])
                cached_bytes += chunk["size"]
            else:
                # Check if this chunk is currently being downloaded
                progress_key = f"{virtual_path}:{chunk['index']}"
                if progress_key in self._chunk_progress:
                    in_progress_bytes += self._chunk_progress[progress_key]

        effective_bytes = cached_bytes + in_progress_bytes
        percent = round((effective_bytes / total_bytes * 100), 1) if total_bytes > 0 else 0
        percent = min(percent, 100.0)

        return {
            "cached_chunks": cached,
            "total_chunks": len(chunks),
            "cached_bytes": effective_bytes,
            "total_bytes": total_bytes,
            "percent": percent,
            "active": virtual_path in self._active_caching,
            "active_offline": virtual_path in self._active_offline_downloads,
        }

    def get_file_cache_snapshot(self, virtual_path: str, chunks: list[dict]) -> dict:
        """Return cache status plus the most recent effective access time."""
        status = self.get_cache_status(virtual_path, chunks)
        last_access_ts = None

        for chunk in chunks:
            chunk_path = str(self._chunk_path(virtual_path, chunk["index"]))
            chunk_access_ts = self._access_times.get(chunk_path)
            if chunk_access_ts is not None and (last_access_ts is None or chunk_access_ts > last_access_ts):
                last_access_ts = chunk_access_ts

            progress_key = f"{virtual_path}:{chunk['index']}"
            if progress_key in self._chunk_progress and last_access_ts is None:
                last_access_ts = time.time()

        status["last_accessed_at"] = (
            datetime.fromtimestamp(last_access_ts, tz=timezone.utc).isoformat()
            if last_access_ts is not None else ""
        )
        return status

    async def cache_entire_file(self, virtual_path: str, file_meta: dict, is_offline_job: bool = False) -> dict:
        """
        Start caching all chunks of a file in background.
        Returns the initial cache status immediately.
        """
        chunks = sorted(file_meta.get("chunks", []), key=lambda c: c["index"])

        # Check if there's already an active caching task for this path
        existing_task = self._caching_tasks.get(virtual_path)
        if existing_task and not existing_task.done():
            logger.debug(f"Caching already in progress for {virtual_path}")
            if is_offline_job:
                self._active_caching.discard(virtual_path)
                self._active_offline_downloads.add(virtual_path)
        else:
            # Start new background caching task
            if is_offline_job:
                self._active_offline_downloads.add(virtual_path)
            else:
                self._active_caching.add(virtual_path)
            task = asyncio.create_task(self._cache_all_chunks(virtual_path, chunks, is_offline_job))
            self._caching_tasks[virtual_path] = task  # Keep strong reference!
            logger.info(f"🚀 Background caching started for {virtual_path} ({len(chunks)} chunks, offline={is_offline_job})")

        return self.get_file_cache_snapshot(virtual_path, chunks)

    async def _cache_all_chunks(self, virtual_path: str, chunks: list[dict], is_offline_job: bool = False):
        """Background task: concurrently cache all chunks for a file."""
        try:
            from config import Config
            logger.info(f"📥 _cache_all_chunks BEGIN: {virtual_path} ({len(chunks)} chunks, parallel={Config.MAX_WORKERS})")
            
            semaphore = asyncio.Semaphore(Config.MAX_WORKERS)

            async def fetch_chunk(i: int, chunk_meta: dict):
                async with semaphore:
                    if not self.is_chunk_cached(virtual_path, chunk_meta["index"], chunk_meta["size"]):
                        logger.info(f"📥 Fetching chunk {i+1}/{len(chunks)} for {virtual_path}")
                        await self.get_or_fetch_chunk(virtual_path, chunk_meta)

            # Create tasks for all chunks
            tasks = [fetch_chunk(i, chunk) for i, chunk in enumerate(chunks)]
            
            # Wait for all downloads to complete
            await asyncio.gather(*tasks)
            
            logger.info(f"✅ _cache_all_chunks DONE: {virtual_path}")
        except Exception as e:
             logger.error(f"❌ Background caching failed for {virtual_path}: {e}", exc_info=True)
        finally:
            if is_offline_job:
                self._active_offline_downloads.discard(virtual_path)
            else:
                self._active_caching.discard(virtual_path)
            self._caching_tasks.pop(virtual_path, None)

    def get_all_chunk_paths(self, virtual_path: str, chunks: list[dict]) -> list[Path]:
        """Get the disk paths for all chunks of a file, in order."""
        return [self._chunk_path(virtual_path, c["index"]) for c in sorted(chunks, key=lambda c: c["index"])]

    def is_fully_cached(self, virtual_path: str, chunks: list[dict]) -> bool:
        """Check if all chunks of a file are cached."""
        return all(
            self.is_chunk_cached(virtual_path, c["index"], c["size"])
            for c in chunks
        )

    def get_full_file_path(self, virtual_path: str, chunks: list[dict]) -> Path | None:
        """
        If the file has exactly one chunk and it's cached, return path directly.
        For multi-chunk files, return None (use serve_range instead).
        """
        if len(chunks) == 1 and self.is_chunk_cached(
            virtual_path, chunks[0]["index"], chunks[0]["size"]
        ):
            return self._chunk_path(virtual_path, chunks[0]["index"])
        return None

    async def cleanup_lru(self) -> int:
        """
        Remove least-recently-used cache files when total exceeds limit.
        Also removes implicit cache files older than 1 day (TTL).

        Returns:
            Number of files removed
        """
        max_bytes = Config.CACHE_MAX_GB * 1024 * 1024 * 1024
        removed = 0
        now = time.time()
        one_day = 86400

        # Get protected explicit cache files
        offline_files = await self._db.get_offline_files()
        protected_paths = set()
        for f in offline_files:
            if not f.get("is_directory") and f.get("chunks"):
                for chunk in f["chunks"]:
                    chunk_path = self._chunk_path(f["path"], chunk["index"])
                    protected_paths.add(str(chunk_path))

        # Calculate current cache size and handle TTL
        cache_files = []
        total_size = 0

        if not self._cache_dir.exists():
            return 0

        for item in self._cache_dir.iterdir():
            if item.is_file() and item.suffix == ".chunk":
                try:
                    size = item.stat().st_size
                    atime = self._access_times.get(str(item), item.stat().st_mtime)
                    
                    # Check TTL for implicit cache (not protected)
                    str_path = str(item)
                    if str_path not in protected_paths and (now - atime) > one_day:
                        item.unlink()
                        self._access_times.pop(str_path, None)
                        removed += 1
                        continue
                        
                    cache_files.append((item, size, atime))
                    total_size += size
                except OSError:
                    continue

        if total_size <= max_bytes:
            if removed > 0:
                logger.info(f"🧹 Cache TTL cleanup: removed {removed} expired implicit cache file(s)")
            return removed

        # Sort by access time (oldest first)
        cache_files.sort(key=lambda x: x[2])

        # Remove oldest until under limit (protecting explicit cache)
        for file_path, file_size, _ in cache_files:
            if total_size <= max_bytes:
                break
                
            # Do not evict explicitly cached files due to size limit
            if str(file_path) in protected_paths:
                continue
                
            try:
                file_path.unlink()
                total_size -= file_size
                self._access_times.pop(str(file_path), None)
                removed += 1
            except OSError as e:
                logger.warning(f"Failed to remove cache file {file_path}: {e}")

        if removed > 0:
            logger.info(
                f"🧹 Cache cleanup: removed {removed} file(s), "
                f"cache now {total_size / 1024 / 1024 / 1024:.1f} GB"
            )

        return removed

    def invalidate(self, virtual_path: str, chunks: list[dict]):
        """Remove all cached chunks for a file (e.g., after delete/overwrite)."""
        for chunk in chunks:
            path = self._chunk_path(virtual_path, chunk["index"])
            if path.exists():
                try:
                    path.unlink()
                    self._access_times.pop(str(path), None)
                except OSError:
                    pass

    def get_total_cache_size(self) -> int:
        """Get total cache size in bytes."""
        total = 0
        if not self._cache_dir.exists():
            return 0
        for item in self._cache_dir.iterdir():
            if item.is_file() and item.suffix == ".chunk":
                try:
                    total += item.stat().st_size
                except OSError:
                    pass
        return total
