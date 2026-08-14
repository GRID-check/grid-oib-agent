"""Prompt wiring: the turn's attachments reach the researcher prompt.

Renders the REAL ``researcher.j2`` (never a paraphrase of it) so a reworded
block that drops one of the load-bearing instructions fails here rather than in
production. Modelled on ``test_ris_catalog_prompt_wiring.py``.
"""

from pathlib import Path
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage

from aiq_agent.agents.shallow_researcher.agent import ShallowResearcherAgent
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.prompt_utils import render_prompt_template
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.turn_attachments import SessionAttachment
from aiq_agent.knowledge.schema import AvailableDocument

REPO_ROOT = Path(__file__).resolve().parents[3]
SHALLOW_TEMPLATE = REPO_ROOT / "src" / "aiq_agent" / "agents" / "shallow_researcher" / "prompts" / "researcher.j2"

_ATTACHMENT_HEADING = "## Files the user attached to this chat"
_INVENTORY_HEADING = "## Knowledge-base inventory (index — NOT sources)"


def _doc(file_name: str, origin_label: str | None):
    return {
        "file_name": file_name,
        "summary": f"Summary of {file_name}",
        "tags": None,
        "origin_label": origin_label,
    }


def _render(session_attachments=None, available_documents=None) -> str:
    return render_prompt_template(
        SHALLOW_TEMPLATE.read_text(encoding="utf-8"),
        current_datetime="2026-08-14",
        user_info=None,
        tools=[],
        available_documents=available_documents or [],
        session_attachments=session_attachments or [],
        project_context=None,
        requires_sources=True,
        execution_enabled=False,
        ris_catalog=None,
    )


class TestAttachmentBlock:
    def test_no_block_when_the_turn_declared_no_attachments(self):
        rendered = _render(session_attachments=[])

        assert _ATTACHMENT_HEADING not in rendered

    def test_every_attached_file_is_named(self):
        rendered = _render(
            session_attachments=[
                {"file_name": "Statikbericht.pdf", "state": "ready"},
                {"file_name": "Einreichplan.pdf", "state": "ready"},
            ]
        )

        assert _ATTACHMENT_HEADING in rendered
        assert "Statikbericht.pdf" in rendered
        assert "Einreichplan.pdf" in rendered

    def test_a_still_indexing_attachment_is_marked_as_such(self):
        rendered = _render(session_attachments=[{"file_name": "Gross.pdf", "state": "indexing"}])

        marked = next(line for line in rendered.splitlines() if "Gross.pdf" in line)
        assert "indexiert" in marked or "indexed" in marked

    def test_a_ready_attachment_is_not_marked_as_indexing(self):
        rendered = _render(session_attachments=[{"file_name": "Fertig.pdf", "state": "ready"}])

        marked = next(line for line in rendered.splitlines() if "Fertig.pdf" in line)
        assert "indexiert" not in marked and "indexed" not in marked

    def test_the_block_instructs_the_file_name_filter(self):
        rendered = _render(session_attachments=[{"file_name": "Statikbericht.pdf", "state": "ready"}])
        block = rendered.split(_ATTACHMENT_HEADING, 1)[1]

        assert "`file_name=`" in block
        assert "knowledge_search" in block

    def test_the_block_forbids_asking_which_file_is_meant(self):
        rendered = _render(session_attachments=[{"file_name": "Statikbericht.pdf", "state": "ready"}])
        block = rendered.split(_ATTACHMENT_HEADING, 1)[1]

        assert "Do NOT ask which file" in block

    def test_the_block_carries_the_anti_hijack_rule(self):
        """The one rule this block must never lose (plan §Design decision 2, L3).

        Without it the prompt reads as "an attachment is the subject", and the
        user who attaches a Statik-Bericht at turn 1 gets their general
        Fluchtweg question at turn 6 answered out of that PDF.
        """
        rendered = _render(session_attachments=[{"file_name": "Statikbericht.pdf", "state": "ready"}])
        block = rendered.split(_ATTACHMENT_HEADING, 1)[1]

        assert "does NOT take the conversation over" in block
        # And it must say what to do instead, concretely: pass no file_name.
        assert "no `file_name`" in block

    @pytest.mark.parametrize(
        "phrase",
        [
            # The reporting user writes German; these are the deictics that made
            # the agent ask "which file do you mean?".
            "fass den Inhalt zusammen",
            "was steht da drin",
            "das Dokument",
            "die Datei",
            # …and the English equivalents, since the agent answers in the
            # user's language and the corpus is bilingual.
            "the file",
            "the attachment",
        ],
    )
    def test_the_block_names_the_deictic_phrases_that_refer_to_an_attachment(self, phrase):
        rendered = _render(session_attachments=[{"file_name": "Statikbericht.pdf", "state": "ready"}])
        block = rendered.split(_ATTACHMENT_HEADING, 1)[1]

        assert phrase in block

    def test_the_attachment_block_comes_before_the_inventory(self):
        """Order is the point: the attachment is the answer to "which document",
        and the inventory is the list that made that question look open."""
        rendered = _render(
            session_attachments=[{"file_name": "Statikbericht.pdf", "state": "ready"}],
            available_documents=[_doc("oib-rl_2.pdf", "Basiswissen")],
        )

        assert rendered.index(_ATTACHMENT_HEADING) < rendered.index(_INVENTORY_HEADING)

    def test_the_block_sits_below_the_kv_cache_boundary(self):
        """A dynamic block above the boundary would invalidate the cached prefix
        of every turn that has an attachment."""
        template = SHALLOW_TEMPLATE.read_text(encoding="utf-8")

        assert template.index("KV CACHE BOUNDARY") < template.index("session_attachments")


