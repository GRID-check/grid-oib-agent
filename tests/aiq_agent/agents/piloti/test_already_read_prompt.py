"""The digest in the prompt: block present, rule present, batching kept.

Contract over prose: these assert the block exists, sits right after the
document inventory, carries the index-not-evidence rule, and that the
locator-first rule names its tools — never the model's wording.
"""

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import render_system_prompt
from aiq_agent.agents.piloti.prompt import system_prompt_template
from aiq_agent.knowledge.already_read import DIGEST_HEADING
from aiq_agent.knowledge.schema import AvailableDocument

DIGEST = ["oib-rl_2_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 12 | Punkte 3.5.2 | Turn 1"]
TOOLS = [
    {"name": "knowledge_search", "description": "Search the knowledge base."},
    {"name": "read_passage", "description": "Open a named passage."},
]


def _render(**overrides) -> str:
    state = ResearchAgentState(
        messages=[HumanMessage(content="Was gilt für tragende Bauteile?")],
        available_documents=[
            AvailableDocument(
                file_name="Brandschutzkonzept.pdf",
                summary="Das Konzept des Projekts.",
                collection="proj_1",
                shelf="project",
            )
        ],
        **overrides,
    )
    return render_system_prompt(system_prompt_template(), state, TOOLS)


class TestDigestBlock:
    def test_the_block_renders_with_its_entries(self):
        rendered = _render(already_read_digest=list(DIGEST))

        assert DIGEST_HEADING in rendered
        assert DIGEST[0] in rendered

    def test_the_block_sits_right_after_the_document_inventory(self):
        rendered = _render(already_read_digest=list(DIGEST))

        # rindex: the rule text names the heading too — the BLOCK is its last occurrence.
        assert rendered.index("## Knowledge-base inventory") < rendered.rindex(DIGEST_HEADING)

    def test_the_block_carries_the_index_not_evidence_rule(self):
        rendered = _render(already_read_digest=list(DIGEST))

        assert "KEIN Beleg" in rendered

    def test_no_digest_renders_no_section(self):
        rendered = _render(already_read_digest=None)

        # The rule still names the heading (static prompt text); the BLOCK —
        # its entries and its index-not-evidence sentence — must be absent.
        assert "KEIN Beleg" not in rendered
        assert DIGEST[0] not in rendered


class TestLocatorFirstRule:
    def test_a_digest_hit_means_read_passage_never_search(self):
        rendered = _render(already_read_digest=list(DIGEST))

        assert "Bereits-Gelesen-Digest zuerst" in rendered
        assert "read_passage" in rendered
        assert "niemals mit `knowledge_search`" in rendered

    def test_search_stays_for_missing_entries_and_no_passage_replies(self):
        rendered = _render(already_read_digest=list(DIGEST))

        assert "kein Digest-Eintrag passt" in rendered
        assert "unknown document" in rendered

    def test_the_batched_round_preference_stays(self):
        rendered = _render(already_read_digest=list(DIGEST))

        assert "gebündelter Zug" in rendered
