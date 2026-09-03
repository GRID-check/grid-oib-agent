"""File-level golden recall for broad/exact/paraphrased OIB queries (backlog item 12).

The measuring instrument items 13/14 must beat. It scores ~30 German golden
questions (``fixtures/oib_golden_overview.json``) in three cohorts — overview,
exact-id, paraphrase — as recall@k (k = production's ``top_k``) plus MRR,
against a deterministic in-memory fixture corpus. No network, no Chroma, no
embedder, no PDF, no key. Everything here runs in CI in seconds.

WHAT IT MEASURES
----------------
Which of the CURRENT retrieval's deterministic channels fire for each query
shape, and whether the expected corpus files are among what fired:

* the exact channel: ``aiq_agent.common.legal_terms.extract_exact_terms`` plus
  a case-sensitive substring match over ``file_name + text`` — the offline
  mirror of Chroma ``where_document {"$contains": term}``, which
  ``german_text``'s docstring documents as case-sensitive;
* the sparse channel: ``oib_retrieval_eval.lexical`` — the shipped
  ``german_text`` analyzer, query terms, DF-ceiling selection and idf ranking
  over the fixture corpus (the SQLite-path semantics, in memory).

Both channels are the production code, imported — never reimplemented — so a
change to the stemmer, the ceiling or term extraction moves these numbers.

WHAT IT DOES NOT MEASURE (read before citing a number)
------------------------------------------------------
* The vector channel is NOT simulated. The ranking per query is exact matches
  (corpus order) followed by sparse matches (index order), deduplicated — and
  nothing else. There is deliberately no fill-to-top-k with generic neighbours:
  production fills ``top_k`` (floor off by design), but filling appends BELOW
  the signal ranking, so recall over the signal ranking is the lower bound a
  fix must lift. A query with no channel firing scores recall 0.0 here; in
  production the same query gets sixteen generic neighbours and a hedge.
* Order beyond channel membership is modelling, not production: production
  fuses via reciprocal rank fusion, this harness concatenates exact-first.
  Recall is order-invariant while the union fits in k (it always does here);
  MRR is reported under the exact-first rule, which is optimistic for the
  exact channel — the channel items 13/14 strengthen.
* The fixture texts are synthetic German carrying each document's real
  designation and discriminative vocabulary (see ``FIXTURE_TEXTS``). They are
  NOT the corpus: absolute values are about channel activation, and the
  before/after deltas are what this set is for.

EXPECTED BASELINE (recorded 2026-09-03; overview re-recorded after item 13)
---------------------------------------------------------------------
Overview "oib N" queries fire the exact channel since item 13 (casefold
identifier: "oib 2" -> "OIB"); their sparse survivors still die at the DF
ceiling / digit-only rule, and the bare "oib-richtlinien" question with no
number fires neither channel. Exact-id and paraphrase queries fire one or both
channels and score high — except literal filenames, which neither deterministic
channel can serve (lowercase, corpus-identity lexemes plus digits) and which
honestly score ~0 until a filename-aware lookup exists. See
``tests/benchmarks/test_oib_overview_recall.py`` for the pinned numbers.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path

# ---------------------------------------------------------------------------
# Cohort vocabulary. Tags are metadata only: the ranking code below never
# branches on them; they solely group the aggregates.
# ---------------------------------------------------------------------------

COHORT_OVERVIEW = "overview"
COHORT_EXACT_ID = "exact-id"
COHORT_PARAPHRASE = "paraphrase"
COHORTS = (COHORT_OVERVIEW, COHORT_EXACT_ID, COHORT_PARAPHRASE)

#: Retrieval depth per channel. Above the fixture size (39) so a channel never
#: truncates before the filter runs — the same reason the main harness uses 120.
RETRIEVE_DEPTH = 120

_FIXTURE_BOILERPLATE = (
    "Österreichisches Institut für Bautechnik. Ausgabe Mai 2023. "
    "Diese Richtlinie gilt für Gebäude. Die Anforderungen müssen eingehalten werden. "
    # DF ballast: real corpus pages are full of German function words, so the DF
    # ceiling prices them as noise. Terse synthetic texts without them would give
    # words like "über"/"den"/"aus" a low document frequency and let them fire
    # the sparse channel — measuring fixture noise instead of retrieval. This
    # sentence puts the closed-class vocabulary in every document, exactly where
    # production's ceiling expects it. Content nouns are deliberately absent.
    "Was hier steht, gilt für alle: wer baut, muss prüfen, kann fragen und darf vorschlagen, "
    "wie es werden soll. Der die das den dem einen einer eines und oder aber denn doch aus bei "
    "bis ins zum zur vom mit von nach über unter zwischen sein sind ein eine nicht kein sehr nur "
    "auch schon noch als zu im am beim."
)

# ---------------------------------------------------------------------------
# Synthetic fixture corpus: one text per real data/oib file (39).
#
# Construction rules (tune here, never in the channel code):
# - every text carries its document's REAL designation string(s), because the
#   exact channel matches on them;
# - every text carries the SHARED boilerplate above, so corpus-identity words
#   (OIB, Richtlinie, Ausgabe, Gebäude, Anforderungen) are as frequent here as
#   in production and the DF ceiling treats them as the noise they are;
# - discriminative domain nouns appear in a handful of documents each (below
#   the 25%-of-39 DF ceiling), mirroring a domain corpus where core nouns are
#   common but not ubiquitous;
# - change logs (aenderungen_*) read like requirements but stay excludable:
#   they are indexed (as in production) and filtered per query (as in
#   production), so they shape DF but can never score.
# ---------------------------------------------------------------------------

FIXTURE_TEXTS: dict[str, str] = {
    # -- RL 1: Standsicherheit -------------------------------------------
    "oib-rl_1_ausgabe_mai_2023.pdf": (
        "OIB-Richtlinie 1 Standsicherheit. " + _FIXTURE_BOILERPLATE + " Das Tragwerk muss alle Lasten "
        "sicher abtragen. Die Tragfähigkeit ist für ständige und veränderliche Einwirkungen "
        "nachzuweisen. Unzulässige Verformung und Setzung sind zu vermeiden. Punkt 2 Standsicherheit."
    ),
    "oib-rl_1_leitfaden_ausgabe_mai_2023.pdf": (
        "Leitfaden zur OIB-Richtlinie 1. " + _FIXTURE_BOILERPLATE + " Anwendungshinweise zum Nachweis "
        "von Tragwerk und Standsicherheit bei üblichen Hochbauten."
    ),
    "erlaeuterungen_oib-rl_1_ausgabe_mai_2023.pdf": (
        "Erläuterungen zur OIB-Richtlinie 1. " + _FIXTURE_BOILERPLATE + " Begründung der Anforderungen "
        "an Standsicherheit und Dauerhaftigkeit des Tragwerks."
    ),
    # -- RL 2 family: Brandschutz (short + full designation spellings) ---
    "oib-rl_2_ausgabe_mai_2023.pdf": (
        "OIB-RL 2 (OIB-Richtlinie 2) Brandschutz. " + _FIXTURE_BOILERPLATE + " Gebäude werden nach "
        "Fluchtniveau in Gebäudeklassen eingeteilt. Brandabschnitte begrenzen die Brandausbreitung. "
        "Fluchtwege führen über Treppenhäuser ins Freie. Punkt 3 Gebäudeklassen. Punkt 5.1.1 "
        "Gehweglänge höchstens 40 m bis zum Ausgang. Punkt 5.1.2 Messung ab der Wohnungseingangstüre. "
        "Punkt 5.1.4 zweiter Fluchtweg aus der Wohnung. Das Wohnhaus braucht sichere Fluchtwege."
    ),
    "oib-rl_2_leitfaden_ausgabe_mai_2023.pdf": (
        "Leitfaden zur OIB-RL 2 (OIB-Richtlinie 2). " + _FIXTURE_BOILERPLATE + " Anwendung des Brandschutzes "
        "im Wohnhaus: Gebäudeklasse bestimmen, Gehweglänge messen, Fluchtwege freihalten."
    ),
    "oib-rl_2.1_ausgabe_mai_2023.pdf": (
        "OIB-RL 2.1 (OIB-Richtlinie 2.1) Brandschutz beim Wohnhaus. " + _FIXTURE_BOILERPLATE + " Ergänzende "
        "Anforderungen für Wohngebäude der Gebäudeklassen 1 bis 3. Jede Wohnung braucht einen sicheren "
        "Fluchtweg; ab einer gewissen Größe ist ein zweiter Fluchtweg nötig. Das Haus muss im Brandfall "
        "rasch verlassen werden können."
    ),
    "oib-rl_2.2_ausgabe_mai_2023.pdf": (
        "OIB-RL 2.2 (OIB-Richtlinie 2.2) Brandschutz. " + _FIXTURE_BOILERPLATE + " Ergänzende Anforderungen "
        "für Garagen und Stellplätze. Brandabschnitte in Garagen, Rauchableitung, tragbare Feuerlöscher."
    ),
    "oib-rl_2.3_ausgabe_mai_2023.pdf": (
        "OIB-RL 2.3 (OIB-Richtlinie 2.3) Brandschutz. " + _FIXTURE_BOILERPLATE + " Ergänzende Anforderungen "
        "für Versammlungsstätten. Fluchtwege für Publikum, Bestuhlung, Sicherheitsbeleuchtung."
    ),
    "erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf": (
        "Erläuterungen zur OIB-Richtlinie 2. " + _FIXTURE_BOILERPLATE + " Warum Gebäudeklassen, "
        "Brandabschnitte und die Gehweglänge von 40 m so festgelegt sind."
    ),
    "erlaeuterungen_oib-rl_2.1_ausgabe_mai_2023.pdf": (
        "Erläuterungen zur OIB-Richtlinie 2.1. " + _FIXTURE_BOILERPLATE + " Hintergründe zu den Wohnhaus-Regelungen."
    ),
    "erlaeuterungen_oib-rl_2.2_ausgabe_mai_2023.pdf": (
        "Erläuterungen zur OIB-Richtlinie 2.2. " + _FIXTURE_BOILERPLATE + " Hintergründe zu den Garagen-Regelungen."
    ),
    "erlaeuterungen_oib-rl_2.3_ausgabe_mai_2023.pdf": (
        "Erläuterungen zur OIB-Richtlinie 2.3. " + _FIXTURE_BOILERPLATE + " Hintergründe zu den "
        "Versammlungsstätten-Regelungen."
    ),
    # -- RL 3: Hygiene ----------------------------------------------------
    "oib-rl_3_ausgabe_mai_2023.pdf": (
        "OIB-Richtlinie 3 Hygiene, Gesundheit und Umweltschutz. " + _FIXTURE_BOILERPLATE + " Trinkwasser muss "
        "in ausreichender Menge zur Verfügung stehen. Aufenthaltsräume brauchen Belichtung und Lüftung. "
        "Feuchtigkeit ist zu vermeiden. Punkt 3 Trinkwasser und Abwasser."
    ),
    "erlaeuterungen_oib-rl_3_ausgabe_mai_2023.pdf": (
        "Erläuterungen zur OIB-Richtlinie 3. " + _FIXTURE_BOILERPLATE + " Warum Trinkwasser, Hygiene und "
        "Belichtung so geregelt sind."
    ),
    # -- RL 4: Nutzungssicherheit / Barrierefreiheit ----------------------
    "oib-rl_4_ausgabe_mai_2023.pdf": (
        "OIB-Richtlinie 4 Nutzungssicherheit und Barrierefreiheit. " + _FIXTURE_BOILERPLATE + " Die nutzbare "
        "Breite von Fluchtwegen muss mindestens 1,20 m betragen. Treppen brauchen Geländer. Barrierefreie "
        "Türen müssen ausreichend breit sein; Rampen ersetzen Stufen. Punkt 2.4.1 Fluchtwegbreite."
    ),
    "erlaeuterungen_oib-rl_4_ausgabe_mai_2023.pdf": (
        "Erläuterungen zur OIB-Richtlinie 4. " + _FIXTURE_BOILERPLATE + " Hintergründe zu Nutzungssicherheit, "
        "Breite der Fluchtwege und barrierefreien Türen."
    ),
    # -- RL 5: Schallschutz -----------------------------------------------
    "oib-rl_5_ausgabe_mai_2023.pdf": (
        "OIB-Richtlinie 5 Schallschutz. " + _FIXTURE_BOILERPLATE + " Wohnungstrennwände müssen ausreichende "
        "Schalldämmung gegen Luftschall bieten. Der Trittschall aus der Nachbarwohnung ist zu begrenzen. "
        "Das Wohnhaus braucht ruhige Wohnungen. Punkt 2 Schallschutz im Wohngebäude."
    ),
    "erlaeuterungen_oib-rl_5_ausgabe_mai_2023.pdf": (
        "Erläuterungen zur OIB-Richtlinie 5. " + _FIXTURE_BOILERPLATE + " Messung von Schallschutz und "
        "Trittschall zwischen Wohnungen."
    ),
    # -- RL 6 family: Energieeinsparung / Wärmeschutz ---------------------
    "oib-rl_6_ausgabe_mai_2023.pdf": (
        "OIB-Richtlinie 6 Energieeinsparung und Wärmeschutz. " + _FIXTURE_BOILERPLATE + " Beim Neubau dürfen "
        "die Wärmedurchgangskoeffizienten nicht überschritten werden. Jeder Wert der Gebäudehülle zählt: "
        "Wände, Fenster, Dach. Der Heizwärmebedarf ist zu begrenzen. Sommerlicher Wärmeschutz ist "
        "einzuhalten. Punkt 3 Wärmeschutz im Neubau."
    ),
    "oib-rl_6-leitfaden_ausgabe_mai_2023.pdf": (
        "Leitfaden zur OIB-Richtlinie 6. " + _FIXTURE_BOILERPLATE + " Rechenbeispiele für Wärmeschutz, "
        "Werte der Bauteile und Heizwärmebedarf im Neubau."
    ),
    "erlaeuterungen_oib-rl_6_ausgabe_mai_2023.pdf": (
        "Erläuterungen zur OIB-Richtlinie 6. " + _FIXTURE_BOILERPLATE + " Warum jeder Wert so festgelegt ist."
    ),
    # -- Begriffsbestimmungen ---------------------------------------------
    "oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf": (
        "OIB-Begriffsbestimmungen. " + _FIXTURE_BOILERPLATE + " Gebäudeklasse nach Fluchtniveau. "
        "Fluchtniveau ist der Höhenunterschied zum Gelände. Gebäudehöhe, Bruttogeschossfläche, Bauweise."
    ),
    # -- Zitierte Normen (rev.1 is the retrievable one) -------------------
    "oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023_rev.1.pdf": (
        "Zitierte Normen und sonstige technische Regelwerke, revidiert. " + _FIXTURE_BOILERPLATE + " Liste "
        "der ÖNORMEN und Richtlinien, auf die verwiesen wird. Jede Norm ist mit Ausgabedatum genannt."
    ),
    "oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023.pdf": (
        "Zitierte Normen und sonstige technische Regelwerke, ersetzte Ausgabe. " + _FIXTURE_BOILERPLATE + " "
        "Durch rev.1 ersetzt; wird in der Abfrage herausgefiltert."
    ),
    # -- Change logs: indexed, never citable -------------------------------
    "aenderungen_oib-rl_1_ausgabe_mai_2023.pdf": (
        "Änderungen OIB-Richtlinie 1 gegenüber Ausgabe 2019. Punkt 2 redaktionell angepasst, Tabelle neu."
    ),
    "aenderungen_oib-rl_1_leitfaden_ausgabe_mai_2023.pdf": (
        "Änderungen Leitfaden OIB-Richtlinie 1 gegenüber Ausgabe 2019. Beispiele aktualisiert."
    ),
    "aenderungen_oib-rl_2_ausgabe_mai_2023.pdf": (
        "Änderungen OIB-Richtlinie 2 gegenüber Ausgabe 2019. Brandschutz redaktionell angepasst, "
        "Gehweglänge klargestellt, Punkt 5.1.1 neu gefasst."
    ),
    "aenderungen_oib-rl_2_leitfaden_ausgabe_mai_2023.pdf": (
        "Änderungen Leitfaden OIB-Richtlinie 2 gegenüber Ausgabe 2019."
    ),
    "aenderungen_oib-rl_2.1_ausgabe_mai_2023.pdf": ("Änderungen OIB-Richtlinie 2.1 gegenüber Ausgabe 2019."),
    "aenderungen_oib-rl_2.2_ausgabe_mai_2023.pdf": ("Änderungen OIB-Richtlinie 2.2 gegenüber Ausgabe 2019."),
    "aenderungen_oib-rl_2.3_ausgabe_mai_2023.pdf": ("Änderungen OIB-Richtlinie 2.3 gegenüber Ausgabe 2019."),
    "aenderungen_oib-rl_3_ausgabe_mai_2023.pdf": (
        "Änderungen OIB-Richtlinie 3 gegenüber Ausgabe 2019. Hygiene redaktionell angepasst."
    ),
    "aenderungen_oib-rl_4_ausgabe_mai_2023.pdf": ("Änderungen OIB-Richtlinie 4 gegenüber Ausgabe 2019."),
    "aenderungen_oib-rl_5_ausgabe_mai_2023.pdf": ("Änderungen OIB-Richtlinie 5 gegenüber Ausgabe 2019."),
    "aenderungen_oib-rl_6_ausgabe_mai_2023.pdf": ("Änderungen OIB-Richtlinie 6 gegenüber Ausgabe 2019."),
    "aenderungen_oib-rl_6-leitfaden_ausgabe_mai_2023.pdf": (
        "Änderungen Leitfaden OIB-Richtlinie 6 gegenüber Ausgabe 2019."
    ),
    "aenderungen_oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf": (
        "Änderungen Begriffsbestimmungen gegenüber Ausgabe 2019."
    ),
    "aenderungen_oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023.pdf": (
        "Änderungen zitierte Normen gegenüber Ausgabe 2019."
    ),
    "aenderungen_oib-rl_zitierte_normen_und_sonstige_technische_regelwerke_ausgabe_mai_2023_rev.1.pdf": (
        "Änderungen zitierte Normen revidiert gegenüber Ausgabe 2019."
    ),
}

assert len(FIXTURE_TEXTS) == 39, f"fixture must cover all 39 data/oib files, has {len(FIXTURE_TEXTS)}"


@dataclass(frozen=True)
class FixtureDoc:
    """One fixture document: a real corpus filename plus synthetic German text."""

    file_name: str
    text: str


@dataclass(frozen=True)
class GoldenEntry:
    """One golden question: file-level expected answer plus cohort metadata."""

    id: str
    cohort: str
    question: str
    expected: tuple[str, ...]
    notes: str
    calibration_pending: bool


@dataclass(frozen=True)
class QueryResult:
    """Everything measured for one golden question."""

    entry: GoldenEntry
    exact_terms: tuple[str, ...]
    sparse_terms: tuple[str, ...]
    ranked: tuple[str, ...]
    recall: float
    mrr: float
    missing: tuple[str, ...]


@dataclass
class CohortScores:
    """Aggregate over one cohort (or the whole set)."""

    label: str
    n: int
    recall: float
    mrr: float
    empty_share: float


@dataclass
class Report:
    """The full harness output: per-query rows plus cohort aggregates."""

    k: int
    results: list[QueryResult] = field(default_factory=list)
    cohorts: list[CohortScores] = field(default_factory=list)


def package_root() -> Path:
    """The ``oib_retrieval`` benchmark package directory."""
    return Path(__file__).resolve().parents[2]


def default_golden_path() -> Path:
    return package_root() / "fixtures" / "oib_golden_overview.json"


def _k() -> int:
    """The cutoff the headline recall is quoted at: production's top_k, read —
    never copied — from the production OIB config (fallback 16)."""
    try:
        from oib_retrieval_eval.corpus import production_retrieval_settings

        return int(production_retrieval_settings().top_k)
    except Exception:  # pragma: no cover - config absence must not break the harness
        return 16


def fixture_docs() -> list[FixtureDoc]:
    """All 39 fixture documents in stable (sorted filename) order."""
    return [FixtureDoc(file_name=name, text=FIXTURE_TEXTS[name]) for name in sorted(FIXTURE_TEXTS)]


def production_excluded() -> frozenset[str]:
    """Production's query-time exclusion list, read — never copied."""
    try:
        from oib_retrieval_eval.corpus import production_excluded_file_names

        return production_excluded_file_names()
    except Exception:  # pragma: no cover - config absence must not break the harness
        return frozenset()


