# GRID Backend Deep Dive — Chat, Cards, Project Knowledge, Files & Research

> Authoritative end-to-end map of how GRID's core flows work, why several were
> broken, and how they were fixed. Written 2026-07-04 from a full source trace
> (7 parallel explorations + NAT-internals verification). File references are
> `path:line` at time of writing.

## 1. System topology

Docker Compose (`deploy/compose/docker-compose.yaml`):

- **postgres** — 3 logical DBs: `aiq_jobs`, `aiq_checkpoints`, `grid_app`.
- **minio** — object storage, bucket `grid-documents`. Published to the host at
  `localhost:9000`; internal DNS name `minio:9000`.
- **aiq-agent** — FastAPI + NeMo Agent Toolkit (NAT) + embedded Dask
  scheduler/worker + in-process ChromaDB. Runs the LangGraph workflow and the
  async deep-research jobs.
- **frontend** — Next.js 16 BFF + a Node WebSocket proxy (`frontends/ui/server.js`).
- **dragonfly** — Redis-protocol shared cache (ADR-0020): read-through caches
  (membership, flags, prompt view, model overrides, budget limits, model
  catalog), the gateway's WS-upgrade rate limiter, and per-conversation
  citation-registry snapshots. Cache-only semantics; both tiers fail open to
  in-process fallbacks when it is down or `REDIS_URL` is unset.

The **real** backend front-end plugin is `frontends/aiq_api` (`_type: aiq_api`).
(The old `src/aiq_agent/fastapi_extensions/` duplicate was deleted 2026-07-03,
commit `2570b1b`; its one live route, `/v1/ingest`, was ported into `aiq_api`.)

The working config is `configs/config_oib_openrouter.yml` (OpenRouter DeepSeek +
OpenRouter embeddings). `config_grid_oib.yml` (Kimi) is not currently working.

## 2. Chat request lifecycle (WebSocket-only)

Chat is **WebSocket only**. The old SSE `/api/generate` chat path is dead; SSE
now serves **only** the deep-research job stream (§7).

```
Browser WebSocket
  → frontends/ui/server.js  (WS upgrade proxy)
      • calls internal /api/websocket-scope?projectId=…  to fetch:
          - projectContext  → sets header  x-grid-project-context
          - collection scope → sets header  x-grid-collection-scope
      • ALSO sets the signed X-Grid-Request-Context envelope (below)
      • proxies the upgrade to the aiq-agent backend
  → NAT workflow  chat_deepresearcher_agent
      LangGraph:  intent_classifier
                    ├─ meta      → END
                    ├─ shallow   → shallow_research ─(escalate?)→ clarifier
                    └─ deep      → clarifier → deep_research
  → response streamed back through the MONKEYPATCHED WS handler
      frontends/aiq_api/src/aiq_api/websocket_reconnect.py
  → frontends/ui/src/adapters/api/websocket-client.ts  (parse system_response)
  → frontends/ui/src/features/chat/hooks/use-websocket-chat.ts  (onResponse)
  → frontends/ui/src/features/layout/components/ChatArea.tsx → AgentResponse.tsx
```

Key files:
- Graph build: `src/aiq_agent/agents/chat_researcher/agent.py` (`_build_graph`, nodes).
- Workflow registration + response creation: `src/aiq_agent/agents/chat_researcher/register.py`.
- WS wire types (NAT, vendored): `.venv/Lib/site-packages/nat/data_models/api_server.py`
  — `ChatResponse` and the WS message models are `extra="allow"`, so extra
  fields (cards, deep_research_job_id) survive serialization.

### The monkeypatch (critical seam)

`websocket_reconnect.py:create_websocket_message` takes the workflow's
`ChatResponse` (`data_model`) and builds the top-level `system_response` WS
message. It **lifts extra fields off the response onto the top-level message**
so the frontend can read them at `message.<field>` (not nested under
`message.content`):

- `cards`  → `message.cards`  (rendered as Grid cards)
- `deep_research_job_id` → `message.deep_research_job_id` (opens the research panel)

If you add another structured signal to the chat response, this is where it must
be lifted, and the frontend Zod schema (`schemas.ts`) must declare it.

### 2b. Signed context envelope (backlog T3-9, 2026-07-16)

Every submission path used to hand-roll its own subset of the `x-grid-*`
context headers (org/user/project id, collection scope, project
context/memory, model overrides, budget, disabled sources) — one audited case
(async-job submit, §8b) simply forgot one. `frontends/ui/src/lib/request-context.ts`
is now the single builder: `buildGridRequestContextWireHeaders` returns every
individual header PLUS one consolidated, signed `X-Grid-Request-Context`
header (base64url JSON of the same fields, plus the structured `bundesland`
fact — §6b) and `X-Grid-Request-Context-Sig` (hex HMAC-SHA256 of the raw
JSON, keyed on `GRID_INTERNAL_API_TOKEN`). This is a **dual-write
transition**: the individual headers are still sent unchanged; the envelope
rides alongside them, and removing the legacy headers is a later cleanup.
`server.js` duplicates the same builder logic (with a pinning comment) since
it is plain CommonJS and cannot import the TS module.

On the backend, `aiq_agent.project_context.GridRequestContext.from_context()`
/`from_envelope()` verifies the signature with `hmac.compare_digest` and
prefers a present-and-valid envelope over the individual headers; an
invalid/missing signature is treated as an ABSENT envelope (logged as a
WARNING tamper signal), falling back to the individual headers exactly as
before the envelope existed.

`frontends/aiq_api/src/aiq_api/context_envelope.py`'s
`GridContextEnvelopeMiddleware` (raw ASGI, same pattern as `AuthMiddleware` —
never buffers the response body, so SSE routes are unaffected) fail-closed
rejects (403 / WS policy-violation close) a workflow-invoking request when
ALL of: `REQUIRE_AUTH=true`; the caller is a WorkOS-authenticated JWT user;
the path is on the conservative enforced allowlist (`/websocket`,
`/v1/jobs/async/submit`, `/v1/internal/workflows/submit`, `/generate`); and no
valid envelope is present. Exempt regardless of path: anonymous mode,
internal-token-authenticated service calls, and every non-enumerated path —
the enforced-path list is an allowlist, not a denylist. Dev fail-open note:
when `GRID_INTERNAL_API_TOKEN` is unset, signature verification is skipped
but envelope *presence* is still required for authenticated requests.

## 3. The card pipeline

**Cards are the rich-UI presentation layer**, not a citations feature. The agent
answers in plain markdown by default and emits a typed *card* whenever a
structured/rich format serves the user better. `LegalBasisCard` is one instance;
the set is meant to grow (summaries, profile patches, and later e.g. requirement
checklists, comparison tables, action prompts, standard-applicability panels).
Because cards are model-*chosen* rich UI, generation is inherently LLM-driven —
the design goal is to make card emission a **first-class, robust output channel**
(visible failures, one shared typed schema front+back, and a frontend renderer
registry so a new card type = define model + add renderer, no pipeline surgery),
NOT to bolt on a silently-failing second LLM call.

