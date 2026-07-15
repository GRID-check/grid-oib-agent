"""Shared, backend-agnostic document classification helpers.

Both ingestion backends (LlamaIndex and Foundational RAG) run two light LLM
passes over freshly-extracted document text at ingestion time:

1. A one-sentence summary (``summarize_document_text``) — surfaced in the Files
   metadata panel and in the per-turn ``available_documents`` prompt line.
2. A controlled set of German document tags (``classify_document_tags``) —
   document type + OIB discipline — stored alongside the summary.

The two backends differ only in how they *obtain* the text (LlamaIndex already
holds extracted ``Document`` chunks; Foundational RAG extracts client-side from
the file). Everything downstream of the text — the prompt, the LLM call, and the
defensive parsing — lives here so the two backends can never drift apart.

Both helpers are fully fail-open: any missing LLM, LLM error, timeout, or
unparseable output resolves to ``None`` and never disturbs ingestion.

Public, reusable vocabulary (the single source of truth for tags):

* ``DOCUMENT_TYPE_TAGS`` — ordered, immutable tuple of document-type tags.
* ``DISCIPLINE_TAGS`` — ordered, immutable tuple of the six OIB discipline tags.
* ``ALLOWED_TAGS`` — a ``frozenset`` union of the two, the closed vocabulary the
  deterministic post-filter validates against.

The classification prompt is *built from* these constants, so the instructions
the LLM sees and the vocabulary the post-filter enforces can never drift apart.
Any future user-facing tag-edit endpoint MUST validate against these same
constants so free-form, semantically-duplicate categories (e.g. "Feuerschutz"
vs the canonical "Brandschutz") can never enter storage.
"""

from __future__ import annotations

import json
import logging
import re

logger = logging.getLogger(__name__)

# Text longer than this is truncated before being sent to the summary/tagging
# LLM (~1000 tokens of input is plenty for a one-liner + a handful of tags).
CLASSIFY_MAX_INPUT_CHARS = 4000

# =============================================================================
# Controlled tag taxonomy (German)
# =============================================================================
# The LLM is instructed to choose from these two closed vocabularies, and a
# deterministic post-filter drops anything outside them — so a hallucinated tag
# can never reach storage. Keep these lists in sync with the taxonomy documented
# on FB-8 in feedback_backlog.md.

# 1–2 of these describe what the document *is*. Ordered + immutable so the
# prompt renders deterministically and callers cannot mutate the vocabulary.
DOCUMENT_TYPE_TAGS: tuple[str, ...] = (
    "Bebauungsplan",
    "Flächenwidmungsplan",
    "Grundriss",
    "Schnitt",
    "Ansicht",
    "Detail",
    "Gutachten",
    "Bescheid",
    "Norm/Richtlinie",
    "Vertrag",
    "Foto",
    "Sonstiges",
)

# 0–3 of these (the six OIB 2023 Richtlinien disciplines) apply when the
# document clearly concerns that discipline.
DISCIPLINE_TAGS: tuple[str, ...] = (
    "Standsicherheit",
    "Brandschutz",
    "Hygiene/Gesundheit/Umweltschutz",
    "Nutzungssicherheit/Barrierefreiheit",
    "Schallschutz",
    "Energieeinsparung/Wärmeschutz",
)

# The complete allowed vocabulary — the closed set the deterministic post-filter
# validates every LLM-returned tag against. The single source of truth shared by
# the prompt builder, the ingestion post-filter, and any future edit endpoint.
ALLOWED_TAGS: frozenset[str] = frozenset(DOCUMENT_TYPE_TAGS) | frozenset(DISCIPLINE_TAGS)

# Hard cap on the number of tags stored per document.
MAX_TAGS = 5

# Length cap for the deterministic, LLM-free fallback summary (see
# ``fallback_summary_from_text``).
FALLBACK_SUMMARY_MAX_CHARS = 200


def fallback_summary_from_text(text: str | None, max_chars: int = FALLBACK_SUMMARY_MAX_CHARS) -> str | None:
    """Deterministic, LLM-free summary derived from already-extracted text.

    Used when LLM summary generation failed/timed out but tag classification
    succeeded: the ``summaries.summary`` column is NOT NULL, so tags need an
    anchor row. Returns the first ``max_chars`` characters of ``text`` collapsed
    to a single line and ellipsized, or ``None`` when no usable text exists (so
    the caller skips registration exactly as it would with no summary).
    """
    if not text:
        return None
    single_line = " ".join(text.split())
    if not single_line:
        return None
    if len(single_line) <= max_chars:
        return single_line
    return single_line[:max_chars].rstrip() + "…"


