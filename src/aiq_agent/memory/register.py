"""``remember`` tool — silent, observable memory capture.

The agent calls this mid-turn when it learns something durable. Writes go
through the internal BFF endpoint (the backend never touches the app
database — strict single-writer separation); observability comes from the
tool call itself, which streams to the UI as an intermediate step like any
other tool, and from the memory panels where users curate items.

Two scopes:
- ``project`` (default): a finding about the current project.
- ``organization``: cross-cutting knowledge that applies to every project in
  the user's organization (never shared across organizations).

See docs/architecture/project-memory-design.md.
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Annotated
from typing import Literal

from pydantic import BeforeValidator
from pydantic import Field
from pydantic import ValidationError

from aiq_agent import project_context
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import get_card_registry
from aiq_agent.knowledge import project_memory as memory_client
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

# Tool-result string returned once the confirmation card has been shown. It must
# make clear to the model that NOTHING was saved — the user decides through their
# own authenticated session.
_CARD_SHOWN_RESULT = (
    "A confirmation was shown to the user asking whether to remember this org-wide or save it to "
    "this project. It has NOT been saved yet — do not claim it was saved; the user decides."
)
_ORG_DISABLED_RESULT = (
    "Error: organization-wide memory is disabled by the administrator in this "
    "deployment; the finding was NOT saved. Tell the user that firm-wide rules "
    "currently have to be added by hand in the organization memory panel. Do not retry."
)
_UNAVAILABLE_RESULT = (
    "Error: the finding was NOT saved — long-term memory is unavailable. Do not tell "
    "the user it has been noted; if they asked you to remember this, tell them it could "
    "not be stored. Continue the main task."
)
_NO_PROJECT_RESULT = (
    "Error: no project in scope for this conversation — memory can only be "
    "recorded in project-scoped chats. Do not retry."
)
_NO_ORG_RESULT = "Error: organization unknown for this session — cannot record org-wide memory. Do not retry."

#: A failed write that is the transport's fault, not the caller's. Narrow on
#: purpose: ``ValueError`` from the client means this tool's vocabulary and
#: ``knowledge.project_memory``'s have drifted apart, which is a defect that
#: must surface rather than be dressed up as "memory is unavailable".
#: ``OSError`` covers ``urllib.error.URLError``/``HTTPError`` and socket
#: timeouts; ``RuntimeError`` covers the missing-token configuration error and
#: ``OrgMemoryDisabledError``; ``JSONDecodeError`` covers a 200 with a body the
#: client could not read.
_WRITE_FAILURES = (OSError, RuntimeError, json.JSONDecodeError)


def _normalized(value: object) -> object:
    """Lowercase and trim an enum argument, leaving anything else to pydantic.

    Models write ``"Decision"`` or ``" high"``; those are the same value, not a
    different one, so they are folded here rather than rejected. A value that is
    genuinely outside the vocabulary still fails the ``Literal`` below.
    """
    return value.strip().lower() if isinstance(value, str) else value


# The three vocabularies as the model sees them. Declaring them as ``Literal``
# puts an ``enum`` in the tool's JSON schema — so a provider constrains the
# argument before it is ever sent — and turns anything outside it into a
# validation error the tool loop hands back for the model to correct. The tool
# used to rewrite an out-of-vocabulary ``scope`` to ``"project"`` and
# ``confidence`` to ``"medium"`` in silence, which quietly moved a finding into
# a different scope than the one that was asked for.
# ``tests/.../test_register.py`` pins each set against the client's ``VALID_*``.
ScopeName = Literal["project", "organization"]

Kind = Annotated[
    Literal["decision", "constraint", "open_question", "derived_fact", "preference"],
    BeforeValidator(_normalized),
]
Confidence = Annotated[Literal["low", "medium", "high"], BeforeValidator(_normalized)]
Scope = Annotated[ScopeName, BeforeValidator(_normalized)]


@dataclass(frozen=True)
class _Target:
    """Where a write actually lands, after the scope policy has had its say."""

    scope: ScopeName
    project_id: str | None
    organization_id: str | None


def _resolve_target(scope: str, project_id: str | None, organization_id: str | None) -> _Target | str:
    """The target for this write, or the error string to hand back to the model.

    A project-scoped call with no project in scope escalates to the
    organization, because the finding is still worth keeping. NOTE: in default
    deployments the frontend denies agent org-wide writes (ORG_MEMORY_DISABLED,
    audit finding S1) unless ``GRID_ALLOW_AGENT_ORG_MEMORY=true``; the caller
    then turns the refusal into a confirmation card. (Escalation kept
    intentionally — product decision deferred.)
    """
    if scope == "project" and project_id:
        return _Target("project", project_id, organization_id)
    if not organization_id:
        return _NO_PROJECT_RESULT if scope == "project" else _NO_ORG_RESULT
    return _Target("organization", None, organization_id)


def _emit_memory_proposal_card(*, content: str, kind: str, confidence: str) -> bool:
    """Build and register a ``memory_proposal`` confirmation card.

    Returns True if the card was added to a bound conversation-scoped card
    registry, False when no card channel is available (so the caller can fall
    back to an honest error string). Mirrors ``emit_card``'s None handling.
    """
    registry = get_card_registry()
    if registry is None:
        return False

    card = {
        "type": "memory_proposal",
        "title": "Neue Erkenntnis merken",
        "content": content,
        "kind": kind,
        "confidence": confidence,
    }
    try:
        validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
    except ValidationError:
        logger.exception("Failed to build memory_proposal card")
        return False
    registry.add(validated)
    logger.info("Emitted memory_proposal card (kind=%s) for user-authorized memory write", kind)
    return True


def _failure_result(exc: Exception, *, scope: str, kind: str, content: str, confidence: str) -> str:
    """Translate a failed write into a tool result, emitting a card when one helps.

    An ORG-scoped write the agent's service token may not make is the one
    failure with a sanctioned alternative: a confirmation card lets the user
    complete the write through their OWN authenticated session (org-wide) or
    save it to just this project. Everything else — and every project-scoped
    failure — gets an honest error string instead of a dead end.
    """
    org_denied = isinstance(exc, memory_client.OrgMemoryDisabledError)
    if org_denied:
        logger.warning("Org-scoped remember denied by frontend policy (org memory disabled)")
    else:
        logger.error("Failed to record memory item", exc_info=exc)

    if (org_denied or scope == "organization") and _emit_memory_proposal_card(
        content=content, kind=kind, confidence=confidence
    ):
        return _CARD_SHOWN_RESULT
    return _ORG_DISABLED_RESULT if org_denied else _UNAVAILABLE_RESULT


def _success_result(kind: str, scope: str, *, supersedes: bool) -> str:
    """The tool result for a write that landed."""
    if not supersedes:
        return f"Recorded {kind} in {scope} memory."
    # Deliberately not claiming the old entry WAS retired: the frontend ignores
    # a quote it cannot resolve, or one naming a human-curated entry, and this
    # call does not learn which happened.
    return f"Recorded {kind} in {scope} memory, replacing the earlier note where it still matched."


_TOOL_DESCRIPTION = (
    "Record ONE durable finding in long-term memory. Use when the conversation establishes "
    "something worth knowing in future conversations: a decision the client/user made "
    "('decision'), a requirement imposed on the project ('constraint'), an unresolved question "
    "to follow up ('open_question'), a concluded property of the project ('derived_fact'), or "
    "how the user wants Grid to work ('preference'). Scope 'project' (default) is for findings "
    "about the current project; scope 'organization' is for knowledge that applies to ALL of the "
    "user's projects (e.g. firm-wide conventions or preferences). Do NOT record general "
    "building-code knowledge, transient conversation details, restatements of the user's "
    "message, or facts already in the project profile. Content must be one concise, "
    "self-contained sentence.\n"
    "When this finding CORRECTS something already in the PROJECT_MEMORY shown in your context "
    "— the user changed a project fact, or an earlier note turned out to be wrong — pass the "
    "outdated entry's text VERBATIM as 'supersedes' (without its [kind | confidence | "
    "verification] tag and surrounding quotes). That retires the stale entry instead of leaving "
    "two contradictory notes in memory. Leave 'supersedes' empty when the finding simply adds "
    "something new."
)


class ProjectMemoryRememberConfig(FunctionBaseConfig, name="project_memory_remember"):
    """Configuration for the project-memory ``remember`` tool."""

    max_content_chars: int = Field(default=500, description="Maximum characters per remembered finding.")


@register_function(config_type=ProjectMemoryRememberConfig)
async def project_memory_remember(tool_config: ProjectMemoryRememberConfig, builder: Builder):
    async def _remember(
        kind: Kind,
        content: str,
        confidence: Confidence = "medium",
        scope: Scope = "project",
        supersedes: str = "",
    ) -> str:
        """Record one durable finding in project or organization memory."""
        content = content.strip()
        if not content:
            return "Error: content must not be empty."
        content = content[: tool_config.max_content_chars]
        supersedes = supersedes.strip()

        target = _resolve_target(
            scope,
            project_context.get_project_id_from_context(),
            project_context.get_organization_id_from_context(),
        )
        if isinstance(target, str):
            return target

        try:
            item_id = await asyncio.to_thread(
                memory_client.insert_memory_item,
                scope=target.scope,
                project_id=target.project_id,
                organization_id=target.organization_id,
                kind=kind,
                content=content,
                confidence=confidence,
                conversation_id=project_context.get_conversation_id_from_context(),
                # Retires the entry this finding corrects. The frontend resolves
                # the quote and ignores it when nothing matches or the target is
                # human-curated, so the write lands either way.
                supersedes_content=supersedes or None,
            )
        except _WRITE_FAILURES as exc:
            return _failure_result(exc, scope=target.scope, kind=kind, content=content, confidence=confidence)

        if item_id is None:
            return "Error: unknown project — nothing recorded."
        logger.info("Recorded %s memory item %s (%s)", target.scope, item_id, kind)
        return _success_result(kind, target.scope, supersedes=bool(supersedes))

    yield FunctionInfo.from_fn(_remember, description=_TOOL_DESCRIPTION)
