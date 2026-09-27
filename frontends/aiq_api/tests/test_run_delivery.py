"""A finished run's writes to the BFF heal on their own, or can be rebuilt.

Two halves of one fix (backlog T3-11):

1. The run's own writes — the report into its message, the thread turn — are
   retried briefly, so a BFF restart at the moment a run ends costs nothing.
2. What the retry cannot heal the BFF's run reconciler rebuilds from the job
   store, through ``GET /v1/internal/jobs/{id}/outcome``. That route must hand
   back the SAME message the runner would have written, and nothing about a job
   of another organization.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest import mock

import pytest
from fastapi import HTTPException

from aiq_api.jobs.conversation_output import FAILURE_NOTICE
from aiq_api.jobs.conversation_output import INTERRUPTED_NOTICE
from aiq_api.jobs.conversation_output import run_message_for_outcome
from aiq_api.jobs.conversation_output import write_job_notice
from aiq_api.jobs.conversation_output import write_job_turn
from aiq_api.websocket_reconnect import post_internal_conversation_message
from aiq_api.websocket_reconnect import post_internal_run_report

USAGE = {"identity": {"organization_id": "org_1", "user_id": "u1"}}


class _Sequence:
    """``httpx.AsyncClient`` stand-in: each POST gets the next answer; an exception is raised."""

    answers: list = []
    calls: list[dict] = []

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    async def post(self, url, json, headers):  # noqa: A002 - httpx kw name
        type(self).calls.append({"url": url, "json": json})
        answer = type(self).answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        status, body = answer if isinstance(answer, tuple) else (answer, {})
        return SimpleNamespace(status_code=status, json=lambda: body)


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "a-real-secret-token")
    _Sequence.answers = []
    _Sequence.calls = []


class TestTheRunReportIsRetried:
    @pytest.mark.asyncio
    async def test_a_run_not_recorded_yet_lands_on_a_later_attempt(self) -> None:
        _Sequence.answers = [404, (200, {"messageId": "msg-1"})]
        with mock.patch("aiq_api.websocket_reconnect.httpx.AsyncClient", _Sequence):
            landed = await post_internal_run_report(job_id="job-1", text="# Bericht", expect_run=True)
        assert landed == "msg-1"
        assert len(_Sequence.calls) == 2

    @pytest.mark.asyncio
    async def test_without_a_run_the_404_is_the_answer_at_once(self) -> None:
        """An interactive job has no run message; the caller falls back without waiting."""
        _Sequence.answers = [404]
        with mock.patch("aiq_api.websocket_reconnect.httpx.AsyncClient", _Sequence):
            assert await post_internal_run_report(job_id="job-1", text="# Bericht") is None
        assert len(_Sequence.calls) == 1

    @pytest.mark.asyncio
    async def test_a_bff_that_never_answers_costs_three_attempts_and_no_exception(self) -> None:
        _Sequence.answers = [ConnectionError("down")] * 3
        with mock.patch("aiq_api.websocket_reconnect.httpx.AsyncClient", _Sequence):
            assert await post_internal_run_report(job_id="job-1", text="x", expect_run=True) is None
        assert len(_Sequence.calls) == 3


class TestTheThreadTurnIsRetried:
    @pytest.mark.asyncio
    async def test_a_5xx_is_asked_again(self) -> None:
        _Sequence.answers = [503, 201]
        with mock.patch("aiq_api.websocket_reconnect.httpx.AsyncClient", _Sequence):
            ok = await post_internal_conversation_message(
                conversation_id="s_1",
                organization_id="org_1",
                message_id="m1",
                role="assistant",
                text="a",
                message_type="agent_response",
            )
        assert ok is True
        assert len(_Sequence.calls) == 2

    @pytest.mark.asyncio
    async def test_a_missing_conversation_is_final(self) -> None:
        _Sequence.answers = [404]
        with mock.patch("aiq_api.websocket_reconnect.httpx.AsyncClient", _Sequence):
            ok = await post_internal_conversation_message(
                conversation_id="s_gone",
                organization_id="org_1",
                message_id="m1",
                role="assistant",
                text="a",
                message_type="agent_response",
            )
        assert ok is False
        assert len(_Sequence.calls) == 1


class TestTheWritersPassOnWhetherARunIsExpected:
    @pytest.mark.asyncio
    async def test_the_turn_and_the_notice_forward_expect_run(self) -> None:
        with mock.patch(
            "aiq_api.jobs.conversation_output.post_internal_run_report",
            new_callable=mock.AsyncMock,
            return_value="msg-1",
        ) as report:
            await write_job_turn(
                conversation_id="s_1", job_id="job-1", usage_context=USAGE, prompt="q", answer="a", expect_run=True
            )
            await write_job_notice(
                conversation_id="s_1", job_id="job-1", usage_context=USAGE, notice=FAILURE_NOTICE, expect_run=True
            )
        assert [call.kwargs["expect_run"] for call in report.await_args_list] == [True, True]

    @pytest.mark.asyncio
    async def test_the_default_expects_no_run(self) -> None:
        with mock.patch(
            "aiq_api.jobs.conversation_output.post_internal_run_report",
            new_callable=mock.AsyncMock,
            return_value="msg-1",
        ) as report:
            await write_job_turn(conversation_id="s_1", job_id="job-1", usage_context=USAGE, prompt="q", answer="a")
        assert report.await_args.kwargs["expect_run"] is False


class TestTheRunMessageRebuiltFromTheJobStore:
    """What the reconciler writes must be what the runner would have written."""

    @pytest.mark.asyncio
    async def test_a_success_rebuilds_the_same_content_and_metadata_the_runner_posts(self) -> None:
        output = {
            "report": "# Bericht",
            "cards": [{"type": "legal_basis"}],
            "sources": [{"id": "s1"}],
            "research_truncated": True,
            "truncation_reason": "wall_clock",
            "not_a_transparency_key": "dropped",
        }
        rebuilt = run_message_for_outcome(job_id="job-1", status="SUCCESS", output=output)

        with mock.patch(
            "aiq_api.jobs.conversation_output.post_internal_run_report",
            new_callable=mock.AsyncMock,
            return_value="msg-1",
        ) as report:
            await write_job_turn(
                conversation_id="s_1",
                job_id="job-1",
                usage_context=USAGE,
                prompt="q",
                answer=output["report"],
                cards=output["cards"],
                sources=output["sources"],
                transparency={"research_truncated": True, "truncation_reason": "wall_clock"},
            )
        posted = report.await_args.kwargs
        assert rebuilt == {"content": posted["text"], "metadata": posted["metadata"]}
        assert "not_a_transparency_key" not in rebuilt["metadata"]

    def test_a_failure_and_a_cancel_get_their_notices(self) -> None:
        assert run_message_for_outcome(job_id="j", status="failure", output=None) == {
            "content": FAILURE_NOTICE,
            "metadata": {"job_id": "j"},
        }
        assert run_message_for_outcome(job_id="j", status="interrupted", output=None)["content"] == INTERRUPTED_NOTICE

    def test_a_live_job_or_a_success_without_a_report_has_nothing_to_write(self) -> None:
        assert run_message_for_outcome(job_id="j", status="running", output=None) is None
        assert run_message_for_outcome(job_id="j", status="submitted", output=None) is None
        assert run_message_for_outcome(job_id="j", status="success", output={"report": ""}) is None


class _Store:
    def __init__(self, job) -> None:
        self._job = job

    async def get_job(self, job_id):
        return self._job


@pytest.fixture
def access_db_url(tmp_path):
    from aiq_api.jobs import access as job_access

    job_access._job_access_schema_initialized.clear()
    yield f"sqlite+aiosqlite:///{tmp_path / 'access.db'}"
    job_access._job_access_schema_initialized.clear()


def _job(status: str, *, output: dict | None = None, error: str | None = None):
    return SimpleNamespace(status=status, output=json.dumps(output) if output else None, error=error)


class TestTheInternalOutcomeRoute:
    @pytest.mark.asyncio
    async def test_a_finished_job_hands_back_everything_the_run_would_have_written(self, access_db_url) -> None:
        from aiq_agent.auth import Principal
        from aiq_api.jobs.access import create_job_access
        from aiq_api.routes.jobs import internal_job_outcome

        create_job_access("job-1", Principal(type="jwt", sub="u1"), access_db_url, None, None, "org_1")
        store = _Store(_job("success", output={"report": "# Bericht", "cards": [{"type": "x"}]}))

        answer = await internal_job_outcome(store, access_db_url, "job-1", "org_1")

        assert answer.status == "success"
        assert answer.report == "# Bericht"
        assert answer.cards == [{"type": "x"}]
        assert answer.error is None
        assert answer.message["content"] == "# Bericht"
        assert answer.message["metadata"]["job_id"] == "job-1"

    @pytest.mark.asyncio
    async def test_a_failed_job_carries_its_error_and_its_notice(self, access_db_url) -> None:
        from aiq_agent.auth import Principal
        from aiq_api.jobs.access import create_job_access
        from aiq_api.routes.jobs import internal_job_outcome

        create_job_access("job-1", Principal(type="jwt", sub="u1"), access_db_url, None, None, "org_1")
        answer = await internal_job_outcome(_Store(_job("failure", error="boom")), access_db_url, "job-1", "org_1")

        assert (answer.status, answer.error, answer.report) == ("failure", "boom", None)
        assert answer.message["content"] == FAILURE_NOTICE

    @pytest.mark.asyncio
    async def test_a_running_job_has_no_message_yet(self, access_db_url) -> None:
        from aiq_agent.auth import Principal
        from aiq_api.jobs.access import create_job_access
        from aiq_api.routes.jobs import internal_job_outcome

        create_job_access("job-1", Principal(type="jwt", sub="u1"), access_db_url, None, None, "org_1")
        answer = await internal_job_outcome(_Store(_job("running")), access_db_url, "job-1", "org_1")
        assert (answer.status, answer.message, answer.error) == ("running", None, None)

    @pytest.mark.asyncio
    async def test_another_organizations_job_is_not_found(self, access_db_url) -> None:
        from aiq_agent.auth import Principal
        from aiq_api.jobs.access import create_job_access
        from aiq_api.routes.jobs import internal_job_outcome

        create_job_access("job-1", Principal(type="jwt", sub="u1"), access_db_url, None, None, "org_1")
        with pytest.raises(HTTPException) as refused:
            await internal_job_outcome(_Store(_job("success")), access_db_url, "job-1", "org_2")
        assert refused.value.status_code == 404

    @pytest.mark.asyncio
    async def test_an_unknown_job_is_not_found(self, access_db_url) -> None:
        from aiq_api.routes.jobs import internal_job_outcome

        with pytest.raises(HTTPException) as refused:
            await internal_job_outcome(_Store(None), access_db_url, "job-gone", "org_1")
        assert refused.value.status_code == 404
