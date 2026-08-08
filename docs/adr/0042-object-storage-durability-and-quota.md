# ADR-0042: Object-storage durability — backup, quota, and least privilege

- **Status:** Proposed
- **Date:** 2026-08-07
- **Deciders:** Grid Agent team
- **Superseded in part by:** [ADR-0043](0043-seaweedfs-split-topology-and-per-tenant-buckets.md) — the topology split this ADR deferred, which is what turns chunk encryption from crypto-erasure into at-rest protection.
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

**2. Enforce a per-organization storage quota in the application, atomically.**

Two checks, and the distinction between them is the decision:

- **An advisory pre-check**, before any bytes reach SeaweedFS, so an upload that
  was never going to be admitted is refused without moving the file.
- **A hard ceiling at admission**, inside the same transaction that inserts the
  `documents` row, under a per-organization advisory lock
  (`insertDocumentWithinQuota`).

The pre-check alone was the original design and it was not a ceiling. It reads
`SUM(file_size)`, compares, and returns; the bytes and the row that records them
land afterwards. Two uploads that start together read the same sum, both pass,
and the organization ends over its limit by up to the per-file maximum times the
concurrency. Nothing reserved the capacity the check had approved, so the
approval was stale the moment it was given.

Serializing admissions per organization makes `SUM(file_size) <= quota` hold
after every commit, with `SUM` still the only source of truth — no counter to
drift and nothing to reconcile. The lock is held for a sum and an insert, not
across the upload.

**The object is written before the row, and a refusal deletes it.** The
alternative — insert first, reserving with the row itself, then upload — would
mean a row whose object does not exist, so every read path in the application
would have to learn a new in-flight state. That is a wide change for a narrow
problem and a new way to show someone a document that cannot be opened. So the
order stays, and `lib/storage/admission.ts` owns the compensating delete: a
refused upload must not leave an object nothing references, because an orphan
there is invisible to the UI, invisible to the quota ledger (which counts rows),
and findable only by a bucket-wide sweep.

Fail-closed, deliberately unlike the abuse limiter: a limiter that fails open
costs some traffic, a quota that fails open costs disk shared with every other
tenant. Unset means unlimited, so introducing quotas does not retroactively
block tenants who were never given a limit.

The quota lives in the `organizations.settings` jsonb bag, not a new table: it
is one nullable scalar with no history requirement. It is a **platform-owned**
key in that bag, which the generic tenant settings route refuses to write — see
decision 3.

**There is one way to insert a `documents` row, and it is the admitting one.**
`insertDocument` and `insertArchivDocument` were removed rather than left beside
it: a ceiling is only a ceiling if every insert passes through it, and a second
ungated path is how that stops being true.

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

**3b. Warn before the wall, once per crossing, to whoever can act.**

Decisions 2 and 3 together produce a quota that refuses an upload and cannot be
raised from inside the tenant. That is correct and, on its own, useless as a
warning: the first person to learn the limit exists is whoever happens to upload
the file that breaks, mid-task, and neither thing they could do about it —
delete documents, or ask the operator — is available in that moment. So an
hourly sweep (`runStorageAlertSweep`, behind the token-guarded
`POST /api/internal/storage/alerts`, driven by the `storage-alerts` CronJob)
raises an inbox item when an organization crosses **80 %** of its quota,
configurable via `GRID_STORAGE_ALERT_THRESHOLD_PERCENT`, escalating at 90 % and
100 %.

Four properties, each of which had a plausible wrong version:

- **Once per crossing, not once per sweep.** `upsertInboxItems` deliberately
  *revives* a row on conflict — `count + 1`, `read_at`/`resolved_at`/
  `archived_at`/`inert_at` all cleared — because for a mention a repeat genuinely
  is new information. For a standing condition it is not: relying on the group
  key alone would have re-surfaced a dismissed warning **every hour** until
  somebody freed space, which teaches people to ignore the inbox. The emitter
  therefore probes for a live row first (`findLiveInboxGroupKeys`) and the
  crossed bucket is part of the group key.
