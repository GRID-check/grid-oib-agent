"""Read an Outlook archive for the BFF's mail import (ADR-0085).

Two internal-token routes, both handed the archive as a presigned GET URL into
object storage (the BFF staged the upload there and decided who may import it):

- ``POST /v1/mail-archive/messages``: a page of messages from a position on,
  with headers, the body as text and what each attachment is.
- ``POST /v1/mail-archive/attachment``: one attachment's bytes, raw.

Answers the BFF acts on: 422 the file is not an archive (no retry helps), 409
one attachment is damaged (skip it), 413 too large (skip it), 502 the object
store failed (retry). A damaged message comes back in the page as an
``unreadable`` item rather than as an error, so the rest of the page files.

The bytes are a second request rather than base64 inside the page because an
attachment can be a hundred megabytes, and a page of them would be a response
nobody should hold in memory twice. This tier decides nothing about access, and
it stores nothing: the archive is read where it lies.
"""

from __future__ import annotations

import asyncio
import logging
from urllib.parse import quote

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request
from fastapi import Response
from pydantic import BaseModel
from pydantic import Field

from ..mail_archive.archives import use_archive
from ..mail_archive.reader import ArchiveError
from ..mail_archive.reader import ArchiveMessage
from ..mail_archive.reader import AttachmentInfo
from ..mail_archive.reader import AttachmentTooLargeError
from ..mail_archive.reader import UnreadableItemError
from ..mail_archive.remote_file import RemoteFileError
from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)

#: The largest attachment this route hands back. The BFF's own file ceiling is
#: lower; this is the bound that protects this process if it is ever raised.
MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024


class ArchiveRef(BaseModel):
    #: The object's storage key: identifies the archive across requests.
    key: str = Field(min_length=1, max_length=1024)
    #: A presigned GET for that object, against the in-network endpoint.
    url: str = Field(min_length=1, max_length=8192)
    size: int = Field(gt=0)


class MessagesRequest(BaseModel):
    archive: ArchiveRef
    start: int = Field(ge=0)
    limit: int = Field(default=25, ge=1, le=200)


class AttachmentRequest(BaseModel):
    archive: ArchiveRef
    position: int = Field(ge=0)
    index: int = Field(ge=0)


def add_mail_archive_routes(router: APIRouter) -> None:
    """Register the archive-reading endpoints."""

    @router.post("/v1/mail-archive/messages", tags=["platform"], summary="A page of messages from an Outlook archive")
    async def messages(request: MessagesRequest, http_request: Request) -> dict:
        _require_internal_token(http_request)
        page = await _read(lambda archive: archive.page(request.start, request.limit), request.archive)
        return {
            "total": page.total,
            "next_position": page.next_position,
            "messages": [_message_json(message) for message in page.messages],
        }

    @router.post("/v1/mail-archive/attachment", tags=["platform"], summary="One attachment of an archived message")
    async def attachment(request: AttachmentRequest, http_request: Request) -> Response:
        _require_internal_token(http_request)
        info, data = await _read(
            lambda archive: archive.attachment(request.position, request.index, MAX_ATTACHMENT_BYTES), request.archive
        )
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={"x-attachment-filename": quote(info.filename, safe="")},
        )


async def _read(operation, ref: ArchiveRef):  # noqa: ANN001, ANN202 - a closure over the open archive
    """Run ``operation`` on the open archive, off the event loop, with errors as HTTP answers."""

    def run():  # noqa: ANN202
        with use_archive(ref.key, ref.url, ref.size) as archive:
            return operation(archive)

    try:
        return await asyncio.to_thread(run)
    except AttachmentTooLargeError as error:
        raise HTTPException(status_code=413, detail="The attachment is too large to import.") from error
    except UnreadableItemError as error:
        # One damaged attachment of a readable archive: the import skips the file.
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ArchiveError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except RemoteFileError as error:
        logger.warning("mail archive %s: object store read failed: %s", ref.key, error)
        raise HTTPException(status_code=502, detail="The archive could not be read from storage.") from error


def _message_json(message: ArchiveMessage) -> dict:
    base = {
        "position": message.position,
        "kind": message.kind,
        "message_class": message.message_class,
        "folder_path": list(message.folder_path),
    }
    if message.kind == "unreadable":
        return {**base, "message_class": "", "detail": message.message_class}
    if message.kind != "mail":
        return base
    return {
        **base,
        "subject": message.subject,
        "sender": _address(message.sender),
        "to": [_address(item) for item in message.to],
        "cc": [_address(item) for item in message.cc],
        "sent_at": message.sent_at.isoformat() if message.sent_at else None,
        "received_at": message.received_at.isoformat() if message.received_at else None,
        "message_id": message.message_id,
        "body": {
            "text": message.body.text if message.body else "",
            "source": message.body.source if message.body else "none",
            "truncated": bool(message.body and message.body.truncated),
        },
        "attachments": [_attachment_json(item) for item in message.attachments],
    }


def _address(address) -> dict | None:  # noqa: ANN001 - Address | None
    if address is None:
        return None
    return {"name": address.name, "address": address.address}


def _attachment_json(info: AttachmentInfo) -> dict:
    return {
        "index": info.index,
        "filename": info.filename,
        "content_type": info.content_type,
        "size": info.size,
        "inline": info.inline,
        "embedded_message": info.embedded_message,
    }
