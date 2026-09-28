"""A landed quote patch keeps the citations the first verification removed (ADR-0067)."""

from __future__ import annotations

from aiq_agent.agents.piloti import answer_pipeline
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

PASSAGE = (
    "Vorher steht ein Satz über Geländer und Brüstungen. Die lichte Durchgangshöhe von Treppen muss "
    "mindestens 2,10 m betragen. Danach ein Satz über Podeste und Stufen in Gebäudeklasse 4."
)
MISQUOTE = "Die lichte Durchgangshöhe bei Treppen muss wenigstens 2,10 m betragen"
CORRECT = "Die lichte Durchgangshöhe von Treppen muss mindestens 2,10 m betragen"


async def test_a_landed_patch_still_reports_the_fake_citation_the_first_pass_removed():
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="oib.pdf, p.3", chunk_text=PASSAGE, source_type="knowledge_layer"))
    answer = (
        f"Es gilt: „{MISQUOTE}“ [1]. Außerdem gilt etwas Erfundenes [2].\n\n"
        "## Quellen\n- [1] oib.pdf, p.3\n- [2] erfunden.pdf, p.9\n"
    )

    async def patch(text: str, passage: str) -> str | None:
        return CORRECT

    verified = await answer_pipeline._verify_with_quote_patch(answer, registry, patch)

    assert f"„{CORRECT}“" in verified.content  # the patch landed
    removed = [entry["number"] for entry in verified.verification.removed_citations]
    assert 2 in removed
