# Piloti Feedback Backlog — 2026-07-21 (source: `260721_Feedback_Piloti.md`)

> Fresh triage of colleague ("Piloti") feedback. **Captain/architect model:** the
> orchestrator plans + reviews; exploration (Sonnet/Haiku) and implementation
> (Opus) run in delegated subagents; web research is mandatory for anything not
> current in pretraining (NAT/AIQ, LangGraph, LLM anti-hallucination patterns).
>
> **Triage doctrine (question the feedback):**
> - `SERVER` — attributable to the undersized server; user says a bigger server
>   is coming. **Do not chase.** (e.g. "loses connection to server".)
> - `MODEL` — DeepSeek being a weak LLM (hallucinations). Not "fix the LLM", but
>   *logic* levers exist (stricter grounding, better model routing, verification).
> - `UI` — user will do UI themselves; touch only gradually / when logic is dry.
> - `LOGIC` — real code bug or bad design. **Primary focus.**
> - `PRODUCT` — needs product/spec decision; flag, don't build blind.
>
> Verdicts are re-verified against **current** code (app advances fast) before any
> build. `VERIFY` = a subagent is checking whether the claim still holds.

## Ranked backlog (logic-first)

### P0 — Direct semantic search (user's biggest pain point, clarified 2026-07-21)

- **PB-18 — Semantic DOCUMENT SEARCH in the FILE BROWSER (Dateien page).**
  Class: LOGIC/FEATURE. **Top priority per user.** (Clarified 2026-07-21: this is
  NOT a chat/agent feature and NOT related to the LLM loop — it lives in the file
  browser.) The user types a query in the Files page → we embed it and query the
  vector DB (Chroma) DIRECTLY over their OWN uploaded documents (project
  `proj_<uuid>` + org Archiv `archiv_<orgId>`) → results are DOCUMENT-centric:
  the matching files reordered/filtered by semantic relevance, each showing the
  best-matching snippet + page so the user can jump to the file. Pure vector
  search — no LLM, no DeepSeek, sub-second. Reuse the existing embedder +
  `knowledge_layer.search()` + collection scoping + the Files-page components
  (`project-file-workspace.tsx`, `archiv-workspace.tsx`) + snippet/preview. New:
  document-centric backend search endpoint, BFF route + service, a search box in
  the file browser (design-system components only). Status: **DONE** — backend
  (`POST /v1/collections/{c}/search`, aggregation, retriever singleton) + frontend
  (explicit-run transparent search box, banner/loading/reset, per-hit snippet+page+
  relevance %, fail-open) landed & pushed. tsc/eslint clean; 67 FE + 2385 BE tests.

### P0 — Trust chain / core "it works" bugs (verify, then fix)

- **PB-1 — Deep research aborts ("DeepResearch bricht ab").**  Class: LOGIC.
  Baseline pytest shows **2 hard failures**: `AgentEventCallback._emit_artifact()
  got multiple values for argument 'content'` at
  `frontends/aiq_api/src/aiq_api/jobs/callbacks.py:723`. `source_entry_to_wire`
  always returns a `content` key (`citation_verification.py:994`) and the call
  site passes `content` positionally **and** `**wire` → guaranteed `TypeError`
  on every real citation source. CONFIRMED code bug. Impact: citation-source
  emission crashes in deep research → sources vanish and/or job errors.
  Status: **DONE (Sprint 1)** — `fix(deep-research): stop citation-source emit
  crashing`. Backend suite 2021 passed / 0 failed (was 2 failed).

- **PB-2 — Sources missing in the output card ("Teilweise fehlen Quellen").**
  Class: LOGIC. Likely same root cause as PB-1 (citation artifacts crash before
  emit). Status: **RESOLVED BY PB-1** — the emit `useful` filter already
  includes `source_type == "knowledge_layer"`; the TypeError crash was hiding all
  sources. With the crash fixed, KB/RIS sources flow into the feed again.

- **PB-3 — "Ask Your Data" (Büroarchiv + Projektunterlagen durchsuchen) doesn't
  work.**  Class: **WORKS AS INTENDED — not a code bug.** Verified: retrieval is
  correctly wired (`collection-scope-request.ts` → signed `x-grid-collection-scope`
  → `knowledge/scoping.py` → `knowledge_layer/register.py` fans out across
  project+archiv collections). Empty results were a *downstream symptom* of the
  PB-4/PB-5 Archiv-ingest crash (empty collection) or no active project / disabled
  `organization-archiv` flag (config). **Action:** none in code; retest after
  PB-4/5 fix reaches the deployed build. Question-the-feedback: complaint real to
  the user, but caused upstream, not in retrieval.

- **PB-4 — Indexing/Tagging of uploaded documents doesn't work.**  Class: REAL
  BUG — **ALREADY FIXED at HEAD** (`86b7231`, today). Same root cause as PB-5:
  a stale `minioKey` binding threw a `ReferenceError` in the Archiv ingest
  dispatch *after* the object/row committed, so `/v1/ingest` was never reached →
  no chunk/embed/summary/tags. Fixed. **Action:** none; colleague was on an older
  build — ask them to retest current build.

- **PB-5 — Archiv upload not possible ("Hochladen … noch nicht möglich").**
  Class: REAL BUG — **ALREADY FIXED at HEAD** (`86b7231`). `lib/archiv/service.ts:115`
  now passes `storageKey` (was undefined `minioKey`). The 500 the user saw fired
  after storage+row commit, so files were stored but ingest never ran. **Action:**
  none; retest current build. Downstream ingest pipeline verified well-formed.

