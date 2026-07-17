"""Phase-3 persistent RIS norm cache on the fetch path (norm registry spec §4.4)."""

import hashlib
from datetime import UTC
from datetime import datetime
from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from ris_adapter import register as reg
from ris_adapter.client import RisDocument
from ris_adapter.register import RisFetchDocumentToolConfig
from ris_adapter.register import ris_fetch_document

from aiq_agent.knowledge.ris_cache import RisCacheStore
from nat.builder.function import LambdaFunction
from nat.data_models.function import FunctionBaseConfig

_REFERENCE = "NOR40217157"
_URL = f"https://www.ris.bka.gv.at/Dokumente/Bundesnormen/{_REFERENCE}/{_REFERENCE}.html"
_NEW_TEXT = "Stand: 1.3.2024\n§ 1 Neu\n"


class _ProbeConfig(FunctionBaseConfig, name="_fetch_cache_probe"):
    pass


async def _call(info, **kwargs):
    fn = LambdaFunction.from_info(config=_ProbeConfig(), info=info)
    return await fn.ainvoke(kwargs, to_type=str)


def _record(store: RisCacheStore, days_old: int = 10, fassung: str | None = "1.1.2020"):
    record = store.store(
        _REFERENCE,
        text="Stand: 1.1.2020 § 1 Alt\n",
        url=_URL,
        title="Altgesetz",
        fassung=fassung,
        file_name=f"RIS_{_REFERENCE}.txt",
    )
    record.fetched_at = datetime.now(UTC) - timedelta(days=days_old)
    registry = store._read_registry()
    registry[_REFERENCE] = store._serialize(record)
    store._write_registry(registry)
    return store.lookup(_REFERENCE)


@pytest.fixture
def cache_env(tmp_path, monkeypatch):
    """Fresh cache store in tmp; fake RIS client; stubbed ingestion; TTL 7 days."""
    store = RisCacheStore(tmp_path / "ris_cache")
    monkeypatch.setenv("GRID_RIS_CACHE_TTL_DAYS", "7")

    class _Client:
        fetch_calls: list[str] = []

        async def fetch_document_text(self, url):
            type(self).fetch_calls.append(url)
            return RisDocument(url=url, title="Neugesetz", text=_NEW_TEXT)

        async def aclose(self):
            pass

    monkeypatch.setattr("ris_adapter.register.RisClient", lambda **kw: _Client())

    ingested: list[tuple[str, str, str, str | None]] = []
    deleted: list[tuple[str, str]] = []

    def _fake_ingest(text, file_name, source_url, collection):
        ingested.append((text, file_name, source_url, collection))
        return file_name

    def _fake_delete(file_name, collection):
        deleted.append((file_name, collection))

    monkeypatch.setattr("ris_adapter.register._ingest_document_sync", _fake_ingest)
    monkeypatch.setattr("ris_adapter.register._delete_from_collection_sync", _fake_delete)
    monkeypatch.setattr("ris_adapter.register._resolve_session_collection", lambda: "s_test")
    return store, _Client, ingested, deleted


def _patch_revalidate(monkeypatch, value: str | None):
    async def _probe(url):
        return value

    monkeypatch.setattr("ris_adapter.register._revalidate_fassung", _probe)


async def _fetch(cache_dir: Path, reference: str = _REFERENCE) -> str:
    config = RisFetchDocumentToolConfig(cache_dir=str(cache_dir))
    async with ris_fetch_document(config, MagicMock()) as info:
        return await _call(info, reference=reference)


class TestDocNumberFromUrlOrReference:
    def test_from_url(self):
        assert reg._document_number_from_url_or_reference("irrelevant", _URL) == _REFERENCE

    def test_reference_fallback(self):
        assert reg._document_number_from_url_or_reference(_REFERENCE, "") == _REFERENCE

    def test_unresolvable(self):
        assert reg._document_number_from_url_or_reference("§ 5 BauO", "") is None


class TestFassungDateFromText:
    def test_stand_pattern(self):
        assert reg._fassung_date_from_text("RIS-Recht\nStand: 15.03.2024\n§ 1 …") == "15.03.2024"

    def test_no_date(self):
        assert reg._fassung_date_from_text("§ 1 ohne Datum") is None


class TestDecideAfterRevalidation:
    def test_novel_detected_refetches(self, tmp_path):
        record = _record(RisCacheStore(tmp_path))
        assert reg._decide_after_revalidation(record, "1.3.2024") == "refetch"

    def test_same_fassung_serves_touch(self, tmp_path):
        record = _record(RisCacheStore(tmp_path))
        assert reg._decide_after_revalidation(record, "1.1.2020") == "serve_touch"

    def test_missing_new_fassung_serves_touch(self, tmp_path):
        record = _record(RisCacheStore(tmp_path))
        assert reg._decide_after_revalidation(record, None) == "serve_touch"

    def test_new_fassung_on_unknown_record_fassung_refetches(self, tmp_path):
        record = _record(RisCacheStore(tmp_path), fassung=None)
        assert reg._decide_after_revalidation(record, "1.3.2024") == "refetch"


class TestFetchCacheFlow:
    async def test_fresh_cache_serves_without_client_call(self, cache_env):
        store, client, ingested, _ = cache_env
        record = _record(store, days_old=1)
        store.mark_ingested(record)
        out = await _fetch(store._dir)
        assert client.fetch_calls == []
        assert "Cache: persistent ris_knowledge" in out
        assert ingested == []  # already ingested into ris_knowledge

    async def test_stale_same_fassung_touches_and_serves(self, cache_env, monkeypatch):
        store, client, _, _ = cache_env
        record = _record(store, days_old=10)
        store.mark_ingested(record)
        _patch_revalidate(monkeypatch, "1.1.2020")
        before = store.lookup(_REFERENCE).fetched_at
        out = await _fetch(store._dir)
        assert client.fetch_calls == []
        assert store.lookup(_REFERENCE).fetched_at > before
        assert "Cache: persistent ris_knowledge" in out

    async def test_simulated_novelle_refetches_and_replaces(self, cache_env, monkeypatch):
        """Spec exit criterion: stale cache + changed Stand date → refetch, new hash/fassung stored."""
        store, client, ingested, deleted = cache_env
        record = _record(store, days_old=10, fassung="1.1.2020")
        old_hash = record.content_hash
        store.mark_ingested(record)
        _patch_revalidate(monkeypatch, "1.3.2024")
        out = await _fetch(store._dir)
        assert len(client.fetch_calls) == 1
        updated = store.lookup(_REFERENCE)
        assert updated.content_hash != old_hash
        assert updated.fassung == "1.3.2024"
        assert "neu abgerufen" in out
        assert (f"RIS_{_REFERENCE}.txt", "ris_knowledge") in deleted
        assert any(coll == "ris_knowledge" and "§ 1 Neu" in text for text, _, _, coll in ingested)
        assert any(coll == "s_test" and "ris_knowledge" in text for text, _, _, coll in ingested)

    async def test_first_fetch_stores_and_ingests(self, cache_env):
        store, client, ingested, _ = cache_env
        out = await _fetch(store._dir)
        assert len(client.fetch_calls) == 1
        record = store.lookup(_REFERENCE)
        assert record is not None
        assert record.content_hash == hashlib.sha256(_NEW_TEXT.encode("utf-8")).hexdigest()
        assert any(coll == "ris_knowledge" for _, _, _, coll in ingested)
        assert "neu abgerufen" in out
