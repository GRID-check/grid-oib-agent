"""Labelled quote-verification cases built from the calibration corpus.

Every case is a complete answer text with one or more quoted spans, plus the
registry it should be verified against and the label the system OUGHT to
produce:

``verify``
    A genuine verbatim quote. Flagging it is a FALSE POSITIVE — the damaging
    error, because the answer is publicly accused of fabricating and its
    confidence is capped.
``flag``
    A quote that is not verbatim in any retrieved passage. Verifying it is a
    FALSE NEGATIVE.
``attribution``
    A real sentence taken from a DIFFERENT retrieved document than the one the
    answer cites. Whole-registry matching cannot express this; scored and
    reported separately so it does not contaminate the false-negative rate.
``grey``
    Judgement calls (a single dropped word) that no threshold can settle.
    Reported, never counted.
"""

from __future__ import annotations

import random
import re
import unicodedata
from dataclasses import dataclass

from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from calibration.quote_verification import perturbations as pert
from calibration.quote_verification.corpus import Corpus
from calibration.quote_verification.corpus import Passage
from calibration.quote_verification.corpus import clean_text
from calibration.quote_verification.corpus import sentences

SEED = 20260728

# Registry variants a case can be scored against.
REGISTRY_CLEAN = "clean"
REGISTRY_OCR_LIGHT = "ocr_light"
REGISTRY_OCR_HEAVY = "ocr_heavy"

# Enclosing quote-mark styles the answer may use. All six are accepted by
# ``_QUOTED_SPAN_RE``; a genuine quote must verify under every one of them.
MARK_STYLES: dict[str, tuple[str, str]] = {
    "german": ("„", "“"),
    "german_lenient": ("„", "”"),
    "german_ascii_close": ("„", '"'),
    "guillemets": ("»", "«"),
    "curly": ("“", "”"),
    "ascii": ('"', '"'),
}

_ALL_MARK_CHARS = '„“”»«"'


@dataclass(frozen=True)
class Case:
    """One labelled answer + registry pair."""

    case_id: str
    family: str
    noise_class: str
    label: str
    answer: str
    quote: str
    registry: str
    origin: str
    note: str = ""


def _pick_marks(quote: str, preferred: str = "german") -> tuple[str, str]:
    """An enclosing mark pair that does not collide with the quote's own marks."""
    order = [preferred, "german", "guillemets", "ascii", "curly"]
    for style in order:
        open_mark, close_mark = MARK_STYLES[style]
        if open_mark not in quote and close_mark not in quote:
            if style in {"german", "german_lenient", "german_ascii_close"} and any(
                character in quote for character in '„“”"'
            ):
                continue
            if style == "guillemets" and any(character in quote for character in "»«"):
                continue
            if style in {"ascii", "curly"} and any(character in quote for character in '"“”'):
                continue
            return open_mark, close_mark
    return MARK_STYLES["guillemets"]


def build_answer(quote: str, *, style: str = "german", avoid_collision: bool = True) -> str:
    """Embed a quoted span in short German answer prose (no source section)."""
    if avoid_collision:
        open_mark, close_mark = _pick_marks(quote, style)
    else:
        open_mark, close_mark = MARK_STYLES[style]
    return (
        "Zur gestellten Frage ist Folgendes festzuhalten. "
        f"Die Richtlinie bestimmt: {open_mark}{quote}{close_mark} "
        "Daraus folgt die oben dargestellte Beurteilung."
    )


# --------------------------------------------------------------------------
# Registries
# --------------------------------------------------------------------------


def _entry(passage: Passage, chunk_text: str) -> SourceEntry:
    return SourceEntry(
        citation_key=passage.citation_key,
        title=passage.doc,
        source_type="knowledge_layer",
        tool_name="knowledge_search_tool",
        collection="oib_knowledge",
        chunk_text=chunk_text,
    )


