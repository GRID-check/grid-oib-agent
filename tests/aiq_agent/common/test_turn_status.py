"""The turn's own account of itself: what it says, and what it refuses to say.

The refusal is the point of this file. A status event may not carry a finished
sentence in any language — it carries a stable KEY and the values to
interpolate into it, and the frontend owns every word. The first cut shipped
German prose in a ``text`` field, the live line rendered it verbatim, and an
English-locale reader read German. :class:`TestNothingEmittedIsLanguageSpecific`
is the test that regression cannot get past.

Exercised against the REAL NAT ``IntermediateStepManager``/``ContextState``
(a process-wide singleton), following ``test_nat_step_repair.py``: half the
contract here is that a status step leaves the span stack exactly as it found
it, and a faked manager would assert nothing about that.
"""

from __future__ import annotations

import json
import re

import pytest

from aiq_agent.common import turn_status
from aiq_agent.skills.events import ALL_SKILL_KEYS
from nat.builder.context import ContextState


@pytest.fixture
def context_state():
    """The singleton ContextState with a clean span stack and a private stream."""
    from nat.utils.reactive.subject import Subject

    state = ContextState.get()
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())
    yield state
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())


@pytest.fixture
def steps(context_state):
    """Every step pushed during the test, as ``(name, parsed payload)`` pairs."""
    seen: list[tuple[str, str, dict]] = []

    def _on_next(step) -> None:
        payload = step.payload
        body = getattr(payload.data, "input", None)
        if isinstance(body, str):
            seen.append((payload.name, str(payload.event_type), json.loads(body)))

    context_state.event_stream.get().subscribe(_on_next)
    return seen


def _live(steps) -> list[dict]:
    return [payload for _name, event_type, payload in steps if event_type.endswith("START")]


class TestSpanHygiene:
    def test_a_step_is_a_balanced_pair(self, steps, context_state) -> None:
        turn_status.emit_citation_check()

        names_and_types = [(name, event_type) for name, event_type, _ in steps]
        assert names_and_types == [
            ("status:citations", "FUNCTION_START"),
            ("status:citations", "FUNCTION_END"),
        ]
        # A leaked START frame corrupts the NEXT legitimate close, which is the
        # fault common.nat_step_repair exists to repair. Never leak one here.
        assert context_state.active_span_id_stack.get() == ["root"]

    def test_emission_never_raises(self, monkeypatch) -> None:
        """Transparency is worth strictly less than the answer it describes."""

        def _boom():
            raise RuntimeError("no context here")

        monkeypatch.setattr("nat.builder.context.Context.get", staticmethod(_boom))
        turn_status.emit_citation_check()
        turn_status.emit_escalation("weil")


class TestDocumentsLoading:
    def test_a_shelf_of_the_readers_own_is_named(self, steps) -> None:
        turn_status.emit_documents_loading(["archiv"])
        payload = _live(steps)[0]
        # The SHELF is in the key, not in the values: German needs the dative
        # ("aus dem Büroarchiv") and English needs no article at all, so a
        # shelf name cannot be interpolated into one shared template.
        assert payload["key"] == "status.documents.archiv"
        assert payload["values"] == {}

    def test_several_shelves_collapse_into_one_line(self, steps) -> None:
        turn_status.emit_documents_loading(["archiv", "project"])
        assert _live(steps)[0]["key"] == "status.documents.several"

    def test_the_base_corpus_alone_says_nothing(self, steps) -> None:
        """It is read on every research turn — announcing it announces a constant."""
        turn_status.emit_documents_loading(["base"])
        turn_status.emit_documents_loading([])
        turn_status.emit_documents_loading(None)
        assert steps == []