Cards (`SummaryCard`, `LegalBasisCard`, `ProjectProfilePatchCard`) are defined in
`src/aiq_agent/cards/models.py` (discriminated union, `validate_cards`); the
frontend renders them in `frontends/ui/src/features/grid-cards/`.

### How generation works (post-fix)

Card generation is a **second LLM call** (`ChatResearcherAgent._generate_cards`,
`agent.py`) run in `run()` after the graph produces an answer, using the
`card_generator_llm` (config: `deepseek_super_llm`). Post-fix behaviour:

- Cards are generated whenever a turn produced a real answer (`query` + `context`).
  The old code hard-gated on `intent == "research"` and was inconsistent between
  its two return-shape branches; this was unified.
- Generation is **skipped when the turn only dispatched an async deep-research
  job** (the "answer" is just the job-submitted stub — nothing to card).
- The result rides `ChatResponse.cards` → monkeypatch → `message.cards` → the
  frontend `validateGridCards` → `GridCards.tsx`.

### Deep-research cards (async path: closed; sync inline path: open)

With `use_async_deep_research: true` (the working config), any query routed to
deep research returns the stub `"Deep research job submitted. Job ID: …"`. The
**real** answer is produced later by `frontends/aiq_api/src/aiq_api/jobs/runner.py`
(`run_agent_job`), which now generates cards post-hoc from the final report
(`_generate_grid_cards` → `aiq_agent.cards.generate_cards`), re-emits the
report artifact with cards attached over the job SSE stream, and stores
`{"report", "cards"}` as the job output. Deep research cannot use the
`emit_card` tool directly: the conversation-scoped `CardRegistry` is bound
only in the chat request path, not inside a Dask worker. The remaining gap is
the **synchronous inline** deep-research path (no Dask scheduler configured):
those answers carry no cards, since the deep agent has no `emit_card` tool
and no post-hoc generation runs in `deep_research_node`.

### Removed dead mechanism

`deep_researcher/prompts/writer.j2` previously instructed the writer to emit a
`<grid_cards>…</grid_cards>` block, but the same prompt tells it to write the
report to `/shared/output.md` and return only a marker — and nothing ever parsed
the block. It could only leak raw JSON into reports. **Removed.**

## 4. Project knowledge — the intake-wizard context

> "Project knowledge" here = the intake-wizard profile injected as agent context.
> This is distinct from RAG/file scoping (§6), which works independently.

Pipeline (all correctly wired):

```
Intake wizard answers
  → PUT /api/projects/{id}/profile
      buildProfileUpdate → buildProjectPromptView(profile)
      → stored in projects.profile_prompt_view  (a compact "PROJECT_CONTEXT v1" block)
  → /api/websocket-scope reads profile_prompt_view → returns projectContext
  → server.js sets header  x-grid-project-context  on the WS upgrade
  → src/aiq_agent/project_context.py reads the header (truncated to 4000 chars)
  → chat_researcher/register.py sets state.project_context
  → injected into every prompt: all *.j2 have {% if project_context %}{{ project_context }}
```

### The bug that was fixed (WebSocket projectId race)

