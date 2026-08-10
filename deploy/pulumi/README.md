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
| Platform | namespace `grid` (+ default-deny NetworkPolicies), cert-manager (Gateway-API) + Let's Encrypt `ClusterIssuer`, Envoy Gateway, observability (ADR-0029: `otel-collector` Deployment + Service + ConfigMap, `aspire-dashboard` Deployment + Service + HTTPRoute + Secret — only when `observabilityEnabled` **and** its config deps are set), Langfuse (ADR-0044: `langfuse-web` + `langfuse-worker` Deployments, `clickhouse` StatefulSet, a dedicated ingestion queue, HTTPRoute + SecurityPolicy — only when `langfuseEnabled` **and** its config deps are set; flag **on by default**), (metrics-server only on bare clusters) |
| Data | CloudNativePG operator + `Cluster` (`aiq_jobs`, `aiq_checkpoints`, `grid_app`) with optional PITR backups to SeaweedFS (`ScheduledBackup`), Dragonfly, SeaweedFS (one StatefulSet under `seaweedfsTopology=single`; master + volume + filer StatefulSets, and a `seaweedfs_filer` CNPG database + role, under `split`) + bucket-init Job |
| App | `aiq-agent` StatefulSet (+ PVC, +PDB/spread in db mode), `frontend` Deployment + HPA + PDB, `agent-worker` Deployment + HPA + PDB (db mode), `purger`, `workflow-scheduler`, a one-shot `drizzle-kit migrate` Job, a one-shot WorkOS audit-schema reconcile Job (when `requireAuth`) |
| Edge | Gateway API (Envoy Gateway, HA: 2 replicas + PDB) + HTTPRoutes with cert-manager TLS for `app.<baseDomain>` and `s3.<baseDomain>` |
| DNS | Cloudflare A records for exactly the Gateway's HTTPS listener hosts, plus optionally the zone-level `www` / `_dmarc` / apex-redirect records — only when `dnsEnabled` (off by default; records are otherwise maintained by hand) |

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
# REQUIRED: Dragonfly `requirepass` on both instances. Deploy fails closed
# without them (opt out deliberately with allowUnauthenticatedRedis=true). The
# two MUST differ — every app pod holds the cache password in its REDIS_URL, and
# sharing it would let the app tier flush the edge rate-limit counters.
pulumi config set --secret grid-oib:dragonflyPassword       "$(openssl rand -base64 32)"
pulumi config set --secret grid-oib:rateLimitStorePassword  "$(openssl rand -base64 32)"
# REQUIRED with seaweedfsTopology=split + seaweedfsFilerStore=postgres (both
# defaults on a new stack): the login for the dedicated `seaweedfs_filer` role
# that owns the filer namespace. Deploy fails closed without it.
pulumi config set --secret grid-oib:seaweedfsFilerDbPassword "$(openssl rand -base64 24)"
# REQUIRED with seaweedfsPerOrgBuckets=true: the credential for the only
# identity allowed to create and drop tenant buckets.
pulumi config set --secret grid-oib:seaweedfsTenantAdminSecretKey "$(openssl rand -base64 24)"