- **A re-crossing alerts again.** Falling back below the threshold *archives* the
  outstanding rows. That is not tidiness — an archived row is not "live", so the
  suppression probe passes again and a later re-crossing is announced. Ingest →
  bulk delete → ingest is a real sequence, and silently swallowing the second
  alert would be the worst failure this feature can have, because it looks
  exactly like nothing being wrong.
- **The feature gate is per item type, on the registry entry.** The inbox was
  gated as a whole behind the collaboration flag, which made an *operational*
  alert unreachable for precisely the tenants least likely to have bought a chat
  feature. `InboxTypeDefinition.gate` (`'collaboration' | 'operational'`) is now
  a field, and `visibleInboxTypes` derives the visible set from it in SQL for
  both the list and the badge — not a hardcoded list of exempt types at the
  route, which would drift the moment a second operational type is registered.
  Nav reachability follows the same derivation (`inboxIsReachable`), so removing
  the last operational type puts the inbox back behind the collaboration flag by
  itself.
- **Recipients are derived from a permission.** There is no "responsible for the
  org" concept in this system, so the closest true statement is "whoever can
  manage the organization's settings" — holders of `org:settings:manage`,
  resolved via `listOrganizationMembersWithRoles` + `findRoleSpec`. Those are the
  people who can both delete documents and talk to the operator, the only two
  ways out. An unknown role is *not* assumed to hold it. An organization with no
  such active member logs and does not throw: the sweep must carry on for every
  other tenant, and "a tenant heading for a wall with nobody home" is exactly the
  condition an operator needs to see.

**Known cap:** `listOrganizationMembersWithRoles` returns only the first page of
memberships (`PAGE_LIMIT = 100`), and this is not paginated on purpose — walking
every membership of every organization each tick to find two or three admins
would make a housekeeping sweep O(all members of the fleet). In an organization
with more than 100 memberships, an admin sorted past the first page will not be
notified. Accepted because the alert only has to reach *someone* who can act; if
that stops being true the fix is a role-filtered membership query in WorkOS, not
a loop.

The sweep re-enters each organization with `withTenant` after the one genuinely
cross-tenant aggregate, so the inbox writes stay subject to row-level security
rather than inheriting the route's `crossTenant` bypass.

**4. Drop `Admin` from the root S3 identity** and scope it to per-bucket object
actions on the buckets this stack creates. Bucket creation runs over `weed
shell` (gRPC to master), which does not go through S3 auth, so nothing needs
`Admin`.

**5. Treat encryption honestly rather than claiming it.**

`-encryptVolumeData` is exposed as `seaweedfsEncryptVolumeData`, which **defaults
to `true`** — `false` is the opt-out. (An earlier revision of this ADR called it
opt-in, which disagreed with both the code and the deployment guide.) It applies
to NEW writes only; objects written before it was enabled stay plaintext and keep
working.

Its real trade-off is recorded rather than glossed: keys are generated per chunk
and stored **in the filer metadata**, so the filer store becomes the key store for
every object. It protects against someone obtaining volume disks *without* the
filer store — which, under `seaweedfsTopology: single`, is nobody, because both
sit on the same PVC. ADR-0043's split topology with the Postgres filer store is
what makes those two different disks; `pulumi preview` warns when encryption is on
in a topology where they are not. Provider-level disk encryption remains the
better control for "disks at rest are encrypted"; this is for the GDPR-erasure
property (drop the metadata and the bytes become undecryptable).

Defaulting it ON raises the stakes on the metadata snapshot rather than lowering
them, and `loadConfig` warns when encryption is enabled with
`seaweedfsBackupEnabled` false: there is no master key and no escrow, so losing
the filer store makes every encrypted object unrecoverable. That is a warning
rather than a refusal because the safer default should not be harder to adopt
than the unsafe one.

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