The header only carries when the WS handshake includes the correct `projectId`
query param. The client used to **snapshot `projectId` once** via
`useChatStore.getState().projectId` at socket-creation time, with the connect
effect **not keyed on `projectId`** and **no way to update it**. Because React
fires child effects before parent effects, on first navigation into a project
(the wizard's landing) the socket connected with `projectId: undefined` → the
header was never sent → the agent had no project knowledge for that session.

**Fix** (`use-websocket-chat.ts`, `websocket-client.ts`):
- Subscribe to `projectId` reactively and add it to the connect-effect deps, so
  the socket is (re)established once the project store resolves.
- Added `NATWebSocketClient.updateProjectId()` which rotates the socket (same
  atomic swap used for auth rotation) only when the value actually changes, so
  the handshake re-sends the project scope.

Note: the profile is intentionally **not** embedded into the `proj_*` RAG
collection — project knowledge reaches the agent only via header text-injection:
this profile header plus the project-memory digest header (`x-grid-project-memory`,
see §8).

## 5. Project summary / fact-sheet

The Project Overview "Project Brief" panel (`project-brief.tsx`, mounted by
`project-overview.tsx`) renders the AI `summary` from `projects.profile_display`
plus a fact sheet derived **at render time from the raw `projects.profile`** via
`buildProjectBriefView` (`lib/project-profile/brief-view.ts`): facts grouped in
intake-stage order with question/option labels ("Main use: Residential", not
"hauptnutzung: wohnen"), goal focus areas, unanswered questions as links back
into the wizard, a completeness count, and agent-suggested `assumptions` with
confirm/dismiss actions (confirm graduates the value into a `user_confirmed`
fact through the same patches endpoint the agent's `project_profile_patch`
cards use). `buildProjectProfileDisplay` (the stored `profile_display`
projection) uses the same labels.

### Agent-driven brief updates (project_profile_patch)

The agent keeps the brief current by emitting a `project_profile_patch` card
(via `emit_card`) whenever the conversation establishes a durable hard fact —
the shallow-researcher prompt has an explicit "Keeping the Project Brief
current" policy, and the card model carries the canonical fact-key vocabulary
(`PROFILE_FACT_VOCABULARY` in `cards/models.py`, mirroring the intake
definition). The card only proposes: the user's Accept posts the JSON-Patch to
`POST /api/projects/{id}/profile/patches`, which normalizes bare values into
full fact objects (`source: 'user_confirmed'` — accepting IS the confirmation),
applies them through the shared patch engine, and prunes unknowns the patch
just answered. `GridCards` receives the chat store's `projectId` in both the
chat bubble (`AgentResponse.tsx`) and the research report (`ReportTab.tsx`), so
Accept is live wherever the card renders.

Summary generation: the intake wizard fires
`POST /api/projects/{id}/generate-summary` → backend `/v1/generate-summary`
(`frontends/aiq_api/.../routes/generate_summary.py`, registered in `plugin.py`)
→ result stored into `profile_display.summary`.

### The bug that was fixed (summary wiped on every save)

`buildProjectProfileDisplay` used to hardcode `summary: ''`, so every profile
save/patch blanked the AI summary; only the intake wizard regenerated it, so any
chat-driven profile edit permanently lost the prose. **Fix**: the function now
takes a `previousSummary` and both callers (`profile/route.ts`,
`profile/patches/route.ts`) pass the current `profile_display.summary` through,
preserving it across rebuilds.

Operational note: `/v1/generate-summary` fails silently (swallowed try/catch on
both ends) if the `aiq_api` process has no LLM key. Ensure `OPENROUTER_API_KEY`
(or `SUMMARY_LLM_API_KEY`) is set, else the summary stays empty even though the
fact-sheet renders.

## 6. Files, documents & RAG

- **Upload**: `POST /api/documents/upload` streams the file to MinIO **server-side**
  via `s3Client` (internal endpoint), records a `documents` row, then presigns a
  GET URL and hands it to backend `/v1/ingest` as `file_ref`. Because the backend
  consumes that URL from **inside** the Docker network, it correctly uses the
  **internal** endpoint.
- **Preview / download**: `/api/documents/{id}/preview` and `/download` presign a
  GET URL for the **browser** to fetch.

### The bug that was fixed (PDF preview/download broken)

Preview/download presigned with the internal `MINIO_ENDPOINT=http://minio:9000`,
which the browser cannot resolve — so both silently failed. **Fix**:
`src/lib/s3.ts` now exposes a second `signingS3Client` bound to
`MINIO_PUBLIC_ENDPOINT` (browser-reachable; defaults to `http://localhost:9000`
in dev), and the preview/download routes sign with it. The upload route keeps the
internal client (its URL is backend-consumed). Compose sets `MINIO_PUBLIC_ENDPOINT`.

### Folders

Nested folders are fully supported (self-referential `project_folders.parent_id`,
`folder-service.ts` builds the nested path, the API accepts `parentId`, and the
tree renders recursively). The prior "can't nest" symptom was **UX only** — there
was no per-folder affordance. **Fix**: `folder-tree-pane.tsx` now shows an "add
subfolder" `+` on each folder row and makes root creation explicit.

### Collection scoping (multitenancy)

Every backend call carries a base64url `X-Grid-Collection-Scope` header =
`[oib_knowledge, proj_<id>, s_<conversation>]`, built in
`src/lib/collection-scope-request.ts` and validated backend-side. This is the core
RAG multi-tenant boundary. Note `resolveProjectCollectionName` short-circuits to
no project scope when `session.organizationId` is falsy (anonymous /
`REQUIRE_AUTH=false`).

### Document summaries & `available_documents` (SQL side-table, distinct from the vector index)

Two separate stores back "documents" and are **architecturally distinct**:
the **ChromaDB vector index** that `knowledge_search`/`knowledge_retrieval`
queries (what's actually retrievable), and a **SQL `summaries` side-table**
(`SummaryStore`, `src/aiq_agent/knowledge/summary_store.py` + `factory.py
get_available_documents_async`) that is the **sole source** of the
`available_documents` list (file name + summary, optionally tags) rendered
into agent prompts and shown in the Data Sources panel. A document could
previously end up fully ingested and retrievable via `knowledge_search` yet
**absent** from `available_documents` — see "Silent summary-row loss on
double LLM failure" below for the fix that closed the practical case of
this.

`available_documents` is fetched **once per turn**, in
`chat_researcher/register.py` (~lines 530–581), aggregated across the
collections in the request's header-based scope (or the base + session
collection fallback when no scope header is present) and deduplicated by file
name. The same list is then shared by the shallow, clarifier, and deep-research
paths for that turn — it is not re-fetched per node.

**Prompt gating asymmetry — fixed 2026-07-16 (`77a4d7a`)**: the deep-research
prompts (`agents/deep_researcher/prompts/planner.j2`,
`agents/deep_researcher/prompts/orchestrator.j2`,
`agents/deep_researcher/prompts/researcher.j2`, and
`agents/deep_researcher/prompts/source_router.j2`) used to gate document
*awareness* purely on `available_documents` being non-empty, unlike the
shallow researcher's unconditional "use `knowledge_search` first" instruction
(`agents/shallow_researcher/prompts/researcher.j2:31`). The document
*listing* block is still wrapped in `{% if available_documents %}` (nothing
to list when the summaries table has no row), but `planner.j2` and
`researcher.j2` now separately instruct the agent to probe `knowledge_search`
unconditionally whenever the query concerns project/user content — "do this
regardless of whether the ... list below is empty or missing" — explaining
that the list "comes from a summaries index that can lag ingestion and
silently omit fully-ingested documents", so an empty/missing list is never
treated as proof no project documents exist. Combined with the reconciliation
backfill below, the list itself should now rarely be wrong in practice, but
the prompt-level distrust remains as defense in depth.

**Silent summary-row loss on double LLM failure — fixed 2026-07-16**:
ingestion (`sources/knowledge_layer/src/llamaindex/adapter.py`, ~lines
1795–1965) runs summary generation and tag classification as two concurrent
calls to the same `summary_llm`; both independently swallow
exceptions/timeouts and return `None` on failure. Previously the
deterministic, text-derived fallback summary only kicked in when `not
summary and tags and text_documents` — i.e. only when tag classification
succeeded but summarization did not — so when **both** calls failed, no
`summaries` row was ever written even though the file's chunks were embedded
successfully and the file was already `FileStatus.SUCCESS`. Two fixes landed
together:

1. **Fallback ungated (`7bc5cc7`)**: `register_summary()`'s fallback now
   fires whenever the LLM summary is missing and `text_documents` exist,
   independent of tag success, and reads a wider source sample (first + last
   chunk) so a sparse first chunk can't starve it.
2. **Reconciliation backfill (`42a4fa3`)**: `reconcile_collection_summaries()`
   (knowledge-layer factory) runs at the end of every `LlamaIndexIngestor`
   ingestion job — the Knowledge API, `scripts/ingest_oib.py`'s `oib_sync`,
   and any future caller get it for free. It diffs a collection's indexed,
   successfully-ingested files (`BaseIngestor.list_files`) against the
   `summaries` table and registers a deterministic fallback summary for any
   gap, logging a WARNING per backfilled document (a gap still means the
   primary summary path failed silently — this is a backstop, not a silent
   fix). Backends may optionally expose `get_document_text_sample()` to give
   the fallback a real text sample; `LlamaIndexIngestor` does, reading chunk
   text back out of Chroma.

Together these implement backlog T3-10's cure (reconciliation pass +
ungating `fallback_summary_from_text` from tag success) and make "ingested ⇒
visible in `available_documents`" hold for every ingestion path — a document
that finishes ingestion always gets a `summaries` row, either from the
primary LLM path or, on backfill, from the reconciliation pass. The two
stores remain architecturally distinct (SQL side-table vs. ChromaDB vector
index), so this is a structural backstop rather than a merge of the two
sources — see backlog T3-10 for the closed status and rationale.

### Multimodal & visual/vector-drawing ingestion

`_run_ingestion` (`adapter.py`) extracts content from a PDF along four
independent tracks, then indexes every resulting `Document` chunk and derives
the document summary:

