"""The turn's own account of itself: what it says, and what it refuses to say.

The refusal is the point of this file. A status event may not carry a finished
sentence in any language — it carries a stable KEY and the values to
interpolate into it, and the frontend owns every word. The first cut shipped
German prose in a ``text`` field, the live line rendered it verbatim, and an
English-locale reader read German. :class:`TestNothingEmittedIsLanguageSpecific`
is the test that regression cannot get past.

Each emitter is exercised at LangGraph's writer seam (the ``emitted`` fixture
in ``tests/conftest.py``) and asserted on the typed step it wrote. That the
writer reaches the producers inside a graph run is
``test_step_producers.py``.
"""

from __future__ import annotations

import re

import pytest

from aiq_agent.common import turn_status
from aiq_agent.common.wire_v2 import StatusStep
from aiq_agent.skills.events import ALL_SKILL_KEYS


@pytest.fixture(autouse=True)
def _reset_retrieval_round():
    """ContextVars leak across tests in one process; a stamp must not outlive the case."""
    yield
    turn_status._retrieval_round.set(None)


@pytest.fixture
def steps(emitted):
    """Every body the producers wrote during the test (``tests/conftest.py``)."""
    return emitted


def _live(emitted) -> list:
    """The steps addressed to the READER: a retrieval round, or a live status.

    The language rules below are about what a reader can see, so a technical
    record (no ``key``, no ``values``, counted and never rendered) is not
    theirs to judge.
    """
    return [step for step in emitted.steps if step.kind == "retrieval" or getattr(step, "channel", None) == "live"]


def _technical(emitted) -> list:
    return [step for step in emitted.steps if step.kind == "status" and step.channel == turn_status.CHANNEL_TECHNICAL]


def _started(emitted, prefix: str) -> list[str]:
    """Step IDS emitted, narrowed to one ``status:`` family."""
    return [step.id for step in emitted.steps if step.id.startswith(prefix)]


class TestOutsideAGraph:
    def test_emission_outside_a_graph_run_is_silent(self) -> None:
        """No stream to write to (the setup phase): nothing, and no error."""
        turn_status.emit_citation_check()
        turn_status.emit_escalation("weil")


class TestDocumentsLoading:
    """A setup-phase line: RETURNED for ``_run`` to yield, never emitted."""

    def test_a_shelf_of_the_readers_own_is_named(self, steps) -> None:
        step = turn_status.documents_loading_step(["archiv"])
        # The SHELF is in the key, not in the values: German needs the dative
        # ("aus der Büroablage") and English needs no article at all, so a
        # shelf name cannot be interpolated into one shared template.
        assert step == StatusStep(
            id="status:documents", slot="documents", key="status.documents.archiv", detail={"shelves": ["archiv"]}
        )
        assert steps == []

    def test_several_shelves_collapse_into_one_line(self) -> None:
        assert turn_status.documents_loading_step(["archiv", "project"]).key == "status.documents.several"

    def test_the_base_corpus_alone_says_nothing(self) -> None:
        """It is read on every research turn — announcing it announces a constant."""
        assert turn_status.documents_loading_step(["base"]) is None
        assert turn_status.documents_loading_step([]) is None
        assert turn_status.documents_loading_step(None) is None