class TestRetrieval:
    def test_it_names_the_corpus_by_ID_and_quotes_the_question(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "knowledge_search_tool", "args": {"query": "Fluchtweglänge GK4"}}],
            round_index=0,
        )
        payload = _live(steps)[0]
        assert payload["key"] == "status.retrieval.withQuery"
        # `knowledge`, not "im OIB-Wissen": the display name is product copy
        # with a German preposition welded on, and the frontend owns both.
        assert payload["values"] == {"corpus": "knowledge", "query": "Fluchtweglänge GK4"}

    def test_a_group_qualified_tool_name_still_resolves(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "sources__ris_search_tool", "args": {"query": "OIB 2"}}],
            round_index=0,
        )
        assert _live(steps)[0]["values"]["corpus"] == "ris"

    def test_a_search_with_no_query_uses_the_other_template(self, steps) -> None:
        turn_status.emit_retrieval([{"name": "web_search_tool", "args": {}}], round_index=0)
        payload = _live(steps)[0]
        assert payload["key"] == "status.retrieval.plain"
        assert payload["values"] == {"corpus": "web"}

    def test_the_quoted_query_never_outgrows_its_slot(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "knowledge_search_tool", "args": {"query": "Frage " * 40}}],
            round_index=0,
        )
        assert len(_live(steps)[0]["values"]["query"]) <= turn_status.MAX_QUERY_CHARS

    def test_a_parallel_batch_is_ONE_line(self, steps) -> None:
        """Three lines in the same instant is a log stream, not a status."""
        turn_status.emit_retrieval(
            [
                {"name": "knowledge_search_tool", "args": {"query": "Fluchtweglänge GK4"}},
                {"name": "ris_search_tool", "args": {"query": "Fluchtweglänge GK4"}},
                {"name": "web_search_tool", "args": {"query": "Fluchtweglänge GK4"}},
            ],
            round_index=0,
        )
        assert len(_live(steps)) == 1
        # An ID LIST, joined by a comma — never by a German "und". Which word
        # joins two corpus names is grammar, and grammar belongs to the reader.
        assert _live(steps)[0]["values"]["corpus"] == "knowledge,ris,web"

    def test_successive_rounds_do_not_collapse_into_one_step(self, steps) -> None:
        turn_status.emit_retrieval([{"name": "ris_search_tool", "args": {"query": "a"}}], round_index=0)
        turn_status.emit_retrieval([{"name": "ris_search_tool", "args": {"query": "b"}}], round_index=1)
        names = {name for name, event_type, _ in steps if event_type.endswith("START")}
        assert names == {"status:retrieval:0", "status:retrieval:1"}

    def test_loading_a_skill_is_not_a_retrieval(self, steps) -> None:
        """The skills substrate narrates that itself, with the skill's human title."""
        turn_status.emit_retrieval([{"name": "use_skill", "args": {"skill_name": "x"}}], round_index=0)
        turn_status.emit_retrieval([], round_index=1)
        turn_status.emit_retrieval(None, round_index=2)
        assert steps == []

    def test_an_interaction_tool_says_what_it_does(self, steps) -> None:
        turn_status.emit_retrieval([{"name": "remember", "args": {"text": "Dachneigung 30°"}}], round_index=0)
        assert _live(steps)[0]["key"] == "status.action.remember"

    def test_a_tool_we_cannot_name_says_NOTHING(self, steps) -> None:
        """The only thing left to say about it is its internal name.

        An identifier dressed up as a status is exactly the noise this whole
        module exists to remove — and it would be an English-looking identifier
        in a German UI and a German-looking one in an English UI.
        """
        turn_status.emit_retrieval([{"name": "sql_probe_v2", "args": {"q": "x"}}], round_index=0)
        assert steps == []


class TestEscalation:
    def test_the_line_says_why_in_the_readers_terms(self, steps) -> None:
        turn_status.emit_escalation("Shallow agent emitted insufficiency marker")
        payload = _live(steps)[0]
        assert payload["key"] == "status.escalation"
        # The internal marker string is telemetry, never the sentence.
        assert payload["values"] == {}
        assert payload["reason"] == "Shallow agent emitted insufficiency marker"


class TestChannels:
    def test_every_status_here_is_addressed_to_the_reader(self, steps) -> None:
        turn_status.emit_documents_loading(["project"])
        turn_status.emit_retrieval([{"name": "knowledge_search_tool", "args": {"query": "q"}}], round_index=0)
        turn_status.emit_citation_check(source_count=3)
        turn_status.emit_escalation(None)

        payloads = _live(steps)
        assert len(payloads) == 4
        for payload in payloads:
            assert payload["kind"] == "status"
            assert payload["channel"] == turn_status.CHANNEL_LIVE
            assert payload["key"] in turn_status.ALL_STATUS_KEYS


# --- The point of the change ------------------------------------------------

#: A key or an enum id: ASCII, no spaces, dot/underscore/comma separated. Every
#: product-authored string on the wire has to look like this, because anything
#: that does not is prose — and prose has a language.
_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*(?:[._,][A-Za-z0-9]+)*$")

