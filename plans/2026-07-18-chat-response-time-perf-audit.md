# Chat Response-Time Performance Audit — 2026-07-18

> Systematic analysis of response-time (latency) optimization opportunities on
> the **interactive chat critical path** of the `aiq_agent` backend. Produced by
> a 6-dimension fan-out (LLM topology, retrieval/RIS, citation post-processing,
> I/O round-trips, concurrency/streaming, prompt/token construction), with every
> candidate **adversarially verified against the real source** for (a) being
> genuinely on the synchronous path a user waits on and (b) carrying **no feature
> regression**. 19 findings verified, **15 confirmed**, 4 rejected.
>
> **Hard constraint honored throughout:** every recommended change is
> latency-only or strictly behavior-equivalent. No feature is removed or altered.

## The critical path

A chat turn is WebSocket-only:

```
server.js (WS proxy) → NAT workflow chat_deepresearcher_agent
  per-turn setup (register.py _run): collection scope, project context + live
    memory digest, available-documents aggregation, session citation registry
  → LangGraph (agent.py): intent_classifier ─ meta ─┐
                                              ─ shallow → shallow_research → (escalate?) clarifier
                                              ─ deep  → clarifier → deep_research (async job, SSE)
  → answer buffered → verify_citations → sanitize_report → citation-registry persist
  → streamed to the client as incremental deltas + a terminal frame (cards/sources)
```

**meta and shallow turns are the most latency-sensitive** — the user waits
synchronously for the answer. (Note: `intent == "meta"` routes to the shallow
agent, *not* to `END`; the only `→ END` edge is the `error` degradation path.
Two candidate findings were rejected for assuming otherwise.) Deep research is an
async, SSE-streamed job and far less TTFT-sensitive.

**Already landed** (excluded from this audit): `asyncio.gather` of the
memory-digest fetch and available-documents aggregation; concurrent
per-collection summary loading; end-to-end streaming of the final answer;
dedicated `ris_planner_llm` at `reasoning_effort:none`; 1.5s memory-digest
timeout.

## Ranked findings (impact-to-effort)

Ranked by the verifier's *revised* win/effort/risk. Three finding-pairs were
merged as duplicates across dimensions.

| # | Optimization | Win | Effort | Regression risk | Path |
|---|--------------|-----|--------|-----------------|------|
| 1 | Stop double-sending shallow tool descriptions (bound schema **and** prompt prose) | Medium | Small | Low | meta + shallow |
| 2 | Shorten intent-classifier routing tool list (drop full docstrings) | Medium | Small | Low | 100% of turns |
| 3 | Gate the RIS Normenkatalog block on `requires_sources` (skip on meta) | Medium | Small | Low | meta |
| 4 | Batch the `doc_class` N+1 queries and move them off the event loop | Medium | Small | **None** | shallow/deep |
| 5 | Fire-and-forget the citation-registry persist (off the TTFT path) | Medium | Small | Low | shallow/deep |
| 6 | Fold session-registry hydration into the existing `gather` (in a thread) | Low | Small | Low | all (cold cache) |
| 7 | Parse the `GridRequestContext` envelope once per turn | Low | Small | **None** | all |
| 8 | Load the norm registry once per turn (wire serialization) | Low | Small | Low | shallow |
| 9 | Reuse a pooled keep-alive client for the memory-digest fetch | Low | Small | Low | all |
| 10 | Cache the static base-corpus `AvailableDocument` list | Low† | Medium | Low | all |
| 11 | Hoist per-iteration shallow context rebuild out of the tool loop | Low | Medium | Low | shallow |
| 12 | Overlap available-documents aggregation with the intent LLM call | Low | Medium | **Medium** | all |

† Medium only under a large corpus on a remote/loaded Postgres.

