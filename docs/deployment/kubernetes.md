# Kubernetes deployment (Pulumi)

This is the operator guide for running the full Grid OIB stack on a Kubernetes
cluster. The infrastructure is defined as code in
[`deploy/pulumi`](../../deploy/pulumi) (Pulumi / TypeScript); this document
explains the architecture, the storage/SeaweedFS decisions, how to deploy, and
— importantly — **how the agent scales**, now and later.

It is the k8s counterpart to [`coolify.md`](./coolify.md) (Docker Compose on
Coolify remains the other supported target).

---

## 1. Topology

One namespace (`grid`) holds every app + data workload. Platform add-ons live in
their own namespaces.

| Workload | k8s object | Replicas | Storage | Scales by |
|---|---|---|---|---|
| `aiq-agent` (agent web tier) | **StatefulSet** | 1 (dask) / N (db, default 2) | RWO PVC `/app/data` per replica | dask mode: vertically (singleton). db mode (both shipped templates): horizontally + PDB/spread — §6.4 |
| `frontend` (Next.js + BFF + WS gateway) | Deployment + HPA | 2→6 | — | Horizontally (CPU HPA) |
| `purger` | Deployment | 1 | — | n/a (SKIP LOCKED-safe) |
| `workflow-scheduler` | Deployment (only when `workflowsEnabled`) | 1 | — | n/a (DB-claimed ticks) |
| `postgres` (`aiq_jobs`, `aiq_checkpoints`, `grid_app`) | CloudNativePG `Cluster` | 1 (→3 HA) | RWO PVC | Add replicas |
| `dragonfly` (Redis-proto cache) | Deployment | 1 | — (cache) | — |
| `seaweedfs` (filer + S3 gateway) | StatefulSet | 1 (`single`) / N (`split`) | RWO PVC `/data` (unused under the Postgres filer store) | See §4 |
| `seaweedfs-master` (`split` only) | StatefulSet | 1 (3 = HA, untested) | RWO PVC `/data` (raft + volume-id sequence) | Odd replica counts only |
| `seaweedfs-volume` (`split` only) | StatefulSet | N | RWO PVC `/data` per replica | `seaweedfsVolumeReplicas` — this is the object-capacity knob |

Platform add-ons installed by Pulumi: **cert-manager** (+ Let's Encrypt issuer,
Gateway-API-enabled), **Envoy Gateway** (Gateway API controller), and the
**CloudNativePG operator**. The HPAs need `metrics.k8s.io`, which the managed
provider already serves via its unremovable base metrics stack — so
`installMetricsServer` defaults to **false** (flip it true only on a bare
cluster with no metrics API). See §2b.

> Edge = **Gateway API**, not Ingress. The Kubernetes ingress-nginx controller
> is retired (maintenance ended 2026-03-31; no further releases or security
> patches), and the Gateway API is the project's modern successor to Ingress.
> We run **Envoy Gateway** (CNCF, Gateway-API native) with a `GatewayClass`,
> a `Gateway` (HTTP :80 for the ACME challenge + per-host HTTPS :443), and
> `HTTPRoute`s (`src/platform/gateway.ts`, `src/app/httproutes.ts`). TLS is
> issued by cert-manager's Gateway integration (`enableGatewayAPI`,
> `gatewayHTTPRoute` HTTP-01 solver). WebSocket upgrades + large uploads pass
> through natively.

Traffic:

```
Internet ──▶ Envoy Gateway ──┬─▶ app.<domain> (HTTPRoute) ──▶ frontend:3000 ──▶ aiq-agent:8000 (WS/REST)
                             └─▶ s3.<domain>  (HTTPRoute) ──▶ seaweedfs:8333 (presigned browser URLs)
```

---

## Row-level security roles (ADR-0041)

The `grid_app` database enforces tenant isolation in Postgres, and the app tier
connects as `grid_app_rw` — DML only, no DDL, and subject to every policy.

Two credentials, and they are not interchangeable:

| Role | Used by | Can do |
|------|---------|--------|
| `aiq` (the application user, `pgAppUser`) | the migration Job only | owns the schema; DDL and backfills. Row-level security does **not** apply to a table's owner — that is what makes a backfill touch rows instead of silently touching none. |
| `grid_app_rw` | every serving container: frontend, purger, scheduler | DML only. No DDL, no `CREATEROLE`, no `BYPASSRLS`, and subject to every policy. |

The three roles are declared on the CloudNativePG `Cluster` under
`spec.managed.roles`, not created by a migration. That is not a preference:
creating `grid_app_platform` requires the creator to hold `BYPASSRLS`, which
neither credential above has. The operator reconciles them as superuser on every
pass, including `grid_app_rw`'s password from the `pg-runtime-credentials`
Secret.

That password comes from Pulumi config `pgRuntimePassword`, which is **required
and has no fallback**. It used to default to `pgAppPassword`; that was wrong,
because Postgres authenticates by (role, password), so a shared password let
anyone holding the runtime DSN log in as the schema owner instead — and the
owner is exempt from every policy. Set it per stack:

```bash
pulumi config set --secret pgRuntimePassword "$(openssl rand -base64 32)"
```

Migration `0030` therefore only *asserts* the roles, failing with a hint rather
than half-applying the boundary. `GRID_APP_MIGRATION_DATABASE_URL` carries the
`aiq` owner credential and is set only on the migration Job — never on a
long-lived Pod.

Runbook: [row-level security](../database/row-level-security.md).

## 2. Prerequisites

- A kubeconfig for the cluster (the provider gives you this).
- The provider's **StorageClass** name for block volumes — this is your
  **Lightbits** (NVMe/TCP) class. Find it: `kubectl get storageclass`.
- Container images in a registry. The [`publish-images`](../../.github/workflows/publish-images.yml)
  workflow builds and pushes `grid-oib-backend`, `grid-oib-frontend` and
  `grid-oib-web` to GHCR on merge to `develop` — on `develop` only the images
  whose files changed are rebuilt (per-service change detection; a blog-post
  commit rebuilds just `grid-web`), while `release/**` pushes, version tags and
  manual runs build all three. Deploys pin each rebuilt service to its commit-SHA
  tag; services that were not rebuilt keep the image reference already stored in
  the stack config (`grid-oib:backendImage` / `grid-oib:frontendImage` /
  `grid-oib:webImage`, falling back to `grid-oib:imageTag`, then `latest`) — see
  [cd.md](cd.md). The kubelet pulls **anonymously**: if the GHCR packages are *private*, set
  `registryUsername` + `registryPassword` (a token with `read:packages`) so the
  program creates the `grid-registry-pull` imagePullSecret — otherwise every app
  pod lands in ImagePullBackOff.
- Pulumi CLI + Node 20+.

### Storage — what it is and isn't

The provider's CSI is **block** storage (NVMe/TCP, Lightbits under the hood),
exposed as **StorageClasses** that hand out fast ReadWriteOnce PVCs. It is *not*
an object store. So:

- Three classes ship, differing only in storage-level replica count:
  `premium` (**default**, 3 replicas), `standard` (2), `single-replica` (1).
  Set the one you want once via `grid-oib:storageClass` (prod → `premium`).
  `lightbits` is the **VolumeSnapshotClass** name (driver
  `csi.lightbitslabs.com`), *not* a StorageClass — don't set `storageClass` to it.
- **Only ReadWriteOnce** — no RWX. Every PVC here is RWO and each is mounted by a
  single pod (Postgres, SeaweedFS, Chroma, and the agent's per-replica
  `/app/data`), so this is a non-issue; just don't add an RWX volume expecting
  shared mounts. Because the CSI is network-attached (NVMe/TCP), an RWO volume
  still re-attaches to a *replacement* node after a node loss.
- **Reclaim policy is `Delete` on every class:** deleting a PVC destroys the
  volume and its data irreversibly. Two mitigations are wired/available — the
  StatefulSets pin `persistentVolumeClaimRetentionPolicy: Retain` so deleting a
  workload never cascades a PVC delete, and you can patch a live PV to survive
  even a PVC delete: `kubectl patch pv <pv> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`.
