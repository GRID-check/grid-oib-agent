"""Every Bun this repo installs is the one `.github/actions/setup-bun` pins.

CI installs Bun through that action; the images copy the binary out of an
`oven/bun:<version>-slim` image; a cloud session installs it in its start hook.
Three places, and nothing tied them together: CI and both images sat on 1.3.11
while sessions ran 1.4.2, under a Dockerfile comment asking for lockstep.

Since `task fe:types` is `bun check`, the Bun version IS the type checker's
version, so a drift here is a gate that passes in one place and fails in
another. These tests read the real files and fail on the first one that names
another version.
"""

import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SETUP_BUN = REPO_ROOT / ".github" / "actions" / "setup-bun" / "action.yml"

# `COPY --from=oven/bun:1.4.3-slim ...` and `FROM oven/bun:1.4.3-slim`.
_IMAGE_TAG = re.compile(r"oven/bun:(\d+\.\d+\.\d+)")


def _pinned() -> str:
    match = re.search(r'default:\s*"(\d+\.\d+\.\d+)"', SETUP_BUN.read_text(encoding="utf-8"))
    assert match, f"{SETUP_BUN} declares no exact default Bun version"
    return match.group(1)


def _dockerfiles() -> list[Path]:
    """The Dockerfiles git tracks: what the repo ships, not whatever lies on disk.

    A walk of the directory also found the Dockerfiles inside agent worktrees
    under `.claude/worktrees/` (another checkout, often of an older commit) and
    failed the gate on files this tree does not contain.
    """
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--", "*Dockerfile*"], cwd=REPO_ROOT, capture_output=True, check=True
    ).stdout.decode("utf-8")
    return sorted(REPO_ROOT / name for name in listed.split("\0") if name and (REPO_ROOT / name).is_file())


def test_the_images_copy_bun_from_somewhere() -> None:
    """A renamed image or a dropped COPY must fail loudly, not pass on zero matches."""
    tagged = [path for path in _dockerfiles() if _IMAGE_TAG.search(path.read_text(encoding="utf-8"))]
    assert tagged, "no Dockerfile copies Bun from an oven/bun image; this test would assert nothing"


@pytest.mark.parametrize("dockerfile", _dockerfiles(), ids=lambda p: str(p.relative_to(REPO_ROOT)))
def test_every_image_copies_the_pinned_bun(dockerfile: Path) -> None:
    pinned = _pinned()
    for version in _IMAGE_TAG.findall(dockerfile.read_text(encoding="utf-8")):
        assert version == pinned, (
            f"{dockerfile.relative_to(REPO_ROOT)} copies Bun {version}, but setup-bun pins {pinned}. "
            "Bump both in the same change."
        )


def test_the_session_hook_reads_the_pin_rather_than_naming_one() -> None:
    hook = (REPO_ROOT / ".claude" / "hooks" / "session-start.sh").read_text(encoding="utf-8")
    assert ".github/actions/setup-bun/action.yml" in hook, "the session hook no longer installs the pinned Bun"
    assert not re.search(r"bun@\d", hook), "the session hook names a Bun version instead of reading setup-bun's"