class TestRetrieval:
    def test_it_names_the_corpus_by_ID_and_quotes_the_question(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "knowledge_search_tool", "args": {"query": "Fluchtweglänge GK4"}}],
            round_index=0,
        )
        payload = _live(steps)[0]
        assert payload.key == "status.retrieval.withQuery"
        # `knowledge`, not "im OIB-Wissen": the display name is product copy
        # with a German preposition welded on, and the frontend owns both.
        assert payload.values == {"corpus": "knowledge", "query": "Fluchtweglänge GK4"}

    def test_a_group_qualified_tool_name_still_resolves(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "sources__ris_search_tool", "args": {"query": "OIB 2"}}],
            round_index=0,
        )
        assert _live(steps)[0].values["corpus"] == "ris"

    def test_a_search_with_no_query_uses_the_other_template(self, steps) -> None:
        turn_status.emit_retrieval([{"name": "web_search_tool", "args": {}}], round_index=0)
        payload = _live(steps)[0]
        assert payload.key == "status.retrieval.plain"
        assert payload.values == {"corpus": "web"}

    def test_the_quoted_query_never_outgrows_its_slot(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "knowledge_search_tool", "args": {"query": "Frage " * 40}}],
            round_index=0,
        )
        assert len(_live(steps)[0].values["query"]) <= turn_status.MAX_QUERY_CHARS

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
        assert _live(steps)[0].values["corpus"] == "knowledge,ris,web"

    def test_successive_rounds_do_not_collapse_into_one_step(self, steps) -> None:
        turn_status.emit_retrieval([{"name": "ris_search_tool", "args": {"query": "a"}}], round_index=0)
        turn_status.emit_retrieval([{"name": "ris_search_tool", "args": {"query": "b"}}], round_index=1)
        assert _started(steps, "status:retrieval") == ["status:retrieval:0", "status:retrieval:1"]

    def test_opening_a_named_passage_says_WHAT_is_being_read(self, steps) -> None:
        """„Liest OIB-Richtlinie 2, Pkt. 3.5.2" — a different claim from „Sucht".

        The reader is being told the passage was already identified, which is
        the checkpoint the Herleitung draws. The document travels as a value
        because it is its publisher's own name for it; the German „Pkt." and
        the whole sentence around it belong to the frontend.
        """
        turn_status.emit_retrieval(
            [{"name": "read_passage", "args": {"document": "OIB-Richtlinie 2", "punkt": "3.5.2"}}],
            round_index=1,
        )
        payload = _live(steps)[0]
        assert payload.key == "status.retrieval.punkt"
        assert payload.values == {"document": "OIB-Richtlinie 2", "punkt": "3.5.2"}
        assert payload.tools == ["read_passage"]

    def test_a_page_locator_uses_its_own_key(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "read_passage", "args": {"document": "Brandschutzkonzept.pdf", "page": 12}}],
            round_index=1,
        )
        payload = _live(steps)[0]
        assert payload.key == "status.retrieval.page"
        assert payload.values == {"document": "Brandschutzkonzept.pdf", "page": "12"}

    def test_the_locator_is_a_retrieval_round_of_the_spine(self, steps) -> None:
        """It reads evidence, so it is a layer — and it stamps the round."""
        assert turn_status.is_retrieval_round([{"name": "read_passage", "args": {"document": "x", "punkt": "1"}}])
        assert (
            turn_status.emit_retrieval(
                [{"name": "read_passage", "args": {"document": "x", "punkt": "1"}}], round_index=3
            )
            is True
        )
        assert turn_status.current_retrieval_round() == 3

    def test_a_document_name_never_outgrows_its_slot(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "read_passage", "args": {"document": "Sehr langer Dokumentname " * 6, "punkt": "1"}}],
            round_index=0,
        )
        assert len(_live(steps)[0].values["document"]) <= turn_status.MAX_DOCUMENT_CHARS

    def test_a_round_that_also_searched_shows_the_search_query(self, steps) -> None:
        """The reader's own words beat an address they never typed.

        A locator-only round is the one this tool exists for; a mixed round is
        still a search, and the query is the thing they can still say no to.
        """
        turn_status.emit_retrieval(
            [
                {"name": "read_passage", "args": {"document": "OIB-Richtlinie 2", "punkt": "3.5.2"}},
                {"name": "knowledge_search", "args": {"query": "Fluchtweglänge GK4"}},
            ],
            round_index=0,
        )
        payload = _live(steps)[0]
        assert payload.key == "status.retrieval.withQuery"
        assert payload.values["query"] == "Fluchtweglänge GK4"

    def test_a_locator_call_naming_nothing_falls_back_to_the_plain_line(self, steps) -> None:
        """Never a template with a hole in it — and never the document name
        quoted as if it were the reader's search string."""
        turn_status.emit_retrieval([{"name": "read_passage", "args": {"document": "OIB 2"}}], round_index=0)
        payload = _live(steps)[0]
        assert payload.key == "status.retrieval.plain"
        assert payload.values == {"corpus": "knowledge"}

    def test_loading_a_skill_is_not_a_retrieval(self, steps) -> None:
        """The skills substrate narrates that itself, with the skill's human title."""
        turn_status.emit_retrieval([{"name": "use_skill", "args": {"skill_name": "x"}}], round_index=0)
        turn_status.emit_retrieval([], round_index=1)
        turn_status.emit_retrieval(None, round_index=2)
        assert steps == []

    def test_an_interaction_tool_says_what_it_does(self, steps) -> None:
        turn_status.emit_retrieval([{"name": "remember", "args": {"text": "Dachneigung 30°"}}], round_index=0)
        assert _live(steps)[0].key == "status.action.remember"

    def test_each_file_verb_says_which_one_it_was(self, steps) -> None:
        """One key per verb: „Entwurf wird geschrieben" is not „wird gelesen"."""
        verbs = {
            "ls": "status.action.draftList",
            "read_file": "status.action.draftRead",
            "write_file": "status.action.draftWrite",
            "edit_file": "status.action.draftEdit",
        }
        for index, (verb, key) in enumerate(verbs.items()):
            turn_status.emit_retrieval([{"name": verb, "args": {"file_path": "/entwuerfe/a.md"}}], round_index=index)
        assert [payload.key for payload in _live(steps)] == list(verbs.values())

    def test_a_file_verb_is_an_action_and_never_a_retrieval(self, steps) -> None:
        """Nothing in the working directory is evidence, so nothing there is "searched".

        The line also carries no ``values``: the file path is the model's own
        invented slug and the query slot belongs to the reader's words.
        """
        turn_status.emit_retrieval(
            [{"name": "write_file", "args": {"file_path": "/entwuerfe/aktenvermerk.md", "content": "# A"}}],
            round_index=0,
        )
        payload = _live(steps)[0]
        assert payload.key == "status.action.draftWrite"
        assert payload.values == {}

    def test_every_file_operation_shares_one_line(self, steps) -> None:
        """One key for every operation, unlike the working directory's own four.

        The card that follows says which operation on which file, in the
        reader's own words and with the buttons attached. A live line naming
        the verb again would be the card, worse and one moment earlier — what
        the line has to carry is that nothing has changed yet.
        """
        operations = ("move", "rename", "create_folder", "assign")
        for index, operation in enumerate(operations):
            turn_status.emit_retrieval(
                [{"name": "propose_file_change", "args": {"operation": operation, "document": "plan.pdf"}}],
                round_index=index,
            )
        keys = [payload.key for payload in _live(steps)]
        assert keys == ["status.action.fileProposal"] * len(operations)

    def test_handing_the_work_over_says_so(self, steps) -> None:
        """``create_task`` gets its own line, not one of the draft verbs.

        What the reader is being told is that THIS turn will not produce the
        answer — something outside the conversation will.
        """
        turn_status.emit_retrieval(
            [{"name": "create_task", "args": {"title": "Fluchtwege prüfen"}}],
            round_index=0,
        )
        payload = _live(steps)[0]
        assert payload.key == "status.action.taskCreated"
        assert payload.values == {}

    def test_a_file_proposal_is_an_action_and_never_a_retrieval(self, steps) -> None:
        """Nothing is being read: the file name is a name the reader gave, not a query."""
        turn_status.emit_retrieval(
            [
                {
                    "name": "propose_file_change",
                    "args": {"operation": "move", "document": "Brandschutzplan.pdf", "target_folder": "Einreichung"},
                }
            ],
            round_index=0,
        )
        payload = _live(steps)[0]
        assert payload.key == "status.action.fileProposal"
        assert payload.values == {}

    def test_remember_does_not_steal_the_next_search_slot(self, steps) -> None:
        """``status:retrieval:N`` is the spine. remember used to occupy it."""
        assert turn_status.emit_retrieval([{"name": "remember", "args": {"text": "x"}}], round_index=0) is False
        assert (
            turn_status.emit_retrieval(
                [{"name": "knowledge_search_tool", "args": {"query": "q"}}],
                round_index=0,
            )
            is True
        )
        assert _started(steps, "status:action") + _started(steps, "status:retrieval") == [
            "status:action:remember",
            "status:retrieval:0",
        ]
        # The agent-node set. Harmless and kept, but NOT what stamps a hit: the
        # tools node runs in its own copied context and sets its own — see
        # ``turn_status.retrieval_round_scope`` and
        # ``tests/aiq_agent/agents/piloti/test_retrieval_rounds_spine.py``.
        assert turn_status.current_retrieval_round() == 0

    def test_a_conclusion_travels_as_reason_not_as_a_value(self, steps) -> None:
        """The Herleitung checkpoint is the model's own words.

        Same discipline as escalation: it has a language, so it is not a
        live-line value. Absent when the model skipped Thought.
        """
        turn_status.emit_retrieval(
            [{"name": "knowledge_search_tool", "args": {"query": "Fluchtweglänge GK4"}}],
            round_index=0,
            conclusion="Fluchtweglänge hängt an Nutzung, GK und dem Treppenraum.",
        )
        payload = _live(steps)[0]
        assert payload.reason == "Fluchtweglänge hängt an Nutzung, GK und dem Treppenraum."
        assert "reason" not in payload.values
        assert "text" not in payload.model_dump()

        turn_status.emit_retrieval(
            [{"name": "knowledge_search_tool", "args": {"query": "x"}}],
            round_index=1,
            conclusion="   ",
        )
        assert _live(steps)[1].reason is None

    def test_a_tool_we_cannot_name_says_NOTHING(self, steps) -> None:
        """The only thing left to say about it is its internal name.

        An identifier dressed up as a status is exactly the noise this whole
        module exists to remove — and it would be an English-looking identifier
        in a German UI and a German-looking one in an English UI.
        """
        turn_status.emit_retrieval([{"name": "sql_probe_v2", "args": {"q": "x"}}], round_index=0)
        assert steps == []


