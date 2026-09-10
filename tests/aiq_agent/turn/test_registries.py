"""The four per-turn registries: bound for the turn, unbound after it, however it ends."""

from __future__ import annotations

import asyncio

import pytest

from aiq_agent.cards.registry import get_card_registry
from aiq_agent.cards.registry import get_or_create_card_registry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import get_session_registry
from aiq_agent.common.image_view_budget import get_image_view_budget
from aiq_agent.knowledge.project_memory import record_turn_memory_write
from aiq_agent.knowledge.project_memory import turn_memory_writes
from aiq_agent.turn import registries as registries_mod
from aiq_agent.turn.registries import load_session_registry
from aiq_agent.turn.registries import pending_persist_tasks
from aiq_agent.turn.registries import turn_registries


@pytest.fixture
def persisted(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(registries_mod, "persist_session_registry", seen.append)
    return seen


async def _settle():
    for task in pending_persist_tasks():
        await task


class TestTurnRegistries:
    async def test_binds_everything_for_the_turn_and_unbinds_after(self, persisted):
        session = SourceRegistry()
        async with turn_registries("conv-1", session) as registries:
            assert get_session_registry() is session
            assert get_card_registry() is registries.cards
            assert get_image_view_budget() is not None
            record_turn_memory_write("Firma: Grid")
            assert turn_memory_writes() == ("Firma: Grid",)
        assert get_session_registry() is None
        assert get_card_registry() is None
        assert get_image_view_budget() is None
        assert turn_memory_writes() == ()
        assert registries.memory_writes == ("Firma: Grid",)
        await _settle()
        assert persisted == ["conv-1"]

    async def test_cards_from_the_previous_turn_are_cleared(self, persisted):
        get_or_create_card_registry("conv-2").add({"type": "checklist"})
        async with turn_registries("conv-2", SourceRegistry()) as registries:
            assert registries.cards.snapshot() == []
        await _settle()

    async def test_unbinds_and_persists_when_the_turn_raises(self, persisted):
        with pytest.raises(RuntimeError):
            async with turn_registries("conv-3", SourceRegistry()):
                raise RuntimeError("the agent died")
        assert get_session_registry() is None
        assert get_card_registry() is None
        await _settle()
        assert persisted == ["conv-3"]

    async def test_a_failed_persist_is_logged_not_raised(self, monkeypatch, caplog):
        def broken(_conversation_id):
            raise OSError("cache gone")

        monkeypatch.setattr(registries_mod, "persist_session_registry", broken)
        async with turn_registries("conv-4", SourceRegistry()):
            pass
        await _settle()
        await asyncio.sleep(0)
        assert "Citation registry persistence failed" in caplog.text


class TestLoadSessionRegistry:
    """The registry hydration is a blocking cache round-trip: it rides a
    thread, and any failure yields a fresh registry — never a failed turn."""

    async def test_passthrough_on_success(self, monkeypatch):
        registry = SourceRegistry()
        monkeypatch.setattr(registries_mod, "get_or_create_session_registry", lambda _cid: registry)
        assert await load_session_registry("conv-1") is registry

    async def test_fresh_registry_on_failure(self, monkeypatch):
        import threading

        calling_thread = threading.current_thread().name
        seen_threads: list[str] = []

        def _hydrate(_conversation_id):
            seen_threads.append(threading.current_thread().name)
            raise RuntimeError("cache down")

        monkeypatch.setattr(registries_mod, "get_or_create_session_registry", _hydrate)
        fallback = await load_session_registry("conv-1")

        assert isinstance(fallback, SourceRegistry)
        # Off the event loop even on the failing path.
        assert seen_threads and seen_threads[0] != calling_thread
