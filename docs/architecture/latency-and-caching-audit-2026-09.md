# Chat-turn latency and LLM caching audit (2026-09)

> What a reader waits for on a chat turn, apart from the model writing tokens,
> and what the caching around the LLM calls does and does not do. Every claim
> below was read off the tree at the date of writing and cites `file:line`.
> Costs are stated as what the code bounds or what the code's own comments
> measured; the repo holds **no measured p50/p95 for a chat turn** (§5), so the
> ranking is structural and the first recommendation is to make it measured.
>
> Supersedes the still-open items in
> `plans/2026-07-18-chat-response-time-perf-audit.md` and
> `plans/2026-07-19-shallow-research-speedups-fable.md` (§7 says which landed).
> Complements `rag-system-audit-2026-08.md` (retrieval quality),
> `post-answer-stages.md` (what runs after the answer) and ADR-0020 (the cache
> tier).

## 1. Verdict

**Time to first token is the whole turn.** The chat turn is generated,
citation-verified and sanitised fully buffered, then the finished text is
re-cut into deltas (`src/aiq_agent/agents/chat_researcher/register.py:250-257`,
`:286-310`, `:1360`; `docs/design/streaming-chat-answer.md:27-38` says so in
as many words). So every item in §3 sits in front of the first character the
reader sees, including the model's own generation. There is no "model
streaming" slice to subtract; nothing streams.

Ranked by expected seconds saved per turn without touching answer quality:

| # | Driver | Order of cost | Fix shape |
|---|---|---|---|
| 1 | The answer is buffered end to end | the entire turn | stream the synthesis call, hold citation markers back, terminal frame stays authoritative (§3.1) |
| 2 | The LLM-judge reranker runs on the frontier default model once per `knowledge_search`, twice on a requery, again in the repair pass | ~14 s per call by the config's own arithmetic | configure the cross-encoder that already exists; cache the judge as a fallback (§3.2) |
| 3 | Up to nine serial frontier-model calls per turn, each re-sending the full context, with no verified prompt-cache hit | seconds per iteration | read the `cached_tokens` column that is already written; deferred tool loading; memoise the JSON-mode rung (§3.3) |
| 4 | Three serial internal HTTP hops before the graph starts, one of them a five-hop memory-digest chain | up to 7 s of ceilings, hundreds of ms warm | `asyncio.gather`, version-keyed digest (§3.4) |
| 5 | Two synchronous `urllib` POSTs on the event loop between "answer final" and "first delta" | up to 10 s of ceilings, blocks every turn on the replica | flush after the yield, off the loop (§3.5) |
| 6 | Synchronous BFF lookups on the event loop with 5 s timeouts, cold every 60 s per replica | stalls all concurrent turns on a miss | `to_thread` or background refresh (§3.6) |
| 7 | Ingest hold, repair pass, WS-upgrade chain, deep-research job tail | situational, up to 20 s / 6 min | bound and parallelise (§3.7 to §3.10) |

**Caching** (§4): nineteen cache layers exist and the ones that matter for
correctness are good. What is missing is the LLM-facing half: no provider
prompt-cache breakpoints, a prompt-cache hit rate that is recorded and never
read, no response cache for the four deterministic helper calls, per-process
embedding and model-config caches that die with the replica, no hit/miss
metrics at either cache module, and no test of the fail-open contract ADR-0020
rests on. §4.4 ranks the enforcement options; the mechanical one is a wrapper
type at the one seam every model handle already passes through.

## 2. Anatomy of a turn

```
WS frame ──▶ aiq_api handler ──▶ chat_researcher._run
  │ status frame "documents loading"                         register.py:1122
  │ gather( project context │ available documents │ registry )  :1143
  │   └ lessons ──▶ memory digest ──▶ stage flags   (serial)   :898 :927 :954
  │ in-flight ingest hold (≤ 20 s)                             :1168-1182
  │ turn admission (Dragonfly Lua)                             :1240
  │ track_agent_profile + track_llm_costs
  │   └ agent.run ─ shallow_research ─ [agent ⇄ tools] × ≤ 9    shallow_researcher/agent.py:988-1086
  │        ├ LLM (shallow_llm, tools bound, ainvoke)            :918
  │        ├ ToolNode (parallel within a round)                 :1034
  │        │   └ knowledge_search: embed → chroma → RRF → rerank LLM ‖ requery LLM → format
  │        ├ forced synthesis, JSON-mode ladder (≤ 3 calls)     :848-909
  │        ├ verify_citations, verify_quoted_spans (pure)       :1407 :1423
  │        ├ repair pass (≤ 2 retrievals + 1 rewrite)           :1436-1481
  │        └ sanitize_report                                    :1571
  │ teardown: profiler.flush(wait=True), tracker.flush(wait=True)   blocking urllib
  │ fire-and-forget: registry persist, post-answer stages
  └ yield deltas of the final text, then the terminal frame     :1360
```

