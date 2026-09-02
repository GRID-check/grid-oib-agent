"""Live turn-shape eval for the two behaviours ADR-0052 moved from code into the prompt.

ADR-0052 deleted the intent classifier: every turn enters the shallow
researcher with every tool bound, and what the turn IS is decided by the model
with the tools in hand. Two things that used to be routing are now the model's
judgment, pinned only by the ``<output_contract>`` block of
``src/aiq_agent/agents/shallow_researcher/prompts/researcher.j2``:

1. a greeting or a question about the assistant is a direct reply, and calls
   no data-source tool;
2. a commissioned report is handed to deep research (``escalate_to_deep`` in
   the envelope) BEFORE any retrieval of its own.

This file is the eval the ADR said those behaviours lacked. It builds the real
``ShallowResearcherAgent`` on the real system prompt against the real shallow
model through OpenRouter, with STUB tools in place of the retrieval stack: the
stubs record every call and return a plausible hit, so the trace shows exactly
what the model chose to do and nothing here needs a corpus, a database or a
RIS connection. The third case is the control: a plain Baurecht question must
still search, or a prompt edit that "fixes" greetings by discouraging retrieval
would pass the first two cases and break the product.

Runs only with ``OPENROUTER_API_KEY`` set (skips otherwise, so the default
``pytest`` run and every PR job stay model-free); CI runs it weekly and on
demand from ``.github/workflows/turn-shapes-live.yml``. Locally:
``task be:eval:turn-shapes``.

The assertions are strict: a behaviour miss fails, with the recorded tool trace
in the message. The ONE retry is for transport (connection, timeout, 429, 5xx),
never for a behaviour the model got wrong — a flaky-then-green model judgment
is exactly the drift this eval exists to measure.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path

import openai
import pytest
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.shallow_researcher.agent import ShallowResearcherAgent
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.common import AgentGroup
from aiq_agent.common import LLMProvider
from aiq_agent.common.data_source_registry import populate_from_config
from aiq_agent.common.data_source_registry import reset_registry
from aiq_agent.common.llm_factory import apply_openrouter_structured_defaults
from aiq_agent.common.llm_factory import enforce_chat_request_contract

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_OIB_CONFIG = _REPO_ROOT / "configs" / "config_oib_openrouter.yml"
_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.environ.get("OPENROUTER_API_KEY"),
        reason="live model eval: needs OPENROUTER_API_KEY (see docs/contributing/testing-and-verification.md)",
    ),
]

# Every tool call the stubs received this run, in order: (tool name, query).
# The trace the assertions read. Cleared per run by ``_run_turn``.
_CALLS: list[tuple[str, str]] = []

# The data sources the OIB config declares, with the same ids and tool names,
# so ``source_lookup_attempted`` and source capture gate on them exactly as
# they do in production (``data_source_registry`` is the second gate on
# capture; a tool it does not know contributes no source).
_DATA_SOURCES = [
    {
        "id": "web_search",
        "name": "Web Search",
        "description": "Search the web for real-time information.",
        "tools": ["web_search_tool"],
    },
    {
        "id": "knowledge_layer",
        "name": "Knowledge Base",
        "description": "Search uploaded documents and files.",
        "tools": ["knowledge_search"],
    },
    {
        "id": "ris",
        "name": "RIS – Österreichisches Recht",
        "description": "Search Austrian federal/state law in the official RIS and fetch entire documents.",
        "tools": ["ris_search_tool", "ris_fetch_tool"],
    },
]
_DATA_SOURCE_TOOL_NAMES = frozenset(name for source in _DATA_SOURCES for name in source["tools"])

# One plausible hit, in the exact layout ``knowledge_layer/src/register.py::_format_results``
# emits, so the citation parser registers it as a real source and the answer
# on the control case has something to cite.
_KNOWLEDGE_HIT = """\
--- Result 1 ---
Source: OIB-Richtlinie 4 – Nutzungssicherheit und Barrierefreiheit (Ausgabe April 2019)
Collection: oib_knowledge
Shelf: basiswissen
Dokumentart: oib_richtlinie — OIB-Richtlinie
Page: 5
Punkt: 4.2.1
Citation: oib-rl_4_ausgabe_april_2019.pdf, p.5
Content Type: text
Relevance Score: 0.87

