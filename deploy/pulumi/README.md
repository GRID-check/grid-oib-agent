# Grid OIB — Kubernetes deployment (Pulumi)

TypeScript Pulumi program that deploys the entire Grid OIB stack to a Kubernetes
cluster: the `aiq-agent` backend, the Next.js frontend/BFF, the purger and
workflow-scheduler workers, plus CloudNativePG Postgres, a Dragonfly cache, and
SeaweedFS object storage — behind Envoy Gateway (Gateway API) with automatic Let's Encrypt TLS.

> Operator walkthrough (prereqs, DNS, day-2, scaling roadmap):
> [`docs/deployment/kubernetes.md`](../../docs/deployment/kubernetes.md).

## What it creates

| Layer | Resources |
|-------|-----------|
| Platform | namespace `grid` (+ default-deny NetworkPolicies), cert-manager (Gateway-API) + Let's Encrypt `ClusterIssuer`, Envoy Gateway, Aspire dashboard (ADR-0029), (metrics-server only on bare clusters) |
| Data | CloudNativePG operator + `Cluster` (`aiq_jobs`, `aiq_checkpoints`, `grid_app`) with optional PITR backups to SeaweedFS (`ScheduledBackup`), Dragonfly, SeaweedFS StatefulSet + bucket-init Job |
| App | `aiq-agent` StatefulSet (+ PVC, +PDB/spread in db mode), `frontend` Deployment + HPA + PDB, `agent-worker` Deployment + HPA + PDB (db mode), `purger`, `workflow-scheduler`, a one-shot `drizzle-kit migrate` Job |
| Edge | Gateway API (Envoy Gateway, HA: 2 replicas + PDB) + HTTPRoutes with cert-manager TLS for `appDomain` and `s3Domain` |

## Prerequisites

- Pulumi CLI + Node 20+.
- A kubeconfig for the target cluster. **Note:** the Control-Center kubeconfig
  token is short-lived (max 2 weeks). For unattended CI/CD deploys, use a
  permanent ServiceAccount token instead — see the "Managed provider (k0s)"
  section in [`docs/deployment/kubernetes.md`](../../docs/deployment/kubernetes.md).
- The provider's **StorageClass** name — `premium` (default, 3 replicas),
  `standard` (2), or `single-replica` (1). Confirm with `kubectl get storageclass`.
  (`lightbits` is the VolumeSnapshotClass, not a StorageClass.)
- Images published to a registry (the `publish-images` GitHub Actions workflow
  pushes them to GHCR on merge to `develop`).

## Quick start

```bash
cd deploy/pulumi
npm install
pulumi stack init prod

# Non-secret config is templated in Pulumi.prod.yaml — edit the placeholders
# (storageClass, appDomain, s3Domain, letsEncryptEmail, imageTag, …).

# Secrets (encrypted into the stack):
pulumi config set --secret grid-oib:kubeconfig           "$(cat ~/.kube/grid-config)"
pulumi config set --secret grid-oib:pgAppPassword        "$(openssl rand -base64 24)"
pulumi config set --secret grid-oib:seaweedfsSecretKey   "$(openssl rand -base64 24)"
pulumi config set --secret grid-oib:gridInternalApiToken "$(openssl rand -hex 32)"
pulumi config set --secret grid-oib:gridAdminToken       "$(openssl rand -hex 32)"
pulumi config set --secret grid-oib:openrouterApiKey     "sk-or-..."
pulumi config set --secret grid-oib:tavilyApiKey         "tvly-..."
pulumi config set --secret grid-oib:workosApiKey         "sk_live_..."
pulumi config set --secret grid-oib:workosCookiePassword "$(openssl rand -hex 32)"
# REQUIRED with the template's jobExecution=db (deploy fails closed without it):
pulumi config set --secret grid-oib:jobPayloadKek      "$(openssl rand -base64 32)"

pulumi preview
pulumi up
```

Then point DNS for `appDomain` and `s3Domain` at the Envoy Gateway external IP
(`kubectl -n envoy-gateway-system get svc`), and once TLS issues, flip
`useStagingIssuer` to `false` and `pulumi up` again.

## Configuration

There are exactly three places values live — if you're looking for a number,
it is in one of these, in this order:

1. **`Pulumi.<stack>.yaml`** — *your* per-environment values (edit these).
2. **`src/config.ts`** — every knob's declaration + default (the table below).
3. **`src/constants.ts`** — fixed platform decisions (ports, UIDs, resource
   envelopes for helpers, shared timeouts) with the reasoning attached. Not
   knobs on purpose; promote one to `config.ts` if an environment genuinely
   needs it to differ.

### Configuration reference

All keys live under the `grid-oib:` namespace. **Bold** = required (no default).
🔒 = set with `pulumi config set --secret`.

