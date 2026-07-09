# Scaling Architecture Review — Caching, Queueing, Query & Agent Assessment (2026-07)

**Status:** Assessment / recommendation document. No code changes accompany this review.
**Scope:** Caching layer evaluation (incl. write-through question), queueing evaluation,
query/process optimization, and AI-agent scalability. Database *infrastructure* (replication,
sharding, managed PG) is explicitly out of scope per the review request; query behavior is in scope.

---

## 1. Executive summary

The system is architecturally well-layered (ADR-0003 BFF split, ADR-0017 repository/service
discipline, single-writer `grid_app`), but the **deployed reality is a single-host,
single-instance-per-service stack** with several hidden serialization points. The "stateless,
horizontally scalable agent" described in ADR-0003 and `system-overview.md` is aspirational today:
the backend embeds ChromaDB and a private Dask cluster in-process on local volumes, the chat
gateway is one Node process, and the backend web tier is one uvicorn worker on one event loop.

Verdicts on the three questions asked:

1. **Caching — yes, but not a general write-through data cache.** The expensive repeated work is
   not "reads of our own Postgres rows"; it is (a) per-request WorkOS network calls, (b) per-upgrade
   budget-ledger aggregations, (c) re-embedding and re-retrieving against a *static* OIB corpus, and
   (d) resending identical multi-KB LLM prompt prefixes with no provider prompt caching. The right
   shape is **read-through TTL caches for externally-owned data (WorkOS), one true write-through
   aggregate (budget spend rollup), write-invalidate for the two BFF-owned hot values (prompt view,
   memory digest), and content-keyed caches for embeddings/retrieval**. In-process caches suffice
   until the second replica; the existing per-process caches must move behind a shared interface
   (Redis) *at that point*, because one of them is already a correctness bug under multi-replica
   (§4.4).

2. **Queueing — mostly already present; what's missing is admission control, not a broker.**
   Postgres is already the queue substrate three times over (`deletion_queue` with
   `FOR UPDATE SKIP LOCKED`, NAT `job_info`/`job_events`, LangGraph checkpoints). Adding
   Kafka/RabbitMQ/Celery now would add an operational component without fixing the actual gap:
   **nothing bounds concurrent deep-research jobs or concurrent ingestion threads** — a burst of
   users translates directly into unbounded LLM/embedding fan-out and event-loop starvation. The
   recommendation is bounded worker pools + queue-depth admission on the two heavy entry points,
   keeping Postgres as the durable queue (the purger already proves the pattern), and re-homing
   deep-research *execution* onto DB-claimed workers when going multi-replica (§5).

3. **The agent — the requester assumed "not much to do"; that is wrong.** The agent tier holds the
   single largest cost lever (no provider prompt caching on large static prefixes resent every
   call) and the single largest latency lever (synchronous Chroma + remote-embedding calls executed
   directly on the lone event loop, stalling *all* concurrent users). Both are fixable without
   touching the agent's reasoning behavior (§6).

Ranked top issues (severity × effort):

| # | Issue | Tier | Severity | Effort |
|---|-------|------|----------|--------|
| 1 | Sync Chroma + remote embedding calls block the single backend event loop (`sources/knowledge_layer/src/llamaindex/adapter.py:1839-1856`) | Backend | Critical | Low |
| 2 | No provider prompt caching; static multi-KB prompt prefixes resent on every LLM call | Agent | High (cost) | Low–Med |
| 3 | Uncached WorkOS `listOrganizationMemberships` network call on **every** authenticated request (`frontends/ui/src/lib/auth/session.ts:20-24`) | BFF | High | Low |
| 4 | No admission control on deep-research job submission or ingestion threads | Backend | High | Med |
| 5 | 1–3 full month-window ledger aggregations per WS upgrade (`frontends/ui/src/lib/budgets/service.ts:508-547`; known in ADR-0015) | BFF | High | Med |
| 6 | Missing indexes: `projects.organization_id`, `conversations(organization_id, updated_at)`, `messages(conversation_id, created_at)` | DB queries | High | Trivial |
| 7 | Duplicate `requireProjectAccess` (2× tenancy query + up to 6 FGA checks) per WS upgrade | BFF | Med | Low |
| 8 | No retrieval/query-embedding cache over the static shared OIB corpus | Agent | Med | Med |
| 9 | Per-replica cache invalidation bug: profile edits leave stale prompt-view on other replicas up to 5 min (`frontends/ui/src/lib/project-profile/prompt-view.ts:37-39`) | BFF | Med (blocker for replicas) | Med |
| 10 | Deep-research execution pinned to per-replica localhost Dask; cross-replica cancel silently no-ops (`frontends/aiq_api/.../routes/jobs.py:1076`) | Backend | Med (blocker for replicas) | High |

