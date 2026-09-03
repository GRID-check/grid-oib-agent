"""Token-based extraction of exact legal terms from a query for the lexical retrieval channel.

The semantic (vector) channel of knowledge retrieval misses queries whose signal is a short
exact string — a paragraph reference (``§ 3`` / ``§3``), an OIB-Richtlinie reference
(``OIB-Richtlinie 2``), a quoted phrase (``"Fluchtweg Breite"``) or an ALLCAPS code
(``OIB``, ``ÖNORM``). :func:`extract_exact_terms` pulls those literals out so the caller can
run a ``where_document {"$contains": term}`` pass and fuse it with the vector results.

Deliberately implemented with plain string predicates (tokenize, ``startswith``, ``isupper``)
rather than regexes: token classification is easier to audit than a pattern set, and there is
no entity vocabulary anywhere in this module — case-insensitive matching is gated on token
SHAPE (see :func:`_is_casefold_identifier`), never on a word list. Pure and deterministic:
same input, same output, in order of first appearance, deduplicated, capped at ``max_terms``.
"""

from __future__ import annotations

_PARAGRAPH = "§"
_OIB_RICHTLINIE_TOKEN = "oib-richtlinie"
_MIN_ALLCAPS_LEN = 3

#: Quote characters that open/close a quoted phrase (straight + German low/high pairs).
_QUOTE_OPEN: dict[str, str] = {'"': '"', "'": "'", "„": "“", "‚": "‘"}

#: Punctuation stripped from token edges before classification. Internal characters
#: (the hyphen in ``OIB-Richtlinie``, the ``§`` sign) are never touched.
_EDGE_PUNCT = ".,;:!?()[]{}<>«»\"'„“‚‘"


def _iter_tokens(text: str) -> list[tuple[int, str]]:
    """Split ``text`` on whitespace, returning ``(start_index, token)`` pairs."""
    tokens: list[tuple[int, str]] = []
    index = 0
    while index < len(text):
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            break
        start = index
        while index < len(text) and not text[index].isspace():
            index += 1
        tokens.append((start, text[start:index]))
    return tokens


def _extract_quoted_spans(query: str) -> tuple[list[tuple[int, str]], str]:
    """Pull quoted phrases out of ``query``.

    Returns ``(spans, remainder)`` where ``spans`` are ``(start_index, phrase)`` pairs in
    reading order and ``remainder`` is the query with each quoted span replaced by spaces
    (positions preserved, so remainder token offsets still line up with the original).
    """
    spans: list[tuple[int, str]] = []
    chars = list(query)
    index = 0
    while index < len(query):
        closer = _QUOTE_OPEN.get(query[index])
        if closer is None:
            index += 1
            continue
        end = query.find(closer, index + 1)
        if end == -1:
            index += 1
            continue
        phrase = query[index + 1 : end].strip()
        if phrase:
            spans.append((index, phrase))
        for pos in range(index, end + 1):
            chars[pos] = " "
        index = end + 1
    return spans, "".join(chars)


def _is_paragraph_number(token: str) -> bool:
    """True for the numeric half of a §-reference (``3``, ``3a``, ``12.1``)."""
    body = token.rstrip(".")
    if body and body[-1].isalpha():
        body = body[:-1]
    if not body:
        return False
    head, _, tail = body.partition(".")
    return head.isdigit() and (not tail or tail.isdigit())