1. **Text** — `_extract_text_from_pdf` (pdfplumber), per page. Licence/watermark
   boilerplate lines (e.g. `VECTORWORKS EDUCATIONAL VERSION`) are removed by
   `_strip_watermark_lines` **before** indexing and before the visual-page
   heuristic, so a drawing that is pure linework plus a stamped watermark does
   not read as "has text".
2. **Tables** — `_extract_tables_from_pdf` (pdfplumber), gated on
   `extract_tables`.
3. **Embedded raster images** — `_extract_images_from_pdf` (pypdfium2 image
   XObjects) → `_analyze_image_with_vlm`, gated on `extract_images`/
   `extract_charts`. This only sees **raster** images embedded in the page.
4. **Rendered visual/vector pages** — `_render_visual_pdf_pages`, gated on
   `AIQ_RENDER_VISUAL_PAGES` (default on) **and** a resolvable VLM key. This is
   the track that captures **vector CAD/architectural drawings** (plans,
   sections, elevations, perspectives): they are thousands of vector *path*
   objects with almost no text and **no embedded raster image**, so tracks 1
   and 3 both miss them entirely. The whole page is composited into one bitmap
   (`page.render`, scaled so the long edge ≈ `AIQ_PAGE_RENDER_MAX_DIM` px,
   default 2048) and sent to `_analyze_drawing_page_with_vlm` with a
   drawing-aware German prompt that returns a structured description (drawing
   type, Maßstab/scale, rooms/elements, spatial relationships, and a
   one-sentence summary), parsed by `_parse_drawing_fields`. A page is routed
   here only when its watermark-stripped text is below
   `AIQ_VISUAL_PAGE_MIN_TEXT_CHARS` (200) **or** it has ≥
   `AIQ_VISUAL_PAGE_MIN_PATHS` (300) vector paths — so ordinary text PDFs (the
   bulk OIB corpus) skip the VLM at near-zero cost — and at most
   `AIQ_MAX_RENDERED_PAGES` (20) pages are rendered per document.

The drawing prompt returns a rich structured block — drawing type, Maßstab,
Nutzung, Räume/Elemente, Materialien/Bauweise, räumliche Beziehungen, and a
multi-sentence `DETAILBESCHREIBUNG` — stored as the chunk body. Because it is a
normal chunk it is **embedded and retrievable/citable by `knowledge_search`**,
so the agent can answer detailed questions about a drawing (materials, storeys,
circulation) that used to have no indexed content at all. The same descriptions
are browsable by the user, second to the one-line summary: `get_document_visual_details`
reads the visual chunks back from Chroma and the file-preview pane's collapsible
**"Detailed information"** section lazy-loads them (`GET /api/documents/{id}/visual-details`
→ `GET /v1/collections/{c}/documents/{f}/visual-details`).

**Summary sourcing (why the summary no longer describes the watermark).** The
document summary + tag LLM calls are started **after** visual extraction. For a
text-sparse drawing PDF the near-empty page text is replaced by the aggregated
rendered-page descriptions as the summary/tag input, and if the summary LLM
fails, `_summary_from_drawing_fields` synthesises a deterministic, watermark-free
summary from the parsed drawing fields. The result: an image-only architectural
PDF is summarised as e.g. *"Perspektivischer Schnitt durch einen
fünfgeschossigen Bildungsbau …"* instead of *"VectorWorks Educational Version is
a version of VectorWorks software …"*. The shared summary prompt
(`document_classification.summarize_document_text`) is also domain-aware and
explicitly instructed to ignore watermark/software boilerplate.

**Org BYOK + runtime model override for the VLM.** The vision model used across
all four tracks is resolved the SAME way the NAT chat models resolve theirs.
`/v1/ingest` forwards `x-grid-organization-id` (the BFF's `dispatchIngest` sets
it) into the job config; because `_run_ingestion` runs in a detached thread pool
with no request context, the org id must be captured at the request boundary and
carried in the config. From it the ingestor resolves, per job:
`resolve_vlm_credential(org_id)` (org BYOK key + base URL, else the deployment
env chain) and `_resolve_vlm_model_override(org_id)` (the org's `ingest_vlm`
model override, `AgentGroup.INGEST_VLM`). The resolved `(model, base_url,
api_key)` is threaded into every VLM call site. Org-agnostic base-corpus sync
(`oib_sync`) carries no org id and gets the deployment default, unchanged. Org
admins select the model in the model-config picker (`ingest_vlm` group, gated to
vision-capable models); see `docs/architecture/org-model-configuration.md`.

> Scope note: this lives in the **LlamaIndex** ingestor. The `foundational_rag`
> backend shares the summary prompt (`summarize_document_text`) but not yet the
> page-render track — a known follow-up if that backend is used for drawing PDFs.
> Embeddings BYOK is likewise still a follow-up (needs an embeddings-capable BYOK
> endpoint).

### Document thumbnails

The file-explorer card grid shows a 200px-wide JPEG thumbnail when available,
falling back to the content-aware SVG sketch (`DocumentKindThumbnail`).

**Generation flow:**
1. The BFF upload route (`dispatchIngest` in `service.ts`) derives a thumbnail
   MinIO key from the original file's key (replaces the filename with
   `_thumb.jpg`) and generates a presigned **PUT** URL for it.
2. The PUT URL is passed to the backend's `/v1/ingest` as
   `thumbnail_upload_url`.
3. During ingestion (`_run_ingestion` in `adapter.py`), after a file is
   indexed and marked SUCCESS, `_generate_and_upload_thumbnail` renders:
   - **PDFs**: page 0 via `pypdfium2` → PIL → 200px JPEG quality 80.
   - **Images**: PIL open → RGB → 200px JPEG quality 80.
4. The JPEG bytes are PUT to MinIO via the presigned URL.

**Serving:**
- `GET /api/documents/{id}/thumbnail` → `getDocumentThumbnail()` presigns a
  browser-facing GET URL for `_thumb.jpg`. Returns `{ url: string | null }`;
  `null` means no thumbnail exists (non-PDF/image, or generation failed).

**Frontend:**
- `ThumbnailWithFallback` (file-browser-pane.tsx) and
  `ArchivThumbnailWithFallback` (archiv-library-pane.tsx) lazily
  `GET /api/documents/{id}/thumbnail` on mount, render the real image when
  a URL comes back, and fall back to the SVG sketch on error or missing
  thumbnail.

Thumbnails are ephemeral: there is no separate DB column — the key is derived
deterministically from `minioKey`, and a missing/expired MinIO object falls
back gracefully to the SVG sketch. Re-ingesting a document overwrites the
thumbnail at the same key.

## 6b. Norm catalog (Normenregister — flat curated pointers + prose legal notes)

