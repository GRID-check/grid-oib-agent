"""The office half of the tool set is not charged to a project turn.

`find_projects` and `open_project` are bound in `configs/*.yml` for every turn,
because the config is static and one agent serves both surfaces (ADR-0052).
Only an office turn can reach them: `find_projects` answers about the
organization's OTHER projects, and `open_project` mounts one, which the mounts
route refuses for a project conversation.

Left bound, a project turn pays both tool schemas — roughly two thousand
characters of description — on every single request, forever, for nothing. This
pins the narrowing so that saving cannot be undone by accident.
"""

from types import SimpleNamespace
from unittest.mock import patch

from aiq_agent.agents.shallow_researcher.register import _OFFICE_ONLY_TOOLS
from aiq_agent.agents.shallow_researcher.register import _tools_for_this_surface

_TOOLS = [
    SimpleNamespace(name="knowledge_search"),
    SimpleNamespace(name="remember"),
    SimpleNamespace(name="search_memory"),
    SimpleNamespace(name="find_projects"),
    SimpleNamespace(name="open_project"),
]


def _names(tools):
    return [tool.name for tool in tools]


def _surface(*, organization_id, project_id):
    return (
        patch(
            "aiq_agent.project_context.get_organization_id_from_context",
            return_value=organization_id,
        ),
        patch(
            "aiq_agent.project_context.get_project_id_from_context",
            return_value=project_id,
        ),
    )


class TestOfficeToolsStayInTheOffice:
    def test_a_project_turn_is_not_charged_for_them(self):
        org, project = _surface(organization_id="org_1", project_id="proj_1")
        with org, project:
            kept = _names(_tools_for_this_surface(_TOOLS))
        assert "find_projects" not in kept
        assert "open_project" not in kept
        # The read half of memory is NOT office-only: a project turn is exactly
        # where it earns its keep (ADR-0055).
        assert kept == ["knowledge_search", "remember", "search_memory"]

    def test_an_office_turn_keeps_them(self):
        org, project = _surface(organization_id="org_1", project_id=None)
        with org, project:
            assert _names(_tools_for_this_surface(_TOOLS)) == _names(_TOOLS)

    def test_it_fails_open_when_the_surface_cannot_be_read(self):
        """A context problem costs prompt budget, never the office's ability to
        find a project — the office is the surface that cannot work without
        these, so the ambiguous case keeps them."""
        with patch(
            "aiq_agent.project_context.get_organization_id_from_context",
            side_effect=RuntimeError("no context"),
        ):
            assert _names(_tools_for_this_surface(_TOOLS)) == _names(_TOOLS)

    def test_the_set_is_exactly_the_two_office_tools(self):
        """A third name added here without an argument would silently stop
        reaching a project turn that may well need it."""
        assert _OFFICE_ONLY_TOOLS == frozenset({"find_projects", "open_project"})
