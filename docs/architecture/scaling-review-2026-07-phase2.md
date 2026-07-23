# Scaling review — Phase 2 (agent state & persistence)

Follow-up to `scaling-review-2026-07.md` (which was assessment-only). This round
was a four-agent investigation of **where the deep-research agent accumulates
information that does not scale**, across three axes: per-run context/state, the
knowledge/memory layer, and the async-job/Postgres layer. Each finding is
corroborated with `file:line` evidence. Items marked **[LANDED]** are fixed in
this PR; the rest are prioritized for follow-up.

## Verdict

The horizontal *mechanics* are sound (DB-claimed workers, shared Chroma, leader
locks). The problem is **unbounded accumulation** in three places and several
**hot-path queries/loops that scale with total history rather than active work**.
It runs fine at low volume and degrades continuously with usage (one exception —
the TTL-cleanup lock — is a cliff).

## P0 — unbounded growth / hot-path (fix first)

1. **LangGraph checkpoint tables never cleaned** (`checkpoints`/`checkpoint_blobs`/
   `checkpoint_writes`). Per-run byte growth is superlinear (full-state blob per
   changed channel per step). **[LANDED — deep]** `worker.py` now purges a deep
   run's `AIQ_DEEP_CHECKPOINT_DB` rows (`thread_id = job_id`) on non-cancelled
   completion (`_purge_deep_checkpoint`, tested). **[LANDED — chat]** the
   `AIQ_CHECKPOINT_DB` conversation checkpoints have no terminal event, so a
   leader-locked **age reaper** (`jobs/checkpoint_retention.py`,
   `reap_idle_threads`) now drops whole threads idle beyond
   `GRID_CHAT_CHECKPOINT_RETENTION_SECONDS` (default 14d), using the checkpoint's
   own `ts` field — no schema change; hourly, one replica per cycle
   (`pg_try_advisory_xact_lock`). Keep-last-K per hot thread remains a follow-up.
2. **`job_info` / `job_access` never expire in `db` mode** — NAT's periodic cleanup
   Dask task is skipped (`routes/jobs.py`) and nothing replaced it; also slowed
   the admission-count query. **[LANDED]** `access.expire_terminal_jobs` now runs
   inside the existing leader-locked event-cleanup cycle when there is no Dask
   client (db mode): it marks terminal rows `is_expired` past their per-row
   expiry (mirroring NAT, keeping the newest finished job) and hard-deletes rows
   past `GRID_JOB_INFO_DELETE_GRACE_SECONDS` (default 7d) across
   job_info/job_access/job_events. Tested.
3. **Per-token `job_events` inserts** (`callbacks.py:759-767`) — one row per streamed
   LLM token. Bounded by the 24h TTL (`event_store.py:649`) but heavy; **[LANDED]**
   `idx_job_events_created_at` so the TTL delete + ghost-reaper scan aren't full-table.
4. **Admission count unindexed on `organization_id`** — **[LANDED]** `idx_job_access_org`.
5. **`ingest_jobs` grew forever** (dead `delete()`) — **[LANDED]** wired into the
   retention prune.

## P1 — knowledge/memory per-turn & per-run cost

6. **`available_documents` dumps the whole project doc-summary table into every
   chat-turn prompt** (`chat_researcher/register.py:833`, `summary_store.get_all` with
   no LIMIT, 5 j2 templates). Per-turn LLM cost grows linearly with document count.
   *Fix:* cap to top-N (recency/relevance) at the aggregation layer, or a
   search-first `available_documents` tool.
7. **No orchestrator-level context compaction** — summarization is wired only into
   the leaf researcher (`factory.py:363`), not orchestrator/planner/writer; ~80k-token
   contexts confirmed. The budget guard counts only output tokens and is off by
   default (`budget_guard.py`). *Fix:* orchestrator-level summarization + prompt-token
   accounting in the guard.
8. **`run_research_batch` gathers all workers then `json.dumps` everything** into one
   ToolMessage (`tools/research.py:192-226,305`); writer keeps a ~1M-char window. *Fix:*
   stream/paginate note aggregation; writer reads persisted note files incrementally.
9. **TTL cleanup holds the shared ingest lock across a full store scan**
   (`base.py:106-153` → `adapter.py:1755` inside `self._lock`) — blocks all
   uploads/deletes, worsens with corpus size (a cliff). *Fix:* compute the deletion
   set off-lock; use Chroma `count()` not full metadata walks.
