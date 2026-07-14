# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Tests for runner-side safety behavior.

Covers: terminal-status stickiness (a reaped FAILURE must never be flipped
back to SUCCESS by the worker), CancellationMonitor stopping on FAILURE, and
error-message sanitization (no raw exception text with hosts/DSNs to clients).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from aiq_api.jobs.runner import CancellationMonitor
from aiq_api.jobs.runner import _update_status_if_not_terminal
from aiq_api.jobs.runner import sanitize_job_error


def _job_store(current_status: str | None):
    job = SimpleNamespace(status=current_status) if current_status is not None else None
    return SimpleNamespace(get_job=AsyncMock(return_value=job), update_status=AsyncMock())


class TestTerminalStatusStickiness:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("terminal_status", ["success", "failure", "interrupted"])
    async def test_success_write_skipped_when_already_terminal(self, terminal_status):
        """A reaped/cancelled job must keep its terminal verdict."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        job_store = _job_store(terminal_status)

        written = await _update_status_if_not_terminal(job_store, "job-1", JobStatus.SUCCESS, output={"report": "r"})

        assert written is False
        job_store.update_status.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_failure_write_skipped_when_already_interrupted(self):
        """The worker's failure path must not clobber a user cancellation."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        job_store = _job_store("interrupted")

        written = await _update_status_if_not_terminal(job_store, "job-1", JobStatus.FAILURE, error="boom")

        assert written is False
        job_store.update_status.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_writes_when_job_still_running(self):
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        job_store = _job_store("running")

        written = await _update_status_if_not_terminal(job_store, "job-1", JobStatus.SUCCESS, output={"report": "r"})

        assert written is True
        job_store.update_status.assert_awaited_once_with("job-1", JobStatus.SUCCESS, output={"report": "r"})

    @pytest.mark.asyncio
    async def test_writes_when_current_status_unreadable(self):
        """Fail open: an unreadable current status must not lose the terminal write."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        job_store = SimpleNamespace(
            get_job=AsyncMock(side_effect=ConnectionError("db down")),
            update_status=AsyncMock(),
        )

        written = await _update_status_if_not_terminal(job_store, "job-1", JobStatus.FAILURE, error="boom")

        assert written is True
        job_store.update_status.assert_awaited_once_with("job-1", JobStatus.FAILURE, error="boom")

    @pytest.mark.asyncio
    async def test_writes_when_job_missing(self):
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        job_store = _job_store(None)

        written = await _update_status_if_not_terminal(job_store, "job-1", JobStatus.SUCCESS)

        assert written is True
        job_store.update_status.assert_awaited_once_with("job-1", JobStatus.SUCCESS)


class TestCancellationMonitorStopStatuses:
    def _monitor(self) -> CancellationMonitor:
        return CancellationMonitor(
            scheduler_address="tcp://localhost:8786",
            db_url="sqlite:///test.db",
            job_id="job-1",
            poll_interval=0.01,
        )

    @staticmethod
    def _patch_job_store(monkeypatch, status: str) -> None:
        import nat.front_ends.fastapi.async_jobs.job_store as nat_job_store

        class FakeJobStore:
            def __init__(self, scheduler_address=None, db_url=None, db_engine=None):
                pass

            async def get_job(self, job_id):
                return SimpleNamespace(status=status)

        monkeypatch.setattr(nat_job_store, "JobStore", FakeJobStore)

    @pytest.mark.asyncio
    async def test_monitor_stops_on_interrupted(self, monkeypatch):
        self._patch_job_store(monkeypatch, "interrupted")
        monitor = self._monitor()

        await asyncio.wait_for(monitor._poll_job_status(), timeout=2.0)

        assert monitor.is_cancelled

    @pytest.mark.asyncio
    async def test_monitor_stops_on_failure(self, monkeypatch):
        """The ghost-job reaper writes FAILURE externally; the worker must stop too."""
        self._patch_job_store(monkeypatch, "failure")
        monitor = self._monitor()

        await asyncio.wait_for(monitor._poll_job_status(), timeout=2.0)

        assert monitor.is_cancelled

    @pytest.mark.asyncio
    async def test_monitor_keeps_running_job_alive(self, monkeypatch):
        self._patch_job_store(monkeypatch, "running")
        monitor = self._monitor()

        task = asyncio.create_task(monitor._poll_job_status())
        await asyncio.sleep(0.1)

        assert not monitor.is_cancelled
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


class TestSanitizeJobError:
    def test_internal_error_never_leaks_exception_text(self):
        message = sanitize_job_error(RuntimeError("postgresql://user:s3cret@db.internal:5432/jobs failed"))

        assert message == "The job failed due to an internal error."
        assert "s3cret" not in message
        assert "db.internal" not in message

    def test_timeout_classified(self):
        assert sanitize_job_error(TimeoutError("upstream at 10.0.0.5 timed out")) == (
            "The job timed out while waiting on an external service."
        )

    def test_connection_error_classified(self):
        message = sanitize_job_error(ConnectionError("refused by 10.0.0.5:5432"))

        assert message == "A connection error occurred while running the job."
        assert "10.0.0.5" not in message

    def test_llm_provider_error_classified_by_module(self):
        class FakeProviderError(Exception):
            pass

        FakeProviderError.__module__ = "openai.error"

        message = sanitize_job_error(FakeProviderError("401 from https://api.example.com key=sk-abc"))

        assert message == "The LLM provider returned an error while running the job."
        assert "sk-abc" not in message

    def test_network_stack_error_classified_by_module(self):
        class FakeTransportError(Exception):
            pass

        FakeTransportError.__module__ = "httpx"

        message = sanitize_job_error(FakeTransportError("connect to internal-host:8443 failed"))

        assert message == "A connection error occurred while running the job."
        assert "internal-host" not in message
