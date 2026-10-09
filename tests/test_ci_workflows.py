"""How the workflows fit together, pinned by evaluating their own conditions.

Each test below is a rule CI used to break silently, because a skipped job
counts as passed and a workflow that runs nothing still reports green:

- a push diffed against the previous push, so a red commit's tier stopped
  running as soon as an unrelated commit landed on top of it;
- a reused pull request result counted on top of a red parent;
- images were tagged for a commit whose checks had failed, or not at all;
- the deploy ran for something other than a green push to develop.

The job conditions are evaluated, not string-matched, so a new job that forgets
the plan fails here instead of running on every merge (or never).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"


def load(name: str) -> dict:
    data = yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))
    # YAML 1.1 reads the bare key `on` as True.
    if True in data:
        data["on"] = data.pop(True)
    return data


class Ctx(dict):
    """An expression context: dotted access, and a falsy empty value for anything unset, like Actions."""

    def __getattr__(self, key):
        value = self.get(key, {})
        return Ctx(value) if isinstance(value, dict) else value

    __getitem__ = __getattr__


def evaluate(expression: str, **context) -> object:
    """Evaluate the small subset of Actions expressions these workflows use."""
    text = " ".join(str(expression).split())
    if text.startswith("${{"):
        text = text[3:-2]
    text = text.replace("&&", " and ").replace("||", " or ")
    text = re.sub(r"!(?!=)", " not ", text)
    # `steps.green.outputs.parent-is-green`: a hyphenated name is an index.
    text = re.sub(r"\.(\w+(?:-\w+)+)", r"['\1']", text)
    # `needs.*.result`: every needed job's result.
    text = text.replace("needs.*.result", "[job.result for job in needs.values()]")
    names = {key: Ctx(value) if isinstance(value, dict) else value for key, value in context.items()}
    names |= {
        "always": lambda: True,
        "cancelled": lambda: False,
        "success": lambda: True,
        "contains": lambda haystack, needle: needle in haystack,
    }
    return eval(text, {"__builtins__": {}}, names)  # noqa: S307 - our own workflow files


CI = load("ci.yml")
JOBS = CI["jobs"]
PLAN = JOBS["changes"]
STEPS = {step["id"]: step for step in PLAN["steps"] if "id" in step}
TIERS = ["backend", "frontend", "web", "infra", "packages", "sast"]
BUILD = json.dumps([{"name": "backend"}])


def plan(*, event: str, parent_green: bool = False, hit: str | None = None, build: str = BUILD) -> dict:
    """The plan job's outputs, given what each of its scripts would answer."""
    github = {"event_name": event}
    steps: dict = {}
    if evaluate(STEPS["green"]["if"], github=github):
        steps["green"] = {"outputs": {"sha": "f" * 40, "parent-is-green": "true" if parent_green else "false"}}
    if evaluate(STEPS["reuse"]["if"], github=github, steps=steps) and hit is not None:
        steps["reuse"] = {"outputs": {"hit": hit}}
    if evaluate(STEPS["filter"]["if"], github=github, steps=steps):
        steps["filter"] = {"outputs": dict.fromkeys(TIERS, "true")}
    steps["images"] = {"outputs": {"build": build, "images": "[]"}}
    if evaluate(STEPS["pins"]["if"], github=github, steps=steps):
        steps["pins"] = {"outputs": {"pins": '["x@sha256:' + "0" * 64 + '"]'}}
    return {name: evaluate(expr, github=github, steps=steps) for name, expr in PLAN["outputs"].items()}


def runs(job: str, *, event: str, outputs: dict) -> bool:
    condition = JOBS[job].get("if")
    if condition is None:
        return True
    needs = {"changes": {"outputs": outputs, "result": "success"}}
    return bool(evaluate(condition, github={"event_name": event}, needs=needs))


# Jobs that check the change. A reused push skips all of them.
CHECKS = [job for job in JOBS if job not in ("changes", "ci-ok", "publish", "image", "image-push")]


# --- What a run diffs against ------------------------------------------------


def test_a_pull_request_diffs_its_whole_base_and_a_push_its_last_green_commit():
    base = STEPS["filter"]["with"]["base"]
    pins = STEPS["pins"]["env"]["BASE"]

    assert base == pins == "${{ github.event.pull_request.base.sha || steps.green.outputs.sha }}"