class TestCheckpointIsCountable:
    """The Herleitung layer is drawn per round; its BODY only sometimes exists.

    The body is the model's own Thought, and tool-calling models often write
    none. Whether the spine reads as reasoning or as a list of empty headers is
    therefore a RATE, and before this event nothing could measure it: the
    conclusion travels as ``reason`` on a live event, so counting its absence
    meant reading the reader's text out of traces.
    """

    def test_a_search_round_records_that_its_checkpoint_has_a_body(self, steps) -> None:
        turn_status.emit_retrieval(
            [{"name": "knowledge_search_tool", "args": {"query": "Fluchtweg"}}],
            round_index=0,
            conclusion="Die Grundregel steht.",
        )
        (record,) = _technical(steps)
        assert record.detail["round"] == 0
        assert record.detail["hasConclusion"] is True
        assert _started(steps, "status:checkpoint") == ["status:checkpoint:0"]

    def test_a_round_the_model_wrote_no_thought_for_records_the_absence(self, steps) -> None:
        turn_status.emit_retrieval([{"name": "knowledge_search_tool", "args": {"query": "q"}}], round_index=1)
        turn_status.emit_retrieval(
            [{"name": "knowledge_search_tool", "args": {"query": "q"}}],
            round_index=2,
            conclusion="   ",
        )
        assert [(r.detail["round"], r.detail["hasConclusion"]) for r in _technical(steps)] == [(1, False), (2, False)]

    def test_it_counts_nothing_the_reader_wrote(self, steps) -> None:
        """A boolean and an index. Never the sentence, in any language."""
        turn_status.emit_retrieval(
            [{"name": "knowledge_search_tool", "args": {"query": "Fluchtweglänge GK4"}}],
            round_index=0,
            conclusion="Fluchtweglänge hängt an Nutzung und Geschoss.",
        )
        (record,) = _technical(steps)
        assert set(record.detail) == {"round", "hasConclusion", "source"}
        assert record.channel == turn_status.CHANNEL_TECHNICAL
        assert "Fluchtweg" not in record.model_dump_json()

    def test_the_argument_beats_the_prose(self, steps) -> None:
        """The whole point of the slot.

        A model that fills the declared argument AND narrates has said the same
        thing twice; the argument is what the prompt asked for, so it is what
        the spine renders and what the rate counts.
        """
        turn_status.emit_retrieval(
            [
                {
                    "name": "knowledge_search",
                    "args": {"query": "Fluchtweg", "conclusion": "Die Grundregel steht; offen ist der GK."},
                }
            ],
            round_index=0,
            conclusion="Prosa, die das Modell nebenher geschrieben hat.",
        )
        (line,) = _live(steps)
        assert line.reason == "Die Grundregel steht; offen ist der GK."
        (record,) = _technical(steps)
        assert (record.detail["hasConclusion"], record.detail["source"]) == (True, turn_status.CHECKPOINT_FROM_ARGUMENT)

    def test_prose_still_carries_a_round_that_filled_no_argument(self, steps) -> None:
        """The fallback is not decoration: a deployment pinned to an older
        prompt has only this channel, and it must not lose its checkpoints."""
        turn_status.emit_retrieval(
            [{"name": "knowledge_search", "args": {"query": "Fluchtweg"}}],
            round_index=0,
            conclusion="Ich brauche zuerst die Grundregel.",
        )
        (line,) = _live(steps)
        assert line.reason == "Ich brauche zuerst die Grundregel."
        (record,) = _technical(steps)
        assert (record.detail["hasConclusion"], record.detail["source"]) == (True, turn_status.CHECKPOINT_FROM_PROSE)

    def test_an_empty_first_call_is_recorded_as_no_body_at_all(self, steps) -> None:
        """What the prompt asks for on the FIRST call: nothing is known yet, so
        the slot is left empty rather than filled with a restated question."""
        turn_status.emit_retrieval(
            [{"name": "knowledge_search", "args": {"query": "Fluchtweg", "conclusion": "   "}}],
            round_index=0,
        )
        (line,) = _live(steps)
        assert line.reason is None
        (record,) = _technical(steps)
        assert (record.detail["hasConclusion"], record.detail["source"]) == (False, turn_status.CHECKPOINT_FROM_NONE)

    def test_a_parallel_batch_takes_the_first_conclusion_it_finds(self, steps) -> None:
        """One round is one checkpoint, however many calls it fans out into."""
        turn_status.emit_retrieval(
            [
                {"name": "knowledge_search", "args": {"query": "a", "conclusion": ""}},
                {"name": "ris_search_tool", "args": {"query": "b", "conclusion": "Beide Korpora, ein Schluss."}},
            ],
            round_index=0,
        )
        assert len(_technical(steps)) == 1
        assert _live(steps)[0].reason == "Beide Korpora, ein Schluss."

    def test_the_conclusion_is_never_quoted_back_as_the_query(self, steps) -> None:
        """`_query_text` falls back to the first non-empty string argument, and
        the checkpoint is the longest string a retrieval call carries — so
        without the exclusion the model's own reasoning appears on the live line
        as if it were what the reader asked for."""
        turn_status.emit_retrieval(
            [{"name": "surface_documents", "args": {"conclusion": "Ich brauche den Plan."}}],
            round_index=0,
        )
        payload = _live(steps)[0]
        assert payload.key == "status.retrieval.plain"
        assert "query" not in payload.values

    def test_an_action_round_draws_no_checkpoint(self, steps) -> None:
        """``remember`` / ``emit_card`` are not layers of the spine."""
        turn_status.emit_retrieval([{"name": "remember", "args": {"text": "x"}}], round_index=0)
        assert _technical(steps) == []

    def test_successive_rounds_each_leave_their_own_record(self, steps) -> None:
        """One step id per round, like ``status:retrieval:N`` and for the same
        reason: two steps sharing an id collapse into one row, and a
        three-round spine reporting one checkpoint is not a rate."""
        for index in (0, 1, 2):
            turn_status.emit_retrieval(
                [{"name": "knowledge_search_tool", "args": {"query": "q"}}],
                round_index=index,
                conclusion="etwas" if index == 1 else None,
            )
        assert _started(steps, "status:checkpoint") == [
            "status:checkpoint:0",
            "status:checkpoint:1",
            "status:checkpoint:2",
        ]
        assert [r.detail["hasConclusion"] for r in _technical(steps)] == [False, True, False]


