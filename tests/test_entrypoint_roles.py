"""``deploy/entrypoint.py`` starts the four roles of the image and refuses every other name (ADR-0082).

``GRID_ROLE`` has no default and ``web`` is not a value: a container that does
not say which job it does stops at once, with the names it may take, instead of
serving a route set nobody sized it for. Run as a subprocess because ``main()``
replaces the process (``execvp``) for the roles that start one.
"""

from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "deploy" / "entrypoint.py"


def _run(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    clean = {k: v for k, v in os.environ.items() if k != "GRID_ROLE"}
    return subprocess.run(
        [sys.executable, str(ENTRYPOINT)], env={**clean, **env}, capture_output=True, text=True, timeout=60, check=False
    )


@pytest.mark.parametrize("env", [{}, {"GRID_ROLE": ""}, {"GRID_ROLE": "web"}, {"GRID_ROLE": "researcher"}])
def test_a_missing_or_unknown_role_exits_non_zero_and_names_the_roles(env):
    result = _run(env)

    assert result.returncode != 0
    assert "GRID_ROLE" in result.stderr
    for role in ("chat", "api", "worker", "ingest-worker"):
        assert role in result.stderr


def test_the_roles_the_entrypoint_accepts_are_the_four_of_the_image():
    tree = ast.parse(ENTRYPOINT.read_text())
    roles = next(
        ast.literal_eval(node.value)
        for node in tree.body
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "ROLES" for t in node.targets)
    )

    assert roles == ("chat", "api", "worker", "ingest-worker")
