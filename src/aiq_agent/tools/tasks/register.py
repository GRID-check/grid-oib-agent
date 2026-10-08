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

Five members, mirrored from `DELEGATABLE_TASK_KINDS` on the BFF side, because
each one names an ENGINE that already exists — a norm check by the general
agent, the Einreichcheck skill, the drafting tools, the Besprechungsprotokoll
skill, the revision path. An open `kind` string
would let the model delegate „Kostenschätzung" to a queue that has nothing to run
it with, and the failure would arrive hours later as a task that did nothing.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from aiq_agent import project_context
from aiq_agent.common.plan_documents import MAX_PLAN_DOCUMENTS
from aiq_agent.common.plan_documents import sanitize_plan_documents
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import register_function

from ..documents.filing import SignedEnvelope
from ..files.resolve import Refusal
from ..files.resolve import is_conversation_attachment
from ..files.resolve import resolve_document
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

#: The BFF's ceiling on pasted text (`TASK_MATERIAL_MAX_CHARS`). Longer is
#: REFUSED, never cut: notes cut in half are the notes of a different meeting,
#: and the way out — a file in the project — exists.
MAX_MATERIAL_CHARS = 20_000

#: How the model lists the documents in one string argument: one per line, or
#: separated by semicolons. A comma is not a separator because file names carry
#: commas („Notizen JF 3, Haus A.pdf“).
_DOCUMENT_SEPARATORS = re.compile(r"[\n;]")

#: The kinds, mirrored from `DELEGATABLE_TASK_KINDS`
#: (`frontends/ui/src/lib/db/schema/tasks.ts`). Same parse-independently rule the
#: request-context headers follow; `tests/aiq_agent/tools/tasks/test_kind_parity.py`
#: reads the TypeScript tuple and is what catches the drift.
TASK_KINDS: tuple[str, ...] = ("compliance_check", "einreichcheck", "document", "protokoll", "revision")

#: The kinds that have nothing to work FROM unless the person hands it over. A
#: Protokoll from no notes is a Protokoll of nothing: refused here, where the
#: person is still in the conversation to supply them, and again by the BFF
#: (`requiresHandedOver` in `lib/tasks/delegation.ts`).
_NEEDS_HANDED_OVER: frozenset[str] = frozenset({"protokoll"})

#: The kinds that run once, on what they were handed, and never on a cadence.
#: A Protokoll is the minutes of ONE meeting; a schedule would redraft the same
#: notes every week. Refused here and again by the BFF (`oneOff` in
#: `lib/tasks/delegation.ts`).
_ONE_OFF: frozenset[str] = frozenset({"protokoll"})

_NO_CADENCE = (
    "Fehler: Ein Protokoll gehört zu genau einer Besprechung und läuft nicht wiederkehrend. Es wurde nichts "
    "angelegt. Lege es ohne `cadence` an, mit den Notizen dieser Besprechung; für die nächste Besprechung "
    "entsteht ein neuer Auftrag mit ihren Notizen."
)

_NO_NOTES = (
    "Fehler: Für ein Protokoll braucht Piloti die Notizen der Besprechung, und dieser Auftrag nennt keine. "
    "Es wurde nichts angelegt. Frage die Nutzerin nach den Notizen: als Datei im Projekt (dann in "
    "`documents`) oder als eingefügter Text (dann in `material`). Entwirf kein Protokoll ohne sie."
)

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


#: A file attached to this conversation is visible here and unreadable to the
#: run, whose collection scope is the project's. Saying „not found" would send
#: the model after a spelling that was right; this says what is the matter.
_ATTACHMENT = (
    "Fehler: „{name}“ hängt nur an dieser Unterhaltung und ist kein Projektdokument; ein Auftrag kann es "
    "nicht lesen. Es wurde nichts angelegt. Bitte die Nutzerin, die Datei im Projekt abzulegen oder den Text "
    "hier einzufügen, und lege den Auftrag dann an."
)


def _documents_or_refuse(documents: str) -> dict[str, Any] | None:
    """The named files as the wire's ``documents.grundlage``, each resolved against this turn's inventory.

    Resolved, not forwarded: a run told to read a file nobody has fails hours
    later, where nobody can ask which file was meant. The resolver is the one
    the file verbs use, so an ambiguous name comes back as a question here too.
    """
    names = [name.strip() for name in _DOCUMENT_SEPARATORS.split(documents or "") if name.strip()]
    if not names:
        return None
    if len(names) > MAX_PLAN_DOCUMENTS:
        raise _Refused(
            f"Fehler: Ein Auftrag kann höchstens {MAX_PLAN_DOCUMENTS} Dateien nennen. Es wurde nichts angelegt."
        )
    resolved: list[str] = []
    for name in names:
        if is_conversation_attachment(name):
            raise _Refused(_ATTACHMENT.format(name=name))
        found = resolve_document(name)
        if isinstance(found, Refusal):
            raise _Refused(f"{found.message} Es wurde nichts angelegt.")
        resolved.append(found.file_name)
    plan_documents = sanitize_plan_documents({"grundlage": resolved})
    return plan_documents.model_dump(exclude_none=True) if plan_documents else None


