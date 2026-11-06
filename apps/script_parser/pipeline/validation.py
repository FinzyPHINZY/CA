"""
validation pipeline — tasks 4.0.19, 4.0.20, 4.0.21.

layer 2: screenplay fingerprint check (pre-parse, on raw text from pages 4-15)
layer 3: confidence scoring (post-parse, on ParseResult)

Stages run in order:
  1. detect_stage_play()      → check before rejecting for non-screenplay
  2. fingerprint_check()      → 3-signal screenplay fingerprint
  3. score_confidence()       → float 0.0–1.0 from parse result structure
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from models.schema import ParseResult

# ── layer 2: fingerprint check ────────────────────────────────────────────────

_SCENE_HEADING_RE = re.compile(
    r"^\s*(INT|EXT|INT\./EXT\.|INT/EXT\.|EXT/INT|I/E)[.\s]",
    re.MULTILINE | re.IGNORECASE | re.UNICODE,
)

_CAPS_WORD_RE = re.compile(r"^[A-Z\u00C0-\u00D6\u00D8-\u00DE][A-Z\u00C0-\u00D6\u00D8-\u00DE\s]{1,39}$", re.UNICODE)

# stage play detection (4.0.20)
_STAGE_PLAY_RE = re.compile(
    r"^(ACT|SCENE)\s+(\d+|ONE|TWO|THREE|FOUR|FIVE|[IVX]+)",
    re.MULTILINE | re.IGNORECASE | re.UNICODE,
)

# dialogue X bucket range for layout signal (PDF only)
_DIALOGUE_X_MIN = 180.0
_DIALOGUE_X_MAX = 252.0


@dataclass
class FingerprintResult:
    signals: int
    scene_heading_found: bool
    character_dialogue_found: bool
    layout_signal_found: bool
    low_confidence_flag: bool
    stage_play_detected: bool


def detect_stage_play(text: str) -> bool:
    """Return True if text matches stage play format (4.0.20)."""
    return bool(_STAGE_PLAY_RE.search(text))


def fingerprint_check(
    text: str,
    words_on_sample_pages: list[dict] | None = None,
    native_blocks: list | None = None,
) -> FingerprintResult:
    """
    layer 2 fingerprint check (task 4.0.19).

    always sample pages 4-15 (caller responsible for passing the right text slice).
    for scripts shorter than 10 pages, all pages should be sampled.

    three signals:
      1. Scene heading regex match
      2. ALL CAPS line (2-40 chars, not a scene heading) immediately before non-ALL-CAPS line
      3. Layout signal (PDF only): >20 words/blocks in dialogue X bucket
         Accepts pdfplumber word dicts OR NativeExtractionBlock objects.
    """
    signal_1 = bool(_SCENE_HEADING_RE.search(text))

    # signal 2: character-above-dialogue pattern
    signal_2 = False
    lines = text.split("\n")
    for i, line in enumerate(lines[:-1]):
        stripped = line.strip()
        next_stripped = lines[i + 1].strip() if i + 1 < len(lines) else ""
        if (
            len(stripped) >= 2
            and len(stripped) <= 40
            and stripped == stripped.upper()
            and not _SCENE_HEADING_RE.match(stripped)
            and next_stripped
            and next_stripped != next_stripped.upper()
        ):
            signal_2 = True
            break

    # signal 3: layout signal (PDF word objects or PyMuPDF blocks)
    signal_3 = False
    if words_on_sample_pages:
        dialogue_words = [
            w for w in words_on_sample_pages
            if _DIALOGUE_X_MIN <= w.get("x0", 0) <= _DIALOGUE_X_MAX
        ]
        signal_3 = len(dialogue_words) > 20
    elif native_blocks:
        dialogue_blocks = [
            b for b in native_blocks
            if len(b.bounding_box) >= 2
            and _DIALOGUE_X_MIN <= b.bounding_box[0] <= _DIALOGUE_X_MAX
        ]
        signal_3 = len(dialogue_blocks) > 20

    signals = int(signal_1) + int(signal_2) + int(signal_3)
    stage_play = not signal_1 and detect_stage_play(text)

    return FingerprintResult(
        signals=signals,
        scene_heading_found=signal_1,
        character_dialogue_found=signal_2,
        layout_signal_found=signal_3,
        low_confidence_flag=(signals == 1),
        stage_play_detected=stage_play,
    )


# ── layer 3: confidence scoring ───────────────────────────────────────────────

def score_confidence(result: ParseResult) -> float:
    """
    layer 3 confidence scoring (task 4.0.21).
    returns float 0.0–1.0.

    Components:
      - Scene count
      - Distinct character count
      - Dialogue element count
      - Dialogue-to-total-element ratio in range 0.25–0.70
      - Fraction of scenes with more than one element ≥ 0.80
    """
    # FDX always gets 1.0
    if result.format == "fdx":
        return 1.0

    scene_count = len(result.scenes)
    char_count = len(result.characters)

    all_elements = [el for scene in result.scenes for el in scene.elements]
    total_el = len(all_elements)
    dialogue_count = sum(
        1 for el in all_elements if el.type.value in ("dialogue", "parenthetical")
    )

    score = 0.0

    # scene count component (max 0.25)
    if scene_count >= 5:
        score += 0.25
    elif scene_count >= 2:
        score += 0.15
    elif scene_count >= 1:
        score += 0.05

    # character count component (max 0.20)
    if char_count >= 3:
        score += 0.20
    elif char_count >= 2:
        score += 0.12
    elif char_count >= 1:
        score += 0.05

    # dialogue count component (max 0.25)
    if dialogue_count >= 15:
        score += 0.25
    elif dialogue_count >= 5:
        score += 0.15
    elif dialogue_count >= 1:
        score += 0.05

    # dialogue ratio component (+0.15)
    if total_el > 0:
        ratio = dialogue_count / total_el
        if 0.25 <= ratio <= 0.70:
            score += 0.15

    # scene element density component (+0.15)
    if scene_count > 0:
        rich_scenes = sum(1 for s in result.scenes if len(s.elements) > 1)
        density = rich_scenes / scene_count
        if density >= 0.80:
            score += 0.15

    return round(min(score, 1.0), 4)
