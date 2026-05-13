# TCloud - HTTP Streaming Server
# Serves media files from Telegram with chunk-aware Range request support.

from __future__ import annotations

import logging
import asyncio
import hashlib
import json
import os
import re
import ssl
import mimetypes
import math
import zipfile
import uuid
import tempfile
import shutil
import unicodedata
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, quote
import sys
from datetime import datetime, timedelta, timezone
import time

from aiohttp import web
import aiofiles
import pymongo

from archive_service import (
    ArchiveCapabilityError,
    ArchiveService,
    ArchiveValidationError,
    _QueueBackedArchiveWriter,
    _QueueBackedSyncReader,
)
from app_audit import append_audit_event
from app_install_service import AppInstallError, AppInstallService
from config import Config
from app_manager import AppManager
from auth import (
    auth_middleware,
    cors_middleware,
    create_app_runtime_token,
    create_public_share_token,
    create_token,
    verify_public_share_token,
    verify_app_runtime_token,
)
from app_permissions import FUNCTION_CATALOG, function_catalog_payload, is_file_type_allowed, is_path_allowed
from file_manager import PublicShareError, scan_image_metadata, scan_pdf_metadata
from managed_config import SETTINGS_SCHEMA
from media_track_labels import (
    detect_subtitle_language_from_content as _detect_subtitle_language_from_content,
    build_audio_label as _shared_build_audio_label,
    build_subtitle_label as _shared_build_subtitle_label,
    clean_track_value as _shared_clean_track_value,
    is_ambiguous_short_language_token as _is_ambiguous_short_language_token,
    language_display_name as _shared_language_display_name,
    looks_like_technical_track_label as _looks_like_technical_track_label,
    normalize_language_code as _shared_normalize_language_code,
)

logger = logging.getLogger("tcloud.http")
_PERCENT_ENCODED_PATH_RE = re.compile(r"%[0-9A-Fa-f]{2}")

# Ensure common media types are registered
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("video/x-matroska", ".mkv")
mimetypes.add_type("video/webm", ".webm")
mimetypes.add_type("video/x-msvideo", ".avi")
mimetypes.add_type("audio/mpeg", ".mp3")
mimetypes.add_type("audio/flac", ".flac")
mimetypes.add_type("audio/ogg", ".ogg")
mimetypes.add_type("audio/aac", ".aac")
mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("application/manifest+json", ".webmanifest")

_PLACEHOLDER_TRACK_VALUES = {
    "",
    "und",
    "undefined",
    "unknown",
    "null",
    "n/a",
    "na",
    "none",
    "subtitlehandler",
    "soundhandler",
    "handlername",
}

SUBTITLE_EXTENSIONS = {".srt", ".vtt"}
UTF8_WEBVTT_SIDECAR_EXTENSIONS = {".srt", ".vtt"}
DEFAULT_RELATED_SUBTITLE_DIRECTORY_NAMES = (
    "legendas",
    "legenda",
    "subs",
    "subtitles",
    "subtitle",
)
_SIDEcar_TOKEN_NOISE = {
    "default",
    "padrao",
    "forced",
    "forcada",
    "forc",
    "sdh",
    "hi",
    "cc",
    "captions",
    "caption",
    "closed",
    "comment",
    "comentario",
    "subtitle",
    "subtitles",
    "sub",
    "subs",
    "legenda",
    "legendas",
}
STABLE_AUDIO_VARIANT_EXTENSIONS = {".mp4", ".webm"}
PREPARED_WEB_VIDEO_EXTENSIONS = {".mkv", ".avi", ".flv", ".wmv"}
PUBLIC_DIRECT_VIDEO_EXTENSIONS = {".mp4", ".m4v", ".mov", ".webm"}
PUBLIC_TRANSCODED_VIDEO_EXTENSIONS = PREPARED_WEB_VIDEO_EXTENSIONS
PUBLIC_DIRECT_AUDIO_EXTENSIONS = {".mp3", ".m4a", ".wav"}
PUBLIC_TRANSCODED_AUDIO_EXTENSIONS = {".flac", ".ogg", ".oga", ".wma", ".aac"}

LANGUAGE_NAMES = {
    "ar": "Árabe",
    "de": "Alemão",
    "en": "Inglês",
    "es": "Espanhol",
    "fr": "Francês",
    "it": "Italiano",
    "ja": "Japonês",
    "ko": "Coreano",
    "nl": "Holandês",
    "pl": "Polonês",
    "pt": "Português",
    "ru": "Russo",
    "tr": "Turco",
    "zh": "Chinês",
}

LANGUAGE_CODE_ALIASES = {
    "ara": "ar",
    "deu": "de",
    "ger": "de",
    "eng": "en",
    "spa": "es",
    "espanol": "es",
    "latino": "es",
    "fra": "fr",
    "fre": "fr",
    "frances": "fr",
    "ita": "it",
    "italiano": "it",
    "jpn": "ja",
    "kor": "ko",
    "dut": "nl",
    "nld": "nl",
    "pol": "pl",
    "por": "pt",
    "ptbr": "pt",
    "portugues": "pt",
    "rus": "ru",
    "tur": "tr",
    "chi": "zh",
    "zho": "zh",
}


def _normalize_virtual_folder(path: str | None) -> str:
    if not path:
        return "/"
    normalized = re.sub(r"/+", "/", str(path).replace("\\", "/").strip())
    if not normalized or normalized == ".":
        return "/"
    if not normalized.startswith("/"):
        normalized = f"/{normalized}"
    if len(normalized) > 1:
        normalized = normalized.rstrip("/")
    return normalized or "/"


def _normalize_cloud_path_variant(path: str | None) -> str:
    return _normalize_virtual_folder(path)


def _safe_float(value):
    try:
        if value in (None, "", "N/A"):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_int(value):
    try:
        if value in (None, "", "N/A"):
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _parse_probe_rate(value):
    if not value or value in ("0/0", "N/A"):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value)
    if "/" in text:
        num, den = text.split("/", 1)
        numerator = _safe_float(num)
        denominator = _safe_float(den)
        if numerator is None or not denominator:
            return None
        return numerator / denominator
    return _safe_float(text)


def _iso_or_none(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value or None


def _mask_storage_id(storage_id: str | None) -> str | None:
    if not storage_id:
        return None
    if len(storage_id) <= 8:
        return storage_id
    return f"{storage_id[:4]}…{storage_id[-4:]}"

SIDECAR_FLAG_TOKENS = {
    "forced",
    "forcada",
    "forc",
    "sdh",
    "hi",
    "cc",
    "comment",
    "comentario",
    "default",
    "padrao",
    "full",
    "complete",
    "completa",
    "hearing",
    "impaired",
    "closed",
    "captions",
}


def _subtitle_stream_content_type(filename: str) -> str | None:
    suffix = Path(filename or "").suffix.lower()
    if suffix == ".vtt":
        return "text/vtt"
    if suffix in SUBTITLE_EXTENSIONS:
        return "text/plain"
    return None


def _build_sidecar_subtitle_url(path: str, is_local: bool) -> str:
    local_param = "&local=true" if is_local else ""
    return f"/api/subtitle?path={quote(path, safe='')}&sidecar=true{local_param}"


def _decode_subtitle_utf8(data: bytes) -> str:
    try:
        if data.startswith(b'\xef\xbb\xbf'):
            return data.decode("utf-8-sig")
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    
    try:
        fallback = data.decode("cp1252")
        logger.info("[Subtitle] Decoded with cp1252 fallback")
        return fallback
    except UnicodeDecodeError:
        pass

    fallback_iso = data.decode("latin-1")
    logger.info("[Subtitle] Decoded with latin-1 fallback")
    return fallback_iso


def _convert_subtitle_to_webvtt(text: str, suffix: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    if suffix == ".srt":
        body = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", normalized)
        return f"WEBVTT\n\n{body.lstrip()}"
    if normalized.startswith("WEBVTT"):
        return normalized
    return f"WEBVTT\n\n{normalized.lstrip()}"


def _clean_track_value(value) -> str:
    return _shared_clean_track_value(value)


def _subtitle_source_stem(value: str) -> str:
    clean_value = _clean_track_value(value)
    if not clean_value:
        return ""

    no_fragment = clean_value.split("#", 1)[0]
    no_query = no_fragment.split("?", 1)[0]
    basename = Path(no_query).name
    if not basename:
        return ""

    return re.sub(r"\.(srt|vtt|ass|ssa|sub)$", "", basename, flags=re.IGNORECASE)


def _subtitle_filename_label(*values) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if not text:
            continue
        basename = text.split("#", 1)[0].split("?", 1)[0].rsplit("/", 1)[-1]
        clean_basename = _clean_track_value(basename)
        if clean_basename:
            return clean_basename
    return ""


def _tokenize_name(value: str) -> list[str]:
    normalized = _strip_accents(str(value).lower())
    return [token for token in re.split(r"[^a-z0-9]+", normalized) if token]


def _strip_trailing_copy_suffix(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return re.sub(r"\s*\((\d+)\)\s*$", "", text).strip()


def _video_stem_for_sidecar_matching(video_name: str) -> str:
    video_stem = Path(video_name).stem
    normalized_stem = _strip_trailing_copy_suffix(video_stem)
    return normalized_stem or video_stem


def _strip_accents(value: str) -> str:
    if not value:
        return ""
    # Normalize to NFD to separate base characters from combining marks
    normalized = unicodedata.normalize('NFD', str(value))
    # Filter out non-spacing mark (Mn) category
    stripped = "".join(c for c in normalized if unicodedata.category(c) != 'Mn')
    return stripped.lower()


def _normalize_language_code(value) -> str:
    return _shared_normalize_language_code(value)


def _related_subtitle_directory_names() -> tuple[str, ...]:
    raw = str(os.getenv("RELATED_SUBTITLE_DIR_NAMES", "") or "").strip()
    if not raw:
        return DEFAULT_RELATED_SUBTITLE_DIRECTORY_NAMES
    names = []
    for token in raw.split(","):
        cleaned = _strip_accents(token.strip().lower())
        if cleaned:
            names.append(cleaned)
    return tuple(dict.fromkeys(names)) or DEFAULT_RELATED_SUBTITLE_DIRECTORY_NAMES


def _is_ordered_token_subsequence(needle: list[str], haystack: list[str]) -> bool:
    if not needle:
        return False
    hay_index = 0
    for token in needle:
        found = False
        while hay_index < len(haystack):
            if haystack[hay_index] == token:
                hay_index += 1
                found = True
                break
            hay_index += 1
        if not found:
            return False
    return True


def _detail_tokens_after_video_match(video_tokens: list[str], subtitle_tokens: list[str]) -> list[str]:
    if not video_tokens or not subtitle_tokens:
        return []

    video_cursor = 0
    detail_tokens: list[str] = []
    for token in subtitle_tokens:
        if video_cursor < len(video_tokens) and token == video_tokens[video_cursor]:
            video_cursor += 1
            continue
        detail_tokens.append(token)
    return detail_tokens


def _subtitle_descriptor_only_tokens(tokens: list[str]) -> bool:
    normalized_tokens = [token for token in tokens if token and not token.isdigit()]
    if not normalized_tokens:
        return False

    for token in normalized_tokens:
        if _normalize_language_code(token):
            continue
        if token in _SIDEcar_TOKEN_NOISE:
            continue
        return False
    return True


def _filtered_sidecar_match_tokens(tokens: list[str]) -> list[str]:
    filtered = []
    for index, token in enumerate(tokens):
        if not token or token.isdigit():
            continue
        if _normalize_language_code(token):
            continue
        previous_token = tokens[index - 1] if index > 0 else ""
        next_token = tokens[index + 1] if index + 1 < len(tokens) else ""
        if len(token) <= 3 and (_normalize_language_code(previous_token) or _normalize_language_code(next_token)):
            continue
        if token in _SIDEcar_TOKEN_NOISE:
            continue
        filtered.append(token)
    return filtered


def _score_sidecar_match(video_name: str, subtitle_name: str, *, scope_kind: str = "same_dir") -> dict:
    video_stem = _video_stem_for_sidecar_matching(video_name)
    subtitle_stem = Path(subtitle_name).stem
    video_tokens = _tokenize_name(video_stem)
    subtitle_tokens = _tokenize_name(subtitle_stem)
    normalized_video_stem = ".".join(video_tokens)
    normalized_subtitle_stem = ".".join(subtitle_tokens)
    detail_tokens = []
    score = 0
    reason = "no_match"

    if not video_tokens or not subtitle_tokens:
        return {
            "matched": False,
            "score": 0,
            "reason": reason,
            "detail_tokens": detail_tokens,
        }

    if normalized_video_stem == normalized_subtitle_stem:
        score = 100
        reason = "exact_stem"
    else:
        matched, contiguous_detail_tokens = _match_sidecar_basename(video_name, subtitle_name)
        if matched:
            score = 86
            reason = "contiguous_tokens"
            detail_tokens = contiguous_detail_tokens
        elif _is_ordered_token_subsequence(video_tokens, subtitle_tokens):
            score = 74
            reason = "ordered_tokens"
            detail_tokens = _detail_tokens_after_video_match(video_tokens, subtitle_tokens)
        else:
            shared_tokens = [token for token in subtitle_tokens if token in set(video_tokens)]
            required_shared = min(max(2, len(video_tokens) // 2), len(video_tokens))
            if len(shared_tokens) >= required_shared and len(shared_tokens) >= 2:
                score = 52
                reason = "partial_shared_tokens"
                detail_tokens = _detail_tokens_after_video_match(video_tokens, subtitle_tokens)

    filtered_subtitle_tokens = _filtered_sidecar_match_tokens(subtitle_tokens)
    if score < 60 and filtered_subtitle_tokens:
        minimum_token_match = min(max(3, len(filtered_subtitle_tokens)), max(3, min(len(video_tokens), 6)))
        if len(filtered_subtitle_tokens) >= minimum_token_match and _is_ordered_token_subsequence(filtered_subtitle_tokens, video_tokens):
            score = max(score, 70)
            reason = "video_contains_subtitle_tokens"
            detail_tokens = _detail_tokens_after_video_match(filtered_subtitle_tokens, subtitle_tokens)

    if not detail_tokens and score:
        detail_tokens = _detail_tokens_after_video_match(video_tokens, subtitle_tokens)

    scope_bonus = {
        "same_dir": 5,
        "related_subdir": 8,
        "video_scoped_dir": 18,
        "video_scoped_related_subdir": 24,
    }.get(str(scope_kind or "").strip().lower(), 0)
    score += scope_bonus

    if score < 60 and str(scope_kind or "").strip().lower() in {"video_scoped_dir", "video_scoped_related_subdir"}:
        if _subtitle_descriptor_only_tokens(subtitle_tokens):
            score = max(score, 78 if scope_kind == "video_scoped_related_subdir" else 72)
            reason = "video_scoped_descriptor_only"
            detail_tokens = subtitle_tokens

    return {
        "matched": score >= 60,
        "score": score,
        "reason": reason,
        "detail_tokens": detail_tokens,
    }


def _directory_name_matches_video(video_name: str, directory_name: str) -> bool:
    video_tokens = _tokenize_name(_video_stem_for_sidecar_matching(video_name))
    directory_tokens = _tokenize_name(directory_name)
    if not video_tokens or not directory_tokens:
        return False
    if ".".join(video_tokens) == ".".join(directory_tokens):
        return True
    if _is_ordered_token_subsequence(video_tokens, directory_tokens):
        return True
    filtered_directory_tokens = _filtered_sidecar_match_tokens(directory_tokens)
    if filtered_directory_tokens and _is_ordered_token_subsequence(filtered_directory_tokens, video_tokens):
        return len(filtered_directory_tokens) >= min(3, len(video_tokens))
    shared_tokens = set(video_tokens) & set(directory_tokens)
    return len(shared_tokens) >= min(max(2, len(video_tokens) // 2), len(video_tokens))


def _language_display_name(language_code: str) -> str:
    return _shared_language_display_name(language_code)






def _is_probably_subtitle_filename(label: str) -> bool:
    if not label:
        return False
    normalized = label.lower()
    return (normalized.endswith(".srt") or 
            normalized.endswith(".vtt") or 
            normalized.endswith(".ass") or 
            normalized.endswith(".ssa") or 
            "/" in normalized or 
            "\\" in normalized)


def _build_subtitle_label(*, language: str, title: str, index: int, filename: str = "", src: str = "",
                          forced: bool = False, default: bool = False, hearing_impaired: bool = False,
                          comment: bool = False, captions: bool = False, complete: bool = False) -> str:
    return _shared_build_subtitle_label(
        language=language,
        title=title,
        index=index,
        filename=filename,
        src=src,
        forced=forced,
        default=default,
        hearing_impaired=hearing_impaired,
        comment=comment,
        captions=captions,
        complete=complete,
    )


def _build_audio_label(*, language: str, title: str, index: int) -> str:
    return _shared_build_audio_label(language=language, title=title, index=index)


def _subtitle_flags(*, forced: bool = False, default: bool = False, hearing_impaired: bool = False,
                    comment: bool = False, captions: bool = False) -> list[str]:
    flags = []
    if forced:
        flags.append("Forçada")
    if default:
        flags.append("Padrão")
    if hearing_impaired:
        flags.append("SDH")
    if comment:
        flags.append("Comentário")
    if captions:
        flags.append("CC")
    return flags




def _match_sidecar_basename(video_name: str, subtitle_name: str) -> tuple[bool, list[str]]:
    video_stem = _video_stem_for_sidecar_matching(video_name)
    subtitle_stem = Path(subtitle_name).stem
    video_tokens = _tokenize_name(video_stem)
    subtitle_tokens = _tokenize_name(subtitle_stem)
    
    if not video_tokens or len(subtitle_tokens) < len(video_tokens):
        return False, []
        
    v_len = len(video_tokens)
    for i in range(len(subtitle_tokens) - v_len + 1):
        if subtitle_tokens[i:i+v_len] == video_tokens:
            detail_tokens = subtitle_tokens[:i] + subtitle_tokens[i+v_len:]
            return True, detail_tokens
            
    return False, []


def _is_strong_sidecar_language_candidate(candidate: str, *, token: str, index: int, token_count: int) -> bool:
    if not candidate:
        return False
    normalized_token = str(token or "").strip().lower()
    if candidate != normalized_token:
        return True
    if len(normalized_token) > 2:
        return True
    if not _is_ambiguous_short_language_token(normalized_token):
        return True
    return index >= max(0, token_count - 2)


def _extract_sidecar_language(detail_tokens: list[str], *, video_tokens: list[str] | None = None) -> str:
    normalized_tokens = [token for token in detail_tokens if token and not token.isdigit()]
    if not normalized_tokens:
        return ""

    video_token_set = {token for token in (video_tokens or []) if token}
    preferred_tokens = [token for token in normalized_tokens if token not in video_token_set]
    if video_token_set and not preferred_tokens:
        return ""
    token_sets = [preferred_tokens] if preferred_tokens else []
    token_sets.append(normalized_tokens)

    seen_token_sets: set[tuple[str, ...]] = set()
    for token_set in token_sets:
        token_tuple = tuple(token_set)
        if not token_tuple or token_tuple in seen_token_sets:
            continue
        seen_token_sets.add(token_tuple)
        weak_fallback = ""
        for index in range(len(token_set) - 1, -1, -1):
            token = token_set[index]
            pair_candidate = f"{token_set[index - 1]}-{token}" if index - 1 >= 0 else ""
            for candidate in (pair_candidate, token):
                normalized = _normalize_language_code(candidate)
                if normalized:
                    if candidate == token and token in video_token_set and preferred_tokens:
                        continue
                    if _is_strong_sidecar_language_candidate(
                        candidate,
                        token=token,
                        index=index,
                        token_count=len(token_set),
                    ):
                        return normalized
                    if not weak_fallback and len(token_set) <= 2:
                        weak_fallback = normalized
        if weak_fallback:
            return weak_fallback
    return ""


def _readable_subtitle_text_sample(subtitle_text: str) -> str:
    lines = []
    for raw_line in str(subtitle_text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.upper() == "WEBVTT":
            continue
        if "-->" in line:
            continue
        if re.fullmatch(r"\d+", line):
            continue
        lines.append(line)
        if len(" ".join(lines)) >= 6000:
            break
    return "\n".join(lines)


def _token_set_contains_language(tokens: list[str], language: str) -> bool:
    normalized_language = _normalize_language_code(language)
    if not normalized_language:
        return False
    for token in tokens:
        if _normalize_language_code(token) == normalized_language:
            return True
    return False


def _should_refine_sidecar_language(
    *,
    current_language: str,
    confidence: float,
    subtitle_name: str,
) -> bool:
    normalized_language = _normalize_language_code(current_language)
    if not normalized_language:
        return True
    if confidence < 0.75:
        return True

    tokens = _tokenize_name(Path(subtitle_name or "").stem)
    if normalized_language == "de" and _token_set_contains_language(tokens, "por"):
        return True
    if normalized_language == "pt" and _token_set_contains_language(tokens, "deu"):
        return True

    return False


def _looks_like_episode_or_year_token(token: str) -> bool:
    normalized = str(token or "").strip().lower()
    if not normalized:
        return False
    return bool(
        re.fullmatch(r"s\d{1,2}e\d{1,3}", normalized)
        or re.fullmatch(r"e\d{1,3}", normalized)
        or re.fullmatch(r"\d{4}", normalized)
    )


def _build_same_folder_sidecar_fallback_metadata(
    video_name: str,
    subtitle_name: str,
    *,
    scope_kind: str = "same_dir",
) -> dict | None:
    extension = Path(subtitle_name).suffix.lower()
    if extension not in SUBTITLE_EXTENSIONS:
        return None

    normalized_scope = str(scope_kind or "same_dir").strip().lower()
    if normalized_scope != "same_dir":
        return None

    score_info = _score_sidecar_match(video_name, subtitle_name, scope_kind=normalized_scope)
    if score_info.get("matched"):
        return None

    video_tokens = _tokenize_name(_video_stem_for_sidecar_matching(video_name))
    subtitle_tokens = _tokenize_name(Path(subtitle_name).stem)
    filtered_subtitle_tokens = _filtered_sidecar_match_tokens(subtitle_tokens)
    
    # Relaxed match: prioritize matching video kernels into the subtitle string
    if len(video_tokens) < 1 or len(filtered_subtitle_tokens) < 1:
        return None
        
    # Case A: Video is a subsequence of the subtitle (common for sidecars with extra tags)
    # Case B: Filtered subtitle is a subsequence of the video (common for stripped names)
    is_match = (
        _is_ordered_token_subsequence(video_tokens, subtitle_tokens)
        or _is_ordered_token_subsequence(filtered_subtitle_tokens, video_tokens)
    )
    
    if not is_match:
        return None
        
    if len(filtered_subtitle_tokens) < 3 and not any(_looks_like_episode_or_year_token(token) for token in filtered_subtitle_tokens):
        # Very short names need an episode or year marker to avoid false positives
        if not _is_ordered_token_subsequence(video_tokens, subtitle_tokens):
            return None

    detail_tokens = _detail_tokens_after_video_match(filtered_subtitle_tokens, subtitle_tokens)
    detail_text = " ".join(detail_tokens)
    folded_detail = _strip_accents(detail_text.lower())

    forced = bool(re.search(r"\b(forced|forcada|forc)\b", folded_detail))
    default = bool(re.search(r"\b(default|padrao)\b", folded_detail))
    hearing_impaired = bool(re.search(r"\b(sdh|hi)\b", folded_detail) or re.search(r"\bhearing\s+impaired\b", folded_detail))
    comment = bool(re.search(r"\b(comment|comentario)\b", folded_detail))
    captions = bool(
        re.search(r"\b(cc|captions?)\b", folded_detail)
        or re.search(r"\bclosed\s+captions?\b", folded_detail)
    )
    language = _extract_sidecar_language(detail_tokens, video_tokens=video_tokens)
    label = _build_subtitle_label(
        language=language,
        title="",
        index=0,
        filename=subtitle_name,
        src=subtitle_name,
        forced=forced,
        default=default,
        hearing_impaired=hearing_impaired,
        comment=comment,
        captions=captions,
    )

    return {
        "language": language,
        "title": "",
        "label": label,
        "forced": forced,
        "default": default,
        "hearing_impaired": hearing_impaired,
        "comment": comment,
        "captions": captions,
        "confidence": max(0.62, float(score_info.get("score", 0) or 0) / 100.0),
        "match_score": max(62, int(score_info.get("score", 0) or 0)),
        "match_reason": "basename_fallback",
        "scope_kind": normalized_scope,
        "auto_match": True,
    }


def _parse_sidecar_metadata(video_name: str, subtitle_name: str, *, scope_kind: str = "same_dir") -> dict | None:
    extension = Path(subtitle_name).suffix.lower()
    if extension not in SUBTITLE_EXTENSIONS:
        return None

    score_info = _score_sidecar_match(video_name, subtitle_name, scope_kind=scope_kind)
    if not score_info.get("matched"):
        return None
    detail_tokens = score_info.get("detail_tokens") or []
    video_tokens = _tokenize_name(_video_stem_for_sidecar_matching(video_name))

    detail_text = " ".join(detail_tokens)
    folded_detail = _strip_accents(detail_text.lower())

    forced = bool(re.search(r"\b(forced|forcada|forc)\b", folded_detail))
    default = bool(re.search(r"\b(default|padrao)\b", folded_detail))
    hearing_impaired = bool(re.search(r"\b(sdh|hi)\b", folded_detail) or re.search(r"\bhearing\s+impaired\b", folded_detail))
    comment = bool(re.search(r"\b(comment|comentario)\b", folded_detail))
    captions = bool(
        re.search(r"\b(cc|captions?)\b", folded_detail)
        or re.search(r"\bclosed\s+captions?\b", folded_detail)
    )
    complete = bool(re.search(r"\b(full|complete|completa|completo)\b", folded_detail))
    language = _extract_sidecar_language(detail_tokens, video_tokens=video_tokens)

    label = _build_subtitle_label(
        language=language,
        title="",
        index=0,
        filename=subtitle_name,
        src=subtitle_name,
        forced=forced,
        default=default,
        hearing_impaired=hearing_impaired,
        comment=comment,
        captions=captions,
        complete=complete,
    )

    return {
        "language": language,
        "title": "",
        "label": label,
        "forced": forced,
        "default": default,
        "hearing_impaired": hearing_impaired,
        "comment": comment,
        "captions": captions,
        "complete": complete,
        "confidence": min(1.0, float(score_info.get("score", 0)) / 100.0),
        "match_score": int(score_info.get("score", 0) or 0),
        "match_reason": str(score_info.get("reason", "") or "").strip(),
        "scope_kind": str(scope_kind or "same_dir"),
        "auto_match": True,
    }


def _build_generated_sidecar_metadata(video_path: str, item: dict) -> dict | None:
    meta = item.get("meta") or {}
    if str(meta.get("generated_role") or "").strip().lower() != "externalized_subtitle":
        return None

    name = str(item.get("name") or Path(item.get("path") or "").name or "").strip()
    if not name:
        return None

    generated_from_video_path = str(meta.get("generated_from_video_path") or "").strip()
    normalized_generated_from = generated_from_video_path.replace("\\", "/")
    normalized_video_path = str(video_path or "").strip().replace("\\", "/")
    generated_matches_video = False
    if normalized_generated_from and normalized_video_path:
        generated_matches_video = (
            normalized_generated_from == normalized_video_path
            or unicodedata.normalize("NFC", normalized_generated_from) == unicodedata.normalize("NFC", normalized_video_path)
            or unicodedata.normalize("NFD", normalized_generated_from) == unicodedata.normalize("NFD", normalized_video_path)
        )
    generated_track_index = _extract_generated_sidecar_track_index(video_path, name)
    if not generated_matches_video and generated_track_index is None:
        return None

    parsed_generated_meta = _parse_sidecar_metadata(Path(video_path).name, name)
    parsed_language = _normalize_language_code((parsed_generated_meta or {}).get("language", ""))
    stored_language = _normalize_language_code(meta.get("language", ""))
    language = parsed_language or stored_language
    forced = bool((parsed_generated_meta or {}).get("forced", meta.get("forced", False)))
    default = bool((parsed_generated_meta or {}).get("default", meta.get("default", False)))
    hearing_impaired = bool((parsed_generated_meta or {}).get("hearing_impaired", meta.get("hearing_impaired", False)))
    comment = bool((parsed_generated_meta or {}).get("comment", meta.get("comment", False)))
    captions = bool((parsed_generated_meta or {}).get("captions", meta.get("captions", False)))
    title = _clean_track_value(meta.get("title", "")) or ""
    if title and _looks_like_technical_track_label(title):
        title = ""
    stored_label = _clean_track_value(meta.get("label", ""))
    if parsed_language and stored_language and parsed_language != stored_language:
        stored_label = ""
    if stored_label and _looks_like_technical_track_label(stored_label):
        stored_label = ""
    label = (
        stored_label
        or (parsed_generated_meta or {}).get("label", "")
        or _build_subtitle_label(
            language=language,
            title=title,
            index=int(meta.get("source_track_index") or 0),
            filename=name,
            src=item.get("path", ""),
            forced=forced,
            default=default,
            hearing_impaired=hearing_impaired,
            comment=comment,
            captions=captions,
        )
    )
    return {
        "language": language,
        "title": title,
        "label": label,
        "forced": forced,
        "default": default,
        "hearing_impaired": hearing_impaired,
        "comment": comment,
        "captions": captions,
        "confidence": 1.0,
        "authoritative_sidecar": True,
        "generated_group_id": str(meta.get("generated_group_id") or "").strip(),
        "source_track_index": meta.get("source_track_index") if meta.get("source_track_index") is not None else generated_track_index,
        "source_codec": str(meta.get("source_codec") or "").strip(),
    }


def _extract_generated_sidecar_track_index(video_path: str, subtitle_name: str) -> int | None:
    video_stem = Path(video_path or "").stem.strip()
    subtitle_stem = Path(subtitle_name or "").stem.strip()
    if not video_stem or not subtitle_stem:
        return None

    prefix = f"{video_stem}.tcloud.embedded."
    if not subtitle_stem.lower().startswith(prefix.lower()):
        return None

    suffix = subtitle_stem[len(prefix):]
    track_token = suffix.split(".", 1)[0].strip()
    if not track_token.isdigit():
        return None
    return int(track_token)


def _build_subtitle_authority_sort_key(candidate: dict) -> tuple[int, int, int, int, str]:
    source = str(candidate.get("source") or "").strip().lower()
    authority_mode = str(candidate.get("authority_mode") or "").strip().lower()
    match_score = int(candidate.get("match_score", 0) or 0)
    return (
        0 if authority_mode == "externalized_sidecar_authoritative" else 1,
        0 if candidate.get("authoritative_sidecar") else 1,
        -match_score,
        0 if source == "sidecar" else (1 if source == "embedded" else 2),
        str(candidate.get("label") or candidate.get("name") or candidate.get("track_id") or "").lower(),
    )


def _build_subtitle_track_id(
    *,
    source: str,
    track_index: int | None = None,
    stream_index: int | None = None,
    path: str = "",
    filename: str = "",
) -> str:
    digest_source = f"{source}:{track_index}:{stream_index}:{path}:{filename}"
    digest = hashlib.sha1(digest_source.encode("utf-8", errors="ignore")).hexdigest()[:12]
    prefix = {
        "embedded": "embedded",
        "sidecar": "sidecar",
        "inband_unknown": "unknown",
    }.get(source, "subtitle")
    if track_index is not None and source == "embedded":
        prefix = f"{prefix}_{track_index}"
    return re.sub(r"[^a-z0-9_]+", "_", f"{prefix}_{digest}".lower()).strip("_")


def _parse_webvtt_timestamp(value: str) -> float | None:
    clean_value = str(value or "").strip()
    if not clean_value:
        return None

    parts = clean_value.split(":")
    if len(parts) == 3:
        hours_text, minutes_text, seconds_text = parts
    elif len(parts) == 2:
        hours_text = "0"
        minutes_text, seconds_text = parts
    else:
        return None

    if "." not in seconds_text:
        return None

    seconds_main, milliseconds_text = seconds_text.split(".", 1)
    try:
        hours = int(hours_text)
        minutes = int(minutes_text)
        seconds = int(seconds_main)
        milliseconds = int(milliseconds_text[:3].ljust(3, "0"))
    except (TypeError, ValueError):
        return None

    return (hours * 3600) + (minutes * 60) + seconds + (milliseconds / 1000.0)


def _format_webvtt_timestamp(seconds_value: float) -> str:
    safe_seconds = max(0.0, float(seconds_value or 0.0))
    total_milliseconds = int(round(safe_seconds * 1000))
    hours, remainder = divmod(total_milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def _parse_webvtt_time_range(line: str) -> tuple[float, float, str] | None:
    if "-->" not in str(line or ""):
        return None

    left, right = str(line).split("-->", 1)
    start_seconds = _parse_webvtt_timestamp(left)
    right_parts = right.strip().split()
    if not right_parts:
        return None

    end_seconds = _parse_webvtt_timestamp(right_parts[0])
    if start_seconds is None or end_seconds is None:
        return None

    settings = " ".join(right_parts[1:]).strip()
    return start_seconds, end_seconds, settings


def _parse_webvtt_cues(text: str) -> list[dict]:
    normalized = str(text or "").replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff").strip()
    if not normalized:
        return []

    cues: list[dict] = []
    for block in re.split(r"\n{2,}", normalized):
        lines = [line for line in block.split("\n")]
        if not lines:
            continue

        first_line = lines[0].strip()
        if not first_line:
            continue
        if first_line.startswith("WEBVTT"):
            continue
        if first_line.startswith(("NOTE", "STYLE", "REGION")):
            continue

        cue_id = ""
        time_line = ""
        payload_lines: list[str] = []

        if "-->" in lines[0]:
            time_line = lines[0]
            payload_lines = lines[1:]
        elif len(lines) >= 2 and "-->" in lines[1]:
            cue_id = lines[0].strip()
            time_line = lines[1]
            payload_lines = lines[2:]
        else:
            continue

        parsed_range = _parse_webvtt_time_range(time_line)
        if not parsed_range:
            continue

        start_seconds, end_seconds, settings = parsed_range
        if end_seconds <= start_seconds:
            continue

        cues.append({
            "id": cue_id,
            "start": start_seconds,
            "end": end_seconds,
            "settings": settings,
            "payload": payload_lines,
        })

    return cues


def _build_webvtt_segment_text(cues: list[dict], segment_start: float) -> str:
    lines = [
        "WEBVTT",
        f"X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS={max(0, int(round(float(segment_start or 0.0) * 90000)))}",
        "",
    ]

    for cue in cues:
        cue_id = str(cue.get("id") or "").strip()
        if cue_id:
            lines.append(cue_id)

        settings = str(cue.get("settings") or "").strip()
        settings_suffix = f" {settings}" if settings else ""
        lines.append(
            f"{_format_webvtt_timestamp(float(cue.get('start') or 0.0))} --> "
            f"{_format_webvtt_timestamp(float(cue.get('end') or 0.0))}{settings_suffix}"
        )
        payload_lines = cue.get("payload") or [""]
        lines.extend(payload_lines)
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


class TCloudHTTPServer:
    # HTTP streaming server for TCloud.

    def __init__(self, file_manager, torrent_manager=None):
        logger.info("[HTTP] __init__ start")
        self._file_manager = file_manager
        self._torrent_manager = torrent_manager
        self._static_dir = Path(__file__).parent / "static"
        self._static_dir.mkdir(parents=True, exist_ok=True)
        logger.info("[HTTP] web.Application")
        self._app = web.Application(
            client_max_size=100 * 1024 * 1024,
            middlewares=[cors_middleware, auth_middleware],
        )
        self._import_tasks = {}
        self._web_download_jobs: dict[str, dict] = {}
        self._web_download_lock = asyncio.Lock()
        self._public_share_metrics_cache: dict[tuple[str, str, str], dict] = {}
        self._public_share_metrics_tasks: dict[tuple[str, str, str], asyncio.Task] = {}
        self._public_share_metrics_ttl_seconds = max(
            10,
            int(os.getenv("PUBLIC_SHARE_METRICS_TTL_SECONDS", "60")),
        )
        self._public_share_metrics_semaphore = asyncio.Semaphore(
            max(1, int(os.getenv("PUBLIC_SHARE_METRICS_CONCURRENCY", "2")))
        )
        self._app_manager = AppManager(runtime_dir=Config.RUNTIME_DIR)
        self._app_install_service = AppInstallService(
            bundled_apps_dir=Path(__file__).parent / "apps",
            runtime_dir=Config.RUNTIME_DIR,
        )
        self._archive_service = ArchiveService(file_manager)
        self._audio_variant_dir = Config.CACHE_DIR / "audio_variants"
        self._audio_variant_dir.mkdir(parents=True, exist_ok=True)
        self._audio_variant_locks: dict[str, asyncio.Lock] = {}
        self._audio_variant_prewarm_tasks: dict[str, asyncio.Task] = {}
        self._web_video_variant_dir = Config.CACHE_DIR / "web_video_variants"
        self._web_video_variant_dir.mkdir(parents=True, exist_ok=True)
        self._web_video_variant_locks: dict[str, asyncio.Lock] = {}
        self._web_video_variant_build_tasks: dict[str, asyncio.Task] = {}
        self._web_playback_dir = Config.CACHE_DIR / "web_playback"
        self._web_playback_dir.mkdir(parents=True, exist_ok=True)
        self._web_playback_sessions: dict[str, dict] = {}
        self._web_playback_lock = asyncio.Lock()
        self._web_playback_cleanup_task: asyncio.Task | None = None
        self._web_subtitle_dir = Config.CACHE_DIR / "web_subtitles"
        self._web_subtitle_dir.mkdir(parents=True, exist_ok=True)
        self._web_subtitle_locks: dict[str, asyncio.Lock] = {}
        self._web_subtitle_source_locks: dict[str, asyncio.Lock] = {}
        self._web_subtitle_source_prefetch_tasks: dict[str, asyncio.Task] = {}
        self._web_subtitle_source_statuses: dict[str, dict] = {}
        self._web_subtitle_extract_timeout_seconds = max(
            30,
            int(os.getenv("WEB_SUBTITLE_EXTRACT_TIMEOUT_SECONDS", "120")),
        )
        self._web_video_transcode_mode = os.getenv("WEB_VIDEO_TRANSCODE_MODE", "hls_session").strip().lower() or "hls_session"
        self._web_playback_ttl_seconds = max(60, int(os.getenv("WEB_PLAYBACK_SESSION_TTL", "900")))
        self._web_playback_retire_grace_seconds = max(5, int(os.getenv("WEB_PLAYBACK_RETIRE_GRACE_SECONDS", "16")))
        self._web_playback_hls_subtitles_mode = {
            "off": "off",
            "disabled": "off",
            "legacy": "off",
            "hybrid": "hybrid",
            "native": "native",
        }.get((os.getenv("WEB_PLAYBACK_HLS_SUBTITLES_MODE", "hybrid").strip().lower() or "hybrid"), "hybrid")
        self._web_playback_hls_subtitle_segment_duration = max(
            2,
            int(os.getenv("WEB_PLAYBACK_HLS_SUBTITLE_SEGMENT_DURATION", "10")),
        )
        raw_segment_type = os.getenv("WEB_PLAYBACK_HLS_SEGMENT_TYPE", "mpegts").strip().lower() or "mpegts"
        self._web_playback_segment_type = {
            "ts": "mpegts",
            "mpegts": "mpegts",
            "fmp4": "fmp4",
            "cmaf": "fmp4",
        }.get(raw_segment_type, "mpegts")
        raw_cloud_input_mode = os.getenv("WEB_PLAYBACK_HLS_CLOUD_INPUT_MODE", "http_range").strip().lower() or "http_range"
        self._web_playback_hls_cloud_input_mode = {
            "http": "http_range",
            "http_range": "http_range",
            "range": "http_range",
            "pipe": "pipe",
            "stdin": "pipe",
            "auto": "auto",
        }.get(raw_cloud_input_mode, "http_range")
        self._web_playback_hls_startup_timeout_seconds = max(
            15.0,
            float(os.getenv("WEB_PLAYBACK_HLS_STARTUP_TIMEOUT_SECONDS", "45")),
        )
        self._app.on_cleanup.append(self._handle_app_cleanup)
        logger.info("[HTTP] _setup_routes")
        self._setup_routes()
        logger.info("[HTTP] __init__ end")

    def _setup_routes(self):
        self._app.router.add_get("/", self._handle_index)
        self._app.router.add_get("/favicon.ico", self._handle_favicon)
        self._app.router.add_get("/apple-touch-icon.png", self._handle_apple_touch_icon)
        self._app.router.add_get("/site.webmanifest", self._handle_site_manifest)
        self._app.router.add_static("/static/", str(self._static_dir.resolve()))
        self._app.router.add_get("/api/files", self._handle_api_files)
        self._app.router.add_post("/api/mkdir", self._handle_api_mkdir)
        self._app.router.add_post("/api/rename", self._handle_api_rename)
        self._app.router.add_post("/api/move", self._handle_api_move)
        self._app.router.add_post("/api/copy", self._handle_api_copy)
        self._app.router.add_post("/api/delete", self._handle_api_delete)
        self._app.router.add_post("/api/upload", self._handle_api_upload)
        self._app.router.add_get("/api/server_uploads", self._handle_api_server_uploads)
        self._app.router.add_post("/api/upload_chunk", self._handle_api_upload_chunk)
        self._app.router.add_get("/api/usage", self._handle_api_usage)
        self._app.router.add_get("/api/thumbnail", self._handle_api_thumbnail)
        self._app.router.add_get("/api/file_info", self._handle_api_file_info)
        self._app.router.add_post("/api/share", self._handle_api_share)
        self._app.router.add_delete("/api/share", self._handle_api_share_delete)
        self._app.router.add_post("/api/favorite", self._handle_api_favorite)
        self._app.router.add_get("/api/favorites", self._handle_api_favorites)
        self._app.router.add_get("/api/recents", self._handle_api_recents)
        self._app.router.add_get("/api/cached", self._handle_api_cached)
        self._app.router.add_get("/api/trash", self._handle_api_trash)
        self._app.router.add_post("/api/trash/move", self._handle_api_trash_move)
        self._app.router.add_post("/api/trash/restore", self._handle_api_trash_restore)
        self._app.router.add_post("/api/trash/empty", self._handle_api_trash_empty)
        self._app.router.add_post("/api/playback_progress", self._handle_api_playback_progress)
        self._app.router.add_get("/api/cache_status", self._handle_api_cache_status)
        self._app.router.add_post("/api/download", self._handle_api_download)
        self._app.router.add_post("/api/make_offline", self._handle_api_make_offline)
        self._app.router.add_post("/api/remove_offline", self._handle_api_remove_offline)
        self._app.router.add_post("/api/evict_cache", self._handle_api_evict_cache)
        self._app.router.add_get("/api/server_downloads", self._handle_api_server_downloads)
        self._app.router.add_get("/api/web_downloads", self._handle_api_web_downloads)
        self._app.router.add_post("/api/web_downloads", self._handle_api_web_download_create)
        self._app.router.add_post("/api/web_downloads/{job_id}/progress", self._handle_api_web_download_progress)
        self._app.router.add_post("/api/web_downloads/{job_id}/pause", self._handle_api_web_download_pause)
        self._app.router.add_post("/api/web_downloads/{job_id}/resume", self._handle_api_web_download_resume)
        self._app.router.add_post("/api/web_downloads/{job_id}/restart", self._handle_api_web_download_restart)
        self._app.router.add_post("/api/web_downloads/{job_id}/cancel", self._handle_api_web_download_cancel)
        self._app.router.add_get("/api/web_downloads/{job_id}/part", self._handle_api_web_download_part)
        self._app.router.add_get("/api/local/files", self._handle_api_local_files) # New local files route
        self._app.router.add_get("/api/import/status", self._handle_api_import_status) # Check import status
        self._app.router.add_get("/api/apps", self._handle_api_apps)  # List installed apps
        self._app.router.add_get("/api/apps/admin", self._handle_api_apps_admin)
        self._app.router.add_get("/api/apps/{app_id}", self._handle_api_app_detail)
        self._app.router.add_post("/api/apps/install/zip", self._handle_api_apps_install_zip)
        self._app.router.add_post("/api/apps/install/github", self._handle_api_apps_install_github)
        self._app.router.add_post("/api/apps/{app_id}/enable", self._handle_api_apps_enable)
        self._app.router.add_post("/api/apps/{app_id}/disable", self._handle_api_apps_disable)
        self._app.router.add_post("/api/apps/{app_id}/uninstall", self._handle_api_apps_uninstall)
        self._app.router.add_get("/api/apps/{app_id}/permissions", self._handle_api_apps_permissions_get)
        self._app.router.add_patch("/api/apps/{app_id}/permissions", self._handle_api_apps_permissions_patch)
        self._app.router.add_get("/api/apps/{app_id}/audit", self._handle_api_apps_audit)
        self._app.router.add_post("/api/apps/{app_id}/runtime/session", self._handle_api_app_runtime_session)
        self._app.router.add_post("/api/apps/runtime/execute", self._handle_api_apps_runtime_execute)
        self._app.router.add_get("/api/settings/schema", self._handle_api_settings_schema)
        self._app.router.add_get("/api/settings", self._handle_api_settings)
        self._app.router.add_get("/api/settings/secret/{key}", self._handle_api_settings_secret)
        self._app.router.add_patch("/api/settings", self._handle_api_settings_patch)
        self._app.router.add_get("/api/settings/status", self._handle_api_settings_status)
        self._app.router.add_get("/api/settings/storage", self._handle_api_settings_storage)
        self._app.router.add_post("/api/settings/actions/reload-apps", self._handle_api_settings_reload_apps)
        self._app.router.add_get("/api/archive/capabilities", self._handle_api_archive_capabilities)
        self._app.router.add_get("/api/archive/jobs", self._handle_api_archive_jobs)
        self._app.router.add_get("/api/archive/jobs/{job_id}", self._handle_api_archive_job)
        self._app.router.add_post("/api/archive/extract", self._handle_api_archive_extract)
        self._app.router.add_post("/api/archive/compress", self._handle_api_archive_compress)
        self._app.router.add_post("/api/archive/jobs/{job_id}/cancel", self._handle_api_archive_job_cancel)
        self._app.router.add_get("/apps/{app_id}/{path:.*}", self._handle_app_static)  # Serve app files
        self._app.router.add_post("/api/auth/login", self._handle_api_login)  # Auth login
        self._app.router.add_get("/api/torrent/status", self._handle_api_torrent_status)
        self._app.router.add_post("/api/torrent/add", self._handle_api_torrent_add)
        self._app.router.add_post("/api/torrent/info", self._handle_api_torrent_info)
        self._app.router.add_post("/api/torrent/pause", self._handle_api_torrent_pause)
        self._app.router.add_post("/api/torrent/resume", self._handle_api_torrent_resume)
        self._app.router.add_post("/api/torrent/cancel", self._handle_api_torrent_cancel)
        self._app.router.add_get("/api/search", self._handle_api_search)
        self._app.router.add_get("/api/media_tracks", self._handle_api_media_tracks)
        self._app.router.add_get("/api/subtitle_candidates", self._handle_api_subtitle_candidates)
        self._app.router.add_get("/api/subtitle", self._handle_api_subtitle)
        self._app.router.add_get("/api/subtitle_status", self._handle_api_subtitle_status)
        self._app.router.add_post("/api/web_playback/session", self._handle_api_web_playback_session_create)
        self._app.router.add_get("/api/web_playback/session/{session_id}/master.m3u8", self._handle_api_web_playback_master_playlist)
        self._app.router.add_get("/api/web_playback/session/{session_id}/subtitles/{track_id}/playlist.m3u8", self._handle_api_web_playback_subtitle_playlist)
        self._app.router.add_get("/api/web_playback/session/{session_id}/subtitles/{track_id}/{asset_name:.*}", self._handle_api_web_playback_subtitle_asset)
        self._app.router.add_get("/api/web_playback/session/{session_id}/{asset_name:.*}", self._handle_api_web_playback_asset)
        self._app.router.add_delete("/api/web_playback/session/{session_id}", self._handle_api_web_playback_session_delete)
        self._app.router.add_get("/s/{public_id}", self._handle_shared_item_page)
        self._app.router.add_get("/api/shared_item/{public_id}", self._handle_api_shared_item)
        self._app.router.add_post("/api/shared_item/{public_id}/access", self._handle_api_shared_item_access)
        self._app.router.add_get("/api/shared_item/{public_id}/browse", self._handle_api_shared_item_browse)
        self._app.router.add_get("/api/shared_item/{public_id}/metrics", self._handle_api_shared_item_metrics)
        self._app.router.add_get("/api/shared_item/{public_id}/download_zip", self._handle_api_shared_item_download_zip)
        self._app.router.add_post("/api/shared_item/{public_id}/selection_summary", self._handle_api_shared_item_selection_summary)
        self._app.router.add_post("/api/shared_item/{public_id}/download_zip_selection", self._handle_api_shared_item_download_zip_selection)
        self._app.router.add_get("/api/shared_item/{public_id}/media_tracks", self._handle_api_shared_media_tracks)
        self._app.router.add_get("/api/shared_item/{public_id}/subtitle", self._handle_api_shared_subtitle)
        self._app.router.add_post("/api/shared_item/{public_id}/web_playback/session", self._handle_api_shared_web_playback_session_create)
        self._app.router.add_get("/api/shared_item/{public_id}/web_playback/session/{session_id}/master.m3u8", self._handle_api_shared_web_playback_master_playlist)
        self._app.router.add_get("/api/shared_item/{public_id}/web_playback/session/{session_id}/subtitles/{track_id}/playlist.m3u8", self._handle_api_shared_web_playback_subtitle_playlist)
        self._app.router.add_get("/api/shared_item/{public_id}/web_playback/session/{session_id}/subtitles/{track_id}/{asset_name:.*}", self._handle_api_shared_web_playback_subtitle_asset)
        self._app.router.add_get("/api/shared_item/{public_id}/web_playback/session/{session_id}/{asset_name:.*}", self._handle_api_shared_web_playback_asset)
        self._app.router.add_delete("/api/shared_item/{public_id}/web_playback/session/{session_id}", self._handle_api_shared_web_playback_session_delete)
        self._app.router.add_get("/stream/shared/{public_id}", self._handle_shared_stream)
        self._app.router.add_get("/stream/shared/{public_id}/{path:.*}", self._handle_shared_stream)
        self._app.router.add_get("/stream/{path:.*}", self._handle_stream)

    async def _handle_index(self, request):
        # Serve the web UI
        template_path = Path(__file__).parent / "templates" / "index.html"
        if not template_path.exists():
            return web.Response(text="Template not found", status=500)
        html = template_path.read_text(encoding="utf-8")
        return web.Response(text=html, content_type="text/html")

    async def _serialize_browser_item(self, request, item: dict, *, share_state: dict | None = None) -> dict:
        chunks = item.get("chunks", [])
        is_cached = False
        if not item.get("is_directory", False) and chunks:
            is_cached = self._file_manager._cache.is_file_cached(item["path"], chunks)

        sharing_state = share_state
        if sharing_state is None and item.get("path"):
            sharing_state = await self._file_manager.describe_sharing_state(
                item["path"],
                is_directory=bool(item.get("is_directory", False)),
            )

        return {
            "name": item["name"],
            "path": item["path"],
            "is_directory": item["is_directory"],
            "size": item["size"],
            "meta": item.get("meta", {}),
            "modified_at": item.get("modified_at", "").isoformat()
            if hasattr(item.get("modified_at", ""), "isoformat")
            else "",
            "created_at": item.get("created_at", "").isoformat()
            if hasattr(item.get("created_at", ""), "isoformat")
            else "",
            "is_favorite": item.get("is_favorite", False),
            "is_offline": item.get("is_offline", False),
            "is_cached": item.get("is_cached", is_cached),
            "mime_type": item.get("meta", {}).get("mime_type") or mimetypes.guess_type(item["name"])[0],
            "sharing_state": self._serialize_owner_sharing_state(request, sharing_state or {}),
        }

    async def _serve_site_asset(self, relative_path: str, *, content_type: str | None = None):
        asset_path = self._static_dir / relative_path
        if not asset_path.exists():
            return web.Response(text="Asset not found", status=404)

        headers = None
        if content_type:
            headers = {"Content-Type": content_type}
        return web.FileResponse(asset_path, headers=headers)

    async def _handle_favicon(self, request):
        return await self._serve_site_asset("icons/favicon.ico", content_type="image/x-icon")

    async def _handle_apple_touch_icon(self, request):
        return await self._serve_site_asset("icons/apple-touch-icon.png", content_type="image/png")

    async def _handle_site_manifest(self, request):
        return await self._serve_site_asset("icons/site.webmanifest", content_type="application/manifest+json")

    async def _handle_api_files(self, request):
        # List directory contents as JSON
        path = request.query.get("path", "/")
        t_list = time.time()
        try:
            items, share_context = await self._file_manager.list_directory_with_sharing(path)
            pdf_warmup_candidates = []
            result = []
            for item in items:
                if (
                    not item["is_directory"]
                    and Path(item["name"]).suffix.lower() == ".pdf"
                    and item.get("chunks")
                ):
                    pdf_warmup_candidates.append(item)
                result.append(
                    await self._serialize_browser_item(
                        request,
                        item,
                        share_state=item.get("sharing_state"),
                    )
                )
            for item in pdf_warmup_candidates[:8]:
                self._file_manager.schedule_pdf_thumbnail_warmup(item["path"], item)
            elapsed = time.time() - t_list
            logger.info(f"⏱️ API /files (path={path}) took {elapsed:.3f}s")
            return web.json_response(
                {
                    "items": result,
                    "path": path,
                    "share_context": self._serialize_owner_sharing_state(request, share_context),
                }
            )
        except Exception as e:
            logger.error(f"Error listing {path}: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_search(self, request):
        """Search all files recursively by name."""
        query = request.query.get("q", "").strip().lower()
        if not query or len(query) < 1:
            return web.json_response({"items": []})

        max_results = int(request.query.get("limit", "50"))
        results = []
        pdf_warmup_candidates = []

        async def walk(dir_path):
            if len(results) >= max_results:
                return
            try:
                items = await self._file_manager.list_directory(dir_path)
                for item in items:
                    if len(results) >= max_results:
                        return
                    name_lower = item["name"].lower()
                    if query in name_lower:
                        chunks = item.get("chunks", [])
                        is_cached = False
                        if not item["is_directory"] and chunks:
                            is_cached = self._file_manager._cache.is_file_cached(item["path"], chunks)
                        results.append({
                            "name": item["name"],
                            "path": item["path"],
                            "is_directory": item["is_directory"],
                            "size": item["size"],
                            "meta": item.get("meta", {}),
                            "modified_at": item.get("modified_at", "").isoformat()
                            if hasattr(item.get("modified_at", ""), "isoformat")
                            else "",
                            "is_favorite": item.get("is_favorite", False),
                            "is_offline": item.get("is_offline", False),
                            "is_cached": is_cached,
                            "mime_type": item.get("meta", {}).get("mime_type") or mimetypes.guess_type(item["name"])[0],
                        })
                        if Path(item["name"]).suffix.lower() == ".pdf" and chunks:
                            pdf_warmup_candidates.append(item)
                    # Recurse into directories
                    if item["is_directory"]:
                        await walk(item["path"])
            except Exception as e:
                logger.warning(f"Search walk error in {dir_path}: {e}")

        await walk("/")
        for item in pdf_warmup_candidates[:5]:
            self._file_manager.schedule_pdf_thumbnail_warmup(item["path"], item)
        return web.json_response({"items": results, "query": query})

    async def _handle_api_cached(self, request):
        try:
            items = await self._file_manager.get_cached_files()
            result = []
            for item in items:
                serialized_item = await self._serialize_browser_item(request, {
                    **item,
                    "name": item.get("filename") or item.get("name") or str(Path(item.get("path", "")).name),
                    "is_cached": item.get("is_cached", True),
                })
                result.append(serialized_item)
            return web.json_response({"items": result})
        except Exception as e:
            logger.error(f"Error getting cached files: {e}")
            return web.json_response({"error": str(e)}, status=500)

    def _serialize_trash_item(self, item: dict) -> dict:
        original_path = item.get("original_path") or item.get("path") or ""
        name = item.get("name") or str(Path(original_path).name)
        meta = item.get("meta", {}) or {}
        trashed_at = item.get("trashed_at") or item.get("modified_at")
        modified_at = item.get("modified_at")
        descendant_counts = item.get("descendant_counts") or {}
        return {
            "name": name,
            "path": original_path,
            "original_path": original_path,
            "original_parent": item.get("original_parent") or _normalize_virtual_folder(str(Path(original_path).parent)),
            "is_directory": bool(item.get("is_directory")),
            "size": int(item.get("size") or 0),
            "meta": meta,
            "modified_at": _iso_or_none(modified_at) or "",
            "trashed_at": _iso_or_none(trashed_at) or "",
            "created_at": _iso_or_none(item.get("created_at")) or "",
            "is_favorite": False,
            "is_offline": False,
            "is_cached": False,
            "mime_type": meta.get("mime_type") or mimetypes.guess_type(name)[0],
            "trash_entry_id": item.get("trash_entry_id"),
            "trash_root_entry_id": item.get("trash_root_entry_id") or item.get("trash_entry_id"),
            "descendant_counts": {
                "files": int(descendant_counts.get("files") or 0),
                "directories": int(descendant_counts.get("directories") or 0),
            },
        }

    async def _handle_api_trash(self, request):
        try:
            include_counts = str(request.query.get("include_counts") or "").strip().lower() in {"1", "true", "yes"}
            items = await self._file_manager.list_trash(include_counts=include_counts)
            result = [self._serialize_trash_item(item) for item in items]
            return web.json_response({"items": result})
        except Exception as e:
            logger.error(f"Error listing trash: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_trash_move(self, request):
        try:
            data = await request.json()
            raw_items = data.get("items")
            if raw_items is not None:
                if not isinstance(raw_items, list) or not raw_items:
                    return web.json_response({"error": "items deve ser uma lista não vazia", "code": "INVALID_ITEMS"}, status=400)

                normalized_items = []
                seen_paths = set()
                for raw_item in raw_items:
                    if not isinstance(raw_item, dict):
                        continue
                    raw_path = raw_item.get("path")
                    if not raw_path:
                        continue
                    path = self._file_manager._db._normalize_path(str(raw_path))
                    if path in seen_paths:
                        continue
                    seen_paths.add(path)
                    normalized_items.append({
                        "path": path,
                        "recursive": bool(raw_item.get("recursive")),
                    })

                if not normalized_items:
                    return web.json_response({"error": "Nenhum item válido informado", "code": "INVALID_ITEMS"}, status=400)

                normalized_items.sort(key=lambda item: (0 if item["recursive"] else 1, len(item["path"]), item["path"]))
                filtered_items = []
                selected_directories = []
                for item in normalized_items:
                    path = item["path"]
                    if any(path == directory or path.startswith(f"{directory}/") for directory in selected_directories):
                        continue
                    filtered_items.append(item)
                    if item["recursive"]:
                        selected_directories.append(path)

                moved = []
                errors = []
                trashed_files = 0
                trashed_directories = 0
                trashed_related_files = 0

                for item in filtered_items:
                    path = item["path"]
                    try:
                        if item["recursive"] and await self._file_manager.is_directory(path):
                            result = await self._file_manager.trash_directory_tree(path)
                            moved.append({
                                "trashed_type": "directory",
                                "trash_entry_id": result.get("trash_root_entry_id"),
                                "original_path": path,
                            })
                            trashed_files += int(result.get("trashed_files") or 0)
                            trashed_directories += int(result.get("trashed_directories") or 0)
                            trashed_related_files += int(result.get("trashed_related_files") or 0)
                            continue

                        if await self._file_manager.is_file(path):
                            result = await self._file_manager.trash_file(path)
                            moved.append({
                                "trashed_type": "file",
                                "trash_entry_id": result.get("trash_entry_id"),
                                "original_path": result.get("root_path") or path,
                            })
                            trashed_related_files += int(result.get("trashed_related_files") or 0)
                            continue

                        if await self._file_manager.is_directory(path):
                            result = await self._file_manager.trash_directory_tree(path)
                            moved.append({
                                "trashed_type": "directory",
                                "trash_entry_id": result.get("trash_root_entry_id"),
                                "original_path": path,
                            })
                            trashed_files += int(result.get("trashed_files") or 0)
                            trashed_directories += int(result.get("trashed_directories") or 0)
                            trashed_related_files += int(result.get("trashed_related_files") or 0)
                            continue

                        errors.append(f"{path}: Item não encontrado")
                    except Exception as exc:
                        logger.error("Error moving item to trash in batch %s: %s", path, exc, exc_info=True)
                        errors.append(f"{path}: {exc}")

                status = 207 if errors else 200
                return web.json_response({
                    "status": "ok" if not errors else "partial",
                    "moved": moved,
                    "moved_count": len(moved),
                    "trashed_files": trashed_files,
                    "trashed_directories": trashed_directories,
                    "trashed_related_files": trashed_related_files,
                    "errors": errors,
                }, status=status)

            path = data.get("path")
            if not path:
                return web.json_response({"error": "Caminho obrigatório", "code": "MISSING_PATH"}, status=400)

            if await self._file_manager.is_file(path):
                result = await self._file_manager.trash_file(path)
                return web.json_response({
                    "status": "ok",
                    "trashed_type": "file",
                    "trash_entry_id": result.get("trash_entry_id"),
                    "original_path": result.get("root_path") or path,
                    "trashed_related_files": int(result.get("trashed_related_files") or 0),
                })

            if await self._file_manager.is_directory(path):
                result = await self._file_manager.trash_directory_tree(path)
                return web.json_response({
                    "status": "ok",
                    "trashed_type": "directory",
                    "trash_entry_id": result.get("trash_root_entry_id"),
                    "original_path": path,
                    "trashed_files": int(result.get("trashed_files") or 0),
                    "trashed_directories": int(result.get("trashed_directories") or 0),
                    "trashed_related_files": int(result.get("trashed_related_files") or 0),
                })

            return web.json_response({"error": "Item não encontrado", "code": "NOT_FOUND"}, status=404)
        except ValueError as e:
            return web.json_response({"error": str(e), "code": "INVALID_OPERATION"}, status=400)
        except FileNotFoundError as e:
            return web.json_response({"error": str(e), "code": "NOT_FOUND"}, status=404)
        except Exception as e:
            logger.error(f"Error moving item to trash: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_trash_restore(self, request):
        try:
            data = await request.json()
            restore_all = bool(data.get("all"))
            entry_ids = data.get("entry_ids") or []
            if not restore_all and not isinstance(entry_ids, list):
                return web.json_response({"error": "entry_ids deve ser uma lista", "code": "INVALID_ENTRY_IDS"}, status=400)

            result = await self._file_manager.restore_trash(entry_ids, restore_all=restore_all)
            status = 207 if result.get("errors") else 200
            return web.json_response({
                "status": "ok" if not result.get("errors") else "partial",
                "restored": result.get("restored", []),
                "restored_count": len(result.get("restored", [])),
                "errors": result.get("errors", []),
            }, status=status)
        except Exception as e:
            logger.error(f"Error restoring trash: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_trash_empty(self, request):
        try:
            data = await request.json()
            purge_all = bool(data.get("all"))
            entry_ids = data.get("entry_ids") or []
            if not purge_all and not isinstance(entry_ids, list):
                return web.json_response({"error": "entry_ids deve ser uma lista", "code": "INVALID_ENTRY_IDS"}, status=400)

            result = await self._file_manager.empty_trash(entry_ids, purge_all=purge_all)
            status = 207 if result.get("errors") else 200
            return web.json_response({
                "status": "ok" if not result.get("errors") else "partial",
                "purged_roots": int(result.get("purged_roots") or 0),
                "purged_files": int(result.get("purged_files") or 0),
                "purged_directories": int(result.get("purged_directories") or 0),
                "errors": result.get("errors", []),
            }, status=status)
        except Exception as e:
            logger.error(f"Error emptying trash: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_playback_progress(self, request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "Payload JSON inválido."}, status=400)

        raw_path = data.get("path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            return web.json_response({"error": "path é obrigatório."}, status=400)
        if bool(data.get("local")):
            return web.json_response({"ok": True, "stored": False, "local": True})

        resolved_request = await self._resolve_cloud_file_request(raw_path)
        normalized_path = resolved_request.get("resolved_path") or resolved_request.get("normalized_path") or _normalize_virtual_folder(raw_path)
        if normalized_path == "/":
            return web.json_response({"error": "Arquivo inválido."}, status=400)

        file_meta = resolved_request.get("file_meta")
        if not file_meta:
            return web.json_response({"error": "Arquivo não encontrado."}, status=404)
        if file_meta.get("is_directory"):
            return web.json_response({"error": "Resume só é suportado para arquivos."}, status=400)

        position_seconds = _safe_float(data.get("position_seconds"))
        duration_seconds = _safe_float(data.get("duration_seconds"))
        if position_seconds is None:
            return web.json_response({"error": "position_seconds é obrigatório."}, status=400)
        position_seconds = max(0.0, position_seconds)

        stored_duration_seconds = _safe_float((file_meta.get("meta") or {}).get("duration"))
        if duration_seconds is None and stored_duration_seconds is not None:
            duration_seconds = stored_duration_seconds
        if duration_seconds is not None and duration_seconds <= 0:
            duration_seconds = None

        percent = _safe_float(data.get("percent"))
        if percent is None and duration_seconds and duration_seconds > 0:
            percent = position_seconds / duration_seconds
        if percent is not None:
            percent = max(0.0, min(1.0, percent))

        reason = str(data.get("reason") or "").strip().lower()
        source = str(data.get("source") or "web").strip() or "web"
        should_clear = (
            bool(data.get("clear"))
            or reason == "ended"
            or position_seconds <= 5
            or (percent is not None and percent >= 0.95)
        )

        if should_clear:
            await self._file_manager.clear_playback_resume(normalized_path)
            return web.json_response({
                "ok": True,
                "cleared": True,
                "resume": None,
            })

        resume_payload = await self._file_manager.save_playback_resume(normalized_path, {
            "position_seconds": position_seconds,
            "duration_seconds": duration_seconds,
            "percent": percent,
            "source": source,
        })
        if not resume_payload:
            return web.json_response({"error": "Não foi possível salvar o progresso."}, status=500)

        logger.info(
            "Playback progress saved: path=%s position=%.2fs percent=%s reason=%s source=%s",
            normalized_path,
            position_seconds,
            f"{percent:.4f}" if percent is not None else "unknown",
            reason or "unspecified",
            source,
        )
        return web.json_response({
            "ok": True,
            "cleared": False,
            "resume": resume_payload,
        })

    async def _handle_api_server_downloads(self, request):
        """Get list of files currently being downloaded to the server cache."""
        try:
            active_paths = list(self._file_manager._cache._active_offline_downloads)
            results = []
            for path in active_paths:
                file_meta = await self._file_manager.get_file_meta(path)
                if file_meta:
                    status = self._file_manager._cache.get_cache_status(path, file_meta.get("chunks", []))
                    results.append({
                        "id": path,
                        "name": file_meta.get("filename") or path.split("/")[-1],
                        "path": path,
                        "percent": status["percent"],
                        "cached_bytes": status["cached_bytes"],
                        "total_bytes": status["total_bytes"],
                        "is_torrent": False
                    })
                    
            if self._torrent_manager:
                for job_id, state in self._torrent_manager.active_torrents.items():
                    if state.get("status") in ["downloading", "pending", "uploading", "paused", "completed"]:
                        results.append({
                            "id": job_id,
                            "name": state.get("name") or "Download Torrent",
                            "path": f"{state.get('target_path', '')}/{state.get('name', 'torrent')}",
                            "target_folder": state.get("target_path", "/"),
                            # Phase-aware fields
                            "phase": state.get("phase", "downloading_pieces"),
                            "download_mode": state.get("download_mode", "full"),
                            "selection_scope": state.get("selection_scope", "all"),
                            "selected_file_count": state.get("selected_file_count", 0),
                            "is_selective": state.get("is_selective", False),
                            # Logical file metrics
                            "selected_logical_bytes_done": state.get("selected_logical_bytes_done", 0),
                            "selected_logical_bytes_total": state.get("selected_logical_bytes_total", 0),
                            # Piece-level metrics
                            "required_piece_bytes_done": state.get("required_piece_bytes_done", 0),
                            "required_piece_bytes_total": state.get("required_piece_bytes_total", 0),
                            "swarm_downloaded_bytes": state.get("swarm_downloaded_bytes", 0),
                            "swarm_total_bytes": state.get("swarm_total_bytes", 0),
                            "minimum_overhead_bytes": state.get("minimum_overhead_bytes", 0),
                            "current_overhead_bytes": state.get("current_overhead_bytes", 0),
                            # Cloud upload metrics  
                            "cloud_upload_bytes_done": state.get("cloud_upload_bytes_done", 0),
                            "cloud_upload_bytes_total": state.get("cloud_upload_bytes_total", 0),
                            # Speeds
                            "torrent_download_speed": state.get("torrent_download_speed", 0),
                            "cloud_upload_speed": state.get("cloud_upload_speed", 0),
                            "num_peers": state.get("num_peers", 0),
                            # Legacy compat
                            "percent": state.get("progress", 0),
                            "cached_bytes": state.get("downloaded", 0),
                            "total_bytes": state.get("total", 0),
                            "selected_ready_at": state.get("ts_selected_ready"),
                            "is_torrent": True,
                            "speed": state.get("speed", ""),
                            "state": state.get("status", "downloading")
                        })
                        
            return web.json_response({"downloads": results})
        except Exception as e:
            logger.error(f"Error getting server downloads: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_torrent_status(self, request):
        if not self._torrent_manager:
            return web.json_response({"error": "Torrent manager indisponível"}, status=500)
            
        active_list = []
        for job_id, state in self._torrent_manager.active_torrents.items():
            active_list.append({
                "id": job_id,
                **state
            })
            
        return web.json_response({"torrents": active_list})

    async def _handle_api_torrent_add(self, request):
        if not self._torrent_manager:
            return web.json_response({"error": "Torrent manager indisponível"}, status=500)
        
        try:
            data = await request.json()
            magnet = data.get("magnet")
            if not magnet or not isinstance(magnet, str) or not magnet.strip():
                return web.json_response({"error": "Magnet link ausente ou inválido"}, status=400)
                
            # Ler aliases canonicos e legacy
            target_path = data.get("target_path")
            if target_path is None:
                if "path" in data:
                    target_path = data.get("path")
                    logger.warning("Client is using legacy 'path' parameter for torrent add.")
                else:
                    target_path = "/"
            
            selected_indices = data.get("selected_indices")
            if selected_indices is None and "indices" in data:
                selected_indices = data.get("indices")
                logger.warning("Client is using legacy 'indices' parameter for torrent add.")
                
            if selected_indices is not None and not isinstance(selected_indices, list):
                return web.json_response({"error": "selected_indices deve ser uma lista"}, status=400)
            
            name = data.get("name")
            if name and ('/' in name or '\\' in name):
                return web.json_response({"error": "Nome do torrent contém barras"}, status=400)
            
            torrent_file = data.get("torrent_file")
                
            job_id = await self._torrent_manager.download_and_upload(magnet, target_path, selected_indices, name, torrent_file=torrent_file)
            return web.json_response({"status": "started", "job_id": job_id})
        except Exception as e:
            logger.error(f"Error adding torrent: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_torrent_info(self, request):
        if not self._torrent_manager:
            return web.json_response({"error": "Torrent manager indisponível"}, status=500)
            
        try:
            data = await request.json()
            magnet = data.get("magnet")
            torrent_file = data.get("torrent_file")
            torrent_url = data.get("torrent_url")
            torrent_source = magnet or torrent_file or torrent_url
            
            if not torrent_source:
                return web.json_response({"error": "Magnet link ou arquivo .torrent ausente"}, status=400)
                
            info = await self._torrent_manager.get_info(torrent_source)
            return web.json_response(info)
        except Exception as e:
            logger.error(f"Error getting torrent info: {e}")
            payload = getattr(e, "payload", None)
            status = getattr(e, "status", 500)
            if isinstance(payload, dict):
                return web.json_response(payload, status=status)
            return web.json_response({"error": str(e)}, status=status)

    async def _handle_api_torrent_pause(self, request):
        if not self._torrent_manager:
            return web.json_response({"error": "Torrent manager indisponível"}, status=500)
        try:
            data = await request.json()
            job_id = data.get("job_id")
            if not job_id:
                return web.json_response({"error": "job_id ausente"}, status=400)
            await self._torrent_manager.pause_torrent(job_id)
            return web.json_response({"status": "ok"})
        except Exception as e:
            logger.error(f"Error pausing torrent: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_torrent_resume(self, request):
        if not self._torrent_manager:
            return web.json_response({"error": "Torrent manager indisponível"}, status=500)
        try:
            data = await request.json()
            job_id = data.get("job_id")
            if not job_id:
                return web.json_response({"error": "job_id ausente"}, status=400)
            await self._torrent_manager.resume_torrent(job_id)
            return web.json_response({"status": "ok"})
        except Exception as e:
            logger.error(f"Error resuming torrent: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_torrent_cancel(self, request):
        if not self._torrent_manager:
            return web.json_response({"error": "Torrent manager indisponível"}, status=500)
        try:
            data = await request.json()
            job_id = data.get("job_id")
            if not job_id:
                return web.json_response({"error": "job_id ausente"}, status=400)
            await self._torrent_manager.cancel_torrent(job_id)
            return web.json_response({"status": "ok"})
        except Exception as e:
            logger.error(f"Error cancelling torrent: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_local_files(self, request):
        # List *LOCAL* directory contents as JSON
        # Security Note: This exposes the host filesystem to the web UI.
        path = request.query.get("path", str(Path.home()))
        
        # Basic security: prevent traversing up if needed, but for "My Computer" we want full access?
        # For now, let's just use the path provided.
        
        try:
            # We use a completely separate Python subprocess to scan the directory.
            # Why? Because macOS TCC prompts ("Python wants to access your Desktop")
            # put the ENTIRE requesting process to sleep (SIGSTOP-like behavior) until 
            # the user clicks 'Allow'. If the main Python server sleeps, FUSE-T times
            # out and the NFS mount crashes. By isolating this to a child process, 
            # only the child process is suspended by macOS while the main server continues!
            script = """
import os, sys, json, stat
from datetime import datetime

path = sys.argv[1]
try:
    p = os.path.abspath(path)
    if not os.path.exists(p):
        print(json.dumps({"error": "Caminho não encontrado"}))
        sys.exit(0)
        
    results = []
    with os.scandir(p) as it:
        for entry in it:
            try:
                st = entry.stat(follow_symlinks=False)
                is_dir = entry.is_dir(follow_symlinks=False)
                results.append({
                    "name": entry.name,
                    "path": os.path.abspath(entry.path),
                    "is_directory": is_dir,
                    "size": st.st_size if not is_dir else 0,
                    "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
                    "created_at": datetime.fromtimestamp(st.st_ctime).isoformat(),
                    "is_favorite": False
                })
            except (PermissionError, FileNotFoundError, OSError):
                continue
                
    results.sort(key=lambda x: (not x['is_directory'], x['name'].lower()))
    print(json.dumps({"items": results, "path": p}))
except PermissionError:
    print(json.dumps({"error": "Permissão negada"}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
"""
            # Run the child process asynchronously
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-c", script, path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await proc.communicate()
            
            if proc.returncode != 0:
                logger.error(f"Local scanner error: {stderr.decode()}")
                return web.json_response({"error": "Falha ao escanear diretório"}, status=500)
                
            try:
                result_data = json.loads(stdout.decode())
            except json.JSONDecodeError:
                return web.json_response({"error": "Resposta inválida do scanner"}, status=500)
                
            if "error" in result_data:
                err = result_data["error"]
                status = 404 if "not found" in err else (403 if "denied" in err else 500)
                return web.json_response({"error": err}, status=status)
                
            return web.json_response(result_data)

        except Exception as e:
            logger.error(f"Error listing local {path}: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _probe_ffprobe_metadata(self, input_path: str | None, is_concat: bool = False) -> tuple[dict, list[str]]:
        if not input_path:
            return {}, ["Metadados avançados indisponíveis para este item."]

        cmd = ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"]
        if is_concat:
            cmd.extend(["-f", "concat", "-safe", "0", "-i", input_path])
        else:
            cmd.extend(["-i", input_path])

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        except asyncio.TimeoutError:
            return {}, ["Timeout ao extrair metadados avançados."]
        except FileNotFoundError:
            return {}, ["ffprobe não está disponível no ambiente."]
        except Exception as exc:
            logger.debug(f"ffprobe metadata probe failed for {input_path}: {exc}")
            return {}, ["Não foi possível extrair metadados avançados de mídia."]

        if proc.returncode != 0:
            return {}, ["Não foi possível extrair metadados avançados de mídia."]

        try:
            return json.loads(stdout or b"{}"), []
        except json.JSONDecodeError:
            return {}, ["Resposta inválida ao extrair metadados avançados."]

    async def _get_cloud_item_entry(self, raw_path: str) -> dict | None:
        normalized = _normalize_virtual_folder(raw_path)
        if normalized == "/":
            return {
                "name": "/",
                "path": "/",
                "is_directory": True,
                "size": 0,
                "created_at": None,
                "modified_at": None,
                "is_favorite": False,
                "is_offline": False,
            }

        parent = str(Path(normalized).parent)
        if parent in ("", "."):
            parent = "/"

        try:
            items = await self._file_manager.list_directory(parent)
        except Exception as exc:
            logger.debug(f"Could not list parent directory for info modal {normalized}: {exc}")
            return None

        for item in items:
            if item.get("path") == normalized:
                return item
        return None

    @staticmethod
    def _normalize_filename_for_resolution(value: str | None) -> str:
        return unicodedata.normalize("NFC", str(value or "").strip())

    async def _resolve_cloud_file_request(self, raw_path: str | None, *, filename_hint: str | None = None) -> dict:
        requested_path = str(raw_path or "").strip()
        normalized_path = _normalize_cloud_path_variant(requested_path)
        resolved = {
            "requested_path": requested_path,
            "normalized_path": normalized_path,
            "decoded_path": "",
            "filename_hint": str(filename_hint or "").strip(),
            "resolved_path": "",
            "resolver_source": "",
            "file_meta": None,
            "attempts": [],
        }
        if not requested_path or normalized_path == "/":
            return resolved

        seen_paths: set[str] = set()
        candidates: list[tuple[str, str]] = []

        def add_candidate(source: str, candidate_path: str | None) -> None:
            normalized_candidate = _normalize_cloud_path_variant(candidate_path)
            if normalized_candidate == "/" or normalized_candidate in seen_paths:
                return
            seen_paths.add(normalized_candidate)
            candidates.append((source, normalized_candidate))

        add_candidate("exact", normalized_path)
        add_candidate("nfc", unicodedata.normalize("NFC", normalized_path))
        add_candidate("nfd", unicodedata.normalize("NFD", normalized_path))

        if _PERCENT_ENCODED_PATH_RE.search(requested_path):
            decoded_path = unquote(requested_path)
            normalized_decoded_path = _normalize_cloud_path_variant(decoded_path)
            resolved["decoded_path"] = normalized_decoded_path
            add_candidate("url_decoded", normalized_decoded_path)
            add_candidate("url_decoded_nfc", unicodedata.normalize("NFC", normalized_decoded_path))
            add_candidate("url_decoded_nfd", unicodedata.normalize("NFD", normalized_decoded_path))

        for source, candidate_path in candidates:
            file_meta = await self._file_manager.get_file_meta(candidate_path)
            attempt = {
                "source": source,
                "path": candidate_path,
                "found": bool(file_meta),
            }
            if file_meta:
                resolved_path = _normalize_cloud_path_variant(file_meta.get("path") or candidate_path)
                attempt["resolved_path"] = resolved_path
                resolved["resolved_path"] = resolved_path
                resolved["resolver_source"] = source
                resolved["file_meta"] = file_meta
                resolved["attempts"].append(attempt)
                return resolved
            resolved["attempts"].append(attempt)

        filename_candidates = [
            self._normalize_filename_for_resolution(filename_hint),
            self._normalize_filename_for_resolution(Path(normalized_path).name),
        ]
        for _source, candidate_path in candidates:
            filename_candidates.append(self._normalize_filename_for_resolution(Path(candidate_path).name))
        filename_candidates = [name for index, name in enumerate(filename_candidates) if name and name not in filename_candidates[:index]]
        parent_candidates: list[str] = []
        for _source, candidate_path in candidates:
            parent = str(Path(candidate_path).parent)
            if parent in ("", "."):
                parent = "/"
            parent = _normalize_cloud_path_variant(parent)
            if parent not in parent_candidates:
                parent_candidates.append(parent)

        for parent in parent_candidates:
            try:
                items = await self._file_manager.list_directory(parent)
            except Exception as exc:
                resolved["attempts"].append({
                    "source": "parent_filename_hint",
                    "path": parent,
                    "filename_hint": resolved["filename_hint"],
                    "found": False,
                    "error": str(exc),
                })
                continue

            matches = []
            for item in items or []:
                item_path = _normalize_cloud_path_variant(item.get("path") or "")
                item_name = self._normalize_filename_for_resolution(
                    item.get("filename") or item.get("name") or Path(item_path).name
                )
                if item.get("is_directory") or not item_path or item_name not in filename_candidates:
                    continue
                matches.append((item_path, item_name))

            attempt = {
                "source": "parent_filename_hint",
                "path": parent,
                "filename_hint": resolved["filename_hint"],
                "matches": [match_path for match_path, _match_name in matches[:5]],
                "found": len(matches) == 1,
            }
            if len(matches) == 1:
                match_path, _match_name = matches[0]
                file_meta = await self._file_manager.get_file_meta(match_path)
                if file_meta:
                    resolved_path = _normalize_cloud_path_variant(file_meta.get("path") or match_path)
                    attempt["resolved_path"] = resolved_path
                    resolved["resolved_path"] = resolved_path
                    resolved["resolver_source"] = "parent_filename_hint"
                    resolved["file_meta"] = file_meta
                    resolved["attempts"].append(attempt)
                    return resolved
                attempt["found"] = False
                attempt["missing_meta"] = True
            elif len(matches) > 1:
                attempt["ambiguous"] = True
            resolved["attempts"].append(attempt)

        return resolved

    async def _build_file_info_payload(self, raw_path: str, is_local: bool) -> dict:
        limitations: list[str] = []
        suffix = Path(raw_path).suffix.lower() or None
        item_name = Path(raw_path).name or raw_path or "/"

        is_directory = False
        file_meta = None
        size_bytes = 0
        created_at = None
        modified_at = None
        is_favorite = False
        is_offline = False
        is_cached = False
        meta = {}

        if is_local:
            local_path = Path(raw_path)
            if not local_path.exists():
                raise FileNotFoundError(f"Caminho não encontrado: {raw_path}")
            stat_info = local_path.stat()
            is_directory = local_path.is_dir()
            size_bytes = 0 if is_directory else stat_info.st_size
            created_at = datetime.fromtimestamp(stat_info.st_ctime).isoformat()
            modified_at = datetime.fromtimestamp(stat_info.st_mtime).isoformat()
        else:
            resolved_request = await self._resolve_cloud_file_request(raw_path)
            normalized_path = resolved_request.get("resolved_path") or resolved_request.get("normalized_path") or _normalize_virtual_folder(raw_path)
            file_meta = resolved_request.get("file_meta")
            if file_meta:
                item_name = file_meta.get("filename") or item_name
                size_bytes = file_meta.get("size", 0)
                created_at = _iso_or_none(file_meta.get("created_at"))
                modified_at = _iso_or_none(file_meta.get("modified_at"))
                meta = dict(file_meta.get("meta", {}) or {})
                chunks = file_meta.get("chunks", [])
                is_cached = self._file_manager._cache.is_file_cached(normalized_path, chunks) if chunks else False
                is_favorite = bool(file_meta.get("is_favorite", False))
                is_offline = bool(file_meta.get("is_offline", False))
            else:
                if not await self._file_manager.is_directory(normalized_path):
                    raise FileNotFoundError(f"Arquivo não encontrado: {normalized_path}")
                is_directory = True
                base_entry = await self._get_cloud_item_entry(normalized_path)
                if base_entry:
                    item_name = base_entry.get("name") or item_name
                    created_at = _iso_or_none(base_entry.get("created_at"))
                    modified_at = _iso_or_none(base_entry.get("modified_at"))
                    is_favorite = bool(base_entry.get("is_favorite", False))
                    is_offline = bool(base_entry.get("is_offline", False))
                raw_path = normalized_path

        mime_type = None if is_directory else (meta.get("mime_type") if meta else None) or mimetypes.guess_type(item_name)[0] or "application/octet-stream"
        extension = suffix or (Path(item_name).suffix.lower() or None)
        local_probe_path: Path | None = None

        if is_local:
            candidate = Path(raw_path)
            if candidate.exists() and candidate.is_file():
                local_probe_path = candidate
        elif file_meta:
            cached_path = self._file_manager.get_cached_file_path(file_meta, raw_path)
            if cached_path and Path(cached_path).exists():
                local_probe_path = Path(cached_path)

        if is_directory:
            if is_local:
                try:
                    with os.scandir(raw_path) as iterator:
                        directory_count = 0
                        file_count = 0
                        for entry in iterator:
                            if entry.is_dir(follow_symlinks=False):
                                directory_count += 1
                            else:
                                file_count += 1
                    meta["directory_count"] = directory_count
                    meta["file_count"] = file_count
                    meta["item_count"] = directory_count + file_count
                except Exception as exc:
                    logger.debug(f"Could not count local folder entries for {raw_path}: {exc}")
                    limitations.append("Não foi possível contar os itens da pasta local.")
            else:
                try:
                    items = await self._file_manager.list_directory(raw_path)
                    directory_count = sum(1 for item in items if item.get("is_directory"))
                    file_count = len(items) - directory_count
                    meta["directory_count"] = directory_count
                    meta["file_count"] = file_count
                    meta["item_count"] = len(items)
                except Exception as exc:
                    logger.debug(f"Could not count cloud folder entries for {raw_path}: {exc}")
                    limitations.append("Não foi possível contar os itens da pasta cloud.")
        else:
            if extension == ".pdf":
                if local_probe_path:
                    pdf_meta = await asyncio.to_thread(scan_pdf_metadata, local_probe_path)
                    meta.update({key: value for key, value in pdf_meta.items() if value is not None})
                elif not meta.get("page_count"):
                    limitations.append("Metadados avançados de PDF exigem o arquivo local ou em cache.")

            if mime_type and mime_type.startswith("image/") and local_probe_path:
                image_meta = await asyncio.to_thread(scan_image_metadata, local_probe_path)
                meta.update({key: value for key, value in image_meta.items() if value is not None})

            if mime_type and (
                mime_type.startswith("audio/")
                or mime_type.startswith("video/")
                or mime_type.startswith("image/")
            ):
                input_path, is_concat = await self._get_file_input_path(raw_path, is_local)
                probe_data, probe_limitations = await self._probe_ffprobe_metadata(input_path, is_concat)
                limitations.extend(probe_limitations)
                if probe_data:
                    fmt = probe_data.get("format", {})
                    streams = probe_data.get("streams", [])
                    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
                    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
                    subtitle_streams = [stream for stream in streams if stream.get("codec_type") == "subtitle"]

                    duration = _safe_float(fmt.get("duration"))
                    if duration is not None:
                        meta["duration"] = duration
                    bitrate = _safe_int(fmt.get("bit_rate"))
                    if bitrate is not None:
                        meta["bitrate"] = bitrate
                    if fmt.get("format_name"):
                        meta["container"] = fmt.get("format_name")

                    if audio_streams:
                        primary_audio = audio_streams[0]
                        meta["audio_codec"] = primary_audio.get("codec_name") or meta.get("audio_codec")
                        sample_rate = _safe_int(primary_audio.get("sample_rate"))
                        if sample_rate is not None:
                            meta["sample_rate"] = sample_rate
                        channels = _safe_int(primary_audio.get("channels"))
                        if channels is not None:
                            meta["channels"] = channels
                    if video_streams:
                        primary_video = video_streams[0]
                        width = _safe_int(primary_video.get("width"))
                        height = _safe_int(primary_video.get("height"))
                        if width is not None:
                            meta["width"] = width
                        if height is not None:
                            meta["height"] = height
                        meta["video_codec"] = primary_video.get("codec_name") or meta.get("video_codec")
                        fps = _parse_probe_rate(primary_video.get("avg_frame_rate") or primary_video.get("r_frame_rate"))
                        if fps is not None:
                            meta["fps"] = fps

                    meta["audio_track_count"] = len(audio_streams)
                    meta["subtitle_track_count"] = len(subtitle_streams)

        preview = {"available": False, "kind": "icon", "url": None}
        if not is_directory:
            quoted_path = quote(raw_path, safe="/")
            preview_asset_path = ""
            preview_asset = meta.get("preview_asset") if isinstance(meta.get("preview_asset"), dict) else None
            if preview_asset:
                candidate_path = preview_asset.get("path")
                if isinstance(candidate_path, str) and candidate_path.strip():
                    preview_asset_path = candidate_path
            if mime_type and mime_type.startswith("image/"):
                preview = {
                    "available": True,
                    "kind": "image",
                    "url": f"/stream{quoted_path}?local=true" if is_local else f"/stream{quoted_path}",
                }
            elif not is_local and mime_type and (
                mime_type.startswith("audio/")
                or mime_type.startswith("video/")
                or mime_type == "application/pdf"
            ):
                preview = {
                    "available": True,
                    "kind": "thumbnail",
                    "url": f"/api/thumbnail?path={quote(preview_asset_path or raw_path, safe='')}",
                }

        storage = {
            "origin": "local" if is_local else "cloud",
            "chunk_count": len(file_meta.get("chunks", [])) if file_meta else 0,
            "storage_scheme": file_meta.get("storage_scheme") if file_meta else None,
            "storage_id_masked": _mask_storage_id(file_meta.get("storage_id")) if file_meta else None,
        }

        sharing_state = {}
        if not is_local:
            sharing_state = await self._file_manager.describe_sharing_state(
                normalized_path,
                is_directory=is_directory,
            )

        return {
            "name": item_name,
            "path": raw_path,
            "is_directory": is_directory,
            "mime_type": mime_type,
            "extension": extension,
            "size_bytes": size_bytes,
            "created_at": created_at,
            "modified_at": modified_at,
            "status": {
                "is_favorite": is_favorite,
                "is_offline": is_offline,
                "is_cached": is_cached,
            },
            "storage": storage,
            "meta": meta,
            "preview": preview,
            "limitations": limitations,
            "sharing": sharing_state,
        }

    async def _handle_api_file_info(self, request):
        raw_path = request.query.get("path", "").strip()
        is_local = request.query.get("local") == "true"
        if not raw_path:
            return web.json_response({"error": "path is required"}, status=400)

        try:
            payload = await self._build_file_info_payload(raw_path, is_local)
            if not is_local:
                payload["sharing"] = self._serialize_owner_sharing_state(request, payload.get("sharing"))
            return web.json_response(payload)
        except FileNotFoundError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except Exception as exc:
            logger.error(f"Error getting file info for {raw_path}: {exc}", exc_info=True)
            return web.json_response({"error": str(exc)}, status=500)

    async def _handle_api_share(self, request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "JSON inválido"}, status=400)

        raw_path = str(data.get("path") or "").strip()
        if not raw_path:
            return web.json_response({"error": "path is required"}, status=400)
        if raw_path == "/":
            return web.json_response({"error": "Não é permitido compartilhar a raiz do TCloud"}, status=400)

        try:
            expires_at = self._parse_public_share_expires_at(data.get("expires_at"))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

        try:
            inheritance_override = str(data.get("inheritance_override") or "").strip().lower()
            if inheritance_override not in {"", "inherit", "hidden"}:
                return web.json_response({"error": "inheritance_override inválido"}, status=400)
            create_direct_link_raw = data.get("create_direct_link", True)
            create_direct_link = not (
                create_direct_link_raw is False
                or str(create_direct_link_raw).strip().lower() in {"0", "false", "no"}
            )
            target_kind = None
            target_doc = None
            if inheritance_override:
                target_kind, target_doc = await self._file_manager.set_share_inheritance_override(
                    raw_path,
                    hidden=inheritance_override == "hidden",
                )
            if create_direct_link:
                target_kind, target_doc = await self._file_manager.configure_share(
                    raw_path,
                    password_enabled=bool(data.get("password_enabled")),
                    password=str(data.get("password") or ""),
                    expires_at=expires_at,
                    max_access=data.get("max_access"),
                    regenerate_link=bool(data.get("regenerate_link")),
                    reset_access_count=bool(data.get("reset_access_count")),
                )
            if not target_kind or not target_doc:
                entry_kind, entry_doc = await self._file_manager._db.get_entry(raw_path)
                if not entry_kind or not entry_doc:
                    raise FileNotFoundError(f"Item not found: {raw_path}")
                target_kind, target_doc = entry_kind, entry_doc
            sharing_state = self._serialize_owner_sharing_state(
                request,
                await self._file_manager.describe_sharing_state(
                    raw_path,
                    is_directory=target_kind == "directory",
                ),
            )
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except FileNotFoundError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except Exception as exc:
            logger.error("Error configuring public share for %s: %s", raw_path, exc, exc_info=True)
            return web.json_response({"error": "Falha ao configurar compartilhamento"}, status=500)

        return web.json_response({
            "status": "ok",
            "path": str(target_doc.get("path") or raw_path),
            "is_directory": target_kind == "directory",
            "sharing": sharing_state,
        })

    async def _handle_api_share_delete(self, request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "JSON inválido"}, status=400)

        raw_path = str(data.get("path") or "").strip()
        if not raw_path:
            return web.json_response({"error": "path is required"}, status=400)

        try:
            await self._file_manager.remove_share(raw_path)
        except FileNotFoundError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except Exception as exc:
            logger.error("Error removing public share for %s: %s", raw_path, exc, exc_info=True)
            return web.json_response({"error": "Falha ao remover compartilhamento"}, status=500)

        return web.json_response({"status": "ok", "path": raw_path})

    async def _handle_shared_item_page(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        template_path = Path(__file__).parent / "templates" / "shared_item.html"
        if not template_path.exists():
            return web.Response(text="Template not found", status=500)
        html = template_path.read_text(encoding="utf-8").replace("__PUBLIC_SHARE_ID__", json.dumps(public_id))
        return web.Response(text=html, content_type="text/html")

    async def _handle_api_shared_item(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        if not public_id:
            payload, status = self._public_share_error_payload(
                public_id,
                code="share_not_found",
                message="Link público não encontrado.",
                status=404,
            )
            return web.json_response(payload, status=status)

        try:
            target_kind, target_doc = await self._file_manager.get_shared_target(public_id)
        except PublicShareError as exc:
            payload, status = self._public_share_error_payload(public_id, code=exc.code, message=exc.message, status=exc.status)
            return web.json_response(payload, status=status)
        except Exception as exc:
            logger.error("Error loading public share summary for %s: %s", public_id, exc, exc_info=True)
            payload, status = self._public_share_error_payload(
                public_id,
                code="share_unavailable",
                message="Falha ao carregar link público.",
                status=500,
            )
            return web.json_response(payload, status=status)

        summary = self._build_public_share_summary_payload(request, public_id, target_kind, target_doc)
        if summary.get("expired"):
            payload, status = self._public_share_error_payload(
                public_id,
                code="share_expired",
                message="Este link público expirou.",
                status=410,
            )
            return web.json_response(payload, status=status)
        if summary.get("access_exhausted"):
            payload, status = self._public_share_error_payload(
                public_id,
                code="share_access_exhausted",
                message="Este link público atingiu o limite de acessos.",
                status=410,
            )
            return web.json_response(payload, status=status)
        return web.json_response(summary)

    async def _handle_api_shared_item_access(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        try:
            data = await request.json()
        except Exception:
            data = {}

        password = str((data or {}).get("password") or "")
        try:
            target_kind, target_doc = await self._file_manager.grant_public_share_access(public_id, password=password)
            session_expires_at = datetime.now(timezone.utc) + timedelta(seconds=1800)
            share_token = create_public_share_token(
                public_id=public_id,
                path=str(target_doc.get("path") or ""),
                is_directory=target_kind == "directory",
                secret=Config.JWT_SECRET,
                expiry_seconds=1800,
            )
        except PublicShareError as exc:
            payload, status = self._public_share_error_payload(public_id, code=exc.code, message=exc.message, status=exc.status)
            return web.json_response(payload, status=status)
        except Exception as exc:
            logger.error("Error granting public share access for %s: %s", public_id, exc, exc_info=True)
            payload, status = self._public_share_error_payload(
                public_id,
                code="share_unavailable",
                message="Falha ao liberar acesso ao link público.",
                status=500,
            )
            return web.json_response(payload, status=status)

        item_payload = self._build_public_share_item_payload(
            request,
            public_id,
            target_kind,
            target_doc,
            share_token=share_token,
        )
        if target_kind == "directory":
            item_payload["browse_url"] = (
                f"/api/shared_item/{quote(public_id, safe='')}/browse?token={quote(share_token, safe='')}"
            )

        return web.json_response({
            "status": "ok",
            "public_id": public_id,
            "share_token": share_token,
            "session_expires_at": session_expires_at.isoformat(),
            "item": item_payload,
        })

    async def _handle_api_shared_item_browse(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        relative_path = str(request.query.get("path") or "").strip()
        started_at = time.perf_counter()
        try:
            token_payload, target_kind, target_doc = await self._resolve_public_share_session(request, public_id)
            if target_kind != "directory":
                return web.json_response({"error": "Este link público não aponta para uma pasta"}, status=400)

            root_path = str(target_doc.get("path") or "").strip()
            current_path = await self._file_manager.resolve_public_share_path(
                root_path,
                relative_path,
                expect_directory=True,
                enforce_visibility=True,
            )
            items = await self._file_manager.list_public_directory(root_path, current_path)
            current_relative_path = self._file_manager.normalize_public_share_relative_path(relative_path)
            share_token = self._request_bearer_token(request)
            zip_base = f"/api/shared_item/{quote(public_id, safe='')}/download_zip"

            serialized_items = []
            for item in items:
                full_path = str(item.get("path") or "").strip()
                if not full_path.startswith(root_path):
                    continue
                item_relative_path = self._file_manager.normalize_public_share_relative_path(
                    full_path[len(root_path):].lstrip("/")
                )
                item_meta = item.get("meta", {}) if isinstance(item.get("meta"), dict) else {}
                mime_type = item_meta.get("mime_type") or mimetypes.guess_type(item.get("name") or "")[0]
                base_stream = f"/stream/shared/{quote(public_id, safe='')}"
                if item_relative_path:
                    base_stream += f"/{quote(item_relative_path, safe='/')}"
                stream_query = f"?token={quote(share_token, safe='')}"
                download_query = f"?download=true&token={quote(share_token, safe='')}"
                zip_query = f"?path={quote(item_relative_path, safe='/')}&token={quote(share_token, safe='')}"
                serialized_item = {
                    "name": item.get("name") or "",
                    "is_directory": bool(item.get("is_directory")),
                    "size": int(item.get("size") or 0),
                    "mime_type": mime_type,
                    "modified_at": _iso_or_none(item.get("modified_at")) or _iso_or_none(item.get("created_at")) or "",
                    "relative_path": item_relative_path,
                    "stream_url": "" if item.get("is_directory") else f"{base_stream}{stream_query}",
                    "download_url": f"{zip_base}{zip_query}" if item.get("is_directory") else f"{base_stream}{download_query}",
                    "download_kind": "zip" if item.get("is_directory") else "file",
                }
                serialized_item.update(self._build_public_media_capabilities(
                    serialized_item["name"],
                    mime_type,
                    bool(item.get("is_directory")),
                    item_meta,
                ))
                serialized_items.append(serialized_item)

            parent_relative_path = ""
            if current_relative_path:
                parent_relative_path = current_relative_path.rsplit("/", 1)[0] if "/" in current_relative_path else ""

            current_name = (
                str(target_doc.get("path") or "/").rstrip("/").rsplit("/", 1)[-1]
                if not current_relative_path
                else str(current_path).rstrip("/").rsplit("/", 1)[-1]
            ) or "Compartilhado"
            root_name = str(target_doc.get("path") or "/").rstrip("/").rsplit("/", 1)[-1] or "Compartilhado"
            root_download_url = f"{zip_base}?path=&token={quote(share_token, safe='')}"
            current_download_url = (
                f"{zip_base}?path={quote(current_relative_path, safe='/')}&token={quote(share_token, safe='')}"
            )

            return web.json_response({
                "public_id": public_id,
                "path": current_relative_path,
                "name": current_name,
                "items": serialized_items,
                "parent_relative_path": parent_relative_path,
                "root_name": root_name,
                "session_public_id": str(token_payload.get("public_id") or public_id),
                "root_download_url": root_download_url,
                "current_download_url": current_download_url,
                "download_url": current_download_url,
                "download_kind": "zip",
                "elapsed_ms": round((time.perf_counter() - started_at) * 1000, 2),
            })
        except PublicShareError as exc:
            return web.json_response({"error": exc.message, "code": exc.code}, status=exc.status)
        except web.HTTPException:
            raise
        except Exception as exc:
            logger.error("Error browsing public share %s: %s", public_id, exc, exc_info=True)
            return web.json_response({"error": "Falha ao listar pasta compartilhada"}, status=500)

    def _ensure_public_share_metrics_state(self) -> None:
        if not hasattr(self, "_public_share_metrics_cache"):
            self._public_share_metrics_cache = {}
        if not hasattr(self, "_public_share_metrics_tasks"):
            self._public_share_metrics_tasks = {}
        if not hasattr(self, "_public_share_metrics_ttl_seconds"):
            self._public_share_metrics_ttl_seconds = 60
        if not hasattr(self, "_public_share_metrics_semaphore"):
            self._public_share_metrics_semaphore = asyncio.Semaphore(2)

    async def _compute_public_share_metrics(self, cache_key: tuple[str, str, str], public_id: str, root_path: str, current_path: str) -> None:
        self._ensure_public_share_metrics_state()
        started_at = time.perf_counter()
        try:
            async with self._public_share_metrics_semaphore:
                metrics = await self._file_manager.collect_public_directory_metrics(root_path, current_path)
            elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
            self._public_share_metrics_cache[cache_key] = {
                "status": "ready",
                "counts": {
                    "total_items": int(metrics.get("total_items") or 0),
                    "folders": int(metrics.get("folders") or 0),
                    "files": int(metrics.get("files") or 0),
                    "total_bytes": int(metrics.get("total_bytes") or 0),
                },
                "truncated": bool(metrics.get("truncated")),
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "created_monotonic": time.monotonic(),
                "elapsed_ms": elapsed_ms,
            }
            logger.info(
                "Public share metrics ready: public_id=%s path=%s items=%s elapsed_ms=%s",
                public_id,
                current_path,
                metrics.get("total_items"),
                elapsed_ms,
            )
        except Exception as exc:
            elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
            logger.warning(
                "Public share metrics failed: public_id=%s path=%s elapsed_ms=%s error=%s",
                public_id,
                current_path,
                elapsed_ms,
                exc,
                exc_info=True,
            )
            self._public_share_metrics_cache[cache_key] = {
                "status": "error",
                "counts": None,
                "truncated": False,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "created_monotonic": time.monotonic(),
                "elapsed_ms": elapsed_ms,
                "error": "Falha ao calcular métricas do compartilhamento.",
            }
        finally:
            self._public_share_metrics_tasks.pop(cache_key, None)

    async def _handle_api_shared_item_metrics(self, request):
        self._ensure_public_share_metrics_state()
        public_id = str(request.match_info.get("public_id") or "").strip()
        relative_path = str(request.query.get("path") or "").strip()
        refresh = str(request.query.get("refresh") or "").strip().lower() in {"1", "true", "yes"}
        try:
            _token_payload, target_kind, target_doc = await self._resolve_public_share_session(request, public_id)
            if target_kind != "directory":
                return web.json_response({"error": "Este link público não aponta para uma pasta"}, status=400)

            root_path = str(target_doc.get("path") or "").strip()
            current_path = await self._file_manager.resolve_public_share_path(
                root_path,
                relative_path,
                expect_directory=True,
                enforce_visibility=True,
            )
            current_relative_path = self._file_manager.normalize_public_share_relative_path(relative_path)
            cache_key = (public_id, root_path, current_path)
            cached = self._public_share_metrics_cache.get(cache_key)
            now = time.monotonic()
            if (
                cached
                and not refresh
                and now - float(cached.get("created_monotonic") or 0) <= self._public_share_metrics_ttl_seconds
            ):
                return web.json_response({
                    "public_id": public_id,
                    "path": current_relative_path,
                    **{key: value for key, value in cached.items() if key != "created_monotonic"},
                })

            if refresh:
                self._public_share_metrics_cache.pop(cache_key, None)

            task = self._public_share_metrics_tasks.get(cache_key)
            if not task or task.done():
                self._public_share_metrics_tasks[cache_key] = asyncio.create_task(
                    self._compute_public_share_metrics(cache_key, public_id, root_path, current_path)
                )

            return web.json_response({
                "public_id": public_id,
                "path": current_relative_path,
                "status": "computing",
                "counts": None,
                "truncated": False,
            })
        except PublicShareError as exc:
            return web.json_response({"error": exc.message, "code": exc.code}, status=exc.status)
        except web.HTTPException:
            raise
        except Exception as exc:
            logger.error("Error loading public share metrics %s: %s", public_id, exc, exc_info=True)
            return web.json_response({"error": "Falha ao carregar métricas do compartilhamento"}, status=500)

    @staticmethod
    def _safe_public_zip_filename(name: str) -> str:
        cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(name or "").strip()).strip(" .")
        if not cleaned:
            cleaned = "compartilhado"
        if not cleaned.lower().endswith(".zip"):
            cleaned += ".zip"
        return cleaned

    @staticmethod
    def _public_selection_paths_from_payload(payload: dict) -> list[str]:
        raw_paths = payload.get("paths")
        if not isinstance(raw_paths, list):
            raise ValueError("Lista de itens selecionados ausente.")
        paths = [str(path or "").strip() for path in raw_paths if str(path or "").strip()]
        if not paths:
            raise ValueError("Nenhum item selecionado.")
        if len(paths) > 500:
            raise ValueError("Seleção grande demais para esta ação.")
        return paths

    async def _public_selection_manifest_from_request(self, request, public_id: str) -> tuple[dict, str, dict, list[str], dict]:
        try:
            payload = await request.json()
        except Exception:
            raise ValueError("JSON inválido.")
        if not isinstance(payload, dict):
            raise ValueError("JSON inválido.")

        paths = self._public_selection_paths_from_payload(payload)
        _token_payload, target_kind, target_doc = await self._resolve_public_share_session(request, public_id)
        if target_kind != "directory":
            raise ValueError("Este link público não aponta para uma pasta.")

        root_path = str(target_doc.get("path") or "").strip()
        manifest = await self._file_manager.collect_public_selection_entries(root_path, paths)
        return payload, root_path, target_doc, paths, manifest

    def _public_selection_zip_filename(self, payload: dict, target_doc: dict, paths: list[str], manifest: dict) -> str:
        requested_name = str(payload.get("name") or "").strip()
        if requested_name:
            return self._safe_public_zip_filename(requested_name)

        selected_roots = manifest.get("selected_roots") if isinstance(manifest.get("selected_roots"), list) else []
        if len(paths) == 1 and selected_roots:
            root_name = str(selected_roots[0].get("relative_path") or "").strip("/").rsplit("/", 1)[-1]
            if not root_name:
                root_name = str(target_doc.get("path") or "").rstrip("/").rsplit("/", 1)[-1]
            return self._safe_public_zip_filename(root_name or "selecionado")

        root_name = str(target_doc.get("path") or "").rstrip("/").rsplit("/", 1)[-1] or "compartilhado"
        return self._safe_public_zip_filename(f"selecionados_{root_name}")

    async def _stream_public_zip_response(
        self,
        request,
        *,
        public_id: str,
        manifest: dict,
        zip_filename: str,
        archive_root: str,
        archive_label: str,
    ):
        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "application/zip",
                "Content-Disposition": f'attachment; filename="{zip_filename}"',
                "Cache-Control": "no-store",
                "X-Archive-Root": archive_label,
            },
        )
        await response.prepare(request)

        writer = _QueueBackedArchiveWriter(max_pending_chunks=8)
        loop = asyncio.get_running_loop()

        def _zip_worker() -> None:
            try:
                with zipfile.ZipFile(writer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                    archive.writestr(zipfile.ZipInfo(f"{archive_root}/"), b"")
                    for directory in manifest.get("directories") or []:
                        normalized_directory = str(directory or "").strip("/")
                        if not normalized_directory:
                            continue
                        archive.writestr(zipfile.ZipInfo(f"{archive_root}/{normalized_directory}/"), b"")

                    for entry in manifest.get("files") or []:
                        entry_archive_path = str(entry.get("archive_path") or "").strip("/")
                        if not entry_archive_path:
                            continue
                        archive_path = f"{archive_root}/{entry_archive_path}"
                        zip_info = zipfile.ZipInfo(archive_path)
                        zip_info.compress_type = zipfile.ZIP_DEFLATED
                        reader = _QueueBackedSyncReader(max_pending_chunks=8)

                        async def _producer(file_entry=entry):
                            async for chunk in self._file_manager.iter_file_chunks_for_archive(
                                file_entry["virtual_path"],
                                file_entry["file_meta"],
                            ):
                                yield chunk

                        producer_future = asyncio.run_coroutine_threadsafe(reader.pump(_producer()), loop)
                        try:
                            with archive.open(zip_info, "w", force_zip64=True) as archive_handle:
                                shutil.copyfileobj(reader, archive_handle, length=1024 * 1024)
                            producer_future.result()
                        except Exception:
                            producer_future.cancel()
                            raise
            except Exception as exc:
                logger.error("Public ZIP generation failed for %s/%s: %s", public_id, archive_label, exc, exc_info=True)
                writer.abort(exc)
            finally:
                writer.close()

        zip_task = asyncio.to_thread(_zip_worker)
        zip_future = asyncio.create_task(zip_task)
        try:
            while True:
                item = await writer.read_next()
                if writer.is_sentinel(item):
                    break
                await response.write(item)
            await zip_future
            if writer.error:
                raise writer.error
            await response.write_eof()
            return response
        except asyncio.CancelledError:
            writer.abort(ArchiveValidationError("Download cancelado."))
            zip_future.cancel()
            raise
        except Exception as exc:
            writer.abort(exc)
            zip_future.cancel()
            raise

    async def _handle_api_shared_item_selection_summary(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        try:
            _payload, _root_path, _target_doc, _paths, manifest = await self._public_selection_manifest_from_request(request, public_id)
            return web.json_response({
                "public_id": public_id,
                "status": "ready",
                "selected_count": int(manifest.get("selected_count") or 0),
                "files": int(manifest.get("file_count") or 0),
                "folders": int(manifest.get("folder_count") or 0),
                "total_items": int(manifest.get("total_items") or 0),
                "total_bytes": int(manifest.get("total_bytes") or 0),
                "truncated": bool(manifest.get("truncated")),
                "skipped_nested_count": int(manifest.get("skipped_nested_count") or 0),
            })
        except PublicShareError as exc:
            return web.json_response({"error": exc.message, "code": exc.code}, status=exc.status)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except web.HTTPException:
            raise
        except Exception as exc:
            logger.error("Error summarizing public selection %s: %s", public_id, exc, exc_info=True)
            return web.json_response({"error": "Falha ao calcular seleção compartilhada"}, status=500)

    async def _handle_api_shared_item_download_zip_selection(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        try:
            payload, _root_path, target_doc, paths, manifest = await self._public_selection_manifest_from_request(request, public_id)
            zip_filename = self._public_selection_zip_filename(payload, target_doc, paths, manifest)
            archive_root = zip_filename[:-4] or "selecionados"
            logger.info(
                "Public selected ZIP manifest ready: public_id=%s selected=%s files=%s bytes=%s",
                public_id,
                len(paths),
                manifest.get("file_count"),
                manifest.get("total_bytes"),
            )
            return await self._stream_public_zip_response(
                request,
                public_id=public_id,
                manifest=manifest,
                zip_filename=zip_filename,
                archive_root=archive_root,
                archive_label="selected",
            )
        except PublicShareError as exc:
            return web.Response(text=exc.message, status=exc.status)
        except ValueError as exc:
            return web.Response(text=str(exc), status=400)
        except web.HTTPException:
            raise
        except Exception as exc:
            logger.error("Error downloading selected public ZIP %s: %s", public_id, exc, exc_info=True)
            return web.Response(text="Falha ao compactar itens selecionados", status=500)

    async def _handle_api_shared_item_download_zip(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        relative_path = str(request.query.get("path") or "").strip()
        try:
            _token_payload, target_kind, target_doc = await self._resolve_public_share_session(request, public_id)
            if target_kind != "directory":
                return web.Response(text="Este link público não aponta para uma pasta", status=400)

            root_path = str(target_doc.get("path") or "").strip()
            current_path = await self._file_manager.resolve_public_share_path(
                root_path,
                relative_path,
                expect_directory=True,
                enforce_visibility=True,
            )
            current_relative_path = self._file_manager.normalize_public_share_relative_path(relative_path)
            folder_name = (
                str(current_path).rstrip("/").rsplit("/", 1)[-1]
                or str(target_doc.get("path") or "").rstrip("/").rsplit("/", 1)[-1]
                or "compartilhado"
            )
            zip_filename = self._safe_public_zip_filename(folder_name)
            archive_root = zip_filename[:-4] or "compartilhado"
            manifest_started_at = time.perf_counter()
            manifest = await self._file_manager.collect_public_archive_entries(root_path, current_path)
            logger.info(
                "Public ZIP manifest ready: public_id=%s path=%s files=%s bytes=%s elapsed_ms=%.2f",
                public_id,
                current_relative_path,
                manifest.get("file_count"),
                manifest.get("total_bytes"),
                (time.perf_counter() - manifest_started_at) * 1000,
            )
            return await self._stream_public_zip_response(
                request,
                public_id=public_id,
                manifest=manifest,
                zip_filename=zip_filename,
                archive_root=archive_root,
                archive_label=current_relative_path,
            )
        except PublicShareError as exc:
            return web.Response(text=exc.message, status=exc.status)
        except web.HTTPException:
            raise
        except Exception as exc:
            logger.error("Error downloading public ZIP %s: %s", public_id, exc, exc_info=True)
            return web.Response(text="Falha ao compactar pasta compartilhada", status=500)

    async def _handle_api_import_local(self, request):
        try:
            data = await request.json()
            source = data.get("source") # Local path
            destination = data.get("destination") # Cloud directory path
            
            if not source or not destination:
                 return web.json_response({"error": "Parâmetros ausentes"}, status=400)
            
            # Verify source exists locally
            source_path = Path(source)
            if not source_path.exists():
                 return web.json_response({"error": "Arquivo de origem não encontrado"}, status=404)
            if source_path.is_dir():
                 # TODO: Support directory import (recursive upload)
                 return web.json_response({"error": "Importação de pastas ainda não suportada"}, status=400)

            filename = source_path.name
            
            # Construct virtual path
            if destination == '/':
                virtual_path = f"/{filename}"
            else:
                if destination.endswith('/'):
                    virtual_path = f"{destination}{filename}"
                else:
                    virtual_path = f"{destination}/{filename}"
            
            # Use background task for large files
            import_id = str(int(asyncio.get_event_loop().time() * 1000))
            
            self._import_tasks[import_id] = {
                "status": "pending",
                "bytes_uploaded": 0,
                "bytes_total": source_path.stat().st_size,
                "filename": filename,
                "virtual_path": virtual_path,
                "target_folder": _normalize_virtual_folder(destination),
            }

            # Start background task
            asyncio.create_task(self._run_import_task(import_id, source_path, virtual_path))
            
            return web.json_response({"status": "started", "import_id": import_id})
            
        except Exception as e:
            logger.error(f"Import local error: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _run_import_task(self, import_id, source_path, virtual_path):
        try:
            self._import_tasks[import_id]["status"] = "running"
            
            def progress_callback(uploaded, total):
                self._import_tasks[import_id]["bytes_uploaded"] = uploaded
                self._import_tasks[import_id]["bytes_total"] = total
            
            logger.info(f"📤 Importing local file: {source_path} -> {virtual_path}")
            
            # Using existing upload_file which expects a Path object for local_path
            # NOTE: Assuming upload_file accepts progress_callback (it does in file_manager.py)
            await self._file_manager.upload_file(source_path, virtual_path, progress_callback=progress_callback)
            
            self._import_tasks[import_id]["status"] = "done"
            self._import_tasks[import_id]["bytes_uploaded"] = self._import_tasks[import_id]["bytes_total"]
            
        except Exception as e:
            logger.error(f"Import task {import_id} failed: {e}", exc_info=True)
            self._import_tasks[import_id]["status"] = "error"
            self._import_tasks[import_id]["error"] = str(e)
    
    async def _handle_api_import_status(self, request):
        import_id = request.query.get("id")
        if not import_id or import_id not in self._import_tasks:
            return web.json_response({"error": "Tarefa não encontrada"}, status=404)
        
        task = self._import_tasks[import_id]
        
        # Calculate percent
        uploaded = task.get("bytes_uploaded", 0)
        total = task.get("bytes_total", 0)
        percent = 0
        if total > 0:
            percent = min(100, round((uploaded / total) * 100, 1))

        return web.json_response({
            "status": task["status"],
            "bytes_uploaded": uploaded,
            "bytes_total": total,
            "percent": percent,
            "error": task.get("error"),
            "virtual_path": task.get("virtual_path"),
            "target_folder": task.get("target_folder"),
        })

    async def _handle_api_mkdir(self, request):
        try:
            data = await request.json()
            path = data.get("path")
            if not path:
                return web.json_response({"status": "error", "message": "Caminho ausente nas alterações"}, status=400)
            
            await self._file_manager.create_directory(path)
            return web.json_response({"status": "ok"})
        except Exception as e:
            logger.error(f"Error in mkdir: {e}")
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    async def _handle_api_rename(self, request):
        try:
            data = await request.json()
            path = data.get("path")
            new_name = data.get("new_name")
            if not path or not new_name:
                return web.json_response({"status": "error", "message": "Parâmetros ausentes"}, status=400)
            
            # Calculate new path
            parent = str(Path(path).parent)
            if parent == '.': parent = '/'
            
            # Simple path join handling
            if parent == '/':
                new_path = f"/{new_name}"
            else:
                new_path = f"{parent}/{new_name}"
            
            await self._file_manager.rename(path, new_path)
            return web.json_response({"status": "ok"})
        except Exception as e:
            logger.error(f"Error in rename: {e}")
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    async def _handle_api_move(self, request):
        try:
            data = await request.json()
            source = data.get("source")
            destination = data.get("destination") # Target directory
            if not source or not destination:
                return web.json_response({"status": "error", "message": "Parâmetros ausentes"}, status=400)
            
            filename = source.rstrip('/').split('/')[-1]
            
            # Clean destination path
            if destination == '/':
                new_path = f"/{filename}"
            else:
                if destination.endswith('/'):
                    new_path = f"{destination}{filename}"
                else:
                    new_path = f"{destination}/{filename}"
            
            # Prevent moving into itself
            if new_path.startswith(source + '/'):
                return web.json_response({"status": "error", "message": "Não é possível mover a pasta para dentro dela mesma"}, status=400)

            mode = data.get("mode", "strict")
            auto_rename = (mode == "auto-rename")

            try:
                await self._file_manager.rename(source, new_path, auto_rename=auto_rename)
            except pymongo.errors.DuplicateKeyError:
                return web.json_response({"error": "Arquivo já existe", "code": "CONFLICT"}, status=409)

            return web.json_response({"status": "ok"})
        except Exception as e:
            logger.error(f"Error in move: {e}")
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    async def _handle_api_copy(self, request):
        try:
            data = await request.json()
            source = data.get("source")
            destination = data.get("destination") # Target directory
            if not source or not destination:
                return web.json_response({"status": "error", "message": "Parâmetros ausentes"}, status=400)
            
            filename = source.rstrip('/').split('/')[-1]
            
            # Clean destination path
            if destination == '/':
                new_path = f"/{filename}"
            else:
                if destination.endswith('/'):
                    new_path = f"{destination}{filename}"
                else:
                    new_path = f"{destination}/{filename}"
            
            logger.info(f"📂 COPY REQUEST: Source='{source}', Destination='{destination}', NewPath='{new_path}'")

            # Prevent copying into itself
            if new_path.startswith(source + '/'):
                return web.json_response({"status": "error", "message": "Não é possível copiar a pasta para dentro dela mesma"}, status=400)

            mode = data.get("mode", "strict")
            auto_rename = (mode == "auto-rename")

            try:
                await self._file_manager.copy(source, new_path, auto_rename=auto_rename)
            except pymongo.errors.DuplicateKeyError:
                return web.json_response({"error": "Arquivo já existe", "code": "CONFLICT"}, status=409)

            return web.json_response({"status": "ok"})
        except Exception as e:
            logger.exception(f"Error in copy: {e}")
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    async def _handle_api_delete(self, request):
        try:
            data = await request.json()
            path = data.get("path")
            if not path:
                return web.json_response({"error": "Caminho obrigatório", "code": "MISSING_PATH"}, status=400)
            
            recursive = data.get("recursive", False)
            
            # Try file first
            if await self._file_manager.is_file(path):
                await self._file_manager.delete_file(path)
                return web.json_response({
                    "status": "ok",
                    "deleted_type": "file",
                    "deleted_path": path
                })
            
            # Try directory
            if await self._file_manager.is_directory(path):
                if recursive:
                    # Full recursive delete with cleanup
                    try:
                        result = await self._file_manager.delete_directory_recursive(path)
                        if result["errors"]:
                            return web.json_response({
                                "error": "Exclusão parcial — alguns itens falharam",
                                "code": "PARTIAL_DELETE_FAILED",
                                "details": {
                                    "path": path,
                                    "deleted_counts": {
                                        "files": result["deleted_files"],
                                        "directories": result["deleted_directories"]
                                    },
                                    "error_count": len(result["errors"])
                                }
                            }, status=207)
                        return web.json_response({
                            "status": "ok",
                            "deleted_type": "directory",
                            "deleted_path": path,
                            "deleted_counts": {
                                "files": result["deleted_files"],
                                "directories": result["deleted_directories"]
                            }
                        })
                    except ValueError as e:
                        return web.json_response({
                            "error": str(e),
                            "code": "CANNOT_DELETE_ROOT"
                        }, status=400)
                else:
                    # Non-recursive: only delete if empty
                    deleted = await self._file_manager.delete_directory(path)
                    if deleted:
                        return web.json_response({
                            "status": "ok",
                            "deleted_type": "directory",
                            "deleted_path": path,
                            "deleted_counts": {"files": 0, "directories": 1}
                        })
                    else:
                        return web.json_response({
                            "error": "Diretório não vazio. Envie recursive: true para excluir com conteúdo.",
                            "code": "DIRECTORY_NOT_EMPTY"
                        }, status=400)

            return web.json_response({"error": "Item não encontrado", "code": "ITEM_NOT_FOUND"}, status=404)
        except Exception as e:
            logger.error(f"Delete error: {e}")
            return web.json_response({"error": str(e), "code": "DELETE_FAILED"}, status=500)

    async def _handle_api_evict_cache(self, request):
        try:
            data = await request.json()
            path = data.get("path")
            if not path:
                return web.json_response({"error": "Caminho ausente"}, status=400)
            
            await self._file_manager.evict_file_cache(path)
            return web.json_response({"status": "ok"})
        except FileNotFoundError:
            return web.json_response({"error": "Arquivo não encontrado"}, status=404)
        except Exception as e:
            logger.error(f"Evict cache error: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_remove_offline(self, request):
        try:
            data = await request.json()
            path = data.get("path")
            if not path:
                return web.json_response({"error": "Caminho ausente"}, status=400)
            
            await self._file_manager.set_offline(path, False)
            return web.json_response({"status": "ok"})
        except FileNotFoundError:
            return web.json_response({"error": "Arquivo não encontrado"}, status=404)
        except Exception as e:
            logger.error(f"Remove offline error: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_upload(self, request):
        path = request.query.get("path", "/")
        if not path.startswith("/"): path = "/" + path
        if not path.endswith("/"): path += "/"

        uploaded_files = []
        try:

            reader = await request.multipart()
            tasks_created = []

            while True:
                part = await reader.next()
                if part is None:
                    break
                
                if part.filename:
                    # Prefer explicitly passed filename over multipart's default name
                    filename = request.query.get("filename") or part.filename
                    # Save to staging
                    temp_path = Config.STAGING_DIR / f"upload_{int(asyncio.get_event_loop().time())}_{filename}"
                    
                    with open(temp_path, "wb") as f:
                        while True:
                            chunk = await part.read_chunk()
                            if not chunk:
                                break
                            f.write(chunk)
                    
                    # Process upload to storage (Background)
                    virtual_path = path + filename
                    virtual_path = virtual_path.replace("//", "/")
                    
                    # Create background task
                    # If job_id was passed, we link it natively to the client upload
                    provided_id = request.query.get("job_id")
                    if provided_id:
                        task_id = provided_id
                    else:
                        task_id = str(int(asyncio.get_event_loop().time() * 1000)) + "_" + filename
                    
                    self._import_tasks[task_id] = {
                        "status": "pending",
                        "bytes_uploaded": 0,
                        "bytes_total": temp_path.stat().st_size,
                        "filename": filename,
                        "virtual_path": virtual_path,
                        "target_folder": _normalize_virtual_folder(path),
                    }

                    # Start background task
                    asyncio.create_task(self._run_upload_task(task_id, temp_path, virtual_path))
                    tasks_created.append({"filename": filename, "task_id": task_id})
            
            return web.json_response({"status": "processing", "tasks": tasks_created})

        except Exception as e:
            logger.error(f"Upload error: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _run_upload_task(self, task_id, temp_path, virtual_path):
        try:
            self._import_tasks[task_id]["status"] = "running"
            
            # Sync callback for file_manager
            def progress_callback(uploaded, total):
                if task_id in self._import_tasks:
                    self._import_tasks[task_id]["bytes_uploaded"] = uploaded
                    self._import_tasks[task_id]["bytes_total"] = total
            
            logger.info(f"📤 Processing upload: {temp_path} -> {virtual_path}")
            
            await self._file_manager.upload_file(temp_path, virtual_path, progress_callback=progress_callback)
            
            if task_id in self._import_tasks:
                self._import_tasks[task_id]["status"] = "done"
                self._import_tasks[task_id]["bytes_uploaded"] = self._import_tasks[task_id]["bytes_total"]
            
        except Exception as e:
            logger.error(f"Upload task {task_id} failed: {e}", exc_info=True)
            if task_id in self._import_tasks:
                self._import_tasks[task_id]["status"] = "error"
                self._import_tasks[task_id]["error"] = str(e)
        finally:
            # Cleanup temp file
            if temp_path.exists():
                os.remove(temp_path)

            # Keep in dict for a while so clients can read the 'done'/'error' status
            async def cleanup():
                await asyncio.sleep(300) # 5 minutes
                if task_id in self._import_tasks:
                    del self._import_tasks[task_id]
            
            asyncio.create_task(cleanup())

    async def _handle_api_server_uploads(self, request):
        try:
            uploads_list = []
            for task_id, task_info in list(self._import_tasks.items()):
                # Filter out old or irrelevant statuses if needed, 
                # but we'll return all and let the client handle it based on status
                if task_info["status"] in ["pending", "running", "error", "done"]:
                    uploaded = task_info.get("bytes_uploaded", 0)
                    total = task_info.get("bytes_total", 0)
                    percent = (uploaded / total * 100) if total > 0 else 0
                    
                    uploads_list.append({
                        "id": task_id,
                        "filename": task_info.get("filename", "unknown"),
                        "status": task_info["status"],
                        "bytes_uploaded": uploaded,
                        "bytes_total": total,
                        "percent": percent,
                        "error": task_info.get("error"),
                        "virtual_path": task_info.get("virtual_path"),
                        "target_folder": task_info.get("target_folder"),
                    })
            return web.json_response({"uploads": uploads_list})
        except Exception as e:
            logger.error(f"Error listing server uploads: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_upload_chunk(self, request):
        try:
            reader = await request.multipart()
            fields = {}
            
            while True:
                part = await reader.next()
                if part is None:
                    break
                
                if part.name == 'chunk':
                    upload_id = fields.get('upload_id')
                    offset = int(fields.get('offset', 0))
                    total_size = int(fields.get('total_size', 0))
                    filename = fields.get('filename')
                    path = fields.get('path', '/')

                    if str(filename or "").strip().lower().endswith(".mkv"):
                        return web.json_response({
                            "error": "Upload chunked de MKV desabilitado para permitir preprocessamento de legendas antes do Telegram",
                            "code": "MKV_CHUNK_UPLOAD_DISABLED",
                        }, status=400)
                    
                    if not upload_id:
                        return web.json_response({"error": "ID de upload ausente"}, status=400)

                    chunk_index = offset // Config.CHUNK_SIZE_BYTES
                    total_chunks = max(1, math.ceil(total_size / Config.CHUNK_SIZE_BYTES)) if total_size else 1
                    chunk_data = bytes(await part.read())
                    chunk_size = len(chunk_data)
                    
                    safe_id = "".join([c for c in upload_id if c.isalnum() or c in ('-', '_')])
                    staging_path = Config.STAGING_DIR / f"{safe_id}.part"
                    
                    # Pipeline: fire-and-forget Telegram upload (returns immediately)
                    await self._file_manager.handle_stream_chunk(
                        upload_id, chunk_index, chunk_data, staging_path,
                        filename=filename,
                        total_chunks=total_chunks,
                    )
                    
                    next_offset = offset + chunk_size
                    
                    if next_offset >= total_size:
                        # Last chunk — finalize: await ALL pending Telegram uploads
                        if not path.startswith("/"): path = "/" + path
                        if not path.endswith("/"): path += "/"
                        virtual_path = (path + filename).replace("//", "/")
                        
                        # Stream finalization progress
                        response = web.StreamResponse()
                        response.content_type = 'application/x-ndjson'
                        response.headers['Cache-Control'] = 'no-cache'
                        await response.prepare(request)
                        
                        async def on_progress(bytes_done, bytes_total):
                            await response.write(json.dumps({
                                "type": "progress",
                                "file_bytes": bytes_done,
                                "file_total": bytes_total
                            }).encode() + b'\n')
                        
                        await self._file_manager.finish_stream_upload(
                            virtual_path, upload_id, filename, staging_path,
                            progress_callback=on_progress
                        )
                        
                        await response.write(json.dumps({
                            "type": "result", "status": "completed"
                        }).encode() + b'\n')
                        await response.write_eof()
                        return response
                    else:
                        # Non-final chunk — respond immediately (Telegram upload runs in background)
                        return web.json_response({"status": "chunk_received", "offset": next_offset})

                else:
                    value = await part.text()
                    fields[part.name] = value

            return web.json_response({"error": "Nenhum chunk encontrado"}, status=400)

        except Exception as e:
            logger.error(f"Chunk upload error: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_usage(self, request):
        # Get total disk usage
        try:
            from database import Database
            db = Database()
            await db.connect()
            usage = await db.get_disk_usage()
            await db.disconnect()
            return web.json_response({"total_bytes": usage})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_thumbnail(self, request):
        path = request.query.get("path")
        if not path:
            return web.Response(text="Caminho ausente", status=400)
            
        try:
            t_thumb = time.time()
            thumb_payload = await self._file_manager.get_thumbnail(path)
            elapsed = time.time() - t_thumb
            if thumb_payload:
                logger.info(f"⏱️ API /thumbnail (path={path}) hit and took {elapsed:.3f}s")
            else:
                logger.info(f"⏱️ API /thumbnail (path={path}) miss and took {elapsed:.3f}s")

            if not thumb_payload:
                return web.Response(status=404)
            thumb_bytes, thumb_content_type = thumb_payload
            return web.Response(body=thumb_bytes, content_type=thumb_content_type)
        except Exception as e:
            logger.error(f"Thumbnail error: {e}")
            return web.Response(status=500)

    async def _stream_transcoded_file(self, request, raw_path, is_local, file_meta=None, file_path=None, force_audio_only=False):
        """Transcode/remux a file to fragmented MP4 for instant browser playback.
        
        Uses fMP4 with empty_moov+frag_keyframe so the browser can start playing
        immediately from a pipe — no need to wait for full file download.
        """
        temp_file_path = None
        temp_concat_path = None
        process = None
        feed_task = None
        filename = file_path.name if is_local else file_meta["filename"]
        is_audio_only = force_audio_only or filename.lower().endswith(('.flac', '.ogg', '.oga', '.wma', '.aac', '.wav', '.opus', '.m4a'))
        content_type = "audio/mp4" if is_audio_only else "video/mp4"
        
        # Seek support (start seconds)
        start_seconds = request.query.get("ss", "0")
        try:
            ss = float(start_seconds)
        except ValueError:
            ss = 0
            
        headers = {
            "Content-Type": content_type,
            "Content-Disposition": 'inline',
            "Cache-Control": "no-cache",
            "Accept-Ranges": "bytes",
            "X-TCloud-Delivery": "pipe",
        }
        
        # Add duration header if available in metadata
        duration = None
        if file_meta and "meta" in file_meta:
            duration = file_meta["meta"].get("duration")
        
        if duration:
            headers["X-Content-Duration"] = str(duration)
        
        # TRANSCODED STREAMS DO NOT SUPPORT RANGE (they are live pipes)
        headers["Accept-Ranges"] = "none"

        response = web.StreamResponse(status=200, headers=headers)
        # Note: We delay response.prepare(request) until we have the first chunk from FFmpeg
        # so we can send a proper 500 error if FFmpeg fails early.
        
        # Build ffmpeg command
        input_args = []
        if ss > 0:
            # FAST SEEK: Put -ss before -i
            input_args.extend(["-ss", str(ss)])
            
        stdin_mode = asyncio.subprocess.PIPE

        if is_local:
            input_args.extend(["-i", str(file_path)])
            stdin_mode = asyncio.subprocess.DEVNULL
        elif file_meta:
            chunks = file_meta.get("chunks", [])
            if self._file_manager._cache.is_fully_cached(raw_path, chunks):
                # OPTIMIZATION: Use concat demuxer for fully cached files.
                # This allows FFmpeg to seek efficiently on disk across all chunks.
                paths = self._file_manager._cache.get_all_chunk_paths(raw_path, chunks)
                import tempfile
                with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
                    for p in paths:
                        f.write(f"file '{p.absolute()}'\n")
                    temp_concat_path = f.name
                
                input_args.extend(["-f", "concat", "-safe", "0", "-i", temp_concat_path])
                stdin_mode = asyncio.subprocess.DEVNULL
                logger.info(f"📁 Using concat demuxer for fully cached file: {raw_path}")
            else:
                # For non-cached cloud files, ALWAYS use piped input with high probesize.
                # This avoids blocking for a full chunk download before starting.
                input_args.extend([
                    "-analyzeduration", "20000000",
                    "-probesize", "20000000",
                    "-i", "pipe:0",
                ])
                stdin_mode = asyncio.subprocess.PIPE
        else:
            # Fallback
            input_args.extend(["-i", "pipe:0"])
            stdin_mode = asyncio.subprocess.PIPE
        
        # Audio track selection (query param ?audio=N)
        audio_track = request.query.get("audio", "0")
        try:
            audio_index = int(audio_track)
        except ValueError:
            audio_index = 0

        # Map args: select specific video and audio streams
        map_args = []
        if not is_audio_only:
            map_args.extend(["-map", "0:v:0", "-map", f"0:a:{audio_index}"])
        else:
            map_args.extend(["-map", f"0:a:{audio_index}"])

        if is_audio_only:
            # Audio: remux to fMP4 (AAC)
            output_args = [
                *map_args,
                "-vn",
                "-c:a", "aac",
                "-b:a", "192k",
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "pipe:1",
            ]
        else:
            # Video: transcode to H.264/AAC fMP4
            output_args = [
                *map_args,
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-tune", "zerolatency",
                "-crf", "23",
                "-c:a", "aac",
                "-b:a", "192k",
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "pipe:1",
            ]
        
        try:
            process = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-hide_banner", "-loglevel", "warning",
                *input_args,
                *output_args,
                stdin=stdin_mode,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            logger.error("FFmpeg not found! Please install ffmpeg.")
            if temp_file_path and os.path.exists(temp_file_path):
                os.unlink(temp_file_path)
            return web.Response(text="FFmpeg not installed. Cannot transcode.", status=500)

        # Feed data to FFmpeg from Telegram stream (for cloud files using pipe)
        async def feed_ffmpeg():
            bytes_fed = 0
            try:
                if not is_local and file_meta:
                    # If we have an offset (ss), we should theoretically calculate the byte offset.
                    # HOWEVER, with -ss before -i, FFmpeg handles the seek internally as long as the input is a stream.
                    # For piped input, it reads and discards until the point.
                    # For local/concat, it seeks efficiently.
                    async for data in self._file_manager.stream_file_range_direct(raw_path, 0, file_meta["size"] - 1):
                        if process.stdin.is_closing():
                            break
                        process.stdin.write(data)
                        await process.stdin.drain()
                        bytes_fed += len(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:
                logger.warning(f"feed_ffmpeg error after {bytes_fed} bytes: {e}")
            finally:
                try:
                    if process.stdin and not process.stdin.is_closing():
                        process.stdin.close()
                        await process.stdin.wait_closed()
                except Exception:
                    pass
            logger.info(f"📤 feed_ffmpeg done: {bytes_fed / 1024 / 1024:.1f} MB fed to FFmpeg")

        if stdin_mode == asyncio.subprocess.PIPE:
            feed_task = asyncio.create_task(feed_ffmpeg())

        bytes_written = 0
        try:
            # Wait for first chunk of data or process exit
            # This is crucial: if FFmpeg fails to find headers (e.g. invalid pipe input),
            # it will exit or block here. 25s timeout allows for Telegram chunk download.
            t_ff = time.time()
            chunk = await asyncio.wait_for(process.stdout.read(65536), timeout=25.0)
            logger.info(f"⏱️ FFmpeg first chunk took {time.time() - t_ff:.3f}s")
            
            if not chunk:
                # FFmpeg closed stdout without outputting anything
                exit_code = process.returncode
                stderr_data = await process.stderr.read()
                error_msg = stderr_data.decode(errors='ignore')
                logger.error(f"FFmpeg failed (exit {exit_code}): {error_msg}")
                return web.Response(text=f"Streaming error: {error_msg}", status=500)

            # NOW we have data, prepare the response headers
            await response.prepare(request)
            await response.write(chunk)
            bytes_written += len(chunk)

            # Continue streaming remaining data
            while True:
                data = await process.stdout.read(65536)
                if not data:
                    break
                await response.write(data)
                bytes_written += len(data)
        except asyncio.TimeoutError:
            logger.error(f"FFmpeg timeout waiting for output: {raw_path}")
            return web.Response(text="Streaming timeout - file too slow to respond", status=504)
        except (ConnectionResetError, ConnectionError):
            logger.debug(f"Client disconnected during transcode: {raw_path}")
        except Exception as e:
            logger.error(f"Transcode stream error: {e}")
            if bytes_written == 0:
                return web.Response(text=f"Internal error: {e}", status=500)
        finally:
            logger.info(f"📥 FFmpeg output done: {bytes_written / 1024 / 1024:.1f} MB written to client")
            # Read stderr for debugging
            try:
                stderr_data = await asyncio.wait_for(process.stderr.read(), timeout=2) if process and process.stderr else None
                if stderr_data:
                    logger.warning(f"FFmpeg stderr: {stderr_data.decode(errors='ignore')[:500]}")
            except Exception:
                pass
            
            if process and process.returncode is None:
                try:
                    process.terminate()
                    await asyncio.sleep(0.1)
                    if process.returncode is None:
                        process.kill()
                except Exception:
                    pass
            
            # Cleanup temp concat file if it was created
            if temp_concat_path and os.path.exists(temp_concat_path):
                try:
                    os.unlink(temp_concat_path)
                except Exception:
                    pass
            
            # Legacy cleanup from previous version (just in case)
            if 'temp_file_path' in locals() and temp_file_path and os.path.exists(temp_file_path):
                try:
                    os.unlink(temp_file_path)
                except Exception:
                    pass
            if feed_task:
                feed_task.cancel()
            # Clean up temp file used for seekable input
            if temp_file_path and os.path.exists(temp_file_path):
                try:
                    os.unlink(temp_file_path)
                except Exception:
                    pass

        try:
            await response.write_eof()
        except Exception:
            pass

        return response

    def _generate_etag(self, file_meta: dict) -> str:
        """Generate a stable ETag from file metadata."""
        chunks = file_meta.get("chunks", [])
        chunk_ids = "-".join(str(c["message_id"]) for c in sorted(chunks, key=lambda c: c["index"]))
        raw = f"{file_meta['size']}:{chunk_ids}"
        return hashlib.md5(raw.encode()).hexdigest()

    def _extract_request_token(self, request) -> str:
        token = (request.query.get("token") or "").strip()
        if token:
            return token
        auth_header = request.headers.get("Authorization", "")
        if auth_header.lower().startswith("bearer "):
            return auth_header.split(" ", 1)[1].strip()
        return ""

    def _append_token_to_playlist_path(self, asset_path: str, token: str) -> str:
        clean_path = str(asset_path or "").strip()
        if not clean_path or not token or clean_path.startswith(("http://", "https://")) or "token=" in clean_path:
            return clean_path
        separator = "&" if "?" in clean_path else "?"
        return f"{clean_path}{separator}token={quote(token, safe='')}"

    def _rewrite_web_playback_media_playlist(self, playlist_text: str, request) -> str:
        token = self._extract_request_token(request)
        if not token:
            return playlist_text

        rewritten_lines: list[str] = []
        for raw_line in str(playlist_text or "").splitlines():
            line = raw_line.strip()
            if line.startswith("#EXT-X-MAP:") and 'URI="' in line:
                line = re.sub(
                    r'URI="([^"]+)"',
                    lambda match: f'URI="{self._append_token_to_playlist_path(match.group(1), token)}"',
                    line,
                )
            elif line and not line.startswith("#"):
                line = self._append_token_to_playlist_path(line, token)
            rewritten_lines.append(line)
        return "\n".join(rewritten_lines) + "\n"

    def _build_web_playback_subtitle_playlist_path(self, session_id: str, track_id: str) -> str:
        return f"/api/web_playback/session/{session_id}/subtitles/{quote(track_id, safe='')}/playlist.m3u8"

    def _build_public_web_playback_subtitle_playlist_path(self, public_id: str, session_id: str, track_id: str) -> str:
        return (
            f"/api/shared_item/{quote(public_id, safe='')}/web_playback/session/"
            f"{quote(session_id, safe='')}/subtitles/{quote(track_id, safe='')}/playlist.m3u8"
        )

    def _web_playback_subtitle_response_headers(self, session: dict, track: dict | None = None) -> dict:
        return {
            "X-TCloud-Playback-Session": str(session.get("id") or session.get("session_id") or ""),
            "X-TCloud-Subtitle-Timebase": str((track or {}).get("subtitle_timebase") or "session"),
            "X-TCloud-Timeline-Offset": str(float(session.get("start_seconds") or 0.0)),
        }

    def _publicize_web_playback_subtitle_tracks(
        self,
        session: dict,
        public_id: str,
        *,
        token_query: str = "",
    ) -> list[dict]:
        session_id = str(session.get("id") or session.get("session_id") or "").strip()
        public_tracks = []
        for track in session.get("subtitle_tracks") or []:
            track_id = str(track.get("track_id") or track.get("id") or "").strip()
            if not session_id or not track_id:
                continue
            playlist_url = self._build_public_web_playback_subtitle_playlist_path(public_id, session_id, track_id)
            if token_query:
                playlist_url = f"{playlist_url}{token_query}"
            public_track = dict(track)
            public_track.update({
                "track_id": track_id,
                "session_id": session_id,
                "delivery": "hls_session",
                "subtitleSourceMode": "hls_session",
                "subtitle_timebase": "session",
                "subtitleTimebase": "session",
                "timebase": "session",
                "timeline_offset_seconds": float(session.get("start_seconds") or 0.0),
                "source_timebase": "media_zero",
                "hls_playlist_url": playlist_url,
                "playlist_url": playlist_url,
                "src": playlist_url,
                "url": playlist_url,
                "legacy_url": "",
            })
            public_tracks.append(public_track)
        return public_tracks

    def _build_web_playback_master_playlist(self, session: dict, request) -> str:
        media_playlist_name = session.get("media_playlist_name") or "media.m3u8"
        media_playlist_ref = self._append_token_to_playlist_path(media_playlist_name, self._extract_request_token(request))
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            "#EXT-X-INDEPENDENT-SEGMENTS",
        ]

        subtitle_group_id = str(session.get("subtitle_group_id") or "subs").strip() or "subs"
        subtitle_tracks = session.get("subtitle_tracks") or []
        subtitle_mode = str(session.get("subtitle_delivery_mode") or "off").strip().lower()
        if subtitle_mode != "off":
            for track in subtitle_tracks:
                track_id = str(track.get("track_id") or "").strip()
                if not track_id:
                    continue
                safe_name = str(track.get("label") or track.get("name") or track_id).replace('"', "'").replace(",", " -")
                attrs = [
                    'TYPE=SUBTITLES',
                    f'GROUP-ID="{subtitle_group_id}"',
                    f'NAME="{safe_name}"',
                    f'URI="{self._append_token_to_playlist_path(self._build_web_playback_subtitle_playlist_path(session.get("id", ""), track_id), self._extract_request_token(request))}"',
                    f'AUTOSELECT={"YES" if track.get("default") or track.get("language") else "NO"}',
                    f'DEFAULT={"YES" if track.get("default") else "NO"}',
                    f'FORCED={"YES" if track.get("forced") else "NO"}',
                ]
                language = _normalize_language_code(track.get("language", ""))
                if language:
                    attrs.append(f'LANGUAGE="{language}"')
                lines.append(f"#EXT-X-MEDIA:{','.join(attrs)}")

        stream_inf = "BANDWIDTH=3500000,AVERAGE-BANDWIDTH=2200000"
        if subtitle_mode != "off" and subtitle_tracks:
            stream_inf += f',SUBTITLES="{subtitle_group_id}"'
        lines.extend([
            f"#EXT-X-STREAM-INF:{stream_inf}",
            media_playlist_ref,
            "",
        ])
        return "\n".join(lines)

    def _guess_web_playback_content_type(self, asset_name: str) -> str:
        suffix = Path(asset_name).suffix.lower()
        if suffix == ".m3u8":
            return "application/x-mpegURL"
        if suffix == ".vtt":
            return "text/vtt"
        if suffix == ".m4s":
            return "video/iso.segment"
        if suffix == ".mp4":
            return "video/mp4"
        if suffix == ".ts":
            return "video/mp2t"
        return mimetypes.guess_type(asset_name)[0] or "application/octet-stream"

    async def _get_web_playback_source(
        self,
        raw_path: str,
        is_local: bool,
        resolved_cloud_request: dict | None = None,
    ) -> dict | None:
        if is_local:
            file_path = self._resolve_local_stream_path(raw_path)
            if not file_path or not file_path.is_file():
                return None
            stat = file_path.stat()
            # Try to get duration via ffprobe for local files
            local_duration = None
            try:
                dur_proc = await asyncio.create_subprocess_exec(
                    "ffprobe", "-v", "quiet", "-show_entries", "format=duration",
                    "-of", "csv=p=0", str(file_path),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
                dur_out, _ = await asyncio.wait_for(dur_proc.communicate(), timeout=5)
                dur_val = dur_out.decode().strip() if dur_out else ""
                if dur_val:
                    local_duration = float(dur_val)
            except Exception:
                pass
            return {
                "path": raw_path,
                "is_local": True,
                "filename": file_path.name,
                "size": stat.st_size,
                "file_path": file_path,
                "duration_seconds": local_duration,
                "file_meta": None,
            }

        resolved_request = resolved_cloud_request or await self._resolve_cloud_file_request(raw_path)
        file_meta = resolved_request.get("file_meta")
        if not file_meta:
            return None

        resolved_path = _normalize_cloud_path_variant(file_meta.get("path") or raw_path)
        duration = None
        if isinstance(file_meta.get("meta"), dict):
            raw_duration = file_meta["meta"].get("duration")
            try:
                duration = float(raw_duration) if raw_duration is not None else None
            except (TypeError, ValueError):
                duration = None

        return {
            "path": resolved_path,
            "requested_path": resolved_request.get("requested_path") or raw_path,
            "resolver_source": resolved_request.get("resolver_source") or "exact",
            "is_local": False,
            "filename": file_meta["filename"],
            "size": int(file_meta["size"]),
            "file_path": None,
            "duration_seconds": duration,
            "file_meta": file_meta,
        }

    async def _wait_for_web_hls_session_ready(self, session_id: str, timeout_seconds: float | None = None) -> dict:
        effective_timeout_seconds = float(
            timeout_seconds
            if timeout_seconds is not None
            else getattr(self, "_web_playback_hls_startup_timeout_seconds", 45.0)
        )
        started_at = time.time()
        while (time.time() - started_at) < effective_timeout_seconds:
            session = self._web_playback_sessions.get(session_id)
            if not session:
                raise FileNotFoundError(f"Web playback session not found: {session_id}")

            temp_dir = session.get("temp_dir")
            media_playlist_name = session.get("media_playlist_name") or "media.m3u8"
            media_playlist_path = temp_dir / media_playlist_name if temp_dir else None
            init_name = session.get("init_name")
            init_path = temp_dir / init_name if temp_dir and init_name else None
            segment_pattern = session.get("segment_glob") or "segment_*"
            segment_files = list(temp_dir.glob(segment_pattern)) if temp_dir else []

            if media_playlist_path and media_playlist_path.exists():
                if not session.get("playlist_detected_at"):
                    session["playlist_detected_at"] = time.time()
                if segment_files or (init_path and init_path.exists()):
                    if not session.get("first_segment_detected_at"):
                        session["first_segment_detected_at"] = time.time()
                    session["status"] = "ready"
                    session["ready_at"] = time.time()
                    return session
                try:
                    media_text = media_playlist_path.read_text(encoding="utf-8", errors="ignore")
                except Exception:
                    media_text = ""
                if "#EXTINF:" in media_text:
                    if not session.get("first_segment_detected_at"):
                        session["first_segment_detected_at"] = time.time()
                    session["status"] = "ready"
                    session["ready_at"] = time.time()
                    return session

            process = session.get("process")
            if process and process.returncode is not None:
                stderr_tail = "\n".join(session.get("stderr_tail") or [])[-1200:]
                raise RuntimeError(stderr_tail or f"ffmpeg exited with status {process.returncode}")

            await asyncio.sleep(0.25)

        session = self._web_playback_sessions.get(session_id)
        if session:
            startup_started_at = float(session.get("startup_started_at") or started_at)
            elapsed_ms = max(0, int((time.time() - startup_started_at) * 1000))
            logger.warning(
                "🎬 Web playback HLS readiness timeout: session=%s path=%s ss=%.3f audio=%s input_mode=%s startup_attempt=%s used_re=%s playlist_kind=%s elapsed_ms=%s playlist_seen=%s first_segment_seen=%s stderr_tail=%s",
                session_id,
                session.get("raw_path", ""),
                float(session.get("start_seconds") or 0.0),
                session.get("audio_index", 0),
                session.get("input_mode", ""),
                session.get("startup_attempt", ""),
                session.get("used_re", False),
                session.get("playlist_kind", ""),
                elapsed_ms,
                bool(session.get("playlist_detected_at")),
                bool(session.get("first_segment_detected_at")),
                "\n".join(session.get("stderr_tail") or [])[-600:],
            )
        raise TimeoutError("Timed out waiting for HLS session readiness")

    async def _drain_web_playback_stderr(self, session_id: str, process) -> None:
        session = self._web_playback_sessions.get(session_id)
        if not session or not process or not process.stderr:
            return

        try:
            while True:
                line = await process.stderr.readline()
                if not line:
                    break
                decoded = line.decode(errors="ignore").strip()
                if not decoded:
                    continue
                tail = session.setdefault("stderr_tail", [])
                tail.append(decoded)
                if len(tail) > 40:
                    del tail[:-40]
        except Exception as exc:
            logger.debug("web playback stderr drain interrupted for %s: %s", session_id, exc)

    async def _monitor_web_playback_process(self, session_id: str) -> None:
        session = self._web_playback_sessions.get(session_id)
        process = session.get("process") if session else None
        if not session or not process:
            return

        try:
            return_code = await process.wait()
        except Exception as exc:
            logger.debug("web playback monitor interrupted for %s: %s", session_id, exc)
            return

        current_session = self._web_playback_sessions.get(session_id)
        if not current_session:
            return

        current_session["ended_at"] = time.time()
        if return_code == 0:
            current_session["status"] = "completed"
        else:
            current_session["status"] = "error"
            logger.warning(
                "Web playback ffmpeg exited with error for %s: %s",
                session_id,
                "\n".join(current_session.get("stderr_tail") or [])[-600:],
            )

    async def _finalize_web_playback_session_cleanup(self, session_id: str, reason: str = "") -> None:
        async with self._web_playback_lock:
            session = self._web_playback_sessions.pop(session_id, None)

        if not session:
            return

        retire_cleanup_task = session.get("retire_cleanup_task")
        if retire_cleanup_task:
            session["retire_cleanup_task"] = None
        subtitle_prewarm_task = session.get("subtitle_prewarm_task")
        if subtitle_prewarm_task and not subtitle_prewarm_task.done():
            subtitle_prewarm_task.cancel()
            session["subtitle_prewarm_task"] = None

        temp_concat_path = session.get("temp_concat_path")
        if temp_concat_path:
            try:
                os.unlink(temp_concat_path)
            except Exception:
                pass

        temp_dir = session.get("temp_dir")
        if temp_dir:
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                pass

        logger.info("🧹 Web playback session destroyed: %s (%s)", session_id, reason or "no-reason")

    async def _retire_web_playback_session(self, session_id: str, *, reason: str = "") -> bool:
        async with self._web_playback_lock:
            session = self._web_playback_sessions.get(session_id)
            if not session:
                return False
            if session.get("status") == "retired":
                return True

            session["status"] = "retired"
            session["retired_at"] = time.time()
            session["last_access_at"] = time.time()

            async def finalize_after_grace(expected_retired_at: float) -> None:
                try:
                    await asyncio.sleep(self._web_playback_retire_grace_seconds)
                    current_session = self._web_playback_sessions.get(session_id)
                    if not current_session:
                        return
                    if current_session.get("status") != "retired":
                        return
                    if float(current_session.get("retired_at") or 0.0) != expected_retired_at:
                        return
                    await self._finalize_web_playback_session_cleanup(
                        session_id,
                        reason=f"{reason or 'retired'}:grace-expired",
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.debug("web playback retire cleanup interrupted for %s: %s", session_id, exc)

            session["retire_cleanup_task"] = asyncio.create_task(finalize_after_grace(session["retired_at"]))

        logger.info(
            "🧊 Web playback session retired with grace window: %s (%s, grace=%ss)",
            session_id,
            reason or "no-reason",
            self._web_playback_retire_grace_seconds,
        )
        return True

    async def _destroy_web_playback_session(self, session_id: str, reason: str = "") -> None:
        graceful_retire = str(reason or "").startswith(("preempt:", "replaced:"))

        async with self._web_playback_lock:
            session = self._web_playback_sessions.get(session_id)

        if not session:
            return

        session["status"] = "closed"
        process = session.get("process")
        if process and process.returncode is None:
            try:
                process.terminate()
                await asyncio.sleep(0.1)
                if process.returncode is None:
                    process.kill()
            except Exception:
                pass

        feed_task = session.get("feed_task")
        if feed_task and not feed_task.done():
            feed_task.cancel()
            try:
                await feed_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass

        for task_name in ("stderr_task", "monitor_task"):
            task = session.get(task_name)
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception:
                    pass

        session["process"] = None
        session["feed_task"] = None
        session["stderr_task"] = None
        session["monitor_task"] = None

        if graceful_retire:
            retired = await self._retire_web_playback_session(session_id, reason=reason)
            if retired:
                return

        await self._finalize_web_playback_session_cleanup(session_id, reason=reason)

    async def _web_playback_cleanup_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(60)
                now = time.time()
                expired_ids = []
                for session_id, session in list(self._web_playback_sessions.items()):
                    last_access_at = float(session.get("last_access_at") or session.get("created_at") or now)
                    if (now - last_access_at) > self._web_playback_ttl_seconds:
                        expired_ids.append(session_id)

                for session_id in expired_ids:
                    await self._destroy_web_playback_session(session_id, reason="ttl-expired")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Web playback cleanup loop stopped unexpectedly: %s", exc)

    async def _handle_app_cleanup(self, app) -> None:
        if self._web_playback_cleanup_task:
            self._web_playback_cleanup_task.cancel()
            try:
                await self._web_playback_cleanup_task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
            self._web_playback_cleanup_task = None

        for session_id in list(self._web_playback_sessions.keys()):
            await self._destroy_web_playback_session(session_id, reason="app-cleanup")

        for task in list(getattr(self, "_public_share_metrics_tasks", {}).values()):
            task.cancel()
        for task in list(getattr(self, "_public_share_metrics_tasks", {}).values()):
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
        if hasattr(self, "_public_share_metrics_tasks"):
            self._public_share_metrics_tasks.clear()

    async def _start_web_hls_session(
        self,
        raw_path: str,
        *,
        is_local: bool,
        audio_index: int = 0,
        start_seconds: float = 0.0,
        bootstrap_reason: str = "initial-open",
        resolved_cloud_request: dict | None = None,
    ) -> dict:
        source = await self._get_web_playback_source(
            raw_path,
            is_local,
            resolved_cloud_request=resolved_cloud_request,
        )
        if not source:
            raise FileNotFoundError(raw_path)

        requested_path = str(source.get("requested_path") or raw_path or "").strip()
        resolved_path = str(source.get("path") or raw_path or "").strip()
        if not is_local and resolved_path:
            raw_path = resolved_path

        filename = source["filename"]
        segment_type = self._web_playback_segment_type
        playlist_kind = "ondemand"
        media_playlist_name = "media.m3u8"
        init_name = "init.mp4" if segment_type == "fmp4" else None
        segment_suffix = ".m4s" if segment_type == "fmp4" else ".ts"
        segment_pattern = f"segment_%05d{segment_suffix}"
        segment_glob = f"segment_*{segment_suffix}"
        input_plan = self._build_web_hls_input_plan(source, raw_path, start_seconds)
        input_args = list(input_plan["input_args"])
        stdin_mode = input_plan["stdin_mode"]
        input_mode = str(input_plan["input_mode"] or "local-file")
        probe_input = input_plan.get("probe_input")
        source_video_codec = await self._probe_web_hls_source_video_codec(probe_input, raw_path)
        prefer_video_copy = (
            segment_type == "mpegts"
            and start_seconds <= 0
            and source_video_codec in ("h264", "h264_qsv", "h264_nvenc")
        )
        startup_timeout_seconds = float(getattr(self, "_web_playback_hls_startup_timeout_seconds", 45.0) or 45.0)

        logger.info(
            "🎬 HLS codec decision: source=%s → %s (input_mode=%s, probe_input=%s)",
            source_video_codec or "unknown",
            "remux (copy)" if prefer_video_copy else "transcode (libx264)",
            input_mode,
            "set" if probe_input else "none",
        )

        startup_attempts = ["copy", "transcode"] if prefer_video_copy else ["transcode"]

        for startup_attempt_index, startup_attempt in enumerate(startup_attempts, start=1):
            use_video_copy = startup_attempt == "copy"
            temp_dir = Path(tempfile.mkdtemp(prefix="hls_", dir=self._web_playback_dir))
            session_id = uuid.uuid4().hex

            if use_video_copy:
                video_codec_args = ["-c:v", "copy"]
            else:
                video_codec_args = [
                    "-c:v", "libx264",
                    "-preset", "ultrafast",
                    "-tune", "zerolatency",
                    "-crf", "23",
                    "-pix_fmt", "yuv420p",
                    "-profile:v", "main",
                    "-level:v", "4.1",
                ]

            output_args = [
                "-map", "0:v:0",
                "-map", f"0:a:{audio_index}?",
                "-sn",
                "-dn",
                *video_codec_args,
            ]

            if not use_video_copy:
                output_args.extend([
                    "-g", "48",
                    "-keyint_min", "48",
                    "-sc_threshold", "0",
                    "-force_key_frames", "expr:gte(t,n_forced*2)",
                ])

            output_args.extend([
                "-c:a", "aac",
                "-ar", "48000",
                "-ac", "2",
                "-b:a", "192k",
                "-f", "hls",
                "-hls_time", "4",
                "-hls_list_size", "0",
                "-hls_flags", "independent_segments+temp_file",
            ])

            if segment_type == "fmp4":
                output_args.extend([
                    "-hls_segment_type", "fmp4",
                    "-hls_fmp4_init_filename", init_name,
                ])
            else:
                output_args.extend([
                    "-hls_segment_type", "mpegts",
                ])

            output_args.extend([
                "-hls_segment_filename", str(temp_dir / segment_pattern),
                str(temp_dir / media_playlist_name),
            ])

            process = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "warning",
                *input_args,
                *output_args,
                stdin=stdin_mode,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )

            session = {
                "id": session_id,
                "raw_path": raw_path,
                "requested_path": requested_path,
                "resolved_path": resolved_path,
                "resolver_source": source.get("resolver_source", ""),
                "filename": filename,
                "is_local": bool(is_local),
                "bootstrap_reason": str(bootstrap_reason or "initial-open").strip().lower() or "initial-open",
                "audio_index": audio_index,
                "start_seconds": float(max(0, start_seconds)),
                "duration_seconds": source.get("duration_seconds"),
                "segment_type": segment_type,
                "playlist_kind": playlist_kind,
                "input_mode": input_mode,
                "used_re": False,
                "codec_probe_source": "local-file" if is_local else ("internal-http" if probe_input else "none"),
                "source_video_codec": source_video_codec or "",
                "startup_strategy": "copy" if use_video_copy else "transcode",
                "startup_attempt": startup_attempt,
                "startup_attempt_index": startup_attempt_index,
                "startup_timeout_seconds": startup_timeout_seconds,
                "created_at": time.time(),
                "startup_started_at": time.time(),
                "last_access_at": time.time(),
                "status": "starting",
                "temp_dir": temp_dir,
                "media_playlist_name": media_playlist_name,
                "init_name": init_name,
                "segment_glob": segment_glob,
                "segment_suffix": segment_suffix,
                "subtitle_group_id": "subs",
                "subtitle_delivery_mode": self._web_playback_hls_subtitles_mode,
                "subtitle_segment_duration": self._web_playback_hls_subtitle_segment_duration,
                "subtitle_tracks": [],
                "subtitle_dir": temp_dir / "subtitles",
                "subtitle_generation_tasks": {},
                "subtitle_generation_locks": {},
                "subtitle_prewarm_task": None,
                "temp_concat_path": None,
                "process": process,
                "stderr_tail": [],
                "feed_task": None,
                "stderr_task": None,
                "monitor_task": None,
            }

            async with self._web_playback_lock:
                self._web_playback_sessions[session_id] = session

            async def feed_ffmpeg_from_cloud() -> None:
                try:
                    file_meta = source["file_meta"]
                    async for data in self._file_manager.stream_file_range_direct(raw_path, 0, file_meta["size"] - 1):
                        if not process.stdin or process.stdin.is_closing():
                            break
                        process.stdin.write(data)
                        await process.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("Web playback feed_ffmpeg failed for %s: %s", raw_path, exc)
                finally:
                    try:
                        if process.stdin and not process.stdin.is_closing():
                            process.stdin.close()
                            await process.stdin.wait_closed()
                    except Exception:
                        pass

            if stdin_mode == asyncio.subprocess.PIPE:
                session["feed_task"] = asyncio.create_task(feed_ffmpeg_from_cloud())

            session["stderr_task"] = asyncio.create_task(self._drain_web_playback_stderr(session_id, process))
            session["monitor_task"] = asyncio.create_task(self._monitor_web_playback_process(session_id))

            try:
                ready_session = await self._wait_for_web_hls_session_ready(
                    session_id,
                    timeout_seconds=startup_timeout_seconds,
                )
                ready_session["last_access_at"] = time.time()
                startup_started_at = float(ready_session.get("startup_started_at") or ready_session.get("created_at") or time.time())
                playlist_detected_at = ready_session.get("playlist_detected_at")
                first_segment_detected_at = ready_session.get("first_segment_detected_at")
                startup_elapsed_ms = max(0, int((time.time() - startup_started_at) * 1000))
                playlist_elapsed_ms = (
                    max(0, int((float(playlist_detected_at) - startup_started_at) * 1000))
                    if playlist_detected_at else None
                )
                first_segment_elapsed_ms = (
                    max(0, int((float(first_segment_detected_at) - startup_started_at) * 1000))
                    if first_segment_detected_at else None
                )
                logger.info(
                    "🎬 Web playback HLS session ready: %s (%s, audio=%s, ss=%.3f, segment_type=%s, playlist_kind=%s, input_mode=%s, startup_attempt=%s, source_codec=%s, startup_ms=%s, playlist_ms=%s, first_segment_ms=%s)",
                    session_id,
                    raw_path,
                    audio_index,
                    float(max(0, start_seconds)),
                    segment_type,
                    playlist_kind,
                    input_mode,
                    startup_attempt,
                    source_video_codec or "unknown",
                    startup_elapsed_ms,
                    playlist_elapsed_ms,
                    first_segment_elapsed_ms,
                )
                if self._web_playback_hls_subtitles_mode != "off":
                    try:
                        ready_session["subtitle_tracks"] = await self._build_web_playback_session_subtitle_tracks(
                            raw_path,
                            is_local=is_local,
                            session_id=session_id,
                        )
                    except Exception as exc:
                        ready_session["subtitle_tracks"] = []
                        logger.warning("🎬 Failed to build HLS subtitle track list for %s: %s", raw_path, exc)
                    ready_bootstrap_reason = str(ready_session.get("bootstrap_reason") or "initial-open").strip().lower() or "initial-open"
                    defer_subtitle_prewarm = ready_bootstrap_reason in {
                        "server-seek",
                        "progress-control",
                        "audio-switch",
                        "audio-track-change",
                    }
                    if ready_session["subtitle_tracks"] and not is_local and not defer_subtitle_prewarm:
                        try:
                            self._schedule_embedded_subtitle_source_prefetch(raw_path, is_local)
                        except Exception:
                            logger.debug("subtitle source prefetch scheduling skipped during HLS session startup", exc_info=True)
                    elif ready_session["subtitle_tracks"] and not is_local:
                        logger.info(
                            "🎬 Skipping embedded subtitle source prefetch for session=%s reason=%s",
                            session_id,
                            ready_bootstrap_reason,
                        )
                    if ready_session["subtitle_tracks"] and not defer_subtitle_prewarm:
                        try:
                            self._schedule_web_playback_subtitle_prewarm(session_id)
                        except Exception:
                            logger.debug("subtitle playlist prewarm scheduling skipped during HLS session startup", exc_info=True)
                    elif ready_session["subtitle_tracks"]:
                        logger.info(
                            "🎬 Skipping HLS subtitle prewarm for session=%s reason=%s",
                            session_id,
                            ready_bootstrap_reason,
                        )
                return ready_session
            except asyncio.CancelledError:
                await self._destroy_web_playback_session(session_id, reason="startup-cancelled")
                raise
            except Exception as exc:
                retry_with_transcode = self._should_retry_web_hls_startup_with_transcode(exc, startup_attempt)
                await self._destroy_web_playback_session(
                    session_id,
                    reason="startup-retry" if retry_with_transcode else "startup-failed",
                )
                if retry_with_transcode:
                    logger.warning(
                        "🎬 Web playback HLS startup retry with transcode: path=%s input_mode=%s attempt=%s codec=%s error=%s",
                        raw_path,
                        input_mode,
                        startup_attempt,
                        source_video_codec or "unknown",
                        exc,
                    )
                    continue
                raise

        raise RuntimeError(f"Unable to start HLS session for {raw_path}")

    async def _handle_api_web_playback_session_create(self, request):
        # HLS session API is always available regardless of transcode mode.
        # This allows the frontend to use HLS for MKV streaming while the
        # variant builder works in background.

        try:
            data = await request.json()
        except Exception:
            try:
                data = await request.post()
            except Exception:
                data = {}

        raw_path = data.get("path")
        is_local = data.get("local") is True or data.get("is_local") is True or str(data.get("local", "")).lower() == "true"
        if not raw_path:
            return web.json_response({"error": "Caminho ausente"}, status=400)

        try:
            audio_index = int(data.get("audio", data.get("audio_index", 0)) or 0)
        except (TypeError, ValueError):
            audio_index = 0
        try:
            start_seconds = float(data.get("ss", data.get("start_seconds", 0)) or 0)
        except (TypeError, ValueError):
            start_seconds = 0.0
        bootstrap_reason = str(data.get("bootstrap_reason", data.get("reason", "initial-open")) or "initial-open").strip().lower() or "initial-open"
        replace_session_id = str(data.get("replace_session_id", data.get("replaceSessionId", "")) or "").strip()
        filename_hint = str(data.get("filename", data.get("name", "")) or "").strip()

        resolved_cloud_request = None
        effective_path = str(raw_path or "").strip()
        if not is_local:
            resolved_cloud_request = await self._resolve_cloud_file_request(raw_path, filename_hint=filename_hint)
            effective_path = str(
                resolved_cloud_request.get("resolved_path")
                or resolved_cloud_request.get("normalized_path")
                or raw_path
                or ""
            ).strip()
            if not resolved_cloud_request.get("file_meta"):
                path_hash = hashlib.sha1(str(raw_path or "").encode("utf-8", errors="ignore")).hexdigest()[:10]
                logger.warning(
                    "🎬 Web playback session path unresolved: hash=%s requested=%s normalized=%s decoded=%s filename_hint=%s attempts=%s",
                    path_hash,
                    raw_path,
                    resolved_cloud_request.get("normalized_path", ""),
                    resolved_cloud_request.get("decoded_path", ""),
                    filename_hint,
                    resolved_cloud_request.get("attempts", []),
                )
                return web.json_response({
                    "error": "Arquivo não encontrado",
                    "code": "WEB_PLAYBACK_FILE_NOT_FOUND",
                }, status=404)
        elif not effective_path:
            return web.json_response({"error": "Caminho ausente"}, status=400)

        try:
            if replace_session_id:
                logger.info(
                    "🎬 Web playback session preempt before startup: replace_session_id=%s reason=%s path=%s",
                    replace_session_id,
                    bootstrap_reason,
                    effective_path,
                )
                await self._destroy_web_playback_session(
                    replace_session_id,
                    reason=f"preempt:{bootstrap_reason}",
                )
            session = await self._start_web_hls_session(
                effective_path,
                is_local=is_local,
                audio_index=max(0, audio_index),
                start_seconds=max(0.0, start_seconds),
                bootstrap_reason=bootstrap_reason,
                resolved_cloud_request=resolved_cloud_request,
            )
        except FileNotFoundError:
            return web.json_response({
                "error": "Arquivo não encontrado",
                "code": "WEB_PLAYBACK_FILE_NOT_FOUND",
            }, status=404)
        except TimeoutError:
            return web.json_response({
                "error": "Timeout preparando stream HLS",
                "code": "HLS_STARTUP_TIMEOUT",
            }, status=504)
        except Exception as exc:
            logger.error("Failed to create web playback session for %s: %s", raw_path, exc)
            return web.json_response({"error": str(exc)}, status=500)

        # Trigger background variant build so the NEXT play of this file
        # will be instant via seekable HTTP Range (prepared MP4 variant).
        filename = session.get("filename", "")
        suffix = Path(filename).suffix.lower() if filename else ""
        if suffix in PREPARED_WEB_VIDEO_EXTENSIONS and audio_index == 0:
            logger.info(
                "🎬 Deferred background web video variant build while active playback session exists: %s",
                raw_path,
            )

        return web.json_response({
            "session_id": session["id"],
            "mode": "hls",
            "playlist_url": f"/api/web_playback/session/{session['id']}/{session.get('media_playlist_name') or 'media.m3u8'}",
            "master_playlist_url": f"/api/web_playback/session/{session['id']}/master.m3u8",
            "subtitle_delivery_mode": session.get("subtitle_delivery_mode", self._web_playback_hls_subtitles_mode),
            "subtitle_group_id": session.get("subtitle_group_id", "subs"),
            "subtitle_segment_duration": session.get("subtitle_segment_duration", self._web_playback_hls_subtitle_segment_duration),
            "subtitle_tracks": session.get("subtitle_tracks") or [],
            "mime": "application/x-mpegURL",
            "duration_seconds": session.get("duration_seconds"),
            "audio_index": session.get("audio_index", 0),
            "start_seconds": session.get("start_seconds", 0.0),
            "bootstrap_reason": session.get("bootstrap_reason", bootstrap_reason),
            "segment_type": session.get("segment_type", self._web_playback_segment_type),
            "playlist_kind": session.get("playlist_kind", "ondemand"),
            "expires_in_seconds": self._web_playback_ttl_seconds,
            "filename": session.get("filename", ""),
            "requested_path": session.get("requested_path", raw_path),
            "resolved_path": session.get("resolved_path", effective_path),
            "resolver_source": session.get("resolver_source", ""),
            "input_mode": session.get("input_mode", ""),
            "startup_attempt": session.get("startup_attempt", ""),
            "source_video_codec": session.get("source_video_codec", ""),
            "replace_session_id": replace_session_id,
        }, status=201)

    async def _handle_api_web_playback_master_playlist(self, request):
        session_id = request.match_info.get("session_id", "")
        session = self._web_playback_sessions.get(session_id)
        if not session:
            return web.Response(text="Session not found", status=404)

        session["last_access_at"] = time.time()
        return web.Response(
            text=self._build_web_playback_master_playlist(session, request),
            content_type="application/x-mpegURL",
            charset="utf-8",
            headers={
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            },
        )

    async def _handle_api_web_playback_subtitle_playlist(self, request):
        session_id = request.match_info.get("session_id", "")
        track_id = request.match_info.get("track_id", "")
        try:
            session, track, playlist_path = await self._ensure_web_playback_subtitle_track_ready(session_id, track_id)
        except FileNotFoundError:
            return web.Response(text="Subtitle track not found", status=404)
        except Exception as exc:
            logger.error("Failed to prepare HLS subtitle playlist for session=%s track=%s: %s", session_id, track_id, exc)
            return web.Response(text=str(exc), status=500)

        session["last_access_at"] = time.time()
        playlist_text = playlist_path.read_text(encoding="utf-8", errors="ignore")
        return web.Response(
            text=self._rewrite_web_playback_media_playlist(playlist_text, request),
            content_type="application/x-mpegURL",
            charset="utf-8",
            headers={
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
                **self._web_playback_subtitle_response_headers(session, track),
            },
        )

    async def _handle_api_web_playback_subtitle_asset(self, request):
        session_id = request.match_info.get("session_id", "")
        track_id = request.match_info.get("track_id", "")
        asset_name = request.match_info.get("asset_name", "")
        try:
            session, track, _playlist_path = await self._ensure_web_playback_subtitle_track_ready(session_id, track_id)
        except FileNotFoundError:
            return web.Response(text="Subtitle track not found", status=404)
        except Exception as exc:
            logger.error("Failed to prepare HLS subtitle asset for session=%s track=%s: %s", session_id, track_id, exc)
            return web.Response(text=str(exc), status=500)

        subtitle_dir = (session.get("subtitle_dir") or (session.get("temp_dir") / "subtitles")) / track_id
        asset_path = (subtitle_dir / asset_name).resolve()
        if not str(asset_path).startswith(str(subtitle_dir.resolve())):
            return web.Response(text="Forbidden", status=403)
        if not asset_path.exists() or not asset_path.is_file():
            return web.Response(text="Asset not found", status=404)

        session["last_access_at"] = time.time()
        return web.FileResponse(
            asset_path,
            headers={
                "Content-Type": self._guess_web_playback_content_type(asset_name),
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
                **self._web_playback_subtitle_response_headers(session, track),
            },
        )

    async def _handle_api_web_playback_asset(self, request):
        session_id = request.match_info.get("session_id", "")
        asset_name = request.match_info.get("asset_name", "")
        session = self._web_playback_sessions.get(session_id)
        if not session:
            return web.Response(text="Session not found", status=404)

        temp_dir = session.get("temp_dir")
        if not temp_dir:
            return web.Response(text="Session unavailable", status=404)

        asset_path = (temp_dir / asset_name).resolve()
        if not str(asset_path).startswith(str(temp_dir.resolve())):
            return web.Response(text="Forbidden", status=403)
        if not asset_path.exists() or not asset_path.is_file():
            return web.Response(text="Asset not found", status=404)

        session["last_access_at"] = time.time()

        if asset_path.suffix.lower() == ".m3u8":
            playlist_text = asset_path.read_text(encoding="utf-8", errors="ignore")
            return web.Response(
                text=self._rewrite_web_playback_media_playlist(playlist_text, request),
                content_type="application/x-mpegURL",
                charset="utf-8",
                headers={
                    "Cache-Control": "no-store",
                    "Access-Control-Allow-Origin": "*",
                },
            )

        return web.FileResponse(
            asset_path,
            headers={
                "Content-Type": self._guess_web_playback_content_type(asset_name),
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            },
        )

    async def _handle_api_web_playback_session_delete(self, request):
        session_id = request.match_info.get("session_id", "")
        reason = (request.query.get("reason") or "").strip() or "client-delete"
        await self._destroy_web_playback_session(session_id, reason=reason)
        return web.json_response({"ok": True, "session_id": session_id})

    async def _resolve_public_share_file_for_playback(
        self,
        request,
        public_id: str,
        relative_path: str,
        *,
        filename_hint: str | None = None,
    ) -> tuple[str, dict, str, str]:
        _payload, target_kind, target_doc = await self._resolve_public_share_session(request, public_id)
        root_path = str(target_doc.get("path") or "").strip()
        normalized_relative = self._file_manager.normalize_public_share_relative_path(relative_path)

        async def resolve_by_parent_filename(candidate_path: str, failure_code: str = "share_file_not_found") -> tuple[str, dict] | None:
            normalized_root = _normalize_cloud_path_variant(root_path)
            normalized_candidate = _normalize_cloud_path_variant(candidate_path)
            root_prefix = normalized_root.rstrip("/")
            root_is_file = target_kind == "file"
            if not root_is_file and normalized_candidate != normalized_root and not normalized_candidate.startswith(f"{root_prefix}/"):
                raise PublicShareError("path_outside_share_scope", "Arquivo compartilhado não encontrado.", status=404)

            parent_path = str(Path(normalized_candidate).parent)
            if parent_path in ("", "."):
                parent_path = "/"
            parent_path = _normalize_cloud_path_variant(parent_path)
            if not root_is_file and parent_path != normalized_root and not parent_path.startswith(f"{root_prefix}/"):
                raise PublicShareError("path_outside_share_scope", "Arquivo compartilhado não encontrado.", status=404)

            filename_candidates = [
                self._normalize_filename_for_resolution(filename_hint),
                self._normalize_filename_for_resolution(Path(normalized_candidate).name),
            ]
            filename_candidates = [name for index, name in enumerate(filename_candidates) if name and name not in filename_candidates[:index]]
            if not filename_candidates:
                return None

            try:
                if root_is_file and hasattr(self._file_manager, "list_directory"):
                    items = await self._file_manager.list_directory(parent_path)
                elif hasattr(self._file_manager, "list_public_directory"):
                    items = await self._file_manager.list_public_directory(normalized_root, parent_path)
                else:
                    items = await self._file_manager.list_directory(parent_path)
            except Exception as exc:
                logger.info(
                    "🎬 Public share playback filename fallback unavailable: public_id=%s relative_path=%s parent=%s code=%s error=%s",
                    public_id,
                    normalized_relative,
                    parent_path,
                    failure_code,
                    exc,
                )
                return None

            matches: list[str] = []
            for item in items or []:
                if item.get("is_directory"):
                    continue
                item_path = _normalize_cloud_path_variant(item.get("path") or "")
                if not item_path:
                    continue
                if not root_is_file and item_path != normalized_root and not item_path.startswith(f"{root_prefix}/"):
                    continue
                item_name = self._normalize_filename_for_resolution(
                    item.get("filename") or item.get("name") or Path(item_path).name
                )
                if item_name not in filename_candidates:
                    continue
                if not root_is_file and hasattr(self._file_manager, "is_hidden_from_public_ancestor"):
                    if await self._file_manager.is_hidden_from_public_ancestor(normalized_root, item_path):
                        continue
                matches.append(item_path)

            if len(matches) > 1:
                logger.warning(
                    "🎬 Public share playback filename fallback ambiguous: public_id=%s relative_path=%s parent=%s matches=%s",
                    public_id,
                    normalized_relative,
                    parent_path,
                    matches[:5],
                )
                raise PublicShareError("ambiguous_filename_match", "Arquivo compartilhado não encontrado.", status=404)
            if len(matches) != 1:
                return None

            resolved_path = matches[0]
            file_meta = await self._file_manager.get_file_meta(resolved_path)
            if not file_meta:
                return None
            logger.info(
                "🎬 Public share playback resolved by filename fallback: public_id=%s relative_path=%s parent=%s requested_filename=%s resolved_path=%s",
                public_id,
                normalized_relative,
                parent_path,
                str(filename_hint or Path(normalized_candidate).name),
                resolved_path,
            )
            return resolved_path, file_meta

        if target_kind == "file":
            if normalized_relative:
                raise PublicShareError("share_file_not_found", "Arquivo compartilhado não encontrado.", status=404)
            target_path = root_path
            file_meta = await self._file_manager.get_file_meta(target_path)
            if not file_meta:
                fallback = await resolve_by_parent_filename(target_path)
                if fallback:
                    target_path, file_meta = fallback
            if not file_meta:
                raise PublicShareError("share_file_not_found", "Arquivo compartilhado não encontrado.", status=404)
        else:
            try:
                target_path = await self._file_manager.resolve_public_share_path(
                    root_path,
                    normalized_relative,
                    expect_directory=False,
                    enforce_visibility=True,
                )
            except PublicShareError as exc:
                if exc.code not in {"share_file_not_found", "share_item_not_found"}:
                    raise
                root_normalized = _normalize_cloud_path_variant(root_path)
                target_path = root_normalized if not normalized_relative else _normalize_cloud_path_variant(f"{root_normalized.rstrip('/')}/{normalized_relative}")
                fallback = await resolve_by_parent_filename(target_path, failure_code=exc.code)
                if not fallback:
                    raise
                target_path, file_meta = fallback
            else:
                file_meta = await self._file_manager.get_file_meta(target_path)
                if not file_meta:
                    fallback = await resolve_by_parent_filename(target_path)
                    if fallback:
                        target_path, file_meta = fallback
            if not file_meta:
                raise PublicShareError("share_file_not_found", "Arquivo compartilhado não encontrado.", status=404)

        if (file_meta.get("meta") or {}).get("hidden_system_file"):
            raise PublicShareError("share_file_not_found", "Arquivo compartilhado não encontrado.", status=404)

        return target_path, file_meta, root_path, target_kind

    async def _handle_api_shared_media_tracks(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        relative_path = str(request.query.get("relative_path", request.query.get("path", "")) or "").strip()

        def build_tracks_payload(
            *,
            audio_tracks=None,
            subtitle_tracks=None,
            file_meta=None,
            probe_status="ready",
            probe_source="ffprobe_input_path",
            elapsed_ms=None,
        ):
            audio_tracks = list(audio_tracks or [])
            subtitle_tracks = list(subtitle_tracks or [])
            media_meta = file_meta.get("meta") if isinstance(file_meta, dict) else {}
            media_meta = media_meta if isinstance(media_meta, dict) else {}
            try:
                metadata_audio_count = int(media_meta.get("audio_track_count") or 0)
            except (TypeError, ValueError):
                metadata_audio_count = 0
            try:
                metadata_subtitle_count = int(media_meta.get("subtitle_track_count") or 0)
            except (TypeError, ValueError):
                metadata_subtitle_count = 0

            audio_count = max(len(audio_tracks), metadata_audio_count)
            subtitle_count = max(len(subtitle_tracks), metadata_subtitle_count)
            payload = {
                "audio": audio_tracks,
                "subtitle": subtitle_tracks,
                "audio_count": audio_count,
                "subtitle_count": subtitle_count,
                "has_multiple_audio": audio_count > 1,
                "probe_status": probe_status,
                "probe_source": probe_source,
                "relative_path": relative_path,
            }
            if elapsed_ms is not None:
                payload["elapsed_ms"] = max(0, int(elapsed_ms))
            return payload

        try:
            target_path, file_meta, _root_path, _target_kind = await self._resolve_public_share_file_for_playback(
                request,
                public_id,
                relative_path,
            )
            probe_started_at = time.time()
            input_path, is_concat = await self._get_file_input_path(target_path, False)
            if not input_path:
                elapsed_ms = (time.time() - probe_started_at) * 1000
                media_meta = file_meta.get("meta") if isinstance(file_meta, dict) else {}
                media_meta = media_meta if isinstance(media_meta, dict) else {}
                has_audio_track_metadata = media_meta.get("audio_track_count") not in (None, "")
                payload = build_tracks_payload(
                    file_meta=file_meta,
                    probe_status="metadata_only" if has_audio_track_metadata else "unavailable",
                    probe_source="metadata" if has_audio_track_metadata else "unavailable",
                    elapsed_ms=elapsed_ms,
                )
                logger.info(
                    "🎬 Public media tracks probe unavailable: public_id=%s path=%s audio_count=%s status=%s elapsed_ms=%s",
                    public_id,
                    target_path,
                    payload["audio_count"],
                    payload["probe_status"],
                    payload.get("elapsed_ms", 0),
                )
                return web.json_response(payload)

            probe_data, _ = await self._probe_ffprobe_metadata(input_path, is_concat)
            streams = probe_data.get("streams", [])
            audio_tracks = []
            subtitle_tracks = []
            audio_idx = 0
            sub_idx = 0
            token = self._request_bearer_token(request)
            token_query = f"&token={quote(token, safe='')}" if token else ""
            public_subtitle_base = f"/api/shared_item/{quote(public_id, safe='')}/subtitle?relative_path={quote(relative_path, safe='')}"

            for stream in streams:
                codec_type = stream.get("codec_type")
                tags = stream.get("tags", {})
                disposition = stream.get("disposition", {})
                lang = _normalize_language_code(tags.get("language", ""))
                title = (
                    _clean_track_value(tags.get("title", ""))
                    or _clean_track_value(tags.get("handler_name", ""))
                    or _clean_track_value(tags.get("HANDLER_NAME", ""))
                )

                if codec_type == "audio":
                    audio_tracks.append({
                        "index": audio_idx,
                        "stream_index": stream.get("index"),
                        "codec": stream.get("codec_name", ""),
                        "language": lang,
                        "title": title,
                        "label": _build_audio_label(language=lang, title=title, index=audio_idx),
                        "channels": stream.get("channels", 0),
                        "default": disposition.get("default", 0) == 1,
                    })
                    audio_idx += 1
                elif codec_type == "subtitle":
                    forced = disposition.get("forced", 0) == 1
                    default = disposition.get("default", 0) == 1
                    hearing_impaired = disposition.get("hearing_impaired", 0) == 1
                    comment = disposition.get("comment", 0) == 1
                    captions = disposition.get("captions", 0) == 1
                    src = f"{public_subtitle_base}&index={sub_idx}{token_query}"
                    subtitle_tracks.append({
                        "index": sub_idx,
                        "stream_index": stream.get("index"),
                        "codec": stream.get("codec_name", ""),
                        "src": src,
                        "language": lang,
                        "title": title,
                        "label": _build_subtitle_label(
                            language=lang,
                            title=title,
                            index=sub_idx,
                            filename=target_path,
                            src=src,
                            forced=forced,
                            default=default,
                            hearing_impaired=hearing_impaired,
                            comment=comment,
                            captions=captions,
                        ),
                        "forced": forced,
                        "default": default,
                        "hearing_impaired": hearing_impaired,
                        "comment": comment,
                        "captions": captions,
                    })
                    sub_idx += 1

            if is_concat:
                try:
                    os.unlink(input_path)
                except Exception:
                    pass

            elapsed_ms = (time.time() - probe_started_at) * 1000
            probe_status = "ready" if streams else "empty"
            payload = build_tracks_payload(
                audio_tracks=audio_tracks,
                subtitle_tracks=subtitle_tracks,
                file_meta=file_meta,
                probe_status=probe_status,
                probe_source="ffprobe_input_path",
                elapsed_ms=elapsed_ms,
            )
            logger.info(
                "🎬 Public media tracks probe result: public_id=%s path=%s audio=%s subtitle=%s audio_count=%s status=%s elapsed_ms=%s",
                public_id,
                target_path,
                len(audio_tracks),
                len(subtitle_tracks),
                payload["audio_count"],
                payload["probe_status"],
                payload.get("elapsed_ms", 0),
            )
            return web.json_response(payload)
        except PublicShareError as exc:
            return web.json_response({"error": exc.message, "code": exc.code}, status=exc.status)
        except asyncio.TimeoutError:
            return web.json_response(build_tracks_payload(probe_status="timeout", probe_source="timeout"))
        except web.HTTPException:
            raise
        except Exception as exc:
            logger.error("Public media tracks error for %s/%s: %s", public_id, relative_path, exc, exc_info=True)
            return web.json_response({"error": "Falha ao carregar trilhas públicas"}, status=500)

    async def _handle_api_shared_subtitle(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        relative_path = str(request.query.get("relative_path", request.query.get("path", "")) or "").strip()
        sidecar_relative_path = str(request.query.get("sidecar_relative_path", "") or "").strip()
        try:
            if sidecar_relative_path:
                sidecar_path, _sidecar_meta, _root_path, _target_kind = await self._resolve_public_share_file_for_playback(
                    request,
                    public_id,
                    sidecar_relative_path,
                )
                return await self._serve_sidecar_subtitle(sidecar_path, False)

            target_path, _file_meta, _root_path, _target_kind = await self._resolve_public_share_file_for_playback(
                request,
                public_id,
                relative_path,
            )
            try:
                sub_index = int(request.query.get("index", "0") or 0)
            except (TypeError, ValueError):
                sub_index = 0

            cache_path = self._build_web_subtitle_cache_path(target_path, False, sub_index)
            if not cache_path.exists():
                async with self._get_web_subtitle_lock(cache_path):
                    if not cache_path.exists():
                        input_path, is_concat = await self._materialize_embedded_subtitle_input(target_path, False)
                        if not input_path:
                            return web.Response(text="File not available for subtitle extraction", status=404)
                        stdout = await self._extract_embedded_subtitle_webvtt(
                            input_path=input_path,
                            is_concat=is_concat,
                            sub_index=sub_index,
                            raw_path=target_path,
                            is_local=False,
                        )
                        if not stdout.strip():
                            return web.Response(text="Subtitle extraction returned empty output", status=500)
                        temp_cache_path = cache_path.with_suffix(".tmp")
                        temp_cache_path.write_bytes(stdout)
                        temp_cache_path.replace(cache_path)

            return self._build_subtitle_http_response(
                cache_path,
                raw_path=target_path,
                is_local=False,
                sub_index=sub_index,
                extraction_mode="public_share",
            )
        except PublicShareError as exc:
            return web.Response(text=exc.message, status=exc.status)
        except UnicodeDecodeError:
            return web.Response(text="Subtitle must be UTF-8 encoded", status=415)
        except asyncio.TimeoutError:
            return web.Response(text="Subtitle extraction timeout", status=504)
        except web.HTTPException:
            raise
        except Exception as exc:
            logger.error("Public subtitle error for %s/%s: %s", public_id, relative_path or sidecar_relative_path, exc, exc_info=True)
            return web.Response(text="Falha ao carregar legenda pública", status=500)

    async def _handle_api_shared_web_playback_session_create(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        try:
            data = await request.json()
        except Exception:
            try:
                data = await request.post()
            except Exception:
                data = {}

        relative_path = str(data.get("relative_path", data.get("path", "")) or "").strip()
        filename_hint = str(data.get("filename", data.get("name", "")) or "").strip()
        try:
            target_path, file_meta, root_path, target_kind = await self._resolve_public_share_file_for_playback(
                request,
                public_id,
                relative_path,
                filename_hint=filename_hint,
            )
        except PublicShareError as exc:
            return web.json_response({"error": exc.message, "code": exc.code}, status=exc.status)
        except web.HTTPException:
            raise
        except Exception as exc:
            logger.error("Error resolving public playback target for %s: %s", public_id, exc, exc_info=True)
            return web.json_response({"error": "Falha ao preparar reprodução pública"}, status=500)

        try:
            audio_index = int(data.get("audio", data.get("audio_index", 0)) or 0)
        except (TypeError, ValueError):
            audio_index = 0
        try:
            start_seconds = float(data.get("ss", data.get("start_seconds", 0)) or 0)
        except (TypeError, ValueError):
            start_seconds = 0.0
        bootstrap_reason = str(data.get("bootstrap_reason", data.get("reason", "public-share-open")) or "public-share-open").strip().lower() or "public-share-open"
        replace_session_id = str(data.get("replace_session_id", data.get("replaceSessionId", "")) or "").strip()

        try:
            try:
                resolved_cloud_request = await self._resolve_cloud_file_request(target_path, filename_hint=filename_hint)
            except FileNotFoundError:
                resolved_cloud_request = {}
            if not resolved_cloud_request.get("file_meta"):
                resolved_cloud_request = {
                    "resolved_path": target_path,
                    "normalized_path": target_path,
                    "file_meta": file_meta,
                    "resolver_source": "public-share",
                }
            effective_path = str(
                resolved_cloud_request.get("resolved_path")
                or resolved_cloud_request.get("normalized_path")
                or target_path
            ).strip()
            logger.info(
                "🎬 Public share playback target resolved: public_id=%s target_kind=%s relative_path=%s target_path=%s resolver_source=%s",
                public_id,
                target_kind,
                self._file_manager.normalize_public_share_relative_path(relative_path),
                target_path,
                resolved_cloud_request.get("resolver_source", ""),
            )
            if replace_session_id:
                await self._destroy_web_playback_session(
                    replace_session_id,
                    reason=f"preempt:public-share:{bootstrap_reason}",
                )
            session = await self._start_web_hls_session(
                effective_path,
                is_local=False,
                audio_index=max(0, audio_index),
                start_seconds=max(0.0, start_seconds),
                bootstrap_reason=bootstrap_reason,
                resolved_cloud_request=resolved_cloud_request,
            )
            session["scope"] = "public_share"
            session["public_id"] = public_id
            session["public_root_path"] = root_path
            session["public_target_kind"] = target_kind
            session["public_target_path"] = effective_path
            session["public_relative_path"] = self._file_manager.normalize_public_share_relative_path(relative_path)
        except FileNotFoundError:
            return web.json_response({
                "error": "Arquivo compartilhado não encontrado",
                "code": "share_file_not_found",
            }, status=404)
        except TimeoutError:
            return web.json_response({
                "error": "Timeout preparando stream HLS",
                "code": "HLS_STARTUP_TIMEOUT",
            }, status=504)
        except Exception as exc:
            logger.error("Failed to create public web playback session for %s/%s: %s", public_id, relative_path, exc, exc_info=True)
            return web.json_response({"error": str(exc)}, status=500)

        token = self._request_bearer_token(request)
        token_query = f"?token={quote(token, safe='')}" if token else ""
        session_base = f"/api/shared_item/{quote(public_id, safe='')}/web_playback/session/{quote(session['id'], safe='')}"
        media_playlist_name = session.get("media_playlist_name") or "media.m3u8"
        public_subtitle_tracks = self._publicize_web_playback_subtitle_tracks(
            session,
            public_id,
            token_query=token_query,
        )
        subtitle_delivery_mode = (
            session.get("subtitle_delivery_mode", getattr(self, "_web_playback_hls_subtitles_mode", "off"))
            if public_subtitle_tracks
            else "off"
        )
        logger.info(
            "🎬 Public share playback session ready: public_id=%s session=%s target=%s ss=%.3f audio=%s subtitles=%s",
            public_id,
            session["id"],
            effective_path,
            float(session.get("start_seconds") or 0.0),
            session.get("audio_index", 0),
            len(public_subtitle_tracks),
        )
        return web.json_response({
            "session_id": session["id"],
            "mode": "hls",
            "playlist_url": f"{session_base}/{quote(media_playlist_name, safe='')}{token_query}",
            "master_playlist_url": f"{session_base}/master.m3u8{token_query}",
            "subtitle_delivery_mode": subtitle_delivery_mode,
            "subtitle_group_id": session.get("subtitle_group_id", "subs"),
            "subtitle_segment_duration": session.get("subtitle_segment_duration", getattr(self, "_web_playback_hls_subtitle_segment_duration", 4)),
            "subtitle_tracks": public_subtitle_tracks,
            "mime": "application/x-mpegURL",
            "duration_seconds": session.get("duration_seconds"),
            "audio_index": session.get("audio_index", 0),
            "start_seconds": session.get("start_seconds", 0.0),
            "bootstrap_reason": session.get("bootstrap_reason", bootstrap_reason),
            "segment_type": session.get("segment_type", self._web_playback_segment_type),
            "playlist_kind": session.get("playlist_kind", "ondemand"),
            "expires_in_seconds": self._web_playback_ttl_seconds,
            "filename": session.get("filename", ""),
            "requested_path": session.get("requested_path", target_path),
            "resolved_path": session.get("resolved_path", effective_path),
            "resolver_source": session.get("resolver_source", ""),
            "input_mode": session.get("input_mode", ""),
            "startup_attempt": session.get("startup_attempt", ""),
            "source_video_codec": session.get("source_video_codec", ""),
            "replace_session_id": replace_session_id,
        }, status=201)

    async def _resolve_public_web_playback_session(self, request, public_id: str, session_id: str) -> dict | None:
        _payload, target_kind, target_doc = await self._resolve_public_share_session(request, public_id)
        session = self._web_playback_sessions.get(session_id)
        if not session:
            return None
        if session.get("scope") != "public_share" or str(session.get("public_id") or "") != public_id:
            raise web.HTTPForbidden(text="Sessão de reprodução incompatível")
        root_path = str(target_doc.get("path") or "").strip()
        if str(session.get("public_root_path") or "") != root_path:
            raise web.HTTPGone(text="Compartilhamento alterado")
        if (target_kind == "file") != (str(session.get("public_target_kind") or "") == "file"):
            raise web.HTTPGone(text="Compartilhamento alterado")
        return session

    def _build_public_web_playback_master_playlist(self, session: dict, request) -> str:
        media_playlist_name = session.get("media_playlist_name") or "media.m3u8"
        token = self._extract_request_token(request)
        media_playlist_ref = self._append_token_to_playlist_path(media_playlist_name, token)
        public_id = str(session.get("public_id") or request.match_info.get("public_id") or "").strip()
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:7",
            "#EXT-X-INDEPENDENT-SEGMENTS",
        ]

        subtitle_group_id = str(session.get("subtitle_group_id") or "subs").strip() or "subs"
        subtitle_tracks = session.get("subtitle_tracks") or []
        subtitle_mode = str(session.get("subtitle_delivery_mode") or "off").strip().lower()
        if subtitle_mode != "off" and public_id:
            for track in subtitle_tracks:
                track_id = str(track.get("track_id") or "").strip()
                if not track_id:
                    continue
                safe_name = str(track.get("label") or track.get("name") or track_id).replace('"', "'").replace(",", " -")
                playlist_path = self._build_public_web_playback_subtitle_playlist_path(public_id, session.get("id", ""), track_id)
                attrs = [
                    'TYPE=SUBTITLES',
                    f'GROUP-ID="{subtitle_group_id}"',
                    f'NAME="{safe_name}"',
                    f'URI="{self._append_token_to_playlist_path(playlist_path, token)}"',
                    f'AUTOSELECT={"YES" if track.get("default") or track.get("language") else "NO"}',
                    f'DEFAULT={"YES" if track.get("default") else "NO"}',
                    f'FORCED={"YES" if track.get("forced") else "NO"}',
                ]
                language = _normalize_language_code(track.get("language", ""))
                if language:
                    attrs.append(f'LANGUAGE="{language}"')
                lines.append(f"#EXT-X-MEDIA:{','.join(attrs)}")

        stream_inf = "BANDWIDTH=3500000,AVERAGE-BANDWIDTH=2200000"
        if subtitle_mode != "off" and subtitle_tracks:
            stream_inf += f',SUBTITLES="{subtitle_group_id}"'
        lines.extend([
            f"#EXT-X-STREAM-INF:{stream_inf}",
            media_playlist_ref,
            "",
        ])
        return "\n".join(lines)

    async def _handle_api_shared_web_playback_master_playlist(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        session_id = str(request.match_info.get("session_id") or "").strip()
        try:
            session = await self._resolve_public_web_playback_session(request, public_id, session_id)
        except web.HTTPException:
            raise
        if not session:
            return web.Response(text="Session not found", status=404)
        session["last_access_at"] = time.time()
        return web.Response(
            text=self._build_public_web_playback_master_playlist(session, request),
            content_type="application/x-mpegURL",
            charset="utf-8",
            headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"},
        )

    async def _handle_api_shared_web_playback_asset(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        session_id = str(request.match_info.get("session_id") or "").strip()
        asset_name = str(request.match_info.get("asset_name") or "").strip()
        try:
            session = await self._resolve_public_web_playback_session(request, public_id, session_id)
        except web.HTTPException:
            raise
        if not session:
            return web.Response(text="Session not found", status=404)

        temp_dir = session.get("temp_dir")
        if not temp_dir:
            return web.Response(text="Session unavailable", status=404)

        asset_path = (temp_dir / asset_name).resolve()
        if not str(asset_path).startswith(str(temp_dir.resolve())):
            return web.Response(text="Forbidden", status=403)
        if not asset_path.exists() or not asset_path.is_file():
            return web.Response(text="Asset not found", status=404)

        session["last_access_at"] = time.time()
        if asset_path.suffix.lower() == ".m3u8":
            playlist_text = asset_path.read_text(encoding="utf-8", errors="ignore")
            return web.Response(
                text=self._rewrite_web_playback_media_playlist(playlist_text, request),
                content_type="application/x-mpegURL",
                charset="utf-8",
                headers={"Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"},
            )

        return web.FileResponse(
            asset_path,
            headers={
                "Content-Type": self._guess_web_playback_content_type(asset_name),
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
            },
        )

    async def _handle_api_shared_web_playback_subtitle_playlist(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        session_id = str(request.match_info.get("session_id") or "").strip()
        track_id = str(request.match_info.get("track_id") or "").strip()
        try:
            session = await self._resolve_public_web_playback_session(request, public_id, session_id)
        except web.HTTPException:
            raise
        if not session:
            return web.Response(text="Session not found", status=404)
        try:
            session, track, playlist_path = await self._ensure_web_playback_subtitle_track_ready(session_id, track_id)
        except FileNotFoundError:
            return web.Response(text="Subtitle track not found", status=404)
        except Exception as exc:
            logger.error(
                "Failed to prepare public HLS subtitle playlist for public_id=%s session=%s track=%s: %s",
                public_id,
                session_id,
                track_id,
                exc,
            )
            return web.Response(text=str(exc), status=500)

        session["last_access_at"] = time.time()
        playlist_text = playlist_path.read_text(encoding="utf-8", errors="ignore")
        logger.info(
            "🎬 Public share subtitle playlist ready: public_id=%s session=%s track=%s",
            public_id,
            session_id,
            track_id,
        )
        return web.Response(
            text=self._rewrite_web_playback_media_playlist(playlist_text, request),
            content_type="application/x-mpegURL",
            charset="utf-8",
            headers={
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
                **self._web_playback_subtitle_response_headers(session, track),
            },
        )

    async def _handle_api_shared_web_playback_subtitle_asset(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        session_id = str(request.match_info.get("session_id") or "").strip()
        track_id = str(request.match_info.get("track_id") or "").strip()
        asset_name = str(request.match_info.get("asset_name") or "").strip()
        try:
            session = await self._resolve_public_web_playback_session(request, public_id, session_id)
        except web.HTTPException:
            raise
        if not session:
            return web.Response(text="Session not found", status=404)
        try:
            session, track, _playlist_path = await self._ensure_web_playback_subtitle_track_ready(session_id, track_id)
        except FileNotFoundError:
            return web.Response(text="Subtitle track not found", status=404)
        except Exception as exc:
            logger.error(
                "Failed to prepare public HLS subtitle asset for public_id=%s session=%s track=%s: %s",
                public_id,
                session_id,
                track_id,
                exc,
            )
            return web.Response(text=str(exc), status=500)

        subtitle_dir = (session.get("subtitle_dir") or (session.get("temp_dir") / "subtitles")) / track_id
        asset_path = (subtitle_dir / asset_name).resolve()
        if not str(asset_path).startswith(str(subtitle_dir.resolve())):
            return web.Response(text="Forbidden", status=403)
        if not asset_path.exists() or not asset_path.is_file():
            return web.Response(text="Asset not found", status=404)

        session["last_access_at"] = time.time()
        return web.FileResponse(
            asset_path,
            headers={
                "Content-Type": self._guess_web_playback_content_type(asset_name),
                "Cache-Control": "no-store",
                "Access-Control-Allow-Origin": "*",
                **self._web_playback_subtitle_response_headers(session, track),
            },
        )

    async def _handle_api_shared_web_playback_session_delete(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        session_id = str(request.match_info.get("session_id") or "").strip()
        try:
            session = await self._resolve_public_web_playback_session(request, public_id, session_id)
        except web.HTTPException:
            session = self._web_playback_sessions.get(session_id)
            if not session or session.get("scope") != "public_share" or str(session.get("public_id") or "") != public_id:
                raise
        if not session:
            return web.json_response({"ok": True, "session_id": session_id})
        reason = (request.query.get("reason") or "").strip() or "public-client-delete"
        await self._destroy_web_playback_session(session_id, reason=reason)
        logger.info("🧹 Public share playback session deleted: public_id=%s session=%s reason=%s", public_id, session_id, reason)
        return web.json_response({"ok": True, "session_id": session_id})

    async def _serve_file_path_with_range(
        self,
        request,
        file_path: Path,
        *,
        filename: str | None = None,
        content_type: str | None = None,
        extra_headers: dict | None = None,
    ):
        """Serve a local file path with HTTP Range support."""
        stat = file_path.stat()
        total_size = stat.st_size
        served_filename = filename or file_path.name

        if not content_type:
            content_type = _subtitle_stream_content_type(served_filename)
        if not content_type:
            content_type, _ = mimetypes.guess_type(served_filename)
        if not content_type:
            content_type = "application/octet-stream"

        etag = f'"{hashlib.md5(f"{total_size}:{stat.st_mtime}".encode()).hexdigest()}"'
        if_none_match = request.headers.get("If-None-Match")
        if if_none_match and if_none_match == etag:
            return web.Response(status=304)

        range_header = request.headers.get("Range")
        start = 0
        end = total_size - 1

        if range_header:
            if_range = request.headers.get("If-Range")
            if if_range and if_range != etag:
                range_header = None
            else:
                try:
                    range_spec = range_header.replace("bytes=", "")
                    parts = range_spec.split("-")
                    if parts[0]:
                        start = int(parts[0])
                    if parts[1]:
                        end = int(parts[1])
                    end = min(end, total_size - 1)
                except Exception:
                    return web.Response(status=416)

        if start > end:
            return web.Response(status=416)

        content_length = end - start + 1
        headers = {
            "Content-Type": f"{content_type}; charset=utf-8" if Path(served_filename).suffix.lower() in SUBTITLE_EXTENSIONS else content_type,
            "Content-Length": str(content_length),
            "Content-Disposition": f'inline; filename="{served_filename}"',
            "Accept-Ranges": "bytes",
            "ETag": etag,
            "Cache-Control": "no-cache",
        }
        if extra_headers:
            headers.update(extra_headers)

        status = 206 if range_header else 200
        if range_header:
            headers["Content-Range"] = f"bytes {start}-{end}/{total_size}"

        response = web.StreamResponse(status=status, headers=headers)
        await response.prepare(request)

        with open(file_path, "rb") as f:
            f.seek(start)
            bytes_sent = 0
            while bytes_sent < content_length:
                chunk = f.read(min(65536, content_length - bytes_sent))
                if not chunk:
                    break
                await response.write(chunk)
                bytes_sent += len(chunk)

        await response.write_eof()
        return response

    async def _get_or_create_stable_audio_variant(
        self,
        raw_path: str,
        *,
        is_local: bool,
        audio_index: int,
        file_meta: dict | None = None,
        file_path: Path | None = None,
        audio_only: bool = False,
    ) -> tuple[Path | None, str | None]:
        """Create or reuse a seekable remuxed media file for alternate audio tracks."""
        filename = file_path.name if is_local and file_path else (file_meta["filename"] if file_meta else "")
        source_suffix = Path(filename).suffix.lower()
        if source_suffix not in STABLE_AUDIO_VARIANT_EXTENSIONS:
            return None, filename or None
        variant_suffix = ".webm" if source_suffix == ".webm" else (".m4a" if audio_only else source_suffix)

        if is_local:
            source_path = file_path or Path(raw_path)
            if not source_path.exists():
                return None, filename or None
            stat = source_path.stat()
            source_signature = f"{stat.st_size}:{stat.st_mtime_ns}"
        else:
            if not file_meta:
                file_meta = await self._file_manager.get_file_meta(raw_path)
            if not file_meta:
                return None, filename or None
            source_signature = self._generate_etag(file_meta)

        variant_key = hashlib.md5(
            f"{raw_path}|{1 if is_local else 0}|{audio_index}|{source_signature}|{source_suffix}|audio_only={1 if audio_only else 0}".encode()
        ).hexdigest()
        variant_path = self._audio_variant_dir / f"{variant_key}{variant_suffix}"
        if variant_path.exists() and variant_path.stat().st_size > 0:
            return variant_path, filename or variant_path.name

        build_lock = self._audio_variant_locks.setdefault(variant_key, asyncio.Lock())
        async with build_lock:
            if variant_path.exists() and variant_path.stat().st_size > 0:
                return variant_path, filename or variant_path.name

            input_path = None
            is_concat = False
            temp_source_path = None
            temp_output_path = variant_path.with_name(f"{variant_path.stem}.{os.getpid()}.tmp{variant_suffix}")
            try:
                if is_local:
                    input_path = str(file_path or Path(raw_path))
                    is_concat = False
                else:
                    if not file_meta:
                        file_meta = await self._file_manager.get_file_meta(raw_path)
                    if not file_meta:
                        return None, filename or None
                    cached_source_path = self._file_manager.get_cached_file_path(file_meta, raw_path)
                    if cached_source_path and Path(cached_source_path).exists():
                        input_path = str(cached_source_path)
                    else:
                        logger.info(f"🎧 Stable audio fallback materializing source: {raw_path}")
                        temp_source_path = variant_path.with_name(f"{variant_path.stem}.{os.getpid()}.source{source_suffix}")
                        try:
                            await self._file_manager.materialize_cached_file_for_read(
                                raw_path,
                                temp_source_path,
                                file_meta=file_meta,
                                timeout=120,
                            )
                        except asyncio.TimeoutError:
                            logger.warning("Stable audio fallback timed out while caching source: %s", raw_path)
                            return None, filename or None
                        input_path = str(temp_source_path)
                    is_concat = False

                input_args = ['-i', input_path] if not is_concat else ['-f', 'concat', '-safe', '0', '-i', input_path]
                map_args = ['-map', f'0:a:{audio_index}'] if audio_only else ['-map', '0:v:0?', '-map', f'0:a:{audio_index}']

                if audio_only and source_suffix != '.webm':
                    output_args = [
                        *map_args,
                        '-vn',
                        '-c:a', 'aac',
                        '-b:a', '192k',
                        '-movflags', '+faststart',
                        '-f', 'mp4',
                        str(temp_output_path),
                    ]
                elif source_suffix == '.webm':
                    output_args = [
                        *map_args,
                        *([] if audio_only else ['-c:v', 'copy']),
                        '-c:a', 'libopus',
                        '-b:a', '192k',
                        '-f', 'webm',
                        str(temp_output_path),
                    ]
                else:
                    output_args = [
                        *map_args,
                        '-c:v', 'copy',
                        '-c:a', 'aac',
                        '-b:a', '192k',
                        '-movflags', '+faststart',
                        '-f', 'mp4',
                        str(temp_output_path),
                    ]

                proc = await asyncio.create_subprocess_exec(
                    'ffmpeg',
                    '-hide_banner', '-loglevel', 'warning',
                    '-y',
                    *input_args,
                    *output_args,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, stderr = await asyncio.wait_for(proc.communicate(), timeout=900)
                if proc.returncode != 0 or not temp_output_path.exists() or temp_output_path.stat().st_size <= 0:
                    logger.warning(
                        "Stable audio variant build failed for %s (audio=%s): %s",
                        raw_path,
                        audio_index,
                        (stderr or b"").decode(errors='ignore')[:800],
                    )
                    return None, filename or None

                os.replace(temp_output_path, variant_path)
                logger.info(
                    "🎧 Stable audio variant ready: %s (audio=%s, output=%s)",
                    raw_path,
                    audio_index,
                    variant_path,
                )
                return variant_path, filename or variant_path.name
            finally:
                if is_concat and input_path:
                    try:
                        os.unlink(input_path)
                    except Exception:
                        pass
                if temp_source_path and temp_source_path.exists():
                    try:
                        os.unlink(temp_source_path)
                    except Exception:
                        pass
                if temp_output_path.exists():
                    try:
                        os.unlink(temp_output_path)
                    except Exception:
                        pass

    def _validate_stable_web_video_variant_probe(self, probe_data: dict) -> tuple[bool, str]:
        streams = probe_data.get("streams", []) if isinstance(probe_data, dict) else []
        format_data = probe_data.get("format", {}) if isinstance(probe_data, dict) else {}

        video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
        if not video_stream:
            return False, "missing-video-stream"

        video_codec = (video_stream.get("codec_name") or "").lower()
        if video_codec != "h264":
            return False, f"unexpected-video-codec:{video_codec or 'unknown'}"

        pixel_format = (video_stream.get("pix_fmt") or "").lower()
        if pixel_format and pixel_format != "yuv420p":
            return False, f"unexpected-pix-fmt:{pixel_format}"

        audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
        if audio_stream:
            audio_codec = (audio_stream.get("codec_name") or "").lower()
            if audio_codec != "aac":
                return False, f"unexpected-audio-codec:{audio_codec or 'unknown'}"

            channels = _safe_int(audio_stream.get("channels"))
            if channels is not None and channels > 2:
                return False, f"unexpected-audio-channels:{channels}"

            sample_rate = _safe_int(audio_stream.get("sample_rate"))
            if sample_rate is not None and sample_rate != 48000:
                return False, f"unexpected-audio-sample-rate:{sample_rate}"

        duration = _safe_float(format_data.get("duration"))
        if duration is None or duration <= 0:
            return False, "missing-duration"

        return True, ""

    async def _get_or_create_stable_web_video_variant(
        self,
        raw_path: str,
        *,
        is_local: bool,
        audio_index: int,
        file_meta: dict | None = None,
        file_path: Path | None = None,
    ) -> tuple[Path | None, str | None]:
        filename = file_path.name if is_local and file_path else (file_meta["filename"] if file_meta else "")
        source_suffix = Path(filename).suffix.lower()
        if source_suffix not in PREPARED_WEB_VIDEO_EXTENSIONS:
            return None, filename or None

        served_filename = f"{Path(filename).stem}.mp4" if filename else "video.mp4"

        if is_local:
            source_path = file_path or Path(raw_path)
            if not source_path.exists():
                return None, served_filename
            stat = source_path.stat()
            source_signature = f"{stat.st_size}:{stat.st_mtime_ns}"
        else:
            if not file_meta:
                file_meta = await self._file_manager.get_file_meta(raw_path)
            if not file_meta:
                return None, served_filename
            source_signature = self._generate_etag(file_meta)

        pipeline_signature = "prepared_web_video_variant_v1"
        variant_key = hashlib.md5(
            f"{raw_path}|{1 if is_local else 0}|{audio_index}|{source_signature}|{pipeline_signature}".encode()
        ).hexdigest()
        variant_path = self._web_video_variant_dir / f"{variant_key}.mp4"
        if variant_path.exists() and variant_path.stat().st_size > 0:
            return variant_path, served_filename

        build_lock = self._web_video_variant_locks.setdefault(variant_key, asyncio.Lock())
        async with build_lock:
            if variant_path.exists() and variant_path.stat().st_size > 0:
                return variant_path, served_filename

            input_args: list[str] = []
            temp_source_path: Path | None = None
            temp_concat_path: str | None = None
            temp_output_path = variant_path.with_name(f"{variant_path.stem}.{os.getpid()}.tmp.mp4")

            try:
                if is_local:
                    source_path = file_path or Path(raw_path)
                    if not source_path.exists():
                        return None, served_filename
                    input_args.extend(["-i", str(source_path)])
                else:
                    if not file_meta:
                        file_meta = await self._file_manager.get_file_meta(raw_path)
                    if not file_meta:
                        return None, served_filename

                    logger.info("🎬 Stable web video variant requires full cache first: %s", raw_path)
                    await self._file_manager.ensure_file_cached(raw_path)

                    cached_path = self._file_manager.get_cached_file_path(file_meta, raw_path)
                    if cached_path and Path(cached_path).exists():
                        input_args.extend(["-i", str(cached_path)])
                    else:
                        chunks = file_meta.get("chunks", [])
                        if not chunks:
                            return None, served_filename
                        temp_source_path = variant_path.with_name(
                            f"{variant_path.stem}.{os.getpid()}.source{source_suffix}"
                        )
                        await asyncio.to_thread(
                            self._file_manager._stitch_cached_chunks_to_file,
                            raw_path,
                            chunks,
                            temp_source_path,
                        )
                        input_args.extend(["-i", str(temp_source_path)])

                proc = await asyncio.create_subprocess_exec(
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "warning",
                    "-y",
                    *input_args,
                    "-map",
                    "0:v:0",
                    "-map",
                    f"0:a:{audio_index}?",
                    "-sn",
                    "-dn",
                    "-fflags",
                    "+genpts",
                    "-avoid_negative_ts",
                    "make_zero",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-crf",
                    "23",
                    "-pix_fmt",
                    "yuv420p",
                    "-profile:v",
                    "main",
                    "-level:v",
                    "4.1",
                    "-c:a",
                    "aac",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-b:a",
                    "192k",
                    "-af",
                    "aresample=async=1:first_pts=0",
                    "-movflags",
                    "+faststart",
                    "-max_muxing_queue_size",
                    "2048",
                    "-f",
                    "mp4",
                    str(temp_output_path),
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, stderr = await asyncio.wait_for(proc.communicate(), timeout=3600)
                stderr_text = (stderr or b"").decode(errors="ignore")[:1200]

                if proc.returncode != 0 or not temp_output_path.exists() or temp_output_path.stat().st_size <= 0:
                    logger.warning(
                        "Stable web video variant build failed for %s (audio=%s): %s",
                        raw_path,
                        audio_index,
                        stderr_text,
                    )
                    return None, served_filename

                probe_data, probe_limitations = await self._probe_ffprobe_metadata(str(temp_output_path), False)
                if probe_limitations:
                    logger.warning(
                        "Stable web video variant probe limitations for %s (audio=%s): %s",
                        raw_path,
                        audio_index,
                        probe_limitations,
                    )
                is_valid, validation_reason = self._validate_stable_web_video_variant_probe(probe_data)
                if not is_valid:
                    logger.warning(
                        "Stable web video variant validation failed for %s (audio=%s): %s",
                        raw_path,
                        audio_index,
                        validation_reason,
                    )
                    return None, served_filename

                os.replace(temp_output_path, variant_path)
                logger.info(
                    "🎬 Stable web video variant ready: %s (audio=%s, output=%s)",
                    raw_path,
                    audio_index,
                    variant_path,
                )
                return variant_path, served_filename
            finally:
                if temp_concat_path:
                    try:
                        os.unlink(temp_concat_path)
                    except Exception:
                        pass
                if temp_source_path and temp_source_path.exists():
                    try:
                        os.unlink(temp_source_path)
                    except Exception:
                        pass
                if temp_output_path.exists():
                    try:
                        os.unlink(temp_output_path)
                    except Exception:
                        pass

    def _compute_web_video_variant_key(
        self,
        raw_path: str,
        *,
        is_local: bool,
        audio_index: int,
        source_signature: str,
    ) -> str:
        pipeline_signature = "prepared_web_video_variant_v1"
        return hashlib.md5(
            f"{raw_path}|{1 if is_local else 0}|{audio_index}|{source_signature}|{pipeline_signature}".encode()
        ).hexdigest()

    def _get_existing_web_video_variant(
        self,
        raw_path: str,
        *,
        is_local: bool,
        audio_index: int,
        file_meta: dict | None = None,
        file_path: Path | None = None,
    ) -> tuple[Path | None, str | None, str | None]:
        """Check if a pre-built web video variant already exists on disk.
        Returns (variant_path, served_filename, variant_key) — all None if not found.
        This is FAST (disk stat only, no transcode).
        """
        filename = file_path.name if is_local and file_path else (file_meta["filename"] if file_meta else "")
        source_suffix = Path(filename).suffix.lower()
        if source_suffix not in PREPARED_WEB_VIDEO_EXTENSIONS:
            return None, filename or None, None

        served_filename = f"{Path(filename).stem}.mp4" if filename else "video.mp4"

        try:
            if is_local:
                source_path = file_path or Path(raw_path)
                if not source_path.exists():
                    return None, served_filename, None
                stat = source_path.stat()
                source_signature = f"{stat.st_size}:{stat.st_mtime_ns}"
            else:
                if not file_meta:
                    return None, served_filename, None
                source_signature = self._generate_etag(file_meta)
        except Exception:
            return None, served_filename, None

        variant_key = self._compute_web_video_variant_key(
            raw_path, is_local=is_local, audio_index=audio_index, source_signature=source_signature,
        )
        variant_path = self._web_video_variant_dir / f"{variant_key}.mp4"
        if variant_path.exists() and variant_path.stat().st_size > 0:
            return variant_path, served_filename, variant_key

        return None, served_filename, variant_key

    def _ensure_web_video_variant_background(
        self,
        raw_path: str,
        *,
        is_local: bool,
        audio_index: int,
        file_meta: dict | None = None,
        file_path: Path | None = None,
        variant_key: str | None = None,
    ) -> None:
        """Fire-and-forget: build the stable web video variant in background.
        If a build for this variant_key is already running, this is a no-op.
        """
        if not variant_key:
            return

        if variant_key in self._web_video_variant_build_tasks:
            existing_task = self._web_video_variant_build_tasks[variant_key]
            if not existing_task.done():
                logger.info("🎬 Web video variant build already in progress: %s (%s)", variant_key[:12], raw_path)
                return

        async def _background_build():
            try:
                logger.info("🎬 Starting background web video variant build: %s (%s, audio=%s)", variant_key[:12], raw_path, audio_index)
                result_path, _ = await self._get_or_create_stable_web_video_variant(
                    raw_path,
                    is_local=is_local,
                    audio_index=audio_index,
                    file_meta=file_meta,
                    file_path=file_path,
                )
                if result_path:
                    logger.info("✅ Background web video variant ready: %s (%s) → next play will be instant", variant_key[:12], raw_path)
                else:
                    logger.warning("⚠️ Background web video variant build returned None: %s (%s)", variant_key[:12], raw_path)
            except asyncio.CancelledError:
                logger.info("🎬 Background web video variant build cancelled: %s", variant_key[:12])
            except Exception as exc:
                logger.warning("⚠️ Background web video variant build failed: %s (%s): %s", variant_key[:12], raw_path, exc)
            finally:
                self._web_video_variant_build_tasks.pop(variant_key, None)

        task = asyncio.create_task(_background_build())
        self._web_video_variant_build_tasks[variant_key] = task

    async def _serve_stable_web_video_variant(
        self,
        request,
        raw_path: str,
        *,
        is_local: bool,
        audio_index: int,
        file_meta: dict | None = None,
        file_path: Path | None = None,
    ):
        # FAST PATH: only check if the variant already exists on disk.
        # If it does NOT exist, kick off a background build and return None
        # so the caller falls through to pipe fMP4 for immediate playback.
        variant_path, filename, variant_key = self._get_existing_web_video_variant(
            raw_path,
            is_local=is_local,
            audio_index=audio_index,
            file_meta=file_meta,
            file_path=file_path,
        )

        if not variant_path:
            # Variant not ready — start building in background and return None
            # so the /stream handler falls through to pipe fMP4 (instant playback).
            if variant_key:
                self._ensure_web_video_variant_background(
                    raw_path,
                    is_local=is_local,
                    audio_index=audio_index,
                    file_meta=file_meta,
                    file_path=file_path,
                    variant_key=variant_key,
                )
                logger.info("🎬 Web video variant not cached, falling back to pipe fMP4 (background build started): %s", raw_path)
            return None

        logger.info("🎬 Serving pre-built web video variant (seekable, range-enabled): %s", raw_path)
        extra_headers = {"X-TCloud-Delivery": "variant"}
        duration = None
        if file_meta and "meta" in file_meta:
            duration = file_meta["meta"].get("duration")
        if duration:
            extra_headers["X-Content-Duration"] = str(duration)

        return await self._serve_file_path_with_range(
            request,
            variant_path,
            filename=filename or variant_path.name,
            content_type="video/mp4",
            extra_headers=extra_headers,
        )

    async def _serve_stable_audio_variant(
        self,
        request,
        raw_path: str,
        *,
        is_local: bool,
        audio_index: int,
        file_meta: dict | None = None,
        file_path: Path | None = None,
        audio_only: bool = False,
    ):
        try:
            variant_path, filename = await self._get_or_create_stable_audio_variant(
                raw_path,
                is_local=is_local,
                audio_index=audio_index,
                file_meta=file_meta,
                file_path=file_path,
                audio_only=audio_only,
            )
        except Exception as exc:
            logger.warning(
                "Stable audio variant unavailable for %s (audio=%s, audio_only=%s): %s",
                raw_path,
                audio_index,
                audio_only,
                exc,
                exc_info=True,
            )
            return None
        if not variant_path:
            return None

        extra_headers = {}
        content_type = None
        if audio_only:
            content_type = "audio/webm" if variant_path.suffix.lower() == ".webm" else "audio/mp4"
        duration = None
        if file_meta and "meta" in file_meta:
            duration = file_meta["meta"].get("duration")
        if duration:
            extra_headers["X-Content-Duration"] = str(duration)

        return await self._serve_file_path_with_range(
            request,
            variant_path,
            filename=filename or variant_path.name,
            content_type=content_type,
            extra_headers=extra_headers,
        )

    def _schedule_audio_variant_prewarm(
        self,
        raw_path: str,
        *,
        is_local: bool,
        audio_tracks: list[dict],
        file_meta: dict | None = None,
    ) -> None:
        filename = file_meta["filename"] if file_meta else Path(raw_path).name
        suffix = Path(filename).suffix.lower()
        if suffix not in STABLE_AUDIO_VARIANT_EXTENSIONS:
            return
        if not is_local:
            if not file_meta:
                return
            chunks = file_meta.get("chunks", [])
            if not self._file_manager._cache.is_fully_cached(raw_path, chunks):
                return

        for track in audio_tracks:
            track_index = track.get("index")
            if not isinstance(track_index, int) or track_index <= 0:
                continue

            task_key = f"{raw_path}|{1 if is_local else 0}|{track_index}"
            existing = self._audio_variant_prewarm_tasks.get(task_key)
            if existing and not existing.done():
                continue

            async def _runner(prewarm_key=task_key, index=track_index):
                try:
                    await self._get_or_create_stable_audio_variant(
                        raw_path,
                        is_local=is_local,
                        audio_index=index,
                        file_meta=file_meta,
                        audio_only=True,
                    )
                except Exception as exc:
                    logger.warning(
                        "Stable audio variant prewarm failed for %s (audio=%s): %s",
                        raw_path,
                        index,
                        exc,
                    )
                finally:
                    self._audio_variant_prewarm_tasks.pop(prewarm_key, None)

            self._audio_variant_prewarm_tasks[task_key] = asyncio.create_task(_runner())

    def _resolve_local_stream_path(self, raw_path: str) -> Path | None:
        file_path = Path(raw_path)
        if file_path.exists():
            return file_path
        if raw_path.startswith("/") and len(raw_path) > 1:
            fallback = Path(raw_path[1:])
            if fallback.exists():
                return fallback
        return None

    async def _get_web_download_source(self, raw_path: str, is_local: bool) -> dict | None:
        if is_local:
            file_path = self._resolve_local_stream_path(raw_path)
            if not file_path or not file_path.is_file():
                return None
            stat = file_path.stat()
            return {
                "path": raw_path,
                "is_local": True,
                "filename": file_path.name,
                "size": stat.st_size,
                "content_type": mimetypes.guess_type(file_path.name)[0] or "application/octet-stream",
                "file_path": file_path,
            }

        file_meta = await self._file_manager.get_file_meta(raw_path)
        if not file_meta:
            return None
        filename = file_meta["filename"]
        return {
            "path": raw_path,
            "is_local": False,
            "filename": filename,
            "size": file_meta["size"],
            "content_type": mimetypes.guess_type(filename)[0] or "application/octet-stream",
            "file_meta": file_meta,
        }

    def _build_web_download_parts(self, total_size: int, requested_workers: int | None) -> list[dict]:
        if total_size <= 0:
            return []

        max_workers = max(1, min(int(requested_workers or 4), 8))
        min_part_size = 8 * 1024 * 1024
        part_count = max(1, min(max_workers, math.ceil(total_size / min_part_size)))
        part_size = math.ceil(total_size / part_count)
        parts = []

        for index in range(part_count):
            start = index * part_size
            end = min(total_size - 1, ((index + 1) * part_size) - 1)
            if start > end:
                break
            parts.append({
                "index": index,
                "start": start,
                "end": end,
                "written": 0,
                "status": "pending",
            })

        return parts

    def _normalize_web_download_parts(self, parts: list[dict], total_size: int) -> list[dict]:
        normalized = []
        for raw_part in parts or []:
            try:
                index = int(raw_part.get("index", len(normalized)))
                start = max(0, int(raw_part.get("start", 0)))
                end = min(total_size - 1, int(raw_part.get("end", total_size - 1)))
                written = max(0, int(raw_part.get("written", 0)))
            except (TypeError, ValueError):
                continue

            if total_size > 0 and start > end:
                continue

            expected_length = max(0, end - start + 1)
            normalized.append({
                "index": index,
                "start": start,
                "end": end,
                "written": min(written, expected_length),
                "status": raw_part.get("status") or "pending",
            })

        return normalized

    def _serialize_web_download_job(self, job: dict) -> dict:
        total_bytes = max(0, int(job.get("size", 0) or 0))
        bytes_written = max(0, min(int(job.get("bytes_written", 0) or 0), total_bytes or int(job.get("bytes_written", 0) or 0)))
        status = job.get("status") or "queued"
        export_ready = status in {"ready_to_export", "completed"}
        query = "?local=true&download=true" if job.get("is_local") else "?download=true"
        percent = 0.0 if total_bytes <= 0 else round((bytes_written / total_bytes) * 100, 2)
        return {
            "id": job["id"],
            "path": job["path"],
            "filename": job["filename"],
            "size": total_bytes,
            "total_bytes": total_bytes,
            "bytes_written": bytes_written,
            "percent": percent,
            "status": status,
            "error": job.get("error"),
            "parts": self._normalize_web_download_parts(job.get("parts", []), total_bytes),
            "parallel_workers": job.get("parallel_workers", 1),
            "is_local": bool(job.get("is_local")),
            "created_at": job.get("created_at"),
            "updated_at": job.get("updated_at"),
            "export_ready": export_ready,
            "export_url": f"/stream{quote(job['path'], safe='/')}{query}",
        }

    async def _stream_web_download_range(self, request, job: dict, start: int, end: int):
        total_size = int(job["size"])
        content_length = end - start + 1
        safe_filename = job["filename"].replace('"', '\\"')
        headers = {
            "Content-Type": job.get("content_type") or "application/octet-stream",
            "Content-Length": str(content_length),
            "Content-Disposition": f'inline; filename="{safe_filename}"',
            "Cache-Control": "no-cache",
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{total_size}",
        }
        response = web.StreamResponse(status=206, headers=headers)
        await response.prepare(request)

        if job.get("is_local"):
            file_path = self._resolve_local_stream_path(job["path"])
            if not file_path:
                raise FileNotFoundError(job["path"])
            with open(file_path, "rb") as handle:
                handle.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = handle.read(min(262144, remaining))
                    if not chunk:
                        break
                    await response.write(chunk)
                    remaining -= len(chunk)
        else:
            async for data in self._file_manager.stream_file_range_direct(job["path"], start, end):
                await response.write(data)

        await response.write_eof()
        return response

    def _update_web_download_job_from_payload(self, job: dict, payload: dict) -> None:
        total_bytes = int(job.get("size", 0) or 0)
        if "parts" in payload:
            job["parts"] = self._normalize_web_download_parts(payload.get("parts") or [], total_bytes)
        if "bytes_written" in payload:
            try:
                bytes_written = int(payload.get("bytes_written", 0) or 0)
            except (TypeError, ValueError):
                bytes_written = job.get("bytes_written", 0) or 0
            job["bytes_written"] = max(0, min(bytes_written, total_bytes or bytes_written))

        requested_status = payload.get("status")
        if requested_status == "ready_to_export" or (
            total_bytes > 0 and int(job.get("bytes_written", 0) or 0) >= total_bytes
        ):
            job["status"] = "ready_to_export"
            job["bytes_written"] = total_bytes
            for part in job.get("parts", []):
                part["written"] = max(0, part["end"] - part["start"] + 1)
                part["status"] = "done"
            job["error"] = None
        elif requested_status in {"queued", "downloading", "paused", "error", "canceled", "server_downloading"}:
            job["status"] = requested_status
            if requested_status != "error":
                job["error"] = None

        if requested_status == "error":
            job["error"] = payload.get("error") or job.get("error") or "Falha no download"
        elif payload.get("error"):
            job["error"] = payload.get("error")

        job["updated_at"] = datetime.utcnow().isoformat() + "Z"

    async def _handle_api_web_downloads(self, request):
        jobs = [self._serialize_web_download_job(job) for job in self._web_download_jobs.values()]
        jobs.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
        return web.json_response({"jobs": jobs})

    async def _handle_api_web_download_create(self, request):
        try:
            data = await request.json()
        except Exception:
            data = {}

        raw_path = data.get("path")
        is_local = data.get("is_local") is True or data.get("local") is True
        parallel_workers = data.get("parallel_workers") or 4
        if not raw_path:
            return web.json_response({"error": "Caminho ausente"}, status=400)

        source = await self._get_web_download_source(raw_path, is_local)
        if not source:
            return web.json_response({"error": "Arquivo não encontrado"}, status=404)

        async with self._web_download_lock:
            for job in self._web_download_jobs.values():
                if job.get("path") == raw_path and bool(job.get("is_local")) == bool(is_local):
                    if job.get("status") != "canceled":
                        return web.json_response({"job": self._serialize_web_download_job(job)})

            created_at = datetime.utcnow().isoformat() + "Z"
            parts = self._build_web_download_parts(source["size"], parallel_workers)
            initial_status = "ready_to_export" if source["size"] == 0 else "queued"
            job = {
                "id": uuid.uuid4().hex,
                "path": raw_path,
                "is_local": bool(is_local),
                "filename": source["filename"],
                "size": int(source["size"]),
                "content_type": source["content_type"],
                "parallel_workers": max(1, min(int(parallel_workers), 8)),
                "bytes_written": int(source["size"]) if source["size"] == 0 else 0,
                "parts": parts,
                "status": initial_status,
                "error": None,
                "created_at": created_at,
                "updated_at": created_at,
            }
            self._web_download_jobs[job["id"]] = job

        return web.json_response({"job": self._serialize_web_download_job(job)}, status=201)

    async def _handle_api_web_download_progress(self, request):
        job_id = request.match_info["job_id"]
        job = self._web_download_jobs.get(job_id)
        if not job:
            return web.json_response({"error": "Download não encontrado"}, status=404)

        try:
            payload = await request.json()
        except Exception:
            payload = {}

        async with self._web_download_lock:
            self._update_web_download_job_from_payload(job, payload)
            serialized = self._serialize_web_download_job(job)
        return web.json_response({"job": serialized})

    async def _handle_api_web_download_pause(self, request):
        job_id = request.match_info["job_id"]
        job = self._web_download_jobs.get(job_id)
        if not job:
            return web.json_response({"error": "Download não encontrado"}, status=404)

        async with self._web_download_lock:
            if job.get("status") not in {"ready_to_export", "completed"}:
                job["status"] = "paused"
                job["updated_at"] = datetime.utcnow().isoformat() + "Z"
            serialized = self._serialize_web_download_job(job)
        return web.json_response({"job": serialized})

    async def _handle_api_web_download_resume(self, request):
        job_id = request.match_info["job_id"]
        job = self._web_download_jobs.get(job_id)
        if not job:
            return web.json_response({"error": "Download não encontrado"}, status=404)

        async with self._web_download_lock:
            if job.get("status") not in {"ready_to_export", "completed"}:
                job["status"] = "downloading"
                job["error"] = None
                job["updated_at"] = datetime.utcnow().isoformat() + "Z"
            serialized = self._serialize_web_download_job(job)
        return web.json_response({"job": serialized})

    async def _handle_api_web_download_restart(self, request):
        job_id = request.match_info["job_id"]
        job = self._web_download_jobs.get(job_id)
        if not job:
            return web.json_response({"error": "Download não encontrado"}, status=404)

        async with self._web_download_lock:
            job["bytes_written"] = 0
            job["status"] = "queued"
            job["error"] = None
            job["parts"] = self._build_web_download_parts(int(job.get("size", 0) or 0), int(job.get("parallel_workers", 1) or 1))
            job["updated_at"] = datetime.utcnow().isoformat() + "Z"
            serialized = self._serialize_web_download_job(job)
        return web.json_response({"job": serialized})

    async def _handle_api_web_download_cancel(self, request):
        job_id = request.match_info["job_id"]
        async with self._web_download_lock:
            job = self._web_download_jobs.pop(job_id, None)
        if not job:
            return web.json_response({"error": "Download não encontrado"}, status=404)
        return web.json_response({"status": "ok"})

    async def _handle_api_web_download_part(self, request):
        job_id = request.match_info["job_id"]
        job = self._web_download_jobs.get(job_id)
        if not job:
            return web.json_response({"error": "Download não encontrado"}, status=404)

        try:
            start = int(request.query.get("start", "0"))
            end = int(request.query.get("end", str(int(job["size"]) - 1)))
        except ValueError:
            return web.json_response({"error": "Range inválido"}, status=400)

        total_size = int(job["size"])
        if total_size <= 0:
            return web.Response(body=b"", status=200)
        if start < 0 or end < start or start >= total_size:
            return web.json_response({"error": "Range inválido"}, status=416)

        end = min(end, total_size - 1)

        try:
            return await self._stream_web_download_range(request, job, start, end)
        except FileNotFoundError:
            return web.json_response({"error": "Arquivo não encontrado"}, status=404)
        except Exception as exc:
            logger.error(f"Web download part error for {job['path']}: {exc}")
            return web.json_response({"error": "Falha ao servir parte do download"}, status=500)

    async def _serve_cloud_stream_request(self, request, raw_path: str, *, is_download: bool = False):
        audio_track = request.query.get("audio", "0")
        audio_only_requested = request.query.get("audio_only") == "true"
        audio_selection_requested = audio_track != "0"
        try:
            audio_track_index = int(audio_track)
        except ValueError:
            audio_track_index = 0

        try:
            file_meta = await self._file_manager.get_file_meta(raw_path)
        except Exception as exc:
            logger.error(f"Error getting file meta: {exc}")
            return web.Response(text="Internal error", status=500)

        if not file_meta:
            return web.Response(text="File not found", status=404)

        total_size = file_meta["size"]
        filename = file_meta["filename"]
        suffix = Path(filename).suffix.lower()
        use_prepared_web_video_variant = (
            self._web_video_transcode_mode == "prepared_mp4_variant"
            and suffix in PREPARED_WEB_VIDEO_EXTENSIONS
            and not audio_only_requested
        )
        use_stable_audio_variant = audio_only_requested and suffix in STABLE_AUDIO_VARIANT_EXTENSIONS
        transcode_required = (
            filename.lower().endswith((".mkv", ".avi", ".flv", ".wmv"))
            or ((audio_selection_requested or audio_only_requested) and suffix not in STABLE_AUDIO_VARIANT_EXTENSIONS)
        )

        is_direct_stream = filename.lower().endswith(
            (".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp", ".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".wma", ".mp4", ".webm")
        ) or Path(filename).suffix.lower() in SUBTITLE_EXTENSIONS
        is_video = filename.lower().endswith((".mp4", ".webm"))
        is_internal_probe = request.query.get("internal_probe") == "true"
        is_raw_internal_probe = is_internal_probe and request.query.get("probe_mode", "").strip().lower() == "raw"

        if is_video and not is_internal_probe:
            try:
                asyncio.create_task(self._file_manager.cache_file(raw_path))
            except Exception:
                pass

        if is_raw_internal_probe:
            logger.info("🎬 Serving raw internal probe stream for %s", raw_path)
            use_prepared_web_video_variant = False
            use_stable_audio_variant = False
            transcode_required = False
            is_direct_stream = True

        if use_prepared_web_video_variant:
            logger.info(f"🎬 video switch path: prepared-web-variant ({raw_path}, audio={audio_track_index})")
            prepared_response = await self._serve_stable_web_video_variant(
                request,
                raw_path,
                is_local=False,
                audio_index=audio_track_index,
                file_meta=file_meta,
            )
            if prepared_response is not None:
                return prepared_response
            logger.warning(f"Prepared web video variant unavailable for cloud file, falling back to legacy transcode: {raw_path}")

        if use_stable_audio_variant:
            logger.info(f"🎧 audio switch path: aux-audio-fallback ({raw_path}, audio={audio_track_index})")
            stable_response = await self._serve_stable_audio_variant(
                request,
                raw_path,
                is_local=False,
                audio_index=audio_track_index,
                file_meta=file_meta,
                audio_only=True,
            )
            if stable_response is not None:
                return stable_response
            logger.warning(f"Stable audio fallback unavailable for cloud file, falling back to transcode: {raw_path}")
            transcode_required = True

        if transcode_required:
            if audio_selection_requested or audio_only_requested:
                logger.info(f"🎧 audio switch path: transcoded-fallback ({raw_path}, audio={audio_track_index})")
            return await self._stream_transcoded_file(
                request,
                raw_path,
                is_local=False,
                file_meta=file_meta,
                force_audio_only=audio_only_requested,
            )

        content_type = _subtitle_stream_content_type(filename)
        if not content_type:
            content_type, _ = mimetypes.guess_type(filename)
        if not content_type:
            content_type = "application/octet-stream"

        etag = f'"{self._generate_etag(file_meta)}"'
        if_none_match = request.headers.get("If-None-Match")
        if if_none_match and if_none_match == etag:
            return web.Response(status=304)

        range_header = request.headers.get("Range")
        start = 0
        end = total_size - 1
        if range_header:
            if_range = request.headers.get("If-Range")
            if if_range and if_range != etag:
                range_header = None
            else:
                try:
                    range_spec = range_header.replace("bytes=", "")
                    parts = range_spec.split("-")
                    if parts[0]:
                        start = int(parts[0])
                    if parts[1]:
                        end = int(parts[1])
                    end = min(end, total_size - 1)
                except (ValueError, IndexError):
                    return web.Response(text="Invalid Range", status=416)

                if start > end or start >= total_size:
                    return web.Response(
                        text="Range Not Satisfiable",
                        status=416,
                        headers={"Content-Range": f"bytes */{total_size}"},
                    )

        content_length = end - start + 1
        safe_filename = os.path.basename(raw_path).replace('"', '\\"')
        disposition = "attachment" if is_download else "inline"
        headers = {
            "Content-Type": f"{content_type}; charset=utf-8" if Path(filename).suffix.lower() in SUBTITLE_EXTENSIONS else content_type,
            "Content-Length": str(content_length),
            "Content-Disposition": f'{disposition}; filename="{safe_filename}"',
            "Access-Control-Allow-Origin": "*",
            "ETag": etag,
            "Cache-Control": "no-cache",
            "Accept-Ranges": "bytes",
        }

        status = 200
        if range_header:
            headers["Content-Range"] = f"bytes {start}-{end}/{total_size}"
            status = 206

        cached_path = self._file_manager.get_cached_file_path(file_meta, raw_path)
        if cached_path:
            logger.info(f"⚡ Serving from cache: {raw_path}")
            response = web.StreamResponse(status=status, headers=headers)
            await response.prepare(request)
            with open(cached_path, "rb") as handle:
                handle.seek(start)
                bytes_remaining = content_length
                while bytes_remaining > 0:
                    data = handle.read(min(262144, bytes_remaining))
                    if not data:
                        break
                    await response.write(data)
                    bytes_remaining -= len(data)
            await response.write_eof()
            return response

        response = web.StreamResponse(status=status, headers=headers)
        await response.prepare(request)
        try:
            t_stream = time.time()
            first_chunk = True
            if is_direct_stream:
                async for data in self._file_manager.stream_file_range_direct(raw_path, start, end):
                    if first_chunk:
                        logger.info(f"⏱️ TTFB (direct stream) for {raw_path} took {time.time() - t_stream:.3f}s")
                        first_chunk = False
                    await response.write(data)
            else:
                async for data in self._file_manager.stream_file_range(raw_path, start, end):
                    if first_chunk:
                        logger.info(f"⏱️ TTFB (cache stream) for {raw_path} took {time.time() - t_stream:.3f}s")
                        first_chunk = False
                    await response.write(data)
        except ConnectionResetError:
            logger.debug(f"Client disconnected during stream: {raw_path}")
        except Exception as exc:
            logger.error(f"Stream error for {raw_path}: {exc}")

        await response.write_eof()

        if is_download:
            try:
                await self._file_manager.evict_file_cache(raw_path)
            except Exception as exc:
                logger.warning(f"Cache eviction after download failed: {exc}")

        return response

    async def _handle_shared_stream(self, request):
        public_id = str(request.match_info.get("public_id") or "").strip()
        relative_path = str(request.match_info.get("path") or "").strip()
        is_download = request.query.get("download") == "true"

        try:
            _, target_kind, target_doc = await self._resolve_public_share_session(request, public_id)
            root_path = str(target_doc.get("path") or "").strip()

            if target_kind == "file":
                if relative_path:
                    return web.Response(text="Arquivo compartilhado não encontrado", status=404)
                target_path = root_path
                file_meta = await self._file_manager.get_file_meta(target_path)
                if not file_meta:
                    return web.Response(text="Arquivo compartilhado não encontrado", status=404)
                if (file_meta.get("meta") or {}).get("hidden_system_file"):
                    return web.Response(text="Arquivo compartilhado não encontrado", status=404)
            else:
                target_path = await self._file_manager.resolve_public_share_path(
                    root_path,
                    relative_path,
                    expect_directory=None,
                    enforce_visibility=True,
                )
                entry_kind, entry_doc = await self._file_manager._db.get_entry(target_path)
                if entry_kind != "file" or not entry_doc:
                    return web.Response(text="Arquivo compartilhado não encontrado", status=404)
                if (entry_doc.get("meta") or {}).get("hidden_system_file"):
                    return web.Response(text="Arquivo compartilhado não encontrado", status=404)

            return await self._serve_cloud_stream_request(
                request,
                target_path,
                is_download=is_download,
            )
        except PublicShareError as exc:
            return web.Response(text=exc.message, status=exc.status)
        except web.HTTPException as exc:
            try:
                payload = json.loads(exc.text or "{}")
                message = payload.get("error") or exc.reason or "Link público indisponível"
            except Exception:
                message = exc.reason or "Link público indisponível"
            return web.Response(text=message, status=exc.status)
        except Exception as exc:
            logger.error("Error streaming public share %s: %s", public_id, exc, exc_info=True)
            return web.Response(text="Falha ao servir o compartilhamento público", status=500)

    async def _handle_stream(self, request):
        # Stream a file with HTTP Range support, ETag, and cache acceleration
        raw_path = "/" + unquote(request.match_info["path"])
        is_local = request.query.get("local") == "true"
        is_download = request.query.get("download") == "true"
        audio_track = request.query.get("audio", "0")
        audio_only_requested = request.query.get("audio_only") == "true"
        audio_selection_requested = audio_track != "0"
        try:
            audio_track_index = int(audio_track)
        except ValueError:
            audio_track_index = 0
        
        logger.info(f"🎬 Stream request: {raw_path} (Local: {is_local}, Download: {is_download}, AudioTrack: {audio_track})")
        
        if is_local:
             # Handle local file streaming
             try:
                 # Remove leading slash if it's there but path is absolute on *nix, 
                 # BUT url path param might mess up. 
                 # raw_path comes from {path:.*}. 
                 # If request is /stream/Users/name/file, raw_path is /Users/name/file
                 # This is correct for specific absolute paths.
                 
                 # Verify existence
                 file_path = self._resolve_local_stream_path(raw_path)
                 
                 if not file_path:
                     return web.Response(text="Local file not found", status=404)
                 
                 # Basic stats
                 stat = file_path.stat()
                 total_size = stat.st_size
                 filename = file_path.name
                 suffix = Path(filename).suffix.lower()
                 use_prepared_web_video_variant = (
                     self._web_video_transcode_mode == "prepared_mp4_variant"
                     and suffix in PREPARED_WEB_VIDEO_EXTENSIONS
                     and not audio_only_requested
                 )
                 use_stable_audio_variant = audio_only_requested and suffix in STABLE_AUDIO_VARIANT_EXTENSIONS
                 transcode_required = (
                     filename.lower().endswith(('.mkv', '.avi', '.flv', '.wmv'))
                     or ((audio_selection_requested or audio_only_requested) and suffix not in STABLE_AUDIO_VARIANT_EXTENSIONS)
                 )

                 if use_prepared_web_video_variant:
                     logger.info(f"🎬 video switch path: prepared-web-variant ({raw_path}, audio={audio_track_index})")
                     prepared_response = await self._serve_stable_web_video_variant(
                         request,
                         raw_path,
                         is_local=True,
                         audio_index=audio_track_index,
                         file_path=file_path,
                     )
                     if prepared_response is not None:
                         return prepared_response
                     logger.warning(f"Prepared web video variant unavailable for local file, falling back to legacy transcode: {raw_path}")

                 if use_stable_audio_variant:
                     logger.info(f"🎧 audio switch path: aux-audio-fallback ({raw_path}, audio={audio_track_index})")
                     stable_response = await self._serve_stable_audio_variant(
                         request,
                         raw_path,
                         is_local=True,
                         audio_index=audio_track_index,
                         file_path=file_path,
                         audio_only=True,
                     )
                     if stable_response is not None:
                         return stable_response
                     logger.warning(f"Stable audio fallback unavailable for local file, falling back to transcode: {raw_path}")
                     transcode_required = True

                 if filename.lower().endswith(('.mp4', '.mp3', '.m4a', '.wav', '.webm')) and not transcode_required:
                     # Serve native formats directly from disk (fast, supports Range)
                     pass
                 elif Path(filename).suffix.lower() in SUBTITLE_EXTENSIONS and not transcode_required:
                     pass
                 else:
                     if audio_selection_requested or audio_only_requested:
                         logger.info(f"🎧 audio switch path: transcoded-fallback ({raw_path}, audio={audio_track_index})")
                     return await self._stream_transcoded_file(request, raw_path, is_local=True, file_path=file_path, force_audio_only=audio_only_requested)
                 
                 return await self._serve_file_path_with_range(request, file_path, filename=filename)
                 
             except Exception as e:
                 logger.error(f"Local stream error: {e}")
                 return web.Response(status=500)

        return await self._serve_cloud_stream_request(
            request,
            raw_path,
            is_download=is_download,
        )

    async def _handle_api_favorite(self, request):
        try:
            data = await request.json()
            path = data.get("path")
            is_favorite = data.get("favorite", False)
            if not path:
                return web.json_response({"status": "error", "message": "Caminho ausente"}, status=400)
            
            await self._file_manager.set_favorite(path, is_favorite)
            return web.json_response({"status": "ok"})
        except Exception as e:
            logger.error(f"Error setting favorite: {e}")
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    async def _handle_api_favorites(self, request):
        try:
            items = await self._file_manager.get_favorites()
            result = []
            for item in items:
                serialized_item = await self._serialize_browser_item(request, {
                    **item,
                    "is_favorite": True,
                })
                result.append(serialized_item)
            return web.json_response({"items": result})
        except Exception as e:
            logger.error(f"Error listing favorites: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_recents(self, request):
        try:
            items = await self._file_manager.get_recents()
            result = []
            for item in items:
                serialized_item = await self._serialize_browser_item(request, {
                    **item,
                    "is_directory": False,
                })
                result.append(serialized_item)
            return web.json_response({"items": result})
        except Exception as e:
            logger.error(f"Error listing recents: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_cache_status(self, request):
        """Get caching progress for a file."""
        path = request.query.get("path")
        if not path:
            return web.json_response({"error": "Caminho ausente"}, status=400)
        try:
            status = await self._file_manager.get_cache_status(path)
            if status is None:
                return web.json_response({"error": "File not found"}, status=404)
            return web.json_response(status)
        except Exception as e:
            logger.error(f"Cache status error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_download(self, request):
        """Trigger background caching of a file for download."""
        try:
            data = await request.json()
            path = data.get("path")
            if not path:
                return web.json_response({"error": "Caminho ausente"}, status=400)

            status = await self._file_manager.cache_file(path)
            return web.json_response({
                "status": "ok",
                "cache": status,
                "download_url": f"/stream{path}",
            })
        except FileNotFoundError:
            return web.json_response({"error": "File not found"}, status=404)
        except Exception as e:
            logger.error(f"Download trigger error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_make_offline(self, request):
        try:
            data = await request.json()
            path = data.get("path")
            logger.info(f"API make_offline received request for path: {path}")
            if not path:
                return web.json_response({"error": "Caminho ausente"}, status=400)

            logger.info(f"Triggering set_offline for {path}")
            await self._file_manager.set_offline(path, True)
            
            status = await self._file_manager.get_cache_status(path)
            logger.info(f"Cache status after trigger: {status}")
            return web.json_response({
                "status": "ok",
                "message": f"File is now available offline: {path}",
                "cache": status,
            })
        except FileNotFoundError:
            return web.json_response({"error": "File not found"}, status=404)
        except Exception as e:
            logger.error(f"Make offline error: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_apps(self, request):
        """Return list of installed apps."""
        try:
            apps = self._app_manager.get_apps(include_disabled=False, include_details=False)
            return web.json_response(
                {
                    "apps": apps,
                    "default_app_id": self._app_manager.get_default_app_id(),
                    "featured_app_ids": [app["id"] for app in apps if app.get("featured")],
                    "schema_version": 3,
                }
            )
        except Exception as e:
            logger.error(f"Error listing apps: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def _handle_api_apps_admin(self, request):
        try:
            return web.json_response(self._app_manager.get_admin_payload())
        except Exception as exc:
            logger.error(f"Error loading apps admin payload: {exc}", exc_info=True)
            return web.json_response({"error": str(exc)}, status=500)

    async def _handle_api_app_detail(self, request):
        app_id = str(request.match_info.get("app_id") or "").strip()
        app = self._app_manager.get_app(app_id, include_details=True)
        if not app:
            return web.json_response({"error": "app nao encontrado"}, status=404)
        return web.json_response({"app": app, "audit": self._app_manager.get_audit_payload(app_id)})

    async def _handle_api_apps_install_zip(self, request):
        try:
            filename = "upload.zip"
            archive_bytes = b""

            if (request.content_type or "").startswith("multipart/"):
                reader = await request.multipart()
                part = await reader.next()
                while part is not None:
                    if part.filename:
                        filename = part.filename
                        archive_bytes = await part.read(decode=False)
                        break
                    part = await reader.next()
            else:
                archive_bytes = await request.read()

            result = self._app_install_service.install_zip_bytes(archive_bytes, filename=filename)
            self._app_manager.reload()
            append_audit_event(Config.RUNTIME_DIR, "install_succeeded", app_id=result["app_id"], details={"source": "zip"})
            return web.json_response(
                {
                    **result,
                    "apps": self._app_manager.get_apps(include_disabled=True, include_details=True),
                }
            )
        except AppInstallError as exc:
            append_audit_event(Config.RUNTIME_DIR, "install_failed", details={"source": "zip", "error": str(exc)})
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.error(f"ZIP install failed: {exc}", exc_info=True)
            append_audit_event(Config.RUNTIME_DIR, "install_failed", details={"source": "zip", "error": str(exc)})
            return web.json_response({"error": str(exc)}, status=500)

    async def _handle_api_apps_install_github(self, request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "JSON invalido"}, status=400)

        url = str(data.get("url") or "").strip()
        ref = str(data.get("ref") or "").strip()
        subdir = str(data.get("subdir") or "").strip()
        if not url:
            return web.json_response({"error": "url ausente"}, status=400)

        try:
            result = self._app_install_service.install_github_url(url, ref=ref, subdir=subdir)
            self._app_manager.reload()
            append_audit_event(Config.RUNTIME_DIR, "install_succeeded", app_id=result["app_id"], details={"source": "github", "url": url})
            return web.json_response(
                {
                    **result,
                    "apps": self._app_manager.get_apps(include_disabled=True, include_details=True),
                }
            )
        except AppInstallError as exc:
            append_audit_event(Config.RUNTIME_DIR, "install_failed", details={"source": "github", "url": url, "error": str(exc)})
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.error(f"GitHub install failed: {exc}", exc_info=True)
            append_audit_event(Config.RUNTIME_DIR, "install_failed", details={"source": "github", "url": url, "error": str(exc)})
            return web.json_response({"error": str(exc)}, status=500)

    async def _handle_api_apps_enable(self, request):
        return await self._handle_api_apps_set_enabled(request, True)

    async def _handle_api_apps_disable(self, request):
        return await self._handle_api_apps_set_enabled(request, False)

    async def _handle_api_apps_set_enabled(self, request, enabled: bool):
        app_id = str(request.match_info.get("app_id") or "").strip()
        try:
            app = self._app_manager.set_enabled(app_id, enabled)
            append_audit_event(Config.RUNTIME_DIR, "app_enabled" if enabled else "app_disabled", app_id=app_id)
            return web.json_response({"ok": True, "app": app})
        except KeyError as exc:
            return web.json_response({"error": exc.args[0]}, status=404)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.error(f"Error changing app state for {app_id}: {exc}", exc_info=True)
            return web.json_response({"error": str(exc)}, status=500)

    async def _handle_api_apps_uninstall(self, request):
        app_id = str(request.match_info.get("app_id") or "").strip()
        app = self._app_manager.get_app(app_id, include_details=True)
        if not app:
            return web.json_response({"error": "app nao encontrado"}, status=404)

        try:
            result = self._app_install_service.uninstall_app(app_id, protected=bool(app.get("protected")))
            self._app_manager.reload()
            return web.json_response(
                {
                    **result,
                    "apps": self._app_manager.get_apps(include_disabled=True, include_details=True),
                }
            )
        except AppInstallError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.error(f"Error uninstalling app {app_id}: {exc}", exc_info=True)
            return web.json_response({"error": str(exc)}, status=500)

    async def _handle_api_apps_permissions_get(self, request):
        app_id = str(request.match_info.get("app_id") or "").strip()
        try:
            return web.json_response(self._app_manager.get_permissions_payload(app_id))
        except KeyError as exc:
            return web.json_response({"error": exc.args[0]}, status=404)

    async def _handle_api_apps_permissions_patch(self, request):
        app_id = str(request.match_info.get("app_id") or "").strip()
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "JSON invalido"}, status=400)

        try:
            payload = self._app_manager.update_permission_policies(app_id, data.get("policies") or {})
            append_audit_event(Config.RUNTIME_DIR, "permissions_updated", app_id=app_id)
            return web.json_response(payload)
        except KeyError as exc:
            return web.json_response({"error": exc.args[0]}, status=404)
        except Exception as exc:
            logger.error(f"Error updating permissions for {app_id}: {exc}", exc_info=True)
            return web.json_response({"error": str(exc)}, status=500)

    async def _handle_api_apps_audit(self, request):
        app_id = str(request.match_info.get("app_id") or "").strip()
        limit = max(1, min(200, int(request.query.get("limit", "50"))))
        try:
            return web.json_response(self._app_manager.get_audit_payload(app_id, limit=limit))
        except KeyError as exc:
            return web.json_response({"error": exc.args[0]}, status=404)

    def _request_bearer_token(self, request) -> str:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            return auth_header[7:]
        return str(request.query.get("token") or "")

    def _build_external_url(self, request, path: str) -> str:
        relative_path = str(path or "").strip() or "/"
        if not relative_path.startswith("/"):
            relative_path = f"/{relative_path}"
        forwarded_host = str(request.headers.get("X-Forwarded-Host") or "").strip()
        host = forwarded_host or str(request.host or "").strip()
        forwarded_proto = str(request.headers.get("X-Forwarded-Proto") or "").strip()
        scheme = forwarded_proto or str(request.scheme or "http").strip() or "http"
        if not host:
            return relative_path
        return f"{scheme}://{host}{relative_path}"

    def _guess_public_preview_kind(self, mime_type: str | None, is_directory: bool) -> str:
        if is_directory:
            return "folder"
        normalized_mime = str(mime_type or "").strip().lower()
        if normalized_mime.startswith("image/"):
            return "image"
        if normalized_mime.startswith("video/"):
            return "video"
        if normalized_mime.startswith("audio/"):
            return "audio"
        if normalized_mime == "application/pdf":
            return "pdf"
        return "file"

    def _build_public_media_capabilities(
        self,
        name: str,
        mime_type: str | None,
        is_directory: bool,
        meta: dict | None = None,
    ) -> dict:
        suffix = Path(str(name or "")).suffix.lower()
        extension = suffix[1:] if suffix.startswith(".") else suffix
        preview_kind = self._guess_public_preview_kind(mime_type, is_directory)
        normalized_mime = str(mime_type or "").strip().lower()
        playback_kind = "folder" if is_directory else "file"
        can_preview = preview_kind in {"folder", "image", "audio", "video", "pdf"}

        if not is_directory:
            if suffix in PUBLIC_TRANSCODED_VIDEO_EXTENSIONS:
                preview_kind = "video"
                playback_kind = "transcoded_video"
                can_preview = True
            elif suffix in PUBLIC_DIRECT_VIDEO_EXTENSIONS or normalized_mime.startswith("video/"):
                preview_kind = "video"
                playback_kind = "direct_video"
                can_preview = True
            elif suffix in PUBLIC_TRANSCODED_AUDIO_EXTENSIONS:
                preview_kind = "audio"
                playback_kind = "transcoded_audio"
                can_preview = True
            elif suffix in PUBLIC_DIRECT_AUDIO_EXTENSIONS or normalized_mime.startswith("audio/"):
                preview_kind = "audio"
                playback_kind = "direct_audio"
                can_preview = True
            elif preview_kind == "image":
                playback_kind = "image"
            elif preview_kind == "pdf":
                playback_kind = "pdf"

        media_meta = meta if isinstance(meta, dict) else {}
        payload = {
            "preview_kind": preview_kind,
            "extension": extension,
            "playback_kind": playback_kind,
            "can_preview": bool(can_preview),
        }
        for source_key, output_key in (
            ("duration", "duration"),
            ("duration_seconds", "duration"),
            ("video_codec", "video_codec"),
            ("audio_track_count", "audio_track_count"),
            ("subtitle_track_count", "subtitle_track_count"),
        ):
            if source_key in media_meta and output_key not in payload:
                payload[output_key] = media_meta.get(source_key)
        return payload

    def _serialize_owner_sharing_state(self, request, sharing_state: dict | None) -> dict:
        payload = dict(sharing_state or {})
        if payload.get("mode") == "direct":
            public_id = str(payload.get("public_id") or "").strip()
            payload["public_url"] = self._build_external_url(request, f"/s/{quote(public_id, safe='')}" if public_id else "")
        else:
            payload["public_url"] = ""
        return payload

    def _build_public_share_item_payload(
        self,
        request,
        public_id: str,
        target_kind: str,
        target_doc: dict,
        *,
        share_token: str = "",
    ) -> dict:
        is_directory = target_kind == "directory"
        normalized_public_id = str(public_id or "").strip()
        name = (
            target_doc.get("filename")
            or str((target_doc.get("path") or "/").rstrip("/").rsplit("/", 1)[-1] or "Compartilhado")
        )
        raw_path = str(target_doc.get("path") or "").strip()
        meta = dict(target_doc.get("meta") or {})
        mime_type = meta.get("mime_type") or mimetypes.guess_type(name)[0]
        relative_stream = f"/stream/shared/{quote(normalized_public_id, safe='')}"
        stream_suffix = f"?token={quote(share_token, safe='')}" if share_token else ""
        payload = {
            "public_id": normalized_public_id,
            "name": name,
            "is_directory": is_directory,
            "mime_type": mime_type,
            "size": 0 if is_directory else int(target_doc.get("size") or 0),
            "modified_at": _iso_or_none(target_doc.get("modified_at")) or _iso_or_none(target_doc.get("created_at")) or "",
            "stream_url": "" if is_directory else f"{relative_stream}{stream_suffix}",
            "download_url": "" if is_directory else f"{relative_stream}?download=true{('&token=' + quote(share_token, safe='')) if share_token else ''}",
            "relative_path": "",
        }
        payload.update(self._build_public_media_capabilities(name, mime_type, is_directory, meta))
        return payload

    def _build_public_share_summary_payload(self, request, public_id: str, target_kind: str, target_doc: dict) -> dict:
        sharing = dict(target_doc.get("sharing") or {})
        meta = target_doc.get("meta") if isinstance(target_doc.get("meta"), dict) else {}
        name = target_doc.get("filename") or str((target_doc.get("path") or "/").rstrip("/").rsplit("/", 1)[-1] or "Compartilhado")
        mime_type = meta.get("mime_type") or mimetypes.guess_type(name)[0]
        max_access = sharing.get("max_access")
        access_count = int(sharing.get("access_count") or 0)
        access_exhausted = False
        if max_access not in (None, "", False):
            try:
                access_exhausted = access_count >= int(max_access)
            except (TypeError, ValueError):
                access_exhausted = True
        expires_at = sharing.get("expires_at")
        expires_iso = _iso_or_none(expires_at) or ""
        expired = False
        if isinstance(expires_at, datetime):
            normalized_expires = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
            expired = normalized_expires <= datetime.now(timezone.utc)
        payload = {
            "public_id": str(public_id or "").strip(),
            "name": name,
            "kind": target_kind,
            "is_directory": target_kind == "directory",
            "size": 0 if target_kind == "directory" else int(target_doc.get("size") or 0),
            "requires_password": bool(str(sharing.get("password") or "").strip()),
            "expired": expired,
            "expires_at": expires_iso,
            "access_exhausted": access_exhausted,
            "max_access": max_access,
            "access_count": access_count,
            "revoked_or_missing": False,
            "public_url": self._build_external_url(request, f"/s/{quote(str(public_id or '').strip(), safe='')}"),
        }
        payload.update(self._build_public_media_capabilities(name, mime_type, target_kind == "directory", meta))
        return payload

    def _public_share_error_payload(self, public_id: str, *, code: str, message: str, status: int) -> tuple[dict, int]:
        return ({
            "public_id": str(public_id or "").strip(),
            "revoked_or_missing": status == 404,
            "expired": code == "share_expired",
            "access_exhausted": code == "share_access_exhausted",
            "requires_password": False,
            "error": message,
            "code": code,
        }, status)

    def _verify_public_share_request_token(self, request, public_id: str) -> dict:
        token = self._request_bearer_token(request)
        if not token:
            raise web.HTTPUnauthorized(
                text=json.dumps({"error": "Sessão pública necessária", "code": "SHARE_TOKEN_REQUIRED"}),
                content_type="application/json",
            )

        payload = verify_public_share_token(token, Config.JWT_SECRET)
        if not payload:
            raise web.HTTPUnauthorized(
                text=json.dumps({"error": "Sessão pública inválida ou expirada", "code": "SHARE_TOKEN_INVALID"}),
                content_type="application/json",
            )

        token_public_id = str(payload.get("public_id") or "").strip()
        if token_public_id != str(public_id or "").strip():
            raise web.HTTPForbidden(
                text=json.dumps({"error": "Sessão pública incompatível com este link", "code": "SHARE_TOKEN_SCOPE"}),
                content_type="application/json",
            )

        return payload

    async def _resolve_public_share_session(self, request, public_id: str) -> tuple[dict, str, dict]:
        payload = self._verify_public_share_request_token(request, public_id)
        target_kind, target_doc = await self._file_manager.get_shared_target(public_id)
        token_path = str(payload.get("path") or "").strip()
        current_path = str(target_doc.get("path") or "").strip()
        token_is_directory = bool(payload.get("is_directory"))
        current_is_directory = target_kind == "directory"
        if token_path != current_path or token_is_directory != current_is_directory:
            raise web.HTTPGone(
                text=json.dumps({"error": "Este compartilhamento foi alterado ou revogado.", "code": "SHARE_SESSION_STALE"}),
                content_type="application/json",
            )
        sharing = dict(target_doc.get("sharing") or {})
        expires_at = sharing.get("expires_at")
        if isinstance(expires_at, datetime):
            normalized_expires = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
            if normalized_expires <= datetime.now(timezone.utc):
                raise web.HTTPGone(
                    text=json.dumps({"error": "Este link público expirou.", "code": "SHARE_EXPIRED"}),
                    content_type="application/json",
                )
        max_access = sharing.get("max_access")
        if max_access not in (None, "", False):
            try:
                if int(sharing.get("access_count") or 0) > int(max_access):
                    raise web.HTTPGone(
                        text=json.dumps({"error": "Este link público não está mais disponível.", "code": "SHARE_ACCESS_EXHAUSTED"}),
                        content_type="application/json",
                    )
            except (TypeError, ValueError):
                raise web.HTTPGone(
                    text=json.dumps({"error": "Este link público não está mais disponível.", "code": "SHARE_ACCESS_EXHAUSTED"}),
                    content_type="application/json",
                )
        return payload, target_kind, target_doc

    def _parse_public_share_expires_at(self, raw_value) -> datetime | None:
        value = str(raw_value or "").strip()
        if not value:
            return None
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if parsed <= datetime.now(timezone.utc):
            raise ValueError("expires_at must be in the future")
        return parsed

    def _build_status_snapshot(self) -> dict:
        apps = self._app_manager.get_apps()
        cache_usage_bytes = self._measure_directory_bytes(Config.CACHE_DIR)
        db_client = getattr(getattr(self._file_manager, "_db", None), "_client", None)
        telegram_manager = getattr(self._file_manager, "_telegram", None)
        persistence = Config.settings_persistence_status()
        return {
            "app_count": len(apps),
            "default_app_id": self._app_manager.get_default_app_id(),
            "featured_app_ids": [app["id"] for app in apps if app.get("featured")],
            "auth_enabled": bool(Config.AUTH_ENABLED),
            "runtime_dir": str(Config.RUNTIME_DIR),
            "cache_dir": str(Config.CACHE_DIR),
            "store_path": str(Config.runtime_store_path()),
            "apps_registry_path": str(Config.runtime_apps_registry_path()),
            "apps_runtime_dir": str(Config.runtime_apps_dir()),
            "app_audit_path": str(Config.runtime_app_audit_path()),
            "cache_usage_bytes": cache_usage_bytes,
            "mongo_connected": db_client is not None,
            "telegram_connected": bool(telegram_manager and getattr(telegram_manager, "bot_count", 0) > 0),
            "log_level": Config.LOG_LEVEL,
            "sync_enabled": bool(Config.SYNC_ENABLED),
            "sync_dir": str(Config.SYNC_DIR) if Config.SYNC_ENABLED else "",
            "web_video_transcode_mode": self._web_video_transcode_mode,
            "web_subtitle_extract_timeout_seconds": self._web_subtitle_extract_timeout_seconds,
            "archive": self._archive_service.status_payload(),
            "pending_restart_keys": sorted(Config._pending_restart_keys),
            "mutable_keys": sorted(key for key, spec in SETTINGS_SCHEMA.items() if spec.get("mutable")),
            "persistence": persistence,
        }

    def _normalize_file_listing_items(self, items: list[dict]) -> list[dict]:
        result = []
        for item in items:
            chunks = item.get("chunks", [])
            is_cached = False
            if not item.get("is_directory", False) and chunks:
                is_cached = self._file_manager._cache.is_file_cached(item["path"], chunks)
            result.append(
                {
                    "name": item.get("name") or item.get("filename") or str(Path(item.get("path", "")).name),
                    "path": item["path"],
                    "is_directory": bool(item.get("is_directory")),
                    "size": item.get("size", 0),
                    "meta": item.get("meta", {}),
                    "modified_at": item.get("modified_at", "").isoformat()
                    if hasattr(item.get("modified_at", ""), "isoformat")
                    else item.get("modified_at", ""),
                    "is_favorite": item.get("is_favorite", False),
                    "is_offline": item.get("is_offline", False),
                    "is_cached": is_cached,
                    "mime_type": item.get("meta", {}).get("mime_type")
                    or mimetypes.guess_type(item.get("name") or item.get("filename") or "")[0],
                }
            )
        return result

    async def _handle_api_app_runtime_session(self, request):
        app_id = str(request.match_info.get("app_id") or "").strip()
        app = self._app_manager.get_app(app_id, include_details=True)
        if not app:
            return web.json_response({"error": "app nao encontrado"}, status=404)
        if not app.get("enabled", True):
            return web.json_response({"error": "app desabilitado"}, status=403)

        runtime_token = create_app_runtime_token(
            app_id=app["id"],
            install_id=app["install_id"],
            secret=Config.JWT_SECRET,
            allowed_functions=app.get("allowed_functions") or [],
            granted_permissions=app.get("granted_permissions") or [],
            user=request.get("user", "anonymous"),
        )
        return web.json_response(
            {
                "app_id": app["id"],
                "install_id": app["install_id"],
                "runtime_token": runtime_token,
                "granted_permissions": app.get("granted_permissions") or [],
                "allowed_functions": app.get("allowed_functions") or [],
                "function_catalog": function_catalog_payload(),
                "trust_level": app.get("trust_level", "scoped"),
                "expires_in": 900,
            }
        )

    def _authorize_runtime_function(self, app: dict, session_payload: dict, function_id: str, payload: dict) -> tuple[bool, str]:
        function_meta = FUNCTION_CATALOG.get(function_id)
        if not function_meta:
            return False, "funcao desconhecida"
        if function_id not in set(session_payload.get("functions") or []):
            return False, "funcao nao autorizada para esta sessao"
        if function_id not in set(app.get("allowed_functions") or []):
            return False, "funcao nao concedida nas permissoes atuais do app"

        permission_id = function_meta.get("permission")
        policy = (app.get("permission_policies") or {}).get(permission_id) or {}
        grant_mode = policy.get("grant_mode", "deny")
        if grant_mode == "deny":
            return False, "permissao negada"
        if grant_mode == "ask_each_time":
            return False, "approval_required"

        for key in ("path", "source", "destination"):
            if key in payload and not is_path_allowed(policy, payload.get(key)):
                return False, f"caminho fora do escopo permitido: {key}"
            if key in payload and not is_file_type_allowed(policy, payload.get(key)):
                return False, f"tipo de arquivo fora do escopo permitido: {key}"
        return True, ""

    async def _dispatch_runtime_function(self, app: dict, function_id: str, payload: dict):
        if function_id == "apps.list":
            return {"apps": self._app_manager.get_apps(include_disabled=False, include_details=False)}

        if function_id == "apps.getPermissions":
            target_app_id = str(payload.get("app_id") or app["id"]).strip()
            if target_app_id != app["id"]:
                raise PermissionError("apps de runtime so podem ler as proprias permissoes")
            return self._app_manager.get_permissions_payload(target_app_id)

        if function_id == "diagnostics.status":
            return self._build_status_snapshot()

        if function_id == "files.listDirectory":
            path = str(payload.get("path") or "/")
            items = await self._file_manager.list_directory(path)
            return {"items": self._normalize_file_listing_items(items), "path": path}

        if function_id == "files.getInfo":
            path = str(payload.get("path") or "").strip()
            if not path:
                raise ValueError("path ausente")
            return await self._build_file_info_payload(path, False)

        if function_id == "search.query":
            query = str(payload.get("query") or payload.get("q") or "").strip().lower()
            if not query:
                return {"items": [], "query": ""}
            limit = max(1, min(100, int(payload.get("limit", 25))))
            results = []

            async def walk(dir_path: str):
                if len(results) >= limit:
                    return
                items = await self._file_manager.list_directory(dir_path)
                for item in items:
                    if len(results) >= limit:
                        return
                    if query in str(item.get("name") or "").lower():
                        results.append(item)
                    if item.get("is_directory"):
                        await walk(item["path"])

            await walk("/")
            return {"items": self._normalize_file_listing_items(results[:limit]), "query": query}

        if function_id == "favorites.list":
            items = await self._file_manager.get_favorites()
            return {"items": self._normalize_file_listing_items(items)}

        if function_id == "recents.list":
            items = await self._file_manager.get_recents()
            return {"items": self._normalize_file_listing_items(items)}

        if function_id == "storage.pinOffline":
            path = str(payload.get("path") or "").strip()
            if not path:
                raise ValueError("path ausente")
            await self._file_manager.set_offline(path, True)
            return {"status": "ok", "path": path, "cache": await self._file_manager.get_cache_status(path)}

        if function_id == "storage.unpinOffline":
            path = str(payload.get("path") or "").strip()
            if not path:
                raise ValueError("path ausente")
            await self._file_manager.set_offline(path, False)
            return {"status": "ok", "path": path}

        if function_id == "storage.evictCache":
            path = str(payload.get("path") or "").strip()
            if not path:
                raise ValueError("path ausente")
            await self._file_manager.evict_file_cache(path)
            return {"status": "ok", "path": path}

        raise NotImplementedError("funcao ainda nao implementada no runtime")

    async def _handle_api_apps_runtime_execute(self, request):
        token = self._request_bearer_token(request)
        if not token:
            return web.json_response({"error": "runtime token ausente"}, status=401)

        session_payload = verify_app_runtime_token(token, Config.JWT_SECRET)
        if not session_payload:
            return web.json_response({"error": "runtime token invalido"}, status=401)

        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "JSON invalido"}, status=400)

        function_id = str(data.get("function") or "").strip()
        payload = data.get("payload") or {}
        app_id = str(session_payload.get("app_id") or "").strip()
        app = self._app_manager.get_app(app_id, include_details=True)
        if not app:
            return web.json_response({"error": "app nao encontrado"}, status=404)
        if not app.get("enabled", True):
            return web.json_response({"error": "app desabilitado"}, status=403)

        allowed, reason = self._authorize_runtime_function(app, session_payload, function_id, payload)
        if not allowed:
            append_audit_event(
                Config.RUNTIME_DIR,
                "runtime_call_denied",
                app_id=app_id,
                details={"function": function_id, "reason": reason},
            )
            status = 409 if reason == "approval_required" else 403
            return web.json_response({"error": reason, "code": reason.upper()}, status=status)

        try:
            result = await self._dispatch_runtime_function(app, function_id, payload)
            append_audit_event(
                Config.RUNTIME_DIR,
                "runtime_call_allowed",
                app_id=app_id,
                details={"function": function_id},
            )
            return web.json_response({"ok": True, "result": result})
        except NotImplementedError as exc:
            return web.json_response({"error": str(exc)}, status=501)
        except PermissionError as exc:
            return web.json_response({"error": str(exc)}, status=403)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.error(f"Runtime execute failed for {app_id}:{function_id}: {exc}", exc_info=True)
            append_audit_event(
                Config.RUNTIME_DIR,
                "runtime_call_failed",
                app_id=app_id,
                details={"function": function_id, "error": str(exc)},
            )
            return web.json_response({"error": str(exc)}, status=500)

    async def _handle_api_settings_schema(self, request):
        return web.json_response(Config.settings_schema())

    async def _handle_api_settings(self, request):
        return web.json_response(Config.settings_payload())

    async def _handle_api_settings_secret(self, request):
        key = str(request.match_info.get("key") or "").strip()
        if not key:
            return web.json_response({"error": "chave ausente"}, status=400)
        try:
            payload = Config.secret_value_payload(key)
        except KeyError as exc:
            return web.json_response({"error": exc.args[0]}, status=404, headers={"Cache-Control": "no-store"})
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400, headers={"Cache-Control": "no-store"})
        return web.json_response(payload, headers={"Cache-Control": "no-store"})

    async def _handle_api_settings_patch(self, request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "JSON invalido"}, status=400)

        changes = data.get("changes") or {}
        result = Config.update_managed_settings(changes)
        if not result.get("ok"):
            return web.json_response(result, status=400)

        self._refresh_runtime_settings()
        return web.json_response(result)

    async def _handle_api_settings_reload_apps(self, request):
        self._app_manager.reload()
        return web.json_response(
            {
                "ok": True,
                "apps": self._app_manager.get_apps(),
                "default_app_id": self._app_manager.get_default_app_id(),
            }
        )

    async def _handle_api_settings_storage(self, request):
        try:
            total_bytes = await self._file_manager.get_disk_usage()
        except Exception:
            total_bytes = 0

        cache_usage_bytes = self._measure_directory_bytes(Config.CACHE_DIR)
        raw_items = await self._file_manager.get_storage_inventory()
        items = []
        persistent_item_count = 0
        temporary_item_count = 0
        ready_item_count = 0
        syncing_item_count = 0

        for item in raw_items:
            status = item.get("status") or {}
            retention_kind = status.get("retention_kind")
            if retention_kind == "persistent":
                persistent_item_count += 1
            elif retention_kind == "temporary":
                temporary_item_count += 1

            if status.get("is_ready"):
                ready_item_count += 1
            if status.get("is_syncing"):
                syncing_item_count += 1

            storage = item.get("storage") or {}
            normalized_item = dict(item)
            normalized_item["storage"] = {
                **storage,
                "storage_id_masked": _mask_storage_id(storage.get("storage_id_masked")),
            }
            items.append(normalized_item)

        active_paths = list(self._file_manager._cache._active_offline_downloads)
        jobs = []
        for path in active_paths:
            file_meta = await self._file_manager.get_file_meta(path)
            if not file_meta:
                continue
            cache_status = self._file_manager._cache.get_file_cache_snapshot(path, file_meta.get("chunks", []))
            jobs.append(
                {
                    "id": path,
                    "path": path,
                    "name": file_meta.get("filename") or Path(path).name,
                    "percent": float(cache_status.get("percent") or 0),
                    "cached_bytes": int(cache_status.get("cached_bytes") or 0),
                    "total_bytes": int(cache_status.get("total_bytes") or 0),
                }
            )

        return web.json_response(
            {
                "summary": {
                    "total_bytes": total_bytes,
                    "cache_usage_bytes": cache_usage_bytes,
                    "persistent_item_count": persistent_item_count,
                    "temporary_item_count": temporary_item_count,
                    "ready_item_count": ready_item_count,
                    "syncing_item_count": syncing_item_count,
                    "cached_item_count": ready_item_count,
                    "offline_item_count": persistent_item_count,
                    "active_offline_download_count": len(jobs),
                    "runtime_dir": str(Config.RUNTIME_DIR),
                    "cache_dir": str(Config.CACHE_DIR),
                    "store_path": str(Config.runtime_store_path()),
                    "env_path": str(Config.runtime_env_path()),
                    "sync_enabled": bool(Config.SYNC_ENABLED),
                    "sync_dir": str(Config.SYNC_DIR) if Config.SYNC_ENABLED else "",
                    "persistence": Config.settings_persistence_status(),
                },
                "items": items,
                "jobs": jobs,
            }
        )

    async def _handle_api_settings_status(self, request):
        return web.json_response(self._build_status_snapshot())

    async def _handle_api_archive_capabilities(self, request):
        return web.json_response(self._archive_service.capabilities_payload())

    async def _handle_api_archive_jobs(self, request):
        return web.json_response({"jobs": await self._archive_service.list_jobs()})

    async def _handle_api_archive_job(self, request):
        job_id = str(request.match_info.get("job_id") or "").strip()
        if not job_id:
            return web.json_response({"error": "job_id ausente"}, status=400)
        payload = await self._archive_service.get_job(job_id)
        if not payload:
            return web.json_response({"error": "job nao encontrado"}, status=404)
        return web.json_response({"job": payload})

    async def _handle_api_archive_extract(self, request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "JSON invalido"}, status=400)

        archive_path = str(data.get("archive_path") or "").strip()
        destination = str(data.get("destination") or "").strip()
        if not archive_path or not destination:
            return web.json_response({"error": "archive_path e destination sao obrigatorios"}, status=400)

        try:
            job = await self._archive_service.create_extract_job(
                archive_path=archive_path,
                destination=destination,
                extract_mode=str(data.get("extract_mode") or "").strip(),
                overwrite_mode=str(data.get("overwrite_mode") or "").strip(),
                password=str(data.get("password") or ""),
            )
            return web.json_response({"ok": True, "job": job})
        except (ArchiveValidationError, ArchiveCapabilityError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.error("Archive extract request failed: %s", exc, exc_info=True)
            return web.json_response({"error": str(exc)}, status=500)

    async def _handle_api_archive_compress(self, request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "JSON invalido"}, status=400)

        source_paths = data.get("source_paths") or []
        destination = str(data.get("destination") or "").strip()
        archive_name = str(data.get("archive_name") or "").strip()
        archive_format = str(data.get("archive_format") or "").strip()
        if not destination or not archive_name or not archive_format or not isinstance(source_paths, list):
            return web.json_response({"error": "source_paths, destination, archive_name e archive_format sao obrigatorios"}, status=400)

        try:
            job = await self._archive_service.create_compress_job(
                source_paths=[str(path) for path in source_paths],
                destination=destination,
                archive_name=archive_name,
                archive_format=archive_format,
                compression_level=str(data.get("compression_level") or "normal").strip(),
                overwrite_mode=str(data.get("overwrite_mode") or "").strip(),
                base_path=str(data.get("base_path") or "").strip(),
            )
            return web.json_response({"ok": True, "job": job})
        except (ArchiveValidationError, ArchiveCapabilityError, FileNotFoundError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.error("Archive compress request failed: %s", exc, exc_info=True)
            return web.json_response({"error": str(exc)}, status=500)

    async def _handle_api_archive_job_cancel(self, request):
        job_id = str(request.match_info.get("job_id") or "").strip()
        if not job_id:
            return web.json_response({"error": "job_id ausente"}, status=400)
        try:
            payload = await self._archive_service.cancel_job(job_id)
            return web.json_response({"ok": True, "job": payload})
        except KeyError:
            return web.json_response({"error": "job nao encontrado"}, status=404)
        except Exception as exc:
            logger.error("Archive cancel request failed: %s", exc, exc_info=True)
            return web.json_response({"error": str(exc)}, status=500)

    def _refresh_runtime_settings(self):
        self._archive_service.refresh_settings()
        self._web_subtitle_extract_timeout_seconds = max(
            30,
            int(getattr(Config, "WEB_SUBTITLE_EXTRACT_TIMEOUT_SECONDS", self._web_subtitle_extract_timeout_seconds)),
        )
        self._web_video_transcode_mode = str(
            getattr(Config, "WEB_VIDEO_TRANSCODE_MODE", self._web_video_transcode_mode)
        ).strip().lower() or self._web_video_transcode_mode
        self._web_playback_ttl_seconds = max(
            60,
            int(getattr(Config, "WEB_PLAYBACK_SESSION_TTL", self._web_playback_ttl_seconds)),
        )
        self._web_playback_retire_grace_seconds = max(
            5,
            int(getattr(Config, "WEB_PLAYBACK_RETIRE_GRACE_SECONDS", self._web_playback_retire_grace_seconds)),
        )
        self._web_playback_hls_subtitles_mode = {
            "off": "off",
            "disabled": "off",
            "legacy": "off",
            "hybrid": "hybrid",
            "native": "native",
        }.get(
            str(getattr(Config, "WEB_PLAYBACK_HLS_SUBTITLES_MODE", self._web_playback_hls_subtitles_mode)).strip().lower()
            or self._web_playback_hls_subtitles_mode,
            "hybrid",
        )
        self._web_playback_hls_subtitle_segment_duration = max(
            2,
            int(getattr(Config, "WEB_PLAYBACK_HLS_SUBTITLE_SEGMENT_DURATION", self._web_playback_hls_subtitle_segment_duration)),
        )
        raw_segment_type = str(
            getattr(Config, "WEB_PLAYBACK_HLS_SEGMENT_TYPE", self._web_playback_segment_type)
        ).strip().lower() or self._web_playback_segment_type
        self._web_playback_segment_type = {
            "ts": "mpegts",
            "mpegts": "mpegts",
            "fmp4": "fmp4",
            "cmaf": "fmp4",
        }.get(raw_segment_type, "mpegts")
        raw_cloud_input_mode = str(
            getattr(Config, "WEB_PLAYBACK_HLS_CLOUD_INPUT_MODE", self._web_playback_hls_cloud_input_mode)
        ).strip().lower() or self._web_playback_hls_cloud_input_mode
        self._web_playback_hls_cloud_input_mode = {
            "http": "http_range",
            "http_range": "http_range",
            "range": "http_range",
            "pipe": "pipe",
            "stdin": "pipe",
            "auto": "auto",
        }.get(raw_cloud_input_mode, self._web_playback_hls_cloud_input_mode)
        self._web_playback_hls_startup_timeout_seconds = max(
            15.0,
            float(getattr(Config, "WEB_PLAYBACK_HLS_STARTUP_TIMEOUT_SECONDS", self._web_playback_hls_startup_timeout_seconds)),
        )

    @staticmethod
    def _measure_directory_bytes(path: Path) -> int:
        total = 0
        if not path.exists():
            return total
        for child in path.rglob("*"):
            if child.is_file():
                try:
                    total += child.stat().st_size
                except OSError:
                    continue
        return total

    async def _handle_app_static(self, request):
        """Serve static files from an app's directory."""
        app_id = request.match_info["app_id"]
        file_path = request.match_info.get("path", "index.html") or "index.html"

        app = self._app_manager.get_app(app_id, include_details=True)
        if not app:
            return web.Response(text="App not found", status=404)
        if not app.get("enabled", True):
            return web.Response(text="App disabled", status=403)

        app_dir = self._app_manager.get_app_dir(app_id, include_disabled=True)
        if not app_dir:
            return web.Response(text="App directory not found", status=404)

        # Security: resolve and ensure the path stays within the app dir
        target = (app_dir / file_path).resolve()
        if not str(target).startswith(str(app_dir.resolve())):
            return web.Response(text="Forbidden", status=403)

        if not target.exists() or not target.is_file():
            return web.Response(text="File not found", status=404)

        # Determine content type
        content_type, _ = mimetypes.guess_type(str(target))
        if not content_type:
            content_type = "application/octet-stream"

        return web.Response(
            body=target.read_bytes(),
            content_type=content_type,
        )

    async def _handle_api_login(self, request):
        """Authenticate and return a JWT token."""
        try:
            data = await request.json()
            username = data.get("username", "")
            password = data.get("password", "")

            if username == Config.AUTH_USERNAME and password == Config.AUTH_PASSWORD:
                remember = data.get("remember", False)
                expiry = 8760 if remember else Config.JWT_EXPIRY_HOURS  # 1 year vs default
                token = create_token(username, Config.JWT_SECRET, expiry)
                return web.json_response({
                    "token": token,
                    "expires_in": expiry * 3600,
                    "auth_enabled": Config.AUTH_ENABLED,
                })
            else:
                return web.json_response(
                    {"error": "Credenciais inválidas"},
                    status=401,
                )
        except Exception as e:
            logger.error(f"Login error: {e}")
            return web.json_response({"error": str(e)}, status=500)

    # ===================== MEDIA TRACKS =====================

    def _build_internal_media_probe_url(self, raw_path: str, *, raw_mode: bool = False) -> str:
        query = ["internal_probe=true"]
        if raw_mode:
            query.append("probe_mode=raw")
        internal_url = f"http://127.0.0.1:{Config.HTTP_PORT}/stream{quote(raw_path, safe='/')}?{'&'.join(query)}"
        if Config.AUTH_ENABLED:
            internal_token = create_token("internal", Config.JWT_SECRET, 1)
            internal_url += f"&token={internal_token}"
        return internal_url

    def _build_web_hls_input_plan(self, source: dict, raw_path: str, start_seconds: float) -> dict:
        input_args: list[str] = []
        stdin_mode = asyncio.subprocess.DEVNULL
        input_mode = "local-file"
        probe_input = None
        internal_raw_url = None
        is_fully_cached = False
        cloud_input_mode = str(getattr(self, "_web_playback_hls_cloud_input_mode", "http_range") or "http_range").strip().lower()

        if start_seconds > 0:
            input_args.extend(["-ss", str(start_seconds)])

        if source.get("is_local"):
            file_path = source["file_path"]
            input_args.extend(["-i", str(file_path)])
            probe_input = str(file_path)
            return {
                "input_args": input_args,
                "stdin_mode": stdin_mode,
                "input_mode": input_mode,
                "probe_input": probe_input,
                "internal_raw_url": internal_raw_url,
                "is_fully_cached": is_fully_cached,
            }

        file_meta = source.get("file_meta") or {}
        chunks = file_meta.get("chunks", [])
        is_fully_cached = bool(self._file_manager._cache.is_fully_cached(raw_path, chunks))
        internal_raw_url = self._build_internal_media_probe_url(raw_path, raw_mode=True)

        use_pipe = cloud_input_mode == "pipe" and not is_fully_cached and start_seconds <= 0
        if use_pipe:
            input_args.extend([
                "-analyzeduration", "20000000",
                "-probesize", "20000000",
                "-i", "pipe:0",
            ])
            stdin_mode = asyncio.subprocess.PIPE
            input_mode = "cloud-pipe"
        else:
            input_args.extend([
                "-analyzeduration", "20000000",
                "-probesize", "20000000",
            ])
            if start_seconds > 0:
                input_args.extend(["-fflags", "+fastseek"])
            input_args.extend(["-i", internal_raw_url])
            stdin_mode = asyncio.subprocess.DEVNULL
            input_mode = "cached-http-range" if is_fully_cached else "cloud-http-range"
            probe_input = internal_raw_url

        return {
            "input_args": input_args,
            "stdin_mode": stdin_mode,
            "input_mode": input_mode,
            "probe_input": probe_input,
            "internal_raw_url": internal_raw_url,
            "is_fully_cached": is_fully_cached,
        }

    async def _probe_web_hls_source_video_codec(self, probe_input: str | None, raw_path: str) -> str | None:
        if not probe_input:
            return None

        try:
            codec_proc = await asyncio.create_subprocess_exec(
                "ffprobe", "-v", "quiet", "-select_streams", "v:0",
                "-show_entries", "stream=codec_name", "-of", "csv=p=0",
                probe_input,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            codec_out, _ = await asyncio.wait_for(codec_proc.communicate(), timeout=5)
            return (codec_out.decode().strip().lower() if codec_out else "") or None
        except Exception as exc:
            logger.debug("HLS codec probe failed for %s: %s", raw_path, exc)
            return None

    def _should_retry_web_hls_startup_with_transcode(self, exc: Exception, startup_attempt: str) -> bool:
        if startup_attempt != "copy":
            return False
        return isinstance(exc, (TimeoutError, RuntimeError))

    async def _get_file_input_path(self, raw_path: str, is_local: bool):
        """Resolve an ffprobe/ffmpeg-readable input. Returns (path_or_url, is_concat)."""
        if is_local:
            file_path = Path(raw_path)
            if file_path.exists():
                return str(file_path), False
            return None, False

        # Cloud file — check if fully cached
        file_meta = await self._file_manager.get_file_meta(raw_path)
        if not file_meta:
            return None, False

        chunks = file_meta.get("chunks", [])
        cached_path = self._file_manager.get_cached_file_path(file_meta, raw_path)
        if cached_path and Path(cached_path).exists():
            return str(cached_path), False

        # Check if fully cached via chunks
        if self._file_manager._cache.is_fully_cached(raw_path, chunks):
            paths = self._file_manager._cache.get_all_chunk_paths(raw_path, chunks)
            # Use concat list for multi-chunk
            if len(paths) == 1:
                return str(paths[0]), False
            # For multi-chunk, create a temp concat file
            import tempfile
            with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
                for p in paths:
                    f.write(f"file '{p.absolute()}'\n")
                return f.name, True  # is_temp=True means it's a concat list

        # Fallback to a raw internal stream URL so ffprobe sees the original
        # container instead of a transcoded playback pipe.
        internal_url = self._build_internal_media_probe_url(raw_path, raw_mode=True)
        logger.info("🎬 Media probe using raw internal stream: %s", raw_path)
        return internal_url, False

    async def _read_sidecar_subtitle_bytes(self, raw_path: str, is_local: bool) -> bytes | None:
        if is_local:
            file_path = Path(raw_path)
            if not file_path.exists() or not file_path.is_file():
                return None
            return file_path.read_bytes()

        file_meta = await self._file_manager.get_file_meta(raw_path)
        if not file_meta:
            return None

        total_size = file_meta.get("size", 0)
        if total_size <= 0:
            return b""

        chunks = []
        async for data in self._file_manager.stream_file_range_direct(raw_path, 0, total_size - 1):
            chunks.append(data)
        return b"".join(chunks)

    async def _detect_sidecar_language_from_content(self, raw_path: str, is_local: bool) -> tuple[str, float]:
        try:
            subtitle_bytes = await self._read_sidecar_subtitle_bytes(raw_path, is_local)
        except Exception:
            return "", 0.0

        if not subtitle_bytes:
            return "", 0.0

        subtitle_text = _decode_subtitle_utf8(subtitle_bytes[:65536])
        sample = _readable_subtitle_text_sample(subtitle_text)
        return _detect_subtitle_language_from_content(sample)

    async def _refine_sidecar_candidate_language(self, candidate: dict, *, is_local: bool) -> dict:
        updated = dict(candidate)
        current_language = _normalize_language_code(updated.get("language", ""))
        confidence = float(updated.get("confidence", 0.0) or 0.0)
        subtitle_name = str(updated.get("name", "") or "")

        if not _should_refine_sidecar_language(
            current_language=current_language,
            confidence=confidence,
            subtitle_name=subtitle_name,
        ):
            return updated

        content_language, content_confidence = await self._detect_sidecar_language_from_content(
            str(updated.get("path", "") or ""),
            is_local,
        )
        if not content_language:
            return updated
        if content_language == current_language and content_confidence <= confidence:
            return updated

        updated["language"] = content_language
        updated["confidence"] = max(confidence, content_confidence)
        updated["label"] = _build_subtitle_label(
            language=content_language,
            title=updated.get("title", ""),
            index=int(updated.get("source_track_index") or 0),
            filename=subtitle_name,
            src=updated.get("path", "") or updated.get("url", ""),
            forced=updated.get("forced", False),
            default=updated.get("default", False),
            hearing_impaired=updated.get("hearing_impaired", False),
            comment=updated.get("comment", False),
            captions=updated.get("captions", False),
            complete=updated.get("complete", False),
        )
        return updated

    async def _serve_sidecar_subtitle(self, raw_path: str, is_local: bool):
        suffix = Path(raw_path).suffix.lower()
        if suffix not in UTF8_WEBVTT_SIDECAR_EXTENSIONS:
            return web.Response(text="Unsupported subtitle format", status=415)

        subtitle_bytes = await self._read_sidecar_subtitle_bytes(raw_path, is_local)
        if subtitle_bytes is None:
            return web.Response(text="Subtitle file not found", status=404)

        subtitle_text = _decode_subtitle_utf8(subtitle_bytes)
        webvtt_text = _convert_subtitle_to_webvtt(subtitle_text, suffix)

        return web.Response(
            text=webvtt_text,
            content_type="text/vtt",
            charset="utf-8",
            headers={
                "Content-Disposition": "inline",
                "Cache-Control": "public, max-age=3600",
                "Access-Control-Allow-Origin": "*",
            },
        )

    def _build_web_subtitle_cache_path(self, raw_path: str, is_local: bool, sub_index: int) -> Path:
        safe_stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(raw_path or "").stem).strip("._")
        if not safe_stem:
            safe_stem = "subtitle"
        digest = hashlib.sha1(f"{int(is_local)}:{sub_index}:{raw_path}".encode("utf-8")).hexdigest()
        return self._web_subtitle_dir / f"{safe_stem}_{sub_index}_{digest}.vtt"

    def _build_web_subtitle_cache_key(self, raw_path: str, is_local: bool, sub_index: int) -> str:
        return f"{int(is_local)}:{sub_index}:{raw_path}"

    def _get_web_subtitle_lock(self, cache_path: Path) -> asyncio.Lock:
        key = str(cache_path)
        lock = self._web_subtitle_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._web_subtitle_locks[key] = lock
        return lock

    def _build_web_subtitle_source_cache_path(self, raw_path: str, is_local: bool) -> Path:
        safe_stem = re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(raw_path or "").stem).strip("._")
        if not safe_stem:
            safe_stem = "subtitle_source"
        suffix = Path(raw_path or "").suffix or ".bin"
        digest = hashlib.sha1(f"source:{int(is_local)}:{raw_path}".encode("utf-8")).hexdigest()
        return self._web_subtitle_dir / f"{safe_stem}_{digest}{suffix}"

    def _get_web_subtitle_source_lock(self, cache_path: Path) -> asyncio.Lock:
        key = str(cache_path)
        lock = self._web_subtitle_source_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._web_subtitle_source_locks[key] = lock
        return lock

    def _build_web_subtitle_source_status_key(self, raw_path: str, is_local: bool) -> str:
        return f"{int(is_local)}:{raw_path}"

    def _describe_web_subtitle_source_exception(self, exc: Exception) -> tuple[str, str]:
        if isinstance(exc, asyncio.TimeoutError):
            return "timeout", "Subtitle source prefetch timed out while caching the cloud file"
        if isinstance(exc, asyncio.CancelledError):
            return "cancelled", "Subtitle source prefetch was cancelled"
        message = str(exc).strip() or exc.__class__.__name__
        return exc.__class__.__name__, message

    def _set_web_subtitle_source_status(
        self,
        raw_path: str,
        is_local: bool,
        status: str,
        **extra,
    ) -> dict:
        task_key = self._build_web_subtitle_source_status_key(raw_path, is_local)
        current = self._web_subtitle_source_statuses.get(task_key, {})
        payload = {
            **current,
            "path": raw_path,
            "local": bool(is_local),
            "status": status,
            "updated_at": time.time(),
        }
        payload.update(extra)
        self._web_subtitle_source_statuses[task_key] = payload
        return payload

    async def _get_web_subtitle_source_status(self, raw_path: str, is_local: bool) -> dict:
        task_key = self._build_web_subtitle_source_status_key(raw_path, is_local)
        payload = dict(self._web_subtitle_source_statuses.get(task_key, {}))
        payload.setdefault("path", raw_path)
        payload.setdefault("local", bool(is_local))
        payload.setdefault("status", "idle")
        payload.setdefault("subtitle_timebase", "media_zero")
        payload["prefetch_active"] = False

        existing_task = self._web_subtitle_source_prefetch_tasks.get(task_key)
        if existing_task and not existing_task.done():
            payload["prefetch_active"] = True

        if is_local:
            source_ready = Path(raw_path).exists()
            payload["source_ready"] = source_ready
            if source_ready and payload.get("status") in {"idle", "scheduled", "resolving_source"}:
                payload["status"] = "source_ready"
            return payload

        try:
            file_meta = await self._file_manager.get_file_meta(raw_path)
        except Exception as exc:
            error_code, error_message = self._describe_web_subtitle_source_exception(exc)
            payload.setdefault("error_code", error_code)
            payload.setdefault("error_message", error_message)
            payload["status"] = "file_meta_error"
            payload["source_ready"] = False
            return payload

        if not file_meta:
            payload["status"] = "not_found"
            payload["error_code"] = "not_found"
            payload["error_message"] = "Media file metadata was not found"
            payload["source_ready"] = False
            return payload

        try:
            cache_status = await self._file_manager.get_cache_status(raw_path)
        except Exception:
            cache_status = None
        if cache_status:
            payload["cache"] = cache_status

        source_cache_path = self._build_web_subtitle_source_cache_path(raw_path, is_local)
        cached_path = self._file_manager.get_cached_file_path(file_meta, raw_path)
        source_ready = bool(
            (cached_path and Path(cached_path).exists())
            or source_cache_path.exists()
        )
        payload["source_ready"] = source_ready
        if source_ready and payload.get("status") in {
            "idle",
            "scheduled",
            "resolving_source",
            "caching_source",
            "materializing_source",
            "timeout",
        }:
            payload["status"] = "source_ready"
        return payload

    async def _materialize_embedded_subtitle_input(self, raw_path: str, is_local: bool) -> tuple[str | None, bool]:
        """Resolve a stable local source for embedded subtitle extraction."""
        return await self._materialize_embedded_subtitle_input_with_options(
            raw_path,
            is_local,
            allow_background_wait=False,
        )

    async def _materialize_embedded_subtitle_input_with_options(
        self,
        raw_path: str,
        is_local: bool,
        *,
        allow_background_wait: bool,
    ) -> tuple[str | None, bool]:
        """Resolve a stable local source for embedded subtitle extraction."""
        if is_local:
            file_path = Path(raw_path)
            if file_path.exists():
                self._set_web_subtitle_source_status(raw_path, is_local, "source_ready")
                return str(file_path), False
            return None, False

        file_meta = await self._file_manager.get_file_meta(raw_path)
        if not file_meta:
            return None, False

        cached_path = self._file_manager.get_cached_file_path(file_meta, raw_path)
        if cached_path and Path(cached_path).exists():
            self._set_web_subtitle_source_status(raw_path, is_local, "source_ready")
            return str(cached_path), False

        chunks = file_meta.get("chunks", [])
        source_cache_path = self._build_web_subtitle_source_cache_path(raw_path, is_local)
        expected_size = int(file_meta.get("size") or 0)
        self._set_web_subtitle_source_status(raw_path, is_local, "resolving_source")

        async with self._get_web_subtitle_source_lock(source_cache_path):
            cached_path = self._file_manager.get_cached_file_path(file_meta, raw_path)
            if cached_path and Path(cached_path).exists():
                self._set_web_subtitle_source_status(raw_path, is_local, "source_ready")
                return str(cached_path), False

            if source_cache_path.exists():
                if expected_size <= 0 or source_cache_path.stat().st_size == expected_size:
                    self._set_web_subtitle_source_status(raw_path, is_local, "source_ready")
                    return str(source_cache_path), False
                try:
                    source_cache_path.unlink()
                except OSError:
                    pass

            temp_source_path = source_cache_path.with_suffix(f"{source_cache_path.suffix}.tmp")
            if temp_source_path.exists():
                try:
                    temp_source_path.unlink()
                except OSError:
                    pass

            logger.info("🎬 Ensuring subtitle source is fully cached: %s", raw_path)
            self._set_web_subtitle_source_status(raw_path, is_local, "caching_source")
            await self._file_manager.ensure_file_cached(
                raw_path,
                timeout=None if allow_background_wait else self._web_subtitle_extract_timeout_seconds,
            )

            cached_path = self._file_manager.get_cached_file_path(file_meta, raw_path)
            if cached_path and Path(cached_path).exists():
                self._set_web_subtitle_source_status(raw_path, is_local, "source_ready")
                return str(cached_path), False

            if not chunks or not self._file_manager._cache.is_fully_cached(raw_path, chunks):
                raise RuntimeError(f"Subtitle source cache did not complete: {raw_path}")

            logger.info("🎬 Materializing cached subtitle source locally: %s", raw_path)
            self._set_web_subtitle_source_status(raw_path, is_local, "materializing_source")
            await asyncio.to_thread(
                self._file_manager._stitch_cached_chunks_to_file,
                raw_path,
                chunks,
                temp_source_path,
            )

            temp_source_path.replace(source_cache_path)

        self._set_web_subtitle_source_status(raw_path, is_local, "source_ready")
        return str(source_cache_path), False

    def _schedule_embedded_subtitle_source_prefetch(self, raw_path: str, is_local: bool) -> None:
        if is_local:
            return

        task_key = f"{int(is_local)}:{raw_path}"
        existing_task = self._web_subtitle_source_prefetch_tasks.get(task_key)
        if existing_task and not existing_task.done():
            return

        async def _runner():
            try:
                self._set_web_subtitle_source_status(raw_path, is_local, "scheduled")
                logger.info("🎬 Scheduling subtitle source prefetch: %s", raw_path)
                await self._materialize_embedded_subtitle_input_with_options(
                    raw_path,
                    is_local,
                    allow_background_wait=True,
                )
                logger.info("🎬 Subtitle source prefetch ready: %s", raw_path)
            except Exception as exc:
                error_code, error_message = self._describe_web_subtitle_source_exception(exc)
                self._set_web_subtitle_source_status(
                    raw_path,
                    is_local,
                    error_code,
                    error_code=error_code,
                    error_message=error_message,
                )
                logger.warning("⚠️ Subtitle source prefetch failed for %s: %s", raw_path, error_message)
            finally:
                current = self._web_subtitle_source_prefetch_tasks.get(task_key)
                if current is asyncio.current_task():
                    self._web_subtitle_source_prefetch_tasks.pop(task_key, None)

        self._web_subtitle_source_prefetch_tasks[task_key] = asyncio.create_task(_runner())

    async def _extract_embedded_subtitle_webvtt(
        self,
        *,
        input_path: str,
        is_concat: bool,
        sub_index: int,
        raw_path: str,
        is_local: bool,
        timeout_seconds: float | None = None,
    ) -> bytes:
        input_args = [
            '-analyzeduration', '20000000',
            '-probesize', '20000000',
        ]
        if is_concat:
            input_args.extend(['-f', 'concat', '-safe', '0', '-i', input_path])
        else:
            input_args.extend(['-i', input_path])

        proc = await asyncio.create_subprocess_exec(
            'ffmpeg', '-hide_banner', '-loglevel', 'warning', '-nostdin',
            *input_args,
            '-map', f'0:s:{sub_index}',
            '-vn',
            '-an',
            '-dn',
            '-c:s', 'webvtt',
            '-f', 'webvtt',
            'pipe:1',
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        extraction_started_at = time.time()
        extraction_timeout = timeout_seconds if timeout_seconds is not None else self._web_subtitle_extract_timeout_seconds
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=extraction_timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            try:
                await proc.communicate()
            except Exception:
                pass
            logger.warning(
                "🎬 Subtitle extraction timeout: path=%s local=%s index=%s input=%s timeout_s=%s",
                raw_path,
                is_local,
                sub_index,
                "concat" if is_concat else ("url" if input_path.startswith("http") else "path"),
                extraction_timeout,
            )
            raise

        if proc.returncode != 0:
            err = stderr.decode(errors='ignore')[:1000]
            logger.warning(
                "🎬 Subtitle extraction failed: path=%s local=%s index=%s input=%s stderr=%s command=%s",
                raw_path,
                is_local,
                sub_index,
                "concat" if is_concat else ("url" if input_path.startswith("http") else "path"),
                err,
                ['ffmpeg', *input_cmd, '-map', f'0:s:{sub_index}', '-vn', '-an', '-dn', '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1']
            )
            raise RuntimeError(f"Subtitle extraction failed: {err}")

        logger.info(
            "🎬 Subtitle extraction ready: path=%s local=%s index=%s bytes=%s elapsed_ms=%s input=%s",
            raw_path,
            is_local,
            sub_index,
            len(stdout),
            max(0, int((time.time() - extraction_started_at) * 1000)),
            "concat" if is_concat else ("url" if input_path.startswith("http") else "path"),
            )
        return stdout

    def _build_subtitle_http_response(
        self,
        cache_path: Path,
        *,
        raw_path: str = "",
        is_local: bool = False,
        sub_index: int | None = None,
        extraction_mode: str = "",
    ) -> web.StreamResponse:
        headers = {
            'Content-Disposition': 'inline',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*',
            'X-TCloud-Subtitle-Timebase': 'media_zero',
        }
        if extraction_mode:
            headers['X-TCloud-Subtitle-Extraction-Mode'] = extraction_mode
        if raw_path and sub_index is not None:
            headers['X-TCloud-Subtitle-Cache-Key'] = self._build_web_subtitle_cache_key(raw_path, is_local, sub_index)
        return web.Response(
            body=cache_path.read_bytes(),
            content_type="text/vtt",
            charset="utf-8",
            headers=headers,
        )

    async def _gather_subtitle_candidates(self, path: str, is_local: bool) -> tuple[list[dict], str]:
        items = []
        input_path = None
        is_concat = False
        embedded_status_snapshot = None
        probe_input_kind = "unavailable"
        authority = await self._resolve_video_subtitle_authority(path, is_local)
        authority_mode = str(authority.get("mode") or "mixed_legacy").strip().lower() or "mixed_legacy"
        subtitle_trace = {
            "path": path,
            "local": is_local,
            "video_name": Path(path).name,
            "parent_dir": str(Path(path).parent if str(Path(path).parent) not in {"", "."} else "/"),
            "authority_mode": authority_mode,
        }

        try:
            sidecar_candidates = await self._discover_sidecar_subtitles(path, is_local)
            if sidecar_candidates:
                logger.info(
                    "🎬 Subtitle sidecars discovered: trace=%s count=%s scope_counts=%s match_reasons=%s",
                    subtitle_trace,
                    len(sidecar_candidates),
                    dict(Counter(str(candidate.get("scope_kind") or "unknown") for candidate in sidecar_candidates)),
                    sorted({
                        str(candidate.get("match_reason") or "").strip()
                        for candidate in sidecar_candidates
                        if str(candidate.get("match_reason") or "").strip()
                    }),
                )
            else:
                logger.info("🎬 Subtitle sidecars empty: trace=%s", subtitle_trace)
            if authority_mode == "externalized_sidecar_authoritative" and any(c.get("authoritative_sidecar") for c in sidecar_candidates):
                probe_input_kind = "authoritative_sidecar"
                logger.info(
                    "🎬 Subtitle authority short-circuit: trace=%s probe_input_kind=%s authoritative_sidecars=%s",
                    subtitle_trace,
                    probe_input_kind,
                    sum(1 for candidate in sidecar_candidates if candidate.get("authoritative_sidecar")),
                )
                # If we have authoritative sidecars, we SHOULD still include non-authoritative ones 
                # from the same folder that aren't exact duplicates by path.
                for idx, sidecar in enumerate(sidecar_candidates):
                    sidecar_url = sidecar.get("url", "")
                    sidecar_path = sidecar.get("path", "")
                    items.append({
                            "id": f"sidecar:{idx}:{sidecar.get('name', '')}",
                            "track_id": _build_subtitle_track_id(
                                source="sidecar",
                                track_index=idx,
                                path=sidecar_path,
                                filename=sidecar.get("name", ""),
                            ),
                            "source": "sidecar",
                            "track_index": None,
                            "stream_index": None,
                            "codec": Path(sidecar.get("name", "")).suffix.lower().lstrip("."),
                            "url": sidecar_url,
                            "legacy_url": sidecar_url,
                            "path": sidecar_path,
                            "media_path": path,
                            "src": sidecar.get("path", ""),
                            "language": sidecar.get("language", ""),
                            "title": sidecar.get("title", ""),
                            "label": sidecar.get("label")
                            or _build_subtitle_label(
                                language=sidecar.get("language", ""),
                                title=sidecar.get("title", ""),
                                index=idx,
                                filename=sidecar.get("name", ""),
                                src=sidecar.get("path", "") or sidecar_url,
                                forced=sidecar.get("forced", False),
                                default=sidecar.get("default", False),
                                hearing_impaired=sidecar.get("hearing_impaired", False),
                                comment=sidecar.get("comment", False),
                                captions=sidecar.get("captions", False),
                            ),
                            "flags": _subtitle_flags(
                                forced=sidecar.get("forced", False),
                                default=sidecar.get("default", False),
                                hearing_impaired=sidecar.get("hearing_impaired", False),
                                comment=sidecar.get("comment", False),
                                captions=sidecar.get("captions", False),
                            ),
                            "forced": sidecar.get("forced", False),
                            "default": sidecar.get("default", False),
                            "hearing_impaired": sidecar.get("hearing_impaired", False),
                            "comment": sidecar.get("comment", False),
                            "captions": sidecar.get("captions", False),
                            "confidence": sidecar.get("confidence", 0.0),
                            "match_score": sidecar.get("match_score", 0),
                            "match_reason": str(sidecar.get("match_reason", "") or "").strip(),
                            "scope_kind": str(sidecar.get("scope_kind", "") or "").strip(),
                            "auto_match": bool(sidecar.get("auto_match", False)),
                            "authoritative_sidecar": bool(sidecar.get("authoritative_sidecar", False)),
                            "generated_group_id": str(sidecar.get("generated_group_id", "") or "").strip(),
                            "source_track_index": sidecar.get("source_track_index"),
                            "source_codec": str(sidecar.get("source_codec", "") or "").strip(),
                            "authority_mode": authority_mode,
                            "authority_rank": 0 if sidecar.get("authoritative_sidecar") else 1,
                            "is_generated_sidecar": bool(sidecar.get("authoritative_sidecar", False)),
                            "delivery": "legacy",
                        })
                    sorted_items = sorted(items, key=_build_subtitle_authority_sort_key)
                    logger.info(
                        "🎬 Subtitle candidate payload ready: trace=%s items=%s probe_input_kind=%s sources=%s",
                        subtitle_trace,
                        len(sorted_items),
                        probe_input_kind,
                        dict(Counter(str(item.get("source") or "unknown") for item in sorted_items)),
                    )
                    return sorted_items, probe_input_kind
            
            if authority_mode == "externalized_sidecar_authoritative":
                authority_mode = "mixed_legacy"

            streams = []
            try:
                input_path, is_concat = await self._get_file_input_path(path, is_local)
                if input_path:
                    probe_input_kind = "concat" if is_concat else ("url" if str(input_path).startswith("http") else "path")
                    logger.info(
                        "🎬 Subtitle probe starting: trace=%s probe_input_kind=%s",
                        subtitle_trace,
                        probe_input_kind,
                    )
                    probe_data, _ = await self._probe_ffprobe_metadata(input_path, is_concat)
                    streams = probe_data.get("streams", [])
            except Exception as probe_error:
                if sidecar_candidates:
                    logger.warning(
                        "Subtitle probe failed after sidecar discovery; returning sidecars only: path=%s local=%s sidecars=%s error=%s",
                        path,
                        is_local,
                        len(sidecar_candidates),
                        probe_error,
                    )
                    probe_input_kind = "sidecar_only_after_probe_failure"
                    streams = []
                else:
                    raise

            subtitle_index = 0
            for stream in streams:
                if stream.get("codec_type") != "subtitle":
                    continue

                tags = stream.get("tags", {})
                disposition = stream.get("disposition", {})
                title = (
                    _clean_track_value(tags.get("title", ""))
                    or _clean_track_value(tags.get("handler_name", ""))
                    or _clean_track_value(tags.get("HANDLER_NAME", ""))
                )
                language = _normalize_language_code(tags.get("language", ""))
                forced = disposition.get("forced", 0) == 1
                default = disposition.get("default", 0) == 1
                hearing_impaired = disposition.get("hearing_impaired", 0) == 1
                comment = disposition.get("comment", 0) == 1
                captions = disposition.get("captions", 0) == 1
                source = "embedded" if language else "inband_unknown"
                subtitle_url = (
                    f"/api/subtitle?path={quote(path, safe='')}&index={subtitle_index}"
                    f"{'&local=true' if is_local else ''}"
                )
                label = _build_subtitle_label(
                    language=language,
                    title=title,
                    index=subtitle_index,
                    filename=path,
                    src=subtitle_url,
                    forced=forced,
                    default=default,
                    hearing_impaired=hearing_impaired,
                    comment=comment,
                    captions=captions,
                )
                if source == "embedded" and embedded_status_snapshot is None:
                    embedded_status_snapshot = await self._get_web_subtitle_source_status(path, is_local)
                items.append({
                    "id": f"{source}:{subtitle_index}",
                    "track_id": _build_subtitle_track_id(
                        source=source,
                        track_index=subtitle_index,
                        stream_index=stream.get("index"),
                        path=path,
                        filename=Path(path).name,
                    ),
                    "source": source,
                    "track_index": subtitle_index,
                    "stream_index": stream.get("index"),
                    "codec": stream.get("codec_name", ""),
                    "url": subtitle_url,
                    "legacy_url": subtitle_url,
                    "src": subtitle_url,
                    "path": path,
                    "media_path": path,
                    "language": language,
                    "title": title,
                    "label": label,
                    "flags": _subtitle_flags(
                        forced=forced,
                        default=default,
                        hearing_impaired=hearing_impaired,
                        comment=comment,
                        captions=captions,
                    ),
                    "forced": forced,
                    "default": default,
                    "hearing_impaired": hearing_impaired,
                    "comment": comment,
                    "captions": captions,
                    "confidence": 0.0,
                    "authoritative_sidecar": False,
                    "authority_mode": authority_mode,
                    "authority_rank": 1,
                    "is_generated_sidecar": False,
                    "requires_source_prefetch": source == "embedded",
                    "initial_status": embedded_status_snapshot.get("status", "idle") if embedded_status_snapshot else "idle",
                    "source_ready": bool(embedded_status_snapshot.get("source_ready")) if embedded_status_snapshot else False,
                    "delivery": "legacy",
                })
                subtitle_index += 1

            for idx, sidecar in enumerate(sidecar_candidates):
                sidecar_url = sidecar.get("url", "")
                sidecar_path = sidecar.get("path", "")
                items.append({
                    "id": f"sidecar:{idx}:{sidecar.get('name', '')}",
                    "track_id": _build_subtitle_track_id(
                        source="sidecar",
                        track_index=idx,
                        path=sidecar_path,
                        filename=sidecar.get("name", ""),
                    ),
                    "source": "sidecar",
                    "track_index": None,
                    "stream_index": None,
                    "codec": Path(sidecar.get("name", "")).suffix.lower().lstrip("."),
                    "url": sidecar_url,
                    "legacy_url": sidecar_url,
                    "path": sidecar_path,
                    "media_path": path,
                    "src": sidecar.get("path", ""),
                    "language": sidecar.get("language", ""),
                    "title": sidecar.get("title", ""),
                    "label": sidecar.get("label")
                    or _build_subtitle_label(
                        language=sidecar.get("language", ""),
                        title=sidecar.get("title", ""),
                        index=idx,
                        filename=sidecar.get("name", ""),
                        src=sidecar.get("path", "") or sidecar_url,
                        forced=sidecar.get("forced", False),
                        default=sidecar.get("default", False),
                        hearing_impaired=sidecar.get("hearing_impaired", False),
                        comment=sidecar.get("comment", False),
                        captions=sidecar.get("captions", False),
                    ),
                    "flags": _subtitle_flags(
                        forced=sidecar.get("forced", False),
                        default=sidecar.get("default", False),
                        hearing_impaired=sidecar.get("hearing_impaired", False),
                        comment=sidecar.get("comment", False),
                        captions=sidecar.get("captions", False),
                    ),
                    "forced": sidecar.get("forced", False),
                    "default": sidecar.get("default", False),
                    "hearing_impaired": sidecar.get("hearing_impaired", False),
                    "comment": sidecar.get("comment", False),
                    "captions": sidecar.get("captions", False),
                    "confidence": sidecar.get("confidence", 0.0),
                    "match_score": sidecar.get("match_score", 0),
                    "match_reason": str(sidecar.get("match_reason", "") or "").strip(),
                    "scope_kind": str(sidecar.get("scope_kind", "") or "").strip(),
                    "auto_match": bool(sidecar.get("auto_match", False)),
                    "authoritative_sidecar": bool(sidecar.get("authoritative_sidecar", False)),
                    "generated_group_id": str(sidecar.get("generated_group_id", "") or "").strip(),
                    "source_track_index": sidecar.get("source_track_index"),
                    "source_codec": str(sidecar.get("source_codec", "") or "").strip(),
                    "authority_mode": authority_mode,
                    "authority_rank": 0 if sidecar.get("authoritative_sidecar", False) else 1,
                    "is_generated_sidecar": bool(sidecar.get("authoritative_sidecar", False)),
                    "delivery": "legacy",
                })
            items = self._suppress_shadowed_embedded_candidates(items)
            logger.info(
                "🎬 Subtitle candidate payload ready: trace=%s items=%s probe_input_kind=%s source_counts=%s scope_counts=%s",
                subtitle_trace,
                len(items),
                probe_input_kind,
                dict(Counter(str(item.get("source") or "unknown") for item in items)),
                dict(Counter(str(item.get("scope_kind") or "unknown") for item in items if str(item.get("scope_kind") or "").strip())),
            )
            return items, probe_input_kind
        finally:
            if is_concat and input_path:
                try:
                    os.unlink(input_path)
                except Exception:
                    pass

    def _suppress_shadowed_embedded_candidates(self, items: list[dict]) -> list[dict]:
        authoritative_track_indexes = {
            int(track_index)
            for track_index in (
                item.get("source_track_index")
                for item in items
                if item.get("source") == "sidecar" and item.get("authoritative_sidecar")
            )
            if isinstance(track_index, int) or (isinstance(track_index, str) and str(track_index).isdigit())
        }

        filtered_items = []
        for item in items:
            if item.get("source") == "embedded":
                track_index = item.get("track_index")
                if (
                    authoritative_track_indexes
                    and (isinstance(track_index, int) or (isinstance(track_index, str) and str(track_index).isdigit()))
                    and int(track_index) in authoritative_track_indexes
                ):
                    continue
            filtered_items.append(item)

        def _sort_key(candidate: dict) -> tuple[int, int, str]:
            base = _build_subtitle_authority_sort_key(candidate)
            return (base[1], base[2], base[3])

        return sorted(filtered_items, key=_sort_key)

    async def _resolve_video_subtitle_authority(self, video_path: str, is_local: bool, file_doc: dict | None = None) -> dict:
        normalized_path = self._db._normalize_path(video_path) if getattr(self, "_db", None) else str(video_path or "")
        if is_local:
            return {
                "mode": "mixed_legacy",
                "video_doc": None,
                "generated_group_id": "",
                "expected_generated_sidecars": [],
                "has_externalized_flag": False,
                "reason": "local_file_without_persisted_metadata",
                "video_path": normalized_path,
            }

        resolved_doc = file_doc if file_doc is not None else await self._db.get_file(normalized_path)
        meta = (resolved_doc or {}).get("meta") or {}
        expected_generated_sidecars = meta.get("generated_subtitle_files") or []
        has_externalized_flag = bool(meta.get("subtitles_externalized_on_upload"))
        generated_group_id = str(meta.get("generated_group_id") or "").strip()

        if has_externalized_flag:
            return {
                "mode": "externalized_sidecar_authoritative",
                "video_doc": resolved_doc,
                "generated_group_id": generated_group_id,
                "expected_generated_sidecars": expected_generated_sidecars,
                "has_externalized_flag": True,
                "reason": "video_marked_externalized_on_upload",
                "video_path": normalized_path,
            }

        return {
            "mode": "mixed_legacy",
            "video_doc": resolved_doc,
            "generated_group_id": generated_group_id,
            "expected_generated_sidecars": expected_generated_sidecars,
            "has_externalized_flag": False,
            "reason": "legacy_or_unclassified_video",
            "video_path": normalized_path,
        }

    def _build_web_playback_session_subtitle_track(self, session: dict, candidate: dict) -> dict:
        track_id = str(candidate.get("track_id") or candidate.get("id") or "").strip()
        session_id = str(session.get("id") or "").strip()
        legacy_url = str(candidate.get("legacy_url") or candidate.get("url") or "").strip()
        return {
            **candidate,
            "track_id": track_id,
            "session_id": session_id,
            "delivery": "hls_session",
            "subtitleSourceMode": "hls_session",
            "subtitle_timebase": "session",
            "subtitleTimebase": "session",
            "timebase": "session",
            "timeline_offset_seconds": float(session.get("start_seconds") or 0.0),
            "source_timebase": "media_zero",
            "legacy_url": legacy_url,
            "url": legacy_url,
            "src": legacy_url or candidate.get("src", ""),
            "hls_playlist_url": self._build_web_playback_subtitle_playlist_path(session_id, track_id) if session_id and track_id else "",
        }

    async def _build_web_playback_session_subtitle_tracks(
        self,
        raw_path: str,
        *,
        is_local: bool,
        session_id: str,
    ) -> list[dict]:
        items, _ = await self._gather_subtitle_candidates(raw_path, is_local)
        session = self._web_playback_sessions.get(session_id) or {}
        tracks = []
        for candidate in items:
            if candidate.get("source") not in ("embedded", "sidecar"):
                continue
            tracks.append(self._build_web_playback_session_subtitle_track(session, candidate))
        return tracks

    def _get_web_playback_subtitle_track(self, session: dict, track_id: str) -> dict | None:
        normalized_track_id = str(track_id or "").strip()
        for track in session.get("subtitle_tracks") or []:
            if str(track.get("track_id") or "").strip() == normalized_track_id:
                return track
        return None

    async def _get_sidecar_webvtt_text(self, raw_path: str, is_local: bool) -> str:
        subtitle_bytes = await self._read_sidecar_subtitle_bytes(raw_path, is_local)
        if subtitle_bytes is None:
            raise FileNotFoundError(raw_path)
        suffix = Path(raw_path).suffix.lower()
        subtitle_text = _decode_subtitle_utf8(subtitle_bytes)
        return _convert_subtitle_to_webvtt(subtitle_text, suffix)

    async def _ensure_embedded_subtitle_webvtt_cache(
        self,
        raw_path: str,
        *,
        is_local: bool,
        sub_index: int,
        prefer_progressive: bool = True,
    ) -> tuple[Path, str]:
        cache_path = self._build_web_subtitle_cache_path(raw_path, is_local, sub_index)
        if cache_path.exists():
            source_status = await self._get_web_subtitle_source_status(raw_path, is_local)
            return cache_path, str(source_status.get("extraction_mode") or "cached_source")

        async with self._get_web_subtitle_lock(cache_path):
            if cache_path.exists():
                source_status = await self._get_web_subtitle_source_status(raw_path, is_local)
                return cache_path, str(source_status.get("extraction_mode") or "cached_source")

            extraction_mode = "cached_source"
            if prefer_progressive and not is_local:
                source_status = await self._get_web_subtitle_source_status(raw_path, is_local)
                if not source_status.get("source_ready"):
                    progressive_timeout = min(
                        max(20.0, self._web_subtitle_extract_timeout_seconds / 2),
                        60.0,
                    )
                    progressive_input_path = self._build_internal_media_probe_url(raw_path, raw_mode=True)
                    try:
                        self._set_web_subtitle_source_status(
                            raw_path,
                            is_local,
                            "extracting_subtitle_stream",
                            subtitle_index=sub_index,
                        )
                        stdout = await self._extract_embedded_subtitle_webvtt(
                            input_path=progressive_input_path,
                            is_concat=False,
                            sub_index=sub_index,
                            raw_path=raw_path,
                            is_local=is_local,
                            timeout_seconds=progressive_timeout,
                        )
                        if stdout.strip():
                            temp_cache_path = cache_path.with_suffix(".tmp")
                            temp_cache_path.write_bytes(stdout)
                            temp_cache_path.replace(cache_path)
                            extraction_mode = "progressive_stream"
                            self._set_web_subtitle_source_status(
                                raw_path,
                                is_local,
                                "subtitle_ready",
                                subtitle_index=sub_index,
                                extraction_mode=extraction_mode,
                                subtitle_timebase="media_zero",
                                subtitle_cache_key=self._build_web_subtitle_cache_key(raw_path, is_local, sub_index),
                            )
                            return cache_path, extraction_mode
                    except Exception as progressive_exc:
                        error_code, error_message = self._describe_web_subtitle_source_exception(progressive_exc)
                        self._set_web_subtitle_source_status(
                            raw_path,
                            is_local,
                            "stream_extract_fallback",
                            subtitle_index=sub_index,
                            error_code=error_code,
                            error_message=error_message,
                        )

            input_path, is_concat = await self._materialize_embedded_subtitle_input(raw_path, is_local)
            if not input_path:
                raise FileNotFoundError(raw_path)

            self._set_web_subtitle_source_status(raw_path, is_local, "extracting_subtitle", subtitle_index=sub_index)
            stdout = await self._extract_embedded_subtitle_webvtt(
                input_path=input_path,
                is_concat=is_concat,
                sub_index=sub_index,
                raw_path=raw_path,
                is_local=is_local,
            )
            if not stdout.strip():
                raise RuntimeError("Subtitle extraction returned empty output")

            temp_cache_path = cache_path.with_suffix(".tmp")
            temp_cache_path.write_bytes(stdout)
            temp_cache_path.replace(cache_path)
            self._set_web_subtitle_source_status(
                raw_path,
                is_local,
                "subtitle_ready",
                subtitle_index=sub_index,
                extraction_mode=extraction_mode,
                subtitle_timebase="media_zero",
                subtitle_cache_key=self._build_web_subtitle_cache_key(raw_path, is_local, sub_index),
            )
            return cache_path, extraction_mode

    async def _load_canonical_subtitle_webvtt(
        self,
        track: dict,
        *,
        session: dict,
    ) -> tuple[str, dict]:
        source = str(track.get("source") or "").strip()
        if source == "sidecar":
            sidecar_path = str(track.get("path") or "").strip()
            if not sidecar_path:
                raise FileNotFoundError("Missing sidecar subtitle path")
            return await self._get_sidecar_webvtt_text(sidecar_path, bool(session.get("is_local"))), {
                "generation_mode": "sidecar_convert",
                "extraction_mode": "sidecar_convert",
            }

        if source != "embedded":
            raise FileNotFoundError(f"Unsupported subtitle source: {source}")

        track_index = int(track.get("track_index") or 0)
        cache_path, extraction_mode = await self._ensure_embedded_subtitle_webvtt_cache(
            str(session.get("raw_path") or ""),
            is_local=bool(session.get("is_local")),
            sub_index=track_index,
            prefer_progressive=True,
        )
        return cache_path.read_text(encoding="utf-8", errors="ignore"), {
            "generation_mode": "cached_vtt",
            "extraction_mode": extraction_mode,
            "cache_path": str(cache_path),
        }

    def _get_web_playback_subtitle_generation_lock(self, session: dict, track_id: str) -> asyncio.Lock:
        locks = session.setdefault("subtitle_generation_locks", {})
        lock = locks.get(track_id)
        if lock is None:
            lock = asyncio.Lock()
            locks[track_id] = lock
        return lock

    def _select_web_playback_subtitle_prewarm_tracks(self, session: dict) -> list[str]:
        tracks = [track for track in (session.get("subtitle_tracks") or []) if str(track.get("track_id") or "").strip()]
        if not tracks:
            return []

        def _priority(track: dict) -> tuple[int, int, int, int, str]:
            language = _normalize_language_code(track.get("language", ""))
            source = str(track.get("source") or "").strip().lower()
            return (
                0 if track.get("default") else 1,
                0 if track.get("forced") else 1,
                0 if language in {"pt", "pt-br", "por"} else 1,
                0 if source == "sidecar" else 1,
                str(track.get("label") or track.get("track_id") or ""),
            )

        ordered_tracks = sorted(tracks, key=_priority)
        max_tracks = 1 if ordered_tracks else 0
        return [str(track.get("track_id") or "").strip() for track in ordered_tracks[:max_tracks]]

    def _schedule_web_playback_subtitle_prewarm(self, session_id: str, track_ids: list[str] | None = None) -> None:
        session = self._web_playback_sessions.get(session_id)
        if not session:
            return
        if str(session.get("subtitle_delivery_mode") or "off").strip().lower() == "off":
            return

        existing_task = session.get("subtitle_prewarm_task")
        if existing_task and not existing_task.done():
            return

        selected_track_ids = [
            str(track_id or "").strip()
            for track_id in (track_ids or self._select_web_playback_subtitle_prewarm_tracks(session))
            if str(track_id or "").strip()
        ]
        if not selected_track_ids:
            return

        async def _runner(expected_track_ids: list[str]) -> None:
            try:
                logger.info(
                    "🎬 Scheduling HLS subtitle prewarm: session=%s tracks=%s",
                    session_id,
                    expected_track_ids,
                )
                for current_track_id in expected_track_ids:
                    current_session = self._web_playback_sessions.get(session_id)
                    if not current_session or current_session.get("status") in {"closed", "retired"}:
                        return
                    try:
                        await self._ensure_web_playback_subtitle_track_ready(session_id, current_track_id)
                    except asyncio.CancelledError:
                        raise
                    except FileNotFoundError:
                        logger.debug(
                            "subtitle prewarm skipped missing track: session=%s track=%s",
                            session_id,
                            current_track_id,
                        )
                    except Exception as exc:
                        logger.warning(
                            "🎬 Failed to prewarm HLS subtitle track: session=%s track=%s error=%s",
                            session_id,
                            current_track_id,
                            exc,
                        )
            finally:
                current_session = self._web_playback_sessions.get(session_id)
                if current_session and current_session.get("subtitle_prewarm_task") is asyncio.current_task():
                    current_session["subtitle_prewarm_task"] = None

        session["subtitle_prewarm_task"] = asyncio.create_task(_runner(selected_track_ids))

    async def _ensure_web_playback_subtitle_track_ready(self, session_id: str, track_id: str) -> tuple[dict, dict, Path]:
        session = self._web_playback_sessions.get(session_id)
        if not session:
            raise FileNotFoundError(f"Session not found: {session_id}")

        track = self._get_web_playback_subtitle_track(session, track_id)
        if not track:
            raise FileNotFoundError(f"Subtitle track not found: {track_id}")

        track_dir = (session.get("subtitle_dir") or (session.get("temp_dir") / "subtitles")) / track_id
        playlist_path = track_dir / "playlist.m3u8"
        if playlist_path.exists():
            return session, track, playlist_path

        async with self._get_web_playback_subtitle_generation_lock(session, track_id):
            if playlist_path.exists():
                return session, track, playlist_path

            generation_started_at = time.time()
            track_dir.mkdir(parents=True, exist_ok=True)
            for existing_asset in track_dir.glob("*"):
                try:
                    if existing_asset.is_file():
                        existing_asset.unlink()
                except Exception:
                    pass

            canonical_webvtt, metadata = await self._load_canonical_subtitle_webvtt(track, session=session)
            cues = _parse_webvtt_cues(canonical_webvtt)
            segment_duration = max(2, int(session.get("subtitle_segment_duration") or self._web_playback_hls_subtitle_segment_duration))
            start_seconds = max(0.0, float(session.get("start_seconds") or 0.0))
            source_duration_seconds = session.get("duration_seconds")
            if isinstance(source_duration_seconds, (int, float)):
                relative_duration = max(0.0, float(source_duration_seconds) - start_seconds)
            else:
                relative_duration = 0.0

            segment_payloads: dict[int, list[dict]] = {}
            last_relative_end = 0.0
            discarded_before_offset = 0
            first_relative_cue_start: float | None = None
            for cue in cues:
                cue_start = float(cue.get("start") or 0.0) - start_seconds
                cue_end = float(cue.get("end") or 0.0) - start_seconds
                if cue_end <= 0:
                    discarded_before_offset += 1
                    continue
                cue_start = max(0.0, cue_start)
                cue_end = max(cue_end, cue_start + 0.001)
                if first_relative_cue_start is None:
                    first_relative_cue_start = cue_start
                last_relative_end = max(last_relative_end, cue_end)
                first_segment_index = int(cue_start // segment_duration)
                last_segment_index = int(max(cue_start, cue_end - 0.001) // segment_duration)
                for segment_index in range(first_segment_index, last_segment_index + 1):
                    segment_start = segment_index * segment_duration
                    segment_end = segment_start + segment_duration
                    clipped_start = max(cue_start, segment_start) - segment_start
                    clipped_end = min(cue_end, segment_end) - segment_start
                    if clipped_end <= clipped_start:
                        continue
                    segment_payloads.setdefault(segment_index, []).append({
                        "id": cue.get("id", ""),
                        "start": clipped_start,
                        "end": clipped_end,
                        "settings": cue.get("settings", ""),
                        "payload": cue.get("payload") or [""],
                    })

            total_duration = relative_duration if relative_duration > 0 else last_relative_end
            segment_count = max(1, int(math.ceil(max(total_duration, 0.001) / segment_duration)))
            playlist_lines = [
                "#EXTM3U",
                "#EXT-X-VERSION:3",
                "#EXT-X-PLAYLIST-TYPE:VOD",
                f"#EXT-X-TARGETDURATION:{segment_duration}",
                "#EXT-X-MEDIA-SEQUENCE:0",
            ]

            for segment_index in range(segment_count):
                segment_start = segment_index * segment_duration
                if total_duration > 0:
                    declared_duration = min(segment_duration, max(total_duration - segment_start, 0.0))
                else:
                    declared_duration = segment_duration
                if declared_duration <= 0:
                    declared_duration = segment_duration
                asset_name = f"segment_{segment_index:05d}.vtt"
                (track_dir / asset_name).write_text(
                    _build_webvtt_segment_text(segment_payloads.get(segment_index, []), segment_start),
                    encoding="utf-8",
                )
                playlist_lines.append(f"#EXTINF:{declared_duration:.3f},")
                playlist_lines.append(asset_name)

            playlist_lines.append("#EXT-X-ENDLIST")
            playlist_path.write_text("\n".join(playlist_lines) + "\n", encoding="utf-8")

            track["generation_mode"] = metadata.get("generation_mode", "")
            track["extraction_mode"] = metadata.get("extraction_mode", "")
            track["segment_count"] = segment_count
            track["generated_at"] = time.time()
            track["first_segment_ready_ms"] = max(0, int((track["generated_at"] - generation_started_at) * 1000))
            track["first_relative_cue_start"] = first_relative_cue_start
            track["timeline_offset_seconds"] = start_seconds
            track["subtitle_timebase"] = "session"

            logger.info(
                "🎬 HLS subtitle track ready: session=%s track=%s source=%s mode=%s extraction=%s start_seconds=%.3f discarded_before_offset=%s first_relative_cue_start=%s segments=%s first_segment_ready_ms=%s",
                session_id,
                track_id,
                track.get("source", ""),
                track.get("generation_mode", ""),
                track.get("extraction_mode", ""),
                start_seconds,
                discarded_before_offset,
                first_relative_cue_start,
                segment_count,
                track.get("first_segment_ready_ms", 0),
            )
        return session, track, playlist_path

    async def _resolve_related_subtitle_directories(self, video_path: str, is_local: bool) -> list[dict]:
        video_name = Path(video_path).name
        video_stem = _video_stem_for_sidecar_matching(video_path)
        related_names = set(_related_subtitle_directory_names())
        directories: list[dict] = []
        seen_paths: set[str] = set()

        def _register(path_value: str, scope_kind: str, reason: str) -> None:
            normalized = str(path_value or "").strip()
            if not normalized or normalized in seen_paths:
                return
            seen_paths.add(normalized)
            directories.append({
                "path": normalized,
                "scope_kind": scope_kind,
                "reason": reason,
            })
            logger.debug(
                "🎬 Subtitle directory registered: path=%s local=%s scope=%s reason=%s video=%s",
                normalized,
                is_local,
                scope_kind,
                reason,
                video_name,
            )

        if is_local:
            parent_dir = Path(video_path).parent
            if not parent_dir.exists():
                # Fallback: maybe the server is running relative to project root
                # OR it's a virtual path starting with /
                server_root = Path.cwd()
                relative_path = str(video_path).lstrip("/")
                alt_parent = (server_root / relative_path).parent
                if alt_parent.exists():
                    parent_dir = alt_parent
                    logger.debug(f"[TCloud] Local path resolved via relative fallback: {parent_dir}")
                else:
                    return []
            
            _register(str(parent_dir), "same_dir", "video_parent")
            
            # Use iterdir for local
            try:
                # Use parent_dir from above
                entries = sorted(parent_dir.iterdir(), key=lambda entry: entry.name.lower())
            except Exception:
                return directories

            for entry in entries:
                if not entry.is_dir():
                    continue
                normalized_name = _strip_accents(entry.name.lower())
                if normalized_name in related_names:
                    _register(str(entry), "related_subdir", "canonical_subtitle_dir")
                elif _directory_name_matches_video(video_name, entry.name):
                    _register(str(entry), "video_scoped_dir", "video_named_dir")
                    try:
                        nested_entries = sorted(entry.iterdir(), key=lambda child: child.name.lower())
                    except Exception:
                        nested_entries = []
                    for child in nested_entries:
                        if not child.is_dir():
                            continue
                        if _strip_accents(child.name.lower()) in related_names:
                            _register(str(child), "video_scoped_related_subdir", "video_named_canonical_subdir")
            return directories

        parent = str(Path(video_path).parent)
        if parent in ("", "."):
            parent = "/"
        _register(parent, "same_dir", "video_parent")

        try:
            parent_entries = await self._file_manager.list_directory(parent)
        except Exception:
            return directories

        for item in parent_entries:
            if not item.get("is_directory"):
                continue
            directory_path = item.get("path", "")
            directory_name = item.get("name", "")
            normalized_name = _strip_accents(directory_name.lower())
            if normalized_name in related_names:
                _register(directory_path, "related_subdir", "canonical_subtitle_dir")
            elif _directory_name_matches_video(video_name, directory_name):
                _register(directory_path, "video_scoped_dir", "video_named_dir")
                try:
                    nested_entries = await self._file_manager.list_directory(directory_path)
                except Exception:
                    nested_entries = []
                for child in nested_entries:
                    if not child.get("is_directory"):
                        continue
                    child_name = str(child.get("name", "") or "")
                    if _strip_accents(child_name.lower()) in related_names:
                        _register(child.get("path", ""), "video_scoped_related_subdir", "video_named_canonical_subdir")

        return directories

    async def _discover_sidecar_subtitles(self, video_path: str, is_local: bool) -> list[dict]:
        video_name = Path(video_path).name
        candidates = []
        seen_paths = set()
        directory_specs = await self._resolve_related_subtitle_directories(video_path, is_local)
        logger.info(
            "🎬 Subtitle discovery start: path=%s local=%s directories=%s",
            video_path,
            is_local,
            [
                {
                    "path": str(spec.get("path", "")),
                    "scope_kind": str(spec.get("scope_kind", "")),
                    "reason": str(spec.get("reason", "")),
                }
                for spec in directory_specs
            ],
        )

        if is_local:
            for directory_spec in directory_specs:
                directory_path = Path(directory_spec["path"])
                if not directory_path.exists():
                    continue
                try:
                    entries = sorted(directory_path.iterdir(), key=lambda entry: entry.name.lower())
                except Exception:
                    continue

                for entry in entries:
                    if not entry.is_file():
                        continue
                    suffix = Path(entry.name).suffix.lower()
                    if suffix not in SUBTITLE_EXTENSIONS:
                        continue
                    full_path = str(entry)
                    if full_path in seen_paths:
                        continue
                    metadata = _parse_sidecar_metadata(video_name, entry.name, scope_kind=directory_spec["scope_kind"])
                    discovery_reason = "accepted_parsed_match"
                    if not metadata:
                        metadata = _build_same_folder_sidecar_fallback_metadata(
                            video_name,
                            entry.name,
                            scope_kind=directory_spec["scope_kind"],
                        )
                        discovery_reason = "accepted_basename_fallback" if metadata else "rejected_no_sidecar_match"
                    if not metadata:
                        logger.debug(
                            "[Subtitle] sidecar candidate rejected: video=%s subtitle=%s scope=%s reason=%s local=%s",
                            video_name,
                            entry.name,
                            directory_spec["scope_kind"],
                            discovery_reason,
                            True,
                        )
                        continue
                    generated_track_index = _extract_generated_sidecar_track_index(video_path, entry.name)
                    metadata.setdefault("match_score", 100 if generated_track_index is not None else 0)
                    metadata.setdefault("match_reason", "generated_track_pattern" if generated_track_index is not None else "")
                    metadata.setdefault("scope_kind", directory_spec["scope_kind"])
                    metadata.setdefault("auto_match", True)
                    logger.debug(
                        "[Subtitle] sidecar candidate accepted: video=%s subtitle=%s scope=%s reason=%s local=%s",
                        video_name,
                        entry.name,
                        directory_spec["scope_kind"],
                        "accepted_generated_authoritative" if generated_track_index is not None else discovery_reason,
                        True,
                    )
                    candidate = {
                        "name": entry.name,
                        "path": full_path,
                        "url": _build_sidecar_subtitle_url(full_path, True)
                        if suffix in UTF8_WEBVTT_SIDECAR_EXTENSIONS
                        else f"/stream{quote(full_path, safe='/')}?local=true",
                        "authoritative_sidecar": generated_track_index is not None,
                        "source_track_index": generated_track_index,
                        **metadata,
                    }
                    candidate = await self._refine_sidecar_candidate_language(candidate, is_local=True)
                    candidates.append(candidate)
                    seen_paths.add(full_path)
            sorted_candidates = sorted(candidates, key=_build_subtitle_authority_sort_key)
            logger.info(
                "🎬 Subtitle discovery complete: path=%s local=%s candidates=%s",
                video_path,
                is_local,
                len(sorted_candidates),
            )
            return sorted_candidates

        for directory_spec in directory_specs:
            try:
                entries = await self._file_manager.list_directory(directory_spec["path"])
            except Exception:
                continue

            for item in entries:
                if item.get("is_directory"):
                    continue
                item_path = item.get("path", "")
                name = item.get("name", "")
                if not item_path or item_path in seen_paths:
                    continue
                suffix = Path(name).suffix.lower()
                if suffix not in SUBTITLE_EXTENSIONS:
                    continue

                generated_metadata = _build_generated_sidecar_metadata(video_path, item)
                if generated_metadata:
                    generated_metadata.setdefault("match_score", 100)
                    generated_metadata.setdefault("match_reason", "authoritative_generated_sidecar")
                    generated_metadata.setdefault("scope_kind", directory_spec["scope_kind"])
                    generated_metadata.setdefault("auto_match", True)
                    candidate = {
                        "name": name,
                        "path": item_path,
                        "url": _build_sidecar_subtitle_url(item_path, False)
                        if suffix in UTF8_WEBVTT_SIDECAR_EXTENSIONS
                        else f"/stream{quote(item_path, safe='/')}",
                        **generated_metadata,
                    }
                    candidate = await self._refine_sidecar_candidate_language(candidate, is_local=False)
                    candidates.append(candidate)
                    logger.debug(
                        "[Subtitle] sidecar candidate accepted: video=%s subtitle=%s scope=%s reason=%s local=%s",
                        video_name,
                        name,
                        directory_spec["scope_kind"],
                        "accepted_generated_authoritative",
                        False,
                    )
                    seen_paths.add(item_path)
                    continue

                metadata = _parse_sidecar_metadata(video_name, name, scope_kind=directory_spec["scope_kind"])
                discovery_reason = "accepted_parsed_match"
                if not metadata:
                    metadata = _build_same_folder_sidecar_fallback_metadata(
                        video_name,
                        name,
                        scope_kind=directory_spec["scope_kind"],
                    )
                    discovery_reason = "accepted_basename_fallback" if metadata else "rejected_no_sidecar_match"
                if not metadata:
                    logger.debug(
                        "[Subtitle] sidecar candidate rejected: video=%s subtitle=%s scope=%s reason=%s local=%s",
                        video_name,
                        name,
                        directory_spec["scope_kind"],
                        discovery_reason,
                        False,
                    )
                    continue
                logger.debug(
                    "[Subtitle] sidecar candidate accepted: video=%s subtitle=%s scope=%s reason=%s local=%s",
                    video_name,
                    name,
                    directory_spec["scope_kind"],
                    discovery_reason,
                    False,
                )
                candidate = {
                    "name": name,
                    "path": item_path,
                    "url": _build_sidecar_subtitle_url(item_path, False)
                    if suffix in UTF8_WEBVTT_SIDECAR_EXTENSIONS
                    else f"/stream{quote(item_path, safe='/')}",
                    **metadata,
                }
                candidate = await self._refine_sidecar_candidate_language(candidate, is_local=False)
                candidates.append(candidate)
                seen_paths.add(item_path)

        sorted_candidates = sorted(candidates, key=_build_subtitle_authority_sort_key)
        logger.info(
            "🎬 Subtitle discovery complete: path=%s local=%s candidates=%s",
            video_path,
            is_local,
            len(sorted_candidates),
        )
        return sorted_candidates

    async def _handle_api_subtitle_candidates(self, request):
        path = request.query.get("path")
        is_local = request.query.get("local") == "true"
        if not path:
            return web.json_response({"error": "path is required"}, status=400)
        probe_started_at = time.time()

        try:
            items, probe_input_kind = await self._gather_subtitle_candidates(path, is_local)
            source_counts: dict[str, int] = {}
            for item in items:
                source = str(item.get("source") or "unknown")
                source_counts[source] = source_counts.get(source, 0) + 1
            same_dir_count = sum(1 for item in items if str(item.get("scope_kind") or "") == "same_dir")
            match_reasons = sorted({
                str(item.get("match_reason") or "").strip()
                for item in items
                if str(item.get("match_reason") or "").strip()
            })

            logger.info(
                "🎬 Subtitle candidate probe result: path=%s local=%s items=%s input=%s same_dir=%s sources=%s reasons=%s elapsed_ms=%s",
                path,
                is_local,
                len(items),
                probe_input_kind,
                same_dir_count,
                source_counts,
                match_reasons,
                max(0, int((time.time() - probe_started_at) * 1000)),
            )
            if not is_local and any(item.get("source") == "embedded" for item in items):
                self._schedule_embedded_subtitle_source_prefetch(path, is_local)
            return web.json_response({"items": items})
        except asyncio.TimeoutError:
            return web.json_response({"items": []})
        except Exception as e:
            logger.error(f"Subtitle candidates error: {e}", exc_info=True)
            return web.json_response({"items": []})

    async def _handle_api_media_tracks(self, request):
        """Return audio and subtitle tracks for a media file using ffprobe."""
        path = request.query.get("path")
        is_local = request.query.get("local") == "true"
        if not path:
            return web.json_response({"error": "path is required"}, status=400)

        try:
            probe_started_at = time.time()
            input_path, is_concat = await self._get_file_input_path(path, is_local)
            if not input_path:
                return web.json_response({"audio": [], "subtitle": []})

            probe_data, _ = await self._probe_ffprobe_metadata(input_path, is_concat)
            streams = probe_data.get('streams', [])
            if not streams:
                return web.json_response({"audio": [], "subtitle": []})

            audio_tracks = []
            subtitle_tracks = []
            audio_idx = 0
            sub_idx = 0

            for s in streams:
                codec_type = s.get('codec_type')
                tags = s.get('tags', {})
                disposition = s.get('disposition', {})
                lang = _normalize_language_code(tags.get('language', ''))
                title = (
                    _clean_track_value(tags.get('title', ''))
                    or _clean_track_value(tags.get('handler_name', ''))
                    or _clean_track_value(tags.get('HANDLER_NAME', ''))
                )

                if codec_type == 'audio':
                    label = _build_audio_label(
                        language=lang,
                        title=title,
                        index=audio_idx,
                    )
                    audio_tracks.append({
                        'index': audio_idx,
                        'stream_index': s.get('index'),
                        'codec': s.get('codec_name', ''),
                        'language': lang,
                        'title': title,
                        'label': label,
                        'channels': s.get('channels', 0),
                        'default': disposition.get('default', 0) == 1
                    })
                    audio_idx += 1

                elif codec_type == 'subtitle':
                    lang = _normalize_language_code(tags.get('language', ''))

                    forced = disposition.get('forced', 0) == 1
                    default = disposition.get('default', 0) == 1
                    hearing_impaired = disposition.get('hearing_impaired', 0) == 1
                    comment = disposition.get('comment', 0) == 1
                    captions = disposition.get('captions', 0) == 1
                    label = _build_subtitle_label(
                        language=lang,
                        title=title,
                        index=sub_idx,
                        filename=path,
                        src=f"/api/subtitle?path={quote(path, safe='')}&index={sub_idx}{'&local=true' if is_local else ''}",
                        forced=forced,
                        default=default,
                        hearing_impaired=hearing_impaired,
                        comment=comment,
                        captions=captions,
                    )

                    subtitle_tracks.append({
                        'index': sub_idx,
                        'stream_index': s.get('index'),
                        'codec': s.get('codec_name', ''),
                        'src': f"/api/subtitle?path={quote(path, safe='')}&index={sub_idx}{'&local=true' if is_local else ''}",
                        'language': lang,
                        'title': title,
                        'label': label,
                        'forced': forced,
                        'default': default,
                        'hearing_impaired': hearing_impaired,
                        'comment': comment,
                        'captions': captions,
                    })
                    sub_idx += 1

            # Cleanup temp concat file only after all optional subtitle probing is done.
            if is_concat:
                try:
                    os.unlink(input_path)
                except Exception:
                    pass

            try:
                self._schedule_audio_variant_prewarm(
                    path,
                    is_local=is_local,
                    audio_tracks=audio_tracks,
                    file_meta=None if is_local else await self._file_manager.get_file_meta(path),
                )
            except Exception:
                logger.debug("Audio variant prewarm scheduling skipped", exc_info=True)

            logger.info(
                "🎬 Media tracks probe result: path=%s local=%s audio=%s subtitle=%s input=%s elapsed_ms=%s",
                path,
                is_local,
                len(audio_tracks),
                len(subtitle_tracks),
                "concat" if is_concat else ("url" if input_path.startswith("http") else "path"),
                max(0, int((time.time() - probe_started_at) * 1000)),
            )
            return web.json_response({
                'audio': audio_tracks,
                'subtitle': subtitle_tracks
            })

        except asyncio.TimeoutError:
            return web.json_response({"audio": [], "subtitle": []})
        except Exception as e:
            logger.error(f"Media tracks error: {e}", exc_info=True)
            return web.json_response({"error": str(e)}, status=500)


    async def _handle_api_subtitle(self, request):
        """Extract a subtitle track as WebVTT."""
        path = request.query.get("path")
        is_local = request.query.get("local") == "true"
        is_sidecar = request.query.get("sidecar") == "true"
        is_prefetch = request.query.get("prefetch_source") == "true"
        index = request.query.get("index", "0")
        if not path:
            return web.json_response({"error": "path is required"}, status=400)

        if is_prefetch:
            self._schedule_embedded_subtitle_source_prefetch(path, is_local)
            return web.json_response(await self._get_web_subtitle_source_status(path, is_local), status=202)

        # Optimization: if the file extension is a known subtitle type, treat it as sidecar
        # even if the sidecar=true flag is missing (common with native MP4 playback).
        if not is_sidecar:
            ext = os.path.splitext(path)[1].lower()
            if ext in ('.srt', '.vtt', '.ass', '.ssa', '.sub'):
                logger.debug(f"File {path} looks like a sidecar subtitle but sidecar=true was missing. Treating as sidecar.")
                is_sidecar = True

        if is_sidecar:
            try:
                return await self._serve_sidecar_subtitle(path, is_local)
            except UnicodeDecodeError:
                return web.Response(text="Subtitle must be UTF-8 encoded", status=415)
            except Exception as e:
                logger.error(f"Sidecar subtitle error: {e}", exc_info=True)
                return web.Response(text=str(e), status=500)

        try:
            sub_index = int(index)
        except ValueError:
            sub_index = 0

        cache_path = self._build_web_subtitle_cache_path(path, is_local, sub_index)
        if cache_path.exists():
            source_status = await self._get_web_subtitle_source_status(path, is_local)
            return self._build_subtitle_http_response(
                cache_path,
                raw_path=path,
                is_local=is_local,
                sub_index=sub_index,
                extraction_mode=source_status.get("extraction_mode", "cached_source"),
            )

        try:
            async with self._get_web_subtitle_lock(cache_path):
                if cache_path.exists():
                    source_status = await self._get_web_subtitle_source_status(path, is_local)
                    return self._build_subtitle_http_response(
                        cache_path,
                        raw_path=path,
                        is_local=is_local,
                        sub_index=sub_index,
                        extraction_mode=source_status.get("extraction_mode", "cached_source"),
                    )

                if not is_local:
                    source_status = await self._get_web_subtitle_source_status(path, is_local)
                    if not source_status.get("source_ready"):
                        progressive_timeout = min(
                            max(30.0, self._web_subtitle_extract_timeout_seconds),
                            90.0,
                        )
                        progressive_input_path = self._build_internal_media_probe_url(path, raw_mode=True)
                        try:
                            self._set_web_subtitle_source_status(
                                path,
                                is_local,
                                "extracting_subtitle_stream",
                                subtitle_index=sub_index,
                            )
                            logger.info(
                                "🎬 Starting progressive subtitle extraction: path=%s index=%s timeout_s=%s",
                                path,
                                sub_index,
                                progressive_timeout,
                            )
                            stdout = await self._extract_embedded_subtitle_webvtt(
                                input_path=progressive_input_path,
                                is_concat=False,
                                sub_index=sub_index,
                                raw_path=path,
                                is_local=is_local,
                                timeout_seconds=progressive_timeout,
                            )
                            if stdout.strip():
                                temp_cache_path = cache_path.with_suffix(".tmp")
                                temp_cache_path.write_bytes(stdout)
                                temp_cache_path.replace(cache_path)
                                self._set_web_subtitle_source_status(
                                    path,
                                    is_local,
                                    "subtitle_ready",
                                    subtitle_index=sub_index,
                                    extraction_mode="progressive_stream",
                                    subtitle_timebase="media_zero",
                                    subtitle_cache_key=self._build_web_subtitle_cache_key(path, is_local, sub_index),
                                )
                                logger.info(
                                    "🎬 Subtitle extraction served from progressive stream: path=%s index=%s timeout_s=%s",
                                    path,
                                    sub_index,
                                    progressive_timeout,
                                )
                                return self._build_subtitle_http_response(
                                    cache_path,
                                    raw_path=path,
                                    is_local=is_local,
                                    sub_index=sub_index,
                                    extraction_mode="progressive_stream",
                                )
                        except Exception as progressive_exc:
                            error_code, error_message = self._describe_web_subtitle_source_exception(progressive_exc)
                            self._set_web_subtitle_source_status(
                                path,
                                is_local,
                                "stream_extract_fallback",
                                subtitle_index=sub_index,
                                error_code=error_code,
                                error_message=error_message,
                            )
                            logger.info(
                                "🎬 Progressive subtitle extraction failed, falling back to cached source: path=%s index=%s reason=%s",
                                path,
                                sub_index,
                                error_message,
                            )

                input_path, is_concat = await self._materialize_embedded_subtitle_input(path, is_local)
                if not input_path:
                    return web.Response(text="File not available for subtitle extraction", status=404)

                self._set_web_subtitle_source_status(path, is_local, "extracting_subtitle", subtitle_index=sub_index)
                stdout = await self._extract_embedded_subtitle_webvtt(
                    input_path=input_path,
                    is_concat=is_concat,
                    sub_index=sub_index,
                    raw_path=path,
                    is_local=is_local,
                )
                if not stdout.strip():
                    return web.Response(text="Subtitle extraction returned empty output", status=500)

                temp_cache_path = cache_path.with_suffix(".tmp")
                temp_cache_path.write_bytes(stdout)
                temp_cache_path.replace(cache_path)
                self._set_web_subtitle_source_status(
                    path,
                    is_local,
                    "subtitle_ready",
                    subtitle_index=sub_index,
                    extraction_mode="cached_source",
                    subtitle_timebase="media_zero",
                    subtitle_cache_key=self._build_web_subtitle_cache_key(path, is_local, sub_index),
                )

            return self._build_subtitle_http_response(
                cache_path,
                raw_path=path,
                is_local=is_local,
                sub_index=sub_index,
                extraction_mode="cached_source",
            )

        except asyncio.TimeoutError:
            self._set_web_subtitle_source_status(
                path,
                is_local,
                "extract_timeout",
                subtitle_index=sub_index,
                error_code="extract_timeout",
                error_message="Subtitle extraction timed out",
            )
            return web.Response(text="Subtitle extraction timeout", status=504)
        except RuntimeError:
            self._set_web_subtitle_source_status(
                path,
                is_local,
                "extract_failed",
                subtitle_index=sub_index,
                error_code="extract_failed",
                error_message="Subtitle extraction failed",
            )
            return web.Response(text="Subtitle extraction failed", status=500)
        except Exception as e:
            error_code, error_message = self._describe_web_subtitle_source_exception(e)
            self._set_web_subtitle_source_status(
                path,
                is_local,
                "extract_error",
                subtitle_index=sub_index,
                error_code=error_code,
                error_message=error_message,
            )
            logger.error(f"Subtitle error: {e}", exc_info=True)
            return web.Response(text=str(e), status=500)

    async def _handle_api_subtitle_status(self, request):
        path = request.query.get("path")
        is_local = request.query.get("local") == "true"
        if not path:
            return web.json_response({"error": "path is required"}, status=400)

        status_payload = await self._get_web_subtitle_source_status(path, is_local)
        index = request.query.get("index")
        if index is not None:
            try:
                sub_index = int(index)
            except ValueError:
                sub_index = 0
            cache_path = self._build_web_subtitle_cache_path(path, is_local, sub_index)
            status_payload["subtitle_ready"] = cache_path.exists()
            status_payload["subtitle_index"] = sub_index
            status_payload["subtitle_timebase"] = "media_zero"
            status_payload["subtitle_cache_key"] = self._build_web_subtitle_cache_key(path, is_local, sub_index)

        return web.json_response(status_payload)

    async def start(self):
        runner = web.AppRunner(self._app)
        await runner.setup()

        # SSL/TLS support
        ssl_ctx = None
        if Config.SSL_CERT and Config.SSL_KEY:
            ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ssl_ctx.load_cert_chain(Config.SSL_CERT, Config.SSL_KEY)
            logger.info(f"🔒 SSL enabled: cert={Config.SSL_CERT}")

        site = web.TCPSite(runner, Config.HTTP_HOST, Config.HTTP_PORT, ssl_context=ssl_ctx)
        await site.start()

        if not self._web_playback_cleanup_task or self._web_playback_cleanup_task.done():
            self._web_playback_cleanup_task = asyncio.create_task(self._web_playback_cleanup_loop())

        protocol = "https" if ssl_ctx else "http"
        logger.info(
            f"🌐 HTTP streaming server running at "
            f"{protocol}://{Config.HTTP_HOST}:{Config.HTTP_PORT}"
        )
        return runner