4.2 Absturzsicherungen
4.2.1 Die Höhe von Absturzsicherungen muss bei Absturzhöhen bis 12 m mindestens 1,00 m betragen,
bei Absturzhöhen über 12 m mindestens 1,10 m. Die Höhe ist ab der Standfläche zu messen.

## Trace-Lanes
- oib_knowledge: 1 hit
"""

_RIS_HIT = """\
Treffer 1
Titel: Wiener Bauordnung § 101 Absturzsicherungen
Dokumentnummer: LWI40000234
URL: https://www.ris.bka.gv.at/Dokumente/LrW/LWI40000234/LWI40000234.html
Auszug: Bei Absturzhöhen ab 60 cm sind Absturzsicherungen von mindestens 1,00 m Höhe anzubringen.
"""

_WEB_HIT = """\
Title: OIB-Richtlinien 2019 – Überblick
URL: https://www.oib.or.at/de/oib-richtlinien/richtlinien/2019
Snippet: Die OIB-Richtlinie 4 regelt Nutzungssicherheit und Barrierefreiheit, darunter Absturzsicherungen.
"""


def _record(name: str, query: str, payload: str) -> str:
    _CALLS.append((name, query))
    return payload


@tool
def knowledge_search(query: str, file_name: str | None = None) -> str:
    """Search the knowledge base: OIB-Richtlinien, Bürowissen and the project's uploaded documents.

    Returns the best matching passages with a Citation line each. Use for any question that needs
    the text of an OIB-Richtlinie, an internal document or a project file."""
    return _record("knowledge_search", query, _KNOWLEDGE_HIT)


@tool
def ris_search_tool(query: str) -> str:
    """Search Austrian federal and state law (Bauordnungen, statutes, case law) in the official RIS.

    Use German search terms. Returns hits with document numbers and URLs; fetch the full text with
    ris_fetch_tool."""
    return _record("ris_search_tool", query, _RIS_HIT)


@tool
def ris_fetch_tool(document_number: str) -> str:
    """Fetch the full text of one RIS document by its document number, for exact wording and citation."""
    return _record(
        "ris_fetch_tool",
        document_number,
        "§ 101. (1) Bei Absturzhöhen ab 60 cm sind Absturzsicherungen von mindestens 1,00 m Höhe anzubringen.\n"
        "URL: https://www.ris.bka.gv.at/Dokumente/LrW/LWI40000234/LWI40000234.html\n",
    )


@tool
def web_search_tool(query: str) -> str:
    """Search the web for general facts, news, or when the sources above are silent."""
    return _record("web_search_tool", query, _WEB_HIT)


_TOOLS = [knowledge_search, ris_search_tool, ris_fetch_tool, web_search_tool]

# Transport, not behaviour: the one class of failure a rerun is allowed for.
# ``APIConnectionError`` covers the timeout subclass; the two status errors are
# the provider saying "not now", not the model saying anything.
_TRANSPORT_ERRORS = (openai.APIConnectionError, openai.RateLimitError, openai.InternalServerError)


def _shallow_model_name() -> str:
    """The shallow researcher's model as the OIB config would boot it.

    Read from ``shallow_llm.model_name`` rather than hard-coded here, so the
    eval follows the boot floor when it moves (``${GRID_DEFAULT_MODEL:-…}``
    resolved the way the config loader resolves it). The live default an actual
    user gets is admin-set (ADR-0014); the boot floor is what a model-free
    process runs on, and the closest thing to a fixed reference this eval has.
    """
    block = _OIB_CONFIG.read_text(encoding="utf-8").split("shallow_llm:", 1)[1]
    match = re.search(r"model_name:\s*\$\{(\w+):-([^}]+)\}", block)
    if match is None:
        raise AssertionError(f"could not find shallow_llm.model_name in {_OIB_CONFIG}")
    env_var, default = match.group(1), match.group(2).strip()
    return os.environ.get(env_var) or default


def _build_agent() -> ShallowResearcherAgent:
    """The real agent, the real prompt, the real model; stub tools."""
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(
        model=_shallow_model_name(),
        base_url=_OPENROUTER_BASE_URL,
        api_key=os.environ["OPENROUTER_API_KEY"],
        # The plumbing ``shallow_llm`` fixes in the config, which no override
        # may touch: sampling, the low reasoning tier of the quick-answer path,
        # a bounded request and the client-side retry count.
        temperature=1.0,
        reasoning_effort="low",
        timeout=120,
        max_retries=2,
    )
    # What ``get_langchain_llm`` does to every fleet model at build time.
    llm = enforce_chat_request_contract(apply_openrouter_structured_defaults(llm))
    provider = LLMProvider()
    provider.set_default(llm, group=AgentGroup.SHALLOW_RESEARCH)
    return ShallowResearcherAgent(
        llm_provider=provider,
        tools=_TOOLS,
        # The repair pass re-searches after a failed verification. That is a
        # second decision made by the pipeline, not the first one made by the
        # model, and the first is what this eval measures.
        repair_pass=False,
    )


async def _run_turn(agent: ShallowResearcherAgent, question: str) -> ShallowResearchAgentState:
    """One turn, with a single rerun for a transport failure only."""
    for attempt in (1, 2):
        _CALLS.clear()
        try:
            return await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content=question)]))
        except _TRANSPORT_ERRORS as exc:
            if attempt == 2:
                raise
            logger.warning("Transport failure on attempt 1 (%s); rerunning once", type(exc).__name__)
    raise AssertionError("unreachable")


def _data_source_calls() -> list[tuple[str, str]]:
    return [call for call in _CALLS if call[0] in _DATA_SOURCE_TOOL_NAMES]


def _answer_text(result: ShallowResearchAgentState) -> str:
    content = result.messages[-1].content
    return content if isinstance(content, str) else str(content)


@pytest.fixture(autouse=True)
def _data_source_registry():
    reset_registry()
    populate_from_config(_DATA_SOURCES)
    yield
    reset_registry()


@pytest.fixture(scope="module")
def agent() -> ShallowResearcherAgent:
    return _build_agent()


async def test_a_greeting_is_answered_directly_without_a_search(agent):
    """ADR-0052, behaviour 1: „Hallo, was kannst du?" is a direct reply.

    The full tool set is bound (there is no narrowed binding to fall into), so
    the only thing between this turn and a pointless retrieval is the model
    reading ``<output_contract>``. The trace must show no data-source call, the
    turn must report no lookup, and the envelope must not escalate.
    """
    result = await _run_turn(agent, "Hallo, was kannst du?")

    assert _data_source_calls() == [], f"a greeting searched: {_CALLS}"
    assert result.source_lookup_attempted is False
    assert result.escalation_requested is False, result.answer_escalation_reason
    assert _answer_text(result).strip(), "a greeting produced an empty answer"


async def test_a_commissioned_report_escalates_before_any_retrieval(agent):
    """ADR-0052, behaviour 2: a commissioned Prüfbericht is handed off at once.

    The prompt says a commissioned report needs no retrieval of the shallow
    agent's own first. So the envelope must carry ``escalate_to_deep`` with a
    reason, and the trace must be empty of data-source calls — the hand-off is
    the final answer, so any recorded retrieval happened before it.
    """
    result = await _run_turn(
        agent,
        "Erstelle mir einen vollständigen Prüfbericht zur Barrierefreiheit für das Projekt Musterstraße "
        "nach OIB-Richtlinie 4",
    )

    assert result.escalation_requested is True, f"no escalation; answer was: {_answer_text(result)[:400]}"
    assert result.answer_escalation_reason, "escalated without an escalation_reason"
    assert _data_source_calls() == [], f"a commissioned report retrieved before handing off: {_CALLS}"


async def test_a_plain_domain_question_still_searches(agent):
    """The control: a Baurecht question retrieves and does not escalate.

    Without this, a prompt edit that stopped greetings from searching by
    discouraging retrieval in general would pass the two cases above and ship
    an assistant that answers OIB questions from memory.
    """
    result = await _run_turn(agent, "Wie hoch muss ein Geländer bei einer Absturzhöhe von 2 m sein?")

    assert _data_source_calls(), f"a domain question retrieved nothing; answer was: {_answer_text(result)[:400]}"
    assert result.source_lookup_attempted is True
    assert result.escalation_requested is False, result.answer_escalation_reason