- Volumes **expand online**, but for the three StatefulSets NOT via config:
  `volumeClaimTemplates` are immutable (a size change would *replace* the
  StatefulSet while the existing PVC kept its old size — the program pins
  `ignoreChanges` on the templates so that can't happen by accident). Grow a
  live volume by patching the PVC directly, e.g.
  `kubectl -n grid patch pvc data-seaweedfs-0 -p '{"spec":{"resources":{"requests":{"storage":"50Gi"}}}}'`,
  then update the config value so future clusters start at the new size. Only
  `pgStorageSize` (CNPG manages its own PVCs) expands via config + `pulumi up`.
  Volumes cannot shrink. **VolumeSnapshots** via the `lightbits` SnapshotClass.
- The **CSI driver / StorageClasses are provider-installed**; Pulumi only
  references a class by name. We do not install the driver.
- **S3 is provided by SeaweedFS**, which runs on top of one of these PVCs (§4).

---

## 2b. Managed provider (k0s) specifics — how this config accounts for them

The target is a **managed k0s** cluster (CNCF-conformant, standard Kubernetes
API). A handful of provider behaviours shape the manifests; each is handled so
you don't have to retrofit it.

**Automatic version upgrades drain nodes.** The provider upgrades Kubernetes and
replaces worker nodes on its own schedule, with no operator step — i.e. *routine*
voluntary node drains. Every multi-replica workload therefore carries a
**PodDisruptionBudget** (`maxUnavailable: 1`) and a soft **topologySpreadConstraint**
across `kubernetes.io/hostname` (`src/platform/scheduling.ts`, applied to
`frontend`, `agent-worker`, and the `db`-mode `aiq-agent` web tier; the Envoy
proxy already had both). A drain can then only take one replica at a time, and
replicas sit on different nodes so a single node loss never empties a tier.
Single-replica workloads deliberately get **no** PDB — `minAvailable: 1` on one
pod would block the drain forever and deadlock the upgrade. Postgres HA is
CloudNativePG's own PDB.

**In dask mode, automatic upgrades interrupt in-flight research.** The default
`jobExecution: dask` runs the agent as a singleton (deliberately without a
PDB): every provider-initiated node drain evicts it, killing in-process Dask
state (durable deep-research checkpoints survive; live WS/HITL state does not)
with a recovery tail of volume re-attach + image pull + up-to-10-min boot.
Both shipped stack templates use `db` mode, which drains one replica at a time.

**Moving image tags make `pulumi up` a no-op.** With `imageTag: latest`, a
redeploy after publishing new images changes no pod spec, so nothing rolls and
the migration Job does not re-fire — but a later pod restart (e.g. a node
drain) silently pulls the new code, possibly against an un-migrated schema.
The CI workflow avoids this by pinning rebuilt services to `sha-<commit>` per
deploy; for manual deploys, pin `imageTag` to a commit SHA the same way.
`pulumi up --refresh` does **not** help: Pulumi only asserts desired state,
and a moving tag never changes the Deployment spec, so a refresh neither rolls
the pods nor re-fires the migration Job. If you must pull a moving tag in an
emergency, do it as an explicit rollout operation — remove the per-service
pins and point the stack at the moving tag (`pulumi config rm
grid-oib:backendImage grid-oib:frontendImage grid-oib:webImage`, `pulumi
config set grid-oib:imageTag latest`, then `pulumi up`, which changes the pod
specs and flips pullPolicy to `Always`) — never a bare `pulumi up --refresh`.

**Size worker groups against the HPA ceilings.** The autoscaler only adds
nodes within a worker group's min/max. If frontend `maxReplicas` (6) +
agent-worker `maxReplicas` (8) + the fixed tiers exceed the group's max
capacity, the extra pods sit Pending forever. Check the sum of limits at max
scale against the group product when sizing.

**Cluster-autoscaler scales on *unschedulable pods*, not utilisation.** Its
documented prerequisites — an HPA as the first scaling tier, `requests`/`limits`
on every container, and `topologySpreadConstraints` — are all met: HPAs on
`frontend` + `agent-worker`, requests **and** limits on every workload, and the
spread constraints above. So a burst first scales pods via HPA, and only if pods
go Pending does a node get added.

**Node loss wipes ephemeral storage; only PVCs survive.** On node replacement,
`emptyDir` / `hostPath` / container-fs are gone. This stack uses **none** of
those for durable data — no `emptyDir`, no `hostPath`, no DaemonSets anywhere —
so the k0s kubelet-path quirk (`/var/lib/k0s/kubelet` instead of
`/var/lib/kubelet`) is a non-issue here; the only ephemeral file is the
agent-worker's `/tmp` liveness marker, which is meant to be transient. All state
lives on PVCs (which survive) or in Postgres.

**Networking is Cilium, no kube-proxy.** All Service types work normally;
nothing in this program assumes kube-proxy. The edge Service is a
`LoadBalancer` that Cilium gives an external IP automatically. A released IP
stays **reserved for 14 days** and is reclaimable via the
`k8s.at/managed-loadbalancer-ip` annotation — set `grid-oib:loadBalancerIp` to
the assigned address after the first deploy and it's stamped onto the Envoy
Service, so DNS keeps resolving across any Gateway re-creation. (Inbound API
restriction — block / country- / IP-allowlist — and the dedicated outbound NAT
IP for egress whitelisting are Control-Center settings, not manifests.)

**Kubeconfig tokens expire (≤ 2 weeks).** The Control-Center kubeconfig is fine
for hands-on `pulumi up`, but a token baked into `grid-oib:kubeconfig` for
unattended CI/CD **will stop working within two weeks**. For automation, use the
provider's documented permanent-credential path: a ServiceAccount with a
non-expiring token Secret, then feed *that* kubeconfig to Pulumi. Least-privilege
RBAC is better than `cluster-admin` if your platform team scopes it, but at
minimum:

```bash
kubectl -n kube-system create serviceaccount grid-deployer
kubectl create clusterrolebinding grid-deployer \
  --clusterrole=cluster-admin --serviceaccount=kube-system:grid-deployer
kubectl -n kube-system apply -f - <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: grid-deployer-token
  namespace: kube-system
  annotations: { kubernetes.io/service-account.name: grid-deployer }
type: kubernetes.io/service-account-token
EOF
# Build a kubeconfig from that token + the cluster CA/endpoint and store it:
#   pulumi config set --secret grid-oib:kubeconfig "$(cat grid-deployer.kubeconfig)"
```

Revoke it by deleting the Secret/ServiceAccount when it's no longer needed — it
does **not** expire on its own.

One interaction to plan for: the Control Center can restrict **API access**
(blocked / country-allowlist / IP-allowlist). CI deploys need the runner to
reach the cluster API — GitHub-hosted and Blacksmith runners have changing
egress IPs, so a strict IP-allowlist will break `pulumi up` from CI. Either
keep the API open and rely on the ServiceAccount token as the credential, use a
country allowlist that covers the runners, or run deploys from a self-hosted
runner with a fixed egress IP.

**Provider add-ons.** A base **metrics** stack (serving `metrics.k8s.io`) is
always provisioned and cannot be removed, so `installMetricsServer` defaults to
**false** — installing our own would just fight it (the HPAs read the built-in
one). Managed **Backups** (Velero) and **Metrics** (Grafana) are paid Control-
Center add-ons; CNPG PITR and a Prometheus/Grafana/Loki stack remain the
in-cluster follow-ups in §7. A cheap interim backup is a scheduled
**VolumeSnapshot** (SnapshotClass `lightbits`) of the Postgres and SeaweedFS PVCs.

---

## 3. Deploy

Full command list is in [`deploy/pulumi/README.md`](../../deploy/pulumi/README.md).
In short:

```bash
cd deploy/pulumi
npm install
pulumi stack init prod
# edit Pulumi.prod.yaml placeholders, then set --secret values (kubeconfig,
# pgAppPassword, seaweedfsSecretKey, tokens, OpenRouter/Tavily/WorkOS keys)
pulumi up
```

Then:

1. `kubectl -n envoy-gateway-system get svc` → note the Envoy proxy LoadBalancer external IP.
2. Point DNS `A`/`AAAA` records for `app.<baseDomain>` and `s3.<baseDomain>`
   (and `otel.<baseDomain>` when observability is on) at it. `appDomain`/
   `s3Domain`/`otelDomain` exist only as optional per-host overrides —
   `grid-oib:baseDomain` is the single key a domain move touches.
3. Leave `useStagingIssuer: true` until the ingress is reachable and a staging
   cert issues (avoids Let's Encrypt rate limits); then set it `false` and
   `pulumi up` for a trusted cert.
4. Verify: `kubectl -n grid get pods,pvc,httproute,gateway,cluster`.

The base OIB corpus is **not** shipped in the image or from git — it is
volume-based. Load it through the platform-admin upload UI once the stack is up;
it persists on the agent's `/app/data` PVC and is embedded into Chroma on the
fly.

---

## 4. SeaweedFS — two topologies, and the migration between them

`grid-oib:seaweedfsTopology` selects one of two layouts (ADR-0043). New stacks
default to `split`; both existing stacks pin `single` in their own
`Pulumi.<stack>.yaml`, because switching is a data migration.

### `single` — one process, one PVC

One `weed server -s3` running master + volume + filer + gateway as a 1-replica
StatefulSet on a durable Lightbits PVC. This is the layout every deployment ran
before ADR-0043 and it remains the right choice for a small one: fewer moving
parts, nothing to coordinate, no Postgres on the storage path.

What it cannot do: grow by adding replicas, and put the chunk encryption keys
anywhere other than the disk holding the chunks they open. The filer's embedded
leveldb store lives at `/data`, beside the volume files, so
`seaweedfsEncryptVolumeData` buys crypto-erasure there and not at-rest
protection. See § Encryption posture.

### `split` — master, volume and filer as separate workloads

```
  app tier ──S3:8333──►  seaweedfs (filer + gateway)  ──gRPC:19333──►  seaweedfs-master
                              │      │                                       ▲
                              │      └──filer.toml──► grid-pg (seaweedfs_filer DB)
                              └──HTTP:8080──► seaweedfs-volume ────heartbeat──┘
```

- **`seaweedfs-master`** — Raft topology and the volume-id sequence, on a small
  PVC (`seaweedfsMasterStorageSize`, default 1Gi). `seaweedfsMasterReplicas`
  must be odd; 1 means no HA, 3 is the HA value and **has not been exercised on
  a live cluster** — treat it as untested.
- **`seaweedfs-volume`** — the bytes. `seaweedfsVolumeReplicas` is the capacity
  knob. Each replica gets its own `seaweedfsStorageSize` PVC and reports its
  Kubernetes node as its SeaweedFS *rack*, which is what lets
  `seaweedfsDefaultReplication: "010"` mean "two copies on two machines" rather
  than "two copies on two pods".
- **`seaweedfs`** — the filer, carrying the S3 gateway in-process. Keeps the
  bare name so `SEAWEED_ENDPOINT=http://seaweedfs:8333` and the edge
  NetworkPolicy are unchanged.

**Volume sizing.** `seaweedfsVolumeSizeLimitMB` defaults to 1024, not
SeaweedFS's own 30000. The volume server derives its writable-slot count from
`free / volumeSizeLimit`, so a 30 GB limit on a 20 Gi PVC computes ONE slot and
on a 10 Gi PVC computed zero — which showed up live as "No writable volumes and
no free volumes left" on every upload. `seaweedfsVolumeMinFreeSpace` must exceed
one volume, or the disk can hit ENOSPC mid-growth before the read-only brake
engages; `loadConfig` refuses the combination.

**Filer store.** `seaweedfsFilerStore: postgres` (the default) puts the
namespace in a dedicated `seaweedfs_filer` database on the existing CNPG
cluster, owned by its own role with `CONNECT` revoked from `PUBLIC`. That
database holds an AES key for every chunk in the object store, which is why it
is neither one of the three application databases nor reachable with the
application login. `leveldb` keeps the embedded store on the filer's own PVC and
is single-replica only — each replica would keep a private namespace and the
same object would exist or not depending on which pod answered.

**Health probes.** The master's `/cluster/healthz` and the volume server's
`/healthz` are readiness ONLY. The master answers `423 Locked` while the leader
holds a topology child lock, and the volume server answers 503 when a *peer*
holding a replica is unreachable — as liveness probes, the second would turn one
node going away into a restart cascade across every surviving replica holder.
TCP liveness sits underneath both. The filer's `/healthz` round-trips its own
store and does both jobs.

### Migrating SeaweedFS to the split topology

**Read this before flipping the knob.** The two topologies use different PVCs.
A stack that switches without migrating comes up with an EMPTY object store
while every existing object sits on a PersistentVolumeClaim nothing mounts —
and nothing errors. The endpoint answers, the probes pass, and the app reports
that the tenant has no files. That is why both existing stacks pin `single`.

Rehearse the whole thing on dev first. Budget a maintenance window: step 3
requires writes to be stopped, because SeaweedFS cannot take a consistent
point-in-time copy of a bucket (ADR-0042) and a document written between the
metadata dump and the object copy lands in neither.

1. **Verify the backup is real.** `seaweedfsBackupEnabled: true`, and the object
   count in the offsite bucket matches the source. "The pod is running" is not
   evidence — `filer.backup` has no initial full-copy phase.

2. **Take a metadata snapshot and keep it off-cluster.**
   ```
   kubectl -n grid exec deploy/seaweedfs-backup -- \
     sh -c 'echo "fs.meta.save -o /tmp/pre-split.meta /" | weed shell -master=seaweedfs:9333'
   kubectl -n grid cp seaweedfs-backup-<pod>:/tmp/pre-split.meta ./pre-split.meta
   ```
   This is the only artefact that makes a botched migration reversible. Check it
   is non-empty; `weed shell` exits 0 even when the command inside it failed.

3. **Stop writes.** Scale the frontend, purger and agent-worker to zero.

4. **Record the object inventory**, so step 8 has something to check against:
   ```
   aws --endpoint-url http://seaweedfs:8333 s3 ls --recursive s3://grid-documents | wc -l
   ```

5. **Set the filer store credential and the topology**, then apply:
   ```
   pulumi config set --secret grid-oib:seaweedfsFilerDbPassword "$(openssl rand -base64 24)"
   pulumi config set grid-oib:seaweedfsTopology split
   pulumi up
   ```
   The three new workloads come up empty. The old `seaweedfs` StatefulSet is
   replaced by the filer of the same name, but **its PVC is not adopted**: the
   single-node claim is `data-seaweedfs-0` and the split filer's is
   `filer-data-seaweedfs-0`, deliberately (see the note on the
   `volumeClaimTemplate` in `src/data/seaweedfs-split.ts`). Retained by policy
   and unclaimed by anything, `data-seaweedfs-0` is what step 6 reads from.

6. **Move the data.** Two ways, and the right one depends on how much there
   is. Whichever you pick, the bucket name and the object-key layout are
   unchanged, so nothing about the application has to know a migration
   happened.

   **6a — S3-to-S3 sync (default).** Run a throwaway single-node `weed server`
   with `data-seaweedfs-0` mounted read-write at `/data` and its S3 port under
   a different Service name (`seaweedfs-legacy`), then `rclone sync` or
   `scripts/migrate-storage.mjs` from that endpoint to `seaweedfs:8333` — the
   same pattern as the MinIO→SeaweedFS cutover in
   [`minio-to-seaweedfs-migration.md`](./minio-to-seaweedfs-migration.md). It
   needs its own `s3.json`; the simplest source is the existing
   `seaweedfs-s3-config` Secret.

   Simple, verifiable object by object, and it re-encrypts every chunk under
   the new store's keys as a side effect. Cost: it reads and rewrites every
   byte, so it scales with corpus size.

   **6b — metadata load, keeping the volume files (large corpora).** SeaweedFS's
   own store-migration path: `fs.meta.save` from the old filer,
   `fs.meta.load` into the new one, with the volume `.dat`/`.idx` files moved
   across (rebind the retained PV to `seaweedfs-volume-0`'s claim, or copy the
   files into it). O(metadata) rather than O(bytes).

   **The two are not interchangeable under encryption.** With
   `seaweedfsEncryptVolumeData` on, each chunk's AES key lives in the FILER
   metadata, not with the chunk. So 6b is only correct if the metadata load
   actually happens — volume files moved WITHOUT their metadata are ciphertext
   nobody can open, and there is no master key and no escrow. If you take 6b,
   verify the load before you delete anything: open a document written before
   the migration, not just one written after.

7. **Compare counts** against step 4. Not "the sync finished" — the count.

8. **Bring the app back up**, upload one document, preview it, download it, and
   delete it. Then confirm the offsite mirror picked up all four events.

**Rolling back** is step 5 with `single`, plus an S3 sync in the other
direction. The old PVC is still there; nothing in this procedure deletes it.
Delete it deliberately, later, once you are sure.

### Per-organization buckets

Off by default (`seaweedfsPerOrgBuckets`). Independent of the topology knob —
either layout can run either way — but they land together because they are the
same subsystem.

Turning it on is NOT a cutover and NOT a migration. The bucket each document
lives in is recorded on its row (`documents.storage_bucket`, migration 0033);
NULL means the shared bucket. Enabling the flag changes where the NEXT object is
written and nothing else, and disabling it again is equally uneventful. An
organization therefore keeps objects in both buckets indefinitely, and every
erasure path sweeps both.

Requires `seaweedfsTenantAdminSecretKey`: bucket creation and deletion are a
single `Admin` action in SeaweedFS and cannot be granted separately, so they get
an identity of their own rather than living on the credential the upload path
carries.

---

## 5. Postgres (CloudNativePG)

A single `Cluster` hosts all three logical databases. `aiq_jobs` is the
bootstrapped app DB; `aiq_checkpoints` and `grid_app` are created (owned by the
`aiq` role) at bootstrap via `postInitSQL`. An idempotent Job creates the job +
checkpoint tables; the frontend's `drizzle-kit migrate` Job owns `grid_app`'s
schema.

- **HA:** `grid-oib:pgInstances: 3` (the prod default) runs one primary + two
  streaming replicas with automatic failover; `primaryUpdateStrategy:
  unsupervised` lets CNPG switch over + roll on its own when the provider drains
  a node. Replicas use `preferred` pod anti-affinity on `kubernetes.io/hostname`
  so they spread across worker nodes. Apps always talk to the `grid-pg-rw`
  service (the current primary).
- **Backups (PITR) — IMPLEMENTED, with an honest scope.** With
  `grid-oib:pgBackupsEnabled: true` (prod default) CNPG archives WAL
  continuously and takes a nightly base backup (plus one immediately on
  creation, so a PITR baseline exists from day one) via its Barman object-store
  integration. The default target is the in-cluster SeaweedFS
  `grid-pg-backups` bucket (auto-created; the Cluster is gated on it so
  archiving never races the bucket): that protects against **Postgres PVC
  loss/corruption**, but NOT against cluster deletion or a SeaweedFS-volume
  loss — the backup lives on the same `Delete`-reclaim CSI. For real offsite
  PITR, point `pgBackupEndpoint` (+ `pgBackupBucket`,
  `pgBackupAccessKey`/`pgBackupSecretKey`) at an external S3, or book the
  provider's Velero addon.
  Tune with `pgBackupRetention` (default `30d`) and `pgBackupSchedule` (6-field
  cron, default `0 0 2 * * *`). Restore is `kubectl cnpg` / a bootstrap
  `recovery` from the same object store.

  **The archive is not encrypted by default, and on the in-cluster destination
  it cannot be.** It is a byte-for-byte copy of all three databases — every
  conversation, every LangGraph checkpoint, WAL included — so this is the
  largest single at-rest exposure in the stack when backups are on.
  `grid-oib:pgBackupEncryption` (`AES256` or `aws:kms`, unset by default) sets
  CloudNativePG's `barmanObjectStore.{wal,data}.encryption` — note it lives on
  `wal`/`data`, not at the top level, and its CRD enum has no empty member, so
  "off" is the key being absent. barman-cloud turns it into an
  `x-amz-server-side-encryption` header, which encrypts nothing unless the
  destination implements SSE; SeaweedFS 3.80 does not (SSE-S3/KMS/C arrive in
  3.97, and no KMS is configured here on any image) and would answer `200` while
  storing plaintext. `loadConfig` therefore **refuses** the setting against an
  in-cluster endpoint rather than let the spec claim an encryption that is not
  happening, and warns on every deploy where backups are on without it. Set it
  only alongside an external S3 destination that documents SSE support. Full
  picture in §7e.

- **Document backups (ADR-0042) — IMPLEMENTED, opt-in.** The `grid-documents`
  bucket is backed up in two layers, both off `false` by default because both
  need an **external** S3 target to mean anything:

  ```
  pulumi config set grid-oib:seaweedfsBackupEnabled true
  pulumi config set grid-oib:seaweedfsBackupEndpoint https://s3.example.com
  pulumi config set grid-oib:seaweedfsBackupBucket   grid-documents-backup
  pulumi config set --secret grid-oib:seaweedfsBackupAccessKey "…"
  pulumi config set --secret grid-oib:seaweedfsBackupSecretKey "…"
  ```

  `loadConfig` **refuses** an endpoint pointing at the in-cluster SeaweedFS —
  that would put the backup on the volumes it exists to survive losing.

  **Layer A — object mirror.** A `seaweedfs-backup` Deployment runs
  `weed filer.backup` against `/buckets`, writing to the external bucket with
  `is_incremental = true`, so files land under `YYYY-MM-DD/` and **deletions are
  not propagated** (a plain mirror faithfully replicates `rm -rf`).

  > ⚠️ **`filer.backup` has no initial full-copy phase.** It replays the filer's
  > metadata change log, so it converges to a complete mirror only while that log
  > is intact. `fs.log.purge`, or a filer-store migration via `fs.meta.load`
  > (which does not regenerate the log), silently leaves the mirror with a
  > partial baseline and reports nothing. **After the first sync settles, compare
  > object counts against the source.** A running pod is not evidence.

  **Layer B — metadata snapshot.** A `seaweedfs-meta-snapshot` CronJob
  (`seaweedfsMetaSnapshotSchedule`, default `0 3 * * *`) runs `fs.meta.save` —
  the only point-in-time primitive SeaweedFS has — and writes the dump back into
  the documents bucket so Layer A carries it offsite. It asserts the file is
  non-empty, because **`weed shell` exits 0 even when the command inside it
  failed**.

  **Neither layer is point-in-time consistent.** SeaweedFS keeps the namespace
  (filer) and the bytes (volumes) in separate subsystems with no coordinated
  snapshot; upstream guidance is to pause writes if you need the two halves to
  agree.

  **Restore — two procedures, do not mix them.**

  1. *From the object mirror (the one to rehearse).* Stand up an empty cluster,
     recreate the buckets (`s3.bucket.create`, then verify with
     `s3.bucket.list`), then sync the backup bucket back **through the new
     cluster's S3 API**, oldest date directory first so later versions win:
     ```
     aws s3 sync s3://grid-documents-backup/2026-08-06/buckets/grid-documents/ \
                 s3://grid-documents/ --endpoint-url http://seaweedfs:8333
     ```
     Verify with `s3.bucket.list` (sizes and counts) and `volume.fsck`.
  2. *From a metadata snapshot.* `fs.meta.load` is **only** correct when the
     matching volume `.dat`/`.idx` files are restored alongside it. The dump
     references chunk file-ids; loading it against volumes it does not match
     produces a namespace where every GET 404s. Use this only for filer-store
     recovery, never as a substitute for (1).

  A restore that has never been executed is a hypothesis. Rehearse (1) on dev.

- **Document encryption at rest — ON by default (ADR-0042).** SeaweedFS writes
  each chunk with its own AES-256-GCM key
  (`grid-oib:seaweedfsEncryptVolumeData`, default `true`). Two operational
  consequences:

  1. **New writes only.** Objects already in the bucket stay plaintext and keep
     working — each chunk carries its own key, or none. There is no bulk-encrypt
     tool; encrypting an existing corpus means rewriting every object (download
     and re-upload through the document service). Turning the flag off again is
     safe for reads: already-encrypted chunks keep their keys and still decrypt.
  2. **The filer metadata store is now the key store for every object.** There
     is no master key, no escrow and no recovery path. Losing or corrupting that
     store turns the entire bucket into ciphertext nobody can open — including
     the offsite mirror, which holds the same encrypted chunks.

  Because of (2), the metadata snapshot in Layer B stops being a nicety and
  becomes the thing standing between a filer-store failure and total loss.
  `pulumi up` warns on every deploy where encryption is on and
  `seaweedfsBackupEnabled` is false. Treat that warning as a to-do, not noise.

  Note what this protects against, which depends on where the filer store is.
  It protects against someone obtaining volume disks *without* the filer store.
  Under `seaweedfsTopology: single` — and under `split` with
  `seaweedfsFilerStore: leveldb` — that separation does not exist: on `single`
  the filer's leveldb sits on the SAME PVC as the volume data, so the gain is
  GDPR erasure (drop the metadata and the bytes become undecryptable) and not
  disk theft. Under `split` with the Postgres store the keys move to a separate
  database on separate disks behind a different credential, which is what turns
  it into at-rest protection (ADR-0043, § 4). `pulumi up` warns on every deploy
  in the configurations where it is the weaker property. Provider-level PVC
  encryption remains the control that matches "the disks are encrypted".

- **Volume snapshots — still worth adding.** A `VolumeSnapshotClass`
  (`lightbits`) exists but nothing schedules it. CSI snapshots are not consistent
  with the layers above, but they are the fastest way back from a bad in-place
  migration.

---

## 6. How the agent scales — the important part

The agent (`aiq-agent`) is the token-heavy core and the thing you most want to
scale. Its scaling story has two phases. This is grounded in
[`../architecture/scaling-review-2026-07.md`](../architecture/scaling-review-2026-07.md),
which inventories exactly what pins work to one process.

### 6.1 Today: vertical scaling (wired and working)

The agent is a **hard singleton** — it embeds ChromaDB, a private localhost Dask
cluster, and in-process job/citation state — so you scale it **up**, not out:

- **CPU / memory:** `backendRequestsCpu/Memory`, `backendLimitsCpu/Memory`.
- **Research parallelism:** `backendDaskWorkers`, `backendDaskThreads` — the
  in-process Dask cluster that executes deep-research fan-out.
- **Admission control (protects the pod under load):** `backendMaxActiveJobs`,
  `backendMaxActiveJobsPerOrg` bound concurrent deep-research runs;
  `backendIngestMaxWorkers` bounds concurrent ingestion. A burst of users then
  degrades gracefully (429 / friendly message) instead of starving the event
  loop or exhausting provider rate limits.

Two preconditions for *any* scaling are already done in this deployment, so you
never have to retrofit them:

- **Postgres everywhere, never SQLite** — job store, checkpoints, summaries, the
  SSE `LISTEN` DSN, and durable deep-research checkpoints (`AIQ_DEEP_CHECKPOINT_DB`)
  all point at CloudNativePG. Restarts no longer lose durable state.
- **A shared Redis cache** (Dragonfly) is wired into both tiers, so cross-replica
  caches are consistent the moment a second replica appears.

For a large majority of real workloads, a well-resourced single agent pod plus
these admission caps is enough — especially after the low-effort event-loop fix
below lands.

### 6.2 The highest-impact code change (do this first)

Per scaling-review §6.2, the single biggest capacity defect is that
`LlamaIndexRetriever.retrieve` (`sources/knowledge_layer/src/llamaindex/adapter.py`)
does a **synchronous** embedding call + Chroma query on the only event loop —
one user's retrieval stalls every other user's chat stream. Wrapping it in
`asyncio.to_thread` (hours of work, no behaviour change) is the difference
between "one slow tenant degrades everyone" and healthy concurrency. This is a
backend code change, tracked separately from this deployment.

### 6.3 Horizontal research execution — IMPLEMENTED (`jobExecution: db`)

The token-heavy workload (deep research) now scales out. Set
`grid-oib:jobExecution: db` and:

- **Research runs on DB-claimed workers** (ADR-0021): submission writes a
  `SUBMITTED` `job_info` row and enqueues a claimable `research_job_queue` row
  (`frontends/aiq_api/src/aiq_api/jobs/queue.py`); dedicated **`agent-worker`**
  replicas (same image, `GRID_ROLE=worker`) claim rows with `FOR UPDATE SKIP
  LOCKED`, run the same `run_agent_job` body, and heartbeat the claim so a crash
  is reclaimed. An HPA scales them on CPU. The web tier runs **no Dask** in this
  mode.
- **Cancellation works from any replica** — the cancel route flips `job_info` to
  INTERRUPTED and drops the queue row; the runner's 1 s `CancellationMonitor`
  honors it. No scheduler is involved.
- **Shared vectors** (Stage A, `chromaEnabled: true`): the shared Chroma server
  means workers and web replicas read/write one store.
- **Citation registry** already shares cross-replica via Dragonfly (ADR-0020).

Safe rollout: `jobExecution: dask` (default in code) is byte-for-byte today's
behaviour; flip to `db` per environment. `agentWorkerMinReplicas` /
`agentWorkerMaxReplicas` / `agentWorkerConcurrency` size the worker tier.

### 6.4 Multi-replica chat/web tier — IMPLEMENTED (`jobExecution: db`)

In `db` mode the `aiq-agent` web tier now runs `backendReplicas` replicas
(default 2). The chat/retrieval path is replica-safe:

- **Vectors** are shared (Chroma server, §6.3); **job/checkpoint state** is in
  Postgres; **caches + citation registry** are in Dragonfly.
- **Ingestion status is persisted** to a shared `ingest_jobs` table
  (`src/aiq_agent/knowledge/ingest_status_store.py`), so a
  `GET /v1/documents/{job_id}/status` poll resolves from any replica instead of
  404-ing on the replica that didn't accept the upload.
- **The two unlocked background loops are now single-runner**: the ghost-job
  reaper (`routes/jobs.py`) and the knowledge TTL-cleanup thread
  (`knowledge/base.py` via `knowledge/leader_lock.py`) elect one runner per
  cycle with a Postgres advisory lock, so N replicas don't double-reap or race
  `delete_collection` against the shared store.

It stays a StatefulSet (stable identity + a per-replica RWO PVC on Lightbits).

**One documented caveat — base-corpus admin upload.** The platform-owner
base-corpus upload writes PDFs to a per-replica `OIB_UPLOADS_DIR`; the uploaded
file (and a later re-sync of *that file*) lives only on the replica that
received it. The vectors it produces are ingested into shared Chroma and are
searchable from every replica, so **chat is unaffected** — only re-ingesting or
removing that specific source PDF is replica-local. Route `OIB_UPLOADS_DIR`
through SeaweedFS to make that admin flow fully replica-agnostic (scoped
follow-up); high-traffic chat/retrieval does not need it.

### 6.5 Frontend tier — what actually bounds it

The `frontend` Deployment (Next.js UI + BFF + WS gateway, one Node process per
pod) is stateless and HPA-scaled on CPU, 2→6 replicas. Two things determine
whether that works, and neither is obvious from reading the Deployment:

**1. `requests.cpu` is the HPA's divisor, not just a scheduling hint.**
`averageUtilization` is a percentage of *requests*. With the old `100m` request,
the 70% target meant **70 millicores — 7% of the pod's own 1-core limit**, which
an SSR pod clears the instant it serves anything. The HPA had no proportional
range: idle sat at `minReplicas`, any traffic pinned it to `maxReplicas`. The
same number also told the scheduler each pod was tiny, so all six could land on
one node — and `topologySpreadConstraints` is `ScheduleAnyway` (soft), so it
would not have stopped that, defeating what the PDB and spread policy assume.

Requests are now `500m` (trigger ≈ 350m, ~35% of the limit).
`assertHpaTargetIsProportional` in `deploy/pulumi/src/config.ts` fails the
preview if this ratio regresses. Tune from `kubectl top pods` — the invariant is
`requests ≈ steady state`, `limits ≈ 2× requests`.

**2. A rolling update is a self-inflicted reconnect herd.** Every WebSocket on a
draining pod is severed, and each re-upgrade resolves the session, runs FGA
checks and reads budgets (ADR-0020). `GRID_WS_UPGRADE_RATE_LIMIT` does not cover
this: it is keyed on client IP, and the herd arrives from thousands of distinct
IPs. Three bounds now apply — jittered client backoff
(`frontends/ui/src/shared/utils/backoff.ts`), per-pod single-flight memoisation
of the scope lookup (`GRID_WS_SCOPE_CACHE_TTL_MS`), and a global in-flight
ceiling that sheds with `503` + `Retry-After` rather than queueing
(`GRID_WS_UPGRADE_MAX_INFLIGHT`). Covered by
`frontends/ui/tests/gateway/ws-upgrade-admission.test.ts`.

**Known gap — CPU is the wrong signal for two of the three workloads.** Holding
idle WebSockets is memory/fd/event-loop, not CPU; SSR awaiting the Python
backend is I/O wait, not CPU. Only rendering is CPU-bound, so a pod can be at its
connection or event-loop limit while the HPA sees a quiet CPU. Scaling on active
WS connections and event-loop lag needs a `custom.metrics.k8s.io` provider, and
this cluster has **only** `metrics.k8s.io` (metrics-server) — no Prometheus
adapter, no KEDA. A `Pods`-type HPA metric would report `<unknown>` and never
scale. Adding that pipeline is a deliberate infra decision, not a config tweak;
see §10.

---

## 7. Security & hardening (what's wired)

- **Pod Security:** the `grid` namespace enforces the `baseline` standard, and
  every first-party workload container runs with a restricted-compliant
  securityContext (`runAsNonRoot`, `allowPrivilegeEscalation: false`,
  `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`) — see
  `src/platform/security.ts`. Bootstrap Jobs get the same minus the fixed UID.
  Third-party workloads (CNPG, SeaweedFS, Chroma, Dragonfly) keep their images'
  own contexts, which is why the namespace stays at `baseline` not `restricted`.
- **NetworkPolicies** (`grid-oib:networkPolicies`, default **on**): a
  default-deny for ingress plus least-privilege allows — intra-namespace, the
  edge (Envoy) to `frontend`/`seaweedfs`, and the CNPG operator to its pods.
  Egress is deliberately open (the agent calls many external LLM/search APIs);
  tightening it is the one item that needs a live-cluster validation pass first.
- **Dragonfly authentication** (`grid-oib:dragonflyPassword` and
  `grid-oib:rateLimitStorePassword`, both **required**): `requirepass` on both
  instances, delivered as `DFLY_requirepass` from a Kubernetes Secret rather
  than a container arg (a pod spec is readable by anything with `get pod`).
  Consumers get the password inside `REDIS_URL`, which for that reason moved
  into the `grid-secrets` Secret. The two passwords must differ — see §7e for
  why, and for what stays plaintext on the wire. `allowUnauthenticatedRedis`
  is the explicit, warned opt-out; there is no silent one.
- **Image pull policy** resolves to `Always` for the moving `latest` tag (so a
  rescheduled pod never silently runs a stale image) and `IfNotPresent` for a
  pinned SHA. Pin `imageTag` to a SHA in prod for reproducible deploys — the
  deploy workflow already pins staging services to SHA tags.
- **Edge rate limiting** (`grid-oib:rateLimitEnabled`, default **on**;
  ADR-0040 L1): Envoy Gateway's global rate limit service, backed by a
  **dedicated** Dragonfly (`dragonfly-ratelimit`) that is deliberately not the
  ADR-0020 cache — that one runs `--cache_mode=true`, so ordinary cache pressure
  would evict rate-limit counters and silently lift the limits. Per-route,
  per-client-IP budgets attach to the existing `BackendTrafficPolicy` objects
  (`src/app/httproutes.ts`); the `envoy-gateway-system → dragonfly-ratelimit`
  allow is NetworkPolicy rule 5c, and without it every lookup fails and — fail-open
  — nothing is enforced while the config reads as correct.

  **It ships in shadow mode** (`rateLimitShadowMode`, default `true`): rules
  evaluate and emit telemetry, nothing is refused. Read the would-have-blocked
  counts off the Aspire pane (§9), pick real numbers, then set it false.

  **Verify client-IP preservation before trusting any per-IP number.**
  `xffNumTrustedHops` defaults to 0 — correct only if the managed LoadBalancer
  preserves the source IP. If it SNATs instead, every caller is bucketed as the
  LB and a per-client limit silently becomes a per-product one.

## 7b. Rolling updates — how a deploy actually lands

A Kubernetes workload with default settings does not roll safely, and the
defaults are silent about it. Everything below is set explicitly in
`src/platform/rollout.ts`, which is the single home for the numbers and the
reasoning; the tier modules only pick a profile.

**The five defaults this replaces**

| Default behaviour | What it costs here | What the stack sets |
|---|---|---|
| A pod is "available" the instant it first passes readiness | A crash-on-first-request image rolls through the whole fleet before anything notices | `minReadySeconds` (15–30s) — the replacement must stay Ready before the next old pod is touched, so a bad rollout STALLS after one pod |
| `maxUnavailable: 25%` | Capacity drops the moment the roll starts, before the replacement serves | `maxUnavailable: 0, maxSurge: 1` — surge first, prove healthy, then retire |
| No progress deadline | A wedged rollout hangs until the client gives up, with no reason | `progressDeadlineSeconds` — Kubernetes reports `ProgressDeadlineExceeded`, which is what Pulumi's await surfaces as the failure |
| SIGTERM races EndpointSlice removal | The gateway keeps routing to a pod that is already stopping → a few 502s on every deploy | a `preStop` sleep on Service-backed tiers (frontend, aiq-agent) that holds the container open while the data plane converges |
| `terminationGracePeriodSeconds: 30` | SIGKILL mid-drain | per-tier grace budgets, and for research workers an operator knob (below) |

**The one that mattered most.** The research worker stops claiming on SIGTERM
and then *awaits its in-flight jobs* (`aiq_api/jobs/worker.py`). Deep-research
runs take minutes, so the 30s default killed them — every deploy, every node
drain, silently. `grid-oib:agentWorkerDrainSeconds` (default 600, staging 180)
is now that budget. The cost is deploy latency: workers roll one at a time and a
draining pod holds its slot for up to the full budget, so `pulumi up` on this
tier can take (drain × replicas) in the worst case. That is the trade being
made deliberately — lower it only if losing in-flight research is preferable to
waiting.

**Secret rotation is a rollout, not a no-op.** Values injected with
`secretKeyRef` are read once, at container start. Before this, rotating a key
(`pulumi config set --secret grid-oib:openrouterApiKey …` + `pulumi up`) updated
the `grid-secrets` object, reported success, and left every pod serving with the
old credential indefinitely. Each consumer's pod template now carries a
`grid.bigls.net/secret-checksum` annotation derived from the Secret's contents,
so a rotation changes the pod template and triggers an ordinary, gated rolling
update. The digest is a one-way SHA-256 and is deliberately *not* marked secret,
so `pulumi preview` shows you the restart before you approve it.

**Frontend WebSocket drain.** `server.js` honours `GRID_SHUTDOWN_DRAIN_MS` (set
to 30s by the deployment; 2s locally). On SIGTERM it starts failing
`/api/healthz`, refuses new WebSocket upgrades, and lets in-flight streaming
answers finish. The pod's grace period (60s) covers preStop + that drain.

**The edge rolls too.** Everything above protects the app tiers *behind* the
gateway. The Envoy data plane is a Deployment as well — generated by Envoy
Gateway from the `EnvoyProxy` CR, not authored here — and it inherited the stock
`maxUnavailable: 25%`, so any change to that CR (or a `gateway-helm` bump; the
chart is deliberately unpinned) retired one of the two proxies immediately,
along with every connection it was terminating. It now carries the same
surge-only strategy as the app tiers plus a pinned `shutdown` budget
(`minDrainDuration: 10s`, `drainTimeout: 60s` — `EDGE_SHUTDOWN` in `rollout.ts`)
so a departing proxy drains instead of resetting. Both are also the upstream
defaults; they are written down because "the default happens to be right" is not
a property a chart bump preserves.

**Endpoint-programming race → edge retries.** In the seconds between a pod being
marked for deletion and Envoy's cluster dropping that endpoint, a request can be
dispatched at a socket that is already gone. Both routes now carry a retry
budget (`EDGE_RETRY`, 3 attempts, 100ms→1s backoff). The trigger list is
narrowed on purpose to `connect-failure`, `refused-stream` and
`reset-before-request` — the cases where Envoy knows the request never reached
the upstream. Envoy's *default* set includes `unavailable` and 503, which would
replay non-idempotent BFF POSTs (chat sends, ingest, workflow mutations); plain
`reset` would replay a half-streamed answer.

### What "zero downtime" does and does not mean here

For request/response traffic the answer is yes, and it was already yes:
surge-only + a readiness soak means no HTTP request is ever dispatched at a pod
that isn't serving. The three paragraphs above close the remaining gaps at the
edge.

**An open WebSocket is a different guarantee.** Surge-first keeps the old pod
alive until the new one is proven — but it does not keep it alive *forever*, and
when it finally exits, every socket it terminated goes with it. Nothing in
Kubernetes or Envoy can migrate an established TCP connection to another pod. So
a chat socket is re-established once per deploy, by design. The question is only
whether the user notices, and that is a client-side budget: the reconnect curve
in `frontends/ui/src/adapters/api/websocket-client.ts` used to allow 3 attempts,
i.e. it surrendered ~4–7 seconds after the drop and put "Unable to connect to
the server" in front of every open chat on every deploy. It is now sized to
outlast a roll of both tiers (12 attempts ≈ 2–4 min, jittered). Anything longer
than that is a genuinely wedged rollout and should still surface as an error.

**And the agent tier is not interchangeable.** `aiq-agent` keeps per-conversation
WS delivery, human-in-the-loop futures and the running LangGraph task *in
process*, so `server.js` pins each conversation to a specific replica by hash
(ADR-0028, `BACKEND_POD_WS_TEMPLATE`). When replica *i* rolls, that
conversation cannot be served by replica *j* — surging a replacement does not
help, because there is no interchangeable peer. Each affected conversation sees
a real gap of (drain + cold start), which is what the client budget above is
sized against. In `dask` mode the tier is a hard singleton and this applies to
every conversation. Closing that gap for real means letting the WS proxy fall
back to the load-balanced Service when the pinned replica is unreachable, which
trades away the in-process state ADR-0028 exists to preserve — a product
decision, not a Pulumi setting.

**Two traps when changing these on a LIVE cluster.** Both cost a real deploy to
find, because a from-scratch plan cannot show them:

- **Never write an immutable StatefulSet field.** Kubernetes permits only
  `replicas`, `ordinals`, `template`, `updateStrategy`,
  `persistentVolumeClaimRetentionPolicy` and `minReadySeconds` to change in
  place. Setting `podManagementPolicy` — even to the value it already has —
  makes Pulumi plan a **replace** of seaweedfs and chroma. It is left unset
  (`OrderedReady` is the default anyway) and the policy pack now blocks it.
- **Do not flip a live Deployment to `Recreate`.** The API server defaults
  `spec.strategy.rollingUpdate` on every RollingUpdate Deployment, and
  server-side apply will not remove a field this program never owned, so the
  merged object is rejected with `spec.strategy.rollingUpdate: Forbidden: may
  not be specified when strategy type is 'Recreate'`. Use `surgeRollout`
  instead, or clear the defaulted field first with
  `kubectl -n grid patch deploy <name> --type=json -p '[{"op":"remove","path":"/spec/strategy/rollingUpdate"}]'`.
  Only purger and workflow-scheduler use `Recreate`, and both were already on it.

**Verifying a rollout**

```bash
kubectl -n grid rollout status deploy/frontend --timeout=15m
kubectl -n grid rollout status statefulset/aiq-agent --timeout=25m
# What changed, and why a pod restarted:
kubectl -n grid get pods -o custom-columns=\
NAME:.metadata.name,CHECKSUM:.metadata.annotations.grid\.bigls\.net/secret-checksum
# Undo the last rollout without touching Pulumi state (emergency only — the
# next `pulumi up` re-asserts the declared state):
kubectl -n grid rollout undo deploy/frontend
```

The supported rollback is a deploy of an older image: run the **Deploy
(staging)** workflow with the `imageTag` input set to a previous
`sha-<40-hex>` (pinning all three services to it). The workflow verifies the
tag is published for **all three** images before deploying, so a rollback to a
commit that only built some images fails fast instead of rolling the others
into ImagePullBackOff. It goes through the same gates as a forward deploy.

## 7c. Guardrails — CrossGuard policy pack

`deploy/pulumi/policy/` is a Pulumi **CrossGuard** policy pack that runs inside
`pulumi preview` and `pulumi up` (CI passes `--policy-pack ./policy`). It exists
because the settings in §7b are easy to lose — a new workload copy-pasted from
an old one, a "temporary" strategy tweak — and losing them is invisible until an
incident.

| Policy | Level | Blocks |
|---|---|---|
| `deployment-rollout-gated` | mandatory | a Deployment with no `minReadySeconds` / `progressDeadlineSeconds` |
| `deployment-no-capacity-dip` | mandatory | `maxUnavailable != 0`, or `Recreate` on a multi-replica tier |
| `statefulset-rollout-gated` | mandatory | `updateStrategy: OnDelete` (updates the template and rolls nothing), or no soak |
| `statefulset-no-immutable-field-writes` | mandatory | writing `podManagementPolicy` — immutable, so on a live StatefulSet it plans a **replace**, not an update |
| `workload-graceful-termination` | mandatory | an unstated (or <5s) `terminationGracePeriodSeconds` |
| `container-resources-bounded` | mandatory | a container missing CPU/memory requests or limits (autoscaler prerequisite, §1) |
| `moving-tag-must-repull` | mandatory | a `latest`/untagged image without `imagePullPolicy: Always` |
| `prefer-immutable-image-tags` | advisory | any moving tag (currently: the app images on the stack default, SeaweedFS, Dragonfly) |
| `workload-health-probes` | advisory | a container with no probe at all (purger + scheduler are the accepted exceptions) |

A `mandatory` violation fails the plan **before anything touches the cluster**.
Helm-rendered charts (cert-manager, Envoy Gateway, CNPG) arrive as a single
opaque `Release` resource and are out of scope by construction.

```bash
cd deploy/pulumi/policy && npm ci      # once
cd .. && pulumi preview --policy-pack ./policy
```

## 7d. Protected resources

`grid-oib:protectDataResources` (default **true**, `false` on the staging stack)
applies Pulumi's `protect` to the resources whose loss is not recoverable by
re-running `pulumi up`:

- the **CloudNativePG `Cluster`** — the operator owns its PVCs, so deleting the
  CR destroys every database, irreversibly on a `Delete`-reclaim StorageClass
  and completely when `pgBackupsEnabled` is off;
- the **SeaweedFS** and **Chroma** StatefulSets — their PVCs are pinned
  `Retain`, but a delete/replace is still a full outage for object storage and
  the vector index.

Pulumi refuses to delete or replace a protected resource, so a stray rename, an
accidental immutable-field change, or a `pulumi destroy` fails loudly with the
resource still standing. Lifting it is deliberate and auditable:

```bash
pulumi state unprotect 'urn:pulumi:prod::grid-oib::kubernetes:apiextensions.k8s.io/v1:CustomResource::grid-pg'
```

## 7e. Encryption posture

What is and is not encrypted, per store and per channel. Written to be cited in
a security review, so it errs toward saying "no" — a control that only *looks*
like encryption is listed as absent, with the reason.

Three things are true of this whole table and are easy to miss:

- **"Server-side encryption" is a request, not a guarantee.** An S3 client that
  sends `x-amz-server-side-encryption` gets a `200` from a store that ignores
  it, and the object is plaintext. The header is only worth what the
  *destination* implements.
- **Encryption at rest and encryption in transit are different questions.** A
  store can be authenticated and still speak cleartext on the wire.
- **The PVCs underneath everything are the base layer.** If they are not
  encrypted (see below), then "at rest" for Postgres, SeaweedFS, Chroma and the
  agent's `/app/data` all bottom out at the same unencrypted disk.

### At rest

| Store | Encrypted? | Detail |
|---|---|---|
| BYOK LLM credentials | **Yes** | WorkOS Vault (`byokSecretBackend`), or AES-256-GCM under `GRID_BYOK_LOCAL_KEK` in the local backend. ADR-0022. |
| DB-claimed job payloads | **Yes** | AES-256-GCM under `GRID_JOB_PAYLOAD_KEK`; they carry the user auth token. `jobExecution=db` refuses to deploy without the KEK unless `allowPlaintextJobPayloads` opts out. |
| SeaweedFS chunk data | **Yes — and what it protects depends on the topology** | `-filer.encryptVolumeData` (`seaweedfsEncryptVolumeData`, default **on**). Per-chunk AES-256-GCM, **new writes only** — objects written before it was enabled stay plaintext, and there is no bulk-encrypt tool. The per-chunk keys live in the **filer metadata store**, so where that store is decides what the feature is worth. Under `seaweedfsTopology: single` (and under `split` with `seaweedfsFilerStore: leveldb`) the store sits on a PVC in the same cluster — on `single`, the *same* PVC as the volume data — so anyone who obtains the volume obtains the keys beside it: this is crypto-erasure, not disk-theft protection. Under `split` with the Postgres store the keys move to a separate database on separate disks reachable with a different credential, which is what makes it at-rest protection. `pulumi up` warns in the configurations where it is not. ADR-0042, ADR-0043. |
| Postgres data files (tables, indexes, WAL on disk) | **No** | Postgres has no native TDE. Confidentiality at rest here is entirely the PVC's (see below). |
| **Postgres PITR archive** (`pgBackupsEnabled`) | **No by default** | The archive is a byte-for-byte copy of all three databases — every conversation, every LangGraph checkpoint, the whole `grid_app` schema, WAL included. `pgBackupEncryption` (`AES256` \| `aws:kms`) sets CloudNativePG's `barmanObjectStore.{wal,data}.encryption`, which becomes an SSE request header. **It is refused when the destination is the in-cluster SeaweedFS**, because SeaweedFS has no SSE at all on the pinned 3.80 image (SSE-S3/KMS/C first appear in 3.97, and this program configures no KMS for them on any image): it would answer `200` and store plaintext while the Cluster spec read `encryption: AES256`. So the archive is encrypted **only** when it goes to an external S3 destination that documents SSE support *and* `pgBackupEncryption` is set. With the default in-cluster destination it is as protected as the SeaweedFS volumes under it, and no more. `pulumi up` warns on every deploy in that state. |
| SeaweedFS offsite documents backup (`seaweedfsBackupEnabled`) | **Destination's problem** | The mirror is pushed over `https://` (enforced at config load), so it is encrypted in transit. Whether the target bucket encrypts at rest is a property of that bucket, which this program does not configure. |
| **SeaweedFS filer namespace** (`split` + `seaweedfsFilerStore: postgres`) | **No — and it is the key store** | The `seaweedfs_filer` database holds a decryption key for every encrypted chunk in the object store, in ordinary Postgres rows with no application-level encryption. Confidentiality at rest is the PVC's, exactly as for the three application databases. It is separated by *credential* rather than by encryption: its own role, its own database, `CONNECT` revoked from `PUBLIC`, so the application logins cannot reach it and it cannot reach `grid_app`. Its inclusion in the PITR archive is the reason the `pgBackupEncryption` row above matters more than it used to. ADR-0043. |
| Chroma vector store | **No** | Persisted on a PVC, no application-level encryption. Embeddings are derived from document text and should be treated as sensitive. |
| Kubernetes Secrets in etcd | **Unknown to this repo — operator action** | Every credential above (DSNs, S3 keys, the KEKs themselves, the Dragonfly passwords) is a Kubernetes Secret, which is **base64, not encryption**. Encrypting them at rest needs an `EncryptionConfiguration` on the API server, which is a control-plane file on a managed cluster and is not reachable from this program. **Ask the provider whether etcd encryption-at-rest is enabled**, and treat the answer as the ceiling on every "encrypted" row in this table — the KEKs are stored there. |
| **PVCs (all of them)** | **Unknown to this repo — operator action** | The StorageClass is provider-supplied (`grid-oib:storageClass`, e.g. `premium` / `single-replica`, Lightbits NVMe/TCP) and **nothing in this repo creates a StorageClass**. Kubernetes has no per-PVC encryption field: whether volumes are encrypted is decided by the StorageClass's `parameters`, which are fixed when the class is created. There is therefore no config key here that could enable it, and adding one would be a setting that does nothing. **Operator action:** obtain (or have the provider create) an encrypted StorageClass and point `grid-oib:storageClass` at it; `kubectl get storageclass <name> -o yaml` shows the parameters actually in force. This remains the control that actually matches "encrypted at rest", and it is the one ADR-0042 named as the better answer than volume-chunk encryption. |

### In transit

| Channel | Encrypted? | Detail |
|---|---|---|
| Browser → edge (app, S3, landing site, Aspire) | **Yes** | TLS terminated at the Gateway, certs from Let's Encrypt via cert-manager. |
| App → Postgres | **Yes** | Every DSN carries `sslmode=require`; CloudNativePG serves TLS on 5432 with a cert it manages. `require` encrypts but does **not** verify the CA — it closes passive sniffing, not active MITM. `verify-full` is the documented follow-up and needs the CNPG internal CA distributed to five clients (node, asyncpg, psycopg, psql, barman). |
| App → SeaweedFS S3 | **No** | `http://seaweedfs:8333` inside the pod network. |
| App → Dragonfly (cache / conversation bus) | **No — but authenticated** | Plaintext RESP on 6379. Dragonfly is not configured with TLS here. What *did* change: `requirepass` is now **required** (`dragonflyPassword`, or an explicit `allowUnauthenticatedRedis` opt-out), so a pod that can open the socket can no longer read the ADR-0028 conversation bus (every WebSocket frame of every chat, with a replayable 500-event backlog), the cached WorkOS directory (`directory:<orgId>` — email, name, avatar), authorization decisions or budget state. The password reaches consumers inside `REDIS_URL`, which for that reason now lives in the `grid-secrets` Secret rather than inline on each pod spec. |
| Envoy rate limit service → counter store | **No — but authenticated** | Same plaintext RESP. `rateLimitStorePassword` is a **separate** credential from `dragonflyPassword` and is enforced distinct: every app pod holds the cache password in its `REDIS_URL`, and sharing it would let the app tier authenticate to the counter store and flush its own rate limits. It reaches the rate limit service as `REDIS_AUTH` (Envoy Gateway's `RateLimitRedisSettings` has no password field — only `url`, `urlRef`, `tls` — so it is injected via `provider.kubernetes.rateLimitDeployment.container.env`). An auth failure here is **fail-open**: limits stop enforcing, traffic keeps flowing. |
| Frontend → backend (BFF/HTTP) | **No** | `http://aiq-agent:8000` inside the pod network. |
| Frontend → backend (WebSocket chat) | **No** | `ws://`, per-replica via the headless service (ADR-0028 conversation affinity). This is the full chat transport, including prompts and answers. |
| Producers → OTel Collector, Collector → dashboard | **No** | Plain OTLP on `http://otel-collector:4318`. This traffic carries **prompts, retrieved snippets, LLM output and live presigned S3 URLs**, so it is the most sensitive plaintext channel in the namespace; the unauthenticated Aspire UI on `:18888` is likewise kept off-limits only by NetworkPolicy, which is why `observabilityEnabled` refuses to deploy with `networkPolicies=false`. |
| App → Chroma | **No, and unauthenticated** | `http://chroma:8000`, no credentials of any kind. Any pod that can reach it can read or delete every tenant's vectors. NetworkPolicy is the only control. |
| Cluster egress (OpenRouter, Tavily, WorkOS, GitHub) | **Yes** | All HTTPS. |

Everything in the "No" rows above is confined to the pod network of a
single-tenant namespace, and the intra-namespace NetworkPolicy is what bounds
it. That is a real control, but it is **one** control: it stops traffic from
outside `grid`, not a compromised pod inside it. Closing the in-namespace rows
properly means mTLS between services — i.e. a service mesh — which is a
deliberate non-goal here (§10), not an oversight.

## 8. CI/CD

`.github/workflows/deploy.yml` deploys the **dev** stack automatically after
`Publish Images` succeeds on `develop` — which on `develop` rebuilds only the
images whose files changed (a paths-filter gate per service; blog content under
`frontends/web/src/content/**` rebuilds only `grid-web`; `release/**` pushes,
version tags and manual dispatch always build all three). Before `pulumi up`
it enforces four gates: the commit's **CI and Security workflows must be
green** (Publish Images runs in parallel with them, so the chain alone would
deploy untested code — a polling gate closes that race), a **preflight** that
the committed stack file is configured (see below), `tsc --noEmit` (typed
manifests), and two checks on the *same commit* the apply runs —
`scripts/validate-crs.mjs` (schema-validates every CustomResource against the
real upstream CRD schemas) and the **CrossGuard policy pack** (§7c). The plan
is previewed with the same image pins the apply deploys: the deploy asks the
triggering Publish Images run which jobs it actually built (GitHub API, by job
name) and pins **per service** — rebuilt services to the commit's
`sha-<40-hex>` tag, the rest to the image reference already in the stack config
(`grid-oib:backendImage` / `grid-oib:frontendImage` / `grid-oib:webImage`,
falling back to the previously set `grid-oib:imageTag`, then `latest`). The
apply then runs on the same runner (`pulumi up --yes`) — the policy pack does
not re-run on the apply (accepted residual, see
`docs/deployment/pulumi-cloud-feature-audit.md`). Because the
state backend is Pulumi Cloud, the update lands in the console's **Activity**
tab with full logs and diffs regardless of where the CLI ran. Manual
`workflow_dispatch` is refused outside `develop`
(no images exist for other branches) and accepts an optional **`imageTag`
input** — the supported rollback path, which pins **all three** services to
the supplied tag through the identical gates, after verifying the tag is
published for all three images. Prod is promoted manually.

**Pulumi stack config is file-based for plaintext, ESC-based for secrets — the
configured stack file must be committed.** `Pulumi.dev.yaml` holds the
non-secret values plus an `environment:` import of the `grid-oib/dev` ESC
environment, which holds the secrets (Pulumi Cloud stores state, the
secrets-decryption key, and the ESC values). CI reads the *checked-out* file
and resolves the import at open time, so the one-time setup is:
`pulumi stack init matthiasbigl/grid-oib/dev` → edit the placeholder values →
`pulumi config env init --stack dev --keep-config` to move the secrets into
ESC (kubeconfig must be the **non-expiring ServiceAccount
token** from §2b, not the ≤2-week Control-Center download) → delete the
duplicated `secure:` blocks → **commit the updated `Pulumi.dev.yaml` to
`develop`** → add the `PULUMI_ACCESS_TOKEN` repo secret.

Know where each of those is caught, because it is not all the same step. The
workflow's **preflight** only inspects the committed stack file: placeholder
values, and that secrets resolve from either a `secure:` entry under `config:`
or an `environment:` import of `grid-oib/dev` — so an unconfigured or
uncommitted `Pulumi.dev.yaml` fails there, with instructions. The
**`PULUMI_ACCESS_TOKEN`** is Pulumi Cloud state that the
preflight cannot see; a missing one fails later, when the gates and the apply
call Pulumi Cloud. Two more infrastructure
prerequisites: the `blacksmith-*` runner integration, and the `staging` GitHub
environment (created on first run; note that adding required reviewers to it
turns the "automatic" deploy into an approval-gated one).

### What has been validated without the provider cluster

The full program was smoke-deployed against a real single-node cluster on the
provider's exact Kubernetes version (**v1.33.9**), with NetworkPolicies
enforced and prod-shaped config (`jobExecution: db`, backups on, shared
Chroma):

- **Green end-to-end:** namespaces, NetworkPolicies, cert-manager (Gateway
  integration up after the Envoy-Gateway CRD ordering), Envoy Gateway
  controller from the unpinned OCI chart, EnvoyProxy HA fleet (2 replicas +
  PDB), `Gateway` PROGRAMMED with a LoadBalancer address, HTTPRoute
  host-routing (verified with live requests), CNPG operator + webhook-wait Job,
  `Cluster` bootstrap to "healthy" incl. the **Barman backup spec accepted by
  the live latest operator**, `pg-init-tables` DDL Job, Dragonfly, SeaweedFS,
  Chroma, PVC binding, PDBs, and the PVC-retention pins.
- **Expected sandbox-only failures:** ACME registration (the test sandbox
  intercepts TLS; real clusters have direct egress) and app-tier image pulls
  (GHCR images are private; the manifests themselves were accepted by the API
  server). Neither involves the config.
- The smoke run also **caught and fixed a real first-deploy blocker** (a shell
  syntax error in the multi-bucket init Job) — the reason this kind of live
  validation exists.

## 9. Observability — OTel Collector + Aspire Dashboard (ADR-0029)

**Gating (flag AND capability):** the tier is deployed only when
`grid-oib:observabilityEnabled` is on (default `true`) **and** every dependency
it needs is configured — `otelPrimaryApiKey`, plus the dashboard's
dedicated WorkOS Connect application (`otelOidcIssuer`/`otelOidcClientId`/
`otelOidcClientSecret`) behind the edge permission gate (the host derives from
`baseDomain` as `otel.<baseDomain>`). Miss one and `pulumi
preview` logs a warning naming it
and skips the whole tier: no collector, no dashboard, no SecurityPolicy, no
`https-otel` Gateway listener/certificate, and no `OTEL_*` env on any producer
(so the frontend's `src/instrumentation.ts` no-ops). That is deliberate: the
dashboard runs `AuthMode=Unsecured` and relies entirely on the Gateway
SecurityPolicy for auth, so a half-configured tier would be an **open**
telemetry dashboard — and producers pointed at an absent collector just retry
exports forever.

When enabled, the stack deploys two components:

- **`otel-collector`** (`deploy/pulumi/src/platform/otel-collector.ts`) — an
  OpenTelemetry Collector that is the cluster's single OTLP ingestion point.
  All producers send plain OTLP in-cluster; the collector batches, applies
  memory back-pressure, and is the ONLY holder of the Aspire ingestion key.
  Traces, logs, and metrics pipelines are all wired, so adopting a new
  signal later is app-only work. Swapping the backend (Grafana/Tempo/.) is a
  collector-config change, not an app change. The `otlp_http/aspire`
  exporter sets `compression: none` - the dashboard does not decompress
  OTLP/HTTP bodies and 500s on gzip (ADR-0029 Amendment 3).

**Signals actually emitted today** (ADR-0029 Amendment 3): traces from
grid-ui (`@vercel/otel`), grid-aiq-agent and grid-agent-worker (NAT tracing
exporter); logs from all five tiers - the Python tiers via the
`otelcollector_logs` NAT logging method
(`src/aiq_agent/observability/otlp_logging_method.py`, attaches to the root
logger) and the Node tiers (grid-ui, workflow-scheduler, purger) via the
`frontends/ui/observability/otel-logs.js` console bridge. Metrics: nothing
emits them yet; that requires explicit meters.
- **`aspire-dashboard`** (`deploy/pulumi/src/platform/observability.ts`) — a
  .NET Aspire standalone dashboard behind the collector, as a live
  trace/span viewer for platform owners.

```text
grid-ui / grid-aiq-agent / grid-agent-worker / grid-workflow-scheduler / grid-purger
        │  plain OTLP (in-cluster, no key)
        ▼
  otel-collector ── OTLP/HTTP + x-otlp-api-key ──▶ aspire-dashboard
```

**URL:** `https://<otelDomain>` (stack output `otelUrl`).

**Access:** WorkOS OIDC, restricted to holders of the
`platform:organizations:view` permission — the same test the application's own
`isPlatformOwner` accepts (ADR-0016). Enforced at the edge by the
`grid-otel-auth` **SecurityPolicy** on the Envoy Gateway, not inside the
dashboard (ADR-0029 Amendment 2): `oidc` authenticates, `jwt` verifies the
forwarded access token against the issuer's JWKS, and `authorization`
default-denies everything without that scope.

Auth runs against a **dedicated WorkOS Connect application**, not the app's
AuthKit client. That is a hard requirement, not a preference: WorkOS's
`/user_management/*` endpoints read client credentials only from the request
body, while Envoy Gateway hardcodes HTTP Basic for the token exchange, so that
pairing fails at the callback with `OAuth flow failed.` A Connect
application's issuer is a spec-complete OIDC provider that accepts
`client_secret_basic`.

> **Bare membership of the platform org is not enough**, and neither is the
> `org-platform-owner` role on its own if the permission is not attached to it.
> If nobody holds `platform:organizations:view`, nobody can open the dashboard.
> `GRID_PLATFORM_OWNER_EMAILS` is an application-level bootstrap and does **not**
> apply at the Gateway.

One-time setup, in the WorkOS dashboard under **Connect**:

1. Create an OAuth application, **confidential** client (a public PKCE-only
   client has no secret, and the SecurityPolicy requires one).
2. Generate a client secret.
3. Sign-in callback: `https://<otelDomain>/oauth2/callback`.
4. Under **Scopes**, assign the `platform:organizations:view` permission — the
   SecurityPolicy requests it and gates on it, so without this nobody is let in.

Then point the stack at it (all three are part of the tier's capability gate,
so a stack missing any of them deploys no dashboard rather than one nobody can
log into):

```bash
pulumi config set          grid-oib:otelOidcIssuer       https://<tenant>.authkit.app
pulumi config set          grid-oib:otelOidcClientId     client_...
pulumi config set --secret grid-oib:otelOidcClientSecret <secret>
```

**Verifying access after a deploy** — the check the original implementation
lacked, and the first thing to run if login breaks:

```bash
ISSUER=$(pulumi config get grid-oib:otelOidcIssuer)
CID=$(pulumi config get grid-oib:otelOidcClientId)
OTEL_DOMAIN=otel.$(pulumi config get grid-oib:baseDomain)
# Same callback and scopes the SecurityPolicy sends, so this exercises the
# deployed configuration rather than a laxer variant of it.
curl -s -o /dev/null -w '%{redirect_url}\n' \
  "$ISSUER/oauth2/authorize?client_id=$CID\
&redirect_uri=https%3A%2F%2F$OTEL_DOMAIN%2Foauth2%2Fcallback\
&response_type=code\
&scope=openid+profile+email+offline_access+platform%3Aorganizations%3Aview&state=x"
```

It must redirect to the AuthKit login UI. `application_not_found` means the
client id is wrong; `invalid_redirect_uri` means step 3 was missed.

**Scope:** traces from all three app tiers. The Python tiers (`aiq-agent`
chat/web, `agent-worker` deep-research jobs) share the NAT config; the
Next.js BFF registers `@vercel/otel` from `src/instrumentation.ts`. They
appear as separate resources via `OTEL_SERVICE_NAME` (`grid-ui` /
`grid-aiq-agent` / `grid-agent-worker`). Workflow-scheduler and purger emit
no telemetry, and the `server.js` WS proxy is not auto-instrumented
(follow-ups).

**Wiring:**

- `configs/config_oib_openrouter.yml` enables the `otelcollector_redaction`
  tracing exporter (spans only, OTLP/HTTP).
- Pulumi injects `OTEL_SERVICE_NAME` + `OTEL_EXPORTER_OTLP_ENDPOINT` into all
  three tiers (only when the tier is enabled — see Gating above). Endpoint
  asymmetry (intentional): the Python tiers get the
  FULL path (`http://otel-collector:4318/v1/traces` — the NAT exporter posts
  as-is); the frontend gets the BASE URL (`http://otel-collector:4318` — the
  JS OTLP HTTP exporter appends `/v1/traces` per the OTEL spec).
- Sensitive values live in the dedicated Secret `aspire-dashboard-secrets`
  (keys: `otlp-api-key`, `client-secret`), referenced via
  `secretKeyRef` by the dashboard (`Dashboard:Otlp:PrimaryApiKey`) and the
  collector exporter header, and by the Gateway SecurityPolicy for the OIDC
  client secret — never a plain env value. Producers hold no key.
- Only the dashboard UI port (18888) is exposed through the Gateway
  (`https-otel` listener + HTTPRoute). Collector and dashboard OTLP ports are
  cluster-internal. The collector's receivers sit under the wholesale
  `allow-same-namespace` allow (any in-namespace pod can post spans to it —
  accepted, see ADR-0029 residual risks); the **dashboard** is deliberately
  excluded from that allow and reachable only by the Gateway (18888) and the
  collector (4318).

**Caveats:**

- **In-memory ring buffer** (configured to 50k log/trace entries) — data is
  lost on dashboard pod restart. This is a live-view tool, not a log archive.
- Single replica each; an observability outage loses no application data. The
  `batch` processor only groups telemetry — the durability that exists comes
  from the `otlphttp` exporter's `exporterhelper` defaults (`sending_queue`:
  in-memory, 1000 requests; `retry_on_failure`: 5s→30s backoff for up to
  300s). Beyond those limits — a full queue or a dashboard down longer than the
  retry window — **exports are dropped**, which is the intended trade for a
  live-view tool.
- No alerting — operators must watch the dashboard.

**Non-obvious deployment facts** (verified against the dashboard docs and the
installed NAT/OTel SDK — see ADR-0029 §"Verified deployment facts" for the
full list): the container's OTLP listeners default to 18889/18890 and are
rebound to 4317/4318 via `ASPIRE_DASHBOARD_OTLP_*_ENDPOINT_URL`; WorkOS's OIDC
issuer is per-client (`https://api.workos.com/user_management/<client_id>`) and
its `/authorize` needs the non-standard `provider=authkit` selector, which is
why OIDC runs on the Gateway (Envoy preserves query parameters already present
on the configured authorization endpoint; ASP.NET 8 has no equivalent hook);
`ASPNETCORE_FORWARDEDHEADERS_ENABLED=true` is still set so the dashboard
generates `https://` links behind the TLS-terminating Gateway; the NAT exporter
posts OTLP/HTTP to the endpoint as-is, so the full `/v1/traces` path is
required on the Python tiers.

## 10. Out of scope (deliberate follow-ups)

- **A rehearsed SeaweedFS split-topology cutover.** The `split` layout exists
  and is the default for new stacks (§4, ADR-0043), but no `pulumi up` has
  applied it and both existing stacks pin `single`. Multi-master Raft
  (`seaweedfsMasterReplicas: 3`) is likewise wired and unexercised. Until dev
  has been migrated and a restore rehearsed, treat both as untested. Under
  `single`, the PVC survives node loss (NVMe/TCP re-attach), so a node drain is
  a brief reschedule, not data loss.
- **Per-ORGANIZATION S3 credentials.** Per-organization *buckets* ship here;
  the credential reaching them is still one wildcard-scoped identity. The
  blocker is that SeaweedFS's runtime IAM store lives under `/etc` in the
  filer, which the offsite mirror deliberately excludes — see ADR-0043
  § Alternatives.
- Egress NetworkPolicies (needs per-endpoint validation on a live cluster).
- **In-namespace mTLS (a service mesh).** The plaintext channels in §7e —
  `ws://` chat, `http://aiq-agent`, `http://chroma`, plaintext RESP to
  Dragonfly, OTLP — are bounded by the NetworkPolicy set, which stops traffic
  from outside `grid` but not a compromised pod inside it. Closing them
  properly means mTLS between every pair of services; that is a mesh (Cilium,
  Linkerd, Istio) with its own control plane, upgrade cadence and failure
  modes, and it is not a per-service TLS flag anyone can just switch on. A
  deliberate non-goal for a single-tenant namespace, listed here so the gap is
  a decision on record rather than an omission.
- **`EncryptionConfiguration` for Kubernetes Secrets in etcd**, and an
  **encrypted StorageClass for the PVCs** (§7e). Both are control-plane /
  provider-side; neither is reachable from this program, and inventing config
  for them would produce settings that do nothing. Confirm both with the
  provider — they are the ceiling on every at-rest claim in this document.
- A metrics/alerting stack (Prometheus/Grafana/Loki) — the Aspire dashboard
  (§9) covers live traces only. Envoy Gateway, cert-manager, CNPG, and
  SeaweedFS all expose Prometheus metrics, so this is a natural next layer —
  and the provider's paid Metrics (Grafana) add-on is the quick option.
- **Autoscaling the frontend on WS connections / event-loop lag (§6.5).**
  Blocked on the item above, not on app code: an HPA can only consume
  `custom.metrics.k8s.io` or `external.metrics.k8s.io`, and this cluster serves
  only `metrics.k8s.io`. Once a metrics pipeline exists, the choice is
  prometheus-adapter (map a scraped gauge to a `Pods` metric, keeps the HPA) or
  KEDA (richer triggers, its own CRD and controller). The OTel collector already
  carries a metrics pipeline (§9), so the app-side emission is the small half of
  this; the cluster-side provider is the decision.
