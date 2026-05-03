import os
import sys
import time
import errno
import stat
import asyncio
import logging
import unicodedata
import threading
from pathlib import Path

# Setup FUSE-T path before importing fuse
fuse_tPaths = [
    "/usr/local/lib/libfuse-t.dylib",
    "/opt/homebrew/lib/libfuse-t.dylib"
]
# Dynamically check fuse-t versions installed in Application Support
app_support = Path("/Library/Application Support/fuse-t/lib")
if app_support.exists():
    for f in app_support.glob("libfuse-t-*.dylib"):
        fuse_tPaths.append(str(f))

for p in fuse_tPaths:
    if os.path.exists(p):
        os.environ["FUSE_LIBRARY_PATH"] = p
        break

try:
    from fuse import FUSE, FuseOSError, Operations
except ImportError:
    print("fusepy not installed or libfuse-t.dylib not found")
    sys.exit(1)

from config import Config

logger = logging.getLogger("tcloud.fuse")

class TCloudFUSE(Operations):
    def __init__(self, file_manager, loop):
        self.fm = file_manager
        self.loop = loop
        
        # Cache for getattr
        self._cache = {}
        self._cache_time = {}
        self.CACHETTL = 60  # seconds (increased to prevent rapid Finder refreshes)
        
        # Per-file-handle byte counter for hybrid copy detection
        self._fh_bytes = {}         # fh -> int total bytes read
        self._fh_path = {}          # fh -> path (for logging)
        
        # Thread-safe read-ahead buffer for BROWSE MODE
        self._read_buffer = {}      # path -> {"data": bytes, "offset": int}
        self._read_locks = {}       # path -> threading.Lock()
        self._read_locks_lock = threading.Lock()
        
        # Track which files have had cache_file() triggered (copy mode)
        self._copy_started = set()  # paths that have been triggered for caching
        
        self.fd_count = 100
        
        # Staging wrappers for writes
        self._open_writes = {} # path -> StagingFileWriter
    
    # Threshold to switch from lightweight to full streaming pipeline.
    # Finder browsing reads < 100KB per file handle (type detection, thumbnails).
    # A real copy reads MB+ per file handle.
    _COPY_THRESHOLD = 128 * 1024  # 128KB
    
    # Read-ahead buffer size for browse mode
    _READAHEAD_SIZE = 4 * 1024 * 1024
        
    def _run_async(self, coro):
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return future.result()

    def _get_read_lock(self, path):
        """Get or create a threading.Lock for a given file path."""
        with self._read_locks_lock:
            if path not in self._read_locks:
                self._read_locks[path] = threading.Lock()
            return self._read_locks[path]

    def _is_ignored(self, path):
        name = Path(path).name
        # Ignore macOS metadata, spotlight, trash, etc
        if name.startswith("._") or name.startswith(".smb") or name.startswith(".Spotlight"):
            return True
        if name in [".DS_Store", ".Trash", ".Trashes", ".background", ".fseventsd", "Icon\r", "Desktop DB", "Desktop DF"]:
            return True
        return False

    def getattr(self, path, fh=None):
        path = unicodedata.normalize('NFC', path)
        if self._is_ignored(path):
            raise FuseOSError(errno.ENOENT)
            
        now = time.time()
        if path in self._cache and (now - self._cache_time.get(path, 0) < self.CACHETTL):
            return self._cache[path]
            
        if path == '/':
            st = dict(
                st_mode=(stat.S_IFDIR | 0o777),
                st_nlink=2,
                st_size=0,
                st_ctime=now,
                st_mtime=now,
                st_atime=now
            )
            self._cache[path] = st
            self._cache_time[path] = now
            return st

        # Check DB
        try:
            is_dir = self._run_async(self.fm.is_directory(path))
            if is_dir:
                st = dict(
                    st_mode=(stat.S_IFDIR | 0o777),
                    st_nlink=2,
                    st_size=0,
                    st_ctime=now,
                    st_mtime=now,
                    st_atime=now
                )
                self._cache[path] = st
                self._cache_time[path] = now
                return st
                
            file_meta = self._run_async(self.fm.get_file_meta(path))
            if file_meta:
                # modified_at timestamp
                mtime = now
                try:
                    mtime = file_meta.get('modified_at').timestamp()
                except:
                    pass
                st = dict(
                    st_mode=(stat.S_IFREG | 0o666),
                    st_nlink=1,
                    st_size=file_meta.get('size', 0),
                    st_ctime=mtime,
                    st_mtime=mtime,
                    st_atime=mtime
                )
                self._cache[path] = st
                self._cache_time[path] = now
                return st
                
            raise FuseOSError(errno.ENOENT)
        except FuseOSError:
            raise
        except Exception as e:
            logger.error(f"getattr error for {path}: {e}")
            raise FuseOSError(errno.ENOENT)

    def readdir(self, path, fh):
        path = unicodedata.normalize('NFC', path)
        yield '.'
        yield '..'
        
        try:
            items = self._run_async(self.fm.list_directory(path))
            now = time.time()
            for item in items:
                name = item['name']
                yield name
                
                # Pre-populate getattr cache to prevent Finder from querying every single file
                full_path = str(Path(path) / name) if path != '/' else f"/{name}"
                
                mtime = now
                try:
                    mtime = item.get('modified_at', now).timestamp()
                except:
                    pass
                    
                st = dict(
                    st_mode=(stat.S_IFDIR | 0o777) if item.get('is_directory') else (stat.S_IFREG | 0o666),
                    st_nlink=2 if item.get('is_directory') else 1,
                    st_size=item.get('size', 0),
                    st_ctime=mtime,
                    st_mtime=mtime,
                    st_atime=mtime
                )
                self._cache[full_path] = st
                self._cache_time[full_path] = now
                
        except Exception as e:
            logger.error(f"readdir error for {path}: {e}")

    # Read Operations
    def open(self, path, flags):
        path = unicodedata.normalize('NFC', path)
        self.fd_count += 1
        fh = self.fd_count
        # Initialize per-FH byte counter
        self._fh_bytes[fh] = 0
        self._fh_path[fh] = path
        return fh

    def _read_from_disk_cache(self, path, offset, length):
        """
        Try to read directly from the DownloadCache files on disk.
        Returns bytes if available, None if not yet cached.
        """
        import hashlib
        chunk_size = Config.CHUNK_SIZE_BYTES
        chunk_index = offset // chunk_size
        
        # Build the same cache key as DownloadCache._chunk_key
        path_hash = hashlib.md5(path.encode()).hexdigest()[:12]
        safe_name = path.replace("/", "_").strip("_")[:40]
        key = f"{safe_name}_{path_hash}_c{chunk_index}"
        
        chunk_path = Config.CACHE_DIR / f"{key}.chunk"
        temp_path = Config.CACHE_DIR / f"{key}.tmp"
        
        # Calculate offset within the chunk
        chunk_start_byte = chunk_index * chunk_size
        local_offset = offset - chunk_start_byte
        
        # Try completed chunk first
        if chunk_path.exists():
            try:
                with open(chunk_path, "rb") as f:
                    f.seek(local_offset)
                    data = f.read(length)
                    if data:
                        return data
            except Exception:
                pass
        
        # Try in-progress .tmp file (background download in progress)
        if temp_path.exists():
            try:
                file_size = temp_path.stat().st_size
                if file_size > local_offset:
                    with open(temp_path, "rb") as f:
                        f.seek(local_offset)
                        available = min(length, file_size - local_offset)
                        data = f.read(available)
                        if data:
                            return data
            except Exception:
                pass
        
        return None

    def _buffer_covers(self, path, offset, length):
        """Check if the read-ahead buffer covers the requested range."""
        buf = self._read_buffer.get(path)
        if not buf:
            return False
        buf_start = buf["offset"]
        buf_end = buf_start + len(buf["data"])
        return buf_start <= offset and offset + length <= buf_end

    def _read_from_buffer(self, path, offset, length):
        """Read from the in-memory buffer. Must be called after _buffer_covers() check."""
        buf = self._read_buffer[path]
        start = offset - buf["offset"]
        return buf["data"][start:start + length]

    def read(self, path, length, offset, fh):
        path = unicodedata.normalize('NFC', path)
        try:
            # Update per-FH byte counter
            self._fh_bytes[fh] = self._fh_bytes.get(fh, 0) + length
            is_copying = self._fh_bytes[fh] >= self._COPY_THRESHOLD
            
            # FAST PATH 1: Read from disk cache ("Available Offline" files)
            data = self._read_from_disk_cache(path, offset, length)
            if data:
                return data
            
            if is_copying:
                # ═══ COPY MODE: Background cache + poll .tmp files ═══
                # 1. Trigger cache_file() ONCE to start downloading all chunks
                # 2. Poll _read_from_disk_cache() until data appears in .tmp
                
                # Start background caching (only once per path)
                if path not in self._copy_started:
                    self._copy_started.add(path)
                    logger.info(f"🚀 FUSE copy detected: {Path(path).name} — activating background cache")
                    try:
                        self._run_async(self.fm.cache_file(path))
                    except Exception as e:
                        logger.error(f"Background cache trigger error: {e}")
                
                # Poll .tmp file until our data appears (background download writes to it)
                for _ in range(600):  # up to 30 seconds (600 × 50ms)
                    data = self._read_from_disk_cache(path, offset, length)
                    if data:
                        return data
                    time.sleep(0.05)
                
                # Fallback: direct fetch if polling times out
                logger.warning(f"FUSE copy poll timeout for {Path(path).name} at offset {offset}")
                data = self._run_async(
                    self.fm.get_file_bytes_direct(path, offset, length)
                )
                return data if data else b""
            else:
                # ═══ BROWSE MODE: Lightweight in-memory buffer (no caching) ═══
                # Finder is just probing for type/thumbnail. Use read-ahead buffer
                # to batch reads, but don't write anything to disk.
                
                # Check buffer first (no lock needed)
                if self._buffer_covers(path, offset, length):
                    return self._read_from_buffer(path, offset, length)
                
                # Acquire per-file lock (prevents parallel redundant downloads)
                lock = self._get_read_lock(path)
                with lock:
                    # Double-check after acquiring lock
                    if self._buffer_covers(path, offset, length):
                        return self._read_from_buffer(path, offset, length)
                    
                    # Fetch from Telegram with read-ahead
                    file_size = self._cache.get(path, {}).get("st_size", 0)
                    fetch_length = max(length, self._READAHEAD_SIZE)
                    if file_size > 0:
                        fetch_length = min(fetch_length, file_size - offset)
                    
                    data = self._run_async(
                        self.fm.get_file_bytes_direct(path, offset, fetch_length)
                    )
                    
                    if not data:
                        return b""
                    
                    # Store in buffer
                    self._read_buffer[path] = {
                        "data": data,
                        "offset": offset,
                    }
                    return data[:length]
        except Exception as e:
            logger.error(f"read error for {path}: {e}")
            raise FuseOSError(errno.EIO)


    # Write Operations
    def create(self, path, mode, fi=None):
        path = unicodedata.normalize('NFC', path)
        logger.debug(f"fuse create: {path}")
        self._cache.pop(path, None)
        
        # Create staging file
        safe_name = f"ul_{hash(path)}_{int(time.time())}.tmp"
        staging_path = Config.STAGING_DIR / safe_name
        staging_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Create the file locally so we have a handle
        fh = os.open(str(staging_path), os.O_WRONLY | os.O_CREAT, mode)
        self._open_writes[path] = {"fd": fh, "staging_path": staging_path}
        return 0

    def write(self, path, buf, offset, fh):
        path = unicodedata.normalize('NFC', path)
        if path not in self._open_writes:
            logger.error(f"write error: {path} not open for writing")
            raise FuseOSError(errno.EIO)
            
        fd = self._open_writes[path]["fd"]
        os.lseek(fd, offset, os.SEEK_SET)
        return os.write(fd, buf)

    def flush(self, path, fh):
        path = unicodedata.normalize('NFC', path)
        if path in self._open_writes:
            os.fsync(self._open_writes[path]["fd"])
        return 0

    def release(self, path, fh):
        path = unicodedata.normalize('NFC', path)
        logger.debug(f"fuse release: {path}")
        # Clean up per-FH tracking, buffers, and streaming state
        self._fh_bytes.pop(fh, None)
        self._fh_path.pop(fh, None)
        self._read_buffer.pop(path, None)
        self._copy_started.discard(path)
        if path in self._open_writes:
            write_info = self._open_writes.pop(path)
            os.close(write_info["fd"])
            
            staging_path = write_info["staging_path"]
            
            if self._is_ignored(path):
                logger.debug(f"Ignoring upload for macOS metadata file: {path}")
                if staging_path.exists():
                    staging_path.unlink()
            else:
                # Start Background upload
                logger.info(f"📤 FUSE: Queueing background upload for {path}")
                
                async def background_upload():
                    try:
                        await self.fm.upload_file(staging_path, path)
                        logger.info(f"✅ FUSE: Uploaded {path}")
                    except Exception as e:
                        logger.error(f"❌ FUSE: Upload failed for {path} - {e}")
                    finally:
                        if staging_path.exists():
                            staging_path.unlink()
                            
                # Fire and forget
                asyncio.run_coroutine_threadsafe(background_upload(), self.loop)
        
        self._cache.pop(path, None)
        
        # Parent directory cache invalidation
        parent = str(Path(path).parent)
        if parent == '.': parent = '/'
        self._cache.pop(parent, None)
        return 0

    # Modify operations
    def mkdir(self, path, mode):
        path = unicodedata.normalize('NFC', path)
        logger.debug(f"fuse mkdir: {path}")
        self._cache.pop(path, None)
        parent = str(Path(path).parent)
        if parent == '.': parent = '/'
        self._cache.pop(parent, None)
        
        try:
            self._run_async(self.fm.create_directory(path))
        except Exception as e:
            logger.error(f"mkdir error: {e}")
            raise FuseOSError(errno.EIO)
        return 0

    def rmdir(self, path):
        path = unicodedata.normalize('NFC', path)
        logger.debug(f"fuse rmdir: {path}")
        self._cache.pop(path, None)
        parent = str(Path(path).parent)
        if parent == '.': parent = '/'
        self._cache.pop(parent, None)
        
        try:
            success = self._run_async(self.fm.delete_directory(path))
            if not success:
                raise FuseOSError(errno.ENOTEMPTY)
        except FuseOSError:
            raise
        except Exception as e:
            logger.error(f"rmdir error: {e}")
            raise FuseOSError(errno.EIO)

    def unlink(self, path):
        path = unicodedata.normalize('NFC', path)
        logger.debug(f"fuse unlink: {path}")
        self._cache.pop(path, None)
        parent = str(Path(path).parent)
        if parent == '.': parent = '/'
        self._cache.pop(parent, None)
        
        try:
            self._run_async(self.fm.delete_file(path))
        except Exception as e:
            logger.error(f"unlink error: {e}")
            raise FuseOSError(errno.EIO)

    def rename(self, old, new):
        old = unicodedata.normalize('NFC', old)
        new = unicodedata.normalize('NFC', new)
        logger.debug(f"fuse rename: {old} -> {new}")
        import pymongo
        
        # Invalidate caches
        for p in [old, new, str(Path(old).parent), str(Path(new).parent)]:
            if p == '.': p = '/'
            self._cache.pop(p, None)
            
        try:
            self._run_async(self.fm.rename(old, new))
        except pymongo.errors.DuplicateKeyError:
            raise FuseOSError(errno.EEXIST)
        except Exception as e:
            logger.error(f"rename error: {e}")
            raise FuseOSError(errno.EIO)

    # Ignore extended attributes for optimal macOS performance with remote storage
    def getxattr(self, path, name, position=0):
        return b''
    def listxattr(self, path):
        return []
    def removexattr(self, path, name):
        return 0
    def setxattr(self, path, name, value, options, position=0):
        return 0

def mount_fuse_drive(file_manager, loop):
    """Mounts the TCloud_Drive using FUSE-T in a blocking manner."""
    mount_point = Path.home() / "TCloud_Drive"
    
    # Ensure mount point exists
    mount_point.mkdir(parents=True, exist_ok=True)
    
    # We first try to ensure it's not already mounted or stale
    os.system(f"umount '{mount_point}' 2>/dev/null")
    
    logger.info(f"🚀 FUSE-T: Mounting native macOS drive at {mount_point}...")
    
    try:
        FUSE(
            TCloudFUSE(file_manager, loop), 
            str(mount_point), 
            nothreads=False, 
            foreground=True, 
            allow_other=True,
            volname="TCloud"
        )
    except Exception as e:
        logger.error(f"❌ FUSE-T Mount failed: {e}")
