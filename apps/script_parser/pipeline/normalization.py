"""
Text normalization helpers shared across all parsers (tasks 4.0.14–4.0.18).

Rules enforced here:
  4.0.14  Strip (CONT'D) and variants from character names
  4.0.15  Extract scene numbers from margins (e.g. "1.  INT. COFFEE - DAY  1.")
  4.0.16  Detect revision markers (* in far-right margin)
  4.0.17  Dual dialogue detection utilities
  4.0.18  Always use `line == line.upper()` for ALL CAPS detection, not isupper()
"""
from __future__ import annotations

import re

# ── 4.0.14 CONT'D stripping ──────────────────────────────────────────────────

_CONTD_RE = re.compile(r"\s*\(CONT['\u2019]?D\.?\)", re.IGNORECASE | re.UNICODE)

# Known delivery/direction extensions that are NOT part of the character name.
# Character-identifying parens like (JOE HOLIDAY) are deliberately excluded.
_CHARACTER_EXTENSION_RE = re.compile(
    r"\s*\("
    r"(?:"
    r"V\.?O\.?|O\.?S\.?|O\.?C\.?"
    r"|CONT['\u2019]?D\.?|CONT"
    r"|PRE-?LAP|PRELAP"
    r"|ON-?SCREEN|ONSCREEN"
    r"|FILTERED|SUBTITLE"
    r"|INTO\s+PHONE|INTO\s+RADIO"
    r"|IN\s+(?:SPANISH|ENGLISH|FRENCH|GERMAN|ITALIAN|MANDARIN|CANTONESE"
    r"|JAPANESE|KOREAN|ARABIC|RUSSIAN|PORTUGUESE|HINDI|HEBREW|LATIN"
    r"|TAGALOG|SIGN\s+LANGUAGE)"
    r")"
    r"\)",
    re.IGNORECASE | re.UNICODE,
)


def strip_contd(name: str) -> str:
    """Remove (CONT'D) / (CONTD) / (CONT.) continuation markers from character names."""
    return _CONTD_RE.sub("", name).strip()


def strip_character_extension(name: str) -> tuple[str, str | None]:
    """Remove known delivery extensions from character names.

    Returns (clean_name, delivery_tag_or_None).
    E.g. 'MANNY (IN SPANISH)' -> ('MANNY', 'IN SPANISH')
         'BANDLEADER (JOE HOLIDAY)' -> ('BANDLEADER (JOE HOLIDAY)', None)
    """
    m = _CHARACTER_EXTENSION_RE.search(name)
    if m:
        delivery = m.group(0).strip().strip("()")
        cleaned = _CHARACTER_EXTENSION_RE.sub("", name).strip()
        return cleaned, delivery
    return name.strip(), None


# ── 4.0.15 scene number extraction ───────────────────────────────────────────

# matches scene numbers in left/right margins: "47A.  INT. ... SHOP  47A."
_SCENE_NUM_RE = re.compile(
    r"^(?P<num>[A-Z0-9]+\.?)\s+(?P<body>.+?)\s+(?P=num)\.?\s*$",
    re.UNICODE,
)
# Simpler: leading "47A. " or "47. "
_LEADING_NUM_RE = re.compile(r"^(?P<num>[0-9]+[A-Z]?\.?)\s+", re.UNICODE)
# Trailing ". 47A"
_TRAILING_NUM_RE = re.compile(r"\s+(?P<num>[0-9]+[A-Z]?\.?)$", re.UNICODE)


def extract_scene_number(heading: str) -> tuple[str | None, str]:
    """
    Returns (script_scene_number, cleaned_heading).
    E.g. '1.   INT. COFFEE SHOP - DAY   1.' → ('1', 'INT. COFFEE SHOP - DAY')
    """
    m = _SCENE_NUM_RE.match(heading.strip())
    if m:
        return m.group("num").rstrip("."), m.group("body").strip()

    cleaned = heading
    script_num: str | None = None

    m_lead = _LEADING_NUM_RE.match(cleaned)
    if m_lead:
        script_num = m_lead.group("num").rstrip(".")
        cleaned = cleaned[m_lead.end():]

    m_trail = _TRAILING_NUM_RE.search(cleaned)
    if m_trail:
        script_num = script_num or m_trail.group("num").rstrip(".")
        cleaned = cleaned[: m_trail.start()]

    return script_num, cleaned.strip()