What does **not** cost the reader anything, and can be left alone:

- Post-answer stages (follow-ups, memory reflection) are `create_task`, never
  awaited, hard-bounded at 20 s and 45 s, and the UI unblocks input on the
  terminal frame before they run (`stages/runner.py:196-206`, `:306`;
  `frontends/ui/src/features/chat/hooks/use-websocket-chat.ts:1518-1553`).
- Citation and quote verification are pure Python. There is no LLM in
  `common/citation_verification.py` and no per-citation call to batch.
- The client batches deltas per animation frame
  (`features/chat/stores/messages-store.ts:719-760`); rendering is not a driver.
- JWKS is cached six hours (`frontends/aiq_api/src/aiq_api/auth/jwt_validator.py:45`);
  auth per message is one local signature check.
- The WebSocket upgrade normally happens at page mount, not on the first turn
  (`use-websocket-chat.ts:2078-2090`). See §3.9 for when it does.

## 3. Latency drivers, ranked

### 3.1 Full buffering: the first delta is the last thing computed

`register.py:1242` awaits `agent.run` to completion; `:1360` then yields the
final text in 24-character pieces. The reason is real and recorded
(`docs/design/streaming-chat-answer.md:27-38`): `verify_citations` deletes
unverified `[N]` markers and renumbers the sources section, and a shallow
answer can still escalate to deep research, so raw tokens would briefly show
unverified citations or text that gets superseded.

Both objections are about **markers and the suffix**, not the prose. The wire
contract already makes the terminal frame authoritative ("the terminal
`complete` frame replaces the text with the authoritative full answer",
`use-websocket-chat.ts:1511-1522`), so a stream that is later corrected is
already legal on this protocol.

What a quality-preserving stream looks like:

1. Stream the synthesis call's `answer` field as it is produced. The forced
   synthesis returns a JSON envelope (`shallow_researcher/agent.py:848-909`), so
   this needs an incremental string-field reader over the JSON stream, not a
   raw token relay. That is the one piece of new machinery.
2. Withhold text from an opening `[` until the marker is closed and resolves in
   the session `SourceRegistry`; emit resolved markers, drop unresolved ones on
   the spot. Verification against the registry is deterministic and per marker
   (`common/citation_verification.py:2503`), so it does not need the whole
   answer.
3. Never stream the `## Sources` section; it is rebuilt by `sanitize_report`.
4. Keep the buffered path for the escalation case: an envelope that sets
   `escalate_to_deep` streams nothing (the answer field of an escalation is a
   hand-off note, and the reader sees the clarifier instead).
5. The terminal frame carries the verified, sanitised text exactly as today and
   replaces the streamed body. Any divergence between the streamed body and the
   terminal text is a bug the existing `answer-cutoff-wire.spec.ts` shape can
   pin.

Cost: this is the only item in this list that is a design change rather than a
fix, and it needs a new ADR that amends the streaming design doc. It is also
the only item that moves the number the reader actually feels by the full
generation time. Everything below it is additive to it, and worth doing first
because each is a few lines.

### 3.2 The LLM-judge reranker is a frontier-model call per search

**[LANDED, the cross-encoder]** The reference config sets
`reranker_provider: openrouter` (model `cohere/rerank-v3.5`, the key every
deployment already holds; the route answers 401 without one, so it exists).
The judge stays as the fallback and the requery judge still runs beside the
reranker, so the retrieval hot path is now bounded by that smaller call. Two
things to know before trusting it: NVIDIA's hosted reranking URL that the
module defaults to answers 410 Gone, so `nvidia` needs a self-hosted NIM via
`AIQ_RERANKER_BASE_URL`; and **no offline eval covers reranking** (the
retrieval harness README says so at its "Reranking" bullet), so the
before/after is the golden compliance eval on live keys and the profiler's
`knowledge_search` tool spans. The judge cache is still open.

