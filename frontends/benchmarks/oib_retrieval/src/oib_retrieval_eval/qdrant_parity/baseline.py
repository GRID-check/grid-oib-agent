"""What the Chroma path measured: the fixed reference the Qdrant numbers are read against.

Chroma, its Postgres German mirror and the ``$contains`` channel left the stack in
one change (ADR-0113), so their path cannot be run again. These are its numbers
from the final gate run of 2026-10-13 (``docs/architecture/qdrant-gates-2026-10.md``,
"Results"): the OIB Punkt corpus, the production embedder at 3,072 dimensions, the
same golden, overview and hard-case fixtures this harness reads, the same machine
as that run's Qdrant numbers.

They are comparable to a ``--embedder production`` run on that corpus and nothing
else: a ``hashed`` run, or a changed fixture, compares against a different corpus,
and the report says so beside every reference row. A threshold that once read
"at least Chroma" now reads "at least these numbers"; moving one is a decision for
the gate report, never an edit here to make a run pass.
"""

from __future__ import annotations

from oib_retrieval_eval.qdrant_parity.evaluation import RankScores

#: Where every number below is written down, with how it was measured.
SOURCE = "qdrant-gates-2026-10.md, final run 2026-10-13 (Chroma path)"

#: The Postgres ``german`` FTS mirror alone, German golden questions, units, base filter.
LEXICAL_GOLDEN = RankScores(
    queries=24,
    recall={5: 0.521, 10: 0.646, 16: 0.854},
    ndcg={10: 0.461},
    mrr=0.414,
)

#: The same mirror on the 21 gating hard cases (``compound_only`` excluded), chunk oracle.
LEXICAL_HARD = {"cases": 21, "precision": 0.619, "r_precision": 0.539, "mrr": 0.714}

#: The full per-collection retrieval of the Chroma path, Punkt golden, units, depth 60.
HYBRID = {
    "golden_all": RankScores(queries=46, recall={10: 0.989, 16: 1.0, 60: 1.0}, ndcg={10: 0.782}, mrr=0.725),
    "golden_de": RankScores(queries=24, recall={10: 1.0, 16: 1.0, 60: 1.0}, ndcg={10: 0.801}, mrr=0.751),
    "golden_en": RankScores(queries=22, recall={10: 0.977, 16: 1.0, 60: 1.0}, ndcg={10: 0.761}, mrr=0.697),
}

#: The overview golden through the same retrieval, files. The cohort sizes were not recorded.
OVERVIEW = {
    "exact-id": {"recall@16": 0.900, "recall_pool": 0.900, "mrr": 0.528},
    "overview": {"recall@16": 0.950, "recall_pool": 0.983, "mrr": 0.632},
    "paraphrase": {"recall@16": 1.000, "recall_pool": 1.000, "mrr": 0.750},
}

#: Mean R-precision of the gating hard cases through the full retrieval.
HYBRID_HARD_R_PRECISION = 0.543

#: The store call per collection, embedding excluded: embedded Chroma plus the Postgres mirror.
LATENCY_MS = {"n": 380, "p50": 58.3, "p95": 88.9, "p99": 120.2, "mean": 59.6}
