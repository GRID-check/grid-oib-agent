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
from collections.abc import Sequence
from contextvars import ContextVar
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

#: How much of one alternative formulation the notice below prints. The notice
#: is a line the model reads before the excerpts, not a transcript.
_NOTICE_QUERY_CHARS = 120

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


def requery_notice(queries: Sequence[str]) -> str:
    """The one line about the widening that the MODEL reads, or ``""``.

    Until this existed the loop was invisible to the agent that had asked for
    the search: the judge decided the first pool could not answer the question,
    the pipeline searched again in words the model never chose, and the model
    was handed the widened excerpts as if they were the answer to its own
    query. Whichever way the turn then went — an answer built on a paraphrase
    of the question, or a second search repeating a formulation that had
    already been tried — the model could not know which, because nothing told
    it. The live status line said so to the READER (``emit_retrieval_requery``)
    and to nobody else.

    German, because the model writes German and this line sits in the tool
    result beside German excerpts. One sentence, named formulations, no
    instruction: what to do about it is the model's next decision, and a line
    that told it would be the pipeline steering the loop a second time.

    Returns ``""`` when nothing was widened, so the common one-shot search
    carries no prefix at all.
    """
    named = [" ".join(query.split())[:_NOTICE_QUERY_CHARS] for query in queries if query and query.strip()]
    if not named:
        return ""
    count = "eine Umformulierung" if len(named) == 1 else f"{len(named)} Umformulierungen"
    formulations = "; ".join(f"„{query}“" for query in named)
    return (
        f"Hinweis: die Suche wurde um {count} erweitert ({formulations}), "
        "weil die ersten Treffer die Frage nicht abdeckten.\n\n"
    )


# ---------------------------------------------------------------------------
# Latency gate: skip the judge when the pool is already decisive.
#
# A production trace (28 s for a 684-token OIB overview) showed the loop's
# cost centre: 3 sequential search rounds (~9 s), 3 requery-judge firings
# (~4 s) and 2 full-context card generations (~4 s+). Token cost is not the
# concern; seconds and redundant work are. On lookups the judge manufactures
# the insufficiency verdict that causes an entire second retrieval round
# (~3 s+) plus its own latency, so the gate below skips it when the first
# pool already answers the question, and the per-turn cap bounds the worst
# case to one firing no matter what the judge says.
#
# Fail-open throughout: any missing score, unparseable query or absent
# context reads as "judge", never as "skip".
# ---------------------------------------------------------------------------

#: Top-1 cosine at or above this reads as decisive. Calibrated against the
#: golden set on multilingual-e5-small, where answerable questions run
#: 0.799-0.933 and unanswerable ones 0.795-0.865: 0.88 sits above the
#: overlap, so only a pool the embedding itself is confident about skips.
_STRONG_TOP1_FLOOR = 0.88

#: Mean of the top-3 cosines at or above this reads as decisive together
#: with the top-1 floor. A single strong hit beside two weak ones is a
#: neighbour, not an answer; three strong hits are the corpus agreeing.
_STRONG_TOP3_MEAN_FLOOR = 0.80

#: How many head scores the mean is read off. Fewer chunks than this never
#: skip on scores alone (fail-open to the judge).
_STRONG_MIN_CHUNKS = 3

#: A query naming a norm family, a Fundstelle or a file is a lookup, not an
#: exploration: the first pool is addressed, and paraphrasing it across every
#: collection drags in what the caller did not ask for. Casefolded search;
#: each pattern is deliberately narrow so a topic question ("Brandschutz im
#: Wohnbau") never matches.
_KNOWN_ENTITY_PATTERNS = (
    r"oib[-\s_]*rl",  # OIB-RL 2, OIB_RL_2, OIB RL 2.1
    r"richtlinie\s*\d",  # Richtlinie 2
    r"\brl\s*\d",  # RL 2
    r"\bpkt\.?\b",  # Pkt. 5.1
    r"\bpunkt\b",  # Punkt 5.1
    r"§",  # § 12
    r"\bseite\b",  # Seite 12
    r"\bpage\b",  # page 12
    r"\btabelle\b",  # Tabelle 1b
    r"\.pdf\b",  # an indexed file name
    r"oib-rl_",  # the corpus file stem
)

