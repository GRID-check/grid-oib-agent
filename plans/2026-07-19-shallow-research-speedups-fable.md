# Shallow Research Answer-Generation — Speed Opportunities (2026-07-19)

> Latency-only analysis of the shallow (and meta) chat turn, built on the
> touch-point map (`plans/2026-07-19-shallow-research-answer-generation-touchpoints.md`)
> and de-duplicated against the broad audit
> (`plans/2026-07-18-chat-response-time-perf-audit.md`). Every anchor below was
> verified against the live source. **No change proposed here removes or alters
> a feature** — each finding states why it is behavior-equivalent.
>
> **Audit status check (verified in source):** audit items #1 (tool-description
> dedup, researcher.j2:97-106), #2 (classifier blurbs), #3 (norm-block gating on
> `requires_sources`, agent.py:227-229), #4 (batched doc_class + `to_thread`,
> knowledge register.py:406/684), #5 (fire-and-forget registry persist,
> chat register.py:920), #7 (envelope parsed once in `_load_project_context`,
> chat register.py:700) have **landed**. #6, #8, #10, #11, #12 are **still open**.

## Ranked summary (impact-to-effort)

| # | Finding | Cadence | Win | Effort | Risk | Overlap w/ 07-18 audit |
|---|---------|---------|-----|--------|------|------------------------|
| 1 | Memoize the norm-store DB loader — every `load_registry`/`get_country_profile` call is a sync DB SELECT + full pydantic re-parse **on the event loop**, hit up to ~15×/turn | per-iteration ×4 + per-knowledge-search ×2 + per-RIS-tool ×1 + per-RIS-source ×2 | **High** (total + TTFT; also unblocks concurrent turns) | Small-Med | Low | Extends #8 — the per-iteration prompt path, knowledge_search path, RIS-tool path, and country-profile path are **new** |
| 2 | Reuse one `TavilySearch` client — rebuilt every call ⇒ new TCP+TLS handshake per web search | per web_search call | Medium (~20–150 ms/call) | Small | Low | New (audit didn't cover tools) |
| 3 | Move RIS `html_to_text` (BeautifulSoup over up to 10 MiB) off the event loop | per ris_fetch (cache miss) | Medium tail (100 ms–seconds; unblocks the loop) | Small | Low | New |
| 4 | Hoist per-iteration invariants out of `agent_node` (catalog/doctrine/parcel blocks, doc dumps, per-iteration envelope re-parse) | per-iteration | Medium before #1, Small after | Medium | Low | Audit #11, still open — **severity upgraded** by the DB-loader discovery; the per-iteration `from_context()` re-parse is new |
| 5 | Hoist `bind_tools` out of `agent_node` (tool-schema conversion per iteration) | per-iteration | Small (~1–5 ms/iter) | Small | Low | New |
| 6 | Pre-split content blocks in `_extract_title_for_url` (O(urls × content) re-split) | per-tool-result | Small-Med on URL-heavy outputs | Small | Low | New |
| 7 | `source_entry_to_wire`: 1 registry load per turn instead of 2 per RIS source | per cited RIS source | Small (subsumed by #1) | Small | Low | = Audit #8 (still open) |
| 8 | Run `ris_catalog_lookup` / ris_search catalog shortcut matching off the loop | per catalog-tool call | Small after #1 | Small | Low | New (mostly subsumed by #1) |
| 9 | Fold session-registry hydration into the per-turn gather | per-turn (cold cache) | Small (≤0.5 s worst case) | Small | Low | = Audit #6 (still open, unchanged) |
| 10 | Single-pass verify+sanitize normalization (dedup `_normalize_citation_syntax` + section find + layout normalize) | per-turn | **Small** (~1–5 ms CPU) | Medium | Low-Med | New detail; audit already rejected the naive version — see constraints |
| 11 | Non-findings & micro items (remember, emit_card, markers/DSML, `all_sources()` ×4, RIS search JSON parse) | — | negligible | — | — | — |

**Recommended batch:** #1, #2, #3, #5 (all small, regression-free, biggest wins).
Then #4 + #7 + #8 together (they share the "registry is static within a turn"
invariant), then #6, #9. #10 only if profiling ever shows it matters (it won't
at current report sizes).

