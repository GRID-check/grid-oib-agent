"""Calibration corpus: retrieved-passage text for quote verification.

Preferred provenance is the REAL OIB Richtlinien corpus in ``data/oib`` (Git LFS
tracked; this module checks the files are real PDFs and not LFS pointer stubs).
Extraction uses ``pdfplumber``, which is what the knowledge layer's ingestion
path also has available, so the passage bodies carry the SAME mechanical
artifacts a live retrieval would hand to ``verify_quoted_spans`` — most
importantly the hyphenated line wraps (``gegeneinan-\\nder``) that PDF layout
extraction produces on every justified paragraph.

If the real corpus is unavailable, :func:`load_passages` falls back to a small
hand-written German building-regulation corpus and marks the provenance as
``synthetic`` so the report can say so.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# Repo root = calibration/quote_verification/corpus.py -> up three levels.
REPO_ROOT = Path(__file__).resolve().parents[2]
OIB_DIR = REPO_ROOT / "data" / "oib"

# Prose-heavy Richtlinien. Order matters only for reproducibility of case IDs.
_PREFERRED_DOCS = (
    "oib-rl_2_ausgabe_mai_2023.pdf",
    "oib-rl_4_ausgabe_mai_2023.pdf",
    "oib-rl_3_ausgabe_mai_2023.pdf",
    "oib-rl_1_ausgabe_mai_2023.pdf",
)

# Pages to consider per document. Page 0 is the cover, page 1-2 the table of
# contents; the normative prose starts around page 3.
_PAGE_RANGE = range(2, 12)

# A retrieved chunk in the live system is ~1024 chars (llamaindex adapter
# default) and is truncated at 1500 by ``register._format_results``.
CHUNK_TARGET_CHARS = 1100

# A "sentence" must look like normative prose, not a table row or a heading.
_MIN_SENTENCE_CHARS = 60
_MAX_SENTENCE_CHARS = 400


@dataclass(frozen=True)
class Passage:
    """One retrieved passage (what lands in ``SourceEntry.chunk_text``)."""

    doc: str
    page: int
    raw: str
    """Body exactly as extraction produced it: line breaks and hyphen wraps intact."""

    @property
    def citation_key(self) -> str:
        return f"{self.doc}, p.{self.page}"


def clean_text(raw: str) -> str:
    """The READING form of a passage — what a model transcribes when it quotes.

    Joins hyphenated line wraps and collapses layout whitespace. This is
    deliberately the same repair ``_normalize_for_quote_match`` performs, so an
    unperturbed sentence taken from here is a genuine verbatim quote of the raw
    passage and must verify at coverage 1.0.
    """
    text = re.sub(r"-\n", "", raw)
    return re.sub(r"\s+", " ", text).strip()


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.;:])\s+(?=[A-ZÄÖÜ„»(])")
_WORD_RE = re.compile(r"[A-Za-zÄÖÜäöüß]{3,}")


def sentences(passage: Passage) -> list[str]:
    """Prose sentences of a passage, in the reading form a quoting model would use.

    Table rows, headings and numbering fragments are filtered out: a candidate
    must have enough real words and must not be dominated by digits.
    """
    text = clean_text(passage.raw)
    # Drop the running header ("Österreichisches Institut für Bautechnik ...").
    text = re.sub(r"Österreichisches Institut für Bautechnik\s+OIB-[\d.\-/]+\s+OIB-Richtlinie\s+\S+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    out: list[str] = []
    for candidate in _SENTENCE_SPLIT_RE.split(text):
        candidate = re.sub(r"^\s*\d+(?:\.\d+)*\s+", "", candidate).strip()
        if not (_MIN_SENTENCE_CHARS <= len(candidate) <= _MAX_SENTENCE_CHARS):
            continue
        words = _WORD_RE.findall(candidate)
        if len(words) < 8:
            continue
        digits = sum(character.isdigit() for character in candidate)
        if digits > len(candidate) * 0.12:
            continue
        if candidate not in text:  # paranoia: the sentence must be a real substring
            continue
        out.append(candidate)
    return out


def _is_real_pdf(path: Path) -> bool:
    """True when ``path`` is an actual PDF and not a Git-LFS pointer stub."""
    try:
        with path.open("rb") as handle:
            head = handle.read(5)
    except OSError:
        return False
    return head == b"%PDF-"


def _extract_real_passages(limit_docs: int, pages_per_doc: int) -> list[Passage]:
    """Passages extracted from the real OIB PDFs. Empty when unavailable."""
    if not OIB_DIR.is_dir():
        return []
    try:
        import pdfplumber
    except ImportError:
        logger.warning("pdfplumber not installed — cannot read the real OIB corpus")
        return []

    passages: list[Passage] = []
    for name in _PREFERRED_DOCS[:limit_docs]:
        path = OIB_DIR / name
        if not path.is_file():
            continue
        if not _is_real_pdf(path):
            logger.warning("%s is a Git-LFS pointer stub, not a PDF — skipping", name)
            continue
        taken = 0
        with pdfplumber.open(path) as pdf:
            for page_index in _PAGE_RANGE:
                if taken >= pages_per_doc or page_index >= len(pdf.pages):
                    break
                raw = pdf.pages[page_index].extract_text() or ""
                candidate = Passage(doc=name, page=page_index + 1, raw=raw[:CHUNK_TARGET_CHARS])
                # Only keep pages that actually carry quotable prose.
                if len(sentences(candidate)) >= 2:
                    passages.append(candidate)
                    taken += 1
    return passages


# --------------------------------------------------------------------------
# Synthetic fallback
# --------------------------------------------------------------------------
# Hand-written German building-regulation prose in the OIB register, laid out
# with the hyphenated line wraps and justified line breaks a PDF extraction
# produces. Used ONLY when the real corpus is missing; the report must then
# state that the corpus is synthetic.

_SYNTHETIC_PAGES = [
    (
        "synthetisch_brandschutz.pdf",
        4,
        "Diese Richtlinie gilt für Gebäude. Für sonstige Bauwerke sind die Bestimmungen der\n"
        "Richtlinie sinngemäß anzuwenden. Werden in dieser Richtlinie Anforderungen an die\n"
        "Feuerwiderstandsklasse in Verbindung mit Anforderungen an Baustoffe der Klasse A2 ge-\n"
        "stellt, gilt dies auch als erfüllt, wenn die für die Tragfähigkeit wesentlichen Bestand-\n"
        "teile der Bauteile der Klasse A2 entsprechen. Brandabschnitte sind durch brandab-\n"
        "schnittsbildende Bauteile gegeneinander abzutrennen, wobei die Anforderungen an\n"
        "Wände von Treppenhäusern davon unberührt bleiben. Für eingeschoßige Gebäude mit\n"
        "höchstens 15 m² Brutto-Grundfläche, die auf eigenem Grund zugänglich sind, werden\n"
        "keine Anforderungen hinsichtlich des Brandschutzes gestellt.\n",
    ),
    (
        "synthetisch_fluchtwege.pdf",
        7,
        "Fluchtwege sind so auszubilden, dass im Brandfall eine rasche und sichere Entfluch-\n"
        "tung des Gebäudes möglich ist. Die Länge des Fluchtweges innerhalb einer Nutzungs-\n"
        "einheit darf 40 m nicht überschreiten, gemessen in der Lauflinie. Notwendige Trep-\n"
        "penhäuser müssen ins Freie oder in einen sicheren Bereich führen. Türen im Verlauf\n"
        "von Fluchtwegen müssen in Fluchtrichtung aufschlagen, sofern sie von mehr als 15\n"
        "Personen benützt werden. Die lichte Breite von Fluchtwegen ist nach der größten zu\n"
        "erwartenden Personenzahl zu bemessen und darf 1,20 m nicht unterschreiten.\n",
    ),
    (
        "synthetisch_waermeschutz.pdf",
        11,
        "Der Wärmeschutz von Gebäuden ist so zu planen und auszuführen, dass bei bestim-\n"
        "mungsgemäßer Nutzung Tauwasserbildung an Bauteiloberflächen vermieden wird. Die\n"
        "wärmeübertragenden Bauteile der Gebäudehülle müssen den in Tabelle 4 angeführten\n"
        "Höchstwerten der Wärmedurchgangskoeffizienten entsprechen. Wärmebrücken sind\n"
        "bei der Planung und Ausführung so weit als möglich zu vermeiden oder in ihrer Wir-\n"
        "kung zu begrenzen. Bei der Errichtung von Gebäuden ist sicherzustellen, dass die\n"
        "Anforderungen an den sommerlichen Überwärmungsschutz eingehalten werden.\n",
    ),
    (
        "synthetisch_barrierefreiheit.pdf",
        6,
        "Bauwerke sind so zu planen und auszuführen, dass sie von Menschen mit Behinderun-\n"
        "gen ohne fremde Hilfe zugänglich und benutzbar sind. Der barrierefreie Zugang zum\n"
        "Gebäude ist stufenlos oder mittels einer Rampe mit höchstens 6 % Neigung herzustel-\n"
        "len. Aufzüge sind in Gebäuden mit mehr als vier oberirdischen Geschoßen vorzuse-\n"
        "hen. Bedienungselemente sind in einer Höhe von 85 cm bis 110 cm über dem Fußbo-\n"
        "den anzuordnen, damit sie auch aus sitzender Position erreicht werden können.\n",
    ),
]


def _synthetic_passages() -> list[Passage]:
    return [Passage(doc=doc, page=page, raw=raw) for doc, page, raw in _SYNTHETIC_PAGES]


@dataclass(frozen=True)
class Corpus:
    """The calibration corpus plus the provenance the report must disclose."""

    passages: list[Passage]
    provenance: str
    """``"real-oib"`` or ``"synthetic"``."""

    @property
    def is_real(self) -> bool:
        return self.provenance == "real-oib"


def load_passages(*, force_synthetic: bool = False, limit_docs: int = 4, pages_per_doc: int = 3) -> Corpus:
    """Load the calibration corpus, preferring the real OIB PDFs."""
    if not force_synthetic:
        real = _extract_real_passages(limit_docs, pages_per_doc)
        if len(real) >= 4:
            return Corpus(passages=real, provenance="real-oib")
        logger.warning("Real OIB corpus unavailable or too small (%d passages) — using synthetic prose", len(real))
    return Corpus(passages=_synthetic_passages(), provenance="synthetic")
