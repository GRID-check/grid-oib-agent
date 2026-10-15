---
status: accepted
date: 2026-10-13
decision-makers:
consulted:
informed:
---

# Qdrant replaces Chroma as the vector store, reached through qdrant-client, in one change

## Context and Problem Statement

Until this change every chunk lived in one Chroma server (`chromadb/chroma:1.5.9`, one replica,
a 20Gi PVC, `deploy/pulumi/src/data/chroma.ts`). Open-source Chroma is single
node, so that pod is a retrieval and ingest outage whenever it moves. On
2026-10-12 one dead Chroma pod drained the API's thread pool, because the
chromadb client sets no HTTP timeout (`docs/contributing/gotchas.md`).

Chroma also has no lexical index, no fetch-by-filter we use, no cheap metadata
update and no auth. About a third of the knowledge layer exists to compensate
for that:
- the `$contains` channel
- the Postgres German FTS mirror
- `exp(-d)` score recovery
- the 3× over-fetch with post-filters
- an embedded dummy query in `read_passage`

The full inventory is in
[`qdrant-retrieval-design.md`](../architecture/qdrant-retrieval-design.md) §2.

ADR-0072 named this case: "Revisit if Piloti needs a vector store that ChromaDB
cannot serve … a new adapter behind the same seam and an ADR superseding this
one."

## Decision Drivers

* Self-hosted on Kubernetes, open source only.
* Horizontal scale and replica failover for ≤10k users across many offices.
* Hybrid dense and German lexical search, filtering and grouping done
  server-side, not reassembled in Python.
* Few moving parts: a small team runs this.
* Migration without re-parsing, re-captioning or re-embedding.

## Considered Options

* Qdrant, reached through `qdrant-client` directly.
* Qdrant, reached through `llama-index-vector-stores-qdrant`.
* Milvus.
* Keep Chroma (do nothing).

And, for the move itself:

* Replace Chroma in one change, with no period in which both stores are written.
* Move in steps behind a flag (`AIQ_VECTOR_BACKEND`: `chroma`, then `dual`,
  then `qdrant`), Chroma staying the write-side record until a last step
  removes it.

## Decision Outcome

Chosen option: "Qdrant, reached through `qdrant-client` directly". It is an
Apache-2.0 single binary that replicates over Raft. Its Query API does the
hybrid, fusion, boosting and grouping work we currently do by hand, including
German BM25 server-side in the open-source build. The direct client is the only
way to reach those features (the LlamaIndex store uses none of them).

The move is one change, with no dual period. Ingestion embeds a file's chunks
and writes them to Qdrant (`knowledge_layer/qdrant/writes.py`); every read,
listing, count and delete goes to Qdrant. Chroma, its client, the
`AIQ_VECTOR_BACKEND` flag, the Chroma-to-Qdrant mirror and the Postgres
`chunk_text` mirror are deleted, and the existing data moves once, offline,
with the export/import tool the runbook describes
([`qdrant-runbook.md`](../deployment/qdrant-runbook.md)). The flagged path was
built first (slice 1, design doc §12) and showed the cost of two stores:
deletes that had to be ordered across them, a mirror whose failures needed a
policy per mode, a backfill to heal it, and every registry read still tied to
Chroma. The gates that decided the move were measured on that build
([`qdrant-gates-2026-10.md`](../architecture/qdrant-gates-2026-10.md)); they
need no second store to stay true.

### Consequences

* Good, because:
  * Replicas survive a node loss; retrieval stops depending on one pod.
  * Hybrid search, RRF, score boosting and `group_by` run in one server call.
    The `$contains` channel, `exp(-d)` recovery, the German FTS mirror and
    per-collection fan-out are deleted.
  * One store means one delete: it took what it names or it raised, and the
    caller's retry starts over. The ordered two-store delete and its failure
    policies are gone.
  * The migration copies the stored vectors and text; nothing is re-embedded.
    Point ids stay the chunk ids, so citations and `already_read` digests
    survive it.
  * `qdrant-client` has native timeouts; the private reach-in goes away, and
    `chromadb` with its transitive tree (onnxruntime, kubernetes,
    huggingface-hub, tokenizers) leaves the image.
