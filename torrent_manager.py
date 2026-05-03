import os
import re
import json
import uuid
import time
import shutil
import asyncio
import logging
import math
from typing import Dict, Any, List, Optional
from config import Config

logger = logging.getLogger("TorrentManager")

class TorrentInfoError(Exception):
    def __init__(self, message: str, payload: Optional[Dict[str, Any]] = None, status: int = 500):
        super().__init__(message)
        self.payload = payload or {"error": message}
        self.status = status

class TorrentManager:
    def __init__(self, file_manager):
        self.file_manager = file_manager
        self.active_torrents: Dict[str, Dict[str, Any]] = {}
        self.tmp_dir = os.path.join(Config.CACHE_DIR, "torrents")
        os.makedirs(self.tmp_dir, exist_ok=True)

    async def get_info(self, magnet_or_file: str) -> Dict[str, Any]:
        """Runs the custom node script to get the file list."""
        cache_dir = str(Config.CACHE_DIR)
        cmd = ["node", "get_torrent_info.mjs", magnet_or_file, cache_dir]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()
        stdout_text = stdout.decode('utf-8', errors='replace').strip()
        stderr_text = stderr.decode('utf-8', errors='replace').strip()
        
        stdout_payload = self._extract_node_json(stdout_text)
        if process.returncode != 0:
            if stdout_payload and stdout_payload.get("files") and stdout_payload.get("infoHash"):
                logger.warning(
                    "Torrent info helper returned metadata despite non-zero exit. "
                    f"Using stdout payload and preserving diagnostics in logs: {stderr_text}"
                )
                return stdout_payload
            payload = self._extract_node_json(stderr_text) or stdout_payload or {}
            error_msg = payload.get("error") or "Falha ao obter metadados do torrent"
            if payload.get("code") == "metadata_timeout":
                error_msg = (
                    "Não foi possível obter os metadados do torrent neste servidor dentro do tempo limite. "
                    "O torrent pode estar válido; tente novamente ou use um arquivo .torrent."
                )
                status = 504
            elif payload.get("code") in {"missing_torrent_source", "unsupported_torrent_source"}:
                status = 400
            else:
                status = 500
            payload = {
                **payload,
                "error": error_msg
            }
            logger.error(f"Failed to get torrent info: {stderr_text or stdout_text}")
            raise TorrentInfoError(error_msg, payload=payload, status=status)
            
        try:
            data = stdout_payload or json.loads(stdout_text)
            if "error" in data:
                 raise TorrentInfoError(data["error"], payload=data)
                 
            return data
        except Exception as e:
            if isinstance(e, TorrentInfoError):
                raise
            logger.error(f"Failed to parse torrent info: {e}\nOutput: {stdout_text}\nDiagnostics: {stderr_text}")
            raise Exception("Invalid torrent format or unable to parse metadata")

    def _extract_node_json(self, text: str) -> Optional[Dict[str, Any]]:
        """Return the last plain JSON object emitted by the Node helper."""
        if not text:
            return None
        for line in reversed([ln.strip() for ln in text.splitlines() if ln.strip()]):
            if not line.startswith("{"):
                continue
            try:
                parsed = json.loads(line)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                continue
        return None

    async def download_and_upload(self, magnet_or_file: str, tcloud_path: str, selected_indices: Optional[List[int]] = None, name: Optional[str] = None, torrent_file: Optional[str] = None) -> str:
        """Starts downloading the specified indices of the torrent, then uploads to Telegram."""
        job_id = str(uuid.uuid4())
        
        download_path = os.path.join(self.tmp_dir, job_id)
        os.makedirs(download_path, exist_ok=True)
        
        # Prefer cached .torrent file over raw magnet to skip DHT re-resolution
        download_source = magnet_or_file
        if torrent_file and os.path.isfile(torrent_file):
            download_source = torrent_file
            logger.info(f"Using cached .torrent file: {torrent_file}")
        else:
            logger.info(f"No cached .torrent file, using magnet link")
        
        # Determine mode
        if selected_indices is None or len(selected_indices) == 0:
            download_mode = "full"
            selection_scope = "all"
            sel_count = 0
        elif len(selected_indices) == 1:
            download_mode = "selective"
            selection_scope = "single_file"
            sel_count = 1
        else:
            download_mode = "selective"
            selection_scope = "multi_file"
            sel_count = len(selected_indices)

        now = time.time()
        self.active_torrents[job_id] = {
            "name": name or "Download Torrent",
            "phase": "resolving_metadata",
            "status": "downloading",
            "progress": 0.0,
            "speed": "0 B/s",
            "time_remaining": "Calculating...",
            "target_path": tcloud_path,
            "selected_indices": selected_indices,
            "download_mode": download_mode,
            "selection_scope": selection_scope,
            "selected_file_count": sel_count,
            "is_selective": download_mode == "selective",
            # Logical file metrics
            "selected_logical_bytes_done": 0,
            "selected_logical_bytes_total": 0,
            # Piece-level metrics
            "required_piece_bytes_done": 0,
            "required_piece_bytes_total": 0,
            "swarm_downloaded_bytes": 0,
            "swarm_total_bytes": 0,
            "minimum_overhead_bytes": 0,
            "current_overhead_bytes": 0,
            # Cloud upload metrics
            "cloud_upload_bytes_done": 0,
            "cloud_upload_bytes_total": 0,
            # Speeds
            "torrent_download_speed": 0,
            "torrent_upload_speed": 0,
            "cloud_upload_speed": 0,
            "num_peers": 0,
            # Legacy compat
            "downloaded": 0,
            "total": 0,
            # Timestamps
            "phase_started_at": now,
            "ts_created": now,
            "ts_metadata": None,
            "ts_selection_applied": None,
            "ts_selected_ready": None,
            "ts_upload_started": None,
            "ts_completed": None,
            "process": None
        }
        
        # Start the background task
        asyncio.create_task(self._process_torrent(job_id, download_source, download_path, tcloud_path, selected_indices))
        return job_id

    async def pause_torrent(self, job_id: str):
        if job_id in self.active_torrents:
            state = self.active_torrents[job_id]
            if state["status"] == "downloading" and state.get("process"):
                state["process"].stdin.write(b"pause\n")
                await state["process"].stdin.drain()
                state["status"] = "paused"

    async def resume_torrent(self, job_id: str):
        if job_id in self.active_torrents:
            state = self.active_torrents[job_id]
            if state["status"] == "paused" and state.get("process"):
                state["process"].stdin.write(b"resume\n")
                await state["process"].stdin.drain()
                state["status"] = "downloading"

    async def cancel_torrent(self, job_id: str):
        if job_id in self.active_torrents:
            state = self.active_torrents[job_id]
            if state.get("process"):
                try:
                    state["process"].stdin.write(b"cancel\n")
                    await state["process"].stdin.drain()
                except Exception:
                    try:
                        state["process"].kill()
                    except Exception:
                        pass
            # Cleanup temp directory
            download_path = os.path.join(self.tmp_dir, job_id)
            try:
                if os.path.exists(download_path):
                    shutil.rmtree(download_path)
            except Exception as e:
                logger.error(f"Failed to clean up torrent temp dir {download_path}: {e}")
                
            del self.active_torrents[job_id]

    def _format_speed(self, bytes_per_sec: float) -> str:
        if bytes_per_sec == 0:
            return "0 B/s"
        k = 1024
        sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s']
        i = int(math.floor(math.log(max(1, bytes_per_sec), k)))
        return f"{bytes_per_sec / (k**i):.1f} {sizes[i]}"

    def _set_phase(self, job_id: str, phase: str):
        """Update phase and timestamp for the state machine."""
        if job_id not in self.active_torrents:
            return
        state = self.active_torrents[job_id]
        old_phase = state.get("phase")
        state["phase"] = phase
        state["phase_started_at"] = time.time()
        logger.info(f"Torrent {job_id}: phase {old_phase} → {phase}")

    async def _process_torrent(self, job_id: str, magnet: str, download_path: str, tcloud_path: str, selected_indices: Optional[List[int]]):
        """Main pipeline: download pieces → detect selected_ready → upload to cloud."""
        selected_ready_event = asyncio.Event()
        
        try:
            cmd = ["node", "webtorrent_downloader.mjs", magnet, download_path]
            
            if selected_indices is not None and len(selected_indices) > 0:
                indices_str = ",".join(map(str, selected_indices))
                cmd.append(indices_str)
            else:
                cmd.append("") # empty selected indices arg
            
            logger.info(f"Starting torrent download {job_id}: {' '.join(cmd)}")
            
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            if job_id in self.active_torrents:
                self.active_torrents[job_id]["process"] = process
            
            # ─── Event stream reader ───
            while True:
                line_bytes = await process.stdout.readline()
                if not line_bytes:
                    break
                
                line = line_bytes.decode('utf-8', errors='ignore').strip()
                if not line:
                    continue
                    
                try:
                    data = json.loads(line)
                    t_type = data.get("type")
                    
                    if t_type == "piece_progress" or t_type == "progress":
                        if self.active_torrents.get(job_id, {}).get("status") == "paused":
                            continue
                        state = self.active_torrents[job_id]
                        file_pct = float(data.get("percent", 0))
                        torrent_pct = float(data.get("torrentPercent", 0))
                        # Use torrent-level progress if file-level stays at 0
                        # (happens when tiny files share large pieces)
                        display_pct = file_pct if file_pct > 0 else torrent_pct
                        state["progress"] = display_pct
                        state["torrent_download_speed"] = data.get("speed", 0)
                        state["torrent_upload_speed"] = data.get("uploadSpeed", 0)
                        state["speed"] = self._format_speed(data.get("speed", 0))
                        # Logical
                        state["selected_logical_bytes_done"] = data.get("selectedLogicalBytesDone", data.get("downloaded", 0))
                        state["selected_logical_bytes_total"] = data.get("selectedLogicalBytesTotal", data.get("total", 0))
                        # Swarm level
                        state["swarm_downloaded_bytes"] = data.get("swarmDownloadedBytes", data.get("torrentDownloaded", 0))
                        state["swarm_total_bytes"] = data.get("swarmTotalBytes", data.get("torrentLength", 0))
                        # Piece level
                        state["required_piece_bytes_done"] = state["swarm_downloaded_bytes"]
                        # overhead
                        state["current_overhead_bytes"] = data.get("currentOverheadBytes", 0)
                        # Peers
                        state["num_peers"] = data.get("numPeers", 0)
                        # Legacy compat
                        state["downloaded"] = data.get("downloaded", data.get("torrentDownloaded", 0))
                        state["total"] = data.get("total", data.get("torrentLength", 0))
                        
                    elif t_type == "metadata":
                        now = time.time()
                        state = self.active_torrents[job_id]
                        state["ts_metadata"] = now
                        state["selected_logical_bytes_total"] = data.get("length", 0)
                        state["required_piece_bytes_total"] = data.get("requiredPieceBytesTotal", data.get("totalTorrentLength", 0))
                        state["minimum_overhead_bytes"] = data.get("minimumOverheadBytes", 0)
                        if "selectedFileCount" in data:
                            state["selected_file_count"] = data.get("selectedFileCount")
                            
                        # For progress bar, use the full torrent length since we download everything
                        state["swarm_total_bytes"] = data.get("totalTorrentLength", data.get("length", 0))
                        state["total"] = state["swarm_total_bytes"]
                        self._set_phase(job_id, "downloading_pieces")
                        state["ts_selection_applied"] = now
                        
                        if data.get("selectedFilePaths"):
                            state["target_files"] = data.get("selectedFilePaths")
                        elif selected_indices is not None and len(selected_indices) > 0:
                            all_files = data.get("files", [])
                            target_paths = []
                            for i in selected_indices:
                                try:
                                    idx = int(i)
                                    if idx < len(all_files):
                                        target_paths.append(all_files[idx])
                                except (ValueError, TypeError):
                                    continue
                            state["target_files"] = target_paths
                            
                    elif t_type == "selected_ready":
                        logger.info(f"Torrent {job_id}: selected files are READY for upload!")
                        state = self.active_torrents[job_id]
                        state["ts_selected_ready"] = time.time()
                        self._set_phase(job_id, "selected_ready")
                        selected_ready_event.set()
                        # DON'T wait for process to end — start upload immediately!
                        asyncio.create_task(self._upload_phase(job_id, download_path, tcloud_path, process))
                        
                    elif t_type == "paused":
                        self.active_torrents[job_id]["status"] = "paused"
                        self.active_torrents[job_id]["speed"] = "0 B/s"
                    elif t_type == "resumed":
                        self.active_torrents[job_id]["status"] = "downloading"
                    elif t_type == "error":
                        logger.error(f"Webtorrent script error: {data.get('message')}")
                    elif t_type == "done":
                        logger.info(f"Torrent {job_id}: Node process reports done")
                        if not selected_ready_event.is_set():
                            # selected_ready was never emitted (maybe full download)
                            selected_ready_event.set()
                            asyncio.create_task(self._upload_phase(job_id, download_path, tcloud_path, process))
                except Exception as parse_err:
                    logger.warning(f"Failed to parse torrent event line: {parse_err} — line: {line[:200]}")
            
            await process.wait()
            
            # If job was cancelled manually, it was removed from active_torrents
            if job_id not in self.active_torrents:
                return
                
            self.active_torrents[job_id]["process"] = None
            
            if process.returncode != 0 and process.returncode != 130 and process.returncode is not None:
                # Only raise if upload hasn't already started or completed
                phase = self.active_torrents.get(job_id, {}).get("phase", "")
                if phase not in ("uploading_to_cloud", "finalizing", "completed"):
                    raise Exception("Webtorrent failed with code " + str(process.returncode))
            
            # If selected_ready was never triggered (e.g. full torrent download), start upload now
            if not selected_ready_event.is_set():
                logger.info(f"Torrent {job_id}: process ended without selected_ready, starting upload")
                selected_ready_event.set()
                await self._upload_phase(job_id, download_path, tcloud_path, None)
            else:
                # Upload was already started by selected_ready handler. Wait for it to finish.
                # The _upload_phase task handles its own completion.
                # We wait here to keep the try/except scope alive.
                while job_id in self.active_torrents:
                    phase = self.active_torrents[job_id].get("phase", "")
                    if phase in ("completed", "error", "partial_failed"):
                        break
                    await asyncio.sleep(0.5)
            
        except Exception as e:
            logger.error(f"Torrent processing failed for {job_id}: {e}")
            if job_id in self.active_torrents:
                self.active_torrents[job_id]["status"] = "error"
                self.active_torrents[job_id]["phase"] = "error"
                self.active_torrents[job_id]["error"] = str(e)
                await asyncio.sleep(10)
                if job_id in self.active_torrents:
                    del self.active_torrents[job_id]

    async def _upload_phase(self, job_id: str, download_path: str, tcloud_path: str, process):
        """Upload phase: scan downloaded files and send to Telegram cloud."""
        try:
            if job_id not in self.active_torrents:
                return
            
            state = self.active_torrents[job_id]
            selected_indices = state.get("selected_indices")
            
            logger.info(f"Torrent {job_id}: starting UPLOAD phase")
            state["status"] = "uploading"
            state["ts_upload_started"] = time.time()
            self._set_phase(job_id, "uploading_to_cloud")
            
            # Find downloaded files
            target_files = state.get("target_files")
            logger.info(f"Target files filter: {target_files}")
            
            files_to_upload = []
            for root, dirs, files in os.walk(download_path):
                for file in files:
                    file_path = os.path.join(root, file)
                    rel_path = os.path.relpath(file_path, download_path)
                    file_size = os.path.getsize(file_path)
                    
                    if file_size == 0:
                        logger.info(f"Skipping empty placeholder file {rel_path}")
                        continue
                    
                    if target_files is not None and rel_path not in target_files:
                        logger.info(f"Skipping unselected file {rel_path}")
                        continue
                    
                    torrent_name = state.get("name", "Torrent")
                    path_parts = rel_path.split(os.sep)
                    if len(path_parts) > 1:
                        path_parts[0] = torrent_name
                        final_rel_path = "/".join(path_parts)
                    else:
                        if torrent_name == path_parts[0]:
                            final_rel_path = path_parts[0]
                        else:
                            final_rel_path = f"{torrent_name}/{path_parts[0]}"
                            
                    final_path = os.path.join(tcloud_path, final_rel_path).replace("\\", "/")
                    final_path = re.sub(r'/+', '/', final_path)
                    
                    base_name, ext = os.path.splitext(file)
                    counter = 1
                    while await self.file_manager._db.file_exists(final_path):
                        new_name = f"{base_name} ({counter}){ext}"
                        final_rel_dir = os.path.dirname(final_rel_path)
                        if final_rel_dir and final_rel_dir != '/':
                            final_path = os.path.join(tcloud_path, final_rel_dir, new_name).replace("\\", "/")
                        else:
                            final_path = os.path.join(tcloud_path, new_name).replace("\\", "/")
                        final_path = re.sub(r'/+', '/', final_path)
                        counter += 1
                    
                    files_to_upload.append((file_path, final_path, file, file_size))
                    logger.info(f"Queued for upload: {file} ({file_size} bytes) → {final_path}")
            
            if not files_to_upload:
                raise Exception("Nenhum arquivo elegível para upload encontrado após o download.")
            
            # Update cloud upload total
            total_bytes_all = sum(f[3] for f in files_to_upload)
            state["cloud_upload_bytes_total"] = total_bytes_all
            
            upload_semaphore = asyncio.Semaphore(5)
            uploaded_count = 0
            bytes_done_per_file = {}
            
            async def upload_one(file_path, final_path, file_name, file_size, file_idx):
                nonlocal uploaded_count
                async with upload_semaphore:
                    logger.info(f"Uploading {file_path} ({file_size} bytes) to {final_path}")
                    try:
                        dir_path = os.path.dirname(final_path)
                        if dir_path and dir_path != "/":
                            current_dir = ""
                            for part in dir_path.strip("/").split("/"):
                                if not part: continue
                                current_dir += f"/{part}"
                                try:
                                    await self.file_manager._db.create_directory(current_dir)
                                except Exception:
                                    pass
                                    
                        def progress_cb(current, total):
                            bytes_done_per_file[file_idx] = current
                            aggregate = sum(bytes_done_per_file.values())
                            self._update_upload_progress(job_id, aggregate, total_bytes_all)
                        
                        await self.file_manager.upload_file(
                            file_path,
                            final_path,
                            progress_callback=progress_cb,
                            resume=True
                        )
                        uploaded_count += 1
                        bytes_done_per_file[file_idx] = file_size
                        logger.info(f"✅ Successfully uploaded {file_name} to {final_path}")
                    except Exception as upload_err:
                        logger.error(f"❌ Failed to upload {file_name}: {upload_err}")
            
            if files_to_upload:
                tasks = [
                    upload_one(fp, dest, name, size, idx)
                    for idx, (fp, dest, name, size) in enumerate(files_to_upload)
                ]
                await asyncio.gather(*tasks)
            
            logger.info(f"Torrent {job_id}: uploaded {uploaded_count} files")
            
            if uploaded_count == 0 and len(files_to_upload) > 0:
                raise Exception("Falha ao subir arquivos para a nuvem.")
            
            self._set_phase(job_id, "finalizing")
            
            if uploaded_count < len(files_to_upload):
                state["status"] = "partial_failed"
                state["phase"] = "partial_failed"
            else:
                state["status"] = "completed"
                state["phase"] = "completed"
                state["progress"] = 100
                state["ts_completed"] = time.time()
            
            # Log timing summary
            ts = state
            latencies = []
            if ts.get("ts_metadata") and ts.get("ts_created"):
                latencies.append(f"metadata: {ts['ts_metadata'] - ts['ts_created']:.1f}s")
            if ts.get("ts_selected_ready") and ts.get("ts_metadata"):
                latencies.append(f"download: {ts['ts_selected_ready'] - ts['ts_metadata']:.1f}s")
            if ts.get("ts_upload_started") and ts.get("ts_selected_ready"):
                latencies.append(f"upload_delay: {ts['ts_upload_started'] - ts['ts_selected_ready']:.1f}s")
            if ts.get("ts_completed") and ts.get("ts_upload_started"):
                latencies.append(f"upload: {ts['ts_completed'] - ts['ts_upload_started']:.1f}s")
            if ts.get("ts_completed") and ts.get("ts_created"):
                latencies.append(f"total: {ts['ts_completed'] - ts['ts_created']:.1f}s")
            logger.info(f"Torrent {job_id} timing: {' | '.join(latencies)}")
            
            # Keep completed state visible
            await asyncio.sleep(5)
            
            # Clean up disk space
            try:
                shutil.rmtree(download_path)
            except Exception as e:
                logger.error(f"Failed to clean up torrent temp dir {download_path}: {e}")
            
            if job_id in self.active_torrents:
                del self.active_torrents[job_id]
                
        except Exception as e:
            logger.error(f"Upload phase failed for {job_id}: {e}")
            if job_id in self.active_torrents:
                self.active_torrents[job_id]["status"] = "error"
                self.active_torrents[job_id]["phase"] = "error"
                self.active_torrents[job_id]["error"] = str(e)
                await asyncio.sleep(10)
                if job_id in self.active_torrents:
                    del self.active_torrents[job_id]

    def _update_upload_progress(self, job_id: str, current: int, total: int):
        if job_id in self.active_torrents:
            pct = round((current / total) * 100, 2) if total > 0 else 0
            
            state = self.active_torrents[job_id]
            now = time.time()
            last_time = state.get("upload_last_time", now)
            last_bytes = state.get("upload_last_bytes", current)
            
            diff_time = now - last_time
            if diff_time >= 1.0:
                diff_bytes = current - last_bytes
                if diff_bytes >= 0:
                    bytes_per_sec = diff_bytes / diff_time
                    state["speed"] = self._format_speed(bytes_per_sec)
                    state["cloud_upload_speed"] = bytes_per_sec
                state["upload_last_time"] = now
                state["upload_last_bytes"] = current
            elif "speed" not in state or state["speed"] == "0 B/s":
                state["upload_last_time"] = now
                state["upload_last_bytes"] = current
                
            state["progress"] = pct
            state["cloud_upload_bytes_done"] = current
            state["cloud_upload_bytes_total"] = total

    def get_status(self, job_id: str) -> Optional[Dict[str, Any]]:
        return self.active_torrents.get(job_id)

    def cancel(self, job_id: str):
        pass