# ── 4.0.16 Revision marker detection ─────────────────────────────────────────

REVISION_MARKER_X_THRESHOLD = 550  # x0 > 550 PDF points = far-right margin


def is_revision_marker(word_obj: dict) -> bool:
    """Return True if a pdfplumber word object is a revision asterisk in the right margin."""
    return (
        word_obj.get("text", "").strip() == "*"
        and word_obj.get("x0", 0) > REVISION_MARKER_X_THRESHOLD
    )


# ── 4.0.17 Dual dialogue detection ───────────────────────────────────────────

DUAL_DIALOGUE_Y_TOLERANCE = 5  # PDF points


def find_dual_dialogue_pairs(
    words_on_page: list[dict],
    char_bucket_x_min: float,
    char_bucket_x_max: float,
) -> list[tuple[dict, dict]]:
    """
    Detect two character-name-bucket elements at the same Y coordinate (±5pt).
    Returns list of (left_word, right_word) pairs.
    """
    char_words = [
        w
        for w in words_on_page
        if char_bucket_x_min <= w.get("x0", 0) <= char_bucket_x_max
        and is_uppercase(w.get("text", ""))
    ]

    pairs: list[tuple[dict, dict]] = []
    used: set[int] = set()

    for i, w1 in enumerate(char_words):
        if i in used:
            continue
        for j, w2 in enumerate(char_words):
            if j <= i or j in used:
                continue
            if abs(w1.get("top", 0) - w2.get("top", 0)) <= DUAL_DIALOGUE_Y_TOLERANCE:
                pairs.append((w1, w2))
                used.add(i)
                used.add(j)
                break

    return pairs


# ── 4.0.18 Non-Latin safe uppercase check ────────────────────────────────────

def is_uppercase(text: str) -> bool:
    """
    Return True if text is all uppercase.
    Uses `text == text.upper()` (not `text.isupper()`) to handle accented
    characters (É, Ñ, Ü) that isupper() may misclassify in some Python locales.
    """
    stripped = text.strip()
    return bool(stripped) and stripped == stripped.upper()


# ── 4.0.19 Character name validation ─────────────────────────────────────────

_ORDINAL_RE = re.compile(r"^\W*\d+(ST|ND|RD|TH)\b", re.IGNORECASE)
_PURE_NUMBER_RE = re.compile(r"^\d+\.?$")
# Title-like: starts with digits then 2+ words (e.g. "12 ANGRY MEN", "3 DAYS LATER")
_TITLE_LIKE_RE = re.compile(r"^\d+\s+\w+\s+\w+", re.UNICODE)
# Timestamp patterns: "2:55 PM", "11:30 AM", etc.
_TIMESTAMP_RE = re.compile(r"^\d{1,2}:\d{2}\s*(?:AM|PM)\.?$", re.IGNORECASE)
# Direction cue prefixes that are never character names
_DIRECTION_CUE_RE = re.compile(
    r"^(?:CLOSE ON|BACK TO|AND BACK TO|CUT TO|ANGLE ON|PUSH IN|PULL BACK|WIDE ON|INSERT)\b",
    re.IGNORECASE,
)
# Scene/act terminators that are never character names
_SCENE_TERMINATORS = frozenset({
    "END", "END.", "THE END", "THE END.", "FINIS", "FINIS.",
    "END OF ACT", "END OF SHOW", "END OF SCENE",
    "END OF ACT ONE", "END OF ACT TWO", "END OF ACT THREE",
    "BLACKOUT", "BLACKOUT.", "CURTAIN", "CURTAIN.",
})
# Exclamatory phrases that are never character names
_EXCLAMATORY_RE = re.compile(r"^[A-Z\s]+[!?]+$", re.UNICODE)
# Header patterns: "EPISODE 207", "CHAPTER 5", "PART TWO"
_HEADER_RE = re.compile(r"^(?:EPISODE|CHAPTER|PART|VOLUME|SEASON)\s+\w+$", re.IGNORECASE)
# Single common English words that are never character names
_NOT_CHARACTER_WORDS = frozenset({
    "TALKED", "FUCK", "NO", "YES", "MORE", "STOP", "WAIT",
    "HELP", "RUN", "GO", "LOOK", "LISTEN", "PLEASE", "HERE",
    "THERE", "WHAT", "WHY", "HOW", "WHEN", "WHERE", "WHO",
    "OKAY", "RIGHT", "SHIT", "DAMN", "HELL", "DONE", "DARE",
    "WRONG", "NEEDS", "GOING", "PHOTOGRAPHS", "SCREECHING",
    "PUTA", "NOT", "AGAIN",
})
# Multi-word action phrases that are never character names
_NOT_CHARACTER_PHRASES = frozenset({
    "SO MUCH", "SNAKE FIGHT", "ON THE GROUND",
    "TO A HALT", "THE LATCH BREAKS", "THIS HAS TO",
    "ARE YOU FUCKI", "STOP FUCKIN", "FUCK OFF",
})


