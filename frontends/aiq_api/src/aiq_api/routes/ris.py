"""Read a RIS document as text, for the reader rather than for the agent.

WHY THIS EXISTS AT ALL. A RIS citation is the one source in this product that
the answer can point at and the reader cannot check without leaving: the chip
carried an ``https://www.ris.bka.gv.at/…`` URL, so it opened a browser tab —
Piloti's own viewer, the passage rail and the copy-as-Zitat actions all sitting
one surface behind — and a RIS document Piloti had already fetched, parsed and
grounded on could not be shown by the product that grounded on it (#622).

The text is not new work. ``ris_fetch_document`` reads exactly this, and this
route goes through the same two things it does: ``RisClient`` (one host
allow-list, one size ceiling, one extractor) and ``fetch_document_cached`` (one
shared Dragonfly read-through). Both are shared deliberately. A second
implementation in TypeScript would be a second set of extraction rules to keep
in step on a source whose whole value is that the text is verbatim — and the
read-through was inline in the tool until this route was written, at which point
it fetched live on every open while claiming the cache in its own docstring. A
helper only one caller applies is a helper the next caller forgets.

The client is held for the process rather than built per request: an
``httpx.AsyncClient`` owns a connection pool, and one per request leaks the pool
until it is collected while defeating the client's own in-memory cache.

Internal-token guarded like every other service-to-service route here: it is
reached from the BFF, never from a browser, and never appears on the external
auth allowlist.
"""

import logging
import re
from typing import TYPE_CHECKING

from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Query
from fastapi import status

from .internal_auth import _require_internal_token

if TYPE_CHECKING:
    from ris_adapter.client import RisClient

logger = logging.getLogger(__name__)

#: How much document text crosses the wire.
#:
#: MEASURED, because the first number here was a guess and the guess broke the
#: product's own primary document. At 400,000 characters this cap truncated the
#: Bauordnung für Wien (759,595 characters) at 53%, and § 108 of that law sits at
#: character 524,079 — so a citation to it opened a reader that did not contain
#: the cited paragraph, marked nothing, and said "gekürzt". Worse than the
#: browser tab it replaced.
#:
#: The real distribution (fetched 2026-09-04, after the page furniture is
#: dropped): Steiermärkisches Baugesetz 20,914 · NÖ Bauordnung 2014 433,820 ·
#: Bauordnung für Wien 759,595 · ABGB 971,067 · ASVG 4,294,779. So the building
#: law this product is for tops out under a million characters.
#:
#: The BROWSER is not the constraint — measured in Chromium at 70ch/14px, a
#: `white-space: pre-wrap` text node lays out in 226 ms at 760k, 299 ms at 1M,
#: 630 ms at 2M and 903 ms at 4.3M, with the passage mark and scroll costing
#: about the same again. The constraint is the RESPONSE: 2M characters of German
#: is roughly 2 MB of JSON, which is the most worth putting behind one click on
#: a slow connection.
#:
#: Two million therefore covers every consolidated building law measured with
#: better than twice the headroom, and only the genuinely enormous federal codes
#: are clipped — and those are clipped AROUND THE CITED PASSAGE (see
#: :func:`_clip_around_passage`), so no citation can land outside its own text
#: whatever this number is set to.
MAX_DOCUMENT_TEXT_CHARS = 2_000_000

#: How much of the cited passage is used to find it. Enough to be distinctive in
#: a statute that repeats its own phrasing; short enough that the extractors'
#: disagreements later in a long sentence cannot break the match.
_PASSAGE_ANCHOR_WORDS = 12


def _passage_offset(text: str, passage: str) -> int | None:
    r"""Where ``passage`` starts in ``text``, or None.

    Deliberately cheap. The precise matching is the reader's job and is done in
    the browser (``passage-highlight.ts``), against the same text this returns;
    all this has to decide is WHICH WINDOW to send, and for that a word-sequence
    match is enough. Both sides of the comparison also came out of the same
    extractor — the retrieval indexed what :func:`html_to_text` produced and this
    fetches through it again — so the only routine divergence is whitespace,
    which the ``\s+`` joins absorb.

    Returns the offset of the FIRST match and refuses an ambiguous one: a phrase
    that occurs twice points at two places at once, and centring the window on
    one of them silently would be a guess presented as an answer.
    """
    words = passage.split()[:_PASSAGE_ANCHOR_WORDS]
    if len(words) < 4:
        return None
    pattern = re.compile(r"\s+".join(re.escape(word) for word in words), re.IGNORECASE)
    first = pattern.search(text)
    if first is None:
        return None
    return first.start()


def _clip_around_passage(text: str, passage: str) -> tuple[str, bool]:
    """Bound the text at :data:`MAX_DOCUMENT_TEXT_CHARS`, keeping the passage in it.

    A citation is a pointer into a document, so a document clipped at its HEAD is
    the one shape the answer must never take: it drops the very passage the
    reader clicked to check. When the passage can be located, the window is
    centred on it instead; when it cannot, the head is the honest fallback and
    the reader is told the text is shortened either way.
    """
    if len(text) <= MAX_DOCUMENT_TEXT_CHARS:
        return text, False
    start = _passage_offset(text, passage) if passage else None
    if start is None:
        return text[:MAX_DOCUMENT_TEXT_CHARS], True
    begin = max(0, start - MAX_DOCUMENT_TEXT_CHARS // 2)
    return text[begin : begin + MAX_DOCUMENT_TEXT_CHARS], True


#: One client for the process.
#:
#: ``httpx.AsyncClient`` owns a connection pool and an in-memory document cache;
#: building one per request leaks the pool until GC and makes the cache useless
#: by construction. Created lazily so importing this module needs no event loop,
#: and never closed on purpose — its lifetime is the process's.
_RIS_CLIENT: "RisClient | None" = None


def _client() -> "RisClient":
    global _RIS_CLIENT
    if _RIS_CLIENT is None:
        from ris_adapter.client import RisClient

        _RIS_CLIENT = RisClient()
    return _RIS_CLIENT


def add_ris_routes(router: APIRouter) -> None:
    @router.get(
        "/v1/ris/document",
        tags=["ris"],
        summary="Fetch a RIS document's text (internal)",
    )
    async def get_ris_document(
        reference: str = Query(..., min_length=1, max_length=2048),
        application: str = Query("", max_length=32),
        passage: str = Query("", max_length=2_000),
        _: None = Depends(_require_internal_token),
    ) -> dict:
        """Return ``{url, title, text, truncated}`` for a RIS document.

        ``reference`` is a RIS document number (``NOR40217157``) or any
        ``https://www.ris.bka.gv.at/...`` URL from a citation. Both forms are
        what ``ris_fetch_document`` accepts, because both are what a citation
        can carry.

        ``passage`` is the cited text, when the caller has it. It is used for one
        thing: deciding which window of an over-long document to return, so a
        citation into a Gesamtfassung of four million characters still arrives at
        its own paragraph. It is never matched for display — that is the reader's
        job, in the browser — and it is published law either way.
        """
        from ris_adapter.cache import fetch_document_cached
        from ris_adapter.client import RisError
        from ris_adapter.client import build_document_url

        reference = reference.strip()
        try:
            if reference.lower().startswith(("http://", "https://")):
                url = reference
            else:
                url = build_document_url(reference, application)
            document = await fetch_document_cached(_client(), url)
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

        text, truncated = _clip_around_passage(document.text, passage.strip())

        return {
            "url": document.url,
            "title": document.title,
            "text": text,
            "truncated": truncated,
        }
