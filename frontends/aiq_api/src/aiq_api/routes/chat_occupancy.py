"""The chat tier's scaling signal: how many turns run across the fleet (ADR-0080).

KEDA's ``metrics-api`` scaler polls this and sizes the ``aiq-agent`` StatefulSet
to it: ``activeTurns`` divided by the per-replica target is the replica count it
asks for. Any replica can answer, because the count is the global admission pool
in Dragonfly (``turn_admission``), which every replica already keeps for the cap.

Internal-token only, like the maintenance routes: the scaler sends
``x-grid-internal-token``. A count that cannot be read is a 503, never a low
number, so KEDA keeps the replicas it has (its ``fallback``) rather than
scaling in under turns it cannot see.
"""

import asyncio

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request

from aiq_agent.common import turn_admission

from .internal_auth import _require_internal_token

#: The path KEDA's ``metrics-api`` trigger reads (``deploy/pulumi/src/app/backend-scaling.ts``).
CHAT_OCCUPANCY_PATH = "/v1/internal/chat-occupancy"


def add_chat_occupancy_routes(router: APIRouter) -> None:
    """Add the chat-occupancy route to the knowledge router."""

    @router.get(
        CHAT_OCCUPANCY_PATH,
        tags=["internal"],
        summary="Chat turns running across the fleet (internal)",
    )
    async def chat_occupancy(request: Request) -> dict[str, int]:
        _require_internal_token(request)
        # The store client is synchronous: off the loop that serves every chat socket.
        active = await asyncio.to_thread(turn_admission.active_turns)
        if active is None:
            raise HTTPException(status_code=503, detail="Active-turn count unavailable")
        return {"activeTurns": active, "maxActiveTurns": max(turn_admission.MAX_ACTIVE_TURNS, 0)}
