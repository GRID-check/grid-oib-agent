"""A vision call the provider rate-limits waits and retries instead of losing the caption."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from knowledge_layer.llamaindex import adapter


class RateLimited(Exception):
    status_code = 429

    def __init__(self, retry_after: str | None = None) -> None:
        super().__init__("Error code: 429 - rate_limit_exceeded")
        self.response = SimpleNamespace(headers={"retry-after": retry_after} if retry_after else {})


def _reply(text: str):
    return SimpleNamespace(choices=[SimpleNamespace(finish_reason="stop", message=SimpleNamespace(content=text))])


class Client:
    def __init__(self, failures: list[Exception]) -> None:
        self.failures = list(failures)
        self.calls = 0
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **_request):
        self.calls += 1
        if self.failures:
            raise self.failures.pop(0)
        return _reply("Grundriss EG")


@pytest.fixture
def slept(monkeypatch):
    waits: list[float] = []
    monkeypatch.setattr(adapter.time, "sleep", waits.append)
    monkeypatch.setattr(adapter.random, "random", lambda: 0.5)  # jitter factor 1.0
    return waits


def _caption(client) -> str:
    return adapter._vlm_chat_create(client, model="m", messages=[], max_tokens=100)


def test_a_rate_limited_call_backs_off_and_succeeds(slept):
    client = Client([RateLimited(), RateLimited()])

    assert _caption(client) == "Grundriss EG"
    assert client.calls == 3
    assert slept == [2.0, 4.0]


def test_the_providers_retry_after_is_honoured(slept):
    client = Client([RateLimited(retry_after="7")])

    assert _caption(client) == "Grundriss EG"
    assert slept == [7.0]


def test_the_retries_run_out(slept, monkeypatch):
    monkeypatch.setattr(adapter, "VLM_RATE_LIMIT_RETRIES", 2)
    client = Client([RateLimited()] * 5)

    with pytest.raises(RateLimited):
        _caption(client)
    assert client.calls == 3


def test_any_other_error_is_not_retried(slept):
    client = Client([ValueError("bad image")])

    with pytest.raises(ValueError):
        _caption(client)
    assert client.calls == 1
    assert slept == []


def test_every_attempt_holds_a_fleet_slot(slept, monkeypatch):
    held = []

    class Slot:
        def __enter__(self):
            held.append("in")

        def __exit__(self, *_):
            held.append("out")

    monkeypatch.setattr(adapter, "_vlm_slot", Slot)
    client = Client([RateLimited()])

    _caption(client)

    # Two attempts, each inside its own slot, the wait between them outside.
    assert held == ["in", "out", "in", "out"]
