"""An ingestion job's model spend reaches the usage ledger, booked as ingestion.

Until this, the only scopes with a cost tracker were chat turns, research jobs
and memory reflection: every vision caption, transcription, summary and
embedding an ingestion job paid for reached no ledger, no budget and no
platform view.
"""

from __future__ import annotations

from unittest.mock import patch

from knowledge_layer.llamaindex import adapter

from aiq_agent.common.cost_tracking import grid_cost_tracker_var
from aiq_agent.common.cost_tracking import record_usage_event


def test_an_ingestion_job_opens_a_tracker_booked_to_its_organization_project_and_uploader():
    config = {"organization_id": "org_1", "project_id": "proj-1", "user_id": "user_1"}
    with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
        with adapter._ingest_cost_scope("job-1", config):
            tracker = grid_cost_tracker_var.get()
            assert record_usage_event(model="vendor/vision-1", role="ingest_vision", prompt_tokens=10, cost_usd=0.01)
    assert (tracker.organization_id, tracker.project_id, tracker.user_id, tracker.job_id) == (
        "org_1",
        "proj-1",
        "user_1",
        "job-1",
    )
    payload = post.call_args.args[0]
    assert payload["activity"] == "ingest" and payload["jobId"] == "job-1"


def test_an_ingestion_job_is_never_refused_by_a_budget_midway():
    # A document half-read because a limit ran out mid-job is worse than the
    # overrun; the spend still lands in the budgets it counts toward.
    with patch("aiq_agent.common.cost_tracking._post_usage_events"):
        with adapter._ingest_cost_scope("job-1", {"organization_id": "org_1"}):
            tracker = grid_cost_tracker_var.get()
            tracker._turn_cost_usd = 1_000_000.0
            tracker._check_budget()


def test_run_ingestion_runs_inside_the_scope(monkeypatch):
    seen = []

    def body(self, job_id, file_paths, collection_name, config):
        seen.append(grid_cost_tracker_var.get())

    monkeypatch.setattr(adapter.LlamaIndexIngestor, "_run_ingestion_tracked", body)
    ingestor = adapter.LlamaIndexIngestor.__new__(adapter.LlamaIndexIngestor)
    with patch("aiq_agent.common.cost_tracking._post_usage_events"):
        ingestor._run_ingestion("job-1", [], "proj_1", {"organization_id": "org_1"})
    assert seen[0] is not None and seen[0].activity == "ingest"
    assert grid_cost_tracker_var.get() is None
