"""Which tools count as unavailable: a stub's marker, never a word in a real tool's description."""

from types import SimpleNamespace

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
