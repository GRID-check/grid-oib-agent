# ADR-0024: Storage-convergence reconciler & protocol-adapter model

- **Status:** Proposed
- **Date:** 2026-07-14
- **Deciders:** Grid Agent team
- **Supersedes (in part):** the "commit-detector + `document_ingest_queue`" ingest plan in `services/file-gateway/docs/ENTERPRISE-READINESS.md`
- **Related:** ADR-0005 (object storage), ADR-0011 (deletion pipeline), ADR-0021 (db-claimed workers), ADR-0023 (file-gateway + per-file FGA)

## Context — the reframe

The file-gateway was designed as "a drive that authorizes access and *fires an ingest
callback*." That framing is wrong. **GRID is a knowledge system; the drive is a
*projection* of a project's document set onto the OS filesystem, and its reason to
exist is that files landing there become agent-queryable knowledge, authorized per
WorkOS.** Under that framing the system has a **four-store consistency problem** it was
pretending it didn't have:

| Store | Role |
|---|---|
| The drive view (= S3) | what the user sees / intends |
| Postgres `documents` | derived index + lifecycle state |
| S3 objects | durable bytes |
| ChromaDB vectors | derived knowledge the agent queries |

The prior plan kept these convergent with **best-effort, per-event callbacks** (web
upload → `dispatchIngest`; drive write → a planned gateway "commit-detector" →
`POST /api/internal/commit-upload`). Every callback is a divergence opportunity: a
dropped one leaves a file that exists on the drive and in S3 but is **invisible to the
agent forever**. Two concrete holes confirm the framing is under-served today:

1. **Ingest is not durable.** `dispatchIngest` is fire-and-forget; the Python job store
   is in-memory (`foundational_rag/adapter.py` `_jobs` dict) — a restart loses in-flight
   jobs. Drive uploads don't get ingested at all (the commit-detector is unbuilt; the
   `commit-upload` seam is currently dead code).
2. **Drive deletion is a compliance/data-integrity bug.** `Guard.Remove`
   (`internal/storage/guard.go`) does a raw S3 object delete after an FGA `Editor` check
   and **nothing else**: it does **not** check `legal_holds`, does **not** remove the
   vector embeddings (so "deleted" content stays agent-searchable — a GDPR-erasure
   failure), orphans the `documents` row, and never enters the ADR-0011 deletion pipeline.

The codebase already contains the right pattern at a different scope: **`oib_sync.py` is
a file-drift reconciler** — it hash-diffs a directory against a registry and, for
new/changed files, calls `ingestor.delete_file()` then `ingestor.upload_file()`
(delete-then-reingest), and for removed files runs the full chunk+registry+summary
cleanup. The right architecture is to **generalize `oib_sync` from the OIB base corpus
to tenant/project scope**, as a durable claimed worker (the `purger`/ADR-0021 family).

## Decision

### 1. A storage-convergence **reconciler** is the primary ingestion & deletion mechanism

Replace the per-event callback design with a **periodic list-and-diff reconciler** that
makes the knowledge system converge with whatever is in S3, regardless of how it got
there (web upload, drive write, or API). This is chosen as **primary, not a safety net**:

- **Cloud-portable.** It depends only on `ListObjectsV2`, which is identical across
  MinIO, SeaweedFS, AWS S3, and R2 — so it survives the "lift to cloud S3 later"
  requirement. Bucket-notification config does *not* transfer between backends and is the
  first thing to silently break on migration; events are a later latency optimization,
  never the source of truth.
- **Self-healing.** A missed/duplicated/failed event permanently corrupts a pure
  event-driven design; a diff loop re-converges on the next sweep by construction.
- **It unifies durability.** The reconciler *is* the durable ingest mechanism: on each
  sweep, any document whose S3 object is present but whose status is not `completed`
  (bounded by an attempt cap) is (re-)dispatched to ingest. If Python was down, the next
  sweep retries. **This dissolves BOTH the commit-detector AND the proposed
  `document_ingest_queue`** — one loop, `oib_sync`-style.

The convergence direction is **S3 → `documents` → vectors**:

- **Arrived** (S3 object, no live row) → upsert `documents` row (idempotent key
  `(projectId, objectKey)`), dispatch ingest.
- **Changed** (row exists, S3 ETag differs from recorded) → `delete_file(old)` then
  re-ingest (replace stale embeddings — the `oib_sync` sequence).
- **Not yet ingested** (row present, object present, status ≠ `completed`, attempts <
  cap) → (re-)dispatch ingest.
- **Disappeared** (live row, no S3 object) → route into the **ADR-0011 deletion
  pipeline** (below).

### 2. Correctness — five guards against acting on transient state

A list-and-diff loop is only safe with these (all mandatory):

1. **Name filter** — never reconcile temp/lock artifacts (`~$*`, `*.tmp`, `.~lock*`,
   `.DS_Store`, `.ac$*`, `._*`). AEC apps write these constantly.
2. **Quiescence** — only act on an object whose `LastModified` is older than a settle
   window, so a save's temp→final rename sequence completes first. (S3 PutObject is
   atomic, so partial *bytes* never appear; the risk is the *rename sequence*.)
3. **ETag change-detection** — re-ingest only when the recorded ETag differs.
4. **Deletion grace-window** — a live row whose object is *absent* is treated as a
   delete **only if the row is older than a grace window**. This defends the web-upload
   ordering race (the row is written *before* `PutObject`, so a fresh row with no object
   is "upload in flight," not "deleted"). Acting on transient absence would destroy live
   uploads.
