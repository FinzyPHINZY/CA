"""
DOCX parser (task 4.0.10).

Primary path: paragraph styles (if ≥80% of paragraphs have recognised style names).
Fallback path: indentation heuristic (for manually-typed scripts in plain Word).
"""
from __future__ import annotations

import io
from collections import defaultdict

import structlog
from docx import Document
from docx.shared import Pt

from models.schema import (
    ElementType,
    ParsedCharacter,
    ParseResult,
    Scene,
    ScriptElement,
)
from pipeline.normalization import extract_scene_number, is_uppercase, strip_contd

log = structlog.get_logger()

# Static style name → ElementType lookup
_STYLE_MAP: dict[str, ElementType] = {
    "scene heading": ElementType.SCENE_HEADING,
    "slug line": ElementType.SCENE_HEADING,
    "shot": ElementType.SCENE_HEADING,
    "slugline": ElementType.SCENE_HEADING,
    "action": ElementType.ACTION,
    "character": ElementType.CHARACTER,
    "character name": ElementType.CHARACTER,
    "dialogue": ElementType.DIALOGUE,
    "dialog": ElementType.DIALOGUE,
    "parenthetical": ElementType.PARENTHETICAL,
    "transition": ElementType.TRANSITION,
    "note": ElementType.NOTE,
    "general": ElementType.NOTE,
    # Fade Pro / Highland / Slugline app style names
    "int ext": ElementType.SCENE_HEADING,
    "scene": ElementType.SCENE_HEADING,
}


def _style_to_element_type(style_name: str) -> ElementType | None:
    key = style_name.lower().strip()
    for pattern, elem_type in _STYLE_MAP.items():
        if key == pattern or key.startswith(pattern):
            return elem_type
    return None


def _classify_by_indent(
    indent_pt: float,
    text: str,
    indent_levels: list[float],
) -> ElementType:
    """Map indentation level to element type when styles are unavailable."""
    ucase = is_uppercase(text)

    if not indent_levels:
        return ElementType.ACTION

    min_indent = min(indent_levels)
    # Cluster paragraphs into 4 levels: action, dialogue, paren, character
    # The leftmost = action/scene, next = dialogue, next = parenthetical, most indented = character
    level = sorted(set(int(x // 18) * 18 for x in indent_levels))

    if len(level) == 0:
        return ElementType.ACTION

    bucket = min(range(len(level)), key=lambda i: abs(level[i] - int(indent_pt // 18) * 18))

    if bucket == 0:
        if ucase:
            return ElementType.SCENE_HEADING
        return ElementType.ACTION
    elif bucket == 1:
        return ElementType.DIALOGUE
    elif bucket == 2:
        if text.startswith("(") and text.endswith(")"):
            return ElementType.PARENTHETICAL
        return ElementType.CHARACTER
    else:
        return ElementType.CHARACTER


def parse_docx(file_bytes: bytes) -> ParseResult:
    """Parse a DOCX file using paragraph styles with indentation fallback (task 4.0.10)."""
    doc = Document(io.BytesIO(file_bytes))
    paragraphs = [p for p in doc.paragraphs if p.text.strip()]

    if not paragraphs:
        return ParseResult(
            format="docx_styled",
            parser_warnings=["DOCX appears to be empty"],
        )

    # Determine whether to use style-based or indentation-based classification
    total = len(paragraphs)
    recognised = sum(
        1 for p in paragraphs if _style_to_element_type(p.style.name) is not None
    )
    use_styles = recognised / total >= 0.80

    log.info(
        "docx_parser_mode",
        total=total,
        recognised=recognised,
        ratio=recognised / total,
        mode="styled" if use_styles else "heuristic",
    )

    # Collect indent values for heuristic mode
    indent_levels: list[float] = []
    if not use_styles:
        for p in paragraphs:
            indent = p.paragraph_format.left_indent
            if indent is not None:
                indent_levels.append(float(indent.pt))
        indent_levels = sorted(set(indent_levels))

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

    for para in paragraphs:
        text = para.text.strip()
        if not text:
            continue
        raw_lines.append(text)

        if use_styles:
            elem_type = _style_to_element_type(para.style.name) or ElementType.ACTION
        else:
            indent = para.paragraph_format.left_indent
            indent_pt = float(indent.pt) if indent else 0.0
            elem_type = _classify_by_indent(indent_pt, text, indent_levels)

        if elem_type == ElementType.SCENE_HEADING:
            _finalize_scene()
            script_num, heading_clean = extract_scene_number(text)
            current_scene = Scene(
                number=len(scenes) + 1,
                script_scene_number=script_num,
                heading=heading_clean,
            )
            current_elements = []
            current_char_name = None

        elif elem_type == ElementType.CHARACTER:
            normalized = strip_contd(text)
            current_char_name = normalized
            current_elements.append(
                ScriptElement(type=elem_type, text=normalized, character_name=normalized)
            )
            char_line_counts[normalized] += 1

        elif elem_type == ElementType.DIALOGUE:
            current_elements.append(
                ScriptElement(type=elem_type, text=text, character_name=current_char_name)
            )
            if current_char_name:
                char_line_counts[current_char_name] += 1

        else:
            current_elements.append(ScriptElement(type=elem_type, text=text))
            if elem_type not in (ElementType.PARENTHETICAL, ElementType.TRANSITION):
                current_char_name = None

    _finalize_scene()

    # Orphaned elements
    if current_elements:
        scenes.append(
            Scene(number=len(scenes) + 1, heading="(Document)", elements=current_elements)
        )

    characters = [
        ParsedCharacter(name=name, line_count=count)
        for name, count in sorted(char_line_counts.items(), key=lambda x: -x[1])
    ]

    parse_format = "docx_styled" if use_styles else "docx_heuristic"

    return ParseResult(
        format=parse_format,  # type: ignore[arg-type]
        scenes=scenes,
        characters=characters,
        raw_text="\n".join(raw_lines),
        page_count=max(1, len(raw_lines) // 55),
    )
