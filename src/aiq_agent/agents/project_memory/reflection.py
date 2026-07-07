"""Async post-answer memory reflection.

The in-turn ``remember`` tool captures findings while the agent is still
answering, but a busy answer often ends before the agent pauses to consolidate
what the exchange actually established. This module adds a **reflection stage**
that runs in the *post-processing phase* — scheduled AFTER the user already has
their answer, as a fire-and-forget background task, so it never adds latency to
the reply.

The stage reads the just-finished exchange and the project's EXISTING memory
digest (the ``x-grid-project-memory`` the BFF injects), asks a small LLM whether
the turn established any NEW durable finding the in-turn tool missed, and writes
each qualifying item through the same token-guarded internal endpoint the
``remember`` tool uses (``grid_app`` stays single-writer).

Design guarantees:
- **Never blocks the answer.** Callers schedule via :func:`schedule_memory_reflection`
  which returns immediately; the work runs on the event loop afterwards.
- **Never crashes the turn.** Every failure path is caught and logged; the worst
  outcome is that no memory is recorded.
- **Opt-in.** With no reflection LLM configured the scheduler is a no-op.
- **Context-free execution.** All request-scoped values (ids, digest, text) are
  captured by the caller and passed explicitly, so the task is safe to run after
  the request context has been torn down.

See docs/architecture/project-memory-design.md.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from aiq_agent.common.json_utils import extract_json
from aiq_agent.knowledge.project_memory import VALID_CONFIDENCES
from aiq_agent.knowledge.project_memory import VALID_KINDS
from aiq_agent.knowledge.project_memory import insert_memory_item

logger = logging.getLogger(__name__)

# A reflection turn records a small, curated set — it is a safety net for what
# the in-turn `remember` tool missed, not a bulk extractor.
MAX_NEW_ITEMS = 5
_MAX_CONTENT_CHARS = 500
_MAX_ANSWER_CHARS = 4000
_MAX_QUERY_CHARS = 2000

REFLECTION_SYSTEM_PROMPT = (
    "You are Grid's memory-reflection step. You run in the background AFTER the user "
    "already received their answer, so you never block the reply. Read the just-finished "
    "exchange and the project's EXISTING memory, then decide whether the exchange "
    "established any NEW durable finding worth keeping for future conversations.\n\n"
    "Record a finding ONLY if ALL of these hold:\n"
    "- it is durable — true across future turns, not transient conversation detail;\n"
    "- it is about THIS project or a firm-wide convention — NEVER general building-code "
    "knowledge (OIB limits, ÖNORM values etc. already live in the corpus);\n"
    "- it is NOT already present in the existing memory shown below (never restate);\n"
    "- it captures something the USER established (a decision, constraint, open question, "
    "concluded fact, or preference) — do not invent speculative inferences.\n\n"
    "kind must be one of: decision, constraint, open_question, derived_fact, preference.\n"
    "scope is 'project' (default, about this project) or 'organization' (firm-wide).\n"
    "confidence is one of: low, medium, high.\n"
    "content must be ONE concise, self-contained sentence.\n\n"
    f"Return AT MOST {MAX_NEW_ITEMS} findings. If nothing qualifies, return an empty list — "
    "that is the common and correct outcome. Respond with ONLY a JSON object of the form: "
    '{"findings": [{"kind": "...", "content": "...", "confidence": "...", "scope": "..."}]}'
)


def _build_user_prompt(query: str, answer: str, memory_digest: str | None) -> str:
    """Assemble the reflection prompt from the turn and the existing memory."""
    existing = memory_digest.strip() if memory_digest else "(no project memory recorded yet)"
    return (
        "## Existing project memory\n"
        f"{existing}\n\n"
        "## User question\n"
        f"{query.strip()[:_MAX_QUERY_CHARS]}\n\n"
        "## Assistant answer\n"
        f"{answer.strip()[:_MAX_ANSWER_CHARS]}"
    )


def _sanitize_findings(
    raw: Any,
    *,
    has_project: bool,
    has_organization: bool,
) -> list[dict[str, str]]:
    """Validate LLM-proposed findings into insertable memory items.

    Drops anything malformed, out-of-vocabulary, empty, or whose target scope
    has no id available. Mirrors the ``remember`` tool's project→organization
    fallback so a finding is kept when only an org is in scope.
    """
    if not isinstance(raw, list):
        return []
    items: list[dict[str, str]] = []
    for entry in raw[:MAX_NEW_ITEMS]:
        if not isinstance(entry, dict):
            continue
        kind = str(entry.get("kind", "")).strip().lower()
        content = str(entry.get("content", "")).strip()
        confidence = str(entry.get("confidence", "medium")).strip().lower()
        scope = str(entry.get("scope", "project")).strip().lower()

        if kind not in VALID_KINDS or not content:
            continue
        if confidence not in VALID_CONFIDENCES:
            confidence = "medium"
        if scope not in {"project", "organization"}:
            scope = "project"
        if len(content) > _MAX_CONTENT_CHARS:
            content = content[:_MAX_CONTENT_CHARS]

        # Resolve the scope against the ids actually available (same fallback as
        # the remember tool: keep an org-worthy finding when no project is scoped).
        if scope == "project" and not has_project:
            if has_organization:
                scope = "organization"
            else:
                continue
        if scope == "organization" and not has_organization:
            continue

        items.append({"kind": kind, "content": content, "confidence": confidence, "scope": scope})
    return items


async def run_memory_reflection(
    *,
    llm: Any,
    query: str,
    answer: str,
    project_id: str | None,
    organization_id: str | None,
    conversation_id: str | None,
    memory_digest: str | None,
) -> list[str]:
    """Run one reflection pass and record any qualifying findings.

    Returns the ids of the memory items written (empty when nothing qualified or
    on any recoverable failure). Intended to be awaited inside a guarded
    background task; it never raises for expected failure modes.
    """
    from langchain_core.messages import HumanMessage
    from langchain_core.messages import SystemMessage

    messages = [
        SystemMessage(content=REFLECTION_SYSTEM_PROMPT),
        HumanMessage(content=_build_user_prompt(query, answer, memory_digest)),
    ]
    response = await llm.ainvoke(messages)
    content = getattr(response, "content", response)
    text = content if isinstance(content, str) else str(content)

    parsed = extract_json(text)
    findings = parsed.get("findings") if isinstance(parsed, dict) else None
    items = _sanitize_findings(
        findings,
        has_project=bool(project_id),
        has_organization=bool(organization_id),
    )
    if not items:
        logger.info("Memory reflection: no new durable findings for this turn")
        return []

    recorded: list[str] = []
    for item in items:
        scope = item["scope"]
        try:
            item_id = await asyncio.to_thread(
                insert_memory_item,
                scope=scope,
                project_id=project_id if scope == "project" else None,
                organization_id=organization_id,
                kind=item["kind"],
                content=item["content"],
                confidence=item["confidence"],
                conversation_id=conversation_id,
            )
        except Exception:
            logger.exception("Memory reflection: failed to record a %s finding", item["kind"])
            continue
        if item_id:
            recorded.append(item_id)

    if recorded:
        logger.info("Memory reflection recorded %d new memory item(s)", len(recorded))
    return recorded


# Strong references to in-flight tasks so the event loop's weak bookkeeping does
# not garbage-collect a reflection mid-run.
_background_tasks: set[asyncio.Task] = set()


def schedule_memory_reflection(
    *,
    llm: Any,
    query: str,
    answer: str,
    project_id: str | None,
    organization_id: str | None,
    conversation_id: str | None,
    memory_digest: str | None,
) -> asyncio.Task | None:
    """Schedule a reflection pass as a fire-and-forget background task.

    Returns the created task, or ``None`` when reflection is skipped (no LLM, no
    writable scope, empty turn, or no running loop). Never blocks; never raises.
    """
    if llm is None:
        return None
    if not (project_id or organization_id):
        # Nowhere to write — anonymous or non-project conversation.
        return None
    if not (query and answer):
        return None

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.debug("Memory reflection skipped: no running event loop")
        return None

    async def _guarded() -> None:
        try:
            await run_memory_reflection(
                llm=llm,
                query=query,
                answer=answer,
                project_id=project_id,
                organization_id=organization_id,
                conversation_id=conversation_id,
                memory_digest=memory_digest,
            )
        except Exception:
            # A background reflection must never surface as a user-facing failure.
            logger.exception("Memory reflection task failed (non-fatal)")

    task = loop.create_task(_guarded())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task