def load_golden(path: str | Path, *, known_files: frozenset[str] | None = None) -> list[GoldenEntry]:
    """Load and strictly validate the overview golden set.

    Strict like the Punkt golden loader: a duplicate id, an unknown cohort, an
    empty question, an expected file outside the fixture corpus, or an expected
    file production filters out at query time raises — an instrument that drops
    what it cannot resolve reports a better number the more broken it is.
    """
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)

    raw_entries = payload["entries"]
    entries: list[GoldenEntry] = []
    seen: set[str] = set()
    for raw in raw_entries:
        entry_id = raw["id"]
        if entry_id in seen:
            raise ValueError(f"duplicate golden entry id: {entry_id!r}")
        seen.add(entry_id)
        cohort = raw["cohort"]
        if cohort not in COHORTS:
            raise ValueError(f"{entry_id!r}: unknown cohort {cohort!r}; expected one of {COHORTS}")
        question = raw["question"]
        if not question or not question.strip():
            raise ValueError(f"{entry_id!r}: empty question")
        expected = tuple(raw["expected_files"])
        if not expected:
            raise ValueError(f"{entry_id!r}: no expected files")
        if len(set(expected)) != len(expected):
            raise ValueError(f"{entry_id!r}: duplicate expected files")
        for name in expected:
            if not name.endswith(".pdf"):
                raise ValueError(f"{entry_id!r}: expected file {name!r} is not a PDF name")
        entries.append(
            GoldenEntry(
                id=entry_id,
                cohort=cohort,
                question=question,
                expected=expected,
                notes=raw.get("notes", ""),
                calibration_pending=bool(raw.get("calibration_pending", True)),
            )
        )

    if known_files is not None:
        for entry in entries:
            for name in entry.expected:
                if name not in known_files:
                    raise ValueError(f"{entry.id!r}: expected file {name!r} is not in the fixture corpus")

    excluded = production_excluded()
    for entry in entries:
        for name in entry.expected:
            if name in excluded:
                raise ValueError(
                    f"{entry.id!r}: expected file {name!r} is on production's exclude_file_names "
                    "list and can never be retrieved — the label is unanswerable by design"
                )

    by_cohort: dict[str, int] = {cohort: 0 for cohort in COHORTS}
    for entry in entries:
        by_cohort[entry.cohort] += 1
    if not (25 <= len(entries) <= 40):
        raise ValueError(f"golden set has {len(entries)} entries; expected 25-40 (~30)")
    for cohort in COHORTS:
        if by_cohort[cohort] < 8:
            raise ValueError(f"cohort {cohort!r} has only {by_cohort[cohort]} entries; expected >= 8")

    return entries


