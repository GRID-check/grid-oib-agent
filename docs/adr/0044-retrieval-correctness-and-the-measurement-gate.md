# ADR-0044: Retrieval correctness, structure-aware chunking, and the measurement gate

- **Status:** Proposed
- **Date:** 2026-08-10
- **Deciders:** Platform / backend
- **Related:** ADR-0039 (agentic retrieval quality package), ADR-0020 (shared cache),
  [../architecture/rag-system-audit-2026-08.md](../architecture/rag-system-audit-2026-08.md)

## Context

ADR-0039 specified hybrid retrieval with reciprocal rank fusion and an LLM-judge
reranker. Both shipped. A full audit of the retrieval plane found that neither
did what it was specified to do, and that nothing in the system could have told
us so.

The defects were not degradations; each produced plausible output while being
wrong:

- `_chunks_from_raw_query` built its nodes with `TextNode(node_id=...)`, but
  `node_id` is a read-only property over `id_`. Pydantic dropped the kwarg, so
  every lexical-channel chunk was born with a fresh `uuid4`. Fusion keys on
  `chunk_id`, so no chunk could ever match across channels: RRF degenerated into
  interleaving, the same passage was emitted twice under two identities, and
  those duplicates displaced genuine vector hits. Hybrid retrieval was a **net
  loss** — turning it off produced a better result set.
- `_merge_results` re-sorted by `chunk.score`, discarding whatever fusion had
  computed. This was a theorem, not an accident: a lexical-only chunk is by
  construction outside the vector top-k, so under a score sort fusion could only
  ever remove high-scoring candidates and add low-scoring ones. The same sort
  meant a user's own uploaded PDF, which sits in a worse distance band than the
  professionally chunked corpus, could never compete however well it matched.
- The vector store reports `exp(-distance)`, not a similarity. An *orthogonal*
  chunk therefore scored 0.37 and was printed into the grounding block as
  `Relevance Score: 0.37`. The only threshold in the codebase,
  `MIN_SURFACE_SCORE = 0.35`, sat at a cosine of **−0.05**: a documented
  user-protecting quality gate that admitted anti-correlated chunks and rejected
  essentially nothing.
- No document set `excluded_embed_metadata_keys`, so LlamaIndex prepended the
  whole metadata dict before embedding. Every corpus vector was shifted by
  `file_size: 1975942`, and non-PDF uploads embedded the ingest temp path, which
  differs on every re-upload of the same file.
- The reranker over-fetched 20 candidates to return 16 and judged each on 400 of
  ~4000 characters. `rerank_candidates: 0` was a valid config that emptied the
  knowledge base on both the success and the fail-open path. A judge reply that
  renumbered, repeated or omitted indices was absorbed as a successful rerank.

Underneath all of it: **there was no retrieval-level evaluation of any kind**.
No golden set, no recall@k, nothing. Every parameter — `top_k`, the diversity
cap, `rerank_candidates`, chunk size, hybrid on/off — was tuned by argument. The
audit's own doctrine names the failure mode: *before optimising a measurement,
establish what the measurement is of*.

Two further forces bear on the decision. The corpus is 946 numbered requirements
at a median of 62 tokens, cut into 1024-token blocks over per-page Documents:
57% of pages began mid-Punkt and 92% of chunks did not start on a numbered line,
so one chunk blended roughly fifteen unrelated requirements and no citation could
be finer than a page. And the deployment is not one process — `AIQ_CHROMA_URL`
points two backend replicas and a 2–8 replica research worker tier at one Chroma —
while the collection write version the result cache keys on was a module global.

## Decision

We will treat retrieval correctness, structure-aware chunking, and measurement as
one package, and we will gate tuning on measurement.

1. **Correctness first, tuning second.** The identity, score-scale, fusion,
   filter-grammar and reranker defects are fixed and each carries a regression
   test that fails without the fix. Where a parameter had to move to make a fixed
   stage functional (`rerank_candidates` 20 → 60), it moves once and is marked
   provisional.
2. **Fusion is by rank, never by score.** `Chunk` carries an optional
   `retrieval_rank`, and cross-collection merging fuses those ranks. Rank fusion
   is scale-free, which is what makes layered retrieval actually layer.
3. **`Chunk.score` is a true cosine similarity.** Recovered exactly via
   `cos = 1 + ln s`, total on every input because `normalize`'s except-branch
   substitutes a citable poison chunk rather than dropping one.
4. **Documents with a usable outline are cut on that outline.** `punkt_documents`
   yields one requirement per chunk with a `punkt_id` to cite; anything it cannot
   parse keeps the previous per-page behaviour byte-for-byte. That fallback is
   what makes enabling it by default safe.
5. **Every collection records the embedding that wrote it.** Absent fingerprints
   are adopted, not rejected, so no deployed corpus breaks.
6. **The collection write version lives in the shared cache**, with `None`
   meaning *unknown* and unknown meaning *do not cache*. The retriever becomes a
   real singleton only together with this; alone it would have converted a
   same-process invalidation into a fleet-wide one-hour staleness window on legal
   text.
7. **No retrieval parameter is tuned on judgement once the harness exists.**
   Until then, values that had to move are marked provisional in-config, and
   `MIN_SURFACE_SCORE` — the standing example of what setting a retrieval number
   without measurement costs — is set conservatively and labelled as such.

## Consequences

### Positive

- Hybrid retrieval stops being a net loss and starts contributing both membership
  and rank. A chunk found by both channels now outranks one found by either.
- Citations can name a Punkt rather than a page, because a chunk is now a
  requirement.
- Scores mean something, so a relevance floor becomes expressible at all — and
  the one existing threshold stops being a no-op.
- A silent corpus swap (same-dimension model change, or a repointed base URL)
  becomes a loud, localised failure instead of quietly wrong answers.
- Cross-replica staleness on legal text drops from 3600s to ≤3s.

### Negative

- **The version bump forces a full re-ingest of the base corpus** (39 PDFs
  including VLM captioning) on the next sync. This is deliberate — `sync()` gates
  on the sha256 of the PDF bytes, so a preprocessing change alters no file hash
  and would otherwise be a silent no-op — but it is a deploy event.
- **Every relevance percentage the UI shows drops.** `semantic-match.tsx` renders
  `score * 100`; an orthogonal hit went from displaying 37% to 0%. Correct, and
  visible.
- Chunks are roughly an eighth of their former size, so `top_k` and
  `rerank_candidates` are now tuned for the wrong shape and must be re-derived.
- The retriever's caches become resident rather than per-run (~49 MiB per distinct
  configuration), and the retrieval path acquires a shared-cache round trip,
  memoised for 3s.

### Neutral / follow-up

- The dense channel's retrieval quality remains **unmeasured**. The harness makes
  structural retrievability and the lexical channel measurable without an
  embeddings key; the dense numbers become real only when run against a populated
  store with credentials.
- A same-name, same-dimension model swap on a collection with no fingerprint is
  still undetectable. Adoption is the price of not bricking deployed corpora.
