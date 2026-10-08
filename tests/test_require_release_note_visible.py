"""The release-note check reads what a product diff DOES, not how it is written."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TS = "frontends/ui/src/lib/example.ts"
PY = "src/aiq_agent/example.py"


@pytest.fixture(scope="module")
def check():
    spec = importlib.util.spec_from_file_location("require_release_note", ROOT / "ci" / "require_release_note.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def hunk(*lines: str) -> str:
    """One `git diff -U0` hunk, as the check reads it."""
    return "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n" + "\n".join(lines) + "\n"


def test_an_escape_spelled_out_is_the_same_program_as_the_character(check):
    # The file holds the character; the diff spells it as an escape. Same value.
    diff = hunk("-const bom = '\\uFEFF';", "+const bom = '" + chr(0xFEFF) + "';")

    assert not check.visible_change(TS, diff)


def test_a_comment_only_change_is_no_change(check):
    assert not check.visible_change(TS, hunk("-  // old note", "+  // new note"))


def test_a_jsdoc_line_inside_a_block_comment_is_a_comment(check):
    old = "/**\n * old text\n */\nconst a = 1\n"
    new = "/**\n * new text\n */\nconst a = 1\n"
    diff = "@@ -2 +2 @@\n-  * old text\n+  * new text\n"

    assert not check.visible_change(TS, diff, old=old, new=new)


def test_a_star_line_outside_a_block_comment_is_code(check):
    # A multiplication continuation looks like a JSDoc line; without block
    # context it is treated as code, so the check errs toward a visible change.
    assert check.visible_change(TS, hunk("-  * 2", "+  * 3"))


def test_a_python_indentation_change_is_visible(check):
    # Moving a statement into a block changes when it runs.
    assert check.visible_change(PY, hunk("-run_next()", "+    run_next()"))


def test_an_escaped_backslash_is_not_an_escape(check):
    # `\\uFEFF` is an escaped backslash then text; `\uFEFF` is the BOM character.
    diff = hunk("-x = '\\\\uFEFF'", "+x = '\\uFEFF'")

    assert check.visible_change(TS, diff)


def test_a_mode_change_is_visible_even_with_a_comment_only_edit(check):
    diff = "diff --git a/f b/f\nold mode 100644\nnew mode 100755\n" + hunk("-// old", "+// new")

    assert check.visible_change(TS, diff)


def test_bytes_that_are_not_utf8_are_visible(check):
    assert check.visible_change(TS, None)


def test_a_new_file_with_code_is_visible(check):
    diff = "diff --git a/f b/f\nnew file mode 100644\n" + hunk("+x = 1")

    assert check.visible_change(TS, diff)


def test_a_leading_star_in_python_is_code_not_a_comment(check):
    # Ruff breaks a long expression before the operator, so `* b)` is code.
    assert check.visible_change(PY, hunk("-    * b)", "+    * c)"))


def test_a_python_comment_change_is_no_change(check):
    assert not check.visible_change(PY, hunk("-# old", "+# new"))


def test_a_code_change_is_visible(check):
    assert check.visible_change(PY, hunk("-return 1", "+return 2"))


def test_a_comment_beside_a_code_change_is_visible(check):
    assert check.visible_change(TS, hunk("-// old", "-x = 1", "+// new", "+x = 2"))


def test_an_indentation_only_change_is_no_change(check):
    assert not check.visible_change(TS, hunk("-x = 1", "+    x = 1"))


def test_removing_a_comment_is_no_change(check):
    assert not check.visible_change(TS, hunk("-// gone"))


def test_reordered_lines_are_visible_because_order_is_behaviour(check):
    assert check.visible_change(TS, hunk("-a = 1", "-b = 2", "+b = 2", "+a = 1"))


def test_one_visible_hunk_among_comment_only_hunks_is_visible(check):
    diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-// old\n+// new\n@@ -9 +9 @@\n-return 1\n+return 2\n"

    assert check.visible_change(TS, diff)


def test_a_binary_change_is_visible_because_it_cannot_be_read(check):
    diff = "diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n"

    assert check.visible_change("frontends/ui/src/icon.png", diff)


def test_an_empty_diff_is_no_change(check):
    assert not check.visible_change(TS, "")


def test_code_after_an_inline_block_comment_is_visible(check):
    # The line is a comment and code: changing LIMIT changes the program.
    diff = hunk(
        "-/* istanbul ignore next */ export const LIMIT = 1", "+/* istanbul ignore next */ export const LIMIT = 2"
    )

    assert check.visible_change(TS, diff)


def test_an_inline_block_comment_alone_is_no_change(check):
    assert not check.visible_change(TS, hunk("-/* old */", "+/* new */"))


def test_code_after_a_closing_block_comment_is_visible(check):
    assert check.visible_change(TS, hunk("-*/ return 1", "+*/ return 2"))