_KNOWN_ENTITY_RE = re.compile("|".join(_KNOWN_ENTITY_PATTERNS), re.IGNORECASE)

#: Hard cap: one requery firing per turn. The flag lives on a ContextVar so
#: sequential searches in one turn share it and tests can reset it; the
#: caller resets it on round zero (see register.py).
_REQUERY_FIRED: ContextVar[bool] = ContextVar("knowledge_requery_fired", default=False)


def _head_scores(chunks: Sequence[Any]) -> list[float]:
    """The head cosine scores, best first, or ``[]`` when unreadable."""
    try:
        scores: list[float] = []
        for chunk in list(chunks or [])[:_STRONG_MIN_CHUNKS]:
            score = getattr(chunk, "score", None)
            if isinstance(score, bool) or not isinstance(score, (int, float)):
                return []
            value = float(score)
            if not 0.0 <= value <= 1.0:
                return []
            scores.append(value)
        return scores
    except Exception:
        return []


def scores_decisively_strong(chunks: Sequence[Any]) -> bool:
    """True when the pool's head is strong enough that judging wastes a call.

    Pure, so tests pin it without a model: top-1 at or above
    :data:`_STRONG_TOP1_FLOOR` AND the top-3 mean at or above
    :data:`_STRONG_TOP3_MEAN_FLOOR`. Anything unreadable is not strong.
    """
    scores = _head_scores(chunks)
    if len(scores) < _STRONG_MIN_CHUNKS:
        return False
    return scores[0] >= _STRONG_TOP1_FLOOR and (sum(scores) / len(scores)) >= _STRONG_TOP3_MEAN_FLOOR


def is_known_entity_lookup(query: str) -> bool:
    """True when ``query`` names a family, a Fundstelle or a file.

    Pure string test, no model: an OIB-RL mention, a Punkt/paragraph/page
    marker or a filename means the caller is addressing evidence, and the
    judge's paraphrases are the opposite of what was asked.
    """
    if not isinstance(query, str) or not query.strip():
        return False
    return _KNOWN_ENTITY_RE.search(query) is not None


def should_skip_judge(query: str, chunks: Sequence[Any], *, file_name: str | None = None) -> tuple[bool, str]:
    """Whether the judge should not run, and the machine-readable reason.

    Returns ``(True, reason)`` with reason one of ``"file_pinned"``,
    ``"strong_scores"`` or ``"known_entity"``, else ``(False, "")``.
    A pinned ``file_name`` is the existing precision-lookup rule, stated here
    so instrumentation and tests read one gate instead of two. Never raises.
    """
    try:
        if file_name and str(file_name).strip():
            return True, "file_pinned"
        if scores_decisively_strong(chunks):
            return True, "strong_scores"
        if is_known_entity_lookup(query):
            return True, "known_entity"
        return False, ""
    except Exception:
        return False, ""


def requery_already_fired() -> bool:
    """Whether this turn already spent its one requery firing."""
    try:
        return bool(_REQUERY_FIRED.get())
    except Exception:
        return False


def claim_requery_slot() -> bool:
    """Claim the turn's one firing; False means it was already spent.

    The first caller wins; every later firing in the same context loses, so
    three sequential searches cost at most one second round no matter what
    three judges would have said.
    """
    try:
        if _REQUERY_FIRED.get():
            return False
        _REQUERY_FIRED.set(True)
        return True
    except Exception:
        return True


def reset_requery_slot() -> None:
    """Open a new turn's firing slot. Fail-open; never raises."""
    try:
        _REQUERY_FIRED.set(False)
    except Exception:
        pass
