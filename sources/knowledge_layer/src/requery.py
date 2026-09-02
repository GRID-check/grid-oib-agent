"""Sufficiency judgement and re-query for ``knowledge_search``.

Retrieval used to be one shot: the query went to every collection in scope,
the channels were fused, the pool was reranked, and whatever came out was the
answer's evidence. Nothing judged whether that pool could answer the question,
and nothing tried a second formulation when it could not. A question phrased
the way a planner talks ("wie lang darf der Fluchtweg sein") and a corpus that
says it the way a norm talks ("Gehweglänge … höchstens 40 m") met only if the
embedding bridged the gap.

This module is the judge half of that loop. Shown the question and the fused
pool, the model says whether the pool contains what is needed and, if not,
proposes a handful of alternative formulations a search index would match.
The caller retrieves those, fuses the new channels into the same RRF, and
reranks the widened pool. The fusion machinery was already N-ary; this is the
part that was missing (rag-system-audit-2026-08 F13).

Fail-open throughout: a missing model, a timeout, an unparseable reply or a
reply that proposes nothing all read as "sufficient", and the search proceeds
exactly as it did before this module existed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from knowledge_layer.rerank import _build_user_prompt

logger = logging.getLogger(__name__)

#: How many candidates the judge is shown. Sufficiency is a property of the
#: head of the ranking, and showing the whole reranker pool would make this
#: call as large as the reranker's for a yes/no answer.
_JUDGE_CANDIDATES = 12

#: Per-candidate excerpt for the judge — enough to see whether the operative
#: sentence is there, not enough to read the whole chunk.
_JUDGE_EXCERPT_CHARS = 600

#: Upper bound on the judge call. It runs beside the reranker, so it costs
#: nothing while it is faster than that; past this it costs the turn.
DEFAULT_TIMEOUT_SECONDS = 15.0

#: A proposed query longer than this is a paragraph, not a search.
_MAX_QUERY_CHARS = 300

_SYSTEM_PROMPT = (
    "You judge whether a set of retrieved excerpts is enough to answer a question, "
    "and if it is not, you propose better search queries.\n\n"
    "The excerpts come from a search index over building regulations, guidance "
    "documents and project files. They were retrieved for the question as the user "
    "phrased it. The index matches wording, so a question phrased in everyday terms "
    "can miss passages that state the same thing in the terminology the source "
    "texts themselves use.\n\n"
    "Decide:\n"
    "- sufficient: true when the excerpts contain the governing statement the "
    "question needs (the requirement, the threshold, the dimension, the definition, "
    "or the fact about the project). false when they only circle the topic, when the "
    "operative statement is missing, or when there are no excerpts at all.\n"
    "- queries: when not sufficient, up to N alternative search queries, in the "
    "language the source texts are written in. Each must differ in wording from the "
    "original and from each other: use the terminology the sources would use, name "
    "the specific concept the question is about, split a compound question into its "
    "parts. Do not repeat the original query. When sufficient, return an empty list.\n\n"
    'Return ONLY a JSON object of the form {"sufficient": true, "queries": []}. '
    "No prose, no markdown."
)


@dataclass(frozen=True)
class SufficiencyVerdict:
    """What the judge decided, and what to search next if it decided "no"."""

    sufficient: bool
    queries: list[str] = field(default_factory=list)

    @property
    def wants_requery(self) -> bool:
        return not self.sufficient and bool(self.queries)


SUFFICIENT = SufficiencyVerdict(sufficient=True)


def _normalised(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


def _parse_verdict(raw: str, *, original_query: str, max_queries: int) -> SufficiencyVerdict | None:
    """Read the judge's JSON; ``None`` for anything that is not the contract.

    Lenient about a code fence or prose around the object, strict about the
    object itself: ``sufficient`` must be a real boolean and ``queries`` a list
    of strings. Proposed queries are de-duplicated, trimmed, and compared to
    the original so a model that paraphrases by repeating cannot spend a
    retrieval on the query that already ran.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    sufficient = parsed.get("sufficient")
    if not isinstance(sufficient, bool):
        return None

    seen = {_normalised(original_query)}
    queries: list[str] = []
    raw_queries = parsed.get("queries")
    for candidate in raw_queries if isinstance(raw_queries, list) else []:
        if not isinstance(candidate, str):
            continue
        cleaned = " ".join(candidate.split())[:_MAX_QUERY_CHARS].strip()
        key = _normalised(cleaned)
        if not key or key in seen:
            continue
        seen.add(key)
        queries.append(cleaned)
        if len(queries) >= max_queries:
            break
    return SufficiencyVerdict(sufficient=sufficient, queries=queries)


async def judge_sufficiency(
    llm: Any,
    query: str,
    chunks: list[Any],
    *,
    max_queries: int,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> SufficiencyVerdict:
    """Ask ``llm`` whether ``chunks`` can answer ``query``; fail-open to sufficient.

    Args:
        llm: LangChain chat model with an async ``ainvoke``; ``None`` disables.
        query: The user's question, as asked.
        chunks: The fused candidate pool, best first. May be empty — an empty
            pool is the strongest reason to try another formulation.
        max_queries: Ceiling on proposed alternative queries.
        timeout_seconds: Upper bound for the judge call.

    Returns:
        The verdict. On any failure, :data:`SUFFICIENT`, so the caller's search
        is exactly the one-shot search it always was.
    """
    if llm is None or not query or max_queries <= 0:
        return SUFFICIENT

    shown = list(chunks[:_JUDGE_CANDIDATES])
    user_prompt = (
        _build_user_prompt(query, shown, _JUDGE_EXCERPT_CHARS) if shown else f"Question: {query}\n\nCandidates: none."
    )
    user_prompt += f"\n\nPropose at most {max_queries} alternative queries if the candidates are not sufficient."

    try:
        response = await asyncio.wait_for(
            llm.ainvoke([("system", _SYSTEM_PROMPT), ("user", user_prompt)]),
            timeout=timeout_seconds,
        )
        content = getattr(response, "content", None)
        if content is None and isinstance(response, dict):
            content = response.get("content")
        raw = str(content or "")
        if not raw:
            raise ValueError("empty judge reply")
        verdict = _parse_verdict(raw, original_query=query, max_queries=max_queries)
        if verdict is None:
            logger.warning("Sufficiency judge reply did not match the contract; treating the pool as sufficient")
            return SUFFICIENT
        if verdict.wants_requery:
            logger.info(
                "Sufficiency judge asked for %d alternative quer(y/ies) for %r", len(verdict.queries), query[:60]
            )
        return verdict
    except Exception as e:
        logger.warning("Sufficiency judge failed (%s: %s); treating the pool as sufficient", type(e).__name__, e)
        return SUFFICIENT
