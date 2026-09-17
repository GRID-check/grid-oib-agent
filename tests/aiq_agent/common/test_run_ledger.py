"""The run ledger's wire, validated against the schema the BFF generated from its own zod.

ADR-0055 read from this side: there is **no hand-written twin** of the contract.
The shape lives in ``frontends/ui/src/lib/runs/run-ledger-types.ts``, is
serialised to ``frontends/ui/tests/fixtures/run-ledger.schema.json`` by
``run-ledger-schema.spec.ts``, and what this file asserts is that the payloads
``aiq_agent.common.run_ledger`` builds validate against it — so a field renamed
on the TS side fails here rather than at runtime with a 400 the reader sees as
„Piloti konnte den Verlauf nicht schreiben".

Both directions are checked: a ledger this tier builds validates against the
schema, and a ledger shaped the way the schema describes parses back into these
models. One direction alone would let a model that drops a field pass.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from typing import get_args

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from aiq_agent.common.run_ledger import MAX_DOCS_PER_STEP
from aiq_agent.common.run_ledger import MAX_INTENT_CHARS
from aiq_agent.common.run_ledger import MAX_LOCI_PER_DOC
from aiq_agent.common.run_ledger import MAX_NAME_CHARS
from aiq_agent.common.run_ledger import MAX_STEPS
from aiq_agent.common.run_ledger import RUN_PHASES
from aiq_agent.common.run_ledger import RUN_STATUSES
from aiq_agent.common.run_ledger import RunError
from aiq_agent.common.run_ledger import RunLedger
from aiq_agent.common.run_ledger import RunLedgerDoc
from aiq_agent.common.run_ledger import RunPhase
from aiq_agent.common.run_ledger import RunPhaseEntry
from aiq_agent.common.run_ledger import RunResult
from aiq_agent.common.run_ledger import RunStatus
from aiq_agent.common.run_ledger import RunStep
from aiq_agent.common.run_ledger import to_wire

SCHEMA_PATH = Path(__file__).resolve().parents[3] / "frontends" / "ui" / "tests" / "fixtures" / "run-ledger.schema.json"


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    with SCHEMA_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def _validator(schema: dict[str, Any], name: str) -> Draft202012Validator:
    """A validator for one named definition, resolving ``$ref`` against the whole file."""
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]})


def _ledger() -> RunLedger:
    """A run that searched, wrote and filed — every optional exercised once."""
    return RunLedger(
        runId="6f1a0f7e-2b1f-4a4e-9a4e-2f0f1a6d9c31",
        status="fertig",
        phases=[
            RunPhaseEntry(
                phase="recherchieren",
                startedAt="2026-09-16T08:00:00.000Z",
                endedAt="2026-09-16T08:05:00.000Z",
            ),
            RunPhaseEntry(phase="abgelegt", startedAt="2026-09-16T08:05:00.000Z"),
        ],
        steps=[
            RunStep(
                id="batch-1",
                phase="recherchieren",
                intent="OIB-2 auf Fluchtwegbreiten prüfen",
                startedAt="2026-09-16T08:01:00.000Z",
                docs=[
                    RunLedgerDoc(
                        name="oib-richtlinie-2.pdf",
                        title="OIB-Richtlinie 2 Brandschutz",
                        shelf="baurecht",
                        loci=["Punkt 2.3.1", "S. 12"],
                        repeat=False,
                    )
                ],
                openPoints=["Stiegenhausbreite im Bestand ungeklärt"],
            )
        ],
        result=RunResult(fileId="doc-1", filedAt="2026-09-16T08:06:00.000Z"),
        startedAt="2026-09-16T08:00:00.000Z",
        updatedAt="2026-09-16T08:06:00.000Z",
        finishedAt="2026-09-16T08:06:00.000Z",
    )


class TestTheWire:
    """A ledger this tier builds is one the BFF's own schema accepts."""

    def test_the_fixture_is_where_the_contract_lives(self, schema: dict[str, Any]) -> None:
        """A guard on the guard: a moved fixture must fail loudly, not silently pass."""
        assert "runLedger" in schema["$defs"]

    def test_a_built_ledger_validates(self, schema: dict[str, Any]) -> None:
        _validator(schema, "runLedger").validate(to_wire(_ledger()))

    def test_a_fresh_ledger_validates(self, schema: dict[str, Any]) -> None:
        """„angelegt, noch nichts passiert" is a state, not an empty payload."""
        fresh = RunLedger(
            runId="run-1",
            status="angelegt",
            startedAt="2026-09-16T08:00:00.000Z",
            updatedAt="2026-09-16T08:00:00.000Z",
        )
        _validator(schema, "runLedger").validate(to_wire(fresh))

    def test_a_failed_ledger_validates(self, schema: dict[str, Any]) -> None:
        failed = RunLedger(
            runId="run-1",
            status="fehlgeschlagen",
            phases=[
                RunPhaseEntry(
                    phase="planen",
                    startedAt="2026-09-16T08:00:00.000Z",
                    endedAt="2026-09-16T08:01:00.000Z",
                )
            ],
            error=RunError(reason="Der Anbieter hat abgebrochen.", completedBefore=["planen"]),
            startedAt="2026-09-16T08:00:00.000Z",
            updatedAt="2026-09-16T08:02:00.000Z",
            finishedAt="2026-09-16T08:02:00.000Z",
        )
        _validator(schema, "runLedger").validate(to_wire(failed))

    def test_the_wire_reads_back_into_the_models(self) -> None:
        """The other direction: what the schema describes is what these models parse."""
        assert RunLedger.model_validate(to_wire(_ledger())) == _ledger()

    def test_an_optional_is_absent_and_never_null(self) -> None:
        payload = to_wire(
            RunLedger(
                runId="run-1",
                status="laeuft",
                startedAt="2026-09-16T08:00:00.000Z",
                updatedAt="2026-09-16T08:00:00.000Z",
            )
        )
        assert "result" not in payload and "error" not in payload and "finishedAt" not in payload

    def test_the_append_op_validates(self, schema: dict[str, Any]) -> None:
        """The request body the fold will post is the same contract, closed at two ops."""
        body = {
            "op": "append",
            "steps": [to_wire(_ledger().steps[0])],
            "phases": [to_wire(_ledger().phases[0])],
            "status": "laeuft",
        }
        _validator(schema, "runLedgerRequest").validate(body)


