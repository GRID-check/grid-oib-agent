# ADR-0043: SeaweedFS split topology, a Postgres filer store, and a bucket per tenant

- **Status:** Proposed
- **Date:** 2026-08-08
- **Deciders:** Grid Agent team
- **Related:** [ADR-0005](0005-object-storage-for-documents-minio.md), [ADR-0011](0011-deletion-pipeline.md), [ADR-0038](0038-one-authorization-catalog-and-decision-point.md), [ADR-0039](0039-agentic-retrieval-quality-package.md), [ADR-0042](0042-object-storage-durability-and-quota.md), [`../deployment/kubernetes.md`](../deployment/kubernetes.md)

## Context

ADR-0042 fixed what could be fixed without moving anything: it added an offsite
backup, a per-organization quota, and turned on chunk encryption. It also
deferred one thing explicitly, and named it as the prerequisite for the rest —
the topology.

Every deployment ran a single `weed server -s3` process holding four roles at
once (master, volume server, filer, S3 gateway) against a single PVC. Three
consequences follow, and they are the whole reason this ADR exists.

**Capacity was a PVC resize on the one tier that grows without bound.** Object
storage is where a document-management product accumulates; it was the only tier
whose growth path was "edit a volume claim and hope the CSI driver supports
online expansion". Nothing about the design let capacity be a replica count.

**Chunk encryption protected almost nothing.** `-filer.encryptVolumeData`
generates a per-chunk AES-256-GCM key and stores it in the FILER metadata. In
the single-node topology the filer's embedded leveldb store sits at `/data`,
which is the same PVC as the volume files it encrypts. Anyone who obtains that
volume gets the ciphertext and the keys, in the same directory. ADR-0042 said so
at the time and called the fix "the topology split ADR-0042 defers". What the
feature actually bought there was crypto-erasure — drop the metadata and the
bytes become undecryptable — which is genuinely useful for deletion, and is not
at-rest protection.

**Every role failed together.** Restarting the filer to change one flag took the
master and the volume server with it.

Separately, tenancy in the object store was a key prefix — `org/<orgId>/…` —
inside one shared bucket. Erasing a tenant was therefore a paginated
list-and-delete that could fail halfway, after the rows naming the objects were
already gone; a key-construction bug was a cross-tenant bug rather than a
scoped one; and per-tenant usage could only be read from the application's own
ledger, with nothing independent to reconcile it against.

Two audit findings from the same pass are folded in here because they are the
same subsystem:

- **`grid-backend-read` held a bare `Read`.** SeaweedFS's `canDo` compares a
  bare action against the request before it ever looks at the bucket, so it
  matched every bucket in the deployment — including `grid-pg-backups`, the
  Postgres PITR archive. The agent tier could read every row of every database.
  ADR-0039 described this identity as scoped to the documents bucket; it was
  not.
- **Deleting a single document left its `_thumb.jpg` sibling behind.** Invisible
  to the UI, invisible to the quota ledger (which counts rows, not bytes), and
  still presignable by anyone who could construct the key. Only the
  project-level purge ever collected them.

Everything below is pinned to SeaweedFS **3.80**, the image production runs.
Four behaviours of that version shaped the design and were each read out of the
source rather than the wiki:

- **`canDo` supports a trailing-`*` prefix match on the bucket.** This is what
  makes per-tenant buckets expressible with static credentials at all: buckets
  created at runtime cannot be enumerated in `s3.json`, but `Read:grid-org-*`
  covers them without covering `grid-documents` or `grid-pg-backups`.
- **`Admin:<bucket>` authorises CreateBucket and DeleteBucket together.** There
  is no way to grant one without the other.
- **Two of the three health endpoints are not self-scoped.** The master's
  `/cluster/healthz` returns `423 Locked` while the leader holds a topology
  child lock — an ordinary admin operation — and the volume server's `/healthz`
  returns 503 when a PEER holding a replica is unreachable. Both were wired as
  liveness probes.
