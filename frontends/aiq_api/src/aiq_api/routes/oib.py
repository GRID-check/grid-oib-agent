# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""OIB admin routes."""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter
from fastapi import Depends
from fastapi import Header
from fastapi import HTTPException
from fastapi import status

from ..models.requests import OibSyncResponse

logger = logging.getLogger(__name__)

_ADMIN_TOKEN = os.environ.get("GRID_ADMIN_TOKEN")


def _require_admin_token(x_admin_token: str | None = Header(default=None)):
    if not _ADMIN_TOKEN:
        return
    if x_admin_token != _ADMIN_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin token")


def _run_ingestion() -> tuple[int, int]:
    # Import here to avoid heavy imports at module load time.
    from aiq_agent.oib_sync import sync

    return sync()


def add_oib_routes(router: APIRouter) -> None:
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="oib-sync-")

    @router.post(
        "/v1/admin/oib/sync",
        response_model=OibSyncResponse,
        tags=["oib"],
        summary="Trigger incremental OIB PDF ingestion",
    )
    async def sync_oib_documents(
        _: None = Depends(_require_admin_token),
    ) -> OibSyncResponse:
        try:
            added, total = await asyncio.get_event_loop().run_in_executor(executor, _run_ingestion)
            return OibSyncResponse(
                status="ok",
                message=f"OIB sync triggered: {added} file(s) added/changed, {total} total tracked",
                files_added=added,
                files_total=total,
            )
        except Exception as e:
            logger.exception("OIB sync failed")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e