def build_registries(corpus: Corpus, rng: random.Random) -> dict[str, SourceRegistry]:
    """One registry per chunk-noise level, each holding every corpus passage.

    A live retrieval returns up to ten hits and ``verify_quoted_spans`` matches
    a span against ALL of them, so the whole corpus in one registry is the
    faithful shape — and it is also the shape that lets an accidental match
    happen, which is part of what we are measuring.
    """
    clean = SourceRegistry()
    light = SourceRegistry()
    heavy = SourceRegistry()
    for passage in corpus.passages:
        clean.add(_entry(passage, passage.raw))
        light.add(_entry(passage, pert.whitespace_damage(pert.ocr_noise(passage.raw, rng, 0.02), rng, 0.01)))
        heavy.add(_entry(passage, pert.whitespace_damage(pert.ocr_noise(passage.raw, rng, 0.08), rng, 0.04)))
    return {REGISTRY_CLEAN: clean, REGISTRY_OCR_LIGHT: light, REGISTRY_OCR_HEAVY: heavy}


# --------------------------------------------------------------------------
# Hand-written negatives
# --------------------------------------------------------------------------
#
# Each paraphrase carries an ANCHOR: a distinctive substring of the sentence it
# paraphrases. The case is only emitted when the anchor really is in the loaded
# corpus, so the paraphrase is a paraphrase of retrieved evidence rather than an
# accidental fabrication — and the list stays valid if the corpus changes.

_PARAPHRASES: list[tuple[str, str]] = [
    (
        "sinngemäß anzuwenden",
        "Bei sonstigen Bauwerken sind die Regelungen dieser Richtlinie sinngemäß heranzuziehen.",
    ),
    (
        "Fertigmaße nach Vollendung",
        "Sämtliche in dieser Richtlinie genannten Maße sind nach Fertigstellung der Bauführung "
        "als Fertigmaße zu verstehen.",
    ),
    (
        "keine Anforderungen hinsichtlich des Brandschutzes",
        "An eingeschoßige Gebäude mit einer Brutto-Grundfläche von nicht mehr als 15 m², die für "
        "die Brandbekämpfung erreichbar sind, werden keine brandschutztechnischen Anforderungen gestellt.",
    ),
    (
        "lichte Durchgangshöhe",
        "Treppen, Rampen und Gänge müssen eine lichte Durchgangshöhe von zumindest 2,10 m aufweisen, "
        "gemessen an der Stufenvorderkante.",
    ),
    (
        "Reinigungsöffnungen dürfen nicht",
        "Es ist unzulässig, Reinigungsöffnungen in fremden Wohn- oder Betriebseinheiten anzuordnen.",
    ),
    (
        "Mündung der Abgasanlagen",
        "Die Mündung der Abgasanlage ist dabei über den Fenstern, Türen und Zuluftöffnungen anzuordnen.",
    ),
    (
        "landesrechtlichen Bestimmungen geregelt",
        "Die landesrechtlichen Bestimmungen legen fest, welche Gebäude oder Gebäudeteile "
        "barrierefrei auszuführen sind.",
    ),
    (
        "gegeneinander abzutrennen",
        "Die Abtrennung von Brandabschnitten erfolgt durch brandabschnittsbildende Bauteile wie Wände und Decken.",
    ),
    (
        "den First um mindestens",
        "Die Mündung ist mindestens 40 cm über dem First auszuführen.",
    ),
    (
        "anstelle von Personenaufzügen",
        "Sofern höchstens zwei Geschoße zu überwinden sind, dürfen statt Personenaufzügen auch "
        "vertikale Hebeeinrichtungen eingesetzt werden.",
    ),
    (
        "Tauwasserbildung",
        "Der Wärmeschutz ist so auszuführen, dass an den Oberflächen der Bauteile kein Tauwasser anfällt.",
    ),
    (
        "in Fluchtrichtung aufschlagen",
        "Türen entlang von Fluchtwegen sind so auszubilden, dass sie sich in Fluchtrichtung öffnen lassen.",
    ),
]

