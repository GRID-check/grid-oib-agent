"""Tests for the prompt-cache/sticky-routing key derivation.

The contract under test is narrow and load-bearing: the key must be the same
for every call that shares a cached prefix (so a turn's iterations land on the
endpoint that cached it) and different the moment the prefix changes (so a miss
is never pinned to a warm shard).
"""

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage

from aiq_agent.common.prompt_caching import PROMPT_CACHE_KEY_FIELD
from aiq_agent.common.prompt_caching import SESSION_ID_FIELD
from aiq_agent.common.prompt_caching import begin_stable_prefix
from aiq_agent.common.prompt_caching import end_stable_prefix
from aiq_agent.common.prompt_caching import prompt_cache_extra_body
from aiq_agent.common.prompt_caching import prompt_cache_key
from aiq_agent.common.prompt_caching import with_prompt_cache_routing

TOOLS = [{"type": "function", "name": "knowledge_search", "parameters": {"type": "object"}}]


def _key(**overrides):
    args = {
        "system_prompt": "You are Piloti.",
        "tools": TOOLS,
        "organization_id": "org_1",
        "model": "openai/gpt-5.6-luna",
    }
    args.update(overrides)
    return prompt_cache_key(**args)


def test_same_prefix_gives_the_same_key():
    assert _key() == _key()


def test_key_changes_with_the_system_prompt():
    assert _key() != _key(system_prompt="You are Piloti. ")


def test_key_changes_with_the_tool_set():
    other = [{"type": "function", "name": "ifc_query", "parameters": {"type": "object"}}]
    assert _key() != _key(tools=other)


def test_key_changes_with_the_tenant_and_the_model():
    assert _key() != _key(organization_id="org_2")
    assert _key() != _key(model="anthropic/claude-sonnet-5")


def test_key_is_independent_of_dict_ordering():
    # Two builds of one tool set may serialize their mappings in different
    # orders; that is not a different prefix and must not split the shard.
    reordered = [{"name": "knowledge_search", "type": "function", "parameters": {"type": "object"}}]
    assert _key() == _key(tools=reordered)


def test_key_fits_openrouters_session_id_limit():
    # `session_id` is capped at 256 characters by the API.
    assert len(_key()) <= 256


def test_parts_cannot_collide_across_the_separator():
    assert prompt_cache_key(system_prompt="ab", tools="c") != prompt_cache_key(system_prompt="a", tools="bc")


def test_routing_fields_preserve_an_existing_extra_body():
    merged = with_prompt_cache_routing({"plugins": [{"id": "response-healing"}]}, "grid-abc")
    assert merged["plugins"] == [{"id": "response-healing"}]
    assert merged[SESSION_ID_FIELD] == "grid-abc"
    assert merged[PROMPT_CACHE_KEY_FIELD] == "grid-abc"


def test_routing_never_overwrites_an_explicit_key():
    merged = with_prompt_cache_routing({SESSION_ID_FIELD: "chosen-by-the-caller"}, "grid-abc")
    assert merged[SESSION_ID_FIELD] == "chosen-by-the-caller"


def test_routing_does_not_mutate_the_input():
    original = {"plugins": []}
    with_prompt_cache_routing(original, "grid-abc")
    assert original == {"plugins": []}


def test_no_leading_system_message_means_no_key():
    # Nothing to pin, and a prompt with no system prefix is below every
    # provider's caching minimum anyway.
    assert prompt_cache_extra_body([HumanMessage(content="hi")], {}) is None
    assert prompt_cache_extra_body([], {}) is None


def test_one_turns_iterations_share_a_key():
    system = SystemMessage(content="You are Piloti.")
    kwargs = {"tools": TOOLS}
    first = prompt_cache_extra_body([system, HumanMessage(content="q")], kwargs, organization_id="org_1")
    grown = [system, HumanMessage(content="q"), AIMessage(content="thinking"), HumanMessage(content="tool result")]
    second = prompt_cache_extra_body(grown, kwargs, organization_id="org_1")
    assert first[SESSION_ID_FIELD] == second[SESSION_ID_FIELD]


def test_a_narrowed_tool_set_gets_its_own_key():
    system = SystemMessage(content="You are Piloti.")
    messages = [system, HumanMessage(content="q")]
    full = prompt_cache_extra_body(messages, {"tools": TOOLS})
    narrowed = prompt_cache_extra_body(messages, {"tools": []})
    assert full[SESSION_ID_FIELD] != narrowed[SESSION_ID_FIELD]


def test_the_envelope_response_format_is_part_of_the_key():
    # response_format sits in the cached prefix (OpenAI: "text.format … adds
    # output-format instructions and the requested schema"), so a call that
    # fell through to another rung must not claim the stronger rung's shard.
    system = SystemMessage(content="You are Piloti.")
    messages = [system, HumanMessage(content="q")]
    strict = prompt_cache_extra_body(messages, {"response_format": {"type": "json_schema"}})
    loose = prompt_cache_extra_body(messages, {"response_format": {"type": "json_object"}})
    assert strict[SESSION_ID_FIELD] != loose[SESSION_ID_FIELD]


class TestAStablePrefixKeepsTheShard:
    """An agent whose system prompt has a stable head and a per-turn tail names the head.

    Piloti's dynamic half changes every turn of one conversation (the
    already-read digest), so keying on the whole message gave each turn a new
    key and a cold static prefix. Named, the prefix is the key; unnamed, or not
    matching, the whole message still is.
    """

    STATIC = "You are Piloti. [rules, tools, schema]"

    def _body(self, tail: str):
        messages = [SystemMessage(content=self.STATIC + tail), HumanMessage(content="q")]
        return prompt_cache_extra_body(messages, {"tools": TOOLS}, organization_id="org_1")

    def test_turns_that_share_the_prefix_share_the_key(self):
        token = begin_stable_prefix(self.STATIC)
        try:
            first = self._body("\n## Context\nCurrent date: 2026-09-15\nread: nothing")
            second = self._body("\n## Context\nCurrent date: 2026-09-16\nread: OIB-2 4.1")
        finally:
            end_stable_prefix(token)
        assert first[SESSION_ID_FIELD] == second[SESSION_ID_FIELD]

    def test_unnamed_the_whole_message_is_the_key(self):
        first = self._body("\nread: nothing")
        second = self._body("\nread: OIB-2 4.1")
        assert first[SESSION_ID_FIELD] != second[SESSION_ID_FIELD]

    def test_a_prompt_that_does_not_open_with_the_prefix_is_keyed_whole(self):
        token = begin_stable_prefix("Another agent's prefix")
        try:
            named = self._body("\nread: nothing")
        finally:
            end_stable_prefix(token)
        assert named[SESSION_ID_FIELD] == self._body("\nread: nothing")[SESSION_ID_FIELD]

    def test_the_named_prefix_is_the_key_itself(self):
        token = begin_stable_prefix(self.STATIC)
        try:
            named = self._body("\nanything")
        finally:
            end_stable_prefix(token)
        bare = prompt_cache_key(system_prompt=self.STATIC, tools=(TOOLS, None), organization_id="org_1", model=None)
        assert named[PROMPT_CACHE_KEY_FIELD] == bare
