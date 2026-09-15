"""[2] Which documents this call will consider. CAP: three.

Two sources, in this order, because one is verified and free and the other is
neither: the norm registry (``configs/norms/*/registry.yml``, ADR-0025) holds
checked pointers for the core building law, and a live OGD-RIS search planned
by ``ris_search``'s own planner covers everything else. A caller who passed an
address — a RIS URL or a document number — skips both: an address is not a
guess to be improved.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from ris_adapter.client import RisError
from ris_adapter.client import RisHit
from ris_adapter.client import build_document_url
from ris_adapter.lookup.address import Address
from ris_adapter.lookup.trace import LookupTrace
from ris_adapter.register import _CASE_LAW_SIGNALS
from ris_adapter.register import _CATALOG_AVAILABLE
from ris_adapter.register import _build_search_params
from ris_adapter.register import focus_entries
from ris_adapter.register import load_registry
from ris_adapter.register import match_entries

logger = logging.getLogger(__name__)

#: Documents considered per call. Three is one law, the adjacent one a
#: building-law question straddles, and one spare — past that the tool is
#: guessing, and a miss naming what it did not read beats a third download.
MAX_CANDIDATES = 3
#: Live-search page size, matching ``ris_search``'s configured page.
LIVE_PAGE_SIZE = 20


@dataclass(frozen=True)
class Candidate:
    """A document this call MIGHT read, with everything a citation needs."""

    title: str
    url: str = ""  # fetchable full text; empty for a reference-only entry
    citation_url: str = ""
    document_number: str = ""
    application: str = ""
    bundesland: str = ""
    origin: str = ""  # "address" | "catalog" | "live"
    version_date: str = ""
    unavailable: str = ""  # why there is no full text, stated verbatim to the model

    @property
    def fetchable(self) -> bool:
        return bool(self.url)


async def collect_candidates(client, planner, question, address: Address, trace: LookupTrace, catalog_path: str):
    """At most three documents: the address, else the catalog, else live RIS."""
    addressed = candidate_from_address(address)
    if addressed is not None:
        trace.searched = f"the address you passed ({addressed.citation_url})"
        return [addressed]
    use_catalog = not trace.application and not _CASE_LAW_SIGNALS.search(question)
    catalog = catalog_candidates(question, address, catalog_path) if use_catalog else []
    if any(candidate.fetchable for candidate in catalog):
        trace.searched = f"the curated norm catalog for {address.law or question!r}"
        return catalog[:MAX_CANDIDATES]
    live = await live_candidates(client, planner, question, address, trace)
    return (catalog + live)[:MAX_CANDIDATES]


def candidate_from_address(address: Address) -> Candidate | None:
    """The document the caller addressed directly — a RIS URL or a document number."""
    if address.url:
        return Candidate(title="", url=address.url, citation_url=address.url, origin="address")
    if not address.document_number:
        return None
    try:
        url = build_document_url(address.document_number)
    except RisError:
        return None
    return Candidate(
        title="",
        url=url,
        citation_url=url,
        document_number=address.document_number,
        origin="address",
    )


def catalog_candidates(question: str, address: Address, catalog_path: str) -> list[Candidate]:
    """Verified pointers from the norm registry, jurisdiction-filtered.

    The same two calls ``ris_search``'s catalog shortcut makes, in the same
    order: match on the topic, then drop every other state's law — a Tyrolean
    project must never be handed the Viennese Bauordnung.
    """
    if not _CATALOG_AVAILABLE:
        return []
    catalog = load_registry(catalog_path or None)
    if catalog is None:
        return []
    needle = " ".join(part for part in (address.law, question) if part)
    matches = focus_entries(match_entries(catalog, needle), address.bundesland)
    return [candidate_from_entry(entry) for entry in matches[:MAX_CANDIDATES]]


def candidate_from_entry(entry) -> Candidate:
    """One norm-registry entry as a candidate, unavailability stated verbatim.

    The two "Not in RIS" sentences are the catalog's own
    (``register._format_catalog_entry``): a norm that exists with no reachable
    full text is a fact the answer must state, not a silent gap.
    """
    unavailable = ""
    if not entry.is_ris:
        unavailable = (
            f"Not in RIS - web source: {entry.source_url}"
            if entry.source_url
            else "Not in RIS - no accessible full text (reference only, say so openly)"
        )
    return Candidate(
        title=entry.title,
        url=(entry.full_law_url or entry.citation_url) if entry.is_ris else "",
        citation_url=entry.citation_url or entry.source_url,
        document_number=entry.document_number,
        application=entry.application,
        bundesland=entry.bundesland,
        origin="catalog",
        unavailable=unavailable,
    )


def candidate_from_hit(hit: RisHit) -> Candidate:
    """One live RIS hit as a candidate.

    ``full_law_url`` beats the single-paragraph document URL: the extractor
    works on §§ and the consolidated law is the document that HAS them. Case
    law has no full-law URL and falls back to its own text.
    """
    return Candidate(
        title=hit.title,
        url=hit.full_law_url or hit.fetch_url,
        citation_url=hit.citation_url or hit.fetch_url,
        document_number=hit.document_number,
        application=hit.application,
        bundesland=hit.metadata.get("Bundesland", ""),
        origin="live",
        version_date=hit.metadata.get("In Kraft seit", ""),
    )


async def live_candidates(client, planner, question, address: Address, trace: LookupTrace) -> list[Candidate]:
    """A live OGD-RIS search, planned by the same LLM ``ris_search`` uses."""
    plan = await search_plan(planner, question, address, trace)
    try:
        params = _build_search_params(plan["application"], plan["query"], plan["title"], plan["bundesland"], "", "")
        result = await client.search(application=plan["application"], params=params, page=1, page_size=LIVE_PAGE_SIZE)
    except RisError as exc:
        logger.info("ris_lookup: live RIS search failed (%s)", exc)
        return []
    except Exception:  # a tool must always hand the agent a string, so a miss it is
        logger.exception("ris_lookup: live RIS search failed")
        return []
    return [candidate_from_hit(hit) for hit in result.hits[:MAX_CANDIDATES]]


async def search_plan(planner, question: str, address: Address, trace: LookupTrace) -> dict:
    """The effective search parameters, planned when a planner is configured."""
    effective = {
        "application": trace.application or ("LrKons" if address.bundesland else "BrKons"),
        "query": question,
        "title": address.law,
        "bundesland": address.bundesland,
    }
    if planner is not None:
        effective = await _planned(planner, effective, address)
    trace.searched = repr(effective["query"])
    trace.application = effective["application"]
    return effective


async def _planned(planner, effective: dict, address: Address) -> dict:
    """Run the planner; the caller's arguments survive a planner failure."""
    try:
        plan = await planner(
            effective["query"], effective["application"], effective["title"], effective["bundesland"], "", ""
        )
    except Exception:  # noqa: BLE001 — same fail-open as ris_search's planner
        logger.warning("ris_lookup: planner failed, using the caller's words", exc_info=True)
        return effective
    if plan is None or not plan.suchworte.strip():
        return effective
    return {
        "application": plan.application,
        "query": plan.suchworte,
        "title": plan.titel,
        # The caller's / project's Bundesland outranks the planner's guess: it
        # is a request FACT, and a planner that drops it hands a Tyrolean
        # project Viennese law.
        "bundesland": address.bundesland or plan.bundesland,
    }
