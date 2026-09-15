"""The prompt store: what a turn is allowed to pay for a remotely managed prompt.

Every assertion here is about a failure mode that would otherwise be invisible
in production — a turn blocked on a dead Langfuse, a log line per turn, a
second OpenTelemetry tracer provider quietly attached to the process — rather
than about the happy path, which is one method call.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from aiq_agent.common.prompt_store import CACHE_TTL_ENV
from aiq_agent.common.prompt_store import ENABLED_ENV
from aiq_agent.common.prompt_store import PUBLIC_KEY_ENV
from aiq_agent.common.prompt_store import SECRET_KEY_ENV
from aiq_agent.common.prompt_store import PromptStore
from aiq_agent.common.prompt_store import ResolvedPrompt
from aiq_agent.common.prompt_store import build_langfuse_client
from aiq_agent.common.prompt_store import configured_cache_ttl_seconds
from aiq_agent.common.prompt_store import configured_label
from aiq_agent.common.prompt_store import git_blob_version
from aiq_agent.common.prompt_store import prompt_management_enabled
from aiq_agent.common.prompt_store import prompt_store
from aiq_agent.common.prompt_store import reset_prompt_store

FALLBACK = ResolvedPrompt(text="COMMITTED TEXT", name="git:prompts/x.md", version="abc1234", is_fallback=True)


class FakePrompt:
    """What the Langfuse SDK hands back for a text prompt."""

    def __init__(self, prompt: str, version: int = 7, is_fallback: bool = False):
        self.prompt = prompt
        self.version = version
        self.is_fallback = is_fallback


class FakeClient:
    """A Langfuse stand-in that records what it was asked and can be made to fail."""

    def __init__(self, *, answer: FakePrompt | None = None, raises: Exception | None = None):
        self.answer = answer
        self.raises = raises
        self.calls: list[dict] = []

    def get_prompt(self, name, *, label, cache_ttl_seconds, fallback, max_retries, fetch_timeout_seconds):
        self.calls.append(
            {
                "name": name,
                "label": label,
                "cache_ttl_seconds": cache_ttl_seconds,
                "fallback": fallback,
                "max_retries": max_retries,
                "fetch_timeout_seconds": fetch_timeout_seconds,
            }
        )
        if self.raises is not None:
            raise self.raises
        return self.answer


class FakeClock:
    """A clock a test moves by hand, so a TTL can be tested without sleeping."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _store(client: FakeClient | None, clock=None, **kwargs) -> PromptStore:
    return PromptStore(
        client_factory=lambda: client,
        clock=clock or FakeClock(),
        enabled=kwargs.pop("enabled", True),
        label=kwargs.pop("label", "production"),
        cache_ttl_seconds=kwargs.pop("cache_ttl_seconds", 60),
    )


class TestDisabled:
    def test_disabled_returns_the_fallback_and_never_reaches_the_client(self):
        """
        The default posture. A deployment that has not opted in renders exactly
        the bytes in its image, and proves it by never building a client — the
        factory raising is how the test would notice a call.
        """

        def exploding_factory():
            raise AssertionError("a disabled store must not build a client")

        store = PromptStore(client_factory=exploding_factory, enabled=False)

        assert store.get("piloti-system-static", fallback=FALLBACK) == FALLBACK

    def test_enabled_without_credentials_returns_the_fallback(self):
        """No keys is not an error, it is the un-provisioned state."""
        store = _store(None)

        assert store.get("piloti-system-static", fallback=FALLBACK) is FALLBACK

    def test_the_flag_is_off_unless_it_is_explicitly_truthy(self, monkeypatch):
        for value in ("", "false", "0", "no", "maybe"):
            monkeypatch.setenv(ENABLED_ENV, value)
            assert prompt_management_enabled() is False
        for value in ("1", "true", "TRUE", "yes", "on"):
            monkeypatch.setenv(ENABLED_ENV, value)
            assert prompt_management_enabled() is True


