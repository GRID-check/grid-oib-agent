"""Tests for the OpenRouter cross-encoder reranker (``knowledge_layer.cross_encoder``).

All offline: ``httpx.MockTransport`` stands in for the provider, so the request
body contract and the documented example payload shape are pinned without
network. The breaker/throttle state is module-global and reset per test.
"""

from __future__ import annotations

import functools
import json
import logging
from types import SimpleNamespace

import httpx
import pytest

from sources.knowledge_layer.src import cross_encoder as ce
from sources.knowledge_layer.src.cross_encoder import CrossEncoderReranker
from sources.knowledge_layer.src.cross_encoder import resolve_cross_encoder


@pytest.fixture(autouse=True)
def _isolated_breaker_state():
    ce._reset_breaker_state()
    yield
    ce._reset_breaker_state()


@pytest.fixture()
def _no_keys(monkeypatch):
    monkeypatch.delenv("AIQ_RERANKER_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)


def _chunk(chunk_id: str, content: str = "text") -> SimpleNamespace:
    return SimpleNamespace(chunk_id=chunk_id, content=content)


def _reranker(**kwargs) -> CrossEncoderReranker:
    kwargs.setdefault("model", "cohere/rerank-v3.5")
    kwargs.setdefault("api_key", "test-key")
    return CrossEncoderReranker("openrouter", **kwargs)


def _serve(monkeypatch, handler) -> list[httpx.Request]:
    """Route the reranker's internal AsyncClient through a MockTransport."""
    seen: list[httpx.Request] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    transport = httpx.MockTransport(_handler)
    monkeypatch.setattr(httpx, "AsyncClient", functools.partial(httpx.AsyncClient, transport=transport))
    return seen


def _ok(payload: dict) -> httpx.Response:
    return httpx.Response(200, json=payload)


def test_request_body_pins_model_query_documents_and_top_n() -> None:
    reranker = _reranker()
    assert reranker._build_body("q", ["a", "b", "c"], top_n=10) == {
        "model": "cohere/rerank-v3.5",
        "query": "q",
        "documents": ["a", "b", "c"],
        "top_n": 3,
    }
    assert "top_n" not in reranker._build_body("q", ["a", "b"], top_n=None)


async def test_ranking_parse_drops_dup_out_of_range_and_string_scores(monkeypatch) -> None:
    seen = _serve(
        monkeypatch,
        lambda request: _ok(
            {
                "results": [
                    {"index": 2, "relevance_score": 0.9},
                    {"index": 0, "relevance_score": 0.1},
                    {"index": 2, "relevance_score": 0.95},  # duplicate: dropped
                    {"index": 7, "relevance_score": 0.99},  # out of range: dropped
                    {"index": 1, "relevance_score": "high"},  # non-numeric: demoted to 0.0
                ]
            }
        ),
    )
    chunks = [_chunk("a"), _chunk("b"), _chunk("c")]
    ranked = await _reranker().rerank("query", chunks, top_n=10)
    assert ranked is not None
    assert [c.chunk_id for c in ranked] == ["c", "a", "b"]
    body = json.loads(seen[0].content.decode())
    assert body == {
        "model": "cohere/rerank-v3.5",
        "query": "query",
        "documents": ["text", "text", "text"],
        "top_n": 3,
    }


async def test_timeout_returns_none(monkeypatch) -> None:
    def _raise(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("provider hung")

    _serve(monkeypatch, _raise)
    assert await _reranker().rerank("query", [_chunk("a")]) is None


async def test_no_key_returns_none(_no_keys) -> None:
    assert resolve_cross_encoder("openrouter") is None


async def test_unknown_removed_provider_fails_loud_then_falls_back(caplog) -> None:
    with caplog.at_level(logging.DEBUG):
        for name in ("cohere", "voyage", "jina", "nvidia"):
            assert resolve_cross_encoder(name) is None
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(errors) == 4
    assert all("was removed" in r.getMessage() and "reranker_provider: openrouter" in r.getMessage() for r in errors)


async def test_generic_unknown_provider_stays_a_warning(caplog) -> None:
    with caplog.at_level(logging.DEBUG):
        assert resolve_cross_encoder("definitely-not-a-provider") is None
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert [r for r in caplog.records if r.levelno == logging.WARNING]


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1"),
        ("https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v1"),
        ("https://example.test/rerank", "https://example.test"),
        ("https://example.test/rerank/", "https://example.test"),
        ("https://example.test/api/v1/rerank", "https://example.test/api/v1"),
    ],
)
def test_base_url_trailing_rerank_is_stripped(given, expected) -> None:
    assert _reranker(base_url=given).base_url == expected