def build_index(docs: list[FixtureDoc]):
    """In-memory sparse index over the fixture corpus (shipped analyzer)."""
    from oib_retrieval_eval.corpus import Chunk
    from oib_retrieval_eval.lexical import build_index

    chunks = [
        Chunk(chunk_id=f"fixture:{doc.file_name}", text=doc.text, file_name=doc.file_name, page=1, arm="fixture")
        for doc in docs
    ]
    return build_index(chunks)


def exact_terms_for(query: str) -> list[str]:
    """Production exact-term extraction, unchanged."""
    from aiq_agent.common.legal_terms import extract_exact_terms

    return extract_exact_terms(query)


def sparse_terms_for(index, query: str) -> list[str]:
    """The lexemes production's selector would actually search on."""
    from oib_retrieval_eval.lexical import selected_terms

    return selected_terms(index, query)


def rank_files(query: str, docs: list[FixtureDoc], index, *, depth: int = RETRIEVE_DEPTH) -> list[str]:
    """Ranked file names for one query: exact matches, then sparse matches.

    Exact matching is a case-sensitive substring test over
    ``file_name + text`` — the offline mirror of Chroma ``$contains`` (which
    carries the production filename in the embedded text, hence the file_name
    half). No fill: a query with no firing channel ranks nothing, and recall
    over that empty ranking is 0.0 — the honest lower bound (production would
    fill top_k with generic neighbours and hedge; see the module docstring).
    """
    from oib_retrieval_eval.lexical import search

    terms = exact_terms_for(query)
    exact: list[str] = []
    if terms:
        for doc in docs:
            haystack = f"{doc.file_name}\n{doc.text}"
            if any(term in haystack for term in terms):
                exact.append(doc.file_name)

    sparse: list[str] = []
    for chunk in search(index, query, depth):
        if chunk.file_name not in exact and chunk.file_name not in sparse:
            sparse.append(chunk.file_name)
    return exact + sparse