# =============================================================================
# One-sentence summary (shared prompt + call + parse)
# =============================================================================


def summarize_document_text(text_content: str, file_name: str, llm) -> str | None:
    """Generate a one-sentence summary from already-extracted document text.

    Backends are responsible for obtaining ``text_content`` (from chunks or via
    client-side extraction); this function owns the prompt, the LLM call, and
    the response parsing so both backends stay identical.

    Args:
        text_content: Representative document text (e.g. first + last chunk).
        file_name: Filename, for log context only.
        llm: A LangChain-style LLM exposing ``.invoke``. ``None`` → no summary.

    Returns:
        A one-sentence summary, or ``None`` if no LLM was provided or generation
        failed.
    """
    if llm is None:
        return None

    text = text_content[:CLASSIFY_MAX_INPUT_CHARS]
    prompt = f"Summarize in ONE sentence:\n\n{text}"

    try:
        response = llm.invoke(prompt)
        content = response.content if hasattr(response, "content") else str(response)
        summary = content.strip()
        logger.info("[SUMMARY] Generated (%d chars)", len(summary))
        return summary or None
    except Exception as e:
        logger.warning("Summary via LLM failed for %s: %s", file_name, e)
        return None


# =============================================================================
# Controlled tag classification (shared prompt + call + parse + post-filter)
# =============================================================================


def _build_tag_prompt(text: str, file_name: str) -> str:
    """Build the German tag-classification prompt with the closed vocabularies."""
    doc_types = ", ".join(DOCUMENT_TYPE_TAGS)
    disciplines = ", ".join(DISCIPLINE_TAGS)
    return (
        "Du klassifizierst ein Baudokument für ein österreichisches "
        "Architekturbüro (OIB-Richtlinien).\n\n"
        f"Dateiname: {file_name}\n\n"
        "Wähle:\n"
        f"- 1 bis 2 Dokumenttyp-Schlagwörter aus: [{doc_types}]\n"
        f"- 0 bis 3 Fachbereich-Schlagwörter aus: [{disciplines}] "
        "(nur wenn der Fachbereich eindeutig zutrifft)\n\n"
        "Regeln:\n"
        "- Verwende AUSSCHLIESSLICH Schlagwörter aus den obigen Listen, "
        "wortgleich.\n"
        "- Maximal 5 Schlagwörter insgesamt.\n"
        "- Erfinde keine neuen Schlagwörter.\n"
        "- Antworte NUR mit einem JSON-Array von Strings, ohne weiteren Text.\n\n"
        'Beispiel: ["Grundriss", "Brandschutz"]\n\n'
        "Dokumentinhalt:\n"
        f"{text}"
    )


def _parse_tags(raw: str) -> list[str] | None:
    """Defensively parse an LLM response into a validated tag list.

    Strips code fences, decodes the JSON array, keeps only strings that are in
    the allowed vocabulary (deduplicated, order-preserving), and caps the result
    at :data:`MAX_TAGS`. Any parse problem — or an empty result after filtering —
    yields ``None``.
    """
    if not raw:
        return None

    text = raw.strip()

    # Strip a leading ```json / ``` fence and its trailing counterpart.
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()

    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None

    if not isinstance(parsed, list):
        return None

    result: list[str] = []
    for item in parsed:
        if not isinstance(item, str):
            continue
        tag = item.strip()
        if tag in ALLOWED_TAGS and tag not in result:
            result.append(tag)

    result = result[:MAX_TAGS]
    return result or None


def classify_document_tags(text: str, file_name: str, llm) -> list[str] | None:
    """Classify document text into 0–5 controlled German tags.

    Fully fail-open: a missing LLM, an LLM error, or any unparseable/invalid
    output resolves to ``None``. Returned tags are always a subset of
    :data:`ALLOWED_TAGS` (unknown tags are dropped deterministically, so the LLM
    cannot invent vocabulary).

    Args:
        text: Representative document text (same source the summary uses).
        file_name: Filename, used both as a classification hint and log context.
        llm: A LangChain-style LLM exposing ``.invoke``. ``None`` → no tags.

    Returns:
        A validated, non-empty list of tags, or ``None``.
    """
    if llm is None:
        return None

    prompt = _build_tag_prompt(text[:CLASSIFY_MAX_INPUT_CHARS], file_name)

    try:
        response = llm.invoke(prompt)
        content = response.content if hasattr(response, "content") else str(response)
    except Exception as e:
        logger.warning("Tag classification via LLM failed for %s: %s", file_name, e)
        return None

    tags = _parse_tags(content)
    if tags:
        logger.info("[TAGS] Classified %s -> %s", file_name, tags)
    return tags
