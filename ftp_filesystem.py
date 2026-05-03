"""
TCloud - FTP Virtual Filesystem
Custom pyftpdlib AbstractedFS that maps FTP operations to MongoDB-backed virtual filesystem.
"""

import asyncio
import errno
import io
import logging
import os
import stat
import time
from datetime import datetime, timezone
from pathlib import Path

from pyftpdlib.filesystems import AbstractedFS

from config import Config
from file_manager import FileManager

logger = logging.getLogger("tcloud.ftp_fs")


def _run_async(coro, loop):
    """
    Run an async coroutine from a synchronous context (thread),
    scheduling it on the main event loop.
    """
    import concurrent.futures
    
    if not loop:
         # Fallback for testing or if loop not provided (shouldn't happen in prod)
         return asyncio.run(coro)

    future = asyncio.run_coroutine_threadsafe(coro, loop)
    try:
        # Increase timeout for large files (1 hour)
        return future.result(timeout=3600)
    except concurrent.futures.TimeoutError:
        raise OSError(errno.ETIMEDOUT, "Operation timed out")
    except Exception as e:
        # Unwrap the exception if possible
        raise e


class VirtualStat:
    """
    A stat-like object for virtual files/directories.
    Compatible with what pyftpdlib expects from os.stat().
    """

    def __init__(self, size=0, is_dir=False, mtime=None, ctime=None):
        now = time.time()
        self.st_mode = (stat.S_IFDIR | 0o755) if is_dir else (stat.S_IFREG | 0o644)
        self.st_ino = 0
        self.st_dev = 0
        self.st_nlink = 2 if is_dir else 1
        self.st_uid = os.getuid() if hasattr(os, "getuid") else 0
        self.st_gid = os.getgid() if hasattr(os, "getgid") else 0
        self.st_size = size
        self.st_atime = mtime or now
        self.st_mtime = mtime or now
        self.st_ctime = ctime or now

    def __getitem__(self, index):
        """Allow indexed access like a tuple (for compatibility)."""
        attrs = [
            self.st_mode, self.st_ino, self.st_dev, self.st_nlink,
            self.st_uid, self.st_gid, self.st_size,
            self.st_atime, self.st_mtime, self.st_ctime,
        ]
        return attrs[index]


