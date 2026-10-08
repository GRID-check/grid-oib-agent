"""Parity guard: which office formats are indexed from their PDF rendition (ADR-0071).

The BFF decides which dispatches carry ``extraction_ref`` with
``RENDITION_INDEXED_EXTENSIONS`` in ``frontends/ui/src/lib/documents/preview-types.ts``;
the knowledge layer fails such a format that arrives without one, using its own
copy in ``renditions.py``. There is no shared schema. A format in the backend's
list and not the BFF's fails every upload of it; one in the BFF's list and not
the backend's is read from the rendition but never refused without one. Either
drift is silent, so it is caught here.
"""

import re
from pathlib import Path

from knowledge_layer.renditions import RENDITION_INDEXED_EXTENSIONS

REPO_ROOT = Path(__file__).resolve().parents[2]
TS_PREVIEW_TYPES = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "documents" / "preview-types.ts"


def _ts_rendition_indexed_extensions() -> set[str]:
    """The string literals of ``RENDITION_INDEXED_EXTENSIONS`` in the BFF."""
    source = TS_PREVIEW_TYPES.read_text(encoding="utf-8")
    match = re.search(r"export const RENDITION_INDEXED_EXTENSIONS = \[(.*?)\] as const", source, re.DOTALL)
    assert match, f"RENDITION_INDEXED_EXTENSIONS not found in {TS_PREVIEW_TYPES}"
    return set(re.findall(r"'([^']+)'", match.group(1)))


def test_spreadsheets_with_their_own_reader_are_not_indexed_from_the_rendition():
    assert ".xlsx" not in RENDITION_INDEXED_EXTENSIONS
    assert ".xlsm" not in RENDITION_INDEXED_EXTENSIONS


def test_bff_and_knowledge_layer_index_the_same_formats_from_the_rendition():
    assert _ts_rendition_indexed_extensions() == set(RENDITION_INDEXED_EXTENSIONS)
