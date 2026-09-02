"""The worker tells the BFF how a run ended, best-effort and by backend job id."""

from __future__ import annotations

from unittest import mock

import pytest

from aiq_api.jobs.outcome_notify import notify_job_outcome

USAGE = {"identity": {"organization_id": "org-1", "user_id": "user-1", "project_id": "proj-1"}}


class _Response:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class _Client:
    """A stand-in for ``httpx.AsyncClient`` that records the one POST."""

    calls: list[dict] = []
    status_code = 200

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def post(self, url, *, json, headers):
        type(self).calls.append({"url": url, "json": json, "headers": headers})
        return _Response(type(self).status_code)


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "a-real-secret-token")
    _Client.calls = []
    _Client.status_code = 200


@pytest.mark.asyncio
async def test_posts_the_outcome_by_backend_job_id() -> None:
    with mock.patch("aiq_api.jobs.outcome_notify.httpx.AsyncClient", _Client):
        accepted = await notify_job_outcome(job_id="job-1", usage_context=USAGE, status="failure", error="boom")

    assert accepted is True
    assert len(_Client.calls) == 1
    call = _Client.calls[0]
    assert call["url"] == "http://frontend:3000/api/internal/jobs/job-1/outcome"
    assert call["json"] == {"organizationId": "org-1", "status": "failure", "error": "boom"}
    assert call["headers"]["X-Grid-Internal-Token"] == "a-real-secret-token"


@pytest.mark.asyncio
async def test_a_run_the_bff_does_not_know_is_not_an_error() -> None:
    """An interactive deep-research job has no job_runs row: 404 is the ordinary answer."""
    _Client.status_code = 404
    with mock.patch("aiq_api.jobs.outcome_notify.httpx.AsyncClient", _Client):
        accepted = await notify_job_outcome(job_id="job-2", usage_context=USAGE, status="success")
    assert accepted is False


@pytest.mark.asyncio
async def test_skips_without_a_tenant_or_a_token(monkeypatch) -> None:
    with mock.patch("aiq_api.jobs.outcome_notify.httpx.AsyncClient", _Client):
        assert await notify_job_outcome(job_id="job-3", usage_context={}, status="success") is False
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN")
        assert await notify_job_outcome(job_id="job-3", usage_context=USAGE, status="success") is False
    assert _Client.calls == []


@pytest.mark.asyncio
async def test_never_raises_when_the_bff_is_unreachable() -> None:
    class _Broken(_Client):
        async def post(self, url, *, json, headers):
            raise ConnectionError("frontend down")

    with mock.patch("aiq_api.jobs.outcome_notify.httpx.AsyncClient", _Broken):
        assert await notify_job_outcome(job_id="job-4", usage_context=USAGE, status="interrupted") is False


@pytest.mark.asyncio
async def test_a_finished_report_rides_along_for_filing_as_the_requester() -> None:
    """The BFF files the report as the task's pinned requester (ADR-0051); the
    worker is the only party that holds the report at completion time."""
    with mock.patch("aiq_api.jobs.outcome_notify.httpx.AsyncClient", _Client):
        await notify_job_outcome(
            job_id="job-1",
            usage_context=USAGE,
            status="success",
            report="# Bericht",
            cards=[{"type": "legal_basis", "title": "OIB-RL 2"}],
        )

    call = _Client.calls[0]
    assert call["json"]["report"] == "# Bericht"
    assert call["json"]["cards"] == [{"type": "legal_basis", "title": "OIB-RL 2"}]


@pytest.mark.asyncio
async def test_no_report_means_no_report_key() -> None:
    with mock.patch("aiq_api.jobs.outcome_notify.httpx.AsyncClient", _Client):
        await notify_job_outcome(job_id="job-1", usage_context=USAGE, status="interrupted", cards=[{"x": 1}])

    assert "report" not in _Client.calls[0]["json"]
    assert "cards" not in _Client.calls[0]["json"]
