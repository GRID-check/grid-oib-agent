# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Live smoke test for Grid card generation.

Reconstructs the minimal real path used by ``ChatResearcherAgent._generate_cards``
(see src/aiq_agent/agents/chat_researcher/agent.py) without needing the full NAT
builder/graph: build the shared card-generation system prompt from
``aiq_agent.cards.prompt``, call the real OpenRouter chat/completions endpoint
with the ``card_generator_llm`` model configured in
``configs/config_oib_openrouter.yml`` (deepseek_super_llm), and validate the
response through the real ``aiq_agent.cards.models.validate_cards``.

Run inside the backend Docker image so it has deps + the OPENROUTER_API_KEY:

    docker run --rm --env-file deploy/.env \
        -v "F:/GRID/grid-oib-agent/scripts:/smoke:ro" \
        nvcr.io/nvidia/blueprint/aiq-agent:2.0.0 python /smoke/smoke_card_generation.py
"""

from __future__ import annotations

import json
import os
import sys

import httpx

from aiq_agent.cards.models import validate_cards
from aiq_agent.cards.prompt import build_card_generation_prompt

# Model wired as card_generator_llm in configs/config_oib_openrouter.yml.
MODEL_NAME = "deepseek/deepseek-v4-flash"
BASE_URL = "https://openrouter.ai/api/v1"

SAMPLE_QUERY = "Welche Brandschutzanforderungen gelten laut OIB-Richtlinie 2 für Fluchtwege in einem 5-geschossigen Wohngebäude?"

SAMPLE_RESEARCH_CONTEXT = (
    "Laut OIB-Richtlinie 2 (Brandschutz), Ausgabe 2019, Punkt 4.2, muessen Fluchtwege in "
    "Gebaeuden der Gebaeudeklasse 5 (mehr als 4 oberirdische Geschosse) so ausgefuehrt sein, "
    "dass jede Nutzungseinheit ueber mindestens einen gesicherten Fluchtweg in einem "
    "Stiegenhaus mit Brandabschnittsbildung erreicht werden kann. Die maximale Fluchtweglaenge "
    "innerhalb einer Nutzungseinheit bis zum gesicherten Fluchtweg betraegt 40 m, sofern kein "
    "zweiter unabhaengiger Fluchtweg vorhanden ist; mit einem zweiten Fluchtweg sind bis zu 60 m "
    "zulaessig. Stiegenhaeuser, die als gesicherter Fluchtweg dienen, sind in der Feuerwiderstandsklasse "
    "REI 90 zu errichten und ins Freie oder in einen sicheren Bereich zu fuehren.\n\n"
    "Quelle: OIB-Richtlinie 2 Brandschutz, Ausgabe 2019, Abschnitt 4.2 (Fluchtwege)."
)


def build_messages() -> list[dict]:
    system_prompt = build_card_generation_prompt()
    user_content = f"Question: {SAMPLE_QUERY}\n\nResearch context:\n{SAMPLE_RESEARCH_CONTEXT}"
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]


def call_openrouter(messages: list[dict]) -> str:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print("FAIL: OPENROUTER_API_KEY is not set in the environment.")
        sys.exit(1)

    payload = {
        "model": MODEL_NAME,
        "messages": messages,
        "temperature": 1.0,
        "top_p": 0.95,
        "max_tokens": 4096,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    with httpx.Client(timeout=120.0) as client:
        resp = client.post(f"{BASE_URL}/chat/completions", json=payload, headers=headers)

    print(f"HTTP status: {resp.status_code}")
    if resp.status_code != 200:
        print("FAIL: OpenRouter request did not succeed.")
        print(resp.text[:2000])
        sys.exit(1)

    data = resp.json()
    choice = data["choices"][0]["message"]["content"]
    return choice


def strip_code_fence(raw_text: str) -> str:
    raw_text = raw_text.strip()
    if raw_text.startswith("```"):
        raw_text = raw_text.split("\n", 1)[-1].rsplit("\n```", 1)[0].strip()
    return raw_text


def main() -> None:
    print(f"Model: {MODEL_NAME}")
    print(f"Base URL: {BASE_URL}")

    messages = build_messages()
    print("\n--- Calling OpenRouter (real LLM call) ---")
    raw_text = call_openrouter(messages)
    print("\n--- Raw LLM response (first 2000 chars) ---")
    print(raw_text[:2000])

    cleaned = strip_code_fence(raw_text)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"\nFAIL: Could not parse LLM output as JSON: {e}")
        sys.exit(1)

    if not isinstance(parsed, list):
        parsed = [parsed]

    try:
        cards = validate_cards(parsed)
    except Exception as e:
        print(f"\nFAIL: validate_cards raised an exception: {e}")
        print(f"Parsed payload was: {json.dumps(parsed, indent=2, ensure_ascii=False)}")
        sys.exit(1)

    print(f"\n--- SUCCESS: {len(cards)} valid card(s) returned ---")
    for card in cards:
        print(f"type={card.get('type')}")
        snippet = json.dumps(card, ensure_ascii=False)
        print(snippet[:500])
        print()


if __name__ == "__main__":
    main()