---

## 1. Memoize the norm-store DB loader (the hidden per-call DB round-trip)

**Anchors:**
- Loader registration: `src/aiq_agent/knowledge/norm_store.py:318-345` (`configure_norm_store` → `_loader` = `store.get()[0]`, **no caching**); store read: `norm_store.py:161-183` (SELECT of the full ~15 KB JSON blob + `NormsFile.model_validate` of 23 entries).
- Registered unconditionally in production by the knowledge tool: `sources/knowledge_layer/src/register.py:615-617`.
- Consumers on the shallow path, all **synchronous on the event loop**:
  - `src/aiq_agent/common/norm_registry.py:311-326` `load_registry()` → `_db_loader()` on **every call** (the mtime-keyed `_load_yaml_cached` LRU only covers the YAML fallback branch — with the store registered it is bypassed);
  - `norm_registry.py:434-447` `load_norms_file("at")` → `_db_loader()` on **every call**, called by `country_profile.get_country_profile` (`src/aiq_agent/common/country_profile.py:81-97`).
- Call sites and cadence (verified):
  - `shallow_researcher/agent.py:227-229` — per **iteration** on research turns: `render_block_for_prompt` (1× `load_registry` + 1× `get_country_profile` for the corpus note, norm_registry.py:564-577) + `doctrine_for` (1× `get_country_profile`, :456-466) + `parcel_note` → `_parcel_tags_for` (1× `get_country_profile`, :600-609) ⇒ **up to 4 store reads per iteration**, ×≤5 iterations.
  - `sources/knowledge_layer/src/register.py:249-254` — `_resolve_base_collection` calls `get_country_profile` **twice** per `knowledge_search` call.
  - `sources/ris_adapter/src/register.py:435` (ris_search catalog shortcut) and `:633` (`ris_catalog_lookup`) — 1× `load_registry` per call.
  - `common/citation_verification.py:877` (`source_lane`) and `:908` (`binding_note_for_entry`) — **2× per cited RIS source** during wire serialization (agent.py:562).

**Cadence & where the time goes:** A single 2-iteration research turn with one
knowledge_search, one catalog lookup, and two cited RIS sources performs
**~15 identical store reads**: each is a blocking SQLAlchemy SELECT (DB RTT:
sub-ms on local SQLite, 5–50 ms on remote/loaded Postgres) plus a JSON decode +
full pydantic validation + `_validated_entries` re-scan (~2–10 ms CPU) — all on
the event loop, stalling every concurrent turn while it runs.

**Proposed change (latency-only):** memoize inside `configure_norm_store._loader`
(one seam fixes every consumer):
- Cache `(NormsFile, version)` in-process with a short TTL (30–60 s), and bust
  the cache in `NormRegistryStore.put()` for same-process admin writes (put
  already computes the new version). Optionally also add an
  `functools.lru_cache`-style memo on `get_country_profile` keyed on
  `(country, norms_file identity)` since `with_overrides` is pure.
- Strictly-equivalent variant (if any staleness is unacceptable): a
  per-turn/contextvar memo scoped like the session registries — the registry is
  already treated as static within a turn (audit #8's premise).

**Why behavior-equivalent:** the catalog is admin-edited, static data; every
consumer already fails open and already tolerates the YAML path's process-lifetime
mtime cache. Same-process writes invalidate immediately; cross-replica admin
edits appear within the TTL instead of the next call — indistinguishable from
today's cross-replica propagation through the summary-DB anyway (there is no
push invalidation today either). No output changes.

**Win:** High — removes ~10–200+ ms of loop-blocking DB/CPU per research turn
(scales with DB distance), and removes the per-iteration stall multiplier.
**Effort:** Small-Medium. **Risk:** Low.
**Overlap:** extends audit #8 (which saw only the wire-serialization 2N loads and
assumed the YAML cache made the rest cheap). The prompt-render, knowledge_search
`_resolve_base_collection`, and RIS-tool paths are new findings.

