"""``create_task``: the chat turn's way of handing work over instead of pretending.

## The failure this exists to stop

„Mach den Einreichcheck bis Freitag" is not a question, and until now the only
thing a turn could do with it was answer as though it were one — or, worse,
answer „mache ich" about work that would never happen, because a chat turn ends
when the answer ships and nothing outlives it. ADR-0051 built the row that does
outlive it, and named a chat handoff as one of the triggers that should create
one. This is that trigger.

## Two triggers, one row

„prüf das jeden Montag" is the same entity as „prüf das bis Freitag", with a
recurring trigger instead of a one-off one (migration 0086 collapsed jobs and
delegated tasks into `task_definitions` + `task_runs` for exactly this). The
optional ``cadence`` argument is where a chat turn says „jeden Montag": the BFF
creates a ``schedule`` definition and the scheduler fires it, instead of
dispatching one run now. A cadence is gated on ``project:skills:manage`` — the
recurrence is the repeated-spend act — and the refusal comes back as text the
model can relay.

## What it does and does not decide

It decides WHICH KIND of work and WHAT was asked. It decides nothing about
identity, permission or budget: the BFF reads the acting person out of the
signed envelope this tool echoes, resolves that person's pinned session, checks
`project:edit` (plus `project:skills:manage` for a cadence) against the named
project and pins them as the task's requester (ADR-0054 §4, ADR-0055). A run
with no envelope — a CLI call, an eval, the job worker — has no acting person,
and the tool refuses rather than falling back to the unsigned individual headers.

The task then costs the requester's budget and runs under their permissions,
which is why creating one is a real act and why the prompt tells the model to
SAY it created one, in one sentence, and never to claim the work is done.

## Why the kinds are closed

Four members, mirrored from `DELEGATABLE_TASK_KINDS` on the BFF side, because
each one names an ENGINE that already exists — the compliance checker, the
Einreichcheck skill, the drafting tools, the revision path. An open `kind` string
would let the model delegate „Kostenschätzung" to a queue that has nothing to run
it with, and the failure would arrive hours later as a task that did nothing.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from aiq_agent import project_context
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

from ..documents.filing import SignedEnvelope
from .cards import emit_task_card
from .client import DelegationError
from .client import post_task

logger = logging.getLogger(__name__)

#: The BFF's own ceiling (`TASK_GOAL_MAX_CHARS`). Checked here so an over-long
#: goal comes back where the model can shorten it, rather than as a 400 after the
#: reader has been told the task is being created.
MAX_GOAL_CHARS = 500

#: The BFF's cron ceiling (`internalTaskRequestSchema.cadence`). A 5-field cron
#: is at most a few dozen characters; a longer one is REFUSED, never truncated,
#: because slicing a comma list can leave a different, still-valid schedule.
MAX_CADENCE_CHARS = 120

#: The kinds, mirrored from `DELEGATABLE_TASK_KINDS`
#: (`frontends/ui/src/lib/db/schema/tasks.ts`). Same parse-independently rule the
#: request-context headers follow; `tests/aiq_agent/tools/tasks/` is what catches
#: the drift.
TASK_KINDS: tuple[str, ...] = ("compliance_check", "einreichcheck", "document", "revision")

#: What each kind is called when the refusal has to name the set.
_KIND_LIST = ", ".join(f"`{kind}`" for kind in TASK_KINDS)

_NO_PROJECT = (
    "Fehler: In diesem Gespräch gibt es kein Projekt, also auch keinen Auftrag, der zu einem Projekt "
    "gehören könnte. Es wurde nichts angelegt. Nicht erneut versuchen."
)

_NO_ENVELOPE = (
    "Fehler: Dieser Lauf hat keinen signierten Sitzungsnachweis, deshalb kann kein Auftrag im Namen "
    "einer Person angelegt werden. Es wurde nichts angelegt. Nicht erneut versuchen."
)


class _Refused(Exception):
    """A model-facing refusal, raised where it is discovered."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _envelope() -> SignedEnvelope:
    header, signature = project_context.get_request_envelope_from_context()
    if not header or not signature:
        raise _Refused(_NO_ENVELOPE)
    return SignedEnvelope(header=header, signature=signature)


def _project_or_refuse() -> str:
    project_id = project_context.get_project_id_from_context()
    if not project_id:
        raise _Refused(_NO_PROJECT)
    return project_id


def _kind_or_refuse(kind: str) -> str:
    normalized = (kind or "").strip().lower()
    if normalized not in TASK_KINDS:
        raise _Refused(f"Fehler: `{kind}` ist keine Auftragsart. Möglich sind {_KIND_LIST}. Es wurde nichts angelegt.")
    return normalized


def _goal_or_refuse(goal: str) -> str:
    text = " ".join((goal or "").split())
    if not text:
        raise _Refused(
            "Fehler: Ein Auftrag braucht eine Beschreibung dessen, was zu tun ist. Es wurde nichts angelegt."
        )
    return text[:MAX_GOAL_CHARS]


def _cadence_or_refuse(cadence: str) -> str:
    """The recurrence, as the 5-field cron the scheduler claims."""
    text = " ".join((cadence or "").split())
    if not text:
        raise _Refused("Fehler: Für einen wiederkehrenden Auftrag fehlt der Zeitplan. Es wurde nichts angelegt.")
    if len(text) > MAX_CADENCE_CHARS:
        raise _Refused("Fehler: Der Zeitplan ist zu lang. Es wurde nichts angelegt.")
    return text


