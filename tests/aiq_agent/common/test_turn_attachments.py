"""Tests for the per-turn session-attachment signal (issue #429).

Covers the wire parser, the ContextVar's clearing contract, and — the thing
nothing tested before — that a value set at the top of the turn is actually
visible to the concurrent work the turn fans out into.
"""

import asyncio

from aiq_agent.agents.chat_researcher.utils import _extract_query_from_text
from aiq_agent.common.focus_file import get_focused_file_name
from aiq_agent.common.turn_attachments import MAX_TURN_ATTACHMENTS
from aiq_agent.common.turn_attachments import SessionAttachment
from aiq_agent.common.turn_attachments import get_turn_attachments
from aiq_agent.common.turn_attachments import parse_turn_attachments
from aiq_agent.common.turn_attachments import set_turn_attachments


def _payload(**extra) -> str:
    import json

    return json.dumps({"query": "Fass den Inhalt zusammen", "data_sources": [], **extra})


class TestParseTurnAttachments:
    def test_parses_the_wire_shape(self):
        parsed = parse_turn_attachments(
            [
                {"file_name": "Statik.pdf", "state": "ready"},
                {"file_name": "Gross.pdf", "state": "indexing"},
            ]
        )
        assert parsed == [
            SessionAttachment(file_name="Statik.pdf", state="ready"),
            SessionAttachment(file_name="Gross.pdf", state="indexing"),
        ]

    def test_missing_or_unreadable_state_defaults_to_ready(self):
        # `ready` asks nothing of the backend; guessing `indexing` would make a
        # reader wait for something that may already be there.
        assert parse_turn_attachments([{"file_name": "a.pdf"}])[0].state == "ready"
        assert parse_turn_attachments([{"file_name": "a.pdf", "state": "hm"}])[0].state == "ready"
        assert parse_turn_attachments([{"file_name": "a.pdf", "state": 7}])[0].state == "ready"

    def test_state_is_normalized(self):
        assert parse_turn_attachments([{"file_name": "a.pdf", "state": " INDEXING "}])[0].state == "indexing"

    def test_file_name_is_trimmed(self):
        assert parse_turn_attachments([{"file_name": "  a.pdf  "}])[0].file_name == "a.pdf"

    def test_malformed_attachment_entries_are_skipped_not_raised(self):
        # Tolerance is per ENTRY: a bad frame costs the turn the entries it could
        # not read, never the turn.
        parsed = parse_turn_attachments(
            [
                "just a string",
                42,
                None,
                {},
                {"file_name": None},
                {"file_name": ""},
                {"file_name": "   "},
                {"file_name": 12},
                {"state": "ready"},
                {"file_name": "good.pdf", "state": "indexing"},
            ]
        )
        assert parsed == [SessionAttachment(file_name="good.pdf", state="indexing")]

    def test_non_list_payloads_yield_nothing_and_never_raise(self):
        for raw in (None, "Statik.pdf", 42, {"file_name": "a.pdf"}, object()):
            assert parse_turn_attachments(raw) == []

    def test_duplicate_file_names_collapse(self):
        parsed = parse_turn_attachments(
            [{"file_name": "a.pdf", "state": "indexing"}, {"file_name": "a.pdf", "state": "ready"}]
        )
        assert parsed == [SessionAttachment(file_name="a.pdf", state="indexing")]

    def test_the_array_is_capped(self):
        # The client caps too, but the backend must not trust a client-controlled
        # array length that is paid for in prompt tokens every turn.
        parsed = parse_turn_attachments([{"file_name": f"doc-{i}.pdf"} for i in range(MAX_TURN_ATTACHMENTS + 20)])
        assert len(parsed) == MAX_TURN_ATTACHMENTS
        assert parsed[0].file_name == "doc-0.pdf"


class TestTurnAttachmentContextVar:
    def test_default_is_empty(self):
        set_turn_attachments(None)
        assert get_turn_attachments() == []

    def test_set_and_get_round_trip(self):
        set_turn_attachments([SessionAttachment(file_name="a.pdf", state="indexing")])
        assert get_turn_attachments() == [SessionAttachment(file_name="a.pdf", state="indexing")]
        set_turn_attachments(None)

    def test_the_accessor_hands_out_a_copy(self):
        set_turn_attachments([SessionAttachment(file_name="a.pdf")])
        got = get_turn_attachments()
        got.append(SessionAttachment(file_name="injected.pdf"))
        assert [a.file_name for a in get_turn_attachments()] == ["a.pdf"]
        set_turn_attachments(None)