def is_valid_character_name(text: str) -> bool:
    """
    Return True if *text* looks like a legitimate character cue.

    Rejects:
      - Pure page numbers: "144", "160.", "2."
      - Ordinal noise: "#3RD", "2ND"
      - Unmatched parentheses: "#8)", "(#5"
      - Fully parenthesised text: "(#5)" — these are action references
      - Strings with no alphabetic or # character
    """
    t = text.strip()
    if not t:
        return False

    # Pure numbers / page numbers
    if _PURE_NUMBER_RE.match(t):
        return False

    # Ordinal noise (#3RD, 2ND, #5TH)
    if _ORDINAL_RE.match(t):
        return False

    # Fully wrapped in parens → action reference, not a character cue
    if t.startswith("(") and t.endswith(")"):
        return False

    # Unmatched parentheses
    if t.count("(") != t.count(")"):
        return False

    # Must contain at least one letter or # (numbered characters like #8)
    if not re.search(r"[A-Za-z#]", t):
        return False

    # Title-like patterns: "12 ANGRY MEN", "3 DAYS LATER" — not character cues
    if _TITLE_LIKE_RE.match(t):
        return False

    # Scene/act terminators: "END.", "THE END", "BLACKOUT", etc.
    if t.upper() in _SCENE_TERMINATORS:
        return False

    # Exclamatory phrases: "THANK YOU!", "STOP!", "HELP!" — not character names
    if _EXCLAMATORY_RE.match(t):
        return False

    # Timestamps: "2:55 PM", "11:30 AM" (checked before colon rule below)
    if _TIMESTAMP_RE.match(t):
        return False

    # Header patterns: "EPISODE 207", "CHAPTER 5"
    if _HEADER_RE.match(t):
        return False

    # Direction cues: "CLOSE ON TIRES", "BACK TO SIDNEY", "CUT TO"
    if _DIRECTION_CUE_RE.match(t):
        return False

    # Colon in text = direction/continuation marker, not character cue
    # "JACK:", "BACK TO THALBERG:", "CONTINUED: (3)"
    if ":" in t:
        return False

    # Trailing dash = interrupted action, not character cue: "FUCK --", "MOTHER-"
    if t.endswith("-") or t.endswith("--"):
        return False

    # Single common words that are never character names
    if t.upper().rstrip(".") in _NOT_CHARACTER_WORDS:
        return False

    # Multi-word action phrases
    if t.upper().rstrip(".") in _NOT_CHARACTER_PHRASES:
        return False

    # Ends with period but not an abbreviation pattern (A.D., D.P., V.O.)
    # Multi-word text ending in period = action/direction, not character name
    if t.endswith(".") and " " in t and not re.search(r"\.\w\.", t):
        return False

    # Contains apostrophe-S contractions mid-word = dialogue fragment, not name
    # (catches "NOBODY'S PULLING THE FUCKING", "LET'S FIGHT" etc.)
    if re.search(r"\w+['\u2019]S\s+\w+", t, re.IGNORECASE):
        return False

    # Multiple consecutive exclamation/question marks = emphatic dialogue, not name
    if re.search(r"[!?]{2,}", t):
        return False

    # Starts with quote mark = title reference, not character cue
    if t.startswith('"') or t.startswith('\u201c'):
        return False

    # Starts with period/dot = continuation artifact, not character cue
    if t.startswith("."):
        return False

    # Contains " -- " (em-dash with spaces) = interrupted dialogue/action
    if " -- " in t or t.endswith(" --"):
        return False

    # Too many words to be a character name (> 4 words, excluding V.O./O.S. tags)
    # Catches headers like "BET S2 - AUDITION SIDES - MIMI"
    words = re.split(r"[\s\-]+", t)
    if len(words) > 4:
        return False

    return True


