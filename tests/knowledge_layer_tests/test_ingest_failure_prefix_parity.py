"""Parity guard: every ``reason:`` prefix an ingest failure can carry has a UI category and a retry category.

The knowledge layer, the ingest status store and the API plugin's ingest worker
write a failed document's ``error_message`` as ``reason: text``
(``vlm_not_configured: …``). Two things read the reason, in two languages:

* the UI maps it to a sentence in the reader's language with
  ``INGEST_FAILURE_PREFIXES`` in ``frontends/ui/src/features/documents/lib/ingest-failure.ts``;
* the backend maps it to a failure category (``PREFIX_CATEGORIES`` in
  ``aiq_agent/knowledge/ingest_failures.py``), which decides whether reading
  the file again is worth anything, and the BFF holds the categories and the
  reader version in ``frontends/ui/src/lib/documents/retry-policy.ts``.

There is no shared schema, and an unmapped reason does not break: it shows the
generic "could not read" sentence and is retried as ``unknown``, so the drift is
silent. It is caught here.
"""

import re
from pathlib import Path

import pytest
from knowledge_layer.deferred_files import ORIGINAL_DOWNLOAD_FAILED
from knowledge_layer.llamaindex.adapter import DOCUMENT_DELETED_DURING_INGEST
from knowledge_layer.llamaindex.adapter import SCREENING_UNAVAILABLE
from knowledge_layer.llamaindex.adapter import unreadable_pdf_verdict
from knowledge_layer.llamaindex.screening import QUARANTINED_PREFIX
from knowledge_layer.llamaindex.transcription import SCAN_NEEDS_VLM
from knowledge_layer.reader_version import INGEST_READER_VERSION
from knowledge_layer.renditions import OFFICE_RENDITION_REQUIRED

from aiq_agent.knowledge.ingest_failures import FAILURE_CATEGORIES
from aiq_agent.knowledge.ingest_failures import PREFIX_CATEGORIES
from aiq_agent.knowledge.ingest_failures import classify_failure
from aiq_agent.knowledge.ingest_status_store import INTERRUPTED_MESSAGE

REPO_ROOT = Path(__file__).resolve().parents[2]
TS_MAPPER = REPO_ROOT / "frontends" / "ui" / "src" / "features" / "documents" / "lib" / "ingest-failure.ts"
TS_RETRY_POLICY = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "documents" / "retry-policy.ts"
BACKEND_ROOTS = (
    REPO_ROOT / "sources" / "knowledge_layer" / "src",
    REPO_ROOT / "src" / "aiq_agent" / "knowledge",
    # The ingest worker settles a job whose queued payload it cannot read
    # (`unreadable_job:`, `jobs/ingest_dispatch.py`). It was outside the scan,
    # and its reason reached the UI unmapped.
    REPO_ROOT / "frontends" / "aiq_api" / "src",
)

