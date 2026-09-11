"""The turn's ONE repair of an answer that failed verification (roadmap L0).

Until this existed every failure the verifier found was handled
subtractively: the citation line deleted, the quote marked, the confidence
capped, and the answer shipped that way. A marker that says "this quote could
not be verified" is cheaper than a second search and worse for the reader in
every case where the passage exists and the model misquoted it. So, once:
retrieve again aimed at exactly what failed, rewrite with the failures named,
and let the caller re-verify and keep whichever answer verifies better.
Bounded to one retrieval per failure (two at most) and one rewrite; the
markers remain the floor.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool

from aiq_agent.common import content_to_text
from aiq_agent.common import get_source_id_for_tool
from aiq_agent.common.answer_envelope import extract_answer_envelope
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import UnverifiedQuote

# Underscore-private in ``common.citation_verification`` and imported here (and
# by ``deep_researcher/custom_middleware.py``) all the same: both are the one
# parser of the citation grammar, and re-implementing them would be a second
# grammar that can disagree. Making them public is a ``common`` change, out of
# this package's scope; the names are pinned by ``test_agent.py``.
from aiq_agent.common.citation_verification import _answer_body_before_sources
from aiq_agent.common.citation_verification import _parse_citation_key
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.turn_status import emit_answer_repair

from .dsml import strip_and_salvage_dsml_tool_calls
from .envelope_call import ainvoke_with_envelope_json_mode
from .markers import detect_and_strip_confidence_marker
from .markers import detect_and_strip_escalation_marker

logger = logging.getLogger(__name__)

#: How many retrievals one repair may spend: one per failing quote or
#: citation, capped. Two is a repair; more is a second research turn.
REPAIR_MAX_RETRIEVALS = 2

#: How many of those retrievals may be in flight at once. Equal to the cap
#: today, so both lookups of a repair overlap; kept separate because the
#: bound is about load on the retrieval stack, not about what a repair costs.
REPAIR_MAX_CONCURRENCY = 2

#: A citation marker in prose, and the file part of a written citation line
#: ("- [3] OIB-RL 2 – oib-rl_2.pdf, p.12" → "oib-rl_2.pdf").
_CITATION_MARKER_RE = re.compile(r"\[(\d+)\]")
_CITED_FILE_RE = re.compile(r"([^\s\[\]()]+\.[A-Za-z0-9]{2,5})\s*,\s*(?:p|S)\.\s*\d+")
#: How far past a quote's closing mark its citation may sit.
_CITATION_REACH = 160

_REWRITE_INSTRUCTION = (
    "\n\nRewrite the whole answer once, as your ```answer_json envelope object, keeping "
    "everything that verified. Cite only sources that appear in the retrieval results "
    "you were given, using the citations [1], [2] and the '## References' format. Put "
    "quotation marks only around text that appears verbatim in a retrieved passage; "
    "where it does not, paraphrase without quotation marks or leave the claim out. "
    "Do not call any tools."
)


@dataclass(frozen=True)
class VerificationFailures:
    """What the verifier could not confirm about the answer as written."""

    removed_citations: tuple[dict[str, Any], ...]
    unverified_quotes: tuple[UnverifiedQuote, ...]
    valid_citations: tuple[dict[str, Any], ...] = ()

    def __bool__(self) -> bool:
        return bool(self.removed_citations or self.unverified_quotes)


@dataclass(frozen=True)
class Repair:
    """The rewritten prose and the sources the repair retrieved for it."""

    prose: str
    sources: tuple[SourceEntry, ...]


def sentence_citing(body: str, number: int) -> str | None:
    """The sentence in *body* that carries ``[number]``, without its markers.

    The claim is the search; the reference line that pointed nowhere is not.
    """
    marker = f"[{number}]"
    at = body.find(marker)
    if at < 0:
        return None
    start = max(body.rfind("\n", 0, at), body.rfind(". ", 0, at) + 1, 0)
    end = at + len(marker)
    tail = re.search(r"[.!?](\s|$)|\n", body[end:])
    if tail:
        end += tail.start() + 1
    sentence = _CITATION_MARKER_RE.sub("", body[start:end])
    sentence = re.sub(r"\s+([.,;:!?])", r"\1", re.sub(r"\s{2,}", " ", sentence)).strip(" -*#\n")
    return sentence or None


def marker_for_quote(body: str, quote: UnverifiedQuote) -> int | None:
    """The ``[N]`` a quote was attributed to: the nearest marker after it.

    One reader of the citation grammar, two consumers: the lookup that
    re-searches the failing text in the document that ``[N]`` verified against,
    and the observation that tells the model WHICH marker to fix.
    """
    nearest = _CITATION_MARKER_RE.search(body, quote.end, min(len(body), quote.end + _CITATION_REACH))
    return int(nearest.group(1)) if nearest else None


def _file_by_citation_number(valid_citations: Sequence[dict[str, Any]]) -> dict[int, str]:
    """``[N]`` → the file its verified citation key names."""
    file_by_number: dict[int, str] = {}
    for citation in valid_citations:
        number = citation.get("number")
        key = citation.get("citation_key")
        if not isinstance(number, int) or not key:
            continue
        filename, _page = _parse_citation_key(str(key))
        if filename:
            file_by_number[number] = filename
    return file_by_number


def repair_lookups(
    prose: str,
    *,
    valid_citations: Sequence[dict[str, Any]],
    removed_citations: Sequence[dict[str, Any]],
    unverified_quotes: Sequence[UnverifiedQuote],
) -> list[tuple[str, str | None]]:
    """What the repair searches for, and where: ``(query, file_name)`` pairs.

    A quote the verifier could not find is searched for in the document the
    answer attributed it to: the nearest citation after the quote, resolved
    to the file it verified against. That makes the search a precision
    lookup in one document instead of a fan-out over every shelf, which is
    what put "almost every file in the project" into the Herleitung as
    read-and-not-used after a repair. A removed citation is searched for
    with the sentence that cited it (the claim, not the reference line), in
    the file the line named when it named one. Deduplicated, capped at
    :data:`REPAIR_MAX_RETRIEVALS`.
    """
    body = _answer_body_before_sources(prose)
    file_by_number = _file_by_citation_number(valid_citations)
    lookups: list[tuple[str, str | None]] = []
    for quote in unverified_quotes:
        text = quote.quote.strip()
        if not text:
            continue
        marker = marker_for_quote(body, quote)
        file_name = file_by_number.get(marker) if marker is not None else None
        lookups.append((text[:300], file_name))
    for removed in removed_citations:
        number = removed.get("number")
        line = str(removed.get("line") or "").strip()
        sentence = sentence_citing(body, number) if isinstance(number, int) else None
        query = (sentence or line)[:300]
        if not query:
            continue
        named = _CITED_FILE_RE.search(line)
        lookups.append((query, named.group(1) if named else None))
    return list(dict.fromkeys(lookups))[:REPAIR_MAX_RETRIEVALS]


def _single_query_fields(tool: BaseTool) -> dict[str, Any]:
    return getattr(getattr(tool, "args_schema", None), "model_fields", None) or {}


def repair_search_tool(tools: Sequence[BaseTool]) -> BaseTool | None:
    """The data-source tool a repair searches with: the knowledge base, else
    the first single-query data-source tool bound to the turn."""
    candidates = [
        tool
        for tool in tools
        if get_source_id_for_tool(tool.name) is not None and "query" in _single_query_fields(tool)
    ]
    for tool in candidates:
        if tool.name == "knowledge_search":
            return tool
    return candidates[0] if candidates else None


async def _retrieve(tool: BaseTool, lookups: Sequence[tuple[str, str | None]]) -> tuple[list[str], list[SourceEntry]]:
    """Run the lookups together; the passages and the sources they carry.

    Captured for the caller rather than into the registry: the graph's tool
    node is not running, and what the repair retrieved must not change the
    answer's grounding unless the repair is adopted.

    Fail-open per lookup: one bad retrieval (timeout, reranker error) is
    dropped in lookup order, not allowed to poison the other -- only an
    all-fail repair gives up, which the caller reads as empty grounding.
    Bounded to two concurrent retrievals: two is a repair, more is a second
    research turn.
    """
    scoped_search = "file_name" in _single_query_fields(tool)
    source_id = get_source_id_for_tool(tool.name)
    semaphore = asyncio.Semaphore(REPAIR_MAX_CONCURRENCY)

    def _args(query: str, file_name: str | None) -> dict[str, Any]:
        if file_name and scoped_search:
            return {"query": query, "file_name": file_name}
        return {"query": query}

    async def _lookup(query: str, file_name: str | None) -> Any:
        async with semaphore:
            return await tool.ainvoke(_args(query, file_name))

    outputs = await asyncio.gather(
        *(_lookup(query, file_name) for query, file_name in lookups),
        return_exceptions=True,
    )
    grounding: list[str] = []
    sources: list[SourceEntry] = []
    for output in outputs:
        if isinstance(output, BaseException):
            logger.warning("Piloti: repair lookup failed: %s", output)
            continue
        text = str(output or "")
        if not text:
            continue
        grounding.append(text)
        sources.extend(extract_sources_from_tool_result(tool.name, text, source_id=source_id))
    return grounding, sources


#: The name the verification result travels under in the transcript. It is not
#: a bound tool and the model can never call it: what runs is the deterministic
#: verifier (``common/citation_verification.py``), and this is its result,
#: shaped like a tool result because that is the one slot in a transcript that
#: means "this came back", as opposed to "I said it".
VERIFICATION_TOOL_NAME = "citation_check"

#: Fixed id: exactly one such call exists per repair, and the pair is built and
#: consumed in one place. A provider rejects a tool result whose call it cannot
#: find, so the two are always emitted together (``agents/piloti/AGENTS.md``).
_VERIFICATION_CALL_ID = "repair-citation-check"


def _failure_lines(body: str, failures: VerificationFailures) -> list[str]:
    """One line per failure, each naming the marker in the answer it belongs to.

    ``[?]`` is a real answer and not a gap: a quote with no citation within
    reach was never attributed to anything, and saying so is what tells the
    model to either cite it or drop the quotation marks.
    """
    lines: list[str] = []
    for quote in failures.unverified_quotes:
        marker = marker_for_quote(body, quote)
        where = f"[{marker}]" if marker is not None else "[?]"
        lines.append(f"- {where} quote not found verbatim in any retrieved passage: „{quote.quote}“")
    for removed in failures.removed_citations:
        number = removed.get("number")
        where = f"[{number}]" if isinstance(number, int) else "[?]"
        reason = removed.get("reason") or "unverifiable"
        lines.append(f"- {where} citation removed ({reason}): {str(removed.get('line') or '').strip()}".rstrip())
    return lines


def verification_observation(prose: str, failures: VerificationFailures) -> list[Any]:
    """The failed check as a tool call and its result, for the transcript.

    The repair used to reach the model as an instruction alone -- "your
    previous answer did not pass verification", with the failures rendered into
    that same human turn. So the one thing the model never saw was the
    OBSERVATION: which marker in its own text failed, and what the check
    returned. It rewrote from a summary of a check it could not see (roadmap
    section 3, "hidden loops the model does not own").

    Two messages, always together: an assistant turn carrying the call and the
    tool result answering it. A tool result with no matching call is a request
    a provider refuses, and the refusal lands on the NEXT request rather than
    this one.
    """
    lines = _failure_lines(_answer_body_before_sources(prose), failures)
    summary = f"{len(lines)} problem(s) found in the answer above:" if lines else "No problems found."
    return [
        AIMessage(
            content="",
            tool_calls=[{"name": VERIFICATION_TOOL_NAME, "args": {}, "id": _VERIFICATION_CALL_ID}],
        ),
        ToolMessage(
            content="\n".join([summary, *lines]),
            name=VERIFICATION_TOOL_NAME,
            tool_call_id=_VERIFICATION_CALL_ID,
        ),
    ]


def _rewrite_anchor(prose: str, failures: VerificationFailures, grounding: Sequence[str]) -> HumanMessage:
    """The rewrite request: every failure named, the fresh passages in hand.

    Says the failures again after the observation above has stated them as the
    check's result. The observation is what the check RETURNED; this is what to
    do about it, and a model reads its last turn hardest. Both render from
    :func:`_failure_lines`, so a third wording cannot drift in.
    """
    named = _failure_lines(_answer_body_before_sources(prose), failures)
    return HumanMessage(
        content=(
            "Your previous answer did not pass verification. Problems found:\n"
            + "\n".join(named)
            + "\n\nAdditional retrieval results, searched for exactly the text that failed:\n\n"
            + "\n\n".join(grounding)
            + _REWRITE_INSTRUCTION
        )
    )


def _clean_rewrite(response: Any) -> str:
    """The rewrite's prose, through the same extraction chain as the answer."""
    text = content_to_text(getattr(response, "content", "") or "")
    if not text.strip():
        return ""
    text = strip_and_salvage_dsml_tool_calls(text)
    text, _meta = extract_answer_envelope(text)
    text, _escalation = detect_and_strip_escalation_marker(text)
    text, _level, _reason = detect_and_strip_confidence_marker(text)
    return text.strip()


