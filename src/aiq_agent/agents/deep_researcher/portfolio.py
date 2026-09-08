"""Portfolio-Recherche: one deep-research sub-run per project, in sequence.

The Büro reads at most ``GRID_WORKSPACE_MAX_MOUNTED_PROJECTS`` projects in a
live turn (ADR-0054). A question that needs more than that has exactly one place
to go, and this is it: the deep researcher iterates the projects the caller may
read, ONE AT A TIME, each sub-run seeing base + Archiv + that project and
nothing else, and a final pass writes one report out of what came back
(spec DR-4…DR-8).

Three things a reader must not have to infer:

* **There is no portfolio agent.** A sub-run is the ordinary deep-research
  agent, called with a narrower scope. What this module owns is the arithmetic
  around it — which projects, which scope, which share of the budget, and how
  the pieces become one report — and every one of those is a pure function so
  that the loop in ``aiq_api.jobs.runner`` has nothing to test that a worker,
  a Dask cluster and a model provider have to be standing up for.
* **Sequential is the design, not a simplification.** Iterating bounds the cost
  by the number of projects times a share, which is a number chosen in advance;
  fanning out bounds it by nothing, and the whole reason the office has a cap is
  that unbounded reads across an organisation are what the product refuses to
  do (ADR-0054, spec DR-5).
* **A project that fails is a line in the report, not the end of the run**
  (spec DR-8). Thirty projects read and one that errored is thirty projects'
  findings and a sentence saying which one is missing; a run that dies on
  project seven is nothing at all, which is the outcome a portfolio run is least
  able to afford — it is the expensive path by construction.

Readability is decided by the **workspace digest endpoint**, not by the mounts
twin, and the choice is load-bearing rather than convenient: the digest already
filters the Projektregister to the projects this MEMBERSHIP may read (ADR-0038,
the same filter the office's turn-start recall uses), it needs no conversation,
and it persists nothing. The mounts twin authorizes the same way, but it also
writes a mount row and spends the per-conversation cap — the very ceiling
Portfolio-Recherche exists to exceed (spec DR-5) — and it would permanently
widen the chat conversation the run was escalated from. So: the digest decides
who may be read, and this module never widens that set.

See docs/adr/0054-workspace-chat-mounts-projects-on-demand.md and
docs/architecture/backend-deep-dive.md §7.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from dataclasses import field
from typing import Any

logger = logging.getLogger(__name__)

#: How many projects one portfolio run ever reads.
#:
#: It is the ceiling of the readable set this worker can LEARN, not a policy
#: choice made here: the workspace digest endpoint caps its own recall at ten
#: (``RECALL_MAX_LIMIT`` in the BFF's register service), so ten is the honest
#: number and asking for more would silently return ten anyway. A run that wants
#: the whole portfolio of a forty-project office needs the BFF to serve the
#: readable set in bulk; until it does, the report says how many were read out
#: of how many were asked for, and never implies it saw the office.
PORTFOLIO_MAX_PROJECTS = 10

#: Outcome tokens. Stable, because they are what the report renders from and
#: what a test asserts on — never prose, which would drift with the wording.
READ = "read"
FAILED = "failed"
BUDGET = "budget"
NOT_REACHED = "not_reached"


@dataclass(frozen=True)
class PortfolioProject:
    """One project a portfolio run may read: its identity, and its collection.

    ``collection`` is what the sub-run's scope is built from, and it is DATA
    wherever the run already has it — a project the escalating conversation had
    mounted arrives on the scope entry with its collection, its id and its name
    (ADR-0054). :func:`project_collection` is the fallback for the rest, and it
    says what it costs.
    """

    id: str
    name: str
    collection: str

    def label(self) -> str:
        return self.name or self.id


@dataclass(frozen=True)
class PortfolioOutcome:
    """What became of one project in the run: the token, and what to say about it."""

    project: PortfolioProject
    status: str
    report: str = ""
    sources: tuple[dict[str, Any], ...] = ()
    detail: str = ""


@dataclass(frozen=True)
class PortfolioSelection:
    """Which projects this run will read, and which it was asked for and cannot."""

    projects: tuple[PortfolioProject, ...] = ()
    #: Requested ids that the readable set did not contain. NAMED in the report
    #: (spec DR-6's sibling obligation: a reader must be able to tell "we looked
    #: and found nothing" from "we never looked"), and deliberately not
    #: explained: the endpoint answers "may not read" and "does not exist"
    #: identically on purpose, so the report must not claim to know which.
    unreadable: tuple[str, ...] = ()
    #: The readable set was longer than :data:`PORTFOLIO_MAX_PROJECTS`.
    truncated: bool = False


@dataclass
class PortfolioRun:
    """The finished iteration: every project's outcome, in the order they ran."""

    query: str
    selection: PortfolioSelection
    outcomes: list[PortfolioOutcome] = field(default_factory=list)
    #: The cross-project pass, when it ran. Absent is ordinary — it is written
    #: by a model call that may fail, and a portfolio report is still a
    #: portfolio report without its opening synthesis.
    synthesis: str = ""

    def read_projects(self) -> list[PortfolioOutcome]:
        return [outcome for outcome in self.outcomes if outcome.status == READ]


