"""Mechanical noise models for quote verification.

Two directions of noise, and the distinction matters:

* **Answer-side** — the model transcribes a passage it read. Its rendering
  differs from the stored passage in ways that have nothing to do with honesty:
  it restores a hyphen the PDF broke across a line, writes ``ss`` for ``ß``,
  swaps German quote marks, adds an ellipsis, wraps the quote in a blockquote.
* **Chunk-side** — the stored passage itself is dirty (OCR confusions, split
  words, lost spaces) while the model quotes the clean reading.

Both produce a *genuine verbatim quote that no longer matches character for
character*, which is exactly the false-positive risk this calibration measures.
None of it depends on which model wrote the answer.
"""

from __future__ import annotations

import random
import re
from collections.abc import Callable

# --------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------


def _long_word_spans(text: str, minimum: int = 9) -> list[tuple[int, int]]:
    pattern = re.compile(rf"[A-Za-zÄÖÜäöüß]{{{minimum},}}")
    return [match.span() for match in pattern.finditer(text)]


def _split_inside_word(text: str, rng: random.Random, inserted: str) -> str | None:
    """Insert ``inserted`` inside a long word, as a line wrap would."""
    spans = _long_word_spans(text)
    if not spans:
        return None
    start, end = rng.choice(spans)
    cut = start + (end - start) // 2
    return text[:cut] + inserted + text[cut:]


def _replace_n(text: str, needle: str, replacement: str, count: int) -> str | None:
    if needle not in text:
        return None
    return text.replace(needle, replacement, count)


# --------------------------------------------------------------------------
# Answer-side perturbations (label: should VERIFY)
# --------------------------------------------------------------------------
#
# ``safe`` marks perturbations that ``_normalize_for_quote_match`` is documented
# to absorb (NFKC, whitespace collapse, hyphen-wrap join, blockquote strip,
# casefold). ``risky`` marks real renderings the normalizer does NOT absorb.

Perturbation = Callable[[str, random.Random], "str | None"]


def p_exact(text: str, rng: random.Random) -> str | None:
    return text


def p_whitespace_expand(text: str, rng: random.Random) -> str | None:
    return re.sub(r" ", "   ", text, count=3)


def p_whitespace_newlines(text: str, rng: random.Random) -> str | None:
    """Quote copied with the source's line layout intact."""
    words = text.split(" ")
    if len(words) < 8:
        return None
    for index in range(6, len(words), 7):
        words[index] = "\n" + words[index]
    return " ".join(words)


def p_hyphen_wrap_newline(text: str, rng: random.Random) -> str | None:
    """Model kept the PDF's line-wrap hyphen AND the newline (``Bau-\\nordnung``)."""
    return _split_inside_word(text, rng, "-\n")


def p_hyphen_wrap_space(text: str, rng: random.Random) -> str | None:
    """Model kept the wrap hyphen but the newline became a space (``Bau- ordnung``).

    This is what copy-paste out of a PDF viewer produces. The normalizer only
    joins ``-\\n``, so this survives into the comparison.
    """
    return _split_inside_word(text, rng, "- ")


def p_soft_hyphen(text: str, rng: random.Random) -> str | None:
    """Soft hyphens (U+00AD) inside words. NFKC does not remove them.

    Two are attempted; one is enough. (Inserting the first breaks the word up so
    the second pass may find no other long word — that must not discard the case.)
    """
    first = _split_inside_word(text, rng, "­")
    if first is None:
        return None
    return _split_inside_word(first, rng, "­") or first


def p_nbsp(text: str, rng: random.Random) -> str | None:
    """Non-breaking spaces before units (``60 m``). NFKC maps them to spaces."""
    return re.sub(r" (m²|m|cm|%)\b", " \\1", text, count=3)


def p_narrow_nbsp(text: str, rng: random.Random) -> str | None:
    return re.sub(r" ", " ", text, count=2)


def p_ligature(text: str, rng: random.Random) -> str | None:
    """Typographic ligatures from the PDF font. NFKC decomposes them."""
    out = _replace_n(text, "fi", "ﬁ", 2)
    return _replace_n(out, "fl", "ﬂ", 2) or out if out else _replace_n(text, "fl", "ﬂ", 2)


def p_casing_upper(text: str, rng: random.Random) -> str | None:
    return text.upper()


def p_casing_title(text: str, rng: random.Random) -> str | None:
    return " ".join(word.capitalize() for word in text.split(" "))


def p_blockquote(text: str, rng: random.Random) -> str | None:
    return "> " + text