`configs/config_oib_openrouter.yml:296-326` describes the call it configures: a
60-candidate pool is "~16k input tokens and ~720 output tokens; at a routine 50
tok/s that is ~14 s of decoding alone", on `rerank_llm`, which resolves to the
same `${GRID_DEFAULT_MODEL}` as every other role (`:317`). It runs once per
`knowledge_search` (`sources/knowledge_layer/src/register.py:1809`), a second
time when the requery judge asks for more (`:1816-1831`), and again for each of
the up to two repair-pass retrievals (`shallow_researcher/agent.py:1154-1163`).
A two-search turn with one requery is three of these calls, all on the path to
the first character.

`rerank_llm` has no agent group, so no admin or org setting can re-point it
(`:311-313`). It is a config-file literal.

Two fixes, in order:

- **Configure the cross-encoder.** `sources/knowledge_layer/src/cross_encoder.py`
  already adapts OpenRouter, Cohere, Voyage, Jina and NVIDIA reranking
  endpoints, is tried first when set, and falls back to the judge
  (`rerank.py:283-292`). `reranker_provider` / `reranker_model`
  (`register.py:184,193`) are set in **no** config file. The module's own header
  says why this is the right answer: a cross-encoder scores query and full
  chunk together "in tens of milliseconds", where the judge needs a
  second-scale call over a truncated excerpt. This is a quality question with
  an oracle: run `task be:eval:retrieval` (`frontends/benchmarks/oib_retrieval`)
  with and without, and keep the one that scores higher. Expect the
  cross-encoder to win; it reads the whole chunk.
- **Cache the judge** for as long as it remains the fallback. It is
  `temperature: 0`, `seed: 1`, `reasoning_effort: none`, `max_retries: 0`, and
  its output is a function of `(model, query, ordered candidate ids)`. §4.3
  gives the key. Same for the requery judge (`requery.py:138-170`), which
  shares the model object (`register.py:1467`).

Neither changes which chunks a hit returns; both change how long the reader
waits for them.

### 3.3 The tool loop: up to nine full-context calls, cache status unknown

`agent.py:756-767`: the ceiling is `max_tool_iterations` (7, config `:648`)
plus two reserved skill iterations. Every iteration re-sends
`[system] + full accumulated history` (`agent.py:845,911`). What that context
holds:

| Block | Size | Evidence |
|---|---|---|
| `researcher.j2` | 43 KB template, conditional | `agents/shallow_researcher/prompts/researcher.j2` |
| Bound tool schemas | ~9 000 tokens, 81 % of it the two BIM tools | config comment `configs/config_oib_openrouter.yml:635,661-663`; ADR-0048 measured ~14 000 with `emit_card` |
| Norm catalog | the AT registry filtered to federal + one Bundesland, 15 KB source | `common/norm_registry.py:615-680` |
| Document inventory | ≤ 50 rows | `register.py:89-101` |
| Conversation history | 8 000 tokens | `register.py:567` |
| Each prior `knowledge_search` result | 16 chunks × ≤ 2 500 chars ≈ 10k tokens, re-sent on every later iteration | `knowledge_layer/register.py:29,1946` |

Three things make this cheaper without changing what the model sees:

- **Read the prompt-cache hit rate that is already recorded.** Every
  generation's `prompt_tokens_details.cached_tokens` is captured
  (`common/cost_tracking.py:211`), posted, and stored in
  `llm_usage_events.cached_tokens` (`frontends/ui/src/lib/db/schema/budgets.ts:104`).
  Nothing reads the column. `sum(cached_tokens) / sum(prompt_tokens)` grouped
  by model and by `agent_group` is the number that says whether the prompt
  engineering in §4.2 is paying off at all. If it is near zero on
  OpenAI-family models, something in the prefix is moving per request; if it is
  high, item 3 drops several places.
- **Deferred tool loading (ADR-0048)** is implemented and off
  (`configs/config_oib_openrouter.yml:735`). It withholds the ~36 KB of BIM tool
  schema server-side for one request. It needs `api_type: responses` (`:138-146`)
  and the build-time probe already refuses to run it silently. Turning it on
  for the reference config is a config change guarded by
  `tests/benchmarks/test_turn_shapes_live.py`.
