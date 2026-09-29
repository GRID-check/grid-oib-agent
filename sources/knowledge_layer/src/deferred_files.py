"""Files the ingest job downloads itself, when it reaches them.

``POST /v1/ingest`` answers the BFF within its ten-second budget by downloading
nothing: it gates each object-store URL and hands the job a zero-argument
callable in place of a path (``aiq_api.routes.ingest.DeferredObjectDownload``).
The original rides in ``submit_job``'s ``file_paths``, its PDF rendition in
``config["extraction_paths"]`` (``knowledge_layer.renditions``). Calling one
downloads to a new temp file and returns its path, which the job then owns and
deletes whether or not it owns the caller's files; a failure raises.

Every other caller (the multipart upload, the OIB sync) passes local paths, and
a path passes through untouched.

Shared by both ingestors, so it imports nothing either of them brings.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

#: The file error for an original the job could not download. A stable,
#: machine-readable prefix, like ``office_rendition_required``: the
#: failed-document UX and anyone grepping logs key on it.
ORIGINAL_DOWNLOAD_FAILED = (
    "original_download_failed: the uploaded file could not be read from storage for indexing "
    "(the link expired, the object is gone, or storage was unreachable)"
)


def is_deferred(entry: Any) -> bool:
    """Whether ``entry`` is a download the job runs rather than a local path."""
    return callable(entry)


def resolve_original(entry: str | Callable[[], str], downloaded: list[str]) -> str | None:
    """The local path of one original: as given, or what its deferred download wrote.

    A downloaded path is appended to ``downloaded``, the job's own files.
    ``None`` when the download failed; the caller fails the file with
    ``ORIGINAL_DOWNLOAD_FAILED``.
    """
    if not is_deferred(entry):
        return entry
    path = run_deferred_download(entry, "original")
    if path:
        downloaded.append(path)
    return path


def run_deferred_download(source: Callable[[], str], what: str) -> str | None:
    """Run a download the route deferred; ``None`` when it failed.

    The class and the HTTP status only: an httpx error's text carries the
    presigned URL, which is a bearer credential.
    """
    try:
        return source()
    except Exception as error:  # noqa: BLE001 — the caller decides what a missing file costs
        status = getattr(getattr(error, "response", None), "status_code", None)
        detail = f" (HTTP {status})" if isinstance(status, int) else ""
        logger.warning("Download of the %s failed: %s%s", what, type(error).__name__, detail)
        return None
