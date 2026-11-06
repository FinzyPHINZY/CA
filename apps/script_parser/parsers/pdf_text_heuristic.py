"""
PDF text-heuristic fallback parser.

Used when the layout parser (x-coordinate based) produces a low-confidence
result on a text-based PDF.  Extracts raw text via pdfplumber — ignoring
x-coordinates entirely — then runs the same ALL-CAPS-above-dialogue heuristic
as the TXT/Fountain fallback parser.

This handles PDFs with non-standard margins, A4 page sizes, HTML→PDF
conversions, and other layouts where column positions don't match the
US-Letter screenplay buckets.
"""
from __future__ import annotations

import io

import pdfplumber
import structlog

from models.schema import ParseResult
from parsers.fountain_parser import _txt_heuristic

log = structlog.get_logger()


def parse_pdf_text_heuristic(file_bytes: bytes) -> ParseResult:
    """
    Extract all text from a PDF via pdfplumber (no layout classification),
    then parse the plain text with the text heuristic parser.
    """
    try:
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            page_count = len(pdf.pages)
            pages_text = [page.extract_text() or "" for page in pdf.pages]
        full_text = "\n".join(pages_text)
    except Exception as exc:
        log.warning("pdf_text_heuristic_extract_failed", error=str(exc))
        result = ParseResult(format="pdf_text_heuristic")  # type: ignore[call-arg]
        return result

    if not full_text.strip():
        log.warning("pdf_text_heuristic_empty_text")
        result = ParseResult(format="pdf_text_heuristic")  # type: ignore[call-arg]
        return result

    log.info(
        "pdf_text_heuristic_extracted",
        chars=len(full_text),
        pages=page_count,
    )

    result = _txt_heuristic(full_text)
    result.format = "pdf_text_heuristic"  # type: ignore[assignment]
    result.page_count = page_count
    return result
