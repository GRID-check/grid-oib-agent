"""A job queued by the release before #887 still runs after the upgrade.

Root cause: a research job's queue payload is the kwargs the worker replays with
``run_agent_job(**payload)``. The release before #887 wrote ``scheduler_address``
(its Dask scheduler) into every payload, and #887 removed that parameter. A row
queued at the upgrade, and a running job whose claim another worker takes over,
replay the same stored payload, so every one of them died with a TypeError.

Why missed: the worker tests stub ``run_agent_job`` with ``**kwargs``, which
accepts anything, and no test replayed a payload written by an earlier release.

The fix: ``worker.RETIRED_PAYLOAD_KEYS`` names the keys the old release wrote,
and the worker drops exactly those after decryption. Anything else unknown still
fails loudly.

Ratchet: the stub below binds against the REAL ``run_agent_job`` signature, so a
stale or misspelled key fails here as it would in production. The rows go through
the real queue table (and the real payload encryption when a KEK is set).
"""

from __future__ import annotations

import base64
import inspect
import logging
import os

import pytest

from aiq_api.jobs import queue
from aiq_api.jobs import worker as worker_mod
from aiq_api.jobs.runner import run_agent_job

from .test_job_queue import _age_heartbeat

#: What the release before #887 enqueued, with the Dask scheduler key it carried.
OLD_PAYLOAD = {
    "configure_logging": False,
    "log_level": 20,
    "scheduler_address": "tcp://127.0.0.1:8786",
    "db_url": "sqlite:///unused.db",
    "config_file_path": "configs/config.yml",
    "job_id": "job-old",
    "input_text": "pre-upgrade question",
    "agent_class_path": "aiq_agent.agents.deep_researcher.agent.DeepResearcherAgent",
    "agent_config_name": "deep_research_agent",
    "claim_owner": None,
}


@pytest.fixture
def db_url(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/jobs.db"
    monkeypatch.setenv("NAT_JOB_STORE_DB_URL", url)
    monkeypatch.setenv("GRID_WORKER_LIVENESS_FILE", str(tmp_path / "alive"))
    monkeypatch.delenv("AIQ_DEEP_CHECKPOINT_DB", raising=False)
    queue.ensure_research_queue_table(url)
    yield url
    queue._queues.pop(url, None)


@pytest.fixture
def replayed(monkeypatch) -> list:
    """Stand in for ``run_agent_job`` with its real signature: a bad key raises as it would in production."""
    calls: list = []
    signature = inspect.signature(run_agent_job)

    async def _bind_like_the_real_one(**kwargs):
        signature.bind(**kwargs)
        calls.append(kwargs)

    monkeypatch.setattr(worker_mod, "run_agent_job", _bind_like_the_real_one)
    return calls


async def _claim_and_run(db_url: str, payload: dict) -> None:
    queue.enqueue(db_url, payload["job_id"], payload, "org-a")
    claim = queue.claim_next(db_url, "worker-old", stale_seconds=30, max_attempts=3)
    assert claim is not None
    await worker_mod.ResearchWorker()._run_claimed(claim)


async def test_queued_payload_with_scheduler_address_replays_without_it(db_url, replayed):
    await _claim_and_run(db_url, dict(OLD_PAYLOAD))

    assert len(replayed) == 1
    assert "scheduler_address" not in replayed[0]
    assert replayed[0]["input_text"] == "pre-upgrade question"
    assert replayed[0]["claim_owner"] == worker_mod.ResearchWorker().worker_id


async def test_encrypted_old_payload_is_filtered_after_decryption(db_url, replayed, monkeypatch):
    monkeypatch.setenv("GRID_JOB_PAYLOAD_KEK", base64.b64encode(os.urandom(32)).decode())

    await _claim_and_run(db_url, dict(OLD_PAYLOAD))

    assert len(replayed) == 1
    assert "scheduler_address" not in replayed[0]


async def test_reclaimed_running_job_replays_the_same_old_payload(db_url, replayed):
    """A job running at deploy time: its claim goes stale and a new worker claims the stored row again."""
    queue.enqueue(db_url, "job-old", dict(OLD_PAYLOAD), "org-a")
    first = queue.claim_next(db_url, "worker-before-deploy", stale_seconds=30, max_attempts=3)
    assert first is not None
    _age_heartbeat(db_url, "job-old", 120)  # the pre-deploy worker is gone
    reclaimed = queue.claim_next(db_url, "worker-after-deploy", stale_seconds=30, max_attempts=3)
    assert reclaimed is not None
    assert reclaimed["attempts"] == 2

    await worker_mod.ResearchWorker()._run_claimed(reclaimed)

    assert len(replayed) == 1
    assert "scheduler_address" not in replayed[0]


async def _run_and_collect_failure(db_url: str, payload: dict, caplog) -> BaseException:
    with caplog.at_level(logging.ERROR, logger=worker_mod.logger.name):
        await _claim_and_run(db_url, payload)
    failure = next(r for r in caplog.records if "failed in worker" in r.getMessage())
    return failure.exc_info[1]


async def test_unknown_key_in_a_new_payload_still_fails(db_url, replayed, caplog):
    """No general ignore-unknown filter: a typo or a stale key in a NEW payload must stay loud."""
    new_payload = {k: v for k, v in OLD_PAYLOAD.items() if k != "scheduler_address"}
    new_payload.update(job_id="job-new", not_a_parameter=1)

    error = await _run_and_collect_failure(db_url, new_payload, caplog)

    assert replayed == []
    assert isinstance(error, TypeError)
    assert "not_a_parameter" in str(error)


async def test_a_retired_key_does_not_hide_an_unknown_one(db_url, replayed, caplog):
    payload = {**OLD_PAYLOAD, "job_id": "job-mixed", "not_a_parameter": 1}

    error = await _run_and_collect_failure(db_url, payload, caplog)

    assert replayed == []
    assert isinstance(error, TypeError)
    assert "not_a_parameter" in str(error)
    assert "scheduler_address" not in str(error)


def test_only_the_named_retired_keys_are_dropped():
    kwargs = worker_mod._replay_kwargs({"job_id": "j", "scheduler_address": "x", "other": 1}, "w1")

    assert kwargs == {"job_id": "j", "other": 1, "claim_owner": "w1"}
    assert worker_mod.RETIRED_PAYLOAD_KEYS == {"scheduler_address"}