async def repair_answer(
    prose: str,
    *,
    failures: VerificationFailures,
    tools: Sequence[BaseTool],
    llm: Any,
    system_prompt: str | None,
    history: Sequence[Any],
) -> Repair | None:
    """One bounded repair: retrieve what failed, rewrite once.

    Returns ``None`` when there is nothing to search with, nothing was found,
    or the model could not answer. Retrieval and rewrite failures are logged
    and ALSO return ``None``: the answer already exists, a failed repair keeps
    it, and an exception out of here would replace a marked answer with no
    answer at all.
    """
    tool = repair_search_tool(tools)
    if tool is None:
        return None
    lookups = repair_lookups(
        prose,
        valid_citations=failures.valid_citations,
        removed_citations=failures.removed_citations,
        unverified_quotes=failures.unverified_quotes,
    )
    if not lookups:
        return None
    emit_answer_repair(
        citations_removed=len(failures.removed_citations),
        quotes_failed=len(failures.unverified_quotes),
    )
    try:
        grounding, sources = await _retrieve(tool, lookups)
    except Exception:  # noqa: BLE001 - the answer already exists; a failed repair keeps it
        logger.warning("Piloti: repair retrieval failed", exc_info=True)
        return None
    if not grounding:
        return None

    messages: list[Any] = [SystemMessage(content=system_prompt)] if system_prompt else []
    messages += [
        *history,
        AIMessage(content=prose),
        *verification_observation(prose, failures),
        _rewrite_anchor(prose, failures, grounding),
    ]
    try:
        response = await ainvoke_with_envelope_json_mode(llm, messages)
    except Exception:  # noqa: BLE001 - see above
        logger.warning("Piloti: repair rewrite failed", exc_info=True)
        return None
    text = _clean_rewrite(response)
    return Repair(prose=text, sources=tuple(sources)) if text else None
