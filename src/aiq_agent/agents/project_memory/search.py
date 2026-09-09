"""``search_memory`` tool — the read half of long-term memory (ADR-0055).

``remember`` writes and, until this tool, nothing read on demand. Memory reached
a turn exactly one way: a digest injected before the agent ran, capped at 1800
characters and twenty items, re-selected each turn against that turn's question.
A project with two hundred findings therefore had a hundred and eighty that no
question could reach, and the digest's own text disclosed the omission to the
MODEL and to nobody else.

This is the second path, and it is deliberately the same path: the recall the
BFF runs for this tool is the recall it runs for the digest
(``lib/knowledge/recall-scoring.ts``), so the tool and the digest cannot
disagree about what is relevant. Everywhere else in this system a bounded
selection is paired with a way to reach the rest — retrieval for the corpus,
mounting for projects (ADR-0054) — and memory was the exception.

**The model chooses the query. It does not choose the scope.** The tool passes
the turn's own organization and, on a project turn, the turn's own project; the
BFF then decides what that means (contract C1: a project turn sees its project's
notes plus the organization's, an office turn sees organization-scoped notes
only, and neither ever sees another project's). There is no scope argument, and
its absence is the design rather than an omission: the endpoint enforcing the
rule is not a reason to offer a knob that can ask for the wrong thing. The same
goes for the ids — they come off the request context, never off the model.

Bounded like every tool here, and the RESULT says that it is bounded: the block
names how many notes it is showing out of how many exist, so a model reading a
truncated list cannot answer "what do you know about the cellar" as if it had
seen everything (``src/aiq_agent/AGENTS.md``, the rule ``render_inventory_block``
carries).

Errors come back as strings, never raised: a tool that raises takes the turn
down, and memory that is briefly unreachable is a recall problem, not an answer
problem.
"""

import asyncio
import logging

from pydantic import Field

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

#: Per-note ceiling in the rendered block. A stored note is allowed 2000
#: characters; twenty of those would be a second context on a single tool call,
#: which is the cost this cap exists to refuse. Generous enough that an ordinary
#: one-sentence finding is never cut.
_NOTE_MAX_CHARS = 400

_TOOL_DESCRIPTION = (
    "Search Piloti's long-term memory for notes that are NOT in the PROJECT_MEMORY block already "
    "in your context. Memory holds more than that block can show: the block is a bounded selection "
    "for this question, and it says how many notes it left out.\n"
    "Call this in exactly two situations:\n"
    "1. the PROJECT_MEMORY block says that further notes were omitted, AND the question needs one "
    "of them;\n"
    "2. the question names something specific — a decision, a constraint, an earlier agreement, a "
    "deadline, a client preference — that the block does not contain, and that would plausibly "
    "have been recorded earlier.\n"
    "Do NOT call it to re-read something the block already shows, to look for building-code "
    "knowledge (that lives in the corpus and is found with the search tools), or on the chance that "
    "there might be something. It costs a round trip and one of this turn's tool calls.\n"
    "Pass what you are looking for as `query`, in the user's own words; German works. `limit` "
    "raises how many notes come back, up to 20 — leave it unset for the default.\n"
    "What comes back is a BOUNDED list of the best-matching notes, each with its kind, its "
    "confidence and whether a person confirmed it. It is memory, not evidence: you may act on a "
    "note and say where it came from, and you may NOT cite one as a legal source."
)


class ProjectMemorySearchConfig(FunctionBaseConfig, name="project_memory_search"):
    """Configuration for the long-term-memory recall tool."""

    max_results: int = Field(
        default=8,
        description="Notes returned when the caller does not ask for a different number (hard ceiling 20).",
    )


