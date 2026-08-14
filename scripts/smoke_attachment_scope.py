"""Live smoke test for the session-attachment scope fix (issue #429, ADR-0048).

This change is almost entirely prompts, so the only honest validation is a real
model reading the real templates. Nothing is paraphrased here: every prompt is
rendered from the shipped ``.j2`` file through the production
``render_prompt_template``, and the tool schema mirrors ``knowledge_search``'s
real signature.

Three calls, matching the three things the fix claims:

1. **Routing** — "Fass den Inhalt zusammen" WITH one attachment must classify as
   ``research`` / ``shallow``. Not ``meta``, not ``out_of_scope``, and above all
   not ``deep``: ``deep`` is the route that summons the clarifier and its
   research-plan dialog, which is the user's third reported symptom.
2. **Scoping** — the shallow researcher, given the same turn, must make its
   FIRST tool call ``knowledge_search(file_name=<the attached file>)`` and must
   not ask which file was meant.
3. **Anti-hijack** — the same attachment present, but the turn asks a general
   OIB question. The model must NOT pass ``file_name``. This is the case a
   runtime hard scope would have broken (ADR-0048 layer 3) and the one most
   likely to regress.

Run with an OpenRouter key in the environment (``OPENROUTER_API_KEY`` or
``OPENROUTER_KEY``):

    PYTHONPATH=src .venv/bin/python3 scripts/smoke_attachment_scope.py

Exit code 0 = all three checks passed; 1 = a check failed; 2 = the provider is
unreachable or unconfigured (never reported as a pass).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx

from aiq_agent.common.prompt_utils import render_prompt_template
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import shelf_origin_label
from aiq_agent.knowledge.schema import AvailableDocument

REPO_ROOT = Path(__file__).resolve().parents[1]
PROMPTS = REPO_ROOT / "src" / "aiq_agent" / "agents"
INTENT_TEMPLATE = PROMPTS / "chat_researcher" / "prompts" / "intent_classification.j2"
SHALLOW_TEMPLATE = PROMPTS / "shallow_researcher" / "prompts" / "researcher.j2"

# Boot-floor model for intent_llm / shallow_llm in configs/config_oib_openrouter.yml.
MODEL_NAME = os.environ.get("GRID_DEFAULT_MODEL", "openai/gpt-5.6-luna")
BASE_URL = "https://openrouter.ai/api/v1"

ATTACHED_FILE = "Statikbericht_Bergsteiggasse.pdf"
ATTACHMENTS = [{"file_name": ATTACHED_FILE, "state": "ready"}]

# A realistic inventory: the shared corpus dwarfs the user's own file, and one
# corpus name sorts alphabetically first — the shape that produced the bug.
INVENTORY = [
    AvailableDocument(
        file_name="OIB-Richtlinie-2-Brandschutz.pdf",
        summary="Brandschutzanforderungen, Fluchtwege, Brandabschnitte.",
        shelf=Shelf.BASE,
    ),
    AvailableDocument(
        file_name="OIB-Richtlinie-4-Nutzungssicherheit.pdf",
        summary="Nutzungssicherheit und Barrierefreiheit.",
        shelf=Shelf.BASE,
    ),
    AvailableDocument(
        file_name=ATTACHED_FILE,
        summary="Statische Berechnung für das Bauvorhaben Bergsteiggasse.",
        shelf=Shelf.SESSION,
    ),
]

ATTACHMENT_QUERY = "Fass den Inhalt zusammen"
GENERAL_QUERY = "Welche maximale Fluchtweglänge muss ich einhalten?"

KNOWLEDGE_SEARCH_SCHEMA = {
    "type": "function",
    "function": {
        "name": "knowledge_search",
        "description": (
            "Read and cite passages from the ingested knowledge base (OIB corpus, this project's "
            "files, the Büroarchiv). Pass `file_name=` that exact indexed name when the turn is "
            "about one named or attached document; `file_name=` is a HARD filter, so omit it when "
            "the question is general."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The fact or passage you need, as a search query."},
                "file_name": {"type": "string", "description": "Indexed file name to read. Never invent a name."},
                "doc_class": {"type": "string"},
                "title_contains": {"type": "string"},
            },
            "required": ["query"],
        },
    },
}


def _api_key() -> str:
    for name in ("OPENROUTER_API_KEY", "OPENROUTER_KEY"):
        key = (os.environ.get(name) or "").strip()
        if key and not key.startswith("${"):
            return key
    print("SKIP-FAIL: no OpenRouter key in the environment (OPENROUTER_API_KEY / OPENROUTER_KEY).")
    print("Live LLM validation was NOT performed. This is not a pass.")
    sys.exit(2)


def _call(messages: list[dict], *, tools: list[dict] | None = None) -> dict:
    payload: dict = {"model": MODEL_NAME, "messages": messages, "temperature": 0.0, "max_tokens": 1200}
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    headers = {"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"}
    try:
        with httpx.Client(timeout=180.0) as client:
            resp = client.post(f"{BASE_URL}/chat/completions", json=payload, headers=headers)
    except Exception as exc:
        print(f"SKIP-FAIL: provider unreachable ({type(exc).__name__}: {exc}).")
        print("Live LLM validation was NOT performed. This is not a pass.")
        sys.exit(2)
    if resp.status_code != 200:
        print(f"SKIP-FAIL: provider returned HTTP {resp.status_code}.")
        print(resp.text[:1500])
        print("Live LLM validation was NOT performed. This is not a pass.")
        sys.exit(2)
    return resp.json()["choices"][0]["message"]


def _render_shallow(query: str, attachments: list[dict]) -> str:
    return render_prompt_template(
        SHALLOW_TEMPLATE.read_text(encoding="utf-8"),
        current_datetime="2026-08-14",
        user_info={"name": "Alex", "email": "alex@example.at"},
        tools=[{"name": "knowledge_search"}],
        available_documents=[{**doc.model_dump(), "origin_label": shelf_origin_label(doc.shelf)} for doc in INVENTORY],
        session_attachments=attachments,
        project_context="country=at\nbundesland=wien\nconfirmed: gebaeudeklasse=4",
        requires_sources=True,
        ris_catalog=None,
        norm_doctrine=None,
        parcel_note=None,
        skills_block=None,
    )


def _first_knowledge_search(message: dict) -> dict | None:
    for call in message.get("tool_calls") or []:
        if (call.get("function") or {}).get("name") != "knowledge_search":
            continue
        try:
            return json.loads(call["function"].get("arguments") or "{}")
        except Exception:
            return {}
    return None


def check_1_routing() -> bool:
    print("\n=== 1. Intent classification: attachment + subjectless request ===")
    system = render_prompt_template(
        INTENT_TEMPLATE.read_text(encoding="utf-8"),
        query=ATTACHMENT_QUERY,
        current_datetime="2026-08-14",
        user_info={"name": "Alex", "email": "alex@example.at"},
        tools=[{"name": "knowledge_search", "description": "Read and cite passages."}],
        project_context="country=at\nbundesland=wien",
        session_attachments=ATTACHMENTS,
    )
    message = _call(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": ATTACHMENT_QUERY},
            {"role": "user", "content": "Classify the query now. Respond with ONLY the raw JSON object."},
        ]
    )
    raw = (message.get("content") or "").strip()
    print(f"model output: {raw!r}")
    try:
        start, end = raw.index("{"), raw.rindex("}") + 1
        parsed = json.loads(raw[start:end])
    except Exception:
        print("FAIL: could not parse a JSON object from the classifier output.")
        return False
    intent, depth = parsed.get("intent"), parsed.get("research_depth")
    print(f"intent={intent!r} research_depth={depth!r}")
    ok = intent == "research" and depth == "shallow"
    print("PASS" if ok else f"FAIL: expected research/shallow, got {intent}/{depth}")
    return ok


def check_2_scoping() -> bool:
    print("\n=== 2. Shallow researcher: first tool call must name the attached file ===")
    message = _call(
        [
            {"role": "system", "content": _render_shallow(ATTACHMENT_QUERY, ATTACHMENTS)},
            {"role": "user", "content": ATTACHMENT_QUERY},
        ],
        tools=[KNOWLEDGE_SEARCH_SCHEMA],
    )
    args = _first_knowledge_search(message)
    text = (message.get("content") or "").strip()
    print(f"tool call args: {json.dumps(args, ensure_ascii=False) if args is not None else None}")
    print(f"assistant text: {text[:400]!r}")
    if args is None:
        print("FAIL: no knowledge_search call — the model answered or asked instead of retrieving.")
        return False
    if args.get("file_name") != ATTACHED_FILE:
        print(f"FAIL: expected file_name={ATTACHED_FILE!r}, got {args.get('file_name')!r}")
        return False
    if "?" in text:
        print("FAIL: the model asked a clarifying question alongside the retrieval.")
        return False
    print("PASS")
    return True


def check_3_anti_hijack() -> bool:
    print("\n=== 3. Anti-hijack: a general OIB question must NOT be scoped to the attachment ===")
    message = _call(
        [
            {"role": "system", "content": _render_shallow(GENERAL_QUERY, ATTACHMENTS)},
            {"role": "user", "content": GENERAL_QUERY},
        ],
        tools=[KNOWLEDGE_SEARCH_SCHEMA],
    )
    args = _first_knowledge_search(message)
    print(f"tool call args: {json.dumps(args, ensure_ascii=False) if args is not None else None}")
    print(f"assistant text: {(message.get('content') or '').strip()[:400]!r}")
    if args is None:
        print("FAIL: no knowledge_search call at all on a plain research question.")
        return False
    if args.get("file_name"):
        print(f"FAIL: the attachment hijacked a general question — file_name={args['file_name']!r}")
        return False
    print("PASS")
    return True


def main() -> None:
    print(f"Model: {MODEL_NAME}")
    print(f"Base URL: {BASE_URL}")
    print(f"Attached file: {ATTACHED_FILE}")
    results = [check_1_routing(), check_2_scoping(), check_3_anti_hijack()]
    print(f"\n=== {sum(results)}/3 checks passed ===")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
