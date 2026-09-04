"""Read a RIS document as text, for the reader rather than for the agent.

WHY THIS EXISTS AT ALL. A RIS citation is the one source in this product that
the answer can point at and the reader cannot check without leaving: the chip
carried an ``https://www.ris.bka.gv.at/…`` URL, so it opened a browser tab —
Piloti's own viewer, the passage rail and the copy-as-Zitat actions all sitting
one surface behind — and a RIS document Piloti had already fetched, parsed and
grounded on could not be shown by the product that grounded on it (#622).

The text is not new work. ``ris_fetch_document`` reads exactly this, through
exactly this client, with the same host allow-list, the same size ceiling and
the same shared cache — the tool simply had no way to hand what it read to the
frontend. This route is that way, and it deliberately reuses ``RisClient``
rather than reimplementing the fetch in the BFF: the extraction rules (which
hosts, which content types, what counts as a title) are the agent's, and a
second implementation in TypeScript is a second set of rules to keep in step.

Internal-token guarded like every other service-to-service route here: it is
reached from the BFF, never from a browser, and never appears on the external
auth allowlist.
"""

import logging

from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Query
from fastapi import status

from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)

#: How much document text crosses the wire.
#:
#: A reader checking a citation reads a paragraph, not a Gesamtfassung — and a
#: consolidated Bauordnung is megabytes. The client already refuses anything
#: over its own transport ceiling; this is the smaller, reader-facing bound, and
#: the response says when it applied so the viewer can print "gekürzt" rather
#: than ending mid-sentence with nothing said.
MAX_DOCUMENT_TEXT_CHARS = 400_000


def add_ris_routes(router: APIRouter) -> None:
    @router.get(
        "/v1/ris/document",
        tags=["ris"],
        summary="Fetch a RIS document's text (internal)",
    )
    async def get_ris_document(
        reference: str = Query(..., min_length=1, max_length=2048),
        application: str = Query("", max_length=32),
        _: None = Depends(_require_internal_token),
    ) -> dict:
        """Return ``{url, title, text, truncated}`` for a RIS document.

        ``reference`` is a RIS document number (``NOR40217157``) or any
        ``https://www.ris.bka.gv.at/...`` URL from a citation. Both forms are
        what ``ris_fetch_document`` accepts, because both are what a citation
        can carry.
        """
        from ris_adapter.client import RisClient
        from ris_adapter.client import RisError
        from ris_adapter.client import build_document_url

        reference = reference.strip()
        try:
            if reference.lower().startswith(("http://", "https://")):
                url = reference
            else:
                url = build_document_url(reference, application)
            document = await RisClient().fetch_document_text(url)
        except RisError as exc:
            # The client's refusals are all statements about the REQUEST — a
            # non-RIS host, a PDF-only document, a reference that is neither a
            # number nor a URL — so they are the caller's to fix and a 400 says
            # so. A 502 here would send the BFF looking for an outage.
            logger.info("ris document fetch refused: %s", exc)
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("ris document fetch failed")
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="RIS is not reachable right now",
            ) from exc

        text = document.text
        truncated = len(text) > MAX_DOCUMENT_TEXT_CHARS
        if truncated:
            text = text[:MAX_DOCUMENT_TEXT_CHARS]

        return {
            "url": document.url,
            "title": document.title,
            "text": text,
            "truncated": truncated,
        }
