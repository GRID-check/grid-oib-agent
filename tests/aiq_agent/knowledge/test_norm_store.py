"""Tests for the admin-managed norm registry store.

Uses a throwaway SQLite file per test. The ``set_db_loader`` integration tests
MUST unset the loader in teardown so registry state does not leak across tests.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy import text

from aiq_agent.common import norm_registry
from aiq_agent.common.norm_registry import NormEntry
from aiq_agent.common.norm_registry import NormsFile
from aiq_agent.knowledge.norm_store import NormRegistryStore


@pytest.fixture
def db_url(tmp_path):
    return f"sqlite:///{tmp_path / 'norms.db'}"


@pytest.fixture
def store(db_url):
    store = NormRegistryStore(db_url)
    yield store
    NormRegistryStore.dispose_all_engines()


@pytest.fixture(autouse=True)
def _clear_registry_state():
    """Never let a registered db loader / cached registry leak between tests."""
    yield
    norm_registry.set_db_loader(None)
    norm_registry.reset_registry_cache()


def _sample_norms_file() -> NormsFile:
    return NormsFile(
        version=1,
        entries=[
            NormEntry(
                id="test-fed",
                title="Test Federal Law",
                short="TFL",
                rank="bundesgesetz",
                application="BrKons",
                document_number="NOR12345678",
            )
        ],
    )


def test_get_empty_returns_none_and_zero(store):
    assert store.get() == (None, 0)


def test_seed_from_yaml_if_empty_seeds_then_idempotent(store):
    assert store.seed_from_yaml_if_empty() is True
    norms_file, version = store.get()
    assert norms_file is not None
    assert version == 1
    assert norms_file.entries  # YAML seed has real entries
    # Second call is a no-op (row already present).
    assert store.seed_from_yaml_if_empty() is False
    _, version_again = store.get()
    assert version_again == 1


def test_put_get_roundtrip_and_version_increment(store):
    norms = _sample_norms_file()
    v1 = store.put(norms)
    assert v1 == 1
    got, version = store.get()
    assert version == 1
    assert got is not None
    assert [e.id for e in got.entries] == ["test-fed"]

    v2 = store.put(norms, expected_version=1)
    assert v2 == 2
    _, version2 = store.get()
    assert version2 == 2


def test_put_version_conflict_returns_none(store):
    store.put(_sample_norms_file())  # -> version 1
    # Caller thinks it is still at version 0.
    assert store.put(_sample_norms_file(), expected_version=0) is None
    # Stored version is unchanged.
    _, version = store.get()
    assert version == 1


def test_corrupted_json_row_fails_open(store, db_url):
    engine = create_engine(db_url.replace("+aiosqlite", ""))
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO norm_registry (country, data, version, updated_at) VALUES ('at', 'not-json', 5, NULL)")
        )
    engine.dispose()
    assert store.get() == (None, 0)


def test_configure_registers_loader_and_falls_back_to_yaml(db_url):
    from aiq_agent.knowledge import norm_store

    try:
        store = norm_store.configure_norm_store(db_url)
        assert store is not None
        assert norm_store.get_norm_store() is store

        # A distinctive entry only present in the store proves the loader is live.
        custom = NormsFile(
            entries=[
                NormEntry(
                    id="only-in-store",
                    title="Store Only",
                    short="SO",
                    rank="bundesgesetz",
                    application="BrKons",
                    document_number="NOR99999999",
                )
            ]
        )
        store.put(custom, expected_version=1)  # seed wrote version 1
        norm_registry.reset_registry_cache()

        registry = norm_registry.load_registry()
        assert registry is not None
        assert any(e.id == "only-in-store" for e in registry.entries)

        # Deleting the row makes the loader return None -> YAML seed fallback.
        engine = create_engine(db_url.replace("+aiosqlite", ""))
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM norm_registry WHERE country = 'at'"))
        engine.dispose()
        norm_registry.reset_registry_cache()

        fallback = norm_registry.load_registry()
        assert fallback is not None
        assert not any(e.id == "only-in-store" for e in fallback.entries)
        assert fallback.entries  # YAML seed present
    finally:
        norm_store._norm_store = None
        NormRegistryStore.dispose_all_engines()
