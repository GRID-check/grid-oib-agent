"""The NAT function: config, description, and the stages in order.

Nothing is decided here. Every bound, every fallback and every sentence the
model reads lives in the stage that owns it; this module says what the tool is
called, what it takes, and which stage runs next.
"""

from __future__ import annotations

import logging

from pydantic import Field
from ris_adapter.client import DEFAULT_BASE_URL
from ris_adapter.client import RisClient
from ris_adapter.lookup.address import parse_address
from ris_adapter.lookup.candidates import collect_candidates
from ris_adapter.lookup.extract import select_passages
from ris_adapter.lookup.fetch import fetch_documents
from ris_adapter.lookup.ingest import ingest_documents
from ris_adapter.lookup.miss import miss_message
from ris_adapter.lookup.passages import build_passages
from ris_adapter.lookup.picker import make_picker
from ris_adapter.lookup.render import format_passages
from ris_adapter.lookup.telemetry import capture_passages
from ris_adapter.lookup.telemetry import emit_lookup_span
from ris_adapter.lookup.trace import LookupTrace
from ris_adapter.register import _make_planner

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

RIS_LOOKUP_DESCRIPTION = """Answer a question about Austrian law from RIS \
(Rechtsinformationssystem des Bundes) with the actual paragraphs, quotable and citable.

WHEN TO CALL — the question turns on what an Austrian law says: Bauordnungen, \
Bautechnikgesetze, Garagengesetze and every other Landesgesetz, the federal acts \
behind them, and court decisions. OIB-Richtlinien become binding through these \
laws, so a question about the binding force of an OIB requirement belongs here too.

WHEN NOT TO CALL — the CONTENT of the OIB-Richtlinien themselves, or anything the \
office uploaded: that is knowledge_search. Non-Austrian law, news or products: web search.

WHAT IT DOES — one call covers the whole path: it reads the address out of your \
question (§/Artikel, the named law, the Bundesland), takes the verified catalog \
pointer or searches RIS live, downloads at most two documents, and cuts the \
paragraphs that answer the question out of them. You never pass a document number \
and never fetch a document yourself.

Args:
    question (str): The legal question, in German, as the user means it — not a \
search string. "Welche Unterlagen verlangt die Baubehörde in Wien für die \
Einreichung?" works; "Unterlagen Einreichung" is worse, because the terms are \
rewritten inside.
    conclusion (str): One sentence saying what you now know and what you still \
need, which is why you are making THIS call. Empty on your first call of the turn. \
It is the Herleitung checkpoint the reader sees; it changes nothing about the lookup.
    jurisdiction (str): The Bundesland ("Wien", "Tirol", …). Pass it when the user \
named one; otherwise it is taken from the instrument, the question, then the \
project brief, and the answer states which.
    instrument (str): An address when you have one: "Bauordnung für Wien", \
"§ 63 BO Wien", a RIS document number, or a ris.bka.gv.at URL. Naming a § makes \
the lookup deterministic — no model reads the law, the paragraph is cut out by its number. \
Name every § you already know you need in ONE call ("§§ 75 und 81 BO Wien", \
"§§ 2 bis 4 Baupolizeigesetz Salzburg", up to six): each is cut out of the same law, \
where a call per § is a round per §.
    application (str): Only for the non-statute corpora: "Vfgh", "Vwgh", "Justiz", \
"Bvwg", "Lvwg" for case law, "BgblAuth"/"LgblAuth" for the authentic gazettes, \
"Begut"/"RegV" for drafts. Leave empty for statute law — it is decided internally.

Returns:
    str: Numbered passages, each with Source, Dokumentart, Punkt, a \
Citation key to copy verbatim, and the paragraph text. A miss says what was \
searched, which Bundesland was assumed and where that came from, what matched but \
was not read, and one concrete retry — never an empty result, and never a reason \
to invent a citation."""


class RisLookupToolConfig(FunctionBaseConfig, name="ris_lookup"):
    """One RIS tool: question in, citable passages out."""

    base_url: str = Field(default=DEFAULT_BASE_URL, description="OGD-RIS API base URL")
    timeout: float = Field(default=60.0, description="HTTP timeout in seconds")
    planner_llm: LLMRef | None = Field(
        default=None,
        description=(
            "LLM used BOTH to plan a live RIS search and to pick the answering §§ out of a "
            "fetched law's headings (strict structured outputs, json_schema). Neither call "
            "happens when the catalog answers and the caller named a §. Must be an LLMRef "
            "(not a plain str) so NAT records the build-order dependency."
        ),
    )
    catalog_path: str = Field(
        default="",
        description=(
            "DEPRECATED (ADR-0025): path to a legacy flat catalog YAML. Empty = the norm registry "
            "(configs/norms/*/registry.yml, GRID_NORMS_DIR). Set only for legacy override."
        ),
    )
    ingest_into_knowledge: bool = Field(
        default=True,
        description=(
            "Ingest each fetched document's FULL text into the per-session knowledge "
            "collection, so read_passage can reopen another § of it later in the conversation"
        ),
    )


@register_function(config_type=RisLookupToolConfig)
async def ris_lookup(tool_config: RisLookupToolConfig, builder: Builder):
    # cache_max_entries=0: the shared read-through cache already holds the
    # document, and a second copy per worker is a megabyte per law per replica.
    client = RisClient(base_url=tool_config.base_url, timeout=tool_config.timeout, cache_max_entries=0)
    planner, picker = await _resolve_llms(tool_config, builder)

    async def _ris_lookup(
        question: str,
        conclusion: str = "",
        jurisdiction: str = "",
        instrument: str = "",
        application: str = "",
    ) -> str:
        # `conclusion` is deliberately unread, exactly like the knowledge
        # tools': it is the Herleitung's checkpoint slot, read off the CALL by
        # turn_status.CONCLUSION_ARG, and a tool that acted on it would turn a
        # transparency field into a control channel.
        question = (question or "").strip()
        if not question:
            return "Error: ris_lookup needs a question — the legal question in German, not a search string."
        address = parse_address(question, instrument, jurisdiction)
        trace = LookupTrace(application=application)
        trace.candidates = await collect_candidates(client, planner, question, address, trace, tool_config.catalog_path)
        documents = await fetch_documents(client, trace.candidates, trace)
        selections = await select_passages(picker, question, address, documents, trace)
        passages = build_passages(selections, address)
        ingested = await ingest_documents(documents, tool_config.ingest_into_knowledge)
        emit_lookup_span(question, address, trace, passages)
        if not passages:
            return miss_message(question, address, trace)
        capture_passages(passages)
        return format_passages(passages, ingested, address)

    try:
        yield FunctionInfo.from_fn(_ris_lookup, description=RIS_LOOKUP_DESCRIPTION)
    finally:
        await client.aclose()


async def _resolve_llms(tool_config: RisLookupToolConfig, builder: Builder):
    """The search planner and the § extractor, or ``(None, None)``.

    One configured model serves both: they are the same kind of bounded
    structured-output call, and a second LLMRef would be a second thing to
    configure for no decision anybody makes differently. A model that cannot be
    resolved is not fatal — the live search then uses the caller's own words
    and the picker only answers a named §.
    """
    if not tool_config.planner_llm:
        return None, None
    try:
        from aiq_agent.common import get_langchain_llm

        llm = await get_langchain_llm(builder, tool_config.planner_llm)
    except Exception:
        logger.warning(
            "ris_lookup: could not resolve planner_llm '%s'; live search falls back to the "
            "caller's words and the § picker to the named § only",
            tool_config.planner_llm,
            exc_info=True,
        )
        return None, None
    return _make_planner(llm), make_picker(llm)
