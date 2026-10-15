"""A dozen synthetic chunks and labels: the harness's own test corpus.

Small enough that both stores index it in well under a second, and written to
carry every hard-case shape the real fixture names (``§``, dotted Punkt numbers,
ALLCAPS codes, a closed compound, ß and umlaut spellings), so a test can assert
what each channel and the exact mode do with them without the licensed corpus.
The vectors are the ``hashed`` stand-in: wiring, never retrieval quality.
"""

from __future__ import annotations

import numpy as np

from oib_retrieval_eval import overview
from oib_retrieval_eval import qrels
from oib_retrieval_eval.qdrant_parity import evaluation
from oib_retrieval_eval.qdrant_parity.runner import Inputs
from oib_retrieval_eval.qdrant_parity.runner import embed_inputs
from oib_retrieval_eval.qdrant_parity.stores import IndexedChunk
from oib_retrieval_eval.qdrant_parity.vectors import Embedder

RL2 = "oib-rl_2_ausgabe_mai_2023.pdf"
RL4 = "oib-rl_4_ausgabe_mai_2023.pdf"
CHANGES = "aenderungen_oib-rl_2_ausgabe_mai_2023.pdf"

#: (file, page, punkt, text). Two pages repeat on purpose: units dedupe them.
TEXTS = (
    (RL2, 13, "5.1.1", "5.1.1 Von jeder Stelle eines Raumes darf die Gehweglänge höchstens 40 m betragen."),
    (RL2, 13, "5.1.2", "5.1.2 Bei Wohnungen ist die Gehweglänge ab der Wohnungseingangstür zu messen."),
    (RL2, 7, "3.1", "3.1 Tragende Bauteile sind in REI 90 auszuführen, in Gebäudeklasse 5 jedenfalls."),
    (RL2, 8, "3.2", "3.2 Für Gebäudeklasse 4 genügt REI 60. Türen in EI2 30-C."),
    (RL2, 9, "3.3", "3.3 Die Brandabschnittsfläche darf 1.200 m² nicht überschreiten; Hauptbrandabschnitte trennen."),
    (RL2, 10, "3.4", "3.4 Jedes Geschoß mit Fußboden über 22 m braucht eine Rauchabzugseinrichtung (RWA)."),
    (RL2, 11, "3.5", "3.5 Außenwände aus A2-s1,d0 an der Straße; die Außenwand ist nicht brennbar auszuführen."),
    (RL2, 2, "0", "Im Sinne des § 3 Abs. 1 der Statuten koordiniert; § 8 bleibt unberührt."),
    (RL4, 5, "2.1", "2.1 Treppenhäuser und Stiegenhäuser sind als Fluchtwege auszubilden."),
    (RL4, 6, "2.2", "2.2 Nachweisverfahren nach TRVB; das Verfahren ist zu dokumentieren."),
    (RL4, 6, "2.3", "2.3 Brandschutz für BROOF(t1) Dächer und den Heizwärmebedarf HWB."),
    (CHANGES, 3, "5.1.1", "5.1.1 geändert: Gehweglänge höchstens 40 m (Änderung gegenüber 2019)."),
)


def chunks() -> list[IndexedChunk]:
    out = []
    for index, (file_name, page, punkt, text) in enumerate(TEXTS):
        out.append(
            IndexedChunk(
                chunk_id=f"00000000-0000-4000-8000-{index:012d}",
                text=text,
                file_name=file_name,
                page=page,
                metadata={
                    "file_name": file_name,
                    "page_label": str(page),
                    "content_type": "text",
                    "chunking": "punkt",
                    "punkt_id": punkt,
                    "richtlinie": "2" if file_name == RL2 else "4",
                },
            )
        )
    return out


def _golden(entry_id: str, language: str, question: str, units: dict[tuple[str, int], int]) -> qrels.Judgements:
    entry = qrels.GoldenEntry(
        id=entry_id,
        need_id=entry_id.split("-", 1)[1],
        language=language,
        question=question,
        question_class="test",
        relevant=(qrels.PunktLabel("2", "5.1.1", 3),),
        provenance="sample",
        label_method="sample",
        notes="",
        calibration_pending=True,
    )
    return qrels.Judgements(entry=entry, graded={qrels.Unit(*unit): grade for unit, grade in units.items()})


def judgements() -> list[qrels.Judgements]:
    return [
        _golden("de-gehweg", "de", "Wie lang darf die Gehweglänge höchstens sein?", {(RL2, 13): 3}),
        _golden("en-gehweg", "en", "What is the maximum travel distance?", {(RL2, 13): 3}),
        _golden("de-rauch", "de", "Wann braucht ein Geschoß eine Rauchabzugseinrichtung?", {(RL2, 10): 3}),
        _golden("de-refuse", "de", "Wie hoch ist die Grunderwerbsteuer?", {}),
    ]


def overview_entries() -> list[overview.GoldenEntry]:
    return [
        overview.GoldenEntry("ov-rl2", "overview", "was weißt du über die oib 2", (RL2,), "", True),
        overview.GoldenEntry("ex-rei", "exact-id", "REI 90", (RL2,), "", True),
        overview.GoldenEntry("pa-stiege", "paraphrase", "Stiegenhaus als Fluchtweg", (RL4,), "", True),
    ]


def inputs(hard_cases_path) -> Inputs:
    """The sample corpus with labels, embedded by the offline stand-in."""
    sample = Inputs(
        chunks=chunks(),
        doc_vectors=np.zeros((0, 0), dtype=np.float32),  # filled by embed_inputs below
        judgements=judgements(),
        overview=overview_entries(),
        hard_cases=evaluation.load_hard_cases(hard_cases_path),
        excluded=frozenset({CHANGES}),
    )
    embed_inputs(sample, Embedder("hashed", None))
    return sample
