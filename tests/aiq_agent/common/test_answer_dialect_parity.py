"""Parity guard: the server's dialect vocabulary is the renderer's.

``common/answer_dialect.py`` validates the answer against the block names,
markers and ``:project[…]`` keys that ``frontends/ui/src/lib/text/answer-directives.ts``
draws. There is no shared schema between the two files: a block the server
knows and the renderer does not shows as its literal ``:::`` lines, and one the
renderer knows and the server does not is unwrapped before anyone sees it.
"""

from __future__ import annotations

import re
from pathlib import Path

from aiq_agent.common.answer_dialect import DIRECTIVE_BLOCKS
from aiq_agent.common.answer_dialect import DIRECTIVE_MARKERS
from aiq_agent.common.answer_dialect import PROJECT_DIRECTIVE
from aiq_agent.common.answer_dialect import PROJECT_KEYS

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_DIALECT = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "text" / "answer-directives.ts"


def _declaration(name: str) -> str:
    """The literal after ``export const <name> =``: the bracketed or braced body."""
    source = TS_DIALECT.read_text(encoding="utf-8")
    match = re.search(rf"export const {name}\b[^=]*=\s*([\[{{])", source)
    assert match, f"{name} not found in {TS_DIALECT}"
    opener = match.group(1)
    closer = "]" if opener == "[" else "}"
    depth, start = 0, match.start(1)
    for index in range(start, len(source)):
        if source[index] == opener:
            depth += 1
        elif source[index] == closer:
            depth -= 1
            if depth == 0:
                return source[start : index + 1]
    raise AssertionError(f"{name} is not closed in {TS_DIALECT}")


def _without_comments(body: str) -> str:
    return re.sub(r"/\*.*?\*/|//[^\n]*", "", body, flags=re.DOTALL)


def _strings(body: str) -> list[str]:
    return re.findall(r"'([^']*)'", _without_comments(body))


def _object(body: str) -> dict[str, str]:
    pairs = re.findall(r"['\"]?([\w-]+)['\"]?\s*:\s*'([^']*)'", _without_comments(body))
    return dict(pairs)


def test_the_blocks_are_the_same():
    assert _strings(_declaration("DIRECTIVE_BLOCKS")) == list(DIRECTIVE_BLOCKS)


def test_the_markers_print_as_the_same_words():
    assert _object(_declaration("DIRECTIVE_MARKERS")) == DIRECTIVE_MARKERS


def test_the_project_keys_are_the_same():
    body = _declaration("PROJECT_KEYS")
    keys = list(_object(body)) if body.startswith("{") else _strings(body)
    assert keys == list(PROJECT_KEYS)
    if body.startswith("{"):
        # Where the frontend states the profile fact a key reads, it is the server's.
        assert _object(body) == PROJECT_KEYS


def test_the_project_directive_is_named_the_same():
    source = TS_DIALECT.read_text(encoding="utf-8")
    assert f"'{PROJECT_DIRECTIVE}'" in source
