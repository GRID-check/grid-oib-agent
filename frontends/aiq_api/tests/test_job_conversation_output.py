"""A finished job run lands in the conversation it was given.

The contract these pin, in order of how badly each would hurt:

1. Nothing here may fail a run. Every write is best-effort.
2. The question precedes the answer. The reader sorts by timestamp and breaks
   ties on a random uuid, so insertion order guarantees nothing.
3. A run that produced nothing says so, rather than leaving an empty thread.
4. No conversation means no HTTP call at all.
5. Whatever transparency an interactive turn carries, the job's thread message
   carries too — a reader must not learn less from a scheduled answer than from
   one they typed.
"""

from __future__ import annotations

from unittest import mock

import pytest

from aiq_api.jobs.conversation_output import FAILURE_NOTICE
from aiq_api.jobs.conversation_output import write_job_notice
from aiq_api.jobs.conversation_output import write_job_turn

USAGE = {"identity": {"organization_id": "org_1", "user_id": "u1"}}


def _posts(calls) -> list[dict]:
    return [c.kwargs for c in calls]


@pytest.mark.asyncio
async def test_writes_the_question_then_the_answer() -> None:
    with mock.patch(
        "aiq_api.jobs.conversation_output.post_internal_conversation_message",
        new_callable=mock.AsyncMock,
    ) as post:
        await write_job_turn(
            conversation_id="s_abc",
            job_id="job-1",
            usage_context=USAGE,
            prompt="Fasse die Woche zusammen.",
            answer="Hier ist die Zusammenfassung.",
            cards=[{"type": "summary"}],
        )

    posts = _posts(post.await_args_list)
    assert [p["role"] for p in posts] == ["user", "assistant"]
    assert posts[0]["text"] == "Fasse die Woche zusammen."
    assert posts[1]["text"] == "Hier ist die Zusammenfassung."
    # The ONE thing insertion order cannot guarantee.
    assert posts[0]["created_at"] < posts[1]["created_at"]
    # The persisted answer carries the job id, so the UI's existing
    # "view report" affordance lights up on the message for free.
    assert posts[1]["metadata"]["deep_research_job_id"] == "job-1"
    assert posts[1]["metadata"]["cards"] == [{"type": "summary"}]


@pytest.mark.asyncio
async def test_ids_are_deterministic_so_a_retry_is_a_no_op() -> None:
    with mock.patch(
        "aiq_api.jobs.conversation_output.post_internal_conversation_message",
        new_callable=mock.AsyncMock,
    ) as post:
        for _ in range(2):
            await write_job_turn(
                conversation_id="s_abc",
                job_id="job-1",
                usage_context=USAGE,
                prompt="q",
                answer="a",
            )

    posts = _posts(post.await_args_list)
    assert posts[0]["message_id"] == posts[2]["message_id"]
    assert posts[1]["message_id"] == posts[3]["message_id"]
    # The two roles must NOT collide with each other.
    assert posts[0]["message_id"] != posts[1]["message_id"]


@pytest.mark.asyncio
async def test_no_conversation_means_no_call() -> None:
    with mock.patch(
        "aiq_api.jobs.conversation_output.post_internal_conversation_message",
        new_callable=mock.AsyncMock,
    ) as post:
        await write_job_turn(conversation_id=None, job_id="job-1", usage_context=USAGE, prompt="q", answer="a")
        await write_job_notice(conversation_id=None, job_id="job-1", usage_context=USAGE, notice=FAILURE_NOTICE)
    post.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_failed_write_never_propagates() -> None:
    """The whole point: a conversation write must not unmake a good run."""
    with mock.patch(
        "aiq_api.jobs.conversation_output.post_internal_conversation_message",
        new_callable=mock.AsyncMock,
        side_effect=RuntimeError("bff down"),
    ):
        await write_job_turn(conversation_id="s_abc", job_id="job-1", usage_context=USAGE, prompt="q", answer="a")
        await write_job_notice(conversation_id="s_abc", job_id="job-1", usage_context=USAGE, notice=FAILURE_NOTICE)


@pytest.mark.asyncio
async def test_a_run_that_produced_nothing_says_so() -> None:
    with mock.patch(
        "aiq_api.jobs.conversation_output.post_internal_conversation_message",
        new_callable=mock.AsyncMock,
    ) as post:
        await write_job_notice(
            conversation_id="s_abc",
            job_id="job-1",
            usage_context=USAGE,
            notice=FAILURE_NOTICE,
        )
    posts = _posts(post.await_args_list)
    assert len(posts) == 1
    assert posts[0]["role"] == "assistant"
    assert posts[0]["text"] == FAILURE_NOTICE


@pytest.mark.asyncio
async def test_no_organization_id_skips_rather_than_posting_a_doomed_write() -> None:
    with mock.patch(
        "aiq_api.jobs.conversation_output.post_internal_conversation_message",
        new_callable=mock.AsyncMock,
    ) as post:
        await write_job_turn(conversation_id="s_abc", job_id="job-1", usage_context={}, prompt="q", answer="a")
    post.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_job_that_ran_under_a_skill_says_so_in_the_thread() -> None:
    """The transparency the socket path already writes, on the job path too.

    ``persist_assistant_message`` puts ``skills_activated`` in the metadata of
    an interactive turn. A job run had the same field on the same agent state
    and dropped it, so a thread written BY a job looked identical whether or
    not the office's own working method had shaped the answer.
    """
    with mock.patch(
        "aiq_api.jobs.conversation_output.post_internal_conversation_message",
        new_callable=mock.AsyncMock,
    ) as post:
        await write_job_turn(
            conversation_id="s_abc",
            job_id="job-1",
            usage_context=USAGE,
            prompt="q",
            answer="a",
            skills_activated=["oib-brandschutznachweis"],
        )

    assert _posts(post.await_args_list)[1]["metadata"]["skills_activated"] == ["oib-brandschutznachweis"]


@pytest.mark.asyncio
async def test_a_job_without_skills_writes_no_skills_key() -> None:
    """Absent means absent — an empty list would render as a claim of nothing."""
    with mock.patch(
        "aiq_api.jobs.conversation_output.post_internal_conversation_message",
        new_callable=mock.AsyncMock,
    ) as post:
        await write_job_turn(
            conversation_id="s_abc",
            job_id="job-1",
            usage_context=USAGE,
            prompt="q",
            answer="a",
            skills_activated=[],
        )

    assert "skills_activated" not in _posts(post.await_args_list)[1]["metadata"]
