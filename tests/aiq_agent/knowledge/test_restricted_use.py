"""A chat turn's use of restricted folders, the agent's half (ADR-0086, ADR-0087).

The BFF decides; these pin that the agent asks before anything reads the
scope, keeps only what it may draw on, admits a tool round's restricted content
before the model reads it, withholds what the BFF refuses, and fails closed.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from typing import Any

import pytest
from langchain_core.messages import ToolMessage

from aiq_agent.knowledge import restricted_use as ru
from aiq_agent.knowledge import scoping
from aiq_agent.knowledge.restricted_use import WITHHELD_NOTICE
from aiq_agent.knowledge.restricted_use import RestrictedUse
from aiq_agent.knowledge.restricted_use import admit_tool_results
from aiq_agent.knowledge.restricted_use import begin_restricted_use
from aiq_agent.knowledge.restricted_use import bind_restricted_use
from aiq_agent.knowledge.restricted_use import reset_restricted_use
from aiq_agent.knowledge.restricted_use import without_restricted
from aiq_agent.knowledge.scoping import ScopedCollection
from aiq_agent.project_context import GridRequestContext

VERTRAEGE = "proj_p1_r0123456789ab"
PERSONAL = "proj_p1_rbbbbbbbbbbbb"
SCOPE = ["oib_knowledge", "proj_p1", VERTRAEGE, PERSONAL]


class Bff:
    """The restricted-use route: what each POST asked, and what it answers."""

    def __init__(self, answer: dict[str, Any] | None) -> None:
        self.answer = answer
        self.asked: list[dict[str, Any]] = []

    def __call__(self, use: RestrictedUse, body: dict[str, Any]) -> dict[str, Any] | None:
        self.asked.append(body)
        return self.answer


@pytest.fixture
def bff(monkeypatch) -> Bff:
    route = Bff({"drawable": [], "recorded": []})
    monkeypatch.setattr(ru, "_post", route)
    return route


@contextlib.contextmanager
def bound(use: RestrictedUse | None) -> Iterator[RestrictedUse | None]:
    token = bind_restricted_use(use)
    try:
        yield use
    finally:
        reset_restricted_use(token)


def _use(drawable=(), confined=False) -> RestrictedUse:
    return RestrictedUse(
        organization_id="org",
        user_id="u1",
        conversation_id="c1",
        project_id="p1",
        drawable=set(drawable),
        confined=confined,
    )


def _request(**fields) -> GridRequestContext:
    base = {"organization_id": "org", "user_id": "u1", "project_id": "p1", "collection_scope": SCOPE}
    return GridRequestContext(**{**base, **fields})


class TestTurnStart:
    async def test_an_open_scope_asks_nobody(self, bff):
        assert await begin_restricted_use(_request(collection_scope=["proj_p1"], envelope_header="x"), "c1") is None
        assert bff.asked == []

    async def test_the_signed_scope_is_offered_and_only_what_the_bff_allows_is_drawable(self, bff):
        bff.answer = {"drawable": [VERTRAEGE, "proj_other_r000000000000"], "recorded": []}
        use = await begin_restricted_use(_request(envelope_header="x"), "c1")
        assert bff.asked == [{"candidates": [VERTRAEGE, PERSONAL]}]
        # Never more than was offered, whatever the answer says.
        assert use is not None and use.drawable == {VERTRAEGE}
        assert use.confined is False

    async def test_a_recorded_folder_confines_the_conversation(self, bff):
        bff.answer = {"drawable": [], "recorded": ["f-vertraege"]}
        use = await begin_restricted_use(_request(envelope_header="x"), "c1")
        assert use is not None and use.confined is True

    async def test_an_unreachable_bff_leaves_nothing_drawable_and_the_turn_confined(self, bff):
        bff.answer = None
        use = await begin_restricted_use(_request(envelope_header="x"), "c1")
        assert use is not None and use.drawable == set() and use.confined is True

    async def test_an_unsigned_scope_vouches_for_nothing_and_asks_nobody(self, bff):
        use = await begin_restricted_use(_request(), "c1")
        assert use is not None and use.drawable == set() and use.confined is True
        assert bff.asked == []

    async def test_no_conversation_to_record_in_draws_nothing(self, bff):
        use = await begin_restricted_use(_request(envelope_header="x"), None)
        assert use is not None and use.drawable == set()
        assert bff.asked == []


class TestTheScopeEveryReadPathTakes:
    def _entries(self, monkeypatch) -> None:
        monkeypatch.setattr(
            scoping, "_parse_scope_payload", lambda _scope: [ScopedCollection(name, None) for name in SCOPE]
        )

    def test_keeps_only_the_restricted_collections_the_turn_may_draw_on(self, monkeypatch):
        self._entries(monkeypatch)
        with bound(_use(drawable={VERTRAEGE})):
            names = [entry.collection for entry in scoping.get_scoped_collections_from_context() or []]
        assert names == ["oib_knowledge", "proj_p1", VERTRAEGE]

    def test_is_unchanged_outside_a_turn_with_restricted_scope(self, monkeypatch):
        self._entries(monkeypatch)
        with bound(None):
            names = [entry.collection for entry in scoping.get_scoped_collections_from_context() or []]
        assert names == SCOPE

    def test_listing_never_includes_a_restricted_collection(self):
        entries = [ScopedCollection(name, None) for name in SCOPE]
        assert [entry.collection for entry in without_restricted(entries)] == ["oib_knowledge", "proj_p1"]


def _result(text: str, call_id: str = "call-1") -> ToolMessage:
    return ToolMessage(content=text, tool_call_id=call_id, name="knowledge_search")


class TestAToolRoundIsAdmittedBeforeTheModelReadsIt:
    async def test_restricted_content_outside_a_restricted_turn_is_withheld_without_asking(self, bff):
        """No use bound: nothing could admit it, so it fails closed (ADR-0087)."""
        messages = [_result(f"Collection: {VERTRAEGE}\nHonorar pauschal")]
        with bound(None):
            out = await admit_tool_results(messages)
        assert out[0].content == WITHHELD_NOTICE
        assert bff.asked == []

    async def test_outside_a_restricted_turn_an_open_result_is_untouched(self, bff):
        messages = [_result("Collection: proj_p1\nPlan EG")]
        with bound(None):
            assert await admit_tool_results(messages) is messages
        assert bff.asked == []

    async def test_a_collection_the_turn_may_not_draw_on_is_withheld_without_asking(self, bff):
        """Only drawable collections are put to the BFF; any other restricted one is withheld."""
        bff.answer = {"admitted": [VERTRAEGE], "refused": []}
        personal = _result(f"Collection: {PERSONAL}\nGehalt", "call-1")
        contract = _result(f"Collection: {VERTRAEGE}\nHonorar pauschal", "call-2")
        with bound(_use(drawable={VERTRAEGE})):
            out = await admit_tool_results([personal, contract])
        assert [message.content for message in out] == [WITHHELD_NOTICE, contract.content]
        assert bff.asked == [{"admit": [VERTRAEGE]}]

    async def test_an_image_result_is_judged_by_its_text_block(self, bff):
        message = ToolMessage(
            content=[
                {"type": "text", "text": f"Uploaded image 'Gehalt.png' from collection '{PERSONAL}'"},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
            ],
            tool_call_id="call-1",
        )
        with bound(_use(drawable=set(), confined=True)):
            out = await admit_tool_results([message])
        assert out[0].content == WITHHELD_NOTICE


def _reported(text: str, collections: set[str], call_id: str = "call-1") -> ToolMessage:
    return _result(text, call_id).model_copy(
        update={"response_metadata": {ru.COLLECTIONS_READ_KEY: sorted(collections)}}
    )


class TestToolsReportWhatTheyRead:
    """The side channel: admission does not depend on a tool naming its collection in the text."""

    async def test_a_reported_read_is_admitted_though_the_text_names_no_collection(self, bff):
        bff.answer = {"admitted": [VERTRAEGE], "refused": []}
        message = _reported("Das Honorar beträgt pauschal 48.000 €.", {VERTRAEGE, "proj_p1"})
        with bound(_use(drawable={VERTRAEGE})) as use:
            assert await admit_tool_results([message]) == [message]
        assert bff.asked == [{"admit": [VERTRAEGE]}]
        assert use is not None and use.confined is True and use.admitted == {VERTRAEGE}

    async def test_a_reported_read_the_bff_refuses_is_withheld(self, bff):
        bff.answer = {"admitted": [], "refused": [VERTRAEGE]}
        message = _reported("Das Honorar beträgt pauschal 48.000 €.", {VERTRAEGE})
        with bound(_use(drawable={VERTRAEGE})):
            out = await admit_tool_results([message])
        assert out[0].content == WITHHELD_NOTICE

    async def test_a_reported_read_outside_a_restricted_turn_is_withheld(self, bff):
        message = _reported("Gehalt 182.000 EUR", {PERSONAL})
        with bound(None):
            out = await admit_tool_results([message])
        assert out[0].content == WITHHELD_NOTICE

    async def test_the_wrapper_stamps_what_the_call_noted_onto_its_result(self):
        async def execute(_request):
            ru.note_collections_read([VERTRAEGE, None, ""])
            ru.note_collections_read(["proj_p1"])
            return _result("Honorar")

        message = await ru.report_collections_read(None, execute)
        assert ru.collections_read(message) == {VERTRAEGE, "proj_p1"}
        assert message.content == "Honorar"

    async def test_a_call_that_noted_nothing_is_returned_as_it_was(self):
        original = _result("Plan EG")

        async def execute(_request):
            return original

        assert await ru.report_collections_read(None, execute) is original

    async def test_two_calls_never_share_what_they_read(self):
        import asyncio

        async def call(collection: str) -> ToolMessage:
            async def execute(_request):
                await asyncio.sleep(0)
                ru.note_collections_read([collection])
                await asyncio.sleep(0)
                return _result(collection)

            return await ru.report_collections_read(None, execute)

        first, second = await asyncio.gather(call(VERTRAEGE), call(PERSONAL))
        assert ru.collections_read(first) == {VERTRAEGE}
        assert ru.collections_read(second) == {PERSONAL}

    async def test_a_note_in_a_worker_thread_reaches_the_call(self):
        """``asyncio.to_thread`` copies the context; the set is the same object."""
        import asyncio

        async def execute(_request):
            await asyncio.to_thread(ru.note_collections_read, [VERTRAEGE])
            return _result("Honorar")

        assert ru.collections_read(await ru.report_collections_read(None, execute)) == {VERTRAEGE}

    def test_a_note_outside_any_call_is_dropped(self):
        ru.note_collections_read([VERTRAEGE])


class TestTheTextBackstop:
    @pytest.mark.parametrize(
        "text",
        [
            "Datei plan_r0123456789ab.pdf",  # a file name shaped like a suffix, no project collection
            "proj_p1 und Seite 3",
            "Collection: proj_p1_r0123",  # too short to be a folder's collection
        ],
    )
    async def test_text_that_names_no_restricted_collection_passes(self, bff, text):
        messages = [_result(text)]
        with bound(None):
            assert await admit_tool_results(messages) is messages

    async def test_a_restricted_collection_in_any_case_is_caught(self, bff):
        messages = [_result(f"Collection: {VERTRAEGE.upper()}")]
        with bound(None):
            out = await admit_tool_results(messages)
        assert out[0].content == WITHHELD_NOTICE


class TestNaming:
    def test_an_open_collection_may_always_be_named(self):
        with bound(None):
            assert ru.may_name("proj_p1") is True
            assert ru.may_name(None) is True

    def test_a_restricted_collection_is_named_only_once_admitted_this_turn(self):
        with bound(_use(drawable={VERTRAEGE})) as use:
            assert ru.may_name(VERTRAEGE) is False
            assert use is not None
            use.admitted.add(VERTRAEGE)
            assert ru.may_name(VERTRAEGE) is True
        with bound(None):
            assert ru.may_name(VERTRAEGE) is False

    async def test_admission_records_what_it_admitted(self, bff):
        bff.answer = {"admitted": [VERTRAEGE], "refused": [PERSONAL]}
        with bound(_use(drawable={VERTRAEGE, PERSONAL})) as use:
            assert use is not None
            assert ru.admit(use, [VERTRAEGE, PERSONAL]) == {VERTRAEGE}
            assert use.admitted == {VERTRAEGE} and use.drawable == {VERTRAEGE}

    async def test_a_result_without_restricted_content_asks_nobody(self, bff):
        messages = [_result("Collection: proj_p1\nPlan EG")]
        with bound(_use(drawable={VERTRAEGE})):
            assert await admit_tool_results(messages) is messages
        assert bff.asked == []

    async def test_admitted_content_passes_and_confines_the_conversation(self, bff):
        bff.answer = {"admitted": [VERTRAEGE], "refused": []}
        messages = [_result(f"Collection: {VERTRAEGE}\nHonorar pauschal")]
        with bound(_use(drawable={VERTRAEGE})) as use:
            assert await admit_tool_results(messages) is messages
        assert bff.asked == [{"admit": [VERTRAEGE]}]
        assert use is not None and use.confined is True

    async def test_refused_content_is_withheld_with_the_same_call_id_and_leaves_the_scope(self, bff):
        """A share raced the turn: the BFF refuses, the passages never reach the model."""
        bff.answer = {"admitted": [], "refused": [VERTRAEGE]}
        restricted = _result(f"Collection: {VERTRAEGE}\nHonorar pauschal", "call-1")
        open_one = _result("Collection: proj_p1\nPlan EG", "call-2")
        with bound(_use(drawable={VERTRAEGE})) as use:
            out = await admit_tool_results([restricted, open_one])
        assert [message.content for message in out] == [WITHHELD_NOTICE, open_one.content]
        assert out[0].tool_call_id == "call-1"
        assert use is not None and use.drawable == set() and use.confined is False

    async def test_an_unreachable_bff_withholds(self, bff):
        bff.answer = None
        messages = [_result(f"Collection: {VERTRAEGE}\nHonorar pauschal")]
        with bound(_use(drawable={VERTRAEGE})):
            out = await admit_tool_results(messages)
        assert out[0].content == WITHHELD_NOTICE
