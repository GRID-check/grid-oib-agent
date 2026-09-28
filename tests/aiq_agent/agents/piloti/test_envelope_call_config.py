"""The run config reaches every rung of the envelope ladder.

The config carries the callbacks that stream the answer's prose
(``on_llm_new_token``). A rung that drops it still answers, so nothing fails:
the reply just arrives whole at the end instead of streaming.
"""

from __future__ import annotations

from typing import Any

from aiq_agent.agents.piloti.envelope_call import ainvoke_with_envelope_json_mode


class _Rejected(Exception):
    status_code = 400


class _FakeLLM:
    """Records each call as ``(response_format, args)``; rejects the formats in ``reject``."""

    def __init__(self, reject: frozenset[str] = frozenset(), calls: list | None = None, response_format=None):
        self.reject = reject
        self.calls: list[tuple[str | None, tuple[Any, ...]]] = [] if calls is None else calls
        self.response_format = response_format

    def bind(self, *, response_format: dict[str, Any]) -> _FakeLLM:
        return _FakeLLM(self.reject, self.calls, response_format)

    async def ainvoke(self, *args: Any) -> str:
        kind = None if self.response_format is None else self.response_format["type"]
        self.calls.append((kind, args))
        if kind in self.reject:
            raise _Rejected("response_format not supported")
        return f"reply via {kind}"


async def test_the_config_reaches_the_first_rung():
    llm, cfg = _FakeLLM(), {"callbacks": ["stream"]}
    assert await ainvoke_with_envelope_json_mode(llm, ["msg"], cfg) == "reply via json_schema"
    assert llm.calls == [("json_schema", (["msg"], cfg))]


async def test_the_config_reaches_every_rung_down_to_the_plain_fallback():
    llm, cfg = _FakeLLM(reject=frozenset({"json_schema", "json_object"})), {"callbacks": ["stream"]}
    assert await ainvoke_with_envelope_json_mode(llm, ["msg"], cfg) == "reply via None"
    assert llm.calls == [
        ("json_schema", (["msg"], cfg)),
        ("json_object", (["msg"], cfg)),
        (None, (["msg"], cfg)),
    ]


async def test_without_a_config_the_call_keeps_its_unstreamed_shape():
    llm = _FakeLLM(reject=frozenset({"json_schema"}))
    await ainvoke_with_envelope_json_mode(llm, ["msg"])
    assert llm.calls == [("json_schema", (["msg"],)), ("json_object", (["msg"],))]
