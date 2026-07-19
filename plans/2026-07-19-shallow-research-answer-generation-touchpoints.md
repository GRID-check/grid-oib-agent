# Shallow Research Agent — Answer-Generation Touch-Point Map

> A scout of **every** touch point on the shallow research agent's answer-generation
> path — the code that runs from the moment a shallow/meta turn enters the agent to
> the moment a verified, sanitized answer (plus cards + sources) is returned. Touch
> points are grouped by layer, each with `file:line` anchors and a note on when it
> runs (per-turn / per-iteration / per-tool-result) and what it costs.
>
> Produced as the input for a follow-up **speed-optimization pass**. This document
> is an inventory only — it does not prescribe fixes.

## Cadence legend

- **per-turn** — once per `ShallowResearcherAgent.run()`.
- **per-iteration** — once per `agent_node` LLM turn; repeats up to `max_tool_iterations` (config: 5).
- **per-tool-result** — once per captured `ToolMessage` inside the tools node.

## The path at a glance

```
chat_researcher/register.py  (per-turn setup: project ctx, live memory digest,
   cross-collection available-docs, session citation registry)
 └─ chat_researcher/agent.py  shallow_research_node → builds ShallowResearchAgentState
                                (sets requires_sources from intent), calls run()
     └─ shallow_researcher/register.py _run  (tool filtering, per-org provider policy)
         └─ agent.py run()  → LangGraph:  agent_node ⇄ tools node   (loop ≤5)
             ├─ agent_node        : render system prompt + LLM.bind_tools().ainvoke()
             └─ tools node        : ToolNode.ainvoke() + per-result source capture
         └─ run() post-process (per-turn): DSML strip → marker strip → verify_citations
                                → sanitize_report → wire sources → structured signals
     └─ _finalize_shallow_answer  (consumes structured signals; escalate or finish)
```

---

## Group A — Core agent graph (`agents/shallow_researcher/agent.py`)

| Touch point | Where | Cadence | Cost |
|---|---|---|---|
| `agent_node` prompt render | agent.py:189-233 | per-iteration | Re-renders full system prompt every iteration. Uses `current_datetime` at **date** precision (not time) to preserve provider KV-cache (agent.py:207-211). |
| Norm scaffolding injection | agent.py:227-229 | per-iteration | `render_block_for_prompt` (~1400 tok), `doctrine_for`, `parcel_note` — **gated on `requires_sources`** (None on meta turns). See Group F. |
| LLM bind + invoke | agent.py:258-260 | per-iteration | `bind_tools(self.tools, parallel_tool_calls=True)` then `ainvoke`. The one unavoidable network hop per iteration. |
| Forced-synthesis branch | agent.py:242-256 | per-turn (budget exhausted) | Appends a synthesis anchor, one final `ainvoke` without tools. |
| `tool_node_with_source_capture` | agent.py:292-335 | per-iteration (w/ tool calls) | `ToolNode.ainvoke` runs the model's tool calls concurrently; then a per-result capture loop. |
| Per-result source capture | agent.py:313-334 | per-tool-result | `get_source_id_for_tool` gate (dict hit) + `extract_sources_from_tool_result` regex parse + `registry.add`. See Group E. |
| `run()` post-process pipeline | agent.py:349-571 | per-turn | Registry resolve, answer-message selection, DSML strip, marker strip, `verify_citations`, `sanitize_report`, `emit_final_report`, wire serialization, structured-signal write-back. |
| `_append_minimal_citation` | agent.py:55-91 | per-turn (fallback) | Regex trims dangling references header + appends one citation when the model omitted refs but exactly one source exists. |

## Group B — Answer post-processing helpers (same package)

| Touch point | Where | Cadence | Cost |
|---|---|---|---|
| `strip_and_salvage_dsml_tool_calls` | `dsml.py:155` | per-turn | Fast bail if the `<｜DSML｜` marker absent. Otherwise brace-balanced JSON scan + emit_card salvage. |
| `detect_and_strip_escalation_marker` | `markers.py:78` | per-turn | Tail-region regex (last 3 non-empty lines). |
| `detect_and_strip_confidence_marker` | `markers.py:102` | per-turn | Tail-region `[CONFIDENCE:…]` regex + enum validation. |

## Group C — Prompt template (`prompts/researcher.j2`)

- Rendered per-iteration via `render_prompt_template`. Template is **compile-cached** (`@lru_cache` in prompt_utils — Group F); per-iteration cost is Jinja `.render` only.
- Has an explicit **KV-cache boundary** at researcher.j2:89 — static contract above, dynamic context (date, tools, docs, catalog, project context) below.
- Tool section emits **names only** (researcher.j2:97-106) — descriptions deliberately not repeated (they already ship in the bound tool schema). `emit_card`'s catalog description is the notable exception (ships in the schema).

## Group D — Wiring & state

