# ADR-0027: Unified Document Processing Pipeline with Concurrent VLM Enrichment

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Engineering team
- **Related:** ADR-0020 (shared cache), ADR-0025 (norm registry), ADR-0026 (source kinds), `docs/architecture/backend-deep-dive.md`

## Context

The ingestion pipeline in `sources/knowledge_layer/src/llamaindex/adapter.py` grew organically. Per-file extraction ran four independent loops over PDF pages (text, tables, images, visual-page rendering), each with its own pdfplumber or pypdfium2 parse, and every image + rendered vector page made a **sequential** VLM HTTP call. For a 20-page architectural plan set this meant 20+ serial network round-trips before the file was done. Key problems:

1. **No concurrency in VLM calls** — each image and each rendered vector page waits on the previous call.
2. **No VLM result caching** — a 1-byte PDF change triggers full re-analysis of every image and drawing.
3. **Four separate PDF parses** — pdfplumber twice (text, tables), pypdfium2 twice (embedded images, visual-page render).
4. **Drawing content_type invisible to the agent** — `"drawing"` metadata fell through to `ContentType.TEXT` at retrieval because the schema had no `DRAWING` member.
5. **No server-side upload size enforcement** — the BFF trusted the client's 100 MB cap without re-checking.

## Decision

We will introduce a new module `processing.py` in the llamaindex package that owns the VLM-heavy stages of per-file processing, keeping `adapter.py` as the orchestration shell.

### Module structure

**`processing.py`** provides three functions:

1. `render_visual_pages_no_vlm(pdf_path, max_dim, min_text_chars, min_paths, max_pages)` — the existing visual-page detection + pypdfium2 render, without any VLM call. Returns raw `(image_bytes, page_number, width, height)` dicts.

2. `vlm_cache_key(image_bytes, prompt_type)` + `_cached_vlm_call(image_bytes, prompt_type, live_call, *args, **kwargs)` — content-hash VLM caching via `aiq_agent.common.cache` (shared Dragonfly/Redis store, ADR-0020). SHA-256 of image bytes + prompt type → `vlm:caption:{type}:{hash}`. TTL of 30 days. Fail-open on store errors.

3. `enrich_vlm_batch(images, drawing_pages, vlm_model, vlm_base_url, vlm_api_key, extract_charts)` — runs ALL VLM calls for a single file concurrently with `ThreadPoolExecutor` (4 workers), using the content-hash cache. Returns `(image_results, drawing_pages_with_captions)`.

### Changes to adapter.py

- `_run_ingestion` replaces the two sequential VLM blocks (embedded images + visual pages) with a single `if is_pdf:` block that gathers raw image bytes + raw rendered pages, then calls `enrich_vlm_batch`.
- Thumbnail generation (`_generate_and_upload_thumbnail`) moved to right after text extraction so the BFF polling sees a thumbnail as soon as the backend has the file, before any VLM or indexing work starts.
- The old `_render_visual_pdf_pages` function (combined detection + VLM) is deleted. Its replacement `processing.render_visual_pages_no_vlm` handles only the detection/render phase; VLM enrichment is the caller's responsibility via `enrich_vlm_batch`. The 3 direct unit tests migrated to test the split functions.

### Schema addition

`ContentType.DRAWING = "drawing"` added to `src/aiq_agent/knowledge/schema.py`. The `normalize` function in the retriever maps `"drawing"` → `ContentType.DRAWING` with a display citation `"file, p.N, drawing_type"`.

### Server-side size enforcement

New `assertFileSizeAllowed(file.size)` function in the BFF documents service, called by both `uploadDocument` and `uploadArchivDocument`. Uses the same `getFileUploadConfigFromEnv` config that drives the client-side limit.

## Consequences

### Positive

- **VLM latency cut dramatically**: a 20-page plan set drops from 20+ serial round-trips to ~5 batches (4 concurrent workers). Embedded images run concurrently with drawings.
- **Re-ingest speed**: content-hash cache avoids re-captioning unchanged images/drawings when a PDF is re-ingested. Even a full corpus sync after a single PDF change only re-runs VLM for that file's new/changed pages.
- **Drawing retrieval visibility**: `ContentType.DRAWING` means drawing chunks get their own citation format in the agent context and are no longer lumped into `ContentType.TEXT`.
- **Security closure**: server-side size enforcement removes the client-only size-gap finding.
- **Extensibility**: `processing.py` provides a clean interface for future document types (e.g. DXF, DOCX images) — add a new processor function and wire it into the VLM batch step.
- **Faster thumbnail availability**: generated right after text extraction, before the heavy VLM and indexing work.

### Negative

- **`processing.py` adds a module boundary** — the pipeline now spans two Python files instead of one. However the separation (adapter = orchestration + legacy functions, processing = batch extraction) is cleaner.
- **Cache storage cost**: VLM captions (a few KB each) stored in Dragonfly/Redis for 30 days. At current corpus sizes this is negligible.

### Risks

- **Cache miss under high concurrency**: the content-hash cache is a single round-trip per key. Four concurrent workers for one file hitting the same key is impossible (each key is unique per image). But multiple files' workers hitting the cache simultaneously is fine — Dragonfly handles concurrent reads.
- **`getFileUploadConfigFromEnv` in service.ts**: this function also reads `imageUploadEnabled` / `vlmAvailable` flags, which currently default to `false` / empty config. The size computation itself only needs `FILE_UPLOAD_MAX_SIZE_MB`; the other env reads are harmless overhead. If this becomes a concern, extract a standalone `maxUploadSizeBytes()` helper.

## Alternatives Considered

- **Keep sequential VLM but add caching only** — simpler, but the biggest latency win is concurrency, not caching. Caching alone still means 20 serial round-trips on first ingest.
- **AsyncIO with httpx** — the VLM client is OpenAI SDK (sync). Rewriting to asyncio would require either an async OpenAI client or wrapping calls in `asyncio.to_thread`. `ThreadPoolExecutor` is simpler and already idiomatic in this codebase.
- **Single library pass (pdfplumber + pdfium merged)** — would save parse time but adds significant complexity to the extraction logic. Deferred as a follow-up.
- **Batch VLM (one API call per file with multiple images)** — NVIDIA NIM and OpenAI don't support multi-image-in-one-chat-call for captioning at this scale. Per-image calls are the current constraint.

## Open Questions / Follow-ups

- `VLM_BATCH_WORKERS = 4` is hardcoded in `processing.py`. If providers enforce tight rate limits, this may need to be env-configurable.
- The content-hash VLM cache key does not include the VLM model name. Switching models invalidates stale entries only at the 30-day TTL boundary. A follow-up could model-key the cache.

## References

- ADR-0020: Shared cache layer (Redis/Dragonfly-backed get_json/set_json)
- `sources/knowledge_layer/src/llamaindex/processing.py`
- `sources/knowledge_layer/src/llamaindex/adapter.py` (`_run_ingestion`, `normalize`)
- `src/aiq_agent/knowledge/schema.py` (`ContentType`)
- `frontends/ui/src/lib/documents/service.ts` (`assertFileSizeAllowed`)
