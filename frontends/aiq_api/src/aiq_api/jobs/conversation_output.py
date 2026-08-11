"""Materialising a finished job run into the conversation it was given.

A job whose ``output`` is ``chat`` is a scheduled prompt whose result should be
a REAL thread — one a colleague opens from the job's run history, reads, and
keeps typing into. The BFF creates that conversation when the job fires and
sends its id along with the run; this module is the other half, writing the
question and the answer into it once the run finishes.

Two rules shape everything here.

**Python never touches the database.** ``grid_app`` is single-writer and the
BFF owns Postgres, so this writes over the internal HTTP API with the service
token, exactly as the memory-reflection step already does from inside a worker.

**Nothing here may fail a run.** Every call is best-effort. A conversation
write that times out or 500s must never turn a successful research run into a
failed one — the report is already stored on the job, and the thread is a
convenience layered on top of it.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC
from datetime import datetime
from datetime import timedelta
from typing import Any

from ..websocket_reconnect import post_internal_conversation_message

logger = logging.getLogger(__name__)

#: Namespace for the deterministic message ids below.
_JOB_MESSAGE_NAMESPACE = uuid.NAMESPACE_URL

#: What a reader is told when the run did not produce an answer.
#:
#: German, because the product is German and this text lands in a thread a
#: person opens. Factual and short: the run's real status and error live on the
#: job, and inventing an error taxonomy here would mean maintaining a second
#: one that drifts.
FAILURE_NOTICE = (
    "Dieser Job wurde ausgeführt, hat aber kein Ergebnis geliefert. "
    "Den Status und die Fehlermeldung finden Sie im Ausführungsverlauf des Jobs."
)
INTERRUPTED_NOTICE = (
    "Dieser Job wurde abgebrochen, bevor ein Ergebnis vorlag. Den Status finden Sie im Ausführungsverlauf des Jobs."
)


def _message_id(conversation_id: str, job_id: str, role: str) -> str:
    """A stable id per (conversation, job, role).

    The internal route upserts with ``onConflictDoNothing`` on the message id,
    so a retried or duplicated write is a no-op rather than a second copy of
    the answer.
    """
    return str(uuid.uuid5(_JOB_MESSAGE_NAMESPACE, f"grid:job:{conversation_id}:{job_id}:{role}"))


def _organization_id(usage_context: dict | None) -> str | None:
    return ((usage_context or {}).get("identity") or {}).get("organization_id")


async def write_job_turn(
    *,
    conversation_id: str | None,
    job_id: str,
    usage_context: dict | None,
    prompt: str,
    answer: str,
    cards: list[Any] | None = None,
) -> None:
    """Write the job's question and its answer into the conversation.

    No conversation id (a deep-research job, or one whose conversation could
    not be created) means there is nothing to do and no HTTP call is made.
    """
    if not conversation_id:
        return

    organization_id = _organization_id(usage_context)
    if not organization_id:
        logger.warning(
            "Job %s has a conversation but no organization id; skipping the conversation write",
            job_id,
        )
        return

    # ORDER IS BY TIMESTAMP, NOT BY INSERTION. The reader sorts by createdAt
    # and breaks ties on a random uuid, so two rows written in the same
    # millisecond would show in a coin-flip order. Stamping the question one
    # second earlier is what guarantees the thread reads as a question and its
    # answer rather than the reverse.
    now = datetime.now(UTC)
    asked_at = (now - timedelta(seconds=1)).isoformat()

    metadata: dict[str, Any] = {"job_id": job_id}
    if cards:
        metadata["cards"] = cards
    # The persisted assistant row carries the backend job id, so the existing
    # "view report" affordance lights up on it for free — the UI keys that off
    # `deep_research_job_id` on the message, not off anything job-specific.
    metadata["deep_research_job_id"] = job_id

    try:
        await post_internal_conversation_message(
            conversation_id=conversation_id,
            organization_id=organization_id,
            message_id=_message_id(conversation_id, job_id, "user"),
            role="user",
            text=prompt,
            message_type="user_message",
            created_at=asked_at,
        )
        await post_internal_conversation_message(
            conversation_id=conversation_id,
            organization_id=organization_id,
            message_id=_message_id(conversation_id, job_id, "assistant"),
            role="assistant",
            text=answer,
            message_type="agent_response",
            metadata=metadata,
            created_at=now.isoformat(),
        )
    except Exception:  # noqa: BLE001 — best-effort by contract; see module docstring
        logger.warning(
            "Failed to write the conversation turn for job %s",
            job_id,
            exc_info=True,
        )


async def write_job_notice(
    *,
    conversation_id: str | None,
    job_id: str,
    usage_context: dict | None,
    notice: str,
) -> None:
    """Say in the thread that the run produced nothing.

    The conversation is created when the job FIRES, before the outcome is
    known. Without this, a failed run leaves a thread someone opens to find
    completely empty — which reads as a broken product rather than a failed
    run. The interactive path never needs this: there is always a human on a
    socket watching it happen.
    """
    if not conversation_id:
        return

    organization_id = _organization_id(usage_context)
    if not organization_id:
        return

    try:
        await post_internal_conversation_message(
            conversation_id=conversation_id,
            organization_id=organization_id,
            message_id=_message_id(conversation_id, job_id, "notice"),
            role="assistant",
            text=notice,
            message_type="agent_response",
            metadata={"job_id": job_id},
        )
    except Exception:  # noqa: BLE001 — best-effort by contract
        logger.warning("Failed to write the failure notice for job %s", job_id, exc_info=True)
