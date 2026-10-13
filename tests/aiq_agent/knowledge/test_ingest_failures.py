"""A failed file's category, from its reason and the exception that ended it.

The category decides whether reading the file again is worth anything
(``frontends/ui/src/lib/documents/retry-policy.ts``). The reasons the adapter
writes on purpose are pinned in ``test_ingest_failure_prefix_parity.py``; these
pin what the per-file catch meets: an exception and ``str(e)``.
"""

import json

import pytest

from aiq_agent.knowledge.ingest_failures import FAILURE_CATEGORIES
from aiq_agent.knowledge.ingest_failures import classify_failure
from aiq_agent.knowledge.ingest_failures import verdict_for


# Stand-ins named as the SDKs name theirs: the classifier reads names, so a
# test needs neither httpx nor openai nor pdfminer installed to say this.
class ReadTimeout(Exception):
    pass


class TimeoutException(ReadTimeout):  # httpx's base sits above the concrete class
    pass


class APIConnectionError(Exception):
    pass


class PDFPasswordIncorrect(Exception):
    pass


class PdfiumError(RuntimeError):
    pass


class _StatusError(Exception):
    def __init__(self, status_code: int):
        super().__init__(f"Error code: {status_code}")
        self.status_code = status_code


class _Response:
    def __init__(self, status_code: int):
        self.status_code = status_code


class HTTPStatusError(Exception):
    def __init__(self, status_code: int):
        super().__init__("upstream refused")
        self.response = _Response(status_code)


def _verdict(exc: BaseException, message: str | None = None):
    v = classify_failure(str(exc) if message is None else message, exc)
    return v.category, v.retryable


@pytest.mark.parametrize(
    "exc",
    [
        TimeoutError("read timed out"),
        ConnectionResetError("connection reset by peer"),
        TimeoutException("timed out"),
        APIConnectionError("Connection error."),
        _StatusError(503),
        _StatusError(429),
        HTTPStatusError(502),
    ],
    ids=["timeout", "connection-reset", "httpx-timeout", "openai-connection", "5xx", "429", "httpx-502"],
)
def test_a_failure_of_the_moment_is_transient(exc):
    assert _verdict(exc) == ("transient", True)


@pytest.mark.parametrize(
    "exc",
    [
        PDFPasswordIncorrect(""),
        PdfiumError("Failed to load document (PDFium: Incorrect password error)."),
        ValueError("Raw PDF/binary content detected; refusing to index"),
        ValueError("Document is empty; nothing to split"),
        UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte"),
        _StatusError(413),
    ],
    ids=["encrypted", "pdfium", "binary-guard", "splitter", "decode", "413"],
)
def test_a_failure_of_the_bytes_is_deterministic(exc):
    assert _verdict(exc) == ("deterministic", False)


def test_a_refused_key_is_configuration():
    assert _verdict(_StatusError(401)) == ("configuration", True)


def test_the_adapters_own_sentence_for_an_empty_file_is_deterministic():
    message = "No content extracted (file may be password-protected, corrupted, or empty)"
    assert (classify_failure(message).category, classify_failure(message).retryable) == ("deterministic", False)


def test_a_garbled_upstream_answer_is_not_blamed_on_the_file():
    """A JSONDecodeError is a ValueError, and almost always the provider's answer, not the bytes."""
    exc = json.JSONDecodeError("Expecting value", "<html>", 0)
    assert _verdict(exc) == ("unknown", True)


def test_what_nothing_recognises_stays_retryable():
    assert _verdict(RuntimeError("something odd")) == ("unknown", True)
    assert (classify_failure(None).category, classify_failure("").retryable) == ("unknown", True)


def test_a_reason_prefix_beats_the_exception():
    """The adapter's deliberate reason is the more specific statement."""
    verdict = classify_failure("vlm_not_configured: image ingestion requires AIQ_VLM_API_KEY", TimeoutError())
    assert verdict.category == "configuration"


def test_the_image_paths_ambiguous_sentence_is_not_a_verdict_on_the_bytes():
    """It says "corrupted file or VLM failure": retrying it must stay possible."""
    verdict = classify_failure("Image could not be decoded or captioned (corrupted file or VLM failure)")
    assert verdict.retryable is True


@pytest.mark.parametrize("category", FAILURE_CATEGORIES)
def test_only_lasting_categories_refuse_a_retry(category):
    assert verdict_for(category).retryable is (category not in ("deterministic", "quarantined"))
