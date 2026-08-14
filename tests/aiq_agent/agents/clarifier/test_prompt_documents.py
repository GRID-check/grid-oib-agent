"""The clarifier's document blocks say what is actually true of each list.

`research_clarification.j2` rendered the whole `available_documents` union —
base corpus + Archiv + project + session — under "The user has uploaded the
following file(s)", and used `available_documents[0].file_name` (alphabetically
first, in practice an OIB Richtlinie) as the exemplar of "the file the user
means". Both statements were false, and the second is the single most misleading
string in the chain: it names a shared-corpus document as the user's upload.

These render the REAL template.
"""

from pathlib import Path

import pytest

from aiq_agent.common.prompt_utils import render_prompt_template

REPO_ROOT = Path(__file__).resolve().parents[4]
TEMPLATE = REPO_ROOT / "src" / "aiq_agent" / "agents" / "clarifier" / "prompts" / "research_clarification.j2"

_INVENTORY = [
    {"file_name": "OIB-Richtlinie-1.pdf", "summary": "Standsicherheit."},
    {"file_name": "oib-rl_2_ausgabe_mai_2023.pdf", "summary": "Brandschutz."},
    {"file_name": "Statikbericht.pdf", "summary": "Statik des Bauvorhabens."},
]

_ATTACHMENTS = [{"file_name": "Statikbericht.pdf", "state": "ready"}]


def _render(available_documents=None, session_attachments=None) -> str:
    return render_prompt_template(
        TEMPLATE.read_text(encoding="utf-8"),
        project_context=None,
        available_documents=available_documents or [],
        session_attachments=session_attachments or [],
        clarifier_result=None,
        tools=[],
        tool_names=[],
    )


class TestUploadedBlock:
    def test_uploaded_block_lists_only_real_attachments(self):
        rendered = _render(available_documents=_INVENTORY, session_attachments=_ATTACHMENTS)
        block = rendered.split("## Files the user attached to this chat", 1)[1]
        block = block.split("## ", 1)[0]

        assert "Statikbericht.pdf" in block
        # The shared corpus is not something the user uploaded.
        assert "OIB-Richtlinie-1.pdf" not in block
        assert "oib-rl_2_ausgabe_mai_2023.pdf" not in block

    def test_there_is_no_attachment_block_when_nothing_was_attached(self):
        rendered = _render(available_documents=_INVENTORY, session_attachments=[])

        assert "## Files the user attached to this chat" not in rendered

    def test_inventory_is_not_described_as_uploaded_by_the_user(self):
        rendered = _render(available_documents=_INVENTORY, session_attachments=[])

        assert "The user has uploaded the following file(s)" not in rendered
        # It is stated for what it is: a searchable index, not the user's uploads.
        assert "NOT uploads" in rendered

    @pytest.mark.parametrize("attachments", [[], _ATTACHMENTS])
    def test_no_inventory_filename_is_used_as_the_which_file_exemplar(self, attachments):
        """`(e.g. {{ available_documents[0].file_name }})` presented the
        alphabetically first corpus document as the file the user meant, in the
        same sentence that forbade asking which file was meant."""
        rendered = _render(available_documents=_INVENTORY, session_attachments=attachments)

        exemplar_section = rendered.split("## Searchable knowledge base", 1)[1]
        for doc in _INVENTORY:
            assert f"e.g. {doc['file_name']}" not in exemplar_section
        assert "OIB-Richtlinie-1.pdf" not in exemplar_section.split("\n\n")[-1]

    def test_the_do_not_ask_which_file_rule_is_scoped_to_real_attachments(self):
        """The instruction itself is right — it was attached to the wrong list."""
        with_attachment = _render(available_documents=_INVENTORY, session_attachments=_ATTACHMENTS)
        without = _render(available_documents=_INVENTORY, session_attachments=[])

        assert "Do NOT ask which file" in with_attachment
        assert "Do NOT ask which file" not in without

    def test_the_attachment_block_carries_the_anti_hijack_rule(self):
        rendered = _render(available_documents=_INVENTORY, session_attachments=_ATTACHMENTS)

        assert "does NOT take the conversation over" in rendered

    def test_both_blocks_sit_below_the_kv_cache_boundary(self):
        template = TEMPLATE.read_text(encoding="utf-8")

        assert template.index("KV CACHE BOUNDARY") < template.index("session_attachments")
        assert template.index("KV CACHE BOUNDARY") < template.index("Searchable knowledge base")
