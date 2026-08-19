"""The live citation stream must be true at the end of a job.

Two failure modes are pinned here, both of them about the SSE ``citation_use``
artifact — the one that tells a reader "the answer actually cites this":

1. Inside a Dask worker the callback had nothing to validate a knowledge-base
   citation against, so an OIB Richtlinie could never be marked cited.
2. The cited claim was made from raw streamed model output, i.e. BEFORE
   ``verify_citations`` stripped the fabricated and unverifiable citations —
   and the frontend's merge is monotonic, so the claim could never be taken
   back.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.citation_verification import verify_citations
from aiq_api.jobs.callbacks import AgentEventCallback
from aiq_api.jobs.callbacks import ArtifactType

OIB_KEY = "oib-rl_2_ausgabe_mai_2023.pdf, p.12"
REAL_URL = "https://example.com/oib-2-zusammenfassung"

# A knowledge-retrieval tool result in the shape ``_format_results`` produces —
# the same bytes ``SourceRegistryMiddleware`` parses, so the callback's mirror
# cannot drift from the registry the verifier later uses.
KB_TOOL_OUTPUT = (
    "Found 1 relevant document:\n\n"
    "--- Result 1 ---\n"
    "Source: OIB-Richtlinie 2\n"
    "Page: 12\n"
    f"Citation: {OIB_KEY}\n"
    "Collection: oib_knowledge\n"
    "Relevance Score: 0.91\n\n"
    "Brandabschnitte sind auf 1.200 m2 zu begrenzen.\n"
)

# The verified, sanitised report as `_finalize` hands it over: both sources are
# real and both survived verification.
FINAL_REPORT = (
    "Brandabschnitte sind auf 1.200 m2 zu begrenzen [1]. Ergaenzend ist die "
    "Rauchableitung nachzuweisen [2]. Fluchtwege duerfen 40 m nicht "
    "ueberschreiten [1].\n\n"
    "## Quellen\n"
    f"- [1] [KB] {OIB_KEY}\n"
    f"- [2] [Web] Zusammenfassung: {REAL_URL}\n"
)


@pytest.fixture(autouse=True)
def _unbound_session_registry():
    """Start every test from the worker's real starting point: nothing bound.

    A registry leaked from another test would make the session tier answer for
    the tier under test, and the assertions would stop meaning anything.
    """
    token = set_session_registry(None)
    yield
    reset_session_registry(token)


def _run_registry() -> SourceRegistry:
    """What a run retrieved: one OIB document and one web page."""
    registry = SourceRegistry()
    registry.add(
        SourceEntry(
            citation_key=OIB_KEY,
            title="OIB-Richtlinie 2",
            source_type="knowledge_layer",
            collection="oib_knowledge",
            tool_name="knowledge_retrieval",
        )
    )
    registry.add(SourceEntry(url=REAL_URL, title="Zusammenfassung", source_type="generic", tool_name="web_search_tool"))
    return registry


def _capture(callback: AgentEventCallback):
    """Patch ``_emit_artifact`` and collect every artifact it was handed."""
    emitted: list[dict] = []
    patcher = patch.object(
        callback,
        "_emit_artifact",
        side_effect=lambda artifact_type, content, **kw: emitted.append(
            {"type": artifact_type, "content": content, **kw}
        ),
    )
    return emitted, patcher


def _cited(emitted: list[dict]) -> list[dict]:
    return [item for item in emitted if item["type"] == ArtifactType.CITATION_USE]


def _cited_keys(emitted: list[dict]) -> list[str]:
    return [item["citation_key"] for item in _cited(emitted) if item.get("citation_key")]


def _cited_urls(emitted: list[dict]) -> list[str]:
    return [item["url"] for item in _cited(emitted) if item.get("url")]


class _StubMessage:
    """The minimal message shape ``_extract_llm_response`` reads.

    A MagicMock cannot stand in: every ``hasattr`` on it is true, so the
    handler reads it as a tool call and never reaches the output path at all.
    """

    def __init__(self, content: str) -> None:
        self.content = content
        self.tool_calls: list = []
        self.additional_kwargs: dict = {}
        self.response_metadata: dict = {}


class _StubGeneration:
    def __init__(self, content: str) -> None:
        self.message = _StubMessage(content)


class _StubLLMResult:
    def __init__(self, content: str) -> None:
        self.generations = [[_StubGeneration(content)]]


class TestADocumentCitationIsMarkableInsideAJob:
    """An OIB Richtlinie the answer cites must be markable as cited IN A JOB.

    ``_get_source_registry`` once read the session contextvar and nothing else,
    and nothing binds that inside a Dask worker — only the synchronous chat
    entrypoints call ``set_session_registry``. The lookup returned None,
    ``_emit_cited_documents`` early-returned, and no knowledge-base document
    could ever be marked cited: a run citing four Richtlinien and one web page
    marked the web page, alone, in a product whose sources are Richtlinien.
    """

    def test_a_registry_passed_to_the_constructor_marks_the_document_cited(self):
        callback = AgentEventCallback(source_registry=_run_registry())
        emitted, patcher = _capture(callback)
        with patcher:
            callback.emit_final_report(FINAL_REPORT)

        assert OIB_KEY in _cited_keys(emitted)

    def test_a_registry_attached_after_construction_marks_the_document_cited(self):
        """The runner builds the callback before the run's registry exists."""
        callback = AgentEventCallback()
        callback.set_source_registry(_run_registry())
        emitted, patcher = _capture(callback)
        with patcher:
            callback.emit_final_report(FINAL_REPORT)

        assert OIB_KEY in _cited_keys(emitted)

    def test_an_accessor_is_re_read_rather_than_pinned_at_wiring_time(self):
        """A callable tier follows a run that swaps registries mid-flight."""
        holder: dict[str, SourceRegistry | None] = {"registry": None}
        callback = AgentEventCallback(source_registry=lambda: holder["registry"])
        emitted, patcher = _capture(callback)
        with patcher:
            holder["registry"] = _run_registry()
            callback.emit_final_report(FINAL_REPORT)

        assert OIB_KEY in _cited_keys(emitted)

    def test_a_run_that_binds_the_session_registry_marks_the_document_cited(self):
        """The production path: ``DeepResearcherAgent.run`` binds the contextvar.

        The callback is constructed by the runner with no registry of its own
        (``AgentEventCallback(event_store)``), so what has to work end to end is
        the session tier the agent binds around the whole run — including the
        ``_finalize`` call that emits this very report.
        """
        callback = AgentEventCallback()
        emitted, patcher = _capture(callback)
        token = set_session_registry(_run_registry())
        try:
            with patcher:
                callback.emit_final_report(FINAL_REPORT)
        finally:
            reset_session_registry(token)

        assert OIB_KEY in _cited_keys(emitted)

    def test_the_runs_own_tool_results_stand_in_when_nothing_is_bound(self):
        """Last resort: the sources this run's tools actually returned.

        No attached registry, no session binding — the shape a job takes when
        its agent never binds one. The mirror is built from the same parse that
        produced the ``citation_source`` artifact, so it cannot claim a document
        the run did not retrieve.
        """
        callback = AgentEventCallback()
        emitted, patcher = _capture(callback)
        with patcher:
            callback.on_tool_end(KB_TOOL_OUTPUT, name="knowledge_retrieval", run_id="tool-1")
            callback.emit_final_report(FINAL_REPORT)

        assert OIB_KEY in _cited_keys(emitted)

    def test_with_nothing_retrieved_no_document_is_claimed_as_cited(self):
        """Declining to guess is the point: an empty registry is not an answer.

        Without this the mirror would be offered while still empty, and every
        document citation would be judged unverifiable rather than unknown.
        """
        callback = AgentEventCallback()
        emitted, patcher = _capture(callback)
        with patcher:
            callback.emit_final_report(FINAL_REPORT)

        assert _cited_keys(emitted) == []
        # The report itself is untouched by any of this.
        assert [item["type"] for item in emitted if item["type"] == ArtifactType.OUTPUT]

    def test_a_registry_accessor_that_raises_never_costs_the_user_the_report(self):
        """Transparency artifacts must never fail a job."""

        def _explode() -> SourceRegistry:
            raise RuntimeError("middleware is gone")

        callback = AgentEventCallback(source_registry=_explode)
        emitted, patcher = _capture(callback)
        with patcher:
            callback.on_tool_end(KB_TOOL_OUTPUT, name="knowledge_retrieval", run_id="tool-1")
            callback.emit_final_report(FINAL_REPORT)

        # Fell through to the run's own mirror instead of breaking the stream.
        assert OIB_KEY in _cited_keys(emitted)