pulumi preview
pulumi up
```

Then point DNS for `app.<baseDomain>` and `s3.<baseDomain>` (plus
`otel.<baseDomain>` when observability is on and `langfuse.<baseDomain>` when
that tier is) at the Envoy Gateway external IP
(`kubectl -n envoy-gateway-system get svc`), and once TLS issues, flip
`useStagingIssuer` to `false` and `pulumi up` again.

With `dnsEnabled` those records are written by this program instead — see
[§3b](../../docs/deployment/kubernetes.md) — and the host set is derived from
the Gateway's own listeners, so a new tier's host arrives in DNS without anyone
remembering to add it.

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
| `imageRegistry` | `ghcr.io/grid-check` | Registry for the app images |
| `imageTag` | `latest` | Tag for all images. CI pins `sha-<commit>` |
| `backendImage` / `frontendImage` / `webImage` | — | Full image-ref overrides (registry+tag ignored) |
| `imagePullPolicy` | auto | Explicit override only; the default derives per image ref — `Always` for a moving tag (`latest`/untagged), `IfNotPresent` for a pinned one — so mixed refs (SHA `imageTag` + `:latest` override) each get the right policy |
| `registryUsername` + 🔒 `registryPassword` | — | Only for PRIVATE app images: creates the `grid-registry-pull` dockerconfigjson Secret and wires it as `imagePullSecrets` on every app workload (the kubelet pulls anonymously, so private GHCR packages need this — a PAT/OAuth token with `read:packages` works as the password). Omit both for public images |
| **Storage** | | |
| **`storageClass`** | — | Provider class for every PVC: `premium` (3 replicas) / `standard` (2) / `single-replica` (1) |
| **Ingress / TLS** | | |
| **`baseDomain`** | — | Single source for every public host: `app.`/`s3.`/`otel.` subdomains derive from it, so a domain move is a one-key change. The **apex** itself is the landing site's host (frontends/web) |
| `appDomain` / `s3Domain` / `otelDomain` / `webDomain` | derived from `baseDomain` | Optional per-host overrides (e.g. an S3 endpoint on a different zone); `webDomain` defaults to the bare `baseDomain` |
| **`letsEncryptEmail`** | — | ACME account email (placeholder rejected) |
| `useStagingIssuer` | `true` | LE staging CA until DNS/TLS verified, then flip false |
| `installMetricsServer` | `false` | Only for bare clusters; the provider ships metrics already |
| `loadBalancerIp` | — | Pin the Envoy LB IP via `k8s.at/managed-loadbalancer-ip` |
| `xffNumTrustedHops` | `0` | Trusted hops when deriving the client IP from `X-Forwarded-For`. **Every per-IP limit rests on this.** 0 = trust Envoy's downstream address (correct when the LB preserves the source IP); 1 when a SNATing proxy appends one hop. Verify on a live cluster — wrong low buckets the whole internet as one client, wrong high lets a client forge its address |
| `maxConnectionsPerProxy` | `10000` | Max concurrent downstream connections per Envoy replica (0 = unbounded) |
| `networkPolicies` | `true` | Default-deny ingress + least-privilege allows |
| **Public DNS (Cloudflare)** | | |
| `dnsEnabled` | `false` | Manage the stack's A records in Cloudflare instead of by hand. The record set is derived from the same config the Gateway listeners are, so the two cannot drift. Requires a pinned `loadBalancerIp`. Off = records are maintained manually, exactly as before |
| `dnsZoneId` | — | Cloudflare zone id (zone → Overview → API). Required when enabled |
| `dnsZoneName` | — | The zone **apex** — not necessarily `baseDomain`, since a stack may live on a subdomain of its zone. Every managed host is checked to fall inside it: the Cloudflare API treats a name outside the zone as relative and appends the zone, creating a record that resolves nowhere and reporting success |
| 🔒 `cloudflareApiToken` | — | Scoped to that one zone: `Zone:DNS:Edit`, plus `Zone:Dynamic URL Redirects:Edit` when `dnsApexRedirectTo` is set |
| `dnsTtl` | `600` | TTL for unproxied records |
| `dnsZoneBaseline` | `false` | Whether this stack owns the zone-level records (`www`, `_dmarc`, the apex). **At most one stack** — two stacks writing the same record is not an API error, the later `up` silently wins |
| `dnsDmarc` | — | Value of the `_dmarc` TXT record, when the baseline is owned here |
| `dnsApexRedirectTo` | — | Absolute URL the apex and `www` redirect to (302) while no stack serves the apex. Unset it once one does — `loadConfig` refuses both at once |
| **Edge rate limiting (ADR-0040 L1)** | | |
| `rateLimitEnabled` | `true` | Deploy the global rate limit service + its counter store and attach the per-route rules. Off = the app-layer limiters are the only ones |
| `rateLimitShadowMode` | `true` | Evaluate every rule and emit its telemetry, but never refuse. **Ships on**: pick real numbers from the would-have-blocked counts, then flip it off |
| `rateLimitFailClosed` | `false` | Refuse traffic when the rate limit service is unreachable. Fail-open is right for abuse bounds — a counter-store blip must not read as an outage |
| `rateLimitApp` | `600`/min | Catch-all budget per client IP on the app host (deliberately loose — stops runaway clients, does not shape traffic) |
| `rateLimitAppAuth` | `20`/min | `/api/auth/*` — the credential-stuffing surface |
| `rateLimitAppWsUpgrade` | `30`/min | `/websocket` upgrades; mirrors `GRID_WS_UPGRADE_RATE_LIMIT` |
| `rateLimitS3` | `300`/min | Presigned preview/download URLs (one preview fans out into many GETs) |
| `rateLimitWeb` | `120`/min | Landing site + blog |
| `rateLimitStoreMaxmemory` | `256mb` | Counter-store dataset cap (floor 256mb — Dragonfly's per-thread boot minimum) |
| `rateLimitStoreMemoryLimit` | `384Mi` | Counter-store pod memory limit; must exceed maxmemory |
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
| `pgBackupEncryption` | unset | Server-side encryption on the PITR archive: `AES256` or `aws:kms`, written to `barmanObjectStore.{wal,data}.encryption`. **Refused against the in-cluster SeaweedFS**, which has no SSE and would answer 200 while storing plaintext — use it only with an external S3 that documents SSE. Unset (the default) means the archive is unencrypted and `pulumi up` warns. See `docs/deployment/kubernetes.md` §7e |
| **Dragonfly (cache)** | | |
| `dragonflyMaxmemory` | `512mb` | Dataset cap (cache evicts above it) |
| `dragonflyMemoryLimit` | `768Mi` | Pod memory limit; must exceed maxmemory |
| 🔒 **`dragonflyPassword`** | — | REQUIRED. `requirepass` for the cache. Without it any pod in the namespace can read the conversation bus (every chat frame), the cached user directory, authz decisions and budget state |
| 🔒 **`rateLimitStorePassword`** | — | REQUIRED while `rateLimitEnabled`. `requirepass` for the counter store; enforced DISTINCT from `dragonflyPassword` |
| `allowUnauthenticatedRedis` | `false` | Dev-only escape hatch for both passwords above (warns on every deploy) |
| **Chroma (vectors)** | | |
| `chromaEnabled` | `true` | Shared vector server; REQUIRED for db mode (fails closed) |
| `chromaImage` | `chromadb/chroma:1.5.9` | Pinned to match the backend's chromadb client |
| `chromaStorageSize` | `20Gi` | Vector store volume (grow via PVC patch) |
| **SeaweedFS (S3)** | | |
| `seaweedfsImage` | `chrislusf/seaweedfs:latest` | Prod template pins 3.80 (storage engine) |
| `seaweedfsStorageSize` | `20Gi` | Object-store volume (grow via PVC patch) |
| `seaweedfsBucket` | `grid-documents` | Documents bucket (auto-created + verified) |
| `seaweedfsAccessKey` / 🔒 **`seaweedfsSecretKey`** | `grid` / — | S3 identity |
| **SeaweedFS topology** (ADR-0043) | | |
| `seaweedfsTopology` | `split` | `single` runs master, volume, filer and S3 gateway as one `weed server` process on one PVC; `split` runs master, volume and filer+gateway as separate StatefulSets, which is what turns capacity into a replica count and lets the filer store live off the disk holding the chunks it decrypts. **Flipping this on a stack that already holds objects is a data migration, not a config change** — the two topologies use different PVCs, so the new cluster comes up empty while the old volumes sit on a claim nothing mounts, and nothing errors. Both stack templates pin `single`; `split` is the default only for stacks that do not exist yet |
| `seaweedfsMasterReplicas` | `1` | Masters in the Raft quorum (`split` only). Rejected unless odd: two voters tolerate no more failures than one and add a way to deadlock, so "adding HA" that way reduces availability. `1` = no HA |
| `seaweedfsVolumeReplicas` | `1` | Volume servers (`split` only). **The capacity knob** — growing the object store is adding a replica, not patching a PVC |
| `seaweedfsFilerReplicas` | `1` | Filer + S3 gateway pods (`split` only). Rejected above `1` while `seaweedfsFilerStore` is `leveldb`: each replica would keep its own namespace on its own PVC, so the same object would exist or not depending on which pod the Service picked |
| `seaweedfsMasterStorageSize` | `1Gi` | PVC for the master's raft log and volume-id sequence. No object data lands here, so it stays small regardless of how big the store grows |
| `seaweedfsFilerStore` | `postgres` | Where the filer keeps the namespace (`split` only). `postgres` gives it a dedicated database and role on the CNPG cluster, so the per-chunk AES keys stop sharing a disk with the ciphertext they open and inherit Postgres' backups; `leveldb` embeds it on the filer's own PVC — fewer moving parts, single replica only, keys back beside the chunks |
| `seaweedfsFilerStorageSize` | `10Gi` | PVC for the filer's `-defaultStoreDir` (`split` only). Larger than the master's default and deliberately its own knob: under `seaweedfsFilerStore=leveldb` this disk holds the metadata entry **and** the per-chunk AES key for every object in the deployment, and a full filer store stops every write. Under `postgres` the namespace lives in Postgres and this claim holds almost nothing — but it is still mounted, so it still has a size. Initial size only, like every `volumeClaimTemplates` value: grow it by patching the PVC |
| 🔒 `seaweedfsFilerDbPassword` | — | Login for the dedicated `seaweedfs_filer` Postgres role. REQUIRED when `seaweedfsTopology=split` and `seaweedfsFilerStore=postgres`; without it the deploy fails at plan time instead of shipping a filer that boots and cannot reach its store |
| `seaweedfsVolumeSizeLimitMB` | `1024` | Cap on one volume file. A volume server derives its writable-slot count from `free / limit`, so SeaweedFS's own `30000` default computes **one** slot on a 20Gi PVC and zero on 10Gi — which surfaces as "No writable volumes and no free volumes left" on every upload. Volumes grow lazily, so a small limit costs nothing. Ceiling `30000` (`weed master` fatals above it) |
| `seaweedfsVolumeMaxCount` | `64` | Writable volume slots a volume server will hold open (`-max`) |
| `seaweedfsVolumeMinFreeSpace` | `2GiB` | Free space at which a volume server marks all of its volumes read-only. Rejected below one `seaweedfsVolumeSizeLimitMB`: the brake has to engage before a growing volume can hit ENOSPC mid-write, not after. A bare number means *percent* to SeaweedFS and is left unchecked |
| `seaweedfsDefaultReplication` | `000` | Copy placement, `<diffDataCenter><diffRack><sameRack>`. Each volume pod reports its Kubernetes **node** as its rack, so `010` is what actually lands the two copies on two machines. Refused when it asks for more copies than there are volume servers — otherwise volume growth starts failing once the first volume fills, which reads as uploads spontaneously breaking rather than as a config error |
| **SeaweedFS per-organization buckets** (ADR-0043) | | |
| `seaweedfsPerOrgBuckets` | `false` | Put each organization's objects in its own bucket instead of a key prefix inside the shared one: erasing a tenant becomes one `DeleteBucket` rather than a paginated sweep that can half-finish, a key-construction bug stops crossing tenants, and usage becomes readable per tenant at the storage layer. Not a cutover — the bucket is recorded on each document row (`documents.storage_bucket`, NULL = the shared bucket), so turning it on changes where the *next* object goes and moves nothing. Reaches the **frontend only** as `SEAWEED_PER_ORG_BUCKETS` — the purger reads the buckets its documents recorded rather than deriving them, so it needs neither the flag nor the naming rule |
| `seaweedfsTenantBucketPrefix` | `grid-org-` | Leading segment of every tenant bucket name — and the string the tenant grants are wildcarded on (`Read:<prefix>*`), matched by plain string prefix. Refused when it is also a prefix of a platform bucket: `grid-` would hand `grid-documents` **and** `grid-pg-backups`, the Postgres PITR archive, to every identity holding a tenant scope. Must be lowercase alphanumeric/hyphen, ≤32 chars, ending in `-`. Reaches the **frontend only** as `SEAWEED_TENANT_BUCKET_PREFIX` (see above) |
| `seaweedfsTenantAdminAccessKey` / 🔒 `seaweedfsTenantAdminSecretKey` | `grid-tenant-admin` / — | The one identity scoped `Admin:<prefix>*`, i.e. the only one that can create or drop a tenant bucket. Separate from the object credential because SeaweedFS's `Admin:<bucket>` authorises CreateBucket and DeleteBucket together and cannot express one without the other — a distinct key is the only way to keep "drop a tenant" off the request path, and it is why the purger never receives it. The secret is REQUIRED when `seaweedfsPerOrgBuckets` is `true` |
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
| **Web (landing site, frontends/web)** | | |
| `webRequestsCpu/Memory`, `webLimitsCpu/Memory` | 50m / 128Mi / 250m / 256Mi | Sizing — static-first Astro site, near-idle CPU |
| `webMinReplicas` / `webMaxReplicas` | 2 / 4 | HPA bounds |
| `webHpaCpuTargetPercent` | `70` | HPA target |
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
| `ifcModelsEnabled` | `true` | `.ifc` upload, the model workspace, the 3D viewer, the Prüfbuch and the agent's `ifc_query` tool (ADR-0045). Reaches the frontend as `GRID_IFC_MODELS_ENABLED`; consulted only while `enforceFeatureFlags` is `false` (with enforcement on, the per-org `ifc-models` WorkOS flag decides). Defaults ON; set `false` to withdraw the feature without enabling flag enforcement globally |
| **Storage alerts** (ADR-0042) | | |
| `storageAlertsEnabled` | `true` | Creates the hourly `storage-alerts` CronJob, which calls `POST /api/internal/storage/alerts`. Default-**on**, unlike the dark-launch gates above: the quota already refuses the upload that crosses it, so without the alert the first person to learn about the limit is whoever breaks mid-task. An org with no quota is skipped, so on a deployment that sets none the sweep emits nothing |
| `storageAlertThresholdPercent` | `80` | Share of quota at which an organization is warned. Reaches the frontend as `GRID_STORAGE_ALERT_THRESHOLD_PERCENT`. Escalation at 90% and 100% is automatic. **Rejected at load time** if outside `(0, 100]` — the BFF would clamp it back to 80, which is right at runtime and wrong at deploy time, where somebody is present to read the error |
| `storageAlertSchedule` | `0 * * * *` | 5-field cron for the sweep. Hourly because the condition changes on the timescale of an ingest and a live alert suppresses re-emission, so a shorter period costs queries without telling anyone anything new |
| **Memory** | | |
| `memoryReflectionEnabled` | `true` | Post-answer memory-reflection stage (the agent's cross-chat learning loop). Reaches the frontend as `GRID_MEMORY_REFLECTION_ENABLED`; consulted only while `enforceFeatureFlags` is `false` (with enforcement on, the per-org `memory-reflection` WorkOS flag decides). Default-on — reflection is a shipped core capability, not a dark-launched gate |
| **Observability** (ADR-0029) | | |
| `observabilityEnabled` | `true` | Feature flag for the tier. Deployed only when the flag is on **AND** the capability holds (`otelPrimaryApiKey`, `otelOidcIssuer`, `otelOidcClientId`, `otelOidcClientSecret` all set) — otherwise `preview` warns and nothing is provisioned, including the `https-otel` listener and the producers' OTLP env |
| **`otelOidcIssuer`** | — | Issuer of the dashboard's dedicated WorkOS **Connect** application (the environment's AuthKit domain, `https://<tenant>.authkit.app`) |
| **`otelOidcClientId`** | — | Client id of that Connect application (confidential client) |
| 🔒 `otelOidcClientSecret` | — | Its client secret. The Gateway SecurityPolicy exchanges the code with `client_secret_basic`, so a public/PKCE-only client cannot be used |
| 🔒 `otelPrimaryApiKey` | — | OTLP ingestion key (`x-otlp-api-key`). Held by the **dashboard and collector only** — backend/worker/frontend send unauthenticated OTLP to the collector, so this key must never be copied into app secrets |
| `dashboardImage` | digest-pinned `mcr.microsoft.com/dotnet/aspire-dashboard@sha256:…` (13.4.2) | Dashboard image; override only for a deliberate upgrade. The trivy `image-scan` job blocks on fixable HIGH/CRITICAL in the pin, so it fails when the pin goes stale |
| `collectorImage` | digest-pinned `otel/opentelemetry-collector-contrib@sha256:…` (0.157.0) | OTel Collector image (single OTLP ingestion point); override only for a deliberate upgrade |
| `dashboardMaxLogCount` / `dashboardMaxTraceCount` | `50000` / `50000` | In-memory ring-buffer limits |
| **Langfuse** (ADR-0044) — durable LLM observability, self-hosted **free/OSS** build. No licence key is set anywhere; the visible cost is that data-retention policies are an Enterprise feature, so nothing expires and `clickhouseStorageSize` is a number to watch. Full operator guide: [`docs/deployment/kubernetes.md` §9b](../../docs/deployment/kubernetes.md) | | |
| `langfuseEnabled` | `true` | Feature flag. Deployed only when the flag is on **AND** every 🔒 key below is set **AND** `observabilityEnabled` resolves true — Langfuse has no receiver of its own, the collector feeds it. Otherwise `preview` warns naming what is missing and nothing is provisioned (no workloads, no `https-langfuse` listener, no collector exporter, no identity attributes). Default-**on**, so setting the 🔒 keys is all a stack needs; set the flag to `false` to opt out of four workloads and a PVC that grows |
| `langfuseDomain` | `langfuse.<baseDomain>` | Public host. Register `https://<host>/oauth2/callback` as a redirect URI on the **same** WorkOS Connect application as `otelOidc*` — not a second one |
| 🔒 `langfuseEncryptionKey` | — | `ENCRYPTION_KEY`. **64 HEX characters** — the only secret here that is not base64. `openssl rand -hex 32`. Rejected at load time otherwise, because Langfuse's own failure is a crash loop that never names the variable |
| 🔒 `langfusePublicKey` / `langfuseSecretKey` | — | Project API keys, pre-seeded by headless init so the collector has a working ingestion credential in the same `pulumi up`. Prefixes `pk-lf-` / `sk-lf-` are validated at load time — Langfuse validates them too, later and less helpfully |
| 🔒 `langfuseSalt` | — | `SALT`, hashes stored API keys. Rotating it invalidates every key including the collector's |
| 🔒 `langfuseNextAuthSecret` | — | Signs the Langfuse session cookie |
| 🔒 `langfuseDbPassword` | — | Login for the dedicated `langfuse_app` Postgres role, which owns the `langfuse` database and nothing else (it runs its own Prisma migrations, so it holds DDL rights) |
| 🔒 `langfuseClickhousePassword` | — | ClickHouse login. **URL-safe characters only** (`A-Za-z0-9._~-`), enforced at load time: Langfuse's ClickHouse migrator interpolates it into a connection-string query parameter with no encoding, so the house `openssl rand -base64 32` — which always ends in `=` — corrupts the URL and crash-loops langfuse-web on the migration. Use `openssl rand -hex 32` |
| 🔒 `langfuseQueuePassword` | — | `requirepass` for the ingestion queue. **Must differ** from `dragonflyPassword` and `rateLimitStorePassword` (refused at load time): every app pod holds the cache URL, and a shared password would let anything reading one pod's env drain the queue |
| 🔒 `langfuseS3SecretKey` | — | Secret for the `grid-langfuse` S3 identity, scoped to the `langfuse` bucket alone. **Must differ** from every other SeaweedFS secret (refused at load time) — SeaweedFS authenticates by key, so sharing one confers that identity's wider bucket scope |
| `langfuseS3AccessKey` | `grid-langfuse` | Its access key. An identity NAME, so it must match the entry in `s3.json` — hence a default |
| 🔒 `langfuseInitUserPassword` | — | Break-glass Langfuse account created at headless init, for when SSO itself is what is broken. A real credential behind the edge gate, not a placeholder |
| `langfuseInitUserEmail` | `letsEncryptEmail` | That account's email |
| `langfuseOrgId` / `langfuseProjectId` | `grid` / `grid-oib` | Headless-init identifiers. Deliberately not derived from the hostname: headless init matches on them, so a value that moved with the domain would create a SECOND project and orphan every stored trace |
| `langfuseWebImage` / `langfuseWorkerImage` | digest-pinned `ghcr.io/langfuse/langfuse{,-worker}@sha256:…` (3.225.1) | Two keys because upstream publishes two images — but they **must be the same version**, and digests are opaque so nothing can check it. Bump together. Both are scanned by the trivy `image-scan` job |
| `clickhouseImage` | digest-pinned `clickhouse/clickhouse-server@sha256:…` (25.8 LTS) | Single-node analytical store. `CLICKHOUSE_CLUSTER_ENABLED=false` makes the migrator emit plain `MergeTree`, so growing to a real cluster is a migration, not a replica count |
| `clickhouseStorageSize` | `20Gi` | The tier's one unbounded resource — see the retention note above. Growing it is a PVC patch (`volumeClaimTemplates` is immutable and `ignoreChanges`d) |
| `langfuseQueueMaxmemory` / `langfuseQueueMemoryLimit` | `512mb` / `1Gi` | Ingestion-queue dataset cap and pod memory limit. Eviction is OFF, so "full" means ingestion stops (loudly) rather than oldest-drops (silently) |

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
                         dns (Cloudflare records for the Gateway's hosts),
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
- **SeaweedFS** ships two topologies (`seaweedfsTopology`, ADR-0043). A new
  stack defaults to `split` — separate master, volume and filer workloads, so
  capacity is a replica count. Both stack templates pin `single`, the
  single-process topology every deployment ran before ADR-0043, because moving
  an existing stack across is a data migration: the two use different PVCs, so
  a flip without the runbook starts an empty cluster and reports healthy.
