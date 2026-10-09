"""Parity guard: every ``reason:`` prefix an ingest failure can carry has a UI category.

The knowledge layer and the ingest status store write a failed document's
``error_message`` as ``reason: text`` (``vlm_not_configured: …``). The UI maps
the reason to a sentence in the reader's language with ``INGEST_FAILURE_PREFIXES``
in ``frontends/ui/src/features/documents/lib/ingest-failure.ts``. There is no
shared schema, and an unmapped reason does not break: it shows the generic
"could not read" sentence, so the drift is silent. It is caught here.
"""

import re
from pathlib import Path

from knowledge_layer.deferred_files import ORIGINAL_DOWNLOAD_FAILED
from knowledge_layer.llamaindex.adapter import unreadable_pdf_verdict
from knowledge_layer.llamaindex.screening import QUARANTINED_PREFIX
from knowledge_layer.llamaindex.transcription import SCAN_NEEDS_VLM
from knowledge_layer.renditions import OFFICE_RENDITION_REQUIRED

from aiq_agent.knowledge.ingest_status_store import INTERRUPTED_MESSAGE

REPO_ROOT = Path(__file__).resolve().parents[2]
TS_MAPPER = REPO_ROOT / "frontends" / "ui" / "src" / "features" / "documents" / "lib" / "ingest-failure.ts"
BACKEND_ROOTS = (
    REPO_ROOT / "sources" / "knowledge_layer" / "src",
    REPO_ROOT / "src" / "aiq_agent" / "knowledge",
)

#: A reason-prefixed literal where a failure is written: an ``error=`` /
#: ``error_message=`` argument, or a module constant (possibly parenthesised
#: over several lines). Logger lines share the shape and are not failures.
_WRITTEN_REASON = re.compile(
    r"""(?:\berror(?:_message)?\s*=\s*|^[A-Z][A-Z0-9_]*\s*=\s*\(?\s*)f?["']([a-z]+(?:_[a-z]+)+):\s""",
    re.MULTILINE,
)


def _prefix(message: str) -> str:
    return message.split(":", 1)[0]


def _ts_prefixes() -> set[str]:
    """The keys of ``INGEST_FAILURE_PREFIXES`` in the UI mapper."""
    source = TS_MAPPER.read_text(encoding="utf-8")
    match = re.search(r"export const INGEST_FAILURE_PREFIXES = \{(.*?)\} as const", source, re.DOTALL)
    assert match, f"INGEST_FAILURE_PREFIXES not found in {TS_MAPPER}"
    return set(re.findall(r"^\s*([a-z_]+):", match.group(1), re.MULTILINE))


def _written_backend_prefixes() -> set[str]:
    found: set[str] = set()
    for root in BACKEND_ROOTS:
        for path in root.rglob("*.py"):
            found.update(_WRITTEN_REASON.findall(path.read_text(encoding="utf-8")))
    return found


class _Pages(list):
    failed_pages = (1, 2, 3)
    page_count = 4


def test_the_known_failure_constants_each_have_a_ui_category():
    pages_verdict = unreadable_pdf_verdict(_Pages())
    assert pages_verdict is not None
    messages = (
        OFFICE_RENDITION_REQUIRED,
        ORIGINAL_DOWNLOAD_FAILED,
        INTERRUPTED_MESSAGE,
        SCAN_NEEDS_VLM,
        pages_verdict,
        # One word, so the reason scan below cannot see it: named here instead.
        QUARANTINED_PREFIX,
    )
    assert {_prefix(message) for message in messages} <= _ts_prefixes()


def test_the_page_counts_the_ui_parses_are_in_the_verdict():
    assert unreadable_pdf_verdict(_Pages()) == "pdf_pages_unreadable: 3 of 4 pages could not be read"


def test_every_reason_the_backend_writes_has_a_ui_category():
    written = _written_backend_prefixes()
    # The scan must find the ones this file imports, or it has gone blind.
    assert {"office_rendition_required", "original_download_failed", "vlm_not_configured"} <= written
    assert written <= _ts_prefixes(), f"unmapped in ingest-failure.ts: {sorted(written - _ts_prefixes())}"
