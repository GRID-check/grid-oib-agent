"""LLM-judge reranking of retrieved chunks against the query.

The default Chroma path is pure vector top-k; a true cross-encoder reranker is not
available on the OpenAI-compatible endpoints this deployment uses, so relevance
re-ordering is done by an LLM acting as a judge: the chunks are scored in one batched
call and the list is re-sorted by score. Deliberately fail-open — any error, timeout or
malformed reply leaves the input order untouched, because retrieval must never be a gate.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

_SYSTEM_PROMPT = (
    "You are a retrieval relevance judge. Score each candidate chunk 0-10 for how "
    "directly it answers the user's question. Return ONLY a JSON object of the form "
    '{"scores": [{"i": 1, "score": 8}, ...]} where i is the 1-based candidate number. '
    "No prose, no markdown."
)

_CHUNK_EXCERPT_CHARS = 400


def _build_user_prompt(query: str, chunks: list[Any]) -> str:
    lines = [f"Question: {query}", "", "Candidates:", ""]
    for index, chunk in enumerate(chunks, start=1):
        content = getattr(chunk, "content", "")
        if len(content) > _CHUNK_EXCERPT_CHARS:
            content = content[:_CHUNK_EXCERPT_CHARS] + "…"
        lines.append(f"[{index}] {getattr(chunk, 'file_name', '')} p.{getattr(chunk, 'page_number', '?')}: {content}")
        lines.append("")
    return "\n".join(lines)


def _parse_scores(raw: str) -> list[tuple[int, float]]:
    """Parse ``{"scores": [{"i": int, "score": float}]}`` out of a model reply.

    Tolerates markdown fences and surrounding prose; drops malformed entries.
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
    entries = payload.get("scores")
    if not isinstance(entries, list):
        return []
    parsed: list[tuple[int, float]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        index = entry.get("i")
        score = entry.get("score")
        if isinstance(index, int) and isinstance(score, (int, float)):
            parsed.append((index, float(score)))
    return parsed


async def rerank_chunks(
    llm: Any,
    query: str,
    chunks: list[Any],
    *,
    top_n: int | None = None,
    timeout_seconds: float = 30.0,
) -> list[Any]:
    """Re-order ``chunks`` by LLM-judged relevance to ``query``; fail-open to the input.

    Unscored chunks sort after scored ones and keep their original relative order.

    Args:
        llm: LangChain chat model with an async ``ainvoke``.
        query: The user query the chunks were retrieved for.
        chunks: Retrieved chunks, best-vector-first.
        top_n: Maximum number of reranked chunks to return (default: all).
        timeout_seconds: Upper bound for the judge call.

    Returns:
        The re-ordered (and trimmed) chunks, or the original (trimmed) list on any failure.
    """
    if not chunks or not query:
        return chunks
    try:
        response = await asyncio.wait_for(
            llm.ainvoke([("system", _SYSTEM_PROMPT), ("user", _build_user_prompt(query, chunks))]),
            timeout=timeout_seconds,
        )
        content = getattr(response, "content", None)
        if content is None and isinstance(response, dict):
            content = response.get("content")
        raw = str(content or "")
        if not raw:
            raise ValueError("empty judge reply")
        scores = dict(_parse_scores(raw))
        if not scores:
            raise ValueError("no parseable scores in judge reply")

        # Scored chunks sort by score (desc); unscored (-1.0) trail them, and the
        # stable sort preserves their original relative order.
        ranked = sorted(enumerate(chunks), key=lambda pair: scores.get(pair[0] + 1, -1.0), reverse=True)
        ordered = [chunk for _, chunk in ranked]
        return ordered if top_n is None else ordered[:top_n]
    except Exception as e:
        logger.warning(f"LLM reranking failed, keeping original order: {e}")
        return chunks[:top_n]
