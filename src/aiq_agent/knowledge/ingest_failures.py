"""Why a file failed to read, as a category a retry can be decided on.

A failed file used to carry only ``error_message``, written by whichever tier
gave up. Every retry, by hand, by „Alle erneut lesen“ or by the org rescan,
read it again, forever, including the file that is certain to fail the same
way: an empty or encrypted PDF fails identically on every attempt and spends a
download, a parse and sometimes vision calls each time.

So every per-file failure gets a category and a ``retryable`` flag, stamped on
the job's ``file_details`` (``FileProgress.failure_category`` / ``retryable``)
next to the message, and the BFF persists both on the document row and decides
retries from them (``frontends/ui/src/lib/documents/retry-policy.ts``):

==============  =========  ====================================================
category        retryable  what it means
==============  =========  ====================================================
transient       yes        interrupted, timed out, a download, a dispatch or an
                           upstream call failed. The same bytes may read now.
configuration   yes        the deployment lacks something (a vision model). The
                           same bytes read once it is configured.
deterministic   no         the bytes themselves: empty, encrypted, unparseable,
                           too many unreadable pages. The same reader fails the
                           same way; new bytes or a newer reader may not.
quarantined     no         not a failure: the content check held the file and
                           a reviewer decides (ADR-0086).
unknown         yes        nothing here recognised it. Retried, as before.
==============  =========  ====================================================

The categories are mirrored in ``INGEST_FAILURE_CATEGORIES``
(``retry-policy.ts``), and ``test_ingest_failure_prefix_parity.py`` holds the two
together, along with a category for every ``reason:`` prefix the backend writes.

Pure: no I/O, and no import of the provider SDKs. Exceptions are recognised by
the names in their MRO, so a classifier in ``aiq_agent`` does not drag httpx,
openai or pdfminer in, and an SDK upgrade that moves a class keeps its name.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Final
from typing import Literal

FailureCategory = Literal["transient", "configuration", "deterministic", "quarantined", "unknown"]

TRANSIENT: Final = "transient"
CONFIGURATION: Final = "configuration"
DETERMINISTIC: Final = "deterministic"
QUARANTINED: Final = "quarantined"
UNKNOWN: Final = "unknown"

#: Every category, in the order the docs list them. Mirrored in the UI.
FAILURE_CATEGORIES: Final[tuple[FailureCategory, ...]] = (TRANSIENT, CONFIGURATION, DETERMINISTIC, QUARANTINED, UNKNOWN)

#: Whether reading the same bytes with the same reader again can succeed.
_RETRYABLE: Final[dict[FailureCategory, bool]] = {
    TRANSIENT: True,
    CONFIGURATION: True,
    DETERMINISTIC: False,
    QUARANTINED: False,
    UNKNOWN: True,
}

#: Every machine prefix (the text before the first ``:``) a failure is written
#: with, to its category. A prefix the backend writes and this does not name
#: fails the parity test, as one the UI does not map does.
PREFIX_CATEGORIES: Final[dict[str, FailureCategory]] = {
    # The worker that owned the job stopped heartbeating (ingest_status_store).
    "interrupted": TRANSIENT,
    # The queued job's payload could not be decrypted or parsed (ingest_dispatch).
    "unreadable_job": TRANSIENT,
    # The presigned original could not be downloaded (deferred_files).
    "original_download_failed": TRANSIENT,
    # The BFF sent no PDF rendition of a Word or presentation file: the
    # converter failed or the link expired. The next dispatch converts again.
    "office_rendition_required": TRANSIENT,
    # The document was deleted while it waited or read; nothing about the bytes.
    "document_deleted": TRANSIENT,
    # No vision model for a scan or an image.
    "vlm_not_configured": CONFIGURATION,
    # Too many pages pdfplumber could not read: the file, not the moment.
    "pdf_pages_unreadable": DETERMINISTIC,
    "quarantined": QUARANTINED,
}


@dataclass(frozen=True)
class FailureVerdict:
    """A failure's category, and whether the same bytes may read on a retry."""

    category: FailureCategory
    retryable: bool


def verdict_for(category: FailureCategory) -> FailureVerdict:
    """The verdict a category carries."""
    return FailureVerdict(category, _RETRYABLE[category])


#: Exception classes (by name, anywhere in the MRO) that say "not now".
_TRANSIENT_EXCEPTIONS: Final = frozenset(
    {
        # builtins and concurrent.futures (an alias of TimeoutError since 3.11)
        "TimeoutError",
        "ConnectionError",
        # httpx
        "TimeoutException",
        "TransportError",
        "NetworkError",
        "RemoteProtocolError",
        # openai
        "APIConnectionError",
        "APITimeoutError",
        "InternalServerError",
        "RateLimitError",
        # requests / urllib3, which some readers still use
        "ReadTimeoutError",
        "ProtocolError",
    }
)

