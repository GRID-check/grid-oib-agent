"""A run's own events, folded into the account its reader is given.

What these pin, in order of how badly each would hurt:

1. Nothing here may fail a run. A ledger client that 500s, times out or raises
   costs the account a flush and the run nothing.
2. Every event lands in the field the reader sees it in — the phase keys most of
   all, because a phase that folds to nothing is a run that shows as idle while
   it works.
3. One fold, one truth: every flush puts the WHOLE ledger on the job's own event
   stream, so a live client replaces its copy instead of folding a second one.
4. A step is posted once, when it is sealed. ``append`` is append-only at the
   BFF, so a step sent twice is a step the reader sees twice.
5. Every body the fold sends is a body the BFF's own schema accepts — checked
   against the JSON Schema exported from its zod, not against a twin written
   here (ADR-0055).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from aiq_agent.common.run_ledger import RUN_PHASES
from aiq_api.jobs.phase_events import JOB_PHASE_EVENT_TYPE
from aiq_api.jobs.phase_events import PHASE_CITATION_VERIFICATION_STARTED
from aiq_api.jobs.phase_events import PHASE_DONE
from aiq_api.jobs.phase_events import PHASE_PLANNING_STARTED
from aiq_api.jobs.phase_events import PHASE_RESEARCH_STARTED
from aiq_api.jobs.phase_events import PHASE_WRITING_STARTED
from aiq_api.jobs.run_ledger_fold import JOB_DEGRADED_EVENT_TYPE
from aiq_api.jobs.run_ledger_fold import PHASE_KEYS
from aiq_api.jobs.run_ledger_fold import RUN_LEDGER_EVENT_TYPE
from aiq_api.jobs.run_ledger_fold import RunLedgerFold

SCHEMA_PATH = Path(__file__).resolve().parents[3] / "frontends" / "ui" / "tests" / "fixtures" / "run-ledger.schema.json"
RUN_ID = "b3f0f0a0-0000-4000-8000-000000000001"


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    with SCHEMA_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def validator(schema: dict[str, Any], name: str) -> Draft202012Validator:
    """A validator for one named definition, resolving ``$ref`` against the file."""
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]})


class FakeClient:
    """The ledger primitive, recorded rather than called."""

    def __init__(self, *, accepts: bool = True, raises: bool = False) -> None:
        self.accepts = accepts
        self.raises = raises
        self.appends: list[Any] = []
        self.finishes: list[Any] = []

    async def append(self, run_id: str, body: Any) -> bool:
        if self.raises:
            raise RuntimeError("the BFF is down")
        self.appends.append(body)
        return self.accepts

    async def finish(self, run_id: str, body: Any) -> bool:
        if self.raises:
            raise RuntimeError("the BFF is down")
        self.finishes.append(body)
        return self.accepts


class FakeStore:
    """The job's event store, kept in a list."""

    job_id = "job-1"

    def __init__(self) -> None:
        self.events: list[dict] = []

    def store(self, event: dict) -> None:
        self.events.append(event)

    def store_batch(self, events: list[dict]) -> None:
        self.events.extend(events)

    def flush(self) -> None:
        return None


def make_fold(**kwargs: Any) -> tuple[RunLedgerFold, FakeStore, FakeClient]:
    store = FakeStore()
    client = kwargs.pop("client", None) or FakeClient()
    fold = RunLedgerFold(
        job_id="job-1",
        run_id=kwargs.pop("run_id", RUN_ID),
        event_store=store,
        client=client,
        autoflush=kwargs.pop("autoflush", False),
        **kwargs,
    )
    return fold, store, client


def phase_event(phase: str, **extra: Any) -> dict:
    return {"type": JOB_PHASE_EVENT_TYPE, "data": {"phase": phase, **extra}}


def source_event(**fields: Any) -> dict:
    return {"type": "artifact.update", "data": {"type": "citation_source", **fields}}


def todo_event(todos: list[dict]) -> dict:
    return {"type": "artifact.update", "data": {"type": "todo", "content": todos}}


def snapshots(store: FakeStore) -> list[dict]:
    return [event["data"]["ledger"] for event in store.events if event["type"] == RUN_LEDGER_EVENT_TYPE]


