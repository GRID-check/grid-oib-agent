"""Tests for the research-queue submit payload (ADR-0021, jobs/submit.py).

The critical correctness property: the payload a worker replays must carry
exactly ``run_agent_job``'s parameters (so a signature change can't silently
drop a field) and must survive a JSON round-trip (it is stored as text).
"""

from __future__ import annotations

import inspect
import json
from types import SimpleNamespace

from aiq_api.jobs.runner import run_agent_job
from aiq_api.jobs.submit import _build_run_agent_payload


def _sample_payload():
    return _build_run_agent_payload(
        configure_logging=True,
        log_level=20,
        db_url="postgresql://x/y",
        config_path="/app/configs/c.yml",
        job_id="job-1",
        input_text="research this",
        agent_config=SimpleNamespace(class_path="pkg.mod.Agent", config_name="deep"),
        parent_trace_context=("span", "fn", "fname", "run", 123, "conv", {"tag": "v"}),
        available_documents=[{"file_name": "d.pdf", "summary": "s"}],
        data_sources=["web"],
        auth_token="tok",
        collection_scope=["c1"],
        platform_lessons='PLATFORM_LESSONS v1\n- [inaccurate | 2x] "Maße nie schätzen."',
        project_context="ctx",
        project_memory="PROJECT_MEMORY v1\n- Atrium ist OIB 2.3",
        model_overrides={"group": "model"},
        usage_context={"identity": {"organization_id": "org"}},
        user_info={"name": "n"},
        clarifier_result="clar",
        memory_reflection_enabled=True,
        memory_reflection_llm="card_llm",
        run_id="run-1",
    )


def test_payload_keys_match_run_agent_job_signature():
    payload = _sample_payload()
    params = set(inspect.signature(run_agent_job).parameters)
    assert set(payload.keys()) == params


def test_payload_is_json_serializable():
    payload = _sample_payload()
    restored = json.loads(json.dumps(payload))
    assert restored["job_id"] == "job-1"
    assert restored["parent_workflow_trace_id"] == 123
    assert restored["available_documents"] == [{"file_name": "d.pdf", "summary": "s"}]
