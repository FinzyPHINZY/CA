"""
FileTypeRouter — entry point for all incoming parse jobs (task 4.0.5).

Routes by file extension to the correct parser.
Handles the full pipeline:
  1. Watermark detection + cleaning (4.0.12–4.0.13) — BEFORE Layer 2
  2. Layer 2 fingerprint check (4.0.19)
  3. Stage play detection (4.0.20)
  4. Parser dispatch
  5. Layer 3 confidence scoring (4.0.21)
  6. Clean text reconstruction (4.0.24)

Digital PDFs use PyMuPDF as the primary extractor (single open). pdfplumber
is a fallback only when PyMuPDF produces weak native text signals.
"""
from __future__ import annotations

import io

import structlog

from models.schema import ParseResult
from models.schema import NativeExtractionPayload
from parsers.fdx_parser import FdxParser
from parsers.pdf_detector import detect_pdf_content_type
from parsers.pdf_layout_parser import parse_pdf_layout
from parsers.pdf_ocr_parser import parse_pdf_ocr
from parsers.pdf_pymupdf_native import extract_native_pdf_with_pymupdf
from parsers.pdf_pymupdf_structural import parse_pdf_pymupdf_structural
from parsers.pdf_text_heuristic import parse_pdf_text_heuristic
from parsers.pdf_gemini_vision import parse_pdf_gemini_vision
from parsers.gemini_structural_parser import parse_with_gemini_structural
from parsers.docx_parser import parse_docx
from parsers.fountain_parser import parse_fountain
from pipeline.clean_text import reconstruct_clean_text
from pipeline.gemini_character_normalizer import normalize_character_names
from pipeline.validation import fingerprint_check, score_confidence
from pipeline.watermark import (
    detect_and_clean_watermarks,
    watermark_result_from_native_suppression,
    WatermarkResult,
)

log = structlog.get_logger()

ALLOWED_EXTENSIONS = frozenset(["pdf", "docx", "txt", "fdx", "fountain"])

# pages sampled for layer 2 fingerprint check (4.0.19)
_FINGERPRINT_PAGE_START = 4
_FINGERPRINT_PAGE_END = 15


def _extract_sample_text_for_fingerprint(
    file_bytes: bytes,
    extension: str,
    native_extraction: NativeExtractionPayload | None = None,
) -> tuple[str, list[dict]]:
    """
    Extract raw text and word objects from pages 4-15 (or all pages if < 10 pages).
    Returns (text_sample, words_list).

    For PDFs with a native extraction already available, reuses the PyMuPDF blocks
    instead of opening pdfplumber again.
    """
    if extension == "pdf":
        # Use PyMuPDF blocks if available (avoids redundant pdfplumber open)
        if native_extraction and native_extraction.blocks:
            page_count = int(native_extraction.metadata.get("page_count", 0) or 0)
            if page_count < 10:
                start_page, end_page = 1, page_count + 1
            else:
                start_page = _FINGERPRINT_PAGE_START
                end_page = _FINGERPRINT_PAGE_END + 1
            sample_blocks = [
                b for b in native_extraction.blocks
                if start_page <= b.page < end_page
            ]
            text = "\n".join(b.text for b in sample_blocks)
            return text, []

        # Fallback: pdfplumber (only if no native extraction)
        try:
            import pdfplumber
            with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                total = len(pdf.pages)
                start = min(_FINGERPRINT_PAGE_START - 1, total - 1)
                end = min(_FINGERPRINT_PAGE_END, total)
                if total < 10:
                    start, end = 0, total
                sample_pages = pdf.pages[start:end]
                text_parts: list[str] = []
                words: list[dict] = []
                for page in sample_pages:
                    text_parts.append(page.extract_text() or "")
                    words.extend(page.extract_words(x_tolerance=3, y_tolerance=3) or [])
                return "\n".join(text_parts), words
        except Exception as exc:
            log.warning("fingerprint_text_extract_failed", error=str(exc))
            return "", []

    elif extension in ("txt", "fountain"):
        text = file_bytes.decode("utf-8", errors="replace")
        lines = text.split("\n")
        # approximate pages: 55 lines/page
        start_line = (_FINGERPRINT_PAGE_START - 1) * 55
        end_line = _FINGERPRINT_PAGE_END * 55
        if len(lines) < 10 * 55:
            start_line, end_line = 0, len(lines)
        return "\n".join(lines[start_line:end_line]), []

    elif extension == "docx":
        try:
            from docx import Document
            doc = Document(io.BytesIO(file_bytes))
            all_text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
            lines = all_text.split("\n")
            start_line = (_FINGERPRINT_PAGE_START - 1) * 55
            end_line = _FINGERPRINT_PAGE_END * 55
            if len(lines) < 10 * 55:
                start_line, end_line = 0, len(lines)
            return "\n".join(lines[start_line:end_line]), []
        except Exception as exc:
            log.warning("docx_fingerprint_extract_failed", error=str(exc))
            return "", []

    return "", []


