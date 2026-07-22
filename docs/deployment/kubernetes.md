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
| `aiq-agent` (agent: web + Dask + Chroma) | **StatefulSet** | **1** in `dask`; `backendReplicas` (default 2) in `db` | RWO PVC `/app/data` | **Vertically** (CPU/mem + Dask knobs) in `dask`; also horizontally in `db` (see §6.4) |
| `frontend` (Next.js + BFF + WS gateway) | Deployment + HPA | 2→6 | — | Horizontally (CPU HPA) |
| `purger` | Deployment | 1 | — | n/a (SKIP LOCKED-safe) |
| `workflow-scheduler` | Deployment | 1 | — | n/a (DB-claimed ticks) |
| `postgres` (`aiq_jobs`, `aiq_checkpoints`, `grid_app`) | CloudNativePG `Cluster` | 1 (→3 HA) | RWO PVC | Add replicas |
| `dragonfly` (Redis-proto cache) | Deployment | 1 | — (cache) | — |
| `seaweedfs` (S3) | StatefulSet | 1 | RWO PVC `/data` | See §4 |

Platform add-ons installed by Pulumi: **cert-manager** (+ Let's Encrypt issuer,
Gateway-API-enabled), **Envoy Gateway** (Gateway API controller), the
**CloudNativePG operator**, and **metrics-server** (for the HPAs).

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
- Pulumi CLI + Node 20+.

### Storage & Lightbits — what it is and isn't

Lightbits is **block** storage (NVMe/TCP), exposed to Kubernetes through its CSI
driver as a **StorageClass** that hands out fast ReadWriteOnce PVCs. It is *not*
an object store. So:

- Every stateful PVC (Postgres, SeaweedFS, the agent's `/app/data`) is placed on
  the Lightbits StorageClass — set once via `grid-oib:storageClass`.
- The **CSI driver / StorageClass is provider-installed**; Pulumi only
  references the class by name. We do not install the driver.
- **S3 is provided by SeaweedFS**, which runs on top of a Lightbits PVC (see §4).

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
3. Leave `useStagingIssuer: true` until the Gateway is reachable and a staging
   cert issues (avoids Let's Encrypt rate limits); then set it `false` and
   `pulumi up` for a trusted cert.
4. Verify: `kubectl -n grid get pods,pvc,httproute,gateway,cluster`.

The base OIB corpus PDFs **ship in the image (tracked in git under `data/oib/`)**
and self-ingest on first start — `deploy/entrypoint.py` runs a background OIB
sync of the repo corpus, so the knowledge base is not empty on boot. What is
volume-based is the **Chroma vector index** (rebuilt on the agent's `/app/data`
PVC), not the source PDFs. The platform-admin upload UI is for **additional**
base documents (written to `OIB_UPLOADS_DIR`), not for loading the shipped
corpus.

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
`frontends/ui/scripts/migrate-storage.mjs` between the old and new S3 endpoints — the same
pattern used for the MinIO→SeaweedFS cutover in
[`minio-to-seaweedfs-migration.md`](./minio-to-seaweedfs-migration.md)).

---

## 5. Postgres (CloudNativePG)

A single `Cluster` hosts all three logical databases. `aiq_jobs` is the
bootstrapped app DB; `aiq_checkpoints` and `grid_app` are created (owned by the
`aiq` role) at bootstrap via `postInitSQL`. An idempotent Job creates the job +
checkpoint tables; the frontend's `drizzle-kit migrate` Job owns `grid_app`'s
schema.

- **HA:** set `grid-oib:pgInstances: 3` for one primary + two streaming
  replicas with automatic failover. Apps always talk to the `grid-pg-rw`
  service (the current primary).
- **Backups (follow-up):** CloudNativePG supports scheduled base backups + WAL
  archiving to S3 — point it at a `grid-pg-backups` SeaweedFS bucket for
  point-in-time recovery. Not enabled in this first cut; add a `backup` /
  `ScheduledBackup` block when you want PITR.

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

## 7. Out of scope (deliberate follow-ups)

- CloudNativePG scheduled backups / PITR to SeaweedFS (§5).
- SeaweedFS modular HA cluster (§4).
- The backend refactors that unlock horizontal agent scaling (§6.3).
- GitOps (Argo/Flux) and an observability stack (Prometheus/Grafana/Loki).
  Envoy Gateway, cert-manager, CNPG, and SeaweedFS all expose Prometheus
  metrics, so this is a natural next layer.