| Touch point | Where | Cadence | Notes |
|---|---|---|---|
| `shallow_research_agent` register | `shallow_researcher/register.py:52-153` | build + per-turn | Build-time: tool resolution + `validate_tool_availability`. Per-turn `_run`: `filter_tools_by_sources`, per-org provider policy (`with_model_overrides/credential/zdr`), rebuilds agent only when policy or tool set actually changed (register.py:114). |
| `ShallowResearchAgentState` | `models/state.py:14-66` | — | Carries `requires_sources`, `answer_citation_grounded`, `escalation_requested`, `answer_confidence_marker`, `verified_sources`. |
| `shallow_research_node` | `chat_researcher/agent.py:294-430` | per-turn | Builds the agent state (sets `requires_sources = intent != "meta"`), invokes the agent fn, unpacks structured signals. |
| `_finalize_shallow_answer` | `chat_researcher/agent.py:71-135` | per-turn | Decides escalate-to-deep vs finish from the stripped markers; passes `verified_sources` through. |
| Per-turn context setup | `chat_researcher/register.py` (`_load_project_context` :678, `_aggregate_documents_across_collections` :88, session registry :23-25) | per-turn | Live memory digest + profile, concurrent cross-collection document aggregation, session citation registry. Feeds the agent's `project_context` / `available_documents`. |

## Group E — Citation / source pipeline (`common/citation_verification.py`)

| Touch point | Where | Cadence | Cost |
|---|---|---|---|
| `extract_sources_from_tool_result` | :516 | per-tool-result | Knowledge output: 4 MULTILINE `re.findall` passes. Generic output: URL `finditer` + per-URL `_extract_title_for_url` (O(urls × blocks × patterns)) — the heaviest per-result path. |
| `SourceRegistry.add` | :187 | per captured source | ~2 URL parses per URL entry (`_normalize_url` + `_ParsedURL`). Dedup O(1). |
| `registry.all_sources()` | :364 | per-turn ×4 | Fresh `list()` copy, called 4× (agent.py:438,443,450,452). |
| `verify_citations` | :1145 | per-turn | **Heaviest single call.** Multiple full-report regex passes (`_normalize_citation_syntax` ×4, section find, layout normalize) + per-citation-line `resolve_url` **multi-strategy linear scan** against the registry (O(cited × registry)). |
| `sanitize_report` | :1447 | per-turn | Second-heaviest. **Re-does** much of verify's normalization/section-finding + body/ref URL stripping + `_renumber_citations`. Regex work effectively duplicated across verify+sanitize. |
| `source_entry_to_wire` | :935 | per cited source | For **RIS** sources, triggers cached `load_registry()` twice/entry (`source_lane` + `binding_note_for_entry`). Non-RIS entries skip it. |
| `get/set/reset_session_registry` | :489/:382 | per-turn | ContextVar ops, trivial. `get_or_create_session_registry` (:439) can do a shared-cache network read — but on conversation setup, not this synchronous path. |

## Group F — Prompt/registry/provider commons

| Touch point | Where | Cadence | Cost |
|---|---|---|---|
| `render_prompt_template` / `_compile_template` | `prompt_utils.py:57/17` | per-iteration | Template compile is `@lru_cache(256)`; per-call = Jinja render only. `StrictUndefined` walks full context. |
| `render_block_for_prompt` | `norm_registry.py:564` | per-iteration (research) | YAML is mtime-keyed `@lru_cache(8)` — no per-call disk read on the file path. But `stat()`, `_validated_entries` re-scan, and the full ~1400-tok block render recur **every iteration**. A registered admin `_db_loader` would add I/O per call. |
| `doctrine_for` | `norm_registry.py:456` | per-iteration (research) | Country-profile lookup + constant string. Cheap. |
| `parcel_note` | `norm_registry.py:612` | per-iteration (research) | Scans available docs × parcel tags. Cheap; None-fast when no docs. |
| `validate_tool_availability` | `tool_validation.py:36` | per-turn (build + error branch) | Linear pass, 2 substring checks/tool. Negligible; **not** on the happy path (only the `EmptySourceRegistryError` branch, agent.py:498). |
| `LLMProvider.get` | `llm_provider.py:90` | per-iteration | Dict lookup, no client build. |
| `with_model_overrides/credential/zdr` | `llm_provider.py:111/180/149` | per-turn | No-op identity return in the common case. Even the active path only `model_copy`s config wrappers — **shares the HTTP client**, no new pool. |
| `get_source_id_for_tool` | `data_source_registry.py:190` | per-tool-result ×2 | O(1) dict hit (prefix index precomputed at registration). Called twice per result (capture + attempted-lookup check). |

---

## Group G — Tools (the shallow agent's 7-tool set, Baurecht config)

Per-tool latency inventory. The agent invokes these inside the `tools` node.

### 1. `web_search_tool` — `tavily_web_search` (`sources/tavily_web_search/src/register.py`)
- Entry `_tavily_web_search` (:87). One outbound **Tavily API** call (`TavilySearch.ainvoke`, :122).
- **New `TavilySearch` client constructed every call (:112) — no reuse/pooling.**
- Retries: in-tool exponential backoff (`2**attempt`, :120/:171), stacks with LLM retries.
- **No HTTP timeout set; no result cache.** Knobs: `max_results:5`, `max_content_length:1000` (truncate :114-118), query capped 400 chars, `include_answer:"advanced"`.