The live `ris_search` tool is keyword-blind: an LLM planner guesses one of ~40
OGD-RIS application silos plus German statutory terms, and a wrong guess yields
"No documents found". The norm catalog (ADR-0025 v2) removes the guesswork for
the core building-law corpus. It is deliberately **flat** — the typed-graph
variant (ranks/roles/editions/relations, Punkt chunking, applicability DSL) was
built, adversarially reviewed, and reduced; ADR-0025's Context records why.

**The three data planes** (how the Baurecht-Wien source diagram maps onto the
system — each plane has its own storage, admin surface, and priority):

| Plane | Holds | Lives | Managed via | Priority rule |
|---|---|---|---|---|
| **Catalog** | verified RIS pointers, prose legal facts (`binding_note`), open TODOs (`review_note`), non-RIS stubs (MA 37, ÖNORM) | norm store (DB) seeded from `configs/norms/<cc>/registry.yml` | `/app/platform` norms editor + verify-and-pick | tells the agent *where law lives* and *what binds what* |
| **Corpus** | full norm texts inside the RAG (OIB PDFs today) | per-country base collection — `NormsFile.corpus_collection` (AT: `oib_knowledge`) | `/app/platform` Base-Knowledge upload/sync | requirements are cited from here (normative documents only) |
| **Project/parcel** | uploads incl. Flächenwidmungs-/Bebauungsplan (tag-classified at ingestion) | project collections in the RAG | project Files UI | **per-parcel source of truth**: `parcel_note` renders tagged plans into the researcher prompt as the governing source for Widmung/Bauklasse/Höhe — above OIB and Bauordnung |

Country expansion touches data, not architecture: a new
`configs/norms/<cc>/registry.yml` (catalog) + its `corpus_collection` (corpus)
+ a fetch adapter for that country's legal database (the RIS adapter is
Austria's). The org-Archiv stratum (ADR-0024) sits beside these unchanged.

- **Data** — `configs/norms/<country>/registry.yml` (env override
  `GRID_NORMS_DIR`; `at` ships 23 entries): per entry `id`, `title`, `short`,
  `rank` (bundesgesetz | landesgesetz | verordnung — RIS-backed law lanes —
  plus behoerdliche_info for non-RIS practice guidance with a plain
  `source_url`, e.g. the MA-37 Merkblätter, and norm_extern for
  ÖNORM/TRVB stubs without accessible full text),
  `bundesland` (canonical name, empty = federal), `topics`, `relevance`, the
  **verified** RIS pointer (application, document number, citation URL,
  entire-consolidated-law URL), optional `aliases`, `binding_note` (curated
  prose legal fact rendered into researcher prompts — e.g. how the WBTV makes
  the OIB-Richtlinien binding in Vienna, the KlGG lex-specialis rule),
  `review_note` (open verification TODO, surfaced only in the platform admin
  UI), and a `verify` seed (title query + disambiguation guards) for live
  re-verification. Austria: the nine state building codes, Wiener
  Garagengesetz, WBTV, Kleingartengesetz, and the federal acts (ASchG, AStV,
  BKAG, ZTG, WGG, DMSG, UVP-G, WRG, ForstG, GewO). Pointer index only: full
  texts still go through `ris_fetch_document`.
- **The OIB corpus is not in the catalog.** `data/oib/` → `oib_knowledge` is
  its own source of truth; what a corpus file *is* (Richtlinie / Leitfaden /
  Erläuterung / Begriffsbestimmungen / Zitierte Normen / Änderungsdokument)
  derives from the filename (`norm_registry.oib_doc_class`). The 15
  `aenderungen_*` diff files and the superseded `zitierte_normen` revision are
  excluded from retrieval via the knowledge tool's `exclude_file_names`
  config (a `file_name NOT IN [...]` filter on the base collection only —
  session/project collections are never filtered).
- **Storage & admin surface** — runtime source precedence: the admin-managed
  store, then the YAML seed, fail-open. `knowledge/norm_store.py` keeps one
  JSON row per country (same DB URL as the summary store), seeds itself from
  the YAML on first boot, and registers itself via
  `norm_registry.set_db_loader`. Backend API: `GET/PUT /v1/admin/norms`
  (optimistic versioning; validation errors returned explicitly) and
  `POST /v1/admin/norms/verify` (live OGD-RIS candidate search), guarded by
  `X-Admin-Token` like the OIB admin routes. Platform-owner UI on
  `/app/platform` (lane-grouped list, entry editor, verify-and-pick,
  `review_note` TODO queue); every write audited
  (`platform.norm_registry.updated`). `scripts/build_ris_catalog.py` re-verifies
  the YAML seed's pointers in place (merge-only; curated fields never
  clobbered).
