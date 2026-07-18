"""Tests for the admin norm-registry routes.

Covers the ``X-Admin-Token`` guard (oib.py semantics), the GET shape, PUT
validation (422 pydantic / 409 optimistic conflict / success resets the
registry cache), and the live-verify endpoint against a mocked ``RisClient``.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.common import norm_registry
from aiq_agent.knowledge import norm_store
from aiq_agent.knowledge.norm_store import NormRegistryStore
from aiq_api.routes import norms as norms_module
from aiq_api.routes.norms import add_norm_routes


@pytest.fixture
def configured_store():
    """Configure the module-level norm store on a fresh temp SQLite DB (seeded)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'norms.db'}"
        NormRegistryStore._tables_initialized.discard(db_url)
        store = norm_store.configure_norm_store(db_url)
        assert store is not None
        yield store
        norm_registry.set_db_loader(None)
        norm_registry.reset_registry_cache()
        norm_store._norm_store = None
        NormRegistryStore.dispose_all_engines()


@pytest.fixture
def app(configured_store):
    app = FastAPI()
    router = APIRouter()
    add_norm_routes(router)
    app.include_router(router)
    return app


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _valid_body(entry_id: str = "custom-fed", version: int = 1) -> dict:
    """A full PUT envelope: the expected version plus a valid NormsFile registry."""
    return {
        "version": version,
        "registry": {
            "version": 1,
            "entries": [
                {
                    "id": entry_id,
                    "title": "Custom Federal Law",
                    "short": "CFL",
                    "rank": "bundesgesetz",
                    "application": "BrKons",
                    "document_number": "NOR00000001",
                }
            ],
        },
    }


