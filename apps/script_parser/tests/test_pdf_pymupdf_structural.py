"""
Unit tests for the PyMuPDF structural parser.

Tests element classification and scene assembly using mock NativeExtractionBlock lists
that represent known screenplay layouts.
"""
from __future__ import annotations

import pytest

from models.schema import ElementType, NativeExtractionBlock
from parsers.pdf_pymupdf_structural import (
    ColumnBuckets,
    DominantFont,
    parse_pdf_pymupdf_structural,
    _calibrate_buckets,
    _classify_block,
    _detect_dominant_font,
    _get_font_signals,
)


def _make_block(
    text: str,
    page: int = 1,
    x0: float = 108.0,
    x1: float = 400.0,
    y0: float = 100.0,
    y1: float = 112.0,
    font_name: str = "Courier",
    font_size: float = 12.0,
) -> NativeExtractionBlock:
    """Helper to create a mock block with standard screenplay-like coordinates."""
    return NativeExtractionBlock(
        text=text,
        page=page,
        bounding_box=[x0, y0, x1, y0, x1, y1, x0, y1],
        attributes={
            "font_name": font_name,
            "font_size": font_size,
            "rotation_degrees": 0.0,
            "block_kind": "line",
            "span_count": 1,
        },
    )


# ── Default column bucket reference values ───────────────────────────────────
# action:      x0 in [108, 144]
# dialogue:    x0 in [180, 252]
# character:   x0 in [252, 288]
# parenthetical: x0 in [216, 252]
# transition:  x1 > 504

DEFAULT_BUCKETS = ColumnBuckets()
DEFAULT_FONT = DominantFont(font_name="Courier", font_size=12.0)
NO_FONT_SIGNALS = {"is_larger": False, "is_italic": False, "is_bold": False}


class TestClassifyBlock:
    def test_scene_heading(self):
        result = _classify_block(
            "INT. COFFEE SHOP - DAY", 120.0, 400.0,
            DEFAULT_BUCKETS, None, NO_FONT_SIGNALS,
        )
        assert result == ElementType.SCENE_HEADING

    def test_scene_heading_ext(self):
        result = _classify_block(
            "EXT. PARK - NIGHT", 120.0, 400.0,
            DEFAULT_BUCKETS, None, NO_FONT_SIGNALS,
        )
        assert result == ElementType.SCENE_HEADING

    def test_action(self):
        result = _classify_block(
            "He walks across the room.", 120.0, 400.0,
            DEFAULT_BUCKETS, None, NO_FONT_SIGNALS,
        )
        assert result == ElementType.ACTION

    def test_character_cue(self):
        result = _classify_block(
            "JOHN", 260.0, 320.0,
            DEFAULT_BUCKETS, None, NO_FONT_SIGNALS,
        )
        assert result == ElementType.CHARACTER

    def test_dialogue_after_character(self):
        result = _classify_block(
            "I can't believe you did that.", 200.0, 380.0,
            DEFAULT_BUCKETS, ElementType.CHARACTER, NO_FONT_SIGNALS,
        )
        assert result == ElementType.DIALOGUE

    def test_dialogue_continues(self):
        result = _classify_block(
            "And then what happened?", 200.0, 380.0,
            DEFAULT_BUCKETS, ElementType.DIALOGUE, NO_FONT_SIGNALS,
        )
        assert result == ElementType.DIALOGUE

    def test_parenthetical(self):
        result = _classify_block(
            "(whispering)", 230.0, 320.0,
            DEFAULT_BUCKETS, ElementType.CHARACTER, NO_FONT_SIGNALS,
        )
        assert result == ElementType.PARENTHETICAL

    def test_transition_right_aligned(self):
        result = _classify_block(
            "CUT TO:", 400.0, 520.0,
            DEFAULT_BUCKETS, None, NO_FONT_SIGNALS,
        )
        assert result == ElementType.TRANSITION

    def test_transition_fade_out(self):
        result = _classify_block(
            "FADE OUT.", 120.0, 400.0,
            DEFAULT_BUCKETS, None, NO_FONT_SIGNALS,
        )
        assert result == ElementType.TRANSITION

    def test_larger_font_scene_heading(self):
        """Larger font reinforces scene heading even outside action column."""
        signals = {"is_larger": True, "is_italic": False, "is_bold": False}
        result = _classify_block(
            "INT. OFFICE - DAY", 90.0, 400.0,
            DEFAULT_BUCKETS, None, signals,
        )
        assert result == ElementType.SCENE_HEADING

    def test_italic_parenthetical(self):
        """Italic font reinforces parenthetical detection."""
        signals = {"is_larger": False, "is_italic": True, "is_bold": False}
        result = _classify_block(
            "(beat)", 200.0, 260.0,
            DEFAULT_BUCKETS, ElementType.CHARACTER, signals,
        )
        assert result == ElementType.PARENTHETICAL