## 2. Reuse one Tavily client (pooling) — plus an explicit timeout knob

**Anchors:** `sources/tavily_web_search/src/register.py:100-112` (`tavily_kwargs`
built and `TavilySearch(**tavily_kwargs)` constructed inside `_tavily_web_search`,
i.e. **per call**); invoke at `:122`; retry loop `:120-171`.

**Cadence & where the time goes:** per web_search call (per-tool-result path).
Every call builds a fresh `TavilySearch`, which constructs new sync+async Tavily
clients and a new httpx pool ⇒ a fresh TCP + TLS handshake to api.tavily.com on
every search (~20–150 ms depending on egress), plus client-construction CPU. No
connection reuse across the up-to-3 in-tool retries' successors or across calls.

**Proposed change (latency-only):** `tavily_kwargs` depends only on
`tool_config` (constant after registration) — hoist the `TavilySearch(...)`
construction to the registration closure (module/closure singleton, next to the
API-key check) and reuse it in `_tavily_web_search`. `TavilySearch.ainvoke` is
stateless per query (the query is passed per call), so this is byte-identical
behavior with connection keep-alive.

Secondary (flag, do not bundle): no HTTP timeout is configured — the tool
relies on the library default; a hung Tavily connection can hold the whole
`ToolNode` (and thus the turn) far longer than the retry backoff suggests.
Setting an explicit client timeout only changes behavior in the failure tail,
so treat it as a robustness knob, not part of the equivalence-safe batch.
**Do not** add a result cache: web-search freshness is user-visible behavior
(regression risk medium) — recommend against.

**Win:** Medium (per web-search call; web-heavy shallow turns often make 1-2).
**Effort:** Small. **Risk:** Low. **Overlap:** none — new (audit excluded tools).

## 3. RIS `html_to_text` off the event loop

**Anchors:** `sources/ris_adapter/src/client.py:524` (`title, text =
html_to_text(response.text)` inside `fetch_document_text`); the function itself
`:335-365` — BeautifulSoup `html.parser` (pure-Python) parse + full-text line
normalization; documents up to `max_document_bytes` = 10 MiB (`:384`).

**Cadence & where the time goes:** per ris_fetch call on a shared-cache miss
(first fetch of a law in 7 days per replica set). Parsing a full consolidated
law (hundreds of KB to MB of HTML) with `html.parser` is CPU-bound and takes
100 ms to multiple seconds — executed **synchronously on the event loop**,
freezing every other in-flight turn and the WS heartbeat for its duration.

**Proposed change (latency-only):** in `fetch_document_text`, wrap the
conversion: `title, text = await asyncio.to_thread(html_to_text, response.text)`.
`html_to_text` is a pure function of its input (no shared state), so this is
strictly behavior-equivalent; only the executing thread changes — exactly the
pattern the same package already uses for its cache (`cache.py:92/103`) and
ingestion (`register.py:822`). (Optionally, using `lxml` as the parser would cut
CPU 5-10×, but parser swap can change whitespace/edge-case extraction — keep it
out of the no-regression batch.)

**Win:** Medium on the tail (doesn't shorten the fetch itself much, but removes
seconds-scale loop stalls that inflate *other* concurrent turns and this turn's
follow-up steps). **Effort:** Small. **Risk:** Low. **Overlap:** none — new.

## 4. Hoist per-iteration invariants out of `agent_node`