- **Memoise the JSON-mode rung.** The forced synthesis tries
  `json_schema` → `json_object` → plain, each a full round trip
  (`agent.py:636-645`). Which rung a `(model, base_url)` honours is a process
  constant; `deferred_tool_loading.py:326-333` already keeps exactly this kind
  of per-model verdict in a bounded `OrderedDict`. One memo removes up to two
  frontier calls from a turn whose provider rejects strict schemas.

Not recommended: compacting earlier tool results out of the history. The model
re-reads them when it writes the answer, so that is a quality change, not a
latency one.

### 3.4 Pre-graph setup: serial hops inside a gathered branch

**[LANDED]** The three awaits are gathered; the in-flight ingest read rides
the outer gather too, and only the wait it may trigger stays after it. The
digest version cache and the empty-memory shortcut are still open.

`register.py:1143` gathers three branches, which is right. Inside the first
branch, `_load_project_context` awaits three independent things one after
another:

| Await | Ceiling | What it does | Cached |
|---|---|---|---|
| platform-lessons digest `:898` | 3.0 s | internal HTTP | 60 s in-process |
| memory digest `:927` | 2.5 s | Python → BFF → `buildProjectMemoryDigest` → `embedNote` (1 s) → Python `/v1/note-embeddings` → embedding provider → pgvector query → `buildProposalDecisionsBlock` (`frontends/ui/src/lib/projects/memory-service.ts:763-799`, `app/api/internal/memory/digest/route.ts:74`) | **no** |
| `resolve_enabled_stages` `:954` | 1.5 s | internal HTTP | **no** |

Fixes, all behaviour-identical because each already fails open on its own:

- `asyncio.gather` the three. One line; removes the flags call's full latency
  and the lessons call's from the critical path.
- Give the digest a version. The BFF knows when memory changed (every write
  goes through `createProjectMemoryItem`); key a Dragonfly entry on
  `(org, project, memory-version, query-hash)` so an unchanged project costs
  one cache read instead of an embedding call plus a vector query.
  `scaling-review-2026-07.md:159` proposed this and it is still open.
- Skip the embedding when the project has no memory rows. `memory-service.ts:763`
  embeds unconditionally.

### 3.5 Two blocking HTTP POSTs between "answer final" and "first delta"

**[LANDED]** Both context managers take `inline_flush=False` on the chat
turn and `profiler.flush_after_answer` posts the batches after the terminal
chunk, off the loop, in a `finally` so an early-closed stream still posts.
The CLI `--input` path flushes before its hard exit. Every other caller
keeps the inline flush.

At the exit of the `with` block on `register.py:1241`, both context managers
post their final batch **synchronously on the event loop**:
`common/profiler.py:410-415` (`profiler.flush(wait=True)`, `urlopen` at `:283`,
5 s timeout) and `common/cost_tracking.py:492-499` (`tracker.flush(wait=True)`,
`urlopen` at `:395`, 5 s). Both comments give the same reason: a `wait=False`
flush hands the batch to a daemon executor that a worker exiting right after
the turn can strand.

That reason is about **when the process exits**, not about where the POST runs.
Keep the synchronous guarantee and move it: yield the deltas and the terminal
frame first, then flush; or `await asyncio.to_thread(flush, wait=True)` so the
loop keeps serving other turns during the round trip. A shutdown hook that
drains both queues closes the strand case for good and lets both flushes go
fully async.

### 3.6 Synchronous BFF lookups on the event loop

**[LANDED]** The skill resolve and the three provider lookups run on a
thread (`asyncio.to_thread`, ContextVars travel with it). Values and TTLs
are unchanged.

Three per-turn lookups in `shallow_researcher/register.py` run as plain
synchronous calls on the loop, each a blocking `httpx` request to the BFF with
a 5 s timeout, cached in-process for 60 s (30 s negative):

- `SkillResolver.resolve` (`:186` → `skills/resolver.py:229-235`)
- `get_zdr_only_from_context` (`:213-215` → `common/model_overrides.py:151-180`)
- `get_org_llm_credential_from_context` (`:213-215` → `common/llm_credentials.py:78-141`)

