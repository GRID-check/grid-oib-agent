"""The one place the agent tier reaches into the API tier."""

from __future__ import annotations

import ast
import pathlib

from aiq_agent.turn import api_seam
from aiq_agent.turn.api_seam import AuthError
from aiq_agent.turn.api_seam import skip_clarifier_requested

AGENT_SRC = pathlib.Path(api_seam.__file__).resolve().parents[1]
#: The packages this seam speaks for. ``aiq_agent/auth`` carries its own,
#: older inversion (``auth/utils.py``, ``auth/workos_validator.py``) that is
#: not this seam's to undo.
GUARDED = (AGENT_SRC / "turn", AGENT_SRC / "agents" / "chat_researcher")


def _imports_of(path: pathlib.Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
        elif isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
    return names


def test_no_other_agent_module_imports_the_api_tier():
    """The inversion is named in one file so undoing it is a change to one file."""
    offenders = [
        str(path.relative_to(AGENT_SRC))
        for package in GUARDED
        for path in package.rglob("*.py")
        if path != pathlib.Path(api_seam.__file__).resolve()
        and any(name == "aiq_api" or name.startswith("aiq_api.") for name in _imports_of(path))
    ]
    assert offenders == [], f"aiq_api imported outside turn/api_seam.py: {offenders}"


def test_outside_a_request_nobody_asked_to_skip_the_clarifier():
    assert skip_clarifier_requested() is False


def test_auth_error_is_the_api_tiers_class():
    from aiq_api.auth.errors import AuthError as ApiAuthError

    assert AuthError is ApiAuthError
