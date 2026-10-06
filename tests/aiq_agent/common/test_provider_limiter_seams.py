"""The two seams every model call passes take a provider slot (ADR-0080).

``test_provider_limiter`` proves the limiter; this proves it is wired in: a chat
call holds a slot for exactly as long as the call or its stream lasts, in the
class of the task that made it, and an OpenRouter HTTP request waits for one,
records a 429 and gives the slot back with the response.
"""

from __future__ import annotations

import asyncio
import inspect
from types import SimpleNamespace

import fakeredis
import httpx
import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from pydantic import Field

from aiq_agent.common import provider_limiter as pl
from aiq_agent.common.llm_factory import enforce_chat_request_contract
from aiq_agent.common.openrouter import pinned_async_http_client
from aiq_agent.common.openrouter import pinned_http_client
from tests.conftest import StrictProviderChatModel


@pytest.fixture
def store(monkeypatch):
    client = fakeredis.FakeRedis(server=fakeredis.FakeServer(), decode_responses=True)
    monkeypatch.setattr(
        pl.cache, "eval_script", lambda script, keys, args: client.eval(script, len(keys), *keys, *args)
    )
    monkeypatch.setenv(pl._CEILING_ENV, "1")
    monkeypatch.setenv(pl._FLOOR_ENV, "1")
    monkeypatch.setattr(pl, "POLL_SECONDS", 0.01)
    return client


def held(store) -> int:
    return store.zcard(pl._keys(pl.POOL)["leases"])


def model_limit(store, model: str) -> int | None:
    value = store.hget(pl._keys(pl.POOL, model)["model_state"], "limit")
    return int(value) if value is not None else None


def key_limit(store) -> int | None:
    value = store.hget(pl._keys(pl.POOL)["state"], "limit")
    return int(value) if value is not None else None


def waiting(store, cls: str) -> int:
    return store.zcard(pl._keys(pl.POOL)["tickets"][pl.CLASSES.index(cls)])


# ------------------------------------------------------------- the chat seam


class OpenRouterChatModel(StrictProviderChatModel):
    """A chat model on the OpenRouter key that records what the pool held while it ran."""

    openai_api_base: str = "https://openrouter.ai/api/v1"
    model_name: str = "vendor/model"
    held_while_running: list[int] = Field(default_factory=list)
    fail_with: Exception | None = None
    store: object | None = None

    def _note(self) -> None:
        self.held_while_running.append(held(self.store))
        if self.fail_with is not None:
            raise self.fail_with

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self._note()
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        self._note()
        return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self._note()
        async for chunk in super()._astream(messages, stop=stop, run_manager=run_manager, **kwargs):
            self.held_while_running.append(held(self.store))
            yield chunk


def chat_model(store, **kwargs) -> OpenRouterChatModel:
    return enforce_chat_request_contract(OpenRouterChatModel(store=store, **kwargs))


MESSAGES = [HumanMessage(content="Hallo")]


def test_a_chat_call_holds_a_slot_while_it_runs_and_gives_it_back(store):
    llm = chat_model(store)
    assert held(store) == 0
    llm.invoke(MESSAGES)
    assert llm.held_while_running == [1]
    assert held(store) == 0


async def test_an_async_chat_call_holds_a_slot_while_it_runs(store):
    llm = chat_model(store)
    await llm.ainvoke(MESSAGES)
    assert llm.held_while_running == [1]
    assert held(store) == 0


async def test_a_stream_keeps_its_slot_until_the_last_chunk(store):
    llm = chat_model(store)
    chunks = [chunk async for chunk in llm.astream(MESSAGES)]
    assert chunks
    assert llm.held_while_running == [1, 1]
    assert held(store) == 0


async def test_a_stream_the_consumer_abandons_gives_its_slot_back(store):
    llm = chat_model(store)
    stream = llm.astream(MESSAGES)
    await anext(stream)
    assert held(store) == 1
    await stream.aclose()
    # LangChain does not close the model's own generator; the loop finalises it.
    for _ in range(20):
        await asyncio.sleep(0.01)
        if held(store) == 0:
            break
    assert held(store) == 0


