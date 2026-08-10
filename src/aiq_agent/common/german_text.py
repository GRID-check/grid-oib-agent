"""German lexical normalisation and ``tsquery`` construction for sparse retrieval.

PURE module: no database, no I/O, no state. It owns the two halves of the German
lexical channel that must never disagree — how a chunk's text becomes lexemes,
and how a user's question becomes a query over those lexemes — so that the
store (:mod:`aiq_agent.knowledge.chunk_text_store`) only has to run SQL.

WHY THIS EXISTS
---------------
The previous lexical channel ran Chroma ``where_document {"$contains": term}``
over the terms of ``aiq_agent.common.legal_terms.extract_exact_terms``. Measured
against 53 real German questions mined from this repo, 28.3% produced any term
and only 9.4% a useful one, because ``$contains`` is a raw, CASE-SENSITIVE,
byte-level substring test: ``'oib'`` misses ``OIB``, ``'§ 3'`` also matches
``§ 30``, and the German morphology of the corpus (``Fluchtweg`` in five
inflected forms, Austrian ``Geschoß`` 677× vs ``Geschoss`` 5×) is invisible to
it. A bare ``OIB`` term matched 467 of 490 chunks — 95.3%, a near-no-op.

THE DF CEILING (the actual fix)
-------------------------------
Postgres' stock ``german`` FTS config solves inflection, ß→ss, umlaut folding
and hyphenated-token splitting, but the *query operator* decides whether the
channel fires at all:

* ``plainto_tsquery`` ANDs every lexeme, so the ``muss``/``brauche``/``wie``
  words German questions carry but normative text does not kill the match — it
  fired on 27.8% of real queries.
* ORing every lexeme fires on 100% of queries but returns 737 of 776 chunks for
  any question containing "OIB" — the ``$contains`` no-op in a new costume.

So: OR the lexemes, but first DROP the ones whose DOCUMENT FREQUENCY in the
target collection is too high to carry signal (see :func:`select_terms`). The
ceiling is a *parameter*, never a hardcoded stopword list — the store measures
the frequencies against the live collection and passes them in, because "OIB is
noise" is a property of this corpus, not of the German language.

FOLDING: MIRRORED FROM ``norm_registry._normalize``, DELIBERATELY DIVERGENT
---------------------------------------------------------------------------
``aiq_agent.common.norm_registry._normalize`` already encodes this repo's
knowledge that German matching needs umlaut/ß folding, and the lexical channel
was the one place not using it. :func:`fold` MIRRORS it (it is not imported) and
diverges on ONE point, on purpose:

* ``_normalize`` expands to digraphs (``ö`` -> ``oe``) because it matches German
  prose against catalog labels a human may have typed as "Oberoesterreich".
* :func:`fold` folds to the single vowel (``ö`` -> ``o``), because these lexemes
  must line up with what Postgres' ``german`` config produces for the SAME text.
  A digraph index would disagree with the Postgres backend on every umlaut and,
  worse, would break the stemmer's R1 region (``türen`` -> ``tueren`` no longer
  stems to ``tür``'s stem).

Both agree on ``ß`` -> ``ss``, which is the measured case that matters
(``Geschoß``/``Geschoss``). The residual gap — a user typing ``Tuerbreite`` for
``Türbreite`` — is NOT handled here, and is not handled by Postgres either, so
the two backends stay identical rather than one silently doing more.

STEMMING IS AN APPROXIMATION, AND ONLY FOR SQLITE
-------------------------------------------------
:func:`analyze` (fold + tokenize + :func:`stem`) is the analyzer for the SQLite
degradation path of the store, where ``to_tsvector`` does not exist and both the
indexed body and the query must be analyzed by the SAME Python code. :func:`stem`
is a small R1-region suffix stripper modelled on Snowball German step 1 — it
gets the plural/genitive inflections this corpus actually turns on
(``Fluchtweg``/``-e``/``-en``/``-es``, ``Anforderung``/``-en``,
``Breite``/``-n``) and nothing else. On Postgres the real Snowball stemmer runs
instead and :func:`query_terms` (lowercase only, NO Python stemming) is used, so
Postgres never sees a pre-mangled lexeme.

Neither backend splits CLOSED compounds: ``Fluchtwegbreiten`` is not reachable
from ``Fluchtweg``. That is a known, accepted limitation of the stock ``german``
config, stated here so nobody re-derives it from a failing query.

ENGLISH QUERIES: THIS CHANNEL IS SILENT, BY CONSTRUCTION
--------------------------------------------------------
Users ask this German corpus in English too, and a sparse channel over German
text is monolingual: ``to_tsvector('german', …)`` produces German stems, and an
English query's lexemes do not match them. So this channel adds recall for
German questions and CONTRIBUTES NOTHING to English ones. That is stated, not
hidden, because the alternative failure is worse: an English query shares only
digits and ALLCAPS codes with the corpus (``OIB``, ``2``, ``4.2``), and a
channel that returned the chunks merely sharing those would have RRF promote
pure noise above real dense hits. Empty beats noisy.

Three consequences are load-bearing:

1. **The language test is document frequency, not language ID.** An English term
   simply is not in the German corpus, so :func:`select_terms` drops it at the
   ``df == 0`` rule — measured against the live collection instead of guessed by
   a classifier. On top of that, a surviving set with no ALPHABETIC term is
   discarded outright (rule 3 there): digit-only overlap is not a language
   signal. The channel then returns nothing and the caller logs it.
2. **Do NOT add a second index.** ``to_tsvector('english', body)`` over German
   text is meaningless — the English Snowball stemmer mangles German words into
   garbage lexemes ("Geschosse" -> "geschoss" only by accident, "Anforderungen"
   -> "anforderungen") and an English query would then match German chunks for
   reasons unrelated to meaning. This module will not gain an English config,
   and the store must not gain an ``english`` column. Rejected on purpose.
3. **The cross-lingual seam is QUERY-SIDE.** English recall is bought by
   translating English domain vocabulary into the German the corpus actually
   uses (escape route -> Fluchtweg/Rettungsweg, fire compartment ->
   Brandabschnitt, building class -> Gebäudeklasse, storey -> Geschoß) and
   feeding those German terms in. That glossary is owned elsewhere; this module
   only provides the SEAM: :func:`query_terms` and :func:`analyze_query` take
   ``extra_terms``, and :func:`build_tsquery` takes a term LIST, so a glossary
   can inject terms without either side knowing about the other. Until it
   exists, English queries are served by the dense channel alone.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

#: Fraction of a collection's chunks a lexeme may appear in and still be used.
#: 0.2 is chosen against the measured corpus: bare ``OIB`` sits at 95.3% and must
#: die; the discriminating terms of real questions (``Fluchtweg``,
#: ``Treppenlaufbreite``, ``Geschoß``) sit far below it. Always overridable —
#: this is a corpus property, not a constant of nature.
DEFAULT_DF_CEILING_RATIO = 0.2

#: Below this many rows a document-frequency RATIO is noise (in a 6-chunk project
#: collection every content word looks "too frequent"), so the ceiling is not
#: applied at all — only lexemes that cannot match anything are dropped.
DEFAULT_DF_CEILING_MIN_TOTAL = 25

#: Alphanumeric runs, plus dotted numbers kept whole. The corpus cites by
#: ``Punkt N.N`` (1,565 occurrences) — ``4.2.1`` must survive as ONE lexeme, not
#: three. Underscore is excluded so ``oib-rl_2`` splits like ``oib-rl 2`` does.
#: Consequence relied upon elsewhere: a token can never contain the SQL LIKE
#: wildcards ``%`` or ``_``, so :func:`like_pattern` needs no escaping.
_TOKEN_RE = re.compile(r"\d+(?:\.\d+)+|[^\W_]+", re.UNICODE)

#: Single-vowel folding (see the module docstring for why not the digraph form).
_FOLD = (("ä", "a"), ("ö", "o"), ("ü", "u"), ("ß", "ss"))

_VOWELS = frozenset("aeiouy")

#: Snowball German's valid ``-s`` predecessors. Without this, ``geschoss`` would
#: stem to ``geschos`` and stop matching ``Geschoß``.
_S_ENDINGS = frozenset("bdfghklmnrt")

#: Step-1 suffixes, longest first so ``-ern`` wins over ``-er``.
_SUFFIXES = ("ern", "em", "er", "en", "es", "e")

#: Shortest lexeme kept from a query. Single letters are noise; single DIGITS are
#: not (``§ 3``, ``OIB-RL 2``), so digits are exempt.
_MIN_TERM_LENGTH = 2


def fold(text: str | None) -> str:
    """Lowercase and fold umlauts/ß so spelling variants collapse.

    Mirrors :func:`aiq_agent.common.norm_registry._normalize` in intent and
    deliberately diverges on the umlaut target — see the module docstring.
    ``None`` folds to the empty string (this module never raises on empty input).
    """
    if not text:
        return ""
    folded = text.strip().lower()
    for source, target in _FOLD:
        folded = folded.replace(source, target)
    return folded


def tokenize(text: str | None) -> list[str]:
    """Lowercased alphanumeric tokens, hyphenated compounds split into parts.

    Mirrors what Postgres' ``german`` config does to a hyphenated token —
    ``OIB-RL`` is indexed as its parts — except that Postgres ALSO indexes the
    whole hyphenated form. We deliberately emit only the parts: ``to_tsquery``
    expands a hyphenated operand into an AND group, and an AND hidden inside one
    operand of our OR would resurrect exactly the all-terms-required failure the
    DF ceiling exists to avoid.
    """
    if not text:
        return []
    return _TOKEN_RE.findall(text.lower())


def _r1(word: str) -> int:
    """Snowball's R1: the region after the first consonant following a vowel.

    Clamped to at least 3, as the German stemmer requires. Suffixes are only
    stripped from inside R1, which is what keeps ``feuer`` from becoming ``feu``
    while still letting ``feuers`` become ``feuer``.
    """
    for index in range(1, len(word)):
        if word[index] not in _VOWELS and word[index - 1] in _VOWELS:
            return max(index + 1, 3)
    return len(word)


def stem(token: str) -> str:
    """Strip German plural/genitive inflection from an already-folded token.

    An approximation of Snowball German step 1 (see the module docstring): used
    ONLY on the SQLite path, where the same Python analyzer must run over both
    the indexed body and the query. Purely numeric tokens are returned untouched
    — ``4.2.1`` is a citation, not a word.
    """
    if not token or token[0].isdigit():
        return token
    region = _r1(token)
    for suffix in _SUFFIXES:
        if token.endswith(suffix) and len(token) - len(suffix) >= region:
            return token[: -len(suffix)]
    if token.endswith("s") and len(token) - 1 >= region and token[-2] in _S_ENDINGS:
        return token[:-1]
    return token


def _is_useful(lexeme: str) -> bool:
    """True for a lexeme worth indexing or searching on.

    Deliberately NOT a stopword list. In a building-code corpus the uninformative
    words are not the ones a general German stoplist names: "Anforderung" and
    "gemaess" carry as little discriminative signal here as "der" does, while
    "Mass" carries a lot. Uselessness is therefore measured against the corpus by
    the document-frequency ceiling in :func:`select_terms`, not asserted in
    advance. This guard only removes what carries no signal by construction --
    single characters that are not digits -- and mirrors the same rule applied to
    the unstemmed path in :func:`_plain_terms`.
    """
    if not lexeme:
        return False
    return len(lexeme) >= _MIN_TERM_LENGTH or lexeme.isdigit()


def analyze(text: str | None) -> list[str]:
    """Lexemes for the SQLite path: fold, tokenize, stem, dedupe (order kept).

    The SAME function analyzes an indexed chunk body and an incoming query, so
    the two sides cannot drift apart. On Postgres this is not used — see
    :func:`query_terms`.
    """
    lexemes: list[str] = []
    for token in tokenize(fold(text)):
        lexeme = stem(token)
        if _is_useful(lexeme) and lexeme not in lexemes:
            lexemes.append(lexeme)
    return lexemes


def analyze_query(text: str | None, *, extra_terms: Sequence[str] = ()) -> list[str]:
    """:func:`analyze` for an incoming QUERY, with the glossary seam.

    ``extra_terms`` are German terms supplied by a caller-side translation /
    expansion layer (see the module docstring): they are analyzed by the same
    pipeline and placed FIRST, because a translated term states the asker's
    intent more directly than the words they happened to type. Multi-word terms
    ("tragende Wand") are tokenized like any other text.
    """
    return _merge_terms(analyze, text, extra_terms)


def index_blob(text: str | None) -> str:
    """The SQLite ``tsv`` column value: space-delimited lexemes, space-padded.

    The leading/trailing spaces let ``LIKE '% lexeme %'`` match the first and
    last lexeme too, which is what makes the fallback a whole-lexeme match rather
    than the substring match this whole module exists to replace.
    """
    lexemes = analyze(text)
    return f" {' '.join(lexemes)} " if lexemes else ""


def like_pattern(lexeme: str) -> str:
    """The SQLite ``LIKE`` pattern matching ``lexeme`` as a whole lexeme.

    No wildcard escaping is needed or performed: ``_TOKEN_RE`` cannot produce
    ``%`` or ``_``, so a lexeme is always LIKE-inert.
    """
    return f"% {lexeme} %"


def _plain_terms(text: str | None) -> list[str]:
    terms: list[str] = []
    for token in tokenize(text):
        if len(token) < _MIN_TERM_LENGTH and not token.isdigit():
            continue
        if token not in terms:
            terms.append(token)
    return terms


def _merge_terms(analyzer, text: str | None, extra_terms: Sequence[str]) -> list[str]:
    """Glossary terms first, then the query's own, deduped in order."""
    merged: list[str] = []
    for source in (*(extra_terms or ()), text):
        for term in analyzer(source):
            if term not in merged:
                merged.append(term)
    return merged


