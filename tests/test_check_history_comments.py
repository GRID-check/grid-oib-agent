"""`scripts/check_history_comments.py`: comments say what is true now; it refuses the ones that narrate history."""

import importlib.util
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "check_history_comments", Path(__file__).resolve().parents[1] / "scripts" / "check_history_comments.py"
)
check = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(check)


def _hits(tmp_path, name: str, text: str) -> list[str]:
    path = tmp_path / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return [line for _, line in check.history_in(path)]


@pytest.mark.parametrize(
    "comment",
    [
        "# Since 2026-10-06 the write is refused.",
        "# Measured on 7 Oct 2026.",
        "# It used to read the snapshot.",
        "# This used to be one binary.",
        "# The matcher was originally lexical.",
        "# Found by an independent review.",
        "# The helper was renamed in the refactor.",
        "# The old code asked the classifier.",
        "# An agent built before ticket 1 still parses it.",
        "# Reverts commit 3df0cff4c.",
        "# Fixed in PR #855.",
        "# Until 8 Oct it read only the Land.",
    ],
)
def test_a_python_comment_that_narrates_history_is_refused(tmp_path, comment):
    assert _hits(tmp_path, "m.py", f"x = 1  {comment}\n")


def test_a_docstring_is_read_like_a_comment(tmp_path):
    assert _hits(tmp_path, "m.py", 'def f():\n    """It used to sleep here."""\n    return 1\n')


@pytest.mark.parametrize(
    "comment",
    [
        "// The key used to sign the token.",
        "/* What the queue is used to order. */",
        "// The example value `2026-10-01` parses as local midnight.",
        "// A write is refused (ADR-0085).",
    ],
)
def test_a_present_tense_comment_passes(tmp_path, comment):
    assert _hits(tmp_path, "a.ts", f"const a = 1 {comment}\n") == []


def test_strings_and_code_are_not_its_business(tmp_path):
    source = 'PROMPT = "Seit 2026-10-06 gilt das. It used to be."\nwhen = "2026-10-06"\n'
    assert _hits(tmp_path, "m.py", source) == []
    assert _hits(tmp_path, "a.ts", "const url = 'https://x.dev/a' // a link\nconst d = '2026-10-06'\n") == []


def test_a_test_may_name_its_fixture_dates_but_not_the_history(tmp_path):
    assert _hits(tmp_path, "tests/test_week.py", "# Wednesday 2026-10-07 -> Monday 2026-10-05\n") == []
    assert _hits(tmp_path, "tests/test_week.py", "# Since 2026-10-07 the week starts on Monday.\n")


def test_yaml_comments_are_read(tmp_path):
    assert _hits(tmp_path, "ci.yml", "# The list lives in filters.yml.\njobs: {}\n") == []
    assert _hits(tmp_path, "ci.yml", "# It used to live inside ci.yml.\njobs: {}\n")


def test_history_files_are_left_alone():
    assert check.EXCLUDED.search("frontends/ui/drizzle/0118_project_memory_evidence.sql")
    assert check.EXCLUDED.search("docs/adr/0088-derived-content-is-judged-by-where-its-source-is-now.md")
    assert check.EXCLUDED.search(".trivyignore.yaml")
    assert not check.EXCLUDED.search("src/aiq_agent/knowledge/permit_extraction.py")
