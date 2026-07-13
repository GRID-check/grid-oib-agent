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
import logging

from pydantic import Field

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


def _emit_memory_proposal_card(*, content: str, kind: str, confidence: str) -> bool:
    """Build and register a ``memory_proposal`` confirmation card.

    Returns True if the card was added to a bound conversation-scoped card
    registry, False when no card channel is available (so the caller can fall
    back to an honest error string). Mirrors ``emit_card``'s None handling.
    """
    from aiq_agent.cards.models import grid_card_adapter
    from aiq_agent.cards.registry import get_card_registry

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
    except Exception:
        logger.exception("Failed to build memory_proposal card")
        return False
    registry.add(validated)
    logger.info("Emitted memory_proposal card (kind=%s) for user-authorized memory write", kind)
    return True


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
    "self-contained sentence."
)


class ProjectMemoryRememberConfig(FunctionBaseConfig, name="project_memory_remember"):
    """Configuration for the project-memory ``remember`` tool."""

    max_content_chars: int = Field(default=500, description="Maximum characters per remembered finding.")


@register_function(config_type=ProjectMemoryRememberConfig)
async def project_memory_remember(tool_config: ProjectMemoryRememberConfig, builder: Builder):
    from aiq_agent.knowledge.project_memory import VALID_CONFIDENCES
    from aiq_agent.knowledge.project_memory import VALID_KINDS
    from aiq_agent.knowledge.project_memory import OrgMemoryDisabledError
    from aiq_agent.knowledge.project_memory import insert_memory_item
    from aiq_agent.project_context import get_conversation_id_from_context
    from aiq_agent.project_context import get_organization_id_from_context
    from aiq_agent.project_context import get_project_id_from_context

    async def _remember(kind: str, content: str, confidence: str = "medium", scope: str = "project") -> str:
        """Record one durable finding in project or organization memory."""
        kind = (kind or "").strip().lower()
        confidence = (confidence or "medium").strip().lower()
        scope = (scope or "project").strip().lower()
        content = (content or "").strip()

        if kind not in VALID_KINDS:
            return f"Error: invalid kind '{kind}'. Use one of: {', '.join(sorted(VALID_KINDS))}."
        if scope not in {"project", "organization"}:
            scope = "project"
        if confidence not in VALID_CONFIDENCES:
            confidence = "medium"
        if not content:
            return "Error: content must not be empty."
        if len(content) > tool_config.max_content_chars:
            content = content[: tool_config.max_content_chars]

        project_id = get_project_id_from_context()
        organization_id = get_organization_id_from_context()

        if scope == "project" and not project_id:
            if organization_id:
                # No project in scope but the finding is still worth keeping, so
                # escalate to org scope. NOTE: in default deployments the frontend
                # denies agent org-wide writes (ORG_MEMORY_DISABLED, audit finding
                # S1) unless GRID_ALLOW_AGENT_ORG_MEMORY=true; when that happens the
                # OrgMemoryDisabledError branch below returns an honest message that
                # explains it to the user. (Escalation kept intentionally — product
                # decision deferred.)
                scope = "organization"
            else:
                return (
                    "Error: no project in scope for this conversation — memory can only be "
                    "recorded in project-scoped chats. Do not retry."
                )
        if scope == "organization" and not organization_id:
            return "Error: organization unknown for this session — cannot record org-wide memory. Do not retry."

        conversation_id = get_conversation_id_from_context()

        try:
            item_id = await asyncio.to_thread(
                insert_memory_item,
                scope=scope,
                project_id=project_id if scope == "project" else None,
                organization_id=organization_id,
                kind=kind,
                content=content,
                confidence=confidence,
                conversation_id=conversation_id,
            )
        except OrgMemoryDisabledError:
            # The agent's service token is blocked from org-wide writes (default
            # deny). Rather than silently failing, offer the user the sanctioned
            # path: a confirmation card lets them complete the write through their
            # OWN authenticated session (org-wide) or save it to just this project.
            # This clear() branch is taken whenever an org write is refused by policy.
            logger.warning("Org-scoped remember denied by frontend policy (org memory disabled)")
            if _emit_memory_proposal_card(content=content, kind=kind, confidence=confidence):
                return _CARD_SHOWN_RESULT
            # No card channel bound — fall back to the honest error string.
            return (
                "Error: organization-wide memory is disabled by the administrator in this "
                "deployment; the finding was NOT saved. Tell the user that firm-wide rules "
                "currently have to be added by hand in the organization memory panel. Do not retry."
            )
        except Exception:
            logger.exception("Failed to record memory item")
            # For an ORG-scoped write, a generic failure is also blocked by the
            # agent's service token — offer the same user-authorized confirmation
            # card instead of a dead end. Project-scoped failures keep the existing
            # honest error string.
            if scope == "organization" and _emit_memory_proposal_card(
                content=content, kind=kind, confidence=confidence
            ):
                return _CARD_SHOWN_RESULT
            return (
                "Error: the finding was NOT saved — long-term memory is unavailable. Do not tell "
                "the user it has been noted; if they asked you to remember this, tell them it could "
                "not be stored. Continue the main task."
            )

        if item_id is None:
            return "Error: unknown project — nothing recorded."

        logger.info("Recorded %s memory item %s (%s)", scope, item_id, kind)
        return f"Recorded {kind} in {scope} memory."

    yield FunctionInfo.from_fn(_remember, description=_TOOL_DESCRIPTION)