class TestTheMapping:
    """Every event in the field the reader sees it in."""

    def test_the_five_phase_keys_are_the_contracts(self) -> None:
        """A phase that folds to a key the schema does not know is a lost run."""
        assert set(PHASE_KEYS.values()) == set(RUN_PHASES)
        assert PHASE_KEYS[PHASE_PLANNING_STARTED] == "planen"
        assert PHASE_KEYS[PHASE_RESEARCH_STARTED] == "recherchieren"
        assert PHASE_KEYS[PHASE_CITATION_VERIFICATION_STARTED] == "pruefen"
        assert PHASE_KEYS[PHASE_WRITING_STARTED] == "schreiben"
        assert PHASE_KEYS[PHASE_DONE] == "abgelegt"

    def test_it_listens_for_the_spelling_the_runner_writes(self) -> None:
        """The fold names the event types itself (the runner imports it, not the
        other way round), so this is what keeps the two spellings one spelling."""
        from aiq_api.jobs.runner import JOB_DEGRADED_EVENT_TYPE as runner_degraded

        assert JOB_DEGRADED_EVENT_TYPE == runner_degraded

    async def test_a_phase_opens_and_the_one_before_it_closes(self) -> None:
        fold, _store, _client = make_fold()
        fold.observe(phase_event(PHASE_PLANNING_STARTED))
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1))
        ledger = fold.snapshot()

        assert [entry["phase"] for entry in ledger["phases"]] == ["planen", "recherchieren"]
        assert ledger["phases"][0]["endedAt"], "the phase the run left has to say it ended"
        assert "endedAt" not in ledger["phases"][1]
        assert ledger["status"] == "laeuft"

    async def test_a_research_round_states_its_own_intent(self) -> None:
        """The batch's ``conclusion`` IS the step's intent — never a tool name."""
        fold, _store, _client = make_fold()
        fold.observe(
            phase_event(
                PHASE_RESEARCH_STARTED,
                batch_index=1,
                batch_size=3,
                conclusion="Fluchtweglängen für GK4 klären",
            )
        )
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=2))
        steps = fold.snapshot()["steps"]

        assert [step["id"] for step in steps] == ["runde-1", "runde-2"]
        assert steps[0]["intent"] == "Fluchtweglängen für GK4 klären"
        # A batch that stated nothing still names itself, because a step with no
        # intent is one the contract refuses and the reader cannot read.
        assert steps[1]["intent"] == "Recherche-Runde 2"
        assert all(step["phase"] == "recherchieren" for step in steps)
        assert all("tool" not in step for step in steps)

    async def test_a_source_lands_on_the_open_step_with_its_locus(self) -> None:
        fold, _store, _client = make_fold()
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1))
        fold.observe(
            source_event(
                file_name="oib-richtlinie-2.pdf",
                title="OIB-Richtlinie 2 Brandschutz",
                shelf="baurecht",
                punkt="2.3.1",
                page=12,
            )
        )
        fold.observe(source_event(file_name="oib-richtlinie-2.pdf", page=14))
        docs = fold.snapshot()["steps"][0]["docs"]

        assert len(docs) == 1, "one document, reached in two places"
        assert docs[0]["name"] == "oib-richtlinie-2.pdf"
        assert docs[0]["title"] == "OIB-Richtlinie 2 Brandschutz"
        assert docs[0]["shelf"] == "baurecht"
        assert docs[0]["loci"] == ["Pkt. 2.3.1 p.12", "p.14"]

    async def test_a_source_before_the_first_step_is_not_invented_a_step(self) -> None:
        fold, _store, _client = make_fold()
        fold.observe(source_event(file_name="a.pdf", page=1))
        assert fold.snapshot()["steps"] == []

    async def test_todos_become_the_open_points_of_the_step_that_kept_them(self) -> None:
        fold, _store, _client = make_fold()
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1))
        fold.observe(
            todo_event(
                [
                    {"content": "Stiegenhausbreite im Bestand prüfen", "status": "pending"},
                    {"content": "OIB-2 gelesen", "status": "completed"},
                ]
            )
        )
        assert fold.snapshot()["steps"][0]["openPoints"] == ["Stiegenhausbreite im Bestand prüfen"]

        # write_todos re-states the whole list, so the fold replaces rather than
        # appends: a point that was closed has to disappear.
        fold.observe(todo_event([{"content": "Stiegenhausbreite im Bestand prüfen", "status": "completed"}]))
        assert "openPoints" not in fold.snapshot()["steps"][0]

    async def test_a_failure_is_an_error_with_what_was_finished_before_it(self) -> None:
        fold, _store, client = make_fold()
        fold.observe(phase_event(PHASE_PLANNING_STARTED))
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1))
        fold.observe({"type": "job.error", "data": {"error": "Der Anbieter hat abgebrochen.", "error_type": "X"}})
        await fold.close()

        ledger = fold.snapshot()
        assert ledger["status"] == "fehlgeschlagen"
        assert ledger["error"]["reason"] == "Der Anbieter hat abgebrochen."
        # Derived from the phases that genuinely ended — „beim Recherchieren
        # gescheitert, Planen war fertig" rather than „failed".
        assert ledger["error"]["completedBefore"] == ["planen"]
        assert [body.error.reason for body in client.finishes] == ["Der Anbieter hat abgebrochen."]

    async def test_a_cancelled_run_is_its_status_and_sends_no_finish(self) -> None:
        """The finish op carries a result or an error; a cancel has neither."""
        fold, _store, client = make_fold()
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1))
        fold.observe({"type": "job.cancelled", "data": {}})
        await fold.close()

        assert fold.snapshot()["status"] == "abgebrochen"
        assert client.finishes == []
        assert client.appends[-1].status == "abgebrochen"

    async def test_a_salvaged_run_is_unterbrochen_and_still_has_its_result(self) -> None:
        fold, _store, client = make_fold()
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1))
        fold.observe({"type": "job.degraded", "data": {"research_truncated": True}})
        fold.note_result(report_message_id="msg-1")
        await fold.close()

        ledger = fold.snapshot()
        assert ledger["status"] == "unterbrochen"
        assert ledger["result"]["reportMessageId"] == "msg-1"
        assert "error" not in ledger
        assert client.finishes[-1].result.report_message_id == "msg-1"

    async def test_a_finished_run_says_what_it_left_behind(self) -> None:
        fold, _store, client = make_fold()
        fold.observe(phase_event(PHASE_WRITING_STARTED))
        fold.observe(phase_event(PHASE_DONE))
        fold.note_result(report_message_id="msg-1", file_id="doc-7")
        await fold.close()

        ledger = fold.snapshot()
        assert ledger["status"] == "fertig"
        assert ledger["result"]["fileId"] == "doc-7"
        assert ledger["finishedAt"]
        assert client.finishes[-1].result.file_id == "doc-7"