- **The shipped `filer.toml` scaffold defaults `upsertQuery` to CockroachDB
  syntax**, which PostgreSQL rejects outright. `enableUpsert = false` is not the
  escape hatch it looks like: the insert-conflict fallback is gated on the
  driver error containing the literal text `duplicate entry`, which is MySQL's
  wording, so on PostgreSQL it never fires and a concurrent insert surfaces as a
  hard error instead.

## Decision

### 1. Split the topology into master, volume and filer workloads

Three StatefulSets. The master holds the Raft topology and the volume-id
sequence on a small PVC; the volume servers hold the bytes and are the capacity
knob; the filer holds the namespace and carries the S3 gateway.

**The S3 gateway stays inside the filer process** (`weed filer -s3`) rather than
becoming a fourth workload. It is a stateless translator that does nothing but
call the filer, so separating it would add a network hop and a second thing to
scale for no isolation gain — the filer is already the unit that scales with
request rate.

**Every pod advertises a unique, directly dialable address**, via per-pod
headless DNS. This is not cosmetic. Volume servers register with the master
under their `-ip` and the filer moves chunks to that address; filers register
under theirs and peer filers subscribe to it for metadata aggregation. The
master keys its member map BY ADDRESS, so advertising a Service name would
collapse every replica into one entry and silently break both.

**The filer workload keeps the bare name `seaweedfs`.** It is the workload that
serves S3, so `SEAWEED_ENDPOINT=http://seaweedfs:8333` resolves exactly as
before and the edge NetworkPolicy — which selects
`app.kubernetes.io/name=seaweedfs` — keeps selecting the pods that actually
answer.

### 2. Move the filer namespace to a dedicated Postgres database and role

Via SeaweedFS's `[postgres2]` store, on the existing CloudNativePG cluster.

`postgres2` rather than `postgres` for one reason that matters here: it sets
`SupportBucketTable`, giving each S3 bucket its own table, so dropping a bucket
is a `DROP TABLE` rather than a row-by-row delete. That is what makes decision 4
an O(1) operation on the metadata side as well as the object side. (`postgres`
additionally declines to create its own table at all.)

Its own database, owned by its own login, with `CONNECT` revoked from `PUBLIC`.
The filer store holds a decryption key for every chunk in the object store, so a
credential that reaches it must not also reach `grid_app` — and the reverse:
compromising the application should not yield the keys to objects it was never
authorized to read. PostgreSQL grants `CONNECT` on a new database to `PUBLIC` by
default, so "the app role has no table privileges there" would have been the
only thing standing between them, and an empty grant table is a coincidence, not
a boundary.

This is what turns chunk encryption from crypto-erasure into at-rest protection:
the keys and the ciphertext are now on different disks, managed by different
systems, reachable with different credentials.

It also changes the backup picture. The namespace becomes ordinary rows in a
database with continuous WAL archiving, so it inherits real point-in-time
recovery. ADR-0042's `fs.meta.save` snapshot stays anyway — it is portable
across filer stores, which is exactly what makes a store MIGRATION recoverable,
and a Postgres PITR of a database that did not yet exist cannot do that.

### 3. Switching topology is a data migration, and the program refuses to pretend otherwise

The two topologies use different PVCs. A stack that flips the knob without
migrating comes up with an empty object store while every existing object sits
on a claim nothing mounts — and **nothing errors**. The S3 endpoint answers, the
health probes pass, and the app reports that the tenant has no files.

That failure shape is why the single-node path is kept intact rather than
deleted, and why both existing stacks pin `seaweedfsTopology: single` in their
own `Pulumi.<stack>.yaml` with the runbook linked from the comment. `split` is
the default only for stacks that do not exist yet. The single-node command line
is byte-for-byte what it was, deliberately: the new volume-sizing knobs are not
read there, because re-sizing volume slots and restarting the only storage
server in a deployment is not something a refactor gets to do.

The migration runbook is `docs/deployment/kubernetes.md` § "Migrating SeaweedFS
to the split topology".

### 4. One bucket per organization, recorded on the row

