"""Workspace (Büro) digest client — the office's turn-start context, in one call.

The sibling of ``project_memory.fetch_memory_digest``, for the turn that has an
organization and no project (ADR-0054). One internal BFF round trip returns both
halves of what the Büro reads before the agent runs:

* the organization's memory digest — the same digest a project turn gets for its
  organization scope;
* the **Projektregister** recall: the Steckbriefe of the projects that best match
  this turn's question, already filtered to the ones the CALLER may read.

Readability is a BFF fact (ADR-0038) keyed on the organization MEMBERSHIP, which
is why ``membership_id`` is a parameter and not an afterthought: without it the
endpoint serves the digest and no projects. That is the fail-closed side, and it
is the endpoint's rule, not this client's.

Two things a reader of this module must not have to infer:

* **It fails open.** Any transport, HTTP, decode or shape failure returns
  ``None`` and the turn proceeds on the frozen connection-time context. The
  register is context, never evidence, so losing it costs recall and never
  correctness — the exact trade ``fetch_memory_digest`` makes, with the same
  ``_DIGEST_TIMEOUT_SECONDS`` ceiling on the critical path. It is blocking:
  call it through ``asyncio.to_thread``.
* **A register hit is navigation, not content** (spec PR-14/PR-15). The block
  this module renders carries a project's name, id and profile facts. It carries
  no document text, and the prompt branch that reads it says so.

The rendered block is BOUNDED and says that it is bounded, because the whole
office is behind it: an unbounded "Passende Projekte" section would grow with
the size of the organization on every single turn, and a model reading a
silently truncated list answers "which projects do we have" confidently and
wrongly (`src/aiq_agent/AGENTS.md`, the same rule ``render_inventory_block``
carries).

See docs/adr/0054-workspace-chat-mounts-projects-on-demand.md.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from dataclasses import field

from aiq_agent.knowledge.memory_context import MemoryCarry
from aiq_agent.knowledge.memory_context import parse_carry
from aiq_agent.knowledge.project_memory import _DIGEST_TIMEOUT_SECONDS
from aiq_agent.knowledge.project_memory import _internal_base_url
from aiq_agent.knowledge.project_memory import _opener

logger = logging.getLogger(__name__)

#: The endpoint's own recall ceiling: `GET /workspace/digest?limit` accepts at
#: most this many (``RECALL_MAX_LIMIT`` in the BFF's register service). Named
#: here because three callers need the same number — this client's clamp, the
#: `find_projects` tool's `limit`, and a Portfolio-Recherche's project count
#: (``deep_researcher.portfolio.PORTFOLIO_MAX_PROJECTS``) — and a second copy of
#: it is how one of them ends up asking for more than it can ever get.
RECALL_MAX_LIMIT = 10

#: How many Steckbriefe the recall BLOCK ever names — the prompt's own ceiling,
#: applied where the block is rendered, so a future endpoint that returns more
#: cannot silently widen every turn's context. It is NOT the ceiling on what a
#: caller may fetch: a tool enumerating a set before a portfolio escalation asks
#: for up to :data:`RECALL_MAX_LIMIT` and gets them.
MAX_PROJECT_ENTRIES = 5

#: Per-Steckbrief character ceiling in the rendered block. A stored Steckbrief
#: is allowed 3000 characters (ADR-0054); five of those would be 15k characters
#: of prompt on every office turn, which is the cost the cap exists to refuse.
#: What survives is the head of the profile, which is where the identifying
#: facts are.
STECKBRIEF_MAX_CHARS = 700

#: Ceiling on the whole rendered block, after which entries are dropped and the
#: text says how many. Belt to the per-entry braces: five near-limit Steckbriefe
#: plus mounted project views must not add up to a context of their own.
BLOCK_MAX_CHARS = 6000


@dataclass(frozen=True)
class WorkspaceProject:
    """One Projektregister hit: a project the caller may read, and why it matched."""

    id: str
    name: str
    steckbrief: str
    score: float = 0.0


@dataclass(frozen=True)
class WorkspaceDigest:
    """What the office reads at turn start: org memory plus register recall."""

    digest: str | None = None
    projects: tuple[WorkspaceProject, ...] = field(default_factory=tuple)
    #: What the memory half of this response carried, omitted and holds
    #: (ADR-0055, contract C2). The office reads organization memory on every
    #: turn and told nobody which notes those were; this is that record, and it
    #: says what was READ — never that the answer used any of it.
    #:
    #: Empty against a BFF that does not send the fields yet, which is what lets
    #: this ship before the endpoint half does: the marker is then absent rather
    #: than present and claiming zero.
    carry: MemoryCarry = MemoryCarry()


def clamped_limit(limit: object, *, default: int = MAX_PROJECT_ENTRIES) -> int:
    """A caller's requested recall size, held between 1 and the endpoint's ceiling.

    Asking for more than :data:`RECALL_MAX_LIMIT` returns that many anyway, so
    the clamp is honesty rather than defence: the number this returns is what
    the caller will actually be able to read.

    ``default`` is what "did not ask" resolves to, and it is the CALLER's own
    default rather than one: absent, ``None``, a non-number, zero and a negative
    are all the same statement — no particular size was requested — and the
    caller that has a default is the one that knows what that means. Falling
    back to one instead would answer "alle Projekte in Wien" with a single
    Steckbrief and read, to the model, as an office with one project in it.
    """
    fallback = max(1, min(default, RECALL_MAX_LIMIT))
    # ``bool`` is an ``int``: ``limit=True`` is a shape nobody meant as "one".
    if limit is None or isinstance(limit, bool):
        return fallback
    try:
        value = int(limit)  # type: ignore[call-overload]  — guarded by the except
    except (TypeError, ValueError):
        return fallback
    return fallback if value < 1 else min(value, RECALL_MAX_LIMIT)


def bounded_project_ids(values: object, *, limit: int = RECALL_MAX_LIMIT) -> list[str] | None:
    """A model-written list of project ids, cleaned and bounded, or ``None``.

    Whitespace stripped, blanks and non-strings dropped, duplicates removed
    (first mention wins) and the result cut to ``limit`` — the number of
    projects anything downstream can actually read. ``None`` for an empty
    result, because "named no projects" and "named nothing usable" are the same
    instruction: read every project the caller may read.
    """
    if not isinstance(values, (list, tuple)):
        return None
    seen: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        text = value.strip()
        if text and text not in seen:
            seen.append(text)
        if len(seen) >= max(1, limit):
            break
    return seen or None


def is_workspace_turn(*, organization_id: str | None, project_id: str | None) -> bool:
    """Whether this turn is in the Büro rather than in a project (ADR-0054).

    An organization and no project. Stated as a function, in the module the
    office context is built in, because it is a RULE and not a condition: the
    absence of a project is information (spec AG-6), so a turn that reads as a
    project turn with a field missing is exactly the bug this names. A turn with
    neither is anonymous — no office to read — and is not the Büro either.
    """
    return bool(organization_id) and not project_id


def _as_project(raw: object) -> WorkspaceProject | None:
    """One wire entry to a :class:`WorkspaceProject`; ``None`` when unusable.

    Fails per ENTRY, not per response: a malformed row is dropped and the rest
    of the recall still reaches the turn. An entry without an id or a name is
    unusable by construction — the agent could neither name it (PR-12) nor mount
    it later — so it is dropped rather than rendered half-blank.
    """
    if not isinstance(raw, dict):
        return None
    project_id = raw.get("id")
    name = raw.get("name")
    if not isinstance(project_id, str) or not project_id.strip():
        return None
    if not isinstance(name, str) or not name.strip():
        return None
    steckbrief = raw.get("steckbrief")
    score = raw.get("score")
    return WorkspaceProject(
        id=project_id.strip(),
        name=name.strip(),
        steckbrief=steckbrief.strip() if isinstance(steckbrief, str) else "",
        score=float(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else 0.0,
    )


def fetch_workspace_digest(
    *,
    organization_id: str | None,
    membership_id: str | None,
    query: str | None = None,
    limit: int = MAX_PROJECT_ENTRIES,
) -> WorkspaceDigest | None:
    """Fetch the organization memory digest and register recall in one call.

    ``GET /api/internal/workspace/digest?organizationId&membershipId&q&limit``
    → ``{"digest": string|null, "projects": [{id, name, steckbrief, score}]}``.

    Returns ``None`` — never raises — when there is no organization, no service
    token, or the call fails in any way. The caller renders the office block
    without recall and the turn proceeds; this is the fail-open contract the
    memory digest set and the reason the register may sit on the critical path
    at all. Blocking; call via ``asyncio.to_thread``.
    """
    if not organization_id:
        return None

    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        # Not an error the turn can act on: the same deployment gap that stops
        # the memory digest, already logged loudly by the startup handshake.
        logger.debug("Workspace digest skipped: GRID_INTERNAL_API_TOKEN is not configured")
        return None

    requested = clamped_limit(limit)
    params = {"organizationId": organization_id, "limit": str(requested)}
    if membership_id:
        params["membershipId"] = membership_id
    if query and query.strip():
        # This turn's question, so the endpoint ranks the register by relevance
        # instead of by recency. Bounded here as well as there — a caller must
        # not be able to post a transcript as a query parameter.
        params["q"] = query.strip()[:2000]

    request = urllib.request.Request(
        f"{_internal_base_url()}/api/internal/workspace/digest?{urllib.parse.urlencode(params)}",
        headers={"X-Grid-Internal-Token": token},
        method="GET",
    )

    try:
        with _opener.open(request, timeout=_DIGEST_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        logger.warning("Workspace digest endpoint returned %s; continuing without register recall", exc.code)
        return None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, UnicodeDecodeError):
        logger.warning("Workspace digest fetch failed; continuing without register recall", exc_info=True)
        return None

    if not isinstance(body, dict):
        logger.warning("Workspace digest response was not a JSON object; continuing without register recall")
        return None

    digest = body.get("digest")
    raw_projects = body.get("projects")
    projects = tuple(
        project
        for project in (_as_project(entry) for entry in (raw_projects if isinstance(raw_projects, list) else []))
        if project is not None
    )
    return WorkspaceDigest(
        digest=digest if isinstance(digest, str) and digest.strip() else None,
        carry=parse_carry(body),
        # Bounded by what THIS caller asked for, not by the prompt block's five:
        # the block truncates itself (``render_workspace_context``), while a
        # caller that asked for ten — the `find_projects` enumeration, a
        # portfolio run's readable set — must be given the ten it may read.
        projects=projects[:requested],
    )


def bound_text(text: str, limit: int) -> str:
    """Cut *text* to *limit* characters on a line boundary where there is one.

    Public because the `find_projects` tool renders the same Steckbriefe under
    the same ceiling: one bound, applied in both places, so a project's profile
    cannot be short in the context block and unbounded in a tool result.
    """
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    head, sep, _tail = cut.rpartition("\n")
    return (head if sep and len(head) > limit // 2 else cut).rstrip() + " …"


def render_workspace_context(
    digest: WorkspaceDigest | None,
    mounted_project_views: list[tuple[str, str, str]] | None = None,
) -> str:
    """The office's per-turn context block: ``WORKSPACE_CONTEXT v1``.

    Three parts, in the order the knowledge hierarchy has them (spec KH-1):
    the organization's memory, the Projektregister recall ("Passende Projekte"),
    and one profile view per MOUNTED project (``mounted_project_views`` is
    ``(name, id, view)`` triples — empty until mounting exists, phase 3).

    Always returns a block, even with nothing to put in it: on an office turn
    the ABSENCE of a project is information the agent must have (spec AG-6), and
    a turn whose recall failed must say that rather than look like a turn with
    no matching projects.
    """
    lines = [
        "WORKSPACE_CONTEXT v1",
        "",
        "Diese Unterhaltung läuft im Büro, nicht in einem Projekt.",
    ]

    if digest is not None and digest.digest:
        lines += ["", "## Organisationsgedächtnis", digest.digest.strip()]

    lines += ["", "## Passende Projekte (Projektregister)"]
    if digest is None:
        lines.append(
            "Das Projektregister war für diese Frage nicht erreichbar. Nenne kein Projekt aus dem Gedächtnis; "
            "suche mit `find_projects`, wenn die Frage ein Projekt betrifft."
        )
    elif not digest.projects:
        lines.append(
            "Keine passenden Projekte gefunden. Das heißt nicht, dass es keine gibt — "
            "mit `find_projects` lässt sich gezielt suchen."
        )
    else:
        shown = list(digest.projects[:MAX_PROJECT_ENTRIES])
        lines.append(
            f"Die {len(shown)} bestpassenden Projekte, auf die dieser Nutzer zugreifen darf — eine BEGRENZTE "
            "Auswahl zu dieser Frage, nicht die Liste aller Projekte des Büros. Jeder Eintrag ist ein "
            "Steckbrief: Name, Kennung und Profilfakten. Er enthält KEINE Dokumentinhalte, und du darfst aus "
            "ihm nichts über den Inhalt der Projektunterlagen ableiten. Weitere Projekte findest du mit "
            "`find_projects`."
        )
        for project in shown:
            lines.append("")
            lines.append(f"### {project.name} (id: {project.id})")
            lines.append(bound_text(project.steckbrief, STECKBRIEF_MAX_CHARS) or "(kein Steckbrief hinterlegt)")

    for name, project_id, view in mounted_project_views or []:
        lines += ["", f"## Eingeblendetes Projekt: {name} (id: {project_id})", (view or "").strip()]

    block = "\n".join(lines).strip()
    if len(block) > BLOCK_MAX_CHARS:
        block = bound_text(block, BLOCK_MAX_CHARS)
        block += "\n\n(Dieser Block wurde gekürzt — er ist eine begrenzte Auswahl, keine vollständige Liste.)"
    return block