#: Exception classes that say "these bytes cannot be read".
_DETERMINISTIC_EXCEPTIONS: Final = frozenset(
    {
        # pdfminer (pdfplumber's parser)
        "PDFPasswordIncorrect",
        "PDFEncryptionError",
        "PDFSyntaxError",
        "PDFTypeError",
        "PDFValueError",
        "PSEOF",
        "PSSyntaxError",
        # pypdfium2
        "PdfiumError",
        # zip containers (xlsx, pptx) and their readers
        "BadZipFile",
        "InvalidFileException",
        "PackageNotFoundError",
        # Pillow
        "UnidentifiedImageError",
        "DecompressionBombError",
    }
)

#: Sentences the adapter and its readers write about the bytes. Not "corrupt":
#: the image path says "corrupted file or VLM failure", which is not a verdict.
_DETERMINISTIC_TEXT = re.compile(
    r"^no content extracted\b|password|encrypt|raw pdf/binary content|not a (?:pdf|zip)\b|"
    r"\bempty file\b|\bfile is empty\b",
    re.IGNORECASE,
)
_TRANSIENT_TEXT = re.compile(
    r"\btimed?[\s_-]?out\b|\btimeout\b|connection (?:reset|refused|aborted|error)|"
    r"temporarily unavailable|service unavailable|bad gateway|gateway time-?out|rate limit|too many requests|"
    r"\b(?:http|status|code|error)\b\D{0,12}\b5\d\d\b|\b5\d\d internal server error\b",
    re.IGNORECASE,
)
_PREFIX = re.compile(r"^([a-z][a-z_]*):")


def classify_failure(error: str | None, exc: BaseException | None = None) -> FailureVerdict:
    """The verdict on one file's failure, from the exception that ended it and its message.

    ``exc`` is the exception the per-file catch caught, when there was one; the
    message alone is enough for every failure the adapter writes deliberately
    (a ``reason:`` prefix or a known sentence). The exception's type is asked
    first because it is the more reliable witness: a message is free text.
    """
    message = (error or "").strip()
    by_prefix = _from_prefix(message)
    if by_prefix is not None:
        return verdict_for(by_prefix)
    if exc is not None:
        by_exception = _from_exception(exc)
        if by_exception is not None:
            return verdict_for(by_exception)
    by_text = _from_text(message or (str(exc) if exc is not None else ""))
    if by_text is not None:
        return verdict_for(by_text)
    if exc is not None and _is_parse_error(exc):
        return verdict_for(DETERMINISTIC)
    return verdict_for(UNKNOWN)


def _from_prefix(message: str) -> FailureCategory | None:
    match = _PREFIX.match(message)
    return PREFIX_CATEGORIES.get(match.group(1)) if match else None


def _names(exc: BaseException) -> set[str]:
    return {cls.__name__ for cls in type(exc).__mro__}


def _from_exception(exc: BaseException) -> FailureCategory | None:
    names = _names(exc)
    if names & _TRANSIENT_EXCEPTIONS:
        return TRANSIENT
    if names & _DETERMINISTIC_EXCEPTIONS:
        return DETERMINISTIC
    return _from_status_code(exc)


def _from_status_code(exc: BaseException) -> FailureCategory | None:
    """An upstream HTTP answer: openai's ``status_code``, httpx's ``response.status_code``."""
    status = getattr(exc, "status_code", None)
    if not isinstance(status, int):
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
    if not isinstance(status, int) or status < 400:
        return None
    if status >= 500 or status in (408, 409, 425, 429):
        return TRANSIENT
    if status in (401, 403):
        return CONFIGURATION
    # 400, 413, 415, 422: the request this file made is refused as it is.
    return DETERMINISTIC


def _from_text(message: str) -> FailureCategory | None:
    if not message:
        return None
    if _TRANSIENT_TEXT.search(message):
        return TRANSIENT
    if _DETERMINISTIC_TEXT.search(message):
        return DETERMINISTIC
    return None


def _is_parse_error(exc: BaseException) -> bool:
    """A ValueError from the splitter, a reader or the binary guard: the bytes, not the moment.

    A JSON decode error is a ValueError too, and it is the upstream's garbled
    answer far more often than the file's, so it stays ``unknown``.
    """
    return isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError)
