"""The run ledger, as this tier builds it — one shape, pinned to the BFF's own.

A run (a deep-research run, a task run) is ONE assistant message in the
conversation the work was commissioned in, and the ledger is the account that
message carries: the phases the run walked, the steps it took inside them —
each described by the INTENT the runner stated, never by a tool name — the
documents each step reached, and the terminal fact (a filed document and a
report, or an error).

**There is no hand-written twin of the contract here.** The shape is defined
once, in zod, at ``frontends/ui/src/lib/runs/run-ledger-types.ts``, exported to
``frontends/ui/tests/fixtures/run-ledger.schema.json`` and validated against
that file by ``tests/aiq_agent/common/test_run_ledger.py`` — the arrangement
ADR-0055 already uses for the document lifecycle. The models below are how this
tier BUILDS a payload; the fixture is what says the payload is right, so a field
renamed on the TS side fails a test here rather than at runtime with a 400
nobody reads.

The bounds are mirrored as constants for the same reason a producer needs them:
a step's intent has to be cut to length before it is sent, not after it is
refused. The BFF's sanitiser (``lib/runs/run-ledger.ts``) is still the
authority — it truncates on write and again on read — and the test pins these
numbers to the fixture's, so the two cannot drift apart quietly.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field

#: The five phases a run walks, in order. ASCII keys; the German with its
#: umlauts is rendered from the frontend's dictionaries, because a key with an
#: umlaut in it arrives differently normalised depending on who serialised it.
RUN_PHASES: tuple[str, ...] = ("planen", "recherchieren", "pruefen", "schreiben", "abgelegt")
RunPhase = Literal["planen", "recherchieren", "pruefen", "schreiben", "abgelegt"]

#: The seven display states a run is shown in. NOT ``task_runs.status`` — that
#: column is the row's lifecycle and keeps its own CHECK; these are what the
#: reader is told.
RUN_STATUSES: tuple[str, ...] = (
    "angelegt",
    "laeuft",
    "wartet",
    "fertig",
    "fehlgeschlagen",
    "abgebrochen",
    "unterbrochen",
)
RunStatus = Literal[
    "angelegt",
    "laeuft",
    "wartet",
    "fertig",
    "fehlgeschlagen",
    "abgebrochen",
    "unterbrochen",
]

MAX_RUN_ID_CHARS = 64
MAX_STEPS = 50
MAX_STEP_ID_CHARS = 64
MAX_INTENT_CHARS = 160
MAX_DOCS_PER_STEP = 100
MAX_NAME_CHARS = 256
MAX_TITLE_CHARS = 256
MAX_SHELF_CHARS = 64
MAX_LOCUS_CHARS = 128
MAX_LOCI_PER_DOC = 20
MAX_OPEN_POINTS = 20
MAX_OPEN_POINT_CHARS = 200
MAX_ERROR_REASON_CHARS = 400
MAX_REFERENCE_ID_CHARS = 128


class _Wire(BaseModel):
    """Camel on the wire, snake in Python, and no unknown key in either direction.

    ``extra="forbid"`` is not politeness: the ledger's whole claim is that its
    key set is CLOSED, and a model that silently accepted ``tool="search_norms"``
    would let this tier build exactly the payload the contract exists to refuse.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class RunLedgerDoc(_Wire):
    """One document a step reached, plus where in it."""

    name: str = Field(max_length=MAX_NAME_CHARS)
    title: str | None = Field(default=None, max_length=MAX_TITLE_CHARS)
    shelf: str | None = Field(default=None, max_length=MAX_SHELF_CHARS)
    #: The pages or Punkte this step reached the document at. Several, because a
    #: step is a longer unit than a retrieval round and reaches one file in more
    #: than one place.
    loci: list[str] = Field(default_factory=list, max_length=MAX_LOCI_PER_DOC)
    #: An earlier step already reached this document — the producer's own
    #: verdict, which is the only side that can reach it.
    repeat: bool | None = None