class TestCitedIsClaimedOnlyForTheVerifiedReport:
    """ "Cited" is announced for the FINAL report, never for raw model output.

    ``_emit_cited_sources`` used to run on ``on_llm_end`` content, which is
    produced before ``verify_citations`` runs in ``DeepResearcherAgent._finalize``
    and before the writer decides which of an intermediate agent's sources reach
    the answer at all. The frontend merge is monotonic — ``isCited`` is sticky
    once true — so a premature claim could never be lowered back to
    "discovered". Discovery still streams live as ``citation_source``; only the
    stronger claim waits.
    """

    def test_raw_streaming_output_claims_nothing_as_cited(self):
        callback = AgentEventCallback(source_registry=_run_registry())
        emitted, patcher = _capture(callback)
        with patcher:
            callback.on_llm_end(_StubLLMResult(FINAL_REPORT + "x" * 200), run_id="llm-1")

        assert _cited(emitted) == []
        # The draft artifact itself still streams — only the claim is withheld.
        assert any(item["type"] == ArtifactType.OUTPUT for item in emitted)

    def test_a_document_verification_stripped_is_absent_from_the_final_cited_set(self):
        """The real verifier decides; the stream only reports its verdict.

        The draft hangs a source URL the run never retrieved off a line that
        names a REAL retrieved document. ``verify_citations`` reads the URL
        first and drops the whole line, so the finished report no longer claims
        that document at all — while the draft's source section still names it,
        and a cited-set built from the draft would announce it.
        """
        registry = _run_registry()
        draft = (
            "Brandabschnitte sind auf 1.200 m2 zu begrenzen [1]. Fluchtwege duerfen "
            "40 m nicht ueberschreiten [2]. Die Rauchableitung ist nachzuweisen [1].\n\n"
            "## Quellen\n"
            f"- [1] [Web] Zusammenfassung: {REAL_URL}\n"
            f"- [2] {OIB_KEY} - https://oib.example.org/rl2-nie-abgerufen\n"
        )
        verification = verify_citations(draft, registry)
        assert verification.removed_citations, "fixture no longer exercises a stripped citation"
        assert OIB_KEY not in verification.verified_report

        callback = AgentEventCallback(source_registry=registry)
        emitted, patcher = _capture(callback)
        with patcher:
            # The order a real run takes: the writer streams, THEN _finalize
            # verifies and re-emits.
            callback.on_llm_end(_StubLLMResult(draft + "x" * 200), run_id="llm-1")
            callback.emit_final_report(verification.verified_report)

        assert _cited_keys(emitted) == []
        assert _cited_urls(emitted) == [REAL_URL]

    def test_a_url_verification_stripped_is_absent_from_the_final_cited_set(self):
        """Same verdict for the web half, judged against the discovery scrape.

        ``_discovered_urls`` is filled by a looser scrape than the registry, so
        a URL the model lifted out of a tool result but never retrieved passes
        the URL check while failing verification. Only the verified report may
        settle it.
        """
        registry = _run_registry()
        stray = "https://example.com/nur-im-snippet"
        draft = (
            "Brandabschnitte sind auf 1.200 m2 zu begrenzen [1]. Ein weiterer "
            "Hinweis findet sich dort [2]. Die Rauchableitung ist nachzuweisen [1].\n\n"
            "## Quellen\n"
            f"- [1] [Web] Zusammenfassung: {REAL_URL}\n"
            f"- [2] [Web] Hinweis: {stray}\n"
        )
        verification = verify_citations(draft, registry)
        assert any(c["reason"] == "url_not_in_registry" for c in verification.removed_citations)

        # No attached registry and no session binding: the URL check falls back
        # to what discovery scraped, which is where the stray URL lives.
        callback = AgentEventCallback()
        callback._discovered_urls.update({REAL_URL, stray})
        emitted, patcher = _capture(callback)
        with patcher:
            callback.on_llm_end(_StubLLMResult(draft + "x" * 200), run_id="llm-1")
            callback.emit_final_report(verification.verified_report)

        assert stray not in _cited_urls(emitted)
        assert _cited_urls(emitted) == [REAL_URL]

    def test_a_source_only_an_intermediate_agent_cited_is_never_announced(self):
        """A researcher's notes cite everything that worker retrieved.

        The writer carries only some of it into the answer. Announcing the rest
        marks sources the finished report does not claim — permanently, because
        ``isCited`` is sticky.
        """
        registry = _run_registry()
        notes = (
            "Recherchenotizen: Beide Fundstellen sind einschlaegig [1][2]. Die "
            "Begrenzung der Brandabschnitte ist in beiden Quellen belegt und "
            "wird hier zusammengefasst.\n\n"
            "## Quellen\n"
            f"- [1] [Web] Zusammenfassung: {REAL_URL}\n"
            f"- [2] [KB] {OIB_KEY}\n"
        )
        writers_report = (
            "Brandabschnitte sind auf 1.200 m2 zu begrenzen [1].\n\n"
            "## Quellen\n"
            f"- [1] [Web] Zusammenfassung: {REAL_URL}\n"
        )

        callback = AgentEventCallback(source_registry=registry)
        emitted, patcher = _capture(callback)
        with patcher:
            callback.on_llm_end(_StubLLMResult(notes), run_id="llm-researcher")
            callback.emit_final_report(writers_report)

        assert _cited_keys(emitted) == []
        assert _cited_urls(emitted) == [REAL_URL]

    def test_the_runners_second_emit_adds_no_duplicate_citation(self):
        """The runner re-emits the same report with Grid cards attached."""
        callback = AgentEventCallback(source_registry=_run_registry())
        emitted, patcher = _capture(callback)
        with patcher:
            callback.emit_final_report(FINAL_REPORT)
            callback.emit_final_report(FINAL_REPORT, cards=[{"type": "legal_basis"}])

        assert len(_cited(emitted)) == 2  # one document, one URL, each announced once

    def test_a_citation_failure_never_costs_the_user_the_report(self):
        callback = AgentEventCallback(source_registry=_run_registry())
        emitted, patcher = _capture(callback)
        with patcher, patch.object(callback, "_emit_cited_sources", side_effect=RuntimeError("boom")):
            callback.emit_final_report(FINAL_REPORT)

        assert [item["type"] for item in emitted] == [ArtifactType.OUTPUT]
