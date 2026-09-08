"""``find_projects`` — search the Projektregister on demand (ADR-0054).

The turn-start workspace digest injects the projects that match the OPENING
question. A conversation moves, and the third question is about something the
first recall never looked for — so the register also needs a tool the agent can
reach for mid-turn (spec PR-13, AG-7).

What comes back is a bounded, plain-text block of Steckbriefe: name, id and
profile facts. It is NOT document content and must not be used as evidence for
one (spec PR-14/PR-15) — the tool description says so, because the description
is what the model reads when it decides what the result licenses.

Errors are returned as strings, never raised: a tool that raises takes the turn
down, and a register that is briefly unreachable is a recall problem, not an
answer problem.
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
    "Search the office's Projektregister: which projects this organisation has and WHAT THEY ARE. "
    "Use it when the question is about the office rather than about building law — 'in welchen Projekten "
    "haben wir GK5 in Holzbau', 'wie heißt nochmal das Projekt in der Seestadt' — or when a follow-up names "
    "a project the context did not already carry. Pass the question in the user's own words; German works. "
    "Returns a BOUNDED list of matching projects the caller may read, each with its name, its id and its "
    "Steckbrief (profile facts: status, Bundesland, use, what it is). "
    "It returns NO document content: you may name a project and quote its Steckbrief facts, and you may NOT "
    "state what a project's drawings, reports or concepts say on the strength of a register hit. To read a "
    "project's files, the project has to be brought into view first. The list is the best matches, never "
    "every project the office has — say so if the user asks for a complete list."
)


class WorkspaceFindProjectsConfig(FunctionBaseConfig, name="workspace_find_projects"):
    """Configuration for the Projektregister search tool."""

    max_results: int = Field(default=5, description="Maximum projects named in one result block.")


@register_function(config_type=WorkspaceFindProjectsConfig)
async def workspace_find_projects(tool_config: WorkspaceFindProjectsConfig, builder: Builder):
    from aiq_agent.knowledge.workspace_digest import STECKBRIEF_MAX_CHARS
    from aiq_agent.knowledge.workspace_digest import bound_text
    from aiq_agent.knowledge.workspace_digest import fetch_workspace_digest
    from aiq_agent.project_context import get_organization_id_from_context
    from aiq_agent.project_context import get_organization_membership_id_from_context

    async def _find_projects(query: str) -> str:
        """Find projects in this office by what they are.

        Returns names, ids and profile facts — never document content.
        """
        query = (query or "").strip()
        if not query:
            return (
                "Error: pass what you are looking for as `query` (e.g. 'Wohnbau GK5 Holzbau in Wien'). "
                "Do not retry with an empty query."
            )

        organization_id = get_organization_id_from_context()
        if not organization_id:
            # No organisation means no register: it never crosses that boundary
            # (spec PR-17). A refusal, not an empty result — "no projects found"
            # would read as a fact about the office.
            return (
                "Error: this conversation is not attached to an organisation, so there is no Projektregister "
                "to search. Tell the user that project search is only available inside their office. Do not retry."
            )

        try:
            digest = await asyncio.to_thread(
                fetch_workspace_digest,
                organization_id=organization_id,
                membership_id=get_organization_membership_id_from_context(),
                query=query,
                limit=tool_config.max_results,
            )
        except Exception:
            # The client is documented not to raise, and a tool that raises
            # takes the whole turn down — so this catch is the second lock on
            # the same door rather than a duplicate of the first.
            logger.exception("Projektregister search failed")
            digest = None
        if digest is None:
            return (
                "Error: the Projektregister could not be reached just now, so no projects were found. Say that "
                "the project search is temporarily unavailable rather than answering from what you assume the "
                "office has. Do not retry more than once."
            )

        projects = list(digest.projects[: max(1, tool_config.max_results)])
        if not projects:
            return (
                f"No project in this office matched '{query}' (searched: name and Steckbrief of every project "
                "you may read). Nothing was found — do not name a project anyway."
            )

        lines = [
            f"{len(projects)} matching project(s), best first. Steckbriefe only — profile facts, no document "
            "content. Naming a project is fine; describing what its files say is not, unless the project is in "
            "view. This is a bounded best-match list, not the office's full project list."
        ]
        for project in projects:
            lines.append("")
            lines.append(f"### {project.name} (id: {project.id})")
            lines.append(bound_text(project.steckbrief, STECKBRIEF_MAX_CHARS) or "(no Steckbrief on file)")
        return "\n".join(lines)

    yield FunctionInfo.from_fn(_find_projects, description=_TOOL_DESCRIPTION)