class TestEscalation:
    def test_the_line_says_why_in_the_readers_terms(self, steps) -> None:
        turn_status.emit_escalation("Shallow agent emitted insufficiency marker")
        payload = _live(steps)[0]
        assert payload.key == "status.escalation"
        # The internal marker string is telemetry, never the sentence.
        assert payload.values == {}
        assert payload.detail == {"reason": "Shallow agent emitted insufficiency marker"}


class TestSynthesis:
    def test_the_line_marks_the_answer_being_written(self, steps) -> None:
        turn_status.emit_synthesis()
        payload = _live(steps)[0]
        assert payload.key == "status.synthesis"
        # Value-less on purpose: what is being written is the reader's answer,
        # and quoting it back as a status would be the model narrating itself.
        assert payload.values == {}


class TestTheSubjectDocument:
    """Read as bytes because retrieval cannot see it — telemetry, not a line."""

    def test_it_is_a_technical_record_with_no_key(self) -> None:
        step = turn_status.subject_document_step(
            loaded=True, document_id="doc-9", version_id="ver-9", state="draft", path="/entwuerfe/Befund.md", chars=42
        )
        # No key, therefore no dictionary entry, therefore nothing rendered on
        # the live line: the reader is already looking at the file it names.
        assert step == StatusStep(
            id="status:documents:subject",
            slot="documents:subject",
            channel="technical",
            detail={
                "loaded": True,
                "document_id": "doc-9",
                "version_id": "ver-9",
                "state": "draft",
                "path": "/entwuerfe/Befund.md",
                "chars": 42,
            },
        )

    def test_a_miss_carries_a_stable_reason_and_omits_what_is_absent(self) -> None:
        """An operator counting misses by reason must not tell "no state" from "state: None"."""
        step = turn_status.subject_document_step(
            loaded=False, version_id="ver-9", reason=turn_status.SUBJECT_UNREACHABLE
        )
        assert step.detail == {"loaded": False, "version_id": "ver-9", "reason": "unreachable"}

    def test_it_is_its_own_slot(self) -> None:
        """Sharing ``documents`` would replace the shelf line the reader was just shown."""
        assert turn_status.subject_document_step(loaded=True).id != turn_status.documents_loading_step(["project"]).id


