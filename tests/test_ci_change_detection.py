"""Every change detector diffs a pull request against its whole base.

ci.yml, security.yml and docker-build.yml each carry their own copy of the
`paths-filter` base and the cancel policy. A copy that diffs only the last push
skips any tier a cancelled run owed, and a skipped tier counts as passed, so a
green PR can hide a check that never ran. Read the workflows, not a second copy.
"""

from __future__ import annotations

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