def _material_or_refuse(material: str) -> str | None:
    """The pasted text, verbatim apart from its outer whitespace."""
    text = (material or "").strip()
    if not text:
        return None
    if len(text) > MAX_MATERIAL_CHARS:
        raise _Refused(
            f"Fehler: Der übergebene Text ist länger als {MAX_MATERIAL_CHARS} Zeichen. Bitte die Nutzerin, ihn als "
            "Datei ins Projekt hochzuladen, und nenne dann die Datei in `documents`. Es wurde nichts angelegt."
        )
    return text


def _handed_over(documents: str, material: str) -> dict[str, Any]:
    """What the person handed over with the task, as the wire's optional fields."""
    handed: dict[str, Any] = {}
    named = _documents_or_refuse(documents)
    if named:
        handed["documents"] = named
    text = _material_or_refuse(material)
    if text:
        handed["material"] = text
    return handed


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
    "Aktenvermerk“, „mach das Protokoll aus den Notizen vom Jour fixe“) — nicht für eine Frage, die sich "
    "jetzt beantworten lässt. "
    "`kind` ist eine von " + _KIND_LIST + ": `compliance_check` ist die Normprüfung eines Dokuments "
    "gegen die OIB-Richtlinien, `einreichcheck` prüft die Vollständigkeit der Einreichung, `document` "
    "schreibt ein Dokument und legt es als Entwurf ab, `protokoll` macht aus den Notizen einer Besprechung "
    "das Besprechungsprotokoll und legt es als Entwurf ab (braucht die Notizen in `documents` oder "
    "`material`; nie mit `cadence`), `revision` überarbeitet einen zurückgegebenen Entwurf. "
    "`goal` ist der Auftrag in den Worten der Nutzerin. `due` ist optional das gewünschte Datum als "
    "`JJJJ-MM-TT` — rechne „bis Freitag“ selbst in ein Datum um, gib keinen Text an. "
    "`cadence` ist optional ein 5-Feld-Cron für wiederkehrende Aufträge („jeden Montag“ → "
    "`0 8 * * 1`, UTC): Damit wird ein Zeitplan angelegt statt eines einzelnen Laufs; er braucht die "
    "Berechtigung `project:skills:manage`, und ohne sie wird er abgelehnt. "
    "Der Auftrag sieht diese Unterhaltung NICHT: Was er braucht, gibst du mit. `documents` ist optional "
    "die Liste der Projektdateien, aus denen gearbeitet wird, eine je Zeile, genau wie in der Dateiübersicht. "
    "`material` ist optional ein Text, den die Nutzerin hier eingefügt hat, wörtlich und vollständig. "
    "Der Auftrag läuft mit den Rechten der Nutzerin und kostet ihr Budget. Nach dem Aufruf ist die "
    "Arbeit ANGELEGT, nicht erledigt. "
    "Ein Auftrag gehört zu einem Projekt: Ohne Projekt in dieser Unterhaltung entsteht keiner, sage "
    "das dann der Nutzerin, statt es erneut zu versuchen."
)


class CreateTaskConfig(FunctionBaseConfig, name="create_task"):
    """Configuration for the ``create_task`` tool."""


async def _create(kind: str, goal: str, due: str, cadence: str, documents: str, material: str) -> str:
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
    handed = _handed_over(documents, material)
    if chosen_kind in _NEEDS_HANDED_OVER and not handed:
        raise _Refused(_NO_NOTES)
    payload.update(handed)
    # Only when the model gave one. The BFF's schema is strict, and an empty
    # string is not a date — it would be a 400 for a field nobody asked for.
    if (due or "").strip():
        payload["due"] = due.strip()
    if (cadence or "").strip():
        if chosen_kind in _ONE_OFF:
            raise _Refused(_NO_CADENCE)
        payload["cadence"] = _cadence_or_refuse(cadence)

    body = await _post(payload, envelope)
    emit_task_card(body, goal=chosen_goal, kind=chosen_kind)
    title = str(body.get("title") or chosen_goal)
    if body.get("scheduled"):
        next_run = str(body.get("nextRunAt") or "").strip()
        first_run = f" Der erste Lauf ist für {next_run} geplant." if next_run else ""
        return f"Zeitplan angelegt: „{title}“.{first_run} {_SCHEDULED}"
    return f"Auftrag angelegt: „{title}“. {_QUEUED}"


async def run_create_task(
    kind: str, goal: str, due: str = "", cadence: str = "", documents: str = "", material: str = ""
) -> str:
    """Delegate one piece of work to a task row.

    Module-level, and the tool below is a one-line wrapper around it, so the
    refusal paths are reachable by a test without going through NAT's generator —
    the refusals are most of what this tool is.
    """
    try:
        return await _create(kind, goal, due, cadence, documents, material)
    except _Refused as refused:
        return refused.message


@register_function(config_type=CreateTaskConfig)
async def create_task(tool_config: CreateTaskConfig, builder: Builder):
    yield FunctionInfo.from_fn(run_create_task, description=_CREATE_TASK_DESCRIPTION)
