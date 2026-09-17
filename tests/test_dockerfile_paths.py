"""Every path the image installs must exist in the tree.

`deploy/Dockerfile` names workspace packages one by one rather than globbing,
which is deliberate — the install order is the dependency order and a glob
would hide it. The cost is that deleting a package leaves a line behind, and
**nothing else in the repo catches that**: `task verify` never builds an image,
so a stale path is invisible until `Build backend image` fails in CI, minutes
into a run, on a PR that passed every local gate.

That is exactly what happened. `32c8460` deleted `sources/exa_web_search` and
`c4fe0df` deleted three more sources; the Dockerfile went on installing two of
them, and the first anyone knew was a red image build.

These tests are the ratchet: they read the real Dockerfile and assert every
`-e ./path` it installs is a directory with a `pyproject.toml`. Deleting a
package now fails a second-long unit test instead of a five-minute image build.
"""

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = REPO_ROOT / "deploy" / "Dockerfile"

# `uv pip install --no-deps -e ./sources/foo` and `-e "./sources/foo[all]"`.
# The quotes and the extras marker are both optional; the path is what matters.
_EDITABLE = re.compile(r"""-e\s+"?(\./[^"\s\[]+)(?:\[[^\]]*\])?"?""")


def _editable_paths() -> list[str]:
    return _EDITABLE.findall(DOCKERFILE.read_text(encoding="utf-8"))


def test_the_dockerfile_is_where_this_test_thinks_it_is() -> None:
    """A moved Dockerfile must fail loudly, not silently pass with zero paths."""
    assert DOCKERFILE.is_file(), f"{DOCKERFILE} not found — this test would otherwise assert nothing"


def test_the_dockerfile_installs_something() -> None:
    """Guards the regex itself: a syntax change that matches nothing is a silent pass."""
    assert _editable_paths(), "no editable installs parsed out of the Dockerfile — the regex has gone stale"


@pytest.mark.parametrize("path", _editable_paths())
def test_every_installed_path_exists(path: str) -> None:
    target = REPO_ROOT / path
    assert target.is_dir(), (
        f"deploy/Dockerfile installs {path}, which does not exist. Delete the line or restore the package."
    )
    assert (target / "pyproject.toml").is_file(), (
        f"deploy/Dockerfile installs {path}, which has no pyproject.toml, so `uv pip install -e` will fail."
    )
