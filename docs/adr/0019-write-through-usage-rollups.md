# ADR-0019: Write-through daily rollups for budget enforcement

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Platform engineering
- **Related:** ADR-0015 (LLM budgets and usage ledger), ../architecture/usage-budgets.md, ../architecture/scaling-review-2026-07.md

## Context

ADR-0015 enforces budgets by aggregating the `llm_usage_events` ledger on every
WebSocket upgrade (`getBudgetStatus` → `getSpendSummary`): up to three
month-window `GROUP BY` scans (org, member, project) per connection. ADR-0015
itself named "a rollup table when ledger scans show up in p95s" as the known
scale-up. The ledger is append-only and grows without bound, so the per-upgrade
cost grows monthly, and reconnect storms multiply it.

A plain cache is the wrong tool here: spend changes on every LLM generation,
so any TTL either serves stale enforcement decisions or barely hits. What the
hot path needs is the *aggregate maintained at write time*.

## Decision

We will maintain a write-through daily rollup table, `llm_usage_rollups`, with
one row per `(organization_id, UTC day, user_id, project_id)` (empty string for
"no user"/"no project" so the composite primary key stays non-null).

- `recordUsageEvents` increments the affected rollup rows via
  `INSERT … ON CONFLICT DO UPDATE` **in the same transaction** as the ledger
  insert. The rollup is therefore exact — an aggregate, not a cache; there is
  no invalidation problem and no drift as long as the ledger keeps its
  single-writer rule (ADR-0008/0015: all writes go through the internal BFF
  endpoint → `recordUsageEvents`).
- Budget enforcement (`getBudgetStatus`) reads day/month totals from the
  rollup (`getSpendTotals`) — a month of daily rows per scope instead of a
  ledger scan.
- Admin analytics that need per-model or per-member breakdowns
  (`getSpendSummary`, `getSpendByMember`, daily trend) keep reading the ledger;
  they are rare (settings page) and need dimensions the rollup grain does not
  carry.
- Migration `0015` backfills the rollup from the existing ledger.

## Consequences

### Positive

- Per-upgrade budget checks become constant-time indexed reads regardless of
  ledger size; the acknowledged ADR-0015 scale-up is done.
- Exactness: enforcement reads the same numbers the ledger implies, always.

### Negative

- Every usage flush pays one extra upsert per distinct (org, day, user,
  project) in the batch (batches are small — tracker flushes ≤5 events).
- A second representation of spend exists; ad-hoc writes to the ledger that
  bypass `recordUsageEvents` would silently diverge from the rollup.

### Risks

- **Divergence via out-of-band writes** — mitigated by the existing
  single-writer rule; a reconciliation query (`GROUP BY` the ledger, diff the
  rollup) can be run ad hoc or before raising limits.
- **Hot-row contention** on an org's current-day row under very high write
  concurrency — acceptable: flushes are batched and serialized per backend
  process today; revisit with per-shard rows only if upsert contention shows
  up in p95s.

## Alternatives Considered

- **TTL cache of spend totals** — stale enforcement decisions for the TTL
  window; a budget that just exhausted would keep admitting turns. Rejected.
- **Materialized view refreshed on a schedule** — same staleness problem plus
  refresh cost proportional to ledger size. Rejected.
- **Aggregating on a covering index only** — the existing indexes already
  cover the scan; the cost is row volume, which only grows. Rejected as a
  non-fix.

## Open Questions / Follow-ups

- Monthly retention/compaction of rollup rows older than the audit horizon
  (cheap: rows are tiny; revisit with data-retention policy work).

## References

- ADR-0015 §"Known scale-ups"
- `frontends/ui/src/lib/budgets/service.ts` (`recordUsageEvents`, `getSpendTotals`)
- `frontends/ui/drizzle/0015_llm_usage_rollups.sql`