**Anchors:** `src/aiq_agent/agents/shallow_researcher/agent.py:219-233` — every
iteration recomputes: `_documents_dump` (2 `model_dump`s per doc), the full
Jinja render (`prompt_utils.py:57-74`, compile is LRU-cached, render is not),
and on research turns `render_block_for_prompt` + `doctrine_for` + `parcel_note`
(the ~1400-token catalog block + the finding-#1 store reads). Additionally
`render_block_for_prompt` → `resolve_bundesland` (`norm_registry.py:397-414`) →
`GridRequestContext.from_context()` re-runs the base64 + HMAC-SHA256 + JSON
parse of the ~6 KB signed envelope **per iteration** (audit #7 fixed only the
chat-register call sites).

**Cadence & where the time goes:** per iteration (×≤5), CPU on the event loop;
with the DB loader active (finding #1) it is also 4 DB round-trips per iteration.

**Proposed change (latency-only):** compute once per `run()` and carry the
rendered blocks (`ris_catalog`, `norm_doctrine`, `parcel_note`,
`_documents_dump`) into `agent_node`. Concurrency constraint (from audit #11,
still valid): `self._graph` is shared across concurrent runs, so stash the
precomputed values on `ShallowResearchAgentState` (a private field defaulting to
None) with the current inline computation as fallback for the graph-direct
path. Inputs (`state.project_context`, `state.available_documents`,
`requires_sources`) are fixed for the life of a `run()`, so the rendered prompt
is byte-identical per iteration.

**Win:** Medium while #1 is unfixed (removes the per-iteration DB hits); Small
after (a few ms CPU + envelope parse per iteration). **Effort:** Medium (state
carrier + fallback). **Risk:** Low. **Overlap:** audit #11 (deferred there as
"Low" — the DB-loader discovery raises its standalone value; if #1 lands first,
#11's original Low rating stands).

## 5. Hoist `bind_tools` out of `agent_node`

**Anchors:** `shallow_researcher/agent.py:258` —
`self._get_llm().bind_tools(self.tools, parallel_tool_calls=True)` runs per
iteration; `self.tools` and the provider's role map are fixed at construction
(`llm_provider.py:90-109` is a plain dict lookup; the per-org override path
builds a **new agent instance** in `register.py:114-121`, so the bound object
cannot go stale).

**Cadence & where the time goes:** per iteration; `bind_tools` converts every
tool to its OpenAI JSON schema each call (7 tools incl. the large emit_card
catalog description) — pure CPU, ~1–5 ms per iteration on the loop.

**Proposed change (latency-only):** build
`self._llm_with_tools = self._get_llm().bind_tools(self.tools, parallel_tool_calls=True)`
once in `__init__` (next to `_build_graph()`), use it at `:258`. The
forced-synthesis branch (`:255`) keeps using the unbound `self._get_llm()`.
Identical request payloads; only when the conversion happens changes.

**Win:** Small. **Effort:** Small. **Risk:** Low. **Overlap:** none — new.

## 6. Pre-split blocks in `_extract_title_for_url`

**Anchors:** `src/aiq_agent/common/citation_verification.py:666-696`
(`_extract_title_for_url` re-runs `re.split(r"\n\n---\n\n|\n\n\n", content)`
over the **entire tool output for every URL**), called from
`_parse_generic_urls` `:699-716` per extracted URL; driven per-tool-result from
`agent.py:325`.

**Cadence & where the time goes:** per tool-result, on the event loop. For
Tavily (≤5 results) it's fine; for a `ris_fetch_document` result (up to 40 000
chars, parsed by the generic URL extractor since only "knowledge" has a
registered parser, `:767`) each embedded URL triggers a fresh full-content
split + 4-pattern scan of its block ⇒ O(urls × content) CPU, tens of ms on
URL-dense outputs.

**Proposed change (latency-only):** split the content into blocks **once** in
`_parse_generic_urls` and pass the block list to `_extract_title_for_url`
(keeping the same per-block `url in block` selection and identical
closest-preceding-title scoring). Same inputs, same outputs — only the repeated
`re.split` is eliminated. (A pre-compiled block→title-matches memo per block is
an equally safe second step.)

**Win:** Small-Medium on URL-heavy results, zero elsewhere. **Effort:** Small.
**Risk:** Low. **Overlap:** none — new (map called this "the heaviest per-result
path"; the audit never touched it).

## 7. `source_entry_to_wire`: one registry load per turn (audit #8, still open)

**Anchors:** `citation_verification.py:935-982` — per RIS entry, `source_lane`
(`:861-891`, `load_registry()` at `:877`) and `binding_note_for_entry`
(`:894-914`, `load_registry()` at `:908`) each load the registry; driven from
`shallow_researcher/agent.py:559-568` per cited source.

**Status & proposal:** unchanged from audit #8 (optional `registry` parameter on
both helpers; compute `load_registry()` once in `source_entry_to_wire`, or once
per turn at the agent.py:559 loop). With finding #1's memo in place this drops
from "N× DB round-trips" to "N× dict-hit", but the parameter-threading is still
worth it for the standalone-YAML deployment path. Byte-identical output;
fail-open preserved.

**Win:** Small (after #1). **Effort:** Small. **Risk:** Low.
**Overlap:** = audit #8; new information: with the DB loader registered the
pre-#1 cost is much higher than the audit estimated.

## 8. RIS catalog tools: keep the lookup off the loop

**Anchors:** `sources/ris_adapter/src/register.py:606-657`
(`_ris_catalog_lookup`: `load_registry` + `match_entries`/`focus_entries`
inline in the async fn, no `to_thread`); same pattern in the ris_search catalog
shortcut `:427-462`.

**Cadence & where the time goes:** per catalog-tool call. The matching itself
(23 entries × needles, `norm_registry.py:357-373`) is sub-ms; the real cost
today is the `load_registry()` DB read (finding #1). After #1, what remains is
trivially cheap.

**Proposed change (latency-only):** primarily fixed by #1. If #1 is deferred,
wrap the registry load + match in `asyncio.to_thread` (both are pure reads;
`load_registry` is already called from threads elsewhere via the knowledge
paths, and the store's engine cache is lock-guarded, `norm_store.py:63-98`).
Identical output.

**Win:** Small (post-#1: skip). **Effort:** Small. **Risk:** Low.
**Overlap:** none — new; noted in the map's cross-cutting section.

## 9. Session-registry hydration into the gather (audit #6, still open)

**Anchors:** `chat_researcher/register.py:877` — `get_or_create_session_registry`
still runs synchronously on the loop after the `:864-873` gather; cold-cache
path does a Dragonfly GET with a 0.5 s socket timeout
(`citation_verification.py:439-476`, `common/cache.py:65-66`).

**Status:** exactly as the audit specified (add
`asyncio.to_thread(get_or_create_session_registry, ...)` as a third gather
member; keep `set_session_registry` inline). Nothing new to add; listing it so
the still-open overlap is explicit.

**Win:** Small (first turn of a conversation per replica). **Effort:** Small.
**Risk:** Low. **Overlap:** = audit #6, unchanged.

## 10. verify_citations + sanitize_report duplicated normalization — honest assessment

**Anchors:** `_normalize_citation_syntax` runs twice per turn
(`citation_verification.py:1178` in verify, `:1468` in sanitize); the
`_REFERENCE_SECTION_RE.search` full-report scan runs in both (`:1196`, `:1477`);
`_normalize_source_section_layout` runs in both (`:1233`, `:1480`). Shallow
`run()` always calls them back-to-back (`agent.py:443` → `:527`).

**Cadence & where the time goes:** per-turn, pure CPU. On a realistic shallow
answer (1–8 KB) the duplicated regex work is **~1–5 ms total** — real but small.

**Proposed change (latency-only), with the equivalence constraints the audit
identified:** the naive "skip sanitize's re-normalization" was correctly
rejected (the `_append_minimal_citation` fallback at `agent.py:480` injects a
fresh `**References:**` section that never passed the normalizer, `:55-91`). A
safe single-pass version must instead have `verify_citations` **return** its
already-normalized `(body, ref_section)` split in
`CitationVerificationResult`, and give `sanitize_report` an optional
`pre_split=(body, ref_section)` parameter used **only** when the caller passes
verify's output through unmodified — the shallow path would pass it on the
`valid_citations`/empty-registry branches and fall back to today's full pass on
the `_append_minimal_citation` branch. Byte-identical by construction
(normalizers are idempotent on already-normalized input, and the fallback branch
keeps the full pass).

**Verdict:** correct but ~1–5 ms for a medium-effort refactor of the two most
subtle functions in the codebase. **Do last, or not at all** unless profiling
of very long deep-research reports (where the same pair runs) justifies it.
**Win:** Small. **Effort:** Medium. **Risk:** Low-Med (test surface is large).
**Overlap:** audit's rejected item #4 (rejection premise honored here).

---

## Per-tool coverage (Group G — all 7)

1. **web_search_tool (Tavily)** — finding #2 (per-call client rebuild = TLS
   handshake per call; no explicit timeout; deliberately **no** result cache —
   freshness is behavior). Retry backoff (`2**attempt`) is a feature, untouched.
2. **knowledge_search** — already the best-optimized tool: collection fan-out
   `gather` (register.py:672), retrieval off-loop (adapter.py:2428), embedding
   LRU (:2430-2448), static-result cache for `oib_knowledge` (:2487-2499),
   batched doc_class + `to_thread(_format_results)` (audit #4, landed :684).
   Remaining gap: `_resolve_base_collection` makes **2 country-profile store
   reads per call on the loop** (register.py:249-254) — fixed by finding #1.
   Session/project collections are intentionally never result-cached (feature).
3. **ris_search_tool** — catalog shortcut → shared cache → planner → API layering
   is sound; pooled httpx client + 30 s timeout + retries verified
   (client.py:400-451). Gaps: catalog-shortcut `load_registry` DB read on the
   loop (findings #1/#8); JSON `parse_search_response` BFS on the loop is small
   (page_size 20, ~sub-ms — no action). The planner LLM hop is a feature (audit
   correctly rejected skipping it).
4. **ris_fetch_tool** — two cache layers + ingest-marker + `to_thread` ingest
   verified. Gap: **`html_to_text` on the loop** (finding #3). The two
   sequential cache reads (doc + marker) are ~1 ms each via `to_thread` — no
   action.
5. **ris_catalog_lookup_tool** — fully local; gap: registry load + matching
   inline on the loop (findings #1/#8).
6. **remember** — validation is in-process; the BFF write is already
   `asyncio.to_thread(insert_memory_item)` (project_memory/register.py:141).
   **No opportunity.**
7. **emit_card** — fully in-process (`json.loads` → pydantic → registry add,
   cards/register.py:62-100). **No call-latency opportunity.** Its large
   catalog description ships in the bound tool schema every LLM call — a
   prompt-token cost, but it sits in the constant prefix ahead of the dynamic
   context, so provider KV-cache absorbs it on warm calls; shrinking it would
   alter the card-authoring contract (feature) — not proposed.

## Verified non-findings / micro items

- **dsml.py / markers.py** — `strip_and_salvage_dsml_tool_calls` bails on a
  marker substring check (dsml.py:163); marker detection scans only the 3-line
  tail region (markers.py:46-64). Negligible; no action.
- **`registry.all_sources()` ×4 per turn** (agent.py:438/443/449/452) — four
  list copies of a handful of entries; micro. A local `sources = registry.all_sources()`
  before the branch would be tidier but saves microseconds.
- **`_finalize_shallow_answer` defensive re-strip** (chat agent.py:112-113) —
  tail-regex on the final answer, negligible; the defensiveness is intentional.
- **Shallow `register.py:_run`** — `filter_tools_by_sources`, the identity-check
  agent reuse (:114), and `validate_tool_availability` are all cheap and
  per-turn; the agent rebuild on active overrides recompiles a small StateGraph
  (~ms) — acceptable, no action.
- **`get_model_overrides_from_context` etc. ×3 per turn** (shallow register.py:107-109)
  — three envelope reads per turn (~tens of µs each); could share one
  `from_context()` like audit #7 did in chat register, but the win is
  micro — fold into #4's cleanup only if touching the file anyway.
- **Streaming architecture** — the answer is fully buffered through
  verify/sanitize before the first delta by design (citations must be verified
  before display); "stream before verification" would change user-visible
  behavior and is out of scope.

## Suggested landing order

1. **#1** norm-store loader memo (one seam, biggest cross-cutting win).
2. **#2** Tavily client hoist + **#3** `html_to_text` to_thread + **#5**
   bind_tools hoist — three independent, small, provably-equivalent diffs.
3. **#4 + #7 + #8** as one "registry is static within a turn" PR.
4. **#6** title-extractor block hoist; **#9** (audit #6) alongside.
5. **#10** only with profiling evidence.