class TCloudFilesystem(AbstractedFS):
    """
    Virtual filesystem abstraction for pyftpdlib.
    Routes all FS operations to the TCloud FileManager (MongoDB + Telegram).
    """

    def __init__(self, root: str, cmd_channel):
        self._file_manager: FileManager = cmd_channel.server.file_manager
        # Get the main event loop attached to the server
        self._loop = getattr(cmd_channel.server, "loop", None)
        self._root = "/"
        self._cwd = "/"
        self.cmd_channel = cmd_channel  # Public for AbstractedFS compatibility

    @property
    def root(self):
        return self._root

    @root.setter
    def root(self, value):
        self._root = "/"

    @property
    def cwd(self):
        return self._cwd

    @cwd.setter
    def cwd(self, path):
        self._cwd = self._normalize(path)

    # ===================== PATH RESOLUTION =====================

    def _normalize(self, path: str) -> str:
        """Normalize a virtual path."""
        if not path:
            return self._cwd

        # Make absolute
        if not path.startswith("/"):
            if self._cwd == "/":
                path = "/" + path
            else:
                path = self._cwd + "/" + path

        # Resolve . and ..
        parts = []
        for part in path.split("/"):
            if part == "" or part == ".":
                continue
            elif part == "..":
                if parts:
                    parts.pop()
            else:
                parts.append(part)

        result = "/" + "/".join(parts)
        return result

    def ftp2fs(self, ftppath: str) -> str:
        """Convert FTP path to internal virtual path."""
        return self._normalize(ftppath)

    def fs2ftp(self, fspath: str) -> str:
        """Convert internal path to FTP path."""
        return fspath if fspath else "/"

    def validpath(self, path: str) -> bool:
        """Check if path is valid (always true for virtual FS)."""
        return True

    # ===================== DIRECTORY OPERATIONS =====================

    def isdir(self, path: str) -> bool:
        """Check if path is a directory."""
        path = self._normalize(path)
        return _run_async(self._file_manager.is_directory(path), self._loop)

    def isfile(self, path: str) -> bool:
        """Check if path is a file."""
        path = self._normalize(path)
        return _run_async(self._file_manager.is_file(path), self._loop)

    def lexists(self, path: str) -> bool:
        """Check if path exists."""
        path = self._normalize(path)
        return _run_async(self._file_manager.exists(path), self._loop)

    def chdir(self, path: str) -> None:
        """Change current working directory."""
        path = self._normalize(path)
        if not _run_async(self._file_manager.is_directory(path), self._loop):
            raise OSError(f"Not a directory: {path}")
        self._cwd = path

    def mkdir(self, path: str) -> None:
        """Create a directory."""
        path = self._normalize(path)
        _run_async(self._file_manager.create_directory(path), self._loop)
        logger.info(f"📁 MKD: {path}")

    def rmdir(self, path: str) -> None:
        """Remove a directory."""
        path = self._normalize(path)
        success = _run_async(self._file_manager.delete_directory(path), self._loop)
        if not success:
            raise OSError(f"Cannot remove directory: {path}")
        logger.info(f"🗑️ RMD: {path}")

    def listdir(self, path: str) -> list[str]:
        """List directory contents."""
        path = self._normalize(path)
        logger.debug(f"📂 LIST: {path}")
        items = _run_async(self._file_manager.list_directory(path), self._loop)
        names = [item["name"] for item in items]
        logger.debug(f"   -> Found {len(names)} items in {path}")
        return names

    def listdirinfo(self, path: str) -> list[str]:
        """List directory with detailed info."""
        return self.listdir(path)

    # ===================== FILE OPERATIONS =====================

    def stat(self, path: str):
        """Get file/directory stat information."""
        path = self._normalize(path)

        # Check directory
        if _run_async(self._file_manager.is_directory(path), self._loop):
            return VirtualStat(size=0, is_dir=True)

        # Check file
        file_info = _run_async(self._file_manager.get_file_info(path), self._loop)
        if file_info:
            mtime = file_info.get("modified_at")
            if isinstance(mtime, datetime):
                mtime = mtime.timestamp()
            ctime = file_info.get("created_at")
            if isinstance(ctime, datetime):
                ctime = ctime.timestamp()
            return VirtualStat(
                size=file_info.get("size", 0),
                is_dir=False,
                mtime=mtime,
                ctime=ctime,
            )

        raise OSError(f"No such file or directory: {path}")

    lstat = stat

    def getsize(self, path: str) -> int:
        """Get file size."""
        st = self.stat(path)
        return st.st_size

    def getmtime(self, path: str) -> float:
        """Get file modification time."""
        st = self.stat(path)
        return st.st_mtime

    def islink(self, path: str) -> bool:
        """Symlinks not supported."""
        return False

    def readlink(self, path: str) -> str:
        """Symlinks not supported."""
        raise OSError("Symlinks not supported")

    def remove(self, path: str) -> None:
        """Delete a file."""
        path = self._normalize(path)
        success = _run_async(self._file_manager.delete_file(path), self._loop)
        if not success:
            raise OSError(f"Cannot delete: {path}")
        logger.info(f"🗑️ DELE: {path}")

    def rename(self, src: str, dst: str) -> None:
        """Rename a file or directory."""
        src = self._normalize(src)
        dst = self._normalize(dst)
        success = _run_async(self._file_manager.rename(src, dst), self._loop)
        if not success:
            raise OSError(f"Cannot rename: {src} -> {dst}")
        logger.info(f"📝 RNTO: {src} -> {dst}")

    def chmod(self, path: str, mode) -> None:
        """No-op for virtual filesystem."""
        pass

    def utime(self, path: str, timeval) -> None:
        """No-op for virtual filesystem."""
        pass

    def mkstemp(self, suffix="", prefix="", dir=None, mode="wb"):
        """Create a temp file in staging for upload."""
        staging = Config.STAGING_DIR
        staging.mkdir(parents=True, exist_ok=True)

        import tempfile
        fd, temp_path = tempfile.mkstemp(
            suffix=suffix, prefix=prefix, dir=str(staging)
        )
        os.close(fd)
        return temp_path

    # ===================== FILE I/O =====================

    def open(self, filename: str, mode: str):
        """
        Open a file. For reading: download from Telegram to staging (streaming).
        For writing: create a staging file.
        """
        virtual_path = self._normalize(filename)

        if "r" in mode or mode == "rb":
            # Download from Telegram to staging
            # Use a unique name to allow concurrent downloads of same file
            staging_path = Config.STAGING_DIR / f"dl_{hash(virtual_path)}_{int(time.time())}"
            
            # Start download in background task on the main loop
            task = asyncio.run_coroutine_threadsafe(
                self._file_manager.download_file(virtual_path, staging_path),
                self._loop
            )

            # Return a wrapper that reads as the file downloads
            return StagingFileReader(staging_path, virtual_path, task)

        elif "w" in mode or "a" in mode or mode == "wb":
            # Create staging file for upload
            staging_path = Config.STAGING_DIR / f"ul_{hash(virtual_path)}_{int(time.time())}"
            staging_path.parent.mkdir(parents=True, exist_ok=True)

            return StagingFileWriter(
                staging_path, virtual_path, self._file_manager, self._loop
            )

        raise OSError(f"Unsupported file mode: {mode}")

    def get_user_by_uid(self, uid):
        """Return username for uid."""
        return "tcloud"

    def get_group_by_gid(self, gid):
        """Return group name for gid."""
        return "tcloud"

    def format_facts(self, path, facts_list):
        """Return MLSD facts for a path."""
        path = self._normalize(path)
        result = {}
        st = None

        try:
            st = self.stat(path)
        except OSError:
            return result

        for fact in facts_list:
            fact_lower = fact.lower()
            if fact_lower == "type":
                if stat.S_ISDIR(st.st_mode):
                    result["type"] = "dir"
                else:
                    result["type"] = "file"
            elif fact_lower == "size":
                result["size"] = str(st.st_size)
            elif fact_lower == "modify":
                result["modify"] = time.strftime(
                    "%Y%m%d%H%M%S", time.gmtime(st.st_mtime)
                )
            elif fact_lower == "create":
                result["create"] = time.strftime(
                    "%Y%m%d%H%M%S", time.gmtime(st.st_ctime)
                )
            elif fact_lower == "perm":
                if stat.S_ISDIR(st.st_mode):
                    result["perm"] = "cdeflmp"
                else:
                    result["perm"] = "adfrw"
            elif fact_lower == "unique":
                result["unique"] = str(hash(path))

        return result


