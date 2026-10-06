"""A chat turn's use of restricted folders, the agent's half (ADR-0078, ADR-0079).

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
    async def test_outside_a_restricted_turn_nothing_is_asked(self, bff):
        messages = [_result(f"Collection: {VERTRAEGE}\nHonorar pauschal")]
        with bound(None):
            assert await admit_tool_results(messages) is messages
        assert bff.asked == []

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
