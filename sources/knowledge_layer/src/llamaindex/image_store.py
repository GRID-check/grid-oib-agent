"""Storing the rasters the ingest pipeline cuts out of a PDF.

``_extract_images_from_pdf`` pulls every image XObject out of a PDF, the VLM
captions each, and until now the bytes were dropped once the caption was
indexed. That left ``view_knowledge_image`` one option for an embedded photo
or scanned drawing: render the whole page, at page resolution, with the text
around it. This module keeps the raster itself, beside the document, so the
tool can hand the model the image at the resolution it was captioned at.

The backend holds a read-only object-store credential (ADR-0039), so it
cannot write the raster itself. It asks the BFF for one presigned PUT per
image (``POST /api/internal/document-image-upload-url``, service-token
guarded) — the thumbnail pattern, per image instead of per document, because
how many rasters a PDF holds is unknown until extraction has run and most
hold none. The BFF builds the key from the document's own storage key
(``<doc dir>/_img/<index>.jpg``) and refuses an index past its per-document
ceiling with a 404, which this module reads as "stop asking".

The presigned URL is trusted as it comes: it is the BFF's answer over the
token-authenticated internal channel, not a field of a request a user token
can reach (the SSRF allowlist on ``/v1/ingest`` exists because that route is
reachable through the user proxy). It is never logged, not even truncated —
it is a live bearer credential to the object.

Fail-open, bounded: any failure keeps the caption and stops storing for the
rest of that file. A dead BFF costs one timeout per document, not one per
image, and the chunk simply carries no ``image_key``.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

_FRONTEND_INTERNAL_URL_ENV = "FRONTEND_INTERNAL_URL"
_INTERNAL_TOKEN_ENV = "GRID_INTERNAL_API_TOKEN"
_PRESIGN_PATH = "/api/internal/document-image-upload-url"
_HTTP_TIMEOUT_SECONDS = 15.0

#: ``(document_id, collection, image_index, organization_id) -> (upload_url, storage_key)``,
#: or ``None`` when no slot is available (unknown document, ceiling reached,
#: BFF unreachable).
Presigner = Callable[[str, str, int, str | None], tuple[str, str] | None]
#: ``(upload_url, image_bytes)``; raises on any failure.
Uploader = Callable[[str, bytes], None]


def request_upload_slot(
    document_id: str, collection: str, image_index: int, organization_id: str | None = None
) -> tuple[str, str] | None:
    """Ask the BFF for a presigned PUT for one raster; ``None`` on any failure.

    A 404 is the BFF saying the document is unknown or the index is past
    ``MAX_STORED_IMAGES_PER_DOCUMENT`` (``frontends/ui/src/lib/s3.ts``) —
    both mean there is nothing more to store for this document.
    """
    base_url = os.environ.get(_FRONTEND_INTERNAL_URL_ENV, "").strip()
    token = os.environ.get(_INTERNAL_TOKEN_ENV, "").strip()
    if not base_url or not token:
        return None
    try:
        import httpx

        body: dict[str, Any] = {"documentId": document_id, "collection": collection, "imageIndex": image_index}
        if organization_id:
            body["organizationId"] = organization_id
        response = httpx.post(
            f"{base_url.rstrip('/')}{_PRESIGN_PATH}",
            json=body,
            headers={"x-grid-internal-token": token},
            timeout=_HTTP_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            logger.info(
                "image_store: no upload slot for image %d of document %s (HTTP %d)",
                image_index,
                document_id,
                response.status_code,
            )
            return None
        data = response.json()
        upload_url = data.get("uploadUrl")
        storage_key = data.get("storageKey")
        if not isinstance(upload_url, str) or not upload_url or not isinstance(storage_key, str) or not storage_key:
            return None
        return upload_url, storage_key
    except Exception as e:  # noqa: BLE001 - fail-open contract
        # Class name only: an httpx error's text embeds the request URL.
        logger.warning("image_store: presign request failed for document %s: %s", document_id, type(e).__name__)
        return None


def put_raster(upload_url: str, image_bytes: bytes) -> None:
    """PUT one raster to its presigned slot. Raises on any failure."""
    import httpx

    response = httpx.put(
        upload_url,
        content=image_bytes,
        headers={"Content-Type": "image/jpeg"},
        timeout=_HTTP_TIMEOUT_SECONDS,
    )
    response.raise_for_status()


def store_extracted_images(
    image_results: list[tuple[dict[str, Any], str, str]],
    *,
    document_id: str,
    collection: str,
    organization_id: str | None = None,
    presign: Presigner | None = None,
    upload: Uploader | None = None,
) -> int:
    """Store each extracted raster beside its document; returns how many landed.

    ``image_results`` is ``enrich_vlm_batch``'s output: ``(record, content_type,
    caption)`` with the JPEG bytes in ``record["image_bytes"]``. A record that
    was stored gains ``image_key`` (the object's storage key) and
    ``stored_image_index`` (the index the key was built from); the adapter
    copies both onto the caption chunk's metadata, and the hit renderer shows
    an ``Image:`` line only when they are present.

    Records are visited in document order (page, then position on the page)
    so the index a re-ingest assigns to a raster is the same one it got last
    time, and the re-ingest overwrites in place. Stops at the first failure —
    see the module docstring for why.
    """
    # Resolved at call time, not bound as defaults, so a test (or a future
    # alternative transport) can replace the module functions.
    presign = presign or request_upload_slot
    upload = upload or put_raster
    ordered = sorted(image_results, key=lambda item: (item[0].get("page_number", 0), item[0].get("image_index", 0)))
    stored = 0
    for index, (record, _content_type, _caption) in enumerate(ordered):
        image_bytes = record.get("image_bytes")
        if not image_bytes:
            continue
        slot = presign(document_id, collection, index, organization_id)
        if slot is None:
            break
        upload_url, storage_key = slot
        try:
            upload(upload_url, image_bytes)
        except Exception as e:  # noqa: BLE001 - fail-open contract
            # Class name only: the exception text of a failed PUT renders the
            # presigned URL, a live bearer credential to the object.
            logger.warning(
                "image_store: upload of image %d for document %s failed (%s); keeping captions only",
                index,
                document_id,
                type(e).__name__,
            )
            break
        record["image_key"] = storage_key
        record["stored_image_index"] = index
        stored += 1
    if stored:
        logger.info("image_store: stored %d/%d raster(s) for document %s", stored, len(ordered), document_id)
    return stored