- **PB-6 — Uploaded files can't be deleted ("lassen sich … nicht mehr
  löschen").**  Class: **REAL BUG — feature never built.** No DELETE route/service/
  UI for *project* documents; Archiv delete IS fully built and is the mirror
  template (`deleteArchivDocument` + route + two-step `DeleteDocumentButton`).
  Status: **DONE (Sprint 1)** — mirrored archiv delete end-to-end; tsc + specs green.

### P1 — Output quality logic (not "fix DeepSeek", but real levers)

- **PB-7 — Hallucinated citations in Baurecht answers.**  Class: MODEL+LOGIC.
  User: fabricated quotes on real sections; Opus is correct on the same
  question. Logic levers: stricter citation-faithfulness verification (verify
  the *quoted text* actually exists in the cited passage, not just that the
  section exists), grounding guard, model routing. Needs WEB RESEARCH on 2026
  citation-faithfulness patterns for weak models. Status: **Sprint 3 — IN
  PROGRESS** (deterministic difflib quote-vs-chunk verification, whole-registry,
  fail-open inline annotation, caps confidence w/ reason `quote_unverified`).

- **PB-8 — Result card too long / repeats project parameters / says
  "Empfehlung".**  Class: LOGIC (prompt + post-processing). Baurecht "Empfehlung"
  wording is a liability concern. Verbosity + param-repetition is a prompt/render
  concern. Status: VERIFY (agent: researcher-pipeline / prompts).

- **PB-9 — Confidence score is hard to understand; needs a reason.**  Class:
  LOGIC (+small UI). Surface a short justification for the confidence level.
  The chip exists (FB-6 history); extend the signal to carry a reason. Status:
  **FOLDED INTO PB-7** — the quote-verification wiring caps confidence to "low"
  with a machine-readable reason (`ungrounded` | `quote_unverified`), which is the
  visible justification this item asks for.

- **PB-10 — Clarifying questions ("Rückfragen") not asked before answering.**
  Class: LOGIC/VERIFY. Feedback says Piloti doesn't ask for missing parameters
  first; prior backlog claims the clarifier is "done". Question it — is it wired
  but not triggering? Status: VERIFY.

### P2 — Data / adapters

- **PB-11 — RIS API adapter connection often lost.**  Class: SERVER? / LOGIC?
  Could be network (server) or missing retry/resilience/caching in the RIS
  adapter. Verify adapter resilience (timeouts, retries, cache fail-open).
  Status: VERIFY.

- **PB-12 — WBTV Wien not retrievable (RIS holds annex texts as titles only, not
  full text).**  Class: DATA/PRODUCT. The full annex text must be deposited in
  the norm registry / base corpus. Flag: needs the source documents. Status:
  PRODUCT (data acquisition) — a person adds the WBTV Anlagen full text to the
  OIB corpus (existing ingestion path); `wbtv` registry entry already exists
  (`configs/norms/at/registry.yml:298`). **Plus one latent code bug** (fix per
  "errors" rule): `norm_registry.py:530` + `ris_adapter/register.py:574` use
  `elif entry.source_url` so a populated `source_url` is silently dropped when
  `full_law_url` is set — blocks attaching a direct annex link. 2-line fix.

- **PB-13 — Finer data-source selection (only OIB / only a specific
  Landesbauordnung).**  Class: LOGIC/FEATURE, "keine Prio". Relates to source
  scoping + FB-5 web allowlist. Status: BACKLOG (low prio).

### P3 — Identity / localization

- **PB-14 — System-prompt identity too narrow ("OIB Research Agent").**  Class:
  LOGIC/CONTENT. Broaden to: AI assistant for internal office knowledge, Baurecht,
  and technical guidelines. Small, high-visibility. Status: VERIFY (find prompt).

- **PB-15 — Project Briefing stays English even after switching to German.**
  Class: LOGIC (i18n). The AI-generated briefing/summary likely ignores the UI
  locale. Find the generation path; pass language. Status: VERIFY.

### P4 — Vision / plan understanding (mostly MODEL + heavy)

- **PB-16 — Plan/Vision understanding is rudimentary; corrupt text output; reads
  legend not the graphic.**  Class: MODEL + LOGIC. Partly VLM quality (server/
  model), partly logic (watermark/garbage text leaking into summaries — there is
  an `AIQ_RENDER_VISUAL_PAGES` path). Check the corrupt-text leak specifically;
  the rest is model/product. Status: **Sprint 3 — IN PROGRESS (real bug).**
  The vector-drawing path already strips watermarks, but the GENERIC image-caption
  path (`_analyze_image_with_vlm`) has no watermark exclusion and its caption
  becomes the summary verbatim → CAD licence stamps leak as "corrupt text".
  Fix: watermark-exclusion in the caption prompt + substring scrub before caption
  becomes summary. (Pixel-level plan understanding remains MODEL/PRODUCT.)
  Status: **DONE** — `fix(ingest): stop watermark/licence text corrupting image
  captions`; full suite 2393 pass, regression test included.

### Deferred — UI (user owns) / PRODUCT / SERVER
- UI: header/typo unification, chat centering, top buttons, border removal, logo,
  color-coding off-topic vs Baurecht, decision-chain animation, larger preview,
  Archiv nav "back to project", role explainer text. → **user owns UI**; revisit
  gradually only if logic backlog empties.
- Citation/quote **click-through preview** (open source, show cited table/section):
  structured locators exist (FB-4 history) — verify end-to-end; the *viewer* is
  UI. Logic part (locators on the wire) may need a fix → folded into PB-2.
- SERVER: connection loss, 60–180s latency (partly config → PB-17 if a logic
  lever appears).
- PRODUCT: Wizard entry questions redesign, Bebauungsplan vision extraction,
  decision-path cards, upload cost/limits, Workflows.

## Sprint log
See `feedback_piloti_log.md`.