#: Value names whose content is NOT ours: the reader's own query echoed back,
#: and the tenant's authored skill title. Both are the same string in every
#: locale by definition, so they are exempt from the id rule — and every OTHER
#: value must be an id.
_ECHOED_BACK = {"query", "skill"}

#: Words that would betray German copy having leaked back into emitted data.
#: Crude on purpose: it is a tripwire, not a language detector, and it is the
#: exact vocabulary the old ``text`` field used.
_GERMAN_WORDS = (
    "wird",
    "werden",
    "wurde",
    "keine",
    "nötig",
    "reicht",
    "sucht",
    "belege",
    "unterlagen",
    "gesichtet",
    "geprüft",
    "angewendet",
    "angefordert",
    "recherche",
    "gespräch",
    " und ",
    " im ",
    " aus ",
)


def _every_live_payload(steps) -> list[dict]:
    """One emission of every live event this repo can produce."""
    turn_status.emit_documents_loading(["archiv"])
    turn_status.emit_documents_loading(["project"])
    turn_status.emit_documents_loading(["session"])
    turn_status.emit_documents_loading(["archiv", "project"])
    turn_status.emit_documents_waiting(file_count=1)
    turn_status.emit_retrieval(
        [
            {"name": "knowledge_search_tool", "args": {"query": "Fluchtweglänge GK4"}},
            {"name": "ris_search_tool", "args": {"query": "Fluchtweglänge GK4"}},
        ],
        round_index=0,
    )
    turn_status.emit_retrieval([{"name": "web_search_tool", "args": {}}], round_index=1)
    turn_status.emit_retrieval([{"name": "remember", "args": {"text": "x"}}], round_index=2)
    turn_status.emit_retrieval([{"name": "emit_card", "args": {"kind": "x"}}], round_index=3)
    turn_status.emit_retrieval_requery(query_count=2)
    turn_status.emit_citation_check(source_count=3)
    turn_status.emit_answer_repair(removed_citations=1, unverified_quotes=1)
    turn_status.emit_escalation("Shallow agent emitted insufficiency marker")
    return _live(steps)


class TestNothingEmittedIsLanguageSpecific:
    """The rule: emitted data has no language. The frontend owns every word.

    A backend that ships a finished sentence has already decided who is
    reading, and it decided wrong for everyone else. These four assertions are
    what a future change has to get past to reintroduce the regression.
    """

    def test_the_text_field_is_gone(self, steps) -> None:
        """``text`` was the vehicle. There is no field to put a sentence in."""
        for payload in _every_live_payload(steps):
            assert "text" not in payload, payload

    def test_every_product_authored_string_is_an_id(self, steps) -> None:
        for payload in _every_live_payload(steps):
            assert _ID_RE.match(payload["key"]), payload["key"]
            for name, value in payload["values"].items():
                if name in _ECHOED_BACK:
                    continue
                assert _ID_RE.match(value), f"{name}={value!r} in {payload['key']}"

    def test_no_german_survives_anywhere_the_reader_can_see(self, steps) -> None:
        """Applies to the key and to the values — i.e. to the whole sentence.

        NOT to ``reason``: that is the model's own words, kept deliberately, and
        rendered in a secondary row that attributes them rather than on the
        live line that speaks in the product's voice.
        """
        for payload in _every_live_payload(steps):
            visible = " ".join(
                [payload["key"], *(v for k, v in payload["values"].items() if k not in _ECHOED_BACK)]
            ).lower()
            for word in _GERMAN_WORDS:
                assert word not in f" {visible} ", f"{word!r} leaked into {payload['key']}"

    def test_every_key_emitted_is_one_the_frontend_declares(self, steps) -> None:
        """The registry is what the UI test reads to check both dictionaries.

        A key emitted but not registered is a blank live line in production and
        nothing anywhere that says why.
        """
        emitted = {payload["key"] for payload in _every_live_payload(steps)}
        assert emitted <= set(turn_status.ALL_STATUS_KEYS)
        # And the registry claims nothing it cannot produce: every id in it is
        # reachable from the calls above.
        assert set(turn_status.ALL_STATUS_KEYS) == emitted

    def test_the_two_registries_do_not_overlap(self) -> None:
        assert not set(turn_status.ALL_STATUS_KEYS) & set(ALL_SKILL_KEYS)