Warm they cost nothing. On a miss, which every org pays every 60 s on every
replica, the entire event loop stops: every other conversation on that
replica waits with this one. Wrap them in `asyncio.to_thread`, or refresh
them from a background task shortly before expiry. Values and TTLs stay as
they are (the credential cache is deliberately per-process, ADR-0022).

### 3.7 The in-flight ingest hold

**[LANDED, the read]** The read is one of the gathered branches now. The
narrowing of the wait itself is still open.

`register.py:1168-1182` polls `ingest_status_store.in_flight_files` for up to
`GRID_INGEST_WAIT_SECONDS` (default 20, `:126`) when anything in scope is still
ingesting, then reloads the document inventory. The failure it prevents is
real (answering as if a just-uploaded file did not exist). Two narrowings that
keep the guarantee: read the in-flight set inside the `:1143` gather and only
*wait* afterwards, and wait only when the question plausibly needs the file
(a focus file is set, or the turn is the first after an upload). How often the
hold fires in production is not knowable from the repo and decides whether
this is a headline or a footnote.

### 3.8 The repair pass

**[LANDED, the gather]** The two lookups run together and keep their order.
The requery skip and the wall-clock bound are still open; both change the
tail, so they are decisions rather than fixes.

When verification fails, `_repair_answer` (`agent.py:1102-1208`) runs up to two
retrievals **sequentially** in a `for` loop (`:1154-1163`), each with the full
rerank and requery machinery of §3.2, then one rewrite call through the same
JSON ladder as §3.3, then re-verifies. Nothing bounds the whole. Fixes:
`gather` the two lookups (they are independent; the caller folds their sources
into a scratch registry), skip requery for them (they are precision lookups on
a named quote), and put a wall-clock bound on the whole pass. The answer with
its markers is already the shippable floor, which is what makes a timeout free
here.

### 3.9 The WebSocket upgrade chain, when a turn pays for it

`server.js:580-788` resolves the scope through a loopback HTTP call to
`app/api/auth/websocket-scope/route.ts`, which awaits ten steps in sequence
(`:29-164`): session, collection scope (itself four serial awaits in
`lib/collection-scope-request.ts:159-192`), two flag reads, model overrides,
budget status, prompt view, Bundesland, memory digest, proposal decisions.
Five of those are `getCached`; the scope build, web-search flag, memory digest
and proposal block are not, and FGA checks are uncached by default
(`lib/authz/resource-check.ts:41-46`, `GRID_AUTHZ_CACHE_TTL_MS=0`).

This is paid at page mount, so it usually misses the first turn. It lands on
a turn when the socket rotates: stale token preflight
(`use-websocket-chat.ts:2343-2350`), project switch (`:2158`), reconnect, or the
10 s scope memo expiring (`server.js:473`). Two `Promise.all` waves (session
and scope first, then everything else) and `GRID_AUTHZ_CACHE_TTL_MS=30000`
(already implemented, tenancy stays uncached) are the fixes; the scope memo
TTL is a security knob (`server.js:470`) and should stay where it is.

### 3.10 The deep-research job tail

**[LANDED]** Card generation and reflection run together, and the reflection
is bounded by the chat path's `REFLECTION_TIMEOUT_S`.

After the report has been streamed to the reader, the job runner awaits, in
sequence, card generation (30 s bound, on the orchestrator model,
`frontends/aiq_api/src/aiq_api/jobs/runner.py:1393`, `cards/generate.py:23`)
and memory reflection (`runner.py:1410`, `:1936-2010`) with **no** timeout
around it; its only bound is `card_llm`'s 120 s × 3 attempts. Only then does
the job flip to SUCCESS, write the thread turn and notify (`:1496-1539`). The
reader has the report, but the job, the thread and the notification say
"running" for up to six minutes in the worst case. `gather` the two and wrap
the reflection in the 45 s the chat path already uses
(`stages/memory_reflection.py:64`).

## 4. Caching

### 4.1 What exists

