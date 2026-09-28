"""A finished job run lands in the conversation it was given.

The contract these pin, in order of how badly each would hurt:

1. Nothing here may fail a run. Every write is best-effort.
2. The question precedes the answer. The reader sorts by timestamp and breaks
   ties on a random uuid, so insertion order guarantees nothing.
3. A run that produced nothing says so, rather than leaving an empty thread.
4. No conversation means no HTTP call at all.
5. Whatever transparency an interactive turn carries, the job's thread message
   carries too — a reader must not learn less from a scheduled answer than from
   one they typed. Including the caveats the run put on its OWN answer: a run
   cut off at the wall clock and salvaged must still read as cut off when the
   thread is reopened tomorrow.
"""

from __future__ import annotations

from unittest import mock

import pytest

from aiq_api.jobs.conversation_output import _TRANSPARENCY_METADATA_KEYS
from aiq_api.jobs.conversation_output import FAILURE_NOTICE
from aiq_api.jobs.conversation_output import _transparency_metadata
from aiq_api.jobs.conversation_output import report_message_id
from aiq_api.jobs.conversation_output import write_job_notice
from aiq_api.jobs.conversation_output import write_job_turn

USAGE = {"identity": {"organization_id": "org_1", "user_id": "u1"}}


def _posts(calls) -> list[dict]:
    return [c.kwargs for c in calls]


@pytest.fixture(autouse=True)
def _no_run_message():
    """Every test below is about a run that has NO message of its own.

    That is the older shape — an interactive deep-research job, or a run
    submitted before ADR-0062 — and it is still the contract for those runs, so
    the whole file keeps testing it. ``None`` is exactly what the BFF's 404
    means. The run-message path has its own class at the end.
    """
    with mock.patch(
        "aiq_api.jobs.conversation_output.post_internal_run_report",
        new_callable=mock.AsyncMock,
        return_value=None,
    ) as report:
        yield report


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


class TestTransparencyReachesTheThread:
    """The caveats a run put on its own answer, on the durable surface too.

    The job store and the live ``job.degraded`` event already carried these. The
    conversation message did not, so the reader who came back tomorrow — the one
    with no live panel and no stream — was the only one never told the research
    had been cut off.
    """

    @pytest.mark.asyncio
    async def test_a_cut_off_run_says_so_in_the_thread(self) -> None:
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
                transparency={
                    "research_truncated": True,
                    "truncation_reason": "wall_clock",
                    "degraded_reasons": ["no_valid_citations"],
                    "citations_removed": {"count": 2, "reasons": ["url_not_in_registry"]},
                },
            )

        metadata = _posts(post.await_args_list)[1]["metadata"]
        # Wire spelling, verbatim: the BFF's normaliser recognises these names
        # and no others, so a camelCase "tidy-up" here would store keys nothing
        # ever reads back.
        assert metadata["research_truncated"] is True
        assert metadata["truncation_reason"] == "wall_clock"
        assert metadata["degraded_reasons"] == ["no_valid_citations"]
        assert metadata["citations_removed"] == {"count": 2, "reasons": ["url_not_in_registry"]}

    @pytest.mark.asyncio
    async def test_the_answers_self_assessment_travels_whole(self) -> None:
        """Level and reasons together — a level with no reason is not actionable."""
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
                transparency={
                    "answer_confidence": "low",
                    "answer_confidence_reason": "Keine bindende Quelle gefunden.",
                    "answer_confidence_capped_reason": "ungrounded",
                },
            )

        metadata = _posts(post.await_args_list)[1]["metadata"]
        assert metadata["answer_confidence"] == "low"
        assert metadata["answer_confidence_reason"] == "Keine bindende Quelle gefunden."
        assert metadata["answer_confidence_capped_reason"] == "ungrounded"

    @pytest.mark.asyncio
    async def test_a_clean_run_writes_no_transparency_keys_at_all(self) -> None:
        """Absent, not false: no ``research_truncated: false`` on a complete run."""
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
                transparency={},
            )
            await write_job_turn(
                conversation_id="s_abc",
                job_id="job-2",
                usage_context=USAGE,
                prompt="q",
                answer="a",
            )

        for metadata in (p["metadata"] for p in _posts(post.await_args_list) if p["role"] == "assistant"):
            for key in _TRANSPARENCY_METADATA_KEYS:
                assert key not in metadata

    @pytest.mark.asyncio
    async def test_empty_values_are_not_claims(self) -> None:
        """``degraded_reasons: []`` would read as "we checked and found none"."""
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
                transparency={
                    "research_truncated": False,
                    "truncation_reason": "",
                    "degraded_reasons": [],
                    "citations_removed": {},
                    "answer_confidence": None,
                },
            )

        metadata = _posts(post.await_args_list)[1]["metadata"]
        for key in _TRANSPARENCY_METADATA_KEYS:
            assert key not in metadata

    @pytest.mark.asyncio
    async def test_only_the_known_keys_travel(self) -> None:
        """An allowlist, so no caller can seed new keys in a public contract."""
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
                transparency={"research_truncated": True, "internal_debug_state": {"secret": 1}},
            )

        metadata = _posts(post.await_args_list)[1]["metadata"]
        assert metadata["research_truncated"] is True
        assert "internal_debug_state" not in metadata

    @pytest.mark.asyncio
    async def test_a_malformed_payload_costs_the_caveat_not_the_message(self) -> None:
        """Transparency is bookkeeping ABOUT an answer; it may never unmake one."""
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
                transparency=["research_truncated"],  # type: ignore[arg-type]
            )

        posts = _posts(post.await_args_list)
        # The thread still reads as a question and its answer.
        assert [p["role"] for p in posts] == ["user", "assistant"]
        assert posts[1]["text"] == "a"
        assert "research_truncated" not in posts[1]["metadata"]