class TestTheClosedShape:
    """What the ledger is defined by NOT carrying."""

    def test_a_step_may_not_name_a_tool(self) -> None:
        with pytest.raises(ValidationError):
            RunStep(
                id="batch-1",
                phase="recherchieren",
                intent="OIB-2 prüfen",
                startedAt="2026-09-16T08:01:00.000Z",
                tool="search_norms",
            )

    def test_the_schema_refuses_it_too(self, schema: dict[str, Any]) -> None:
        step = to_wire(_ledger().steps[0]) | {"tool": "search_norms"}
        assert not _validator(schema, "runLedger").is_valid(to_wire(_ledger()) | {"steps": [step]})

    def test_both_vocabularies_are_the_frontends(self, schema: dict[str, Any]) -> None:
        """Mirrored, not imported; the fixture is the pin.

        A phase added on the TS side and not here would arrive on a ledger this
        tier cannot build, so the run would lose its whole account rather than
        one row.
        """
        properties = schema["$defs"]["runLedger"]["properties"]
        assert set(get_args(RunStatus)) == set(properties["status"]["enum"])
        assert set(RUN_STATUSES) == set(properties["status"]["enum"])
        phase_enum = properties["phases"]["items"]["properties"]["phase"]["enum"]
        assert set(get_args(RunPhase)) == set(phase_enum)
        assert set(RUN_PHASES) == set(phase_enum)

    def test_the_bounds_are_the_frontends(self, schema: dict[str, Any]) -> None:
        """A producer cuts to length before it sends; the caps it cuts to are these.

        Pinned to the fixture so „truncate at 160" cannot mean one thing here and
        another in the sanitiser that has the last word.
        """
        ledger = schema["$defs"]["runLedger"]["properties"]
        step = ledger["steps"]["items"]["properties"]
        doc = step["docs"]["items"]["properties"]
        assert ledger["steps"]["maxItems"] == MAX_STEPS
        assert step["intent"]["maxLength"] == MAX_INTENT_CHARS
        assert step["docs"]["maxItems"] == MAX_DOCS_PER_STEP
        assert doc["name"]["maxLength"] == MAX_NAME_CHARS
        assert doc["loci"]["maxItems"] == MAX_LOCI_PER_DOC
