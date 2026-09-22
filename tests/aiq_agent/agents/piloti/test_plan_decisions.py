"""The decision model proposes the plan's genre and depth; the planner is told."""

import json
from unittest.mock import patch

import httpx
import pytest

from aiq_agent.agents.piloti.plan_decisions import decide_plan_shape
from aiq_agent.common import decisions


@pytest.fixture(autouse=True)
def _endpoint_available(monkeypatch):
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


def _answering(genre: str, genre_p: float, depth: str, depth_p: float):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert set(body["questions"]) == {"genre", "depth"}
        return httpx.Response(
            200,
            json={
                "id": "d",
                "model": "typesafe/jev-1.13",
                "answers": {
                    "genre": {"choice": genre, "probabilities": {genre: genre_p}, "confidence": genre_p},
                    "depth": {"choice": depth, "probabilities": {depth: depth_p}, "confidence": depth_p},
                },
                "usage": {"input_tokens": 1, "output_tokens": 1, "cost": 0},
            },
        )

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_a_confident_answer_becomes_the_preselection():
    shape = await decide_plan_shape(
        "Prüfen Sie den Brandschutz", "GK 4", transport=_answering("pruefbericht", 0.9, "kurzpruefung", 0.7)
    )
    assert shape.genre == "pruefbericht" and shape.depth == "kurzpruefung" and shape.decided


@pytest.mark.asyncio
async def test_a_doubtful_answer_proposes_nothing():
    shape = await decide_plan_shape("q", None, transport=_answering("bericht", 0.3, "gutachten", 0.4))
    assert shape.genre is None and shape.depth is None and not shape.decided


@pytest.mark.asyncio
async def test_an_endpoint_failure_never_blocks_the_plan():
    shape = await decide_plan_shape("q", None, transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    assert not shape.decided
