"""The answer's Markdown dialect, server side: its vocabulary, and the validator that holds an answer to it.

The model writes a few ``remark-directive`` blocks around ordinary Markdown
(ADR-0069, ``docs/design/answer-richness.md``): ``:::check``, ``:::cases``,
``:::actions`` and the rest, the markers ``:current`` / ``:applies`` /
``:recommended``, and the inline project binding ``:project[key]``. The
frontend draws them (``frontends/ui/src/lib/text/answer-directives.ts`` holds
the same vocabulary; ``tests/aiq_agent/common/test_answer_dialect_parity.py``
holds the two lists together).

:func:`validate_dialect` runs on the finished answer after citation
verification and before report hygiene. It repairs and unwraps; it never
deletes a line the reader would read (guardrail 8):

- a block name the renderer does not know loses its fences, keeps its content,
  and its ``[label]`` becomes a bold line over it;
- a block over the budget of the answer's ``kind`` is unwrapped the same way
  (``direct``: none; ``ruling``: one primary block; ``walkthrough``: two);
- a marker outside the block it belongs to has no provenance and is stripped
  (guardrail 5). ``:current`` inside a ``:::procedure`` is kept: whether the
  conversation established the step is not decidable here, so it is logged;
- ``:project[key]`` with a key the renderer cannot resolve becomes the key's
  plain text. The model never types the value (guardrail 7).

Every repair is recorded, and the census (blocks by name) goes to the trace.

The scanner is a port of the frontend's ``scanDirectiveFences`` rather than
markdown-it-py's container plugin: the renderer closes the innermost open block
at a bare ``:::`` (``normalizeDirectiveFences``), which CommonMark containers
do not, and the server must see the blocks the reader sees. ``mdit-py-plugins``
is not a dependency either.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

logger = logging.getLogger(__name__)

#: Blocks, written ``:::name`` … ``:::``. Mirrors ``DIRECTIVE_BLOCKS`` in
#: ``answer-directives.ts``.
DIRECTIVE_BLOCKS: tuple[str, ...] = (
    "check",
    "procedure",
    "cases",
    "metrics",
    "compare",
    "details",
    "actions",
    "not-found",
    "subsumption",
)

#: The blocks the budget counts. ``details`` is disclosure, not a shape.
PRIMARY_BLOCKS: frozenset[str] = frozenset(DIRECTIVE_BLOCKS) - {"details"}

#: Inline markers and the word each prints as. Mirrors ``DIRECTIVE_MARKERS``.
DIRECTIVE_MARKERS: dict[str, str] = {"current": "aktuell", "applies": "trifft zu", "recommended": "empfohlen"}

#: The block a marker needs around it to mean anything.
MARKER_PARENTS: dict[str, str] = {"current": "procedure", "applies": "cases", "recommended": "compare"}

#: The inline project binding, ``:project[building_class]``.
PROJECT_DIRECTIVE = "project"

#: The keys ``:project[…]`` accepts, each with the project-profile fact it reads
#: (``frontends/ui/src/lib/project-profile/intake-definition.ts`` writes them).
#: Mirrors ``PROJECT_KEYS`` in ``answer-directives.ts``. No ``parcel_area_m2``:
#: the profile records no Grundstücksfläche.
PROJECT_KEYS: dict[str, str] = {
    "building_class": "gebaeudeklasse",
    "escape_level_m": "fluchtniveau_m",
    "use": "nutzungen",
    "state": "bundesland",
    "storeys": "geschosse_oberirdisch",
    "gross_floor_area_m2": "bgf_oberirdisch",
}

#: ``kind`` → (primary blocks, diagrams) an answer of that kind may carry.
#: A kind not here (no envelope) is not budgeted.
BUDGET: dict[str, tuple[int, int]] = {
    "direct": (0, 0),
    "handoff": (0, 0),
    "ruling": (1, 0),
    "walkthrough": (2, 1),
}

#: A code fence opener or closer (``FENCE`` in the frontend).
_FENCE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
#: A container opener: ``:::name``, optionally ``[label]`` and ``{attributes}``.
_OPENER = re.compile(r"^(\s*)(:{3,})([A-Za-z][\w-]*)(.*)$", re.ASCII)
#: A container closer: colons alone on the line.
_CLOSER = re.compile(r"^(\s*)(:{3,})\s*$")
#: A text directive (``TEXT_DIRECTIVE``). ASCII ``\w`` as in JavaScript.
_TEXT_DIRECTIVE = re.compile(r"(^|[^\w:\\])(:)([A-Za-z][\w-]*)(?:\[([^\]\n]*)\])?(?:\{[^}\n]*\})?", re.ASCII)
_LABEL = re.compile(r"^\[([^\]]*)\]")
_ATTRS = re.compile(r"\{([^}\n]*)\}")
_INLINE_CODE = re.compile(r"(`[^`]*`)")


@dataclass
class _Block:
    name: str
    open: int
    close: int | None
    label: str
    attrs: str
    parent: int | None


@dataclass
class DialectResult:
    """The answer held to the dialect, with what was repaired and what it held."""

    text: str
    #: Blocks by name as the model wrote them, and ``diagrams`` (mermaid fences).
    census: dict[str, int] = field(default_factory=dict)
    #: One entry per repair: ``{"repair": …, "name": …}``.
    repairs: list[dict[str, str]] = field(default_factory=list)

    def as_trace(self) -> dict[str, Any]:
        """The census and the repairs by kind, for the trace metadata."""
        return {
            "blocks": dict(self.census),
            "repairs": dict(Counter(repair["repair"] for repair in self.repairs)),
        }


def _scan(lines: Sequence[str]) -> tuple[list[_Block], list[bool], int]:
    """The blocks, which lines are code, and how many mermaid fences: ``scanDirectiveFences``, kept structured."""
    blocks: list[_Block] = []
    stack: list[int] = []
    code = [False] * len(lines)
    fence: str | None = None
    diagrams = 0
    for index, line in enumerate(lines):
        fence_match = _FENCE.match(line)
        if fence is not None:
            code[index] = True
            if fence_match and fence_match.group(1)[0] == fence[0] and len(fence_match.group(1)) >= len(fence):
                fence = None
            continue
        if fence_match:
            fence = fence_match.group(1)
            code[index] = True
            diagrams += fence_match.group(2).strip().lower().startswith("mermaid")
            continue
        opener = _OPENER.match(line)
        if opener:
            rest = opener.group(4).strip()
            label = _LABEL.match(rest)
            attrs = _ATTRS.search(rest)
            blocks.append(
                _Block(
                    name=opener.group(3),
                    open=index,
                    close=None,
                    label=label.group(1).strip() if label else "",
                    attrs=attrs.group(1) if attrs else "",
                    parent=stack[-1] if stack else None,
                )
            )
            stack.append(len(blocks) - 1)
            continue
        if _CLOSER.match(line) and stack:
            blocks[stack.pop()].close = index
    return blocks, code, diagrams


def _unwrap_set(blocks: Sequence[_Block], kind: str | None, repairs: list[dict[str, str]]) -> set[int]:
    """The blocks that lose their fences: unknown names, then whatever is over the kind's budget."""
    unwrap: set[int] = set()
    for index, block in enumerate(blocks):
        if block.name not in DIRECTIVE_BLOCKS:
            unwrap.add(index)
            repairs.append({"repair": "unwrap_unknown", "name": block.name})
    budget = BUDGET.get(kind or "")
    if budget is None:
        return unwrap
    allowed = budget[0]
    kept = 0
    for index, block in enumerate(blocks):
        if index in unwrap:
            continue
        # A kind with no primary budget carries no block at all, not even details.
        if allowed == 0 or block.name in PRIMARY_BLOCKS:
            if allowed and kept < allowed:
                kept += 1
                continue
            unwrap.add(index)
            repairs.append({"repair": "unwrap_over_budget", "name": block.name})
    return unwrap


