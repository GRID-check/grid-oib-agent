"""Gate G6: does a 1024-d vector derived from the stored 3072-d one keep recall?

Two instruments, because two different things could lose recall:

* **Exact cosine in numpy** over the full vectors and over their truncated,
  re-normalised prefix. This isolates the dimension: no index, no quantization.
* **Qdrant's HNSW** on four named vectors in one throwaway collection: 3072 and
  1024, each as float and as TurboQuant 4-bit (production's quantization,
  ``schema.py``), searched with default parameters as ``hybrid_search``'s dense
  prefetch is. This adds what the index and the quantized copy cost on top.

Scored on the Punkt golden set's dense channel (German and English), units as
everywhere else in this harness, production's base filter applied by dropping
excluded files from a deeper ranking.

This module drives ``qdrant_client`` directly: it builds a collection shape
production does not have (four dense vectors), on a uniquely named collection it
deletes afterwards, as the knowledge layer's own server tests do.
"""

from __future__ import annotations

import contextlib
import time
import uuid
from collections.abc import Callable
from collections.abc import Sequence
from typing import Any

import numpy as np

from oib_retrieval_eval.qdrant_parity.vectors import truncate_renormalise

FULL = 3072
REDUCED = 1024

#: Named vectors in the G6 collection: (name, dimension, quantized).
VARIANTS = (
    ("f3072", FULL, False),
    ("q3072", FULL, True),
    ("f1024", REDUCED, False),
    ("q1024", REDUCED, True),
)


def exact_rankings(doc_vectors: np.ndarray, query_vectors: np.ndarray, depth: int) -> list[list[int]]:
    """Row indices of the ``depth`` nearest documents per query, by exact cosine (unit rows)."""
    scores = query_vectors @ doc_vectors.T
    depth = min(depth, doc_vectors.shape[0])
    order = np.argsort(-scores, axis=1, kind="stable")[:, :depth]
    return [list(map(int, row)) for row in order]


def _variant_params(models: Any, dimension: int, quantized: bool) -> Any:
    quantization = (
        models.TurboQuantization(turbo=models.TurboQuantQuantizationConfig(bits=models.TurboQuantBitSize.BITS4))
        if quantized
        else None
    )
    return models.VectorParams(size=dimension, distance=models.Distance.COSINE, quantization_config=quantization)


def qdrant_rankings(
    client: Any, doc_vectors: np.ndarray, query_vectors: np.ndarray, depth: int, timeout_s: float = 900.0
) -> tuple[dict[str, list[list[int]]], dict[str, Any]]:
    """Per variant, the ANN ranking (row indices) for every query; and the collection's index state."""
    from qdrant_client import models

    name = f"parity_g6_{uuid.uuid4().hex[:8]}"
    reduced = truncate_renormalise(doc_vectors, REDUCED)
    client.create_collection(
        name, vectors_config={variant: _variant_params(models, dim, q) for variant, dim, q in VARIANTS}
    )
    try:
        for start in range(0, doc_vectors.shape[0], 64):
            points = [
                models.PointStruct(
                    id=row,
                    vector={
                        "f3072": doc_vectors[row].tolist(),
                        "q3072": doc_vectors[row].tolist(),
                        "f1024": reduced[row].tolist(),
                        "q1024": reduced[row].tolist(),
                    },
                )
                for row in range(start, min(start + 64, doc_vectors.shape[0]))
            ]
            client.upsert(name, points, wait=True)
        info = _wait_green(client, name, timeout_s)
        queries_reduced = truncate_renormalise(query_vectors, REDUCED)
        rankings: dict[str, list[list[int]]] = {}
        for variant, dimension, _quantized in VARIANTS:
            source = query_vectors if dimension == FULL else queries_reduced
            rankings[variant] = [
                [
                    int(point.id)
                    for point in client.query_points(name, query=q.tolist(), using=variant, limit=depth).points
                ]
                for q in source
            ]
        return rankings, info
    finally:
        with contextlib.suppress(Exception):
            client.delete_collection(name)


def _wait_green(client: Any, name: str, timeout_s: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    info = client.get_collection(name)
    while time.monotonic() < deadline:
        info = client.get_collection(name)
        if str(getattr(info.status, "value", info.status)) == "green":
            break
        time.sleep(1.0)
    return {
        "status": str(getattr(info.status, "value", info.status)),
        "points": int(info.points_count or 0),
        "indexed_vectors": int(info.indexed_vectors_count or 0),
    }


def to_units(rows: Sequence[int], unit_of: Callable[[int], Any], allowed: Callable[[int], bool], depth: int) -> list:
    """Row indices as distinct judged units, excluded rows dropped, cut at ``depth``."""
    units: list = []
    seen: set = set()
    for row in rows:
        if not allowed(row):
            continue
        unit = unit_of(row)
        if unit in seen:
            continue
        seen.add(unit)
        units.append(unit)
        if len(units) >= depth:
            break
    return units
