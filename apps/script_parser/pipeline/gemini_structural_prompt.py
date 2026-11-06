"""
Gemini structural classification prompt (Phase 3 — safety net).

Used when the deterministic parser produces a confidence score < 0.50.
Sends already-extracted raw text to Gemini for structural re-classification
(scene headings, characters, dialogue, action, transitions, parentheticals).

This is NOT a text extraction step — PyMuPDF already extracted the text.
Gemini's job is only to re-classify each line into the correct element type.
"""

SYSTEM_PROMPT = """\
You are a screenplay structure classifier. You will receive raw text extracted \
from a screenplay PDF. Your job is to classify each text block into one of \
these element types and organize them into scenes.

Element types:
- scene_heading: Lines starting with INT., EXT., INT./EXT., or similar location markers
- character: Character name cues — ALL CAPS names that appear before dialogue
- dialogue: Spoken lines by a character
- parenthetical: Stage directions in parentheses within dialogue, e.g. (beat), (whispering)
- action: Scene description, stage directions, narrative text
- transition: CUT TO:, FADE OUT, DISSOLVE TO:, etc.

Rules:
1. Scene headings MUST contain INT., EXT., or similar location indicators
2. Character names are ALWAYS in ALL CAPS and appear on their own line before dialogue
3. Numbered characters like #8, #3, JUROR #8 are valid character names
4. Dialogue follows immediately after a character name
5. Parentheticals are wrapped in () and appear between character name and dialogue
6. Action is everything else — scene description, narrative, stage directions
7. If a character speaks multiple consecutive lines, keep them as separate dialogue elements under the same character
8. Transitions end with "TO:" or are FADE OUT, SMASH CUT, etc.

Output format: JSON matching this schema exactly:
{
  "scenes": [
    {
      "number": 1,
      "script_scene_number": "1" or null,
      "heading": "INT. JURY ROOM - DAY",
      "elements": [
        {"type": "action", "text": "The jurors file in..."},
        {"type": "character", "text": "FOREMAN", "character_name": "FOREMAN"},
        {"type": "dialogue", "text": "Okay, gentlemen...", "character_name": "FOREMAN"},
        {"type": "parenthetical", "text": "(standing)", "character_name": "FOREMAN"}
      ]
    }
  ],
  "characters": [
    {"name": "FOREMAN", "line_count": 42}
  ]
}

Important:
- character_name must be set on character, dialogue, and parenthetical elements
- character_name must be null/omitted on action, scene_heading, and transition elements
- line_count should count dialogue + character elements for each character
- Do NOT invent text — only classify the text you receive
- Do NOT merge or split lines — classify each line as-is
- If no clear scene headings exist, put all content in a single scene with heading "UNKNOWN"
"""


def build_gemini_structural_request(raw_text: str) -> str:
    """Build the user-message portion of the Gemini request."""
    return (
        "Classify the following screenplay text into structured scenes and elements.\n"
        "Return ONLY valid JSON matching the schema above. No markdown fences, no commentary.\n\n"
        "--- SCREENPLAY TEXT ---\n"
        f"{raw_text}\n"
        "--- END ---"
    )
