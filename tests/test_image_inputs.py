"""An image is named by what its Dockerfile copies, and a run builds what is not built yet.

`ci/image_inputs.py` replaced two hand-written path lists that disagreed with
the Dockerfiles, and an incremental publish that lost every change of a dropped
run. Each test pins one way the name could stop meaning "these exact inputs".
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WEEK = "2026-W41"


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("image_inputs", ROOT / "ci" / "image_inputs.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # @dataclass resolves its module through sys.modules.
    sys.modules["image_inputs"] = module
    spec.loader.exec_module(module)
    return module


# --- Reading the Dockerfile ----------------------------------------------------


def test_copy_sources_reads_every_context_copy_and_skips_stage_copies(mod):
    dockerfile = """
FROM debian AS builder
# COPY commented/ ./out/
COPY pyproject.toml uv.lock ./
COPY --chown=app:app src/ ./src/
COPY --from=builder /app /app
ADD scripts/*.sh /usr/local/bin/
COPY deploy/entrypoint.py \\
     deploy/start_web.py ./deploy/
COPY ["configs/a.yml", "/etc/a.yml"]
copy lower/ ./lower/
"""
    assert mod.copy_sources(dockerfile) == [
        "pyproject.toml",
        "uv.lock",
        "src/",
        "scripts",
        "deploy/entrypoint.py",
        "deploy/start_web.py",
        "configs/a.yml",
        "lower/",
    ]


def test_copying_the_whole_context_makes_the_whole_context_an_input(mod):
    assert mod.copy_sources("FROM node\nCOPY . .\n") == ["."]


def test_the_backend_image_watches_what_its_dockerfile_copies(mod):
    # packages/ifc-spatial-py is copied into the backend image and was in
    # neither hand-written list, so a change to it never reached a published
    # image. Reading the real Dockerfile is the fix this pins.
    backend = next(image for image in mod.IMAGES if image.name == "backend")
    inputs = mod.inputs(backend)

    assert "packages/ifc-spatial-py" in inputs
    assert {"deploy/Dockerfile", "src", "uv.lock", "deploy/start_web.py"} <= set(inputs)
    assert "tests" not in inputs and "docs" not in inputs


def test_a_copy_that_leaves_the_context_is_refused(mod):
    with pytest.raises(ValueError, match="leaves the build context"):
        mod._normalise("frontends/ui", "../../etc/passwd")


# --- Hashing, on a repository of our own ---------------------------------------


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def write(repo: Path, files: dict[str, str]) -> str:
    for name, text in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "change")
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(mod, tmp_path, monkeypatch):
    git(tmp_path, "init", "-q", "-b", "develop")
    write(
        tmp_path,
        {
            "deploy/Dockerfile": "FROM debian\nCOPY src/ ./src/\nCOPY pyproject.toml ./\n",
            "src/app.py": "print(1)\n",
            "pyproject.toml": "[project]\n",
            "frontends/ui/deploy/Dockerfile": "FROM node\nCOPY . .\n",
            "frontends/ui/page.tsx": "export {}\n",
            "frontends/web/Dockerfile": "FROM node\nCOPY . .\n",
            "frontends/web/index.astro": "<p/>\n",
            "docs/readme.md": "hi\n",
        },
    )
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    return tmp_path


def test_only_an_input_change_renames_the_image(mod, repo):
    before = mod.hashes("HEAD", week=WEEK)
    write(repo, {"docs/readme.md": "changed\n"})
    assert mod.hashes("HEAD", week=WEEK) == before

    write(repo, {"src/app.py": "print(2)\n"})
    after = mod.hashes("HEAD", week=WEEK)
    assert after["backend"] != before["backend"]
    assert {k: after[k] for k in ("frontend", "web")} == {k: before[k] for k in ("frontend", "web")}


def test_a_new_week_renames_every_image_so_base_images_are_refreshed(mod, repo):
    this_week, next_week = mod.hashes("HEAD", week=WEEK), mod.hashes("HEAD", week="2026-W42")

    assert all(this_week[name] != next_week[name] for name in this_week)
    assert mod.iso_week(__import__("datetime").date(2026, 10, 9)) == WEEK


def test_a_copied_path_the_commit_does_not_track_fails_loudly(mod, repo):
    write(repo, {"deploy/Dockerfile": "FROM debian\nCOPY generated/ ./generated/\n"})

    with pytest.raises(ValueError, match="does not track"):
        mod.hashes("HEAD", week=WEEK)


def test_a_pull_request_builds_the_images_it_changes(mod, repo):
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", "-b", "feature")
    write(repo, {"frontends/ui/page.tsx": "export const x = 1\n"})
    # develop moves on under the PR; its change is not the PR's to build.
    git(repo, "checkout", "-q", "develop")
    moved = write(repo, {"src/app.py": "print(3)\n"})
    git(repo, "checkout", "-q", "feature")

    build, images = mod.plan_pull_request(moved, week=WEEK)

    assert [entry["name"] for entry in build] == ["frontend"]
    assert [entry["name"] for entry in images] == ["backend", "frontend", "web"]
    assert build[0]["repository"] == "grid-oib-frontend" and build[0]["context"] == "frontends/ui"
    assert mod.plan_pull_request(base, week=WEEK)[0] == build


@pytest.mark.parametrize(
    ("answers", "expected"),
    [
        ({"backend": True, "frontend": True, "web": True}, []),
        ({"backend": True, "frontend": False, "web": True}, ["frontend"]),
        # The registry could not say: build. An extra build costs minutes; a
        # skipped one ships the wrong code.
        ({"backend": None, "frontend": True, "web": True}, ["backend"]),
    ],
)
def test_a_push_builds_what_the_registry_does_not_have(mod, repo, answers, expected):
    asked: list[tuple[str, str]] = []

    def published(name: str, tag: str):
        asked.append((name, tag))
        return answers[name]

    build, _ = mod.plan_push(published, week=WEEK)

    assert [entry["name"] for entry in build] == expected
    hashes = mod.hashes("HEAD", week=WEEK)
    assert asked == [(name, f"inputs-{hashes[name]}") for name in ("backend", "frontend", "web")]