class TestChannels:
    def test_every_status_here_is_addressed_to_the_reader(self, steps) -> None:
        turn_status.emit_retrieval([{"name": "knowledge_search_tool", "args": {"query": "q"}}], round_index=0)
        turn_status.emit_citation_check(source_count=3)
        turn_status.emit_escalation(None)

        payloads = [turn_status.documents_loading_step(["project"]), *_live(steps)]
        assert [payload.kind for payload in payloads] == ["status", "retrieval", "status", "status"]
        for payload in payloads:
            assert getattr(payload, "channel", "live") == turn_status.CHANNEL_LIVE
            assert payload.key in turn_status.ALL_STATUS_KEYS


# --- The point of the change ------------------------------------------------

#: A key or an enum id: ASCII, no spaces, dot/underscore/comma separated. Every
#: product-authored string on the wire has to look like this, because anything
#: that does not is prose — and prose has a language.
_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*(?:[._,][A-Za-z0-9]+)*$")

#: Value names whose content is NOT ours: the reader's own query echoed back,
#: the tenant's authored skill title, and — on a locator line — the document's
#: own name plus the number the corpus gives the passage. Each is the same
#: string in every locale by definition (a proper noun, or a figure), so they
#: are exempt from the id rule — and every OTHER value must be an id.
_ECHOED_BACK = {"query", "skill", "document", "punkt", "page"}

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


