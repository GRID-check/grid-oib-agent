"""[3] Downloading the candidates. CAP: two, in parallel.

Through ``cache.fetch_document_cached``, the shared read-through cache the
reader route (``GET /v1/ris/document``) uses too — so the second turn that
needs the same law pays nothing, and neither does the second replica.

Two is the bound because a fetch is the expensive step and a building-law
question straddles at most two instruments (the Bauordnung and the technical
ordinance beside it). A candidate that was not fetched is not forgotten: it
goes to the miss message, which is what tells the model what to ask for next.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from ris_adapter.cache import fetch_document_cached
from ris_adapter.client import RisDocument
from ris_adapter.lookup.candidates import Candidate
from ris_adapter.lookup.trace import LookupTrace

logger = logging.getLogger(__name__)

#: Documents downloaded per call.
MAX_FETCHES = 2


@dataclass(frozen=True)
class FetchedDocument:
    """A candidate and the text that came back for it."""

    candidate: Candidate
    document: RisDocument


async def fetch_documents(client, candidates: list[Candidate], trace: LookupTrace) -> list[FetchedDocument]:
    """At most two documents, gathered concurrently, failures dropped not raised.

    A fetch that fails is one candidate lost, never the call: the other
    document still answers, and the miss message still names what was not read.
    """
    targets = [candidate for candidate in candidates if candidate.fetchable][:MAX_FETCHES]
    if not targets:
        return []
    results = await asyncio.gather(
        *(fetch_document_cached(client, candidate.url) for candidate in targets), return_exceptions=True
    )
    return [
        document
        for candidate, result in zip(targets, results, strict=True)
        if (document := _fetched(candidate, result, trace)) is not None
    ]


def _fetched(candidate: Candidate, result, trace: LookupTrace) -> FetchedDocument | None:
    """One gathered result as a document, or ``None`` when that fetch failed."""
    if isinstance(result, BaseException):
        logger.info("ris_lookup: fetch failed for %s (%s)", candidate.url, result)
        return None
    trace.fetched.append(candidate.url)
    return FetchedDocument(candidate=candidate, document=result)
