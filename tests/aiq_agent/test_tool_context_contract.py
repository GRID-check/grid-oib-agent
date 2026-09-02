"""Every bound tool can run in every context it is bound into.

A tool declares what it needs from the request context
(`aiq_agent.project_context.TOOL_CONTEXT_REQUIREMENTS`); each entry path that
binds it must supply that. The chat path sets the headers on the WebSocket
upgrade; the job worker injects them from the run's identity. These tests
read the shipped config and the two declarations as data — wiring, never
behaviour. `remember` sat outside this contract for weeks: bound to the deep
researcher, run by a worker that injected nothing, answering "no project in
scope" on every unattended run.
"""

from pathlib import Path

import pytest
import yaml

from aiq_agent.project_context import ORGANIZATION_ID_HEADER
from aiq_agent.project_context import PROJECT_ID_HEADER
from aiq_agent.project_context import TOOL_CONTEXT_REQUIREMENTS
from aiq_api.jobs.runner import WORKER_IDENTITY_HEADERS

CONFIG = Path(__file__).resolve().parents[2] / "configs" / "config_oib_openrouter.yml"


@pytest.fixture(scope="module")
def config() -> dict:
    return yaml.safe_load(CONFIG.read_text(encoding="utf-8"))


def _bound_tool_types(config: dict, agent: str) -> dict[str, str]:
    """Bound tool name -> its NAT function type, the identity the contract is keyed by."""
    functions = config["functions"]
    return {name: functions[name]["_type"] for name in functions[agent]["tools"] if name in functions}


@pytest.mark.parametrize("agent", ["shallow_research_agent", "deep_research_agent"])
def test_the_worker_supplies_what_every_bound_tool_needs(config: dict, agent: str):
    """The deep researcher runs unattended on the job worker; the shallow one
    can too (`output: chat` jobs). Either way the worker's identity headers
    must cover every tool the agent binds."""
    missing = {
        name: [header for header in TOOL_CONTEXT_REQUIREMENTS.get(kind, ()) if header not in WORKER_IDENTITY_HEADERS]
        for name, kind in _bound_tool_types(config, agent).items()
    }
    missing = {name: headers for name, headers in missing.items() if headers}
    assert missing == {}, f"{agent} binds tools the job worker cannot serve: {missing}"


def test_the_memory_tool_declares_its_project_scope():
    """The one requirement that has already bitten, stated as data."""
    assert set(TOOL_CONTEXT_REQUIREMENTS["project_memory_remember"]) == {PROJECT_ID_HEADER, ORGANIZATION_ID_HEADER}


def test_every_declared_requirement_names_a_function_type_the_config_binds(config: dict):
    """A requirement for a type nobody binds is a typo that would guard nothing."""
    bound_types = {entry.get("_type") for entry in config["functions"].values() if isinstance(entry, dict)}
    unknown = [kind for kind in TOOL_CONTEXT_REQUIREMENTS if kind not in bound_types]
    assert unknown == [], unknown
