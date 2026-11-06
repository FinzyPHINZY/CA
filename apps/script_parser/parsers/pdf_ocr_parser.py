"""
PDF OCR fallback for image-based PDFs (task 4.0.9).

Pipeline:
  1. Render each page to 300 DPI image via pdf2image (wraps poppler)
  2. Send to Google Vision API DOCUMENT_TEXT_DETECTION
  3. Map Vision's TextAnnotation bounding polygon x coords to column buckets
  4. Apply same classification rules as the text parser (4.0.8)

OCR coordinates are less precise → lower base confidence contribution.
"""
from __future__ import annotations

import io
import os
from collections import defaultdict

import structlog
from pdf2image import convert_from_bytes

from models.schema import (
    ElementType,
    ParsedCharacter,
    ParseResult,
    Scene,
    ScriptElement,
)
from parsers.pdf_layout_parser import ColumnBuckets, _classify_block, _calibrate_buckets
from pipeline.normalization import extract_scene_number, is_revision_marker, strip_contd
from pipeline.watermark import WatermarkResult

log = structlog.get_logger()

_OCR_CONFIDENCE_PENALTY = 0.15  # Subtracted from score for OCR pages


def _vision_words_from_page(image, vision_client) -> list[dict]:
    """
    Send a PIL image to Vision API and return pdfplumber-compatible word dicts.
    Each word dict has: text, x0, x1, top, bottom.
    """
    import io as _io

    img_byte_arr = _io.BytesIO()
    image.save(img_byte_arr, format="PNG")
    img_bytes = img_byte_arr.getvalue()

    from google.cloud import vision

    content_image = vision.Image(content=img_bytes)
    response = vision_client.document_text_detection(image=content_image)

    words: list[dict] = []
    if not response.full_text_annotation:
        return words

    for page in response.full_text_annotation.pages:
        # Vision returns in document units; scale to PDF points (72pt/inch, image at 300 DPI)
        scale = 72.0 / 300.0
        for block in page.blocks:
            for para in block.paragraphs:
                for word in para.words:
                    verts = word.bounding_box.vertices
                    if len(verts) < 4:
                        continue
                    xs = [v.x * scale for v in verts]
                    ys = [v.y * scale for v in verts]
                    text = "".join(
                        sym.text for sym in word.symbols
                    )
                    words.append({
                        "text": text,
                        "x0": min(xs),
                        "x1": max(xs),
                        "top": min(ys),
                        "bottom": max(ys),
                        "rotation": 0.0,
                    })
    return words


def parse_pdf_ocr(
    file_bytes: bytes,
    watermark_result: WatermarkResult | None = None,
) -> ParseResult:
    """OCR-based parser for image PDFs (task 4.0.9)."""
    from google.cloud import vision as vision_module

    vision_client = vision_module.ImageAnnotatorClient()

    pages_images = convert_from_bytes(file_bytes, dpi=300)
    page_count = len(pages_images)
    log.info("ocr_parser_start", pages=page_count)

    all_words_for_calibration: list[dict] = []
    pages_words: list[list[dict]] = []

    for img in pages_images[:10]:
        words = _vision_words_from_page(img, vision_client)
        all_words_for_calibration.extend(words)
        pages_words.append(words)

    # Process remaining pages
    for img in pages_images[10:]:
        words = _vision_words_from_page(img, vision_client)
        pages_words.append(words)

    buckets = _calibrate_buckets(all_words_for_calibration) or ColumnBuckets()

    scenes: list[Scene] = []
    current_scene: Scene | None = None
    current_elements: list[ScriptElement] = []
    prev_type: ElementType | None = None
    current_char_name: str | None = None
    char_line_counts: dict[str, int] = defaultdict(int)
    raw_lines: list[str] = []

    watermark_word_ids = watermark_result.watermark_word_ids if watermark_result else set()

    def _finalize_scene() -> None:
        nonlocal current_scene, current_elements
        if current_scene is not None:
            current_scene.elements = current_elements[:]
            scenes.append(current_scene)
            current_scene = None
            current_elements = []

    for page_num, words in enumerate(pages_words, start=1):
        # Group into lines by y-coord
        line_groups: dict[int, list[dict]] = defaultdict(list)
        for w in words:
            if id(w) in watermark_word_ids:
                continue
            y_bucket = int(w.get("top", 0) // 5)
            line_groups[y_bucket].append(w)

        for y_key in sorted(line_groups.keys()):
            group = sorted(line_groups[y_key], key=lambda w: w.get("x0", 0))
            line_text = " ".join(w.get("text", "") for w in group).strip()
            if not line_text:
                continue

            x0 = group[0].get("x0", 0.0)
            x1 = group[-1].get("x1", 0.0)
            elem_type = _classify_block(line_text, x0, x1, buckets, prev_type)

            raw_lines.append(line_text)

            if elem_type == ElementType.SCENE_HEADING:
                _finalize_scene()
                script_num, heading_clean = extract_scene_number(line_text)
                current_scene = Scene(
                    number=len(scenes) + 1,
                    script_scene_number=script_num,
                    heading=heading_clean,
                    page_start=page_num,
                )
                current_elements = []
                current_char_name = None

            elif elem_type == ElementType.CHARACTER:
                normalized = strip_contd(line_text)
                current_char_name = normalized
                current_elements.append(
                    ScriptElement(type=elem_type, text=normalized, character_name=normalized)
                )
                char_line_counts[normalized] += 1

            elif elem_type == ElementType.DIALOGUE:
                current_elements.append(
                    ScriptElement(type=elem_type, text=line_text, character_name=current_char_name)
                )
                if current_char_name:
                    char_line_counts[current_char_name] += 1

            else:
                current_elements.append(ScriptElement(type=elem_type, text=line_text))
                if elem_type not in (ElementType.PARENTHETICAL, ElementType.TRANSITION):
                    current_char_name = None

            prev_type = elem_type
            if current_scene:
                current_scene.page_end = page_num

    _finalize_scene()

    characters = [
        ParsedCharacter(name=name, line_count=count)
        for name, count in sorted(char_line_counts.items(), key=lambda x: -x[1])
    ]

    return ParseResult(
        format="pdf_ocr",
        scenes=scenes,
        characters=characters,
        raw_text="\n".join(raw_lines),
        page_count=page_count,
        watermark_detected=watermark_result.watermark_detected if watermark_result else False,
        watermark_texts=watermark_result.watermark_texts if watermark_result else [],
        parser_warnings=["OCR-based extraction; coordinates may be less precise than text PDF"],
    )
