# ADR-0011: Deletion pipeline — soft-delete → restore → hard-purge with legal holds

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Grid Agent team
- **Related:** [ADR-0004](0004-tenancy-ownership-and-access-model.md), [ADR-0005](0005-object-storage-for-documents-minio.md), [`../architecture/deletion-pipeline.md`](../architecture/deletion-pipeline.md)

## Context

A project's data spans several stores — `grid_app` rows, MinIO objects, a Chroma
collection, job rows, checkpoints, and a WorkOS FGA resource. Deleting it must be
(a) reversible for a grace window (mistakes happen), (b) complete across every
store (GDPR erasure), and (c) blockable by a legal hold. A single synchronous
delete cannot satisfy all three safely.

## Decision

We will make project deletion a **two-phase pipeline**:

1. **Soft-delete + enqueue.** The project is marked deleted and a `deletion_queue`
   row is created with `purge_after = now + PROJECT_PURGE_GRACE_DAYS`. It is
   **restorable** while the row is un-claimed.
2. **Hard-purge.** A dedicated `purger` worker claims due rows (with backoff and
   `FOR UPDATE SKIP LOCKED`), re-checks **`legal_holds`** before each destructive
   step, and destroys external stores first (backend resources, MinIO prefix,
   WorkOS resource), deleting the `grid_app` project row **last** so a failed
   purge stays recoverable and retryable.

## Consequences

### Positive
- Recoverable within the grace window; complete erasure after it; legally holdable.
- Ordered, idempotent, retryable steps; failures don't orphan data silently.

### Negative
- A separate long-running worker service and a queue to operate/monitor.

### Risks
- Partial failures across non-transactional external stores — mitigated by
  surfacing MinIO/backend partial-failure signals (throw + retry), per-step hold
  re-checks, and restoring only un-claimed rows.
- A crashed final attempt can strand a row in `purging` (known follow-up).

## Alternatives Considered
- **Synchronous cascade delete on the request** — rejected; not reversible, and a
  mid-cascade failure orphans data with no retry.
- **Rely on DB cascade only** — rejected; cannot reach MinIO / Chroma / WorkOS.

## Open Questions / Follow-ups
- Reclaim/surface stranded `purging` rows; add purger SQL tests; purgers for
  document/conversation/org/user entity types.

## References
- [`../architecture/deletion-pipeline.md`](../architecture/deletion-pipeline.md)
