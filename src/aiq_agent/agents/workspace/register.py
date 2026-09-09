"""The office's two tools: ``find_projects`` and ``open_project`` (ADR-0054).

They are the two halves of one move, and the order is the point: the register
says WHICH project, mounting is what makes its documents readable.

``find_projects`` searches the Projektregister on demand. The turn-start
workspace digest injects the projects that match the OPENING question; a
conversation moves, and the third question is about something the first recall
never looked for (spec PR-13, AG-7). What comes back is a bounded, plain-text
block of Steckbriefe: name, id and profile facts. It is NOT document content and
must not be used as evidence for one (spec PR-14/PR-15) — the tool description
says so, because the description is what the model reads when it decides what
the result licenses.

``open_project`` brings one of those projects into view for the conversation:
the BFF checks the ACTING USER's ``project:chat``, writes the mount row and
signs a grant, and ``knowledge/mounts.py`` verifies that grant and widens this
turn's collection scope by it. The tool decides nothing about access — it asks,
and it renders the answer for two readers at once: the first line is one JSON
object the UI parses into its MountNotice, and everything after the blank line
is German prose for the model.

Errors are returned as strings, never raised: a tool that raises takes the turn
down, and a register that is briefly unreachable is a recall problem, not an
answer problem.
"""

import asyncio
import json
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
    "project's files, call `open_project` with the id printed next to its name — that brings the project into "
    "view for this conversation, and only then may you search and cite its documents. The list is the best "
    "matches, never every project the office has — say so if the user asks for a complete list. "
    "`limit` raises how many are named, up to ten: use it when the question is about a SET of projects "
    "('alle Projekte in Wien') and you have to name them before proposing a Portfolio-Recherche; leave it "
    "unset for an ordinary lookup."
)


class WorkspaceFindProjectsConfig(FunctionBaseConfig, name="workspace_find_projects"):
    """Configuration for the Projektregister search tool."""

    max_results: int = Field(
        default=5,
        description="Projects named in one result block when the caller does not ask for a different number.",
    )


