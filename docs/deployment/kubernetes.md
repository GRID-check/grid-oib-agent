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
| `seaweedfs` (S3) | StatefulSet | 1 | RWO PVC `/data` | See §4 |

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

## 2. Prerequisites

- A kubeconfig for the cluster (the provider gives you this).
- The provider's **StorageClass** name for block volumes — this is your
  **Lightbits** (NVMe/TCP) class. Find it: `kubectl get storageclass`.
- Container images in a registry. The [`publish-images`](../../.github/workflows/publish-images.yml)
  workflow builds and pushes `grid-oib-backend` and `grid-oib-frontend` to GHCR
  on merge to `develop`. Pin `imageTag` to a commit SHA for reproducible deploys.
  The kubelet pulls **anonymously**: if the GHCR packages are *private*, set
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
The CI workflow avoids this by pinning `sha-<commit>` per deploy; for manual
deploys either pin `imageTag` to a SHA or run `pulumi up --refresh`.

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
2. Point DNS `A`/`AAAA` records for `appDomain` and `s3Domain` at it.
3. Leave `useStagingIssuer: true` until the ingress is reachable and a staging
   cert issues (avoids Let's Encrypt rate limits); then set it `false` and
   `pulumi up` for a trusted cert.
4. Verify: `kubectl -n grid get pods,pvc,httproute,gateway,cluster`.

The base OIB corpus is **not** shipped in the image or from git — it is
volume-based. Load it through the platform-admin upload UI once the stack is up;
it persists on the agent's `/app/data` PVC and is embedded into Chroma on the
fly.

---

## 4. SeaweedFS — decision and scale-out path

**What we run:** the exact single-node topology proven in Docker Compose — one
`weed server -s3` process running master + volume + filer + the S3 gateway — as
a 1-replica StatefulSet, but with its data on a durable Lightbits PVC instead of
an ephemeral local volume. S3 identities come from a Kubernetes Secret (mounted
as `s3.json`); a one-shot Job pre-creates the `grid-documents` bucket.

**Why:** it is the lowest-risk, faithful migration of a battle-tested setup, and
the app's object load (PDFs, presigned preview/download) is modest. Fewer moving
parts than a modular cluster.

**When to scale out** (any of: volume-server disk pressure, throughput ceiling,
you want HA object storage): migrate to the upstream **SeaweedFS Helm chart**
(or operator), which splits master / volume / filer into separate StatefulSets
and lets you run N volume servers and move the filer metadata store onto
Postgres. Because the bucket name (`grid-documents`) and object-key layout are
unchanged, this is a data-preserving migration (an `rclone sync` or the existing
`scripts/migrate-storage.mjs` between the old and new S3 endpoints — the same
pattern used for the MinIO→SeaweedFS cutover in
[`minio-to-seaweedfs-migration.md`](./minio-to-seaweedfs-migration.md)).

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
  provider's Velero addon. The `grid-documents` SeaweedFS bucket itself has no
  automated backup yet — the provider's Velero addon or scheduled
  VolumeSnapshots (needs a scheduler, e.g. snapscheduler) are the options.
  Tune with `pgBackupRetention` (default `30d`) and `pgBackupSchedule` (6-field
  cron, default `0 0 2 * * *`). Restore is `kubectl cnpg` / a bootstrap
  `recovery` from the same object store.

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
- **Image pull policy** resolves to `Always` for the moving `latest` tag (so a
  rescheduled pod never silently runs a stale image) and `IfNotPresent` for a
  pinned SHA. Pin `imageTag` to a SHA in prod for reproducible deploys — the
  deploy workflow already does this for staging.

## 8. CI/CD

`.github/workflows/deploy.yml` deploys the **dev** stack automatically after
`Publish Images` succeeds on `develop`. Before `pulumi up` it enforces four
gates: the commit's **CI and Security workflows must be green** (Publish Images
runs in parallel with them, so the chain alone would deploy untested code — a
polling gate closes that race), a **preflight** that the committed stack file
is configured (see below), `tsc --noEmit` (typed manifests), and
`scripts/validate-crs.mjs` (schema-validates every CustomResource in the plan
— previewed with the same `sha-<sha>` imageTag the deploy applies). Manual
`workflow_dispatch` is refused outside `develop` (no images exist for other
branches). Prod is promoted manually.

**Pulumi stack config is file-based — the configured stack file must be
committed.** `pulumi config set` writes values (secrets as ciphertext) into
`deploy/pulumi/Pulumi.dev.yaml` in your working copy; Pulumi Cloud stores only
state and the decryption key. CI reads the *checked-out* file, so the one-time
setup is: `pulumi stack init grid-check/dev` → edit the placeholder values →
set every `--secret` (kubeconfig must be the **non-expiring ServiceAccount
token** from §2b, not the ≤2-week Control-Center download) → **commit the
updated `Pulumi.dev.yaml` to `develop`** (encrypted secrets are safe to
commit) → add the `PULUMI_ACCESS_TOKEN` repo secret. Until that commit lands,
every CI deploy fails its preflight with instructions. Two more infrastructure
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
it needs is configured — `otelDomain`, `platformOrgId`, `otelPrimaryApiKey`,
plus the WorkOS OIDC client (`workosClientId`/`workosApiKey`) behind the
edge claim gate. Miss one and `pulumi preview` logs a warning naming it
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
  signal later is app-only work. Swapping the backend (Grafana/Tempo/…) is a
  collector-config change, not an app change.
- **`aspire-dashboard`** (`deploy/pulumi/src/platform/observability.ts`) — a
  .NET Aspire standalone dashboard behind the collector, as a live
  trace/span viewer for platform owners.

```text
grid-ui / grid-aiq-agent / grid-agent-worker
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
curl -s -o /dev/null -w '%{redirect_url}\n' \
  "$ISSUER/oauth2/authorize?client_id=$CID\
&redirect_uri=https%3A%2F%2F$OTEL_DOMAIN%2Foauth2%2Fcallback\
&response_type=code&scope=openid+profile+email&state=x"
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

- SeaweedFS modular HA cluster (§4) — single-node today; its PVC survives node
  loss (NVMe/TCP re-attach), so a node drain is a brief reschedule, not data loss.
- Egress NetworkPolicies (needs per-endpoint validation on a live cluster).
- A metrics/alerting stack (Prometheus/Grafana/Loki) — the Aspire dashboard
  (§9) covers live traces only. Envoy Gateway, cert-manager, CNPG, and
  SeaweedFS all expose Prometheus metrics, so this is a natural next layer —
  and the provider's paid Metrics (Grafana) add-on is the quick option.
