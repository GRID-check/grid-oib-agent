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

**Amendment (2026-08-07) — the same rule, applied to the rest of the data
path.** Auditing what else was plaintext produced three findings; the honesty
rule above decided all three, and the outcomes differ because the facts do.

*The Postgres PITR archive was the worst of them.* `barmanObjectStore` set
compression and no encryption, so with `pgBackupsEnabled` the WAL stream and
every base backup — a byte-for-byte copy of all three databases, every
conversation and every LangGraph checkpoint — were written to object storage in
the clear. CloudNativePG does support encryption there, and the exact shape was
verified against the CRD this repo's `validate-crs.mjs` pins (v1.28.0) rather
than assumed: the field lives on `barmanObjectStore.wal` and
`barmanObjectStore.data`, **not** at the top level, and its enum is
`["AES256", "aws:kms"]` with no empty member — "off" is the key being absent.
It is exposed as `grid-oib:pgBackupEncryption`.

But it is *server-side* encryption: barman-cloud turns it into an
`x-amz-server-side-encryption` header, which is exactly the request 3.80 answers
`200` to while storing plaintext — the silent compliance hazard this ADR opened
with, arriving from a second direction. So the setting is **refused** when the
destination is the in-cluster SeaweedFS, rather than accepted into a Cluster
spec that would read `encryption: AES256` over unencrypted bytes. It is usable,
and useful, against an external S3 destination that documents SSE support. With
the default in-cluster destination the archive stays as protected as the
SeaweedFS volumes beneath it and no more, `pulumi up` says so on every deploy,
and `docs/deployment/kubernetes.md` §7e says so in the table someone will cite.

*Dragonfly had no authentication at all* — no password, no TLS, on a namespace
whose NetworkPolicy lets any pod dial 6379 — while holding the ADR-0028
conversation bus (every WebSocket frame of every chat, replayable), the cached
WorkOS directory, authorization decisions and budget state. "Cache semantics"
described its durability and had been quietly read as describing its
sensitivity. `requirepass` is now required on both instances
(`dragonflyPassword`, `rateLimitStorePassword`, enforced distinct, with an
explicit `allowUnauthenticatedRedis` opt-out). The transport stays plaintext
RESP; that is stated rather than papered over, because closing it means mTLS
between services, which means a mesh, which is a separate decision.

*PVC encryption at rest could not be fixed here, so it was not pretended to
be.* This ADR already named provider-level disk encryption as the control that
actually matches "encrypted at rest". Investigating it produced no
implementation: Kubernetes has no per-PVC encryption field, the property comes
from the StorageClass's `parameters`, those are fixed at class-creation time,
and nothing in this repo creates a StorageClass — `grid-oib:storageClass` only
names a provider-supplied one. Any config key added here would have done
nothing. It is recorded as an operator action instead, alongside the
`EncryptionConfiguration` for Secrets in etcd, which is likewise control-plane
and likewise out of reach. Both are the ceiling on every at-rest claim the stack
makes, including this ADR's own chunk encryption, whose keys are Kubernetes
Secrets.

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
- There is now one page (`docs/deployment/kubernetes.md` §7e) that answers
  "what is encrypted?" per store and per channel, including the rows where the
  answer is "no" and the rows where the answer belongs to the provider.
- A pod that gets a foothold in `grid` can no longer read every chat frame and
  every cached user record out of the cache for free.

### Negative

- A second long-running process and a CronJob to operate.
- Backup requires an external S3 target that someone must provision and pay for.
- The quota check adds one aggregate query to the upload path.
- Enabling volume encryption makes the filer store unrecoverable-if-lost, which
  raises the stakes on the metadata snapshot rather than lowering them.
- Two more required secrets on every stack (`dragonflyPassword`,
  `rateLimitStorePassword`), and an existing stack cannot deploy until it sets
  them. That is the intended cost of not leaving authentication off by default.
- The Dragonfly password now travels inside `REDIS_URL`, which makes that
  variable secret and moves it into the `grid-secrets` Secret — so rotating it
  is a rolling update of the app tier, not a config edit.

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
  matches "encrypted at rest". Investigated (see the 2026-08-07 amendment) and
  confirmed to be an **operator action**, not a config change: the StorageClass
  is provider-supplied and this repo creates none, so ask the provider for an
  encrypted class and point `grid-oib:storageClass` at it.
- Confirm with the provider whether the API server runs an
  `EncryptionConfiguration` for Secrets in etcd. Every KEK in this stack — the
  BYOK local KEK, the job-payload KEK, the Dragonfly passwords — is a Secret,
  so the answer bounds every at-rest claim above.
- TLS on the intra-namespace hops (`ws://` chat, `http://aiq-agent`,
  `http://chroma`, RESP to Dragonfly, OTLP). Deferred as a mesh decision, not a
  per-service flag.
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