class TestDominantFont:
    def test_most_frequent_font(self):
        blocks = [
            _make_block("line 1", font_name="Courier", font_size=12.0),
            _make_block("line 2", font_name="Courier", font_size=12.0),
            _make_block("line 3", font_name="Courier", font_size=12.0),
            _make_block("TITLE", font_name="Courier-Bold", font_size=18.0),
        ]
        dom = _detect_dominant_font(blocks)
        assert dom.font_name == "Courier"
        assert dom.font_size == 12.0

    def test_empty_blocks(self):
        dom = _detect_dominant_font([])
        assert dom.font_name is None
        assert dom.font_size == 0.0


class TestFontSignals:
    def test_normal_font(self):
        block = _make_block("Hello", font_name="Courier", font_size=12.0)
        dom = DominantFont(font_name="Courier", font_size=12.0)
        signals = _get_font_signals(block, dom)
        assert signals["is_larger"] is False
        assert signals["is_italic"] is False
        assert signals["is_bold"] is False

    def test_larger_font(self):
        block = _make_block("TITLE", font_name="Courier", font_size=18.0)
        dom = DominantFont(font_name="Courier", font_size=12.0)
        signals = _get_font_signals(block, dom)
        assert signals["is_larger"] is True

    def test_italic_font(self):
        block = _make_block("whisper", font_name="Courier-Italic", font_size=12.0)
        dom = DominantFont(font_name="Courier", font_size=12.0)
        signals = _get_font_signals(block, dom)
        assert signals["is_italic"] is True

    def test_bold_font(self):
        block = _make_block("JOHN", font_name="Courier-Bold", font_size=12.0)
        dom = DominantFont(font_name="Courier", font_size=12.0)
        signals = _get_font_signals(block, dom)
        assert signals["is_bold"] is True


class TestCalibrateBuckets:
    def test_insufficient_blocks_returns_defaults(self):
        blocks = [_make_block("foo", page=1) for _ in range(5)]
        result = _calibrate_buckets(blocks)
        assert result == ColumnBuckets()

    def test_enough_blocks_with_peaks(self):
        blocks = []
        # Create blocks at action column (x0=120) - 15 blocks
        for i in range(15):
            blocks.append(_make_block(f"action {i}", page=1, x0=120.0))
        # Create blocks at dialogue column (x0=200) - 10 blocks
        for i in range(10):
            blocks.append(_make_block(f"dialogue {i}", page=1, x0=200.0))
        result = _calibrate_buckets(blocks)
        # Should produce calibrated buckets, not defaults
        assert result.action_x_min != ColumnBuckets().action_x_min or result.dialogue_x_min != ColumnBuckets().dialogue_x_min


