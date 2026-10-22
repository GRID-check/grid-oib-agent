"""Read one inbound mail for the BFF: ``POST /v1/mail/read``.

The BFF's receive job stages a mail sent to a project's address as ``raw.eml``
in object storage and hands this route a presigned GET for it. The answer is a
:class:`~aiq_api.mail.models.MailRead`: the body as the sender's own text, the
blocks they quoted, and the calendar invitations it carried. The BFF stages it
as ``read.json`` beside the raw message, and nothing is filed until a person
decides (DECISION D12, §6).

The route is internal-token only, a dependency so a caller without the token
gets 403 before its body is looked at. ``file_ref`` is an
:data:`~aiq_api.object_store_url.ObjectStoreUrl`: a URL naming anything but the
object store is refused with 422 before a byte is requested. The fetch itself
follows no redirect and stops reading past the message cap.

Answers the BFF acts on: 200 with a ``MailRead`` whatever the bytes are (a part
past a cap, a parser failure or the deadline is ``unreadable`` in the body, not
an error, so a mail is never lost to a parser); 502 when the object store did
not hand over the message (retry); 422 for a URL that is not the store's (no
retry helps). No model is called, nothing is stored, and no log line carries
the URL (a bearer credential) or a byte of the message.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from pydantic import BaseModel
from pydantic import ConfigDict

from ..mail import limits
from ..mail.models import MailRead
from ..mail.models import UnreadableReason
from ..mail.read import read_message_within
from ..object_store_url import ObjectStoreUrl
from ..object_store_url import object_store_request_url
from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)


class MailReadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: A presigned GET for the staged raw message, against the in-network endpoint.
    file_ref: ObjectStoreUrl


class MessageTooLargeError(Exception):
    """The stored message is larger than :data:`~aiq_api.mail.limits.MAX_MESSAGE_BYTES`."""


def add_mail_routes(router: APIRouter) -> None:
    """Register the inbound-mail reading endpoint."""

    @router.post(
        "/v1/mail/read",
        tags=["platform"],
        summary="What one raw mail message says: own text, quoted blocks, calendar",
        dependencies=[Depends(_require_internal_token)],
    )
    async def read_mail(request: MailReadRequest) -> MailRead:
        try:
            raw = await fetch_message(object_store_request_url(request.file_ref, field="file_ref"))
        except MessageTooLargeError:
            return MailRead.unread(UnreadableReason.MESSAGE_TOO_LARGE)
        except httpx.HTTPError as error:
            logger.warning("mail read: object store fetch failed: %s", type(error).__name__)
            raise HTTPException(status_code=502, detail="The message could not be read from storage.") from error
        return await read_message_within(raw)


async def fetch_message(url: str, transport: httpx.AsyncBaseTransport | None = None) -> bytes:
    """The object at ``url``, at most the message cap; :class:`MessageTooLargeError` past it.

    In-network: no proxy from the environment and no redirect, so the request
    goes to the origin the gate checked and nowhere else. ``transport`` is for tests.
    """
    timeout = httpx.Timeout(limits.FETCH_TIMEOUT_SECONDS, connect=10.0)
    async with (
        httpx.AsyncClient(timeout=timeout, trust_env=False, follow_redirects=False, transport=transport) as client,
        client.stream("GET", url) as response,
    ):
        response.raise_for_status()
        declared = response.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limits.MAX_MESSAGE_BYTES:
            raise MessageTooLargeError
        chunks: list[bytes] = []
        size = 0
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > limits.MAX_MESSAGE_BYTES:
                raise MessageTooLargeError
            chunks.append(chunk)
    return b"".join(chunks)
