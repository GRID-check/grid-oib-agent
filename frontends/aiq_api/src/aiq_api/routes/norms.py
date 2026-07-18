"""Admin CRUD routes for the curated norm registry.

Follows the factory pattern of :mod:`aiq_api.routes.oib` (``add_norm_routes`` +
the ``X-Admin-Token`` guard). Three endpoints under ``/v1/admin/norms``:

- ``GET``    — read the current registry (store first, YAML seed fallback).
- ``PUT``    — replace the registry with optimistic-concurrency and validation.
- ``POST /verify`` — live OGD-RIS title search to help an admin pick a pointer.
"""

from __future__ import annotations

import logging
import os
from datetime import date

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Header
from fastapi import HTTPException
from fastapi import status
from pydantic import BaseModel
from pydantic import Field

from aiq_agent.common import norm_registry
from aiq_agent.common.norm_registry import BUNDESLAENDER
from aiq_agent.common.norm_registry import KNOWN_APPLICATIONS
from aiq_agent.common.norm_registry import NormsFile

logger = logging.getLogger(__name__)

_ADMIN_TOKEN = os.environ.get("GRID_ADMIN_TOKEN")

# Bundesland -> OGD-RIS "SucheIn<State>" query flag (mirrors scripts/build_ris_catalog.py).
_BUNDESLAND_PARAMS: dict[str, str] = {
    "Wien": "SucheInWien",
    "Niederösterreich": "SucheInNiederoesterreich",
    "Oberösterreich": "SucheInOberoesterreich",
    "Steiermark": "SucheInSteiermark",
    "Kärnten": "SucheInKaernten",
    "Salzburg": "SucheInSalzburg",
    "Tirol": "SucheInTirol",
    "Vorarlberg": "SucheInVorarlberg",
    "Burgenland": "SucheInBurgenland",
}


def _require_admin_token(x_admin_token: str | None = Header(default=None)):
    if not _ADMIN_TOKEN:
        return
    if x_admin_token != _ADMIN_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin token")


class NormsPutRequest(BaseModel):
    """PUT body: the expected version (optimistic lock) plus the new registry."""

    version: int
    registry: NormsFile


class NormsVerifyRequest(BaseModel):
    """POST /verify body: a live OGD-RIS title search seed."""

    title_query: str
    application: str
    bundesland: str = ""
    expect: str = ""
    exclude: list[str] = Field(default_factory=list)
    gesetzesnummer: str = ""


def _rejection_reasons(norms_file: NormsFile) -> list[str]:
    """Entries norm_registry would silently drop — surfaced to the admin as 400 reasons.

    Replicates ``norm_registry._validated_entries``' rules (unknown RIS
    application, unknown Bundesland, duplicate id) with explicit messages so an
    admin SEES the problem instead of having entries vanish on the next load.
    """
    problems: list[str] = []
    seen: set[str] = set()
    for entry in norms_file.entries:
        if entry.id in seen:
            problems.append(f"duplicate entry id '{entry.id}'")
        seen.add(entry.id)
        if entry.application not in KNOWN_APPLICATIONS:
            problems.append(f"entry '{entry.id}': unknown RIS application '{entry.application}'")
        if entry.bundesland and entry.bundesland not in BUNDESLAENDER:
            problems.append(f"entry '{entry.id}': unknown Bundesland '{entry.bundesland}'")
    return problems


def _fallback_registry() -> tuple[NormsFile, int]:
    """YAML-seed view for GET when the store is unavailable (version 0)."""
    registry = norm_registry.load_registry()
    entries = registry.entries if registry is not None else []
    return NormsFile(entries=entries), 0


def add_norm_routes(router: APIRouter) -> None:
    @router.get(
        "/v1/admin/norms",
        tags=["norms"],
        summary="Read the curated norm registry (admin)",
    )
    async def get_norms(_: None = Depends(_require_admin_token)) -> dict:
        from aiq_agent.knowledge.norm_store import get_norm_store

        store = get_norm_store()
        if store is not None:
            norms_file, version = store.get()
            if norms_file is not None:
                return {"version": version, "registry": norms_file.model_dump()}
        norms_file, version = _fallback_registry()
        return {"version": version, "registry": norms_file.model_dump()}

    @router.put(
        "/v1/admin/norms",
        tags=["norms"],
        summary="Replace the curated norm registry (admin)",
    )
    async def put_norms(body: NormsPutRequest, _: None = Depends(_require_admin_token)) -> dict:
        from aiq_agent.knowledge.norm_store import get_norm_store

        # NormsFile schema validation already ran (FastAPI -> 422 with details).
        # Second gate: entries norm_registry would silently drop must be an
        # explicit 400 so the admin sees them, not lose them on the next load.
        problems = _rejection_reasons(body.registry)
        if problems:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=problems)

        store = get_norm_store()
        if store is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Norm store is not configured",
            )

        new_version = store.put(body.registry, expected_version=body.version)
        if new_version is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Version conflict: the registry was modified since you last read it",
            )

        norm_registry.reset_registry_cache()
        return {"version": new_version}

    @router.post(
        "/v1/admin/norms/verify",
        tags=["norms"],
        summary="Live OGD-RIS title search to verify a norm pointer (admin)",
    )
    async def verify_norm(body: NormsVerifyRequest, _: None = Depends(_require_admin_token)) -> dict:
        from ris_adapter.client import RisClient
        from ris_adapter.client import RisError

        params: dict[str, str] = {"Titel": body.title_query}
        if body.bundesland:
            flag = _BUNDESLAND_PARAMS.get(body.bundesland)
            if flag is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Unknown Bundesland '{body.bundesland}'",
                )
            params[f"Bundesland.{flag}"] = "true"

        client = RisClient()
        try:
            hits = []
            page = 1
            while True:
                result = await client.search(body.application, params=params, page=page, page_size=50)
                hits.extend(result.hits)
                if len(hits) >= result.total or not result.hits:
                    break
                page += 1
        except RisError as e:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"OGD-RIS search failed: {e}",
            ) from e
        finally:
            await client.aclose()

        candidates = []
        for hit in hits:
            kurztitel = hit.metadata.get("Kurztitel") or hit.title or ""
            lower = kurztitel.lower()
            if body.expect and body.expect.lower() not in lower:
                continue
            if any(term.lower() in lower for term in body.exclude):
                continue
            # Whole-law anchors only (the "§ 0" document with a consolidated-law URL):
            # that is what a registry pointer references.
            if hit.metadata.get("Paragraph/Artikel") != "§ 0":
                continue
            if not hit.full_law_url:
                continue
            if body.gesetzesnummer and f"Gesetzesnummer={body.gesetzesnummer}" not in hit.full_law_url:
                continue
            candidates.append(
                {
                    "title": kurztitel,
                    "document_number": hit.document_number,
                    "citation_url": hit.citation_url,
                    "full_law_url": hit.full_law_url,
                }
            )

        return {"candidates": candidates, "verified_at": date.today().isoformat()}