class TestParsePdfPymupdfStructural:
    def test_empty_blocks(self):
        result = parse_pdf_pymupdf_structural([], page_count=0)
        assert result.format == "pdf_pymupdf_structural"
        assert result.scenes == []
        assert result.characters == []

    def test_simple_scene(self):
        blocks = [
            _make_block("INT. COFFEE SHOP - DAY", page=1, x0=120.0, x1=400.0),
            _make_block("John enters the room.", page=1, x0=120.0, x1=400.0),
            _make_block("JOHN", page=1, x0=260.0, x1=320.0),
            _make_block("Hello, world.", page=1, x0=200.0, x1=380.0),
        ]
        result = parse_pdf_pymupdf_structural(blocks, page_count=1)

        assert result.format == "pdf_pymupdf_structural"
        assert len(result.scenes) == 1
        assert result.scenes[0].heading == "INT. COFFEE SHOP - DAY"
        assert len(result.scenes[0].elements) == 3  # action + character + dialogue
        assert result.scenes[0].elements[0].type == ElementType.ACTION
        assert result.scenes[0].elements[1].type == ElementType.CHARACTER
        assert result.scenes[0].elements[1].text == "JOHN"
        assert result.scenes[0].elements[2].type == ElementType.DIALOGUE
        assert result.scenes[0].elements[2].character_name == "JOHN"

    def test_multiple_scenes(self):
        blocks = [
            _make_block("INT. OFFICE - DAY", page=1, x0=120.0, x1=400.0),
            _make_block("ALICE", page=1, x0=260.0, x1=320.0),
            _make_block("Let's go.", page=1, x0=200.0, x1=380.0),
            _make_block("EXT. PARK - NIGHT", page=2, x0=120.0, x1=400.0),
            _make_block("BOB", page=2, x0=260.0, x1=320.0),
            _make_block("I agree.", page=2, x0=200.0, x1=380.0),
        ]
        result = parse_pdf_pymupdf_structural(blocks, page_count=2)

        assert len(result.scenes) == 2
        assert result.scenes[0].heading == "INT. OFFICE - DAY"
        assert result.scenes[0].page_start == 1
        assert result.scenes[1].heading == "EXT. PARK - NIGHT"
        assert result.scenes[1].page_start == 2

    def test_character_extraction(self):
        blocks = [
            _make_block("INT. ROOM - DAY", page=1, x0=120.0, x1=400.0),
            _make_block("ALICE", page=1, x0=260.0, x1=320.0),
            _make_block("Line one.", page=1, x0=200.0, x1=380.0),
            _make_block("BOB", page=1, x0=260.0, x1=320.0),
            _make_block("Line two.", page=1, x0=200.0, x1=380.0),
            _make_block("ALICE", page=1, x0=260.0, x1=320.0),
            _make_block("Line three.", page=1, x0=200.0, x1=380.0),
        ]
        result = parse_pdf_pymupdf_structural(blocks, page_count=1)

        char_names = [c.name for c in result.characters]
        assert "ALICE" in char_names
        assert "BOB" in char_names
        # ALICE has more lines (2 cues + 2 dialogue = 4 counts) vs BOB (1 cue + 1 dialogue = 2)
        alice = next(c for c in result.characters if c.name == "ALICE")
        bob = next(c for c in result.characters if c.name == "BOB")
        assert alice.line_count > bob.line_count

    def test_contd_stripped_from_character(self):
        blocks = [
            _make_block("INT. ROOM - DAY", page=1, x0=120.0, x1=400.0),
            _make_block("ALICE (CONT'D)", page=1, x0=260.0, x1=360.0),
            _make_block("More dialogue.", page=1, x0=200.0, x1=380.0),
        ]
        result = parse_pdf_pymupdf_structural(blocks, page_count=1)

        assert result.characters[0].name == "ALICE"
        assert result.scenes[0].elements[0].text == "ALICE"

    def test_watermark_metadata_passed_through(self):
        blocks = [
            _make_block("INT. ROOM - DAY", page=1, x0=120.0, x1=400.0),
        ]
        result = parse_pdf_pymupdf_structural(
            blocks, page_count=1,
            watermark_detected=True,
            watermark_texts=["CONFIDENTIAL"],
        )
        assert result.watermark_detected is True
        assert "CONFIDENTIAL" in result.watermark_texts

    def test_transition_detection(self):
        blocks = [
            _make_block("INT. ROOM - DAY", page=1, x0=120.0, x1=400.0),
            _make_block("FADE OUT.", page=1, x0=120.0, x1=400.0),
        ]
        result = parse_pdf_pymupdf_structural(blocks, page_count=1)

        assert result.scenes[0].elements[0].type == ElementType.TRANSITION

    def test_parenthetical_in_dialogue(self):
        blocks = [
            _make_block("INT. ROOM - DAY", page=1, x0=120.0, x1=400.0),
            _make_block("ALICE", page=1, x0=260.0, x1=320.0),
            _make_block("(whispering)", page=1, x0=230.0, x1=320.0),
            _make_block("Be quiet.", page=1, x0=200.0, x1=380.0),
        ]
        result = parse_pdf_pymupdf_structural(blocks, page_count=1)

        elements = result.scenes[0].elements
        assert elements[0].type == ElementType.CHARACTER
        assert elements[1].type == ElementType.PARENTHETICAL
        assert elements[1].character_name == "ALICE"
        assert elements[2].type == ElementType.DIALOGUE
        assert elements[2].character_name == "ALICE"

    def test_page_end_tracked(self):
        blocks = [
            _make_block("INT. ROOM - DAY", page=1, x0=120.0, x1=400.0),
            _make_block("Some action.", page=1, x0=120.0, x1=400.0),
            _make_block("More action.", page=3, x0=120.0, x1=400.0),
        ]
        result = parse_pdf_pymupdf_structural(blocks, page_count=3)

        assert result.scenes[0].page_start == 1
        assert result.scenes[0].page_end == 3

    def test_raw_text_populated(self):
        """raw_text contains all block texts joined by newlines."""
        blocks = [
            _make_block("INT. ROOM - DAY", page=1, x0=120.0, x1=400.0),
            _make_block("Some action.", page=1, x0=120.0, x1=400.0),
        ]
        result = parse_pdf_pymupdf_structural(blocks, page_count=1)

        assert "INT. ROOM - DAY" in result.raw_text
        assert "Some action." in result.raw_text
