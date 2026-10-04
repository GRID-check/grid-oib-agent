"""The PR template must satisfy the hygiene check applied to every PR body."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_pr_template_does_not_trigger_closing_keywords_check() -> None:
    workflow = (ROOT / ".github" / "workflows" / "pr.yml").read_text(encoding="utf-8")
    declaration = re.search(r"^\s+pattern='([^']+)'$", workflow, re.MULTILINE)
    assert declaration is not None, "The closing-keywords workflow must declare its validation pattern"

    pattern = re.compile(declaration.group(1), re.IGNORECASE)
    assert pattern.search("Fixes #1, #2") is not None
    assert pattern.search("Fixes #1, fixes #2") is None

    template = (ROOT / ".github" / "pull_request_template.md").read_text(encoding="utf-8")
    assert pattern.search(template) is None, "The template itself triggers the Closing keywords check"
