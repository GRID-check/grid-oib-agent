# ADR-0042: Object-storage durability — backup, quota, and least privilege

- **Status:** Proposed
- **Date:** 2026-08-07
- **Deciders:** Grid Agent team
- **Related:** [ADR-0005](0005-object-storage-for-documents-minio.md), [ADR-0011](0011-deletion-pipeline.md), [ADR-0024](0024-org-wide-document-archiv.md), [ADR-0041](0041-row-level-security-for-tenant-isolation.md), [`../deployment/kubernetes.md`](../deployment/kubernetes.md)

## Context

An infrastructure audit of the object-storage tier found four problems that
shared one property: none had any mitigation at all, and each fails as a
cluster-wide event rather than a scoped one.

**The documents bucket had no backup.** Postgres has continuous PITR via
CloudNativePG — and its archive is written to the *same* SeaweedFS. A single
volume loss therefore destroyed the customer documents and the database backups
together. `docs/deployment/kubernetes.md` already admitted this in one line; it
had not been acted on.

**Nothing limited how many bytes a tenant could store.** The only ceilings were
the PVC size and `-volume.max`, and reaching either fails every tenant's uploads
at once. There was no per-org quota at any layer, and no way to see usage.

**The BFF and purger held the root `grid` S3 identity**, with `Admin` on every
bucket. That reaches the Postgres backup bucket, and — because the identity can
`PutObject` over any key — it can replace an existing document's bytes in place
while the `documents` row keeps pointing at the same key, so preview and
download serve substituted content with no trace.

**Nothing was encrypted at rest.** Not the PVCs, not the objects.

A prerequisite for fixing any of it was establishing what SeaweedFS 3.80 — the
pinned production image — actually supports, because the wiki documents a
moving target. Three findings shaped the decision:

- **S3 server-side encryption does not exist in 3.80.** SSE-S3, SSE-KMS and
  SSE-C first appear in 3.97. A client sending
  `x-amz-server-side-encryption: AES256` to 3.80 gets a **successful response and
  an unencrypted object** — a silent compliance hazard.
- **`weed filer.backup` has no initial full-copy phase.** It is a subscriber to
  the filer's metadata change log, so it converges to a complete mirror only
  while that log is intact, and it reports nothing when it is not.
- **SeaweedFS cannot take a consistent point-in-time backup of a bucket.** The
  namespace (filer) and the bytes (volumes) are separate subsystems with no
  coordinated snapshot; the project's own guidance is to pause writes.

## Decision

**1. Back up the documents bucket in two layers, both off-cluster.**

- A long-running `weed filer.backup` process mirrors `/buckets` into an
  **external** S3 target, with `is_incremental = true` so deletions are not
  propagated and a bulk delete stays recoverable.
- A nightly `fs.meta.save` CronJob captures the namespace — the only
  point-in-time primitive SeaweedFS offers — and asserts the dump is non-empty,
  because `weed shell` exits 0 even when the command inside it failed.

`loadConfig` **refuses** an in-cluster backup endpoint. A backup written to the
disk you are trying to survive losing is not a backup, and the configuration
should not let anyone believe otherwise.

**2. Enforce a per-organization storage quota in the application.**

Checked before any bytes reach SeaweedFS, so a refusal leaves no orphan object.
Fail-closed, deliberately unlike the abuse limiter: a limiter that fails open
costs some traffic, a quota that fails open costs disk shared with every other
tenant. Unset means unlimited, so introducing quotas does not retroactively
block tenants who were never given a limit.

The quota lives in the `organizations.settings` jsonb bag, not a new table: it
is one nullable scalar with no history requirement.

**3. The quota is set by the platform owner, never by the tenant.**

A limit the constrained party can raise is not a limit. The write lives at
`PUT /api/platform/organizations/[organizationId]/storage`, gated by
`platformApiRoute`'s `requirePlatformOwner`, and `setStorageQuota` takes an
explicit `organizationId` rather than reading one off the caller's session — a
platform owner browsing another tenant holds no membership in it. Same placement
and same reasoning as `platform_model_defaults`.

Organization → Storage shows the reading to **every member, read-only for every
role including org admin**, and says who owns the number so nobody hunts for a
control that is not there. A member whose upload was just refused is usually not
an admin, and this page is the only thing that explains the refusal.

**4. Drop `Admin` from the root S3 identity** and scope it to per-bucket object
actions on the buckets this stack creates. Bucket creation runs over `weed
shell` (gRPC to master), which does not go through S3 auth, so nothing needs
`Admin`.

**5. Treat encryption honestly rather than claiming it.**