def test_no_workflow_diffs_against_the_previous_push():
    # `github.event.before` is the commit before THIS push: after a red commit,
    # or a dropped queued run, it hides a tier that still owes a run.
    for path in WORKFLOWS.glob("*.yml"):
        assert "github.event.before" not in path.read_text(encoding="utf-8"), path.name


def test_the_last_green_lookup_runs_on_push_and_may_not_fail_quietly():
    green = STEPS["green"]

    assert evaluate(green["if"], github={"event_name": "push"})
    assert not evaluate(green["if"], github={"event_name": "pull_request"})
    # Its script falls back to the root commit itself; a crash must be loud,
    # not an empty base.
    assert "continue-on-error" not in green
    assert green["run"] == "python3 ci/last_green.py"


# --- Concurrency -----------------------------------------------------------------


def test_a_branch_coalesces_its_pushes_and_a_pull_request_cancels_its_older_run():
    concurrency = CI["concurrency"]

    # One group per branch, not per commit: a queued push is replaced by the
    # newer one, which diffs against the last green commit and so covers it.
    assert "github.sha" not in concurrency["group"]
    assert "github.ref" in concurrency["group"] and "github.event_name" in concurrency["group"]
    # A running push is never cancelled, so a merge train cannot starve CI.
    assert concurrency["cancel-in-progress"] == "${{ github.event_name == 'pull_request' }}"


# --- Reusing a pull request's green result ----------------------------------------


def test_a_reused_push_skips_every_check_but_still_publishes():
    outputs = plan(event="push", parent_green=True, hit="true")

    assert outputs["reused"] == "true"
    assert {outputs[tier] for tier in TIERS} == {"false"}
    assert outputs["pins"] == "[]"
    assert [job for job in CHECKS if runs(job, event="push", outputs=outputs)] == []
    # The pull request built its images and pushed none, so the push must.
    assert runs("image-push", event="push", outputs=outputs)


def test_a_pull_request_result_counts_only_on_a_green_parent():
    # The PR run skipped every tier it did not touch. On a red parent those
    # tiers are exactly the ones that are broken.
    outputs = plan(event="push", parent_green=False, hit="true")

    assert outputs["reused"] == "false"
    assert [job for job in CHECKS if not runs(job, event="push", outputs=outputs) and job != "semgrep"] == [
        "frontend-coverage"
    ]


@pytest.mark.parametrize("hit", ["false", None])  # a miss, and a lookup step that failed
def test_a_miss_runs_every_check_the_filter_selects(hit):
    outputs = plan(event="push", parent_green=True, hit=hit)
    skipped = [job for job in CHECKS if not runs(job, event="push", outputs=outputs)]

    # Diff-aware SAST and the coverage comment have nothing to do on a push.
    assert skipped == ["semgrep", "frontend-coverage"]


def test_a_pull_request_runs_every_check_the_filter_selects():
    outputs = plan(event="pull_request")

    assert [job for job in CHECKS if not runs(job, event="pull_request", outputs=outputs)] == []
    assert runs("image", event="pull_request", outputs=outputs)
    assert not runs("image-push", event="pull_request", outputs=outputs)


def test_the_reuse_lookup_cannot_fail_the_run():
    reuse = STEPS["reuse"]

    assert reuse["continue-on-error"] is True
    assert reuse["run"] == "python3 ci/reuse_green_run.py ci-green"
    assert PLAN["permissions"] == {"contents": "read", "actions": "read", "packages": "read"}


def test_the_marker_is_uploaded_only_by_a_passing_pull_request_gate():
    steps = JOBS["ci-ok"]["steps"]
    check = next(i for i, step in enumerate(steps) if "Require needed jobs" in step.get("name", ""))
    uploads = [i for i, step in enumerate(steps) if step.get("uses", "").startswith("actions/upload-artifact")]

    assert JOBS["ci-ok"]["if"] == "always()"
    # Every job gates the marker, bar the coverage comment (see CI OK).
    assert set(JOBS["ci-ok"]["needs"]) == set(JOBS) - {"ci-ok", "frontend-coverage"}
    assert len(uploads) == 1 and uploads[0] > check
    upload = steps[uploads[0]]
    # No status function: the implicit success() keeps a failed check from uploading.
    assert not re.search(r"always\(\)|failure\(\)|cancelled\(\)", upload["if"])
    assert "github.event_name == 'pull_request'" in upload["if"]
    assert upload["with"]["name"] == "ci-green-${{ steps.tree.outputs.tree }}"
    assert int(upload["with"]["retention-days"]) <= 7
    for other in WORKFLOWS.glob("*.yml"):
        if other.name != "ci.yml":
            assert "ci-green-" not in other.read_text(encoding="utf-8")