def _every_live_payload(steps) -> list:
    """One of every live step this repo can produce, the setup phase's included."""
    setup = [
        turn_status.documents_loading_step(["archiv"]),
        turn_status.documents_loading_step(["project"]),
        turn_status.documents_loading_step(["session"]),
        turn_status.documents_loading_step(["archiv", "project"]),
        turn_status.documents_waiting_step(file_count=1),
    ]
    turn_status.emit_retrieval(
        [
            {"name": "knowledge_search_tool", "args": {"query": "Fluchtweglänge GK4"}},
            {"name": "ris_search_tool", "args": {"query": "Fluchtweglänge GK4"}},
        ],
        round_index=0,
    )
    turn_status.emit_retrieval([{"name": "web_search_tool", "args": {}}], round_index=1)
    turn_status.emit_retrieval(
        [{"name": "read_passage", "args": {"document": "OIB-Richtlinie 2", "punkt": "3.5.2"}}],
        round_index=4,
    )
    turn_status.emit_retrieval(
        [{"name": "read_passage", "args": {"document": "Brandschutzkonzept.pdf", "page": 12}}],
        round_index=5,
    )
    turn_status.emit_retrieval([{"name": "remember", "args": {"text": "x"}}], round_index=2)
    turn_status.emit_retrieval([{"name": "emit_card", "args": {"kind": "x"}}], round_index=3)
    turn_status.emit_retrieval([{"name": "ls", "args": {"path": "/entwuerfe/"}}], round_index=4)
    turn_status.emit_retrieval([{"name": "read_file", "args": {"file_path": "/entwuerfe/a.md"}}], round_index=5)
    turn_status.emit_retrieval([{"name": "write_file", "args": {"file_path": "/entwuerfe/a.md"}}], round_index=6)
    turn_status.emit_retrieval([{"name": "edit_file", "args": {"file_path": "/entwuerfe/a.md"}}], round_index=7)
    turn_status.emit_retrieval(
        [{"name": "propose_file_change", "args": {"operation": "move", "document": "plan.pdf"}}],
        round_index=8,
    )
    turn_status.emit_retrieval(
        [{"name": "file_draft", "args": {"path": "/entwuerfe/a.md"}}],
        round_index=9,
    )
    turn_status.emit_retrieval(
        [{"name": "file_draft", "args": {"path": "/entwuerfe/a.md", "submit": True}}],
        round_index=10,
    )
    turn_status.emit_retrieval(
        [{"name": "create_task", "args": {"title": "Fluchtwege prüfen"}}],
        round_index=11,
    )
    turn_status.emit_retrieval_requery(query_count=2)
    turn_status.emit_citation_check(source_count=3)
    turn_status.emit_answer_repair(quotes=1)
    turn_status.emit_escalation("Shallow agent emitted insufficiency marker")
    turn_status.emit_synthesis()
    return [*setup, *_live(steps)]


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
            assert _ID_RE.match(payload.key), payload.key
            for name, value in payload.values.items():
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
            visible = " ".join([payload.key, *(v for k, v in payload.values.items() if k not in _ECHOED_BACK)]).lower()
            for word in _GERMAN_WORDS:
                assert word not in f" {visible} ", f"{word!r} leaked into {payload['key']}"

    def test_every_key_emitted_is_one_the_frontend_declares(self, steps) -> None:
        """The registry is what the UI test reads to check both dictionaries.

        A key emitted but not registered is a blank live line in production and
        nothing anywhere that says why.
        """
        emitted = {payload.key for payload in _every_live_payload(steps)}
        assert emitted <= set(turn_status.ALL_STATUS_KEYS)
        # And the registry claims nothing it cannot produce: every id in it is
        # reachable from the calls above.
        assert set(turn_status.ALL_STATUS_KEYS) == emitted

    def test_the_two_registries_do_not_overlap(self) -> None:
        assert not set(turn_status.ALL_STATUS_KEYS) & set(ALL_SKILL_KEYS)


class TestTheRepairRecordCarriesItsCounts:
    """`status:repair` is the reader's line AND the Herleitung's detail.

    One step, because the same id replaces the row: a second
    ``status:repair`` on the technical channel would cost one of the two — on
    exactly the turns that had a repair. So the counts ride the live record as
    detail, which is what ``emit_status``'s ``detail`` is for.
    """

    def test_one_step_named_status_repair(self, steps) -> None:
        turn_status.emit_answer_repair(quotes=1)
        assert {step.id for step in steps.steps} == {"status:repair"}

    def test_the_count_is_the_camel_case_the_detail_panel_reads(self, steps) -> None:
        turn_status.emit_answer_repair(quotes=1)
        payload = _live(steps)[0]
        # A removed citation is no longer repaired, so it is no longer counted here.
        assert payload.detail == {"quotesFailed": 1}

    def test_the_line_still_resolves_for_the_reader(self, steps) -> None:
        """The record is detail; the sentence is still a dictionary id."""
        turn_status.emit_answer_repair(quotes=1)
        payload = _live(steps)[0]
        assert payload.key == turn_status.KEY_REPAIR
        assert payload.values == {}


def _search_calls():
    """A knowledge search batch."""
    return [{"name": "knowledge_search", "args": {"query": "Fluchtweglänge GK4"}}]


def _open_calls():
    """A read_passage batch opening one named Punkt."""
    return [{"name": "read_passage", "args": {"document": "oib-rl_2.pdf", "punkt": "3.5.2"}}]