async def test_a_chat_call_waits_while_the_pool_is_full_and_goes_before_bulk(store):
    holder = await pl.aacquire(cls=pl.BULK)
    llm = chat_model(store)
    with pl.provider_class(pl.BULK):
        bulk = asyncio.create_task(llm.ainvoke(MESSAGES))
    await asyncio.sleep(0.1)
    with pl.provider_class(pl.CHAT):
        chat = asyncio.create_task(llm.ainvoke(MESSAGES))
    await asyncio.sleep(0.1)
    assert (waiting(store, pl.BULK), waiting(store, pl.CHAT)) == (1, 1)

    done_order: list[str] = []
    bulk.add_done_callback(lambda _: done_order.append("bulk"))
    chat.add_done_callback(lambda _: done_order.append("chat"))
    await holder.arelease()
    await asyncio.wait_for(asyncio.gather(bulk, chat), 5)
    assert done_order == ["chat", "bulk"]


async def test_a_429_gives_the_slot_back_and_halves_the_limit(store, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "16")

    class RateLimited(Exception):
        status_code = 429
        response = SimpleNamespace(headers={"retry-after": "0"}, status_code=429)

    llm = chat_model(store, fail_with=RateLimited("slow down"))
    with pytest.raises(RateLimited):
        await llm.ainvoke(MESSAGES)
    assert held(store) == 0
    assert model_limit(store, "vendor/model") == 16


def test_a_model_off_the_openrouter_key_is_not_limited(store):
    llm = enforce_chat_request_contract(OpenRouterChatModel(store=store, openai_api_base="https://llm.example.test/v1"))
    llm.invoke(MESSAGES)
    assert llm.held_while_running == [0]


def test_the_reply_of_a_limited_call_is_unchanged(store):
    llm = chat_model(store, responses=[AIMessage(content="Vier Meter.")])
    assert llm.invoke(MESSAGES).content == "Vier Meter."


# ------------------------------------------------------- the HTTP transport


def mocked(client, handler):
    client._transport._inner = httpx.MockTransport(handler)
    return client


def test_an_openrouter_request_holds_a_slot_until_its_body_is_read(store):
    seen: list[int] = []

    def handler(request):
        seen.append(held(store))
        return httpx.Response(200, json={"data": []})

    client = mocked(pinned_http_client(), handler)
    response = client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "m", "input": ["x"]})
    assert response.status_code == 200
    assert seen == [1]
    assert held(store) == 0


def test_another_host_takes_no_slot(store):
    seen: list[int] = []

    def handler(request):
        seen.append(held(store))
        return httpx.Response(200, json={})

    client = mocked(pinned_http_client(), handler)
    client.post("https://api.openai.com/v1/embeddings", json={"input": ["x"]})
    assert seen == [0]


def test_a_streamed_response_keeps_its_slot_until_it_is_closed(store):
    class Events(httpx.SyncByteStream):
        def __iter__(self):
            yield b"data: x\n\n"

    client = mocked(pinned_http_client(), lambda request: httpx.Response(200, stream=Events()))
    with client.stream("POST", "https://openrouter.ai/api/v1/chat/completions", json={"model": "m"}) as response:
        assert held(store) == 1
        assert response.status_code == 200
    assert held(store) == 0


def test_a_failed_request_gives_its_slot_back(store):
    def handler(request):
        raise httpx.ConnectError("down", request=request)

    client = mocked(pinned_http_client(), handler)
    with pytest.raises(httpx.ConnectError):
        client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "m"})
    assert held(store) == 0


def test_a_429_response_is_recorded_and_its_slot_is_free_for_the_retry(store, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "16")
    client = mocked(pinned_http_client(), lambda request: httpx.Response(429, headers={"retry-after": "3"}))
    response = client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "vendor/embed", "input": ["x"]})
    assert response.status_code == 429
    assert held(store) == 0
    assert model_limit(store, "vendor/embed") == 16


def test_the_model_of_a_request_labels_its_429(monkeypatch):
    from aiq_agent.common.openrouter import _request_model

    big = b'{"messages": [{"image": "' + b"A" * 2_000_000 + b'"}], "model": "vendor/vision", "x": 1}'
    request = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions", content=big)
    assert _request_model(request) == "vendor/vision"
    assert _request_model(httpx.Request("POST", "https://openrouter.ai/x", content=b"{}")) is None


