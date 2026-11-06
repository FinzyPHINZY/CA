"""
TXT / Fountain parser (task 4.0.11).

Strategy:
  1. Attempt Fountain parsing via fountain-py.
  2. Accept if ≥1 scene heading AND ≥1 character/dialogue pair found.
  3. Fall back to raw heuristic regex-based TXT parser if Fountain produces nothing.
"""
from __future__ import annotations

import re
from collections import defaultdict

import structlog

from models.schema import (
    ElementType,
    ParsedCharacter,
    ParseResult,
    Scene,
    ScriptElement,
)
from pipeline.normalization import (
    extract_scene_number,
    is_uppercase,
    is_valid_character_name,
    merge_consecutive_dialogue,
    strip_contd,
)

log = structlog.get_logger()

# ── Fountain-py wrapper ───────────────────────────────────────────────────────

def _try_fountain(text: str) -> ParseResult | None:
    """Attempt to parse text using fountain-py. Returns None if not enough structure found."""
    try:
        import fountain as fountain_module

        script = fountain_module.parse(text)
    except Exception as exc:
        log.warning("fountain_parse_error", error=str(exc))
        return None

    scenes: list[Scene] = []
    current_scene: Scene | None = None
    current_elements: list[ScriptElement] = []
    current_char_name: str | None = None
    char_line_counts: dict[str, int] = defaultdict(int)
    raw_lines: list[str] = []

    def _finalize_scene() -> None:
        nonlocal current_scene, current_elements
        if current_scene is not None:
            current_scene.elements = current_elements[:]
            scenes.append(current_scene)
            current_scene = None
            current_elements = []

    _FOUNTAIN_TYPE_MAP = {
        "scene_heading": ElementType.SCENE_HEADING,
        "action": ElementType.ACTION,
        "character": ElementType.CHARACTER,
        "dialogue": ElementType.DIALOGUE,
        "parenthetical": ElementType.PARENTHETICAL,
        "transition": ElementType.TRANSITION,
        "note": ElementType.NOTE,
    }

    for element in getattr(script, "elements", []):
        elem_text = getattr(element, "text", "").strip()
        elem_type_str = getattr(element, "type", "action").lower()
        if not elem_text:
            continue

        raw_lines.append(elem_text)
        elem_type = _FOUNTAIN_TYPE_MAP.get(elem_type_str, ElementType.ACTION)

        if elem_type == ElementType.SCENE_HEADING:
            _finalize_scene()
            script_num, heading_clean = extract_scene_number(elem_text)
            current_scene = Scene(
                number=len(scenes) + 1,
                script_scene_number=script_num,
                heading=heading_clean,
            )
            current_elements = []
            current_char_name = None

        elif elem_type == ElementType.CHARACTER:
            normalized = strip_contd(elem_text)
            current_char_name = normalized
            current_elements.append(
                ScriptElement(type=elem_type, text=normalized, character_name=normalized)
            )
            char_line_counts[normalized] += 1

        elif elem_type == ElementType.DIALOGUE:
            current_elements.append(
                ScriptElement(type=elem_type, text=elem_text, character_name=current_char_name)
            )
            if current_char_name:
                char_line_counts[current_char_name] += 1

        else:
            current_elements.append(ScriptElement(type=elem_type, text=elem_text))
            if elem_type not in (ElementType.PARENTHETICAL, ElementType.TRANSITION):
                current_char_name = None

    _finalize_scene()

    # Check acceptance criteria: ≥1 scene heading + ≥1 character or dialogue
    has_scenes = any(
        any(el.type == ElementType.SCENE_HEADING for el in s.elements) or s.heading != "(Document)"
        for s in scenes
    )
    has_dialogue = any(
        any(el.type in (ElementType.DIALOGUE, ElementType.CHARACTER) for el in s.elements)
        for s in scenes
    )

    # Also check scene count directly
    if not scenes or (not has_dialogue and len(scenes) < 2):
        return None

    characters = [
        ParsedCharacter(name=name, line_count=count)
        for name, count in sorted(char_line_counts.items(), key=lambda x: -x[1])
    ]

    return ParseResult(
        format="fountain",
        scenes=scenes,
        characters=characters,
        raw_text="\n".join(raw_lines),
        page_count=max(1, len(raw_lines) // 55),
    )


# ── Raw heuristic TXT parser ─────────────────────────────────────────────────

_SCENE_RE = re.compile(
    r"^(?:\d{1,4}\s+)?(INT\.?|EXT\.?|INT\./EXT\.|INT/EXT\.|EXT/INT|I/E)[.\s]",
    re.IGNORECASE | re.UNICODE,
)
_TRANSITION_RE = re.compile(r"TO:\s*$", re.UNICODE)

# Inline dialogue: CHARACTER_NAME (optional parenthetical) dialogue text
# Matches lines like:
#   BEN (stunned) How do you know my name?
#   ADDISON Ben, it's me Addison.
#   ADDISON (O.S.) Don't be so dramatic-
_INLINE_DIALOGUE_RE = re.compile(
    r"^([A-Z][A-Z .''\-]{0,38}?)"  # Capture group 1: character name (ALL CAPS, 1-40 chars)
    r"\s+"                           # At least one space after the name
    r"(?:(\([^)]+\))\s+)?"          # Capture group 2: optional parenthetical, followed by space
    r"(.+)$",                        # Capture group 3: dialogue text
    re.UNICODE,
)

# Any parenthetical after an ALL-CAPS name is a strong dialogue signal.
# Parenthetical stage directions (stunned, beat, O.S., etc.) only appear
# in screenplay dialogue — their presence confirms the line is dialogue.
_STRONG_PAREN_RE = re.compile(
    r"\([^)]{1,60}\)",  # Any parenthetical, 1-60 chars
)


def _needs_inline_detection(scenes: list[Scene]) -> bool:
    """Check if Pass 2 inline dialogue detection should activate."""
    total = 0
    dialogue_count = 0
    for scene in scenes:
        for el in scene.elements:
            if el.type in (ElementType.SCENE_HEADING, ElementType.TRANSITION):
                continue
            total += 1
            if el.type == ElementType.DIALOGUE:
                dialogue_count += 1
    if total == 0:
        return False
    return (dialogue_count / total) <= 0.10


def _detect_inline_characters(scenes: list[Scene]) -> set[str]:
    """
    Scan ACTION elements for strong parenthetical signals to discover
    character names used in inline dialogue format.
    """
    names: set[str] = set()
    for scene in scenes:
        for el in scene.elements:
            if el.type != ElementType.ACTION:
                continue
            m = _INLINE_DIALOGUE_RE.match(el.text)
            if not m:
                continue
            paren = m.group(2)
            # Require a strong parenthetical signal for the first pass
            if paren and _STRONG_PAREN_RE.search(paren):
                name = strip_contd(m.group(1).strip())
                if name and len(name) >= 2:
                    names.add(name)
    return names


# Common action verbs that follow character names in stage directions.
# If dialogue text starts with one of these, the line is likely ACTION.
_ACTION_VERB_RE = re.compile(
    r"^(?:takes|picks|grabs|walks|runs|stands|sits|looks|turns|moves"
    r"|enters|exits|crosses|opens|closes|pulls|pushes|reaches|holds"
    r"|puts|steps|stops|starts|gets|goes|comes|leaves|stares|leans"
    r"|nods|shakes|sighs|pauses|watches|glances|points|drops|throws"
    r"|slams|hands|sets|places|rises|falls|kneels|rushes|hurries"
    r"|appears|disappears|approaches|retreats|notices|spins|waves"
    r"|is |and )\b",
    re.IGNORECASE,
)


def _reclassify_inline_dialogue(
    elements: list[ScriptElement],
    char_names: set[str],
    char_line_counts: dict[str, int],
) -> list[ScriptElement]:
    """
    Re-scan ACTION elements and split inline dialogue into
    CHARACTER + optional PARENTHETICAL + DIALOGUE elements.
    """
    result: list[ScriptElement] = []
    for el in elements:
        if el.type != ElementType.ACTION:
            result.append(el)
            continue

        m = _INLINE_DIALOGUE_RE.match(el.text)
        if not m:
            result.append(el)
            continue

        name = strip_contd(m.group(1).strip())
        if name not in char_names:
            result.append(el)
            continue

        paren = m.group(2)
        dialogue_text = m.group(3).strip()

        # Without a parenthetical, check if the text starts with an action
        # verb — if so, keep as ACTION to avoid false positives like
        # "ADDISON takes her HANDLINK"
        if not paren and dialogue_text and _ACTION_VERB_RE.match(dialogue_text):
            result.append(el)
            continue

        # Split into CHARACTER + optional PARENTHETICAL + DIALOGUE
        result.append(
            ScriptElement(type=ElementType.CHARACTER, text=name, character_name=name)
        )
        char_line_counts[name] += 1

        if paren:
            result.append(
                ScriptElement(type=ElementType.PARENTHETICAL, text=paren, character_name=name)
            )

        if dialogue_text:
            result.append(
                ScriptElement(type=ElementType.DIALOGUE, text=dialogue_text, character_name=name)
            )
            char_line_counts[name] += 1

    return result


def _txt_heuristic(text: str) -> ParseResult:
    """Fallback regex-based TXT parser when Fountain format is not detected."""
    lines = text.split("\n")
    scenes: list[Scene] = []
    current_scene: Scene | None = None
    current_elements: list[ScriptElement] = []
    current_char_name: str | None = None
    char_line_counts: dict[str, int] = defaultdict(int)
    raw_lines: list[str] = []
    prev_type: ElementType | None = None

    def _finalize_scene() -> None:
        nonlocal current_scene, current_elements
        if current_scene is not None:
            current_scene.elements = current_elements[:]
            scenes.append(current_scene)
            current_scene = None
            current_elements = []

    for i, raw_line in enumerate(lines):
        line = raw_line.strip()
        if not line:
            continue

        # Skip standalone page numbers (e.g., "2.", "72.", "153.")
        if re.match(r"^\d{1,4}\.$", line):
            continue

        raw_lines.append(line)

        # Scene heading
        if _SCENE_RE.match(line):
            _finalize_scene()
            script_num, heading_clean = extract_scene_number(line)
            current_scene = Scene(
                number=len(scenes) + 1,
                script_scene_number=script_num,
                heading=heading_clean,
            )
            current_elements = []
            current_char_name = None
            prev_type = ElementType.SCENE_HEADING
            continue

        # Transition
        if _TRANSITION_RE.search(line) or (is_uppercase(line) and line.endswith("TO:")):
            current_elements.append(ScriptElement(type=ElementType.TRANSITION, text=line))
            prev_type = ElementType.TRANSITION
            current_char_name = None
            continue

        # Character name: standalone ALL CAPS line (2–40 chars)
        # followed by a non-ALL-CAPS line
        next_line = ""
        for j in range(i + 1, min(i + 4, len(lines))):
            if lines[j].strip():
                next_line = lines[j].strip()
                break

        if (
            is_uppercase(line)
            and 2 <= len(line) <= 40
            and next_line
            and not is_uppercase(next_line)
            and not _SCENE_RE.match(line)
            and is_valid_character_name(line)
        ):
            normalized = strip_contd(line)
            current_char_name = normalized
            current_elements.append(
                ScriptElement(type=ElementType.CHARACTER, text=normalized, character_name=normalized)
            )
            char_line_counts[normalized] += 1
            prev_type = ElementType.CHARACTER
            continue

        # Parenthetical
        if line.startswith("(") and line.endswith(")"):
            current_elements.append(
                ScriptElement(type=ElementType.PARENTHETICAL, text=line, character_name=current_char_name)
            )
            prev_type = ElementType.PARENTHETICAL
            continue

        # Dialogue: follows character/parenthetical
        if prev_type in (ElementType.CHARACTER, ElementType.DIALOGUE, ElementType.PARENTHETICAL):
            current_elements.append(
                ScriptElement(type=ElementType.DIALOGUE, text=line, character_name=current_char_name)
            )
            if current_char_name:
                char_line_counts[current_char_name] += 1
            prev_type = ElementType.DIALOGUE
            continue

        # Action
        current_elements.append(ScriptElement(type=ElementType.ACTION, text=line))
        current_char_name = None
        prev_type = ElementType.ACTION

    _finalize_scene()

    if current_elements and not scenes:
        scenes = [Scene(number=1, heading="(Document)", elements=current_elements)]

    # ── Pass 2: Inline dialogue detection ────────────────────────────────
    # Only activates when Pass 1 found very few dialogue elements (≤10%),
    # indicating the script uses inline formatting (character name + dialogue
    # on the same line) rather than standard screenplay layout.
    if _needs_inline_detection(scenes):
        inline_chars = _detect_inline_characters(scenes)
        if len(inline_chars) >= 2:
            log.info(
                "inline_dialogue_pass2_activated",
                character_names=sorted(inline_chars),
                scene_count=len(scenes),
            )
            for scene in scenes:
                scene.elements = _reclassify_inline_dialogue(
                    scene.elements, inline_chars, char_line_counts,
                )

    # ── Pass 3: Merge consecutive same-character dialogue lines ────────
    # pdfplumber extracts each PDF line separately, so a multi-line speech
    # becomes multiple DIALOGUE elements. Merge them into single blocks.
    for scene in scenes:
        scene.elements = merge_consecutive_dialogue(scene.elements)

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

    return ParseResult(
        format="txt_heuristic",
        scenes=scenes,
        characters=characters,
        raw_text="\n".join(raw_lines),
        page_count=max(1, len(raw_lines) // 55),
    )


def parse_fountain(file_bytes: bytes) -> ParseResult:
    """
    Main entry for TXT/Fountain files (task 4.0.11).
    Fountain-py first, fallback to TXT heuristic.
    """
    text = file_bytes.decode("utf-8", errors="replace")

    result = _try_fountain(text)
    if result is not None:
        log.info("fountain_parse_success", scenes=len(result.scenes))
        return result

    log.info("fountain_parse_fallback_to_txt_heuristic")
    return _txt_heuristic(text)