class TestRoundAnnouncementMirrorsTheLiveFrame:
    """The stored half of ``emit_retrieval``: same parsing, no second derivation.

    The live frame and this record are two renderings of one batch of calls.
    If either ever parses differently, the Herleitung spine (built from the
    ledger) and the live line (built from the frame) describe different
    rounds — so the interesting assertions here are the PARITY ones.
    """

    def test_a_search_round_records_its_facts_and_no_guessed_purpose(self) -> None:
        """Query, tools, corpora and key are recorded; nothing is guessed."""
        record = turn_status.record_round_announcement(round_index=0, calls=_search_calls(), conclusion=None)
        assert record == {
            "index": 0,
            "key": turn_status.KEY_RETRIEVAL_WITH_QUERY,
            "tools": ["knowledge_search"],
            "corpora": ["knowledge"],
            "query": "Fluchtweglänge GK4",
        }

    def test_a_locator_round_records_its_key(self) -> None:
        """A locator round keeps its punkt key, not the search template."""
        record = turn_status.record_round_announcement(round_index=1, calls=_open_calls(), conclusion=None)
        assert record is not None
        assert record["key"] == turn_status.KEY_RETRIEVAL_PUNKT
        assert record["tools"] == ["read_passage"]

    def test_action_batches_and_empties_record_nothing(self) -> None:
        """Action batches and empty batches record nothing, like the counter skips them."""
        assert (
            turn_status.record_round_announcement(
                round_index=0,
                calls=[{"name": "remember", "args": {}}],
                conclusion=None,
            )
            is None
        )
        assert turn_status.record_round_announcement(round_index=0, calls=[], conclusion=None) is None

    def test_the_reason_is_the_ranked_checkpoint_clipped_like_the_frame(self, steps) -> None:
        calls = [
            {
                "name": "knowledge_search",
                "args": {"query": "q", "conclusion": "Die Grundregel steht."},
            }
        ]
        record = turn_status.record_round_announcement(round_index=0, calls=calls, conclusion="Prose beside the calls.")
        assert record is not None
        assert record["reason"] == "Die Grundregel steht."
        turn_status.emit_retrieval(calls, round_index=0, conclusion="Prose beside the calls.")
        assert _live(steps)[0].reason == record["reason"]

    def test_record_covers_exactly_the_batches_the_counter_skips(self) -> None:
        """Parity with the round counter: record None ⟺ emit False."""
        batches = [
            _search_calls(),
            _open_calls(),
            [{"name": "remember", "args": {}}],
            [{"name": "acme_custom_tool", "args": {}}],
            [],
        ]
        for index, calls in enumerate(batches):
            record = turn_status.record_round_announcement(round_index=index, calls=calls, conclusion=None)
            assert (record is None) == (not turn_status.emit_retrieval(calls, round_index=99))


class TestLaneCaptureKeepsRoundsApart:
    """Per-round hits for the ledger, read off the same stamp the block gets."""

    def test_hits_land_with_the_current_round(self) -> None:
        """Hits land stamped with the round active when recorded."""
        token = turn_status.begin_lane_capture()
        try:
            with turn_status.retrieval_round_scope(0):
                turn_status.record_lane_hit("oib-rl_2.pdf", title="OIB-RL 2", detail="p.12")
            with turn_status.retrieval_round_scope(1):
                turn_status.record_lane_hit("oib-rl_2.pdf", title="OIB-RL 2", detail="p.31")
            hits = turn_status.get_lane_captures()
        finally:
            turn_status.end_lane_capture(token)
        assert [(hit["round"], hit["name"], hit.get("detail")) for hit in hits] == [
            (0, "oib-rl_2.pdf", "p.12"),
            (1, "oib-rl_2.pdf", "p.31"),
        ]

    def test_capture_is_scoped_and_best_effort(self) -> None:
        """Capture is silent outside its window and bounded inside it."""
        turn_status.record_lane_hit("x.pdf")
        assert turn_status.get_lane_captures() == []
        token = turn_status.begin_lane_capture()
        try:
            turn_status.record_lane_hit("  ")
            turn_status.record_lane_hit("x.pdf")
            assert [hit["name"] for hit in turn_status.get_lane_captures()] == ["x.pdf"]
        finally:
            turn_status.end_lane_capture(token)
        assert turn_status.get_lane_captures() == []
        turn_status.record_lane_hit("y.pdf")
        assert turn_status.get_lane_captures() == []


class TestTheFetchFailureMarker:
    """A result that is a failure must be distinguishable from a fetch.

    Both retrieval tools answer an unreachable store with PROSE asking the
    model to retry the identical call. The duplicate-fetch guard withholds
    exactly that call and says the answer is already above — true for a fetch
    that returned, a lie for one that never ran. The marker is what tells the
    two apart at the one place that has to know.
    """

    def test_the_marker_is_a_stable_prefix_both_tools_can_write(self) -> None:
        assert turn_status.FETCH_FAILED_MARKER == "[fetch failed]"

    def test_both_retrieval_tools_start_their_failure_string_with_it(self) -> None:
        from knowledge_layer.read_passage import _store_silent_message

        assert _store_silent_message("OIB-Richtlinie 2, Pkt. 3.5.2").startswith(turn_status.FETCH_FAILED_MARKER)
        # The search side is asserted through the agent's graph
        # (`test_repeat_fetch_guard.py`), where the string is produced inside
        # the tool's own except branch.