class TestInventoryOriginLabels:
    def test_an_entry_states_the_shelf_it_came_from(self):
        rendered = _render(
            available_documents=[
                _doc("oib-rl_2.pdf", "Basiswissen"),
                _doc("Statikbericht.pdf", "Chat-Upload"),
            ]
        )

        assert "**oib-rl_2.pdf** (Basiswissen)" in rendered
        assert "**Statikbericht.pdf** (Chat-Upload)" in rendered

    def test_an_unknown_shelf_renders_no_parenthetical(self):
        """ADR-0047: unknown is unknown. It is never guessed as `base`, and an
        invented label would be the same lie in prose."""
        rendered = _render(available_documents=[_doc("Mystery.pdf", None)])

        assert "**Mystery.pdf**:" in rendered
        assert "**Mystery.pdf** (" not in rendered


class TestAgentRendersTheAttachmentSignal:
    """The template can only render what the agent passes it.

    The block above is inert unless ``ShallowResearcherAgent`` actually forwards
    ``state.session_attachments`` and stamps each inventory entry with its shelf
    label — so this exercises the real render path and reads the SystemMessage
    the model would have received.
    """

    @pytest.fixture(autouse=True)
    def _bypass_citation_pipeline(self):
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify,
            patch("aiq_agent.agents.shallow_researcher.agent.sanitize_report") as mock_sanitize,
        ):
            mock_verify.side_effect = lambda content, reg, reference_sources=None: MagicMock(
                verified_report=content, removed_citations=[]
            )
            mock_sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
            yield

    async def _system_prompt_for(self, **state_kwargs) -> str:
        llm = MagicMock()
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Antwort [CONFIDENCE:high]"))
        llm.bind_tools = MagicMock(return_value=llm)
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)

        agent = ShallowResearcherAgent(llm_provider=provider, tools=[])
        await agent.run(
            ShallowResearchAgentState(
                messages=[HumanMessage(content="Fass den Inhalt zusammen")],
                **state_kwargs,
            )
        )

        sent = llm.ainvoke.call_args[0][0]
        system = next(m for m in sent if isinstance(m, SystemMessage))
        return system.content

    @pytest.mark.asyncio
    async def test_the_attached_file_reaches_the_rendered_prompt(self):
        prompt = await self._system_prompt_for(
            session_attachments=[SessionAttachment(file_name="Statikbericht.pdf", state="indexing")]
        )

        assert "## Files the user attached to this chat" in prompt
        assert "Statikbericht.pdf" in prompt
        assert "still being indexed" in prompt

    @pytest.mark.asyncio
    async def test_a_turn_without_attachments_renders_no_block(self):
        prompt = await self._system_prompt_for(session_attachments=None)

        assert "## Files the user attached to this chat" not in prompt

    @pytest.mark.asyncio
    async def test_inventory_entries_reach_the_prompt_with_their_origin(self):
        prompt = await self._system_prompt_for(
            available_documents=[
                AvailableDocument(file_name="oib-rl_2.pdf", summary="Brandschutz", shelf=Shelf.BASE),
                AvailableDocument(file_name="Statikbericht.pdf", summary="Statik", shelf=Shelf.SESSION),
                # No shelf stated: unknown, and unknown renders unattributed.
                AvailableDocument(file_name="Mystery.pdf", summary="?"),
            ]
        )

        assert "**oib-rl_2.pdf** (Basiswissen)" in prompt
        assert "**Statikbericht.pdf** (Chat-Upload)" in prompt
        assert "**Mystery.pdf**:" in prompt