Each of these is CONDITIONAL, and the condition is stated, because a consequence
list read as a guarantee is how an operator comes to believe in protection their
configuration does not provide.

- **When `seaweedfsBackupEnabled` is true and points at an external S3 target**
  (it is **off by default**, and a stack with it off has exactly the durability it
  had before this ADR), losing the SeaweedFS volume no longer loses the documents,
  and no longer loses the Postgres backups with them.
- **When a quota is set** — per organization, or fleet-wide via
  `GRID_DEFAULT_STORAGE_QUOTA_BYTES` — a tenant filling the disk becomes that
  tenant's problem, with a page that says so, rather than an outage for everyone.
  **Unset means unlimited**, which is what every existing deployment has until
  someone chooses otherwise.
- The blast radius of a leaked BFF S3 credential shrinks from "every bucket,
  every action" to "object CRUD on two known buckets". Unconditional: the identity
  set carries no `Admin` on any platform bucket regardless of configuration.
- A tenant cannot raise its own ceiling, so the quota is a real commercial
  control rather than a suggestion. Unconditional since the platform-owned key
  guard (`PLATFORM_OWNED_SETTINGS`) — before it, `PUT /api/organization/settings`
  accepted `storageQuotaBytes` from anyone holding `org:settings:manage`.
- The quota is a HARD ceiling, not a best-effort one: admission re-reads usage
  inside the transaction that inserts the row, under a per-organization lock, so
  concurrent uploads cannot jointly cross it.
- The limits are written down where they are enforced, so nobody has to
  rediscover that `filer.backup` starts empty or that 3.80 ignores SSE headers.
- There is now one page (`docs/deployment/kubernetes.md` §7e) that answers
  "what is encrypted?" per store and per channel, including the rows where the
  answer is "no" and the rows where the answer belongs to the provider.
- **Unless `allowUnauthenticatedRedis` is set**, a pod that gets a foothold in
  `grid` can no longer read every chat frame and every cached user record out of
  the cache for free. That opt-out exists for throwaway environments and is a
  deliberate hole when used.

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
  nothing says so. **A logical inventory must be compared after the first sync
  settles** — "the pod is running" is not evidence, and neither is a raw object
  count. The sink is `is_incremental`, so it retains historical copies and never
  propagates deletions, and the nightly `fs.meta.save` dump lands in the same
  bucket: the offsite object count is therefore expected to EXCEED the source, and
  can match it by coincidence while current keys are missing. Compare a normalized
  manifest of current `(bucket, key, size)` entries, excluding the snapshot
  prefix, per `docs/deployment/kubernetes.md` § 4.
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

- ~~Split the topology~~ — **done, in ADR-0043**: masters odd-only, volume servers
  as the capacity knob, filer store on Postgres, with the invalid-PostgreSQL
  `upsertQuery` from the 3.80 scaffold overridden. Not yet applied to a cluster;
  both stacks remain on `single`.
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
- ~~A platform-tier UI for the quota~~ — **done**: Platform → Storage lists every
  tenant ordered by consumption with an inline quota editor
  (`app/platform/storage-table.tsx`). What remains is paging: the list is bounded
  at `ORGANIZATION_PAGE_MAX` and says so when it truncates, rather than offering a
  cursor. Sorting happens in memory over an aggregate of another table, so a real
  cursor means moving the ordering into SQL — worth doing the day a fleet
  approaches that bound, and not before.

## References

- [SeaweedFS Data Backup](https://github.com/seaweedfs/seaweedfs/wiki/Data-Backup)
- [SeaweedFS Async Backup](https://github.com/seaweedfs/seaweedfs/wiki/Async-Backup)
- [SeaweedFS Filer Data Encryption](https://github.com/seaweedfs/seaweedfs/wiki/Filer-Data-Encryption)
- [SeaweedFS S3 Bucket Quota](https://github.com/seaweedfs/seaweedfs/wiki/S3-Bucket-Quota)
- [`../deployment/kubernetes.md`](../deployment/kubernetes.md)
