"""Relevance reranking of retrieved chunks against the query.

The default Chroma path is pure vector top-k, so the retrieved set is ordered by
embedding proximity rather than by whether a chunk actually answers the question.
Reranking converts that recall into precision, and it is the stage that pays for
over-fetching in the first place.

Two rankers live here, tried in order and both fail-open:

1. :func:`rerank_chunks` -- an LLM acting as a relevance judge, scoring every
   candidate in one batched call.
2. the cross-encoder in :mod:`knowledge_layer.cross_encoder`, when one is
   configured -- resolved by the caller and passed in as ``cross_encoder``.

Fail-open is deliberate and absolute: any error, timeout, malformed reply or
unusable score set leaves the input order untouched, because retrieval must
never be a gate. The distinction this module draws is between *failing* (keep
the retrieval order, say so in the log) and *succeeding with a bad reply* --
the second is the dangerous one, because a judge that renumbers, repeats or
omits candidates produces an order that looks reranked and is not. Every such
reply is rejected rather than absorbed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
from typing import Any

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = (
    "You are a retrieval relevance judge for an Austrian building-code (OIB-Richtlinien) "
    "assistant. The candidates are German-language excerpts from building regulations, "
    "guidance documents and project files.\n\n"
    "Score every candidate 0-10 for how directly it answers the user's question:\n"
    "  10-8  states the governing requirement itself (the Punkt, the threshold, the "
    "dimension, the explicit obligation) for exactly what was asked\n"
    "  7-5   on-topic and useful context, but not the governing requirement\n"
    "  4-2   same general subject area, does not bear on the question\n"
    "  1-0   unrelated, or a heading/table-of-contents fragment with no substance\n\n"
    "Rules:\n"
    "- Prefer a chunk that names the applicable Punkt or paragraph over one that only "
    "mentions the topic.\n"
    "- Judge the German text on its own terms; do not penalise a chunk for not being in "
    "the language of the question.\n"
    "- Break ties by preferring the more specific and self-contained excerpt.\n"
    "- Return EXACTLY ONE entry for EVERY candidate number shown, using the numbering "
    "given, from 1 to N. Do not renumber, skip or repeat.\n"
    "- Scores must be whole numbers.\n\n"
    'Return ONLY a JSON object of the form {"scores": [{"i": 1, "score": 8}, ...]}. '
    "No prose, no markdown."
)

# Per-candidate excerpt budget. The judge cannot rank text it was not shown, and
# in OIB prose the operative sentence (the dimension, the threshold, the "muss")
# routinely sits well past the Punkt heading and its preamble.
_CHUNK_EXCERPT_CHARS = 1200

# Whole-prompt excerpt budget. Candidate pools are meant to be large, so the
# per-chunk budget above has to yield to a total bound rather than multiply by
# it. ~60k chars is ~15k tokens of German at the ~4.0 chars/token this corpus
# measures, which leaves headroom in every context window the judge may run on.
_TOTAL_EXCERPT_BUDGET_CHARS = 60_000

# Floor for the adaptive per-chunk budget: below this an excerpt is a heading and
# nothing else, and reranking on it is worse than not reranking.
_MIN_EXCERPT_CHARS = 300


def _excerpt_budget(chunk_count: int, max_doc_chars: int) -> int:
    """Per-candidate excerpt size that keeps the whole prompt within budget."""
    if chunk_count <= 0:
        return max_doc_chars
    affordable = _TOTAL_EXCERPT_BUDGET_CHARS // chunk_count
    return max(_MIN_EXCERPT_CHARS, min(max_doc_chars, affordable))


def _format_page(chunk: Any) -> str:
    """Render a chunk's page as ``p.12``, or nothing when it has no page.

    ``page_number`` is ``int | None``, so a ``getattr`` default never fires for a
    chunk whose page is genuinely absent -- the attribute exists and holds
    ``None``. Rendering that as ``p.None`` spends prompt tokens telling the judge
    nothing.
    """
    page = getattr(chunk, "page_number", None)
    return f" p.{page}" if page else ""


def _build_user_prompt(query: str, chunks: list[Any], max_doc_chars: int = _CHUNK_EXCERPT_CHARS) -> str:
    budget = _excerpt_budget(len(chunks), max_doc_chars)
    lines = [f"Question: {query}", "", f"Candidates (score all {len(chunks)}):", ""]
    for index, chunk in enumerate(chunks, start=1):
        content = getattr(chunk, "content", "")
        if len(content) > budget:
            content = content[:budget] + "…"
        source = getattr(chunk, "file_name", "")
        lines.append(f"[{index}] {source}{_format_page(chunk)}: {content}")
        lines.append("")
    return "\n".join(lines)


def _is_real_number(value: Any) -> bool:
    """True for a usable numeric score.

    Rejects ``bool`` (a subclass of ``int``, so ``{"score": true}`` would
    otherwise be read as 1.0) and non-finite floats -- ``json.loads`` accepts
    ``NaN``, and a single NaN makes the whole sort order implementation-defined
    because every comparison against it is false.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


