"""The turn's document inventory: aggregation, the ingest wait, the scope."""

from __future__ import annotations

import asyncio

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.scoping import ScopedCollection
from aiq_agent.turn.inventory import Inventory
from aiq_agent.turn.inventory import aggregate_documents_across_collections
from aiq_agent.turn.inventory import await_ingest_settling
from aiq_agent.turn.inventory import fallback_scope
from aiq_agent.turn.inventory import in_flight_names
from aiq_agent.turn.inventory import load_inventory
from aiq_agent.turn.inventory import resolve_scope
from aiq_agent.turn.inventory import session_collection_name
from aiq_agent.turn.inventory import shelves_in_scope


def _scoped(names):
    return [ScopedCollection(name) for name in names]


class _Doc:
    """Minimal stand-in for a document summary."""

    def __init__(self, file_name, collection=None, shelf=None):
        self.file_name = file_name
        self.collection = collection
        self.shelf = shelf

    def __eq__(self, other):
        return isinstance(other, _Doc) and other.file_name == self.file_name and other.collection == self.collection

    def __hash__(self):
        return hash((self.collection, self.file_name))

    def __repr__(self):
        return f"_Doc({self.file_name!r}, collection={self.collection!r})"


def _sequential_reference(collections, per_collection):
    """Oracle: stamp collection, keep ``(collection, file_name)`` (ADR-0047)."""
    aggregated = []
    seen = set()
    for coll in collections:
        docs = per_collection.get(coll)
        if docs is None:  # a raising collection contributed nothing
            continue
        for doc in docs:
            key = (coll, doc.file_name)
            if key in seen:
                continue
            seen.add(key)
            aggregated.append(_Doc(doc.file_name, collection=coll, shelf=getattr(doc, "shelf", None)))
    aggregated.sort(key=lambda d: (d.file_name.lower(), d.collection or ""))
    return aggregated