@pytest.mark.parametrize("uptime", [1.0, 10_000.0], ids=["fresh-boot", "long-running"])
async def test_first_failure_warns_then_debugs_within_cooldown(monkeypatch, caplog, uptime) -> None:
    """The first failure warns whatever the host's uptime is.

    ``time.monotonic()`` is time since boot on Linux, so a freshly started
    container reads well under the cooldown. While "never warned" was the float
    ``0.0``, ``now - 0.0`` was already inside the window there and the first
    failure logged at debug -- the one warning the throttle exists to guarantee,
    swallowed on exactly the hosts that had just started failing. The parameters
    pin both clocks so uptime can never decide this again.
    """

    def _raise(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    monkeypatch.setattr(ce.time, "monotonic", lambda: uptime)
    _serve(monkeypatch, _raise)
    reranker = _reranker()
    with caplog.at_level(logging.DEBUG, logger=ce.__name__):
        assert await reranker.rerank("query", [_chunk("a")]) is None
        assert await reranker.rerank("query", [_chunk("a")]) is None
    failures = [r for r in caplog.records if "keeping retrieval order" in r.getMessage()]
    assert [r.levelno for r in failures] == [logging.WARNING, logging.DEBUG]


async def test_breaker_trips_after_consecutive_failures_and_recovers(monkeypatch, caplog) -> None:
    calls: list[httpx.Request] = []

    def _fail(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        raise httpx.ConnectError("down")

    def _succeed(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return _ok({"results": [{"index": 1, "relevance_score": 0.9}, {"index": 0, "relevance_score": 0.1}]})

    now = [1000.0]
    monkeypatch.setattr(ce.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(ce, "_BREAKER_THRESHOLD", 3)
    monkeypatch.setattr(ce, "_BREAKER_COOLDOWN_SECONDS", 300.0)

    transport = httpx.MockTransport(_fail)
    monkeypatch.setattr(httpx, "AsyncClient", functools.partial(httpx.AsyncClient, transport=transport))
    reranker = _reranker()
    chunks = [_chunk("a"), _chunk("b")]

    with caplog.at_level(logging.DEBUG, logger=ce.__name__):
        for _ in range(3):
            assert await reranker.rerank("query", chunks) is None
    assert [r for r in caplog.records if "disabling it for" in r.getMessage()]

    # Tripped: a healthy provider is not even called.
    monkeypatch.setattr(
        httpx, "AsyncClient", functools.partial(httpx.AsyncClient, transport=httpx.MockTransport(_succeed))
    )
    before = len(calls)
    assert await reranker.rerank("query", chunks) is None
    assert len(calls) == before

    # After the cooldown the provider is retried and success resets the count.
    now[0] += 301.0
    ranked = await reranker.rerank("query", chunks)
    assert ranked is not None
    assert [c.chunk_id for c in ranked] == ["b", "a"]
    assert len(calls) == before + 1


async def test_unusable_ranking_counts_toward_the_breaker(monkeypatch) -> None:
    _serve(monkeypatch, lambda request: _ok({"results": []}))
    monkeypatch.setattr(ce, "_BREAKER_THRESHOLD", 2)
    reranker = _reranker()
    chunks = [_chunk("a")]
    assert await reranker.rerank("query", chunks) is None
    assert await reranker.rerank("query", chunks) is None
    assert ce._breaker_open()


# --- Who pays for the rerank, and with whose key (ledger row 25) -------------


class _Tracker:
    """The cost tracker's one method this call site uses."""

    def __init__(self) -> None:
        self.events: list = []

    def record(self, event) -> None:
        self.events.append(event)


@pytest.fixture()
def tracker(monkeypatch):
    """Install a tracker in the ambient ContextVar, as a turn does."""
    from aiq_agent.common import cost_tracking

    sink = _Tracker()
    token = cost_tracking.grid_cost_tracker_var.set(sink)
    try:
        yield sink
    finally:
        cost_tracking.grid_cost_tracker_var.reset(token)


def _ranked(_request: httpx.Request) -> httpx.Response:
    return _ok({"results": [{"index": 0, "relevance_score": 0.9}, {"index": 1, "relevance_score": 0.4}]})


async def test_a_rerank_lands_on_the_ledger_with_its_role_and_tokens(monkeypatch, tracker) -> None:
    """It was a frontier-model call per search, charged to nobody."""
    _serve(monkeypatch, _ranked)

    await _reranker().rerank("Fluchtweg", [_chunk("a", "x" * 400), _chunk("b", "y" * 400)])

    assert len(tracker.events) == 1
    event = tracker.events[0]
    assert event.role == "rerank"
    assert event.model == "cohere/rerank-v3.5"
    assert event.prompt_tokens > 100, "the documents that were sent are what it cost"
    assert event.cost_source == "estimate", "the endpoint reports no cost; the row must not invent one"
    assert event.cost_usd == 0.0


async def test_a_provider_that_reports_usage_is_believed_over_the_estimate(monkeypatch, tracker) -> None:
    _serve(
        monkeypatch,
        lambda request: _ok({"results": [{"index": 0, "relevance_score": 0.9}], "usage": {"prompt_tokens": 4242}}),
    )

    await _reranker().rerank("Fluchtweg", [_chunk("a", "x" * 400)])

    event = tracker.events[0]
    assert (event.prompt_tokens, event.cost_source) == (4242, "usage_field")


async def test_a_failed_rerank_is_charged_to_nobody(monkeypatch, tracker) -> None:
    """No ranking, no row: the turn kept the order it already had."""
    _serve(monkeypatch, lambda request: httpx.Response(500))

    await _reranker().rerank("Fluchtweg", [_chunk("a")])

    assert tracker.events == []


async def test_a_search_outside_a_turn_is_not_recorded_and_still_ranks(monkeypatch) -> None:
    """An ingest thread or a CLI run has no tracker; the rerank still happens."""
    _serve(monkeypatch, _ranked)

    ranked = await _reranker().rerank("Fluchtweg", [_chunk("a"), _chunk("b")])

    assert [chunk.chunk_id for chunk in ranked] == ["a", "b"]


async def test_an_org_with_its_own_key_reranks_on_it(monkeypatch, tracker) -> None:
    """BYOK, per search. The handle is built at startup where no org exists, so
    resolving the key at construction is what made every org's rerank the
    platform's bill."""
    from aiq_agent.common import credential_resolution

    seen = _serve(monkeypatch, _ranked)
    monkeypatch.setattr(ce, "_organization_id_in_scope", lambda: "org_byok")

    def _resolve(*, organization_id=None, default_base_url="", **_kw):
        assert organization_id == "org_byok", "the search must ask for the turn's org"
        return credential_resolution.ResolvedCredential(
            api_key="org-own-key",  # pragma: allowlist secret
            base_url="https://byok.example/api/v1",
            model="m",
            source="byok",
        )

    monkeypatch.setattr(credential_resolution, "resolve_llm_credential", _resolve)

    await _reranker(api_key="platform-key").rerank("Fluchtweg", [_chunk("a")])  # pragma: allowlist secret

    assert seen[0].headers["Authorization"] == "Bearer org-own-key"
    assert str(seen[0].url) == "https://byok.example/api/v1/rerank"
    assert tracker.events[0].is_byok is True


async def test_without_an_org_the_platform_key_is_used(monkeypatch, tracker) -> None:
    seen = _serve(monkeypatch, _ranked)
    monkeypatch.setattr(ce, "_organization_id_in_scope", lambda: None)

    await _reranker(api_key="platform-key").rerank("Fluchtweg", [_chunk("a")])  # pragma: allowlist secret

    assert seen[0].headers["Authorization"] == "Bearer platform-key"
    assert tracker.events[0].is_byok is False


async def test_an_org_with_no_key_of_its_own_still_reranks(monkeypatch, tracker) -> None:
    """A BYOK lookup that resolves nothing must not take reranking down."""
    from aiq_agent.common import credential_resolution

    seen = _serve(monkeypatch, _ranked)
    monkeypatch.setattr(ce, "_organization_id_in_scope", lambda: "org_plain")
    monkeypatch.setattr(
        credential_resolution,
        "resolve_llm_credential",
        lambda **_kw: credential_resolution.ResolvedCredential(api_key="", base_url="", model="m", source="none"),
    )

    await _reranker(api_key="platform-key").rerank("Fluchtweg", [_chunk("a")])  # pragma: allowlist secret

    assert seen[0].headers["Authorization"] == "Bearer platform-key"