| Layer | Key | TTL | Backend | Invalidation | Hit rate visible |
|---|---|---|---|---|---|
| VLM captions (a vision-LLM call) | `vlm:caption:{model}:{prompt}:{sha256}` | 30 d | Dragonfly | content-addressed | DEBUG log |
| RIS search (includes the planner LLM) and document text | hashed, URL/query scoped | 7 d | Dragonfly | TTL | no |
| Org agent skills | `skills:{org}:{agent}` | 60 s | Dragonfly | TTL only | no |
| Citation registry snapshot | `citations:{conversation}` | 24 h | Dragonfly | TTL | no |
| Collection write-version | `knowledge:collection-version:{c}` | none | Dragonfly, Lua, not fail-open | it is the invalidator | no |
| Static retrieval results (`oib_knowledge` only) | `(collection, version, query, top_k, filters)` | 1 h | **process** | version bump | INFO log |
| Query embeddings | `(model, query)` LRU 512 | none | **process** | none | no |
| Org model overrides + ZDR (backend) | org | 60 s / 30 s | **process** | TTL only | no |
| BYOK credential (backend) | org | 60 s / 30 s | **process**, by design | TTL only | no |
| Norm registry, retrieval and reasoning settings, platform lessons | singletons | 30 s to 5 min | **process** | `reset_*_cache()` | no |
| Rendered system prompt | per run | one run | LangGraph state | n/a | no |
| BFF read-through (22 keys, `lib/cache/index.ts`) | per site | 30 s to 6 h | Dragonfly | write-invalidate on 14 of 22 | no |
| Provider prompt-prefix cache | token prefix | provider | provider | n/a | **`cached_tokens` written, never read** |
| LLM response cache, exact or semantic | | | **does not exist** | | |

Sources: `src/aiq_agent/common/cache.py`, `skills/resolver.py:228`,
`common/citation_verification.py:561-634`, `knowledge/collection_version.py`,
`sources/knowledge_layer/src/llamaindex/processing.py:49-165`,
`llamaindex/adapter.py:3946-4180`, `common/model_overrides.py:141-215`,
`common/llm_credentials.py:111-150`, `frontends/ui/src/lib/cache/index.ts`.

### 4.2 Provider prompt caching: engineered for, never verified

The prompts are already shaped for prefix caching, deliberately: stable text
first and volatile blocks last in every template (`researcher.j2` switches at
`:273`), the date rather than a timestamp (`shallow_researcher/agent.py:811-815`),
the rendered prompt memoised per run (`models/state.py:195-203`), tool-schema
enum order pinned across processes by a test that spawns two interpreters
(`tests/aiq_agent/agents/test_ifc_measure_tool.py:2115-2140`), and tool-result
truncation frozen per message so history bytes never move
(`deep_researcher/custom_middleware.py:517-540`). `render_envelope_schema`
(`common/answer_envelope.py:646`) is list-driven and byte-stable.

What is missing:

- **No `cache_control` anywhere** (`grep` over `src/`, `sources/`, `configs/`,
  `frontends/`). Every role goes through OpenRouter, which forwards OpenAI-family
  automatic caching and needs explicit breakpoints for Anthropic. An org
  override (ADR-0014) can point any group at an Anthropic model at any time, so
  "which mechanism applies" is a per-request property. The single seam for
  this is `common/llm_factory.get_langchain_llm` (`:204-215`), which already
  rewrites every request for the contract subclass.
- **Nothing reads `cached_tokens`** (§3.3). Until it is read, the prompt
  engineering above is a belief.
- Two per-project blocks (`norm_doctrine`, `jurisdiction_grounding`) sit at the
  top of the deep-research templates, which fragments the prefix per project
  rather than per turn. Stable per project, so low priority.

### 4.3 What should be cached and is not

Ranked by seconds saved per turn:

1. **The rerank and requery judges** (§3.2). Deterministic by configuration.
   Key `rerank:{model}:{sha256(query ‖ candidate ids ‖ candidate text hashes)}`,
   TTL a day, scoped by collection so a tenant's chunk text never keys a hit
   for another tenant. Value: the score list. Cross-encoder scores get the same
   treatment.
2. **The RIS query planner** (`ris_planner_llm`, `reasoning_effort: none`,
   strict schema). Already cached indirectly through the RIS search cache;
   direct caching covers the misses.
3. **HyDE drafts** (`common/hyde.py`), when enabled. Fail-open and discarded
   after embedding; a stale draft cannot reach the answer.
4. **Query embeddings, in the shared tier.** The in-process LRU dies with the
   replica and is invisible to the other replicas and the deep workers
   (`collection_version.py:20-24` counts them). One embedding is a JSON list
   small enough for Dragonfly; the key is `(model, sha256(text))`.