def clean_character_name(name: str) -> str:
    """
    Normalise a character name by stripping stray punctuation artefacts.

    Covers PDF extraction noise such as trailing unmatched ')' or leading '('.
    """
    t = name.strip()
    # Strip outer parens: "(#5)" → "#5"
    if t.startswith("(") and t.endswith(")"):
        t = t[1:-1].strip()
    # Strip trailing unmatched ')': "#8)" → "#8"
    if t.endswith(")") and "(" not in t:
        t = t.rstrip(")").strip()
    # Strip leading unmatched '(': "(#5" → "#5"
    if t.startswith("(") and ")" not in t:
        t = t.lstrip("(").strip()
    # Strip trailing period unless it's an abbreviation (e.g. "D.P.", "A.D.")
    if t.endswith(".") and not re.match(r"^([A-Z]\.)+$", t):
        t = t.rstrip(".").strip()
    return t


def deduplicate_characters(
    characters: "list[ParsedCharacter]",
    scenes: "list[Scene]",
) -> "tuple[list[ParsedCharacter], list[Scene]]":
    """
    Merge character variants that differ only by stray punctuation
    or delivery extensions.

    E.g. '#8)' and '#8' become '#8', line counts are summed,
    'MANNY (O.S.)' and 'MANNY' merge to 'MANNY',
    and element character_name references are updated.
    """
    from models.schema import ParsedCharacter as PC

    # Build mapping: cleaned_name → canonical (first seen cleaned form)
    canonical_map: dict[str, str] = {}  # raw_name → canonical
    count_map: dict[str, int] = {}  # canonical → total count

    for char in characters:
        # Strip delivery extensions first, then clean punctuation artifacts
        base_name, _ = strip_character_extension(char.name)
        cleaned = clean_character_name(base_name)
        if cleaned not in count_map:
            count_map[cleaned] = 0
        count_map[cleaned] += char.line_count
        canonical_map[char.name] = cleaned

    # Update element references in scenes
    for scene in scenes:
        for el in scene.elements:
            if el.character_name and el.character_name in canonical_map:
                el.character_name = canonical_map[el.character_name]
            elif el.character_name:
                base_name, _ = strip_character_extension(el.character_name)
                cleaned = clean_character_name(base_name)
                el.character_name = cleaned
            if el.type.value == "character" and el.text in canonical_map:
                el.text = canonical_map[el.text]

    # Rebuild deduplicated character list
    deduped = [
        PC(name=name, line_count=count)
        for name, count in sorted(count_map.items(), key=lambda x: -x[1])
    ]

    return deduped, scenes


# ── Element merge helpers ────────────────────────────────────────────────────

def merge_consecutive_dialogue(
    elements: "list[ScriptElement]",
) -> "list[ScriptElement]":
    """Merge consecutive DIALOGUE elements from the same character into one."""
    from models.schema import ElementType, ScriptElement

    if not elements:
        return elements

    merged: list[ScriptElement] = []
    for el in elements:
        if (
            el.type == ElementType.DIALOGUE
            and merged
            and merged[-1].type == ElementType.DIALOGUE
            and merged[-1].character_name == el.character_name
        ):
            merged[-1] = ScriptElement(
                type=ElementType.DIALOGUE,
                text=merged[-1].text + " " + el.text,
                character_name=el.character_name,
            )
        else:
            merged.append(el)
    return merged


def merge_consecutive_action(
    elements: "list[ScriptElement]",
) -> "list[ScriptElement]":
    """Merge consecutive ACTION elements into single blocks."""
    from models.schema import ElementType, ScriptElement

    if not elements:
        return elements

    merged: list[ScriptElement] = []
    for el in elements:
        if (
            el.type == ElementType.ACTION
            and merged
            and merged[-1].type == ElementType.ACTION
        ):
            merged[-1] = ScriptElement(
                type=ElementType.ACTION,
                text=merged[-1].text + " " + el.text,
            )
        else:
            merged.append(el)
    return merged