def test_a_chat_request_stops_waiting_at_its_pool_timeout(store):
    holder = pl.acquire(cls=pl.BULK)
    client = mocked(pinned_http_client(timeout=0.05), lambda request: httpx.Response(200, json={}))
    with pl.provider_class(pl.CHAT):
        with pytest.raises(httpx.PoolTimeout):
            client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "m"})
    assert waiting(store, pl.CHAT) == 0
    holder.release()


def test_a_bulk_request_waits_past_its_timeout_rather_than_fail(store):
    import threading
    import time

    holder = pl.acquire(cls=pl.CHAT)
    client = mocked(pinned_http_client(timeout=0.05), lambda request: httpx.Response(200, json={"ok": True}))
    results: list[int] = []

    def send() -> None:
        with pl.provider_class(pl.BULK):
            results.append(client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "m"}).status_code)

    thread = threading.Thread(target=send)
    thread.start()
    time.sleep(0.3)  # six times its timeout, still waiting
    assert results == []
    holder.release()
    thread.join(5)
    assert results == [200]


async def test_the_async_transport_holds_and_releases_a_slot_too(store):
    seen: list[int] = []

    def handler(request):
        seen.append(held(store))
        return httpx.Response(200, json={})

    client = pinned_async_http_client()
    client._transport._inner = httpx.MockTransport(handler)
    response = await client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "m"})
    assert response.status_code == 200
    assert seen == [1]
    assert held(store) == 0


async def test_the_async_transport_records_a_429(store, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "16")
    client = pinned_async_http_client()
    client._transport._inner = httpx.MockTransport(lambda request: httpx.Response(429))
    response = await client.post("https://openrouter.ai/api/v1/embeddings", json={"model": "m"})
    assert response.status_code == 429
    assert held(store) == 0
    assert model_limit(store, "m") == 16


# ------------------------------------------------------------ entry points


def test_a_chat_turn_runs_in_the_chat_class():
    from aiq_agent.turn import admission

    seen: list[str] = []

    class Agent:
        async def stream(self, state, thread_id=None):
            seen.append(pl.current_class())
            yield state

    async def run() -> None:
        async for _ in admission.answer_turn(Agent(), object(), thread_id="t", organization_id=None):
            pass

    asyncio.run(run())
    assert seen == [pl.CHAT]
    assert pl.current_class() == pl.INTERACTIVE


def test_a_research_job_runs_in_the_research_class():
    from aiq_api.jobs import runner

    assert getattr(runner.run_agent_job, "__wrapped__", None) is not None
    assert inspect.iscoroutinefunction(runner.run_agent_job)


def test_a_queued_ingest_job_runs_in_the_class_of_its_priority(monkeypatch):
    import threading

    import aiq_api.jobs.ingest_dispatch as dispatch
    from aiq_api.jobs.ingest_dispatch import QueueSource
    from aiq_agent.knowledge.base import PreparedIngestJob

    seen: list[str] = []

    class Ingestor:
        def run_prepared(self, prepared, still_owner=None):
            seen.append(pl.current_class())

    source = QueueSource.__new__(QueueSource)
    source._ingestor = Ingestor()
    source._worker = "w"
    source._max_job_seconds = 0
    source._held = {}
    source._held_lock = threading.Lock()
    source._beat = lambda *a: None

    monkeypatch.setattr(dispatch.ingest_queue, "mark_done", lambda *a, **k: None)
    monkeypatch.setattr(dispatch.ingest_queue.QUEUE, "record_duration", lambda *a, **k: None)

    def job(config: dict) -> PreparedIngestJob:
        return PreparedIngestJob(job_id="j", status=None, file_paths=[], collection_name="c", config=config)

    # The priority POST /v1/ingest put on the job config is the one the limiter sees.
    source._run("job-1", job({"priority": "bulk"}), dispatch._Run())
    source._run("job-2", job({"priority": "interactive"}), dispatch._Run())
    source._run("job-3", job({}), dispatch._Run())  # a job from before priorities existed
    assert seen == [pl.BULK, pl.INTERACTIVE, pl.INTERACTIVE]