5. **Backend org model overrides, in the shared tier.** The BFF invalidates its
   own key on save (`lib/model-config/service.ts:160,202`); the backend keeps a
   60 s per-process copy that the save cannot reach. Public config, no ADR-0022
   constraint, straightforward move. The credential cache stays per-process.
6. **A semantic result cache.** `rag-system-audit-2026-08.md:369` (F15) already
   names it. Defer until the hit rate of the exact-key cache is measured; it is
   the largest change and the least certain win.

Not candidates: `shallow_llm`, `clarifier_llm`, `deep_*`, `card_llm`,
`follow_ups_llm`, `compliance_llm`. All run `temperature: 1.0` over
conversation history.

### 4.4 Enforcement

What holds the line today: fifteen invariant tests on the collection version
(`tests/aiq_agent/knowledge/test_collection_version.py`), one VLM cache test,
RIS key-shape tests, the two-interpreter enum test, and an autouse
`reset_local_store()`. No test covers `common/cache.py` or `lib/cache/index.ts`
at all; the fail-open contract ADR-0020 leans on is asserted nowhere. No lint
rule or pre-commit hook touches caching. Neither cache module counts hits.
Keys are ad-hoc f-strings at 28 call sites; the tenant leak that invites is
already in `docs/contributing/gotchas.md:36` as something that happened.

Options, most mechanical first:

| # | Mechanism | Closes | Cost |
|---|---|---|---|
| E1 | A `DeterministicLLM` handle returned by a sibling of `get_langchain_llm`, whose `ainvoke` goes through the content-hash cache, and which is the **only** way to obtain `rerank_llm`, `requery_llm`, `ris_planner_llm` and the HyDE model | "did you cache it" cannot be answered no | one factory function, four call sites |
| E2 | ruff `flake8-tidy-imports` `banned-api`: no `builder.get_llm` outside `common/llm_factory.py` | a new role that bypasses the seam | ten lines in `pyproject.toml:116-147` |
| E3 | An ESLint rule beside `eslint-rules/require-tenant-scope.mjs`: the key argument to an imported `getCached` must interpolate an org identifier or be on a global-key allowlist | `gotchas.md:36` recurring | one rule file, three lines in `eslint.config.mjs` |
| E4 | Render every `agents/*/prompts/*.j2` in two fresh interpreters with fixed inputs and diff the prefix up to the volatile boundary | a timestamp, a set iteration, or a reordered schema creeping above the boundary | generalise the enum test |
| E5 | A source-order test: the last static line of each template precedes the first volatile variable | the cheap version of E4 | text assertion |
| E6 | Fail-open tests for both cache modules: a fake client that raises on every op; `get_json` returns the local value, `eval_script` returns `None`, the 30 s cooldown engages | the floor under ADR-0020 | one test file each |
| E7 | Hit/miss counters in both modules through `observability/`, and a rollup over `llm_usage_events.cached_tokens` | every rule above arguing from theory | counters plus one query |
| E8 | ADR-0020 amendment: LLM-response caching enters the policy, with a **Confirmation** section naming E1 and E2 as the gate | the doc half of the ratchet | review |

One asymmetry worth a second look while in `cache.py`: `_mark_client_failed`
(`:75-79`) is global, so a single failing key sends every consumer to the local
map for 30 s. `eval_script` carries a comment refusing to do exactly that for
its own path (`:208-213`); `get_json` and `set_json` do it anyway.

## 5. Measure before optimising

**[LANDED, step 1]** The profiler root span now opens before the setup I/O
and outside admission, with `setup.project_context`,
`setup.available_documents`, `setup.session_registry`, `setup.ingest_status`,
`setup.ingest_wait` and `admission.wait` spans, and the turn's outcome
(`admission_refused`, `budget_exceeded`) on the root span's metadata. Steps
2 to 5 are still open.

The repo has one measured chat-turn number, and it is a YAML comment: the
synthesis call at ≈ 29 s on a reasoning model at `medium`
(`configs/config_oib_openrouter.yml:131-136`). The eval suite's latency bounds
are placeholders (`frontends/benchmarks/oib_compliance/README.md:62-78`,
`bounds_calibration_pending: true`). `docs/audit/feedback-backlog.md:82` already
records FB-17 as "blocked on runtime measurement".

