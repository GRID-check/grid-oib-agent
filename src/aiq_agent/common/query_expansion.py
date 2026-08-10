"""Cross-lingual query expansion for the German OIB corpus.

The corpus is German; users ask in German and in English. An English question cannot
reach a German index lexically at all, and only weakly by embedding. Measured on this
corpus with a multilingual retriever over Punkt-cut chunks:

===========================  =====
arm                          MRR
===========================  =====
German question              0.678
English question, raw        0.293
English question + glossary  0.674
===========================  =====

So the gap is real, it is large, and prepending the corpus's own German terms closes
it. That is what this module does, and the reason it is worth its complexity.

It is deliberately pure, deterministic and table-driven -- no LLM, no network, no
database -- matching the idiom of `legal_terms`, `applicability` and
`norm_registry.match_entries`. A translation model on the hot retrieval path would
cost a round trip per query to do worse than a 33-entry table, because the table is
grounded in counted corpus vocabulary rather than in general German.

The augmentation is **additive and original-preserving**: the user's own words stay
in the query. An English speaker who typed a term the glossary does not know is no
worse off than before, and a German query is returned untouched.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

#: The admin-editable glossary, beside the norm registry it mirrors in shape.
VOCABULARY_PATH = Path(os.environ.get("AIQ_VOCABULARY_PATH", "configs/norms/at/vocabulary.yml"))

#: Function words that mark a query as English. Chosen to be absent from German:
#: "die"/"was" would fire on both, "the"/"which" cannot.
_ENGLISH_MARKERS = frozenset(
    {"the", "what", "which", "how", "are", "is", "for", "of", "in", "must", "required", "do", "does", "can", "and"}
)

#: German markers, likewise chosen to be unambiguous.
_GERMAN_MARKERS = frozenset(
    {"welche", "welcher", "wie", "was", "muss", "müssen", "gilt", "gelten", "für", "der", "die", "das", "und", "bei"}
)

#: Umlauts and eszett are decisive on their own -- no English word carries them.
_GERMAN_CHARS = frozenset("äöüßÄÖÜ")

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)

_lock = threading.Lock()
_concepts: list[tuple[tuple[str, ...], tuple[str, ...]]] | None = None


def _load_concepts() -> list[tuple[tuple[str, ...], tuple[str, ...]]]:
    """Load ``(english_forms, german_terms)`` pairs, longest English form first.

    Longest-first is what stops ``building class`` being matched only as ``class``,
    and ``external wall`` degrading to ``wall``.

    Fail-open: a missing or malformed glossary disables expansion rather than
    breaking retrieval, because expansion is an enhancement and retrieval is not.
    """
    global _concepts
    with _lock:
        if _concepts is not None:
            return _concepts
        pairs: list[tuple[tuple[str, ...], tuple[str, ...]]] = []
        try:
            import yaml

            data = yaml.safe_load(VOCABULARY_PATH.read_text(encoding="utf-8")) or {}
            for concept in data.get("concepts") or []:
                english = tuple(str(form).strip().lower() for form in concept.get("en") or [] if str(form).strip())
                german = tuple(str(term).strip() for term in concept.get("de") or [] if str(term).strip())
                if english and german:
                    pairs.append((english, german))
        except Exception as e:
            logger.warning("Query-expansion vocabulary unavailable (%s: %s); expansion disabled", type(e).__name__, e)
            pairs = []
        pairs.sort(key=lambda pair: -max(len(form) for form in pair[0]))
        _concepts = pairs
        return _concepts


def reset_vocabulary_cache() -> None:
    """Drop the parsed glossary so a test (or an admin edit) is picked up."""
    global _concepts
    with _lock:
        _concepts = None


def detect_language(query: str | None) -> str:
    """``"de"``, ``"en"`` or ``"unknown"``.

    Crude on purpose, and honest about it: ``"unknown"`` is returned rather than a
    guess, and every caller must behave sanely on it. A German character settles the
    question immediately; otherwise the marker counts decide, and a tie is unknown.
    """
    if not query or not query.strip():
        return "unknown"
    if any(character in _GERMAN_CHARS for character in query):
        return "de"
    words = {word.lower() for word in _WORD_RE.findall(query)}
    german = len(words & _GERMAN_MARKERS)
    english = len(words & _ENGLISH_MARKERS)
    if german > english:
        return "de"
    if english > german:
        return "en"
    return "unknown"


def expansion_terms(query: str | None) -> list[str]:
    """German corpus terms for the concepts ``query`` mentions, in order of first match.

    Returned separately from :func:`augmented_query` so the sparse channel can take
    the terms directly -- it needs lexemes, not a sentence.
    """
    if not query:
        return []
    haystack = query.lower()
    terms: list[str] = []
    consumed: list[str] = []
    for english_forms, german_terms in _load_concepts():
        for form in english_forms:
            if form not in haystack:
                continue
            # A longer concept already claimed this span (`building class` before
            # `class`), so the shorter one would only restate it.
            if any(form in previous for previous in consumed):
                break
            consumed.append(form)
            for term in german_terms:
                if term not in terms:
                    terms.append(term)
            break
    return terms


def augmented_query(query: str | None) -> str:
    """``query`` with its German equivalents prepended, or unchanged.

    Prepended rather than appended because retrieval encoders weight early tokens
    more heavily, and the glossary term is the part that can actually match the
    corpus. The original wording is kept: it carries the specifics the glossary
    cannot know -- a Gebäudeklasse number, a dimension, a Bundesland.

    A German or unrecognised query is returned untouched, so this is a no-op for the
    language the corpus is already written in.
    """
    if not query or not query.strip():
        return query or ""
    if detect_language(query) == "de":
        return query
    terms = expansion_terms(query)
    if not terms:
        return query
    return f"{' '.join(terms)} {query}"