# --------------------------------------------------------------------------- #
# Auth guard (oib.py semantics: unset token -> open; set token -> must match)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_get_open_when_admin_token_unset(app, monkeypatch):
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", None)
    async with _client(app) as client:
        resp = await client.get("/v1/admin/norms")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_get_rejects_wrong_admin_token(app, monkeypatch):
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", "secret")
    async with _client(app) as client:
        resp = await client.get("/v1/admin/norms", headers={"X-Admin-Token": "wrong"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_get_accepts_correct_admin_token(app, monkeypatch):
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", "secret")
    async with _client(app) as client:
        resp = await client.get("/v1/admin/norms", headers={"X-Admin-Token": "secret"})
    assert resp.status_code == 200


# --------------------------------------------------------------------------- #
# GET shape
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_get_returns_version_and_registry(app, monkeypatch):
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", None)
    async with _client(app) as client:
        resp = await client.get("/v1/admin/norms")
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == 1  # seeded from YAML
    assert "entries" in data["registry"]
    assert isinstance(data["registry"]["entries"], list)
    assert data["registry"]["entries"]  # seed has entries


# --------------------------------------------------------------------------- #
# PUT
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_put_pydantic_error_is_422(app, monkeypatch):
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", None)
    bad = {"version": 1, "registry": {"entries": [{"id": "x"}]}}  # missing required fields
    async with _client(app) as client:
        resp = await client.put("/v1/admin/norms", json=bad)
    assert resp.status_code == 422
    assert resp.json()["detail"]  # pydantic error details present


@pytest.mark.asyncio
async def test_put_unknown_application_is_400(app, monkeypatch):
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", None)
    body = _valid_body()
    body["registry"]["entries"][0]["application"] = "NotAnApp"
    async with _client(app) as client:
        resp = await client.put("/v1/admin/norms", json=body)
    assert resp.status_code == 400
    assert any("NotAnApp" in reason for reason in resp.json()["detail"])


@pytest.mark.asyncio
async def test_put_version_conflict_is_409(app, monkeypatch):
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", None)
    body = _valid_body(version=0)  # stale: seed is already at version 1
    async with _client(app) as client:
        resp = await client.put("/v1/admin/norms", json=body)
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_put_get_roundtrips_profile_overrides(app, monkeypatch):
    """The optional CountryProfile overrides (doctrine/states/language/parcel_tags)
    survive a PUT -> GET round-trip through the store (NormsFile carries them)."""
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", None)
    body = _valid_body(entry_id="fed-overrides")
    body["registry"]["doctrine"] = "Custom Normenhierarchie doctrine"
    body["registry"]["states"] = {"wien": "Wien", "ausserhalb_oesterreichs": None}
    body["registry"]["language"] = "de-AT"
    body["registry"]["parcel_tags"] = ["Bebauungsplan", "Flächenwidmungsplan"]
    body["registry"]["corpus_note"] = "Korpus-Hinweis"

    async with _client(app) as client:
        put = await client.put("/v1/admin/norms", json=body)
        assert put.status_code == 200
        get = await client.get("/v1/admin/norms")

    assert get.status_code == 200
    registry = get.json()["registry"]
    assert registry["doctrine"] == "Custom Normenhierarchie doctrine"
    assert registry["states"] == {"wien": "Wien", "ausserhalb_oesterreichs": None}
    assert registry["language"] == "de-AT"
    assert registry["parcel_tags"] == ["Bebauungsplan", "Flächenwidmungsplan"]
    assert registry["corpus_note"] == "Korpus-Hinweis"


@pytest.mark.asyncio
async def test_put_success_writes_and_resets_cache(app, configured_store, monkeypatch):
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", None)
    reset = MagicMock(wraps=norm_registry.reset_registry_cache)
    monkeypatch.setattr(norms_module.norm_registry, "reset_registry_cache", reset)

    body = _valid_body(entry_id="brand-new")
    async with _client(app) as client:
        resp = await client.put("/v1/admin/norms", json=body)

    assert resp.status_code == 200
    assert resp.json()["version"] == 2  # seed was 1
    reset.assert_called_once()
    stored, version = configured_store.get()
    assert version == 2
    assert any(e.id == "brand-new" for e in stored.entries)


# --------------------------------------------------------------------------- #
# verify (mocked RisClient)
# --------------------------------------------------------------------------- #


def _fake_hit(**kwargs):
    hit = MagicMock()
    hit.metadata = kwargs.get("metadata", {})
    hit.title = kwargs.get("title", "")
    hit.document_number = kwargs.get("document_number", "")
    hit.citation_url = kwargs.get("citation_url", "")
    hit.full_law_url = kwargs.get("full_law_url", "")
    return hit


def _fake_ris_client(hits):
    result = MagicMock()
    result.hits = hits
    result.total = len(hits)
    client = MagicMock()
    client.search = AsyncMock(return_value=result)
    client.aclose = AsyncMock()
    return MagicMock(return_value=client)


@pytest.mark.asyncio
async def test_verify_returns_filtered_candidates(app, monkeypatch):
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", None)
    hits = [
        _fake_hit(
            metadata={"Kurztitel": "Bauordnung für Wien", "Paragraph/Artikel": "§ 0"},
            document_number="LWI40000225",
            citation_url="https://ris.example/cite",
            full_law_url="https://ris.example/GeltendeFassung?Gesetzesnummer=20000006",
        ),
        # Not a § 0 whole-law anchor -> filtered out.
        _fake_hit(metadata={"Kurztitel": "Bauordnung für Wien", "Paragraph/Artikel": "§ 3"}),
        # Excluded by the 'exclude' term.
        _fake_hit(
            metadata={"Kurztitel": "Bauordnung für Wien (Novelle)", "Paragraph/Artikel": "§ 0"},
            full_law_url="https://ris.example/x",
        ),
    ]

    body = {
        "title_query": "Bauordnung für Wien",
        "application": "LrKons",
        "bundesland": "Wien",
        "expect": "Bauordnung",
        "exclude": ["Novelle"],
    }
    async with _client(app) as client:
        with patch("ris_adapter.client.RisClient", _fake_ris_client(hits)):
            resp = await client.post("/v1/admin/norms/verify", json=body)

    assert resp.status_code == 200
    data = resp.json()
    assert len(data["candidates"]) == 1
    assert data["candidates"][0]["document_number"] == "LWI40000225"
    assert "verified_at" in data


@pytest.mark.asyncio
async def test_verify_ris_error_is_502(app, monkeypatch):
    monkeypatch.setattr(norms_module, "_ADMIN_TOKEN", None)
    from ris_adapter.client import RisError

    client_obj = MagicMock()
    client_obj.search = AsyncMock(side_effect=RisError("boom"))
    client_obj.aclose = AsyncMock()

    body = {"title_query": "X", "application": "LrKons"}
    async with _client(app) as client:
        with patch("ris_adapter.client.RisClient", MagicMock(return_value=client_obj)):
            resp = await client.post("/v1/admin/norms/verify", json=body)

    assert resp.status_code == 502
