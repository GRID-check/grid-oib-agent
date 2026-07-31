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
| Platform | namespace `grid` (+ default-deny NetworkPolicies), cert-manager (Gateway-API) + Let's Encrypt `ClusterIssuer`, Envoy Gateway, observability (ADR-0029: `otel-collector` Deployment + Service + ConfigMap, `aspire-dashboard` Deployment + Service + HTTPRoute + Secret — only when `observabilityEnabled` **and** its config deps are set), (metrics-server only on bare clusters) |
| Data | CloudNativePG operator + `Cluster` (`aiq_jobs`, `aiq_checkpoints`, `grid_app`) with optional PITR backups to SeaweedFS (`ScheduledBackup`), Dragonfly, SeaweedFS StatefulSet + bucket-init Job |
| App | `aiq-agent` StatefulSet (+ PVC, +PDB/spread in db mode), `frontend` Deployment + HPA + PDB, `agent-worker` Deployment + HPA + PDB (db mode), `purger`, `workflow-scheduler`, a one-shot `drizzle-kit migrate` Job, a one-shot WorkOS audit-schema reconcile Job (when `requireAuth`) |
| Edge | Gateway API (Envoy Gateway, HA: 2 replicas + PDB) + HTTPRoutes with cert-manager TLS for `app.<baseDomain>` and `s3.<baseDomain>` |

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
# (storageClass, baseDomain, letsEncryptEmail, imageTag, …).

# Secrets: with ESC adopted (see docs/deployment/pulumi-cloud-feature-audit.md),
# dev secrets live in the `grid-oib/dev` environment. Migrate in three steps —
# the middle one is not optional, `--keep-config` leaves the values in BOTH
# places and stack config wins over ESC, so skipping it means the secrets never
# actually move:
#   1. pulumi config env init --stack dev --keep-config   # copy into ESC
#   2. delete every `secure:` block from Pulumi.dev.yaml   # drop the duplicates
#   3. pulumi preview --stack dev                          # must be a NO-OP:
#      resolving through ESC yields the same values, so a non-empty diff means
#      a key did not make it across (restore from git and retry).
# Edit secrets afterwards via `pulumi env edit grid-oib/dev` (add under
# values.pulumiConfig as fn::secret). The `pulumi config set --secret` commands
# below are the file-based alternative (ciphertext in the stack file):
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

Then point DNS for `app.<baseDomain>` and `s3.<baseDomain>` (and `otel.<baseDomain>`
when observability is on) at the Envoy Gateway external IP
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
🔒 = secret — lives in the ESC environment (`pulumi env edit grid-oib/<stack>`); `pulumi config set --secret` still works but writes ciphertext into the stack file.

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
| **`baseDomain`** | — | Single source for every public host: `app.`/`s3.`/`otel.` subdomains derive from it, so a domain move is a one-key change |
| `appDomain` / `s3Domain` / `otelDomain` | derived from `baseDomain` | Optional per-host overrides (e.g. an S3 endpoint on a different zone) |
| **`letsEncryptEmail`** | — | ACME account email (placeholder rejected) |
| `useStagingIssuer` | `true` | LE staging CA until DNS/TLS verified, then flip false |
| `installMetricsServer` | `false` | Only for bare clusters; the provider ships metrics already |
| `loadBalancerIp` | — | Pin the Envoy LB IP via `k8s.at/managed-loadbalancer-ip` |
| `networkPolicies` | `true` | Default-deny ingress + least-privilege allows |
| `protectDataResources` | `true` | Pulumi `protect` on the CNPG Cluster + SeaweedFS/Chroma StatefulSets: refuses any delete/replace, so a stray rename or `pulumi destroy` fails loudly instead of destroying data. `false` on scratch stacks; lift one resource with `pulumi state unprotect <urn>` |
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
| `agentWorkerDrainSeconds` | `600` | Seconds a terminating worker may spend finishing already-claimed research jobs (`terminationGracePeriodSeconds`). Below this the kubelet SIGKILLs the drain, so deploys and node drains destroy in-flight research. Costs deploy latency — workers roll one at a time. Floor 30 |
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
| **Collaboration** (ADR-0032…0035) | | |
| `collaborationEnabled` | `false` | Shared chats, `@`-mentions and the inbox. Reaches the frontend as `GRID_COLLABORATION_ENABLED`; consulted only while `enforceFeatureFlags` is `false` (with enforcement on, the per-org `collaboration` WorkOS flag decides). Default-deny — the feature changes who can see a conversation |
| **Observability** (ADR-0029) | | |
| `observabilityEnabled` | `true` | Feature flag for the tier. Deployed only when the flag is on **AND** the capability holds (`otelPrimaryApiKey`, `otelOidcIssuer`, `otelOidcClientId`, `otelOidcClientSecret` all set) — otherwise `preview` warns and nothing is provisioned, including the `https-otel` listener and the producers' OTLP env |
| **`otelOidcIssuer`** | — | Issuer of the dashboard's dedicated WorkOS **Connect** application (the environment's AuthKit domain, `https://<tenant>.authkit.app`) |
| **`otelOidcClientId`** | — | Client id of that Connect application (confidential client) |
| 🔒 `otelOidcClientSecret` | — | Its client secret. The Gateway SecurityPolicy exchanges the code with `client_secret_basic`, so a public/PKCE-only client cannot be used |
| 🔒 `otelPrimaryApiKey` | — | OTLP ingestion key (`x-otlp-api-key`). Held by the **dashboard and collector only** — backend/worker/frontend send unauthenticated OTLP to the collector, so this key must never be copied into app secrets |
| `dashboardImage` | digest-pinned `mcr.microsoft.com/dotnet/aspire-dashboard@sha256:…` (13.4.2) | Dashboard image; override only for a deliberate upgrade. The trivy `image-scan` job blocks on fixable HIGH/CRITICAL in the pin, so it fails when the pin goes stale |
| `collectorImage` | digest-pinned `otel/opentelemetry-collector-contrib@sha256:…` (0.157.0) | OTel Collector image (single OTLP ingestion point); override only for a deliberate upgrade |
| `dashboardMaxLogCount` / `dashboardMaxTraceCount` | `50000` / `50000` | In-memory ring-buffer limits |

