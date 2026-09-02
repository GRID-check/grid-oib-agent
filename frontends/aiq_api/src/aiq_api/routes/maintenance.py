"""Internal maintenance endpoints used by the purger service and the BFF's sweep.

Deletes the Python-side resources of a purged project: the Chroma
collection (+ its summaries), aiq_jobs rows, and LangGraph checkpoints.
Guarded by GRID_INTERNAL_API_TOKEN; never exposed to end users.
All operations are idempotent — re-running on already-deleted data is a no-op.

Also reconciles the summaries table against the vector store
(``reconcile-summaries``): the agent's document inventory is built from
summary rows alone, so a row whose chunks are gone lists a file nobody can
retrieve. ``delete_file`` now forgets both together; this sweep catches the
rows orphaned before it did.
"""

import asyncio
import logging
import os
import re
from typing import Any
from urllib.parse import unquote

import psycopg
from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request
from pydantic import BaseModel
from pydantic import Field

# The internal-token guard is shared with the skills submit route. Re-exported
# here so existing imports (and tests) of these names from routes.maintenance
# keep working while a single implementation lives in one place.
from .internal_auth import _DEV_APP_ENVS  # noqa: F401 - re-export for backwards compatibility
from .internal_auth import _DEV_DEFAULT_TOKEN  # noqa: F401 - re-export for backwards compatibility
from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)


class PurgeProjectResourcesRequest(BaseModel):
    collection_name: str | None = None
    conversation_ids: list[str] = []


def _jobs_dsn() -> str | None:
    dsn = os.environ.get("AIQ_SUMMARY_DB")
    return dsn.replace("+psycopg", "") if dsn else None


async def _purge_jobs(collection_name: str) -> int:
    """Delete job rows whose events reference the project's collection.

    job_info has no project/collection column (see spec §4), so matching is
    LIKE-based on job_events.event_data. Collection names are `proj_<uuid>`,
    unique enough for a substring match. Improvement tracked for Phase 4:
    tag job_info with a collection column at submission time.
    """
    dsn = _jobs_dsn()
    if dsn is None:
        return 0
    # Escape LIKE metacharacters so a caller cannot pass e.g. "%" (or a name
    # containing "_") and match — and delete — job rows across every project /
    # org. ESCAPE '\' pairs with the escaped pattern below.
    escaped = collection_name.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{escaped}%"
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT DISTINCT job_id FROM job_events WHERE event_data LIKE %s ESCAPE '\\'",
                (pattern,),
            )
            job_ids = [row[0] for row in await cur.fetchall()]
            if not job_ids:
                return 0
            await cur.execute("DELETE FROM job_events WHERE job_id = ANY(%s)", (job_ids,))
            await cur.execute("DELETE FROM job_access WHERE job_id = ANY(%s)", (job_ids,))
            await cur.execute("DELETE FROM job_info WHERE job_id = ANY(%s)", (job_ids,))
        await conn.commit()
    return len(job_ids)


async def _purge_checkpoints(conversation_ids: list[str]) -> None:
    dsn = os.environ.get("AIQ_CHECKPOINT_DB")
    if not dsn or not conversation_ids:
        return
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
                await cur.execute(
                    f"DELETE FROM {table} WHERE thread_id = ANY(%s)",  # nosec B608 - fixed table names
                    (conversation_ids,),
                )
        await conn.commit()


class ReconcileSummariesRequest(BaseModel):
    """Scope and mode of one summary-reconcile sweep.

    ``collections`` omitted means every collection that holds a summary row.
    The BFF passes the collections it just chunk-reconciled, so the
    separately managed OIB corpus is never touched from that caller.
    """

    collections: list[str] | None = None
    dry_run: bool = Field(default=False, description="Report the orphans without forgetting them.")


# Same two divergences ``delete_file`` normalises away before it compares a
# stored chunk name with a requested one: the temp-upload prefix and
# percent-encoding. A summary row and its chunks were written by the same
# ingest, but not always under the same spelling.
_TMP_PREFIX = re.compile(r"^tmp.{8}_")


def _normalized_name(name: str) -> str:
    return unquote(_TMP_PREFIX.sub("", name or ""))


def _reconcile_one_collection(
    ingestor: Any,
    collection: str,
    *,
    live_chunk_counts: dict[str, int],
    dry_run: bool,
) -> list[str]:
    """Return the summary filenames in ``collection`` that own no chunks, forgetting them unless ``dry_run``.

    Raises on anything that would make the verdict unsafe. The caller records
    the raise as a per-collection failure and moves on.
    """
    from aiq_agent.knowledge import factory as knowledge_factory
    from aiq_agent.knowledge.chunk_text_store import get_chunk_text_store
    from aiq_agent.knowledge.ingest_status_store import in_flight_files

    summaries = knowledge_factory.get_available_documents(collection)
    if not summaries:
        return []

    held: set[str] = set()
    if collection in live_chunk_counts:
        files = ingestor.list_files(collection)
        # ``list_files`` answers ``[]`` for a collection it could not reach as
        # well as for an empty one. Chroma reported chunks a moment ago, so an
        # empty listing here is a failed read, not an empty collection — and
        # a failed read must not forget every summary the collection has.
        if not files and live_chunk_counts[collection] > 0:
            raise RuntimeError("file listing came back empty for a collection that holds chunks")
        # ANY tracked status keeps a summary: a file that failed or is still
        # ingesting has no chunks yet and is not an orphan.
        held = {_normalized_name(f.file_name) for f in files}
    # A collection Chroma no longer has: every summary in it is an orphan
    # (the purge route clears them the same way). Either way, a file whose
    # ingest is still running is not judged this sweep.
    for name in in_flight_files([collection]).get(collection, []):
        held.add(_normalized_name(name))

    orphans = sorted(doc.file_name for doc in summaries if _normalized_name(doc.file_name) not in held)
    if dry_run:
        return orphans
    text_store = get_chunk_text_store()
    for file_name in orphans:
        knowledge_factory.unregister_summary(collection, file_name)
        # The lexical mirror is keyed the way the row is; forget it under both
        # spellings, as ``delete_file`` does.
        text_store.delete_by_file(collection, file_name)
        normalized = _normalized_name(file_name)
        if normalized != file_name:
            text_store.delete_by_file(collection, normalized)
    return orphans


