"""Every registered tool an agent is meant to have must be BOUND in the config.

A tool can be fully built, registered with ``@register_function``, imported
eagerly, documented as default-on — and reachable by nobody. NAT binds only
what a config declares under ``functions:`` and then lists in an agent's
``tools:``, so the gap between "written" and "callable" is two YAML lines and
nothing complains about their absence.

``view_knowledge_image`` sat in that gap for its whole life. ``git log -S
view_knowledge_image -- configs/`` was empty: it had never been declared. The
model therefore read VLM captions OF drawings and never a drawing, which is
what "der Agent bezieht die visuellen Planunterlagen kaum ein" looks like from
the outside while every retrieval test passes.

These tests read the shipped config as data. They assert wiring, never
behaviour — the tools' own suites do that.
"""

from pathlib import Path

import pytest
import yaml

CONFIG = Path(__file__).resolve().parents[2] / "configs" / "config_oib_openrouter.yml"


@pytest.fixture(scope="module")
def config() -> dict:
    # `safe_load` chokes on nothing here: the file is plain YAML with `${VAR:-default}`
    # strings that NAT expands later, and a string is all this needs them to be.
    return yaml.safe_load(CONFIG.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def functions(config: dict) -> dict:
    return config["functions"]


def _tools(config: dict, agent: str) -> list[str]:
    return list(config["functions"][agent]["tools"])


@pytest.mark.parametrize("agent", ["shallow_research_agent", "deep_research_agent"])
def test_every_tool_an_agent_lists_is_declared(config: dict, functions: dict, agent: str):
    """A name in `tools:` that is not under `functions:` binds nothing."""
    missing = [name for name in _tools(config, agent) if name not in functions]
    assert missing == [], f"{agent} lists tools that no `functions:` entry declares: {missing}"


@pytest.mark.parametrize("agent", ["shallow_research_agent", "deep_research_agent"])
def test_the_agent_can_see_a_plan_and_not_only_its_caption(config: dict, agent: str):
    """The regression this file exists for.

    Retrieval already indexes visual chunks in the same collection and reaches
    them with the same tool — so the drawings were never missing from the
    index. What was missing was any way for the model to LOOK at one. This is
    an OIB product; a plan is the evidence.
    """
    assert "view_knowledge_image" in _tools(config, agent)


def test_the_image_tool_is_declared_with_its_own_type(functions: dict):
    entry = functions.get("view_knowledge_image")
    assert entry is not None, "view_knowledge_image must be declared under `functions:`"
    assert entry["_type"] == "view_knowledge_image"


def test_both_researchers_reach_the_same_knowledge_and_ris_tools(config: dict):
    """Shallow and deep answer the same questions; a tool on one and not the
    other means the answer changes with the routing decision rather than with
    the question."""
    shallow = set(_tools(config, "shallow_research_agent"))
    deep = set(_tools(config, "deep_research_agent"))
    shared = {
        "knowledge_search",
        "view_knowledge_image",
        "ris_search_tool",
        "ris_fetch_tool",
        "ris_catalog_lookup_tool",
    }
    assert shared <= shallow
    assert shared <= deep