@register_function(config_type=WorkspaceFindProjectsConfig)
async def workspace_find_projects(tool_config: WorkspaceFindProjectsConfig, builder: Builder):
    from aiq_agent.knowledge.workspace_digest import RECALL_MAX_LIMIT
    from aiq_agent.knowledge.workspace_digest import STECKBRIEF_MAX_CHARS
    from aiq_agent.knowledge.workspace_digest import bound_text
    from aiq_agent.knowledge.workspace_digest import clamped_limit
    from aiq_agent.knowledge.workspace_digest import fetch_workspace_digest
    from aiq_agent.project_context import get_organization_id_from_context
    from aiq_agent.project_context import get_organization_membership_id_from_context

    async def _find_projects(query: str, limit: int | None = None) -> str:
        """Find projects in this office by what they are.

        Args:
            query: What you are looking for, in the user's own words.
            limit: How many projects to name, 1 to 10. Omit for the default.

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

        # The model may ask for more than the default when it has to enumerate a
        # SET before proposing a Portfolio-Recherche (spec DR-3). The ceiling is
        # the register endpoint's own (RECALL_MAX_LIMIT), not a second opinion
        # about it: asking for more returns that many anyway, so a larger number
        # would only make the block claim a completeness it never had. A limit
        # the tool cannot read as a size — absent, zero, negative — is the
        # CONFIGURED default and never one: "no particular number" is what the
        # ordinary lookup already answers.
        wanted = clamped_limit(limit, default=tool_config.max_results)
        try:
            digest = await asyncio.to_thread(
                fetch_workspace_digest,
                organization_id=organization_id,
                membership_id=get_organization_membership_id_from_context(),
                query=query,
                limit=wanted,
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

        projects = list(digest.projects[:wanted])
        if not projects:
            return (
                f"No project in this office matched '{query}' (searched: name and Steckbrief of every project "
                "you may read). Nothing was found — do not name a project anyway."
            )

        lines = [
            f"{len(projects)} matching project(s), best first. Steckbriefe only — profile facts, no document "
            "content. Naming a project is fine; describing what its files say is not, unless the project is in "
            f"view. This is a bounded best-match list (at most {wanted} of at most {RECALL_MAX_LIMIT}), not the "
            "office's full project list."
        ]
        for project in projects:
            lines.append("")
            lines.append(f"### {project.name} (id: {project.id})")
            lines.append(bound_text(project.steckbrief, STECKBRIEF_MAX_CHARS) or "(no Steckbrief on file)")
        return "\n".join(lines)

    yield FunctionInfo.from_fn(_find_projects, description=_TOOL_DESCRIPTION)


_OPEN_PROJECT_DESCRIPTION = (
    "Bring ONE project into view for this conversation, so its documents can be searched and cited. "
    "Pass the project's id — the `id:` printed beside its name by `find_projects` or in the "
    "'Passende Projekte' block; never a name, and never an id you have not seen. "
    "Call it BEFORE searching for anything in a project: in the office, a document search reaches only the "
    "projects that are in view, so a search that runs first quietly answers from the wrong shelf. "
    "Access is decided by the office, not by you: the result says whether the project is now in view, or why "
    "it is not — no access, the limit on how many projects one conversation may hold, or a project that "
    "cannot be found. A refusal is a fact to tell the user, never a reason to answer from what you assume the "
    "project contains. Mounting one project never removes another, and mounting the same project twice is "
    "free."
)


class WorkspaceOpenProjectConfig(FunctionBaseConfig, name="workspace_open_project"):
    """Configuration for the project-mounting tool. It has no knobs: the cap, the
    permission and the grant's lifetime are the office's to decide (the mounts
    service is their one implementation), and a per-deployment YAML setting here
    would be a second, quieter answer to the same question."""


@register_function(config_type=WorkspaceOpenProjectConfig)
async def workspace_open_project(tool_config: WorkspaceOpenProjectConfig, builder: Builder):
    from aiq_agent.knowledge.mounts import REFUSAL_CAP
    from aiq_agent.knowledge.mounts import REFUSAL_NO_ACCESS
    from aiq_agent.knowledge.mounts import REFUSAL_NOT_FOUND
    from aiq_agent.knowledge.mounts import REFUSAL_UNAVAILABLE
    from aiq_agent.knowledge.mounts import REFUSAL_WOULD_EXCLUDE
    from aiq_agent.knowledge.mounts import MountGranted
    from aiq_agent.knowledge.mounts import register_mount_grant
    from aiq_agent.knowledge.mounts import request_mount
    from aiq_agent.project_context import GridRequestContext
    from aiq_agent.project_context import get_conversation_id_from_context

    def _event(payload: dict, prose: str) -> str:
        """One JSON line, a blank line, then the German prose.

        Two readers, one string: the UI parses the first line of this tool's
        result into the MountNotice (the way `remember`'s result drives the
        memory chip), and the model reads the prose. Compact separators and
        `ensure_ascii=False` so the line stays one line and a project name keeps
        its umlauts.
        """
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n\n" + prose

    def _refused(
        code: str,
        prose: str,
        *,
        project_id: str | None = None,
        cap: int | None = None,
        excluded: tuple[str, ...] = (),
    ) -> str:
        return _event(
            {
                "event": "mount",
                "status": "refused",
                "code": code,
                "cap": cap,
                "excluded": list(excluded) or None,
                "projectId": project_id or None,
            },
            prose,
        )

    async def _open_project(project_id: str) -> str:
        """Bring a project into view for this conversation.

        Returns whether the project is now readable, or why it is not.
        """
        project_id = (project_id or "").strip()
        if not project_id:
            return _refused(
                REFUSAL_NOT_FOUND,
                "Es wurde keine Projektkennung übergeben. Suche das Projekt zuerst mit `find_projects` und "
                "übergib die dort angezeigte `id`. Frage nicht erneut mit leerer Kennung.",
            )

        ctx = GridRequestContext.from_context()
        if not ctx.organization_id:
            # No organisation means no office, and mounting is an office move.
            return _refused(
                REFUSAL_NO_ACCESS,
                "Diese Unterhaltung gehört zu keinem Büro, deshalb kann kein Projekt eingeblendet werden. "
                "Sag das dem Nutzer und antworte ohne Projektunterlagen.",
                project_id=project_id,
            )

        conversation_id = get_conversation_id_from_context()
        if not conversation_id:
            # A grant is bound to a conversation; without one there is nothing
            # to bind it to, so this can only be refused, not worked around.
            return _refused(
                REFUSAL_UNAVAILABLE,
                "Das Projekt konnte nicht eingeblendet werden (diese Unterhaltung ist nicht identifizierbar). "
                "Sag, dass das Einblenden gerade nicht möglich ist, und antworte ohne Projektunterlagen.",
                project_id=project_id,
            )

        try:
            outcome = await asyncio.to_thread(
                request_mount,
                conversation_id=conversation_id,
                project_id=project_id,
                organization_id=ctx.organization_id,
                user_id=ctx.user_id,
                membership_id=ctx.organization_membership_id,
            )
        except Exception:
            # The client is documented not to raise; this is the second lock on
            # the same door, because a raising tool takes the whole turn down.
            logger.exception("Mount request failed")
            outcome = None

        if outcome is None:
            return _refused(
                REFUSAL_UNAVAILABLE,
                "Das Projekt konnte gerade nicht eingeblendet werden. Sag, dass das Einblenden vorübergehend "
                "nicht möglich ist, und antworte nicht aus Annahmen über den Projektinhalt. Höchstens einmal "
                "erneut versuchen.",
                project_id=project_id,
            )

        if not isinstance(outcome, MountGranted):
            if outcome.code == REFUSAL_CAP:
                cap_text = f"{outcome.cap} Projekte" if outcome.cap else "die erlaubte Anzahl an Projekten"
                mounted = ", ".join(outcome.mounted) if outcome.mounted else "die bereits eingeblendeten Projekte"
                return _refused(
                    REFUSAL_CAP,
                    f"Diese Unterhaltung hat bereits {cap_text} eingeblendet ({mounted}) — mehr gehen "
                    "gleichzeitig nicht. Sag das dem Nutzer, nenne die eingeblendeten Projekte, und biete an, "
                    "entweder eines davon auszublenden oder die Frage als vertiefte Recherche über mehrere "
                    "Projekte zu stellen. Blende nichts von dir aus aus.",
                    project_id=project_id,
                    cap=outcome.cap,
                )
            if outcome.code == REFUSAL_WOULD_EXCLUDE:
                # Not the cap: nothing is in the way, and unmounting something
                # would not help. The conversation is SHARED with people who may
                # not read this project, and MT-14 makes the mounted set a
                # property of the conversation — so mounting it would answer
                # past them (spec AC-8).
                people = ", ".join(outcome.excluded) if outcome.excluded else "andere Beteiligte dieser Unterhaltung"
                return _refused(
                    REFUSAL_WOULD_EXCLUDE,
                    f"Dieses Projekt kann hier nicht eingeblendet werden, weil {people} es nicht sehen "
                    "dürfen und diese Unterhaltung geteilt ist. Sag das offen, nenne die Personen, und biete "
                    "an, entweder die Freigabe dieser Unterhaltung zu ändern oder die Frage ohne dieses "
                    "Projekt zu beantworten. Antworte nicht aus Annahmen über den Projektinhalt.",
                    project_id=project_id,
                    excluded=outcome.excluded,
                )
            if outcome.code == REFUSAL_NO_ACCESS:
                return _refused(
                    REFUSAL_NO_ACCESS,
                    "Dieser Nutzer darf dieses Projekt nicht im Chat verwenden, deshalb ist es nicht "
                    "eingeblendet. Sag das offen und antworte ohne seine Unterlagen — nichts über den Inhalt "
                    "des Projekts erfinden oder aus dem Steckbrief ableiten.",
                    project_id=project_id,
                )
            if outcome.code == REFUSAL_NOT_FOUND:
                # Denial and non-existence answer identically on purpose: the
                # endpoint refuses to tell an outsider that a project exists.
                return _refused(
                    REFUSAL_NOT_FOUND,
                    "Zu dieser Kennung gibt es kein Projekt, das dieser Nutzer öffnen kann. Prüfe die Kennung "
                    "mit `find_projects` und sag dem Nutzer, dass das Projekt hier nicht verfügbar ist — "
                    "behaupte nicht, dass es das Projekt nicht gibt.",
                    project_id=project_id,
                )
            return _refused(
                REFUSAL_UNAVAILABLE,
                "Das Projekt konnte gerade nicht eingeblendet werden. Sag, dass das Einblenden vorübergehend "
                "nicht möglich ist, und antworte nicht aus Annahmen über den Projektinhalt.",
                project_id=project_id,
            )

        name = outcome.project_name or "Das Projekt"
        mounted_event = {
            "event": "mount",
            "status": "mounted",
            "projectId": outcome.project_id,
            "projectName": outcome.project_name,
            "mountedBy": "agent",
        }

        if register_mount_grant(outcome.grant, outcome.sig) is None:
            # The mount ROW exists (the office wrote it), so the UI must show the
            # project as mounted and the next turn will carry it on the scope
            # header. Only THIS turn cannot read it, and saying so is the honest
            # half — silently searching without it would answer from the office
            # corpus while claiming the project.
            logger.warning("Mount grant for project %s did not verify; this turn stays unwidened", project_id)
            return _event(
                mounted_event,
                f"{name} ist jetzt für diese Unterhaltung eingeblendet, seine Unterlagen sind aber erst ab der "
                "nächsten Frage lesbar. Sag das dem Nutzer und antworte jetzt ohne die Projektunterlagen.",
            )

        return _event(
            mounted_event,
            f"{name} ist jetzt eingeblendet: du kannst seine Dokumente ab sofort durchsuchen und zitieren. "
            "Nenne bei jeder Aussage das Projekt, aus dem sie stammt, und halte Projektwissen von Baurecht "
            "getrennt.",
        )

    yield FunctionInfo.from_fn(_open_project, description=_OPEN_PROJECT_DESCRIPTION)