def _enclosing(blocks: Sequence[_Block], unwrap: set[int], line_count: int) -> list[frozenset[str]]:
    """For each line, the names of the surviving blocks it sits inside (fence lines excluded)."""
    inside: list[set[str]] = [set() for _ in range(line_count)]
    for index, block in enumerate(blocks):
        if index in unwrap:
            continue
        end = block.close if block.close is not None else line_count
        for line in range(block.open + 1, end):
            inside[line].add(block.name)
    return [frozenset(names) for names in inside]


def _inline(line: str, around: frozenset[str], repairs: list[dict[str, str]]) -> str:
    """One prose line's markers and project bindings, held to the rules. Inline code is left alone."""

    def substitute(match: re.Match[str]) -> str:
        before, name, label = match.group(1), match.group(3), match.group(4)
        if name == PROJECT_DIRECTIVE and label is not None:
            if label.strip() in PROJECT_KEYS:
                return match.group(0)
            repairs.append({"repair": "project_key_unknown", "name": label.strip()})
            return f"{before}{label}"
        if name in DIRECTIVE_MARKERS and label is None:
            if MARKER_PARENTS[name] not in around:
                repairs.append({"repair": "strip_marker", "name": name})
                # The space before the marker goes with it (``[1] :current.`` → ``[1].``).
                return "" if before.isspace() else before
            if name == "current":
                # Kept: the step's provenance is the conversation's, not decidable here.
                repairs.append({"repair": "current_unverified", "name": name})
        return match.group(0)

    if ":" not in line:
        return line
    parts = _INLINE_CODE.split(line)
    return "".join(part if index % 2 else _TEXT_DIRECTIVE.sub(substitute, part) for index, part in enumerate(parts))


