"""
PyMuPDF structural parser — primary parser for digital PDFs with strong text layers.

Takes noise-suppressed NativeExtractionBlock[] from pdf_pymupdf_native and produces
a full ParseResult with scenes, characters, and classified elements.

Element classification uses a two-signal approach:
  1. X-position adaptive calibration (histogram-cluster x0 values into column buckets)
  2. Font-based supplementary signals (dominant font detection, ALL-CAPS, size, italic)
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

import structlog

from models.schema import (
    ElementType,
    NativeExtractionBlock,
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
    is_valid_character_name,
    strip_character_extension,
    strip_contd,
)

log = structlog.get_logger()

_SCENE_HEADING_RE = re.compile(
    r"^(INT\.?|EXT\.?|INT\./EXT\.|INT/EXT\.?|EXT/INT|I/E)[.\s]",
    re.IGNORECASE | re.UNICODE,
)
_TRANSITION_ENDS_RE = re.compile(
    r"TO:\s*$|^FADE OUT\.?$|^SMASH CUT TO:?$", re.IGNORECASE | re.UNICODE
)
_MARGIN_NUMBER_RE = re.compile(r"^\d{1,4}[A-Z]?\.?$")
_OMIT_RE = re.compile(r"^OMIT(TED)?\.?$", re.IGNORECASE)

# Calibration: first N pages used for histogram clustering
_CALIBRATION_PAGES = 10
# Minimum blocks needed for adaptive calibration to activate
_MIN_CALIBRATION_BLOCKS = 20


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


@dataclass
class DominantFont:
    font_name: str | None = None
    font_size: float = 0.0


@dataclass
class DualDialogueZone:
    """A vertical region on a page where two characters speak side-by-side."""
    page: int
    y_start: float
    y_end: float
    left_char_x: float
    right_char_x: float
    split_x: float  # midpoint — blocks left of this are left-column


def _calibrate_buckets(blocks: list[NativeExtractionBlock]) -> ColumnBuckets:
    """
    Cluster x0 values from calibration blocks into column buckets.
    Falls back to defaults if clustering produces unreasonable values.

    Strategy: bin x0 into 10pt buckets, filter out low-frequency noise,
    merge adjacent bins within 20pt, then assign the top distinct peaks
    to action / dialogue / character roles by x-position order.
    """
    cal_blocks = [b for b in blocks if b.page <= _CALIBRATION_PAGES]
    if len(cal_blocks) < _MIN_CALIBRATION_BLOCKS:
        return ColumnBuckets()

    # Filter to reasonable x0 range for screenplay content (skip margin noise)
    x0_values = [
        b.bounding_box[0] for b in cal_blocks
        if len(b.bounding_box) >= 2 and 60 <= b.bounding_box[0] <= 550
    ]
    if not x0_values:
        return ColumnBuckets()

    # Histogram clustering: bin into 10pt buckets
    bins: dict[int, int] = defaultdict(int)
    for x in x0_values:
        bins[int(x // 10) * 10] += 1

    # Filter out low-frequency noise bins (must have >= 2% of total blocks)
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
        "calibration_peaks",
        raw_bin_count=len(bins),
        significant_bin_count=len(significant_bins),
        merged_peak_count=len(merged_peaks),
        action_x=round(action_x, 1),
        dialogue_x=round(dialogue_x, 1),
        char_x=round(char_x, 1),
    )

    defaults = ColumnBuckets()
    if 60 <= action_x <= 200 and 100 <= dialogue_x <= 350:
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


def _detect_dominant_font(blocks: list[NativeExtractionBlock]) -> DominantFont:
    """Find the most frequent font_name + font_size combination (the body font)."""
    font_counts: dict[tuple[str | None, float], int] = defaultdict(int)
    for b in blocks:
        name = b.attributes.get("font_name")
        size = float(b.attributes.get("font_size", 0) or 0)
        if name and size > 0:
            font_counts[(str(name), size)] += 1

    if not font_counts:
        return DominantFont()

    (best_name, best_size), _ = max(font_counts.items(), key=lambda item: item[1])
    return DominantFont(font_name=best_name, font_size=best_size)


def _get_font_signals(
    block: NativeExtractionBlock,
    dominant: DominantFont,
) -> dict[str, bool]:
    """
    Extract supplementary font-based signals from a block.
    These supplement x-position classification, they never override it alone.
    """
    font_size = float(block.attributes.get("font_size", 0) or 0)
    font_name = str(block.attributes.get("font_name", "") or "")

    is_larger = font_size > dominant.font_size * 1.15 if dominant.font_size > 0 else False
    is_italic = "italic" in font_name.lower() or "oblique" in font_name.lower()
    is_bold = "bold" in font_name.lower()

    return {
        "is_larger": is_larger,
        "is_italic": is_italic,
        "is_bold": is_bold,
    }


def _build_margin_numbers_index(
    blocks: list[NativeExtractionBlock],
    content_x_min: float,
) -> dict[int, list[tuple[float, str]]]:
    """Build page_num -> [(y0, number_text)] index from margin number blocks.

    Margin scene numbers appear at x0 < content_x_min (left gutter) or x0 > 500
    (right gutter). bounding_box format: [x0, y0, ...] (8-element polygon).
    """
    index: dict[int, list[tuple[float, str]]] = defaultdict(list)
    for b in blocks:
        text = b.text.strip()
        if not text or len(b.bounding_box) < 4:
            continue
        x0 = b.bounding_box[0]
        y0 = b.bounding_box[1]
        if (x0 < content_x_min or x0 > 500) and _MARGIN_NUMBER_RE.match(text):
            num_text = text.rstrip(".")
            index[b.page].append((y0, num_text))
    return dict(index)


# ── Title page detection ────────────────────────────────────────────────────

_BY_LINE_RE = re.compile(r"\b(?:written\s+by|screenplay\s+by|by)\b", re.IGNORECASE)
_REVISION_DATE_RE = re.compile(
    r"\d{1,2}/\d{1,2}/\d{2,4}"
    r"|\b(?:white|blue|pink|yellow|green|goldenrod|buff|salmon|cherry|tan|revised)\b",
    re.IGNORECASE,
)


def _detect_title_page(
    blocks: list[NativeExtractionBlock],
    buckets: ColumnBuckets,
) -> tuple[bool, str | None]:
    """Score page 1 blocks for title page signals. Requires 3+ signals.

    Signals: no scene headings (mandatory), centered bold text,
    "by"/"written by", revision date/color patterns.
    Returns (is_title_page, extracted_title_or_None).
    """
    page1_blocks = [b for b in blocks if b.page == 1]
    if not page1_blocks:
        return False, None

    # Mandatory: no scene headings on page 1
    for b in page1_blocks:
        text = b.text.strip()
        if text and _SCENE_HEADING_RE.match(text):
            return False, None

    signals = 1  # no-scene-heading signal already counted
    candidate_title: str | None = None
    has_by_line = False
    has_revision_date = False
    has_bold_centered = False

    for b in page1_blocks:
        text = b.text.strip()
        if not text:
            continue
        font_name = str(b.attributes.get("font_name", "") or "")
        is_bold = "bold" in font_name.lower()
        x0 = b.bounding_box[0] if len(b.bounding_box) >= 2 else 0
        is_centered = x0 > 180

        if is_bold and is_centered and not has_bold_centered:
            has_bold_centered = True
            signals += 1
            if candidate_title is None and len(text) >= 2:
                candidate_title = text

        if _BY_LINE_RE.search(text) and not has_by_line:
            has_by_line = True
            signals += 1

        if _REVISION_DATE_RE.search(text) and not has_revision_date:
            has_revision_date = True
            signals += 1

    is_title_page = signals >= 3
    return is_title_page, candidate_title if is_title_page else None


# ── Dual dialogue detection ─────────────────────────────────────────────────

def _detect_dual_dialogue_zones(
    blocks: list[NativeExtractionBlock],
) -> list[DualDialogueZone]:
    """Pre-scan for side-by-side character pairs indicating dual dialogue.

    Looks for pairs of uppercase valid-character-name blocks at similar y0 (±5pt)
    with x-gap > 100pt on the same page. Returns zones where dual dialogue handling
    should override normal column classification.
    """
    by_page: dict[int, list[NativeExtractionBlock]] = defaultdict(list)
    for b in blocks:
        by_page[b.page].append(b)

    zones: list[DualDialogueZone] = []

    for page_num, page_blocks in by_page.items():
        # Find candidate character blocks
        char_candidates = []
        for b in page_blocks:
            text = b.text.strip()
            if (
                text
                and len(b.bounding_box) >= 4
                and is_uppercase(text)
                and 2 <= len(text) <= 40
                and is_valid_character_name(text)
            ):
                char_candidates.append(b)

        char_candidates.sort(key=lambda b: b.bounding_box[1])

        # Find pairs at similar y0 with significant x-gap
        used: set[int] = set()
        for i, b1 in enumerate(char_candidates):
            if i in used:
                continue
            for j, b2 in enumerate(char_candidates):
                if j <= i or j in used:
                    continue
                y1 = b1.bounding_box[1]
                y2 = b2.bounding_box[1]
                x1_pos = b1.bounding_box[0]
                x2_pos = b2.bounding_box[0]
                if abs(y1 - y2) <= 5.0 and abs(x1_pos - x2_pos) > 100.0:
                    left_x = min(x1_pos, x2_pos)
                    right_x = max(x1_pos, x2_pos)
                    split_x = (left_x + right_x) / 2.0
                    zone_y_start = min(y1, y2) - 5.0

                    # Scan forward to find zone end: next block that's clearly
                    # back in single-column action (x0 near action column) or
                    # a scene heading, below the character pair.
                    zone_y_end = zone_y_start + 200.0
                    for b in page_blocks:
                        by0 = b.bounding_box[1] if len(b.bounding_box) >= 2 else 0
                        bx0 = b.bounding_box[0] if len(b.bounding_box) >= 2 else 0
                        bt = b.text.strip()
                        if by0 <= zone_y_start + 10:
                            continue
                        # Full-width action line signals end of dual dialogue
                        if bx0 < left_x and len(bt) > 40:
                            zone_y_end = by0 - 1.0
                            break
                        if bt and _SCENE_HEADING_RE.match(bt):
                            zone_y_end = by0 - 1.0
                            break

                    zones.append(DualDialogueZone(
                        page=page_num,
                        y_start=zone_y_start,
                        y_end=zone_y_end,
                        left_char_x=left_x,
                        right_char_x=right_x,
                        split_x=split_x,
                    ))
                    used.add(i)
                    used.add(j)
                    break

    return zones


def _find_dual_zone(
    page: int, y0: float, zones: list[DualDialogueZone],
) -> DualDialogueZone | None:
    """Return the dual dialogue zone containing this block, if any."""
    for z in zones:
        if z.page == page and z.y_start <= y0 <= z.y_end:
            return z
    return None


def _classify_block(
    text: str,
    x0: float,
    x1: float,
    buckets: ColumnBuckets,
    prev_type: ElementType | None,
    font_signals: dict[str, bool],
) -> ElementType:
    """Map a text block to an ElementType based on X coordinate, content, and font signals."""
    text_stripped = text.strip()
    ucase = is_uppercase(text_stripped)

    in_action = buckets.action_x_min <= x0 <= buckets.action_x_max
    in_char = buckets.char_x_min <= x0 <= buckets.char_x_max
    in_dialogue = buckets.dialogue_x_min <= x0 <= buckets.dialogue_x_max
    in_paren = buckets.paren_x_min <= x0 <= buckets.paren_x_max
    right_aligned = x1 > buckets.transition_x1_min

    # Scene heading: action column + uppercase + scene heading pattern
    # Font signal: larger font reinforces scene heading detection
    if in_action and ucase and _SCENE_HEADING_RE.match(text_stripped):
        return ElementType.SCENE_HEADING
    if font_signals.get("is_larger") and ucase and _SCENE_HEADING_RE.match(text_stripped):
        return ElementType.SCENE_HEADING

    # Transition
    if in_action and ucase and _TRANSITION_ENDS_RE.search(text_stripped):
        return ElementType.TRANSITION
    if right_aligned and ucase:
        return ElementType.TRANSITION

    # Action
    if in_action:
        return ElementType.ACTION

    # Character cue: char column + uppercase + reasonable length + valid name
    # Font signal: bold reinforces character detection
    if in_char and ucase and 2 <= len(text_stripped) <= 40 and is_valid_character_name(text_stripped):
        return ElementType.CHARACTER

    # Parenthetical: paren column + wrapped in parens
    # Font signal: italic hints at parenthetical/stage direction
    if in_paren and text_stripped.startswith("(") and text_stripped.endswith(")"):
        return ElementType.PARENTHETICAL
    if font_signals.get("is_italic") and text_stripped.startswith("(") and text_stripped.endswith(")"):
        return ElementType.PARENTHETICAL

    # Dialogue: dialogue column + follows character/dialogue/parenthetical
    if in_dialogue and prev_type in (
        ElementType.CHARACTER,
        ElementType.DIALOGUE,
        ElementType.PARENTHETICAL,
    ):
        return ElementType.DIALOGUE
    if in_dialogue:
        return ElementType.DIALOGUE

    # Fallback: uppercase short text → character cue (with validation)
    if ucase and 2 <= len(text_stripped) <= 40 and is_valid_character_name(text_stripped):
        return ElementType.CHARACTER

    return ElementType.ACTION


def parse_pdf_pymupdf_structural(
    blocks: list[NativeExtractionBlock],
    page_count: int,
    watermark_detected: bool = False,
    watermark_texts: list[str] | None = None,
) -> ParseResult:
    """
    Primary structural parser for digital PDFs using PyMuPDF blocks.

    Takes already noise-suppressed blocks and produces a full ParseResult
    with scenes, characters, and classified elements.
    """
    if not blocks:
        return ParseResult(
            format="pdf_pymupdf_structural",
            page_count=page_count,
            watermark_detected=watermark_detected,
            watermark_texts=watermark_texts or [],
            parser_warnings=["No blocks to parse"],
        )

    buckets = _calibrate_buckets(blocks)
    dominant_font = _detect_dominant_font(blocks)
    log.debug(
        "pymupdf_structural_calibration",
        buckets=buckets,
        dominant_font_name=dominant_font.font_name,
        dominant_font_size=dominant_font.font_size,
    )

    # Title page detection: skip page 1 if it's a title page
    is_title_page, detected_title = _detect_title_page(blocks, buckets)
    title_page_pages: set[int] = {1} if is_title_page else set()
    if is_title_page:
        log.info("title_page_detected", title=detected_title)

    # Dual dialogue pre-scan
    dual_zones = _detect_dual_dialogue_zones(blocks)
    if dual_zones:
        log.info("dual_dialogue_zones_detected", count=len(dual_zones))

    # Build a set of recurring text that appears on 2+ pages OUTSIDE the character
    # column. Character names naturally recur (same character speaks on many pages),
    # so we only flag text as header/footer noise when it recurs at non-character positions.
    _text_page_positions: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for b in blocks:
        t = b.text.strip()
        if t and len(t) >= 3 and len(b.bounding_box) >= 2:
            _text_page_positions[t].append((b.page, b.bounding_box[0]))
    recurring_texts = frozenset(
        t for t, entries in _text_page_positions.items()
        if len(set(pg for pg, _ in entries)) >= 2
        and all(not (buckets.char_x_min <= x0 <= buckets.char_x_max) for _, x0 in entries)
    )

    scenes: list[Scene] = []
    current_scene: Scene | None = None
    current_elements: list[ScriptElement] = []
    prev_type: ElementType | None = None
    current_char_name: str | None = None
    current_left_char: str | None = None
    current_right_char: str | None = None
    char_line_counts: dict[str, int] = defaultdict(int)
    raw_lines: list[str] = []
    parser_warnings: list[str] = []

    def _finalize_scene() -> None:
        nonlocal current_scene, current_elements
        if current_scene is not None:
            current_scene.elements = current_elements[:]
            scenes.append(current_scene)
            current_scene = None
            current_elements = []

    # Determine content margin boundaries from calibrated buckets
    content_x_min = max(buckets.action_x_min - 10, 50.0)

    # Build margin numbers index for scene number correlation (Fix 2)
    margin_numbers = _build_margin_numbers_index(blocks, content_x_min)

    for block in blocks:
        text = block.text.strip()
        if not text:
            continue

        bbox = block.bounding_box
        if len(bbox) < 4:
            continue

        x0 = bbox[0]
        x1 = bbox[2]
        page_num = block.page

        # Skip title page blocks entirely
        if page_num in title_page_pages:
            continue

        # Skip margin-area blocks (scene numbers, page numbers in gutters)
        if x0 < content_x_min and re.match(r"^\d{1,4}[A-Z]?\.?$", text):
            continue
        if x0 > 500 and re.match(r"^\d{1,4}[A-Z]?\.?$", text):
            continue

        # Check for dual dialogue zone before standard classification
        block_y0 = bbox[1]
        dual_zone = _find_dual_zone(page_num, block_y0, dual_zones) if dual_zones else None

        if dual_zone is not None:
            # In dual dialogue zone: classify by content AND x-position proximity
            # to known character columns. Without x-check, uppercase action text
            # (direction notes, emphatic dialogue) gets misclassified as CHARACTER.
            is_left = x0 < dual_zone.split_x
            near_char_x = (
                abs(x0 - dual_zone.left_char_x) <= 30
                or abs(x0 - dual_zone.right_char_x) <= 30
            )
            if (
                near_char_x
                and is_uppercase(text)
                and 2 <= len(text) <= 40
                and is_valid_character_name(text)
            ):
                elem_type = ElementType.CHARACTER
            elif text.startswith("(") and text.endswith(")"):
                elem_type = ElementType.PARENTHETICAL
            else:
                elem_type = ElementType.DIALOGUE
        else:
            font_signals = _get_font_signals(block, dominant_font)
            elem_type = _classify_block(text, x0, x1, buckets, prev_type, font_signals)

        # Demote recurring cross-page text from CHARACTER to ACTION
        # (headers like "BET S2 - AUDITION SIDES - MIMI", terminators like "END.")
        if elem_type == ElementType.CHARACTER and text in recurring_texts:
            elem_type = ElementType.ACTION

        raw_lines.append(text)

        # OMIT/OMITTED scene detection: action-column text matching OMIT pattern
        # with a margin scene number at the same y-position → separate scene slot.
        if (
            elem_type == ElementType.ACTION
            and _OMIT_RE.match(text)
            and page_num in margin_numbers
        ):
            omit_y0 = bbox[1]
            omit_scene_num = None
            for margin_y0, margin_num in margin_numbers[page_num]:
                if abs(margin_y0 - omit_y0) <= 5.0:
                    omit_scene_num = margin_num
                    break
            if omit_scene_num is not None:
                _finalize_scene()
                current_scene = Scene(
                    number=len(scenes) + 1,
                    script_scene_number=omit_scene_num,
                    heading=text.upper().rstrip("."),
                    page_start=page_num,
                    page_end=page_num,
                )
                _finalize_scene()
                current_char_name = None
                prev_type = elem_type
                continue

        if elem_type == ElementType.SCENE_HEADING:
            # Capture pre-heading content as a prologue scene (only before first scene)
            if current_scene is None and current_elements and len(scenes) == 0:
                current_scene = Scene(
                    number=0,
                    script_scene_number=None,
                    heading="PROLOGUE",
                    page_start=blocks[0].page if blocks else 1,
                    page_end=page_num,
                )
            _finalize_scene()
            script_num, heading_clean = extract_scene_number(text)
            # Margin number fallback: when number isn't embedded in heading text,
            # look for margin numbers at similar y-position on this page.
            if script_num is None and page_num in margin_numbers:
                heading_y0 = bbox[1]
                for margin_y0, margin_num in margin_numbers[page_num]:
                    if abs(margin_y0 - heading_y0) <= 5.0:
                        script_num = margin_num
                        break
            current_scene = Scene(
                number=len(scenes) + 1,
                script_scene_number=script_num,
                heading=heading_clean,
                page_start=page_num,
            )
            current_elements = []
            current_char_name = None

        elif elem_type == ElementType.CHARACTER:
            base_name, delivery = strip_character_extension(text)
            # Track left/right character names for dual dialogue zones
            if dual_zone is not None:
                if is_left:
                    current_left_char = base_name
                else:
                    current_right_char = base_name
                current_char_name = base_name
            else:
                current_char_name = base_name
                current_left_char = None
                current_right_char = None
            current_elements.append(
                ScriptElement(
                    type=elem_type,
                    text=base_name,
                    character_name=base_name,
                    delivery=delivery,
                )
            )
            char_line_counts[base_name] += 1

        elif elem_type == ElementType.DIALOGUE:
            # In dual dialogue, assign character based on left/right position
            if dual_zone is not None:
                char_name = current_left_char if is_left else current_right_char
            else:
                char_name = current_char_name
            current_elements.append(
                ScriptElement(
                    type=elem_type,
                    text=text,
                    character_name=char_name,
                )
            )
            if char_name:
                char_line_counts[char_name] += 1

        elif elem_type == ElementType.PARENTHETICAL:
            if dual_zone is not None:
                char_name = current_left_char if is_left else current_right_char
            else:
                char_name = current_char_name
            current_elements.append(
                ScriptElement(
                    type=elem_type,
                    text=text,
                    character_name=char_name,
                )
            )

        else:
            current_elements.append(ScriptElement(type=elem_type, text=text))
            if elem_type != ElementType.TRANSITION:
                current_char_name = None
                current_left_char = None
                current_right_char = None

        prev_type = elem_type

        if current_scene:
            current_scene.page_end = page_num

    _finalize_scene()

    # Renumber scenes sequentially (prologue may have shifted numbers)
    for idx, scene in enumerate(scenes):
        scene.number = idx + 1

    characters = [
        ParsedCharacter(name=name, line_count=count)
        for name, count in sorted(char_line_counts.items(), key=lambda x: -x[1])
    ]

    # Phase 2: deduplicate character name variants from PDF extraction noise
    characters, scenes = deduplicate_characters(characters, scenes)

    log.info(
        "pymupdf_structural_parse_complete",
        scene_count=len(scenes),
        character_count=len(characters),
        element_count=sum(len(s.elements) for s in scenes),
    )

    return ParseResult(
        title=detected_title,
        format="pdf_pymupdf_structural",
        scenes=scenes,
        characters=characters,
        raw_text="\n".join(raw_lines),
        page_count=page_count,
        parser_warnings=parser_warnings,
        watermark_detected=watermark_detected,
        watermark_texts=watermark_texts or [],
    )
