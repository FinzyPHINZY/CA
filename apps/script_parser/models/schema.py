"""
Unified Pydantic output schema for the script parser service (task 4.0.23).
All parsers produce this schema. Validated before publishing to results queue.
"""
from __future__ import annotations

from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


class ElementType(str, Enum):
    SCENE_HEADING = "scene_heading"
    ACTION = "action"
    CHARACTER = "character"
    DIALOGUE = "dialogue"
    PARENTHETICAL = "parenthetical"
    TRANSITION = "transition"
    NOTE = "note"
    DUAL_DIALOGUE = "dual_dialogue"


class ScriptElement(BaseModel):
    type: ElementType
    text: str
    character_name: Optional[str] = None
    # Delivery/direction extension stripped from the character name (e.g. "V.O.", "IN SPANISH")
    delivery: Optional[str] = None
    # True when a revision marker (*) appears in the right margin on the same line
    revised: bool = False


class Scene(BaseModel):
    number: int
    # Original scene number from production script margins (e.g. "47A")
    script_scene_number: Optional[str] = None
    heading: str
    location: Optional[str] = None
    time_of_day: Optional[str] = None
    interior_exterior: Optional[str] = None
    elements: list[ScriptElement] = Field(default_factory=list)
    page_start: Optional[int] = None
    page_end: Optional[int] = None


class ParsedCharacter(BaseModel):
    name: str
    line_count: int = 0


class NativeExtractionBlock(BaseModel):
    text: str
    page: int
    bounding_box: list[float] = Field(default_factory=list)
    attributes: dict[str, object] = Field(default_factory=dict)


class NativeExtractionPayload(BaseModel):
    source: Literal["pymupdf_native_pdf"]
    blocks: list[NativeExtractionBlock] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    metadata: dict[str, object] = Field(default_factory=dict)


ParseFormat = Literal[
    "fdx",
    "pdf_text",
    "pdf_pymupdf_structural",
    "pdf_ocr",
    "pdf_text_heuristic",
    "pdf_gemini_vision",
    "pdf_image",
    "gemini_structural",
    "docx_styled",
    "docx_heuristic",
    "fountain",
    "txt_heuristic",
]


class ParseResult(BaseModel):
    title: Optional[str] = None
    format: ParseFormat
    scenes: list[Scene] = Field(default_factory=list)
    characters: list[ParsedCharacter] = Field(default_factory=list)
    # Raw extracted bytes as text — preserved for audit, never sent to Gemini
    raw_text: str = ""
    # Clean reconstructed text — sent to Gemini for semantic analysis
    clean_text: str = ""
    page_count: int = 0
    structure_confidence_score: float = 0.0
    watermark_detected: bool = False
    watermark_texts: list[str] = Field(default_factory=list)
    stage_play_detected: bool = False
    parser_warnings: list[str] = Field(default_factory=list)
    low_confidence_flag: bool = False


class ParseJobMessage(BaseModel):
    """Message consumed from script_parser.queue (published by ai_service)."""
    task_id: str
    media_url: str
    file_name: str
    file_extension: str
    user_id: str
    project_id: str
    script_id: str
    # Correlation fields echoed back in result (not used for parsing logic)
    script_index: Optional[int] = None
    media_id: Optional[str] = None


class ParseResultMessage(BaseModel):
    """Message published back to ai_service for semantic analysis continuation."""
    task_id: str
    script_id: str
    user_id: str
    status: Literal["SUCCESS", "VALIDATION_FAILED", "PARSE_FAILED", "NEEDS_OCR"]
    error: Optional[Literal[
        "NOT_A_SCREENPLAY",
        "STAGE_PLAY_DETECTED",
        "LOW_CONFIDENCE",
        "PARSE_ERROR",
        "NEEDS_OCR",
    ]] = None
    message: Optional[str] = None
    confidence_score: Optional[float] = None
    result: Optional[ParseResult] = None
    native_extraction: Optional[NativeExtractionPayload] = None
    # Correlation fields echoed back so NestJS can correlate without DB lookups
    file_name: Optional[str] = None
    project_id: Optional[str] = None
    script_index: Optional[int] = None
    # SHA256 hash of the original file content for duplicate detection
    content_hash: Optional[str] = None
    # Media URL passed back for NEEDS_OCR so ai_service can download the file
    media_url: Optional[str] = None
    # Phase 0 observability: parser path tracking surfaced to ai_service so
    # a single search by task_id shows both sides of the routing decision.
    parser_path: Optional[str] = None
    parser_chain: list[str] = Field(default_factory=list)
