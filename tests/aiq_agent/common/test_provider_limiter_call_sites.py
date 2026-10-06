"""Every chat model and embedding client passes the provider limiter (ADR-0080).

``test_openrouter_call_sites`` is the ratchet on zero data retention; this is the
same ratchet on the limiter. The limiter is only a ceiling if nothing calls a
model around it, and "nothing" is a claim that review alone cannot keep: a new
agent that builds its own ``ChatOpenAI``, or a script that builds its own
embedding client, goes out ungated and nothing says so until the provider does.

The seams that carry the limiter, one per call-site shape:

- a LangChain chat model: ``llm_factory.get_langchain_llm``, whose
  ``enforce_chat_request_contract`` makes every ``_generate`` / ``_stream`` take a
  slot. A model built any other way never passes it;
- an OpenAI SDK client, which is every embedding, vision and rerank call:
  ``openrouter.openai_client`` / ``pinned_http_client``, whose transport takes the
  slot;
- the embedding client: ``knowledge_layer.llamaindex.adapter.make_embed_model``,
  which hands those transports to llama-index.

The first two tests scan the source, the rest are behavioural: they send a call
through each seam and watch the pool, so a seam that is rewired to skip the
limiter fails here even though every name still matches.
"""

from __future__ import annotations

import re
from pathlib import Path

import fakeredis
import httpx
import pytest

from aiq_agent.common import provider_limiter as pl
from aiq_agent.common.openrouter import openai_client
from aiq_agent.common.openrouter import pinned_async_http_client
from aiq_agent.common.openrouter import pinned_http_client

ROOT = Path(__file__).resolve().parents[3]
SCANNED = [ROOT / "src", ROOT / "sources", ROOT / "frontends" / "aiq_api" / "src", ROOT / "scripts"]

#: Building a chat model by hand, or acquiring one from NAT without the seam.
#: Every one of them yields a model the contract subclass never wraps.
CHAT_MODEL = re.compile(
    r"\b(?:ChatOpenAI|AzureChatOpenAI|ChatNVIDIA|ChatAnthropic|ChatGoogleGenerativeAI|ChatMistralAI|ChatOllama"
    r"|ChatLiteLLM|ChatBedrock|ChatBedrockConverse|ChatDeepSeek|ChatOpenRouter)\(|\binit_chat_model\(|\.get_llm\("
)
CHAT_MODEL_HOMES = {
    "src/aiq_agent/common/llm_factory.py": "get_langchain_llm, the one place a chat model is taken from NAT",
}

#: Building an embedding client by hand. Its HTTP client must come from the seam.
EMBEDDING_CLIENT = re.compile(r"\b[A-Za-z]*Embeddings?\(|\.embeddings\.create\(")
EMBEDDING_CLIENT_HOMES = {
    "sources/knowledge_layer/src/llamaindex/adapter.py": "make_embed_model hands llama-index the limited transports",
    "src/aiq_agent/common/openrouter.py": "mentions `.embeddings` in a docstring only",
}
#: A match that is not a client: a class that merely has "Embedding" in its name.
NOT_A_CLIENT = re.compile(r"\b(?:Mock|Fake|Stub|Noop)\w*Embedding|\bQueryEmbedding\(|\b_InflightEmbedding\(")


def _python_files() -> list[Path]:
    files: list[Path] = []
    for base in SCANNED:
        files.extend(p for p in base.rglob("*.py") if "tests" not in p.relative_to(ROOT).parts)
    return files


def _rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def _code(path: Path) -> str:
    """The file without comments, so a docstring or comment naming a class is not a construction."""
    return "\n".join(
        line for line in path.read_text(encoding="utf-8").splitlines() if not line.lstrip().startswith("#")
    )


def test_the_scan_sees_the_known_call_sites():
    """Guards the test itself: a glob that silently matched nothing would pass everything."""
    scanned = {_rel(p) for p in _python_files()}
    assert "src/aiq_agent/common/llm_factory.py" in scanned
    assert "sources/knowledge_layer/src/llamaindex/adapter.py" in scanned
    assert "src/aiq_agent/agents/piloti/register.py" in scanned


@pytest.mark.parametrize("path", _python_files(), ids=_rel)
def test_no_chat_model_is_built_outside_the_limited_seam(path: Path):
    if _rel(path) in CHAT_MODEL_HOMES:
        return
    match = CHAT_MODEL.search(_code(path))
    assert match is None, (
        f"{_rel(path)} gets a chat model with {match.group(0)!r} instead of through "
        "common/llm_factory.get_langchain_llm. A model taken that way is never wrapped by the request "
        "contract, so its calls skip the provider limiter (ADR-0080) and nothing queues them behind chat. "
        "If this one truly cannot reach the provider, add it to CHAT_MODEL_HOMES with the reason."
    )


@pytest.mark.parametrize("path", _python_files(), ids=_rel)
def test_no_embedding_client_is_built_outside_the_limited_seam(path: Path):
    if _rel(path) in EMBEDDING_CLIENT_HOMES:
        return
    code = NOT_A_CLIENT.sub("", _code(path))
    match = EMBEDDING_CLIENT.search(code)
    assert match is None, (
        f"{_rel(path)} builds an embedding client with {match.group(0)!r}. Build it through "
        "knowledge_layer.llamaindex.adapter.make_embed_model (or openrouter.openai_client), whose HTTP "
        "transport takes a provider slot (ADR-0080). A client built by hand calls the provider ungated."
    )