#: A reason-prefixed literal where a failure is written: an ``error=`` /
#: ``error_message=`` argument or assignment, or a module constant (either one
#: possibly parenthesised over several lines). Logger lines share the shape and
#: are not failures.
_WRITTEN_REASON = re.compile(
    r"""(?:\berror(?:_message)?\s*=\s*\(?\s*|^[A-Z][A-Z0-9_]*\s*=\s*\(?\s*)f?["']([a-z]+(?:_[a-z]+)+):\s""",
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


def _ts_categories() -> tuple[str, ...]:
    """``INGEST_FAILURE_CATEGORIES`` in the BFF's retry policy, in order."""
    source = TS_RETRY_POLICY.read_text(encoding="utf-8")
    match = re.search(r"export const INGEST_FAILURE_CATEGORIES = \[(.*?)\] as const", source, re.DOTALL)
    assert match, f"INGEST_FAILURE_CATEGORIES not found in {TS_RETRY_POLICY}"
    return tuple(re.findall(r"'([a-z_]+)'", match.group(1)))


def _ts_reader_version() -> str:
    source = TS_RETRY_POLICY.read_text(encoding="utf-8")
    match = re.search(r"export const CURRENT_INGEST_READER_VERSION = '([^']+)'", source)
    assert match, f"CURRENT_INGEST_READER_VERSION not found in {TS_RETRY_POLICY}"
    return match.group(1)


def _written_backend_prefixes() -> set[str]:
    found: set[str] = set()
    for root in BACKEND_ROOTS:
        for path in root.rglob("*.py"):
            found.update(_WRITTEN_REASON.findall(path.read_text(encoding="utf-8")))
    return found


class _Pages(list):
    failed_pages = (1, 2, 3)
    page_count = 4


def _known_messages() -> tuple[str, ...]:
    pages_verdict = unreadable_pdf_verdict(_Pages())
    assert pages_verdict is not None
    return (
        OFFICE_RENDITION_REQUIRED,
        ORIGINAL_DOWNLOAD_FAILED,
        INTERRUPTED_MESSAGE,
        SCAN_NEEDS_VLM,
        DOCUMENT_DELETED_DURING_INGEST,
        SCREENING_UNAVAILABLE,
        pages_verdict,
        # One word, so the reason scan below cannot see it: named here instead.
        QUARANTINED_PREFIX,
    )


def test_the_known_failure_constants_each_have_a_ui_category():
    assert {_prefix(message) for message in _known_messages()} <= _ts_prefixes()


def test_the_page_counts_the_ui_parses_are_in_the_verdict():
    assert unreadable_pdf_verdict(_Pages()) == "pdf_pages_unreadable: 3 of 4 pages could not be read"


def test_every_reason_the_backend_writes_has_a_ui_category():
    written = _written_backend_prefixes()
    # The scan must find the ones this file imports, or it has gone blind; and
    # the worker's, or it no longer reaches the API plugin.
    assert {"office_rendition_required", "original_download_failed", "vlm_not_configured", "unreadable_job"} <= written
    assert written <= _ts_prefixes(), f"unmapped in ingest-failure.ts: {sorted(written - _ts_prefixes())}"


def test_every_reason_has_a_retry_category():
    """A reason without one is retried as ``unknown`` forever, which is the bug this category exists to end."""
    reasons = _written_backend_prefixes() | _ts_prefixes() | {_prefix(m) for m in _known_messages()}
    missing = sorted(reasons - set(PREFIX_CATEGORIES))
    assert not missing, f"no category in ingest_failures.PREFIX_CATEGORIES: {missing}"


def test_the_bff_knows_the_same_categories_in_the_same_order():
    assert _ts_categories() == FAILURE_CATEGORIES
    assert set(PREFIX_CATEGORIES.values()) <= set(FAILURE_CATEGORIES)


def test_the_bff_compares_against_the_reader_the_backend_stamps():
    assert _ts_reader_version() == INGEST_READER_VERSION


@pytest.mark.parametrize(
    ("message", "category", "retryable"),
    [
        (INTERRUPTED_MESSAGE, "transient", True),
        (ORIGINAL_DOWNLOAD_FAILED, "transient", True),
        (OFFICE_RENDITION_REQUIRED, "transient", True),
        (DOCUMENT_DELETED_DURING_INGEST, "transient", True),
        ("unreadable_job: the queued ingestion job could not be read; retry to index this file", "transient", True),
        (SCAN_NEEDS_VLM, "configuration", True),
        (SCREENING_UNAVAILABLE, "configuration", True),
        ("vlm_not_configured: image ingestion requires AIQ_VLM_API_KEY", "configuration", True),
        ("pdf_pages_unreadable: 3 of 4 pages could not be read", "deterministic", False),
        ('quarantined:{"reasons":[],"checked":"full"}', "quarantined", False),
    ],
)
def test_each_known_reason_carries_its_category(message, category, retryable):
    verdict = classify_failure(message)
    assert (verdict.category, verdict.retryable) == (category, retryable)
