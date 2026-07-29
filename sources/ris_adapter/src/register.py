"""NAT tools for the Austrian RIS (Rechtsinformationssystem des Bundes).

Two tools built on the OGD-RIS API:

- ``ris_search``          — search Austrian federal law, state law, and case
  law; returns document references with citation URLs. Optionally refines the
  query through a planner LLM using strict structured outputs
  (``response_format: json_schema``, OpenRouter-compatible) so search
  parameters are always schema-valid.
- ``ris_fetch_document``  — fetch an ENTIRE document (law paragraph, full
  consolidated law, court decision) on demand, return its text to the agent,
  and (optionally) ingest it into the session knowledge collection so the
  knowledge layer can retrieve and cite it afterwards.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import tempfile
from datetime import UTC
from datetime import datetime
from typing import Literal
from urllib.parse import parse_qs
from urllib.parse import urlparse

from langchain_core.exceptions import OutputParserException
from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError
from ris_adapter.cache import cache_get_json
from ris_adapter.cache import cache_set_json
from ris_adapter.cache import doc_cache_key
from ris_adapter.cache import ingested_marker_key
from ris_adapter.cache import ris_cache_ttl_seconds
from ris_adapter.cache import search_cache_key
from ris_adapter.client import CONTROLLER_FOR_APPLICATION
from ris_adapter.client import DEFAULT_BASE_URL
from ris_adapter.client import PAGE_SIZES
from ris_adapter.client import RisClient
from ris_adapter.client import RisDocument
from ris_adapter.client import RisError
from ris_adapter.client import RisHit
from ris_adapter.client import build_document_url

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig

try:
    from aiq_agent.common.norm_registry import NormEntry
    from aiq_agent.common.norm_registry import extract_bundesland
    from aiq_agent.common.norm_registry import focus_entries
    from aiq_agent.common.norm_registry import load_registry
    from aiq_agent.common.norm_registry import match_entries

    _CATALOG_AVAILABLE = True
except ImportError:  # adapter used standalone, without the Grid agent package
    NormEntry = None  # type: ignore[assignment]
    extract_bundesland = None  # type: ignore[assignment]
    focus_entries = None  # type: ignore[assignment]
    load_registry = None  # type: ignore[assignment]
    match_entries = None  # type: ignore[assignment]
    _CATALOG_AVAILABLE = False

logger = logging.getLogger(__name__)

# Austrian federal states accepted by the Landesrecht (LrKons) filter.
_BUNDESLAND_PARAMS: dict[str, str] = {
    "burgenland": "Bundesland.SucheInBurgenland",
    "kaernten": "Bundesland.SucheInKaernten",
    "niederoesterreich": "Bundesland.SucheInNiederoesterreich",
    "oberoesterreich": "Bundesland.SucheInOberoesterreich",
    "salzburg": "Bundesland.SucheInSalzburg",
    "steiermark": "Bundesland.SucheInSteiermark",
    "tirol": "Bundesland.SucheInTirol",
    "vorarlberg": "Bundesland.SucheInVorarlberg",
    "wien": "Bundesland.SucheInWien",
}

_JUDIKATUR_APPLICATIONS = frozenset(
    app for app, controller in CONTROLLER_FOR_APPLICATION.items() if controller == "Judikatur"
)

# Applications serving consolidated (legally non-binding, informational) texts.
_KONSOLIDIERT_APPLICATIONS = frozenset({"BrKons", "LrKons"})

_KONSOLIDIERT_NOTE = (
    "Legal status: konsolidierte Fassung (consolidated version) — informational, not legally "
    "binding. The authentic text is the promulgation in the Bundesgesetzblatt/Landesgesetzblatt "
    "(applications BgblAuth/LgblAuth)."
)

_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")

_CASE_LAW_SIGNALS = re.compile(
    r"(vwgh|vfgh|judikatur|erkenntnis|entscheidung|geschäftszahl|geschaeftszahl|beschluss|urteil)",
    re.IGNORECASE,
)


def _normalize_bundesland(value: str) -> str:
    """Map a user-supplied state name to the API filter key (empty if unknown)."""
    normalized = (
        value.strip()
        .lower()
        .replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
        .replace("ß", "ss")
        .replace(" ", "")
        .replace("-", "")
    )
    return _BUNDESLAND_PARAMS.get(normalized, "")


def _build_search_params(
    application: str,
    query: str,
    title: str,
    bundesland: str,
    date_from: str,
    date_to: str,
) -> dict[str, str]:
    """Translate the tool arguments into OGD-RIS query parameters."""
    params: dict[str, str] = {}
    if query:
        params["Suchworte"] = query
    if title:
        params["Titel"] = title

    if bundesland and application in ("LrKons", "Lgbl", "LgblAuth", "Vbl"):
        key = _normalize_bundesland(bundesland)
        if key:
            params[key] = "true"

    for value, name in ((date_from, "date_from"), (date_to, "date_to")):
        if value and not _DATE_RE.fullmatch(value.strip()):
            raise RisError(f"{name} must use the YYYY-MM-DD format, got '{value}'")

    if application in _JUDIKATUR_APPLICATIONS:
        if date_from:
            params["EntscheidungsdatumVon"] = date_from.strip()
        if date_to:
            params["EntscheidungsdatumBis"] = date_to.strip()
    elif application == "BgblAuth":
        if date_from:
            params["Kundmachung.Von"] = date_from.strip()
        if date_to:
            params["Kundmachung.Bis"] = date_to.strip()
    elif application == "BrKons" and date_from:
        # Query the consolidated version in force at the given date.
        params["Fassung.FassungVom"] = date_from.strip()

    return params


# ---------------------------------------------------------------------------
# Search planning via strict structured outputs
# ---------------------------------------------------------------------------


class RisSearchPlan(BaseModel):
    """Structured RIS search plan.

    Requested from the planner LLM with ``response_format: json_schema`` +
    ``strict: true`` (OpenRouter structured outputs). Not every OpenRouter-served
    model honors strict schema mode, so a garbled JSON payload can still reach the
    parser and raise ``ValidationError``; ``_make_planner`` guards that with a
    bounded corrective retry. The enum constraints reject an invalid application
    or Bundesland whenever the payload does parse.
    """

    application: Literal[
        "BrKons",
        "LrKons",
        "BgblAuth",
        "LgblAuth",
        "Begut",
        "RegV",
        "Vfgh",
        "Vwgh",
        "Justiz",
        "Bvwg",
        "Lvwg",
        "Dsk",
        "Erlaesse",
    ] = Field(description="RIS application to search")
    suchworte: str = Field(description="German full-text search terms (precise legal terminology)")
    titel: str = Field(default="", description="Optional filter on the norm/decision title, empty if unused")
    bundesland: Literal[
        "",
        "Burgenland",
        "Kärnten",
        "Niederösterreich",
        "Oberösterreich",
        "Salzburg",
        "Steiermark",
        "Tirol",
        "Vorarlberg",
        "Wien",
    ] = Field(default="", description="State filter for Landesrecht searches, empty if not state-specific")
    date_from: str = Field(default="", description="YYYY-MM-DD or empty")
    date_to: str = Field(default="", description="YYYY-MM-DD or empty")
    reasoning: str = Field(default="", description="One short sentence: why this application and these terms")


_PLANNER_SYSTEM_PROMPT = """You translate a legal research request into search parameters \
for the Austrian RIS (Rechtsinformationssystem des Bundes).

