"""Tests for the chunk-text mirror behind the German sparse retrieval channel.

THE CONTRACT UNDER TEST
-----------------------
:class:`~aiq_agent.knowledge.chunk_text_store.ChunkTextStore` mirrors the chunk
text Chroma already holds into the knowledge database so a *lexical* channel can
search it. Three properties make or break it, and each is asserted here rather
than assumed:

1. **It never gates retrieval.** Every method fails open — a bad URL, a dead
   database, a missing table, garbage input — because the vector channel must
   keep answering when the mirror is down. A raised exception here is a
   production outage, so "degrades to empty" is tested as hard as the happy path.
2. **It is tenancy-safe.** ``(collection, chunk_id)`` is the primary key and the
   collection scopes every delete. The same ``file_name`` legitimately exists in
   the base corpus *and* in a project upload; deleting the project's copy must
   not blind the base corpus. That is a tenancy boundary, not a tidiness detail.
3. **German morphology actually works.** The channel exists because Chroma's
   ``$contains`` is a case-sensitive byte-level substring test that misses
   ``Fluchtwegen`` -> ``Fluchtweg`` and ``Geschoss`` -> ``Geschoß``. If those two
   do not retrieve, the whole store is pointless.

WHY THE FIXTURE IS REAL CORPUS TEXT
-----------------------------------
:data:`CORPUS` is 36 VERBATIM passages from ``data/oib/*.pdf`` — the same text
``adapter._extract_text_from_pdf`` yields at ingestion. Synthetic German would
prove nothing here: the two morphology cases are properties of *this* corpus
(Austrian ``Geschoß`` appears 677× against 5 for ``Geschoss``; ``Fluchtweg``
appears in five inflected forms), and the document-frequency ceiling is measured
against the live collection rather than a stopword list, so it can only be
exercised by text with a realistic frequency profile. The passages are pasted in
rather than re-extracted so the suite stays offline, fast and deterministic — it
needs neither ``pdfplumber``, nor ``data/``, nor Chroma.

Measured over these 36 rows: ``anforderung`` and ``punkt`` sit at 27.8% (above
the 20% ceiling, so both are dropped), ``geschoss`` at 13.9% and ``fluchtweg`` at
13.9% (below it, so both are kept), and ``treppenlaufbreit`` at 2.8% — the rare,
discriminating term that must win the ranking.

WHY SQLITE
----------
Production is Postgres, whose ``german`` FTS config does the stemming; the repo
default and CI are SQLite, where the store falls back to a Python-analyzed lexeme
blob searched with ``LIKE``. That fallback is the code path CI and every local
dev box actually execute, so it is the one these tests run — against a real
SQLite file in ``tmp_path``, never a mock database.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy import text

from aiq_agent.knowledge.chunk_text_store import TABLE_NAME
from aiq_agent.knowledge.chunk_text_store import ChunkTextRow
from aiq_agent.knowledge.chunk_text_store import ChunkTextStore

#: Verbatim passages from the real OIB corpus: ``(chunk_id, file_name, page_label, body)``.
#: ``chunk_id`` stands in for the llama-index node id Chroma stores; it encodes the
#: source only so a failing assertion names the passage it is talking about.
CORPUS: list[tuple[str, str, str, str]] = [
    (
        "rl4#2.4.7",
        "oib-rl_4_ausgabe_mai_2023.pdf",
        "6",
        "2.4.7 Bei Treppen im Verlauf von Fluchtwegen, auf die mehr als 240 Personen gleichzeitig angewiesen "
        "sind, sind zusätzliche Handläufe zur Unterteilung der Treppenlaufbreite (Zwischenhandläufe) "
        "erforderlich, wenn diese 2,40 m überschreitet.",
    ),
    (
        "rl4#2.1.3",
        "oib-rl_4_ausgabe_mai_2023.pdf",
        "5",
        "2.1.3 Treppen und Gänge im Verlauf von Fluchtwegen müssen die gleichen Anforderungen dieser "
        "Richtlinie erfüllen, wie die zur Erschließung erforderlichen Treppen und Gänge.",
    ),
    (
        "rl4#2.1.4",
        "oib-rl_4_ausgabe_mai_2023.pdf",
        "5",
        "2.1.4 Treppen im Verlauf von Fluchtwegen, ausgenommen Wohnungstreppen, sind bis zum Ausgangsniveau "
        "durchgehend auszubilden.",
    ),
    (
        "rl4#2.1.1",
        "oib-rl_4_ausgabe_mai_2023.pdf",
        "5",
        "2.1.1 Bei Gebäuden oder Gebäudeteilen, die barrierefrei zu gestalten sind, muss mindestens ein "
        "Eingang, und zwar der Haupteingang oder ein Eingang in dessen unmittelbarer Nähe, stufenlos "
        "erreichbar sein.",
    ),
    (
        "rl4#2.9.1",
        "oib-rl_4_ausgabe_mai_2023.pdf",
        "8",
        "2.9.1 Bei einflügeligen und zweiflügeligen Türen muss die nutzbare Breite der Durchgangslichte des "
        "Gehflügels mindestens 80 cm aufweisen. Dieses Mindestmaß darf durch das Türblatt oder einen "
        "Paniktürverschluss nicht eingeschränkt werden.",
    ),
    (
        "rl4#2.1.2",
        "oib-rl_4_ausgabe_mai_2023.pdf",
        "5",
        "2.1.2 Zur vertikalen Erschließung sind Treppen oder Rampen herzustellen. Für den Zugang zu nicht "
        "ausgebauten Dachräumen sind auch einschiebbare Treppen oder Leitern zulässig.",
    ),
    (
        "rl4#2.8.3",
        "oib-rl_4_ausgabe_mai_2023.pdf",
        "8",
        "2.8.3 Aus einem Raum, der zum Aufenthalt für mehr als 120 Personen bestimmt ist, müssen mindestens "
        "zwei ausreichend weit voneinander entfernte Ausgänge direkt auf einen Fluchtweg führen.",
    ),
    (
        "rl2#3.1.4",
        "oib-rl_2_ausgabe_mai_2023.pdf",
        "5",
        "3.1.4 Ist im Brandfall mit einer mechanischen Beanspruchung von brandabschnittsbildenden Wänden zu "
        "rechnen (z.B. durch im Brandfall umstürzende Lagerungen), muss zusätzlich zu den Anforderungen der "
        "Tabelle 1b auch das „Leistungskriterium M“ erfüllt sein.",
    ),
    (
        "rl2#3.1.10",
        "oib-rl_2_ausgabe_mai_2023.pdf",
        "6",
        "3.1.10 Grenzen Dachöffnungen und Glasdächer an einen höheren Gebäudeteil eines anderen "
        "Brandabschnittes, müssen diese innerhalb eines Abstandes von 4,00 m so beschaffen sein, dass ein "
        "Brandüberschlag wirksam eingeschränkt wird.",
    ),
    (
        "rl2#7.1.3",
        "oib-rl_2_ausgabe_mai_2023.pdf",
        "15",
        "7.1.3 In oberirdischen Geschoßen von Wirtschaftsgebäuden kann a) von der erforderlichen "
        "Feuerwiderstandsdauer tragender Bauteile gemäß Tabelle 1b, sowie b) von der zulässigen Größe eines "
        "Brandabschnittes gemäß Punkt 3.1.1 jeweils nach Lage und Nutzung abgewichen werden.",
    ),
    (
        "rl2#7.2.5",
        "oib-rl_2_ausgabe_mai_2023.pdf",
        "16",
        "7.2.5 Bei oberirdischen Geschoßen darf ein Brandabschnitt eine Netto-Grundfläche von 1.600 m² nicht "
        "überschreiten.",
    ),
    (
        "rl2#2.1",
        "oib-rl_2_ausgabe_mai_2023.pdf",
        "4",
        "2.1 Brandverhalten von Bauprodukten (Baustoffen) Es gelten – wenn im Folgenden nichts anderes "
        "bestimmt ist – die Anforderungen der Tabelle 1a.",
    ),
    (
        "rl2#7.9.5",
        "oib-rl_2_ausgabe_mai_2023.pdf",
        "22",
        "7.9.5 Ein einziger Fluchtweg über ein Treppenhaus bzw. eine Außentreppe gemäß Punkt 5.1.1 b) ist nur "
        "zulässig in Gebäuden mit nicht mehr als 100 Schlafplätzen.",
    ),
    (
        "rl2.2#2.2.4",
        "oib-rl_2.2_ausgabe_mai_2023.pdf",
        "5",
        "2.2.4 Werden Garagen in Gebäude der Gebäudeklasse 1 bzw. in Reihenhäusern der Gebäudeklasse 2 "
        "eingebaut, müssen angrenzende Wände und Decken REI 30 bzw. EI 30 entsprechen.",
    ),
    (
        "rl2.2#2.2.5",
        "oib-rl_2.2_ausgabe_mai_2023.pdf",
        "5",
        "2.2.5 Werden Garagen in Gebäude der Gebäudeklasse 2 bis 5 – ausgenommen Reihenhäuser der "
        "Gebäudeklasse 2 – eingebaut, müssen angrenzende Wände und Decken die Anforderungen an „Trennwände“ "
        "bzw. an „Trenndecken“ gemäß Tabelle 1b der OIB-Richtlinie 2 erfüllen.",
    ),
    (
        "rl2.2#2.1.2",
        "oib-rl_2.2_ausgabe_mai_2023.pdf",
        "4",
        "2.1.2 Überdachte Stellplätze, die an mehr als zwei Seiten durch Wände bzw. sonstige Bauteile "
        "umschlossen sind, fallen nicht unter Punkt 2.2, sondern unter Punkt 2.1.1, wenn sie zumindest an "
        "einer Seite nicht durch eine Wand bzw. sonstige Bauteile (z.B. Tor, Gitter) umschlossen sind.",
    ),
    (
        "rl2.1#3.9.3",
        "oib-rl_2.1_ausgabe_mai_2023.pdf",
        "8",
        "3.9.3 Bei Betriebsbauten mit mehr als einem oberirdischen Geschoß und einer Außenwandhöhe von mehr "
        "als 14 m müssen die Komponenten bzw. das Gesamtsystem von nichttragenden Außenwänden aus A2 "
        "bestehen.",
    ),
    (
        "rl2.1#2.1",
        "oib-rl_2.1_ausgabe_mai_2023.pdf",
        "4",
        "2.1 Hauptbrandabschnitte sind durch Brandwände gemäß Punkt 3.8 zu trennen. Hinsichtlich der "
        "zulässigen Netto-Grundfläche je oberirdisches Geschoß innerhalb von Hauptbrandabschnitten gelten "
        "die Anforderungen gemäß Tabelle 1.",
    ),
    (
        "rl2.1#2.3",
        "oib-rl_2.1_ausgabe_mai_2023.pdf",
        "4",
        "2.3 Bei Betriebsbauten mit nicht mehr als zwei oberirdischen Geschoßen und einer Netto-Grundfläche "
        "von insgesamt nicht mehr als 3.000 m² sind offene Deckendurchbrüche (z.B. Treppen, Schächte, "
        "Arbeitsöffnungen) ohne Feuerschutzabschlüsse zulässig.",
    ),
    (
        "rl2.3#2.2.1",
        "oib-rl_2.3_ausgabe_mai_2023.pdf",
        "4",
        "2.2.1 Tragende und aussteifende Bauteile sowie Läufe und Podeste von Sicherheitstreppenhäusern "
        "müssen R 90 und A2 entsprechen.",
    ),
    (
        "rl2.3#2.1.4",
        "oib-rl_2.3_ausgabe_mai_2023.pdf",
        "4",
        "2.1.4 In Treppenhäusern, Schleusen und offenen Gängen gemäß Punkt 4.2.2 ist eine Verlegung von "
        "brennbaren Leitungen sowie von Leitungen für brennbare Medien ohne brandschutztechnische "
        "Vorkehrungen unzulässig.",
    ),
    (
        "rl2.3#2.1.3",
        "oib-rl_2.3_ausgabe_mai_2023.pdf",
        "4",
        "2.1.3 In Gängen – ausgenommen innerhalb von Wohnungen, Büros und Räumen mit büroähnlicher Nutzung – "
        "müssen freiliegende elektrische Kabel bzw. Leitungen Eca entsprechen.",
    ),
    (
        "rl2.3#2.1.7",
        "oib-rl_2.3_ausgabe_mai_2023.pdf",
        "4",
        "2.1.7 In Treppenhäusern, Schleusen und offenen Gängen gemäß Punkt 4.2.2 müssen Dämmstoffe von "
        "Leitungen A2-s1, d0 entsprechen.",
    ),
    (
        "rl3#2.1",
        "oib-rl_3_ausgabe_mai_2023.pdf",
        "4",
        "2.1 Allgemeine Anforderungen Fußböden und Wände von Sanitärräumen (Toiletten, Bäder und sonstige "
        "Nassräume) müssen entsprechend den hygienischen Erfordernissen leicht zu reinigen sein. Toiletten "
        "müssen in der Regel über eine Wasserspülung verfügen.",
    ),
    (
        "rl3#2.3.2",
        "oib-rl_3_ausgabe_mai_2023.pdf",
        "4",
        "2.3.2 Toilettenräume in Gastronomiebetrieben dürfen nicht direkt von Gasträumen zugänglich sein. "
        "Ausgenommen von der Verpflichtung zur Errichtung von Toiletten sind Gastronomiebetriebe mit nicht "
        "mehr als acht Verabreichungsplätzen.",
    ),
    (
        "rl3#3.1.1",
        "oib-rl_3_ausgabe_mai_2023.pdf",
        "5",
        "3.1.1 Niederschlagswässer, die nicht als Nutzwasser verwendet werden, sind technisch einwandfrei zu "
        "versickern, abzuleiten oder zu entsorgen.",
    ),
    (
        "rl3#2.2",
        "oib-rl_3_ausgabe_mai_2023.pdf",
        "4",
        "2.2 Sanitäreinrichtungen in Wohnungen Jede Wohnung muss im Wohnungsverband über eine Toilette, ein "
        "Waschbecken und eine Dusche oder Badewanne in zumindest einem Sanitärraum verfügen.",
    ),
    (
        "rl5#2.1",
        "oib-rl_5_ausgabe_mai_2023.pdf",
        "4",
        "2.1 Anwendungsbereich Die festgelegten Anforderungen dienen der Sicherstellung eines für normal "
        "empfindende Menschen ausreichenden Schutzes von Aufenthaltsund Nebenräumen vor Schallimmissionen "
        "von außen und aus anderen Nutzungseinheiten desselben Gebäudes sowie aus angrenzenden Gebäuden.",
    ),
    (
        "rl5#2.8.2",
        "oib-rl_5_ausgabe_mai_2023.pdf",
        "8",
        "2.8.2 Der anzuwendende Planungsbasispegel LPB im zu schützenden Aufenthaltsraum darf durch den "
        "Beurteilungspegel Lr nicht überschritten werden. Kennzeichnende Spitzenpegel LA,Sp dürfen den "
        "anzuwendenden Planungsbasispegel LPB um nicht mehr als 10 dB überschreiten.",
    ),
    (
        "rl5#2.8.1",
        "oib-rl_5_ausgabe_mai_2023.pdf",
        "8",
        "2.8.1 Die für die Dimensionierung erforderlichen schalltechnischen Kenngrößen sind nach dem Stand "
        "der Technik zu ermitteln.",
    ),
    (
        "rl5#2.7.3",
        "oib-rl_5_ausgabe_mai_2023.pdf",
        "8",
        "2.7.3 Bezüglich der schalltechnischen Anforderungen an haustechnische Anlagen gelten die "
        "Bestimmungen von Punkt 2.6.",
    ),
    (
        "rl6#4.9",
        "oib-rl_6_ausgabe_mai_2023.pdf",
        "9",
        "4.9 Sommerlicher Wärmeschutz Beim Neubau und bei größerer Renovierung von Wohngebäuden ist Punkt "
        "4.9.1 einzuhalten. Beim Neubau und bei größerer Renovierung von Nicht-Wohngebäuden (NWG) ist Punkt "
        "4.9.2 einzuhalten.",
    ),
    (
        "rl6#4.4.2",
        "oib-rl_6_ausgabe_mai_2023.pdf",
        "8",
        "4.4.2 Bei Gefälledämmung ist der Nachweis entsprechend den Regeln der Technik über den maximal "
        "zulässigen Leitwert, das ist das Produkt aus der Gesamtfläche und höchstzulässigem U-Wert, zu "
        "führen, wobei die Anforderungen nach Punkt 4.8 jedenfalls einzuhalten sind.",
    ),
    (
        "rl6#4.4.3",
        "oib-rl_6_ausgabe_mai_2023.pdf",
        "8",
        "4.4.3 Bei erdberührten Bauteilen darf der Nachweis auch über den maximal zulässigen Leitwert, das "
        "ist das Produkt aus erdberührter Fläche und höchstzulässigem U-Wert und Temperaturkorrekturfaktor, "
        "geführt werden, wobei die Anforderungen nach Punkt 4.8 jedenfalls einzuhalten sind.",
    ),
    (
        "rl1#2.1.1",
        "oib-rl_1_ausgabe_mai_2023.pdf",
        "4",
        "2.1.1 Tragwerke sind so zu planen und herzustellen, dass sie eine ausreichende Tragfähigkeit, "
        "Gebrauchstauglichkeit und Dauerhaftigkeit aufweisen, um die Einwirkungen, denen das Bauwerk "
        "ausgesetzt ist, aufzunehmen und in den Boden abzutragen.",
    ),
    (
        "rl1#2.1.3",
        "oib-rl_1_ausgabe_mai_2023.pdf",
        "4",
        "2.1.3 Bei Änderungen an bestehenden Bauwerken mit Auswirkungen auf bestehende Tragwerke sind für "
        "die bestehenden Tragwerksteile Abweichungen vom aktuellen Stand der Technik zulässig, sofern das "
        "erforderliche Zuverlässigkeitsniveau des rechtmäßigen Bestandes nicht verschlechtert wird.",
    ),
]

BASE_COLLECTION = "oib_knowledge"
BODIES: dict[str, str] = {chunk_id: body for chunk_id, _, _, body in CORPUS}


def _rows() -> list[ChunkTextRow]:
    return [
        ChunkTextRow(chunk_id=chunk_id, body=body, file_name=file_name, page_label=page_label)
        for chunk_id, file_name, page_label, body in CORPUS
    ]


class _RefusingEngine:
    """A hand-written engine whose every connection attempt fails.

    Stands in for a database that is configured and reachable at construction but
    down when a query runs — the outage shape a mock cannot express honestly,
    because the point is that the store swallows a REAL exception from ``connect``
    rather than that it called a method.
    """

    def __init__(self) -> None:
        self.attempts = 0

    def connect(self):
        self.attempts += 1
        raise OSError("knowledge database is unreachable")

    def dispose(self) -> None:
        return None


@pytest.fixture(autouse=True)
def _isolate_engine_cache():
    """Never let a cached engine or an "already created" flag leak between tests."""
    ChunkTextStore.dispose_all_engines()
    yield
    ChunkTextStore.dispose_all_engines()


@pytest.fixture
def db_url(tmp_path):
    return f"sqlite:///{tmp_path / 'chunks.db'}"


@pytest.fixture
def store(db_url):
    return ChunkTextStore(db_url)


@pytest.fixture
def corpus_store(store):
    """A store holding the whole real-corpus fixture in the base collection."""
    store.upsert_many(BASE_COLLECTION, _rows())
    return store


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


def test_the_schema_is_created_on_construction_so_the_first_write_has_a_table(store, db_url):
    engine = create_engine(db_url)
    try:
        with engine.connect() as conn:
            tables = {row[0] for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type = 'table'"))}
    finally:
        engine.dispose()
    assert TABLE_NAME in tables


def test_creating_the_schema_twice_over_the_same_database_is_idempotent(db_url):
    first = ChunkTextStore(db_url)
    assert first.upsert_many(BASE_COLLECTION, _rows()) == len(CORPUS)

    # A second store on the same URL re-runs schema creation from scratch (the
    # process-wide "already initialized" set is cleared), which must neither raise
    # nor drop the rows the first store wrote.
    ChunkTextStore._tables_initialized.clear()
    second = ChunkTextStore(db_url)
    assert second.count(BASE_COLLECTION) == len(CORPUS)


def test_ensure_schema_is_re_entrant_so_every_method_may_call_it_freely(store):
    """Each public method calls ``_ensure_schema`` again; repeating it is free."""
    for _ in range(3):
        store._ensure_schema()
    assert store.upsert_many(BASE_COLLECTION, _rows()) == len(CORPUS)
    assert store.count(BASE_COLLECTION) == len(CORPUS)


def test_a_failed_schema_creation_is_not_remembered_as_successful(tmp_path):
    """A store that could not create its table must retry, not cache the failure."""
    unwritable = f"sqlite:///{tmp_path / 'missing-dir' / 'chunks.db'}"
    store = ChunkTextStore(unwritable)

    assert unwritable not in ChunkTextStore._tables_initialized
    assert store.count(BASE_COLLECTION) == 0


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


def test_upsert_many_writes_every_usable_row_and_reports_the_count(store):
    assert store.upsert_many(BASE_COLLECTION, _rows()) == len(CORPUS)
    assert store.count(BASE_COLLECTION) == len(CORPUS)


def test_re_upserting_the_same_chunk_id_updates_the_row_instead_of_duplicating_it(store):
    store.upsert_many(BASE_COLLECTION, _rows())
    before = store.count(BASE_COLLECTION)

    store.upsert_many(BASE_COLLECTION, _rows())

    assert store.count(BASE_COLLECTION) == before


def test_re_upserting_a_chunk_replaces_its_indexed_text_so_the_mirror_cannot_go_stale(store):
    store.upsert_many(BASE_COLLECTION, [ChunkTextRow(chunk_id="c1", body="Die Treppenlaufbreite beträgt 1,20 m.")])
    assert store.search(BASE_COLLECTION, "Treppenlaufbreite") == ["c1"]

    store.upsert_many(BASE_COLLECTION, [ChunkTextRow(chunk_id="c1", body="Der Trittschallpegel ist begrenzt.")])

    assert store.count(BASE_COLLECTION) == 1
    assert store.search(BASE_COLLECTION, "Treppenlaufbreite") == []
    assert store.search(BASE_COLLECTION, "Trittschallpegel") == ["c1"]


def test_a_chunk_with_no_id_or_no_text_is_skipped_rather_than_failing_its_batch(store):
    written = store.upsert_many(
        BASE_COLLECTION,
        [
            ChunkTextRow(chunk_id="", body="Fluchtwege sind freizuhalten."),
            ChunkTextRow(chunk_id="blank", body="   "),
            ChunkTextRow(chunk_id="good", body="Fluchtwege sind freizuhalten."),
        ],
    )
    assert written == 1
    assert store.count(BASE_COLLECTION) == 1


def test_a_chunk_may_arrive_as_a_plain_mapping_because_chroma_hands_back_dicts(store):
    written = store.upsert_many(
        BASE_COLLECTION,
        [{"chunk_id": "m1", "body": "Die Treppenlaufbreite beträgt 1,20 m.", "file_name": "a.pdf", "page_label": "3"}],
    )
    assert written == 1
    assert store.search(BASE_COLLECTION, "Treppenlaufbreite") == ["m1"]


def test_a_row_whose_fields_are_not_strings_is_coerced_rather_than_crashing_the_batch(store):
    """Chroma metadata routinely carries ``None`` labels and non-string ids."""
    written = store.upsert_many(
        BASE_COLLECTION,
        [
            {"chunk_id": 17, "body": "Die Treppenlaufbreite beträgt 1,20 m.", "page_label": None},
            ChunkTextRow(chunk_id="bad", body=None),
        ],
    )
    assert written == 1
    assert store.search(BASE_COLLECTION, "Treppenlaufbreite") == ["17"]


# ---------------------------------------------------------------------------
# Deletes — tenancy
# ---------------------------------------------------------------------------


def test_delete_by_file_removes_only_that_files_chunks(corpus_store):
    target = "oib-rl_5_ausgabe_mai_2023.pdf"
    expected = sum(1 for _, file_name, _, _ in CORPUS if file_name == target)

    deleted = corpus_store.delete_by_file(BASE_COLLECTION, target)

    assert deleted == expected
    assert corpus_store.count(BASE_COLLECTION) == len(CORPUS) - expected
    assert corpus_store.search(BASE_COLLECTION, "Planungsbasispegel") == []
    assert corpus_store.search(BASE_COLLECTION, "Treppenlaufbreite") == ["rl4#2.4.7"]


def test_delete_by_file_in_one_collection_leaves_the_same_file_in_another_untouched(store):
    """The base corpus and a project upload legitimately share a file name."""
    rows = _rows()
    store.upsert_many(BASE_COLLECTION, rows)
    store.upsert_many("project_alpha", rows)

    store.delete_by_file("project_alpha", "oib-rl_4_ausgabe_mai_2023.pdf")

    survivors = sum(1 for _, file_name, _, _ in CORPUS if file_name == "oib-rl_4_ausgabe_mai_2023.pdf")
    assert store.count("project_alpha") == len(CORPUS) - survivors
    assert store.count(BASE_COLLECTION) == len(CORPUS)
    assert "rl4#2.4.7" in store.search(BASE_COLLECTION, "Treppenlaufbreite")
    assert store.search("project_alpha", "Treppenlaufbreite") == []


def test_delete_collection_removes_that_collection_and_only_that_collection(store):
    rows = _rows()
    store.upsert_many(BASE_COLLECTION, rows)
    store.upsert_many("project_alpha", rows)

    deleted = store.delete_collection("project_alpha")

    assert deleted == len(CORPUS)
    assert store.count("project_alpha") == 0
    assert store.count(BASE_COLLECTION) == len(CORPUS)


def test_deleting_something_absent_reports_zero_rather_than_failing(corpus_store):
    assert corpus_store.delete_by_file(BASE_COLLECTION, "never-ingested.pdf") == 0
    assert corpus_store.delete_collection("no_such_collection") == 0
    assert corpus_store.count(BASE_COLLECTION) == len(CORPUS)


# ---------------------------------------------------------------------------
# Search over real corpus text
# ---------------------------------------------------------------------------


def test_a_real_german_question_retrieves_its_passage_first(corpus_store):
    ids = corpus_store.search(
        BASE_COLLECTION,
        "Welche Treppenlaufbreite ist bei Fluchtwegen für mehr als 240 Personen erforderlich?",
    )
    assert ids, "the lexical channel must fire for a question whose vocabulary is in the corpus"
    assert ids[0] == "rl4#2.4.7"


def test_a_rare_term_outranks_several_common_ones(corpus_store):
    """``Planungsbasispegel`` occurs once; the words around it occur everywhere."""
    ids = corpus_store.search(BASE_COLLECTION, "Welcher Planungsbasispegel gilt im Aufenthaltsraum?")
    assert ids[0] == "rl5#2.8.2"


def test_a_question_about_garages_retrieves_the_garage_richtlinie(corpus_store):
    ids = corpus_store.search(BASE_COLLECTION, "Welche Anforderungen gelten für Garagen in der Gebäudeklasse 2?")
    assert set(ids[:2]) == {"rl2.2#2.2.4", "rl2.2#2.2.5"}


def test_results_are_scoped_to_their_collection(store):
    store.upsert_many(BASE_COLLECTION, _rows())
    store.upsert_many("project_alpha", [ChunkTextRow(chunk_id="p1", body="Die Treppenlaufbreite beträgt 1,20 m.")])

    assert store.search("project_alpha", "Treppenlaufbreite") == ["p1"]
    assert store.search(BASE_COLLECTION, "Treppenlaufbreite") == ["rl4#2.4.7"]


def test_the_limit_caps_how_many_chunk_ids_come_back(corpus_store):
    assert len(corpus_store.search(BASE_COLLECTION, "Fluchtwegen", limit=2)) == 2


def test_search_is_deterministic_so_fusion_downstream_is_reproducible(corpus_store):
    question = "Welche Anforderungen gelten für Treppen im Verlauf von Fluchtwegen?"
    assert corpus_store.search(BASE_COLLECTION, question) == corpus_store.search(BASE_COLLECTION, question)


# ---------------------------------------------------------------------------
# German morphology — the reason this store exists
# ---------------------------------------------------------------------------


def test_an_inflected_query_finds_the_uninflected_corpus_form(corpus_store):
    """``Fluchtwegen`` must reach passages that only ever say ``Fluchtweg``.

    This is the failure that motivated the whole store: Chroma's ``$contains`` is
    a byte-level substring test, so ``Fluchtwegen`` matched none of these.
    """
    ids = corpus_store.search(BASE_COLLECTION, "Fluchtwegen", limit=len(CORPUS))

    bare_form = {chunk_id for chunk_id, body in BODIES.items() if "Fluchtweg " in body or "Fluchtweg." in body}
    assert bare_form, "the fixture must contain the uninflected corpus form"
    assert bare_form <= set(ids)


def test_the_uninflected_query_also_finds_the_inflected_corpus_form(corpus_store):
    """The same analyzer runs over the body and the query, so it works both ways."""
    ids = corpus_store.search(BASE_COLLECTION, "Fluchtweg", limit=len(CORPUS))
    assert "rl4#2.1.4" in ids  # says "Fluchtwegen", never "Fluchtweg"


def test_a_german_keyboard_spelling_finds_the_austrian_orthography(corpus_store):
    """``Geschoss`` must retrieve ``Geschoß`` — 677 vs 5 occurrences in the corpus.

    Austrian legal text spells it with ``ß``; a user on a German keyboard types
    ``ss``. Folding ``ß`` -> ``ss`` on both sides is what makes the two meet, and
    NOTHING in this fixture is spelled ``Geschoss``, so a hit can only come from a
    ``Geschoß`` passage.
    """
    ids = corpus_store.search(BASE_COLLECTION, "Geschoss", limit=len(CORPUS))

    assert ids, "the ss spelling must not be a dead query"
    assert all("Geschoß" in BODIES[chunk_id] for chunk_id in ids)
    assert not any("Geschoss" in BODIES[chunk_id] for chunk_id in ids)


def test_the_austrian_spelling_retrieves_exactly_what_the_german_one_does(corpus_store):
    sharp_s = corpus_store.search(BASE_COLLECTION, "Geschoß", limit=len(CORPUS))
    double_s = corpus_store.search(BASE_COLLECTION, "Geschoss", limit=len(CORPUS))
    assert sharp_s == double_s


# ---------------------------------------------------------------------------
# The document-frequency ceiling
# ---------------------------------------------------------------------------


def test_a_query_of_only_corpus_wide_words_returns_nothing_instead_of_everything(corpus_store):
    """The measured failure the ceiling exists to prevent.

    ``Anforderungen`` and ``Punkt`` each occur in 27.8% of these passages — over
    the 20% ceiling — so both are dropped and nothing survives to search on.
    Returning the corpus here would have RRF fuse a near-no-op into the results,
    which is exactly what the old ``$contains`` channel did with a bare ``OIB``.
    """
    assert corpus_store.search(BASE_COLLECTION, "Anforderungen Punkt", limit=len(CORPUS)) == []


def test_a_corpus_wide_word_does_not_drag_its_chunks_in_beside_a_useful_one(corpus_store):
    """``Anforderungen`` is dropped even when a rare term keeps the query alive.

    The ceiling is applied per LEXEME, not per query: ``treppenlaufbreit``
    survives and ranks first, while ``anforderung`` (27.8%) and ``die`` (47.2%)
    are discarded, so the ten passages that merely say "Anforderungen" do not
    ride along. What comes back is a handful of chunks, not the collection.
    """
    ids = corpus_store.search(BASE_COLLECTION, "Anforderungen an die Treppenlaufbreite", limit=len(CORPUS))

    assert ids[0] == "rl4#2.4.7"
    assert len(ids) < len(CORPUS) // 2

    says_anforderungen = {chunk_id for chunk_id, body in BODIES.items() if "Anforderungen" in body}
    assert len(says_anforderungen & set(ids)) < len(says_anforderungen)


def test_document_frequencies_measure_the_ceiling_against_the_live_collection(corpus_store):
    frequencies = corpus_store.document_frequencies(BASE_COLLECTION, ["anforderung", "treppenlaufbreit", "nirgendwo"])

    assert frequencies.total == len(CORPUS)
    assert frequencies.counts["treppenlaufbreit"] == 1
    assert frequencies.counts["anforderung"] > frequencies.total * 0.2
    assert frequencies.counts["nirgendwo"] == 0


def test_a_word_absent_from_the_corpus_retrieves_nothing(corpus_store):
    assert corpus_store.search(BASE_COLLECTION, "Hubschrauberlandeplatz") == []


# ---------------------------------------------------------------------------
# Fail-open — retrieval is never gated by this store
# ---------------------------------------------------------------------------


def test_an_unparsable_database_url_degrades_to_empty_instead_of_raising():
    store = ChunkTextStore("this is not a database url")

    assert store.search(BASE_COLLECTION, "Fluchtwegen") == []
    assert store.count(BASE_COLLECTION) == 0
    assert store.upsert_many(BASE_COLLECTION, _rows()) == 0
    assert store.delete_by_file(BASE_COLLECTION, "a.pdf") == 0
    assert store.delete_collection(BASE_COLLECTION) == 0
    assert store.document_frequencies(BASE_COLLECTION, ["fluchtweg"]).total == 0


def test_an_unknown_database_dialect_degrades_to_empty_instead_of_raising():
    store = ChunkTextStore("nosuchdialect://user@host/db")

    assert store.search(BASE_COLLECTION, "Fluchtwegen") == []
    assert store.count(BASE_COLLECTION) == 0


def test_a_database_that_is_down_degrades_to_empty_instead_of_raising(corpus_store):
    """A store that worked a moment ago and then lost its database."""
    refusing = _RefusingEngine()
    corpus_store._sync_engine = refusing

    assert corpus_store.search(BASE_COLLECTION, "Fluchtwegen") == []
    assert corpus_store.count(BASE_COLLECTION) == 0
    assert corpus_store.upsert_many(BASE_COLLECTION, _rows()) == 0
    assert corpus_store.delete_by_file(BASE_COLLECTION, "oib-rl_4_ausgabe_mai_2023.pdf") == 0
    assert corpus_store.delete_collection(BASE_COLLECTION) == 0
    assert refusing.attempts > 0, "the store must actually have tried the database"


def test_a_missing_table_degrades_to_empty_instead_of_raising(store, db_url):
    ChunkTextStore._tables_initialized.add(db_url)  # pretend the schema is ready
    engine = create_engine(db_url)
    try:
        with engine.connect() as conn:
            conn.execute(text(f"DROP TABLE {TABLE_NAME}"))
            conn.commit()
    finally:
        engine.dispose()

    assert store.search(BASE_COLLECTION, "Fluchtwegen") == []
    assert store.count(BASE_COLLECTION) == 0
    assert store.upsert_many(BASE_COLLECTION, _rows()) == 0


# ---------------------------------------------------------------------------
# Empty and missing input
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("collection", ["", None])
def test_a_missing_collection_is_a_no_op_everywhere(corpus_store, collection):
    assert corpus_store.search(collection, "Fluchtwegen") == []
    assert corpus_store.count(collection) == 0
    assert corpus_store.upsert_many(collection, _rows()) == 0
    assert corpus_store.delete_by_file(collection, "a.pdf") == 0
    assert corpus_store.delete_collection(collection) == 0
    assert corpus_store.document_frequencies(collection, ["fluchtweg"]).total == 0
    assert corpus_store.count(BASE_COLLECTION) == len(CORPUS)


@pytest.mark.parametrize("query", ["", None, "   ", "?", "§"])
def test_an_empty_or_contentless_query_returns_no_ids(corpus_store, query):
    assert corpus_store.search(BASE_COLLECTION, query) == []


@pytest.mark.parametrize("limit", [0, -1])
def test_a_non_positive_limit_returns_no_ids(corpus_store, limit):
    assert corpus_store.search(BASE_COLLECTION, "Fluchtwegen", limit=limit) == []


@pytest.mark.parametrize("rows", [None, [], (), 42, "Fluchtweg"])
def test_missing_or_unusable_rows_write_nothing_and_do_not_raise(store, rows):
    assert store.upsert_many(BASE_COLLECTION, rows) == 0
    assert store.count(BASE_COLLECTION) == 0


@pytest.mark.parametrize("terms", [None, [], ["", None]])
def test_missing_terms_measure_no_document_frequencies(corpus_store, terms):
    assert corpus_store.document_frequencies(BASE_COLLECTION, terms).total == 0


def test_an_empty_file_name_never_deletes_a_whole_collection(corpus_store):
    """A blank file name must not degenerate into ``DELETE WHERE collection``."""
    assert corpus_store.delete_by_file(BASE_COLLECTION, "") == 0
    assert corpus_store.delete_by_file(BASE_COLLECTION, None) == 0
    assert corpus_store.count(BASE_COLLECTION) == len(CORPUS)


def test_searching_a_collection_that_was_never_mirrored_returns_no_ids(corpus_store):
    assert corpus_store.search("never_ingested", "Fluchtwegen") == []
    assert corpus_store.count("never_ingested") == 0