class TestFetching:
    def test_a_fetched_version_replaces_the_text_and_the_identity(self):
        client = FakeClient(answer=FakePrompt("LANGFUSE TEXT", version=12))
        store = _store(client)

        resolved = store.get("piloti-system-static", fallback=FALLBACK)

        assert resolved.text == "LANGFUSE TEXT"
        assert resolved.name == "piloti-system-static"
        assert resolved.version == "12"
        assert resolved.is_fallback is False

    def test_the_turn_budget_is_what_is_actually_sent_to_the_sdk(self):
        """
        Retries off and a two-second ceiling are the whole reason a turn can
        call this synchronously. A default `max_retries=2` with exponential
        backoff would put ten seconds of someone else's outage on a user's turn.
        """
        client = FakeClient(answer=FakePrompt("LANGFUSE TEXT"))
        _store(client, cache_ttl_seconds=90, label="staging").get("p", fallback=FALLBACK)

        call = client.calls[0]
        assert call["max_retries"] == 0
        assert call["fetch_timeout_seconds"] == 2
        assert call["cache_ttl_seconds"] == 90
        assert call["label"] == "staging"
        # The committed text goes down as the SDK's own fallback too, so even a
        # bug in the error handling below cannot render an empty prompt.
        assert call["fallback"] == FALLBACK.text

    def test_the_ttl_is_the_sdks_to_honour_and_a_repeat_call_is_not_re_fetched_by_us(self):
        """
        Stale-while-revalidate lives in the SDK's prompt cache: it serves the
        stale text immediately and refreshes on a background thread. This store
        adds no second cache in front of it, so a second call is a second
        `get_prompt` — and that is the point, since anything else would pin a
        version the SDK had already refreshed.
        """
        client = FakeClient(answer=FakePrompt("LANGFUSE TEXT", version=3))
        store = _store(client)

        first = store.get("p", fallback=FALLBACK)
        client.answer = FakePrompt("REVISED TEXT", version=4)
        second = store.get("p", fallback=FALLBACK)

        assert (first.version, second.version) == ("3", "4")
        assert second.text == "REVISED TEXT"


class TestFailure:
    def test_a_raising_client_serves_the_fallback(self, caplog):
        client = FakeClient(raises=RuntimeError("connection refused"))
        store = _store(client)

        with caplog.at_level(logging.WARNING):
            assert store.get("p", fallback=FALLBACK) is FALLBACK

        assert any("unavailable" in record.message for record in caplog.records)

    def test_an_sdk_served_fallback_is_read_as_a_failure_not_as_a_version(self):
        """
        Handing the SDK a fallback means an unreachable API comes back as a
        `TextPromptClient` with `is_fallback=True` and `version=0` rather than
        as an exception. Taking that at face value would stamp every trace in a
        Langfuse outage with "version 0" of a prompt that has no such version.
        """
        client = FakeClient(answer=FakePrompt(FALLBACK.text, version=0, is_fallback=True))
        store = _store(client)

        assert store.get("p", fallback=FALLBACK) is FALLBACK

    def test_an_empty_prompt_is_refused_rather_than_rendered(self):
        """A blank managed prompt is a lobotomy, and it would deploy silently."""
        client = FakeClient(answer=FakePrompt("   \n  "))

        assert _store(client).get("p", fallback=FALLBACK) is FALLBACK

    def test_a_failure_mutes_the_name_so_a_turn_pays_at_most_one_attempt_per_window(self):
        """
        The SDK does not cache a FAILED fetch, so without this every turn of an
        outage would open a connection and log. The mute is what turns "Langfuse
        is down" from a per-turn cost into a per-minute one.
        """
        clock = FakeClock()
        client = FakeClient(raises=RuntimeError("down"))
        store = _store(client, clock=clock, cache_ttl_seconds=60)

        for _ in range(5):
            assert store.get("p", fallback=FALLBACK) is FALLBACK
        assert len(client.calls) == 1

        clock.advance(61)
        assert store.get("p", fallback=FALLBACK) is FALLBACK
        assert len(client.calls) == 2

    def test_the_failure_is_logged_once_per_class_not_once_per_turn(self, caplog):
        clock = FakeClock()
        client = FakeClient(raises=RuntimeError("down"))
        store = _store(client, clock=clock, cache_ttl_seconds=60)

        with caplog.at_level(logging.WARNING):
            for _ in range(4):
                store.get("p", fallback=FALLBACK)
                clock.advance(61)

        assert sum("unavailable" in record.message for record in caplog.records) == 1

    def test_recovery_after_the_window_serves_the_live_text_again(self):
        clock = FakeClock()
        client = FakeClient(raises=RuntimeError("down"))
        store = _store(client, clock=clock, cache_ttl_seconds=60)

        assert store.get("p", fallback=FALLBACK) is FALLBACK

        client.raises = None
        client.answer = FakePrompt("BACK UP", version=9)
        clock.advance(61)

        assert store.get("p", fallback=FALLBACK).text == "BACK UP"

    def test_a_client_that_cannot_be_built_is_not_rebuilt_every_turn(self, caplog):
        calls = {"n": 0}

        def factory():
            calls["n"] += 1
            raise ImportError("langfuse is not installed")

        store = PromptStore(client_factory=factory, enabled=True)

        with caplog.at_level(logging.WARNING):
            for _ in range(3):
                assert store.get("p", fallback=FALLBACK) is FALLBACK

        assert calls["n"] == 1