Application selection rules:
- BrKons: consolidated FEDERAL law (Bundesgesetze, Verordnungen des Bundes).
- LrKons: consolidated STATE law — Bauordnungen, Bautechnikgesetze, Garagengesetze and all other \
Landesgesetze live here; ALWAYS set `bundesland` for building-law questions.
- BgblAuth / LgblAuth: authentic gazettes — only when the user needs the legally binding promulgation.
- Begut / RegV: draft bills and government bills (legislation in progress).
- Vfgh / Vwgh / Justiz / Bvwg / Lvwg / Dsk: case law (constitutional, administrative, civil/criminal, \
federal administrative court, state administrative courts, data protection).
- Erlaesse: federal ministry decrees.

Search term rules:
- `suchworte` must be German legal terminology; strip filler words. Prefer the statutory term \
(e.g. "Stellplatzverpflichtung" not "Parkplätze vorgeschrieben").
- Use `titel` only when the user names a specific law ("Bauordnung für Wien", "Garagengesetz").
- Dates only when the request clearly constrains time (decision periods, version in force at a date).
- Keep `reasoning` to one short sentence."""


def _apply_org_llm_policy(llm):
    """Apply the platform's per-request LLM policy to the planner model.

    Mirrors how other auxiliary LLM calls (e.g. memory reflection) integrate:
    the org's runtime model override for the DEEP_RESEARCH_ROUTER agent group
    (the planner is the same kind of lightweight routing/planning task) and
    the org's BYOK credential (ADR-0022) are applied per call. Both wrappers
    fail open to the YAML-configured model, and this import degrades
    gracefully when the adapter is used outside the Grid agent.
    """
    try:
        from aiq_agent.common import apply_model_override
        from aiq_agent.common import apply_org_credential
        from aiq_agent.common.model_overrides import AgentGroup

        return apply_org_credential(apply_model_override(llm, AgentGroup.DEEP_RESEARCH_ROUTER))
    except ImportError:
        return llm
    except Exception:
        logger.warning("ris_search: could not apply org LLM policy to the planner", exc_info=True)
        return llm


def _make_planner(llm):
    """Wrap a LangChain chat model into a RIS search planner using structured outputs.

    ``method="json_schema"`` emits ``response_format: {type: json_schema, strict: true}`` —
    the OpenRouter structured-outputs wire format. Not every OpenRouter-served model
    honors ``strict: true``, so ``_plan`` performs one bounded corrective retry on a
    parse/validation failure before letting the error surface to the caller's fail-open.
    """

    async def _plan(query: str, application: str, title: str, bundesland: str, date_from: str, date_to: str):
        # Resolve overrides/credentials per call: they are request-scoped (headers).
        structured = _apply_org_llm_policy(llm).with_structured_output(RisSearchPlan, method="json_schema", strict=True)
        request = (
            f"Research request: {query}\n"
            f"Caller suggestion — application: {application or '(none)'}, title: {title or '(none)'}, "
            f"bundesland: {bundesland or '(none)'}, date_from: {date_from or '(none)'}, "
            f"date_to: {date_to or '(none)'}\n"
            "Respect the caller suggestion unless it is clearly wrong for this request."
        )
        messages = [
            {"role": "system", "content": _PLANNER_SYSTEM_PROMPT},
            {"role": "user", "content": request},
        ]
        try:
            return await structured.ainvoke(messages)
        except (ValidationError, OutputParserException):
            # strict=True is not honored by every OpenRouter-served model, so a
            # garbled JSON payload can still reach the parser. Retry once with an
            # explicit corrective instruction; a second failure propagates to the
            # caller's outer fail-open (which reverts to the caller arguments).
            # TODO(follow-up): re-evaluate switching method= away from json_schema
            #   once alternatives are validated against the live model fleet.
            logger.warning("ris_search planner: invalid structured output, retrying once", exc_info=True)
            corrective = [
                *messages,
                {
                    "role": "user",
                    "content": (
                        "Your previous output was invalid JSON. Return ONLY a single valid "
                        "JSON object matching the schema."
                    ),
                },
            ]
            return await structured.ainvoke(corrective)

    return _plan


def _format_hit(index: int, hit: RisHit) -> str:
    lines = [f"--- Result {index} ---"]
    if hit.title:
        lines.append(f"Title: {hit.title}")
    if hit.application:
        lines.append(f"Application: {hit.application}")
    if hit.document_number:
        lines.append(f"Document number: {hit.document_number}")
    for label, value in hit.metadata.items():
        if hit.title and value == hit.title:
            continue
        lines.append(f"{label}: {value}")
    source_url = hit.citation_url or hit.fetch_url
    if source_url:
        lines.append(f"Source: {source_url}")
    if hit.fetch_url:
        lines.append(f"Fetch full text: ris_fetch_document with '{hit.document_number or hit.fetch_url}'")
    if hit.full_law_url:
        lines.append(f"Entire consolidated law (all paragraphs): {hit.full_law_url}")
    return "\n".join(lines)


class RisSearchToolConfig(FunctionBaseConfig, name="ris_search"):
    """Search the Austrian RIS (Rechtsinformationssystem des Bundes) via the OGD-RIS API."""

    base_url: str = Field(default=DEFAULT_BASE_URL, description="OGD-RIS API base URL")
    timeout: float = Field(default=30.0, description="HTTP timeout in seconds")
    page_size: int = Field(default=20, description="Documents per page (10, 20, 50, or 100)")
    max_results: int = Field(default=10, ge=1, description="Maximum number of results to format for the agent")
    planner_llm: LLMRef | None = Field(
        default=None,
        description=(
            "Optional LLM reference (llms: section) used to refine the query into structured "
            "RIS search parameters via strict structured outputs (response_format: json_schema). "
            "Falls back to the caller's raw arguments when unset or on planner failure. "
            "Must be an LLMRef (not a plain str) so NAT records the build-order "
            "dependency and instantiates the LLM before this tool is built."
        ),
    )
    catalog_shortcut: bool = Field(
        default=True,
        description=(
            "Return curated-catalog pointers directly when the query matches the catalog "
            "(no live search, no planner). Live search stays the fallback."
        ),
    )
    catalog_path: str = Field(
        default="",
        description=(
            "DEPRECATED (ADR-0025): path to a legacy flat catalog YAML. Empty = the norm registry "
            "(configs/norms/*/registry.yml, GRID_NORMS_DIR). Set only for legacy override."
        ),
    )


@register_function(config_type=RisSearchToolConfig)
async def ris_search(tool_config: RisSearchToolConfig, builder: Builder):
    if tool_config.page_size not in PAGE_SIZES:
        logger.warning("ris_search: page_size %s not in %s, using 20", tool_config.page_size, sorted(PAGE_SIZES))
        tool_config.page_size = 20

    client = RisClient(base_url=tool_config.base_url, timeout=tool_config.timeout)

    planner = None
    if tool_config.planner_llm:
        try:
            from aiq_agent.common import get_langchain_llm

            planner_llm_obj = await get_langchain_llm(builder, tool_config.planner_llm)
            planner = _make_planner(planner_llm_obj)
            logger.info("ris_search: query planner enabled (llm=%s)", tool_config.planner_llm)
        except Exception:
            logger.warning(
                "ris_search: could not resolve planner_llm '%s', continuing without a query planner",
                tool_config.planner_llm,
                exc_info=True,
            )

    async def _ris_search(
        query: str,
        application: str = "BrKons",
        title: str = "",
        bundesland: str = "",
        date_from: str = "",
        date_to: str = "",
        page: int = 1,
    ) -> str:
        """Search the official Austrian legal information system RIS — the authoritative, always-current
        source for Austrian federal law, state law, and court decisions.

        WHEN TO USE THIS TOOL:
        - The question turns on what an Austrian law, regulation, or court actually SAYS: exact
          wording, scope, thresholds, obligations, penalties, validity, or applicable version.
        - You need the precise legal anchor behind a requirement (law name, paragraph, Bundesland,
          version). OIB-Richtlinien become binding via the state building laws found here.
        - Building law: Bauordnungen, Bautechnikgesetze, and Garagengesetze are STATE law — search
          application "LrKons" and always set the bundesland.
        - Case law: how courts interpreted a provision (Vfgh, Vwgh, Justiz, Bvwg, Lvwg).

        WHEN NOT TO USE:
        - Content of the OIB-Richtlinien themselves or user-uploaded documents → knowledge_search.
        - Non-Austrian law, news, products, or general facts → web search.

        This returns document REFERENCES, not full texts. Never quote legal wording from these
        snippets: pass the document number (or Source URL) to ris_fetch_document and read the
        entire document before citing it.

        Args:
            query (str): German legal search terms, e.g. "Stellplatzverpflichtung Garage". Use
                statutory terminology, not colloquial phrasing.
            application (str): RIS application: "BrKons" consolidated federal law (default),
                "LrKons" consolidated state law, "BgblAuth" authentic federal gazette, "Begut"
                draft bills, "RegV" government bills, "Vfgh"/"Vwgh"/"Justiz"/"Bvwg"/"Lvwg" case
                law, "Dsk" data protection decisions, "Erlaesse" ministry decrees.
            title (str): Optional title filter when a specific law is named, e.g. "Bauordnung für Wien".
            bundesland (str): State filter for state-law searches ("Wien", "Tirol", ...). Required
                practice for Bauordnung questions.
            date_from (str): Optional YYYY-MM-DD. Case law: earliest decision date. "BrKons": the
                version in force at this date.
            date_to (str): Optional YYYY-MM-DD. Case law: latest decision date.
            page (int): 1-based result page.

        Returns:
            str: Numbered document references with citation URLs and fetch instructions.
        """
        if (
            tool_config.catalog_shortcut
            and _CATALOG_AVAILABLE
            and not title
            and not date_from
            and not date_to
            and not _CASE_LAW_SIGNALS.search(query)
        ):
            catalog = load_registry(tool_config.catalog_path or None)
            if catalog is not None:
                matches = match_entries(catalog, query)
                # An explicitly non-default application narrows the pointers to
                # that application ("BrKons" is the signature default, so it is
                # indistinguishable from "not specified" and filters nothing).
                if application != "BrKons":
                    matches = [m for m in matches if m.application == application]
                # Jurisdiction: the explicit bundesland argument wins, else the
                # state named in the query. Other states' law is dropped and the
                # project's own state sorts first — never hand a Tyrolean
                # project the Viennese Bauordnung.
                detected_land = extract_bundesland(bundesland) or extract_bundesland(query)
                matches = focus_entries(matches, detected_land)
                if matches:
                    shown = matches[: tool_config.max_results]
                    lines = [
                        f"Curated RIS catalog match(es) for '{query}' - verified pointers, no live search performed:",
                        "",
                    ]
                    lines.extend(_format_catalog_entry(i, entry) + "\n" for i, entry in enumerate(shown, 1))
                    lines.append(
                        "Fetch the full text with ris_fetch_document using the document number or the "
                        "'Entire consolidated law' URL. This answer comes from the curated catalog; "
                        "refine the query (e.g. name a court, set an explicit application, or a date) "
                        "to force a live RIS search."
                    )
                    return "\n".join(lines)
        # Live-search read-through cache: skips both the planner LLM and the RIS
        # API for a repeat of the exact same search. The catalog shortcut above
        # is local and already free, so it is deliberately not cached here.
        search_key = search_cache_key("|".join([application, query, title, bundesland, date_from, date_to, str(page)]))
        cached_search = await cache_get_json(search_key)
        if isinstance(cached_search, str) and cached_search:
            return cached_search

        effective = {
            "application": application,
            "query": query,
            "title": title,
            "bundesland": bundesland,
            "date_from": date_from,
            "date_to": date_to,
        }
        if planner is not None:
            try:
                plan = await _plan_with(planner, query, application, title, bundesland, date_from, date_to)
                if plan is not None and plan.suchworte.strip():
                    effective = {
                        "application": plan.application,
                        "query": plan.suchworte,
                        "title": plan.titel,
                        "bundesland": plan.bundesland,
                        "date_from": plan.date_from,
                        "date_to": plan.date_to,
                    }
                    logger.info(
                        "ris_search planner: application=%s suchworte='%s' bundesland='%s' (%s)",
                        plan.application,
                        plan.suchworte,
                        plan.bundesland,
                        plan.reasoning,
                    )
            except Exception:
                logger.warning("ris_search: planner failed, using caller arguments", exc_info=True)

        try:
            params = _build_search_params(
                effective["application"],
                effective["query"],
                effective["title"],
                effective["bundesland"],
                effective["date_from"],
                effective["date_to"],
            )
            result = await client.search(
                application=effective["application"],
                params=params,
                page=page,
                page_size=tool_config.page_size,
            )
        except RisError as exc:
            return f"Error: RIS search failed - {exc}"
        except Exception as exc:  # a tool must always hand the agent a string
            logger.exception("ris_search failed")
            return f"Error: RIS search failed - {exc}"

        if not result.hits:
            return (
                f"No RIS documents found for query '{effective['query']}' in application "
                f"'{effective['application']}'. Try different German search terms, another "
                "application (e.g. LrKons for state building law with a bundesland), or drop filters."
            )

        shown = result.hits[: tool_config.max_results]
        total_pages = max(1, -(-result.total // result.page_size)) if result.total else 1
        lines = [
            f"Found {result.total or len(shown)} RIS document(s) "
            f"(page {result.page} of {total_pages}, showing {len(shown)}):",
            "",
        ]
        lines.extend(_format_hit(i, hit) + "\n" for i, hit in enumerate(shown, 1))
        if effective["application"] in _KONSOLIDIERT_APPLICATIONS:
            lines.append(_KONSOLIDIERT_NOTE)
        lines.append(
            "To read a document in full, call ris_fetch_document with its document number or Source URL. "
            "For the complete text of a law (all paragraphs), fetch the 'Entire consolidated law' URL."
        )
        output = "\n".join(lines)
        # Only successful, non-empty results are cached (errors / "no documents
        # found" returned earlier and are never stored).
        await cache_set_json(search_key, output, ris_cache_ttl_seconds())
        return output

    try:
        yield FunctionInfo.from_fn(
            _ris_search,
            description=_ris_search.__doc__,
        )
    finally:
        await client.aclose()


async def _plan_with(planner, query, application, title, bundesland, date_from, date_to) -> RisSearchPlan | None:
    """Run the planner; isolated for testability."""
    return await planner(query, application, title, bundesland, date_from, date_to)


def _format_catalog_entry(index: int, entry: NormEntry) -> str:
    """Format one curated catalog entry as an agent-readable pointer block."""
    lines = [f"--- Catalog match {index} ---"]
    lines.append(f"Title: {entry.title}")
    if entry.bundesland:
        lines.append(f"Bundesland: {entry.bundesland}")
    if entry.is_ris:
        lines.append(f"Application: {entry.application}")
        lines.append(f"Document number: {entry.document_number}")
        if entry.citation_url:
            lines.append(f"Source: {entry.citation_url}")
        if entry.full_law_url:
            lines.append(f"Entire consolidated law (all paragraphs): {entry.full_law_url}")
    elif entry.source_url:
        # Non-RIS source (behoerdliche_info etc.): a plain link — NOT fetchable
        # via ris_fetch_document; the agent reads it with the web tools.
        lines.append(f"Not in RIS - web source: {entry.source_url}")
    else:
        lines.append("Not in RIS - no accessible full text (reference only, say so openly)")
    if entry.relevance:
        lines.append(f"Relevance: {entry.relevance}")
    if entry.binding_note:
        lines.append(f"Rechtlicher Hinweis: {entry.binding_note}")
    return "\n".join(lines)


class RisCatalogLookupToolConfig(FunctionBaseConfig, name="ris_catalog_lookup"):
    """Look up building-law topics in the curated RIS catalog of verified norms."""

    catalog_path: str = Field(
        default="",
        description=(
            "DEPRECATED (ADR-0025): path to a legacy flat catalog YAML. Empty = the norm registry "
            "(configs/norms/*/registry.yml, GRID_NORMS_DIR). Set only for legacy override."
        ),
    )
    max_matches: int = Field(default=5, ge=1, description="Maximum catalog entries returned per lookup")


@register_function(config_type=RisCatalogLookupToolConfig)
async def ris_catalog_lookup(tool_config: RisCatalogLookupToolConfig, builder: Builder):
    catalog_path = tool_config.catalog_path or None

    async def _ris_catalog_lookup(topic: str) -> str:
        """Look up an Austrian building-law topic in the curated RIS catalog of verified norms.

        WHEN TO USE THIS TOOL:
        - First stop for any question about Austrian building law: Bauordnungen,
          Bautechnikgesetze/-verordnungen, and the adjacent federal acts. The catalog
          maps topics to VERIFIED RIS pointers (application, document number, citation
          URL, 'entire consolidated law' URL) - no keyword guessing, no wrong silo.
        - Then call ris_fetch_document with the returned document number or the
          'Entire consolidated law' URL to read the full text before citing anything.

        WHEN NOT TO USE:
        - The catalog covers only the core building-relevant norms. For case law,
          draft bills, gazettes, or anything beyond it, use ris_search (live RIS search).

        Args:
            topic (str): German building-law topic. ALWAYS name the Bundesland for
                state-law topics (e.g. "Bauordnung Tirol", "Stellplatz Wien") — the
                nine state building codes differ, and the lookup returns the named
                state's law (plus federal law) instead of all nine.

        Returns:
            str: Verified pointer blocks (application, document number, citation URL,
                entire-law URL) or guidance to use ris_search when nothing matches.
        """
        if not _CATALOG_AVAILABLE:
            return "Error: RIS catalog lookup unavailable - catalog module not importable. Use ris_search."
        catalog = load_registry(catalog_path)
        if catalog is None:
            return (
                "Error: RIS catalog unavailable (file missing or invalid) - use ris_search (live RIS search) instead."
            )
        # Jurisdiction filter BEFORE truncation: for "Bauordnung Tirol" the nine
        # state codes all match the generic "bauordnung" topic, and without the
        # filter the catalog-order head (Wien, NÖ, ...) would crowd Tirol out of
        # max_matches entirely.
        matches = focus_entries(match_entries(catalog, topic), extract_bundesland(topic))
        matches = matches[: tool_config.max_matches]
        if not matches:
            return (
                f"No curated RIS catalog entry matches '{topic}'. The catalog covers only the core "
                "building-relevant norms (Bauordnungen, Bautechnik, adjacent federal law) - use "
                "ris_search (live RIS search) for anything else."
            )
        lines = [f"Curated RIS catalog: {len(matches)} verified match(es) for '{topic}':", ""]
        for i, entry in enumerate(matches, 1):
            lines.append(_format_catalog_entry(i, entry) + "\n")
        lines.append(
            "These are verified pointers - fetch the full text with ris_fetch_document using the "
            "document number or the 'Entire consolidated law' URL. No ris_search needed."
        )
        return "\n".join(lines)

    yield FunctionInfo.from_fn(
        _ris_catalog_lookup,
        description=_ris_catalog_lookup.__doc__,
    )


class RisFetchDocumentToolConfig(FunctionBaseConfig, name="ris_fetch_document"):
    """Fetch entire documents (laws, court decisions) from the Austrian RIS on demand."""

    timeout: float = Field(default=60.0, description="HTTP timeout in seconds")
    max_chars: int = Field(
        default=40_000,
        ge=1_000,
        description="Maximum characters of document text returned to the agent (full text is still ingested)",
    )
    ingest_into_knowledge: bool = Field(
        default=True,
        description=(
            "Ingest fetched documents into the per-session knowledge collection so "
            "knowledge_search can retrieve and cite them afterwards"
        ),
    )
    cache_ttl_seconds: float = Field(default=3600.0, description="How long fetched documents are cached in memory")


# A RIS page title routinely reads
# "RIS - Wiener Garagengesetz 2008 - Landesrecht konsolidiert Wien, Fassung vom 28.07.2026".
# Two parts of that must not reach the document name:
#
#  * the leading "RIS - ", which doubled up under our own "RIS_" prefix and
#    produced "RIS_RIS_-_…";
#  * the trailing "Fassung vom <date>" stamp, which is the RETRIEVAL date. It
#    made the same law ingest as a NEW document on every new day, so a session
#    accumulated near-duplicate snapshots and a citation pointed at whichever
#    day's copy happened to be retrieved.
_RIS_TITLE_PREFIX_RE = re.compile(r"^\s*RIS\s*[-–—:]+\s*", re.IGNORECASE)
_RIS_TITLE_FASSUNG_RE = re.compile(r"[,;]?\s*Fassung\s+vom\s+[\d.]+\s*$", re.IGNORECASE)

#: Room for the readable part of the name, leaving space for the document
#: number that anchors it.
_RIS_NAME_TITLE_CHARS = 60


#: A RIS URL carries the document's identity either as a query parameter
#: (`Dokument.wxe?…&Dokumentnummer=NOR40217157`,
#: `GeltendeFassung.wxe?…&Gesetzesnummer=10008935`) or in the content path
#: (`/Dokumente/Bundesnormen/NOR40217157/NOR40217157.html`).
_RIS_URL_ID_PARAMS = ("dokumentnummer", "gesetzesnummer")
_RIS_DOCUMENT_PATH_RE = re.compile(r"/Dokumente/[^/]+/([^/]+)/", re.IGNORECASE)


def _document_anchor(reference: str) -> str:
    """The document number a `ris_fetch_document` reference identifies.

    ``reference`` is either a bare document number or a RIS URL for the same
    document, and both MUST anchor the same name: the ingest marker is keyed on
    the FETCHED document's URL, so a URL fetch that reuses a number fetch's
    ingestion would otherwise skip ingestion while reporting a filename that was
    never stored (and vice versa).

    A URL whose identity cannot be read contributes no anchor at all rather than
    a sanitized URL soup: the title alone is stable, a mangled URL is not. That
    includes a URL `urlparse` refuses (``http://[`` raises ValueError): naming a
    document must never be the thing that fails an otherwise successful fetch.
    """
    ref = (reference or "").strip()
    if ref.lower().startswith(("http://", "https://")):
        try:
            parsed = urlparse(ref)
        except ValueError:
            return ""
        query = {key.lower(): values for key, values in parse_qs(parsed.query).items()}
        ref = ""
        for param in _RIS_URL_ID_PARAMS:
            value = next((v.strip() for v in query.get(param, []) if v.strip()), "")
            if value:
                ref = value
                break
        else:
            path_match = _RIS_DOCUMENT_PATH_RE.search(parsed.path)
            ref = path_match.group(1) if path_match else ""
    return re.sub(r"[^\w.\-]+", "", ref)


def _safe_document_name(reference: str, title: str) -> str:
    """Build a stable, filesystem- and citation-friendly name for an ingested document.

    The name becomes a CITATION KEY the reader sees, so it has to be both
    human-legible and stable across fetches. The document number anchors it
    (read out of a URL reference when that is what the agent passed, see
    :func:`_document_anchor`): two fetches of the same law converge on one
    document instead of piling up date-stamped copies, and the reader can still
    tell which law it is.
    """
    base = _RIS_TITLE_FASSUNG_RE.sub("", _RIS_TITLE_PREFIX_RE.sub("", title or ""))
    base = re.sub(r"[^\w.\- ]+", "_", base).strip("_ ").replace(" ", "_")
    # Trim on the truncation boundary too: cutting mid-token used to leave a
    # trailing "." that collided with the extension ("…vom_28..txt").
    base = re.sub(r"[._\-]+$", "", base[:_RIS_NAME_TITLE_CHARS])

    parts = [part for part in (base, _document_anchor(reference)) if part]
    return f"RIS_{'_'.join(parts) or 'Dokument'}.txt"


def _resolve_session_collection() -> str | None:
    """Return the per-session knowledge collection name, or None outside a session."""
    from aiq_agent.knowledge.base import SESSION_COLLECTION_PREFIX
    from nat.builder.context import Context

    try:
        ctx = Context.get()
        session_id = ctx.conversation_id if ctx else None
    except Exception:
        return None
    if not session_id:
        return None
    if session_id.startswith(SESSION_COLLECTION_PREFIX):
        return session_id
    return f"{SESSION_COLLECTION_PREFIX}{session_id}"


def _ingest_document_sync(text: str, file_name: str, source_url: str) -> str | None:
    """Write the document to a temp file and submit it to the active ingestor.

    Returns the ingested file name, or None when ingestion is unavailable.
    Best-effort by design: fetching must succeed even when ingestion cannot.
    """
    from aiq_agent.knowledge.factory import get_active_ingestor

    ingestor = get_active_ingestor()
    if ingestor is None:
        logger.debug("ris_fetch_document: no active ingestor, skipping ingestion")
        return None

    collection = _resolve_session_collection()
    if not collection:
        logger.debug("ris_fetch_document: no session collection, skipping ingestion")
        return None

    staging_dir = tempfile.mkdtemp(prefix="ris_adapter_")
    file_path = os.path.join(staging_dir, file_name)
    with open(file_path, "w", encoding="utf-8") as handle:
        handle.write(f"Source: {source_url}\n\n{text}")

    ingestor.submit_job([file_path], collection)
    logger.info("ris_fetch_document: submitted '%s' for ingestion into '%s'", file_name, collection)
    return file_name


def _legal_status_note(url: str) -> str | None:
    """Konsolidierte Fassung disclaimer for consolidated-law URLs (lawyer-grade citation hygiene)."""
    if "GeltendeFassung" in url or "/Bundesnormen/" in url or "/Landesnormen/" in url:
        return _KONSOLIDIERT_NOTE
    return None


@register_function(config_type=RisFetchDocumentToolConfig)
async def ris_fetch_document(tool_config: RisFetchDocumentToolConfig, builder: Builder):
    client = RisClient(timeout=tool_config.timeout, cache_ttl_seconds=tool_config.cache_ttl_seconds)

    async def _ris_fetch_document(reference: str, application: str = "") -> str:
        """Fetch the ENTIRE text of an Austrian law or court decision from RIS on demand.

        WHEN TO USE THIS TOOL:
        - Always after ris_search, before citing or quoting any legal provision. Search snippets
          are references only — legal answers must be grounded in the full document text.
        - To load a complete consolidated law (every paragraph) via the 'Entire consolidated law'
          URL from ris_search results, e.g. before answering questions spanning multiple sections.
        - To re-read a document the user or an earlier step referenced by document number or RIS URL.

        WHEN NOT TO USE:
        - For documents not hosted on ris.bka.gv.at (this tool only fetches RIS).
        - When the relevant text is already fully present in this conversation.

        The fetched document is also added to the session knowledge base (full text, not truncated),
        so knowledge_search can retrieve and cite specific sections in later steps.

        Args:
            reference (str): RIS document number from ris_search (e.g. "NOR40217157",
                "JWT_2020130074_20210415J00") or any https://www.ris.bka.gv.at/... URL from
                ris_search results (document URL or 'Entire consolidated law' URL).
            application (str): Only needed with a document number whose application cannot be
                inferred: "BrKons", "LrKons", "Vfgh", "Vwgh", "Justiz", "Bvwg", "Lvwg", ...

        Returns:
            str: The document's full text (truncated if very long) with its citation URL,
                retrieval date, and legal-status note.
        """
        reference = (reference or "").strip()
        if not reference:
            return "Error: RIS document fetch failed - provide a document number or RIS URL from ris_search."

        try:
            if reference.lower().startswith(("http://", "https://")):
                url = reference
            else:
                url = build_document_url(reference, application)
            # Shared-cache read-through: an identical document fetched earlier
            # (this turn, an earlier turn, another replica, before a restart) is
            # served without the network download. Fail-open — a cache miss/error
            # just falls through to the live fetch.
            cache_key = doc_cache_key(url)
            cached_doc = await cache_get_json(cache_key)
            if isinstance(cached_doc, dict) and cached_doc.get("text"):
                document = RisDocument(
                    url=cached_doc.get("url", url),
                    title=cached_doc.get("title", ""),
                    text=cached_doc["text"],
                )
            else:
                document = await client.fetch_document_text(url)
                await cache_set_json(
                    cache_key,
                    {"url": document.url, "title": document.title, "text": document.text},
                    ris_cache_ttl_seconds(),
                )
        except RisError as exc:
            return f"Error: RIS document fetch failed - {exc}"
        except Exception as exc:  # a tool must always hand the agent a string
            logger.exception("ris_fetch_document failed")
            return f"Error: RIS document fetch failed - {exc}"

        ingested_name: str | None = None
        if tool_config.ingest_into_knowledge:
            file_name = _safe_document_name(reference, document.title)
            # Don't re-ingest (re-patch) the same document into the same session
            # on every back-and-forth turn — once it's in the collection, just
            # reference it. The marker is best-effort; without it we ingest.
            collection = _resolve_session_collection()
            marker = ingested_marker_key(collection, document.url) if collection else None
            already_ingested = bool(marker) and bool(await cache_get_json(marker))
            if already_ingested:
                ingested_name = file_name
            else:
                try:
                    ingested_name = await asyncio.to_thread(
                        _ingest_document_sync, document.text, file_name, document.url
                    )
                except Exception:
                    logger.warning("ris_fetch_document: knowledge ingestion failed (non-fatal)", exc_info=True)
                if ingested_name and marker:
                    await cache_set_json(marker, True, ris_cache_ttl_seconds())

        header = [f"Source: {document.url}"]
        if document.title:
            header.append(f"Title: {document.title}")
        header.append(f"Retrieved: {datetime.now(UTC).date().isoformat()}")
        status_note = _legal_status_note(document.url)
        if status_note:
            header.append(status_note)
        header.append("Retrieved from RIS (Rechtsinformationssystem des Bundes). Full document text follows.")

        text = document.text
        footer: list[str] = []
        if len(text) > tool_config.max_chars:
            total = len(text)
            text = text[: tool_config.max_chars]
            footer.append(f"[Document truncated: showing {tool_config.max_chars:,} of {total:,} characters.]")
        if ingested_name:
            footer.append(
                f'[The complete document was added to the knowledge base as "{ingested_name}" — '
                "use knowledge_search to query specific sections.]"
            )

        parts = ["\n".join(header), "", text]
        if footer:
            parts.extend(["", "\n".join(footer)])
        return "\n".join(parts)

    try:
        yield FunctionInfo.from_fn(
            _ris_fetch_document,
            description=_ris_fetch_document.__doc__,
        )
    finally:
        await client.aclose()