async def reconcile_orphaned_summaries(collections: list[str] | None, *, dry_run: bool) -> dict[str, Any]:
    """Forget summary rows whose file holds no chunks in the vector store.

    Fails per collection, never as a whole: one unreachable collection is
    reported in ``failures`` and the others are still swept. The one
    whole-request failure is a vector store that cannot be listed at all,
    because then nothing can be judged.
    """
    from aiq_agent.knowledge import factory as knowledge_factory

    ingestor = knowledge_factory.get_active_ingestor()
    if ingestor is None:
        raise HTTPException(status_code=503, detail="No active ingestor; summaries cannot be reconciled")
    try:
        # Chroma scans are synchronous; keep them off the event loop so a long
        # sweep does not stall every other request the API is serving.
        live_chunk_counts = {info.name: info.chunk_count for info in await asyncio.to_thread(ingestor.list_collections)}
    except Exception as exc:
        logger.warning("reconcile-summaries: could not list vector-store collections: %s", exc)
        raise HTTPException(status_code=503, detail="Vector store unavailable; nothing reconciled") from exc

    targets = collections if collections is not None else knowledge_factory.list_summary_collections()

    forgotten: list[dict[str, str]] = []
    failures: list[dict[str, str]] = []
    for collection in targets:
        try:
            orphans = await asyncio.to_thread(
                _reconcile_one_collection,
                ingestor,
                collection,
                live_chunk_counts=live_chunk_counts,
                dry_run=dry_run,
            )
        except Exception as exc:
            logger.warning("reconcile-summaries: %s failed: %s", collection, exc)
            failures.append({"collection": collection, "error": str(exc)})
            continue
        forgotten.extend({"collection": collection, "file_name": name} for name in orphans)
        if orphans:
            logger.warning(
                "reconcile-summaries: %s %d chunk-less summary row(s) in %s: %s",
                "would forget" if dry_run else "forgot",
                len(orphans),
                collection,
                orphans,
            )

    return {
        "status": "ok",
        "dry_run": dry_run,
        "collections_scanned": len(targets),
        "orphans_found": len(forgotten),
        "orphans_forgotten": 0 if dry_run else len(forgotten),
        "forgotten": forgotten,
        "failures": failures,
    }


def add_maintenance_routes(router: APIRouter) -> None:
    """Add internal maintenance routes to the FastAPI app."""

    @router.post(
        "/v1/maintenance/reconcile-summaries",
        tags=["maintenance"],
        summary="Forget summary rows whose chunks are gone (internal)",
    )
    async def reconcile_summaries(
        body: ReconcileSummariesRequest,
        request: Request,
    ) -> dict:
        _require_internal_token(request)
        return await reconcile_orphaned_summaries(body.collections, dry_run=body.dry_run)

    @router.post(
        "/v1/maintenance/purge-project-resources",
        tags=["maintenance"],
        summary="Purge Python-side resources of a deleted project (internal)",
    )
    async def purge_project_resources(
        body: PurgeProjectResourcesRequest,
        request: Request,
    ) -> dict:
        _require_internal_token(request)

        collection_deleted = False
        # Unambiguous outcome for the caller: "deleted" (removed now),
        # "not_found" (already gone — idempotent success) or "failed" (existed
        # but delete_collection returned falsy). The purger must retry on
        # "failed" rather than orphan the collection.
        collection_status = "not_found"
        jobs_deleted = 0

        if body.collection_name:
            from aiq_agent.knowledge.factory import clear_collection_summaries
            from aiq_agent.knowledge.factory import get_active_ingestor

            ingestor = get_active_ingestor()
            if ingestor is not None and ingestor.get_collection(body.collection_name):
                collection_deleted = ingestor.delete_collection(body.collection_name)
                collection_status = "deleted" if collection_deleted else "failed"
            # delete_collection clears summaries too, but run it explicitly so a
            # previously half-failed purge (collection gone, summaries left) heals.
            clear_collection_summaries(body.collection_name)
            jobs_deleted = await _purge_jobs(body.collection_name)

        await _purge_checkpoints(body.conversation_ids)

        return {
            "status": "failed" if collection_status == "failed" else "ok",
            "collection_status": collection_status,
            "collection_deleted": collection_deleted,
            "jobs_deleted": jobs_deleted,
            "checkpoints_purged_for": len(body.conversation_ids),
        }
