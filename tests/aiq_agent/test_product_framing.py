"""What Piloti is, held where people and agents first read it.

Piloti is the workspace for architects; building law is one of its capabilities
(VISION.md). For a long time the README called it an "AI Compliance Assistant",
the deep-research prompts introduced the agent as "Grid OIB — an assistant for
... Austrian building regulations", and agents writing new docs and copy
repeated that frame because it was the first thing they read. The product owner
also forbade calling a file a plan (CONTEXT.md, "Fassung"): a name with an
index says a file has Fassungen, not that it is a drawing.

This is the ratchet for both, on the surfaces that shape everything else: the
first-impression docs and every agent prompt. The UI copy has its own
(frontends/ui/src/i18n/forbidden-file-words.spec.ts), and so does the public
site (frontends/web/scripts/lint-claims.mjs).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

#: Where a reader, human or agent, learns what the product is.
FIRST_IMPRESSION = [
    "README.md",
    "AGENTS.md",
    "CONTEXT.md",
    "docs/README.md",
    "docs/architecture/system-overview.md",
    "docs/architecture/overview.md",
    "frontends/ui/README.md",
]

PROMPTS = sorted(
    path.relative_to(ROOT).as_posix()
    for path in (ROOT / "src" / "aiq_agent").rglob("prompts/*")
    if path.suffix in {".j2", ".md"}
)

#: The old frame. VISION.md names these on purpose (as what Piloti is not), and
#: docs/product/vision.md quotes the frame it replaced, so neither is scanned.
OLD_FRAME = re.compile(
    r"compliance assistant|grid oib|answers oib questions|research assistant for austrian building|oib chatbot",
    re.IGNORECASE,
)

#: A file called a plan. Compounds (Lageplan, Bebauungsplan, Bestandspläne) do not
#: match; a research plan is not a file and is written in the singular here.
FILE_AS_PLAN = re.compile(r"(?<![\w-])(Pläne|Plänen|Planstand|Planstände|Planständen)(?![\w-])")


def _lines(relative: str) -> list[tuple[int, str]]:
    text = (ROOT / relative).read_text(encoding="utf-8")
    return list(enumerate(text.splitlines(), start=1))


@pytest.mark.parametrize("relative", FIRST_IMPRESSION + PROMPTS)
def test_no_surface_frames_piloti_as_a_compliance_question_answerer(relative: str) -> None:
    hits = [f"{relative}:{number}: {line.strip()}" for number, line in _lines(relative) if OLD_FRAME.search(line)]
    assert hits == [], "Piloti is the workspace for architects (VISION.md):\n" + "\n".join(hits)


@pytest.mark.parametrize("relative", PROMPTS)
def test_no_prompt_calls_a_file_a_plan(relative: str) -> None:
    hits = [f"{relative}:{number}: {line.strip()}" for number, line in _lines(relative) if FILE_AS_PLAN.search(line)]
    assert hits == [], "Never call a file a plan (CONTEXT.md, „Fassung“):\n" + "\n".join(hits)


@pytest.mark.parametrize("name", ["orchestrator.j2", "planner.j2", "researcher.j2", "writer.j2"])
def test_every_deep_research_prompt_introduces_the_agent_as_piloti(name: str) -> None:
    first_line = (ROOT / "src/aiq_agent/agents/deep_researcher/prompts" / name).read_text(encoding="utf-8")
    assert "Piloti" in first_line.splitlines()[0]


def test_the_scan_sees_the_prompts() -> None:
    """A glob that silently matched nothing would pass every test above."""
    assert "src/aiq_agent/agents/piloti/prompts/piloti_static.md" in PROMPTS
    assert len(PROMPTS) >= 8