class StagingFileReader:
    """
    File-like object for reading a downloaded file from staging.
    Supports lazy reading (waits for data) to allow streaming.
    Cleans up the staging file on close.
    """

    def __init__(self, staging_path: Path, virtual_path: str, task=None):
        self._staging_path = staging_path
        self._virtual_path = virtual_path
        self._task = task
        self._file = None
        self._closed = False

    @property
    def closed(self):
        return self._closed

    @property
    def name(self):
        return self._virtual_path

    def read(self, size=-1):
        # Open file if not yet open
        if not self._file:
             # Wait for file creation (FileManager.download_file touches it immediately)
             wait_count = 0
             while not self._staging_path.exists():
                 if self._task and self._task.done():
                     # Task failed or finished?
                     try:
                         self._task.result()
                     except Exception as e:
                         raise IOError(f"Download start failed: {e}")
                     break
                 
                 time.sleep(0.1)
                 wait_count += 1
                 if wait_count > 100: # 10s wait for start
                      raise IOError("Timeout waiting for download start")
             
             if self._staging_path.exists():
                 self._file = open(self._staging_path, "rb")

        if not self._file:
            return b"" 

        # Read loop
        while True:
            data = self._file.read(size)
            if data:
                return data
            
            # EOF reached? Check if task is done.
            if self._task and not self._task.done():
                # Task still writing, wait for more data
                time.sleep(0.1)
                continue
            
            # Task done, check for errors
            if self._task:
                 try:
                     self._task.result()
                 except Exception as e:
                     raise IOError(f"Download failed: {e}")
            
            return b""

    def readline(self):
        # Simplistic implementation calling read
        # Not optimized for huge lines but FTP binary mode relies on read(size)
        return self._file.readline() if self._file else b""

    def seek(self, offset, whence=0):
        if not self._file:
             # Force open if seeking
             self.read(0)
        return self._file.seek(offset, whence)

    def tell(self):
        return self._file.tell() if self._file else 0

    def close(self):
        if self._closed:
            return
        self._closed = True
        if self._file:
            self._file.close()
        
        # We might want to cancel the task if closed early?
        # But we want to cleanup buffer.
        # Ideally, wait for task to finish or cancel?
        # For now, let it finish or error out.
        
        try:
            if self._staging_path.exists():
                self._staging_path.unlink()
        except OSError:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class StagingFileWriter:
    """
    File-like object for writing to staging, then uploading to Telegram on close.
    """

    def __init__(
        self, staging_path: Path, virtual_path: str, file_manager: FileManager, loop
    ):
        self._staging_path = staging_path
        self._virtual_path = virtual_path
        self._file_manager = file_manager
        self._loop = loop
        self._file = open(staging_path, "wb")
        self._closed = False

    @property
    def closed(self):
        return self._closed

    @property
    def name(self):
        return self._virtual_path

    def write(self, data):
        return self._file.write(data)

    def seek(self, offset, whence=0):
        return self._file.seek(offset, whence)

    def tell(self):
        return self._file.tell()

    def close(self):
        if self._closed:
            return
        self._closed = True
        self._file.close()

        # Upload to Telegram
        try:
            if self._staging_path.exists() and self._staging_path.stat().st_size > 0:
                _run_async(
                    self._file_manager.upload_file(
                        self._staging_path, self._virtual_path
                    ),
                    self._loop
                )
        except Exception as e:
            logger.error(f"❌ Upload failed on close: {e}")
        finally:
            try:
                self._staging_path.unlink()
            except OSError:
                pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
