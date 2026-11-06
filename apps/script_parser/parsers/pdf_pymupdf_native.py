"""
PyMuPDF native PDF extractor for digital PDFs with usable text layers.

Returns grouped line-level blocks with coordinates and basic quality signals.
This is transport-oriented extraction, not screenplay parsing.
"""
from __future__ import annotations

from collections import defaultdict
import re

import fitz
import structlog

from models.schema import NativeExtractionBlock, NativeExtractionPayload

log = structlog.get_logger()

_SCENE_HEADING_RE = re.compile(r"^(INT|EXT|INT/EXT|EXT/INT|I/E)\.?", re.I)
_CHARACTER_CUE_RE = re.compile(r"^[A-Z][A-Z0-9 .'\-()]{1,29}$")
_WATERMARK_KEYWORDS = (
    "confidential",
    "property of",
    "for your consideration",
    "do not distribute",
    "screener",
    "draft",
    "internal use",
)
_HEADER_RATIO = 0.08
_FOOTER_RATIO = 0.92
_CENTER_X_BAND = 0.2
_CENTER_Y_BAND = 0.25


def extract_native_pdf_with_pymupdf(file_bytes: bytes) -> NativeExtractionPayload:
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    try:
        raw_blocks: list[NativeExtractionBlock] = []
        page_dimensions: dict[int, tuple[float, float]] = {}

        for page_index in range(len(doc)):
            page = doc.load_page(page_index)
            page_number = page_index + 1
            page_dimensions[page_number] = (float(page.rect.width), float(page.rect.height))
            page_dict = page.get_text("dict")
            page_blocks = extract_page_blocks(page_dict, page_number, page.rotation)
            if page_blocks:
                raw_blocks.extend(page_blocks)

        blocks, suppression_summary = apply_noise_suppression(raw_blocks, page_dimensions)
        pages_with_blocks = len({block.page for block in blocks})
        line_texts = [block.text for block in blocks]

        metadata = _build_quality_metadata(
            line_texts,
            len(doc),
            pages_with_blocks,
            suppression_summary,
        )
        warnings: list[str] = []
        strength = metadata["native_text_layer_strength"]
        if strength == "weak":
            warnings.append(
                "PyMuPDF recovered native text, but screenplay or layout signals are weak."
            )
        elif strength == "absent":
            warnings.append(
                "PyMuPDF recovered too little usable native text for a confident digital PDF path."
            )
        if suppression_summary["removed_watermark_count"]:
            warnings.append(
                "Suppressed recurring watermark-like native text before downstream normalization."
            )
        if suppression_summary["removed_header_footer_count"]:
            warnings.append(
                "Suppressed recurring header/footer native text before downstream normalization."
            )

        log.info(
            "pymupdf_native_extract_complete",
            pages=len(doc),
            pages_with_blocks=pages_with_blocks,
            block_count=len(blocks),
            removed_watermark_count=suppression_summary["removed_watermark_count"],
            removed_header_footer_count=suppression_summary["removed_header_footer_count"],
            native_text_layer_strength=strength,
        )

        return NativeExtractionPayload(
            source="pymupdf_native_pdf",
            blocks=blocks,
            warnings=warnings,
            metadata=metadata,
        )
    finally:
        doc.close()


def extract_page_blocks(
    page_dict: dict,
    page_number: int,
    page_rotation: int,
) -> list[NativeExtractionBlock]:
    extracted: list[NativeExtractionBlock] = []
    skipped_rotated = 0
    for block in page_dict.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue

            # Skip non-horizontal lines (diagonal watermarks).
            # dir=(cos, sin): horizontal text has dir≈(1,0) or (-1,0).
            # Any significant sin component means rotated/diagonal text.
            line_dir = line.get("dir", (1.0, 0.0))
            if len(line_dir) >= 2 and abs(line_dir[1]) > 0.15:
                skipped_rotated += 1
                continue

            text_parts = [str(span.get("text", "")) for span in spans]
            text = "".join(text_parts).strip()
            if not text:
                continue

            bbox = line.get("bbox") or block.get("bbox")
            if not bbox or len(bbox) < 4:
                continue

            x0, y0, x1, y1 = [float(v) for v in bbox[:4]]
            dominant_span = max(spans, key=lambda span: float(span.get("size", 0) or 0))
            extracted.append(
                NativeExtractionBlock(
                    text=text,
                    page=page_number,
                    bounding_box=[x0, y0, x1, y0, x1, y1, x0, y1],
                    attributes={
                        "font_name": dominant_span.get("font"),
                        "font_size": float(dominant_span.get("size", 0) or 0),
                        "rotation_degrees": float(page_rotation or 0),
                        "line_dir": list(line_dir),
                        "block_kind": "line",
                        "span_count": len(spans),
                    },
                )
            )

    if skipped_rotated > 0:
        log.info(
            "skipped_rotated_lines",
            page=page_number,
            count=skipped_rotated,
        )

    return extracted


