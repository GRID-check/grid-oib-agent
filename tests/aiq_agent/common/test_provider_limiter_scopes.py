"""Which quota a 429 names: the transport and the OpenAI SDK, against real OpenRouter-shaped bodies.

OpenRouter answers 429 in two shapes. An upstream provider that ran out wraps its
refusal and names itself in ``error.metadata.provider_name``; OpenRouter's own
limit carries ``code: 429`` and no provider. The first is one model's quota, the
second the key's. The OpenAI SDK keeps the response's ``error`` object as
``RateLimitError.body``, which is what the chat seam classifies.
"""

from __future__ import annotations

import fakeredis
import httpx
import pytest
from openai import OpenAI
from openai import RateLimitError

from aiq_agent.common import provider_limiter as pl
from aiq_agent.common.openrouter import pinned_async_http_client
from aiq_agent.common.openrouter import pinned_http_client

UPSTREAM_429 = {
    "error": {
        "code": 429,
        "message": "Provider returned error",
        "metadata": {"provider_name": "Google", "raw": "quota"},
    }
}
OPENROUTER_429 = {"error": {"code": 429, "message": "Rate limit exceeded: limit_rpm", "metadata": {"headers": {}}}}


@pytest.fixture
def store(monkeypatch):
    client = fakeredis.FakeRedis(server=fakeredis.FakeServer(), decode_responses=True)
    monkeypatch.setattr(
        pl.cache, "eval_script", lambda script, keys, args: client.eval(script, len(keys), *keys, *args)
    )
    monkeypatch.setenv(pl._CEILING_ENV, "64")
    monkeypatch.setenv(pl._FLOOR_ENV, "1")
    monkeypatch.setattr(pl, "POLL_SECONDS", 0.01)
    return client


def model_limit(store, model: str) -> int | None:
    value = store.hget(pl._keys(pl.POOL, model)["model_state"], "limit")
    return int(value) if value is not None else None


def key_limit(store) -> int | None:
    value = store.hget(pl._keys(pl.POOL)["state"], "limit")
    return int(value) if value is not None else None


def answering(client, status_body):
    client._transport._inner = httpx.MockTransport(lambda request: httpx.Response(429, json=status_body))
    return client


def test_an_upstream_429_cuts_the_models_limit_and_not_the_keys(store):
    client = answering(pinned_http_client(), UPSTREAM_429)
    response = client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "vendor/a", "input": ["x"]})
    assert response.json() == UPSTREAM_429  # the body is still there for the SDK's own retry
    assert model_limit(store, "vendor/a") == 16
    assert model_limit(store, "vendor/b") is None
    assert key_limit(store) is None


def test_openrouters_own_429_cuts_the_keys_limit_and_no_models(store):
    client = answering(pinned_http_client(), OPENROUTER_429)
    client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "vendor/a", "input": ["x"]})
    assert key_limit(store) == 32
    assert model_limit(store, "vendor/a") is None


def test_a_429_with_a_body_that_is_not_json_counts_against_the_model(store):
    client = pinned_http_client()
    client._transport._inner = httpx.MockTransport(lambda request: httpx.Response(429, content=b"slow down"))
    client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "vendor/a"})
    assert model_limit(store, "vendor/a") == 16
    assert key_limit(store) is None


async def test_the_async_transport_classifies_a_429_by_its_body_too(store):
    client = answering(pinned_async_http_client(), OPENROUTER_429)
    await client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "vendor/a"})
    assert key_limit(store) == 32
    assert store.zcard(pl._keys(pl.POOL)["leases"]) == 0


async def test_the_async_transport_cuts_one_model_for_an_upstream_429(store):
    client = answering(pinned_async_http_client(), UPSTREAM_429)
    await client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "vendor/a"})
    assert model_limit(store, "vendor/a") == 16
    assert key_limit(store) is None


@pytest.mark.parametrize(
    ("body", "scope"),
    [(UPSTREAM_429, pl.MODEL_SCOPE), (OPENROUTER_429, pl.KEY_SCOPE)],
    ids=["upstream", "openrouter"],
)
def test_the_sdk_error_carries_the_object_the_classifier_reads(store, body, scope):
    client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key="k",  # pragma: allowlist secret
        max_retries=0,
        http_client=answering(pinned_http_client(), body),
    )
    with pytest.raises(RateLimitError) as raised:
        client.embeddings.create(model="vendor/a", input=["x"])
    assert pl.rate_limit_scope(raised.value) == scope