The instrument exists and is under-scoped. `common/profiler.py` records a
`turn → node → llm → tool` span tree to `agent_profiler_spans` and a waterfall
UI renders it (`frontends/ui/src/features/platform/components/agent-profiler.tsx`).
But `track_agent_profile` opens at `register.py:1241`, around `agent.run`
only, and inside `admit_turn_async`. Everything in §3.4 to §3.7 and the
admission queue wait are invisible to it. Minimal additions, in order:

1. Move the profiler block to wrap the whole of `_run` from the first status
   frame, outside admission, with spans named `setup.context`,
   `setup.documents`, `setup.ingest_wait`, `admission.wait`, `teardown.flush`.
2. Stamp `{"cache": "hit" | "miss"}` into span metadata at the TTL-cached
   readers (norm store, model overrides, retrieval settings, skills, the two
   cache modules). Without it a warm turn and a cold one are the same row.
3. One SQL over `agent_profiler_spans`: `percentile_cont(0.5, 0.95)` of
   `duration_ms` grouped by `kind, name` over a window. The indexes are there.
4. One SQL over `llm_usage_events`: `sum(cached_tokens) / sum(prompt_tokens)`
   by model and agent group.

The two queries, against `grid_app`, ready to paste:

```sql
-- Where the last seven days of chat turns went, per span. `turn` rows are the
-- whole turn; `setup.*` and `admission.wait` are the seconds before the first
-- model call; `llm`/`tool` rows are per call, named by model or tool.
select kind, name,
       count(*)                                                       as n,
       round(percentile_cont(0.5)  within group (order by duration_ms)) as p50_ms,
       round(percentile_cont(0.95) within group (order by duration_ms)) as p95_ms
from agent_profiler_spans
where created_at > now() - interval '7 days'
group by kind, name
order by p95_ms desc;

-- Whether the provider's prompt-prefix cache is landing at all. Near zero on
-- an OpenAI-family model means something in the prefix moves per request.
select model,
       count(*)                                               as calls,
       sum(prompt_tokens)                                     as prompt_tokens,
       sum(cached_tokens)                                     as cached_tokens,
       round(100.0 * sum(cached_tokens) / nullif(sum(prompt_tokens), 0), 1) as cached_pct
from llm_usage_events
where created_at > now() - interval '7 days'
group by model
order by prompt_tokens desc;
```
5. Calibrate the eval bounds from three to five live runs, as the README
   already specifies, and flip the flag.

Then re-rank §3 against numbers.

## 6. Implementation batches

**Batch 0, measurement (§5).** Ships first because it is the only way to know
which of the rest mattered.

**Batch 1, small and behaviour-identical.** §3.4 gather; §3.5 flush after the
yield; §3.6 `to_thread`; §3.8 gather and bound; §3.10 gather and bound; §3.3
JSON-rung memo; §3.7 read-inside-gather. Each is a few lines, each has a test
seam, none changes an answer.

**Batch 2, configuration with an oracle.** Cross-encoder reranking, measured
with `task be:eval:retrieval`; deferred tool loading on the reference config,
measured with `task be:eval:turn-shapes`; `GRID_AUTHZ_CACHE_TTL_MS`.

**Batch 3, caching.** E1 wrapper and the four deterministic caches; embeddings
and model overrides into the shared tier; `cache_control` breakpoints at the
factory seam for Anthropic-routed groups; E2, E3, E6, E7.

**Batch 4, streaming (§3.1).** Its own ADR. Largest win, only real design
change.

## 7. The July findings, reconciled

Of `plans/2026-07-18` and `plans/2026-07-19`: tool-description dedup,
batched `doc_class`, fire-and-forget registry persist, single envelope parse,
norm-store memo (`knowledge/norm_store.py:51`), Tavily client reuse
(`sources/tavily_web_search/src/register.py:104`), `html_to_text` off the loop
(`sources/ris_adapter/src/client.py:576`), and session-registry hydration in
the gather (`register.py:1146`) have all landed. Findings #2 and #12 of the
July 18 audit targeted the intent classifier, which ADR-0052 deleted. Still
open from July: caching the static base-corpus inventory (#10), hoisting the
per-iteration prompt invariants (#11). Both are minor next to §3 and are
absorbed by items 3.3 and 3.4 here.