- **Prompt rendering** — `render_block_for_prompt(project_context)` renders
  the doctrine-adjacent catalog block: Bundesrecht lane, the project's own
  Bundesland lane (other states' law is dropped — `focus_entries` semantics),
  the curated `binding_note` lines, a static OIB-corpus citation note, and the
  project applicability section (`applicability.render_project_block`). The
  Normenhierarchie doctrine itself is one constant (`NORM_DOCTRINE`) injected
  into the shallow-researcher, deep-researcher, planner, and writer templates
  as `{{ norm_doctrine }}`.
- **Jurisdiction** — `resolve_bundesland`: the validated envelope token wins
  (`ausserhalb_oesterreichs` → None is final), then the structured
  `bundesland=<token>` prompt fact, then free-text state-name probing.
  `focus_entries` drops other states' law and sorts the project's state first;
  the same rule filters `ris_search`'s catalog short-circuit and
  `ris_catalog_lookup` before truncation.
- **Applicability** — `common/applicability.py` is a small hand-written module
  (no DSL): OIB verdicts from project facts (mirrors the UI's
  `applicable-standards.ts`), German trigger hints for the four boolean intake
  facts (Kleingarten, Denkmalschutz, Betriebsanlage, Stellplatz), and the
  prompt section. The compliance checker scopes Stage 1 with it (verdicts
  `required`/`likely`/`check` all stay in scope; an explicit user scope is
  never narrowed).
- **Display tagging** — `lane_for_hit` / `citation_verification.source_lane`
  map a retrieval or citation hit to a stratum + lane label (Bundesrecht /
  Landesrecht / Verordnung via catalog rank; OIB lanes via filename class;
  Projektwissen / Büroarchiv / Web via collection origin) for the research
  fan-out UI. Deterministic tagging only — no chunk-metadata dependency.

## 7. Deep research (async jobs)

- The `deep_research` graph node submits a Dask job and returns the stub message
  **plus** a structured `deep_research_job_id` (added in this pass), threaded
  through `ChatResearcherState` → `ChatResponse.deep_research_job_id` → monkeypatch
  → `message.deep_research_job_id`.
- The frontend (`use-websocket-chat.ts`) opens the research panel from the
  **structured field** (`deepResearchJobId`), falling back to the old prose regex
  only for older backends. This fixes the fragile-regex failure where any wording
  drift silently hid the entire research panel.
- Job data (progress, thinking, citations, report) streams via SSE from backend
  `/v1/jobs/async/*` through the BFF proxy `/api/jobs/async/[...path]` into the
  `ResearchPanel` (Tasks / Thinking / Report tabs).

**Open items**: synchronous inline deep-research answers (no Dask) do not
carry Grid cards (§3; the async job path generates them post-hoc in the
runner). And the research tab can 403 — see §9.

**Collection-scope re-injection gap — now diagnosable (fixed 2026-07-16,
`f8093a0`)**: the `X-Grid-Collection-Scope` header is captured once at submit
time (`chat_researcher/register.py`) and threaded into the async job payload
as `collection_scope`. The Dask worker only re-injects it into its own
request context conditionally — `frontends/aiq_api/src/aiq_api/jobs/runner.py:641`
does `if collection_scope is not None:` before base64url-encoding it back
onto the header. When the scope is absent, `knowledge_retrieval` inside the
worker falls back to legacy config-based resolution (base collection +
session collection only — see `docs/technical-reference/collection-scoping.md`).
Because `project_collections` is `[]` in the shipped configs, project
collections are **never** searched in that fallback path for the affected
job. The fallback behavior is unchanged, but it is no longer silent: the
`elif` branch for `deep_research_agent` jobs now logs a one-time WARNING
(job id, whether the request looked authenticated/project-scoped) at exactly
the point the re-injection would otherwise be skipped.

**Durable checkpointing (backlog T3-8, 2026-07-16, `5bea711`)**: optional
LangGraph checkpointing for the deep-research graph, configured via
`deep_research_agent.checkpoint_db` (env `AIQ_DEEP_CHECKPOINT_DB`; unset by
default) — see §9's "Async deep-research jobs are not restart-safe" bullet
for the full mechanism and its manual-resubmit resume contract.

**Workflows (ADR-0023, 2026-07-16)**: saved per-project research briefs can
fire this same async pipeline on a cron schedule — a dedicated
`workflow-scheduler` container claims due rows in `grid_app`
(`FOR UPDATE SKIP LOCKED`) and fires through the BFF's internal endpoint into
`POST /v1/internal/workflows/submit` (internal-token-guarded wrapper around
`submit_agent_job`, so admission control and cost tracking apply unchanged).
See `docs/architecture/workflows.md`.

**Deep-research agent graph internals**: the orchestrator/planner/researcher/
writer middleware stack, structured-output contracts, and graph invariants
(concurrency, recursion limit, skill filesystem permissions) live in
`src/aiq_agent/agents/deep_researcher/README.md`. Its "Known limitations"
section covers the remaining open defects found by a source audit against the
installed `deepagents`/`langchain`/`langgraph` versions, several of which are
now fixed — summarized in §9 below.

**Compliance pipeline (backlog T4-3, 2026-07-16)**: `src/aiq_agent/agents/compliance_checker/README.md`
documents a separate, purpose-built alternative to running an OIB
Soll-Ist-Abgleich through this open-ended deep-research harness — see §8c.

## 8. Backend agent architecture & DRY debt

Registered agents (via NAT `@register_function` + `FunctionBaseConfig`):
`intent_classifier`, `chat_deepresearcher_agent` (entrypoint), `clarifier_agent`,
`shallow_research_agent`, `deep_research_agent` (+ eval/placeholder wrappers).

No shared base-agent class exists; four agent classes each repeat: tool
resolution/exclusion, `LLMProvider` construction, verbose/trace callback setup,
per-request data-source-filtered rebuild, tool-availability validation, and
prompt-loading fallbacks. Good shared primitives already live in
`src/aiq_agent/common/` (`llm_provider`, `data_source_registry`, `tool_validation`,
`prompt_utils`, `citation_verification`).

**Recommended (not yet implemented):** a `src/aiq_agent/common/agent_base.py`
providing `resolve_tools()`, `build_llm_provider()`, `with_tool_guard()`, a
prompt-loading mixin, and an eval-wrapper factory — collapsing the duplication
without touching the genuinely agent-specific LangGraph node logic. This is a
refactor that should be verified against a running stack before merge.

### Project memory (implemented)

The agent can now persist curated findings across turns. Full design:
`docs/architecture/project-memory-design.md`. Key facts:

- **Single-writer**: the `grid_app` DB has exactly one writer, the Next.js BFF.
  The backend `remember` tool never touches the DB — it POSTs to the internal
  BFF endpoint `POST /api/internal/memory`
  (`frontends/ui/src/app/api/internal/memory/route.ts`), authenticated by the
  shared service token `GRID_INTERNAL_API_TOKEN` (`x-grid-internal-token`
  header; the route fails closed with 503 when the token is unconfigured).
  Backend client: `src/aiq_agent/knowledge/project_memory.py` (base URL from
  `FRONTEND_INTERNAL_URL`, default `http://frontend:3000`).
- **Two scopes**: the `project_memory` table has a `scope` column —
  `project` (requires `projectId`) or `organization` (org-wide, requires
  `organizationId`, `projectId` null).
- **Read path**: `buildProjectMemoryDigest()`
  (`frontends/ui/src/lib/projects/memory-service.ts`) merges org-wide +
  project items (active only; pinned first, then most recently updated,
  bounded), tags each line with scope/kind/confidence/verification, and the
  digest rides the WS upgrade as the `x-grid-project-memory` header
  (`server.js` → `src/aiq_agent/project_context.py`), injected into prompts
  alongside `x-grid-project-context`.

## 8b. Runtime model overrides & usage metering (2026-07-07)

Two org-level runtime systems sit on top of the static workflow config —
full specs in `org-model-configuration.md` (ADR-0014) and
`usage-budgets.md` (ADR-0015); summary of the backend seams:

- **Model overrides**: `x-grid-model-overrides` (base64url JSON
  `{agentGroup: openrouterModelId}`) is parsed by
  `src/aiq_agent/common/model_overrides.py` and applied request-scoped:
  `LLMProvider.with_model_overrides()` (group-tagged roles; identity when
  nothing applies) in the shallow/deep/clarifier `_run` closures, plus
  `apply_model_override()` at the intent-classifier invocation, the
  clarifier planner, and the reflection scheduling site. Async jobs carry
  the map through `submit_agent_job` → `jobs/runner.py` (provider + header
  re-injection). Only the model id changes; params/keys stay from YAML. When
  no header/envelope carries the map (e.g. the generic async-job proxy before
  2026-07-16, or any future endpoint the BFF doesn't front),
  `get_model_overrides_from_context()` falls back to a just-in-time org-side
  resolution against the BFF's internal `GET /api/internal/model-overrides`
  — see `docs/architecture/org-model-configuration.md`'s submission-paths
  table. The **ingestion VLM** (`ingest_vlm` group) rides the same machinery
  from a detached thread: `/v1/ingest` captures the org id into the job config
  and the ingestor resolves the override (and BYOK credential) by org id — see
  §6 "Multimodal & visual/vector-drawing ingestion".
- **Cost capture (DRY)**: `src/aiq_agent/common/cost_tracking.py` installs
  `GridCostTracker` through LangChain's `register_configure_hook` ContextVar
  seam — every callback manager configured inside the request picks it up,
  so agents contain no metering code. Activated in exactly three places:
  the chat workflow `_run`, the Dask job runner, and the reflection task.
  Events (model, tokens, OpenRouter `usage.cost`, generation id) POST to
  the token-guarded `POST /api/internal/usage` (single-writer rule).
- **Budgets**: `x-grid-budget` carries remaining USD per scope
  (org/member/project); the tracker raises `BudgetExceededError` before the
  next LLM call once exhausted (sync path returns a friendly chat response);
  the BFF refuses the WS upgrade outright when already over. A separate,
  per-run **completion-token** ceiling (backlog T4-4, 2026-07-16) —
  `GRID_MAX_RUN_COMPLETION_TOKENS`, default `0` = disabled — bounds one job's
  total output tokens across every LLM call including concurrent researcher
  workers (`BudgetGuardCallback`, `src/aiq_agent/common/budget_guard.py`),
  independent of the USD budget ledger.
- **Phase progress events** (backlog T4-4, 2026-07-16): `PhaseProgressCallback`
  (`aiq_api.jobs.phase_events`) observes the deep-research orchestrator's
  existing task-dispatch and `run_research_batch` callback events to detect
  planning/research/writing/citation-verification/done transitions, without
  any change to the `deep_researcher` package itself, and persists each as a
  `job.phase` `job_events` row on the existing SSE stream. The UI status pill
  consumes these to show live progress instead of staying silent for the
  first minutes of a run.

## 8c. Compliance-check pipeline (backlog T4-3, 2026-07-16)

`src/aiq_agent/agents/compliance_checker/` is a separate, **deterministic**
3-stage pipeline for the OIB Soll-Ist-Abgleich (requirements-vs-evidence
compliance check) — the structured alternative to running the same check
through the open-ended `deep_research_agent` (which the audit that opened
T4-3 measured at ~300 LLM turns / 20+ minutes for the same job). Stage 1
derives applicable requirements per Richtlinie (one structured LLM call each,
grounded by tool-free `knowledge_search` retrieval against the base OIB
collection); Stage 2 checks project-document evidence per batch of ~8-10
requirements (one structured LLM call each); Stage 3 assembles the compliance
matrix, ranks gaps by risk, and renders a German Markdown report — pure
Python, no LLM calls. A full 6-Richtlinien check is ~10-25 LLM calls total,
bounded and predictable.

Registered as the `compliance_check` function (`_type: compliance_check_agent`)
in `configs/config_oib_openrouter.yml`, backed by a dedicated `compliance_llm`
role and the `aiq_compliance_checker` `nat.plugins` entry point
(`pyproject.toml`). **Not yet invoked by any chat/workflow entry point** — the
function is registered and directly callable, but no orchestrator node, slash
command, or UI action calls it yet, so it needs a live shakedown before
user-facing use. See `src/aiq_agent/agents/compliance_checker/README.md` for
the full stage design, budget math, and its own still-open known limitation
(`AgentGroup` has no dedicated member for this pipeline's model overrides
yet).

## 9. Known issues / open items

- **Research tab 403** — origin is `requireAuthorizedSession()` throwing
  `Unauthorized` in the BFF proxy (`/api/jobs/async/[...path]`), mapped to 403 by
  `backend-proxy.ts` when there is no WorkOS session at request time (auth
  required + missing/expired cookie). A secondary candidate is the backend
  `require_verified_principal()` under `REQUIRE_AUTH=true`. Distinguish by the
  error code: `FORBIDDEN` (frontend) vs `BACKEND_ERROR` (backend). Note
  `requireAuthorizedSession()` also `redirect()`s no-org users, which is invalid
  inside an API route — a latent bug for users without an organization. **Needs
  runtime evidence to fix safely; do not guess-patch auth.**
- **Deep-research cards** — not delivered on the async path (§3/§7).
- **Silent LLM failures** — card generation and summary generation both swallow
  exceptions; consider surfacing a degraded signal to the UI. Document-ingestion
  summary/tag generation used to be the sharpest instance of this (a double LLM
  failure left a document permanently invisible) — that specific consequence is
  fixed (§6, "Silent summary-row loss on double LLM failure"); the LLM calls
  themselves can still fail silently, just without the visibility consequence
  anymore.
- **`available_documents` vs. ChromaDB divergence — mitigated 2026-07-16** —
  the SQL summaries side-table that feeds `available_documents` can still, in
  principle, diverge from what's indexed in ChromaDB (they remain
  architecturally distinct stores), but the reconciliation backfill (§6) now
  closes every gap the double-LLM-failure case could produce, and the
  deep-research prompts no longer gate document *awareness* on the list being
  non-empty (§6) — only the *listing* still is, which is cosmetic once the
  list itself is reliable.
- **Async job collection-scope fallback — fixed 2026-07-16 (`f8093a0`)** —
  `collection_scope` is still only re-injected into the Dask worker context
  when present (behavior unchanged: absent scope still drops
  project-collection search for that job, §7), but the degradation is no
  longer silent: `runner.py` logs a one-time WARNING (job id, whether the
  request looked authenticated/project-scoped) at the point it would
  otherwise skip re-injection, so the gap is diagnosable from logs instead of
  invisible.
- **Deep-research tool-result pruning defeats prompt-prefix caching — fixed
  2026-07-16 (`0b5d29d`)** — `ToolResultPruningMiddleware` now records
  truncation per message id and freezes it once applied (monotonic), instead
  of recomputing a positional keep-last-N window from scratch on every model
  call — message bytes at a given offset no longer shift turn over turn, so
  the ~80k-token contexts a deep run accumulates stop invalidating
  OpenRouter/DeepSeek prompt-prefix caching on that axis. Trivial results
  (`think`, `ls`) no longer occupy window slots — only oversized results do.
  It still runs uncoordinated with deepagents' own (stable-cutoff)
  summarization middleware, and no call site sets provider prompt-caching
  hints yet (that's a separate, still-open lever — see
  `docs/architecture/llm-providers.md` and `scaling-review-2026-07.md` §6.1).
  Model-call retries were narrowed in the same change: `ModelRetryMiddleware`
  now retries only rate limits, timeouts, transport errors, and 5xx (was any
  exception). See `src/aiq_agent/agents/deep_researcher/README.md`
  "Known limitations" for details.
- **Deep-research strict structured-output schema bounds — fixed 2026-07-16
  (`2db0f7d`)** — `EvidenceJudgment.relevance_score` (`ge=0`/`le=100`) and
  `ResearchQuery.preferred_tools` (`min_length`) used to compile to
  JSON-Schema `minimum`/`maximum`/`minLength`, unsupported in strict
  `json_schema` mode on some providers. Both are now
  `field_validator(mode="after")` checks instead of declarative bounds:
  `relevance_score` clamps out-of-range values (a worker returning 105
  degrades to 100 instead of failing) while `preferred_tools` still raises on
  empty (no tool name to invent). `ResearchNotes`/`ResearchPlan.model_json_schema()`
  no longer emit `minimum`/`maximum`/`minLength`/`maxLength`/`pattern`
  anywhere in the nested tree. `tools/research.py`'s fenced-JSON fallback
  parser remains as a second line of defense for non-conformant completions
  in general. See the same README section.
- **Deep-research planner ceremony overhead** — deepagents' `StateBackend`
  is write-once (a second `write_file` to an existing path errors; recovery
  is via `edit_file`); the planner prompt mandates `write_todos` before
  decomposing. As of the 2026-07-16 prompt pass (`77a4d7a`) the todo-list
  ceremony is optional rather than mandatory, the planner's after-every-search
  `think` call is consolidated into a single pre-finalize `think`, and
  orchestrator `write_todos` updates are phase-level instead of per-step —
  reducing but not eliminating pure-ceremony LLM turns per planning run.
- **NAT step-tree/span corruption after a retried call — root cause fixed
  2026-07-16 (`6e57c08`)** — the log warnings `Step id ... not the last step
  in the stack` / `span ID stack is not equal` had two causes. (1) NAT's
  `LangchainProfilerHandler` (`nat/plugins/langchain/callback_handler.py`,
  `nvidia-nat==1.7.0`) implements `on_llm_start`/`on_tool_start` etc. but no
  `on_llm_error`/`on_tool_error`, so an errored (then retried) model or tool
  attempt never closed its intermediate-step span, corrupting the stack for
  every later step — this is now fixed by
  `SpanClosingProfilerHandler` (`src/aiq_agent/common/nat_step_repair.py`), a
  local subclass adding `on_llm_error`/`on_tool_error` overrides that push
  the matching `END` event, mirroring the installed handler's
  `on_llm_end`/`on_tool_end` construction field-for-field. (2) The remaining
  cause is NOT a bug: the deep-research pipeline legitimately runs sibling
  steps concurrently (parallel researcher workers, batched source-tool
  fan-out), which NAT's single-chain step model cannot represent — those
  residual warnings are deliberately suppressed (raised to `ERROR` level,
  `src/aiq_agent/common/logging_utils.py`) rather than fixed, since the steps
  themselves are still recorded correctly. `run_id`-keyed token/cost
  accounting (§8b) was never corrupted by either cause.
- **Shared trace-callback state across concurrent researcher workers — fixed
  2026-07-16 (`de67efd`)** — `VerboseTraceCallback` mutates per-run state
  (`current_input`, `active_chains`, `depth` — `common/callbacks.py`);
  `for_new_run()` already gave each deep-research *run* a fresh instance
  (`DeepResearcherAgent._prepare_run()`, ADR-0018), but that one instance was
  then shared as a single `callbacks` entry across every concurrent
  researcher *worker* inside the run (up to `max_research_concurrency`,
  default 6). `_run_research_query` (`tools/research.py`) now builds a
  per-worker callbacks list via `cb.for_new_run()` (falling back to the same
  instance for callbacks without it) before each `researcher_runnable.ainvoke()`
  call — the outer/batch-level callbacks list itself is untouched. This
  applies uniformly to both the sync chat path and the async job runner
  (both go through the same `_run_research_query`), so `runner.py` building
  one `VerboseTraceCallback()`/`LangchainProfilerHandler()` per job (not per
  worker) no longer means those workers race on shared state.
- **Async deep-research jobs are not restart-safe — mitigated 2026-07-16
  (`5bea711`, backlog T3-8)** — the deepagents graph's `store=InMemoryStore()`
  (longterm memory) is unchanged, but `build_deep_research_graph` now accepts
  an optional `checkpointer` (per-thread execution state, an independent axis
  from `store`) passed through to `create_deep_agent`. When
  `deep_research_agent.checkpoint_db` is configured (env
  `AIQ_DEEP_CHECKPOINT_DB`; unset by default, opt-in since jobs run in
  ephemeral Dask worker processes — the reference config sets it to
  `./deep_research_checkpoints.db`), `DeepResearcherAgent.run()` wires
  `configurable.thread_id = job_id` and `durability="async"` (LangGraph's
  canonical durable-execution mode for long batch-style runs), so a worker
  crash no longer silently loses all execution state — the checkpointed
  thread survives. **Resume is manual-resubmit-based, not automatic**:
  `submit_agent_job` still rejects a duplicate `job_id`
  (`DuplicateJobIdError`), and `run()` always passes the full initial state
  rather than `None`, so a resubmitted call layers new input onto the
  checkpointed thread via the state schema's reducers rather than continuing
  exactly from the interrupted step — there is no automatic queueing/resume
  entry point yet, and the ghost-job reaper (ADR-0021,
  `scaling-review-2026-07.md` §2.4) still flips an orphaned `RUNNING` row to
  `FAILURE` after its timeout. A future DB-claimed-worker migration
  (ADR-0021) fixes replica pinning/cross-node cancel but is orthogonal to
  this checkpointing layer.
- Infra: live secrets in `deploy/.env`; backend DBs have no migration mechanism
  (init only); config drift between the two config files.

## 10. Verification workflow

The host's `npm install` hangs, so verify in containers:

- **Frontend typecheck (fast, no NGC auth):**
  ```
  cd frontends/ui
  docker build -q -f Dockerfile.typecheck -t grid-tsc .   # deps layer caches
  docker run --rm grid-tsc                                 # runs tsc --noEmit
  ```
  Note: tsconfig includes test files, so spec type errors block the production
  `next build`.
- **Backend:** `.venv/Scripts/python.exe -m py_compile <files>` and
  `.venv/Scripts/ruff.exe check <files>` (uv hangs on cross-filesystem sync here).
- **Full stack / runtime:** the `.devcontainer` (VS Code, `deploy/Dockerfile`
  target `dev-builder`, NGC auth required) or `docker compose … up -d --build`.
  Runtime-behavioural changes (deep-research cards, agent refactor, research 403)
  must be verified here before merge.