def _build_quality_metadata(
    line_texts: list[str],
    page_count: int,
    pages_with_blocks: int,
    suppression_summary: dict[str, object],
) -> dict[str, object]:
    cleaned = [line.strip() for line in line_texts if line.strip()]
    text_char_count = sum(len(re.sub(r"\s+", "", line)) for line in cleaned)
    scene_heading_matches = sum(1 for line in cleaned if _SCENE_HEADING_RE.match(line))
    character_cue_matches = sum(1 for line in cleaned if _looks_like_character_cue(line))
    dialogue_like_lines = _count_dialogue_like_lines(cleaned)
    repeated_noise_line_count = _count_repeated_noise_lines(cleaned)
    watermark_keyword_hits = sum(
        1
        for line in cleaned
        if any(keyword in line.lower() for keyword in _WATERMARK_KEYWORDS)
    )

    screenplay_signal_score = min(
        1.0,
        min(scene_heading_matches, 4) * 0.18
        + min(character_cue_matches, 8) * 0.07
        + min(dialogue_like_lines, 12) * 0.03,
    )
    noise_signal_score = min(
        1.0,
        min(repeated_noise_line_count, 10) * 0.08
        + min(watermark_keyword_hits, 6) * 0.1
        + _fragment_noise_ratio(cleaned) * 0.5,
    )
    layout_coherence_score = max(
        0.0,
        min(
            1.0,
            _stable_line_ratio(cleaned) * 0.65
            + _dialogue_flow_ratio(cleaned) * 0.35
            - noise_signal_score * 0.35,
        ),
    )

    if text_char_count < 80 or len(cleaned) < 5:
        strength = "absent"
    elif screenplay_signal_score >= 0.5 and layout_coherence_score >= 0.45:
        strength = "strong"
    else:
        strength = "weak"

    return {
        "page_count": page_count,
        "pages_with_blocks": pages_with_blocks,
        "text_char_count": text_char_count,
        "native_text_layer_strength": strength,
        "screenplay_signal_score": round(screenplay_signal_score, 3),
        "noise_signal_score": round(noise_signal_score, 3),
        "layout_coherence_score": round(layout_coherence_score, 3),
        "scene_heading_matches": scene_heading_matches,
        "character_cue_matches": character_cue_matches,
        "dialogue_like_lines": dialogue_like_lines,
        "repeated_noise_line_count": repeated_noise_line_count,
        "watermark_keyword_hits": watermark_keyword_hits,
        "removed_watermark_count": suppression_summary["removed_watermark_count"],
        "removed_header_footer_count": suppression_summary["removed_header_footer_count"],
        "removed_other_noise_count": suppression_summary["removed_other_noise_count"],
        "watermark_texts": suppression_summary["watermark_texts"],
    }


def apply_noise_suppression(
    blocks: list[NativeExtractionBlock],
    page_dimensions: dict[int, tuple[float, float]],
) -> tuple[list[NativeExtractionBlock], dict[str, object]]:
    if not blocks:
        return [], {
            "removed_watermark_count": 0,
            "removed_header_footer_count": 0,
            "removed_other_noise_count": 0,
            "watermark_texts": [],
        }

    occurrences: dict[str, set[int]] = defaultdict(set)
    for block in blocks:
        normalized = normalize_line(block.text)
        if normalized:
            occurrences[normalized].add(block.page)

    filtered: list[NativeExtractionBlock] = []
    watermark_texts: set[str] = set()
    removed_watermark_count = 0
    removed_header_footer_count = 0
    removed_other_noise_count = 0
    total_pages = max(len(page_dimensions), 1)

    for block in blocks:
        classification = classify_noise_block(
            block,
            page_dimensions,
            occurrences,
            total_pages,
        )
        if classification == "keep":
            filtered.append(block)
            continue
        if classification == "watermark":
            removed_watermark_count += 1
            watermark_texts.add(block.text.strip())
            continue
        if classification == "header_footer":
            removed_header_footer_count += 1
            continue
        removed_other_noise_count += 1

    return filtered, {
        "removed_watermark_count": removed_watermark_count,
        "removed_header_footer_count": removed_header_footer_count,
        "removed_other_noise_count": removed_other_noise_count,
        "watermark_texts": sorted(text for text in watermark_texts if text),
    }