### 1. Stop double-sending shallow tool descriptions
- **Where:** `shallow_researcher/prompts/researcher.j2:99` (Available Tools loop); bound schemas at `shallow_researcher/agent.py:250`.
- **Change:** render tool **names only** (`- **{{ tool.name }}**`), drop `: {{ tool.description }}`. Keep the `{% if tools %} … {% else %}No research tools available.{% endif %}` branch. Do **not** touch `bind_tools` or `_build_tools_info`.
- **Why it's a win:** the same descriptions are already sent authoritatively via the OpenAI `tools` API field (`bind_tools`); the prose is a second copy of ~2.5–3.5k tokens (`emit_card`'s card catalog alone is ~1.1k). The prose sits **below** the KV-cache boundary (`researcher.j2:89`), so it is uncached and re-paid on every call and every tool-loop iteration (up to 5×), including plain greetings.
- **Why it's safe:** tool-calling is driven by the bound schemas, not the prose; every prompt reference to tools is by name/capability. No test asserts descriptions in the rendered prompt.

### 2. Shorten the intent-classifier routing tool list
- **Where:** `chat_researcher/register.py:296` (tools_info build; reused for `non_registry_tools_info` at `:310`); rendered at `intent_classification.j2:35`.
- **Change:** build each tool's `description` as a short one-line blurb — prefer the data-source registry's short description (the same text the pinned-sources path already renders via `format_data_source_tools`), else the first sentence of the tool's own docstring. Keep exact `name` values and the `{name, description}` shape.
- **Why it's a win:** the classifier is the graph entry node — the first LLM call on **100% of turns**, at `reasoning_effort:none`, so latency is prefill-dominated. The full agent docstrings (~1600 tokens; ris_search alone ~1.5–2KB) render below the KV-cache boundary (`j2:25`) and are re-prefilled every turn. The prompt itself labels the list "routing context only." Also fixes the pinned-sources path, where `remember` still carries its full docstring today.
- **Why it's safe:** routing depends on tool *purpose/presence*, not argument syntax; the pinned-sources path already routes correctly on short descriptions. `remember`'s blurb stays non-empty so memory-request routing is preserved.

### 3. Gate the RIS Normenkatalog block on `requires_sources`
- **Where:** `shallow_researcher/agent.py:219-221` (unconditional `ris_catalog`/`norm_doctrine`/`parcel_note` compute); guards at `researcher.j2:36,115,118`.
- **Change (Python):** pass `ris_catalog=None` / `norm_doctrine=None` / `parcel_note=None` when `not state.requires_sources`; compute as today otherwise. No `.j2` edits — each block already has a truthiness guard.
- **Why it's a win:** meta/greeting turns (most latency-sensitive) stop prepending the ~1400–1500-token norm catalog they never consult; the Python gate also skips the `load_registry()` read + `render_project_block()` compute.
- **Why it's safe:** `requires_sources` is the deterministic meta-vs-research signal the agent already trusts (drives the marker mandate). Strictly subtractive for meta turns; research turns keep everything verbatim; no new cache prefix variant.

### 4. Batch the `doc_class` N+1 queries and move them off the loop
- **Where:** `knowledge_layer/src/register.py:406` (`_resolve_doc_classes`), called from `_format_results:525` inline at `:671`; backed by `summary_store.py:432 get_doc_class` (engine `pool_pre_ping=True`).
- **Change:** add `summary_store.get_doc_classes_batch(collection, filenames)` (one `… WHERE collection=:c AND filename IN (…)` per distinct collection, 1–3 total), replicating the truthy-only coercion so precedence stays byte-identical; add a factory seam; rewrite `_resolve_doc_classes` to group by collection; wrap the `_format_results` call at `:671` in `await asyncio.to_thread(...)`.
- **Why it's a win:** collapses ~10 serial blocking Postgres round-trips (5 docs × 2, incl. the `pool_pre_ping SELECT 1`) into 1–3, off the event loop — ~20–50ms of loop-blocking per `knowledge_search`, ×tool-loop iterations; also unblocks concurrent turns.
- **Why it's safe (regression risk = None):** same rows, same precedence, byte-identical output; only statement count and thread change. Fail-open preserved via per-collection try/except.