---

## 2. Current state (verified findings)

### 2.1 Topology

- Compose (`deploy/compose/docker-compose.yaml`, `.coolify.yaml`) defines **no replicas anywhere**.
  Frontend is capped at 0.5 CPU / 512 MB; backend and MinIO have no limits; Postgres 2 CPU / 4 GB,
  untuned, no pooler.
- **Backend container = 1 uvicorn worker (single event loop, no `workers=` in
  `deploy/start_web.py:254`) + a private localhost Dask cluster (1 worker × 4 threads,
  `deploy/entrypoint.py:181-238`) + in-process ChromaDB (`PersistentClient` on the `chroma_data`
  volume).** The docs' "stateless agent" owns the vector store, the job runner, and (by default
  SQLite) the job/checkpoint stores.
- **Frontend container = 1 Node process** running the WS gateway *and* Next.js in-process
  (`frontends/ui/server.js:44-51`). ADR-0009 already concedes "a gateway crash breaks all chat".
- No Redis, no broker, no job-queue container. Postgres tables are the only queue substrate.

### 2.2 The per-connection hot path (BFF)

Chat messages bypass the BFF (pure WS relay — good). But **every WS upgrade** runs, serially:
session resolution (WorkOS membership network call, uncached), `buildCollectionScopeFromRequest`
(tenancy query + up to 3 FGA checks), feature-flag check (30 s cache), model overrides (2 queries,
uncached), `getBudgetStatus` (up to ~6 queries incl. up to 3 month-window ledger `GROUP BY`s,
awaited **serially**), a **second redundant** `requireProjectAccess`
(`app/api/auth/websocket-scope/route.ts:106` duplicating `collection-scope-request.ts:91`),
prompt view (5 min cache), memory digest (query, uncached). Total: ~8–11 queries + up to 6 FGA
checks + 1–2 WorkOS calls per upgrade — and the gateway reaches all of this through a loopback
HTTP self-call (`server.js:114-164`).

Every **REST** request pays `getGridSession()` → the same uncached WorkOS membership round-trip.

### 2.3 The backend hot path

Every `knowledge_search` tool call fans out one retrieval **per collection in scope** via
`asyncio.gather` — but each `retrieve()` body is fully synchronous (remote NVIDIA embedding HTTP
call + Chroma HNSW query + `VectorStoreIndex.from_vector_store` rebuild per call,
`adapter.py:1839-1856`), so they run serially **and block the only event loop**. The same query
string is re-embedded once per collection, every time, with no memoization.

### 2.4 Job & ingestion mechanics

- Deep research: submitted straight to the local Dask cluster with **no queue-depth check or
  concurrency cap** (`frontends/aiq_api/src/aiq_api/jobs/submit.py:146-301`). Per-run internal
  fan-out is bounded (6 researchers, 5 source-tool slots); the *number of runs* is not.
- Ingestion: `/v1/ingest` spawns **one unbounded daemon thread per upload**
  (`adapter.py:812-818`), all embedding against the remote API and writing to one embedded Chroma
  file; job status lives in in-memory dicts on the accepting process (`adapter.py:617-620`).
- Restart loses in-flight Dask jobs; the ghost-job reaper marks them FAILURE after 300 s. No
  resume/replay.
- The purger is the model citizen: `SELECT … FOR UPDATE SKIP LOCKED`, attempts + backoff, stale
  reclaim (`frontends/ui/purger/db.js:23-55`). It is multi-instance-safe already.