class TestFetchSignature:
    """What a call FETCHES, as one comparable id.

    The atom under the duplicate-fetch guard. It lives here because this module
    already owns what the retrieval tools' arguments mean, and two readings of
    ``document``/``punkt``/``page`` would drift apart without anything failing.

    The rule it encodes: two calls share a signature when they would return the
    same bytes. Everything that changes WHICH passage comes back — a page, a
    ``file_name``, a ``folder`` — is part of the identity; everything that is
    only how the model typed it — case, whitespace, a trailing dot on a
    Punkt — is not.
    """

    def test_a_search_folds_case_and_whitespace_in_the_query(self) -> None:
        first = turn_status.fetch_signature({"name": "knowledge_search", "args": {"query": "Fluchtweglänge GK4"}})
        second = turn_status.fetch_signature({"name": "knowledge_search", "args": {"query": "  fluchtweglänge   gk4 "}})
        assert first is not None
        assert first == second

    def test_a_narrowing_argument_is_part_of_the_identity(self) -> None:
        """Same words against another file are another corpus and another answer."""
        plain = turn_status.fetch_signature({"name": "knowledge_search", "args": {"query": "Fluchtweg"}})
        narrowed = turn_status.fetch_signature(
            {"name": "knowledge_search", "args": {"query": "Fluchtweg", "file_name": "Brandschutz.pdf"}}
        )
        foldered = turn_status.fetch_signature(
            {"name": "knowledge_search", "args": {"query": "Fluchtweg", "folder": "Brandschutz"}}
        )
        assert len({plain, narrowed, foldered}) == 3

    def test_a_file_name_is_matched_case_insensitively(self) -> None:
        upper = turn_status.fetch_signature(
            {"name": "knowledge_search", "args": {"query": "q", "file_name": "Brandschutz.PDF"}}
        )
        lower = turn_status.fetch_signature(
            {"name": "knowledge_search", "args": {"query": "q", "file_name": " brandschutz.pdf"}}
        )
        assert upper == lower

    def test_filters_compare_by_content_and_not_by_key_order(self) -> None:
        one = turn_status.fetch_signature(
            {"name": "knowledge_search", "args": {"query": "q", "filters": {"a": 1, "b": 2}}}
        )
        other = turn_status.fetch_signature(
            {"name": "knowledge_search", "args": {"query": "q", "filters": {"b": 2, "a": 1}}}
        )
        unfiltered = turn_status.fetch_signature({"name": "knowledge_search", "args": {"query": "q"}})
        assert one == other
        assert one != unfiltered

    def test_an_empty_narrowing_is_the_same_as_none(self) -> None:
        """A model that fills the slot with "" narrowed nothing."""
        blank = turn_status.fetch_signature(
            {"name": "knowledge_search", "args": {"query": "q", "doc_class": "  ", "filters": {}}}
        )
        assert blank == turn_status.fetch_signature({"name": "knowledge_search", "args": {"query": "q"}})

    def test_a_punkt_is_the_same_point_with_or_without_its_trailing_dot(self) -> None:
        """The Richtlinien print both, and so does the model."""
        dotted = turn_status.fetch_signature(
            {"name": "read_passage", "args": {"document": "OIB-Richtlinie 2", "punkt": "3.5.2."}}
        )
        plain = turn_status.fetch_signature(
            {"name": "read_passage", "args": {"document": " oib-richtlinie 2 ", "punkt": "3.5.2"}}
        )
        assert dotted is not None
        assert dotted == plain

    def test_another_page_of_one_document_is_another_passage(self) -> None:
        twelve = turn_status.fetch_signature({"name": "read_passage", "args": {"document": "plan.pdf", "page": 12}})
        as_text = turn_status.fetch_signature({"name": "read_passage", "args": {"document": "plan.pdf", "page": "12"}})
        thirteen = turn_status.fetch_signature({"name": "read_passage", "args": {"document": "plan.pdf", "page": 13}})
        assert twelve == as_text
        assert twelve != thirteen

    def test_a_group_qualified_tool_name_still_signs(self) -> None:
        assert turn_status.fetch_signature(
            {"name": "mcp__knowledge_search", "args": {"query": "q"}}
        ) == turn_status.fetch_signature({"name": "knowledge_search", "args": {"query": "q"}})

    def test_every_other_tool_is_never_guarded(self) -> None:
        """Two cards are two cards; two measurements are not the same bytes."""
        for name in ("emit_card", "remember", "ris_search_tool", "web_search_tool", "ifc_measure", "use_skill"):
            assert turn_status.fetch_signature({"name": name, "args": {"query": "q"}}) is None

    def test_a_call_it_cannot_read_is_not_signed(self) -> None:
        """A guard that cannot read a call must not take it away."""
        assert turn_status.fetch_signature({"name": "knowledge_search"}) is None
        assert turn_status.fetch_signature({"name": "knowledge_search", "args": "query=q"}) is None
        assert turn_status.fetch_signature("knowledge_search") is None


class TestTheRepeatFetchRecord:
    """The duplicate-fetch guard's own technical record.

    Its own slot per round, like ``status:checkpoint:N``: a turn that re-asked
    in three rounds must leave three countable records, and two steps sharing a
    id collapse into one row. No ``key``, because
    whether the reader is told is a product decision and shipping a live key
    would make it silently.
    """

    def test_it_never_reaches_the_live_line(self, steps) -> None:
        turn_status.emit_repeat_fetch(round_index=1, withheld=2)
        assert _live(steps) == []
        (payload,) = _technical(steps)
        assert payload.channel == turn_status.CHANNEL_TECHNICAL
        assert payload.key is None
        assert (payload.detail["round"], payload.detail["withheld"]) == (1, 2)

    def test_each_round_leaves_its_own_step(self, steps) -> None:
        turn_status.emit_repeat_fetch(round_index=0, withheld=1)
        turn_status.emit_repeat_fetch(round_index=1, withheld=1)
        assert _started(steps, "status:repeat") == ["status:repeat:0", "status:repeat:1"]