def apply_production_filter(ranked: list[str]) -> list[str]:
    """Drop files production's ``exclude_file_names`` removes at query time."""
    excluded = production_excluded()
    return [name for name in ranked if name not in excluded]


def run(
    entries: list[GoldenEntry] | None = None,
    docs: list[FixtureDoc] | None = None,
    *,
    k: int | None = None,
) -> Report:
    """Retrieve every golden question through the deterministic channels."""
    from oib_retrieval_eval.metrics import mean
    from oib_retrieval_eval.metrics import mrr
    from oib_retrieval_eval.metrics import recall_at_k

    cutoff = k if k is not None else _k()
    docs = fixture_docs() if docs is None else docs
    if entries is None:
        entries = load_golden(default_golden_path(), known_files=frozenset(FIXTURE_TEXTS))
    index = build_index(docs)

    results: list[QueryResult] = []
    for entry in entries:
        exact = tuple(exact_terms_for(entry.question))
        sparse = tuple(sparse_terms_for(index, entry.question))
        ranked = tuple(apply_production_filter(rank_files(entry.question, docs, index)))
        expected = set(entry.expected)
        results.append(
            QueryResult(
                entry=entry,
                exact_terms=exact,
                sparse_terms=sparse,
                ranked=ranked,
                recall=recall_at_k(list(ranked), expected, cutoff),
                mrr=mrr(list(ranked), expected),
                missing=tuple(f for f in entry.expected if f not in list(ranked)[:cutoff]),
            )
        )

    cohorts: list[CohortScores] = []
    for label, subset in [("all", results)] + [
        (cohort, [r for r in results if r.entry.cohort == cohort]) for cohort in COHORTS
    ]:
        cohorts.append(
            CohortScores(
                label=label,
                n=len(subset),
                recall=mean([r.recall for r in subset]),
                mrr=mean([r.mrr for r in subset]),
                empty_share=(sum(1 for r in subset if not r.ranked) / len(subset)) if subset else 0.0,
            )
        )
    return Report(k=cutoff, results=results, cohorts=cohorts)