# --- Images ------------------------------------------------------------------------


def test_only_a_push_can_write_to_the_registry():
    for name, job in JOBS.items():
        packages = (job.get("permissions") or {}).get("packages")
        if packages == "write":
            assert name in ("image-push", "publish")
            assert not runs(name, event="pull_request", outputs=plan(event="pull_request"))
    assert CI.get("permissions") == {"contents": "read"}
    assert JOBS["image"]["permissions"]["packages"] == "read"
    pushes = [step for step in JOBS["image"]["steps"] if step.get("with", {}).get("push")]
    assert pushes == []


def test_no_image_job_runs_with_an_empty_build_plan():
    outputs = plan(event="push", build="[]")

    assert not runs("image-push", event="push", outputs=outputs)
    assert not runs("image", event="pull_request", outputs=plan(event="pull_request", build="[]"))


def test_the_commit_is_tagged_only_after_every_check_on_its_push_passed():
    publish = JOBS["publish"]
    can_run_on_push = {job for job in CHECKS if runs(job, event="push", outputs=plan(event="push"))}

    assert can_run_on_push - {"frontend-coverage"} <= set(publish["needs"])
    assert "image-push" in publish["needs"]
    condition = " ".join(publish["if"].split())
    assert "github.event_name == 'push'" in condition
    assert "needs.changes.result == 'success'" in condition
    assert "!contains(needs.*.result, 'failure')" in condition
    assert "!contains(needs.*.result, 'cancelled')" in condition
    # And the gate waits for it, so a green push run means tagged images.
    assert "publish" in JOBS["ci-ok"]["needs"]


# --- Release notes ------------------------------------------------------------------


def test_a_push_lints_its_release_notes_and_a_pull_request_must_add_one():
    steps = JOBS["repo"]["steps"]
    lint = next(step for step in steps if step.get("run") == "task release:lint")
    require = next(step for step in steps if "require_release_note.py" in step.get("run", ""))

    assert "if" not in lint
    assert evaluate(require["if"], github={"event_name": "pull_request"})
    assert not evaluate(require["if"], github={"event_name": "push"})
    # The label is read live, so labelling and re-running is enough.
    assert "labels.*.name" not in require["if"]
    assert "no-release-note" in require["run"]


# --- Security -----------------------------------------------------------------------


def test_security_is_surveillance_and_the_gate_lives_in_ci():
    triggers = set(load("security.yml")["on"])

    assert triggers == {"schedule", "workflow_dispatch"}
    assert "gitleaks" in json.dumps(JOBS["repo"])
    assert JOBS["semgrep"]["container"]["image"].split(":")[1][0].isdigit()  # pinned


# --- Deploy -------------------------------------------------------------------------

DEPLOY = load("deploy.yml")


def test_staging_deploys_follow_ci_and_nothing_else():
    trigger = DEPLOY["on"]["workflow_run"]

    assert trigger == {"workflows": ["CI"], "types": ["completed"], "branches": ["develop"]}
    assert "gate" not in DEPLOY["jobs"]


@pytest.mark.parametrize(
    ("run", "deploys"),
    [
        ({"conclusion": "success", "event": "push", "head_repository": {"full_name": "acme/grid"}}, True),
        ({"conclusion": "cancelled", "event": "push", "head_repository": {"full_name": "acme/grid"}}, False),
        ({"conclusion": "failure", "event": "push", "head_repository": {"full_name": "acme/grid"}}, False),
        # A pull request whose head branch is called `develop` passes the
        # `branches` filter; it must not reach a job holding stack credentials.
        ({"conclusion": "success", "event": "pull_request", "head_repository": {"full_name": "acme/grid"}}, False),
        ({"conclusion": "success", "event": "push", "head_repository": {"full_name": "fork/grid"}}, False),
    ],
)
def test_staging_deploys_only_a_green_push_run_of_this_repository(run, deploys):
    condition = DEPLOY["jobs"]["deploy"]["if"]
    github = {"event_name": "workflow_run", "repository": "acme/grid", "event": {"workflow_run": run}}

    assert bool(evaluate(condition, github=github, inputs={})) is deploys
    assert not evaluate(DEPLOY["jobs"]["deploy-prod"]["if"], github=github, inputs={})