def test_the_allowlists_name_files_that_exist():
    """A stale entry would quietly exempt whatever file next takes that path."""
    for rel in [*CHAT_MODEL_HOMES, *EMBEDDING_CLIENT_HOMES]:
        assert (ROOT / rel).is_file(), rel


# --------------------------------------------------------------- behavioural


@pytest.fixture
def pool(monkeypatch):
    """A one-slot pool on a Redis with Lua, and a way to see how many slots are held."""
    client = fakeredis.FakeRedis(server=fakeredis.FakeServer(), decode_responses=True)
    monkeypatch.setattr(
        pl.cache, "eval_script", lambda script, keys, args: client.eval(script, len(keys), *keys, *args)
    )
    monkeypatch.setenv(pl._CEILING_ENV, "1")
    monkeypatch.setenv(pl._FLOOR_ENV, "1")
    return lambda: client.zcard(pl._keys(pl.POOL)["leases"])


def _seen_while_serving(client, pool) -> list[int]:
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(pool())
        return httpx.Response(200, json={"data": []})

    client._transport._inner = httpx.MockTransport(handler)
    return seen


def test_the_embedding_client_holds_a_slot_for_every_call_it_makes(pool):
    from knowledge_layer.llamaindex.adapter import make_embed_model

    model = make_embed_model(
        base_url="https://openrouter.ai/api/v1",
        model="vendor/embed",
        api_key="k",  # pragma: allowlist secret
        max_retries=0,
    )
    seen = _seen_while_serving(model._http_client, pool)
    with pytest.raises(Exception):  # noqa: B017 - the empty reply is not a valid embedding; the call was made
        model.get_query_embedding("Brüstungshöhe")
    assert seen == [1]
    assert pool() == 0


async def test_the_embedding_clients_async_side_holds_a_slot_too(pool):
    from knowledge_layer.llamaindex.adapter import make_embed_model

    model = make_embed_model(
        base_url="https://openrouter.ai/api/v1",
        model="vendor/embed",
        api_key="k",  # pragma: allowlist secret
        max_retries=0,
    )
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(pool())
        return httpx.Response(200, json={"data": []})

    model._async_http_client._transport._inner = httpx.MockTransport(handler)
    with pytest.raises(Exception):  # noqa: B017 - see above
        await model.aget_query_embedding("Brüstungshöhe")
    assert seen == [1]
    assert pool() == 0


def test_a_vision_or_rerank_client_from_the_seam_holds_a_slot(pool):
    client = openai_client(
        base_url="https://openrouter.ai/api/v1",
        api_key="k",  # pragma: allowlist secret
        policy=pl_policy(),
        max_retries=0,
    )
    seen = _seen_while_serving(client._client, pool)
    try:
        client.chat.completions.create(model="vendor/vision", messages=[{"role": "user", "content": "x"}])
    except Exception:  # noqa: BLE001 - the stub reply may not parse; the call was made either way
        pass
    assert seen == [1]
    assert pool() == 0


def pl_policy():
    from aiq_agent.common.openrouter import PLATFORM_FIXED

    return PLATFORM_FIXED


@pytest.mark.parametrize("make", [pinned_http_client, pinned_async_http_client], ids=["sync", "async"])
def test_every_pinned_client_is_built_on_the_limited_transport(make):
    from aiq_agent.common import openrouter

    transport = make()._transport
    assert isinstance(transport, (openrouter._PinningTransport, openrouter._AsyncPinningTransport))


async def test_a_chat_model_from_the_seam_holds_a_slot_for_every_call(pool, monkeypatch):
    """`get_langchain_llm` through a real NAT builder: what every agent in the fleet is handed."""
    from langchain_openai import ChatOpenAI

    import nat.plugins.langchain.llm  # noqa: F401 - registers NAT's LangChain clients
    from aiq_agent.common.llm_factory import get_langchain_llm
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.llm.openai_llm import OpenAIModelConfig

    seen: list[int] = []

    async def serve(self, request: httpx.Request) -> httpx.Response:
        seen.append(pool())
        return httpx.Response(500, json={"error": {"message": "stub", "code": 500}})

    # Whatever transport LangChain built (it adds socket options and proxy mounts), the call ends here.
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", serve)
    config = OpenAIModelConfig(
        model_name="vendor/model",
        api_key="k",  # pragma: allowlist secret
        base_url="https://openrouter.ai/api/v1",
        num_retries=1,
    )
    async with WorkflowBuilder() as builder:
        await builder.add_llm("llm", config)
        llm = await get_langchain_llm(builder, "llm")
        assert isinstance(llm, ChatOpenAI)
        with pytest.raises(Exception):  # noqa: B017 - the stub reply is an error; the call was made
            await llm.ainvoke("Hallo")
    assert seen
    assert set(seen) == {1}
    assert pool() == 0


async def test_a_per_request_copy_of_a_seam_model_still_holds_a_slot(pool):
    """The model-override and ZDR seams `model_copy` the model; the copy must keep the limiter."""
    from aiq_agent.common.model_overrides import override_model
    from tests.aiq_agent.common.test_llm_factory import _resolved_through_nat

    llm = await _resolved_through_nat(base_url="https://openrouter.ai/api/v1")
    copy = override_model(llm, "x-ai/grok-4.5")
    assert getattr(type(copy), "__grid_request_contract__", False)
