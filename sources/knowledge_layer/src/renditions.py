"""The PDF rendition a Word or presentation original is indexed from (ADR-0071).

The BFF converts these originals to ``_render.pdf`` through Gotenberg and sends
``extraction_ref`` with the ingest request; ``POST /v1/ingest`` gates the URL
and hands the job ``config["extraction_paths"]``, positional like
``original_filenames``. An entry is a local path, or a zero-argument callable
that downloads one: the route defers every download to the job, the original's
too (``knowledge_layer.deferred_files``), because the BFF gives the request ten
seconds, and everything slow before the job id is a false failure waiting to
happen.

Shared by both ingestors, so it imports nothing either of them brings.
"""

from __future__ import annotations

import contextlib
import logging
import os
from pathlib import Path
from typing import Any

from knowledge_layer.deferred_files import is_deferred
from knowledge_layer.deferred_files import run_deferred_download

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


#: The per-file rendition lists a job config may carry, positional like
#: ``original_filenames``: the one a document is READ from (``extraction_paths``,
#: ADR-0071) and the one only its thumbnail is drawn from (``preview_paths``, an
#: office original indexed from its own bytes, a spreadsheet).
RENDITION_CONFIG_LISTS = ("extraction_paths", "preview_paths")


def align_extraction_paths(job_config: dict[str, Any], kept_indices: list[int]) -> None:
    """Filter the per-file renditions in lockstep with the files ``submit_job`` kept.

    Both lists are positional like ``original_filenames``: a skipped original
    must not hand its rendition to the next file. A local rendition whose
    original was skipped has no job to clean it up, so it goes here when the
    caller handed cleanup over; a deferred download that never ran left
    nothing on disk.
    """
    for key in RENDITION_CONFIG_LISTS:
        if key in job_config:
            _align(job_config, key, kept_indices)


def _align(job_config: dict[str, Any], key: str, kept_indices: list[int]) -> None:
    renditions = job_config.get(key) or []
    job_config[key] = [renditions[i] if i < len(renditions) else None for i in kept_indices]
    if not job_config.get("cleanup_files"):
        return
    kept = set(kept_indices)
    for index, path in enumerate(renditions):
        if isinstance(path, str) and index not in kept:
            with contextlib.suppress(OSError):
                os.unlink(path)


def handed_rendition_paths(config: dict[str, Any]) -> list[str]:
    """The local renditions the caller handed over, for a job that owns cleanup."""
    return [path for key in RENDITION_CONFIG_LISTS for path in config.get(key) or [] if isinstance(path, str)]


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
    return _resolve(config, "extraction_paths", index, downloaded)


def resolve_preview(config: dict[str, Any], index: int, downloaded: list[str]) -> str | None:
    """The PDF rendition file ``index``'s thumbnail is drawn from, or ``None``.

    Sent for an office original indexed from its own bytes (a spreadsheet),
    whose pages the job cannot rasterise. Downloaded only once the file's
    screening has passed (ADR-0086): the route used to draw it in the request,
    before the job had read a word of the file.
    """
    return _resolve(config, "preview_paths", index, downloaded)


def _resolve(config: dict[str, Any], key: str, index: int, downloaded: list[str]) -> str | None:
    entries = config.get(key) or []
    entry = entries[index] if index < len(entries) else None
    if is_deferred(entry):
        path = run_deferred_download(entry, "PDF rendition")
        if path:
            downloaded.append(path)
        return path
    if not entry:
        return None
    if os.path.exists(entry):
        return entry
    logger.warning("Rendition for file %d is gone before extraction", index)
    return None


def delete_quietly(paths: list[str]) -> None:
    """Delete temp files this job owns; one already gone is not an error."""
    for path in paths:
        with contextlib.suppress(OSError):
            os.unlink(path)
