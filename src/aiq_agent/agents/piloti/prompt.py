"""System-prompt assembly for the researcher.

The 43 KB ``researcher.j2`` is read from disk ONCE per process
(:func:`system_prompt_template`) and rendered once per ``run()``: every input
to the render is fixed for the life of one turn, so ``agent_node`` caches the
rendered string on the state and the tool loop never renders twice.
"""

from __future__ import annotations

import functools
import logging
import os
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from aiq_agent.common import load_prompt
from aiq_agent.common import render_prompt_template
from aiq_agent.common.norm_registry import doctrine_for
from aiq_agent.common.norm_registry import parcel_note
from aiq_agent.common.norm_registry import render_block_for_prompt
from aiq_agent.common.platform_lessons import render_lessons_block
from aiq_agent.common.source_kinds import SHELF_QUALIFIERS
from aiq_agent.common.source_kinds import parse_shelf

from .models import ResearchAgentState

logger = logging.getLogger(__name__)

#: This agent's directory; the prompts live beside the code that renders them.
AGENT_DIR = Path(__file__).parent
PROMPTS_DIR = AGENT_DIR / "prompts"
PROMPT_NAME = "researcher"


@functools.cache
def system_prompt_template() -> str:
    """The researcher's prompt template, read from disk once per process.

    A missing or unreadable prompt raises ``PromptError`` at the first
    construction, which is boot: production must never run on a stub prompt,
    and a typed failure at boot is the only place the fault is cheap.
    """
    return load_prompt(PROMPTS_DIR, PROMPT_NAME)


def shelf_label(shelf: str | None) -> str | None:
    """Reader-facing German shelf name for the focused file, or None.

    The prompt names the shelf the same way the inventory block does, so the
    subject line and the inventory cannot disagree about where a file sits.
    An unparseable shelf yields None: the focus line then names the file
    alone rather than inventing a shelf for it.
    """
    if not shelf:
        return None
    parsed = parse_shelf(shelf)
    return SHELF_QUALIFIERS.get(parsed) if parsed is not None else None


def build_tools_info(tools: Sequence[Any]) -> list[dict[str, str]]:
    """Name + description per tool, the shape the template's tool list reads."""
    return [
        {
            "name": getattr(tool, "name", str(tool)),
            "description": getattr(tool, "description", "No description available"),
        }
        for tool in tools
    ]


def render_system_prompt(
    template: str,
    state: ResearchAgentState,
    tools_info: Sequence[dict[str, str]],
) -> str:
    """Render the system prompt for one run.

    The date is rendered at DAY precision: a second-precision timestamp made
    every rendered prompt unique, defeating provider prompt caching across
    tool-loop iterations and turns. Research needs the date, not the clock.
    ``answer_envelope_schema`` is injected by the renderer itself, so no caller
    can teach an empty schema by forgetting a kwarg.
    """
    documents = [doc.model_dump() for doc in (state.available_documents or [])]
    rendered = render_prompt_template(
        template,
        tools=list(tools_info),
        # The <entwuerfe> block is rendered only for a turn that HAS the working
        # directory bound (`tools/documents`). A turn without a conversation to
        # namespace by gets no file verbs, and a prompt telling that model to
        # write a document would be describing a tool it cannot call.
        drafting_enabled=any(tool.get("name") == "write_file" for tool in tools_info),
        # Same rule for the <aufraeumen> block and the five file-operation
        # tools (`tools/files`): they are bound by the config and refuse
        # outright without a project, so a deployment or a chat that does not
        # have them must not be told to reach for them. Keyed on the one verb
        # that is unambiguous — `create_folder` also exists as a word in the
        # working directory's vocabulary, `move_document` does not.
        tidying_enabled=any(tool.get("name") == "move_document" for tool in tools_info),
        # And for the <delegieren> block. `create_task` refuses without a project
        # and without a signed envelope, so a deployment that does not bind it —
        # and every unattended run, which has no envelope — must not be told that
        # handing work over is something this turn can do.
        delegating_enabled=any(tool.get("name") == "create_task" for tool in tools_info),
        user_info=state.user_info,
        current_datetime=datetime.now().strftime("%Y-%m-%d"),
        available_documents=documents,
        # Not a document list: the files that are NOT yet in one. The renderer
        # hands it to the inventory block.
        in_flight_documents=state.in_flight_documents,
        project_context=state.project_context,
        platform_lessons=render_lessons_block(state.platform_lessons),
        focus_file_name=state.focus_file_name,
        focus_shelf_label=shelf_label(state.focus_shelf),
        ris_catalog=render_block_for_prompt(state.project_context),
        norm_doctrine=doctrine_for(state.project_context),
        parcel_note=parcel_note(documents),
        # Skills catalog + forced-skills block, collated by the register layer;
        # None renders no section.
        skills_block=state.skills_block,
    )
    if os.environ.get("DEBUG_PROMPTS"):
        logger.debug("Rendered system prompt:\n%s", rendered)
    return rendered
