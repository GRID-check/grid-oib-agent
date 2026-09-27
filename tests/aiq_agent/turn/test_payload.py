"""What one user message states about how to answer it (`turn/payload.py`).

The chat socket hands the turn the v2 `user_message` with flat, typed fields;
`nat run` and a single-shot HTTP turn hand it the question as a plain string.
"""

import pytest

from aiq_agent.common.focus_file import get_focused_file_name
from aiq_agent.common.focus_file import get_turn_shelves
from aiq_agent.common.focus_file import set_turn_intent
from aiq_agent.common.wire_v2 import UserMessage
from aiq_agent.turn import payload as payload_module
from aiq_agent.turn.payload import extract_turn_inputs


def _message(text: str = "fass zusammen", **fields) -> UserMessage:
    return UserMessage(conversation_id="c1", message_id="m1", text=text, **fields)


@pytest.fixture(autouse=True)
def _clear_intent():
    yield
    set_turn_intent()


class TestExtractTurnInputs:
    """The wire -> state lift.

    Retrieval reads the turn focus from ContextVars that this lift sets. Reading
    them was once a separate step in the register layer, ordered only by a
    comment, and nothing noticed when it was removed entirely.
    """

    def test_lifts_the_focus_from_the_message(self):
        inputs = extract_turn_inputs(_message(focus_file_name="Aufsicht.pdf", focus_shelf="project"))

        assert inputs.query_text == "fass zusammen"
        assert inputs.focus_file_name == "Aufsicht.pdf"
        assert inputs.focus_shelf == "project"

    def test_a_plain_question_is_the_whole_question_and_states_nothing_else(self):
        """`nat run`: no JSON is read out of the text, and no data source is chosen."""
        inputs = extract_turn_inputs('  {"query": "x", "data_sources": ["web_search"]}  ')

        assert inputs.query_text == '{"query": "x", "data_sources": ["web_search"]}'
        assert inputs.data_sources is None
        assert inputs.focus_file_name is None

    def test_anything_else_is_refused(self):
        with pytest.raises(TypeError):
            extract_turn_inputs({"content": {"messages": [{"role": "user", "content": "x"}]}})

    def test_a_turn_without_a_subject_clears_the_previous_one(self):
        """The vars outlive one turn; a plain message must not inherit a subject."""
        extract_turn_inputs(_message(focus_file_name="Aufsicht.pdf"))
        inputs = extract_turn_inputs(_message("welche OIB-Richtlinien gelten in Wien?"))

        assert inputs.focus_file_name is None
        assert inputs.focus_shelf is None
        extract_turn_inputs(_message(focus_file_name="Aufsicht.pdf"))
        assert extract_turn_inputs("und jetzt?").focus_file_name is None

    def test_the_selection_of_data_sources_comes_through_even_when_empty(self):
        assert extract_turn_inputs(_message(data_sources=["web_search"])).data_sources == ["web_search"]
        assert extract_turn_inputs(_message()).data_sources == []
        assert "skills" not in extract_turn_inputs(_message())._fields

    def test_the_intent_is_set_for_retrieval_by_the_lift(self):
        extract_turn_inputs(_message(focus_file_name="Protokoll.pdf", focus_shelf="session"))
        assert get_focused_file_name() == "Protokoll.pdf"
        # `base` rides along with every subject shelf: a subject narrows which
        # documents the turn reads, not whether the law applies.
        assert get_turn_shelves() == frozenset({"session", "base"})

        extract_turn_inputs(_message(source_preset="law"))
        assert get_turn_shelves() == frozenset({"base"})

    def test_a_failure_to_set_the_focus_raises_instead_of_leaking_the_last_turn(self, monkeypatch):
        def broken(**_kw):
            raise RuntimeError("focus store gone")

        monkeypatch.setattr(payload_module, "set_turn_intent", broken)
        with pytest.raises(RuntimeError, match="focus store gone"):
            extract_turn_inputs(_message(focus_file_name="a.pdf"))


class TestTheSubjectVersion:
    """What the composer says about the subject's OPEN version, and only that."""

    def test_it_travels_beside_the_focus_file_name(self):
        inputs = extract_turn_inputs(
            _message(
                focus_file_name="Befund.md",
                focus_document_id="doc-9",
                focus_version_id="ver-9",
                focus_version_state="draft",
            )
        )

        assert (inputs.subject.document_id, inputs.subject.version_id, inputs.subject.state) == (
            "doc-9",
            "ver-9",
            "draft",
        )
        assert inputs.subject.is_open

    def test_an_ordinary_message_names_no_subject_version(self):
        assert not extract_turn_inputs(_message()).subject.is_open

    def test_an_incomplete_triple_is_not_open(self):
        assert not extract_turn_inputs(_message(focus_document_id="doc-9", focus_version_state="draft")).subject.is_open

    def test_a_plain_turn_does_not_inherit_the_previous_ones_subject(self):
        extract_turn_inputs(_message(focus_document_id="d", focus_version_id="v", focus_version_state="draft"))

        assert not extract_turn_inputs(_message("und jetzt?")).subject.is_open