### 2.5 Statefulness inventory (what pins work to a process)

| State | Location | Replica-safe? |
|---|---|---|
| Conversation checkpoints | SQLite by default; PG DSN supported (`src/aiq_agent/common/__init__.py:162-199`) | Only with PG |
| Citation source registry (accumulates across turns) | module-global LRU (`src/aiq_agent/common/citation_verification.py:352-373`) | **No** |
| Ingestion job/file status | in-memory dicts in singleton ingestor | **No** |
| Deep-research execution + cancel | localhost Dask futures | **No** |
| NAT job metadata/events | SQLite default; PG supported (+ `AIQ_LISTEN_DB_URL` for SSE) | Only with PG |
| BFF caches (flags, prompt view, catalog, platform) | per-process Maps | Stale-read hazard |
| Vector store | embedded Chroma on local volume | **No** |

---

## 3. Caching layer — design

### 3.1 Principle: classify by owner and mutation source

"Write-through vs read-through" is decided per touchpoint by **who writes the data**:

- **We are not the writer** (WorkOS memberships, FGA relations, feature flags, OpenRouter catalog):
  write-through is impossible; use **read-through with short TTL**, sized to the acceptable
  staleness of an *authorization* answer.
- **We are the single writer** (project prompt view, memory digest — both written only via the
  BFF, per ADR-0008 single-writer): **write-invalidate or write-through is cheap and exact**,
  because every mutation already passes through one code path.
- **Append-only high-volume** (usage ledger): cache the *aggregate*, not the rows — a **rollup
  table maintained transactionally on insert**. This is the one place a true write-through design
  is correct, and ADR-0015 already names it as the known scale-up.
- **Content-addressed, immutable** (query embeddings, OIB retrieval results, compiled Jinja
  templates, LLM prompt prefixes): cache key = content hash; no invalidation problem at all.

### 3.2 Touchpoint-by-touchpoint decision table

| Touchpoint | Today | Recommendation | Policy |
|---|---|---|---|
| WorkOS org-membership id (`session.ts:14-27`) | Network call **every request** | Read-through cache keyed `(userId, orgId)`; better: fold membership id into JWT claims at login so it rides the cookie | TTL 5–15 min; membership changes are rare and already tolerated at flag-cache staleness |
| FGA `authorization.check()` (`authz/projects.ts:59-63`) | Up to 6/upgrade, uncached | Memoize per `(membershipId, projectId, relation)` | TTL 30–60 s — short, because this is authz; combine with §4.2 dedup |
| Feature flags | 30 s in-process cache | Keep; move behind shared cache at replica ≥2 | TTL 30 s |
| Org model overrides (`model-config/service.ts:30-61`) | 2 queries/upgrade | Read-through cache; invalidate on the org-config write path (BFF is the writer → write-invalidate) | TTL 5 min + explicit invalidation |
| Budget **policies** (rows) | Queried per upgrade | Read-through, write-invalidate (BFF writes them) | TTL 5 min |
| Budget **spend** (aggregations) | 1–3 month-window `GROUP BY`s per upgrade | **Write-through rollup table** (`llm_usage_rollups`, per org/member/project per day), updated in the same transaction as `recordUsageEvents`; `getBudgetStatus` reads ≤3 indexed rollup rows | Exact, no TTL; backfill once from ledger |
| Project prompt view | 5 min per-process cache, local-only invalidation | Keep write-invalidate, but make invalidation shared (Redis pub/sub or a `version` column checked cheaply) before adding replicas — **currently a correctness bug at N>1** | Write-invalidate |
| Memory digest (`memory-service.ts:286-331`) | Query per upgrade + backend re-fetch per turn | Write-through: the internal memory endpoint is the only writer — update the cached digest on write. Serve the per-turn backend `fetch_memory_digest` call from it | Write-through, exact |
| OpenRouter catalog | 5 min in-process | Keep | TTL 5 min |
| Query embeddings (backend) | Same string re-embedded per collection per call | In-process LRU keyed by `hash(model, text)`; embed once per `search` call, reuse across the collection fan-out (restructure `retrieve` to accept a precomputed vector) | Content-keyed, size-bounded |
| OIB retrieval results | None | LRU keyed `(collection, hash(query), top_k)` for the **static** `oib_knowledge` collection only (invalidate on OIB re-sync, which already tracks corpus hashes in `oib_sync.py:61-63`); do *not* cache project/session collections (mutable) | TTL hours / version = corpus hash |
| LLM prompt prefixes | Resent uncached | Provider prompt caching (§6.1) | Provider-managed |
| Compiled Jinja templates (`common/prompt_utils.py:65-83`) | Recompiled per render | `functools.lru_cache` over template source → compiled `Template` | Permanent, content-keyed |

