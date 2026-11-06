"""Quick diagnostic: dump PyMuPDF raw block data for TINA.pdf to see rotation/direction."""
import sys
import json
import fitz

def inspect_pdf(path: str):
    doc = fitz.open(path)
    for page_idx in range(len(doc)):
        page = doc.load_page(page_idx)
        page_dict = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)
        print(f"\n=== Page {page_idx + 1} (rotation={page.rotation}) ===\n")
        for bi, block in enumerate(page_dict.get("blocks", [])):
            if block.get("type") != 0:
                continue
            for li, line in enumerate(block.get("lines", [])):
                spans = line.get("spans", [])
                text = "".join(s.get("text", "") for s in spans).strip()
                if not text:
                    continue
                direction = line.get("dir", (1.0, 0.0))
                bbox = line.get("bbox", [])
                font = spans[0].get("font", "?") if spans else "?"
                size = spans[0].get("size", 0) if spans else 0
                print(f"  dir={direction}  bbox={[round(v,1) for v in bbox]}  font={font}  size={round(size,1)}  text={text!r}")
    doc.close()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python debug_tina.py <path_to_pdf>")
        sys.exit(1)
    inspect_pdf(sys.argv[1])
