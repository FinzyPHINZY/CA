"""
PDF Gemini Vision fallback parser.

Last-resort fallback when both the layout parser and the text-heuristic
parser yield a confidence score below the rejection threshold.

Sends the raw PDF bytes to Google Gemini (native PDF support) and asks it
to extract the screenplay text.  The extracted text is then parsed with the
text-heuristic parser so the result has the same structure as every other
parser output.

Requires: GOOGLE_GEMINI_API_KEY env var.
"""
from __future__ import annotations

import io
import os

import pdfplumber
import structlog

from models.schema import ParseResult
from parsers.fountain_parser import _txt_heuristic

log = structlog.get_logger()

_EXTRACTION_PROMPT = (
    "Extract all text from this PDF screenplay document.\n\n"
    "Rules:\n"
    "- Preserve screenplay structure: scene headings (INT./EXT.), "
    "character names (ALL CAPS), dialogue, action lines, parentheticals, transitions.\n"
    "- Output the raw screenplay text line by line exactly as it appears.\n"
    "- Do NOT add commentary, summaries, or any text that is not in the document.\n"
    "- If a page is blank or contains only a page number, skip it."
)


def parse_pdf_gemini_vision(file_bytes: bytes) -> ParseResult:
    """
    Use Gemini to extract screenplay text from a PDF, then parse with
    the text heuristic.  Raises RuntimeError on configuration/API errors
    so the caller can catch and log gracefully.
    """
    import base64
    import google.generativeai as genai  # noqa: PLC0415 — lazy import, optional dependency

    api_key = os.getenv("GOOGLE_GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_GEMINI_API_KEY is not configured")

    model_name = os.getenv("GEMINI_MODEL_NAME", "gemini-2.0-flash")

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(model_name)

    pdf_b64 = base64.standard_b64encode(file_bytes).decode()

    log.info("gemini_vision_request", model=model_name, pdf_bytes=len(file_bytes))

    response = model.generate_content([
        {"inline_data": {"mime_type": "application/pdf", "data": pdf_b64}},
        _EXTRACTION_PROMPT,
    ])

    extracted_text: str = ""
    if hasattr(response, "text") and response.text:
        extracted_text = response.text
    elif response.candidates:
        for part in response.candidates[0].content.parts:
            if hasattr(part, "text"):
                extracted_text += part.text

    if not extracted_text.strip():
        raise RuntimeError("Gemini Vision returned an empty response for this PDF")

    log.info("gemini_vision_extracted", chars=len(extracted_text))

    result = _txt_heuristic(extracted_text)
    result.format = "pdf_gemini_vision"  # type: ignore[assignment]

    # Preserve real page count from the original PDF
    try:
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            result.page_count = len(pdf.pages)
    except Exception:
        pass

    return result