### 3.3 Where the cache lives

**Phase now (single host):** in-process caches are correct and free. Close the gaps above without
new infrastructure. Wrap them in one thin interface (`getCached(key, ttl, loader)` /
`invalidate(key)`) in the BFF and an equivalent helper in the backend so the storage backend is
swappable.

**Phase multi-replica:** introduce **Redis** as (a) shared cache backing that interface, (b)
pub/sub invalidation channel for prompt-view/flag/model-config edits, (c) shared rate-limit /
admission counters (§5). Do not introduce Redis before the second replica exists — every finding
above is fixable without it, and an unused Redis is pure operational drag. The one exception to
"wait": the spend rollup goes in **Postgres**, not Redis, because it must be transactional with
the ledger insert and survives restarts.

**Explicitly rejected:** a general write-through cache in front of `grid_app` reads
(projects/conversations/documents). These queries are cheap PK/indexed lookups once §7's indexes
exist; a caching tier there adds invalidation complexity for microseconds of win. Cache the
*expensive derived things* (aggregates, external calls, embeddings), not the rows.

---

## 4. Queueing — design

### 4.1 Verdict: no message broker

Signals that would justify Kafka/RabbitMQ/SQS — multiple consumer services, event fan-out to
independent subscribers, replay semantics, >10³ msgs/sec — are all absent. The system has exactly
two heavy asynchronous workloads (deep research, ingestion) plus deletion, and Postgres queue
tables with `SKIP LOCKED` already serve deletion correctly. Adding a broker now duplicates the
durable store (jobs would live in both PG and the broker) and adds an HA component to operate.
Re-evaluate only if event fan-out to multiple consumer services appears.

### 4.2 What is actually missing: admission control + bounded workers

The real "sudden surplus of users" failure mode today is not queue absence — it is that both heavy
entry points **accept unbounded work instantly**:

1. **Deep research** (`submit.py`): add a submission gate — count `RUNNING`+`SUBMITTED` rows in
   `job_info` (per org and global); above the global cap, either reject with 429 + retry-after or
   accept in a `QUEUED` state that a dispatcher promotes as slots free. The per-org cap prevents
   one tenant from starving others (real risk: each deep run can hold 6-wide researcher fan-out
   with 128k-token orchestrator calls).
2. **Ingestion** (`adapter.py:812`): replace thread-per-upload with a bounded
   `ThreadPoolExecutor` (2–4 workers) + a persistent `ingest_jobs` table (mirroring the purger
   pattern) so status survives restarts and resolves from any replica. This also serializes
   writers into embedded Chroma, which is currently contended by N concurrent threads.
3. **Chat itself needs no queue.** It is interactive; queueing a chat turn is just added latency.
   The protection chat needs is (a) the event-loop fix (§6.2) so heavy work can't stall it, (b) a
   cheap connection/rate limit at the gateway, and (c) the WS-upgrade cost reductions (§3.2, §7)
   so reconnect storms are survivable.
4. **Background reflection** (`project_memory/reflection.py:219-287`): fire-and-forget tasks on
   the live event loop with no cap — bound with an `asyncio.Semaphore` (e.g. 4) and drop (or
   defer) beyond it; reflection is best-effort by design.

### 4.3 Multi-replica execution model (when it comes)

The localhost-Dask design cannot span replicas (submit on A, cancel routed to B no-ops —
`routes/jobs.py:1076`). Two viable paths, in order of preference:

- **A. DB-claimed workers (recommended):** deep-research runs become rows; dedicated worker
  processes/containers claim with `FOR UPDATE SKIP LOCKED` (identical to the purger), heartbeat to
  the row, and cancellation becomes a status flip the runner's existing 1 s `CancellationMonitor`
  poll already respects. Web replicas become genuinely stateless; workers scale independently of
  chat capacity. This removes Dask rather than distributing it.
- **B. External shared Dask cluster:** smaller code delta but keeps Dask as an HA component,
  keeps cancel coupled to scheduler futures, and still needs the queue-depth gate.

Precondition for either (and for any second backend replica): flip the default SQLite stores to
the already-supported Postgres DSNs (`job_info`/`job_events`, checkpoints, summary store,
`AIQ_LISTEN_DB_URL`) — this is configuration, not code.

### 4.4 Single points of failure to acknowledge

The purger is single-instance (safe to run N, but nothing runs N). The gateway is one process for
all chat. Neither needs new machinery — a second purger container and (post §3.2/§4.2) a second
frontend replica behind the existing proxy are the fixes — but both are blocked on the shared-cache
invalidation work (§3.3) for the frontend.

---

## 5. Query & process optimization

Ordered by measured impact on the hot path:

1. **Add three indexes** (drizzle migration, zero risk):
   `projects(organization_id, deleted_at, created_at)`; `conversations(organization_id, updated_at)`;
   `messages(conversation_id, created_at)`. Postgres does not auto-index FKs; every tenant list
   query currently sequential-scans its table (`frontends/ui/src/lib/db/schema/{projects,conversations,messages}.ts`
   define no indexes).
2. **Spend rollup table** (§3.2) — converts the per-upgrade ledger scans (growing monthly,
   unbounded) into constant-time reads. Until then, at minimum `Promise.all` the 1–3 aggregations
   in `getBudgetStatus` (`budgets/service.ts:513-531`) — they are independent and currently serial.
3. **De-duplicate `requireProjectAccess`** on the WS-upgrade path (route re-checks what
   `buildCollectionScopeFromRequest` already checked): −1 tenancy query, −3 FGA calls per upgrade.
4. **Remove the gateway's loopback HTTP self-call** (`server.js:114-164`): extract header
   construction into shared code callable in-process, or keep the route but call the service layer
   directly. −1 full HTTP round-trip per connection.
5. **Document-list reconciliation N+1** (`lib/documents/reconcile-status.ts:133-181`): one backend
   status HTTP call per in-flight document on every list read. Batch into a single
   `/v1/documents/status?ids=…` backend endpoint, or push status via the internal API on job
   completion instead of polling on read.
6. **Backend per-turn document aggregation + memory-digest fetch** (`chat_researcher/register.py:443-579`)
   ride on every message; the digest fetch is served by §3.2's write-through cache, and the
   document summary aggregation is cacheable keyed on collection version.
7. **`collection.peek(limit=10000)` scans** to compute file counts (`adapter.py:968-1214`) —
   replace with Chroma `count()`/metadata queries before collections grow.
8. **DB pool posture:** postgres-js default 10 conns/replica, backend pools 5 — fine now; when
   replicas multiply, add PgBouncer (`prepare: false` is already set, but note
   `jobs.py:1325` LISTEN/NOTIFY needs a direct session — route SSE listeners around the pooler).

---

## 6. The AI agent — it scales worse *and* better than assumed

The premise "it's an intense process, nothing much to do" is half right: the token-heavy reasoning
is irreducible. But the *waste around it* is large, and one defect makes the agent tier's capacity
far lower than its CPU/token budget implies:

### 6.1 Cost: provider prompt caching (largest single lever)

Every LLM call resends identical multi-KB static prefixes — orchestrator/planner/researcher/writer
prompts (100–174 lines each), tool registry, source registry, card instructions, project context,
document summaries — with **no `cache_control`/provider caching hints anywhere**, across calls
*within* a deep run (dozens of calls) and across users. A deep run's orchestrator/planner run at
`reasoning_effort: max`, `max_tokens: 128000`. Enabling OpenRouter/Anthropic-style prompt caching
on stable prefixes (order prompts static-first, keep volatile content last) typically cuts input
cost of exactly this shape of workload substantially, with no behavior change. This composes with
the budget ledger: cheaper turns per user = more users per budget.

