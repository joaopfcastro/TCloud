from __future__ import annotations

from collections import Counter
import re
import unicodedata
from pathlib import Path

PLACEHOLDER_TRACK_VALUES = {
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

AMBIGUOUS_SHORT_LANGUAGE_TOKENS = {
    "as",
    "de",
    "do",
    "el",
    "he",
    "is",
    "it",
    "la",
    "no",
    "se",
    "so",
    "to",
}

_SUBTITLE_CONTENT_SCRIPT_PATTERNS = (
    ("ar", re.compile(r"[\u0600-\u06FF]")),
    ("ko", re.compile(r"[\uAC00-\uD7AF]")),
    ("ja", re.compile(r"[\u3040-\u30FF]")),
    ("zh", re.compile(r"[\u4E00-\u9FFF]")),
    ("ru", re.compile(r"[\u0400-\u04FF]")),
)

_SUBTITLE_CONTENT_HINTS = {
    "pt": {
        "strong": {
            "não", "nao", "uma", "para", "com", "por", "você", "voce", "vocês", "voces",
            "está", "esta", "estão", "estao", "isso", "essa", "esse", "seu", "sua", "seus",
            "suas", "meu", "minha", "também", "tambem", "então", "entao", "foi", "tem",
            "tinha", "onde", "quando", "agora", "aqui", "porque", "obrigado", "obrigada",
        },
        "weak": {"que", "como", "mas", "ele", "ela", "eles", "elas", "pra", "num", "uma"},
        "chars": "ãõçáéíóúâêôà",
    },
    "es": {
        "strong": {
            "una", "para", "pero", "está", "esta", "están", "estan", "usted", "ustedes",
            "eso", "esa", "fue", "tiene", "donde", "cuando", "porque", "también", "tambien",
            "gracias", "hola", "ahora", "muy", "señor", "senor",
        },
        "weak": {"que", "como", "con", "por", "ella", "ellos", "ellas", "esto", "esta"},
        "chars": "ñ¿¡áéíóú",
    },
    "en": {
        "strong": {
            "the", "and", "you", "your", "with", "from", "this", "that", "have", "what",
            "they", "were", "there", "would", "about", "hello", "thanks", "please",
        },
        "weak": {"are", "was", "for", "not", "but", "him", "her", "them", "their"},
        "chars": "",
    },
    "de": {
        "strong": {
            "der", "die", "das", "und", "nicht", "ist", "ich", "wir", "mit", "eine", "einer",
            "einen", "einem", "den", "dem", "des", "für", "fuer", "aber", "danke", "bitte",
        },
        "weak": {"ein", "du", "sie", "auf", "was", "wie", "sein"},
        "chars": "ßäöü",
    },
    "fr": {
        "strong": {
            "une", "avec", "dans", "vous", "nous", "pour", "mais", "bonjour", "merci",
            "être", "etre", "très", "tres", "plus", "quoi", "elle", "elles",
        },
        "weak": {"que", "des", "les", "pas", "est", "comme", "qui"},
        "chars": "àâæçéèêëîïôœùûüÿ",
    },
    "it": {
        "strong": {
            "che", "una", "con", "per", "non", "sono", "sei", "noi", "come", "dove",
            "questo", "questa", "quella", "grazie", "ciao", "adesso", "perché", "perche",
        },
        "weak": {"gli", "della", "delle", "dello", "anche", "più", "piu"},
        "chars": "àèéìíîòóù",
    },
}

_TECHNICAL_TRACK_TOKENS = {
    "aac",
    "ac3",
    "atmos",
    "bluray",
    "brrip",
    "caption",
    "captions",
    "cc",
    "closed",
    "default",
    "dl",
    "dual",
    "dubbed",
    "dub",
    "embedded",
    "forced",
    "handler",
    "handlername",
    "hearing",
    "impaired",
    "hi",
    "hls",
    "mp3",
    "opus",
    "padrao",
    "release",
    "sdh",
    "sidecar",
    "soundhandler",
    "stereo",
    "subtitle",
    "subtitles",
    "surround",
    "tcloud",
    "track",
    "tracks",
    "truehd",
    "vtt",
    "srt",
    "ass",
    "ssa",
    "sub",
    "webrip",
    "webdl",
    "web",
    "x264",
    "x265",
    "h264",
    "h265",
}


def strip_accents(value: str) -> str:
    if not value:
        return ""
    normalized = unicodedata.normalize("NFD", str(value))
    stripped = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    return stripped.lower()


def clean_track_value(value) -> str:
    if value is None:
        return ""

    text = str(value).strip()
    if not text:
        return ""

    collapsed = re.sub(r"[\s._-]+", "", text.lower())
    if collapsed in PLACEHOLDER_TRACK_VALUES:
        return ""

    return " ".join(text.split())


def normalize_language_code(value) -> str:
    if value is None:
        return ""

    text = strip_accents(str(value).lower()).strip()
    if not text:
        return ""

    normalized_text = text.replace("_", "-")
    primary = re.split(r"[^a-z0-9]+", normalized_text, maxsplit=1)[0]
    if not primary:
        return ""

    if normalized_text in LANGUAGE_NAMES:
        return normalized_text
    if normalized_text in LANGUAGE_CODE_ALIASES:
        return LANGUAGE_CODE_ALIASES[normalized_text]
    if primary in LANGUAGE_NAMES and re.fullmatch(r"[a-z]{2,3}(?:-(?:[a-z]{2}|[a-z]{4}|\d{3}))?", normalized_text):
        return primary
    if primary in LANGUAGE_CODE_ALIASES:
        return LANGUAGE_CODE_ALIASES[primary]
    return ""


def language_display_name(language_code: str) -> str:
    normalized = normalize_language_code(language_code)
    if not normalized:
        return ""
    return LANGUAGE_NAMES.get(normalized, normalized.upper())


def _tokenize_label(value: str) -> list[str]:
    normalized = strip_accents(value)
    return [token for token in re.split(r"[^a-z0-9]+", normalized) if token]


def is_probably_subtitle_filename(label: str) -> bool:
    if not label:
        return False
    normalized = label.lower()
    return (
        normalized.endswith(".srt")
        or normalized.endswith(".vtt")
        or normalized.endswith(".ass")
        or normalized.endswith(".ssa")
        or normalized.endswith(".sub")
        or "/" in normalized
        or "\\" in normalized
    )


def looks_like_technical_track_label(value) -> bool:
    text = str(value or "").strip()
    if not text:
        return False

    cleaned = clean_track_value(text)
    if not cleaned:
        return True

    normalized = strip_accents(cleaned)
    collapsed = re.sub(r"[\s._-]+", "", normalized)
    if collapsed in PLACEHOLDER_TRACK_VALUES:
        return True

    if "/" in cleaned or "\\" in cleaned:
        return True
    if ".tcloud.embedded." in normalized or normalized.startswith("tcloud.embedded."):
        return True
    if re.search(r"\.(srt|vtt|ass|ssa|sub|sup|idx|mks|mka|mkv|mp4|avi|webm|mov|mpg|mpeg)$", normalized):
        return True

    tokens = _tokenize_label(cleaned)
    if not tokens:
        return False

    technical_hits = 0
    for token in tokens:
        if token in _TECHNICAL_TRACK_TOKENS:
            technical_hits += 1
            continue
        if re.fullmatch(r"\d{3,4}p", token):
            technical_hits += 1
            continue
        if re.fullmatch(r"\d+[ch]\b", token):
            technical_hits += 1
            continue
        if re.fullmatch(r"s\d{1,2}e\d{1,3}", token):
            technical_hits += 1
            continue
        if re.fullmatch(r"\d{4}", token):
            technical_hits += 1

    if technical_hits >= 2 and len(tokens) >= 3:
        return True
    if technical_hits >= 1 and "." in cleaned and len(tokens) >= 4:
        return True

    return False


def _subtitle_filename_label(*values) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if not text:
            continue
        basename = text.split("#", 1)[0].split("?", 1)[0].rsplit("/", 1)[-1]
        clean_basename = clean_track_value(basename)
        if clean_basename:
            return clean_basename
    return ""


def build_subtitle_label(
    *,
    language: str,
    title: str,
    index: int,
    filename: str = "",
    src: str = "",
    forced: bool = False,
    default: bool = False,
    hearing_impaired: bool = False,
    comment: bool = False,
    captions: bool = False,
    complete: bool = False,
) -> str:
    clean_title = clean_track_value(title)
    if clean_title and looks_like_technical_track_label(clean_title):
        clean_title = ""
    language_label = language_display_name(language)
    filename_label = _subtitle_filename_label(src, filename)

    label = ""
    if clean_title and not is_probably_subtitle_filename(clean_title):
        label = clean_title
    elif language_label:
        label = language_label
    else:
        label = clean_title or filename_label

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
    if complete:
        flags.append("FULL")

    if label and flags:
        label += f" [{', '.join(flags)}]"

    return label


def build_audio_label(*, language: str, title: str, index: int) -> str:
    clean_title = clean_track_value(title)
    if clean_title and looks_like_technical_track_label(clean_title):
        clean_title = ""
    language_label = language_display_name(language)

    if clean_title and language_label:
        if strip_accents(clean_title) == strip_accents(language_label):
            return language_label
        return f"{clean_title} - {language_label}"

    if clean_title:
        return clean_title

    if language_label:
        return language_label

    return f"Áudio {index + 1}"


def is_ambiguous_short_language_token(value: str) -> bool:
    normalized = strip_accents(str(value or "").strip())
    return normalized in AMBIGUOUS_SHORT_LANGUAGE_TOKENS


def subtitle_content_language_hints_supported() -> tuple[str, ...]:
    return tuple(_SUBTITLE_CONTENT_HINTS.keys())


def _strip_subtitle_markup(text: str) -> str:
    cleaned_lines = []
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.upper() == "WEBVTT":
            continue
        if re.match(r"^\d+$", line):
            continue
        if "-->" in line:
            continue
        line = re.sub(r"<[^>]+>", " ", line)
        line = re.sub(r"\{\\[^}]+\}", " ", line)
        line = re.sub(r"\[[^\]]+\]", " ", line)
        line = re.sub(r"\([^)]*\)", " ", line)
        line = re.sub(r"&[a-z]+;", " ", line, flags=re.I)
        cleaned_lines.append(line)
    return " ".join(cleaned_lines)


def detect_subtitle_language_from_content(text: str) -> tuple[str, float]:
    cleaned = _strip_subtitle_markup(text)
    if not cleaned:
        return "", 0.0

    sample = cleaned[:6000]
    if len(sample.strip()) < 24:
        return "", 0.0

    for language, pattern in _SUBTITLE_CONTENT_SCRIPT_PATTERNS:
        if len(pattern.findall(sample)) >= 3:
            return language, 0.99

    lowered = sample.lower()
    tokens = re.findall(r"[a-zà-ÿ']+", lowered)
    if len(tokens) < 6:
        return "", 0.0

    token_counts = Counter(tokens)
    scores: dict[str, float] = {}
    for language, hints in _SUBTITLE_CONTENT_HINTS.items():
        strong_words = hints["strong"]
        weak_words = hints["weak"]
        char_hits = sum(lowered.count(char) for char in hints["chars"])
        score = 0.0
        score += sum(token_counts[word] * 3.0 for word in strong_words)
        score += sum(token_counts[word] * 1.0 for word in weak_words)
        score += min(char_hits, 8) * 0.35
        scores[language] = score

    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    best_language, best_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else 0.0
    distinct_hits = sum(token_counts[word] for word in _SUBTITLE_CONTENT_HINTS[best_language]["strong"])

    if best_score < 4.0:
        return "", 0.0
    if best_score < second_score + 1.5 and distinct_hits < 2:
        return "", 0.0

    confidence = min(0.99, 0.55 + (best_score / 18.0))
    return best_language, confidence
