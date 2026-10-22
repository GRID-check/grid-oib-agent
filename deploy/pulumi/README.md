# Piloti — Kubernetes deployment (Pulumi)

TypeScript Pulumi program that deploys the entire Piloti stack to a Kubernetes
cluster: the `aiq-agent` backend, the Next.js frontend/BFF, the purger and
skill-scheduler workers, plus CloudNativePG Postgres, a Dragonfly cache, and
SeaweedFS object storage — behind Envoy Gateway (Gateway API) with automatic Let's Encrypt TLS.

> Operator walkthrough (prereqs, DNS, day-2, scaling roadmap):
> [`docs/deployment/kubernetes.md`](../../docs/deployment/kubernetes.md).

## What it creates

| Layer | Resources |
|-------|-----------|
| Platform | namespace `grid` (+ default-deny NetworkPolicies), cert-manager (Gateway-API) + Let's Encrypt `ClusterIssuer`, Envoy Gateway, observability (ADR-0029: `otel-collector` Deployment + Service + ConfigMap — only when `observabilityEnabled` **and** something consumes it: Langfuse, `posthogLogsEnabled` or `posthogMetricsEnabled`; with metrics, ADR-0119, an `otel-agent` DaemonSet and a read-only ServiceAccount and ClusterRole for each), Langfuse (ADR-0044: `langfuse-web` + `langfuse-worker` Deployments, `clickhouse` StatefulSet, a dedicated ingestion queue, HTTPRoute + SecurityPolicy — only when `langfuseEnabled` **and** its config deps are set; flag **on by default**), (metrics-server only on bare clusters) |
| Data | CloudNativePG operator + `Cluster` (`aiq_jobs`, `aiq_checkpoints`, `grid_app`) with optional PITR backups to SeaweedFS (`ScheduledBackup`), Dragonfly, SeaweedFS (one StatefulSet under `seaweedfsTopology=single`; master + volume + filer StatefulSets, and a `seaweedfs_filer` CNPG database + role, under `split`) + bucket-init Job, Qdrant, the one vector store (ADR-0115: `qdrant` StatefulSet + headless and ClusterIP Services + PDB + `qdrant-snapshot` CronJob + `qdrant-alert-rules` ConfigMap, always; operating it: [`qdrant-runbook.md`](../../docs/deployment/qdrant-runbook.md)). No Chroma: `chromaMigration` copies the retired store into Qdrant on the deploy that removes it, and its volume `data-chroma-0` is kept, unmanaged, as the way back |
| App | `aiq-agent` StatefulSet (no PVC; +PDB/spread in db mode), `frontend` Deployment + HPA + PDB, `agent-worker` Deployment + HPA + PDB (db mode), `purger`, `skill-scheduler`, a one-shot `drizzle-kit migrate` Job, a one-shot WorkOS audit-schema reconcile Job (when `requireAuth`), the one-shot `chroma-migration` Job + its `chroma-migration-exporter` ConfigMap (only when `chromaMigration`) |
| Edge | Gateway API (Envoy Gateway, HA: 2 replicas + PDB) + HTTPRoutes with cert-manager TLS for `app.<baseDomain>` and `s3.<baseDomain>` |
| DNS | Cloudflare A records for exactly the Gateway's HTTPS listener hosts, plus optionally the zone-level `www` / `_dmarc` / apex-redirect records — only when `dnsEnabled` (off by default; records are otherwise maintained by hand) |
| Mail | Project mail at Cloudflare (ADR-0135): Email Routing on the mail domain's zone apex (by default the app zone), its catch-all, and the Email Worker that refuses addresses that are not project-shaped and posts the rest, RFC 9421-signed, to the BFF — only when `inboundMailDomain` is set (off by default) |

## Prerequisites

- Pulumi CLI + Node 20+.
- A kubeconfig for the target cluster. **Note:** the Control-Center kubeconfig
  token is short-lived (max 2 weeks). For unattended CI/CD deploys, use a
  permanent ServiceAccount token instead — see the "Managed provider (k0s)"
  section in [`docs/deployment/kubernetes.md`](../../docs/deployment/kubernetes.md).
- The provider's **StorageClass** name — `premium` (default, 3 replicas),
  `standard` (2), or `single-replica` (1). Confirm with `kubectl get storageclass`.
  (`lightbits` is the VolumeSnapshotClass, not a StorageClass.)
- Images published to a registry (CI pushes them to GHCR and tags all three
  `sha-<commit>` for every `develop` commit whose checks passed).

## Quick start

```bash
cd deploy/pulumi
bun install --frozen-lockfile
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
# values.pulumiConfig as fn::secret), or one key at a time with
#   esc env set matthiasbigl/grid-oib/<stack> pulumiConfig.grid-oib:<key> "<value>" --secret
# Staging (dev) and prod keep EVERY secret in ESC: for them, run each line below
# as that `esc env set` (the stack files' headers list them in that form). A
# `pulumi config set --secret` writes ciphertext into the committed stack file
# instead, and stack config wins over ESC, so on those stacks it shadows the
# ESC value. The lines below are for a scratch stack without ESC:
pulumi config set --secret grid-oib:kubeconfig           "$(cat ~/.kube/grid-config)"
pulumi config set --secret grid-oib:pgAppPassword        "$(openssl rand -base64 24)"
pulumi config set --secret grid-oib:seaweedfsSecretKey   "$(openssl rand -base64 24)"
pulumi config set --secret grid-oib:gridInternalApiToken "$(openssl rand -hex 32)"
pulumi config set --secret grid-oib:gridAdminToken       "$(openssl rand -hex 32)"
pulumi config set --secret grid-oib:openrouterApiKey     "sk-or-..."
pulumi config set --secret grid-oib:tavilyApiKey         "tvly-..."
pulumi config set --secret grid-oib:workosApiKey         "sk_live_..."
pulumi config set --secret grid-oib:workosCookiePassword "$(openssl rand -hex 32)"
# REQUIRED (deploy fails closed without it):
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
# REQUIRED on every stack (Qdrant is always deployed): the read-write and
# read-only API keys and the snapshot S3 identity's secret, each its own value
# (ADR-0115).
pulumi config set --secret grid-oib:qdrantApiKey         "$(openssl rand -base64 32)"
pulumi config set --secret grid-oib:qdrantReadOnlyApiKey "$(openssl rand -base64 32)"
pulumi config set --secret grid-oib:qdrantS3SecretKey    "$(openssl rand -base64 32)"
# Rotating qdrantApiKey later takes three deploys through qdrantAltApiKey:
# docs/deployment/qdrant-runbook.md, "Rotate the API key".

pulumi preview
pulumi up
```

