"""The PDF rendition a Word or presentation original is indexed from (ADR-0071).

The BFF converts these originals to ``_render.pdf`` through Gotenberg and sends
``extraction_ref`` with the ingest request; ``POST /v1/ingest`` gates the URL
and hands the job ``config["extraction_paths"]``, positional like
``original_filenames``. An entry is a local path, or a zero-argument callable
that downloads one: the route defers the download to the job because the BFF
gives the request ten seconds, and everything slow before the job id is a false
failure waiting to happen.

Shared by both ingestors, so it imports nothing either of them brings.
"""

from __future__ import annotations

import contextlib
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: The formats indexed ONLY from their rendition. Mirrors
#: ``RENDITION_INDEXED_EXTENSIONS`` in ``frontends/ui/src/lib/documents/preview-types.ts``,
#: the one place the BFF decides which dispatches carry ``extraction_ref``;
#: there is no shared schema, so a format added there without being added here
#: still works (a rendition present is always read), while one added here and
#: not there fails every upload of it. Spreadsheets with a structure of their
#: own (.xlsx/.xlsm) are absent on purpose: their sheets are read by openpyxl.
RENDITION_INDEXED_EXTENSIONS = frozenset(
    {".docx", ".docm", ".doc", ".odt", ".rtf", ".pptx", ".pptm", ".ppt", ".odp", ".xls", ".ods"}
)

#: The file error for such a format with no rendition to read. A stable,
#: machine-readable prefix, like ``vlm_not_configured``: the failed-document UX
#: and anyone grepping logs key on it.
OFFICE_RENDITION_REQUIRED = (
    "office_rendition_required: Word and presentation files are indexed from their PDF "
    "rendition, and none could be read (conversion disabled or failed, or the download failed)"
)


def requires_rendition(file_name: str, file_path: str) -> bool:
    """Whether this original is one only its rendition may be indexed from.

    The ORIGINAL name's extension first, the temp path's second, as
    ``office_extractors`` reads them.
    """
    return (Path(file_name).suffix or Path(file_path).suffix).lower() in RENDITION_INDEXED_EXTENSIONS


def align_extraction_paths(job_config: dict[str, Any], kept_indices: list[int]) -> None:
    """Filter the per-file renditions in lockstep with the files ``submit_job`` kept.

    ``extraction_paths`` is positional like ``original_filenames``: a skipped
    original must not hand its rendition to the next file. A local rendition
    whose original was skipped has no job to clean it up, so it goes here when
    the caller handed cleanup over; a deferred download that never ran left
    nothing on disk.
    """
    renditions = job_config.get("extraction_paths") or []
    job_config["extraction_paths"] = [renditions[i] if i < len(renditions) else None for i in kept_indices]
    if not job_config.get("cleanup_files"):
        return
    kept = set(kept_indices)
    for index, path in enumerate(renditions):
        if isinstance(path, str) and index not in kept:
            with contextlib.suppress(OSError):
                os.unlink(path)


def handed_rendition_paths(config: dict[str, Any]) -> list[str]:
    """The local renditions the caller handed over, for a job that owns cleanup."""
    return [path for path in config.get("extraction_paths") or [] if isinstance(path, str)]


def resolve_rendition(config: dict[str, Any], index: int, downloaded: list[str]) -> str | None:
    """The PDF rendition to extract file ``index`` from, or ``None``.

    The ingestor has no format policy here: a rendition present means "read
    the bytes from here", whatever the original's extension. A path a deferred
    download produced is appended to ``downloaded``, which the job deletes
    whether or not it owns the caller's files. A rendition that cannot be had
    (gone from disk, or its download failed) is logged and ``None``; for a
    format indexed only from its rendition the caller then fails the file with
    ``OFFICE_RENDITION_REQUIRED``.
    """
    entries = config.get("extraction_paths") or []
    entry = entries[index] if index < len(entries) else None
    if callable(entry):
        path = _run_deferred_download(entry)
        if path:
            downloaded.append(path)
        return path
    if not entry:
        return None
    if os.path.exists(entry):
        return entry
    logger.warning("Rendition for file %d is gone before extraction", index)
    return None


def _run_deferred_download(source: Callable[[], str]) -> str | None:
    """Run the download the route deferred; ``None`` when it failed.

    The class name only: an httpx error's text carries the presigned URL,
    which is a bearer credential.
    """
    try:
        return source()
    except Exception as error:  # noqa: BLE001 — the caller decides what a missing rendition costs
        logger.warning("Download of the PDF rendition failed: %s", type(error).__name__)
        return None


def delete_quietly(paths: list[str]) -> None:
    """Delete temp files this job owns; one already gone is not an error."""
    for path in paths:
        with contextlib.suppress(OSError):
            os.unlink(path)
