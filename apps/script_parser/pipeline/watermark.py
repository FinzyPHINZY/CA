"""
Watermark detection and cleaning (tasks 4.0.12–4.0.13).

CRITICAL ORDERING: watermark cleaning must run BEFORE Layer 2 validation.
If watermarks are cleaned after fingerprint check, legitimate professional
scripts may fail due to watermark noise contaminating the sampled text.

Three detection signals:
  1. Rotation-based: abs(rotation) > 5 degrees → diagonal overlay watermark
  2. Coordinate-based: text outside all five column buckets AND outside header/footer zone
  3. Repetition-based: same normalized string at non-standard position on >30% of pages

Header/footer zone: top < 50 or top > 730 (PDF points, US Letter 792pt tall)
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

import structlog

log = structlog.get_logger()

# US Letter page height in PDF points
_PAGE_HEIGHT_PT = 792.0

# Header/footer zone thresholds (PDF points)
_HEADER_ZONE_TOP = 50.0
_FOOTER_ZONE_TOP = 730.0

# Column bucket ranges (PDF points, US Letter)
# action/scene heading: x0 in [108, 144]
# character names:       x0 in [252, 288]
# dialogue:              x0 in [180, 252]
# parentheticals:        x0 in [216, 252]
# transition right edge: x1 > 504
_NORMAL_X_RANGES = [
    (108, 504),  # covers all normal screenplay columns
]

# Repetition threshold: string must appear on > 30% of pages to be a watermark
_REPETITION_THRESHOLD = 0.30

# Known watermark keyword patterns (lowercase, stripped)
_WATERMARK_KEYWORDS = frozenset(
    [
        "confidential",
        "do not distribute",
        "for your consideration",
        "property of",
        "fyc",
        "screener",
        "not for sale",
        "awards consideration",
    ]
)


def _normalize_string(s: str) -> str:
    """Lowercase and strip punctuation for watermark matching."""
    return re.sub(r"[^\w\s]", "", s.lower()).strip()


@dataclass
class WatermarkResult:
    watermark_detected: bool = False
    watermark_texts: list[str] = field(default_factory=list)
    # Word objects that ARE watermarks (to be excluded from classification)
    watermark_word_ids: set[int] = field(default_factory=set)


def detect_and_clean_watermarks(
    pages_words: list[list[dict]],
) -> WatermarkResult:
    """
    Given a list of pages (each page is a list of pdfplumber word dicts),
    detect watermark word objects and return which to exclude.

    Does NOT modify the original word lists — returns a set of word object ids.
    Call filter_watermarks() to get clean word lists.
    """
    result = WatermarkResult()
    total_pages = len(pages_words)
    if total_pages == 0:
        return result

    # Build per-page sets for repetition detection
    # key: normalized_text → list of pages where it appears at non-standard positions
    non_standard_occurrences: dict[str, list[int]] = defaultdict(list)

    watermark_ids: set[int] = set()
    watermark_texts_seen: set[str] = set()

    for page_idx, words in enumerate(pages_words):
        for word in words:
            raw_text = word.get("text", "").strip()
            if not raw_text:
                continue

            wid = id(word)
            top = word.get("top", 0.0)
            x0 = word.get("x0", 0.0)
            rotation = abs(word.get("rotation", 0.0))

            # Signal 1: rotation-based
            if rotation > 5:
                watermark_ids.add(wid)
                watermark_texts_seen.add(raw_text)
                log.debug("watermark_rotation", text=raw_text, rotation=rotation, page=page_idx)
                continue

            # Signal 2: coordinate-based — outside all normal column buckets
            # AND outside header/footer zone
            in_header_footer = top < _HEADER_ZONE_TOP or top > _FOOTER_ZONE_TOP
            in_normal_x = any(x_min <= x0 <= x_max for x_min, x_max in _NORMAL_X_RANGES)

            if not in_normal_x and not in_header_footer:
                watermark_ids.add(wid)
                watermark_texts_seen.add(raw_text)
                log.debug("watermark_coordinate", text=raw_text, x0=x0, top=top, page=page_idx)
                continue

            # Track header/footer text for repetition check below
            if in_header_footer:
                normalized = _normalize_string(raw_text)
                non_standard_occurrences[normalized].append(page_idx)

                # Also check against known watermark keyword patterns immediately
                for kw in _WATERMARK_KEYWORDS:
                    if kw in normalized:
                        watermark_ids.add(wid)
                        watermark_texts_seen.add(raw_text)
                        break

    # Signal 3: repetition-based
    for normalized, page_list in non_standard_occurrences.items():
        unique_pages = set(page_list)
        ratio = len(unique_pages) / total_pages
        if ratio > _REPETITION_THRESHOLD:
            log.debug(
                "watermark_repetition",
                normalized=normalized,
                pages=len(unique_pages),
                total_pages=total_pages,
                ratio=ratio,
            )
            # Mark all word objects that match this normalized string
            for page_idx, words in enumerate(pages_words):
                if page_idx not in unique_pages:
                    continue
                for word in words:
                    if _normalize_string(word.get("text", "")) == normalized:
                        watermark_ids.add(id(word))
                        watermark_texts_seen.add(word.get("text", "").strip())

    result.watermark_detected = bool(watermark_ids)
    result.watermark_texts = sorted(watermark_texts_seen)
    result.watermark_word_ids = watermark_ids

    if result.watermark_detected:
        log.info(
            "watermarks_detected",
            count=len(watermark_ids),
            texts=result.watermark_texts,
        )

    return result


def filter_watermarks(
    words: list[dict],
    watermark_ids: set[int],
) -> list[dict]:
    """Return a new list with watermark word objects removed."""
    return [w for w in words if id(w) not in watermark_ids]


def watermark_result_from_native_suppression(
    metadata: dict[str, object],
) -> WatermarkResult:
    """
    Build a WatermarkResult from PyMuPDF native extraction metadata.

    PyMuPDF's noise suppression already detects and removes watermarks during
    extraction. This bridges its output into the WatermarkResult format used
    by downstream parsers, avoiding a separate pdfplumber watermark pass.
    """
    watermark_count = int(metadata.get("removed_watermark_count", 0) or 0)
    watermark_texts = list(metadata.get("watermark_texts", []) or [])

    return WatermarkResult(
        watermark_detected=watermark_count > 0 or len(watermark_texts) > 0,
        watermark_texts=watermark_texts,
        # No word object IDs — blocks were already filtered during extraction
        watermark_word_ids=set(),
    )