def classify_noise_block(
    block: NativeExtractionBlock,
    page_dimensions: dict[int, tuple[float, float]],
    occurrences: dict[str, set[int]],
    total_pages: int,
) -> str:
    text = block.text.strip()
    if not text:
        return "other"
    if is_screenplay_like(text):
        return "keep"

    normalized = normalize_line(text)
    if not normalized:
        return "other"

    page_width, page_height = page_dimensions.get(block.page, (612.0, 792.0))
    x0, y0, x1, _, _, y1, _, _ = block.bounding_box
    center_x = (x0 + x1) / 2
    center_y = (y0 + y1) / 2
    repetition_ratio = len(occurrences.get(normalized, set())) / total_pages

    is_header = y0 <= page_height * _HEADER_RATIO
    is_footer = y1 >= page_height * _FOOTER_RATIO
    in_header_footer = is_header or is_footer
    in_center_band = (
        abs(center_x - (page_width / 2)) <= page_width * _CENTER_X_BAND
        and abs(center_y - (page_height / 2)) <= page_height * _CENTER_Y_BAND
    )

    rotation = abs(float(block.attributes.get("rotation_degrees", 0) or 0))
    font_size = float(block.attributes.get("font_size", 0) or 0)
    has_watermark_keyword = any(keyword in normalized for keyword in _WATERMARK_KEYWORDS)
    looks_page_number = bool(re.match(r"^\d{1,4}$", normalized))

    if in_header_footer and repetition_ratio >= 0.4:
        return "header_footer"
    if looks_page_number and in_header_footer:
        return "header_footer"
    if has_watermark_keyword and (repetition_ratio >= 0.2 or rotation > 3 or in_center_band):
        return "watermark"
    if rotation > 3 and repetition_ratio >= 0.2:
        return "watermark"
    if font_size >= 20 and in_center_band and repetition_ratio >= 0.2:
        return "watermark"
    if _looks_noisy(normalized) and repetition_ratio >= 0.7 and in_center_band:
        return "watermark"
    if _looks_noisy(normalized) and in_header_footer and repetition_ratio >= 0.5:
        return "header_footer"
    # Annotation stamps: very large font (>2x typical 12pt) + short text + non-script font
    if font_size >= 24 and len(text) <= 15:
        if not is_screenplay_like(text):
            return "other"
    return "keep"


def normalize_line(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def is_screenplay_like(text: str) -> bool:
    stripped = text.strip()
    return bool(
        _SCENE_HEADING_RE.match(stripped)
        or _looks_like_character_cue(stripped)
        or stripped.startswith("(")
        or re.match(r"^(CUT TO:|FADE IN:|FADE OUT\.?|DISSOLVE TO:)$", stripped, re.I)
    )


def _looks_like_character_cue(line: str) -> bool:
    stripped = line.strip()
    return bool(
        _CHARACTER_CUE_RE.match(stripped)
        and not _SCENE_HEADING_RE.match(stripped)
        and not stripped.isdigit()
    )


def _count_dialogue_like_lines(lines: list[str]) -> int:
    count = 0
    speaker_active = False
    for line in lines:
        if _looks_like_character_cue(line):
            speaker_active = True
            continue
        if _SCENE_HEADING_RE.match(line):
            speaker_active = False
            continue
        if speaker_active and 8 <= len(line) <= 120 and not _looks_like_character_cue(line):
            count += 1
            continue
        speaker_active = False
    return count


def _count_repeated_noise_lines(lines: list[str]) -> int:
    counts: dict[str, int] = {}
    for line in lines:
        normalized = re.sub(r"\s+", " ", line.lower()).strip()
        if not normalized or len(normalized) > 80:
            continue
        counts[normalized] = counts.get(normalized, 0) + 1
    repeated = 0
    for line, count in counts.items():
        if count >= 3 and _looks_noisy(line):
            repeated += count
    return repeated


def _looks_noisy(line: str) -> bool:
    letters = len(re.findall(r"[a-z]", line, re.I))
    digits = len(re.findall(r"\d", line))
    punctuation = len(re.findall(r"[^a-z0-9\s]", line, re.I))
    return (
        digits >= letters
        or punctuation > letters
        or bool(re.match(r"^[\d\s:/.\-]+$", line))
        or any(keyword in line.lower() for keyword in _WATERMARK_KEYWORDS)
    )


def _fragment_noise_ratio(lines: list[str]) -> float:
    if not lines:
        return 0.0
    noisy = 0
    for line in lines:
        letters = len(re.findall(r"[a-z]", line, re.I))
        digits = len(re.findall(r"\d", line))
        if len(line) <= 5 or digits > letters * 1.5:
            noisy += 1
    return noisy / len(lines)


def _stable_line_ratio(lines: list[str]) -> float:
    if not lines:
        return 0.0
    stable = 0
    for line in lines:
        letters = len(re.findall(r"[a-z]", line, re.I))
        if 3 <= len(line) <= 80 and letters >= 2:
            stable += 1
    return stable / len(lines)


def _dialogue_flow_ratio(lines: list[str]) -> float:
    cue_count = sum(1 for line in lines if _looks_like_character_cue(line))
    if cue_count == 0:
        return 0.0
    return min(1.0, _count_dialogue_like_lines(lines) / cue_count)
