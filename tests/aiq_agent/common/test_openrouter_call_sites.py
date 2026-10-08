"""Every outbound model call goes through the OpenRouter seam (``common/openrouter.py``).

Zero Data Retention was once applied call site by call site, and most call
sites never learned about it: the embeddings, the reranker, drawing captions,
conversation titles and the whole async job worker went out unpinned while the
setting said "on". This test is the ratchet on that: a module that builds its
own model client, or posts to a model endpoint, without one of the seam's
adapters fails here, so the next call site is caught by CI rather than by an
audit.

The adapters, one per call-site shape:

- a JSON body built by hand: ``ResolvedCredential.request_body`` or
  ``PLATFORM_FIXED.apply`` / ``DataPolicy.apply``;
- an OpenAI SDK client: ``openrouter.openai_client``;
- the embedding client: ``knowledge_layer.llamaindex.adapter.make_embed_model``;
- a LangChain chat model: ``pin_chat_model`` / ``apply_model_override`` /
  ``RequestLLMContext.apply`` (not scanned here: those models are built by NAT,
  and ``test_model_overrides`` / ``test_llm_provider`` cover them).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SCANNED = [ROOT / "src", ROOT / "sources", ROOT / "frontends" / "aiq_api" / "src", ROOT / "scripts"]

#: Constructing a model client by hand. Allowed only where the seam builds one.
RAW_CLIENT = re.compile(r"\b(?:Async)?OpenAI\(|\bNVIDIAEmbedding\(")
RAW_CLIENT_HOMES = {
    "src/aiq_agent/common/openrouter.py",  # openai_client
    "sources/knowledge_layer/src/llamaindex/adapter.py",  # make_embed_model
}

#: Talking to a model endpoint directly. The module must also use an adapter.
MODEL_ENDPOINT = re.compile(
    r"/chat/completions|/audio/transcriptions|[\"']/rerank[\"']|/api/alpha/decisions|\.responses\.[\w.]*create\("
)
ADAPTERS = re.compile(
    r"request_body\(|PLATFORM_FIXED\.apply\(|\.apply\(\{|openai_client\(|pinned_(?:async_)?http_client\("
)

#: Mentions of a model endpoint that send no tenant content, with the reason.
NO_TENANT_CONTENT = {
    "frontends/aiq_api/src/aiq_api/context_envelope.py": "our own route path, in a docstring",
    "scripts/turn_census/census.py": "parses recorded request paths",
    "scripts/release_notes.py": "sends the changelog, which is public",
    "scripts/smoke_card_generation.py": "a dev smoke test on fixed sample text",
    "src/aiq_agent/common/deferred_tool_loading.py": "the capability probe sends 'ping' and synthetic tool schemas",
}


def _python_files() -> list[Path]:
    files: list[Path] = []
    for base in SCANNED:
        files.extend(p for p in base.rglob("*.py") if "tests" not in p.relative_to(ROOT).parts)
    return files


def _rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def test_the_scan_sees_the_known_call_sites():
    """Guards the test itself: a glob that silently matched nothing would pass everything."""
    scanned = {_rel(p) for p in _python_files()}
    assert "frontends/aiq_api/src/aiq_api/routes/generate_summary.py" in scanned
    assert "sources/knowledge_layer/src/cross_encoder.py" in scanned
    assert "src/aiq_agent/common/decisions.py" in scanned


@pytest.mark.parametrize("path", _python_files(), ids=_rel)
def test_no_model_client_is_built_outside_the_seam(path: Path):
    if _rel(path) in RAW_CLIENT_HOMES:
        return
    match = RAW_CLIENT.search(path.read_text(encoding="utf-8"))
    assert match is None, (
        f"{_rel(path)} builds {match.group(0)!r} by hand. Build it through common/openrouter.py "
        "(openai_client, pinned_http_client) or adapter.make_embed_model, so its requests carry "
        "the organization's zero-data-retention policy."
    )


@pytest.mark.parametrize("path", _python_files(), ids=_rel)
def test_every_model_endpoint_call_goes_through_an_adapter(path: Path):
    rel = _rel(path)
    if rel in NO_TENANT_CONTENT:
        return
    text = path.read_text(encoding="utf-8")
    endpoint = MODEL_ENDPOINT.search(text)
    if endpoint is None:
        return
    assert ADAPTERS.search(text), (
        f"{rel} talks to a model endpoint ({endpoint.group(0)!r}) without a common/openrouter.py adapter. "
        "Send the body through ResolvedCredential.request_body (an organization's call) or "
        "PLATFORM_FIXED.apply (a platform-fixed model). If it truly sends no tenant content, add it to "
        "NO_TENANT_CONTENT with the reason."
    )


def test_the_allowlists_name_files_that_exist():
    """A stale entry would quietly exempt whatever file next takes that path."""
    for rel in [*RAW_CLIENT_HOMES, *NO_TENANT_CONTENT]:
        assert (ROOT / rel).is_file(), rel