def _is_casefold_identifier(token: str, following: str) -> bool:
    """True for a token that is identifier-shaped but not uppercase.

    The ``$contains`` channel is a case-sensitive byte test, so a lowercase ``oib``
    never matches the corpus ``OIB`` — while the sparse channel independently drops the
    same survivors on its DF ceiling and digit-only rule. Case-insensitive matching is
    what every BM25 analyzer does, but a naive ``token.upper()`` casefold promotes EVERY
    German function word (``die`` -> ``DIE``) to an exact term, and this channel has no
    DF ceiling to price that noise back out. So casefolding is gated on identifier
    SHAPE, never on vocabulary:

    - a letter run carrying digits (``b1800``): German prose words never mix letters
      and digits, so this shape cannot be a function word;
    - a pure letter run directly followed by a paragraph-style number (``oib 2``): the
      ``<name> <number>`` citation shape the ``§`` and ``OIB-Richtlinie`` arms already
      recognise, generalised.

    The caller emits ``token.upper()``: document convention writes identifiers
    uppercase, so this both matches (``oib`` -> ``OIB``) and self-neutralises false
    positives — ``die 3`` yields ``DIE``, which a mixed-case corpus only contains as a
    substring accident, i.e. an empty ``$contains`` pass, the channel's designed-normal
    outcome. Every term this arm can emit, the ALLCAPS arm already emits for the
    uppercased query, so no new term shape enters the channel: the fix removes the case
    lottery, nothing else. Deliberately NOT covered: hyphenated lowercase compounds
    (``fluchtweg-breite``) — indistinguishable from prose by shape, and each would burn
    one of the ``max_terms`` slots on a dead uppercase term.

    A TERM IS NOT A HIT. This module decides what is identifier-SHAPED; it does not and
    cannot know what is SELECTIVE, because that is a property of the collection being
    searched, not of the string. ``oib 2`` emits a bare ``OIB`` here, and on the OIB
    corpus ``OIB`` is on 92.3% of pages — so the retriever measures every term against
    the live collection and drops the ones above its document-frequency ceiling
    (``knowledge_layer.llamaindex.hybrid.selective_terms``, the rule
    ``aiq_agent.common.german_text`` has always applied on the sparse side). Adding a
    shape here therefore widens what CAN be searched; it never asserts that the search
    will find anything, and no caller may read a non-empty return as retrieval.
    """
    has_alpha = any(char.isalpha() for char in token)
    if has_alpha and any(char.isdigit() for char in token):
        return True
    return token.isalpha() and _is_paragraph_number(following)


def extract_exact_terms(query: str, *, max_terms: int = 3) -> list[str]:
    """Extract exact-match legal terms from ``query`` for the lexical retrieval channel.

    Recognizes, in order of first appearance:

    - §-references with or without a space (``§ 3``, ``§3``, ``§ 12.1``), emitted as ``§ <n>``;
    - OIB-Richtlinie references (``OIB-Richtlinie 2``), case-insensitive on the name token;
    - quoted phrases (``"…"``, ``'…'``, ``„…"``, ``‚…'``), emitted without the quotes;
    - ALLCAPS tokens of length >= 3 (``OIB``, ``ÖNORM``), edge punctuation stripped;
    - case-insensitive identifier shapes of length >= 3 (``oib 2`` -> ``OIB``,
      ``b1800`` -> ``B1800``), emitted uppercased — see :func:`_is_casefold_identifier`
      for the shape gate that keeps German function words out, and for why a term
      returned here is a candidate the retriever still prices, not a hit.

    The result is deduplicated, ordered by first appearance, and capped at ``max_terms``.
    ``max_terms <= 0`` yields an empty list.

    Args:
        query: The raw user query.
        max_terms: Upper bound on returned terms.

    Returns:
        list[str]: The exact terms, ready for ``where_document {"$contains": term}`` filters.
    """
    if max_terms <= 0 or not query:
        return []

    spans, remainder = _extract_quoted_spans(query)
    tokens = _iter_tokens(remainder)

    found: list[tuple[int, str]] = list(spans)
    skip_next = False
    for position, (start, raw) in enumerate(tokens):
        if skip_next:
            skip_next = False
            continue
        token = raw.strip(_EDGE_PUNCT)
        if not token:
            continue
        following = tokens[position + 1][1].strip(_EDGE_PUNCT) if position + 1 < len(tokens) else ""

        if token == _PARAGRAPH and _is_paragraph_number(following):
            found.append((start, f"{_PARAGRAPH} {following.rstrip('.')}"))
            skip_next = True
        elif token.startswith(_PARAGRAPH) and _is_paragraph_number(token[len(_PARAGRAPH) :]):
            found.append((start, f"{_PARAGRAPH} {token[len(_PARAGRAPH) :].rstrip('.')}"))
        elif token.casefold() == _OIB_RICHTLINIE_TOKEN and _is_paragraph_number(following):
            found.append((start, f"OIB-Richtlinie {following.rstrip('.')}"))
            skip_next = True
        elif len(token) >= _MIN_ALLCAPS_LEN and token.isupper():
            found.append((start, token))
        elif len(token) >= _MIN_ALLCAPS_LEN and _is_casefold_identifier(token, following):
            # Backlog item 13: the trailing number is shape evidence, not term content —
            # "OIB 2" yields bare "OIB" on the arm above, so this arm emits the same.
            found.append((start, token.upper()))

    found.sort(key=lambda item: item[0])
    terms: list[str] = []
    for _, term in found:
        if term not in terms:
            terms.append(term)
        if len(terms) >= max_terms:
            break
    return terms