class TestAggregateDocumentsAcrossCollections:
    """The concurrent per-collection loader must return the same merged/deduped
    data as the old sequential loop, plus a stable file_name sort and a top-N
    cap for prompt-cost control — with the same per-collection fail-open."""

    def _run(self, collections, per_collection):
        """Drive the concurrent helper against a mock async fetch_one."""
        call_order = []

        async def fetch_one(coll):
            call_order.append(coll)
            # Yield control so collections genuinely interleave (proves the
            # merge does not depend on completion order).
            await asyncio.sleep(0)
            docs = per_collection.get(coll)
            if docs is None:
                raise RuntimeError(f"no summaries for {coll}")
            return list(docs)

        result = asyncio.run(aggregate_documents_across_collections(_scoped(collections), fetch_one))
        return result, call_order

    def test_matches_sequential_merge_order(self):
        collections = ["base", "session"]
        per_collection = {
            "base": [_Doc("a.pdf"), _Doc("b.pdf")],
            "session": [_Doc("c.pdf")],
        }
        result, _ = self._run(collections, per_collection)
        assert result == _sequential_reference(collections, per_collection)
        assert [d.file_name for d in result] == ["a.pdf", "b.pdf", "c.pdf"]

    def test_same_filename_on_two_collections_is_kept_twice(self):
        collections = ["base", "session"]
        per_collection = {
            "base": [_Doc("dup.pdf"), _Doc("a.pdf")],
            "session": [_Doc("dup.pdf"), _Doc("b.pdf")],
        }
        result, _ = self._run(collections, per_collection)
        assert result == _sequential_reference(collections, per_collection)
        assert [(d.collection, d.file_name) for d in result] == [
            ("base", "a.pdf"),
            ("session", "b.pdf"),
            ("base", "dup.pdf"),
            ("session", "dup.pdf"),
        ]

    def test_dedup_within_a_single_collection(self):
        collections = ["base"]
        per_collection = {"base": [_Doc("x.pdf"), _Doc("x.pdf"), _Doc("y.pdf")]}
        result, _ = self._run(collections, per_collection)
        assert [d.file_name for d in result] == ["x.pdf", "y.pdf"]

    def test_one_collection_failing_still_merges_the_rest(self):
        # Fail-open per collection: the raising one yields empty, not a wipeout.
        collections = ["base", "session"]
        per_collection = {
            "base": [_Doc("a.pdf")],
            "session": None,  # raises inside fetch_one
        }
        result, _ = self._run(collections, per_collection)
        assert result == _sequential_reference(collections, per_collection)
        assert [d.file_name for d in result] == ["a.pdf"]

    def test_first_collection_failing_keeps_second(self):
        collections = ["base", "session"]
        per_collection = {
            "base": None,  # raises
            "session": [_Doc("only.pdf")],
        }
        result, _ = self._run(collections, per_collection)
        assert [d.file_name for d in result] == ["only.pdf"]

    def test_all_collections_empty_returns_empty(self):
        collections = ["base", "session"]
        result, _ = self._run(collections, {"base": [], "session": []})
        assert result == []

    def test_no_collections_returns_empty(self):
        result, call_order = self._run([], {})
        assert result == []
        assert call_order == []

    def test_every_collection_is_fetched(self):
        collections = ["base", "session", "extra"]
        per_collection = {"base": [_Doc("a")], "session": [_Doc("b")], "extra": [_Doc("c")]}
        _, call_order = self._run(collections, per_collection)
        assert sorted(call_order) == ["base", "extra", "session"]

    def test_merge_is_order_deterministic_regardless_of_completion(self):
        # session resolves before base (base sleeps longer), but the merged
        # order must still follow the input order, not the completion order.
        async def fetch_one(coll):
            if coll == "base":
                await asyncio.sleep(0.02)
                return [_Doc("base.pdf")]
            await asyncio.sleep(0)
            return [_Doc("session.pdf")]

        result = asyncio.run(aggregate_documents_across_collections(_scoped(["base", "session"]), fetch_one))
        assert [d.file_name for d in result] == ["base.pdf", "session.pdf"]

    def test_result_is_sorted_by_file_name(self):
        # DB rows have no ordering column; the helper sorts so the capped slice
        # (and prompt prefix) is stable across turns.
        async def fetch_one(coll):
            return [_Doc("m.pdf"), _Doc("a.pdf"), _Doc("z.pdf")]

        result = asyncio.run(aggregate_documents_across_collections(_scoped(["base"]), fetch_one))
        assert [d.file_name for d in result] == ["a.pdf", "m.pdf", "z.pdf"]
        assert all(d.collection == "base" for d in result)

    def test_user_shelf_survives_a_cap_that_would_have_been_all_oib(self):
        async def fetch_one(coll):
            if coll == "oib_knowledge":
                return [_Doc(f"oib-{i:02d}.pdf") for i in range(20)]
            return [_Doc("Buero-Standard.pdf")]

        result = asyncio.run(
            aggregate_documents_across_collections(
                [
                    ScopedCollection("oib_knowledge", Shelf.BASE),
                    ScopedCollection("archiv_org", Shelf.ARCHIV),
                ],
                fetch_one,
                max_documents=5,
            )
        )
        assert any(d.file_name == "Buero-Standard.pdf" and d.shelf == "archiv" for d in result)

    def test_caps_to_max_documents_keeping_lowest_sorted(self):
        async def fetch_one(coll):
            return [_Doc(f"{c}.pdf") for c in "edcba"]

        result = asyncio.run(aggregate_documents_across_collections(_scoped(["base"]), fetch_one, max_documents=2))
        # Sorted then capped -> the two lowest file_names.
        assert [d.file_name for d in result] == ["a.pdf", "b.pdf"]

    def test_cap_of_zero_disables_truncation(self):
        async def fetch_one(coll):
            return [_Doc(f"{i}.pdf") for i in range(5)]

        result = asyncio.run(aggregate_documents_across_collections(_scoped(["base"]), fetch_one, max_documents=0))
        assert len(result) == 5


class TestAwaitIngestSettling:
    """The turn holds for an attachment still being indexed, bounded."""

    async def _run(self, reads, timeout=5.0):
        reads = list(reads)
        calls = {"polls": 0, "sleeps": []}

        def read(scope_names):
            calls["polls"] += 1
            return reads.pop(0) if reads else {}

        async def sleep(seconds):
            calls["sleeps"].append(seconds)

        settled = await await_ingest_settling(
            ["s_1"], {"s_1": ["plan.pdf"]}, read=read, timeout_seconds=timeout, poll_seconds=1.0, sleep=sleep
        )
        return settled, calls

    async def test_returns_empty_once_the_file_finished(self):
        settled, calls = await self._run([{"s_1": ["plan.pdf"]}, {}])

        assert settled == {}
        assert calls["polls"] == 2

    async def test_returns_the_remaining_files_when_the_deadline_hits(self):
        # A read that never clears: the loop must end on the clock, not spin.
        stuck = {"s_1": ["plan.pdf"]}
        settled, calls = await self._run([stuck] * 50, timeout=0.0001)

        assert settled == stuck
        assert calls["polls"] <= 2

    async def test_a_zero_budget_never_polls(self):
        settled, calls = await self._run([{}], timeout=0)

        assert settled == {"s_1": ["plan.pdf"]}
        assert calls["polls"] == 0

    async def test_nothing_pending_is_an_immediate_return(self):
        def read(_names):
            raise AssertionError("must not poll")

        assert await await_ingest_settling(["s_1"], {}, read=read, timeout_seconds=5.0) == {}