_FABRICATIONS: list[str] = [
    "Bei Gebäuden der Gebäudeklasse 5 ist ein zweiter baulicher Fluchtweg zwingend vorzusehen.",
    "Die Feuerwiderstandsdauer tragender Bauteile darf in keinem Fall weniger als 90 Minuten betragen.",
    "Rauchabzugsöffnungen müssen mindestens 2 % der Grundfläche des Brandabschnittes aufweisen.",
    "Der Abstand zwischen zwei notwendigen Treppenhäusern darf 35 m nicht überschreiten.",
    "Für Aufenthaltsräume ist eine lichte Raumhöhe von mindestens 2,80 m einzuhalten.",
    "Automatische Löschanlagen sind ab einer Netto-Grundfläche von 3.000 m² verpflichtend zu errichten.",
    "Die Anordnung von Brandmeldeanlagen richtet sich ausschließlich nach der Anzahl der Nutzungseinheiten.",
    "Bauteile der Klasse A1 sind in Treppenhäusern von Gebäuden der Gebäudeklasse 3 unzulässig.",
    "Der Bauwerber hat die Einhaltung dieser Richtlinie durch ein Sachverständigengutachten nachzuweisen.",
    "Bei Umbauten bleiben die Anforderungen dieser Richtlinie in vollem Umfang unberührt bestehen.",
]

# Short fabricated fragments spanning the MIN_QUOTE_LEN boundary. Any that turn
# out to be genuine corpus substrings are dropped at build time.
_SHORT_FABRICATIONS: list[str] = [
    "§ 4 Abs 2",
    "die Klasse C1",
    "mindestens 3,40 m",
    "eine Neigung von 9 %",
    "Rettungsweglänge 55 m",
    "die Klasse C1 Bauteile",
    "Feuerwiderstand REI 150",
    "Schallschutzklasse SSK 4",
    "höchstens 25 m² Nutzfläche",
    "acht oberirdische Geschoße",
    "eine Brandwiderstandsklasse EI 45",
    "ein Abstand von mindestens 7,50 Meter",
    "die höchstzulässige Rauchabschnittsfläche",
    "eine Löschwassermenge von 1.800 Liter je Minute",
]


# Probe grid for the length × divergence surface.
DIVERGENCE_LENGTHS = (12, 16, 20, 24, 28, 32, 40, 60, 100)
DIVERGENCE_COUNTS = (1, 2, 3, 4, 6)


def _substitute(text: str, count: int) -> str | None:
    """Substitute ``count`` characters, spread evenly, keeping the length.

    A same-length substitution is the shape almost all mechanical noise takes
    (``ß``→``ss`` is one character longer; a mark swap is exactly equal), and it
    costs the coverage metric exactly ``count`` matched characters — no elision
    is involved, so this isolates the threshold from the gap budget.
    """
    if len(text) < count * 3:
        return None
    chars = list(text)
    stride = len(chars) // (count + 1)
    for step in range(1, count + 1):
        position = step * stride
        chars[position] = "x" if chars[position] != "x" else "y"
    return "".join(chars)


def _norm(text: str) -> str:
    """Local mirror of the module's normalization, used only for corpus lookups."""
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"-\n", "", text)
    return re.sub(r"\s+", " ", text).strip().casefold()


# --------------------------------------------------------------------------
# Case construction
# --------------------------------------------------------------------------

# Normalized lengths probed around MIN_QUOTE_LEN.
BOUNDARY_LENGTHS = (8, 12, 16, 18, 20, 22, 24, 28, 32, 40, 56)

# Elision sizes probed around _QUOTE_MAX_ELIDED_GAP.
ELISION_SIZES = (2, 4, 6, 8, 10, 12, 16, 24, 40, 80, 160)

# Short German words whose deletion changes what a norm REQUIRES. Each is short
# enough to sit inside a small absolute elision budget.
_MEANING_INVERTING_WORDS = (
    "nicht",
    "kein",
    "keine",
    "nur",
    "auch",
    "höchstens",
    "mindestens",
    "sinngemäß",
    "abweichend",
    "ausgenommen",
    "zulässig",
)