class RunStep(_Wire):
    """One step of a run.

    There is deliberately NO tool field. The reader is told what the run was
    trying to do, in the runner's own words; a tool name is an implementation
    detail that changes when we rename a function and means nothing to the person
    waiting for a Befund.
    """

    id: str = Field(max_length=MAX_STEP_ID_CHARS)
    phase: RunPhase
    intent: str = Field(max_length=MAX_INTENT_CHARS)
    started_at: str = Field(alias="startedAt")
    docs: list[RunLedgerDoc] = Field(default_factory=list, max_length=MAX_DOCS_PER_STEP)
    open_points: list[str] | None = Field(default=None, alias="openPoints", max_length=MAX_OPEN_POINTS)


class RunPhaseEntry(_Wire):
    """One phase the run entered, and — once it is over — left."""

    phase: RunPhase
    started_at: str = Field(alias="startedAt")
    ended_at: str | None = Field(default=None, alias="endedAt")


class RunResult(_Wire):
    """What a finished run left behind."""

    file_id: str | None = Field(default=None, alias="fileId", max_length=MAX_REFERENCE_ID_CHARS)
    report_message_id: str | None = Field(default=None, alias="reportMessageId", max_length=MAX_REFERENCE_ID_CHARS)
    filed_at: str = Field(alias="filedAt")


class RunError(_Wire):
    """Why a run stopped, and what it had finished by then."""

    reason: str = Field(max_length=MAX_ERROR_REASON_CHARS)
    #: Derived by the BFF from the phases that actually ended, never believed
    #: from the wire — it is sent for a reader that has only this payload.
    completed_before: list[RunPhase] = Field(default_factory=list, alias="completedBefore")


class RunLedger(_Wire):
    """The whole account of one run."""

    run_id: str = Field(alias="runId", max_length=MAX_RUN_ID_CHARS)
    status: RunStatus
    phases: list[RunPhaseEntry] = Field(default_factory=list, max_length=len(RUN_PHASES))
    steps: list[RunStep] = Field(default_factory=list, max_length=MAX_STEPS)
    result: RunResult | None = None
    error: RunError | None = None
    started_at: str = Field(alias="startedAt")
    updated_at: str = Field(alias="updatedAt")
    finished_at: str | None = Field(default=None, alias="finishedAt")


class RunFinishError(_Wire):
    """The error half of a ``finish`` op: the reason, and nothing else.

    No ``completedBefore`` here although :class:`RunError` has one. The BFF
    derives that list from the phases that actually ended, so a producer that
    sent its own would be stating a fact the store is about to recompute — and
    the two would disagree exactly when a run died mid-phase, which is the only
    time anybody reads it.
    """

    reason: str = Field(max_length=MAX_ERROR_REASON_CHARS)


class RunLedgerAppendRequest(_Wire):
    """``POST /api/internal/runs/{runId}/ledger`` — more of a running account.

    The run id is in the PATH and never here: it is the route's only identity,
    and a body that could name a second run would be a body that could write
    another tenant's ledger.

    Every field is optional because an append is a PATCH in spirit: a flush that
    only closed a phase says nothing about steps, and a flush that only sealed a
    step says nothing about the status.
    """

    op: Literal["append"] = "append"
    steps: list[RunStep] | None = Field(default=None, max_length=MAX_STEPS)
    phases: list[RunPhaseEntry] | None = Field(default=None, max_length=len(RUN_PHASES))
    status: RunStatus | None = None


class RunLedgerFinishRequest(_Wire):
    """The terminal op: exactly one of a result or an error.

    Both or neither is a 400 the route raises rather than the schema, because a
    discriminated union cannot carry that refinement — so a producer checks it
    here, one layer earlier, where the failure is a log line instead of a run
    whose ledger never closed.
    """

    op: Literal["finish"] = "finish"
    result: RunResult | None = None
    error: RunFinishError | None = None


def to_wire(model: _Wire) -> dict:
    """The payload as the route parses it: camelCase keys, absent optionals.

    Absent, never ``null``: every optional on this contract is ``.optional()`` on
    the zod side and a ``null`` would be a key the strict schema refuses — so an
    unfiled run says nothing about a file rather than claiming there is none.
    """
    return model.model_dump(by_alias=True, exclude_none=True, mode="json")
