"""
PDF content type detector (task 4.0.7).

Determines whether a PDF has a usable text layer before routing to
the correct parser (layout-aware heuristic vs OCR).

Uses PyMuPDF (fitz) instead of pdfplumber for lighter-weight detection.
"""
from __future__ import annotations

import fitz
import structlog

log = structlog.get_logger()

# Minimum characters from first 2 pages to classify as text PDF
_TEXT_PDF_CHAR_THRESHOLD = 50


def detect_pdf_content_type(file_bytes: bytes) -> str:
    """
    Return 'text' if PDF has a usable text layer, 'image' otherwise.
    Inspects pages 1 and 2 only.
    """
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        try:
            sample_text = ""
            for page_index in range(min(2, len(doc))):
                page = doc.load_page(page_index)
                sample_text += page.get_text("text") or ""

            char_count = len(sample_text.replace("\n", "").replace(" ", ""))
            log.debug("pdf_content_detection", char_count=char_count)

            if char_count < _TEXT_PDF_CHAR_THRESHOLD:
                return "image"
            return "text"
        finally:
            doc.close()
    except Exception as exc:
        log.warning("pdf_content_detection_failed", error=str(exc))
        return "text"  # Attempt text path; layout parser will degrade gracefully
