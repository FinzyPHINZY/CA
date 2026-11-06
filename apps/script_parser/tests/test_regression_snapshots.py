"""
Regression snapshot tests.

For each fixture in tests/fixtures/regression/, run route_and_parse() and
compare the resulting structural shape to a stored JSON snapshot. Any
unexplained drift will fail the test — protecting against silent regressions
during parser fixes.

Workflow
--------
- First run (or intentional change): `UPDATE_SNAPSHOTS=1 pytest tests/test_regression_snapshots.py`
  Writes new snapshot files. Reviewer must inspect diff before commit.
- Subsequent runs: `pytest tests/test_regression_snapshots.py`
  Compares against stored snapshot. Fails on any drift.

Snapshot shape captures everything we care about across all phases:
- counts (scene/character/dialogue/action) — caught by Phase 2/3/4 fixes
- structure_confidence_score — caught by parser changes
- parser_path / parser_chain — Phase 0 routing
- watermark + warning state
- document_class (Phase 1)
- per-scene heading list — catches phantom PROLOGUE (Phase 6)

We deliberately do NOT snapshot raw text or scene-element bodies. Those
shift with extraction tweaks even when structure is unchanged, and they'd
make snapshots unreadable in PR review.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from pipeline.router import route_and_parse


FIXTURES_DIR = Path(__file__).parent / "fixtures" / "regression"
SNAPSHOTS_DIR = FIXTURES_DIR / "snapshots"

# Fixtures that should run. Extension drives parser selection.
# OCR fixture deferred — no scanned PDF available; tracked as a Phase 0 gap.
FIXTURES = [
    ("sides_breakdown_services.pdf", "pdf"),
    ("full_screenplay_digital.pdf", "pdf"),
    ("full_screenplay.fdx", "fdx"),
    ("full_screenplay.fountain", "fountain"),
]


def _count_elements_by_type(result) -> dict[str, int]:
    """Count scene elements by type across all scenes."""
    counts: dict[str, int] = {}
    if not result or not result.scenes:
        return counts
    for scene in result.scenes:
        for el in scene.elements:
            t = getattr(el.type, "value", el.type)
            counts[t] = counts.get(t, 0) + 1
    return counts


def _build_snapshot(route_result) -> dict[str, Any]:
    """Build a deterministic snapshot dict from a RouteResult."""
    result = route_result.result
    element_counts = _count_elements_by_type(result)

    scene_headings = []
    if result and result.scenes:
        for scene in result.scenes:
            scene_headings.append(
                {
                    "number": scene.number,
                    "script_scene_number": scene.script_scene_number,
                    "heading": scene.heading,
                    "page_start": scene.page_start,
                    "page_end": scene.page_end,
                    "element_count": len(scene.elements),
                }
            )

    return {
        "parser_path": route_result.parser_path,
        "parser_chain": route_result.parser_chain,
        "rejected": route_result.rejected,
        "rejection_error": route_result.rejection_error,
        "document_class": getattr(result, "document_class", None) if result else None,
        "format": getattr(result, "format", None) if result else None,
        "page_count": result.page_count if result else 0,
        "scene_count": len(result.scenes) if result else 0,
        "character_count": len(result.characters) if result else 0,
        "character_names": sorted([c.name for c in result.characters]) if result else [],
        "element_counts": element_counts,
        "structure_confidence_score": round(
            result.structure_confidence_score, 3
        ) if result else None,
        "watermark_detected": result.watermark_detected if result else None,
        "watermark_texts": sorted(result.watermark_texts) if result else [],
        "stage_play_detected": result.stage_play_detected if result else None,
        "low_confidence_flag": result.low_confidence_flag if result else None,
        "parser_warnings": result.parser_warnings if result else [],
        "scenes": scene_headings,
    }


@pytest.mark.parametrize("fixture_name,extension", FIXTURES)
def test_regression_snapshot(fixture_name: str, extension: str) -> None:
    fixture_path = FIXTURES_DIR / fixture_name
    if not fixture_path.exists():
        pytest.skip(f"Fixture not present: {fixture_name}")

    snapshot_path = SNAPSHOTS_DIR / f"{fixture_name}.json"

    file_bytes = fixture_path.read_bytes()
    route_result = route_and_parse(file_bytes, extension)
    actual = _build_snapshot(route_result)

    if os.getenv("UPDATE_SNAPSHOTS") == "1":
        SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
        snapshot_path.write_text(json.dumps(actual, indent=2, sort_keys=True))
        pytest.skip(f"Snapshot updated: {snapshot_path.name}")

    if not snapshot_path.exists():
        pytest.fail(
            f"No snapshot for {fixture_name}. "
            f"Run with UPDATE_SNAPSHOTS=1 to seed it."
        )

    expected = json.loads(snapshot_path.read_text())
    if actual != expected:
        # Emit a readable diff hint. Full diff is in the assertion message.
        diff_keys = sorted(
            k for k in set(actual) | set(expected)
            if actual.get(k) != expected.get(k)
        )
        pytest.fail(
            f"Snapshot drift for {fixture_name} on keys: {diff_keys}\n"
            f"Expected: {json.dumps(expected, indent=2, sort_keys=True)}\n"
            f"Actual:   {json.dumps(actual, indent=2, sort_keys=True)}\n"
            f"If intentional, re-run with UPDATE_SNAPSHOTS=1 and review the diff."
        )