class TestEnvironmentReading:
    def test_the_label_defaults_to_production(self, monkeypatch):
        monkeypatch.delenv("LANGFUSE_PROMPT_LABEL", raising=False)
        assert configured_label() == "production"

        monkeypatch.setenv("LANGFUSE_PROMPT_LABEL", "experiment-a")
        assert configured_label() == "experiment-a"

    def test_an_unparseable_ttl_falls_back_rather_than_crashing_boot(self, monkeypatch):
        monkeypatch.setenv(CACHE_TTL_ENV, "a minute or so")
        assert configured_cache_ttl_seconds() == 60

        monkeypatch.setenv(CACHE_TTL_ENV, "300")
        assert configured_cache_ttl_seconds() == 300

    def test_the_process_store_is_one_object_and_resettable(self, monkeypatch):
        monkeypatch.delenv(ENABLED_ENV, raising=False)
        reset_prompt_store()
        try:
            assert prompt_store() is prompt_store()
            first = prompt_store()
            reset_prompt_store()
            assert prompt_store() is not first
        finally:
            reset_prompt_store()


class TestGitBlobVersion:
    def test_it_is_the_hash_git_itself_would_print(self, tmp_path: Path):
        """
        Pinned against git's documented object format (`blob <len>\\0<bytes>`)
        with a value taken from git's own test corpus: an empty blob hashes to
        e69de29. A version an operator cannot look up with `git cat-file` is
        not a version, it is a number.
        """
        empty = tmp_path / "empty.md"
        empty.write_bytes(b"")

        assert git_blob_version(empty) == "e69de29"

    def test_it_changes_with_the_content(self, tmp_path: Path):
        path = tmp_path / "prompt.md"
        path.write_text("one")
        before = git_blob_version(path)
        path.write_text("two")

        assert git_blob_version(path) != before


def _span_processor_count(provider) -> int:
    """How many span processors a tracer provider carries, or -1 if it has none.

    Reaches into the OTel SDK's private multi-processor because there is no
    public accessor and the whole point is to observe a processor somebody else
    attached. A ProxyTracerProvider has no such attribute and reports -1.
    """
    multi = getattr(provider, "_active_span_processor", None)
    return len(getattr(multi, "_span_processors", ())) if multi is not None else -1


class TestSdkDoesNotHijackTracing:
    def test_the_client_registers_no_global_tracer_provider(self, monkeypatch):
        """
        The decision this whole module rests on. The Langfuse SDK installs a
        TracerProvider AND hangs its own BatchSpanProcessor on whatever provider
        it finds, unless `tracing_enabled=False`; this process already exports
        spans to Langfuse through NAT and the OTel collector, so either would
        mean a second export path for every span in the fleet.

        Asserted rather than trusted because it is an internal of the SDK
        (`LangfuseResourceManager.__init__`) that a minor release could move.
        """
        from opentelemetry import trace as otel_trace

        monkeypatch.setenv(PUBLIC_KEY_ENV, "pk-lf-test")
        monkeypatch.setenv(SECRET_KEY_ENV, "sk-lf-test")
        monkeypatch.setenv("LANGFUSE_HOST", "http://langfuse.invalid:3000")

        before = otel_trace.get_tracer_provider()
        processors_before = _span_processor_count(before)
        client = build_langfuse_client()

        assert client is not None
        # The global provider is the same OBJECT, and it did not grow a span
        # processor. Whether it is still the untouched ProxyTracerProvider
        # depends on what else in the suite has booted telemetry, so the
        # invariant is stated as "unchanged", not as a type.
        assert otel_trace.get_tracer_provider() is before
        assert _span_processor_count(otel_trace.get_tracer_provider()) == processors_before

    def test_no_credentials_means_no_client_at_all(self, monkeypatch):
        monkeypatch.delenv(PUBLIC_KEY_ENV, raising=False)
        monkeypatch.delenv(SECRET_KEY_ENV, raising=False)

        assert build_langfuse_client() is None


@pytest.fixture(autouse=True)
def _clean_process_store():
    """No test may leave a store behind for the next one to inherit."""
    reset_prompt_store()
    yield
    reset_prompt_store()