class TestTheGrundlage:
    """The documents the reader named: on the ledger from the first snapshot, extended live."""

    async def test_the_named_documents_are_on_the_first_snapshot_and_the_first_append(self) -> None:
        fold, store, client = make_fold(
            grundlage=[
                {"name": "Einreichplan.pdf", "title": "Einreichplan", "shelf": "project"},
                {"name": "", "shelf": "project"},
            ]
        )
        fold.observe(phase_event(PHASE_PLANNING_STARTED))
        await fold.flush(force=True)

        assert snapshots(store)[0]["grundlage"] == [
            {"name": "Einreichplan.pdf", "title": "Einreichplan", "shelf": "project", "loci": []}
        ]
        assert [doc.name for doc in client.appends[0].grundlage] == ["Einreichplan.pdf"]
        # Sent once: a quiet flush repeats neither the list nor the step.
        await fold.flush(force=True)
        assert all(body.grundlage is None for body in client.appends[1:])

    async def test_a_document_added_while_the_run_goes_joins_the_list_once_and_flushes_at_once(self) -> None:
        fold, store, client = make_fold(grundlage=[{"name": "Einreichplan.pdf"}])
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1))
        await fold.flush(force=True)

        from aiq_agent.common.plan_documents import PlanDocument

        fold.add_grundlage(PlanDocument(name="Brandschutzkonzept.pdf", shelf="project"))
        fold.add_grundlage({"name": "brandschutzkonzept.pdf"})
        await fold.flush()

        assert [doc["name"] for doc in snapshots(store)[-1]["grundlage"]] == [
            "Einreichplan.pdf",
            "Brandschutzkonzept.pdf",
        ]
        sent = [[doc.name for doc in body.grundlage] for body in client.appends if body.grundlage is not None]
        assert sent == [["Einreichplan.pdf"], ["Einreichplan.pdf", "Brandschutzkonzept.pdf"]]

    async def test_the_grundlage_validates_against_the_bff_schema(self, schema: dict[str, Any]) -> None:
        fold, store, client = make_fold(grundlage=[{"name": "Einreichplan.pdf", "shelf": "project"}])
        fold.observe(phase_event(PHASE_PLANNING_STARTED))
        await fold.flush(force=True)

        from aiq_agent.common.run_ledger import to_wire

        validator(schema, "runLedger").validate(snapshots(store)[-1])
        for body in client.appends:
            validator(schema, "runLedgerRequest").validate(to_wire(body))