Bucket names are `<prefix><slug>-<hash>`, where the slug is the organization id
reduced to the S3 alphabet and the hash is a 12-hex-character SHA-256 of the
ORIGINAL id.

The hash is unconditional. Slugging is lossy — `Org_1` and `org-1` both reduce
to `org-1` — and two organizations sharing a bucket is precisely the failure
this decision exists to prevent, so uniqueness is restored by construction
rather than by an argument about which ids are safe. 12 hex is 48 bits: at
100,000 organizations the birthday bound puts a collision at roughly 1 in
30,000, where 32 bits would be about even odds.

**The bucket is recorded on each document row (`documents.storage_bucket`), not
derived from the organization id.** This is the load-bearing part of the design.
Deriving it would make the feature flag a CUTOVER: the instant it flipped, every
object written before it would become unreachable, because the read path would
start looking in a bucket it was never written to — and flipping back would
strand everything written meanwhile. Recorded, turning it on changes where the
NEXT object goes and nothing else. NULL means "the shared bucket", which is what
every row predating migration 0033 means, and that meaning is fixed forever.

The object KEY layout does not change. Keys stay `org/<orgId>/project/…` even
inside a per-org bucket, where the leading segment is redundant, so an object
remains valid under either layout and moving between them is a bucket copy
rather than a rewrite. Only the bucket moves.

**Erasure visits every bucket an organization could have objects in** — the
shared one AND its own, unconditionally. Three states have to be correct and
only one of them is "the flag is on": before it, the tenant bucket does not
exist, and a prefix sweep over a bucket that does not exist is a no-op, because
a bucket that does not exist holds no objects; during, objects are in both,
because an organization that predates the flip kept everything it already had;
after it is turned off again, objects are STILL in both — and that is the state
that makes gating dangerous, because a sweep consulting the flag would skip the
tenant bucket and report the erasure complete.

The lazy-creation half of that matters too: tenant buckets are created on an
organization's first upload, so an organization that has not uploaded since the
flip has none. Treating a missing bucket as an error rather than as zero objects
would fail the purge AFTER it had destroyed the Python-side stores, retry ten
times destroying them again, and then abandon the queue row with the tenant's
project and conversation rows intact.

**The naming rule is ONE module**, CommonJS, shared by the BFF and the purger —
the same pattern `lib/limits/rules.js` uses for the WebSocket proxy, and for the
same reason: the purger is plain Node and cannot import TypeScript, but it is
the process that ERASES a tenant. A second implementation there would sweep a
bucket that does not exist, find nothing, and report success.

### 5. Bucket lifecycle gets its own credential

Three static identities in `s3.json`:

| identity | holder | grant |
|---|---|---|
| `grid` | BFF, purger, PG backups | object CRUD on the platform buckets, plus `Read/Write/List/Tagging:<prefix>*`. No `Admin` — it cannot create or drop a bucket. |
| `grid-backend-read` | aiq-agent tier (ADR-0039) | `Read` on document buckets ONLY. Was a bare `Read`; see Context. |
| `grid-tenant-admin` | bucket provisioning only | `Admin:<prefix>*` and nothing else. |

The split between `grid` and `grid-tenant-admin` is forced by the SeaweedFS
limitation above: since `Admin:<bucket>` authorises DeleteBucket as well as
CreateBucket, the only way to keep "drop a tenant's entire bucket" out of reach
of the upload path is to keep it on a credential the upload path does not hold.
The purger is given the naming inputs but NOT that credential — it erases
objects by prefix, and an unattended queue worker is the last thing that should
be able to drop a bucket outright.

**The tenant SCOPES are granted whether or not the feature is enabled; only the
lifecycle identity is gated.** That asymmetry is the thing that makes turning
the feature back off safe. The application layer is already flag-independent on
reads — it resolves the bucket from the row — but a presigned URL is only worth
what the credential signing it can do. Gate the grants on the flag and a
rollback silently `AccessDenied`s every document written while it was on, and
makes the purge skip the tenant bucket while reporting success. The grant is a
bucket-name PREFIX, so when no tenant bucket exists it covers nothing; creating
buckets is the one thing that genuinely stops.