def p_blockquote_multiline(text: str, rng: random.Random) -> str | None:
    wrapped = p_whitespace_newlines(text, rng)
    if wrapped is None:
        return None
    return "\n".join("> " + line for line in wrapped.split("\n"))


def p_ellipsis_trailing(text: str, rng: random.Random) -> str | None:
    return text + " …"


def p_ellipsis_trailing_ascii(text: str, rng: random.Random) -> str | None:
    return text + " ..."


def p_ellipsis_leading(text: str, rng: random.Random) -> str | None:
    return "… " + text


def p_sz_to_ss(text: str, rng: random.Random) -> str | None:
    """German ``ß`` written ``ss`` (Swiss orthography / model habit)."""
    return _replace_n(text, "ß", "ss", 3)


def p_umlaut_transliteration(text: str, rng: random.Random) -> str | None:
    out = text
    for umlaut, ascii_form in (("ä", "ae"), ("ö", "oe"), ("ü", "ue")):
        out = out.replace(umlaut, ascii_form, 2)
    return out if out != text else None


def p_dash_normalized(text: str, rng: random.Random) -> str | None:
    """En dash ``–`` rendered as an ASCII hyphen. NFKC keeps them distinct."""
    return _replace_n(text, "–", "-", 3)


def p_interior_quote_ascii(text: str, rng: random.Random) -> str | None:
    """German „…“ inside the quoted sentence rendered as ASCII ``"…"``."""
    if "„" not in text:
        return None
    return text.replace("„", '"').replace("“", '"').replace("”", '"')


def p_interior_quote_guillemets(text: str, rng: random.Random) -> str | None:
    if "„" not in text:
        return None
    return text.replace("„", "»").replace("“", "«").replace("”", "«")


def p_extra_hyphen(text: str, rng: random.Random) -> str | None:
    """One extra hyphen inside a word — a single unmatched character.

    The generic shape of a restored compound hyphen, usable in combinations. The
    *faithful* version, which restores a hyphen the source PDF really broke
    across a line, is built from passage context by :func:`restore_wrap_hyphen`.
    """
    spans = _long_word_spans(text, minimum=6)
    if not spans:
        return None
    start, end = rng.choice(spans)
    cut = start + (end - start) // 2
    return text[:cut] + "-" + text[cut:]


_WRAP_HYPHEN_RE = re.compile(r"([A-Za-zÄÖÜäöüß]{2,})-\n([A-Za-zÄÖÜäöüß]{2,})")


def restore_wrap_hyphen(quote: str, raw_passage: str) -> str | None:
    """Rewrite ``quote`` the way a correct answer renders a REAL line-wrap hyphen.

    ``OIB-\\nRichtlinien`` in the stored passage is joined by
    ``_normalize_for_quote_match`` to ``oibrichtlinien`` — the wrap-join cannot
    tell a genuine compound hyphen from a typesetter's break. A correct answer
    writes ``OIB-Richtlinien``, so the restored hyphen becomes an unmatched
    character even though the quote is perfectly verbatim.

    Only GENUINE compounds are restored, not typesetter syllable breaks: German
    orthography capitalises the second element of a compound noun
    (``Brutto-Grundfläche``), while a plain hyphenation break continues in lower
    case (``Brandab-schnittes``) — nobody writes that one back with its hyphen.

    Returns ``None`` when the passage has no such wrap that survives into the quote.
    """
    for match in _WRAP_HYPHEN_RE.finditer(raw_passage):
        head, tail = match.group(1), match.group(2)
        if not (tail[:1].isupper() or head.isupper()):
            continue
        joined = head + tail
        if joined in quote:
            return quote.replace(joined, f"{head}-{tail}", 1)
    return None


SAFE_PERTURBATIONS: dict[str, Perturbation] = {
    "exact": p_exact,
    "whitespace_expand": p_whitespace_expand,
    "whitespace_newlines": p_whitespace_newlines,
    "hyphen_wrap_newline": p_hyphen_wrap_newline,
    "nbsp": p_nbsp,
    "narrow_nbsp": p_narrow_nbsp,
    "ligature_nfkc": p_ligature,
    "casing_upper": p_casing_upper,
    "casing_title": p_casing_title,
    "blockquote": p_blockquote,
    "blockquote_multiline": p_blockquote_multiline,
}