class TestTheRunWritesIntoItsOwnMessage:
    """A run is ONE message in the thread that commissioned it (ADR-0062).

    The BFF minted that message when the run was submitted and it has been
    carrying the run's ledger since; the report belongs IN it. What these pin is
    the shape of the move and the fork that decides it:

    1. when the run has a message, the report goes there and NO question row is
       written — nobody typed a question, and inventing one puts words in a
       person's mouth in their own thread;
    2. the metadata is the same metadata either way, so the two destinations
       cannot come to describe one answer differently;
    3. a failure notice lands in that same message rather than beside it;
    4. the 404 that says „this run has no message" falls back to the old pair,
       which is what lets the two services deploy in either order.
    """

    @pytest.mark.asyncio
    async def test_the_report_fills_in_the_run_message_and_writes_no_question(self, _no_run_message) -> None:
        _no_run_message.return_value = "msg-run-1"
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
                skills_activated=["oib-brandschutznachweis"],
                sources=[{"title": "OIB-2"}],
                transparency={"research_truncated": True},
            )

        post.assert_not_awaited()
        written = _no_run_message.await_args.kwargs
        assert written["job_id"] == "job-1"
        assert written["text"] == "Hier ist die Zusammenfassung."
        # Everything the fallback turn would have carried, carried here.
        assert written["metadata"]["deep_research_job_id"] == "job-1"
        assert written["metadata"]["cards"] == [{"type": "summary"}]
        assert written["metadata"]["skills_activated"] == ["oib-brandschutznachweis"]
        assert written["metadata"]["sources"] == [{"title": "OIB-2"}]
        assert written["metadata"]["research_truncated"] is True

    @pytest.mark.asyncio
    async def test_the_writer_names_the_message_the_report_landed_in(self, _no_run_message) -> None:
        """The ledger's ``result.reportMessageId`` is whatever the writer returns, never a second derivation."""
        _no_run_message.return_value = "msg-run-1"
        with mock.patch(
            "aiq_api.jobs.conversation_output.post_internal_conversation_message",
            new_callable=mock.AsyncMock,
        ):
            landed = await write_job_turn(
                conversation_id="s_abc", job_id="job-1", usage_context=USAGE, prompt="q", answer="a"
            )
        assert landed == "msg-run-1"

        _no_run_message.return_value = None
        with mock.patch(
            "aiq_api.jobs.conversation_output.post_internal_conversation_message",
            new_callable=mock.AsyncMock,
        ):
            fallback = await write_job_turn(
                conversation_id="s_abc", job_id="job-1", usage_context=USAGE, prompt="q", answer="a"
            )
        assert fallback == report_message_id("s_abc", "job-1")
        nothing = await write_job_turn(
            conversation_id=None, job_id="job-1", usage_context=USAGE, prompt="q", answer="a"
        )
        assert nothing is None

    @pytest.mark.asyncio
    async def test_a_failure_is_stated_in_the_run_message_too(self, _no_run_message) -> None:
        _no_run_message.return_value = "msg-run-1"
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

        post.assert_not_awaited()
        assert _no_run_message.await_args.kwargs["text"] == FAILURE_NOTICE

    @pytest.mark.asyncio
    async def test_a_run_without_a_message_still_gets_its_question_and_answer(self) -> None:
        """The fallback, which is the whole reason the 404 is not an error."""
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
            )

        assert [p["role"] for p in _posts(post.await_args_list)] == ["user", "assistant"]

    @pytest.mark.asyncio
    async def test_a_run_message_needs_no_conversation_id_of_its_own(self, _no_run_message) -> None:
        """The BFF knows where the message is; the worker does not have to.

        A deep-research run was submitted with no conversation at all before this
        design, and its report went into the job store and nowhere else. Now the
        run's message is found from the job id, so the report reaches the thread
        even when nothing was passed down to the worker.
        """
        _no_run_message.return_value = "msg-run-1"
        with mock.patch(
            "aiq_api.jobs.conversation_output.post_internal_conversation_message",
            new_callable=mock.AsyncMock,
        ) as post:
            await write_job_turn(
                conversation_id=None,
                job_id="job-1",
                usage_context=USAGE,
                prompt="q",
                answer="Der Bericht",
            )

        post.assert_not_awaited()
        assert _no_run_message.await_args.kwargs["text"] == "Der Bericht"

    @pytest.mark.asyncio
    async def test_a_failing_report_write_never_propagates(self, _no_run_message) -> None:
        """Nothing here may fail a run — the module's first rule, on the new door.

        And the reader still gets the answer: a surprise on the tidier path costs
        them the tidier SHAPE, never the report.
        """
        _no_run_message.side_effect = RuntimeError("bff down")
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
            )

        assert [p["role"] for p in _posts(post.await_args_list)] == ["user", "assistant"]


class TestTransparencyMetadataFilter:
    """The filter itself, at the values the extractor can hand it."""

    def test_nothing_in_nothing_out(self) -> None:
        assert _transparency_metadata(None) == {}
        assert _transparency_metadata({}) == {}

    def test_only_literal_true_counts_as_a_cutoff(self) -> None:
        assert _transparency_metadata({"research_truncated": True}) == {"research_truncated": True}
        assert _transparency_metadata({"research_truncated": False}) == {}

    def test_the_keys_are_the_backends_wire_spelling(self) -> None:
        """Pinned: the BFF normaliser recognises these names and no others."""
        assert _TRANSPARENCY_METADATA_KEYS == (
            "research_truncated",
            "truncation_reason",
            "degraded_reasons",
            "citations_removed",
            "answer_confidence",
            "answer_confidence_reason",
            "answer_confidence_capped_reason",
            "answer_meta",
            "findings",
            "retrieval_ledger",
            "skills_hidden",
            "stages",
        )