def _cases_keys(blocks: Sequence[_Block], unwrap: set[int], repairs: list[dict[str, str]]) -> None:
    """Log a ``:::cases{by=…}`` whose key the renderer cannot resolve; it degrades to an unmarked table."""
    for index, block in enumerate(blocks):
        if index in unwrap or block.name != "cases" or not block.attrs:
            continue
        by = re.search(r"\bby\s*=\s*\"?([\w-]+)", block.attrs)
        if by and by.group(1) not in PROJECT_KEYS:
            repairs.append({"repair": "cases_by_unknown", "name": by.group(1)})


def validate_dialect(text: str, kind: str | None) -> DialectResult:
    """``text`` held to the dialect and the budget of ``kind``; see the module docstring for the rules."""
    if ":" not in text and "```" not in text and "~~~" not in text:
        return DialectResult(text)
    lines = text.split("\n")
    blocks, code, diagrams = _scan(lines)
    census = dict(Counter(block.name for block in blocks))
    if diagrams:
        census["diagrams"] = diagrams
    repairs: list[dict[str, str]] = []
    unwrap = _unwrap_set(blocks, kind, repairs)
    budget = BUDGET.get(kind or "")
    if budget is not None and diagrams > budget[1]:
        # A mermaid fence has no content-keeping degrade: logged, never removed.
        repairs.append({"repair": "diagrams_over_budget", "name": "mermaid"})
    _cases_keys(blocks, unwrap, repairs)
    around = _enclosing(blocks, unwrap, len(lines))
    replaced: dict[int, list[str]] = {}
    for index in unwrap:
        block = blocks[index]
        indent = _OPENER.match(lines[block.open]).group(1)  # type: ignore[union-attr]
        replaced[block.open] = [f"{indent}**{block.label}**", ""] if block.label else []
        if block.close is not None:
            replaced[block.close] = []
    out: list[str] = []
    dropped = False
    for index, line in enumerate(lines):
        if index in replaced:
            out.extend(replaced[index])
            dropped = not replaced[index]
            continue
        # A fence taken out between two blank lines leaves two; prose keeps one.
        if dropped and not line.strip() and out and not out[-1].strip():
            dropped = False
            continue
        dropped = False
        out.append(line if code[index] else _inline(line, around[index], repairs))
    result = "\n".join(out)
    if repairs:
        logger.info("Answer dialect: %d repair(s) %s; blocks %s", len(repairs), _summary(repairs), census)
    return DialectResult(result, census, repairs)


def _summary(repairs: Sequence[Mapping[str, str]]) -> str:
    return ", ".join(f"{repair['repair']}:{repair['name']}" for repair in repairs)
