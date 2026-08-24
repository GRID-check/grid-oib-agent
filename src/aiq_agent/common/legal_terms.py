"""Token-based extraction of exact legal terms from a query for the lexical retrieval channel.

The semantic (vector) channel of knowledge retrieval misses queries whose signal is a short
exact string — a paragraph reference (``§ 3`` / ``§3``), an OIB-Richtlinie reference
(``OIB-Richtlinie 2``), a quoted phrase (``"Fluchtweg Breite"``) or an ALLCAPS code
(``OIB``, ``ÖNORM``). :func:`extract_exact_terms` pulls those literals out so the caller can
run a ``where_document {"$contains": term}`` pass and fuse it with the vector results.

Deliberately implemented with plain string predicates (tokenize, ``startswith``, ``isupper``)
rather than regexes: the vocabulary is tiny and fixed, and token classification is easier to
audit than a pattern set. Pure and deterministic: same input, same output, in order of first
appearance, deduplicated, capped at ``max_terms``.
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


def extract_exact_terms(query: str, *, max_terms: int = 3) -> list[str]:
    """Extract exact-match legal terms from ``query`` for the lexical retrieval channel.

    Recognizes, in order of first appearance:

    - §-references with or without a space (``§ 3``, ``§3``, ``§ 12.1``), emitted as ``§ <n>``;
    - OIB-Richtlinie references (``OIB-Richtlinie 2``), case-insensitive on the name token;
    - quoted phrases (``"…"``, ``'…'``, ``„…"``, ``‚…'``), emitted without the quotes;
    - ALLCAPS tokens of length >= 3 (``OIB``, ``ÖNORM``), edge punctuation stripped.

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

    found.sort(key=lambda item: item[0])
    terms: list[str] = []
    for _, term in found:
        if term not in terms:
            terms.append(term)
        if len(terms) >= max_terms:
            break
    return terms
