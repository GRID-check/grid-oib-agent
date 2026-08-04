# ADR-0039: Agentic retrieval quality package (filters, hybrid RRF, LLM-judge reranker)

- **Status:** Accepted
- **Date:** 2026-08-03
- **Deciders:** Matthias Bigl (maintainer), opencode agent session
- **Related:** ADR-0010 (LLM-agnostic OpenAI-compatible), ADR-0020 (shared cache), ADR-0025 (norm registry), ADR-0026 (source-kind model), ADR-0028 (agent scaling)

## Context

The RAG retrieval path (`knowledge_search` / `knowledge_retrieval` in
`sources/knowledge_layer/src/register.py`) was a single vector-only retrieval
with three known quality gaps, identified in an audit against NVIDIA's
"Traditional RAG vs. Agentic RAG" playbook:

1. **Exact-keyword misses** — a query containing a precise norm number or a
   technical term the embedding model weights low retrieves no matching chunk
   (the planner then guesses "no corpus hit" even though the document exists).
   Fixing this would otherwise require re-embedding the whole corpus.
2. **No query-time filters** — the agent could not narrow retrieval by document
   class (`doc_class`: verbindliche OIB-Richtlinie vs. Leitfaden vs. Norm vs.
   Gesetz) or title, so a broad query polluted results with the wrong document
   kinds. The admin-editable `doc_class`/`display_title` (document_metadata
   store, ADR-0025/ADR-0026 surface) exists but retrieval ignored it.
3. **No query-time relevance judgment** — top-k is embedding-distance only; no
   second, more discriminating signal reranks candidates before trimming to
   `top_k`.

Two further constraints shaped the design:

- **No new subscriptions/keys.** The deployment resolves LLM credentials
  through existing Pulumi secrets (OpenRouter / OpenAI-compatible endpoints,
  ADR-0010). OpenRouter exposes **no `/rerank` endpoint** (verified), so a
  hosted reranker API was off the table.
- **No re-ingest for behavior changes.** Re-embedding the corpus to fix keyword
  recall would be expensive and version-unstable; store-side metadata is
   already authoritative for `doc_class`.

## Decision

We will add four retrieval-side improvements to the knowledge layer, all
**fail-open** (any error degrades to previous plain behavior, never raises):

1. **Agentic filters on `knowledge_search`**: optional `doc_class` and
   `title_contains` arguments, applied post-merge with over-fetch
   (`_AGENT_FILTER_OVERFETCH = 3`), store-authoritative via
   `aiq_agent.knowledge.factory` (`get_document_doc_classes` /
   `get_document_display_titles`) with chunk metadata as fallback. Invalid
   `doc_class` values return the allowed vocabulary instead of an empty result.
2. **Hybrid lexical + vector retrieval**: when `AIQ_HYBRID_RETRIEVAL` (default
   on; config key `hybrid_search`) is enabled, an extra exact-term lexical query
   per collection (up to 3 technical tokens via the shared token-based utility
   `src/aiq_agent/common/legal_terms.py::extract_exact_terms` — **no regex**),
   matched with Chroma `where_document: {"$contains": term}`, fused with the
   vector channel by **reciprocal rank fusion** (`llamaindex/hybrid.py`,
   Cormack `k=60`, vector channel wins ties).
3. **LLM-judge reranker**: optional config keys `rerank_llm` (LLM alias from the
   config `llms:` block; reference config points it at `summary_llm`) and
   `rerank_candidates` (default 15; must exceed `top_k` — the judge call trims to
   `rerank_candidates`, so a smaller pool could never fill the full result set;
   the reference config pairs `top_k: 16` with `rerank_candidates: 20`). When
   set, merged+filtered candidates are
   rescored once by an LLM judge (`llamaindex/rerank.py::rerank_chunks`, 30s
   timeout, excerpt-windowed prompt of 400 chars/chunk, 1–10 scores) before
   trimming to `top_k`. Fail-open to the original order.
4. **Multimodal answer-time page/image viewing**: new NAT tool
   `view_knowledge_image` (`llamaindex/view_image.py`) gated on
   `AIQ_VIEW_IMAGES_ENABLED` (default on) plus a resolvable VLM key. It covers
   both source shapes: **PDF pages** are re-rendered on demand (pypdfium2 →
   JPEG, long edge `AIQ_PAGE_RENDER_MAX_DIM`, default 2048) — base-corpus PDFs
   from disk, project/Archiv PDFs from SeaweedFS bytes — and **standalone
   image uploads** (PNG/JPG project/Archiv documents) are fetched from
   SeaweedFS and re-encoded to JPEG directly. It returns a
   `[text, image_url]` multimodal block pair so the model sees images
   **during a research turn**, not only at ingestion. Every failure path
   degrades to a text-only explanation block.

   Storage-key resolution goes through the BFF: the backend carries only
   `(collection, filename)` while the SeaweedFS `storage_key` lives in the
   frontend's `documents` table, so a new token-guarded internal route
   `GET /api/internal/document-file` (service `lib/documents/service.ts`,
   repository `lib/documents/repository.ts`, ADR-0017 layering) resolves the
   pair, and the backend fetches the bytes itself via boto3 (S3, path-style).
    This **deliberately overrides the previous "no SEAWEED_* on the aiq-agent
    tier" separation** in `deploy/pulumi/src/app/config.ts`: the tier now
    receives `SEAWEED_ENDPOINT`/`SEAWEED_BUCKET`/`SEAWEED_ACCESS_KEY`/
    `SEAWEED_SECRET_KEY` for read-only `get_object` calls — the smallest
    credential scope that lets the tool see project/Archiv documents without a
    presign round-trip through the upload path. The credential is a **dedicated
    read-only, bucket-scoped identity** (`grid-backend-read`: `Read` on the
    documents bucket only, distinct key material from the root `grid` identity,
    provisioned alongside it in the SeaweedFS s3.json by
    `deploy/pulumi/src/data/seaweedfs.ts`) — the backend never holds the root
    Admin access key.

