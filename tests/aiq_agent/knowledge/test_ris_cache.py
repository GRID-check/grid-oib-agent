"""Tests for the persistent ris_knowledge cache store (norm-registry Phase 3)."""

from datetime import UTC
from datetime import datetime
from datetime import timedelta

import pytest

from aiq_agent.knowledge.ris_cache import RisCacheStore
from aiq_agent.knowledge.ris_cache import cache_ttl_days


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.delenv("GRID_RIS_CACHE_TTL_DAYS", raising=False)
    return RisCacheStore(tmp_path / "ris_cache")


class TestStoreAndLookup:
    def test_lookup_miss_returns_none(self, store):
        assert store.lookup("NOR40191806") is None

    def test_store_then_lookup_roundtrip(self, store):
        store.store(
            "NOR40191806",
            text="Wasserrechtsgesetz Volltext",
            url="https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40191806/NOR40191806.html",
            title="Wasserrechtsgesetz 1959",
            fassung="1. Jänner 2020",
            file_name="RIS_Wasserrechtsgesetz.txt",
        )
        loaded = store.lookup("NOR40191806")
        assert loaded is not None
        assert loaded.document_number == "NOR40191806"
        assert loaded.fassung == "1. Jänner 2020"
        assert loaded.title == "Wasserrechtsgesetz 1959"
        assert loaded.content_hash
        assert store.read_text(loaded) == "Wasserrechtsgesetz Volltext"

    def test_store_replaces_existing_record_and_text(self, store):
        store.store("NOR1", text="alt", url="u", title="t", fassung="2020", file_name="a.txt")
        record = store.store("NOR1", text="neu", url="u", title="t", fassung="2023", file_name="a.txt")
        assert store.read_text(store.lookup("NOR1")) == "neu"
        assert record.fassung == "2023"


class TestFreshness:
    def _record(self, store, age_days: float):
        record = store.store("NOR1", text="x", url="u", title="t", fassung="2020", file_name="a.txt")
        record.fetched_at = datetime.now(UTC) - timedelta(days=age_days)
        return record

    def test_fresh_within_ttl(self, store):
        assert store.is_fresh(self._record(store, 2), ttl_days=7) is True

    def test_stale_beyond_ttl(self, store):
        assert store.is_fresh(self._record(store, 8), ttl_days=7) is False

    def test_boundary_is_stale(self, store):
        assert store.is_fresh(self._record(store, 7.0), ttl_days=7) is False

    def test_touch_refreshes_fetched_at(self, store):
        record = self._record(store, 30)
        store.touch(record)
        reloaded = store.lookup("NOR1")
        assert store.is_fresh(reloaded, ttl_days=7) is True


class TestTtlEnv:
    def test_default_seven_days(self, monkeypatch):
        monkeypatch.delenv("GRID_RIS_CACHE_TTL_DAYS", raising=False)
        assert cache_ttl_days() == 7

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("GRID_RIS_CACHE_TTL_DAYS", "30")
        assert cache_ttl_days() == 30

    def test_invalid_env_falls_back(self, monkeypatch):
        monkeypatch.setenv("GRID_RIS_CACHE_TTL_DAYS", "junk")
        assert cache_ttl_days() == 7