Then point DNS for `app.<baseDomain>` and `s3.<baseDomain>` (plus
`langfuse.<baseDomain>` when that tier is on, and `qdrant.<baseDomain>` when
the Qdrant dashboard is: by default, wherever the `otelOidc*` keys are set) at the Envoy Gateway external IP
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
| `appDomain` / `s3Domain` / `webDomain` | derived from `baseDomain` | Optional per-host overrides (e.g. an S3 endpoint on a different zone); `webDomain` defaults to the bare `baseDomain` |
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
| 🔒 `cloudflareApiToken` | — | Scoped to that one zone: `Zone:DNS:Edit`, plus `Zone:Dynamic URL Redirects:Edit` when `dnsApexRedirectTo` is set. With `inboundMailDomain` set it adds, on the mail domain's zone, `Zone:Zone Settings:Edit`, `Zone:Email Routing Rules:Edit` and `Zone:Zone:Read`, plus Account `Workers Scripts:Edit` with the account listed under the token's Account Resources (a token scoped to the zone alone lacks it) |
| `dnsTtl` | `600` | TTL for unproxied records |
| `dnsZoneBaseline` | `false` | Whether this stack owns the zone-level records (`www`, `_dmarc`, the apex). **At most one stack** — two stacks writing the same record is not an API error, the later `up` silently wins |
| `dnsDmarc` | — | Value of the `_dmarc` TXT record, when the baseline is owned here |
| `dnsApexRedirectTo` | — | Absolute URL the apex and `www` redirect to (302) while no stack serves the apex. Unset it once one does — `loadConfig` refuses both at once |
| **Project mail (Cloudflare Email Routing, ADR-0135)** — operator guide: [`docs/deployment/kubernetes.md` §3c](../../docs/deployment/kubernetes.md) | | |
| `inboundMailDomain` | — | Domain of the project addresses, normally the app zone's apex (`piloti.at`, the same as `dnsZoneName`). Setting it turns the feature on: Email Routing, the catch-all and the Worker at Cloudflare, `GRID_INBOUND_MAIL_DOMAIN` on the frontend. Email Routing adds and locks the apex MX and SPF records and a DKIM TXT; it leaves the apex A record, `www` and `_dmarc` alone. **Must be the apex of `inboundMailZoneId`** (Cloudflare's catch-all exists only for an apex; refused at load time for a subdomain of `dnsZoneName`, at preview for any other mismatch). On the app zone it needs `dnsEnabled` and `dnsZoneBaseline`. Refused while `malwareScanEnabled` is false: every part of a mail is scanned before it can be filed. Refused at preview if the apex has MX records pointing anywhere but `*.mx.cloudflare.net`. A company address on the same apex needs a literal routing rule of its own (`postmaster@` and `abuse@` before the first promote: gate G7). Each organization also needs the `inbound-mail` WorkOS entitlement. At most one stack per mail zone. **Never unset it to turn the feature off**: set `inboundMailEnabled: false` first |
| `inboundMailZoneId` | `dnsZoneId` when `inboundMailDomain` equals `dnsZoneName` | Cloudflare zone whose apex is `inboundMailDomain`. Set it only for a domain on a zone of its own |
| `inboundMailEnabled` | `true` | The managed off switch. `false` keeps the domain and Email Routing, updates the catch-all in place to disabled (Cloudflare then refuses unclaimed addresses at SMTP time; never Drop, which loses mail silently), deletes the Worker after that, and takes the domain off the frontend. The keys are then not needed |
| `inboundMailPaused` | `false` | The incident lever: the Worker answers every project address with a temporary failure before reading it, and the BFF answers 503 (`GRID_INBOUND_MAIL_PAUSED`). Senders retry for days; nothing bounces. The promote that first sets the domain sets this too; unpause after launch gates G1–G9 (`scripts/inbound-mail-smoke.ts`) |
| 🔒 `inboundMailSigningKeys` | — | Required with the domain while enabled. JSON, keyid → base64 secret of at least 32 bytes, one or two entries: `{"mi-2026-10":"<openssl rand -base64 32>"}`. Reaches the frontend as `GRID_INBOUND_MAIL_SIGNING_KEYS`; the Worker gets only the entry it signs with, as a `secret_text` binding. Checked as the BFF checks it (a map it cannot use is a 503 on every delivery). Rotate: add the successor, set `inboundMailSigningKeyId` to it, promote; then remove the old entry and promote. Never edit the Worker's binding in the dashboard: the next `up` restores it from state |
| `inboundMailSigningKeyId` | the only key | The keyid the Worker signs with. Required while the map holds two keys |
| **Edge rate limiting (ADR-0040 L1)** | | |
| `rateLimitEnabled` | `true` | Deploy the global rate limit service + its counter store and attach the per-route rules. Off = the app-layer limiters are the only ones |
| `rateLimitShadowMode` | `true` | Evaluate every rule and emit its telemetry, but never refuse. **Ships on**: pick real numbers from the would-have-blocked counts, then flip it off |
| `rateLimitFailClosed` | `false` | Refuse traffic when the rate limit service is unreachable. Fail-open is right for abuse bounds — a counter-store blip must not read as an outage |
| `rateLimitApp` | `600`/min | Catch-all budget per client IP on the app host (deliberately loose — stops runaway clients, does not shape traffic) |
| `rateLimitAppAuth` | `20`/min | `/api/auth/*` — the credential-stuffing surface |
| `rateLimitAppWsUpgrade` | `30`/min | `/websocket` upgrades; mirrors `GRID_WS_UPGRADE_RATE_LIMIT` |
| — | — | `/api/internal/signed/*` (the RFC 9421 signed internal routes, today the project mail webhook) has a route of its own and **no** edge bucket: all of it arrives from Cloudflare's shared egress, so a per-client bucket would let other Cloudflare traffic defer mail. Its edge ceiling is a `Content-Length` of at most 27 MiB matched on the header (Envoy answers 413 otherwise, without buffering a byte), and its upstream budget is 120 s (`SIGNED_INTERNAL_ROUTE` in `src/constants.ts`). The BFF limits per signing key, address and organization after the signature |
| `rateLimitS3` | `300`/min | Presigned preview/download URLs (one preview fans out into many GETs) |
| `rateLimitWeb` | `120`/min | Landing site + blog |
| `rateLimitStoreMaxmemory` | `256mb` | Counter-store dataset cap (floor 256mb — Dragonfly's per-thread boot minimum) |
| `rateLimitStoreMemoryLimit` | `384Mi` | Counter-store pod memory limit; must exceed maxmemory |
| `protectDataResources` | `true` | Pulumi `protect` on the CNPG Cluster + SeaweedFS/Qdrant StatefulSets: refuses any delete/replace, so a stray rename or `pulumi destroy` fails loudly instead of destroying data. `false` on scratch stacks; lift one resource with `pulumi state unprotect <urn>` |
| `nodeGroupApp` / `nodeGroupData` / `nodeGroupBatch` | unset (prod: `Node` / `data` / `batch`) | IPAX worker group, as the value of the node label `k8s.at/node-group` (case-sensitive), that the app tier (everything not below) / the stores / ingestion are pinned to by nodeSelector. Unset renders no nodeSelector. A data group also makes the Postgres anti-affinity and the PgBouncer spread required. The groups themselves are managed in the IPAX Control Center ([kubernetes.md §2b](../../docs/deployment/kubernetes.md#worker-groups-ipax)) |
| **Postgres (CNPG)** | | |
| `pgInstances` | `1` (prod template: 3) | 1 = single primary; 3 = HA with auto-failover |
| `pgStorageSize` | `20Gi` | Per-instance volume (expandable via config — CNPG manages PVCs) |
| `pgPoolerInstances` | `2` (dev: 1) | PgBouncers in the transaction pooler (`grid-pg-pooler-rw`, ADR-0083), spread across nodes with a PDB when more than 1 |
| `pgPoolerPoolSize` | `12` | Server connections each PgBouncer opens per (database, role) pair. The plan fails when `pgPoolerInstances x (3 pooled pairs x this + 1)` plus the direct reserve passes `max_connections` (200): prod 74 + 76 = 150, a fresh stack with everything on 196 (`assertPgConnectionBudget`) |
| `pgPoolerImage` | digest-pinned `ghcr.io/cloudnative-pg/pgbouncer:1.26.0@sha256:…` | PgBouncer image, must be 1.21 or newer (prepared statements in transaction mode). Scanned by the trivy `image-scan` job; override only for a deliberate upgrade |
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
| 🔒 `pgScalerPassword` | derived from `pgAppPassword` | Password of `grid_keda_scaler`, the read-only login KEDA's `postgresql` scaler counts the queue tables with (SELECT on the `status` column of `ingest_job_queue`, `research_job_queue` and `bff_job_queue`, and nothing else). Optional: unset, it is an HMAC of `pgAppPassword`, so it is never the owner's password and needs no new secret to deploy. Set it to rotate the scaler's credential alone; it lives in the `grid-keda-scaler` Secret, which no pod reads, so a rotation restarts nothing |
| **Dragonfly (cache)** | | |
| `dragonflyMaxmemory` | `512mb` | Dataset cap (cache evicts above it) |
| `dragonflyMemoryLimit` | `768Mi` | Pod memory limit; must exceed maxmemory |
| 🔒 **`dragonflyPassword`** | — | REQUIRED. `requirepass` for the cache. Without it any pod in the namespace can read the conversation bus (every chat frame), the cached user directory, authz decisions and budget state |
| 🔒 **`rateLimitStorePassword`** | — | REQUIRED while `rateLimitEnabled`. `requirepass` for the counter store; enforced DISTINCT from `dragonflyPassword` |
| `allowUnauthenticatedRedis` | `false` | Dev-only escape hatch for both passwords above (warns on every deploy) |
| **Qdrant (vectors, ADR-0115)** | | The only vector store, always deployed; [`qdrant-retrieval-design.md`](../../docs/architecture/qdrant-retrieval-design.md) §9 has the reasoning. Every stack gets the `qdrant` StatefulSet, its Services, PDB, NetworkPolicies (`allow-app-to-qdrant`, `qdrant-peers`, and `allow-collector-to-qdrant-metrics` when the collector is deployed), the `qdrant-snapshots` bucket and `grid-qdrant` S3 identity, the `qdrant-snapshot` CronJob and the `qdrant-alert-rules` ConfigMap (Prometheus rules, rendered against `qdrantMemory`; inert: nothing stores the metrics or evaluates the rules on any stack, and connecting the provider's metrics stack or a vmalert to `otel-collector:8889` with these rules is a precondition for prod, see the runbook's "Alerts"), a scrape of every peer's keyless metrics port (6336) by the OTel collector, re-exposed on `otel-collector:8889/metrics`, and `AIQ_QDRANT_URL` + `AIQ_QDRANT_API_KEY` on every backend tier. The dashboard's public route follows `qdrantDashboardEnabled`, on by default wherever the `otelOidc*` Connect application is set. `chromaEnabled`, `chromaImage`, `chromaStorageSize`, `qdrantEnabled` and `vectorBackend` are retired: a stack that still sets one fails the plan with the keys to `pulumi config rm` |
| `qdrantImage` | `qdrant/qdrant:v1.19.2` | Pinned. Self-hosted Qdrant upgrades one minor at a time and a snapshot restores only into the same or the next minor; diff `data/qdrant.ts` against `qdrant-helm` on each minor |
| `qdrantReplicas` | `3` | Peers, one per node (required anti-affinity once `nodeGroupData` is set). `3` keeps Raft quorum through one failure, runs in cluster mode with `ENFORCE_INTERNAL_AUTH`, and hands the backend `AIQ_QDRANT_SHARD_NUMBER=6` / `AIQ_QDRANT_REPLICATION_FACTOR=2` for the collections it creates; `1` runs without cluster mode, for small stacks; `2` is refused. Going from 1 to 3 later turns cluster mode on over existing storage: plan it as a migration, not a knob |
| `qdrantCpu` / `qdrantMemory` | `4` / `16Gi` | Per peer, request = limit (Guaranteed QoS). OOM during optimisation is the most reported Qdrant failure |
| `qdrantStorageSize` | `100Gi` | Data PVC per peer, on `storageClass`, `Retain`. Size at 2x the data: snapshots are staged on it before upload. Initial size only; grow by patching the PVC |
| 🔒 `qdrantApiKey` / 🔒 `qdrantReadOnlyApiKey` | — | REQUIRED, and must differ. In the `qdrant-credentials` Secret (rolls the peers on rotation); the read-write key also reaches the backend tiers as `AIQ_QDRANT_API_KEY` through `grid-secrets` |
| `qdrantS3AccessKey` / 🔒 `qdrantS3SecretKey` | `grid-qdrant` / — | The snapshot identity: object CRUD on `qdrant-snapshots` and nothing else. The secret is REQUIRED and must differ from every other SeaweedFS secret |
| `qdrantSnapshotSchedule` | `30 1 * * *` | 5-field cron for `qdrant-snapshot`: first `GET /aliases` recorded as `aliases/aliases-<timestamp>.json` (aliases are in no snapshot), then every collection snapshotted on every peer (a collection snapshot holds that peer's shards only) and uploaded to `qdrant-snapshots`. Restoring from them: the runbook |
| `qdrantSnapshotRetentionDays` | `7` | The same CronJob deletes snapshots and alias records older than this, by the timestamp in their names |
| `qdrantQuotaMemoryPercent` / `qdrantQuotaDiskPercent` | `90` / `85` | Qdrant's quotas: above either share of the memory limit or of the data volume, a peer refuses writes with HTTP 507 and reports `quota_exceeded{resource}` (the alert `QdrantQuotaExceeded`), instead of an OOM kill or a full disk. Whole percentages 1-99. They seed the quota manager on a cluster's first start only; on a running cluster change them with `PUT /quotas` too (the runbook's "Quotas") |
| 🔒 `qdrantAltApiKey` | — | Unset outside a key rotation. While set, every peer also accepts it as a read-write key, on the API and on p2p, so `qdrantApiKey` can be rotated in three deploys without a refused write (the runbook's "Rotate the API key"). Its arrival and its removal each roll the peers. Must differ from `qdrantReadOnlyApiKey` |
| `chromaMigration` | `false` | Run the one-shot `chroma-migration` Job that copies the retired Chroma store into Qdrant (`app/chroma-migration-job.ts`), on the deploy that removes Chroma; the order of operations is the runbook's "Migrating from Chroma on Kubernetes". The Job exports over HTTP from the Chroma server that deploy still runs (Pulumi deletes it last, and only on success), in a pinned Python image with the `chromadb` the deployment ran, then imports and verifies in the backend image. `pulumi up` waits for it, and every backend tier and the frontend roll only after it: users keep retrieval from Chroma until then, and a failed Job fails the deploy before anything rolled or Chroma was deleted. It runs once while the flag is on (a later deploy does not replace it), never retries (a failed pod keeps its logs and the export), and has no TTL, so it and its log stay until the flag is switched off. While the flag is on, the `housekeeping-base-corpus` and `vector-reconcile` CronJobs are suspended: neither may take a collection the import has not filled yet for one the store lost (a corpus re-embedding, forgotten document metadata) |
| `chromaMigrationScratchSize` | `50Gi` | The Job's scratch volume (a generic ephemeral claim on `storageClass`, kept with the pod until the Job is deleted). It holds the export (about 16 KB per chunk at 3072 dimensions) and about 2 GiB for the `chromadb` environment. 50Gi covers about 3 million chunks |
| `chromaMigrationTimeoutMinutes` | `40` | How long `pulumi up` waits for the Job before it fails the deploy (nothing has rolled then, and Chroma is not deleted; the Job keeps running). The staging pipeline stops at 60 minutes and the rest of a deploy takes about 6: raise it only for an `up` run from a terminal |
| `qdrantLowMemoryMode` | — | `no_resident` or `no_populate`: Qdrant's `storage.low_memory_mode` on every peer, to get one that OOMs while loading its segments back up (the runbook's "OOM crash loop"). Recovery only: remove it once the peer is up. Anything else is refused, because Qdrant refuses it at start |
| `qdrantDashboardEnabled` | `true` | Qdrant's built-in web dashboard on a public host: an `https-qdrant` listener (certificate `grid-qdrant-tls`), its DNS record under `dnsEnabled`, the `grid-qdrant-dashboard` HTTPRoute to `qdrant:6333`, the `grid-qdrant-dashboard-auth` SecurityPolicy (the platform Connect application of `otelOidc*`, operator permission only, no analysts), the `qdrant-dashboard-oidc` Secret and the `allow-edge-to-qdrant-dashboard` NetworkPolicy (edge to 6333 only). Off, none of these exist. On by default only where the three `otelOidc*` keys are set: without them the route is skipped with a warning, and an explicit `true` fails the plan instead. `false` keeps it off. The route strips `Authorization` and `Cookie`, so no WorkOS token reaches Qdrant, and injects no Qdrant key: the operator pastes one into the dashboard. The WorkOS redirect URI it needs first, which key to paste, and the port-forward when it is off: the runbook's "Dashboard" |
| `qdrantDashboardDomain` | `qdrant.<baseDomain>` | Its public host. Register `https://<host>/oauth2/callback` as a redirect URI on the **same** WorkOS Connect application as Langfuse before turning the flag on |
| **Gotenberg (office → PDF, ADR-0070)** | | |
| `gotenbergEnabled` | `true` | Office → PDF converter. Required for indexing Word, presentation, `.xls` and `.ods` files, which the backend reads only from the PDF (ADR-0071). `false` drops the workload and the frontend's `GOTENBERG_URL`: those files are then marked failed with a retryable reason, and `.xlsx`/`.xlsm` index without preview or thumbnail. With `networkPolicies` on it admits the frontend alone and has no egress (`gotenberg-frontend-only`); its flags refuse LibreOffice's outbound fetches either way. Drains a conversion in flight for up to 120s on a rollout |
| `gotenbergReplicas` | `ceil(bffJobsMaxReplicas × bffJobsRenditionConcurrency / 2)` (2 by default) | Converter replicas. A replica is sized for 2 conversions (one running, one ready behind it, `GOTENBERG_SLOTS_PER_REPLICA`), so its capacity is twice this, and the `bff-jobs` pool's ceiling (`bffJobsMaxReplicas × bffJobsRenditionConcurrency`) may not exceed it (`gotenberg.spec.ts` holds the defaults to it). Unset, it follows the pool; set it higher to leave headroom for readers opening a preview, whose conversions the frontend pods run themselves |
| `gotenbergImage` | `gotenberg/gotenberg:8.37.0-libreoffice` | Pinned, LibreOffice-only variant: no Chromium, so no HTML/URL → PDF routes. The container args are 8.x flag names, and an unknown flag (any `--chromium-*` on this variant) stops it at boot. Keep equal to the Compose pin (`gotenberg.spec.ts` checks) |
| **Geocoder (address search, ADR-0120)** | | |
| `geocoderEnabled` | `false` | Self-hosted [Photon](https://github.com/komoot/photon) over the Austrian OSM extract: a `geocoder` StatefulSet of one with an index volume, and `GRID_GEOCODER_URL=http://geocoder:2322` on the frontend. Off, the project dialog's address stays a plain text field. The first start downloads the pinned jar from GitHub and the ~1 GB index from `download1.graphhopper.com`, so the cluster needs HTTPS egress to both. With `networkPolicies` on it admits the frontend alone and may only reach DNS and port 443 (`geocoder-frontend-only`) |
| `geocoderImage` / `geocoderFetchImage` | `eclipse-temurin:21.0.12.1_1-jre-noble@sha256:…` / `alpine:3.22.6@sha256:…` | The Java runtime Photon runs on, and the init container that fetches and verifies the jar (sha256 pinned in `GEOCODER`, `src/constants.ts`) and the index (md5 published beside it). Official images, digest-pinned |
| `geocoderIndexUrl` | GraphHopper's `photon-db-austria-1.0-latest.tar.bz2` | The Photon 1.x index; `<url>.md5` must exist beside it. Move it with the jar on a Photon major bump |
| `geocoderStorageSize` | `10Gi` | The index volume. The index unpacks to about 2 GB; a refresh holds the tarball, the new index and the old one at once |
| `geocoderIndexMaxAgeDays` | `30` | At pod start, an index older than this is fetched again, and the old one is served if that fails. Nothing restarts the pod on a clock; `kubectl -n grid rollout restart statefulset/geocoder` refreshes on demand |
| **Malware scanner (ClamAV, ADR-0133)** | | |
| `malwareScanEnabled` | `false` | clamd and freshclam in a `clamav` Deployment of one (`src/app/clamav.ts`), and `GRID_MALWARE_SCAN_URL=tcp://clamav:3310` on the frontend and the `bff-jobs` pool. Off, every scan fails closed (`not-configured`) and nothing that needs a clean scan is filed. Requests 2 GiB of memory; freshclam needs HTTPS egress to `database.clamav.net`. The pod is ready only while its signatures are under 48 hours old. With `networkPolicies` on it admits the frontend and the `bff-jobs` pool alone (`clamav-bff-only`). Its config is `deploy/compose/clamav/{clamd,freshclam}.conf`, shared with Compose |
| `malwareScanImage` | `clamav/clamav:1.5.4@sha256:…` | The official image with its signatures baked in. Refused unless pinned by digest; keep it equal to the Compose pin. `grid-oib:malwareScanUrl` is refused on every stack: the URL is always the stack's own clamd |
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
| `seaweedfsVolumeMaxCount` | `64` | Writable volume slots a volume server will hold open (`-max`). Applies to **both** topologies — `single` hardcoded 8 until staging ran out of them. A bucket is a SeaweedFS COLLECTION and each one needs a writable volume of its own, so with `seaweedfsPerOrgBuckets` on, this number is the ceiling on how many organizations can ever be onboarded. SeaweedFS grows a new collection by up to 7 volumes at once, so 64 slots hold about nine buckets, platform buckets included; prod sets 512 after the tenth failed (2026-10-20), where the app reports „Object storage is unavailable“. Hitting it looks nothing like a capacity problem: `/dir/status` reports `Max:8 Free:0`, the new org's collection shows `writables: null`, and its first write fails with a bare S3 `InternalError` while the disk sits all but empty. Slots are a ceiling, not a reservation — SeaweedFS grows volumes lazily, so raising this costs nothing until the volumes are used |
| `seaweedfsVolumeMinFreeSpace` | `2GiB` | Free space at which a volume server marks all of its volumes read-only. Rejected below one `seaweedfsVolumeSizeLimitMB`: the brake has to engage before a growing volume can hit ENOSPC mid-write, not after. A bare number means *percent* to SeaweedFS and is left unchecked |
| `seaweedfsDefaultReplication` | `000` | Copy placement, `<diffDataCenter><diffRack><sameRack>`. Each volume pod reports its Kubernetes **node** as its rack, so `010` is what actually lands the two copies on two machines. Refused when it asks for more copies than there are volume servers — otherwise volume growth starts failing once the first volume fills, which reads as uploads spontaneously breaking rather than as a config error |
| **SeaweedFS per-organization buckets** (ADR-0043) | | |
| `seaweedfsPerOrgBuckets` | `false` | Put each organization's objects in its own bucket instead of a key prefix inside the shared one: erasing a tenant becomes one `DeleteBucket` rather than a paginated sweep that can half-finish, a key-construction bug stops crossing tenants, and usage becomes readable per tenant at the storage layer. Not a cutover — the bucket is recorded on each document row (`documents.storage_bucket`, NULL = the shared bucket), so turning it on changes where the *next* object goes and moves nothing. Reaches the **frontend only** as `SEAWEED_PER_ORG_BUCKETS` — the purger reads the buckets its documents recorded rather than deriving them, so it needs neither the flag nor the naming rule |
| `seaweedfsTenantBucketPrefix` | `grid-org-` | Leading segment of every tenant bucket name — and the string the tenant grants are wildcarded on (`Read:<prefix>*`), matched by plain string prefix. Refused when it is also a prefix of a platform bucket: `grid-` would hand `grid-documents` **and** `grid-pg-backups`, the Postgres PITR archive, to every identity holding a tenant scope. Must be lowercase alphanumeric/hyphen, ≤32 chars, ending in `-`. Reaches the **frontend only** as `SEAWEED_TENANT_BUCKET_PREFIX` (see above) |
| `seaweedfsTenantAdminAccessKey` / 🔒 `seaweedfsTenantAdminSecretKey` | `grid-tenant-admin` / — | The one identity scoped `Admin:<prefix>*`, i.e. the only one that can create or drop a tenant bucket. Separate from the object credential because SeaweedFS's `Admin:<bucket>` authorises CreateBucket and DeleteBucket together and cannot express one without the other — a distinct key is the only way to keep "drop a tenant" off the request path, and it is why the purger never receives it. The secret is REQUIRED when `seaweedfsPerOrgBuckets` is `true` |
| **Agent (backend web tier)** | | |
| `backendRequestsCpu/Memory`, `backendLimitsCpu/Memory` | 1 / 2Gi / 4 / 8Gi | Vertical scaling |
| `backendMaxActiveJobsPerOrg` | 3 | Research jobs one organization runs at once (0 = off). It is the workers' claim cap: a job over it waits in the queue (ADR-0079), it is not refused |
| `backendMaxQueuedJobsPerOrg` | `50` | `db` execution: research jobs one organisation may have waiting (`GRID_MAX_QUEUED_JOBS_PER_ORG`), the only 429 left. 0 = off |
| `backendIngestMaxWorkers` | `2` | Concurrent ingestion bound |
| `backendConfigFile` | `config_oib_openrouter.yml` | Baked backend config path |
| `backendReplicas` | `2` | Chat replicas. The floor once the chat tier autoscales |
| `chatAffinity` | `true` | `GRID_CHAT_AFFINITY` (ADR-0080): the gateway pins a conversation to a replica by hash (the replica count is then static). `false` sends sockets to the `aiq-agent` Service and lets the conversation bus decide per turn; needs `conversationBus`. Prod keeps `true` until the cross-replica path is validated on dev |
| `backendMaxReplicas` | `3` | Ceiling KEDA scales the chat tier to. Used only with `chatAffinity: false` and a ceiling above `backendReplicas`; prod pins `1` |
| `backendTurnsPerReplica` | `8` | Fleet-wide running chat turns per replica that the KEDA `metrics-api` trigger aims for (`GET /v1/internal/chat-occupancy`) |
| `backendCpuTargetPercent` | `70` | CPU utilisation (% of requests) of the KEDA `cpu` trigger beside it |
| `backendDrainSeconds` | `20` with `chatAffinity: true`, `2730` with it off | `GRID_CHAT_DRAIN_SECONDS`: how long a terminating replica waits for its turns. The pod grace period is this plus 10 s of endpoint drain and 60 s of slack, so the autoscaled value covers the longest chat turn (`GRID_CHAT_TURN_DEADLINE_SECONDS`, 2700). Floor 10 |
| **Research execution** | | |
| `conversationBus` | `true` | Dragonfly pub/sub chat bus (ADR-0028) |
| 🔒 `jobPayloadKek` | — | REQUIRED for db mode (encrypts job payloads at rest) |
| `allowPlaintextJobPayloads` | `false` | Dev-only escape hatch for the KEK requirement |
| `agentWorkerRequestsCpu/Memory`, `agentWorkerLimitsCpu/Memory` | 1 / 2Gi / 4 / 8Gi | Worker sizing |
| `agentWorkerMinReplicas` / `agentWorkerMaxReplicas` | 1 / 8 | KEDA bounds for the worker tier, which scales on `research_job_queue` depth (not CPU). 0 lets it idle while nothing waits; dev sets 0 |
| `agentWorkerConcurrency` | `1` | Jobs per worker process; KEDA asks for one replica per this many open jobs |
| `agentWorkerDrainSeconds` | `600` | Seconds a terminating worker may spend finishing already-claimed research jobs (`GRID_RESEARCH_WORKER_DRAIN_SECONDS`); the grace period is this plus 30 s. A job still running when it ends is requeued without costing an attempt and started over by another worker, so the budget decides how much work a deploy repeats. Costs deploy latency — workers roll one at a time. Floor 30 |
| **The api tier** (ADR-0082): `aiq-api`, every backend HTTP route but the chat socket, which `BACKEND_URL` names | | |
| `apiMinReplicas` / `apiMaxReplicas` | 2 / 4 (prod 1 / 3, dev 1 / 2) | Bounds of its CPU HPA. A ceiling below the floor fails the plan |
| `apiHpaCpuTargetPercent` | `70` | HPA target average CPU, as a percentage of requests (`apiRequestsCpu`) |
| `apiRequestsCpu/Memory`, `apiLimitsCpu/Memory` | 500m / 1536Mi / 2 / 6Gi | Sizing |
| **Ingestion tier, BFF pool and KEDA** (ADR-0076, ADR-0079) | | |
| `ingestWorkerMinReplicas` / `ingestWorkerMaxReplicas` | 1 / 5 (prod 1 / 8) | KEDA bounds for the ingest tier, which scales on `ingest_job_queue` depth. The ceiling is held to the provider budget below: the deploy fails when it is more than 2x `vlmFleetConcurrency`. Prod's 8 x 2 x 4 = 64 sits exactly at it |
| `ingestWorkerRequestsCpu/Memory`, `ingestWorkerLimitsCpu/Memory` | 500m / 4Gi / 2 / 6Gi (prod: 1 / 6Gi / 2 / 6Gi, on the batch group) | Sizing. The memory request is what a worker holds while it parses, so the scheduler cannot pack several onto one node; prod sets request = limit, so it cannot overcommit at all |
| `ingestWorkerConcurrency` / `ingestWorkerDrainSeconds` | 3 (prod 2) / 600 | Jobs per worker (also KEDA's jobs-per-replica target) / SIGTERM budget; the grace period is the drain plus 30 s |
| `ingestMaxPerOrg` | `0` | Most ingest jobs one organisation may run fleet-wide at once; 0 = no cap (the claim is fair regardless) |
| `bffJobsEnabled` | `true` | Run the `bff-jobs` pool. It runs project reindex, failed-ingestion rescan, IFC extraction, Office → PDF rendition and research-report filing, so with it off none of those runs |
| `bffJobsRequestsCpu/Memory`, `bffJobsLimitsCpu/Memory` | 250m / 512Mi / 1 / 2Gi | Sizing. The limit is double a frontend pod's because an IFC model is parsed in the pod, several times its own size in memory, `bffJobsConcurrency` of them at once |
| `bffJobsMinReplicas` / `bffJobsMaxReplicas` | 1 / 4 | KEDA bounds for the `bff-jobs` pool, which scales on `bff_job_queue` depth |
| `bffJobsConcurrency` / `bffJobsDrainSeconds` | 2 / 60 | Jobs per pod (also KEDA's target) / SIGTERM budget; the grace period is the drain plus 30 s |
| `bffJobsMaxPerOrg` | `0` | Most jobs one organisation may run fleet-wide at once; 0 = no cap (the claim is fair regardless) |
| `bffJobsRenditionConcurrency` | `1` | `GOTENBERG_MAX_CONCURRENCY` in a `bff-jobs` pod: Office conversions one pod runs at Gotenberg at once. The fleet's conversion ceiling is this times `bffJobsMaxReplicas` (`renditionCeiling`), and it is held to `gotenbergReplicas` (below): raise either side of the product and Gotenberg's replicas must follow, or conversions queue inside the converter and run out their API timeout |
| `installKeda` | `true` | Install KEDA (chart pinned in `src/platform/keda.ts`, the release the plan's CRDs are validated against). `false` when the cluster already runs one, which must then be the same release |
| **Provider budget** (ADR-0076, ADR-0081) | | |
| `vlmFleetConcurrency` | `32` | `AIQ_VLM_FLEET_CONCURRENCY`: vision calls in flight across every ingest process at once (0 = off). Held to `providerModelLimitCeiling` and `providerLimitCeiling`: a vision call holds a slot in both pools, so a larger pool never fills |
| `vlmBatchWorkers` | `4` | `AIQ_VLM_BATCH_WORKERS`: vision calls one file runs at once. With the ingest tier's replicas and concurrency it sets the peak that `vlmFleetConcurrency` is checked against |
| `providerLimitCeiling` / `providerModelLimitCeiling` | 128 / 32 | `GRID_PROVIDER_LIMIT_CEILING` / `GRID_PROVIDER_MODEL_LIMIT_CEILING`: model calls in flight fleet-wide, all models together and any one model; where the adaptive limiter starts and what it recovers to |
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
| `vlmModel` / `vlmBaseUrl` | gpt-6-luna / OpenRouter | Vision model |
| **Auth / platform** | | |
| `requireAuth` | `true` | WorkOS AuthKit enforcement |
| **`workosClientId`** / 🔒 `workosApiKey` / 🔒 `workosCookiePassword` | — | WorkOS |
| `platformOwnerEmails` / `platformOrgExternalId` | — / `grid-platform` | Platform tier |
| `disableSelfServeOrgs` | `false` | Tenancy toggle |
| *(feature flags)* | — | No stack keys. Every feature is a WorkOS flag per organization (`frontends/ui/src/lib/authz/feature-flags.ts`), read from the WorkOS environment `requireAuth` signs in against. The retired keys `enforceFeatureFlags`, `skillsEnabled`, `collaborationEnabled`, `mailImportEnabled`, `agentAuthoredDocumentsEnabled`, `ifcModelsEnabled` and `memoryReflectionEnabled` are ignored |
| `auditLogsEnabled` | `false` | WorkOS audit-log emission from the frontend (`GRID_AUDIT_LOGS_ENABLED`) — default OFF |
| `byokSecretBackend` / 🔒 `byokLocalKek` | — | BYOK backends |
| `allowAgentOrgMemory` | `false` | Org-memory write path |
| 🔒 **`gridInternalApiToken`** / 🔒 **`gridAdminToken`** | — | Cross-service tokens |
| **Agent Skills & Jobs** (the `skills` flag decides whether they exist) | | |
| `skillMinIntervalMinutes` | `15` | Floor on how often a job may be scheduled to fire |
| **Storage alerts** (ADR-0042) | | |
| `storageAlertsEnabled` | `true` | Creates the hourly `storage-alerts` CronJob, which calls `POST /api/internal/storage/alerts`. Default-**on**: the quota already refuses the upload that crosses it, so without the alert the first person to learn about the limit is whoever breaks mid-task. An org with no quota is skipped, so on a deployment that sets none the sweep emits nothing |
| `storageAlertThresholdPercent` | `80` | Share of quota at which an organization is warned. Reaches the frontend as `GRID_STORAGE_ALERT_THRESHOLD_PERCENT`. Escalation at 90% and 100% is automatic. **Rejected at load time** if outside `(0, 100]` — the BFF would clamp it back to 80, which is right at runtime and wrong at deploy time, where somebody is present to read the error |
| `storageAlertSchedule` | `0 * * * *` | 5-field cron for the sweep. Hourly because the condition changes on the timescale of an ingest and a live alert suppresses re-emission, so a shorter period costs queries without telling anyone anything new |
| **Vector maintenance** | | |
| `vectorReconcileEnabled` | `true` | Creates the `vector-reconcile` CronJob, which calls `POST /api/internal/maintenance/reconcile-vectors`: the same sweep a platform owner can start from Platform → Vector maintenance — delete indexed chunks whose document row is gone, forget inventory (summary) rows whose chunks are gone. Default-**on**: the orphans it recovers are invisible in the product, so nobody knows to start the manual run |
| `vectorReconcileSchedule` | `0 3 * * 0` | 5-field cron for the sweep. Weekly, Sunday 03:00 UTC: every collection is scanned each tick and the store is only written to when a past delete left something behind, so a tighter period costs scans without recovering anything sooner |
| **Observability** (ADR-0029) | | |
| `observabilityEnabled` | `true` | Feature flag for the OTel Collector. Deployed when the flag is on **AND** something consumes it: Langfuse, `posthogLogsEnabled` or `posthogMetricsEnabled`. With no consumer `preview` warns and nothing is provisioned, including the producers' OTLP env. The Aspire dashboard and err2issue it used to feed are retired; their keys (`otelPrimaryApiKey`, `otelDomain`, `dashboardImage`, `dashboardMaxLogCount`, `dashboardMaxTraceCount`, and every `err2issue*` and `feedbackIssues*` key) are ignored and can be deleted from the stack file |
| **`otelOidcIssuer`** | — | Issuer of the platform WorkOS **Connect** application (the environment's AuthKit domain, `https://<tenant>.authkit.app`). Read by Langfuse alone now, which is deployed only when all three `otelOidc*` keys are set |
| **`otelOidcClientId`** | — | Client id of that Connect application (confidential client) |
| 🔒 `otelOidcClientSecret` | — | Its client secret. The Gateway SecurityPolicy exchanges the code with `client_secret_basic`, so a public/PKCE-only client cannot be used |
| `collectorImage` | digest-pinned `otel/opentelemetry-collector-contrib@sha256:…` (0.163.2) | OTel Collector image (single OTLP ingestion point); override only for a deliberate upgrade |
| **Langfuse** (ADR-0044) — durable LLM observability, self-hosted **free/OSS** build. No licence key is set anywhere; the visible cost is that data-retention policies are an Enterprise feature, so trace data never expires and `clickhouseStorageSize` is a number to watch (the server's own system logs self-clean after 14 days). Full operator guide: [`docs/deployment/kubernetes.md` §9b](../../docs/deployment/kubernetes.md) | | |
| `langfuseEnabled` | `true` | Feature flag. Deployed only when the flag is on **AND** every 🔒 key below is set **AND** `observabilityEnabled` is not `false` **AND** the `otelOidc*` Connect application is set (its UI signs in against it) — Langfuse has no receiver of its own, the collector feeds it, and Langfuse is what brings the collector up on a stack with no dashboard. Otherwise `preview` warns naming what is missing and nothing is provisioned (no workloads, no `https-langfuse` listener, no collector exporter, no identity attributes). Default-**on**, so setting the 🔒 keys is all a stack needs; set the flag to `false` to opt out of four workloads and a PVC that grows |
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
| `langfuseDefaultRole` | `VIEWER` | Role a NEW Langfuse user gets in `langfuseOrgId` / `langfuseProjectId` on first SSO sign-in (`LANGFUSE_DEFAULT_ORG_ROLE` and `_PROJECT_ROLE`). `OWNER`, `ADMIN`, `MEMBER`, `VIEWER` or `NONE`, refused at load time otherwise, because Langfuse refuses to start on an unknown one. `NONE` joins the org with no access and no project. Applied only when an account is created or first linked, so a promotion made in the Langfuse UI is never reverted. See kubernetes.md §9b, "Giving analysts read-only access" |
| `langfuseWebImage` / `langfuseWorkerImage` | digest-pinned `ghcr.io/langfuse/langfuse{,-worker}@sha256:…` (4.68.0) | Two keys because upstream publishes two images — but they **must be the same version**, and digests are opaque so nothing can check it. Bump together. Both are scanned by the trivy `image-scan` job |
| `clickhouseImage` | digest-pinned `clickhouse/clickhouse-server@sha256:…` (26.8 LTS) | Single-node analytical store. Langfuse v4 needs 25.12 or newer. `CLICKHOUSE_CLUSTER_ENABLED=false` makes the migrator emit plain `MergeTree`, so growing to a real cluster is a migration, not a replica count |
| `clickhouseStorageSize` | `50Gi` | The trace store is the tier's unbounded resource — see the retention note above. The server's own system logs are TTL-bounded at 14 days (`system-log-ttl.xml` in `src/data/clickhouse.ts`) and cannot fill the disk the way `system.trace_log` did on dev in August 2026. Growing the PVC is a PVC patch (`volumeClaimTemplates` is immutable and `ignoreChanges`d) |
| `langfuseV4HistoricBackfill` | `false` | Rewrite historic traces into v4's tables. Needs about three times the current ClickHouse disk as headroom |
| `langfuseQueueMaxmemory` / `langfuseQueueMemoryLimit` | `512mb` / `1Gi` | Ingestion-queue dataset cap and pod memory limit. Eviction is OFF, so "full" means ingestion stops (loudly) rather than oldest-drops (silently) |

## Validation (no target cluster required)

```bash
npm run typecheck   # tsc: every typed manifest, incl. Gateway/Envoy CRD specs,
                    # the launch-gate tool, and the Email Worker against
                    # @cloudflare/workers-types (tsconfig.worker.json)
npm run validate    # pulumi preview → schema-check every CustomResource in the
                    # plan against the real upstream CRD schemas (CNPG + KEDA)
npm run policy      # pulumi preview --policy-pack ./policy → CrossGuard
                    # guardrails (rollout safety, resource bounds, pull policy)
```

`validate` and `policy` need a selected stack (its config feeds the plan) but
work even when the kubeconfig points at an unreachable cluster. The deploy
workflow runs all three as its gates before the apply; the apply itself is a
plain `up` on the same runner, so the policy pack does **not** re-run there —
the gate preview is the policy checkpoint (accepted residual, see
`docs/deployment/pulumi-cloud-feature-audit.md`).

### Project mail's launch gates

`scripts/inbound-mail-smoke.ts` runs the launch gates G1–G9 of project mail
against a deployed stack, after the promote that set `inboundMailDomain`
with `inboundMailPaused: true` and before the unpause, and again after any
bump of the Worker's `COMPATIBILITY_DATE` (G8). It never writes to
Cloudflare and sends nothing without `--run`; its header lists the
environment it reads. Never point it at a customer office's address: the
probes are held mail in the test office.

```bash
bun scripts/inbound-mail-smoke.ts plan                # every gate's steps
bun scripts/inbound-mail-smoke.ts cloudflare          # G7, routing, catch-all, Worker settings (read-only)
bun scripts/inbound-mail-smoke.ts signed --run        # G3 at the BFF and the edge
bun scripts/inbound-mail-smoke.ts signed --run --expect-paused   # G4, while paused
bun scripts/inbound-mail-smoke.ts malware --run       # G6: EICAR and a limit-exceeding archive
bun scripts/inbound-mail-smoke.ts dkim-share ./export # G9, offline, over .eml / .mbox
```

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
                         inbound-mail (Email Routing's catch-all + the Email
                         Worker, inbound-mail-worker.js, uploaded verbatim),
                         email-routing (the mail zone + apex MX guard),
                         metrics-server, scheduling (PDB/spread), rollout
                         (update strategy, drain, secret checksum)
policy/                  CrossGuard policy pack (own package.json + bun.lock)
src/data/                postgres (CNPG), dragonfly, seaweedfs, qdrant
src/app/                 config (Secret + env), migrations Job,
                         audit-schemas Job, chroma-migration Job,
                         backend, frontend (+HPA),
                         workers, httproutes
scripts/                 deploy.yml's helpers: GHCR tag lookup, the staging
                         image resolver + downgrade guard (reads the
                         `deployedImages` output), CR schema validation,
                         and inbound-mail-smoke.ts (project mail's launch
                         gates G1–G9, below)
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
  must not block a release — and since agent-authored documents shipped that is
  a deliberate trade rather than a free choice: `document.generated` uses the
  throwing emitter, so a rejected event unfiles the document instead of losing a
  line. The window and the reasoning are in the Job's own header; the compose
  stacks make the opposite call. See `docs/deployment/workos-provisioning.md` §5.
- **SeaweedFS** ships two topologies (`seaweedfsTopology`, ADR-0043). A new
  stack defaults to `split` — separate master, volume and filer workloads, so
  capacity is a replica count. Both stack templates pin `single`, the
  single-process topology every deployment ran before ADR-0043, because moving
  an existing stack across is a data migration: the two use different PVCs, so
  a flip without the runbook starts an empty cluster and reports healthy.