RISKY_PERTURBATIONS: dict[str, Perturbation] = {
    "hyphen_wrap_space": p_hyphen_wrap_space,
    "soft_hyphen": p_soft_hyphen,
    "ellipsis_trailing": p_ellipsis_trailing,
    "ellipsis_trailing_ascii": p_ellipsis_trailing_ascii,
    "ellipsis_leading": p_ellipsis_leading,
    "sz_to_ss": p_sz_to_ss,
    "umlaut_transliteration": p_umlaut_transliteration,
    "dash_normalized": p_dash_normalized,
    "interior_quote_ascii": p_interior_quote_ascii,
    "interior_quote_guillemets": p_interior_quote_guillemets,
    "extra_hyphen": p_extra_hyphen,
}


def compose(*names: str) -> Perturbation:
    """Apply several perturbations in sequence, skipping the inapplicable ones.

    A real transcript carries whichever noise classes its sentence admits — a
    sentence with no ``ß`` simply has no ``ß``→``ss`` error. Aborting the whole
    combination on the first inapplicable step would have silently deleted the
    combination cases for exactly those sentences. ``None`` only when nothing
    applied at all.
    """
    table = {**SAFE_PERTURBATIONS, **RISKY_PERTURBATIONS}

    def applied(text: str, rng: random.Random) -> str | None:
        out = text
        for name in names:
            step = table[name](out, rng)
            if step is not None:
                out = step
        return out if out != text else None

    return applied


COMBINED_PERTURBATIONS: dict[str, Perturbation] = {
    "combo_safe_only": compose("whitespace_expand", "nbsp", "casing_title", "ligature_nfkc"),
    "combo_wrap_plus_orthography": compose("hyphen_wrap_space", "sz_to_ss"),
    "combo_orthography_plus_dash": compose("sz_to_ss", "dash_normalized", "umlaut_transliteration"),
    "combo_quote_plus_ellipsis": compose("interior_quote_ascii", "ellipsis_trailing"),
    "combo_realistic_transcript": compose("extra_hyphen", "sz_to_ss", "whitespace_expand", "casing_title"),
    "combo_heavy": compose(
        "hyphen_wrap_space", "soft_hyphen", "sz_to_ss", "dash_normalized", "ellipsis_trailing", "blockquote"
    ),
}


# --------------------------------------------------------------------------
# Chunk-side OCR noise (label: should still VERIFY — the quote is honest)
# --------------------------------------------------------------------------


def ocr_noise(raw: str, rng: random.Random, rate: float) -> str:
    """Inject classic OCR confusions into a stored passage.

    ``rate`` is the probability per eligible site. The quote is taken from the
    CLEAN reading, so every injected error is a divergence the verifier sees.
    """
    out: list[str] = []
    index = 0
    substitutions = (("rn", "m"), ("m", "rn"), ("l", "1"), ("O", "0"), ("ü", "ii"), ("ft", "ff"))
    while index < len(raw):
        applied = False
        for needle, replacement in substitutions:
            if raw.startswith(needle, index) and rng.random() < rate:
                out.append(replacement)
                index += len(needle)
                applied = True
                break
        if not applied:
            out.append(raw[index])
            index += 1
    return "".join(out)


def whitespace_damage(raw: str, rng: random.Random, rate: float) -> str:
    """Lost and spurious spaces, as column-aware PDF extraction produces."""
    out: list[str] = []
    for character in raw:
        if character == " " and rng.random() < rate:
            continue  # word run-together
        out.append(character)
        if character.isalpha() and rng.random() < rate / 3:
            out.append(" ")  # spurious split
    return "".join(out)


# --------------------------------------------------------------------------
# Fabrication models (label: should FLAG)
# --------------------------------------------------------------------------


def elide_middle(text: str, chars: int) -> str | None:
    """Drop ``chars`` characters from the middle — an adjacent-clause splice.

    This is the parameterised form of the documented hard case: the quote merges
    material either side of a run of real passage text it silently skipped. The
    sweep over ``chars`` is what locates the ``_QUOTE_MAX_ELIDED_GAP`` cliff.
    """
    if len(text) < chars + 40:
        return None
    cut = (len(text) - chars) // 2
    return text[:cut] + text[cut + chars :]


def splice_adjacent(first: str, second: str, *, keep_first: float = 0.55) -> str:
    """Tail of one sentence welded to the head of the next, connective dropped."""
    head = first[: max(20, int(len(first) * keep_first))].rstrip()
    tail = second[: max(20, int(len(second) * (1 - keep_first) + 20))].rstrip()
    return f"{head} {tail}"


def splice_scattered(fragments: list[str]) -> str:
    """Fragments pulled from different paragraphs and joined."""
    return " ".join(fragment.strip() for fragment in fragments if fragment.strip())