async def _post(payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """The blocking call, off the event loop, with the refusal already worded."""
    try:
        return await asyncio.to_thread(post_task, payload, envelope)
    except DelegationError as exc:
        raise _Refused(
            f"Fehler beim Anlegen des Auftrags: {exc}. Es wurde nichts angelegt; sage der Nutzerin, "
            "dass der Auftrag nicht angenommen wurde."
        ) from exc


#: How the answer is told to talk about what just happened. It leads with the
#: thing the model gets wrong — „ich habe den Einreichcheck gemacht" about work
#: that has been QUEUED — because that sentence is the reason the tool exists.
_QUEUED = (
    "Der Auftrag ist angelegt und läuft; er ist NICHT erledigt. Sage in einem Satz, dass Piloti sich "
    "darum kümmert und sich meldet — behaupte nicht, das Ergebnis liege schon vor."
)

#: The scheduled arm. Nothing runs now: the definition exists and the scheduler
#: owns every fire, so the answer must not claim a first result is coming before
#: the cadence fires — and must name WHEN it will first run when the route said.
_SCHEDULED = (
    "Der Auftrag ist als wiederkehrender Zeitplan angelegt; der erste Lauf startet zum angegebenen "
    "Zeitpunkt, nicht jetzt. Sage in einem Satz, dass der Zeitplan steht und wann er das erste Mal "
    "läuft — behaupte nicht, es sei schon etwas erledigt."
)

_CREATE_TASK_DESCRIPTION = (
    "Legt einen Auftrag an, den Piloti nach diesem Gespräch selbständig erledigt, und meldet sich, "
    "wenn er fertig ist. Aufrufen, wenn die Nutzerin um Arbeit bittet, die länger dauert als diese "
    "Antwort („mach den Einreichcheck bis Freitag“, „@Piloti prüf das“, „schreib mir bis Montag den "
    "Aktenvermerk“) — nicht für eine Frage, die sich jetzt beantworten lässt. "
    "`kind` ist eine von " + _KIND_LIST + ": `compliance_check` ist die Normprüfung eines Dokuments "
    "gegen die OIB-Richtlinien, `einreichcheck` prüft die Vollständigkeit der Einreichung, `document` "
    "schreibt ein Dokument und legt es als Entwurf ab, `revision` überarbeitet einen zurückgegebenen "
    "Entwurf. "
    "`goal` ist der Auftrag in den Worten der Nutzerin. `due` ist optional das gewünschte Datum als "
    "`JJJJ-MM-TT` — rechne „bis Freitag“ selbst in ein Datum um, gib keinen Text an. "
    "`cadence` ist optional ein 5-Feld-Cron für wiederkehrende Aufträge („jeden Montag“ → "
    "`0 8 * * 1`, UTC): Damit wird ein Zeitplan angelegt statt eines einzelnen Laufs; er braucht die "
    "Berechtigung `project:skills:manage`, und ohne sie wird er abgelehnt. "
    "Der Auftrag läuft mit den Rechten der Nutzerin und kostet ihr Budget. Nach dem Aufruf ist die "
    "Arbeit ANGELEGT, nicht erledigt. "
    "Ein Auftrag gehört zu einem Projekt: Ohne Projekt in dieser Unterhaltung entsteht keiner, sage "
    "das dann der Nutzerin, statt es erneut zu versuchen."
)


class CreateTaskConfig(FunctionBaseConfig, name="create_task"):
    """Configuration for the ``create_task`` tool."""


async def _create(kind: str, goal: str, due: str, cadence: str) -> str:
    """The whole of ``create_task``, with every refusal raised where it is found."""
    project_id = _project_or_refuse()
    envelope = _envelope()
    chosen_kind = _kind_or_refuse(kind)
    chosen_goal = _goal_or_refuse(goal)

    payload: dict[str, Any] = {
        "op": "create",
        "projectId": project_id,
        "kind": chosen_kind,
        "goal": chosen_goal,
    }
    # Only when the model gave one. The BFF's schema is strict, and an empty
    # string is not a date — it would be a 400 for a field nobody asked for.
    if (due or "").strip():
        payload["due"] = due.strip()
    if (cadence or "").strip():
        payload["cadence"] = _cadence_or_refuse(cadence)

    body = await _post(payload, envelope)
    emit_task_card(body, goal=chosen_goal, kind=chosen_kind)
    title = str(body.get("title") or chosen_goal)
    if body.get("scheduled"):
        next_run = str(body.get("nextRunAt") or "").strip()
        first_run = f" Der erste Lauf ist für {next_run} geplant." if next_run else ""
        return f"Zeitplan angelegt: „{title}“.{first_run} {_SCHEDULED}"
    return f"Auftrag angelegt: „{title}“. {_QUEUED}"


async def run_create_task(kind: str, goal: str, due: str = "", cadence: str = "") -> str:
    """Delegate one piece of work to a task row.

    Module-level, and the tool below is a one-line wrapper around it, so the
    refusal paths are reachable by a test without going through NAT's generator —
    the refusals are most of what this tool is.
    """
    try:
        return await _create(kind, goal, due, cadence)
    except _Refused as refused:
        return refused.message


@register_function(config_type=CreateTaskConfig)
async def create_task(tool_config: CreateTaskConfig, builder: Builder):
    yield FunctionInfo.from_fn(run_create_task, description=_CREATE_TASK_DESCRIPTION)