def project_collection(project_id: str) -> str:
    """The collection a project's documents live in, from its id.

    THE ONE PLACE this process derives a collection name rather than being told
    one, and it is a deliberate, bounded exception to ADR-0006 (the BFF is the
    naming authority). It exists because the workspace digest returns a
    project's id and name and NOT its collection, so a portfolio run has no
    other way to address the documents of a project it did not mount.

    Two things keep the exception honest. The convention is the BFF's own,
    documented in ``docs/technical-reference/collection-scoping.md``
    (``proj_{projectId}``) and already relied on — as a parser — in four places
    on this side. And the AUTHORIZATION is still entirely the BFF's: this name
    is only ever built for a project the digest's readable filter already
    returned for this membership, so deriving it widens nothing that was not
    already decided elsewhere.

    Delete it the day the digest endpoint returns each hit's collection; that is
    the fix, and this docstring is the note that says so.
    """
    return f"proj_{project_id}"


def _wire_entry(entry: Any) -> dict[str, Any] | None:
    """One scope entry as a wire dict, whichever shape it arrived in."""
    if isinstance(entry, str):
        name = entry.strip()
        return {"collection": name} if name else None
    if isinstance(entry, dict):
        raw = entry.get("collection")
        return dict(entry) if isinstance(raw, str) and raw.strip() else None
    return None


def scope_project_entries(collection_scope: list | None) -> dict[str, dict[str, Any]]:
    """Project id → its scope entry, for every entry of *collection_scope* that names one.

    This is where a mounted project's REAL collection comes from: the escalating
    conversation's scope carries it as data, so a project the office already had
    in view is addressed by the name the BFF gave it rather than by a derived
    one.
    """
    found: dict[str, dict[str, Any]] = {}
    for raw in collection_scope or ():
        entry = _wire_entry(raw)
        if entry is None:
            continue
        project_id = entry.get("projectId")
        if isinstance(project_id, str) and project_id.strip():
            found.setdefault(project_id.strip(), entry)
    return found


def narrow_scope_to_project(collection_scope: list | None, project: PortfolioProject) -> list[dict[str, Any]]:
    """The scope of ONE sub-run: everything above the projects, plus this project.

    Base and Archiv (and anything else the run was given that is not a project)
    stay: a portfolio question is still a building-law question, and a sub-run
    that lost the corpus would answer each project out of its own files alone.
    Every OTHER project's entry is dropped, which is what makes the sub-run a
    sub-run — one project in view, so a passage cannot be attributed to the
    wrong one.

    The project's entry carries its id and name (ADR-0054), because that is what
    travels onto the chunk and out to the citation: without it the report would
    have per-project sections whose citations could not say which project they
    came from, which is exactly what spec DR-6 forbids.
    """
    narrowed: list[dict[str, Any]] = []
    for raw in collection_scope or ():
        entry = _wire_entry(raw)
        if entry is None:
            continue
        shelf = entry.get("shelf")
        project_id = entry.get("projectId")
        if shelf == "project" or (isinstance(project_id, str) and project_id.strip()):
            # Every project entry is dropped here and exactly one is added back
            # below — including this project's own, so that it is added with the
            # identity fields even if the entry it came from lacked them.
            continue
        narrowed.append(entry)
    narrowed.append(
        {
            "collection": project.collection,
            "shelf": "project",
            "projectId": project.id,
            "projectName": project.name,
        }
    )
    return narrowed


