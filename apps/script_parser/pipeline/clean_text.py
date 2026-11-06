"""
Clean text reconstruction for Gemini (task 4.0.24).

Generates clean_text from the structured ParseResult — NOT from raw extracted bytes.
Reconstructs by walking ParseResult.scenes with correct screenplay indentation per element type.

This eliminates watermark fragments, page numbers, revision markers, and layout noise
from what Gemini receives. clean_text is what Gemini analyzes; raw_text is for audit only.
"""
from __future__ import annotations

from models.schema import ElementType, ParseResult, Scene, ScriptElement

# indentation in spaces for each element type
_INDENT = {
    ElementType.SCENE_HEADING: 0,
    ElementType.ACTION: 0,
    ElementType.CHARACTER: 22,
    ElementType.DIALOGUE: 10,
    ElementType.PARENTHETICAL: 15,
    ElementType.TRANSITION: 0,
    ElementType.NOTE: 0,
    ElementType.DUAL_DIALOGUE: 10,
}


def _indent(text: str, spaces: int) -> str:
    prefix = " " * spaces
    return "\n".join(prefix + line for line in text.split("\n"))


def reconstruct_clean_text(result: ParseResult) -> str:
    """
    Walk result.scenes and format each element with screenplay-standard indentation.
    Returns a single string suitable for Gemini semantic analysis.
    """
    output_blocks: list[str] = []

    for scene in result.scenes:
        # scene heading
        output_blocks.append(scene.heading.upper())
        output_blocks.append("")

        for el in scene.elements:
            spaces = _INDENT.get(el.type, 0)

            if el.type == ElementType.SCENE_HEADING:
                output_blocks.append(el.text.upper())

            elif el.type == ElementType.CHARACTER:
                output_blocks.append(_indent(el.text.upper(), spaces))

            elif el.type == ElementType.TRANSITION:
                # transitions are right-aligned; approximate with large indent
                output_blocks.append(_indent(el.text.upper(), 42))

            elif el.type in (ElementType.NOTE, ElementType.DUAL_DIALOGUE):
                # skip notes and raw dual_dialogue markers in clean output
                continue

            else:
                output_blocks.append(_indent(el.text, spaces))

        output_blocks.append("")  # blank line between scenes

    return "\n".join(output_blocks).strip()
