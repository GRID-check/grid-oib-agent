"""A push diffs against the newest commit CI passed, and anything doubtful widens the diff.

`ci/last_green.py` picks the base a push's path filter diffs against. Picking
too new a commit skips a tier that still owes a run, and a skipped tier counts
as passed; picking too old only runs more. So every refusal below errs old.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = "acme/grid"
PATH = ".github/workflows/ci.yml"
HEAD = "h" * 40


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("last_green", ROOT / "ci" / "last_green.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def run(sha: str, **overrides) -> dict:
    return {
        "head_sha": sha,
        "event": "push",
        "conclusion": "success",
        "path": PATH,
        "head_repository": {"full_name": REPO},
        **overrides,
    }


def find(mod, runs: list[dict], ancestors: set[str]) -> tuple[str | None, list[str]]:
    asked: list[str] = []

    def get(path: str):
        asked.append(path)
        return {"workflow_runs": runs}

    found = mod.find(get, repo=REPO, path=PATH, branch="develop", head=HEAD, is_ancestor=ancestors.__contains__)
    return found, asked


def test_the_newest_green_ancestor_wins(mod):
    a, b = "a" * 40, "b" * 40
    found, asked = find(mod, [run(a), run(b)], {a, b})

    assert found == a
    query = "branch=develop&event=push&status=success&per_page=50"
    assert asked == [f"/repos/{REPO}/actions/workflows/ci.yml/runs?{query}"]


@pytest.mark.parametrize(
    "rejected",
    [
        run("n" * 40),  # not an ancestor: another branch's history, or a force-push
        run(HEAD),  # HEAD itself: a re-run must re-test, not diff against itself
        run("p" * 40, event="pull_request"),  # a PR run proves nothing about the branch
        run("f" * 40, conclusion="failure"),
        run("o" * 40, path=".github/workflows/security.yml"),
        run("k" * 40, head_repository={"full_name": "fork/grid"}),
        run("not-a-sha"),
    ],
)
def test_anything_that_does_not_prove_the_branch_green_is_stepped_over(mod, rejected):
    older = "c" * 40
    ancestors = {older, HEAD} | {rejected["head_sha"]} - {"n" * 40}

    assert find(mod, [rejected, run(older)], ancestors)[0] == older


def test_no_green_ancestor_means_no_base(mod):
    assert find(mod, [run("n" * 40)], set())[0] is None
    assert find(mod, [], set())[0] is None


def test_a_failed_lookup_widens_the_diff_and_keeps_the_output_parseable(mod, monkeypatch, tmp_path):
    # The reason feeds the Plan job's summary. An exception message spanning
    # lines must not end the value early: GitHub rejects an output file with a
    # line that is not `key=value`, and the step would fail instead of widening.
    commits = {("rev-parse", "HEAD"): HEAD, ("rev-list", "--max-parents=0", "HEAD"): "r" * 40}
    monkeypatch.setattr(mod, "_git", lambda *args: commits.get(args, f"{HEAD} {'p' * 40}"))

    def broken(*_args, **_kwargs):
        raise RuntimeError("HTTP 502\nupstream gone")

    monkeypatch.setattr(mod, "find", broken)
    output = tmp_path / "out"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    monkeypatch.setenv("GITHUB_WORKFLOW_REF", f"{REPO}/{PATH}@refs/heads/develop")

    assert mod.main() == 0
    values = dict(line.split("=", 1) for line in output.read_text().splitlines())
    assert values["sha"] == "r" * 40 and values["found"] == "false" and values["parent-is-green"] == "false"
    assert values["reason"].startswith("lookup failed (RuntimeError: HTTP 502 upstream gone)")