def per_project_completion_ceiling(run_ceiling: int | None, project_count: int) -> int | None:
    """One project's share of the run's completion-token budget (ADR-0015).

    ``None`` when the run has no ceiling configured — the portfolio run must not
    invent a budget where the deployment set none, or a run that is allowed to
    cost what it costs would be cut off by a number nobody chose.

    An equal share, floored, and never below one token: the alternative — spend
    freely until the run ceiling is hit — gives the first project everything and
    the last one nothing, which is the failure mode a portfolio report shows most
    clearly (five thorough sections and twenty-five stubs).
    """
    if not run_ceiling or run_ceiling <= 0 or project_count <= 0:
        return None
    return max(1, run_ceiling // project_count)


def resolve_portfolio_projects(
    *,
    organization_id: str | None,
    membership_id: str | None,
    query: str,
    requested_ids: list[str] | None = None,
    collection_scope: list | None = None,
    limit: int = PORTFOLIO_MAX_PROJECTS,
    fetch=None,
) -> PortfolioSelection:
    """Which projects this run may read, decided by the BFF and narrowed here.

    The digest endpoint answers "which projects of this organisation may this
    MEMBERSHIP read, best matches for this question first" — see the module
    docstring for why it and not the mounts twin. When the request named ids,
    they are an INTERSECTION with that answer and never an addition to it: a
    caller naming a project it may not read gets it back in
    :attr:`PortfolioSelection.unreadable`, never in the read set.

    Fails CLOSED. A digest that cannot be reached yields no projects, because
    "we could not ask who you may read" is not "you may read everyone".
    """
    if fetch is None:
        from aiq_agent.knowledge.workspace_digest import fetch_workspace_digest

        fetch = fetch_workspace_digest

    wanted = [pid.strip() for pid in (requested_ids or []) if isinstance(pid, str) and pid.strip()]
    if not organization_id:
        return PortfolioSelection(unreadable=tuple(wanted))

    try:
        digest = fetch(
            organization_id=organization_id,
            membership_id=membership_id,
            query=query,
            limit=min(max(int(limit or 1), 1), PORTFOLIO_MAX_PROJECTS),
        )
    except Exception:
        logger.warning("Portfolio run could not read the register; no project is readable", exc_info=True)
        digest = None
    if digest is None:
        return PortfolioSelection(unreadable=tuple(wanted))

    readable = {hit.id: hit for hit in digest.projects if hit.id}
    if wanted:
        chosen_ids = [pid for pid in wanted if pid in readable]
        unreadable = tuple(pid for pid in wanted if pid not in readable)
    else:
        chosen_ids = list(readable)
        unreadable = ()

    mounted = scope_project_entries(collection_scope)
    projects: list[PortfolioProject] = []
    for project_id in chosen_ids[:PORTFOLIO_MAX_PROJECTS]:
        hit = readable[project_id]
        entry = mounted.get(project_id)
        collection = entry.get("collection") if entry else None
        projects.append(
            PortfolioProject(
                id=project_id,
                name=hit.name or project_id,
                collection=collection if isinstance(collection, str) and collection else project_collection(project_id),
            )
        )
    return PortfolioSelection(
        projects=tuple(projects),
        unreadable=unreadable,
        truncated=len(chosen_ids) > PORTFOLIO_MAX_PROJECTS,
    )


_CITATION_MARKER = re.compile(r"\[(\d+(?:\s*[,;]\s*\d+)*)\]")


def renumber_citations(
    report: str,
    sources: list[dict[str, Any]] | tuple[dict[str, Any], ...] | None,
    offset: int,
) -> tuple[str, list[dict[str, Any]], int]:
    """Shift one sub-run's ``[N]`` markers and its sources by *offset*.

    Every sub-run numbers its citations from 1, so five sections concatenated
    would carry five different ``[1]``s and one provenance list in which the
    reader could not tell them apart. The report is one document with one
    numbering, which is the shape every surface already reads (the ``[N]`` →
    source binding lives in the sources list and nowhere else), so each section
    is shifted past the ones before it.

    Returns ``(report, sources, next_offset)``. A source with no ``number`` is
    kept and left unnumbered rather than dropped: it is still provenance, and
    inventing a marker for it would put a number in the list that the prose
    never uses.
    """
    entries = [dict(source) for source in (sources or ()) if isinstance(source, dict)]
    if offset:
        for source in entries:
            number = source.get("number")
            if isinstance(number, int) and not isinstance(number, bool):
                source["number"] = number + offset

        def _shift(match: re.Match[str]) -> str:
            numbers = re.split(r"\s*[,;]\s*", match.group(1))
            return "[" + ", ".join(str(int(number) + offset) for number in numbers) + "]"

        report = _CITATION_MARKER.sub(_shift, report)

    highest = max(
        (source["number"] for source in entries if isinstance(source.get("number"), int)),
        default=offset,
    )
    return report, entries, max(offset, highest)


def _status_line(outcome: PortfolioOutcome) -> str:
    """One line about a project that produced no section, in the product's voice."""
    if outcome.status == FAILED:
        return f"- {outcome.project.label()}: konnte nicht gelesen werden (die Recherche brach ab)."
    if outcome.status == BUDGET:
        return f"- {outcome.project.label()}: das Budget dieses Laufs war vorher aufgebraucht."
    if outcome.status == NOT_REACHED:
        return f"- {outcome.project.label()}: wurde nicht mehr gelesen."
    return f"- {outcome.project.label()}: nicht gelesen."


def render_portfolio_report(run: PortfolioRun) -> tuple[str, list[dict[str, Any]]]:
    """The one report, and the one provenance list that goes with it.

    Deterministic on purpose: the synthesis at the top is written by a model and
    may be missing, and everything below it — which projects were read, what each
    said, what was not read and why — is a fact about the run that must be in the
    report whether or not that call succeeded (spec DR-8).
    """
    read = run.read_projects()
    lines = [f"# Portfolio-Recherche: {run.query.strip()}", ""]

    asked = len(run.selection.projects) + len(run.selection.unreadable)
    if read:
        names = ", ".join(outcome.project.label() for outcome in read)
        lines.append(f"Gelesen wurden {len(read)} von {asked} Projekten: {names}.")
    else:
        lines.append(f"Es konnte keines der {asked} angefragten Projekte gelesen werden.")
    if run.selection.truncated:
        lines.append(
            f"Diese Recherche liest höchstens {PORTFOLIO_MAX_PROJECTS} Projekte pro Lauf. "
            "Für weitere Projekte braucht es einen zweiten Lauf."
        )
    lines.append("")

    if run.synthesis.strip():
        lines += ["## Überblick", run.synthesis.strip(), ""]

    sources: list[dict[str, Any]] = []
    offset = 0
    for outcome in read:
        body, entries, offset = renumber_citations(outcome.report, outcome.sources, offset)
        sources.extend(entries)
        lines += [f"## {outcome.project.label()}", body.strip(), ""]

    missing = [outcome for outcome in run.outcomes if outcome.status != READ]
    if missing or run.selection.unreadable:
        lines.append("## Nicht gelesen")
        lines += [_status_line(outcome) for outcome in missing]
        for project_id in run.selection.unreadable:
            # Denial and absence answer identically at the endpoint, so the
            # report says what it knows and not which of the two it was.
            lines.append(f"- {project_id}: für diesen Zugang nicht verfügbar.")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n", sources


#: What the cross-project pass is asked to do. Deliberately narrow: the
#: per-project sections are already written and already cited, and a model asked
#: to "write the report" would rewrite them — losing the citations that make
#: each finding checkable (spec DR-6). It compares, and it names its projects.
SYNTHESIS_INSTRUCTION = (
    "Du bekommst die Einzelergebnisse einer Recherche über mehrere Projekte eines Architekturbüros. "
    "Schreibe daraus einen kurzen Überblick (höchstens 250 Wörter, Deutsch): was die Projekte gemeinsam "
    "haben, worin sie sich unterscheiden, und was daraus für die Frage folgt.\n"
    "Nenne jedes Projekt beim Namen. Erfinde nichts hinzu — verwende ausschließlich, was in den "
    "Einzelergebnissen steht. Wiederhole die Einzelergebnisse nicht und übernimm KEINE Fußnotenzeichen "
    "wie [1]: die stehen in den Einzelabschnitten und deren Nummerierung gilt hier nicht. "
    "Wenn die Ergebnisse zu unterschiedlich sind, um sie zu vergleichen, sage das in einem Satz."
)


def synthesis_prompt(run: PortfolioRun) -> str:
    """The cross-project pass's input: the question, and each project's findings.

    Bounded per project, because the alternative is a prompt whose size is the
    sum of ten deep-research reports — the one prompt in this pipeline that
    grows with the number of projects, which is the growth the whole design
    exists to bound.
    """
    parts = [SYNTHESIS_INSTRUCTION, "", f"FRAGE: {run.query.strip()}", ""]
    for outcome in run.read_projects():
        body = outcome.report.strip()
        if len(body) > 4000:
            body = body[:4000].rsplit("\n", 1)[0] + "\n…"
        parts += [f"PROJEKT: {outcome.project.label()}", body, ""]
    return "\n".join(parts)


async def run_portfolio_iteration(
    *,
    query: str,
    selection: PortfolioSelection,
    run_project,
    run_ceiling: int | None = None,
    synthesize=None,
    on_outcome=None,
) -> PortfolioRun:
    """Read every selected project in turn and return what each produced.

    ``run_project(project, ceiling)`` runs ONE sub-run and returns
    ``(report, sources)``; it is a callable rather than an import so that this
    loop — the part with the invariants — is testable without a worker, a model
    provider and a Dask cluster. ``synthesize(run)`` writes the cross-project
    pass and may fail; ``on_outcome`` is told about each project as it finishes,
    which is what a progress event is built from.

    The invariants, in the order a reader will want them:

    * **Sequential.** One sub-run at a time, in the selection's order.
    * **Bounded per project.** Each gets its own share of the run's ceiling
      (:func:`per_project_completion_ceiling`), so the last project is as well
      funded as the first.
    * **A failure is data.** Anything a sub-run raises is recorded against that
      project and the loop goes on (spec DR-8). The two exceptions are budget
      exhaustion of the WHOLE run — there is nothing left to read with, so the
      rest are honestly marked as not reached rather than tried and failed — and
      cancellation, which is the user asking for the run to stop and must not be
      swallowed into a per-project note.
    """
    import asyncio

    from aiq_agent.common import RunBudgetExceededError
    from aiq_agent.common.cost_tracking import BudgetExceededError

    run = PortfolioRun(query=query, selection=selection)
    share = per_project_completion_ceiling(run_ceiling, len(selection.projects))
    exhausted = False

    for project in selection.projects:
        if exhausted:
            run.outcomes.append(PortfolioOutcome(project=project, status=NOT_REACHED))
            continue
        try:
            report, sources = await run_project(project, share)
            outcome = PortfolioOutcome(
                project=project,
                status=READ,
                report=report or "",
                sources=tuple(sources or ()),
            )
        except asyncio.CancelledError:
            raise
        except RunBudgetExceededError as exc:
            # This project's SHARE is gone, not the run's money. The next
            # project gets its own share and a fresh guard.
            logger.info("Portfolio sub-run for %s hit its share of the budget: %s", project.id, exc)
            outcome = PortfolioOutcome(project=project, status=BUDGET, detail=str(exc))
        except BudgetExceededError as exc:
            # The ORGANISATION's budget (ADR-0015). Nothing is left to read
            # with, so the remaining projects are marked, not attempted.
            logger.warning("Portfolio run stopped by the organisation budget at %s: %s", project.id, exc)
            outcome = PortfolioOutcome(project=project, status=BUDGET, detail=str(exc))
            exhausted = True
        except Exception as exc:  # noqa: BLE001 — one project's failure is a line in the report
            logger.warning("Portfolio sub-run for project %s failed", project.id, exc_info=True)
            outcome = PortfolioOutcome(project=project, status=FAILED, detail=type(exc).__name__)
        run.outcomes.append(outcome)
        if on_outcome is not None:
            try:
                on_outcome(outcome)
            except Exception:  # pragma: no cover - progress reporting is never load-bearing
                logger.debug("Portfolio progress callback failed", exc_info=True)

    if synthesize is not None and run.read_projects():
        try:
            run.synthesis = await synthesize(run) or ""
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — the sections are the report; the overview is a bonus
            logger.warning("Portfolio synthesis failed; the report ships with its sections alone", exc_info=True)
    return run
