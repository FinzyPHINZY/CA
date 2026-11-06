"""
Gemini character name normalization (Phase 4).

Post-processing step that sends the parsed character list + script context
to Gemini to normalize ambiguous names. Only triggers when the character
list contains names that look like abbreviations, numbers, or symbols.

Examples:
  - "#8" → "JUROR #8"
  - "MRS. R" → "MRS. ROBINSON"
  - "#3" → "JUROR #3"
  - "FOREMAN" stays "FOREMAN" (already clear)
"""
from __future__ import annotations

import json
import os
import re

import structlog

from models.schema import ParsedCharacter, ParseResult

log = structlog.get_logger()

# Characters that look ambiguous and might benefit from normalization
_AMBIGUOUS_RE = re.compile(
    r"^("
    r"#\d+"             # Numbered: #8, #12
    r"|[A-Z]\."         # Single initial: J., M.
    r"|[A-Z]{1,2}\s*$"  # 1-2 letter names: AL, J
    r"|MR\.?\s+[A-Z]$"  # Mr. + single letter: MR. R
    r"|MRS\.?\s+[A-Z]$" # Mrs. + single letter: MRS. R
    r"|MS\.?\s+[A-Z]$"  # Ms. + single letter: MS. R
    r"|DR\.?\s+[A-Z]$"  # Dr. + single letter: DR. K
    r")$",
    re.IGNORECASE,
)

_SYSTEM_PROMPT = """\
You are a screenplay character name normalizer. Given a list of character \
names extracted from a screenplay and a text excerpt for context, return \
normalized versions of ambiguous names.

Rules:
1. Only rename characters whose names are abbreviated, numbered, or unclear
2. Use context from the script text to determine full names
3. If the script uses numbered characters (like #8), determine the role \
prefix from context (e.g. "JUROR #8", "PLAYER #8", "SOLDIER #3")
4. Keep names that are already clear (FOREMAN, JUDGE, GUARD) unchanged
5. If you cannot determine a better name from context, keep the original
6. Preserve ALL CAPS formatting
7. Never invent names — only expand what's implied by the text

Output format: JSON object mapping original names to normalized names.
Only include names that should change. If no names need changing, return {}.

Example input:
Characters: #8, #3, FOREMAN, JUDGE
Context: "12 ANGRY MEN ... The jurors file into the jury room..."

Example output:
{"#8": "JUROR #8", "#3": "JUROR #3"}
"""

# Max context chars to send (first portion of raw text for title/role context)
_MAX_CONTEXT_CHARS = 8000


def _has_ambiguous_characters(characters: list[ParsedCharacter]) -> bool:
    """Return True if any character name looks ambiguous."""
    return any(_AMBIGUOUS_RE.match(c.name.strip()) for c in characters)


def _build_request(characters: list[ParsedCharacter], raw_text: str) -> str:
    """Build the user message for Gemini."""
    char_names = ", ".join(c.name for c in characters)
    context = raw_text[:_MAX_CONTEXT_CHARS]
    return (
        f"Characters: {char_names}\n\n"
        f"Context (first portion of script):\n{context}\n\n"
        "Return ONLY valid JSON mapping original names to normalized names. "
        "Only include names that should change."
    )


def normalize_character_names(parse_result: ParseResult) -> ParseResult:
    """
    Normalize ambiguous character names using Gemini.

    Only calls the API when the character list contains names matching
    ambiguous patterns. Applies the rename mapping to all character
    references in the parse result.

    Returns the (possibly modified) parse result. Never raises — logs
    warnings on failure and returns the original result unchanged.
    """
    if not parse_result.characters:
        return parse_result

    if not _has_ambiguous_characters(parse_result.characters):
        log.debug("character_normalization_skipped", reason="no ambiguous names")
        return parse_result

    api_key = os.getenv("GOOGLE_GEMINI_API_KEY")
    if not api_key:
        log.warning("character_normalization_skipped", reason="no API key")
        return parse_result

    try:
        import google.generativeai as genai

        model_name = os.getenv("GEMINI_MODEL_NAME", "gemini-2.0-flash")
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(
            model_name,
            system_instruction=_SYSTEM_PROMPT,
            generation_config={
                "temperature": 0,
                "response_mime_type": "application/json",
            },
        )

        user_message = _build_request(parse_result.characters, parse_result.raw_text)

        log.info(
            "character_normalization_request",
            model=model_name,
            character_count=len(parse_result.characters),
            ambiguous_count=sum(
                1 for c in parse_result.characters if _AMBIGUOUS_RE.match(c.name.strip())
            ),
        )

        response = model.generate_content(user_message)

        response_text = ""
        if hasattr(response, "text") and response.text:
            response_text = response.text
        elif response.candidates:
            for part in response.candidates[0].content.parts:
                if hasattr(part, "text"):
                    response_text += part.text

        if not response_text.strip():
            log.warning("character_normalization_empty_response")
            return parse_result

        # Parse JSON — strip markdown fences if present
        text = response_text.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*\n?", "", text)
            text = re.sub(r"\n?```\s*$", "", text)

        rename_map: dict[str, str] = json.loads(text)

        if not rename_map:
            log.info("character_normalization_no_changes")
            return parse_result

        # Validate: only accept renames where the original exists
        valid_names = {c.name for c in parse_result.characters}
        rename_map = {k: v for k, v in rename_map.items() if k in valid_names and v}

        if not rename_map:
            log.info("character_normalization_no_valid_renames")
            return parse_result

        log.info(
            "character_normalization_applying",
            renames=rename_map,
        )

        # Apply renames to character list
        for char in parse_result.characters:
            if char.name in rename_map:
                char.name = rename_map[char.name]

        # Apply renames to all element references in scenes
        for scene in parse_result.scenes:
            for el in scene.elements:
                if el.character_name and el.character_name in rename_map:
                    el.character_name = rename_map[el.character_name]
                if el.type.value == "character" and el.text in rename_map:
                    el.text = rename_map[el.text]

        log.info(
            "character_normalization_complete",
            renamed_count=len(rename_map),
        )

        return parse_result

    except Exception as exc:
        log.warning(
            "character_normalization_failed",
            error=str(exc),
        )
        return parse_result
