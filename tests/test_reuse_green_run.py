"""A push reuses a pull request's green result only when that run proves the same tree.

`ci/reuse_green_run.py` decides whether CI and Security on a push to `develop`
may skip their jobs. Every way the decision can go wrong skips a check that
never ran, so each refusal is pinned here against fake API responses, and so is
the fallback: an error is a miss, and a miss runs everything.
"""

from __future__ import annotations

import importlib.util
import urllib.error
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = "acme/grid"
WORKFLOW = ".github/workflows/ci.yml"
WORKFLOW_REF = f"{REPO}/{WORKFLOW}@refs/heads/develop"
TREE = "a" * 40
BLOB = "b" * 40
HEAD = "c" * 40
NAME = f"ci-green-{TREE}"


@pytest.fixture(scope="module")
def reuse():
    spec = importlib.util.spec_from_file_location("reuse_green_run", ROOT / "ci" / "reuse_green_run.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def green_run(**overrides) -> dict:
    run = {
        "id": 7,
        "status": "completed",
        "conclusion": "success",
        "event": "pull_request",
        "path": WORKFLOW,
        "head_sha": HEAD,
        "head_repository": {"full_name": REPO},
        "repository": {"full_name": REPO},
        "html_url": "https://github.com/acme/grid/actions/runs/7",
    }
    return {**run, **overrides}


def artifact(**overrides) -> dict:
    return {"id": 1, "name": NAME, "expired": False, "workflow_run": {"id": 7}, **overrides}


def fake_api(*, artifacts: list[dict], run: dict | None = None, blob: str = BLOB):
    """A GitHub API that knows one run and one workflow file, and records what was asked."""
    calls: list[str] = []

    def get(path: str):
        calls.append(path)
        if path.startswith(f"/repos/{REPO}/actions/artifacts?"):
            assert f"name={NAME}" in path
            return {"total_count": len(artifacts), "artifacts": artifacts}
        if path == f"/repos/{REPO}/actions/runs/7" and run is not None:
            return run
        if path == f"/repos/{REPO}/contents/{WORKFLOW}?ref={HEAD}":
            return {"sha": blob}
        raise urllib.error.HTTPError(path, 404, "Not Found", hdrs=None, fp=None)

    get.calls = calls
    return get


def decide(reuse, get, **overrides):
    args = {"prefix": "ci-green", "tree": TREE, "blob": BLOB, "repo": REPO, "workflow_ref": WORKFLOW_REF}
    return reuse.decide(get, **{**args, **overrides})


def test_a_green_pull_request_run_of_the_same_tree_is_a_hit(reuse):
    hit, message = decide(reuse, fake_api(artifacts=[artifact()], run=green_run()))

    assert hit
    assert "actions/runs/7" in message


def test_no_artifact_for_the_tree_is_a_miss(reuse):
    hit, message = decide(reuse, fake_api(artifacts=[]))

    assert not hit
    assert "no artifact" in message


def test_an_artifact_for_another_name_is_ignored(reuse):
    # The API filters by name, but the decision must not trust that it did.
    other = artifact(name=f"ci-green-{'d' * 40}")

    assert decide(reuse, fake_api(artifacts=[other], run=green_run()))[0] is False


def test_an_expired_artifact_is_a_miss(reuse):
    hit, message = decide(reuse, fake_api(artifacts=[artifact(expired=True)], run=green_run()))

    assert not hit
    assert "expired" in message


@pytest.mark.parametrize(
    ("status", "conclusion"),
    [("completed", "failure"), ("completed", "cancelled"), ("completed", "skipped"), ("in_progress", None)],
)
def test_a_run_that_did_not_conclude_success_is_a_miss(reuse, status, conclusion):
    # The marker is uploaded by the gate job before the run ends. A run that was
    # cancelled or failed afterwards (or is still going) proves nothing.
    run = green_run(status=status, conclusion=conclusion)

    assert decide(reuse, fake_api(artifacts=[artifact()], run=run))[0] is False


def test_a_fork_run_is_a_miss(reuse):
    run = green_run(head_repository={"full_name": "mallory/grid"})
    hit, message = decide(reuse, fake_api(artifacts=[artifact()], run=run))

    assert not hit
    assert "fork" in message


@pytest.mark.parametrize("event", ["push", "workflow_dispatch", "schedule", "pull_request_target"])
def test_only_a_pull_request_run_counts(reuse, event):
    assert decide(reuse, fake_api(artifacts=[artifact()], run=green_run(event=event)))[0] is False


def test_a_run_of_another_workflow_is_a_miss(reuse):
    run = green_run(path=".github/workflows/security.yml")

    assert decide(reuse, fake_api(artifacts=[artifact()], run=run))[0] is False


def test_the_run_path_may_carry_its_ref(reuse):
    run = green_run(path=f"{WORKFLOW}@refs/pull/12/merge")

    assert decide(reuse, fake_api(artifacts=[artifact()], run=run))[0] is True


def test_a_run_whose_workflow_file_differs_is_a_miss(reuse):
    # A pull request runs the workflow from its own branch, so an unreviewed PR
    # could edit the upload step to mint a marker for any tree. Pinning the file
    # to the pushed commit's copy closes that.
    hit, message = decide(reuse, fake_api(artifacts=[artifact()], run=green_run(), blob="e" * 40))

    assert not hit
    assert "different" in message


def test_one_qualifying_artifact_among_rejected_ones_is_a_hit(reuse):
    artifacts = [artifact(id=1, expired=True), artifact(id=2)]

    assert decide(reuse, fake_api(artifacts=artifacts, run=green_run()))[0] is True


def test_an_api_error_is_a_miss(reuse):
    def get(path: str):
        raise urllib.error.HTTPError(path, 403, "Resource not accessible by integration", hdrs=None, fp=None)

    hit, message = decide(reuse, get)

    assert not hit
    assert "lookup failed" in message


def test_a_malformed_response_is_a_miss(reuse):
    assert decide(reuse, lambda path: ["not", "an", "object"])[0] is False


def test_an_unreadable_tree_is_a_miss_without_asking_the_api(reuse):
    get = fake_api(artifacts=[artifact()], run=green_run())

    assert decide(reuse, get, tree="")[0] is False
    assert get.calls == []


def test_a_workflow_ref_from_another_repository_is_a_miss(reuse):
    get = fake_api(artifacts=[artifact()], run=green_run())

    assert decide(reuse, get, workflow_ref=f"mallory/grid/{WORKFLOW}@refs/heads/develop")[0] is False


def test_main_writes_false_and_exits_zero_when_the_lookup_fails(reuse, tmp_path, monkeypatch):
    output = tmp_path / "out"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    monkeypatch.setenv("GITHUB_WORKFLOW_REF", WORKFLOW_REF)
    monkeypatch.setattr(reuse, "_git", lambda *args: TREE if args[-1] == "HEAD^{tree}" else BLOB)
    monkeypatch.setattr(reuse, "github_get", lambda api_url, token: fake_api(artifacts=[]))

    assert reuse.main(["ci-green"]) == 0
    assert output.read_text() == "hit=false\n"


def test_main_writes_true_on_a_hit(reuse, tmp_path, monkeypatch):
    output = tmp_path / "out"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)
    monkeypatch.setenv("GITHUB_WORKFLOW_REF", WORKFLOW_REF)
    monkeypatch.setattr(reuse, "_git", lambda *args: TREE if args[-1] == "HEAD^{tree}" else BLOB)
    monkeypatch.setattr(reuse, "github_get", lambda api_url, token: fake_api(artifacts=[artifact()], run=green_run()))

    assert reuse.main(["ci-green"]) == 0
    assert output.read_text() == "hit=true\n"
