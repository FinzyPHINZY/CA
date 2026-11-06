"""
PDF layout-aware heuristic parser for text-based PDFs (task 4.0.8).

Uses pdfplumber X-coordinate data for element classification.
Adaptive calibration: clusters x0 values from first 10 pages to find
column centroids for that specific document.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

import pdfplumber
import structlog

from models.schema import (
    ElementType,
    ParsedCharacter,
    ParseResult,
    Scene,
    ScriptElement,
)
from pipeline.normalization import (
    clean_character_name,
    deduplicate_characters,
    extract_scene_number,
    is_uppercase,
    is_revision_marker,
    is_valid_character_name,
    merge_consecutive_action,
    merge_consecutive_dialogue,
    strip_character_extension,
    strip_contd,
    REVISION_MARKER_X_THRESHOLD,
)
from pipeline.watermark import WatermarkResult

log = structlog.get_logger()

# ── Default US Letter column buckets (PDF points) ────────────────────────────
# These are overridden by adaptive calibration when enough words are found.

@dataclass
class ColumnBuckets:
    action_x_min: float = 108.0
    action_x_max: float = 144.0
    char_x_min: float = 252.0
    char_x_max: float = 288.0
    dialogue_x_min: float = 180.0
    dialogue_x_max: float = 252.0
    paren_x_min: float = 216.0
    paren_x_max: float = 252.0
    transition_x1_min: float = 504.0


_SCENE_HEADING_RE = re.compile(
    r"^(?:\d{1,4}\s+)?(INT\.?|EXT\.?|INT\./EXT\.|INT/EXT\.|EXT/INT|I/E)[.\s]",
    re.IGNORECASE | re.UNICODE,
)
_TRANSITION_ENDS_RE = re.compile(r"TO:\s*$|^FADE OUT\.?$|^SMASH CUT TO:?$", re.IGNORECASE | re.UNICODE)


def _calibrate_buckets(all_words: list[dict]) -> ColumnBuckets:
    """
    Cluster x0 values from the first 10 pages and find column centroids.
    Falls back to defaults if clustering produces unreasonable values.

    Strategy: bin x0 into 10pt buckets, filter out low-frequency noise,
    merge adjacent bins within 20pt, then assign the top distinct peaks
    to action / dialogue / character roles by x-position order.
    """
    if len(all_words) < 20:
        return ColumnBuckets()

    x0_values = [w["x0"] for w in all_words if 50 <= w.get("x0", 0) <= 600]
    if not x0_values:
        return ColumnBuckets()

    # Histogram clustering: bin into 10pt buckets
    bins: dict[int, int] = defaultdict(int)
    for x in x0_values:
        bins[int(x // 10) * 10] += 1

    # Filter out low-frequency noise bins (must have >= 2% of total words)
    min_count = max(3, len(x0_values) // 50)
    significant_bins = {k: v for k, v in bins.items() if v >= min_count}
    if len(significant_bins) < 2:
        return ColumnBuckets()

    # Merge adjacent bins within 20pt into weighted-average peaks
    sorted_positions = sorted(significant_bins.keys())
    merged_peaks: list[tuple[float, int]] = []  # (weighted_x, total_count)
    i = 0
    while i < len(sorted_positions):
        cluster_x_sum = sorted_positions[i] * significant_bins[sorted_positions[i]]
        cluster_count = significant_bins[sorted_positions[i]]
        j = i + 1
        while j < len(sorted_positions) and sorted_positions[j] - sorted_positions[i] <= 20:
            cluster_x_sum += sorted_positions[j] * significant_bins[sorted_positions[j]]
            cluster_count += significant_bins[sorted_positions[j]]
            j += 1
        merged_peaks.append((cluster_x_sum / cluster_count, cluster_count))
        i = j

    # Filter content peaks (x <= 450, skip transitions/margins)
    content_peaks = [(x, c) for x, c in merged_peaks if x <= 450]
    if len(content_peaks) < 2:
        return ColumnBuckets()

    # Take top 4 by frequency, then sort by x-position to assign roles
    content_peaks.sort(key=lambda p: -p[1])
    top_peaks = content_peaks[:4]
    top_peaks.sort(key=lambda p: p[0])

    action_x = top_peaks[0][0]
    dialogue_x = top_peaks[min(1, len(top_peaks) - 1)][0]
    char_x = top_peaks[min(2, len(top_peaks) - 1)][0]

    # Validate minimum 30pt separation between adjacent columns
    if dialogue_x - action_x < 30:
        if len(top_peaks) >= 3:
            dialogue_x = top_peaks[2][0]
            char_x = top_peaks[min(3, len(top_peaks) - 1)][0]
        else:
            return ColumnBuckets()

    if char_x - dialogue_x < 30 and len(top_peaks) > 3:
        char_x = top_peaks[3][0]

    log.debug(
        "layout_calibration_peaks",
        raw_bin_count=len(bins),
        significant_bin_count=len(significant_bins),
        merged_peak_count=len(merged_peaks),
        action_x=round(action_x, 1),
        dialogue_x=round(dialogue_x, 1),
        char_x=round(char_x, 1),
    )

    defaults = ColumnBuckets()
    if 60 <= action_x <= 200 and 150 <= dialogue_x <= 350:
        return ColumnBuckets(
            action_x_min=action_x - 18,
            action_x_max=action_x + 18,
            char_x_min=char_x - 18,
            char_x_max=char_x + 18,
            dialogue_x_min=dialogue_x - 18,
            dialogue_x_max=dialogue_x + 18,
            paren_x_min=dialogue_x + 18,
            paren_x_max=char_x + 18,
            transition_x1_min=defaults.transition_x1_min,
        )

    return defaults


def _classify_block(
    text: str,
    x0: float,
    x1: float,
    buckets: ColumnBuckets,
    prev_type: ElementType | None,
) -> ElementType:
    """Map a text block to an ElementType based on X coordinate and content."""
    text_stripped = text.strip()
    ucase = is_uppercase(text_stripped)

    in_action = buckets.action_x_min <= x0 <= buckets.action_x_max
    in_char = buckets.char_x_min <= x0 <= buckets.char_x_max
    in_dialogue = buckets.dialogue_x_min <= x0 <= buckets.dialogue_x_max
    in_paren = buckets.paren_x_min <= x0 <= buckets.paren_x_max
    right_aligned = x1 > buckets.transition_x1_min

    # Scene headings are a strong content match (INT./EXT.) — check before
    # column-based classification since they can appear at varying x offsets
    # (e.g., x0=78 with scene numbers while action column starts at x0=82).
    if ucase and _SCENE_HEADING_RE.match(text_stripped):
        return ElementType.SCENE_HEADING

    if in_action and ucase and _TRANSITION_ENDS_RE.search(text_stripped):
        return ElementType.TRANSITION

    if right_aligned and ucase:
        return ElementType.TRANSITION

    if in_action:
        return ElementType.ACTION

    if in_char and ucase and 2 <= len(text_stripped) <= 40 and is_valid_character_name(text_stripped):
        return ElementType.CHARACTER

    if in_dialogue and prev_type in (ElementType.CHARACTER, ElementType.DIALOGUE, ElementType.PARENTHETICAL):
        return ElementType.DIALOGUE

    if in_paren and text_stripped.startswith("(") and text_stripped.endswith(")"):
        return ElementType.PARENTHETICAL

    if in_dialogue:
        return ElementType.DIALOGUE

    # Fallback: if looks like a character line (with validation)
    if ucase and 2 <= len(text_stripped) <= 40 and is_valid_character_name(text_stripped):
        return ElementType.CHARACTER

    return ElementType.ACTION


def parse_pdf_layout(
    file_bytes: bytes,
    watermark_result: WatermarkResult | None = None,
) -> ParseResult:
    """
    Layout-aware text PDF parser (task 4.0.8).
    Processes each page's word objects, calibrates column buckets,
    classifies each text block, and assembles scenes.
    """
    import io

    scenes: list[Scene] = []
    current_scene: Scene | None = None
    current_elements: list[ScriptElement] = []
    prev_type: ElementType | None = None
    current_char_name: str | None = None
    char_line_counts: dict[str, int] = defaultdict(int)
    raw_lines: list[str] = []
    parser_warnings: list[str] = []
    watermark_word_ids = watermark_result.watermark_word_ids if watermark_result else set()

    calibration_words: list[dict] = []

    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        page_count = len(pdf.pages)

        # Collect first 10 pages' words for calibration
        for page in pdf.pages[:10]:
            words = page.extract_words(x_tolerance=3, y_tolerance=3) or []
            calibration_words.extend(
                w for w in words
                if id(w) not in watermark_word_ids
                and not is_revision_marker(w)
            )

        buckets = _calibrate_buckets(calibration_words)
        log.debug("column_buckets_calibrated", buckets=buckets)

        def _finalize_scene() -> None:
            nonlocal current_scene, current_elements
            if current_scene is not None:
                current_scene.elements = current_elements[:]
                scenes.append(current_scene)
                current_scene = None
                current_elements = []

        for page_num, page in enumerate(pdf.pages, start=1):
            words = page.extract_words(x_tolerance=3, y_tolerance=3) or []

            # Group words into line blocks by y-coordinate (within 3pt)
            line_groups: dict[int, list[dict]] = defaultdict(list)
            for word in words:
                if id(word) in watermark_word_ids:
                    continue
                if is_revision_marker(word):
                    continue
                y_bucket = int(word.get("top", 0) // 3)
                line_groups[y_bucket].append(word)

            for y_key in sorted(line_groups.keys()):
                group = sorted(line_groups[y_key], key=lambda w: w.get("x0", 0))
                if not group:
                    continue

                line_text = " ".join(w.get("text", "") for w in group).strip()
                if not line_text:
                    continue

                # Skip standalone page numbers (e.g., "2.", "72.", "153.")
                # These appear at page boundaries and get misclassified as
                # character names, polluting the character list and turning
                # subsequent action text into false dialogue.
                if re.match(r"^\d{1,4}\.$", line_text):
                    continue

                # Check for revision markers in this line
                revised = any(is_revision_marker(w) for w in line_groups.get(y_key, []))

                x0 = group[0].get("x0", 0.0)
                x1 = group[-1].get("x1", 0.0)

                elem_type = _classify_block(line_text, x0, x1, buckets, prev_type)

                raw_lines.append(line_text)

                if elem_type == ElementType.SCENE_HEADING:
                    _finalize_scene()
                    script_num, heading_clean = extract_scene_number(line_text)
                    current_scene = Scene(
                        number=len(scenes) + 1,
                        script_scene_number=script_num,
                        heading=heading_clean,
                        page_start=page_num,
                    )
                    current_elements = []
                    current_char_name = None

                elif elem_type == ElementType.CHARACTER:
                    base_name, delivery = strip_character_extension(line_text)
                    current_char_name = base_name
                    current_elements.append(
                        ScriptElement(
                            type=elem_type,
                            text=base_name,
                            character_name=base_name,
                            delivery=delivery,
                            revised=revised,
                        )
                    )
                    char_line_counts[base_name] += 1

                elif elem_type == ElementType.DIALOGUE:
                    current_elements.append(
                        ScriptElement(
                            type=elem_type,
                            text=line_text,
                            character_name=current_char_name,
                            revised=revised,
                        )
                    )
                    if current_char_name:
                        char_line_counts[current_char_name] += 1

                elif elem_type == ElementType.PARENTHETICAL:
                    current_elements.append(
                        ScriptElement(
                            type=elem_type,
                            text=line_text,
                            character_name=current_char_name,
                            revised=revised,
                        )
                    )

                else:
                    current_elements.append(
                        ScriptElement(type=elem_type, text=line_text, revised=revised)
                    )
                    if elem_type != ElementType.TRANSITION:
                        current_char_name = None

                prev_type = elem_type

                # Update page_end on the current scene
                if current_scene:
                    current_scene.page_end = page_num

        _finalize_scene()

    # ── Post-processing: merge fragmented elements ────────────────────────
    # pdfplumber extracts each PDF line as a separate element. Merge
    # consecutive same-character dialogue and consecutive action lines
    # into single blocks.
    for scene in scenes:
        scene.elements = merge_consecutive_dialogue(scene.elements)
        scene.elements = merge_consecutive_action(scene.elements)

    # Rebuild char_line_counts after merging
    char_line_counts.clear()
    for scene in scenes:
        for el in scene.elements:
            if el.type in (ElementType.CHARACTER, ElementType.DIALOGUE) and el.character_name:
                char_line_counts[el.character_name] += 1

    characters = [
        ParsedCharacter(name=name, line_count=count)
        for name, count in sorted(char_line_counts.items(), key=lambda x: -x[1])
    ]

    # Phase 2: deduplicate character name variants from PDF extraction noise
    characters, scenes = deduplicate_characters(characters, scenes)

    return ParseResult(
        format="pdf_text",
        scenes=scenes,
        characters=characters,
        raw_text="\n".join(raw_lines),
        page_count=page_count,
        parser_warnings=parser_warnings,
        watermark_detected=watermark_result.watermark_detected if watermark_result else False,
        watermark_texts=watermark_result.watermark_texts if watermark_result else [],
    )
