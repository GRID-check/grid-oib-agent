"""The one place the agent tier reaches into the API tier."""

from __future__ import annotations

import ast
import pathlib

from aiq_agent.turn import api_seam
from aiq_agent.turn.api_seam import AuthError
from aiq_agent.turn.api_seam import skip_clarifier_requested

AGENT_SRC = pathlib.Path(api_seam.__file__).resolve().parents[1]

#: Every module under ``aiq_agent`` that may name ``aiq_api``, relative to ``AGENT_SRC``.
#:
#: The guard walks the WHOLE package and subtracts this tuple, rather than naming the
#: packages it walks. Listing what is guarded is the shape that fails silently: the
#: previous version named ``turn`` and ``agents/researcher`` and would have passed a
#: new ``aiq_api`` import anywhere in ``memory/``, ``stages/``, ``tools/``, ``cards/``
#: or ``agents/deep_researcher`` — and it had already once named a directory that no
#: longer existed, ``rglob``-ing nothing and proving nothing. Inverted, the guarded set
#: can only shrink by someone editing this tuple, in a diff that says what it allows.
#:
#: * ``turn/api_seam.py`` IS the seam; its module docstring is the rule.
#: * ``auth/utils.py`` and ``auth/workos_validator.py`` carry their own, older
#:   inversion, predating this seam and not this seam's to undo. They are exempt so
#:   the guard can be repo-wide, not because they are approved.
EXEMPT = (
    pathlib.Path("turn/api_seam.py"),
    pathlib.Path("auth/utils.py"),
    pathlib.Path("auth/workos_validator.py"),
)


def _imports_of(path: pathlib.Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
        elif isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
    return names


def test_every_exemption_still_exists():
    """An exemption for a file that moved silently widens the guard's blind spot."""
    missing = [str(relative) for relative in EXEMPT if not (AGENT_SRC / relative).is_file()]
    assert missing == [], f"EXEMPT names a module that no longer exists: {missing}"


def test_the_guard_actually_walks_the_package():
    """Anti-vacuity: a walk that finds nothing to check passes for the wrong reason."""
    modules = [path for path in AGENT_SRC.rglob("*.py") if "__pycache__" not in path.parts]
    assert len(modules) > 100, f"only {len(modules)} modules found under {AGENT_SRC}"


def test_no_other_agent_module_imports_the_api_tier():
    """The inversion is named in one file so undoing it is a change to one file."""
    exempt = {(AGENT_SRC / relative).resolve() for relative in EXEMPT}
    offenders = [
        str(path.relative_to(AGENT_SRC))
        for path in sorted(AGENT_SRC.rglob("*.py"))
        if "__pycache__" not in path.parts
        and path.resolve() not in exempt
        and any(name == "aiq_api" or name.startswith("aiq_api.") for name in _imports_of(path))
    ]
    assert offenders == [], f"aiq_api imported outside turn/api_seam.py: {offenders}"


def test_outside_a_request_nobody_asked_to_skip_the_clarifier():
    assert skip_clarifier_requested() is False


def test_auth_error_is_the_api_tiers_class():
    from aiq_api.auth.errors import AuthError as ApiAuthError

    assert AuthError is ApiAuthError
