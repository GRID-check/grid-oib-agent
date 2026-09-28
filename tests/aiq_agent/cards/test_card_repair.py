"""The one bounded repair of a wrong-shaped envelope card, on the small model.

Every exit is ``None`` and logged, never raised: the answer is already final
when a repair runs, and a card is an enhancement of it.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock
from unittest.mock import patch

from langchain_core.messages import AIMessage

from aiq_agent.cards import repair as repair_module
from aiq_agent.cards.repair import repair_card

CARD = {"type": "typed_table", "title": "Teile", "columns": ["Teil"], "rows": [["OIB 2"]]}
FIXED = {"type": "typed_table", "title": "Teile", "columns": [{"label": "Teil", "type": "text"}], "rows": [["OIB 2"]]}


async def _run(reply):
    with patch.object(repair_module, "_ainvoke_card_llm", AsyncMock(return_value=reply)) as invoke:
        result = await repair_card(object(), CARD, "card of type 'typed_table' failed validation: …", "Die Antwort.")
    return result, invoke


async def test_the_corrected_object_of_the_same_type_comes_back():
    result, invoke = await _run(AIMessage(content="```json\n" + json.dumps(FIXED) + "\n```"))
    assert result == FIXED
    # The prompt carries the answer, the card as written and the refusal — the
    # three things a repair needs, and nothing of the turn's context.
    _llm, messages = invoke.await_args.args
    human = messages[-1].content
    assert "Die Antwort." in human and json.dumps(CARD, ensure_ascii=False) in human
    assert "failed validation" in human


async def test_a_different_type_is_refused():
    result, _ = await _run(AIMessage(content=json.dumps({**FIXED, "type": "legal_basis"})))
    assert result is None


async def test_unparseable_output_is_nothing():
    result, _ = await _run(AIMessage(content="I cannot help with that."))
    assert result is None


async def test_a_provider_error_keeps_the_answer():
    with patch.object(repair_module, "_ainvoke_card_llm", AsyncMock(side_effect=RuntimeError("boom"))):
        assert await repair_card(object(), CARD, "why", "answer") is None


async def test_a_timeout_keeps_the_answer(monkeypatch):
    import asyncio

    async def _slow(*_args, **_kwargs):
        await asyncio.sleep(10)

    monkeypatch.setattr(repair_module, "CARD_REPAIR_TIMEOUT_S", 0.01)
    with patch.object(repair_module, "_ainvoke_card_llm", _slow):
        assert await repair_card(object(), CARD, "why", "answer") is None