10. **`proj_*` Chroma collections never TTL'd** (`base.py:116`) — one persistent
    collection per project forever. *Fix:* archival policy for inactive projects.

## P2 — resource/robustness

11. **Fleet-wide Postgres connections uncapped** (~30/process × replicas + 1 unpooled
    per SSE viewer). *Fix:* central connection budget + SSE cap.
12. **`reap_exhausted` runs every worker every tick, un-leader-locked**
    (`worker.py:161`) — DB load scales with worker count, not job volume. *Fix:*
    leader-lock or de-cadence.
13. **`self._files` in-process dict never pruned** + O(n²) `list_files`
    (`adapter.py:1345,2055`). *Fix:* prune on the `_jobs` cadence.
14. **Uncapped embedded-image extraction + sequential VLM captioning**
    (`adapter.py:453,2579`) — one image-heavy PDF can starve the 2-worker ingest pool.
    *Fix:* cap image count (mirror `MAX_RENDERED_PAGES`), bound VLM concurrency.
15. **In-process citation registry, no per-run cap + 1000-session LRU, not
    replica-safe** (`citation_verification.py:180,409`). *Fix:* per-run cap; externalize.

## Landed in this PR
- `idx_job_access_org`, `idx_job_events_created_at` in the authoritative runtime
  schema-ensure (access.py / event_store.py) — see ADR-0027 for why they live there
  and not in the infra bootstraps.
- `ingest_jobs` retention (dead `delete()` wired).
- Deep-run checkpoint purge on completion (`worker._purge_deep_checkpoint`).
- Chat checkpoint age reaper (`jobs/checkpoint_retention.py`) — leader-locked,
  hourly, drops idle threads past the retention window.
- db-mode `job_info`/`job_access` expiry (`access.expire_terminal_jobs`) folded
  into the leader-locked event-cleanup cycle: mark-past-expiry + hard-delete-past-grace.

## Shallow / chat path (the interactive, higher-frequency path)

Investigated separately — it runs synchronously per chat turn over WebSocket on
the `aiq-agent` web tier (scales to `backendReplicas`). It is the volume driver.

### P0 (chat-specific)
- **CHAT TIER REPLICA-SAFETY** (`websocket_reconnect.py:90-435`). The WS session
  registry, HITL/clarifier futures, and the running LangGraph task are in-process
  with no cross-replica fallback. **[LANDED — conversation affinity, ADR-0028]**
  the frontend WS proxy now pins each conversation to its owning replica by
  `hash(conversationId) % N` via headless per-pod DNS, so reconnect/HITL return to
  the owner; `backendReplicas` is 2 again. **Follow-up (fully stateless):**
  Dragonfly pub/sub event bus so any replica serves any reconnect and a replica
  restart doesn't drop live streams.
- **No provider prompt caching + non-invariant static prefix** (`researcher.j2:36,64,84`;
  no `cache_control` anywhere) — the ~2-3k-token system prompt re-billed ~every
  turn; the meta/research branch and the per-turn live memory-digest sit above the
  KV-cache boundary. *Fix:* make the pre-boundary prefix byte-invariant; send
  `cache_control` breakpoints (content-block split) for providers that support it.
- **`available_documents` full-table dump every turn** (see P1 #6 above) is worst
  here — paid on every interactive turn including chit-chat.

### P1 (chat-specific)
- **Checkpoint pool `max_size=3`, shared chat+deep on one DSN** (`common/__init__.py:237`)
  — per-replica throughput ceiling. *Fix:* raise/tune; separate chat vs deep pools.
- **`trim_message_history` trims by message COUNT, not tokens** — `trim_messages(
  token_counter=len)` (`chat_researcher/utils.py:10`) makes `max_history=20` a
  message count; large messages defeat the budget. *Fix:* real token counter +
  summarize trimmed turns.
- **Per-turn citation verification cost grows with conversation length** — the
  session `SourceRegistry` only appends, and `verify_citations` runs against all
  cumulative sources every turn (`shallow_researcher/agent.py:500`).
- **Memory digest uncapped** on the per-turn `project_context` fetch + reflection
  prompt (`reflection.py:108`, `project_memory.py:94`).

### Well-designed (verified, no action)
- Memory reflection is fire-and-forget, semaphore-bounded, off the TTFT path
  (`reflection.py:311-395`) — good.
- Citation/card registries are session-scoped, LRU(1000)-bounded, Dragonfly-backed
  for cross-replica recovery (ADR-0020) — good.