### 6.2 Latency/throughput: stop blocking the event loop (largest single defect)

`LlamaIndexRetriever.retrieve` (`adapter.py:1821-1856`) performs a remote embedding HTTP call and
a Chroma query synchronously inside `async def`, on the only event loop in the only uvicorn
worker. One user's retrieval freezes every other user's WS stream, heartbeat, and SSE. Fix:
`asyncio.to_thread` around the blocking body (hours of work), then de-duplicate the per-collection
re-embedding (§3.2). This single change is the difference between "one slow tenant degrades
everyone" and normal concurrent behavior. Additionally set `workers` / run multiple uvicorn
processes once in-process singletons allow it.

### 6.3 Bounded fan-out

Per-run concurrency is bounded (6 researchers, 5 source-tool slots, batch ≤4) — good — but bounds
are per-run: N concurrent deep runs = 6N researchers and N×(provider `max_retries` 5–10 ×
middleware retries) against upstream APIs, with `recursion_limit: 2000` as the only run-length
backstop. §4.2's job admission cap is what bounds the multiplication; additionally add a
process-wide semaphore on concurrent LLM calls to protect provider rate limits, and consider a
wall-clock cap per run.

### 6.4 Cheap per-call wins

Jinja templates recompiled every render (`prompt_utils.py:80` — memoize);
`VectorStoreIndex.from_vector_store` rebuilt per query (`adapter.py:1852` — cache per collection);
the common-case rebuild of a *second* full `DeepResearcherAgent` per request when only scoping/
overrides changed (`deep_researcher/register.py:246-277` — parameterize instead of reconstruct).

### 6.5 Replica-affinity facts (for the later horizontal-scaling phase)

With Postgres checkpoints configured, a conversation *can* move between replicas — except the
citation source registry (`citation_verification.py:352-373`) accumulates cross-turn state in a
process-local LRU. Persist it per conversation (checkpointer state or a table) before running two
backend replicas, or citations silently degrade after a failover. Async deep runs already carry
their context explicitly into workers (headers re-injected in `runner.py:472-503`), so *jobs* are
portable; it is the chat process that is sticky.

---

## 7. Phased roadmap

**Phase 0 — this sprint, no new infrastructure (top of list because each is hours, not days):**
indexes (§5.1); `asyncio.to_thread` retrieval fix (§6.2); WorkOS membership cache/claims (§3.2);
remove duplicate `requireProjectAccess`; parallelize `getBudgetStatus`; Jinja/template + index
object memoization; semaphore on reflection tasks.

**Phase 1 — single-host hardening (1–2 sprints):** spend rollup table (write-through, ADR);
provider prompt caching across agent prompts; query-embedding LRU + OIB retrieval cache keyed on
corpus hash; ingestion bounded pool + persistent `ingest_jobs` table; deep-research admission cap
(per-org + global); batch document-status reconciliation.

**Phase 2 — multi-replica readiness (when demand warrants):** Redis for shared cache +
invalidation pub/sub (fixes the prompt-view staleness bug at N>1) and shared rate limiting; flip
all SQLite defaults to shared Postgres DSNs; DB-claimed deep-research workers (retire per-pod
Dask); persist citation registry; second frontend replica + second purger; PgBouncer with a
LISTEN/NOTIFY bypass. Each of these deserves its own ADR when picked up (per the repo's ADR
obligation); this document is the assessment that scopes them.

---

## 8. What was deliberately not recommended

- **No message broker** (§4.1) and **no generic row-cache over `grid_app`** (§3.3) — complexity
  without a matching bottleneck.
- **No database-infrastructure changes** (out of scope by request) beyond additive indexes, one
  rollup table, and configuration flips to already-supported Postgres DSNs.
- **No agent-behavior changes** — every agent recommendation (prompt caching, embedding reuse,
  non-blocking I/O, admission control) preserves reasoning behavior and output quality.
