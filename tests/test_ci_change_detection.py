"""Every change detector diffs a pull request against its whole base.

ci.yml, security.yml and docker-build.yml each carry their own copy of the
`paths-filter` base and the cancel policy. A copy that diffs only the last push
skips any tier a cancelled run owed, and a skipped tier counts as passed, so a
green PR can hide a check that never ran. Read the workflows, not a second copy.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

WORKFLOWS = Path(__file__).resolve().parents[1] / ".github" / "workflows"
DETECTORS = ["ci.yml", "security.yml", "docker-build.yml"]
WHOLE_PR_BASE = "${{ github.event.pull_request.base.sha || github.event.before }}"
CANCEL_ONLY_PULL_REQUESTS = "${{ github.event_name == 'pull_request' }}"


def load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", DETECTORS)
def test_the_change_filter_diffs_the_whole_pull_request(name):
    steps = load(name)["jobs"]["changes"]["steps"]
    filters = [step for step in steps if step.get("uses", "").startswith("dorny/paths-filter")]

    assert len(filters) == 1
    assert filters[0]["with"]["base"] == WHOLE_PR_BASE


@pytest.mark.parametrize("name", DETECTORS)
def test_a_push_to_a_branch_is_never_cancelled_by_a_later_one(name):
    concurrency = load(name)["concurrency"]

    assert concurrency["cancel-in-progress"] == CANCEL_ONLY_PULL_REQUESTS


@pytest.mark.parametrize("name", DETECTORS)
def test_each_push_has_its_own_group_so_no_pending_run_is_dropped(name):
    # GitHub drops a pending run when a newer run joins its group. A push's
    # group must therefore be keyed by its commit, not shared by the branch.
    group = load(name)["concurrency"]["group"]

    assert "github.sha" in group
    assert "github.ref" in group


# --- Reusing a pull request's green result on push ---------------------------
#
# CI and Security skip every job on a push whose tree a green pull_request run
# already tested (ci/reuse_green_run.py decides; tests/test_reuse_green_run.py
# pins the decision). What the workflows must keep true around it: the marker is
# written only by a passing PR gate, the lookup runs only on push, and a hit
# skips every job while a miss skips none. The job conditions are evaluated
# below rather than string-matched, so a new job that forgets the reuse output
# fails here instead of re-running (or worse, skipping) on develop.

REUSERS = {"ci.yml": ("ci-ok", "ci-green"), "security.yml": ("security-ok", "security-green")}


class Ctx(dict):
    """An expression context: dotted access, and '' for anything unset, like Actions."""

    def __getattr__(self, key):
        value = self.get(key, "")
        return Ctx(value) if isinstance(value, dict) else value


def evaluate(expression: str, **context) -> object:
    """Evaluate the small subset of Actions expressions these workflows use."""
    text = expression.strip()
    if text.startswith("${{"):
        text = text[3:-2]
    text = text.replace("&&", " and ").replace("||", " or ")
    text = re.sub(r"!(?!=)", " not ", text)
    names = {key: Ctx(value) if isinstance(value, dict) else value for key, value in context.items()}
    names |= {"always": lambda: True, "cancelled": lambda: False, "success": lambda: True}
    return eval(text, {"__builtins__": {}}, names)  # noqa: S307 - our own workflow files


def changes_outputs(workflow: dict, *, event: str, hit: str | None, tiers: str) -> dict:
    """The `changes` job's outputs, given the lookup's answer and what the filter would say."""
    job = workflow["jobs"]["changes"]
    steps = {step.get("id"): step for step in job["steps"] if step.get("id")}
    github = {"event_name": event}
    reuse_ran = evaluate(steps["reuse"]["if"], github=github)
    reuse_outputs = {"hit": hit} if reuse_ran and hit is not None else {}
    step_ctx = {"reuse": {"outputs": reuse_outputs}}
    filter_ran = evaluate(steps["filter"]["if"], github=github, steps=step_ctx)
    filter_outputs = {}
    if filter_ran:
        filter_outputs = {k: tiers for k in re.findall(r"steps\.filter\.outputs\.(\w+)", str(job["outputs"]))}
    step_ctx["filter"] = {"outputs": filter_outputs}
    return {name: evaluate(expr, github=github, steps=step_ctx) for name, expr in job["outputs"].items()}


def runs(workflow: dict, job_name: str, *, event: str, outputs: dict) -> bool:
    condition = workflow["jobs"][job_name].get("if")
    if condition is None:
        return True
    needs = {"changes": {"outputs": outputs, "result": "success"}}
    return bool(evaluate(condition, github={"event_name": event}, needs=needs))


def checked_jobs(name: str) -> list[str]:
    gate, _ = REUSERS[name]
    return [job for job in load(name)["jobs"] if job not in ("changes", gate)]


@pytest.mark.parametrize("name", REUSERS)
def test_a_hit_sets_every_tier_false_and_skips_every_job(name):
    workflow = load(name)
    outputs = changes_outputs(workflow, event="push", hit="true", tiers="true")

    tiers = {key: value for key, value in outputs.items() if key != "reused"}

    assert outputs["reused"] == "true"
    assert tiers and set(tiers.values()) == {"false"}
    assert [job for job in checked_jobs(name) if runs(workflow, job, event="push", outputs=outputs)] == []


@pytest.mark.parametrize("name", REUSERS)
@pytest.mark.parametrize("hit", ["false", None])  # a miss, and a lookup step that failed
def test_a_miss_on_push_runs_every_job_the_filter_selects(name, hit):
    workflow = load(name)
    outputs = changes_outputs(workflow, event="push", hit=hit, tiers="true")
    skipped = [job for job in checked_jobs(name) if not runs(workflow, job, event="push", outputs=outputs)]

    assert skipped == []


def test_a_push_lints_its_release_notes_and_only_a_pull_request_must_add_one():
    # A push straight to release/** has no PR run to have checked its notes, so
    # the lint steps carry no condition; only the step that reads the PR's base
    # and labels is limited to pull requests.
    steps = load("ci.yml")["jobs"]["release-note"]["steps"]
    lints = [step for step in steps if "lint" in step.get("run", "")]
    require = next(step for step in steps if "require_release_note.py" in step.get("run", ""))

    assert len(lints) == 2 and all("if" not in step for step in lints)
    # With no `no-release-note` label, the label check reads False.
    unlabelled = require["if"].replace("contains(github.event.pull_request.labels.*.name, 'no-release-note')", "False")
    for event in ("push", "pull_request"):
        assert bool(evaluate(unlabelled, github={"event_name": event})) is (event == "pull_request")


@pytest.mark.parametrize("name", REUSERS)
@pytest.mark.parametrize("event", ["pull_request", "schedule"])
def test_the_lookup_runs_only_on_push(name, event):
    if event == "schedule" and name == "ci.yml":
        pytest.skip("ci.yml has no schedule")
    workflow = load(name)
    reuse = next(step for step in workflow["jobs"]["changes"]["steps"] if step.get("id") == "reuse")
    outputs = changes_outputs(workflow, event=event, hit="true", tiers="true")

    assert reuse["if"] == "github.event_name == 'push'"
    assert outputs["reused"] == "false"
    assert evaluate(reuse["if"], github={"event_name": "push"})


def test_the_weekly_security_scan_runs_every_scan():
    workflow = load("security.yml")
    outputs = changes_outputs(workflow, event="schedule", hit="true", tiers="false")

    assert [
        job for job in checked_jobs("security.yml") if not runs(workflow, job, event="schedule", outputs=outputs)
    ] == []


@pytest.mark.parametrize("name", REUSERS)
def test_the_lookup_cannot_fail_the_run_and_can_read_artifacts(name):
    job = load(name)["jobs"]["changes"]
    reuse = next(step for step in job["steps"] if step.get("id") == "reuse")
    _, prefix = REUSERS[name]

    assert reuse["continue-on-error"] is True
    assert reuse["run"] == f"python3 ci/reuse_green_run.py {prefix}"
    assert job["permissions"] == {"contents": "read", "actions": "read"}


@pytest.mark.parametrize("name", REUSERS)
def test_the_marker_is_uploaded_only_by_a_passing_pull_request_gate(name):
    gate, prefix = REUSERS[name]
    workflow = load(name)
    steps = workflow["jobs"][gate]["steps"]
    check = next(i for i, step in enumerate(steps) if "Require needed jobs" in step.get("name", ""))
    uploads = [i for i, step in enumerate(steps) if step.get("uses", "").startswith("actions/upload-artifact")]

    assert workflow["jobs"][gate]["if"] == "always()"
    # Every job gates the marker, bar the one ci.yml leaves out on purpose (see CI OK).
    assert set(workflow["jobs"][gate]["needs"]) == set(workflow["jobs"]) - {gate, "frontend-coverage"}
    assert len(uploads) == 1 and uploads[0] > check
    upload = steps[uploads[0]]
    # No status function: the implicit success() keeps a failed check from uploading.
    assert not re.search(r"always\(\)|failure\(\)|cancelled\(\)", upload["if"])
    assert "github.event_name == 'pull_request'" in upload["if"]
    assert upload["with"]["name"] == f"{prefix}-${{{{ steps.tree.outputs.tree }}}}"
    assert int(upload["with"]["retention-days"]) <= 7
    # And no other job anywhere writes a marker.
    for other in WORKFLOWS.glob("*.yml"):
        if other.name != name:
            assert f"{prefix}-" not in other.read_text(encoding="utf-8")