`loadConfig` refuses a tenant prefix that is a prefix of any platform bucket
name. The grants are wildcard-scoped and matched by string prefix, so a prefix
of `grid-` would hand `grid-documents` and `grid-pg-backups` to every identity
holding a tenant scope — including the read-only agent credential. That is the
same class of mistake as the bare `Read` this ADR fixes, so it is checked at
plan time rather than left to review.

### 6. Health probes: readiness where the check is not self-scoped

The master's `/cluster/healthz` and the volume server's `/healthz` are readiness
probes only, with TCP liveness underneath. The volume case is the serious one: a
liveness probe that fails when a PEER is unreachable turns a single node loss
into a restart cascade across every surviving replica holder. The filer's
`/healthz` round-trips its own store and is the one genuinely self-scoped check
of the three, so it does both jobs.

This applies to the single-node path too, where a 423 during an ordinary admin
operation would have restarted the only storage server in the deployment.

## Consequences

**Good**

- Object capacity is a replica count. `seaweedfsVolumeReplicas` scales the tier
  that actually grows, and `seaweedfsDefaultReplication` with per-node rack
  labels makes a second copy mean a second machine.
- Chunk encryption becomes at-rest protection rather than crypto-erasure —
  **in the split topology with the Postgres store**, which is where the keys
  move to a different system on different disks. Under `single`, and under
  `split` with the embedded store, it remains crypto-erasure and `pulumi up`
  says so on every deploy.
- The filer namespace inherits Postgres backup, replication and PITR.
- **The container for a tenant's objects exists**, which is the prerequisite
  for erasing one as a single operation. Note what that is and is not today:
  the deletion pipeline (ADR-0011) implements `project` and nothing else, and a
  project is a subset of an organization's bucket, so it stays a prefix sweep —
  now across both buckets. When the ORGANIZATION purger is built it can be
  `DeleteBucket`, and with `postgres2` the metadata side of that is a
  `DROP TABLE`. This ADR makes that possible; it does not deliver it.
- A key-construction bug stops being a cross-tenant bug **once the feature is
  enabled**. It is off by default, so today this is a property the deployment
  can opt into rather than one it has.
- The agent tier can no longer read the Postgres PITR archive. This one is
  unconditional and applies to every existing deployment on the next deploy.
- Per-document delete no longer orphans a thumbnail. Also unconditional.

**Costs and things that are now true**

- **There are three workloads where there was one**, and a Postgres dependency
  on the storage path. A filer whose database is unreachable stops serving S3
  — which is the correct behaviour, and is more moving parts than before.
- **Bootstrap ordering became conditional.** Postgres archives WAL into a
  SeaweedFS bucket, and the split filer needs a Postgres database; run both at
  once and it is a cycle. Only the split-plus-Postgres configuration is a real
  cycle, so that branch installs Postgres first and accepts a transient
  `ContinuousArchiving: false` on a fresh deploy until bucket-init lands.
  Postgres retries `archive_command` indefinitely and recovers on its own, but
  it is visible in `kubectl cnpg status` and should not be mistaken for a broken
  backup.

  The one-shot BASE backup does not self-heal the same way — CNPG does not retry
  a failed `Backup`, so the next attempt would be the cron the following night,
  and archived WAL with no base backup is not a recoverable PITR. That is why
  the `ScheduledBackup` is created from `index.ts` after bucket-init rather than
  inside `installPostgres`.
- **The BFF still holds one credential across every tenant bucket**, scoped
  `Read:<prefix>*` / `Write:<prefix>*`. Per-ORGANIZATION credentials are the
  next step and SeaweedFS can express them, but they would have to live in the
  filer's runtime IAM store — which ADR-0042's offsite mirror deliberately does
  not back up (`-filerPath=/buckets` excludes `/etc`). Losing that state would
  lock every tenant out of their own data. Authorization stays where ADR-0038
  put it; the bucket boundary is defence in depth, not a replacement.
