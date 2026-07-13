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
            logger.warning("Org-scoped remember denied by frontend policy (org memory disabled)")
            return (
                "Error: organization-wide memory is disabled by the administrator in this "
                "deployment; the finding was NOT saved. Tell the user that firm-wide rules "
                "currently have to be added by hand in the organization memory panel. Do not retry."
            )
        except Exception:
            logger.exception("Failed to record memory item")
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