def query_terms(text: str | None, *, extra_terms: Sequence[str] = ()) -> list[str]:
    """Candidate lexemes from a query for the POSTGRES path (no Python stemming).

    Lowercased, hyphen-split, deduped, single letters dropped (single digits
    kept). Stemming, stopword removal and umlaut/ß folding are left to
    ``to_tsquery('german', …)``, which must see the word the user actually typed
    — pre-stemming here would hand Postgres a non-word and stem it twice.

    ``extra_terms`` is the cross-lingual seam (see the module docstring): German
    terms produced by a caller-side glossary for an English query, merged ahead
    of the query's own tokens. Without them an English query yields terms that
    are absent from the German corpus, and :func:`select_terms` correctly
    silences the channel.
    """
    return _merge_terms(_plain_terms, text, extra_terms)


def select_terms(
    terms: list[str],
    frequencies: dict[str, int],
    total: int,
    *,
    df_ceiling_ratio: float = DEFAULT_DF_CEILING_RATIO,
    min_total: int = DEFAULT_DF_CEILING_MIN_TOTAL,
) -> list[str]:
    """Drop the lexemes that cannot carry signal, keep the rest for ORing.

    Three rules, in order:

    1. A lexeme with document frequency 0 matches nothing in this collection —
       dropping it is free and also removes every stopword, typo, and (the point
       of the English case) every word that simply is not German corpus
       vocabulary. Postgres reports 0 for a stopword, whose ``tsquery`` is empty.
    2. A lexeme present in more than ``df_ceiling_ratio`` of the collection is
       noise: it is what turned a bare ``OIB`` into a 95.3%-recall no-op. The
       ceiling is only applied once the collection is big enough for a ratio to
       mean anything (``min_total``).
    3. If nothing ALPHABETIC survives, the whole set is discarded. Digits and
       dotted citation numbers are language-neutral: an English question that
       overlaps the corpus only on ``2`` or ``4.2`` has no lexical signal, and
       returning the chunks that share a digit would have RRF promote noise over
       real dense hits.

    Returning an EMPTY list is a correct, expected outcome — "OIB?" carries no
    usable lexical signal, and an English query carries none at all — so the
    caller must degrade to vector-only rather than hand back the corpus. There
    is deliberately no "keep the rarest term anyway" fallback: for the measured
    failure case the rarest term IS ``OIB``.
    """
    if not terms or total <= 0:
        return []
    apply_ceiling = total >= min_total
    ceiling = total * df_ceiling_ratio
    kept: list[str] = []
    for term in terms:
        frequency = frequencies.get(term, 0)
        if frequency <= 0:
            continue
        if apply_ceiling and frequency > ceiling:
            continue
        kept.append(term)
    if not any(any(character.isalpha() for character in term) for term in kept):
        return []
    return kept


def build_tsquery(terms: list[str]) -> str:
    """OR the surviving lexemes into a ``to_tsquery`` string, or ``""``.

    Each lexeme is single-quoted so Postgres treats it as a literal operand.
    Quotes cannot appear inside a lexeme (``_TOKEN_RE`` yields alphanumerics
    only), and the result is always passed to Postgres as a BOUND parameter of
    ``to_tsquery('german', :tsquery)`` — never interpolated into SQL text.
    """
    return " | ".join(f"'{term}'" for term in terms if term)