## Validation (no target cluster required)

```bash
npm run typecheck   # tsc: every typed manifest, incl. Gateway/Envoy CRD specs
npm run validate    # pulumi preview → schema-check every CustomResource in the
                    # plan against the real upstream CRD schemas (CNPG included)
npm run policy      # pulumi preview --policy-pack ./policy → CrossGuard
                    # guardrails (rollout safety, resource bounds, pull policy)
```

`validate` and `policy` need a selected stack (its config feeds the plan) but
work even when the kubeconfig points at an unreachable cluster. The deploy
workflow runs all three as its gates before the apply; the apply itself is a
plain `up` on the same runner, so the policy pack does **not** re-run there —
the gate preview is the policy checkpoint (accepted residual, see
`docs/deployment/pulumi-cloud-feature-audit.md`).

### Rollout safety

Every workload declares how it rolls rather than inheriting the defaults —
surge-only updates (`maxUnavailable: 0`), a readiness soak, a progress deadline,
a preStop endpoint drain on Service-backed tiers, and an explicit shutdown
budget. The numbers and the reasoning live in one place,
`src/platform/rollout.ts`; `policy/` enforces that no workload drops them. Two
consequences worth knowing:

- **Rotating a secret restarts pods.** Each consumer stamps a
  `grid.bigls.net/secret-checksum` annotation derived from `grid-secrets`, so a
  credential rotation is a real rolling update instead of a Secret nobody
  re-reads. `pulumi preview` shows the annotation change before you approve it.
- **Research workers drain.** `agentWorkerDrainSeconds` is the time a
  terminating worker gets to finish claimed jobs, so rolling that tier can take
  minutes by design. See `docs/deployment/kubernetes.md` §7b.

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
src/platform/            provider, namespace, cert-manager, gateway (Envoy),
                         metrics-server, scheduling (PDB/spread), rollout
                         (update strategy, drain, secret checksum)
policy/                  CrossGuard policy pack (own package.json + npm ci)
src/data/                postgres (CNPG), dragonfly, seaweedfs
src/app/                 config (Secret + env), migrations Job,
                         audit-schemas Job, backend, frontend (+HPA),
                         workers, httproutes
```

## Notes

- **State-safe secrets:** every secret is a `pulumi.Output` sourced from
  `--secret` config, so it stays encrypted in state and is only materialised
  inside the `grid-secrets` Kubernetes Secret.
- **Migrations** run once in a Job (not per frontend pod) so replicas never race.
- **WorkOS audit schemas** are reconciled by their own one-shot Job, for the
  same reason and with the same shape: an action the code emits without a
  registered schema is rejected by WorkOS and the audit trail silently thins
  out (issues #255/#256). The script reads before it writes, so a deploy that
  changes nothing writes nothing. Nothing depends on the Job — an audit outage
  must not block a release. See `docs/deployment/workos-provisioning.md` §5.
- **SeaweedFS** is intentionally the proven single-node topology on a durable
  PVC; the scale-out path is documented in the operator guide.