class TestExtractQuerySetsTurnAttachments:
    def setup_method(self):
        set_turn_attachments(None)

    def teardown_method(self):
        set_turn_attachments(None)

    def test_session_attachments_parsed_from_ws_payload(self):
        query, _sources, _skills = _extract_query_from_text(
            _payload(
                session_attachments=[
                    {"file_name": "Statik.pdf", "state": "ready"},
                    {"file_name": "Gross.pdf", "state": "indexing"},
                ]
            )
        )
        assert query == "Fass den Inhalt zusammen"
        assert get_turn_attachments() == [
            SessionAttachment(file_name="Statik.pdf", state="ready"),
            SessionAttachment(file_name="Gross.pdf", state="indexing"),
        ]

    def test_session_attachments_cleared_when_payload_omits_them(self):
        """A later attachment-free turn must not inherit the previous turn's scope.

        The ContextVar outlives one turn within a connection, so every path
        through the extractor has to state a value — including "none".
        """
        _extract_query_from_text(_payload(session_attachments=[{"file_name": "Statik.pdf"}]))
        assert get_turn_attachments()

        # A payload turn that says nothing about attachments.
        _extract_query_from_text(_payload())
        assert get_turn_attachments() == []

        _extract_query_from_text(_payload(session_attachments=[{"file_name": "Statik.pdf"}]))
        assert get_turn_attachments()

        # A plain-text turn (not a payload at all).
        _extract_query_from_text("Wie breit muss der Fluchtweg sein?")
        assert get_turn_attachments() == []

        _extract_query_from_text(_payload(session_attachments=[{"file_name": "Statik.pdf"}]))
        assert get_turn_attachments()

        # A turn that LOOKS like a payload but is malformed JSON. This path used
        # to return early without clearing anything.
        _extract_query_from_text('{"query": "kaputt",}')
        assert get_turn_attachments() == []

        _extract_query_from_text(_payload(session_attachments=[{"file_name": "Statik.pdf"}]))
        assert get_turn_attachments()

        # An empty turn.
        _extract_query_from_text("")
        assert get_turn_attachments() == []

    def test_malformed_attachments_do_not_kill_the_turn(self):
        query, _sources, _skills = _extract_query_from_text(_payload(session_attachments="not-a-list"))
        assert query == "Fass den Inhalt zusammen"
        assert get_turn_attachments() == []

    def test_focus_file_name_is_unchanged_without_attachments(self):
        """The existing scoping hook keeps its behaviour, and its own contract.

        Pinned because attachments deliberately do NOT extend `focus_file_name`
        and must not perturb it.
        """
        _extract_query_from_text(_payload(focus_file_name="Grundriss.pdf"))
        assert get_focused_file_name() == "Grundriss.pdf"
        assert get_turn_attachments() == []

        _extract_query_from_text(_payload())
        assert get_focused_file_name() is None

    def test_focus_and_attachments_coexist(self):
        _extract_query_from_text(
            _payload(
                focus_file_name="Grundriss.pdf",
                session_attachments=[{"file_name": "Statik.pdf", "state": "indexing"}],
            )
        )
        assert get_focused_file_name() == "Grundriss.pdf"
        assert [a.file_name for a in get_turn_attachments()] == ["Statik.pdf"]

    def test_focus_file_name_is_cleared_on_a_malformed_payload(self):
        """Regression: the malformed-JSON path used to leave the previous value.

        `focus_file_name` had the same staleness hole the attachment ContextVar
        must not have — a turn whose text merely LOOKS like JSON returned early
        and left the previous turn's focused file in place.
        """
        _extract_query_from_text(_payload(focus_file_name="Grundriss.pdf"))
        assert get_focused_file_name() == "Grundriss.pdf"

        _extract_query_from_text('{"query": "kaputt",}')
        assert get_focused_file_name() is None


class TestTurnAttachmentsPropagateThroughAsyncio:
    """The value set at the top of the turn must reach the turn's concurrent work.

    `_run` calls `_extract_query_and_sources` (register.py) BEFORE the
    `asyncio.gather` that fans out the per-turn I/O and before the graph is
    invoked. `asyncio` copies the current context into each task it creates, so a
    set in the parent coroutine propagates INTO children — but the reverse does
    not hold, and nothing tested either direction. `focus_file_name` has relied
    on this since it shipped.
    """

    def test_a_value_set_before_a_gather_is_visible_inside_it(self):
        async def reader(tag):
            await asyncio.sleep(0)
            return (tag, [a.file_name for a in get_turn_attachments()], get_focused_file_name())

        async def nested():
            # A task created INSIDE a gathered task: the tool-inside-a-node shape.
            return await asyncio.create_task(reader("nested"))

        async def main():
            # Exactly what `_run` does, in the same order.
            _extract_query_from_text(
                _payload(
                    focus_file_name="Grundriss.pdf",
                    session_attachments=[{"file_name": "Statik.pdf", "state": "indexing"}],
                )
            )
            during = await asyncio.gather(reader("a"), reader("b"), nested())

            # ...and the clearing path, so a later turn's children see nothing.
            _extract_query_from_text("Wie breit muss der Fluchtweg sein?")
            after = await asyncio.gather(reader("a2"), nested())
            return during, after

        during, after = asyncio.run(main())
        assert during == [
            ("a", ["Statik.pdf"], "Grundriss.pdf"),
            ("b", ["Statik.pdf"], "Grundriss.pdf"),
            ("nested", ["Statik.pdf"], "Grundriss.pdf"),
        ]
        assert after == [("a2", [], None), ("nested", [], None)]

    def test_a_value_set_inside_a_task_does_not_escape_it(self):
        """The constraint this design has to respect, stated as a test.

        A set inside a child task mutates that task's own context copy only. It
        is why the signal must be set in `_run` itself — as it is — and never
        from inside a node or a tool.
        """

        async def main():
            set_turn_attachments(None)

            async def leaker():
                set_turn_attachments([SessionAttachment(file_name="Leaked.pdf")])

            await asyncio.gather(leaker())
            return get_turn_attachments()

        assert asyncio.run(main()) == []