### 2. `knowledge_search` — `knowledge_retrieval` (`sources/knowledge_layer/...`)
- Entry `search` (register.py:630). Fans collections out with `asyncio.gather` (:672-675).
- Each collection: `retrieve` → `asyncio.to_thread(_retrieve_sync)` (adapter.py:2428) — embedding + Chroma **off the event loop**.
- **Remote embedding** (`NVIDIAEmbedding`, adapter.py:2439) behind an **LRU query cache** (size 512) so multi-collection fan-out embeds once. **Chroma** local query (:2521).
- Caches: query-embedding LRU + per-collection index cache + **static-result cache** for `oib_knowledge` (TTL 3600s); session/project collections never result-cached.
- `_resolve_doc_classes` batched to 1 DB query/collection (register.py:406); `_format_results` offloaded via `to_thread` (:684). Knobs: `top_k:5`, chunk cap 1500 chars.

### 3. `ris_search_tool` — `ris_search` (`sources/ris_adapter/...`)
- Entry `_ris_search` (register.py:380). Ordered short-circuits:
  1. **Catalog shortcut** (in-process norm-registry match) — returns with **no network/LLM** (:427-462).
  2. **Shared read-through cache** (Redis/Dragonfly, :466-469).
  3. **Planner LLM** (`ris_planner_llm`, `reasoning_effort:none`) with one corrective retry (:263-297).
  4. **RIS API** GET via pooled `httpx.AsyncClient` (client.py:453-493, pool :400-411).
- Retries `_get_with_retries` (`2**attempt`, max 3, client.py:419). Timeout 30s. Success cached (7-day TTL, :546). Knobs: `page_size:20`, `max_results:10`.
- Note: JSON parse/normalize on the event loop (small).

### 4. `ris_fetch_tool` — `ris_fetch_document` (`sources/ris_adapter/...`)
- Entry `_ris_fetch_document` (register.py:747). Read-through cache (:788) → miss downloads via pooled client (client.py:495-530).
- **`html_to_text` BeautifulSoup parse runs synchronously on the event loop** (client.py:524) — can be heavy for a full consolidated law.
- Two cache layers (shared Redis 7-day + in-process LRU 64). Optional ingest is `to_thread` fire-and-forget with a marker to skip re-ingest (:810-828). Timeout 60s. Knobs: `max_chars:40000` (return truncation; full text still ingested).

### 5. `ris_catalog_lookup_tool` — `ris_catalog_lookup` (`sources/ris_adapter/...`)
- Entry `_ris_catalog_lookup` (register.py:606). **Entirely local**: `load_registry` + `match_entries`/`focus_entries`. No network/LLM/vector.
- **Runs synchronously on the event loop (no `to_thread`)** — cheap matching, but not offloaded. Relies on `load_registry`'s own memoization. Knob: `max_matches:5`.

### 6. `remember` — `project_memory_remember` (`src/aiq_agent/agents/project_memory/register.py`)
- Entry `_remember` (:99). Validates/truncates, then **DB write via BFF** `asyncio.to_thread(insert_memory_item)` (:141) — correctly off-loop. Fallback emits a `memory_proposal` card. Excluded from citation registry. Knob: `max_content_chars:500`.

### 7. `emit_card` — `emit_card` (`src/aiq_agent/cards/register.py`)
- Entry `_emit` (:62). **Fully in-process, no I/O**: `json.loads` → pydantic validate → registry add. Excluded from citation registry.
- The large **card-catalog description** ships in the tool schema on every LLM turn — a **prompt-token cost**, not a per-call latency cost.

### Tool cross-cutting notes
- Concurrency present: `parallel_tool_calls=True` + concurrent `ToolNode`; knowledge fan-out `gather`; RIS/knowledge/memory offload blocking work with `to_thread`.
- Caches present: Tavily = **none**; knowledge = 3 layers; RIS = shared Redis read-through + in-process LRU; catalog = local only.
- Blocking work still on the event loop: RIS `html_to_text` (large docs), `ris_catalog_lookup` matching, RIS JSON parse.
- Per-call re-init: Tavily client rebuilt every call (only tool without pooling/reuse).

---

## Where synchronous cost concentrates (summary)

- **Per-iteration (×≤5):** `render_block_for_prompt` catalog render (~1400 tok + `_validated_entries` re-scan + `stat()`), Jinja render, and the LLM `ainvoke`. Norm scaffolding is gated off on meta turns.
- **Per-tool-result:** `extract_sources_from_tool_result` regex parse (heaviest on many-URL generic output), `SourceRegistry.add` URL re-parse.
- **Per-turn:** `verify_citations` + `sanitize_report` — the biggest single-call CPU, with **duplicated** normalization/section-finding across the two and registry linear scans; `source_entry_to_wire` per RIS source (2× cached registry loads).
- **Network hops:** LLM per iteration; per tool: Tavily (uncached), NVIDIA embed + Chroma (cached), RIS API + planner LLM (short-circuited/cached), RIS doc download (cached), BFF memory write. Catalog + emit_card are local.