def _parse_scores(raw: str) -> list[tuple[int, float]]:
    """Parse ``{"scores": [{"i": int, "score": float}]}`` out of a model reply.

    Tolerates markdown fences and surrounding prose; drops malformed entries.
    Entry order is preserved so the caller can resolve duplicates first-wins.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:].strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return []
    try:
        payload = json.loads(text[start : end + 1])
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(payload, dict):
        return []
    entries = payload.get("scores")
    if not isinstance(entries, list):
        return []
    parsed: list[tuple[int, float]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        index = entry.get("i")
        score = entry.get("score")
        if isinstance(index, bool) or not isinstance(index, int):
            continue
        if not _is_real_number(score):
            continue
        parsed.append((index, float(score)))
    return parsed


def _validated_scores(parsed: list[tuple[int, float]], chunk_count: int) -> dict[int, float] | None:
    """Turn parsed entries into a usable ``{1-based index: score}`` map, or ``None``.

    Returns ``None`` -- meaning "fail open, keep the retrieval order" -- when no
    entry refers to a candidate that was actually sent. That is the signature of a
    judge that renumbered (a 0-based reply) or answered about a different list,
    and absorbing it silently produces a *wrong* order indistinguishable from a
    successful rerank in the logs.

    Duplicate indices resolve first-wins (a repeat is a transcription slip, not a
    revision) and out-of-range indices are dropped, both with a warning -- the
    previous ``dict()`` collapse silently let a repeated index *demote* a chunk.
    """
    if chunk_count <= 0:
        return None

    scores: dict[int, float] = {}
    out_of_range = 0
    duplicates = 0
    for index, score in parsed:
        if not 1 <= index <= chunk_count:
            out_of_range += 1
            continue
        if index in scores:
            duplicates += 1
            continue
        scores[index] = score

    if out_of_range:
        logger.warning("Rerank judge returned %d score(s) outside 1..%d; dropped", out_of_range, chunk_count)
    if duplicates:
        logger.warning("Rerank judge repeated %d index(es); kept the first score for each", duplicates)

    if not scores:
        logger.warning("Rerank judge scored none of the %d candidates; keeping retrieval order", chunk_count)
        return None
    return scores


def _ranked_order(chunks: list[Any], scores: dict[int, float]) -> list[Any]:
    """Order ``chunks`` by judged score, imputing the mean for unscored candidates.

    Models routinely score only a prefix of a long candidate list. Treating those
    omissions as a low score buries them beneath candidates the judge explicitly
    rejected -- with twenty candidates and a reply covering eight, twelve
    top-ranked hits would sort below a chunk scored 0 ("completely irrelevant").

    An omission is not a rejection, it is an absence of opinion, so an unscored
    candidate is imputed the mean of the scores the judge did give: above anything
    actively rejected, below anything actively preferred, and neutral overall.
    Scored candidates win ties against imputed ones, and ``sorted`` is stable
    (``reverse=True`` does not reverse ties), so equals keep their retrieval order.
    """
    mean_score = sum(scores.values()) / len(scores)
    return [
        chunk
        for _, chunk in sorted(
            enumerate(chunks),
            key=lambda pair: (scores.get(pair[0] + 1, mean_score), pair[0] + 1 in scores),
            reverse=True,
        )
    ]


def _trim(chunks: list[Any], top_n: int | None) -> list[Any]:
    """Trim to ``top_n``; ``None`` and non-positive both mean "no trim".

    A non-positive ``top_n`` used to slice the result to nothing, which turned a
    misconfigured ``rerank_candidates`` into an empty knowledge base with the
    fail-open path failing open to zero chunks.
    """
    if top_n is None or top_n <= 0:
        return chunks
    return chunks[:top_n]


async def rerank_chunks(
    llm: Any,
    query: str,
    chunks: list[Any],
    *,
    top_n: int | None = None,
    timeout_seconds: float = 30.0,
    max_doc_chars: int = _CHUNK_EXCERPT_CHARS,
    cross_encoder: Any = None,
) -> list[Any]:
    """Re-order ``chunks`` by judged relevance to ``query``; fail-open to the input.

    When ``cross_encoder`` is supplied it is tried first; the LLM judge is the
    fallback. Unscored chunks sort after scored ones and keep their original
    relative order (``sorted`` is stable, and ``reverse=True`` does not reverse
    ties).

    Args:
        llm: LangChain chat model with an async ``ainvoke``. May be ``None`` when
            only a cross-encoder is configured.
        query: The user query the chunks were retrieved for.
        chunks: Retrieved chunks, best-vector-first.
        top_n: Maximum number of reranked chunks to return (default: all).
        timeout_seconds: Upper bound for the judge call.
        max_doc_chars: Per-candidate excerpt budget, reduced automatically to keep
            the whole prompt within :data:`_TOTAL_EXCERPT_BUDGET_CHARS`.
        cross_encoder: Optional object with
            ``async rerank(query, chunks, top_n) -> list[chunk] | None``.

    Returns:
        The re-ordered (and trimmed) chunks, or the original (trimmed) list on any
        failure.
    """
    if not chunks or not query:
        return chunks

    if cross_encoder is not None:
        try:
            ranked = await cross_encoder.rerank(query, chunks, top_n=top_n)
            if ranked:
                logger.info("Cross-encoder reranked %d candidate(s)", len(chunks))
                return _trim(ranked, top_n)
            logger.warning("Cross-encoder returned no ranking; falling back to the LLM judge")
        except Exception as e:
            logger.warning(
                "Cross-encoder reranking failed (%s: %s); falling back to the LLM judge", type(e).__name__, e
            )

    if llm is None:
        return _trim(chunks, top_n)

    try:
        response = await asyncio.wait_for(
            llm.ainvoke([("system", _SYSTEM_PROMPT), ("user", _build_user_prompt(query, chunks, max_doc_chars))]),
            timeout=timeout_seconds,
        )
        content = getattr(response, "content", None)
        if content is None and isinstance(response, dict):
            content = response.get("content")
        raw = str(content or "")
        if not raw:
            raise ValueError("empty judge reply")

        scores = _validated_scores(_parse_scores(raw), len(chunks))
        if scores is None:
            return _trim(chunks, top_n)

        logger.info("LLM judge reranked %d candidate(s) (%d scored)", len(chunks), len(scores))
        return _trim(_ranked_order(chunks, scores), top_n)
    except Exception as e:
        # `%s: %s` on the type and the message: the single most likely failure is
        # `asyncio.TimeoutError`, whose str() is empty, so the old log line ended
        # at the colon and named neither the cause nor the stage.
        logger.warning("LLM reranking failed (%s: %s), keeping original order", type(e).__name__, e)
        return _trim(chunks, top_n)
