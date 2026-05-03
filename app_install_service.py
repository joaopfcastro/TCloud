from __future__ import annotations

import hashlib
import io
import json
import shutil
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from app_audit import append_audit_event
from app_registry import build_registry_entry, load_registry, save_registry

REQUIRED_MANIFEST_FIELDS = {"id", "name", "icon"}
MAX_ARCHIVE_SIZE_BYTES = 25 * 1024 * 1024
MAX_ARCHIVE_FILE_COUNT = 500


class AppInstallError(RuntimeError):
    pass


class AppInstallService:
    def __init__(self, *, bundled_apps_dir: Path, runtime_dir: Path):
        self._bundled_apps_dir = Path(bundled_apps_dir)
        self._runtime_dir = Path(runtime_dir)
        self._runtime_apps_dir = self._runtime_dir / "apps"
        self._runtime_apps_dir.mkdir(parents=True, exist_ok=True)

    def install_zip_bytes(self, archive_bytes: bytes, *, filename: str = "upload.zip") -> dict:
        if not archive_bytes:
            raise AppInstallError("arquivo ZIP vazio")
        if len(archive_bytes) > MAX_ARCHIVE_SIZE_BYTES:
            raise AppInstallError("arquivo ZIP excede o limite permitido")

        checksum = hashlib.sha256(archive_bytes).hexdigest()
        with tempfile.TemporaryDirectory(prefix="tcloud-app-install-") as tmp_dir:
            extraction_dir = Path(tmp_dir) / "extract"
            extraction_dir.mkdir(parents=True, exist_ok=True)
            manifest, app_root = self._extract_zip_to_dir(archive_bytes, extraction_dir)
            return self._promote_app_dir(
                manifest=manifest,
                app_root=app_root,
                source={
                    "type": "runtime_zip",
                    "location": f"runtime/apps/{manifest['id']}",
                    "checksum": checksum,
                    "url": filename,
                },
            )

    def install_github_url(self, url: str, *, ref: str = "", subdir: str = "") -> dict:
        github = self._parse_github_input(url, ref=ref, subdir=subdir)
        download_url = github["download_url"]
        request = urllib.request.Request(
            download_url,
            headers={
                "Accept": "application/vnd.github+json, application/octet-stream",
                "User-Agent": "TCloud-AppInstaller/1.0",
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            archive_bytes = response.read(MAX_ARCHIVE_SIZE_BYTES + 1)
        if len(archive_bytes) > MAX_ARCHIVE_SIZE_BYTES:
            raise AppInstallError("download do GitHub excede o limite permitido")

        checksum = hashlib.sha256(archive_bytes).hexdigest()
        with tempfile.TemporaryDirectory(prefix="tcloud-app-github-") as tmp_dir:
            extraction_dir = Path(tmp_dir) / "extract"
            extraction_dir.mkdir(parents=True, exist_ok=True)
            manifest, app_root = self._extract_zip_to_dir(archive_bytes, extraction_dir)

            selected_root = app_root
            requested_subdir = github["subdir"]
            if requested_subdir:
                candidate = (app_root / requested_subdir).resolve()
                if not str(candidate).startswith(str(app_root.resolve())) or not candidate.exists():
                    raise AppInstallError("subdiretorio solicitado no GitHub nao foi encontrado no bundle")
                manifest = self._load_manifest(candidate)
                selected_root = candidate

            result = self._promote_app_dir(
                manifest=manifest,
                app_root=selected_root,
                source={
                    "type": "github",
                    "location": f"runtime/apps/{manifest['id']}",
                    "url": url,
                    "repo": github["repo"],
                    "ref": github["ref"],
                    "subdir": github["subdir"],
                    "checksum": checksum,
                },
            )
            result["source"] = github
            return result

    def uninstall_app(self, app_id: str, *, protected: bool = False) -> dict:
        if protected:
            raise AppInstallError("app protegido nao pode ser desinstalado")

        runtime_app_dir = self._runtime_apps_dir / app_id
        if not runtime_app_dir.exists():
            raise AppInstallError("app instalado em runtime nao encontrado")

        shutil.rmtree(runtime_app_dir)

        registry = load_registry(self._runtime_dir)
        registry_apps = registry.get("apps") or {}
        registry_apps.pop(app_id, None)
        registry["apps"] = registry_apps
        save_registry(self._runtime_dir, registry)
        append_audit_event(self._runtime_dir, "app_uninstalled", app_id=app_id, details={"source": "runtime"})
        return {"ok": True, "app_id": app_id}

    def _extract_zip_to_dir(self, archive_bytes: bytes, destination: Path) -> tuple[dict, Path]:
        archive_file = io.BytesIO(archive_bytes)
        try:
            with zipfile.ZipFile(archive_file) as archive:
                infos = archive.infolist()
                if not infos:
                    raise AppInstallError("arquivo ZIP sem conteudo")
                if len(infos) > MAX_ARCHIVE_FILE_COUNT:
                    raise AppInstallError("arquivo ZIP possui arquivos demais")

                for info in infos:
                    self._validate_zip_member(info)
                    target = (destination / info.filename).resolve()
                    if not str(target).startswith(str(destination.resolve())):
                        raise AppInstallError("arquivo ZIP contem caminho invalido")
                    if info.is_dir():
                        target.mkdir(parents=True, exist_ok=True)
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as source_handle, target.open("wb") as target_handle:
                        shutil.copyfileobj(source_handle, target_handle)
        except zipfile.BadZipFile as exc:
            raise AppInstallError("arquivo ZIP invalido") from exc

        candidate_roots = []
        for manifest_path in destination.rglob("manifest.json"):
            if manifest_path.parent.name.startswith(".") or "__MACOSX" in manifest_path.parts:
                continue
            if (manifest_path.parent / "index.html").exists():
                candidate_roots.append(manifest_path.parent)

        if len(candidate_roots) != 1:
            raise AppInstallError("o bundle deve conter exatamente um app com manifest.json e index.html")

        app_root = candidate_roots[0]
        manifest = self._load_manifest(app_root)
        return manifest, app_root

    def _validate_zip_member(self, info: zipfile.ZipInfo) -> None:
        filename = info.filename
        normalized = filename.replace("\\", "/")
        if normalized.startswith("/") or normalized.startswith("../") or "/../" in normalized:
            raise AppInstallError("arquivo ZIP contem path traversal")
        if normalized.startswith("__MACOSX/"):
            return
        mode = info.external_attr >> 16
        if mode and (mode & 0o170000) == 0o120000:
            raise AppInstallError("arquivo ZIP contem symlink, o que nao e permitido")

    def _load_manifest(self, app_root: Path) -> dict:
        manifest_path = app_root / "manifest.json"
        index_path = app_root / "index.html"
        if not manifest_path.exists() or not index_path.exists():
            raise AppInstallError("bundle sem manifest.json ou index.html")

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise AppInstallError("manifest.json invalido") from exc

        missing = REQUIRED_MANIFEST_FIELDS - set(manifest.keys())
        if missing:
            raise AppInstallError(f"manifest.json sem campos obrigatorios: {', '.join(sorted(missing))}")

        app_id = str(manifest.get("id") or "").strip().lower()
        if not app_id or any(char for char in app_id if not (char.islower() or char.isdigit() or char in {"-", "_"})):
            raise AppInstallError("id do app deve usar lowercase, numeros, hifen ou underscore")
        manifest["id"] = app_id
        return manifest

    def _promote_app_dir(self, *, manifest: dict, app_root: Path, source: dict) -> dict:
        app_id = manifest["id"]
        bundled_dir = self._bundled_apps_dir / app_id
        if bundled_dir.exists():
            raise AppInstallError("nao e permitido sobrescrever um app bundled")

        destination = self._runtime_apps_dir / app_id
        temp_destination = self._runtime_apps_dir / f".{app_id}.tmp"
        if temp_destination.exists():
            shutil.rmtree(temp_destination)
        shutil.copytree(app_root, temp_destination)
        if destination.exists():
            shutil.rmtree(destination)
        temp_destination.replace(destination)

        registry = load_registry(self._runtime_dir)
        existing = (registry.get("apps") or {}).get(app_id)
        registry.setdefault("apps", {})[app_id] = build_registry_entry(
            manifest,
            source=source,
            existing=existing,
            install_id=(existing or {}).get("install_id"),
        )
        save_registry(self._runtime_dir, registry)
        append_audit_event(
            self._runtime_dir,
            "app_installed",
            app_id=app_id,
            details={"source_type": source.get("type", "runtime_zip"), "location": source.get("location", "")},
        )
        return {"ok": True, "app_id": app_id, "manifest": manifest}

    def _parse_github_input(self, url: str, *, ref: str = "", subdir: str = "") -> dict:
        parsed = urllib.parse.urlparse(str(url or "").strip())
        if parsed.scheme not in {"http", "https"} or parsed.netloc not in {"github.com", "www.github.com"}:
            raise AppInstallError("somente links do GitHub sao suportados nesta versao")

        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) < 2:
            raise AppInstallError("link do GitHub invalido")

        owner, repo = parts[0], parts[1].removesuffix(".git")
        detected_ref = ref.strip()
        detected_subdir = subdir.strip().strip("/")

        if len(parts) >= 4 and parts[2] == "tree":
            detected_ref = detected_ref or parts[3]
            if len(parts) > 4 and not detected_subdir:
                detected_subdir = "/".join(parts[4:])

        resolved_ref = detected_ref or "HEAD"
        repo_slug = f"{owner}/{repo}"
        download_url = f"https://api.github.com/repos/{repo_slug}/zipball/{urllib.parse.quote(resolved_ref, safe='')}"
        return {
            "repo": repo_slug,
            "ref": resolved_ref,
            "subdir": detected_subdir,
            "download_url": download_url,
        }
