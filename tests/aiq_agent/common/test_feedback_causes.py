"""ADR-0064 use 9: each sampled down-vote filed under one cause, or none."""

from types import SimpleNamespace
from unittest.mock import patch

from aiq_agent.common import feedback_causes
from aiq_agent.common.decisions import Decision


def _sample(question="Wie hoch?", reason="inaccurate", comment=None):
    return SimpleNamespace(question=question, reason=reason, comment=comment)


def _deciding(answers):
    seen = {}

    async def fake(states, questions, **kwargs):
        seen.update(states=states, questions=questions)
        return [
            None
            if a is None
            else Decision(answers={"cause": {"type": "choice", "choice": a[0], "probabilities": {a[0]: a[1]}}})
            for a in answers
        ]

    return fake, seen


async def test_each_vote_is_asked_with_its_comment_reason_and_question():
    fake, seen = _deciding([("wrong_value", 1.0), ("slow", 0.89)])
    with patch("aiq_agent.common.decisions.decide_many", fake):
        labels = await feedback_causes.label_causes([_sample(comment="R 60, nicht R 90"), _sample(reason="too_slow")])
    assert labels == ["wrong_value", "slow"]
    assert seen["states"][0] == {"question": "Wie hoch?", "reason": "inaccurate", "comment": "R 60, nicht R 90"}
    assert "comment" not in seen["states"][1]
    assert list(seen["questions"]["cause"]["criteria"]) == list(feedback_causes.CAUSES)


async def test_an_unsure_unknown_or_missing_label_is_not_guessed():
    fake, _ = _deciding([("form", 0.4), ("erfunden", 1.0), None])
    with patch("aiq_agent.common.decisions.decide_many", fake):
        assert await feedback_causes.label_causes([_sample()] * 3) == [None, None, None]


def test_counts_leave_unlabelled_votes_out_most_frequent_first():
    assert feedback_causes.count_causes(["form", None, "wrong_rule", "wrong_rule"]) == {"wrong_rule": 2, "form": 1}
