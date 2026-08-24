# ADR-0020: Dragonfly as the shared cache tier

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Platform engineering
- **Related:** ADR-0019 (usage rollups), ADR-0003 (BFF split), ../architecture/scaling-review-2026-07.md

## Context

Every cache in the system was per-process: the BFF's feature-flag, prompt-view,
model-catalog, and platform-membership Maps; the backend's engine caches and
LRUs. Two consequences:

1. **Multi-replica correctness bug in waiting.** `invalidateProjectPromptViewCache`
   only cleared the local replica — with two frontends, a project-profile edit
   kept injecting stale project context into the agent from the other replica
   for up to 5 minutes. Same class of problem for flags and model overrides.
2. **Replica-pinned conversation state.** The citation source registry
   accumulates cross-turn state in a process-local LRU; a conversation resumed
   on another replica (or after a restart) silently lost its prior-turn
   sources.

Additionally there was no rate limiting anywhere; an in-process limiter would
be ineffective the moment a second replica exists.

## Decision

We will run **Dragonfly** (Redis-protocol, single binary) as the stack's
shared cache tier, and consume it exclusively through two thin modules:

- **BFF:** `frontends/ui/src/lib/cache/index.ts` — `getCached(key, ttl, loader)`
  read-through + `invalidateCached`. Backed by ioredis when `REDIS_URL` is
  set, an in-process TTL map otherwise.
- **Backend:** `src/aiq_agent/common/cache.py` — `get_json`/`set_json`/
  `delete`/`incr_fixed_window`, same `REDIS_URL` switch and fallback.

What lives in it (all values JSON, all reconstructible):

| Use | Keys | Policy |
|---|---|---|
| WorkOS membership id | `membership:{org}:{user}` | read-through, 10 min (30 s negative) |
| Feature flags | `flags:{org}` | read-through, 30 s |
| Project prompt view | `promptview:{project}` | write-invalidate on profile edits |
| Org model overrides | `modeloverrides:{org}` | write-invalidate on config save/rollback |
| Budget limits (enforcement) | `budgetlimits:{org}:{scope}:{subject}` | write-invalidate on policy writes |
| OpenRouter catalog | `openrouter:catalog` | read-through, 5 min |
| Citation-registry snapshots | `citations:{conversation}` | written after each turn, TTL 24 h |
| WS-upgrade rate limiting | `ratelimit:ws:{ip}:{window}` | fixed window, `GRID_WS_UPGRADE_RATE_LIMIT`/min |

Explicitly NOT in it: budget **spend** (exact write-through rollup in
Postgres, ADR-0019), job/queue state (Postgres), documents/vectors, anything
whose loss is not tolerable — Dragonfly runs with `cache_mode=true`
(evict under memory pressure) and **no persistence volume**; every value can
be rebuilt from Postgres, WorkOS, or the next turn.

Operational posture: one container, 256 MB memory cap, 1 proactor thread
(Dragonfly requires ≥ 256 MiB of maxmemory per thread, so a second thread
would double the cap for nothing at our scale),
health-checked; both app tiers **fail open to their in-process fallback** on
any cache error, so the stack runs unchanged with the container stopped or
`REDIS_URL` unset (dev outside Docker, tests).

## Consequences

### Positive

- Cross-replica cache coherence: profile/flag/model-config edits invalidate
  once, globally — the known N>1 stale-context bug is fixed before N>1 exists.
- Conversations lose their replica affinity for citations: prior-turn sources
  survive restarts and failovers.
- Rate limiting has a home that stays correct across replicas.
- Upstream load (WorkOS, OpenRouter) stops multiplying with replica count.

### Negative

- One more container to run and monitor (mitigated: cache-only semantics, no
  persistence, fail-open callers — it can be killed with no data loss).
- JSON round-trip constraints on cached values (deliberate: it keeps values
  replica-safe by construction).

### Risks

- **Treating the cache as a store.** Guarded by convention (this ADR) and by
  `cache_mode` eviction making any such misuse visibly lossy early.
- **Auth:** the compose network is private and Dragonfly is not exposed;
  when the network boundary changes, set `--requirepass` and carry the
  password in `REDIS_URL`.

## Alternatives Considered

- **Redis** — the API we actually use; Dragonfly speaks it verbatim. Chosen
  Dragonfly for materially better memory efficiency and multi-threaded
  throughput on a single node, and a simpler single-binary operational story.
  Because every consumer speaks the Redis protocol through the two thin
  modules, swapping to Redis/Valkey is a one-line compose change — the choice
  is deliberately low-stakes.
- **Valkey** — equivalent fit; Dragonfly preferred for the same
  single-node-throughput reasons. Also a one-line swap if preferences change.
- **Postgres as cache (UNLOGGED tables)** — keeps the stack at one store, but
  puts cache churn on the same instance the ledger and app data live on, and
  offers no native TTL/eviction; rejected.
- **No shared tier / per-process caches with pub/sub invalidation** — still
  needs a broker for the pub/sub, at which point the broker may as well hold
  the values; rejected as complexity without savings.

## Open Questions / Follow-ups

- Move the WS-upgrade limiter key from IP to authenticated user id once the
  gateway parses the session (today it deliberately stays dumb).
- Candidate next tenants: FGA check memoization (short TTL), document-summary
  aggregation per collection version.

## References

- `frontends/ui/src/lib/cache/index.ts`, `src/aiq_agent/common/cache.py`
- `deploy/compose/docker-compose.yaml` / `docker-compose.coolify.yaml` (`dragonfly` service)
- https://www.dragonflydb.io/
