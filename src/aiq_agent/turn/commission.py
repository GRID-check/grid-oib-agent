"""Commissioning a run for a question this turn will not answer itself.

## What changed, and why it is not a submit any more

An escalated question used to be submitted straight to the worker from here:
``submit_agent_job`` with no conversation and no run row, a stub sentence
written into the thread („Deep research job submitted. Job ID: …") and a job id
carried on the state for the frontend to hang a panel off. Nothing else in the
product knew that work existed — it could not be listed, stopped, filed or
named — because the only record of it was a string in a message.

It is now commissioned through the BFF, which is the single writer of the
workspace (ADR-0003) and the owner of the run primitive (ADR-0055, ADR-0062):
``POST /api/internal/tasks`` with ``op: "research"``. The BFF writes the
``task_runs`` row, mints the run's message in this thread, submits the job with
that run's id, and answers with where the run narrates itself. The turn's own
answer then carries those two ids and no prose at all — the block IS the
narration.

## Echo, never sign

Same rule as ``tools/tasks/client.py``, for the same reason: the internal token
and the signing secret are one secret, so a tier that minted its own envelope
would be choosing the acting person with a credential that only authenticates
the service. The envelope the BFF minted for this turn is forwarded
byte-for-byte, and a turn without one cannot commission anything.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any
from typing import Literal

from aiq_agent import project_context
from aiq_agent.tools.documents.filing import SignedEnvelope
from aiq_agent.tools.tasks.client import DelegationError
from aiq_agent.tools.tasks.client import post_task

logger = logging.getLogger(__name__)

#: Bound on the question, matching the route's own (`TASK_GOAL_MAX_CHARS`). A
#: longer one is cut here rather than refused there: the question is the run's
#: prompt AND its title, and a refusal would lose the work over a long sentence.
MAX_QUESTION_CHARS = 500

#: Bound on the context block (`RESEARCH_CONTEXT_MAX_CHARS`). What the clarifier
#: settled is worth carrying; a transcript is not.
MAX_CONTEXT_CHARS = 8_000

#: Why a question could not become a run. Each one is a different sentence to
#: the reader, which is the whole reason this is not a bool.
CommissionRefusal = Literal["no_project", "no_envelope", "forbidden", "busy", "unreachable"]


@dataclass(frozen=True)
class CommissionedRun:
    """Where the commissioned run narrates itself."""

    run_id: str
    #: The run's message in this thread, or ``None`` when the BFF could not mint
    #: one — the run still runs, it just has no block to watch.
    run_message_id: str | None
    conversation_id: str


class CommissionRefused(RuntimeError):
    """The question could not become a run. Carries what the reader may be told."""

    def __init__(
        self,
        reason: CommissionRefusal,
        message: str,
        *,
        retry_after_seconds: int | None = None,
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.retry_after_seconds = retry_after_seconds


def _envelope() -> SignedEnvelope:
    header, signature = project_context.get_request_envelope_from_context()
    if not header or not signature:
        raise CommissionRefused("no_envelope", "this turn carries no signed request context")
    return SignedEnvelope(header=header, signature=signature)


def _payload(project_id: str, question: str, context: str | None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "op": "research",
        "projectId": project_id,
        "question": " ".join(question.split())[:MAX_QUESTION_CHARS],
    }
    settled = (context or "").strip()
    if settled:
        payload["context"] = settled[:MAX_CONTEXT_CHARS]
    return payload


def _refusal_from(error: DelegationError) -> CommissionRefused:
    """The route's status, as the one sentence the turn has to act on.

    403/404 are the authorization ladder's answer to „you may not commission
    here" — the ladder answers 404 for a project the caller cannot reach on
    purpose, so the two are one case. 409 means the envelope named no thread,
    which is a bug in the caller rather than something the reader did.
    """
    if error.status in (403, 404):
        return CommissionRefused("forbidden", str(error))
    if error.status == 429:
        return CommissionRefused("busy", str(error))
    return CommissionRefused("unreachable", str(error))


async def commission_research_run(question: str, *, context: str | None = None) -> CommissionedRun:
    """Turn this turn's question into a run, and say where it narrates itself.

    Raises :class:`CommissionRefused` for every refusal, so the caller has one
    thing to catch and one place to decide what the reader is told.
    """
    project_id = project_context.get_project_id_from_context()
    if not project_id:
        # A run is project-scoped work: the row's tenancy predicate requires a
        # project, and there is no such thing as a run outside one.
        raise CommissionRefused("no_project", "this conversation is not in a project")
    envelope = _envelope()

    try:
        body = await asyncio.to_thread(post_task, _payload(project_id, question, context), envelope)
    except DelegationError as exc:
        logger.info("Research run refused by the task API: %s", exc)
        raise _refusal_from(exc) from exc

    run_id = body.get("runId")
    conversation_id = body.get("conversationId")
    if not isinstance(run_id, str) or not run_id or not isinstance(conversation_id, str):
        raise CommissionRefused("unreachable", "the task API answered without a run")
    message_id = body.get("runMessageId")
    return CommissionedRun(
        run_id=run_id,
        run_message_id=message_id if isinstance(message_id, str) and message_id else None,
        conversation_id=conversation_id,
    )
