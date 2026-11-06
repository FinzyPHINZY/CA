"""
FDX (Final Draft XML) parser — task 4.0.6.

Uses Python's built-in xml.etree.ElementTree. No third-party dependency.
Walks all <Paragraph> elements and maps the Type attribute to ElementType
using a static lookup table.

FDX always produces structure_confidence_score = 1.0.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from collections import defaultdict

import structlog

from models.schema import (
    ElementType,
    ParsedCharacter,
    ParseFormat,
    ParseResult,
    Scene,
    ScriptElement,
)
from parsers.base import BaseParser
from pipeline.normalization import strip_contd, extract_scene_number

log = structlog.get_logger()

# Static lookup from FDX Paragraph Type → ElementType
_TYPE_MAP: dict[str, ElementType] = {
    "Scene Heading": ElementType.SCENE_HEADING,
    "Action": ElementType.ACTION,
    "Character": ElementType.CHARACTER,
    "Dialogue": ElementType.DIALOGUE,
    "Parenthetical": ElementType.PARENTHETICAL,
    "Transition": ElementType.TRANSITION,
    "Shot": ElementType.ACTION,
    "General": ElementType.NOTE,
    "GeneralNote": ElementType.NOTE,
    "Cast List": ElementType.NOTE,
    "New Act": ElementType.SCENE_HEADING,
    "More": ElementType.NOTE,
}


def _extract_text(para_elem: ET.Element) -> str:
    """Join all <Text> child text content with a single space."""
    parts: list[str] = []
    for text_elem in para_elem.findall(".//Text"):
        t = (text_elem.text or "").strip()
        if t:
            parts.append(t)
    return " ".join(parts)


class FdxParser(BaseParser):
    def parse(self, file_bytes: bytes) -> ParseResult:
        text = file_bytes.decode("utf-8", errors="replace")

        try:
            root = ET.fromstring(text)
        except ET.ParseError as exc:
            raise ValueError(f"Invalid FDX XML: {exc}") from exc

        # Strip namespace prefix for cleaner element finding
        ns_map: dict[str, str] = {}
        for elem in root.iter():
            if "}" in elem.tag:
                ns, local = elem.tag[1:].split("}", 1)
                ns_map[ns] = local

        scenes: list[Scene] = []
        current_scene: Scene | None = None
        current_elements: list[ScriptElement] = []
        current_char_name: str | None = None

        raw_lines: list[str] = []
        char_line_counts: dict[str, int] = defaultdict(int)

        page_count = 0

        def _finalize_scene() -> None:
            nonlocal current_scene, current_elements
            if current_scene is not None:
                current_scene.elements = current_elements[:]
                scenes.append(current_scene)
                current_scene = None
                current_elements = []

        # Walk all paragraphs including those inside DualDialogue wrappers
        paragraphs = root.findall(".//{*}Paragraph")
        if not paragraphs:
            # Try without namespace
            paragraphs = root.findall(".//Paragraph")

        for para in paragraphs:
            para_type = para.get("Type", "Action")
            elem_type = _TYPE_MAP.get(para_type, ElementType.ACTION)
            raw = _extract_text(para)
            if not raw:
                continue

            raw_lines.append(raw)

            if elem_type == ElementType.SCENE_HEADING:
                _finalize_scene()
                scene_num = len(scenes) + 1
                script_num, heading_clean = extract_scene_number(raw)
                current_scene = Scene(
                    number=scene_num,
                    script_scene_number=script_num,
                    heading=heading_clean,
                )
                current_elements = []
                current_char_name = None

            elif elem_type == ElementType.CHARACTER:
                normalized = strip_contd(raw)
                current_char_name = normalized
                current_elements.append(
                    ScriptElement(
                        type=elem_type,
                        text=normalized,
                        character_name=normalized,
                    )
                )
                char_line_counts[normalized] += 1

            elif elem_type == ElementType.DIALOGUE:
                current_elements.append(
                    ScriptElement(
                        type=elem_type,
                        text=raw,
                        character_name=current_char_name,
                    )
                )
                if current_char_name:
                    char_line_counts[current_char_name] += 1

            elif elem_type == ElementType.PARENTHETICAL:
                current_elements.append(
                    ScriptElement(
                        type=elem_type,
                        text=raw,
                        character_name=current_char_name,
                    )
                )

            else:
                current_elements.append(ScriptElement(type=elem_type, text=raw))
                current_char_name = None

        _finalize_scene()

        # Handle trailing elements with no scene heading (title page etc.)
        if current_elements:
            scene_num = len(scenes) + 1
            orphan = Scene(number=scene_num, heading="(Preamble)", elements=current_elements)
            scenes.insert(0, orphan)

        # If no scenes at all, wrap everything in a single scene
        if not scenes and raw_lines:
            scenes = [
                Scene(
                    number=1,
                    heading="(Document)",
                    elements=[ScriptElement(type=ElementType.ACTION, text=ln) for ln in raw_lines],
                )
            ]

        characters = [
            ParsedCharacter(name=name, line_count=count)
            for name, count in sorted(char_line_counts.items(), key=lambda x: -x[1])
        ]

        raw_text = "\n".join(raw_lines)

        # Attempt page count from <HeaderAndFooter> or <PageLayout> element
        for elem in root.iter():
            tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
            if tag == "PageLayout":
                try:
                    page_count = int(elem.get("LinesPerPage", 0))
                except ValueError:
                    pass

        if page_count == 0:
            page_count = max(1, len(raw_lines) // 55)

        log.info(
            "fdx_parse_complete",
            scenes=len(scenes),
            characters=len(characters),
            page_count=page_count,
        )

        return ParseResult(
            format="fdx",
            scenes=scenes,
            characters=characters,
            raw_text=raw_text,
            page_count=page_count,
            # FDX is always fully confident — deterministic XML
            structure_confidence_score=1.0,
        )
