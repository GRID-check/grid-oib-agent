"""Parity guard: the frontend tag vocabulary must match the backend enum.

The controlled tag vocabulary lives canonically in the Python backend
(``document_classification``). The Files tag editor keeps a hand-written
TypeScript mirror in ``frontends/ui/src/lib/documents/tag-vocabulary.ts`` to
render its chips. This test fails if the two ever drift — so the backend stays
the single source of truth and a stale TS copy is caught in CI.
"""

import re
from pathlib import Path

from aiq_agent.knowledge.document_classification import DISCIPLINE_TAGS
from aiq_agent.knowledge.document_classification import DOCUMENT_TYPE_TAGS

REPO_ROOT = Path(__file__).resolve().parents[1]
TS_VOCAB = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "documents" / "tag-vocabulary.ts"


def _extract_ts_array(source: str, const_name: str) -> list[str]:
    """Pull the string literals out of an ``export const NAME = [ ... ]`` block."""
    match = re.search(rf"export const {const_name} = \[(.*?)\]", source, re.DOTALL)
    assert match, f"{const_name} not found in {TS_VOCAB}"
    return re.findall(r"'([^']*)'", match.group(1))


def test_document_type_tags_match():
    source = TS_VOCAB.read_text(encoding="utf-8")
    assert _extract_ts_array(source, "DOCUMENT_TYPE_TAGS") == list(DOCUMENT_TYPE_TAGS)


def test_discipline_tags_match():
    source = TS_VOCAB.read_text(encoding="utf-8")
    assert _extract_ts_array(source, "DISCIPLINE_TAGS") == list(DISCIPLINE_TAGS)