### 5. Fire-and-forget the citation-registry persist
- **Where:** `chat_researcher/register.py:829-835` (awaited `to_thread(persist_session_registry, …)` in `finally`); body at `citation_verification.py:418-436`.
- **Change:** replace the awaited call with a **guarded** fire-and-forget mirroring `schedule_memory_reflection` (`reflection.py:352-358`): a coroutine that runs the persist in a thread and swallows/logs exceptions, held by a strong reference in a module-level `_persist_tasks` set with an `add_done_callback` discard. **Not** the naive `create_task(to_thread(...))` (drops the swallow, can be GC'd).
- **Why it's a win:** removes one Dragonfly `SET` RTT (~1–5ms typical, up to the 0.5s socket timeout when slow) from time-to-first-token on every source-capturing shallow turn. Meta turns already early-return (empty registry).
- **Why it's safe:** persistence is documented best-effort/fail-open (ADR-0020 recovery preserved); it reads the module dict, not the contextvar reset in `finally`; nothing downstream reads the result.

### 6. Fold session-registry hydration into the gather
- **Where:** `register.py:788` (serial sync `get_or_create_session_registry` after the `:784` gather); backed by `cache.py:118 client.get` (0.5s socket timeout).
- **Change:** add `asyncio.to_thread(get_or_create_session_registry, conversation_id)` as a third `gather` coroutine; unpack `session_registry`; delete `:788`. Keep `set_session_registry` (`:789`) and the card-registry binding (`:793-795`) inline on the loop (contextvar mutations).
- **Win / safety:** overlaps a cold-cache Dragonfly `GET` with digest+documents I/O and takes it off the loop (warm LRU hits return before any I/O). Idempotent, `threading.Lock`-guarded, no contextvar reads — timing-only.

### 7. Parse the `GridRequestContext` envelope once per turn
- **Where:** `register.py:613-618,635` (5× `from_context()` in `_load_project_context`) + `register.py:576,730` (duplicate collection-scope decode); `project_context.py:265-355`.
- **Change:** call `ctx = GridRequestContext.from_context()` once and read all fields off it; reuse the `_collection_scope` computed at `:576` inside `_load_available_documents` instead of re-decoding at `:730`. Do **not** swap the scoping-header call for the envelope's `collection_scope` (different normalization).
- **Win / safety (regression risk = None):** collapses ~5 base64+HMAC-SHA256+JSON parses of a ~6KB payload plus one duplicate decode into one each; identical values, only parse count changes. The docstring already instructs calling `from_context()` once.

### 8. Load the norm registry once per turn (wire serialization)
- **Where:** `citation_verification.py:961,978` (`source_lane` + `binding_note_for_entry`, each calling `load_registry()` for RIS URLs) driven from `shallow_researcher/agent.py:554`.
- **Change:** add an optional `registry=_UNSET` sentinel param to both functions; in `source_entry_to_wire` compute `is_ris` once and `load_registry()` once, passing it to both → N loads instead of 2N. Optional full collapse to 1/turn: memoize the DB branch of `load_registry` keyed on the version `store.get()` returns, invalidated by `reset_registry_cache`.
- **Win / safety:** eliminates uncached, loop-blocking DB round-trips + full pydantic re-parses of the norm catalog. Registry is static within a turn; byte-identical output; fail-open preserved.

### 9. Pooled keep-alive client for the memory-digest fetch
- **Where:** `knowledge/project_memory.py:131` (`fetch_memory_digest`, `_opener.open`); invoked from `register.py:623-625`.
- **Change:** module-level `requests.Session` (requests is installed, httpx is not; its urllib3 pool is thread-safe for the `to_thread` call). **Critical:** keep `allow_redirects=False` **and** call `raise_for_status()` to preserve the current "non-2xx → fail-open to frozen digest" semantics. Leave `_opener` for the other two callers.
- **Win / safety:** saves one TCP handshake RTT per turn (sub-ms compose-local, larger if BFF is remote/TLS); same GET/endpoint/headers/timeout/fail-open.

### 10. Cache the static base-corpus `AvailableDocument` list
- **Where:** `register.py:717-769` → `factory.py:353` → `summary_store.py:508 get_all_async`.
- **Change:** version-keyed result cache for the **static base collection only** (`STATIC_RESULT_CACHE_COLLECTIONS`, default `oib_knowledge`); never cache the session collection. Prefer a summary-store-local version counter bumped inside the five mutation methods (avoids the `bump_collection_version` gap and an import cycle); if reusing `collection_version`, carry a TTL. Store immutable/deep-copied lists.
- **Win / safety:** eliminates one collection `SELECT` + O(rows) JSON decode per turn — but runs concurrently with the 1.5s-capped digest, so it's the tall pole only for a large corpus. Session uploads still appear next turn; hit returns an identical set.

### 11. Hoist per-iteration shallow context rebuild out of the loop
- **Where:** `shallow_researcher/agent.py:211-225` (`agent_node` render block).
- **Change:** compute the invariant blocks (`ris_catalog`, `norm_doctrine`, `parcel_note`, the `available_documents` dump) once per `run()`. **Concurrency constraint:** `self._graph` is shared across concurrent runs, so stash the precomputed value on `ShallowResearchAgentState` (not the instance/closure) and keep an inline fallback for the standalone graph-direct path.
- **Win / safety:** saves a directory glob + stats + ~23-entry sort + 2 `model_dump`s/doc per iteration; dominated by the seconds-scale LLM call. Byte-identical rendered prompt.

### 12. Overlap available-documents aggregation with the intent LLM call
- **Where:** `register.py:775-784` (gather blocks on both loads) vs `intent_classifier.py:187-194` (never reads `available_documents`).
- **Change:** await only `_load_project_context()` before the graph; launch `_load_available_documents()` as a task (via `asyncio.ensure_future` while request context is live) and await/merge it inside the intent-classifier node after the LLM returns — covering **all** classifier return paths. Do not stash the task in the pydantic state (breaks checkpoint serialization) or an instance attribute (shared classifier).
- **Win / risk:** hides only the *overhang* of doc aggregation beyond the digest fetch behind one `reasoning_effort:none` LLM call — zero when docs finish first. **Regression risk medium** (a missed return path renders a partial/None document list downstream), which is why it ranks last and is **not** in the first implementation batch.

## Rejected (correctly — would regress features or rest on a wrong premise)

- **Unbind search tools / strip source blocks on meta turns.** Meta turns explicitly include identity/ability questions ("can you search RIS/web?", "what did I upload?"); the model answers those from the tool list and the document/norm blocks. Stripping them changes genuinely-meta answers, and unbinding tools removes a misclassified-as-meta research query's ability to still search. Not latency-only.
- **Skip the ris_search nested planner.** The planner rewrites the query into statutory *Suchworte*; skipping it sends different terms to RIS and changes recall — a behavior regression the finding itself conceded.
- **Defer available-documents load past intent routing (as "meta never uses it").** Wrong premise: `intent == "meta"` routes to the shallow agent, which *does* render `available_documents`. Deferring would also lose the existing `gather` overlap — a potential latency *regression*.
- **Drop `sanitize_report`'s re-normalization as pure idempotency.** The `_append_minimal_citation` fallback injects a fresh `**References:**` section that never passed the normalizer; skipping the pass would leave it un-rewritten. Impact is sub-ms anyway.

## Implementation plan

**First batch (this PR) — the meta/shallow TTFT wins, all small-effort and
regression-free:** #1, #2, #3, #4, #5, #7. Together they strip the largest
uncached prompt bloat off the two hottest LLM calls, collapse the retrieval
N+1, and take two cache round-trips off the synchronous path.

**Deferred:** #6, #8, #9, #10, #11 are safe but lower-value/more surface; #12
carries the only medium regression risk and is intentionally excluded from an
automated "no-regression" batch.