def format_report(report: Report) -> str:
    """Human-readable harness output: cohort table plus per-query diff."""
    lines = [
        "OIB OVERVIEW GOLDEN RECALL",
        f"cutoff k={report.k} (production top_k); fixture: {len(FIXTURE_TEXTS)} files; "
        f"excluded per query: {len(production_excluded())}",
        "",
        f"{'cohort':<12}{'n':>4}{'recall@k':>10}{'mrr':>8}{'empty':>8}",
    ]
    for scores in report.cohorts:
        lines.append(
            f"{scores.label:<12}{scores.n:>4}{scores.recall:>10.3f}{scores.mrr:>8.3f}{scores.empty_share:>8.2f}"
        )
    lines += [
        "",
        "empty = share of queries with no firing channel (ranked nothing).",
        "",
        "per-query (expected vs got; missing = expected files outside the ranking):",
    ]
    for result in report.results:
        first_hit = next(
            (rank + 1 for rank, name in enumerate(result.ranked) if name in set(result.entry.expected)),
            None,
        )
        lines.append(
            f"[{result.entry.cohort:<10}] {result.entry.id}: "
            f"recall@{report.k}={result.recall:.2f} mrr={result.mrr:.3f} "
            f"first_hit={first_hit if first_hit is not None else '-'} "
            f"exact={list(result.exact_terms)!r} sparse={list(result.sparse_terms)!r}"
        )
        lines.append(f"  expected: {list(result.entry.expected)}")
        lines.append(f"  got     : {list(result.ranked[:8])}{' …' if len(result.ranked) > 8 else ''}")
        if result.missing:
            lines.append(f"  missing : {list(result.missing)}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """Print the harness report (human entry point; gating lives in pytest)."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--golden", default=str(default_golden_path()))
    parser.add_argument("--k", type=int, default=None, help="Cutoff (default: production top_k).")
    args = parser.parse_args(argv)

    started = time.perf_counter()
    entries = load_golden(args.golden, known_files=frozenset(FIXTURE_TEXTS))
    report = run(entries, k=args.k)
    elapsed = time.perf_counter() - started
    print(format_report(report))
    print(f"\n({len(entries)} queries in {elapsed:.1f}s, deterministic, offline.)")
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry
    raise SystemExit(main())