| Key | Default | What it does |
|---|---|---|
| **Cluster & images** | | |
| 🔒 **`kubeconfig`** | — | Target-cluster kubeconfig. For CI use the non-expiring SA token (guide §2b) |
| `namespace` | `grid` | Namespace for all app + data workloads |
| `imageRegistry` | `ghcr.io/grid-check` | Registry for the two app images |
| `imageTag` | `latest` | Tag for both images. CI pins `sha-<commit>`; `latest` forces pullPolicy Always |
| `backendImage` / `frontendImage` | — | Full image-ref overrides (registry+tag ignored) |
| `imagePullPolicy` | auto | `Always` for `latest`, else `IfNotPresent` |
| `registryUsername` + 🔒 `registryPassword` | — | Only for PRIVATE app images: creates the `grid-registry-pull` dockerconfigjson Secret and wires it as `imagePullSecrets` on every app workload (the kubelet pulls anonymously, so private GHCR packages need this — a PAT/OAuth token with `read:packages` works as the password). Omit both for public images |
| **Storage** | | |
| **`storageClass`** | — | Provider class for every PVC: `premium` (3 replicas) / `standard` (2) / `single-replica` (1) |
| **Ingress / TLS** | | |
| **`appDomain`** / **`s3Domain`** | — | Public hosts for app and S3 endpoints |
| **`letsEncryptEmail`** | — | ACME account email (placeholder rejected) |
| `useStagingIssuer` | `true` | LE staging CA until DNS/TLS verified, then flip false |
| `installMetricsServer` | `false` | Only for bare clusters; the provider ships metrics already |
| `loadBalancerIp` | — | Pin the Envoy LB IP via `k8s.at/managed-loadbalancer-ip` |
| `networkPolicies` | `true` | Default-deny ingress + least-privilege allows |
| **Postgres (CNPG)** | | |
| `pgInstances` | `1` (prod template: 3) | 1 = single primary; 3 = HA with auto-failover |
| `pgStorageSize` | `20Gi` | Per-instance volume (expandable via config — CNPG manages PVCs) |
| `pgAppUser` | `aiq` | Role owning all three databases |
| 🔒 **`pgAppPassword`** | — | Role password; drives every DSN |
| `pgPrimaryUpdateStrategy` | `unsupervised` | Automatic switchover on operator/image updates |
| `pgBackupsEnabled` | `false` (prod template: true) | Continuous WAL + nightly base backups (PITR) |
| `pgBackupEndpoint` | in-cluster SeaweedFS | Point at external S3 for offsite PITR |
| `pgBackupBucket` | `grid-pg-backups` | Backup bucket (auto-created on in-cluster SeaweedFS) |
| `pgBackupAccessKey` / 🔒 `pgBackupSecretKey` | SeaweedFS keys | Credentials for an external endpoint |
| `pgBackupRetention` | `30d` | Barman retention window |
| `pgBackupSchedule` | `0 0 2 * * *` | 6-field CNPG cron (sec min hour …) |
| **Dragonfly (cache)** | | |
| `dragonflyMaxmemory` | `512mb` | Dataset cap (cache evicts above it) |
| `dragonflyMemoryLimit` | `768Mi` | Pod memory limit; must exceed maxmemory |
| **Chroma (vectors)** | | |
| `chromaEnabled` | `true` | Shared vector server; REQUIRED for db mode (fails closed) |
| `chromaImage` | `chromadb/chroma:1.5.9` | Pinned to match the backend's chromadb client |
| `chromaStorageSize` | `20Gi` | Vector store volume (grow via PVC patch) |
| **SeaweedFS (S3)** | | |
| `seaweedfsImage` | `chrislusf/seaweedfs:latest` | Prod template pins 3.80 (storage engine) |
| `seaweedfsStorageSize` | `20Gi` | Object-store volume (grow via PVC patch) |
| `seaweedfsBucket` | `grid-documents` | Documents bucket (auto-created + verified) |
| `seaweedfsAccessKey` / 🔒 **`seaweedfsSecretKey`** | `grid` / — | S3 identity |
| **Agent (backend web tier)** | | |
| `backendRequestsCpu/Memory`, `backendLimitsCpu/Memory` | 1 / 2Gi / 4 / 8Gi | Vertical scaling |
| `backendDaskWorkers` / `backendDaskThreads` | 1 / 4 | In-process research parallelism (dask mode) |
| `backendMaxActiveJobs` / `backendMaxActiveJobsPerOrg` | 8 / 3 | Admission caps (0 = off) |
| `backendIngestMaxWorkers` | `2` | Concurrent ingestion bound |
| `backendConfigFile` | `config_oib_openrouter.yml` | Baked backend config path |
| `backendDataStorageSize` | `20Gi` | Per-replica /app/data volume (grow via PVC patch) |
| `backendReplicas` | `2` | Web replicas (db mode only; dask forces 1) |
| **Research execution** | | |
| `jobExecution` | `dask` (both templates: `db`) | `db` = DB-claimed worker tier, horizontal |
| `conversationBus` | `true` | Dragonfly pub/sub chat bus (ADR-0028) |
| 🔒 `jobPayloadKek` | — | REQUIRED for db mode (encrypts job payloads at rest) |
| `allowPlaintextJobPayloads` | `false` | Dev-only escape hatch for the KEK requirement |
| `agentWorkerRequestsCpu/Memory`, `agentWorkerLimitsCpu/Memory` | 1 / 2Gi / 4 / 8Gi | Worker sizing |
| `agentWorkerMinReplicas` / `agentWorkerMaxReplicas` | 2 / 8 | Worker HPA bounds |
| `agentWorkerHpaCpuTargetPercent` | `70` | Worker HPA target |
| `agentWorkerConcurrency` | `1` | Jobs per worker process |
| **Frontend** | | |
| `frontendRequestsCpu/Memory`, `frontendLimitsCpu/Memory` | 100m / 256Mi / 1 / 1Gi | Sizing |
| `frontendMinReplicas` / `frontendMaxReplicas` | 2 / 6 | HPA bounds |
| `frontendHpaCpuTargetPercent` | `70` | HPA target |
| **LLM / models** | | |
| 🔒 **`openrouterApiKey`** / 🔒 **`tavilyApiKey`** | — | Provider keys |
| `embedModel` / `embedBaseUrl` | text-embedding-3-large / OpenRouter | Embeddings |
| `vlmModel` / `vlmBaseUrl` | gemma-4-31b-it / OpenRouter | Vision model |
| `budgetEurPerUsd` | `0.86` | Budget conversion |
| **Auth / platform** | | |
| `requireAuth` | `true` | WorkOS AuthKit enforcement |
| **`workosClientId`** / 🔒 `workosApiKey` / 🔒 `workosCookiePassword` | — | WorkOS |
| `platformOwnerEmails` / `platformOrgExternalId` | — / `grid-platform` | Platform tier |
| `disableSelfServeOrgs` / `enforceFeatureFlags` | `false` / `false` | Tenancy toggles |
| `byokSecretBackend` / 🔒 `byokLocalKek` | — | BYOK backends |
| `allowAgentOrgMemory` | `false` | Org-memory write path |
| 🔒 **`gridInternalApiToken`** / 🔒 **`gridAdminToken`** | — | Cross-service tokens |
| **Workflows** | | |
| `workflowsEnabled` | `false` | Scheduled workflows feature; the `workflow-scheduler` Deployment is only created when `true` |
| `workflowMinIntervalMinutes` | `15` | Minimum schedule interval |
| **Observability** (ADR-0029) | | |
| **`otelDomain`** | — | Public hostname of the Aspire dashboard UI (`https-otel` Gateway listener) |
| **`platformOrgId`** | — | WorkOS org id required by the dashboard OIDC claim gate |
| 🔒 `otelPrimaryApiKey` | — | Shared OTLP ingestion key (`x-otlp-api-key`) dashboard ↔ backend/worker |
| `dashboardImage` | `mcr.microsoft.com/dotnet/aspire-dashboard:9.1.0` | Dashboard image pin |
| `dashboardMaxLogCount` / `dashboardMaxTraceCount` | `50000` / `50000` | In-memory ring-buffer limits |