`-encryptVolumeData` is exposed as an opt-in config flag with its real trade-off
recorded: keys are generated per chunk and stored **in the filer metadata**, so
the filer store becomes the key store for every object. It protects against
someone obtaining volume disks *without* the filer store — not the usual failure
in a single-namespace cluster. Provider-level disk encryption remains the better
control for "disks at rest are encrypted"; this is for the GDPR-erasure property
(drop the metadata and the bytes become undecryptable).

We do **not** claim SSE support on 3.80, because there is none.

## Consequences

### Positive

- Losing the SeaweedFS volume no longer loses the documents, and no longer loses
  the Postgres backups with them.
- A tenant filling the disk becomes that tenant's problem, with a page that says
  so, rather than an outage for everyone.
- The blast radius of a leaked BFF S3 credential shrinks from "every bucket,
  every action" to "object CRUD on two known buckets".
- A tenant cannot raise its own ceiling, so the quota is a real commercial
  control rather than a suggestion.
- The limits are written down where they are enforced, so nobody has to
  rediscover that `filer.backup` starts empty or that 3.80 ignores SSE headers.

### Negative

- A second long-running process and a CronJob to operate.
- Backup requires an external S3 target that someone must provision and pay for.
- The quota check adds one aggregate query to the upload path.
- Enabling volume encryption makes the filer store unrecoverable-if-lost, which
  raises the stakes on the metadata snapshot rather than lowering them.

### Risks

- **The mirror can be silently incomplete.** `filer.backup` replays the metadata
  log; if that log was ever purged, or the filer store was migrated via
  `fs.meta.load` (which does not regenerate it), the baseline is partial and
  nothing says so. **Object counts must be compared after the first sync
  settles.** "The pod is running" is not evidence.
- **Neither layer is point-in-time consistent**, and the two restore by
  *different* procedures. Mixing them — loading a metadata dump against volumes
  it does not match — produces a namespace of dangling chunk references where
  every GET 404s.
- A restore that has never been rehearsed is a hypothesis. The runbook exists;
  executing it against the dev stack is the follow-up.
- The quota counts `documents.file_size`, which is the ledger, not the bucket.
  Bytes written outside the document service have no row and are invisible to
  it — which is a reason writes must keep going through the service.

## Alternatives Considered

- **Volume snapshots only (CSI/`snapscheduler`)** — kept as a complement, not a
  substitute. They are the fastest path back from a bad migration, but they live
  on the same provider and do not survive cluster or account loss.
- **`weed backup` (volume-level)** — rejected as the primary. It copies
  `.dat`/`.idx` bytes with no namespace, so the output cannot be mapped back to
  S3 keys without a matching metadata dump, and a loop over volume ids is not a
  consistent snapshot.
- **`weed filer.sync`** — rejected. It is bidirectional by default, so a mistake
  on the backup side propagates back into production.
- **SeaweedFS bucket quota (`s3.bucket.quota`)** — rejected as the enforcement
  point. It is advisory: nothing in the S3 layer reads it, and it only takes
  effect when a separately-scheduled `s3.bucket.quota.enforce -apply` flips the
  bucket read-only. It is also per-bucket, and all tenants share one bucket.
  Retained as a possible cluster-level backstop.
- **Splitting the single `weed server` into master/volume/filer tiers** — not
  rejected, deferred. It is the right end state and the flags are now verified,
  but migrating the existing `/data` PVC is undocumented upstream and carries
  real data-loss risk. Doing it *after* a working backup exists is the correct
  order, and that is the point of this ADR.

## Open Questions / Follow-ups

- Split the topology (masters ≥1 **odd only** — an even peer count is a fatal
  error, not degraded mode; volume servers scaled independently; filer store on
  Postgres). Note the 3.80 scaffold ships an `upsertQuery` that is invalid
  PostgreSQL and must be overridden.
- Rehearse a restore end to end on the dev stack.
- Decide whether SSE justifies an upgrade to ≥3.97, which brings its own key
  management (lose the KEK, lose the objects).
- Provider-level encryption for the PVCs, which is the control that actually
  matches "encrypted at rest".
- Per-org quota defaults per plan/tier, once there are plans.
- A platform-tier UI for the quota. The API exists and is gated; the operator
  currently sets it with an authenticated `PUT`, which is enough to run the
  control but is not yet a screen.

## References

- [SeaweedFS Data Backup](https://github.com/seaweedfs/seaweedfs/wiki/Data-Backup)
- [SeaweedFS Async Backup](https://github.com/seaweedfs/seaweedfs/wiki/Async-Backup)
- [SeaweedFS Filer Data Encryption](https://github.com/seaweedfs/seaweedfs/wiki/Filer-Data-Encryption)
- [SeaweedFS S3 Bucket Quota](https://github.com/seaweedfs/seaweedfs/wiki/S3-Bucket-Quota)
- [`../deployment/kubernetes.md`](../deployment/kubernetes.md)
