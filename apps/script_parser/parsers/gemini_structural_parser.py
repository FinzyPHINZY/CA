"""
Gemini structural classification parser (Phase 3 — safety net).

Takes raw text already extracted by PyMuPDF and sends it to Gemini for
structural re-classification when the deterministic parser confidence < 0.50.

This parser does NOT extract text from PDFs — it only re-classifies text
that was already extracted. The result is a ParseResult with format
"gemini_structural".
"""
from __future__ import annotations

import json
import os
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
from pipeline.gemini_structural_prompt import (
    SYSTEM_PROMPT,
    build_gemini_structural_request,
)
from pipeline.normalization import (
    is_valid_character_name,
    strip_contd,
)

log = structlog.get_logger()

# Map JSON type strings to ElementType enum
_TYPE_MAP = {
    "scene_heading": ElementType.SCENE_HEADING,
    "character": ElementType.CHARACTER,
    "dialogue": ElementType.DIALOGUE,
    "parenthetical": ElementType.PARENTHETICAL,
    "action": ElementType.ACTION,
    "transition": ElementType.TRANSITION,
}

# Max chars to send to Gemini (avoid token limit issues)
_MAX_INPUT_CHARS = 800_000


def _parse_gemini_json(raw_response: str) -> dict:
    """
    Parse Gemini's JSON response, stripping markdown fences if present.
    Raises ValueError on malformed JSON.
    """
    text = raw_response.strip()
    # Strip markdown code fences: ```json ... ```
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    return json.loads(text)


def _build_parse_result(data: dict) -> ParseResult:
    """Convert Gemini's JSON response into a ParseResult."""
    scenes: list[Scene] = []
    char_line_counts: dict[str, int] = defaultdict(int)
    raw_lines: list[str] = []

    for scene_data in data.get("scenes", []):
        elements: list[ScriptElement] = []
        current_char_name: str | None = None

        for el_data in scene_data.get("elements", []):
            type_str = el_data.get("type", "action")
            elem_type = _TYPE_MAP.get(type_str, ElementType.ACTION)
            text = el_data.get("text", "").strip()
            char_name = el_data.get("character_name")

            if not text:
                continue

            raw_lines.append(text)

            if elem_type == ElementType.CHARACTER:
                if char_name:
                    char_name = strip_contd(char_name)
                    if not is_valid_character_name(char_name):
                        elem_type = ElementType.ACTION
                        char_name = None
                    else:
                        current_char_name = char_name
                        char_line_counts[char_name] += 1
                else:
                    # Gemini didn't provide character_name — use text
                    char_name = strip_contd(text)
                    if is_valid_character_name(char_name):
                        current_char_name = char_name
                        char_line_counts[char_name] += 1
                    else:
                        elem_type = ElementType.ACTION
                        char_name = None

            elif elem_type == ElementType.DIALOGUE:
                if not char_name and current_char_name:
                    char_name = current_char_name
                if char_name:
                    char_line_counts[char_name] += 1

            elif elem_type == ElementType.PARENTHETICAL:
                if not char_name and current_char_name:
                    char_name = current_char_name

            elif elem_type in (ElementType.ACTION, ElementType.TRANSITION, ElementType.SCENE_HEADING):
                if elem_type != ElementType.TRANSITION:
                    current_char_name = None
                char_name = None

            elements.append(
                ScriptElement(
                    type=elem_type,
                    text=text,
                    character_name=char_name,
                )
            )

        heading = scene_data.get("heading", "UNKNOWN")
        script_num = scene_data.get("script_scene_number")

        scenes.append(
            Scene(
                number=len(scenes) + 1,
                script_scene_number=script_num,
                heading=heading,
                elements=elements,
            )
        )

    characters = [
        ParsedCharacter(name=name, line_count=count)
        for name, count in sorted(char_line_counts.items(), key=lambda x: -x[1])
    ]

    return ParseResult(
        format="gemini_structural",
        scenes=scenes,
        characters=characters,
        raw_text="\n".join(raw_lines),
    )


def parse_with_gemini_structural(
    raw_text: str,
    page_count: int = 0,
    watermark_detected: bool = False,
    watermark_texts: list[str] | None = None,
) -> ParseResult:
    """
    Send already-extracted raw text to Gemini for structural classification.

    Raises RuntimeError if the API key is missing or the API call fails
    after retries, so the caller can catch and fall back gracefully.
    """
    import google.generativeai as genai

    api_key = os.getenv("GOOGLE_GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_GEMINI_API_KEY is not configured")

    model_name = os.getenv("GEMINI_MODEL_NAME", "gemini-2.0-flash")

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(
        model_name,
        system_instruction=SYSTEM_PROMPT,
        generation_config={
            "temperature": 0,
            "response_mime_type": "application/json",
        },
    )

    # Truncate if too long (preserve beginning which has scene structure)
    input_text = raw_text[:_MAX_INPUT_CHARS]
    if len(raw_text) > _MAX_INPUT_CHARS:
        log.warning(
            "gemini_structural_input_truncated",
            original_chars=len(raw_text),
            truncated_to=_MAX_INPUT_CHARS,
        )

    user_message = build_gemini_structural_request(input_text)

    log.info(
        "gemini_structural_request",
        model=model_name,
        input_chars=len(input_text),
    )

    # Attempt with one retry on malformed JSON
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            response = model.generate_content(user_message)

            response_text = ""
            if hasattr(response, "text") and response.text:
                response_text = response.text
            elif response.candidates:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, "text"):
                        response_text += part.text

            if not response_text.strip():
                raise RuntimeError("Gemini returned an empty response")

            data = _parse_gemini_json(response_text)
            result = _build_parse_result(data)

            result.page_count = page_count
            result.watermark_detected = watermark_detected
            result.watermark_texts = watermark_texts or []

            log.info(
                "gemini_structural_complete",
                scene_count=len(result.scenes),
                character_count=len(result.characters),
                element_count=sum(len(s.elements) for s in result.scenes),
            )

            return result

        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            last_error = exc
            log.warning(
                "gemini_structural_json_error",
                attempt=attempt + 1,
                error=str(exc),
            )
            continue
        except Exception as exc:
            raise RuntimeError(f"Gemini structural classification failed: {exc}") from exc

    raise RuntimeError(
        f"Gemini structural classification failed after retries: {last_error}"
    )