- **The filer StatefulSet carries a small PVC it does not use** under the
  Postgres store. `volumeClaimTemplates` are immutable, so a template that
  appeared only in leveldb mode would make switching stores a StatefulSet
  REPLACE — deleting the running filer — rather than a rolling update. One
  shape, one Gi, no replace.
- **Multi-master Raft is a knob, not a rehearsed configuration.**
  `seaweedfsMasterReplicas` validates that the count is odd and builds the peer
  list, but no live 3-master failover has been exercised. Treat 3 as untested
  until it is.
- **The split topology itself has not run on a live cluster.** Be precise about
  what that leaves. Verified: every flag name and value against the SeaweedFS
  3.80 source; the health-endpoint semantics, read out of the handlers rather
  than the wiki; the generated `filer.toml`, parsed with a TOML parser including
  the awkward password cases; the CNPG `Database` CR, run through the repo's own
  `validate-crs.mjs` against the pinned v1.28.0 CRD; and the manifests
  themselves, asserted under `pulumi.runtime.setMocks` — including a
  whole-program construction in BOTH topologies, which is what would catch a
  dependency cycle. The policy-pack invariants are asserted the same way,
  rule by rule; **CrossGuard itself has not been run**, because
  `pulumi preview --policy-pack` needs stack credentials.

  Not verified, and not verifiable here: that the cluster comes up. No
  `pulumi up` has applied this. The runbook is written to be rehearsed on dev
  first for exactly that reason.
- **The next `pulumi up` restarts the object store once, on every existing
  stack.** Two pod-template changes land together: the liveness probe moves off
  `/cluster/healthz` (which answers 423 during an ordinary admin operation, and
  would restart the only storage server in a single-node deployment), and the
  config checksum annotation appears so that a future credential rotation
  actually rolls the pods. Neither is a REPLACE — every resource name, label,
  Service and volume claim is byte-identical to the parent commit — but on
  `seaweedfsTopology: single` there is one replica, so it is a brief object-store
  outage rather than a rolling one. Deploy it in a window.
- **Per-organization buckets are off by default**, and turning them on does not
  move anything that already exists. An organization keeps objects in both
  buckets indefinitely. That is the design (see decision 4), but it means "how
  many buckets does this tenant use" has two valid answers.

## Alternatives considered

**Keep the single-node topology and encrypt the PVC instead.** Would address
disk theft without any of this, and addresses nothing else: capacity would still
be a resize, the roles would still fail together, and the provider's
StorageClasses do not offer it.

**Adopt the upstream SeaweedFS Helm chart or operator.** It is the well-trodden
path and it would have given multi-master for free. Rejected because the rest of
this program is one reviewable Pulumi codebase with a policy pack that enforces
rollout gating, resource bounds and probe presence on every workload — and
because the chart's own defaults are what produced two of the four findings
above (liveness on a non-self-scoped endpoint, the CockroachDB `upsertQuery`).
Inheriting those silently is worse than writing three StatefulSets.

**Derive the bucket from the organization id instead of recording it.** Simpler
by every measure except the one that matters — see decision 4.

**Per-organization S3 credentials now.** The stronger boundary, and SeaweedFS
supports it: identities can live in the filer at `/etc/iam/identity.json` and
the gateway hot-reloads them from a metadata subscription on `/etc`. Deferred
because that state is runtime state the offsite mirror explicitly excludes, so
adopting it today would create a category of data whose loss locks every tenant
out permanently. Revisit when `/etc` is in the backup path.

**Bucket per PROJECT rather than per organization.** More granular, and the
authorization boundary in this product is the project (ADR-0038), so it lines up
with FGA better. Rejected on arithmetic: projects are created freely and each
bucket costs a `postgres2` table and a filer collection, so the table count
would track user behaviour rather than customer count. The organization is the
unit that gets erased, quota'd and billed, which is what a bucket should map to.
