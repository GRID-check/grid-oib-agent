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
from aiq_agent.project_context import USER_ID_HEADER
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


def test_the_memory_tool_declares_the_one_thing_both_its_shapes_need():
    """`remember` runs in TWO shapes and the declaration states their minimum.

    In a project turn it writes project memory; in the Büro there is no project
    and it writes ORGANISATION memory (ADR-0054, spec AG-8), so requiring the
    project id here would state a requirement the office turn legitimately does
    not meet — and this contract is checked against every path that binds the
    tool, not against the paths that happen to be project-scoped. The
    organisation is what neither shape can run without: without it there is
    nowhere to record a finding at all, and the tool says exactly that.
    """
    assert set(TOOL_CONTEXT_REQUIREMENTS["project_memory_remember"]) == {ORGANIZATION_ID_HEADER}


def test_the_worker_still_injects_the_project_id_the_office_turn_does_not_have():
    """The other half of the row above, and the reason dropping it is safe.

    A PROJECT run's `remember` writes project memory, and it can only do that if
    the worker injects the project id — which is not covered by the requirement
    any more, because the office shape has no project. Pinned here instead: a
    worker that stopped injecting it would not fail the requirement, it would
    quietly escalate every finding of every project run to the whole office.
    """
    assert PROJECT_ID_HEADER in WORKER_IDENTITY_HEADERS


def test_the_bim_tools_declare_the_organisation_and_not_the_project(config: dict):
    """The building-model tools take their project as an ARGUMENT (spec AG-10).

    They are bound in the Büro as well as in a project chat, and there the turn
    has no project to read off the context — it has a mounted set, and the model
    names which of it to read. What neither can run without is the organisation:
    every BIM route scopes its reads to one tenant. Named here for the same
    reason as the rows above — a tool with no entry passes the worker test by
    having no requirements at all.
    """
    for kind in ("ifc_query", "ifc_measure"):
        assert set(TOOL_CONTEXT_REQUIREMENTS[kind]) == {ORGANIZATION_ID_HEADER}
    # And they are bound where the office turn runs, which is what makes the
    # office branch of the resolver reachable at all.
    assert {"ifc_query", "ifc_measure"} <= set(_bound_tool_types(config, "shallow_research_agent").values())


def test_the_register_search_declares_its_organization_scope():
    """The Projektregister never crosses the organisation (ADR-0054, PR-17), so
    the organisation is what `find_projects` cannot run without. Named here so
    that dropping the declaration is loud rather than silent — a tool with no
    entry passes the worker test by having no requirements at all."""
    assert set(TOOL_CONTEXT_REQUIREMENTS["workspace_find_projects"]) == {ORGANIZATION_ID_HEADER}


def test_mounting_a_project_declares_the_acting_user():
    """The office authorizes a mount as the USER (`project:chat` is a person's
    permission, never the service's — ADR-0054, spec MT-3), so `open_project`
    cannot run on the organisation alone the way the register search can. Named
    here for the same reason as the row above: a tool with no entry passes the
    worker test by having no requirements at all."""
    assert set(TOOL_CONTEXT_REQUIREMENTS["workspace_open_project"]) == {ORGANIZATION_ID_HEADER, USER_ID_HEADER}


def test_the_office_tools_are_bound_where_the_office_turn_runs(config: dict):
    """Both halves of the Büro tool set reach the answering agent (spec AG-7).
    The entry point exposes them; this is the wiring that makes the model see
    them, and it is the half a config edit can silently drop."""
    bound = _bound_tool_types(config, "shallow_research_agent")
    assert "workspace_find_projects" in bound.values()
    assert "workspace_open_project" in bound.values()


def test_every_declared_requirement_names_a_function_type_the_config_binds(config: dict):
    """A requirement for a type nobody binds is a typo that would guard nothing."""
    bound_types = {entry.get("_type") for entry in config["functions"].values() if isinstance(entry, dict)}
    unknown = [kind for kind in TOOL_CONTEXT_REQUIREMENTS if kind not in bound_types]
    assert unknown == [], unknown
