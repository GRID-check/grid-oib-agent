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
    def test_the_digest_names_are_the_locator_names(self):
        """The digest lists what was opened, under names `read_passage` accepts.

        A fact, not an instruction: the model reads which names the locator
        takes and decides itself when to open one.
        """
        rendered = _render(already_read_digest=list(DIGEST))

        assert "## Bereits gelesen (diese Unterhaltung)" in rendered
        assert "exact names `read_passage` accepts" in rendered

    def test_a_stale_entry_is_named_and_search_resolves_it(self):
        rendered = _render(already_read_digest=list(DIGEST))

        assert "unknown document" in rendered
        assert "a search resolves it again" in rendered

    def test_the_rule_states_an_outcome_and_prescribes_no_round_shape(self):
        """What must be true, not how many calls to make when, or which tool
        is forbidden: the locator's contract lives in its description."""
        rendered = _render(already_read_digest=list(DIGEST))

        assert "EINER parallelen" not in rendered
        assert "niemals mit `knowledge_search`" not in rendered
        assert "Bereits-Gelesen-Digest zuerst" not in rendered
