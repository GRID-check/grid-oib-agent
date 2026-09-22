"""The decision client: typed answers, fail-open everywhere, one record per call.

Through an ``httpx.MockTransport``, so what is pinned is the wire contract
(OpenRouter's alpha Decisions endpoint) and the two rules every caller
relies on: ``None`` on any failure, and a record that says why.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import httpx
import pytest

from aiq_agent.common import decisions
from aiq_agent.common.decisions import Decision
from aiq_agent.common.decisions import choice
from aiq_agent.common.decisions import decide
from aiq_agent.common.decisions import decide_many
from aiq_agent.common.decisions import noul
from aiq_agent.common.decisions import score

ANSWERS = {
    "needs_evidence": {"type": "noul", "noul": 0.93},
    "corpus": {
        "type": "choice",
        "choice": "baurecht",
        "confidence": 0.8,
        "probabilities": {"baurecht": 0.8, "projekt": 0.2},
    },
    "urgency": {"type": "score", "score": 1.4, "probabilities": {"0": 0.1, "1": 0.4, "2": 0.5}, "legend": {}},
}
QUESTIONS = {
    "needs_evidence": noul("Does it need evidence?", true="yes", false="no"),
    "corpus": choice("Which corpus?", {"baurecht": "law", "projekt": "project files"}),
    "urgency": score("How urgent?", ["low", "mid", "high"]),
}


#: The real resolver, captured before the fixture below replaces it.
_RESOLVE_ENDPOINT = decisions._resolve_endpoint_blocking
_ENDPOINT = decisions._Endpoint(url="https://openrouter.ai/api/alpha/decisions", api_key="k", model="typesafe/jev-1.13")


def _transport(handler):
    return httpx.MockTransport(handler)


def _ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "gen-dec-1",
            "model": "typesafe/jev-1.13-20260917",
            "answers": ANSWERS,
            "usage": {"input_tokens": 476, "output_tokens": 70, "cost": 0.00002},
        },
    )


@pytest.fixture(autouse=True)
def _endpoint_available(monkeypatch):
    """A key resolves, no ZDR, breaker closed, decisions enabled."""
    decisions.reset_breaker()
    monkeypatch.delenv(decisions.ENABLED_ENV, raising=False)
    monkeypatch.delenv(decisions.URL_ENV, raising=False)
    with (
        patch.object(decisions, "_zdr_only_blocking", return_value=False),
        patch.object(
            decisions,
            "_resolve_endpoint_blocking",
            return_value=(
                decisions._Endpoint(
                    url="https://openrouter.ai/api/alpha/decisions", api_key="k", model="typesafe/jev-1.13"
                ),
                None,
            ),
        ),
    ):
        yield
    decisions.reset_breaker()


@pytest.fixture
def records():
    with patch.object(decisions, "_record") as record:
        yield record


class TestTheWire:
    async def test_the_request_is_the_documented_body_and_the_answers_are_typed(self, records):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return _ok(request)

        decision = await decide({"message": "Wie hoch?"}, QUESTIONS, slot="turn", transport=_transport(handler))

        assert decision is not None
        body = json.loads(seen[0].content)
        assert body["model"] == "typesafe/jev-1.13"
        assert body["state"] == {"message": "Wie hoch?"}
        assert body["questions"]["needs_evidence"] == {
            "type": "noul",
            "instructions": "Does it need evidence?",
            "criteria": {"true": "yes", "false": "no"},
        }
        assert seen[0].headers["authorization"] == "Bearer k"
        assert decision.noul("needs_evidence") == 0.93
        assert decision.choice("corpus") == ("baurecht", {"baurecht": 0.8, "projekt": 0.2})
        assert decision.score("urgency") == 1.4
        assert decision.input_tokens == 476 and decision.cost_usd == 0.00002
        slot, values = records.call_args.args
        assert slot == "turn" and values["answers"]["needs_evidence"] == 0.93
        assert values["answers"]["corpus"] == {"choice": "baurecht", "p": 0.8}

    async def test_an_unanswered_question_is_none_not_a_guess(self):
        decision = await decide("s", QUESTIONS, slot="t", transport=_transport(_ok))
        assert decision is not None
        assert decision.noul("missing") is None
        assert decision.choice("missing") == (None, {})

    def test_a_probability_is_clamped_and_a_bool_is_refused(self):
        decision = Decision(answers={"a": {"type": "noul", "noul": 1.7}, "b": {"type": "noul", "noul": True}})
        assert decision.noul("a") == 1.0 and decision.noul("b") is None

    def test_the_question_builders_refuse_what_the_endpoint_would(self):
        with pytest.raises(ValueError):
            choice("x", {})
        with pytest.raises(ValueError):
            score("x", ["only one"])


class TestFailOpen:
    async def test_a_5xx_is_none_and_recorded(self, records):
        decision = await decide("s", QUESTIONS, slot="t", transport=_transport(lambda r: httpx.Response(503)))
        assert decision is None
        assert records.call_args.args[1] == {"skipped": "error", "detail": "http_503"}

    async def test_a_timeout_is_none(self, records):
        def handler(request):
            raise httpx.ReadTimeout("slow", request=request)

        assert await decide("s", QUESTIONS, slot="t", transport=_transport(handler)) is None
        assert records.call_args.args[1]["skipped"] == "timeout"

    async def test_garbage_is_none(self, records):
        assert (
            await decide("s", QUESTIONS, slot="t", transport=_transport(lambda r: httpx.Response(200, json={"x": 1})))
            is None
        )
        assert records.call_args.args[1]["skipped"] == "error"

    async def test_disabled_skips_without_a_request(self, records, monkeypatch):
        monkeypatch.setenv(decisions.ENABLED_ENV, "false")
        called = []
        assert await decide("s", QUESTIONS, slot="t", transport=_transport(lambda r: called.append(r))) is None
        assert not called
        assert records.call_args.args[1] == {"skipped": "disabled"}

    async def test_zdr_skips(self, records):
        with patch.object(decisions, "_zdr_only_blocking", return_value=True):
            assert await decide("s", QUESTIONS, slot="t", transport=_transport(_ok)) is None
        assert records.call_args.args[1] == {"skipped": "zdr"}

    async def test_a_byok_key_on_another_host_skips(self):
        with patch("aiq_agent.common.credential_resolution.resolve_llm_credential") as resolve:
            resolve.return_value.api_key = "k"
            resolve.return_value.base_url = "https://api.openai.com/v1"
            resolve.return_value.source = "byok"
            endpoint, skipped = _RESOLVE_ENDPOINT("org-1")
        assert endpoint is None and skipped == "byok_host"

    async def test_the_breaker_opens_after_repeated_server_failures(self, records):
        transport = _transport(lambda r: httpx.Response(503))
        for _ in range(decisions._BREAKER_THRESHOLD):
            await decide("s", QUESTIONS, slot="t", transport=transport)
        called = []
        assert await decide("s", QUESTIONS, slot="t", transport=_transport(lambda r: called.append(r))) is None
        assert not called
        assert records.call_args.args[1] == {"skipped": "breaker"}

    async def test_a_4xx_is_ours_and_never_opens_the_breaker(self):
        transport = _transport(lambda r: httpx.Response(422))
        for _ in range(decisions._BREAKER_THRESHOLD + 1):
            await decide("s", QUESTIONS, slot="t", transport=transport)
        assert not decisions._breaker_open()


class TestManyStates:
    async def test_each_state_gets_its_own_decision_in_order(self, records):
        def handler(request: httpx.Request) -> httpx.Response:
            state = json.loads(request.content)["state"]
            if state["passage"] == "bad":
                return httpx.Response(500)
            return httpx.Response(
                200, json={"answers": {"hit": {"type": "noul", "noul": 0.1 * len(state["passage"])}}, "usage": {}}
            )

        decided = await decide_many(
            [{"passage": "aaa"}, {"passage": "bad"}, {"passage": "a"}],
            {"hit": noul("hit?", true="y", false="n")},
            slot="rerank",
            transport=_transport(handler),
        )
        assert [d.noul("hit") if d else None for d in decided] == [pytest.approx(0.3), None, pytest.approx(0.1)]
        values = records.call_args.args[1]
        assert values["count"] == 3 and values["decided"] == 2 and values["skipped"] == "error"

    async def test_nothing_to_decide_is_all_none_without_a_request(self):
        assert await decide_many([], QUESTIONS, slot="x") == []


class TestTheCostIsOnTheLedger:
    async def test_a_decision_records_a_usage_event(self):
        with patch("aiq_agent.common.cost_tracking.record_usage_event") as record:
            await decide("s", QUESTIONS, slot="t", transport=_transport(_ok))
        record.assert_called_once()
        kwargs = record.call_args.kwargs
        assert kwargs["role"] == "decision" and kwargs["prompt_tokens"] == 476 and kwargs["cost_source"] == "provider"
