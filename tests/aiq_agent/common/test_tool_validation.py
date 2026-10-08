"""Which tools count as unavailable, and what the reader is told when the searches left nothing."""

from types import SimpleNamespace

from aiq_agent.common.canned_replies import NO_SOURCES_MESSAGE
from aiq_agent.common.canned_replies import SCOPED_NO_SOURCES_MESSAGE
from aiq_agent.common.canned_replies import TOOLS_UNAVAILABLE_MESSAGE
from aiq_agent.common.tool_validation import format_no_sources_message
from aiq_agent.common.tool_validation import validate_tool_availability


def _tool(name: str, description: str) -> SimpleNamespace:
    return SimpleNamespace(name=name, description=description)


def test_a_registered_stub_is_unavailable_with_its_reason():
    stub = _tool("web_search_tool", "Web search tool (unavailable - missing TAVILY_API_KEY).")
    assert validate_tool_availability([stub], enable_logging=False) == (
        False,
        0,
        ["web_search_tool (missing TAVILY_API_KEY)"],
    )


def test_a_real_tool_that_mentions_missing_data_is_available():
    # ifc_query and ifc_measure were reported unavailable on every turn, as
    # "missing standard" and "missing one", for sentences like these.
    tools = [
        _tool("ifc_query", "Checks the model: duplicated GlobalIds, missing standard property sets."),
        _tool("ifc_measure", "A declared one is repeated, a missing one is missing and is never derived."),
    ]
    assert validate_tool_availability(tools, enable_logging=False) == (True, 2, [])


def test_an_unscoped_miss_does_not_tell_the_reader_to_widen_a_scope():
    message = format_no_sources_message("research", [], 3)
    assert message == NO_SOURCES_MESSAGE
    assert "einzelne Datei" not in message


def test_a_scoped_miss_tells_the_reader_to_widen_the_scope():
    assert format_no_sources_message("research", [], 3, scoped=True) == SCOPED_NO_SOURCES_MESSAGE


def test_an_unavailable_tool_is_named_before_any_scope_advice(monkeypatch):
    monkeypatch.delenv("AIQ_DEV_ENV", raising=False)
    message = format_no_sources_message("research", ["web_search_tool (missing KEY)"], 0, scoped=True)
    assert message == TOOLS_UNAVAILABLE_MESSAGE