* Neutral, because LlamaIndex stays for loaders and chunking (a
  `SentenceSplitter` per job, no `VectorStoreIndex`), and the
  `BaseRetriever`/`BaseIngestor` seam stays.
* Neutral, because a collection is now a scope on the points (ADR-0114): every
  name is a collection, an empty one has no chunks, and creating one stores
  nothing. A collection's `updated_at` is the newest `indexed_at` its points
  carry; points copied without one never expire through the 24-hour reaper of
  conversation uploads until they are re-ingested or the import stamps it.
* Bad, because there is no rollback to Chroma after the cut-over short of
  restoring the old deployment and its volume. The migration is rehearsed on a
  copy first, and the Qdrant snapshots are the net afterwards.
* Bad, because a write is acknowledged by one replica (consistency 1, design
  doc §12), and until Qdrant has re-synced the other, a peer lost for good
  inside that window loses it. Chroma no longer stands behind it; the
  snapshots do, and a re-ingest of the affected files repairs the rest.
* Bad, because open-source Qdrant has no resharding, auto-rebalancing or
  automatic re-replication. Shard counts are fixed at creation, and node changes
  are manual API calls we must script and drill.
* Bad, because Qdrant must be upgraded minor by minor. Falling behind means
  stepping through every minor.
* Bad, because we write and own a StatefulSet, snapshot CronJob and metrics
  scrape. The commercial operator is the alternative we decline.
* Bad, because the adapter's roughly 40 direct chromadb calls are rewritten,
  not swapped.

### Confirmation

* `sources/knowledge_layer/tests/test_qdrant_import_boundary.py` allows
  `qdrant_client` only under `knowledge_layer/qdrant/`, and `chromadb` (or
  LlamaIndex's Chroma store) nowhere but the one-off migration tool under
  `deploy/migration/`. A second store creeping back in fails the build.
* Every test that needs a store runs against a real `qdrant/qdrant:v1.19.2`
  (the CI backend job sets `AIQ_QDRANT_TEST_URL` for every step) through one
  fixture, `sources/knowledge_layer/tests/qdrant_testing.py`, and fails, rather
  than skips, when the server is missing on CI.
* `test_qdrant_adapter_deletes.py` drives every adapter delete against the
  real store with a failure injected: nothing is deleted or recorded as
  deleted when Qdrant refuses, and a retry finishes the job.
* The cut-over in each environment follows the runbook's migration procedure
  and its verification (id sets compared, collection by collection); the
  answer suite runs on the migrated stack before it serves users. Review is
  the gate for that.
* `task be:eval:answer-suite` runs before and after every retrieval change, as
  AGENTS.md already requires.

## Pros and Cons of the Options

### Qdrant through `llama-index-vector-stores-qdrant`

* Good, because it is the smallest code change.
* Bad, because 0.10.4 sends dense and sparse as two requests and fuses them
  client-side. It uses no prefetch, server-side fusion, formula, `group_by`,
  MMR or server BM25, and it hides chunk text inside a `_node_content` string
  that no full-text index can read. We would pay for Qdrant and use it like
  Chroma.

### Milvus

* Good, because it scales elastically with an open-source operator, and its
  BM25 full-text engine is stronger than Qdrant's sparse-vector BM25.
* Bad, because it brings coordinators, query, data and streaming nodes plus
  etcd and object storage: a system built for billions of vectors, run by a team
  that needs millions. It has no official Chroma migration path.

### Keep Chroma

* Bad, because it stays single node, and every workaround in the design doc §2
  stays with it.

## More Information

* The design this decision serves:
  [`qdrant-retrieval-design.md`](../architecture/qdrant-retrieval-design.md).
* Companion decision: [ADR-0114](0114-retrieval-scope-is-a-payload-filter-compiled-in-one-place.md)
  (scope as a payload filter).
* On acceptance this supersedes
  [ADR-0072](0072-the-knowledge-layer-has-one-backend-llamaindex.md). The seam
  survives; "one backend: LlamaIndex over Chroma" does not.
* Revisit if the point count passes about 500M, or if write throughput outgrows
  a manually balanced 6-shard layout. Milvus's elastic scaling is the answer to
  that problem, which we do not have.