## Validation (no target cluster required)

```bash
npm run typecheck   # tsc: every typed manifest, incl. Gateway/Envoy CRD specs
npm run validate    # pulumi preview → schema-check every CustomResource in the
                    # plan against the real upstream CRD schemas (CNPG included)
```

`validate` needs a selected stack (its config feeds the plan) but works even
when the kubeconfig points at an unreachable cluster. The deploy workflow runs
both before `pulumi up`.

The whole program was additionally smoke-deployed end-to-end against a real
single-node cluster running the provider's exact Kubernetes version
(v1.33.9): platform + data tiers came up green — CNPG bootstrap + Barman backup
config accepted by the live operator webhook, Envoy fleet HA config applied,
Gateway programmed with a LoadBalancer IP, HTTPRoute host-routing verified, and
the bootstrap Jobs ran to completion under enforced NetworkPolicies.

## Layout

```
index.ts                 wiring + stack outputs
src/config.ts            typed config (every knob + secret)
src/platform/            provider, namespace, cert-manager, gateway (Envoy), metrics-server
src/data/                postgres (CNPG), dragonfly, seaweedfs
src/app/                 config (Secret + env), migrations Job, backend,
                         frontend (+HPA), workers, httproutes
```

## Notes

- **State-safe secrets:** every secret is a `pulumi.Output` sourced from
  `--secret` config, so it stays encrypted in state and is only materialised
  inside the `grid-secrets` Kubernetes Secret.
- **Migrations** run once in a Job (not per frontend pod) so replicas never race.
- **SeaweedFS** is intentionally the proven single-node topology on a durable
  PVC; the scale-out path is documented in the operator guide.