def _quotable(corpus: Corpus, minimum: int = 90, limit: int | None = None) -> list[tuple[Passage, str]]:
    """(passage, sentence) pairs long enough to carry several noise classes.

    ``limit`` caps the pool round-robin across passages, so a smaller run still
    covers every document rather than exhausting the first one.
    """
    per_passage = [[(passage, s) for s in sentences(passage) if len(s) >= minimum] for passage in corpus.passages]
    pairs: list[tuple[Passage, str]] = []
    for index in range(max((len(group) for group in per_passage), default=0)):
        for group in per_passage:
            if index < len(group):
                pairs.append(group[index])
    return pairs[:limit] if limit else pairs


def build_cases(corpus: Corpus, *, max_sentences: int | None = None) -> list[Case]:  # noqa: PLR0912, PLR0915 - a flat catalogue reads better than nested builders
    """The full labelled catalogue."""
    cases: list[Case] = []
    all_pairs = _quotable(corpus)
    pairs = all_pairs[:max_sentences] if max_sentences else all_pairs
    if not pairs:
        raise RuntimeError("corpus produced no quotable sentences")
    corpus_norm = [_norm(passage.raw) for passage in corpus.passages]

    def in_corpus(fragment: str) -> bool:
        needle = _norm(fragment)
        return any(needle in chunk for chunk in corpus_norm)

    def add(**kwargs: object) -> None:
        cases.append(Case(**kwargs))  # type: ignore[arg-type]

    # ---------------- verbatim + enclosing mark styles ----------------
    for index, (passage, sentence) in enumerate(pairs):
        add(
            case_id=f"verbatim/{index}",
            family="verbatim",
            noise_class="exact",
            label="verify",
            answer=build_answer(sentence),
            quote=sentence,
            registry=REGISTRY_CLEAN,
            origin=passage.citation_key,
        )
    for style in MARK_STYLES:
        for index, (passage, sentence) in enumerate(pairs[:6]):
            if any(character in sentence for character in _ALL_MARK_CHARS):
                continue
            add(
                case_id=f"marks/{style}/{index}",
                family="mark_style",
                noise_class=f"marks_{style}",
                label="verify",
                answer=build_answer(sentence, style=style, avoid_collision=False),
                quote=sentence,
                registry=REGISTRY_CLEAN,
                origin=passage.citation_key,
            )

    # ---------------- single mechanical noise classes ----------------
    noise_tables = (
        ("noise_safe", pert.SAFE_PERTURBATIONS),
        ("noise_risky", pert.RISKY_PERTURBATIONS),
        ("noise_combined", pert.COMBINED_PERTURBATIONS),
    )
    for family, table in noise_tables:
        for name, function in table.items():
            if name == "exact":
                continue
            for index, (passage, sentence) in enumerate(pairs):
                perturbed = function(sentence, random.Random(SEED + index))
                if perturbed is None or perturbed == sentence:
                    continue
                add(
                    case_id=f"{family}/{name}/{index}",
                    family=family,
                    noise_class=name,
                    label="verify",
                    answer=build_answer(perturbed),
                    quote=perturbed,
                    registry=REGISTRY_CLEAN,
                    origin=passage.citation_key,
                )

    # ---------------- restored compound hyphen (needs passage context) ----------------
    # The one noise class that cannot be modelled from the quote alone: the
    # stored passage broke a REAL compound across a line (``OIB-\nRichtlinien``),
    # the normalizer's wrap-join deletes the hyphen, and a correct answer writes
    # it back. Built from the actual wraps in the actual PDF text.
    for index, (passage, sentence) in enumerate(all_pairs):
        restored = pert.restore_wrap_hyphen(sentence, passage.raw)
        if restored is None or restored == sentence:
            continue
        add(
            case_id=f"wrap_hyphen/{index}",
            family="restored_compound_hyphen",
            noise_class="compound_hyphen_restored",
            label="verify",
            answer=build_answer(restored),
            quote=restored,
            registry=REGISTRY_CLEAN,
            origin=passage.citation_key,
            note="answer writes the compound hyphen the PDF broke across a line",
        )

    # ---------------- interior quote marks kept (regex stress) ----------------
    for index, (passage, sentence) in enumerate(all_pairs):
        if "„" not in sentence:
            continue
        add(
            case_id=f"interior_marks/{index}",
            family="interior_marks",
            noise_class="interior_marks_kept",
            label="verify",
            answer=build_answer(sentence, style="guillemets", avoid_collision=False),
            quote=sentence,
            registry=REGISTRY_CLEAN,
            origin=passage.citation_key,
            note="quoted sentence itself contains German quotation marks",
        )

    # ---------------- chunk-side OCR damage ----------------
    for registry_name in (REGISTRY_OCR_LIGHT, REGISTRY_OCR_HEAVY):
        for index, (passage, sentence) in enumerate(pairs):
            add(
                case_id=f"chunk_ocr/{registry_name}/{index}",
                family=f"chunk_ocr_{registry_name.removeprefix('ocr_')}",
                noise_class=registry_name,
                label="verify",
                answer=build_answer(sentence),
                quote=sentence,
                registry=registry_name,
                origin=passage.citation_key,
            )

    # ---------------- boundary: short VERBATIM prefixes ----------------
    for target in BOUNDARY_LENGTHS:
        for index, (passage, sentence) in enumerate(pairs[:8]):
            fragment = sentence[:target].rstrip()
            if len(_norm(fragment)) < max(4, target - 4):
                continue
            add(
                case_id=f"boundary_true/{target}/{index}",
                family="boundary_short_verbatim",
                noise_class=f"len_{target}",
                label="verify",
                answer=build_answer(fragment),
                quote=fragment,
                registry=REGISTRY_CLEAN,
                origin=passage.citation_key,
            )
    # Same fragments, one character substituted — the shortest realistic noise.
    for target in BOUNDARY_LENGTHS:
        for index, (passage, sentence) in enumerate(pairs[:8]):
            fragment = sentence[:target].rstrip()
            if len(fragment) < 8:
                continue
            middle = len(fragment) // 2
            noisy = fragment[:middle] + ("x" if fragment[middle] != "x" else "y") + fragment[middle + 1 :]
            add(
                case_id=f"boundary_true_1char/{target}/{index}",
                family="boundary_short_one_char_noise",
                noise_class=f"len_{target}",
                label="verify",
                answer=build_answer(noisy),
                quote=noisy,
                registry=REGISTRY_CLEAN,
                origin=passage.citation_key,
                note="single-character divergence — the smallest possible mechanical error",
            )

    # ---------------- length × divergence surface ----------------
    # The decisive interaction between QUOTE_MATCH_THRESHOLD and MIN_QUOTE_LEN.
    # Coverage of a genuine quote carrying ``k`` unmatched characters is
    # ``(L - k) / L``, so the tolerance is a fraction of the quote — a short
    # quote gets almost none. This family measures the boundary directly instead
    # of arguing it: a real verbatim fragment of a controlled length, with a
    # controlled number of characters substituted. Everything here is a genuine
    # quote of retrieved text, so every flag is a false positive.
    for target in DIVERGENCE_LENGTHS:
        for divergences in DIVERGENCE_COUNTS:
            for index, (passage, sentence) in enumerate(pairs[:6]):
                fragment = sentence[:target].rstrip()
                if len(fragment) < target - 4 or len(fragment) < divergences * 3:
                    continue
                noisy = _substitute(fragment, divergences)
                if noisy is None:
                    continue
                add(
                    case_id=f"len_div/{target}/{divergences}/{index}",
                    family="length_vs_divergence",
                    noise_class=f"len_{target}_div_{divergences}",
                    label="verify",
                    answer=build_answer(noisy),
                    quote=noisy,
                    registry=REGISTRY_CLEAN,
                    origin=passage.citation_key,
                    note=f"{divergences} unmatched characters in a {target}-character verbatim quote",
                )

    # ---------------- German orthography on SHORT quotes ----------------
    # The two-character divergences that occur in ordinary correct German:
    # ``ß``→``ss`` and a German→ASCII quotation-mark pair. Applied to short
    # fragments, where a two-character cost is a large fraction of the quote.
    for target in (24, 32, 48, 72):
        for index, (passage, sentence) in enumerate(pairs):
            fragment = sentence[:target].rstrip()
            for name, function in (
                ("sz_to_ss", pert.p_sz_to_ss),
                ("umlaut_transliteration", pert.p_umlaut_transliteration),
                ("interior_quote_ascii", pert.p_interior_quote_ascii),
            ):
                perturbed = function(fragment, random.Random(SEED + index))
                if perturbed is None or perturbed == fragment:
                    continue
                add(
                    case_id=f"short_orthography/{name}/{target}/{index}",
                    family="short_german_orthography",
                    noise_class=f"{name}_len_{target}",
                    label="verify",
                    answer=build_answer(perturbed),
                    quote=perturbed,
                    registry=REGISTRY_CLEAN,
                    origin=passage.citation_key,
                )

    # ---------------- meaning-inverting micro-elisions ----------------
    # The elision budget is an ABSOLUTE character count, so it is blind to WHICH
    # characters were dropped. In German normative prose the highest-stakes words
    # are among the shortest: deleting "nicht " (6 chars) reverses a duty.
    # Drawn from the FULL sentence pool, never the capped one: the family is
    # small, cheap, and the single most consequential thing the gap budget does.
    for word in _MEANING_INVERTING_WORDS:
        pattern = re.compile(rf"\s{re.escape(word)}\b")
        for index, (passage, sentence) in enumerate(all_pairs):
            shortened, replaced = pattern.subn("", sentence, count=1)
            if not replaced:
                continue
            add(
                case_id=f"negation_elision/{word}/{index}",
                family="meaning_inverting_elision",
                noise_class=f"drop_{word}_{len(word) + 1}chars",
                label="flag",
                answer=build_answer(shortened),
                quote=shortened,
                registry=REGISTRY_CLEAN,
                origin=passage.citation_key,
                note=f"dropped '{word}' ({len(word) + 1} chars incl. one space) — reverses the rule",
            )

    # ---------------- boundary: short FABRICATED fragments ----------------
    for fragment in _SHORT_FABRICATIONS:
        if in_corpus(fragment):
            continue
        add(
            case_id=f"boundary_false/{len(_norm(fragment))}/{fragment[:16]}",
            family="boundary_short_fabricated",
            noise_class=f"len_{len(_norm(fragment))}",
            label="flag",
            answer=build_answer(fragment),
            quote=fragment,
            registry=REGISTRY_CLEAN,
            origin="-",
        )

    # ---------------- elision sweep (adjacent-clause splice, parameterised) ----------------
    for size in ELISION_SIZES:
        for index, (passage, sentence) in enumerate(pairs):
            spliced = pert.elide_middle(sentence, size)
            if spliced is None:
                continue
            label = "grey" if size <= 6 else "flag"
            add(
                case_id=f"elision/{size}/{index}",
                family="elision_sweep",
                noise_class=f"elided_{size}",
                label=label,
                answer=build_answer(spliced),
                quote=spliced,
                registry=REGISTRY_CLEAN,
                origin=passage.citation_key,
                note="a dropped word or two is a judgement call, not a fabrication" if label == "grey" else "",
            )

    # ---------------- natural adjacent-clause splices ----------------
    for passage in corpus.passages:
        passage_sentences = [s for s in sentences(passage) if len(s) >= 70]
        for index in range(len(passage_sentences) - 1):
            spliced = pert.splice_adjacent(passage_sentences[index], passage_sentences[index + 1])
            add(
                case_id=f"adjacent_splice/{passage.citation_key}/{index}",
                family="adjacent_splice",
                noise_class="adjacent_splice",
                label="flag",
                answer=build_answer(spliced),
                quote=spliced,
                registry=REGISTRY_CLEAN,
                origin=passage.citation_key,
            )
        # Lopsided splice: almost all of one sentence plus a short real tail from
        # the next. The hardest shape for a run-length metric.
        for index in range(len(passage_sentences) - 1):
            spliced = pert.splice_adjacent(passage_sentences[index], passage_sentences[index + 1], keep_first=0.92)
            add(
                case_id=f"lopsided_splice/{passage.citation_key}/{index}",
                family="lopsided_splice",
                noise_class="lopsided_splice",
                label="flag",
                answer=build_answer(spliced),
                quote=spliced,
                registry=REGISTRY_CLEAN,
                origin=passage.citation_key,
                note="≈92% of one real sentence plus a real fragment of the next",
            )

    # ---------------- scattered splices across paragraphs ----------------
    for index in range(min(12, len(pairs) - 2)):
        first = pairs[index][1]
        second = pairs[(index + 4) % len(pairs)][1]
        third = pairs[(index + 7) % len(pairs)][1]
        spliced = pert.splice_scattered([first[:60], second[20:80], third[:50]])
        add(
            case_id=f"scattered_splice/{index}",
            family="scattered_splice",
            noise_class="scattered_splice",
            label="flag",
            answer=build_answer(spliced),
            quote=spliced,
            registry=REGISTRY_CLEAN,
            origin="-",
        )

    # ---------------- paraphrases ----------------
    for anchor, paraphrase in _PARAPHRASES:
        if not in_corpus(anchor):
            continue
        add(
            case_id=f"paraphrase/{anchor[:24]}",
            family="paraphrase",
            noise_class="paraphrase",
            label="flag",
            answer=build_answer(paraphrase),
            quote=paraphrase,
            registry=REGISTRY_CLEAN,
            origin="-",
            note=f"paraphrases retrieved text anchored on '{anchor}'",
        )

    # ---------------- wholesale fabrications ----------------
    for index, fabricated in enumerate(_FABRICATIONS):
        if in_corpus(fabricated):
            continue
        add(
            case_id=f"fabricated/{index}",
            family="fabricated",
            noise_class="fabricated",
            label="flag",
            answer=build_answer(fabricated),
            quote=fabricated,
            registry=REGISTRY_CLEAN,
            origin="-",
        )

    # ---------------- attribution: real sentence, wrong document ----------------
    documents = sorted({passage.doc for passage in corpus.passages})
    if len(documents) >= 2:
        for index, (passage, sentence) in enumerate(pairs):
            other = next((document for document in documents if document != passage.doc), None)
            if other is None:
                continue
            add(
                case_id=f"attribution/{index}",
                family="attribution",
                noise_class="other_document",
                label="attribution",
                answer=build_answer(sentence),
                quote=sentence,
                registry=REGISTRY_CLEAN,
                origin=passage.citation_key,
                note=f"answer cites {other} but quotes {passage.citation_key}",
            )

    # ---------------- grey zone: a single dropped word ----------------
    for index, (passage, sentence) in enumerate(pairs):
        words = sentence.split(" ")
        if len(words) < 10:
            continue
        dropped = words[len(words) // 2]
        shortened = " ".join(words[: len(words) // 2] + words[len(words) // 2 + 1 :])
        add(
            case_id=f"dropped_word/{index}",
            family="dropped_word",
            noise_class=f"dropped_{len(dropped)}_chars",
            label="grey",
            answer=build_answer(shortened),
            quote=shortened,
            registry=REGISTRY_CLEAN,
            origin=passage.citation_key,
            note=f"dropped the {len(dropped)}-character word '{dropped}'",
        )

    return cases


def clean_reading(passage: Passage) -> str:
    """Convenience re-export used by the report writer."""
    return clean_text(passage.raw)
