"""System-prompt assembly for Piloti.

``piloti.j2`` is read from disk ONCE per process
(:func:`system_prompt_template`) and rendered once per ``run()``: every input
to the render is fixed for the life of one turn, so ``agent_node`` caches the
rendered string on the state and the tool loop never renders twice.

THE PROMPT IS TWO HALVES, AND ONLY ONE OF THEM IS IN THIS FILE'S GIFT.
``piloti.j2`` now holds the DYNAMIC half alone — everything below the
``KV CACHE BOUNDARY`` marker, which varies per turn — and opens with
``{{ static_block }}``. The STATIC half is the platform prompt: the same bytes
for every tenant and every turn, authored and versioned in **Langfuse**, and
pulled from there by :func:`resolve_static_block` through
``common/prompt_store.py``.

``prompts/piloti_static.md`` is the BUNDLED FALLBACK for that half — what is
rendered when prompt management is off (the default), when the credentials are
absent, when Langfuse is unreachable or when it holds no such prompt. It is
allowed to lag the live version; ``task prompts:pull`` refreshes it. With the
store disabled the render is byte-identical to the one-file template it
replaced.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from aiq_agent.common import load_prompt
from aiq_agent.common import render_prompt_template
from aiq_agent.common.applicability import render_project_block
from aiq_agent.common.norm_registry import parcel_note
from aiq_agent.common.platform_lessons import render_lessons_block
from aiq_agent.common.prompt_store import ResolvedPrompt
from aiq_agent.common.prompt_store import git_blob_version
from aiq_agent.common.prompt_store import prompt_store
from aiq_agent.common.prompt_utils import PromptError
from aiq_agent.common.source_kinds import SHELF_QUALIFIERS
from aiq_agent.common.source_kinds import parse_shelf
from aiq_agent.knowledge.already_read import render_already_read_block
from aiq_agent.observability.langfuse_trace_attributes import current_fallback_identity
from aiq_agent.observability.langfuse_trace_attributes import record_prompt_link
from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata

from .models import ResearchAgentState

logger = logging.getLogger(__name__)

#: This agent's directory; the prompts live beside the code that renders them.
AGENT_DIR = Path(__file__).parent
PROMPTS_DIR = AGENT_DIR / "prompts"
PROMPT_NAME = "piloti"
#: The bundled fallback for the static half. Langfuse holds the live one.
STATIC_PROMPT_FILE = "piloti_static.md"
#: What the live text is called in Langfuse. A wire name: every version in the
#: store and ``scripts/prompts_pull.py`` are keyed on it, so it moves only with
#: a rename in Langfuse itself.
STATIC_PROMPT_NAME = "piloti-system-static"


@functools.cache
def system_prompt_template() -> str:
    """Piloti's prompt template, read from disk once per process.

    A missing or unreadable prompt raises ``PromptError`` at the first
    construction, which is boot: production must never run on a stub prompt,
    and a typed failure at boot is the only place the fault is cheap.

    The static half is resolved here too, although the return value does not
    carry it. That is deliberate: this function is called once, at boot, so the
    store's first fetch — the only one that can block on the network — is paid
    where nobody is waiting on a turn, and the process starts with the identity
    its traces will name already resolved.
    """
    resolve_static_block()
    return load_prompt(PROMPTS_DIR, PROMPT_NAME)


@functools.cache
def bundled_static_block() -> ResolvedPrompt:
    """The bundled fallback, with the identity that says it IS the fallback.

    Named by its path and versioned by its git blob hash, so a trace stamped
    with this version names a text an operator can produce with
    ``git cat-file -p <hash>`` — and a fleet running on the bundled prompt is
    visible in the trace list rather than indistinguishable from one serving
    the live Langfuse version.
    """
    path = PROMPTS_DIR / STATIC_PROMPT_FILE
    return ResolvedPrompt(
        text=load_prompt(PROMPTS_DIR, STATIC_PROMPT_FILE),
        name=f"git:{path.relative_to(AGENT_DIR)}",
        version=git_blob_version(path),
        is_fallback=True,
    )


def resolve_static_block() -> ResolvedPrompt:
    """The static half to render with, and the prompt link for this turn's spans.

    The store returns the bundled fallback unless prompt management is on, the
    credentials are present, and Langfuse answered — see
    ``common/prompt_store.py`` for the budget that guarantees a turn never
    waits on it twice.

    Only a Langfuse version becomes a prompt LINK. The bundled fallback names
    no prompt Langfuse holds and is versioned by a git blob hash where the
    ingestion schema wants an int, and a generation carrying that is dropped
    whole. It is recorded as a fallback instead and reaches the trace as
    free-form metadata through :func:`record_static_prompt_metadata`.
    """
    resolved = prompt_store().get(STATIC_PROMPT_NAME, fallback=bundled_static_block())
    if not resolved.is_fallback and not _renders(resolved.text):
        # The store's promise ("never raises into a turn") covers the FETCH.
        # The text it fetched is still a Jinja template one layer up, and a
        # prompt author who pastes a JSON example with ``{{`` into Langfuse
        # would otherwise fail every turn on every replica for as long as the
        # version is published. The bundled file is the floor here too.
        resolved = bundled_static_block()
    # One record for both outcomes: a fallback is recorded AS a fallback, which
    # is no link and is what the trace metadata names; a served version is the
    # link. Recording the fallback rather than clearing is what stops a process
    # that served a version and then fell back from naming it on generations.
    record_prompt_link(name=resolved.name, version=resolved.version, is_fallback=resolved.is_fallback)
    return resolved


async def stamp_static_prompt_for_turn() -> str:
    """Resolve the static half for THIS turn, then name a fallback in its trace.

    Awaited on the event loop at the start of a turn. The resolution runs in a
    worker thread because the store may fetch; the stamp runs on the loop
    because ``asyncio.to_thread`` copies the context, so a ContextVar written
    in the thread dies with it. Resolving first is what makes the stamp this
    turn's: the render that follows hits the store's cache and serves the same
    identity. Never raises: the store never raises into a turn, and
    ``record_trace_metadata`` absorbs its own failures.

    Returns the rendered static half, the bytes ``render_system_prompt`` opens
    with this turn, so the caller can name it as the provider cache's stable
    prefix (``prompt_caching.begin_stable_prefix``). Rendered here from the
    same resolution, so it cannot differ from what the turn's prompt starts
    with; the render is cached on the text, so this costs a hash.
    """
    static_text = await asyncio.to_thread(_render_resolved_static_block)
    record_static_prompt_metadata()
    return static_text


def _render_resolved_static_block() -> str:
    return render_static_block(resolve_static_block().text)


def record_static_prompt_metadata() -> None:
    """Name a bundled-fallback render in this turn's trace metadata, on the loop.

    Reads the turn's own record, so a transition another turn makes between
    this turn's resolve and its stamp names nothing here.
    """
    fallback = current_fallback_identity()
    if fallback is None:
        return
    name, version = fallback
    record_trace_metadata(prompt_name=name, prompt_version=version)


@functools.lru_cache(maxsize=4)
def _renders(static_text: str) -> bool:
    """Whether a served text renders as the static half; logged once per text."""
    try:
        render_static_block(static_text)
    except PromptError:
        logger.warning(
            "The static prompt served by the store does not render as a template; "
            "the bundled file serves until the published version is fixed",
            exc_info=True,
        )
        return False
    return True


@functools.lru_cache(maxsize=4)
def render_static_block(static_text: str) -> str:
    """Substitute the one variable the static half carries, once per distinct text.

    The static half is plain text but for ``{{ answer_envelope_schema }}``,
    which ``render_prompt_template`` injects from the models that validate the
    envelope (one source of truth, and no caller can teach an empty schema).
    ``document_inventory`` is passed empty only to skip that injection's work:
    the static half never lists files.

    Cached on the text, so a re-render costs a hash of ~33 KB rather than a
    Jinja pass, and a new Langfuse version re-renders exactly once. The
    trailing newlines come off because the boundary marker in ``piloti.j2``
    owned that joint before the split: the file's mandatory final newline and a
    Langfuse-stored text that has none must produce the same bytes.
    """
    return render_prompt_template(static_text, document_inventory="").rstrip("\n")


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


def oib_applicability(project_context: str | None) -> str | None:
    """Which OIB-Richtlinien this project's own facts make applicable, or None.

    The one part of the old ``## Normenregister`` block that survives the cut:
    the catalog itself was a list of RIS addresses ``ris_lookup`` resolves from
    a free-text question (ADR-0060 (d)), while this section is derived from the
    project's `confirmed:` facts and no tool can produce it from the question.
    Fail-open, because a verdict list is never worth a turn.
    """
    try:
        return render_project_block(project_context or "")
    except Exception:  # noqa: BLE001 — applicability must never break prompt building
        logger.warning("piloti: OIB applicability block failed — omitted", exc_info=True)
        return None


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
        # Everything above the KV-cache boundary, resolved through the prompt
        # store: the committed file unless a Langfuse version is being served.
        static_block=render_static_block(resolve_static_block().text),
        tools=list(tools_info),
        # The <entwuerfe> block is rendered only for a turn that HAS the working
        # directory bound (`tools/documents`). A turn without a conversation to
        # namespace by gets no file verbs, and a prompt telling that model to
        # write a document would be describing a tool it cannot call. What the
        # block still carries is the two sentences no tool description can: the
        # anaphora („mach daraus ein File") and what happens without a project.
        # Everything else it used to say is in `write_file`, `edit_file`,
        # `file_draft` and `submit_draft` (ADR-0060 (d)).
        drafting_enabled=any(tool.get("name") == "write_file" for tool in tools_info),
        user_info=state.user_info,
        current_datetime=datetime.now().strftime("%Y-%m-%d"),
        available_documents=documents,
        # The conversation's "already read" digest, rendered right after the
        # inventory: what THIS conversation opened, for the locator-first rule.
        # None renders no section (the template guards it).
        already_read_block=render_already_read_block(state.already_read_digest),
        # Not a document list: the files that are NOT yet in one. The renderer
        # hands it to the inventory block.
        in_flight_documents=state.in_flight_documents,
        project_context=state.project_context,
        platform_lessons=render_lessons_block(state.platform_lessons),
        # The office's own standing instructions, below the KV-cache boundary
        # because they vary per tenant. Bounded at the header boundary
        # (``project_context.ORG_INSTRUCTIONS_MAX_CHARS``), so nothing here has
        # to remember a cap; the template frames them as preferences that
        # neither supply a normative value nor outrank the static rules.
        org_instructions=state.org_instructions,
        focus_file_name=state.focus_file_name,
        focus_shelf_label=shelf_label(state.focus_shelf),
        oib_applicability=oib_applicability(state.project_context),
        parcel_note=parcel_note(documents),
        # The L1 skills catalog, collated by the register layer; None renders
        # no section.
        skills_block=state.skills_block,
    )
    if os.environ.get("DEBUG_PROMPTS"):
        logger.debug("Rendered system prompt:\n%s", rendered)
    return rendered
