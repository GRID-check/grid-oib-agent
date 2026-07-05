"""Internal maintenance endpoints used by the purger service.

Deletes the Python-side resources of a purged project: the Chroma
collection (+ its summaries), aiq_jobs rows, and LangGraph checkpoints.
Guarded by GRID_INTERNAL_API_TOKEN; never exposed to end users.
All operations are idempotent — re-running on already-deleted data is a no-op.
"""

import logging
import os

import psycopg
from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class PurgeProjectResourcesRequest(BaseModel):
    collection_name: str | None = None
    conversation_ids: list[str] = []


# Well-known default shipped in docker-compose for local development. It must
# never authenticate anything outside a dev environment.
_DEV_DEFAULT_TOKEN = "grid-internal-dev-token"
_DEV_APP_ENVS = {"development", "dev", "local"}


def _require_internal_token(request: Request) -> None:
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise HTTPException(status_code=403, detail="Forbidden")
    app_env = os.environ.get("APP_ENV", "production").lower()
    if token == _DEV_DEFAULT_TOKEN and app_env not in _DEV_APP_ENVS:
        logger.error(
            "GRID_INTERNAL_API_TOKEN is the well-known dev default "
            "('%s') but APP_ENV=%s is not a dev environment - refusing to "
            "serve internal maintenance requests. Set a real token in the "
            "deployment environment.",
            _DEV_DEFAULT_TOKEN,
            app_env,
        )
        raise HTTPException(status_code=503, detail="Internal API disabled")
    if request.headers.get("x-internal-token") != token:
        raise HTTPException(status_code=403, detail="Forbidden")


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
    pattern = f"%{collection_name}%"
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT DISTINCT job_id FROM job_events WHERE event_data LIKE %s",
                (pattern,),
            )
            job_ids = [row[0] for row in await cur.fetchall()]
            if not job_ids:
                return 0
            await cur.execute(
                "DELETE FROM job_events WHERE job_id = ANY(%s)", (job_ids,)
            )
            await cur.execute(
                "DELETE FROM job_access WHERE job_id = ANY(%s)", (job_ids,)
            )
            await cur.execute(
                "DELETE FROM job_info WHERE job_id = ANY(%s)", (job_ids,)
            )
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


def add_maintenance_routes(router: APIRouter) -> None:
    """Add internal maintenance routes to the FastAPI app."""

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
        jobs_deleted = 0

        if body.collection_name:
            from aiq_agent.knowledge.factory import clear_collection_summaries
            from aiq_agent.knowledge.factory import get_active_ingestor

            ingestor = get_active_ingestor()
            if ingestor is not None and ingestor.get_collection(body.collection_name):
                collection_deleted = ingestor.delete_collection(body.collection_name)
            # delete_collection clears summaries too, but run it explicitly so a
            # previously half-failed purge (collection gone, summaries left) heals.
            clear_collection_summaries(body.collection_name)
            jobs_deleted = await _purge_jobs(body.collection_name)

        await _purge_checkpoints(body.conversation_ids)

        return {
            "collection_deleted": collection_deleted,
            "jobs_deleted": jobs_deleted,
            "checkpoints_purged_for": len(body.conversation_ids),
        }
