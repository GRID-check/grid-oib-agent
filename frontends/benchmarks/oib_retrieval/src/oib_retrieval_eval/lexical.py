"""An in-memory inverted index over the real corpus, built from the SHIPPED German analyzer.

Every lexeme here — indexed or queried — comes from ``aiq_agent.common.german_text``, the
module the production lexical channel uses: :func:`fold`, :func:`analyze`,
:func:`query_terms`, :func:`select_terms`, :func:`build_tsquery`. Nothing about German is
reimplemented, so a change to the stemmer or the document-frequency ceiling moves these
numbers, which is the only way this harness can be a regression test for that module.

WHAT THIS IS AND IS NOT
-----------------------
It is the SQLite degradation path of the store, run in memory: ``analyze`` (fold, tokenize,
stem) over both the chunk body and the query, whole-lexeme matching, and the same
:func:`select_terms` document-frequency ceiling that decides whether the channel fires at
all. On Postgres, production instead hands ``to_tsquery('german', …)`` the string
:func:`build_tsquery` builds and lets Snowball stem; that path needs a database, so it is
not what runs here. The divergence is one stemmer, and it is stated rather than papered
over: these are real numbers for the analyzer as shipped, not a prediction of the exact
Postgres ranking.

SCORING
-------
Score is the sum of ``idf`` over the DISTINCT query lexemes a chunk matches — no term
frequency. That is deliberate. The Postgres side ranks with ``ts_rank``, which this cannot
reproduce without a database, so rather than approximate it badly the ranking encodes the
one property the channel is actually for: a chunk matching two rare lexemes
(``fluchtweg`` + ``gehweglange``) beats a chunk that repeats one of them ten times.
Repetition in a building code is boilerplate, not relevance.

THE ENGLISH RESULT IS EXPECTED TO BE ZERO, AND THAT IS THE POINT
-----------------------------------------------------------------
``german_text``'s own docstring states that this channel is silent for English queries by
construction: an English term has document frequency 0 in a German corpus, ``select_terms``
drops it, and rule 3 discards any surviving digit-only set. Measuring it anyway is not
redundant — it turns a design claim into a number, and it is the baseline the query-side
glossary seam (``extra_terms``) has to beat when somebody builds it.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from dataclasses import field

from oib_retrieval_eval.corpus import Chunk

#: Passed through to ``german_text.select_terms``. Left at the shipped defaults so the
#: measured behaviour is the shipped behaviour; exposed so a tuning run can sweep it.
DEFAULT_DF_CEILING_RATIO = 0.2


@dataclass
class LexicalIndex:
    """Postings + document frequencies over one arm's chunks."""

    chunks: list[Chunk]
    postings: dict[str, set[int]] = field(default_factory=lambda: defaultdict(set))
    frequencies: dict[str, int] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return len(self.chunks)

    def idf(self, lexeme: str) -> float:
        """Smoothed inverse document frequency; 0.0 for a lexeme not in the collection."""
        frequency = self.frequencies.get(lexeme, 0)
        if frequency <= 0:
            return 0.0
        return math.log((self.total + 1) / (frequency + 0.5))


def build_index(chunks: list[Chunk]) -> LexicalIndex:
    """Analyze every chunk body once and invert it."""
    from aiq_agent.common.german_text import analyze

    index = LexicalIndex(chunks=list(chunks))
    postings: dict[str, set[int]] = defaultdict(set)
    for position, chunk in enumerate(index.chunks):
        for lexeme in analyze(chunk.text):
            postings[lexeme].add(position)
    index.postings = postings
    index.frequencies = {lexeme: len(rows) for lexeme, rows in postings.items()}
    return index


def selected_terms(
    index: LexicalIndex,
    question: str,
    extra_terms: tuple[str, ...] = (),
    df_ceiling_ratio: float = DEFAULT_DF_CEILING_RATIO,
) -> list[str]:
    """The lexemes the production selector would actually search on for this question.

    ``extra_terms`` is the cross-lingual glossary seam ``german_text`` exposes; the harness
    passes nothing through it today, so the English arm measures the channel as it ships.
    """
    from aiq_agent.common.german_text import analyze_query
    from aiq_agent.common.german_text import select_terms

    candidates = analyze_query(question, extra_terms=extra_terms)
    return select_terms(
        candidates,
        index.frequencies,
        index.total,
        df_ceiling_ratio=df_ceiling_ratio,
    )


def tsquery_for(
    index: LexicalIndex,
    question: str,
    extra_terms: tuple[str, ...] = (),
    df_ceiling_ratio: float = DEFAULT_DF_CEILING_RATIO,
) -> str:
    """The exact ``to_tsquery`` string the Postgres backend would be handed for this question.

    Not used for ranking here (there is no Postgres in this harness); reported and tested
    so the offline arm and the production SQL cannot silently disagree about which lexemes
    survive selection.
    """
    from aiq_agent.common.german_text import build_tsquery

    return build_tsquery(selected_terms(index, question, extra_terms, df_ceiling_ratio))


def search(
    index: LexicalIndex,
    question: str,
    top_k: int,
    extra_terms: tuple[str, ...] = (),
    df_ceiling_ratio: float = DEFAULT_DF_CEILING_RATIO,
) -> list[Chunk]:
    """Ranked chunks for one question, or ``[]`` when the channel has no usable signal.

    An empty result is a correct outcome, not a failure: ``select_terms`` returns nothing
    for a question whose lexemes are all too frequent (a bare "OIB?") or all absent (any
    English question), and production degrades to the dense channel there. Returning the
    corpus instead would be the 95%-recall no-op the ceiling exists to kill.
    """
    terms = selected_terms(index, question, extra_terms, df_ceiling_ratio)
    if not terms:
        return []

    scores: dict[int, float] = defaultdict(float)
    for term in terms:
        weight = index.idf(term)
        if weight <= 0.0:
            continue
        for position in index.postings.get(term, ()):
            scores[position] += weight

    # Ties break toward the earlier chunk (corpus order), which is stable across runs;
    # a set-iteration order would not be, and an unstable baseline cannot detect a
    # regression.
    ordered = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    return [index.chunks[position] for position, _score in ordered[:top_k]]