class TestTheFlush:
    """When the account moves, and who is told."""

    async def test_every_flush_puts_the_whole_ledger_on_the_job_stream(self) -> None:
        fold, store, _client = make_fold()
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1, conclusion="OIB-2 lesen"))
        await fold.flush(force=True)

        assert len(snapshots(store)) == 1
        ledger = snapshots(store)[0]
        # The WHOLE thing, so a live client replaces its copy rather than
        # folding a second one from the raw events.
        assert ledger["runId"] == RUN_ID
        assert ledger["steps"][0]["intent"] == "OIB-2 lesen"

    async def test_a_transition_flushes_and_a_quiet_moment_does_not(self) -> None:
        fold, store, _client = make_fold()
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1))
        await fold.flush(force=True)
        assert len(snapshots(store)) == 1

        # Inside the debounce window and not a transition: nothing goes out.
        fold.observe(source_event(file_name="a.pdf", page=1))
        await fold.flush()
        assert len(snapshots(store)) == 1

        # A phase transition ignores the debounce: the reader is told at once.
        fold.observe(phase_event(PHASE_WRITING_STARTED))
        await fold.flush()
        assert len(snapshots(store)) == 2
        assert snapshots(store)[-1]["steps"][0]["docs"][0]["name"] == "a.pdf"

    async def test_an_ingest_schedules_its_own_flush(self) -> None:
        """The runner never calls flush: the events that feed the fold drive it."""
        store = FakeStore()
        fold = RunLedgerFold(job_id="job-1", run_id=RUN_ID, event_store=store, client=FakeClient())
        fold.observe(phase_event(PHASE_PLANNING_STARTED))
        await asyncio.sleep(0.05)
        assert len(snapshots(store)) == 1

    async def test_a_step_is_posted_once_and_only_when_it_is_sealed(self) -> None:
        fold, _store, client = make_fold()
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1))
        await fold.flush(force=True)
        # Still open: it may still collect documents, and append cannot revise.
        assert [step.id for body in client.appends for step in (body.steps or [])] == []

        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=2))
        await fold.flush(force=True)
        await fold.flush(force=True)
        sent = [step.id for body in client.appends for step in (body.steps or [])]
        assert sent == ["runde-1"], "sealed once, sent once"

    async def test_a_refused_append_is_retried_rather_than_lost(self) -> None:
        fold, _store, client = make_fold(client=FakeClient(accepts=False))
        fold.observe(phase_event(PHASE_PLANNING_STARTED))
        fold.observe(phase_event(PHASE_WRITING_STARTED))
        await fold.flush(force=True)
        await fold.flush(force=True)

        sent = [step.id for body in client.appends for step in (body.steps or [])]
        assert sent == ["planen", "planen"], "what the store did not take is offered again"

    async def test_without_a_run_id_it_narrates_and_posts_nothing(self) -> None:
        """No run id is no identity: the route would 404, so no doomed POST."""
        fold, store, client = make_fold(run_id=None)
        fold.observe(phase_event(PHASE_PLANNING_STARTED))
        fold.note_result(report_message_id="msg-1")
        await fold.close()

        assert client.appends == [] and client.finishes == []
        assert snapshots(store), "the live stream still carries the account"