def test_session_collection_name_is_idempotent():
    assert session_collection_name("abc") == "s_abc"
    assert session_collection_name("s_abc") == "s_abc"


class TestScope:
    """Which collections a turn reads when the request states none."""

    def test_the_fallback_builds_base_and_session_with_their_shelves(self, monkeypatch):
        monkeypatch.setenv("COLLECTION_NAME", "oib_knowledge")
        assert fallback_scope("conv-1") == [
            ScopedCollection("oib_knowledge", Shelf.BASE),
            ScopedCollection("s_conv-1", Shelf.SESSION),
        ]

    def test_no_conversation_means_the_base_corpus_only(self, monkeypatch):
        monkeypatch.setenv("COLLECTION_NAME", "oib_knowledge")
        assert fallback_scope(None) == [ScopedCollection("oib_knowledge", Shelf.BASE)]

    def test_a_stated_scope_wins_and_an_empty_one_falls_back(self, monkeypatch):
        monkeypatch.setenv("COLLECTION_NAME", "oib_knowledge")
        stated = [ScopedCollection("archiv_org", Shelf.ARCHIV)]
        assert resolve_scope(stated, "conv-1") == stated
        assert resolve_scope([], "conv-1") == fallback_scope("conv-1")
        assert resolve_scope(None, None) == fallback_scope(None)

    def test_shelves_in_scope_skips_unknown_shelves(self):
        scope = [ScopedCollection("archiv_org", Shelf.ARCHIV), ScopedCollection("legacy")]
        assert shelves_in_scope(scope) == ["archiv"]

    def test_in_flight_names_dedupes_across_collections(self):
        assert in_flight_names({"a": ["x.pdf", "y.pdf"], "b": ["x.pdf"]}) == ["x.pdf", "y.pdf"]


class TestLoadInventory:
    """The documents and the in-flight files, read together; the wait only after."""

    SCOPE = [ScopedCollection("s_1", Shelf.SESSION)]

    async def test_reads_documents_and_in_flight_in_one_gather(self):
        order: list[str] = []

        async def fetch_one(_collection):
            order.append("fetch:start")
            await asyncio.sleep(0.01)
            order.append("fetch:end")
            return [_Doc("a.pdf")]

        def read_in_flight(_names):
            order.append("in_flight")
            return {}

        inventory = await load_inventory(self.SCOPE, fetch_one=fetch_one, read_in_flight=read_in_flight)

        assert [d.file_name for d in inventory.available_documents] == ["a.pdf"]
        assert inventory.in_flight_documents is None
        assert order.index("in_flight") < order.index("fetch:end"), "the in-flight read must overlap the fetch"

    async def test_a_settled_upload_rebuilds_the_inventory(self):
        reads = [{"s_1": ["plan.pdf"]}, {}]
        fetches = {"n": 0}

        async def fetch_one(_collection):
            fetches["n"] += 1
            return [] if fetches["n"] == 1 else [_Doc("plan.pdf")]

        inventory = await load_inventory(
            self.SCOPE, fetch_one=fetch_one, read_in_flight=lambda _n: reads.pop(0), timeout_seconds=5.0
        )

        assert inventory == Inventory([_Doc("plan.pdf", collection="s_1", shelf="session")], None)

    async def test_an_upload_still_pending_at_the_deadline_is_reported(self):
        async def fetch_one(_collection):
            return []

        inventory = await load_inventory(
            self.SCOPE, fetch_one=fetch_one, read_in_flight=lambda _n: {"s_1": ["plan.pdf"]}, timeout_seconds=0
        )

        assert inventory == Inventory(None, ["plan.pdf"])


@pytest.fixture(autouse=True)
def _no_status_frames(monkeypatch):
    """The waiting status line is fail-open transparency; keep it out of the assertions."""
    monkeypatch.setattr("aiq_agent.turn.inventory.emit_documents_waiting", lambda **_kw: None)