5. **Pipeline backstop** — a detected deletion is *enqueued* into `deletion_queue`
   (grace + legal holds), never hard-deleted directly.

### 3. Drive deletion — legal holds enforced synchronously, embeddings removed

- **`Guard.Remove` must check `legal_holds` synchronously before destroying bytes** (an
  extra field on the internal file-access decision, or a dedicated check). If held, the
  `rm` is denied and the file stays — bytes are never destroyed under a hold. This is a
  compliance requirement, not an optimization. **(Implemented in this PR.)** The gateway
  gains a `storage.HoldChecker` consulted in `Guard.Remove` after the Editor authz; the
  BFF exposes `POST /api/internal/file-deletable` (backed by `isDeletionUnderHold`, which
  mirrors the purger's org/project/document hold predicate). The check **fails closed** —
  an unreachable BFF or any uncertain answer *refuses* the delete (preserving bytes), the
  opposite posture to a read authz. The async embedding/row cleanup for an *allowed*
  delete is still driven by the reconciler's "disappeared" branch (below), not here.
- If allowed, the raw S3 delete proceeds (the file disappears from the drive
  immediately — correct `rm` UX), and the reconciler's "disappeared" branch drives the
  rest through the pipeline: a **new `document` purger** (registered in `purger/index.js`,
  the `entityType:'document'` slot that already exists) calls `ingestor.delete_file()`
  (per-file embedding removal), deletes the single S3 key, cleans up any per-file WorkOS
  resource, and soft-deletes/removes the row — all under the same `legal_holds` re-check
  and `MAX_ATTEMPTS`/backoff machinery as the project purger.
- **Documented semantic difference:** a *drive* `rm` is immediate (no undo — `rm` is
  `rm`); a *web* "Delete" keeps the ADR-0011 grace/undo window. This matches user mental
  models and is called out in the user guide.

### 4. Protocol is a swappable **adapter**, not a fixed choice

Because the reconciler decouples ingestion from the protocol, the mount protocol is now
purely an "authorized view" over the same `StoragePort`/`Guard`. There is no single
winning protocol, so we support more than one behind the same authz core:

| Protocol | Identity fit | Client (Windows) | Deploy | Verdict |
|---|---|---|---|---|
| **NFSv3** (built, since removed) | weak — `AUTH_NULL`, needs mount-token + network isolation | 2nd-class | privileged (FUSE/`SYS_ADMIN`) | removed with ADR-0025 (in git history); returns only as NFSv4+Kerberos |
| **WebDAV** (this ADR) | **best** — per-request `Authorization` header, checked in middleware | works, caveats (≤50MB default, HTTPS/Basic registry tweaks, perf) | **plain HTTP, no privilege** | adopt as the identity-carrying + easy-deploy front |
| **SMB** (Samba) | good — authenticated session | **best, native** | Samba + in-tree VFS (heavy) | documented Windows-native ideal (ADR-0023) |

**Decision:** add **WebDAV** as a second adapter now — it dissolves the H3 identity
blocker (HTTP carries a real per-request credential) *and* the M8 privileged-container
blocker (no FUSE) for every HTTP-capable client (macOS/Linux, managed Windows). Keep
NFS. SMB remains the Windows-native follow-up. The authz core and the reconciler are
identical across all three.

## Consequences

- **Positive:** one durable, self-healing convergence path for web + drive + API;
  drive-upload ingest and drive-delete correctness fall out for free; the fragile
  commit-detector and the `document_ingest_queue` are both deleted from the plan; a
  cloud-portable trigger; a non-privileged HTTP mount option; the legal-hold/GDPR hole is
  closed.
- **Negative / risks:** convergence latency = sweep interval (bounded by scoping sweeps
  per org/project and varying cadence); at very large scale a full-bucket diff is costly
  (mitigate with prefix scoping + ETag short-circuits + later event-driven latency
  layer); the reconciler must be idempotent and guard-complete (§2) or it will corrupt
  state — so its diff logic is unit-tested exhaustively as a pure function
  (`reconcile-plan`).

## Alternatives considered

- **Commit-detector on the gateway (prior plan)** — rejected as primary: couples ingest
  to fragile filesystem-event detection over NFS, duplicates the temp-file/quiescence
  problem, and gives no self-healing. Retained only as an optional *latency* optimization
  (fire an inline reconcile of one key on write-close).
- **Bucket notifications as primary** — rejected: not portable across S3 backends
  (breaks on cloud migration), at-least-once, and no infra exists today. A later latency
  layer on top of the reconciler, never the source of truth.
- **Pick one protocol** — rejected: no single winner; the adapter model is the correct
  factoring given a protocol-agnostic authz core.

## Follow-ups

- Build the reconciler worker (sibling of `purger`) around the pure `reconcile-plan` diff
  core (`frontends/ui/src/lib/documents/reconcile-plan.ts`, landed + exhaustively tested
  in this PR), the `document` purger + the `ingestor.delete_file` maintenance route, and
  the `(projectId, objectKey)` unique index / upsert. (`Guard.Remove` legal-hold check is
  done — see §3.)
- WebDAV production identity: **done — ADR-0025** (SSO-brokered device credentials over
  Basic, verified via `/api/internal/mount-auth`; HTTPS at the ingress; Windows
  file-size registry note in `services/file-gateway/docs/MOUNTING.md`).