class RouteResult:
    """Result from the router including parse result + validation metadata."""
    def __init__(
        self,
        result: ParseResult,
        native_extraction: NativeExtractionPayload | None = None,
        rejected: bool = False,
        rejection_error: str | None = None,
        rejection_message: str | None = None,
        parser_path: str | None = None,
        parser_chain: list[str] | None = None,
    ):
        self.result = result
        self.native_extraction = native_extraction
        self.rejected = rejected
        self.rejection_error = rejection_error
        self.rejection_message = rejection_message
        # parser_path: identifier of the final winning parser (the one whose
        # output is in `result`). parser_chain: ordered list of every parser
        # attempted, including fallbacks. Both feed Phase 0 observability so
        # we can grep one log line and know which code path actually ran.
        self.parser_path = parser_path
        self.parser_chain = parser_chain or ([] if parser_path is None else [parser_path])


def route_and_parse(file_bytes: bytes, extension: str) -> RouteResult:
    """
    Main entry point. Routes file to correct parser and runs full validation pipeline.

    Returns RouteResult with:
      - result: ParseResult (populated even on rejection, for partial data)
      - rejected: True if file failed validation
      - rejection_error / rejection_message: structured error for notification pipeline
    """
    extension = extension.lower().lstrip(".")

    if extension not in ALLOWED_EXTENSIONS:
        return RouteResult(
            result=ParseResult(format="txt_heuristic"),  # type: ignore
            rejected=True,
            rejection_error="NOT_A_SCREENPLAY",
            rejection_message=f"Unsupported file extension: .{extension}",
            parser_path="rejected_unsupported_extension",
        )

    # ── step 1: PyMuPDF native extraction for PDFs ────────────────────────────
    # Single PyMuPDF open replaces separate watermark + fingerprint + native opens.
    watermark_result: WatermarkResult | None = None
    native_extraction: NativeExtractionPayload | None = None

    if extension == "pdf":
        try:
            native_extraction = extract_native_pdf_with_pymupdf(file_bytes)
            # Build watermark result from PyMuPDF's noise suppression metadata
            watermark_result = watermark_result_from_native_suppression(
                native_extraction.metadata,
            )
        except Exception as exc:
            log.warning("pymupdf_native_extract_failed", error=str(exc))
            # Fall through — pdfplumber watermark detection + layout parser as fallback

    # ── step 2: layer 2 fingerprint check ─────────────────────────────────────
    sample_text, sample_words = _extract_sample_text_for_fingerprint(
        file_bytes, extension, native_extraction,
    )

    # FDX skips fingerprint — XML structure is its own proof
    if extension != "fdx":
        # Pass native blocks for layout signal when pdfplumber words aren't available
        native_sample_blocks = None
        if not sample_words and native_extraction and native_extraction.blocks:
            page_count = int(native_extraction.metadata.get("page_count", 0) or 0)
            if page_count < 10:
                start_page, end_page = 1, page_count + 1
            else:
                start_page = _FINGERPRINT_PAGE_START
                end_page = _FINGERPRINT_PAGE_END + 1
            native_sample_blocks = [
                b for b in native_extraction.blocks
                if start_page <= b.page < end_page
            ]

        fingerprint = fingerprint_check(
            sample_text,
            sample_words if sample_words else None,
            native_blocks=native_sample_blocks,
        )
        log.info(
            "fingerprint_check",
            signals=fingerprint.signals,
            scene_heading=fingerprint.scene_heading_found,
            char_dialogue=fingerprint.character_dialogue_found,
            layout=fingerprint.layout_signal_found,
            stage_play=fingerprint.stage_play_detected,
        )

        if fingerprint.stage_play_detected and fingerprint.signals == 0:
            return RouteResult(
                result=ParseResult(format="txt_heuristic"),  # type: ignore
                rejected=True,
                rejection_error="STAGE_PLAY_DETECTED",
                rejection_message=(
                    "This appears to be a stage play. Stage play format is not yet supported. "
                    "Only screenplays are supported at this time."
                ),
                parser_path="rejected_stage_play",
            )

        # Temporarily bypass fingerprint rejection: log low-signal cases but keep processing.
        if fingerprint.signals == 0:
            log.warning(
                "fingerprint_bypass_active",
                reason="signals=0 would reject, but bypass is enabled for testing.",
            )

    # ── step 3: parse ─────────────────────────────────────────────────────────
    pdf_type: str | None = None  # tracked for step 3b fallback
    parser_chain: list[str] = []  # tracks every parser attempted, in order
    winning_parser: str | None = None  # tracks parser whose output is in `parse_result`

    try:
        if extension == "fdx":
            parser_chain.append("fdx")
            winning_parser = "fdx"
            parse_result = FdxParser().parse(file_bytes)

        elif extension == "pdf":
            pdf_type = detect_pdf_content_type(file_bytes)
            log.info("pdf_type_detected", pdf_type=pdf_type)

            # Override: if the simple char-count detector says "text" but PyMuPDF's
            # deeper analysis found zero usable blocks (native_text_layer_strength
            # is "absent"), the extractable chars are likely just watermark/metadata
            # noise (e.g. "Sides by Breakdown Services" rotated text). Reclassify
            # as "image" so OCR handles it properly.
            if (
                pdf_type == "text"
                and native_extraction
                and native_extraction.metadata.get("native_text_layer_strength") == "absent"
            ):
                log.info(
                    "reclassifying_pdf_to_image",
                    reason="detector said text but PyMuPDF found no usable blocks (strength=absent)",
                    original_pdf_type=pdf_type,
                )
                pdf_type = "image"

            if pdf_type == "image":
                # Image PDFs need OCR — delegate back to ai_service which has
                # Document AI and Adobe Extract already configured.
                log.info("image_pdf_detected_delegating_ocr_to_ai_service")
                return RouteResult(
                    result=ParseResult(format="pdf_image"),
                    rejected=True,
                    rejection_error="NEEDS_OCR",
                    rejection_message=(
                        "This PDF is image-based and requires OCR extraction. "
                        "Delegating to ai_service Document AI / Adobe Extract."
                    ),
                    parser_path="needs_ocr_delegation",
                )
            elif (
                native_extraction
                and native_extraction.metadata.get("native_text_layer_strength") == "strong"
            ):
                # PyMuPDF structural parse — primary path for digital PDFs
                log.info("using_pymupdf_structural_parser")
                parser_chain.append("pdf_pymupdf_structural")
                winning_parser = "pdf_pymupdf_structural"
                parse_result = parse_pdf_pymupdf_structural(
                    native_extraction.blocks,
                    int(native_extraction.metadata.get("page_count", 0) or 0),
                    watermark_detected=watermark_result.watermark_detected if watermark_result else False,
                    watermark_texts=watermark_result.watermark_texts if watermark_result else [],
                )
            else:
                # Weak/absent native text or no native extraction → pdfplumber fallback
                log.info(
                    "falling_back_to_pdfplumber_layout",
                    reason="native_text_layer_strength not strong or no native extraction",
                )
                parser_chain.append("pdf_layout_pdfplumber")
                winning_parser = "pdf_layout_pdfplumber"
                parse_result = parse_pdf_layout(file_bytes, watermark_result)

        elif extension == "docx":
            parser_chain.append("docx")
            winning_parser = "docx"
            parse_result = parse_docx(file_bytes)

        else:  # txt / fountain
            parser_chain.append("fountain")
            winning_parser = "fountain"
            parse_result = parse_fountain(file_bytes)

    except Exception as exc:
        log.error("parser_exception", extension=extension, error=str(exc))
        raise

    # ── step 3b: fallback chain for low-confidence text PDFs ──────────────────
    # Only text PDFs go through this — image PDFs already used OCR.
    # Fallback order: text heuristic (free) → Gemini structural (API cost).
    if extension == "pdf" and pdf_type == "text":
        layout_confidence = score_confidence(parse_result)
        best_confidence = layout_confidence

        if layout_confidence < 0.50:
            log.info(
                "layout_confidence_low_trying_text_heuristic",
                layout_score=layout_confidence,
            )
            try:
                parser_chain.append("pdf_text_heuristic")
                heuristic_result = parse_pdf_text_heuristic(file_bytes)
                heuristic_confidence = score_confidence(heuristic_result)
                log.info("text_heuristic_score", score=heuristic_confidence)

                if heuristic_confidence > best_confidence:
                    parse_result = heuristic_result
                    best_confidence = heuristic_confidence
                    winning_parser = "pdf_text_heuristic"
            except Exception as heuristic_exc:
                log.warning(
                    "text_heuristic_fallback_failed",
                    error=str(heuristic_exc),
                )

            # Gemini structural repair: last resort when both deterministic
            # parsers fail. Sends already-extracted raw text for re-classification.
            if best_confidence < 0.50 and parse_result.raw_text:
                log.info(
                    "trying_gemini_structural_repair",
                    best_score_so_far=best_confidence,
                )
                try:
                    parser_chain.append("pdf_gemini_structural")
                    gemini_result = parse_with_gemini_structural(
                        raw_text=parse_result.raw_text,
                        page_count=parse_result.page_count,
                        watermark_detected=parse_result.watermark_detected,
                        watermark_texts=parse_result.watermark_texts,
                    )
                    gemini_confidence = score_confidence(gemini_result)
                    log.info("gemini_structural_score", score=gemini_confidence)

                    if gemini_confidence > best_confidence:
                        parse_result = gemini_result
                        best_confidence = gemini_confidence
                        winning_parser = "pdf_gemini_structural"
                        log.info(
                            "gemini_structural_accepted",
                            improvement=round(gemini_confidence - layout_confidence, 3),
                        )
                    else:
                        log.info(
                            "gemini_structural_not_better",
                            gemini_score=gemini_confidence,
                            best_score=best_confidence,
                        )
                except Exception as gemini_exc:
                    log.warning(
                        "gemini_structural_fallback_failed",
                        error=str(gemini_exc),
                    )

    # ── step 4: layer 3 confidence scoring ────────────────────────────────────
    confidence = score_confidence(parse_result)
    parse_result.structure_confidence_score = confidence

    if extension != "fdx":
        if fingerprint.low_confidence_flag:
            parse_result.low_confidence_flag = True
            parse_result.parser_warnings.append(
                "Only 1 of 3 screenplay fingerprint signals found. "
                "Parse result may be incomplete."
            )

    log.info("confidence_score", score=confidence, extension=extension)

    if confidence < 0.40:
        log.warning(
            "confidence_bypass_active",
            score=confidence,
            message="score < 0.40 would normally reject, but bypass is enabled for testing.",
        )

    # ── step 5: character name normalization (Gemini) ────────────────────────
    # Normalize ambiguous names (#8 → JUROR #8) using Gemini. Only calls
    # the API when ambiguous patterns are detected. Never fails — returns
    # the original result on any error.
    parse_result = normalize_character_names(parse_result)

    # ── step 6: clean text reconstruction for Gemini ──────────────────────────
    parse_result.clean_text = reconstruct_clean_text(parse_result)

    return RouteResult(
        result=parse_result,
        native_extraction=native_extraction,
        parser_path=winning_parser,
        parser_chain=parser_chain,
    )