Plus a fifth, observability-side improvement:

5. **Retrieval-precision feedback**: a new `retrieval_precision` event kind in
   the citation-health pipeline (`src/aiq_agent/common/citation_events.py`).
   `build_turn_events` compares retrieved source labels against cited labels per
   turn and emits an info-severity event with `retrieved`/`cited`/`uncited`
   counts and the first 10 uncited labels, closing the retrieval-quality loop on
   the existing `GRID_CITATION_EVENTS_ENABLED` dashboard surface. Frontend:
   `CITATION_PRECISION_KIND` in `lib/db/schema/citation-events.ts`; defect
   queries and glossary in `lib/citations/{service,repository}.ts` exclude the
   new kind so precision renders as its own diagnostic.

All changes ship with unit tests under `tests/knowledge_layer_tests/`
(`test_agent_filters.py`, `test_hybrid.py`, `test_rerank.py`,
`test_view_image.py`).

## Consequences

### Positive

- Exact-keyword queries now hit the corpus without a re-embed; hybrid fusion
  preserves the semantic channel while adding lexical recall.
- The agent can scope retrieval by document kind/title at query time, and
  admin-edited classifications take effect immediately (store-authoritative).
- A cheap LLM judge adds a second relevance signal without a new dependency or
  subscription; fail-open keeps availability.
- The citation-health dashboard now exposes *retrieval* quality (surfaced but
  unused documents) separate from citation defects.
- Image-groundable follow-up questions ("what does this plan show?") work with
  the existing VLM key.

### Negative

- Extra LLM call per turn when the reranker is enabled (mitigated: only
  `rerank_candidates` chunks, 30s timeout, fail-open; operators can omit
  `rerank_llm`).
- Hybrid lexical queries add a second Chroma query per collection per term
  (≤3 terms) — latency bounded by `top_k` scale; over-fetch factor 3 increases
  candidate work.
- Two new env knobs (`AIQ_HYBRID_RETRIEVAL`, `AIQ_VIEW_IMAGES_ENABLED`) and two
  config keys (`hybrid_search`, `rerank_llm`/`rerank_candidates`) — each has a
  fail-open default, per the capability doctrine (flags are product decisions,
  never derived capability duplicates).

### Risks

- A bad reranker judge could reorder good hits below bad ones; mitigated by
  fail-open, 1–10 scoring on excerpts, and operator control via `rerank_llm`.
- `$contains` lexical queries on very common terms could flood the lexical
  channel; mitigated by term extraction (≤3 technical tokens) and RRF k=60
  dampening.
- Answer-time page rendering exposes PDF render cost in the chat path;
  mitigated by per-page on-demand rendering, `AIQ_PAGE_RENDER_MAX_DIM` bounds,
  and the gate itself: availability is the default-on `AIQ_VIEW_IMAGES_ENABLED`
  flag AND a resolvable VLM key (the derived capability, per the capability
  doctrine); without a key the tool explains itself in text.
- The aiq-agent tier now holds a SeaweedFS S3 credential (attack-surface
  widening vs. the previous presign-only separation); mitigated by a dedicated
  read-only identity (`grid-backend-read`: `Read` on the documents bucket only,
  distinct key material from the root `grid` identity — see
  `deploy/pulumi/src/data/seaweedfs.ts`), token-guarded BFF lookup as the sole
  key source, and fail-open degradation when the credential is absent.

## Alternatives Considered

- **Hosted reranker API (e.g. Cohere/voyage)** — rejected: OpenRouter (the
  deployment's credential hub) has no rerank endpoint, and a new subscription
  violates the no-new-keys constraint.
- **Re-embedding with a keyword-aware model or n-gram chunking** — rejected:
  expensive, corpus-version-unstable, and does not fix the *query-side*
  weakness; hybrid lexical retrieval is cheaper and reversible.
- **Regex-based term extraction for the lexical channel** — rejected: brittle
  for German legal morphology and hardcoded-string-prone; the shared
  token-based utility (`legal_terms.py`) is reused by both the hybrid channel
  and future callers.
- **Backend presign flow for view_knowledge_image** — rejected: the upload
  path hands the backend a presigned PUT URL from the BFF, but reads would
  need a presigned GET minted per call (extra round-trip + a new BFF presign
  route); direct boto3 `get_object` is simpler and read-only.
- **Teaching the Python `document_metadata` store the `storage_key`** —
  rejected: the frontend `documents` table already owns the mapping; a
  token-guarded internal lookup keeps one source of truth instead of
  replicating the column into the backend's summary DB.

## Open Questions / Follow-ups

- `view_knowledge_image` covers the LlamaIndex ingest backend; the
  `foundational_rag` backend's page-render track is a known follow-up (see
  deep-dive §6 scope note).
- The precision event is emitted best-effort; dashboard aggregation and
  per-org precision metrics are follow-ups on the platform side.
- Hybrid retrieval currently fuses per collection; cross-collection fusion was
  intentionally kept out of scope for this change.

## References

- Deep-dive §6 "Agentic retrieval quality package": `docs/architecture/backend-deep-dive.md`
- NVIDIA "Traditional RAG vs. Agentic RAG" (audit source)
- Cormack et al. reciprocal rank fusion (k=60)
- Citation-health pipeline: ADR-0037-related surface, `GRID_CITATION_EVENTS_ENABLED`
