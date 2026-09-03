"""Hypothetical-document (HyDE) retrieval channel — backlog item 14, experiment.

Textbook HyDE (Gao et al.): when the query is too vague to match the corpus,
ask a model to draft the passage that WOULD answer it, embed the draft, and
retrieve on draft similarity. The draft lives in document space (norm
register, chunk-shaped) where the vague question does not.

This module is the shape of that experiment inside this codebase, and its
limits are deliberate:

- CONDITIONAL. The draft channel fires only when the query carries no exact
  identifier (see :func:`has_exact_identifier`). A query that names its
  target precisely already reaches the exact channel; drafting beside it can
  only add hallucinated noise. Detection is by SHAPE (digits, the § glyph,
  quotes, filename suffixes, plus whatever :mod:`legal_terms` extracts) —
  there is no entity vocabulary anywhere in this module.
- RETRIEVAL PROBE ONLY. The draft is embedded and fused, then discarded. It
  never enters the generation context, the reranker still judges the
  ORIGINAL query, and the original channels always stay in the mix.
- FAIL-OPEN. No model, a slow model, an empty reply — all read as "no draft",
  and retrieval is exactly the baseline it always was.
- DEFAULT OFF. Enabled per deployment through the retrieval config; the
  golden harness (``oib_retrieval_eval.overview``) measures on-vs-off, and
  the channel ships as default behaviour only if that shows an overview lift
  with no exact-id/paraphrase regression.

No agent group: like ``rerank_llm``/``requery_llm`` this is a retrieval-plane
judge handle resolved from the ``llms:`` section, not a per-agent model —
see the NOTE on ``rerank_llm`` in ``configs/config_oib_openrouter.yml``. The
deployment points the draft at an already-configured low-temperature,
small/fast entry; no model name lives here or in the config diff that
enables the experiment.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from aiq_agent.common.legal_terms import extract_exact_terms

logger = logging.getLogger(__name__)

#: Cap on the draft, in characters. ~200 tokens of German at the ~4.0
#: chars/token this corpus measures — chunk-shaped, not answer-shaped.
HYDE_MAX_DRAFT_CHARS = 800

#: Upper bound on the draft call. It runs beside the first retrieval fan-out,
#: so it costs nothing while it is faster than that; past this it costs the
#: turn. Fail-open: a slow draft reads as no draft.
DEFAULT_TIMEOUT_SECONDS = 8.0

#: A digit run is identifier SHAPE: Richtlinie numbers, Punkt numbers,
#: dimensions, years ("oib 2", "5.1.1", "40 m"). The query names its target
#: by number and needs no hypothetical rendering of it.
_DIGIT_RE = re.compile(r"\d")

#: A filename-shaped token ("…​.pdf", "…​.docx"). The query names a document
#: and needs no hypothetical rendering of its content. Suffix classes only —
#: no filename vocabulary.
_FILENAME_SUFFIX_RE = re.compile(r"\.[A-Za-z0-9]{2,5}\b")

#: Quote characters that mark an explicitly quoted span (straight + German
#: low/high pairs + guillemets — punctuation shape, not vocabulary).
_QUOTE_CHARS = frozenset("\"'„“‚‘«»‹›")

#: The paragraph glyph. A §-reference with a number is already an exact term;
#: a bare glyph still marks identifier intent by shape.
_PARAGRAPH = "§"

_SYSTEM_PROMPT = (
    "Du formulierst einen kurzen hypothetischen Regelungsabschnitt, der die folgende "
    "Frage beantworten würde.\n\n"
    "Regeln:\n"
    "- Höchstens etwa zweihundert Tokens, ein einziger Absatz, keine Aufzählung.\n"
    "- Schreibe im Register einer technischen Baunorm: sachlich, mit Muss-Anforderungen.\n"
    "- Erfinde keine konkreten Nummern, Maße oder Verweise — formuliere den "
    "Regelungsgedanken allgemein.\n"
    "- Antworte NUR mit dem Abschnitt, ohne Einleitung und ohne Anführungszeichen."
)


def has_exact_identifier(query: str) -> bool:
    """True when ``query`` carries an exact identifier by SHAPE.

    Any of: a term :mod:`legal_terms` extracts (§-refs, Richtlinie refs,
    quoted spans, ALLCAPS/casefold identifiers), the § glyph, a quote
    character, a filename suffix, or a digit run. Zero entity vocabulary —
    every arm tests characters, never words. A blank query counts as
    identifier-shaped (no draft for nothing).
    """
    if not query or not query.strip():
        return True
    if extract_exact_terms(query):
        return True
    if _PARAGRAPH in query:
        return True
    if any(char in _QUOTE_CHARS for char in query):
        return True
    if _FILENAME_SUFFIX_RE.search(query):
        return True
    return _DIGIT_RE.search(query) is not None


def should_draft(query: str, *, enabled: bool) -> bool:
    """Whether the HyDE channel fires for ``query``.

    ``enabled`` is the deployment switch (retrieval config, default off).
    The shape gate does the rest: identifier-shaped queries never draft,
    however the switch is set.
    """
    return bool(enabled) and not has_exact_identifier(query)


def build_draft_messages(query: str) -> list[tuple[str, str]]:
    """The draft prompt: norm register, capped, entity-free.

    Kept separate from :func:`draft_passage` so tests can pin the contract
    (no identifiers, no examples) without invoking a model.
    """
    return [("system", _SYSTEM_PROMPT), ("user", query)]


async def draft_passage(
    llm: Any,
    query: str,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    max_chars: int = HYDE_MAX_DRAFT_CHARS,
) -> str | None:
    """Draft the hypothetical passage for ``query``; ``None`` on any failure.

    Args:
        llm: LangChain chat model with an async ``ainvoke``; ``None`` disables.
        query: The user's question, as asked.
        timeout_seconds: Upper bound for the draft call.
        max_chars: Truncation bound on the returned draft.

    Returns:
        The stripped, truncated draft, or ``None`` when there is no model, no
        query, no reply, or the call was slow or failed. Callers treat
        ``None`` as "retrieve the baseline".
    """
    if llm is None or not (query or "").strip():
        return None
    try:
        response = await asyncio.wait_for(
            llm.ainvoke(build_draft_messages(query)),
            timeout=timeout_seconds,
        )
        content = getattr(response, "content", None)
        if content is None and isinstance(response, dict):
            content = response.get("content")
        text = str(content or "").strip()
        if not text:
            return None
        return text[:max_chars].rstrip() or None
    except Exception as exc:  # noqa: BLE001 - fail open by design
        logger.warning("HyDE draft failed (%s); retrieving the baseline", type(exc).__name__)
        return None
