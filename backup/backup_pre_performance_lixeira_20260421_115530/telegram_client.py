"""
TCloud - Telegram Client Manager
Manages multiple Telegram bot connections using Telethon for file upload/download.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from itertools import cycle

from telethon import TelegramClient, functions, types
from telethon.errors import FloodWaitError

from config import Config

logger = logging.getLogger("tcloud.telegram")


class TelegramManager:
    """
    Manages multiple Telegram bot clients with round-robin load distribution.
    Handles file upload, download, and deletion from a Telegram channel.
    """

    def __init__(self):
        self._clients: list[TelegramClient] = []
        self._client_cycle = None
        self._connected = False

    async def start(self) -> None:
        """Initialize and connect all bot clients."""
        sessions_dir = Config.BASE_DIR / "sessions"
        sessions_dir.mkdir(exist_ok=True)

        for i, token in enumerate(Config.BOT_TOKENS):
            session_path = str(sessions_dir / f"bot_{i}")
            client = TelegramClient(
                session_path,
                Config.API_ID,
                Config.API_HASH,
            )
            await client.start(bot_token=token)

            me = await client.get_me()
            logger.info(f"✅ Bot {i} connected: @{me.username}")
            self._clients.append(client)

        if not self._clients:
            raise RuntimeError("No Telegram bot clients were initialized.")

        self._client_cycle = cycle(self._clients)
        self._connected = True
        logger.info(f"🤖 {len(self._clients)} bot(s) ready")

    async def stop(self) -> None:
        """Disconnect all bot clients gracefully."""
        for client in self._clients:
            try:
                await client.disconnect()
            except Exception as e:
                logger.warning(f"Error disconnecting client: {e}")
        self._clients.clear()
        self._connected = False
        logger.info("🔌 All Telegram clients disconnected")

    @property
    def bot_count(self) -> int:
        """Number of connected bot clients."""
        return len(self._clients)

    async def ensure_connection(self, client: TelegramClient) -> None:
        """Ensure the given client is connected, attempting reconnection if not."""
        if not client.is_connected():
            logger.info("🔌 Telegram client disconnected, attempting reconnection...")
            try:
                await client.connect()
                logger.info("✅ Telegram client reconnected successfully")
            except Exception as e:
                logger.error(f"❌ Failed to reconnect Telegram client: {e}")
                # We don't raise here, method calling this will fail anyway
                # but at least we tried.

    def _next_client(self) -> TelegramClient:
        """Get the next client in round-robin order."""
        if not self._client_cycle:
            raise RuntimeError("Telegram clients not started")
        return next(self._client_cycle)

    def _get_client_by_index(self, index: int) -> TelegramClient:
        """Get a specific client by index (for pinning a bot to a file_id)."""
        if not self._clients:
            raise RuntimeError("Telegram clients not started")
        return self._clients[index % len(self._clients)]

    async def upload_file(self, file_path: str | Path, filename: str | None = None, thumb: str | Path | None = None, progress_callback=None) -> int:
        """
        Upload a file to the Telegram channel.

        Args:
            file_path: Path to the local file to upload.
            filename: Optional display name for the file.
            thumb: Optional path to thumbnail image.
            progress_callback: Optional callback(current, total) for progress tracking.

        Returns:
            message_id of the uploaded file message.
        """
        file_path = Path(file_path)
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        display_name = filename or file_path.name
        file_size = file_path.stat().st_size
        logger.info(f"📤 Uploading: {display_name} ({file_size / 1024 / 1024:.1f} MB) thumb={thumb}")

        for attempt in range(1, Config.MAX_RETRIES + 1):
            client = self._next_client()
            try:
                uploaded_file = await client.upload_file(
                    str(file_path),
                    file_name=display_name,
                    progress_callback=progress_callback,
                )
                message = await client.send_file(
                    Config.CHAT_ID,
                    uploaded_file,
                    caption=None,
                    thumb=str(thumb) if thumb else None,
                    force_document=True,
                )
                logger.info(
                    f"✅ Uploaded: {display_name} -> msg_id={message.id} "
                    f"(attempt {attempt})"
                )
                return message.id

            except FloodWaitError as e:
                wait_time = e.seconds + 1
                logger.warning(
                    f"⏳ FloodWait: waiting {wait_time}s (attempt {attempt}/{Config.MAX_RETRIES})"
                )
                await asyncio.sleep(wait_time)

            except Exception as e:
                logger.error(
                    f"❌ Upload error (attempt {attempt}/{Config.MAX_RETRIES}): {e}"
                )
                if attempt < Config.MAX_RETRIES:
                    backoff = min(2 ** attempt, 30)
                    logger.info(f"⏳ Retrying in {backoff}s...")
                    await asyncio.sleep(backoff)
                else:
                    raise RuntimeError(
                        f"Failed to upload {display_name} after {Config.MAX_RETRIES} attempts"
                    ) from e

        raise RuntimeError("Upload failed: exhausted all retries")

    async def download_file(self, message_id: int, dest_path: str | Path) -> Path:
        # Download a file from a Telegram channel message.
        dest_path = Path(dest_path)
        dest_path.parent.mkdir(parents=True, exist_ok=True)

        logger.info(f"📥 Downloading msg_id={message_id} -> {dest_path}")

        for attempt in range(1, Config.MAX_RETRIES + 1):
            client = self._next_client()
            try:
                messages = await client.get_messages(Config.CHAT_ID, ids=message_id)
                if not messages or not messages.media:
                    raise FileNotFoundError(
                        f"Message {message_id} not found or has no media"
                    )

                await client.download_media(messages, file=str(dest_path))
                logger.info(f"✅ Downloaded: msg_id={message_id}")
                return dest_path

            except FloodWaitError as e:
                wait_time = e.seconds + 1
                logger.warning(
                    f"⏳ FloodWait: waiting {wait_time}s (attempt {attempt}/{Config.MAX_RETRIES})"
                )
                await asyncio.sleep(wait_time)

            except FileNotFoundError:
                raise

            except Exception as e:
                logger.error(
                    f"❌ Download error (attempt {attempt}/{Config.MAX_RETRIES}): {e}"
                )
                if attempt < Config.MAX_RETRIES:
                    backoff = min(2 ** attempt, 30)
                    await asyncio.sleep(backoff)
                else:
                    raise RuntimeError(
                        f"Failed to download msg_id={message_id} after {Config.MAX_RETRIES} attempts"
                    ) from e

        raise RuntimeError("Download failed: exhausted all retries")

    async def download_range(self, message_id: int, offset: int, limit: int) -> bytes:
        # Download a specific byte range from a message using raw GetFileRequest.
        # This avoids Telethon's high-level logic which causes LimitInvalidError on seeking.
        from telethon.tl.functions.upload import GetFileRequest
        from telethon.tl.types import InputDocumentFileLocation
        from telethon import utils

        client = self._next_client()
        await self.ensure_connection(client)
        messages = await client.get_messages(Config.CHAT_ID, ids=[message_id])
        if not messages or not messages[0] or not messages[0].media:
            raise ValueError(f"Message {message_id} not found or has no media")
            
        media = messages[0].media
        # Handle regular documents/videos
        if hasattr(media, 'document'):
            location = utils.get_input_location(media.document)
        elif hasattr(media, 'photo'):
             location = utils.get_input_location(media.photo)
        else:
             raise ValueError(f"Unsupported media type: {type(media)}")

        # utils.get_input_location might return (dc_id, location) tuple in some versions
        if isinstance(location, tuple):
            # Log for confirmation (can remove later)
            # logger.info(f"DEBUG: location is tuple: {location}")
            location = location[1]

        # Raw API call
        # offset: bytes
        # limit: bytes (must be aligned to 4KB, max 1MB usually)
        # We use 128KB in file_manager, which is valid.
        
        try:
            # Telethon 1.x GetFileRequest typically supports precise and cdn_supported
            # We must pass arguments by keyword to be safe.
            # TLObject error often means response mismatch.
            # precise=True allows requesting arbitrary offsets?
            # Actually, precise=True is for when you want exact byte ranges?
            
            result = await client(GetFileRequest(
                location=location,
                offset=offset,
                limit=limit,
                precise=True,
                cdn_supported=False
            ))
            return result.bytes
        except Exception as e:
            # If TLObject error, logging details is crucial
            import traceback
            logger.error(f"GetFileRequest ERROR: offset={offset}, limit={limit}, location={location}")
            logger.error(traceback.format_exc())
            
            # Fallback for TLObject error? 
            # If server sent FileCdnRedirect, Telethon user methods handle it. 
            # Raw invoke does NOT.
            # But handling CDN is complex. 
            # Let's hope it's just a parameter issue.
            raise RuntimeError(f"GetFileRequest failed: {e}") from e

    async def download_thumbnail(self, message_id: int) -> bytes | None:
        """Download thumbnail from a message (if exists)."""
        client = self._next_client()
        try:
            logger.info(f"🔍 Fetching thumb for msg_id={message_id}")
            messages = await client.get_messages(Config.CHAT_ID, ids=[message_id])
            if not messages or not messages[0]:
                logger.warning(f"❌ Message {message_id} not found")
                return None
            
            msg = messages[0]
            
            # Try to download thumb directly without checking .thumb property
            # (Some Telethon versions don't have .thumb helper on Message)
            try:
                data = await client.download_media(msg, file=bytes, thumb=-1)
                if data:
                    logger.info(f"✅ Downloaded thumb: {len(data)} bytes")
                    return data
                else:
                    logger.warning(f"⚠️ download_media returned empty for thumb")
                    return None
            except Exception as e:
                logger.warning(f"Failed to download media thumb: {e}")
                return None

        except Exception as e:
            logger.warning(f"❌ Error downloading thumbnail for {message_id}: {e}")
            return None

    async def iter_download(self, message_id: int, offset: int = 0, limit: int = None, file_size: int = None):
        # Yield file content chunks from Telegram message.
        # Useful for streaming large files without loading entirely into memory.
        client = self._next_client()
        await self.ensure_connection(client)
        
        # Get message first
        messages = await client.get_messages(Config.CHAT_ID, ids=[message_id])
        if not messages or not messages[0]:
            raise ValueError(f"Message {message_id} not found")

        # Telegram API STRICTLY requires offset and limit to be multiples of 512KB (524288) or 1MB (1048576)
        # The FUSE driver might request arbitrary bytes like offset=32768
        CHUNK_ALIGN = 512 * 1024
        
        # Calculate aligned offset (round down to nearest multiple of 512KB)
        aligned_offset = (offset // CHUNK_ALIGN) * CHUNK_ALIGN
        
        # Calculate how many bytes to skip from the start of the aligned chunk
        skip_bytes = offset - aligned_offset
        
        kwargs = {"offset": aligned_offset}
        
        if limit is not None:
            # We want `limit` bytes, but we have to read `skip_bytes` first.
            # So we need at least `skip_bytes + limit` bytes from Telegram.
            # Round up the requested bytes to the nearest 512KB boundary.
            needed_bytes = skip_bytes + limit
            aligned_limit = ((needed_bytes + CHUNK_ALIGN - 1) // CHUNK_ALIGN) * CHUNK_ALIGN
            kwargs["limit"] = aligned_limit

        try:
            bytes_yielded = 0
            total_skipped = 0
            
            async for chunk in client.iter_download(messages[0], **kwargs):
                if total_skipped < skip_bytes:
                    # We are still skipping the unaligned prefix
                    chunk_len = len(chunk)
                    if total_skipped + chunk_len <= skip_bytes:
                        total_skipped += chunk_len
                        continue
                    else:
                        # We skip a portion of this chunk
                        skip_in_this_chunk = skip_bytes - total_skipped
                        chunk = chunk[skip_in_this_chunk:]
                        total_skipped += skip_in_this_chunk
                
                # Now we are in the requested byte range
                if limit is not None:
                    remaining = limit - bytes_yielded
                    if remaining <= 0:
                        break
                    
                    if len(chunk) > remaining:
                        yield chunk[:remaining]
                        bytes_yielded += remaining
                        break
                
                yield chunk
                bytes_yielded += len(chunk)
                
        except Exception as e:
            logger.error(f"Telegram iter_download error: {e}", exc_info=True)
            raise e

    async def delete_file(self, message_id: int) -> bool:
        # Delete a file message from the Telegram channel.
        # Args:
        #     message_id: The message ID to delete.
        # Returns:
        #     True if deleted successfully.
        client = self._next_client()
        try:
            await client.delete_messages(Config.CHAT_ID, message_id)
            logger.info(f"🗑️ Deleted: msg_id={message_id}")
            return True
        except Exception as e:
            logger.error(f"❌ Error deleting msg_id={message_id}: {e}")
            return False

    async def delete_files(self, message_ids: list[int]) -> bool:
        # Delete multiple file messages from the channel.
        if not message_ids:
            return True

        client = self._next_client()
        try:
            await client.delete_messages(Config.CHAT_ID, message_ids)
            logger.info(f"🗑️ Deleted {len(message_ids)} messages")
            return True
        except Exception as e:
            logger.error(f"❌ Error deleting messages: {e}")
            return False

    async def forward_messages(self, message_ids: list[int]) -> list[int]:
        """
        Forward messages to the channel to duplicate them (get new IDs).
        
        Args:
            message_ids: List of message IDs to forward.
            
        Returns:
            List of new message IDs.
        """
        if not message_ids:
            return []

        client = self._next_client()
        try:
            # We forward to the same chat to duplicate content
            new_messages = await client.forward_messages(Config.CHAT_ID, message_ids, from_peer=Config.CHAT_ID)
            
            # Ensure we return a list of IDs even if single message
            if not isinstance(new_messages, list):
                new_messages = [new_messages]
            
            # Extract IDs, handling potential None (if forward failed)
            new_ids = [m.id for m in new_messages if m]
            logger.info(f"⏩ Forwarded {len(message_ids)} messages -> {len(new_ids)} new messages")
            return new_ids
        except Exception as e:
            logger.error(f"❌ Error forwarding messages: {e}")
            raise e

    async def save_file_part(self, file_id: int, index: int, total_parts: int, data: bytes, file_size: int = 0, client_index: int = -1) -> bool:
        """
        Upload a single part of a file using low-level API.
        Uses SaveFilePartRequest for files <=10MB, SaveBigFilePartRequest for larger.
        client_index: if >= 0, pin to specific bot; otherwise use round-robin.
        """
        is_big = file_size > 10 * 1024 * 1024
        for attempt in range(1, Config.MAX_RETRIES + 1):
            client = self._get_client_by_index(client_index) if client_index >= 0 else self._next_client()
            try:
                if is_big:
                    await client(functions.upload.SaveBigFilePartRequest(
                        file_id=file_id,
                        file_part=index,
                        file_total_parts=total_parts,
                        bytes=data
                    ))
                else:
                    await client(functions.upload.SaveFilePartRequest(
                        file_id=file_id,
                        file_part=index,
                        bytes=data
                    ))
                return True
            except FloodWaitError as e:
                await asyncio.sleep(e.seconds + 1)
            except Exception as e:
                logger.warning(f"Part {index} upload failed (attempt {attempt}): {e}")
                if attempt == Config.MAX_RETRIES:
                    raise
                await asyncio.sleep(1)

    async def finish_upload(self, file_id: int, filename: str, total_parts: int, file_size: int = 0, thumb: str | Path | None = None, client_index: int = -1) -> int:
        """
        Finalize the upload and send the message.
        Uses InputFile for small files (<=10MB) and InputFileBig for larger files.
        client_index: if >= 0, pin to specific bot; otherwise use round-robin.
        """
        client = self._get_client_by_index(client_index) if client_index >= 0 else self._next_client()
        try:
            # Telegram requires InputFile for small files, InputFileBig for large
            if file_size > 10 * 1024 * 1024:
                input_file = types.InputFileBig(
                    id=file_id,
                    parts=total_parts,
                    name=filename
                )
            else:
                input_file = types.InputFile(
                    id=file_id,
                    parts=total_parts,
                    name=filename,
                    md5_checksum=""
                )
            
            message = await client.send_file(
                Config.CHAT_ID,
                input_file,
                caption=None,
                thumb=str(thumb) if thumb else None,
                force_document=True
            )
            logger.info(f"✅ Finished upload: {filename} -> msg_id={message.id}")
            return message.id
            
        except Exception as e:
            logger.error(f"❌ Finish upload error: {e}")
            raise