@register_function(config_type=ProjectMemorySearchConfig)
async def project_memory_search(tool_config: ProjectMemorySearchConfig, builder: Builder):
    from aiq_agent.common.turn_status import emit_memory_search
    from aiq_agent.knowledge.memory_context import record_memory_search
    from aiq_agent.knowledge.project_memory import SEARCH_MAX_LIMIT
    from aiq_agent.knowledge.project_memory import MemorySearchHit
    from aiq_agent.knowledge.project_memory import search_memory_notes
    from aiq_agent.project_context import get_organization_id_from_context
    from aiq_agent.project_context import get_project_id_from_context

    def _clamped(limit: object) -> int:
        """The number of notes to ask for: the model's, held inside the ceiling.

        A limit the tool cannot read as a size — absent, ``None``, ``True``,
        zero, negative, a word — is the CONFIGURED default and never one:
        "no particular number" is what the ordinary lookup already answers.
        """
        if limit is None or isinstance(limit, bool):
            return tool_config.max_results
        try:
            value = int(limit)  # type: ignore[call-overload]  — guarded by the except
        except (TypeError, ValueError):
            return tool_config.max_results
        if value < 1:
            return tool_config.max_results
        return min(value, SEARCH_MAX_LIMIT)

    def _render(hit: MemorySearchHit) -> str:
        """One note, in the digest's own line grammar so both read alike."""
        tags = [hit.kind or "note", hit.confidence or "medium"]
        if hit.verification:
            tags.append(hit.verification)
        if hit.pinned:
            tags.append("angeheftet")
        if hit.scope == "organization":
            tags.append("büroweit")
        content = hit.content.strip()
        if len(content) > _NOTE_MAX_CHARS:
            content = content[: _NOTE_MAX_CHARS - 1].rstrip() + "…"
        return f'- [{" | ".join(tags)}] "{content}"'

    async def _search_memory(query: str, limit: int | None = None) -> str:
        """Search long-term memory for notes the injected digest did not carry.

        Args:
            query: What you are looking for, in the user's own words.
            limit: How many notes to return, 1 to 20. Omit for the default.

        Returns a bounded list of matching notes. Never another project's.
        """
        query = (query or "").strip()
        if not query:
            return (
                "Error: pass what you are looking for as `query` (e.g. 'Entscheidung zum Dachaufbau'). "
                "Do not retry with an empty query."
            )

        organization_id = get_organization_id_from_context()
        if not organization_id:
            # No organisation means no memory to search: every note belongs to
            # one, and a scope-less search is the one thing this tool may never
            # perform. A refusal, not an empty result — "nothing found" would
            # read as a fact about the project.
            return (
                "Error: this conversation is not attached to an organisation, so there is no long-term "
                "memory to search. Answer from the context you have. Do not retry."
            )

        wanted = _clamped(limit)
        # The turn's OWN scope, off the request context. The project is passed
        # when the turn has one and omitted when it does not — that is the
        # difference between a project turn and a Büro turn, and it is decided
        # here rather than by the model (contract C1).
        project_id = get_project_id_from_context()

        try:
            result = await asyncio.to_thread(
                search_memory_notes,
                query=query,
                project_id=project_id,
                organization_id=organization_id,
                limit=wanted,
            )
        except Exception:
            # The client is documented not to raise, and a tool that raises
            # takes the whole turn down — so this catch is the second lock on
            # the same door rather than a duplicate of the first.
            logger.exception("Memory search failed")
            result = None

        if result is None:
            return (
                "Error: long-term memory could not be reached just now. Say that you could not look it up "
                "rather than answering from what you assume was recorded. Do not retry more than once."
            )

        hits = list(result.items)
        if not hits:
            return (
                f"No note in long-term memory matched '{query}'. Nothing was found — do not state a "
                "remembered fact anyway. What is already in your PROJECT_MEMORY block is all there is "
                "on this question."
            )

        # The reader learns that the agent went past the digest, and how far.
        # Recorded before the block is built so the count on the line is the
        # count in the block, not a number computed twice.
        fresh = record_memory_search(tuple(hit.as_note() for hit in hits))
        emit_memory_search(fresh)

        total = max(result.total, len(hits))
        where = "diesem Projekt und dem Büro" if project_id else "dem Büro"
        lines = [
            f"{len(hits)} von {total} Notizen aus dem Gedächtnis zu '{query}' (Bereich: {where}). "
            "Dies ist eine BEGRENZTE Auswahl nach Relevanz, nicht alles, was gespeichert ist — "
            "sage nicht, dies sei das gesamte Gedächtnis. Notizen sind Gedächtnis, keine Belege: "
            "zitiere sie nicht als Rechtsquelle.",
            "",
        ]
        lines.extend(_render(hit) for hit in hits)
        return "\n".join(lines)

    yield FunctionInfo.from_fn(_search_memory, description=_TOOL_DESCRIPTION)