class TestNothingFailsTheRun:
    """The contract every write in this tier keeps."""

    async def test_a_client_that_raises_never_reaches_the_run(self) -> None:
        fold, store, _client = make_fold(client=FakeClient(raises=True))
        fold.observe(phase_event(PHASE_PLANNING_STARTED))
        fold.note_result(report_message_id="msg-1")
        await fold.close()
        assert snapshots(store), "the snapshot still went out"

    async def test_an_event_store_that_raises_never_reaches_the_run(self) -> None:
        class BrokenStore(FakeStore):
            def store(self, event: dict) -> None:
                raise RuntimeError("no database")

        fold = RunLedgerFold(
            job_id="job-1", run_id=RUN_ID, event_store=BrokenStore(), client=FakeClient(), autoflush=False
        )
        fold.observe(phase_event(PHASE_PLANNING_STARTED))
        await fold.close()

    async def test_a_malformed_event_is_ignored(self) -> None:
        fold, _store, _client = make_fold()
        for event in ({}, {"type": "job.phase"}, {"type": "job.phase", "data": {"phase": "nonsense"}}):
            fold.observe(event)
        assert fold.snapshot()["phases"] == []

    async def test_the_wrapped_store_still_stores_everything(self) -> None:
        """Wrapping the event store must not cost the stream a single event."""
        fold, store, _client = make_fold()
        wrapped = fold.observing(store)
        wrapped.store(phase_event(PHASE_PLANNING_STARTED))
        wrapped.store_batch([source_event(file_name="a.pdf", page=2)])
        wrapped.flush()

        assert [event["type"] for event in store.events] == ["job.phase", "artifact.update"]
        assert wrapped.job_id == "job-1"
        assert fold.snapshot()["steps"][0]["docs"][0]["name"] == "a.pdf"


class TestTheContract:
    """What the fold sends is what the BFF's own schema accepts (ADR-0055)."""

    async def test_every_body_a_whole_run_sends_validates(self, schema: dict[str, Any]) -> None:
        fold, store, client = make_fold()
        fold.observe(phase_event(PHASE_PLANNING_STARTED))
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1, conclusion="OIB-2 auf Fluchtwege prüfen"))
        fold.observe(source_event(file_name="oib-richtlinie-2.pdf", shelf="baurecht", punkt="2.3.1", page=12))
        fold.observe(todo_event([{"content": "Bestand klären", "status": "pending"}]))
        await fold.flush(force=True)
        fold.observe(phase_event(PHASE_WRITING_STARTED))
        fold.observe(phase_event(PHASE_CITATION_VERIFICATION_STARTED))
        fold.observe(phase_event(PHASE_DONE))
        fold.note_result(report_message_id="8f1a0f7e-2b1f-4a4e-9a4e-2f0f1a6d9c31")
        await fold.close()

        from aiq_agent.common.run_ledger import to_wire

        request = validator(schema, "runLedgerRequest")
        assert client.appends and client.finishes
        for body in [*client.appends, *client.finishes]:
            request.validate(to_wire(body))

        ledger = validator(schema, "runLedger")
        assert snapshots(store)
        for payload in snapshots(store):
            ledger.validate(payload)

    async def test_an_over_long_intent_is_cut_before_it_is_sent(self, schema: dict[str, Any]) -> None:
        """A producer cuts to length; being refused is not a plan."""
        fold, store, _client = make_fold()
        fold.observe(phase_event(PHASE_RESEARCH_STARTED, batch_index=1, conclusion="ü" * 400))
        await fold.flush(force=True)
        validator(schema, "runLedger").validate(snapshots(store)[-1])


def test_a_repeated_claim_is_not_a_change() -> None:
    from aiq_api.jobs.run_ledger_fold import _add_findings
    from aiq_api.jobs.run_ledger_fold import _Step

    step = _Step(id="s1", phase="research", intent="Brandschutz", started_at="t")
    notes = json.dumps({"findings": [{"claim": "REI 60 gefordert."}]})
    assert _add_findings(step, notes) is True
    assert _add_findings(step, notes) is False
    assert step.findings == ["REI 60 gefordert."]
