"""Run the real metadata-only workflow step, not a second copy of its matcher."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "pr.yml"


def run_check(body: str) -> subprocess.CompletedProcess[str]:
    workflow = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["closing-keywords"]["steps"]
    assert len(steps) == 1
    step = steps[0]
    assert step["shell"] == "python"
    assert step["env"]["BODY"] == "${{ github.event.pull_request.body }}"
    assert "${{" not in step["run"]
    return subprocess.run(
        [sys.executable, "-c", step["run"]],
        env={**os.environ, "BODY": body},
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize(
    "body",
    [
        "",
        "Fixes #1, fixes #2",
        "Closes #1 and resolves #2",
        "Fixes: #1\nResolves #2",
        "Relates to #1, #2",
        "<!-- Fixes #1, #2 -->",
        '<!-- Guidance:\n"Fixes #1, fixes #2". "Fixes #1, #2" closes only #1.\n-->',
        "<!-- Fixes #1, #2 --><!-- Resolves #3 and #4 -->\nFixes #5",
        "<!-- Fixes #1, #2 -->\nFixes #3, fixes #4",
        "__import__('os').environ.clear()\nFixes #1, fixes #2",
    ],
)
def test_ignores_hidden_guidance_but_accepts_valid_references(body: str) -> None:
    result = run_check(body)
    assert result.returncode == 0, result.stderr
    assert "::error::" not in result.stdout


@pytest.mark.parametrize(
    "body",
    [
        "Fixes #1, #2",
        "fix #1 and #2",
        "Fixed: #1 & #2",
        "CLOSES #1, #2",
        "closed #1 and #2",
        "Resolve #1, #2",
        "resolved #1 & #2",
        "resolves #1 and #2",
        "Fixes #1,\n#2",
        "<!-- Correct guidance: Fixes #1, fixes #2 -->\nFixes #3, #4",
        "Fixes #1<!-- hidden guidance -->, #2",
    ],
)
def test_still_rejects_visible_keyword_followed_by_issue_list(body: str) -> None:
    result = run_check(body)
    assert result.returncode == 1, result.stderr
    assert "::error::A closing keyword is followed by a list of issues" in result.stdout


def test_repository_template_passes() -> None:
    template = (ROOT / ".github" / "pull_request_template.md").read_text(encoding="utf-8")
    result = run_check(template)
    assert result.returncode == 0, result.stderr
