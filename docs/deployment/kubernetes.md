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
| `aiq-agent` (agent web tier) | **StatefulSet** | 1 (dask) / N (db, default 2) | none (no PVC; ADR-0082 step A2) | dask mode: vertically (singleton). db mode (both shipped templates): horizontally + PDB/spread — §6.4; with `chatAffinity: false` a KEDA ScaledObject on running turns, `backendReplicas`→`backendMaxReplicas` (§6.4b; prod stays at 1) |
| `frontend` (Next.js + BFF + WS gateway) | Deployment + HPA | `frontendMinReplicas`→`frontendMaxReplicas` (default 2→6; prod and dev 1→3) | — | Horizontally (CPU HPA) |
| `agent-worker` (research, `jobExecution: db`) | Deployment + KEDA ScaledObject | `agentWorkerMinReplicas`→`agentWorkerMaxReplicas` (default 1→8; prod 1→3, dev 0→3) | — | Horizontally, on `research_job_queue` depth (§6.3) |
| `ingest-worker` (ingestion, `jobExecution: db`) | Deployment + KEDA ScaledObject | `ingestWorkerMinReplicas`→`ingestWorkerMaxReplicas` (default 1→5; prod 1→5, dev 0→3) | — | Horizontally, on `ingest_job_queue` depth; the ceiling is held to the provider budget (§6.3b, §6.3d) |
| `bff-jobs` (the BFF's background pool: reindex, rescan, IFC, rendition, report filing; no Service, no route) | Deployment + KEDA ScaledObject | `bffJobsMinReplicas`→`bffJobsMaxReplicas` (default 1→4; prod 1→4, dev 0→2) | — | Horizontally, on `bff_job_queue` depth (§6.3c) |
| KEDA (`keda` namespace) | Helm release, chart pinned to the release the plan's CRDs are validated against | 1 operator | — | n/a; what it may read and reach is §6.3d |
| `purger` | Deployment | 1 | — | n/a (SKIP LOCKED-safe) |
| `skill-scheduler` | Deployment (always; fires schedules only when `skillsEnabled`, drives the run reconciler either way) | 1 | — | n/a (DB-claimed ticks) |
| `postgres` (`aiq_jobs`, `aiq_checkpoints`, `grid_app`) | CloudNativePG `Cluster` | 1 (→3 HA) | RWO PVC | Add replicas |
| `dragonfly` (Redis-proto cache) | Deployment | 1 | — (cache) | — |
| `gotenberg` (office → PDF, ADR-0070; required to index Word, presentation, `.xls` and `.ods` files, ADR-0071; `gotenbergEnabled`, default on) | Deployment | `gotenbergReplicas` (sized to the `bff-jobs` pool's conversion ceiling, prod 2; §6.3c) | — | n/a (stateless. A conversion it drops fails that ingest retryably, so a rollout drains for up to 120s) |
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

A fourth login, `grid_keda_scaler`, is declared the same way and is not an
application role: it is what KEDA's `postgresql` scaler counts the queue tables
with, SELECT on the `status` column of three tables and nothing else, with no
`BYPASSRLS` (§6.3d). Its
password is `pgScalerPassword`, or derived from `pgAppPassword` when unset.

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
  tag; a service that was not rebuilt gets the newest develop commit's tag that
  GHCR actually has, and a resolved image older than the deployed one fails the
  deploy — see [cd.md](cd.md#partial-deploys-per-service-images). The kubelet pulls **anonymously**: if the GHCR packages are *private*, set
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
  single pod (Postgres, SeaweedFS, Chroma), so this is a non-issue; just don't add an RWX volume expecting
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

**Size worker groups against the autoscaler ceilings.** The cluster autoscaler
only adds nodes within a worker group's min/max. In prod the ceilings are
frontend 3 (HPA) + agent-worker 3 + ingest-worker 8 + bff-jobs 4 (KEDA), plus
the chat tier's `backendMaxReplicas` (1 while affinity is on, §6.4b) and the
fixed tiers; the defaults for a stack that sets none are frontend 6, agent-worker
8, ingest-worker 8, bff-jobs 4 and web 4. If the sum of limits at those ceilings
exceeds the group's max capacity, the extra pods sit Pending forever. Check it
against the group product when sizing, and again whenever a `…MaxReplicas` is
raised: the ingest tier's is also bounded by the provider budget (§6.3d).

**Cluster-autoscaler scales on *unschedulable pods*, not utilisation.** Its
documented prerequisites — an HPA as the first scaling tier, `requests`/`limits`
on every container, and `topologySpreadConstraints` — are all met: HPAs on
`frontend` and `web` (CPU), the KEDA-driven queue tiers (`agent-worker`,
`ingest-worker`, `bff-jobs`, and the chat tier when it autoscales), requests
**and** limits on every workload, and the spread constraints above. So a burst first scales pods, and only if pods go Pending does
a node get added.

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

1. `kubectl -n envoy-gateway-system get svc` → note the Envoy proxy LoadBalancer
   external IP, and pin it as `grid-oib:loadBalancerIp`.
2. Publish DNS `A` records for `app.<baseDomain>` and `s3.<baseDomain>` (and
   `otel.<baseDomain>` when observability is on) plus the `baseDomain` apex
   itself, pointing at that IP. `appDomain`/`s3Domain`/`otelDomain` exist only
   as optional per-host overrides — `grid-oib:baseDomain` is the single key a
   domain move touches.

   With `grid-oib:dnsEnabled` this is not a manual step: `src/platform/dns.ts`
   derives the record set from the same config the Gateway listeners are built
   from and writes it to Cloudflare, so a host can never have a listener without
   a record or the reverse. See § Public DNS below.
3. Leave `useStagingIssuer: true` until the ingress is reachable and a staging
   cert issues (avoids Let's Encrypt rate limits); then set it `false` and
   `pulumi up` for a trusted cert.
4. Verify: `kubectl -n grid get pods,pvc,httproute,gateway,cluster`.

The base OIB corpus is **not** shipped in the image or from git. Load it through
the platform-admin upload UI once the stack is up: the PDFs are stored in
SeaweedFS, listed in a table in the knowledge database, and ingested into Chroma
by the base-corpus housekeeping CronJob (every ten minutes; an upload also queues
its own ingestion at once).

---

## 3b. Public DNS (`grid-oib:dnsEnabled`)

Off by default. A stack whose records are maintained by hand deploys exactly as
it always did; nothing below is required.

What it removes is step 2 above — the one whose failure mode is not a failure.
A forgotten or mistyped record leaves a perfectly healthy cluster that nobody
can reach, and a cert-manager HTTP-01 challenge that never solves because the CA
cannot resolve the name it is validating. Neither shows up in
`kubectl get pods`.

`src/platform/dns.ts` derives its record set from the same config
`src/platform/gateway.ts` builds its HTTPS listeners from, so the two cannot
drift: every listener has an A record, and no A record points at a host with no
listener (`otel.` appears only when the observability tier is deployed, and
`langfuse.` only when that tier is — §9b).

### Cloudflare operates the zone; the registrar does not change

The domain stays registered wherever it is — only its `NS` records move. For
GoDaddy specifically this is not one option among several: their Domains API is
gated behind 10+ domains or a Discount Domain Club membership, and below that
bar every DNS call returns `403 ACCESS_DENIED`, so the zone cannot be driven
from code at all while they serve it.

### Configuration

| Key | Notes |
|---|---|
| `dnsEnabled` | Master switch. Everything else is unread while false |
| `dnsZoneId` | Cloudflare zone → Overview → API section |
| `dnsZoneName` | The zone **apex** (`piloti.at`), which need not equal `baseDomain` — a stack may live on a subdomain of its zone |
| 🔒 `cloudflareApiToken` | Scoped to that one zone: `Zone:DNS:Edit`, plus `Zone:Dynamic URL Redirects:Edit` on the `dnsZoneBaseline` stack |
| `dnsTtl` | Default 600s |
| `dnsZoneBaseline` | Whether this stack owns the zone-level records (`www`, `_dmarc`, the apex). **At most one stack**, and required on the stack that serves the apex |
| `dnsDmarc` | Value of the `_dmarc` TXT record, when the baseline is owned here |
| `dnsApexRedirectTo` | Absolute URL the apex and `www` redirect to, for the window before any stack serves the apex |

`loadBalancerIp` must be pinned. An unpinned address is assigned by the provider
and can change under a Gateway re-creation; records written from it would be
wrong from that moment, with nothing in this program in a position to notice.

### Records are not proxied

Every host record is created "grey cloud" (`proxied: false`), deliberately.
Three separate things break behind Cloudflare's proxy and all three break
quietly:

- cert-manager solves ACME HTTP-01 through the Gateway. Proxying terminates TLS
  at Cloudflare with its own certificate, so the Gateway's certificate stops
  renewing and nothing says so until it expires.
- `s3Domain` carries browser uploads via presigned URLs. The free plan caps a
  request body at 100 MB; past that the upload dies at the edge, in no log this
  repo collects.
- The app tier is WebSocket-heavy (ADR-0028 pins a conversation to its owning
  replica). Proxied WebSockets work, but acquire an idle timeout the Gateway's
  own configuration no longer governs.

Enabling the proxy is a real option; it just has to be taken together with a
DNS-01 issuer and a paid upload limit.

### The apex, and the one-owner rule

Zone-level records have no stack of their own. `dnsZoneBaseline` names the stack
that owns them, and `loadConfig` refuses the combinations that would produce two
owners — because Cloudflare will not. Two stacks writing the same record is not
an API error; the later `pulumi up` overwrites the earlier one and reports
success.

`dnsApexRedirectTo` is scaffolding for the window in which no stack serves the
apex yet. It creates a proxied A record on `192.0.2.1` (RFC 5737 TEST-NET-1,
guaranteed unroutable) and a dynamic-redirect ruleset; a redirect rule only runs
on proxied traffic, and no packet is ever forwarded to the address, so a *real*
IP there would be a trap — it would silently become a traffic destination the
day the rule is removed. The redirect is a **302**: it disappears as soon as a
stack claims the apex, and a cached 301 would keep bouncing visitors off the
real site with no server-side way to undo it.

When a stack's `baseDomain` *is* the zone apex, that stack publishes a real A
record for it, `dnsApexRedirectTo` must be unset, and the stack must own the
baseline — `loadConfig` refuses anything else. `www` is not a Gateway listener,
so the owning stack keeps it proxied and redirects it to the apex with a 301
(path and query kept).

Moving the baseline between stacks is two deploys, in order: the old owner
drops `dnsZoneBaseline` and `dnsApexRedirectTo` and deploys first, deleting its
`www`, `_dmarc`, placeholder and ruleset; only then does the new owner deploy
and create its own. Reversed, the new owner's `www` CNAME and redirect
ruleset collide with records that still exist, and its deploy fails on them.
`stack-files.spec.ts` checks the committed stack files against each other,
because `loadConfig` sees one stack at a time.

### Cutover order

The delegation moves last, so the new operator is already serving the right
answers when it takes over:

**The delegation moves LAST, and this program writes the zone FIRST.** That
order is what makes the cutover verifiable instead of hopeful — Cloudflare
answers queries on a zone's assigned nameservers as soon as it holds records,
long before any registrar points at them, so the new zone can be interrogated
directly while the old operator is still authoritative.

1. `dig` the live zone for every record type — `A AAAA MX TXT CNAME SRV CAA` at
   the apex, plus `_dmarc` and any DKIM selector. The current operator's web UI
   truncates long values and the Cloudflare dashboard's auto-scan misses records
   it cannot guess the name of; neither is a substitute for asking DNS.
2. Add the zone in Cloudflare, then **delete every record its auto-scan
   imported**. Whatever this program manages it must be the sole creator of:
   Cloudflare permits two A records with the same name and round-robins between
   them, so an imported record plus a created one is not an error, it is an
   intermittently wrong answer.
3. Set `dnsZoneId` / `dnsZoneName` / `cloudflareApiToken` — the token **before**
   anything that could trigger a deploy, since `loadConfig` throws without it
   once `dnsEnabled` is set, and on a CI-deployed stack that turns a merge into
   a failed deploy.
4. `dnsEnabled: true`, then `pulumi up`. Nothing goes live: the registrar still
   delegates elsewhere.
5. Verify against Cloudflare directly, bypassing the delegation —
   `dig @<assigned-cloudflare-ns> <host>` for every host. This is the step that
   makes the cutover safe, and it has no equivalent in the other ordering.
6. Point the nameservers at Cloudflare at the registrar, having lowered any TTL
   still at an hour and waited out the *old* value first.
7. Re-verify without the `@` override once `dig NS <zone>` shows Cloudflare.

Abandonable up to step 6: everything before it is invisible to the internet, and
reverting is deleting a Cloudflare zone nobody is pointed at.

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

1. **Verify the backup is real.** `seaweedfsBackupEnabled: true`, and a LOGICAL
   inventory of the offsite bucket accounts for every current object. "The pod is
   running" is not evidence — `filer.backup` has no initial full-copy phase.

   Not an object count. The sink is `is_incremental`, so it keeps historical
   copies and never propagates deletions, and the nightly `fs.meta.save` dump
   lands in the same bucket — so the offsite count is EXPECTED to exceed the
   source, and can match it by coincidence while current keys are missing.
   Compare current `(key, size)` pairs, newest date directory winning, and
   exclude the snapshot prefix:

   ```shell
   # Source: every bucket the ledger records, not just grid-documents.
   for b in $(psql -At -d grid_app -c \
     "SELECT DISTINCT coalesce(storage_bucket, 'grid-documents') FROM documents"); do
     aws --endpoint-url http://seaweedfs:8333 s3api list-objects-v2 --bucket "$b" \
       --query 'Contents[].[Key,Size]' --output text | sed "s|^|$b/|"
   done | sort > /tmp/source.inventory

   # Offsite: the mirror lays objects out as <date>/buckets/<bucket>/<key>.
   # Strip the date so the newest copy of each key wins, and drop the snapshots.
   aws --endpoint-url https://s3.example.com s3api list-objects-v2 \
     --bucket grid-documents-backup --query 'Contents[].[Key,Size]' --output text \
     | grep -v '\.meta$' \
     | sed -E 's|^[0-9]{4}-[0-9]{2}-[0-9]{2}/buckets/||' \
     | sort -u > /tmp/offsite.inventory

   # Anything present in the source and absent offsite is a gap.
   comm -23 /tmp/source.inventory /tmp/offsite.inventory
   ```

   Empty output is the pass condition. Anything listed is an object the mirror
   does not have, which means the change log was incomplete when the mirror
   started — see ADR-0042's risk note.

   **If no offsite mirror is configured yet.** This is the ordinary situation for
   a first migration: `filer.backup` has no initial full-copy phase, so a mirror
   turned on today does not contain yesterday's objects and cannot be verified
   against them however long you wait. Enabling it first does not solve step 1;
   it only moves the unverified window. So the migration can proceed without it,
   with the safety net named explicitly rather than assumed:

   - **The old PVC is the backup.** The `single` topology's claim is not deleted
     by the switch — it is left unmounted. Confirm that before starting, and
     confirm nothing will reclaim it:

     ```shell
     kubectl -n grid get pvc -o custom-columns=\
     'NAME:.metadata.name,SIZE:.spec.resources.requests.storage,SC:.spec.storageClassName'
     kubectl -n grid get pv -o custom-columns=\
     'NAME:.metadata.name,CLAIM:.spec.claimRef.name,POLICY:.spec.persistentVolumeReclaimPolicy'
     ```

     Any volume backing the SeaweedFS claim must read `Retain`, not `Delete`. If
     it reads `Delete`, patch it before touching the topology — a `Delete` policy
     turns the rollback path into permanent loss the moment the claim is
     released:

     ```shell
     kubectl patch pv <name> -p \
       '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
     ```

     Keep `grid-oib:protectDataResources: true` set for the same reason.

   - **Rollback is the flip back.** Because the claim survives, returning
     `seaweedfsTopology` to `single` and re-applying restores the previous object
     store. That is the whole recovery plan, and it is only true while the claim
     exists — which is why the check above is not optional.

   - **Copy the metadata dump off-cluster anyway.** Step 2's `fs.meta.save`
     output is small and is the only thing that makes the namespace
     reconstructible if both claims are lost. `kubectl cp` it somewhere that is
     not this cluster before step 3, even without a mirror to put it in.

   - **Take the local inventory regardless.** Run the source half of the
     comparison above and keep `/tmp/source.inventory`. Without an offsite side
     to compare against it is not a pass condition, but after step 5 it is the
     only way to answer "did everything arrive?" with something other than a
     count.

   Enable the mirror after the migration, once there is a stable topology for it
   to run against, and treat its first verification as a separate exercise.

2. **Take a metadata snapshot and keep it off-cluster.**
   ```
   kubectl -n grid exec deploy/seaweedfs-backup -- \
     sh -c 'echo "fs.meta.save -o /tmp/pre-split.meta /" | weed shell -master=seaweedfs:9333'
   kubectl -n grid cp seaweedfs-backup-<pod>:/tmp/pre-split.meta ./pre-split.meta
   ```
   This is the only artefact that makes a botched migration reversible. Check it
   is non-empty; `weed shell` exits 0 even when the command inside it failed.

3. **Stop writes.** Scale the frontend, purger and agent-worker to zero.

4. **Record the object inventory of EVERY bucket**, so step 7 has something to
   check against. With per-organization buckets enabled the set is not
   `grid-documents` alone, and it is not derivable from the org id either — the
   ledger is what knows (ADR-0043):

   ```shell
   BUCKETS=$(psql -At -d grid_app -c \
     "SELECT DISTINCT coalesce(storage_bucket, 'grid-documents') FROM documents")

   for b in $BUCKETS; do
     aws --endpoint-url http://seaweedfs:8333 s3api list-objects-v2 --bucket "$b" \
       --query 'Contents[].[Key,Size]' --output text | sed "s|^|$b/|"
   done | sort > /tmp/pre-split.inventory

   wc -l /tmp/pre-split.inventory
   ```

   Keep the file, not just the number: step 7 compares contents, because a count
   can match while the contents differ.

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

7. **Compare the inventory** against step 4 — the file, not the number:

   ```shell
   for b in $BUCKETS; do
     aws --endpoint-url http://seaweedfs:8333 s3api list-objects-v2 --bucket "$b" \
       --query 'Contents[].[Key,Size]' --output text | sed "s|^|$b/|"
   done | sort > /tmp/post-split.inventory

   diff /tmp/pre-split.inventory /tmp/post-split.inventory
   ```

   No output is the pass condition. Not "the sync finished", and not a matching
   count: two inventories of the same length can differ in which keys they hold.

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
written and nothing else, and disabling it again is equally uneventful — which
holds only because two things are deliberately NOT gated on the flag: the S3
grants (`Read:grid-org-*` and friends are always issued, so a rollback does not
revoke access to what was written while it was on) and the erasure sweep (which
always visits both buckets, so a rollback cannot silently leave a tenant's
objects behind). An organization keeps objects in both buckets indefinitely;
that is the design, not a loose end.

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
  so they spread across worker nodes. Both routes below follow the current
  primary through a failover.
- **Two routes to the primary (ADR-0083).** `grid-pg-pooler-rw` is a CloudNativePG
  `Pooler` running PgBouncer in **transaction** mode, and `grid-pg-rw` is the
  primary itself. Every DSN picks one (`via: "pooler" | "direct"`, no default in
  `data/postgres.ts`). Pooled: `NAT_JOB_STORE_DB_URL`, `AIQ_CHECKPOINT_DB`,
  `AIQ_DEEP_CHECKPOINT_DB`, `AIQ_SUMMARY_DB` and `GRID_APP_DATABASE_URL`. Direct:
  `AIQ_LISTEN_DB_URL` (LISTEN/NOTIFY), `AIQ_LOCK_DB_URL` (session advisory
  locks), `GRID_APP_MIGRATION_DATABASE_URL`, the KEDA scaler DSNs, the init and
  grants Jobs, Langfuse and the SeaweedFS filer. Anything that needs the same
  server connection across statements must be direct: through the pooler a
  session lock leaks and a LISTEN hears nothing, with no error. Transaction
  locks (`pg_advisory_xact_lock`) and `FOR UPDATE SKIP LOCKED` are fine pooled.
- **Pooler sizing.** `pgPoolerInstances` (default 2; dev 1) PgBouncers, spread
  across nodes with a PodDisruptionBudget when there is more than one, each
  opening at most `pgPoolerPoolSize` (default 12) server connections per
  (database, role) pair. The plan refuses a stack whose pooler worst case plus
  the direct reserve passes `max_connections` (200): `assertPgConnectionBudget`
  prints every part. Prod is 74 pooled + 82 direct = 156; a fresh stack with
  everything on is 196. Clients past the pool wait in PgBouncer instead of
  failing, so saturation shows as waiting clients rather than errors:
  PgBouncer's `SHOW POOLS` reports them as `cl_waiting`, and a value above 0 for
  long means raise `pgPoolerPoolSize` (and the budget with it). The image is
  CloudNativePG's PgBouncer, pinned by tag and digest and scanned by the
  `image-scan` job.
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

- **Document backups (ADR-0042) — IMPLEMENTED, opt-in.** Every bucket under
  `/buckets` is backed up in two layers — `grid-documents` and, when
  per-organization buckets are on, each `grid-org-*` — because `filer.backup`
  runs with `-filerPath=/buckets` and mirrors the whole subtree. Both layers
  default to `false`, because both need an **external** S3 target to mean
  anything:

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
  > a LOGICAL inventory against the source** — see § 4 step 1 for the commands. A
  > raw object count will not do it: the sink is `is_incremental` and the nightly
  > metadata dump lands in the same bucket, so the offsite count is expected to
  > exceed the source and can match it by coincidence while current keys are
  > missing. A running pod is not evidence either.

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
     recreate **every** bucket, then sync each one back **through the new
     cluster's S3 API**, oldest date directory first so later versions win.

     Every bucket, not `grid-documents`: with per-organization buckets enabled
     the tenant objects live in `grid-org-*` buckets, and the mirror already
     covers them (`filer.backup` runs with `-filerPath=/buckets`, so it mirrors
     the whole subtree and the layout is `<date>/buckets/<bucket>/…`). What is
     easy to miss is the RESTORE, because the bucket set is not a constant.

     Take it from the mirror itself rather than from a naming rule — the rule
     depends on the current prefix and hash width, and the mirror knows what is
     actually there.

     **Two endpoints means two commands.** `aws s3 sync` has ONE `--endpoint-url`
     and it applies to both URIs, so `sync s3://mirror/... s3://bucket/` with the
     new cluster's endpoint reads the mirror from the new cluster — where the
     mirror bucket does not exist, or worse, where a same-named bucket does. Every
     object therefore lands via a staging directory: one sync out of the mirror,
     one sync into the cluster. The two also need different credentials, which the
     single-endpoint form cannot express either; below they are two named
     profiles.

     ```shell
     # ~/.aws/config: [profile mirror] → the offsite provider's keys
     #                [profile cluster] → this cluster's admin S3 keys
     MIRROR='aws --profile mirror --endpoint-url https://s3.example.com'
     CLUSTER='aws --profile cluster --endpoint-url http://seaweedfs:8333'
     STAGE=$(mktemp -d)   # sized for ONE bucket-slice, not the whole corpus

     # Every bucket that appears in the mirror.
     BUCKETS=$($MIRROR s3api list-objects-v2 \
       --bucket grid-documents-backup --query 'Contents[].Key' --output text \
       | tr '\t' '\n' | sed -nE 's|^[0-9-]{10}/buckets/([^/]+)/.*|\1|p' | sort -u)

     for b in $BUCKETS; do
       echo "s3.bucket.create -name $b" | weed shell -master=seaweedfs-master:9333
     done
     echo 's3.bucket.list' | weed shell -master=seaweedfs-master:9333   # verify

     # Oldest date directory first, so a later version of a key overwrites an
     # earlier one rather than the reverse.
     for d in $($MIRROR s3 ls s3://grid-documents-backup/ \
                  | awk '{print $2}' | tr -d / | sort); do
       for b in $BUCKETS; do
         # Never --delete on either hop: the mirror is incremental, so a deletion
         # was never propagated to it, and an older date directory legitimately
         # holds keys a newer one does not.
         $MIRROR s3 sync "s3://grid-documents-backup/$d/buckets/$b/" "$STAGE/$b/"
         $CLUSTER s3 sync "$STAGE/$b/" "s3://$b/"
         rm -rf "$STAGE/$b"   # keeps peak disk at one bucket-slice
       done
     done
     rmdir "$STAGE"
     ```

     The staging hop is also the only place to verify the bytes left the mirror
     intact, so if a restore is being done under pressure this is where to spot a
     truncated object rather than after it is already in the cluster.

     If the database survived, cross-check the restored set against the ledger —
     it is the record of which bucket each document's bytes are in, and a bucket
     present in the ledger but absent from the mirror is a gap you want to know
     about before declaring the restore done:
     ```shell
     psql -At -d grid_app -c \
       "SELECT DISTINCT coalesce(storage_bucket, 'grid-documents') FROM documents" \
       | sort > /tmp/ledger.buckets
     comm -23 /tmp/ledger.buckets <(echo "$BUCKETS")
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
  is reclaimed. The claim is fair (below) and KEDA scales the tier on the queue,
  not on CPU. The web tier runs **no Dask** in this mode.
- **Cancellation works from any replica** — the cancel route flips `job_info` to
  INTERRUPTED and drops the queue row; the runner's 1 s `CancellationMonitor`
  honors it. No scheduler is involved.
- **Shared vectors** (Stage A, `chromaEnabled: true`): the shared Chroma server
  means workers and web replicas read/write one store.
- **Citation registry** already shares cross-replica via Dragonfly (ADR-0020).

- **The claim is fair, and a full cluster waits** (ADR-0079). A free worker
  takes the next job of the organisation with the fewest research jobs running
  fleet-wide, then the one served longest ago; inside one office a `bulk` job
  (a scheduled fire) goes after an `interactive` one. `GRID_MAX_ACTIVE_JOBS` is
  no longer a 429 in this mode: a job over capacity waits as `queued`, and a
  scheduled task is not skipped for it. `backendMaxActiveJobsPerOrg` is the
  claim's per-organisation cap (jobs running at once). The one refusal left is
  `backendMaxQueuedJobsPerOrg` (default 50), a bound on how many jobs one
  organisation may have waiting.
- **KEDA scales `agent-worker` on `research_job_queue`**, replacing the CPU HPA,
  which an LLM-bound job barely moves: its `postgresql` trigger counts the rows
  that are not `dead` (a finished job's row is deleted) and asks for
  ceil(jobs / `agentWorkerConcurrency`) replicas between `agentWorkerMinReplicas`
  and `agentWorkerMaxReplicas`. Out at once, in a pod a minute; dev's floor is 0
  and prod's is 1. It reads the queue through `jobs-queue-auth`, the
  TriggerAuthentication it shares with the ingest tier (one database).
- **A drain gives work back.** On SIGTERM the worker waits
  `agentWorkerDrainSeconds` for the jobs it holds, then requeues what still runs
  without spending an attempt; another worker starts it over. A job that crashes
  every worker that takes it is kept as a `dead` row for
  `GRID_RESEARCH_DEAD_RETENTION_DAYS`.

Safe rollout: `jobExecution: dask` (default in code) is byte-for-byte today's
behaviour; flip to `db` per environment. `agentWorkerMinReplicas` /
`agentWorkerMaxReplicas` / `agentWorkerConcurrency` size the worker tier.

### 6.3b Ingestion — a fair queue and a tier KEDA scales on its depth (ADR-0076)

Ingestion used to be two threads per backend process, FIFO across every tenant,
lost on restart. Now, with `jobExecution: db`:

- **`/v1/ingest` jobs go into `ingest_job_queue`** (Postgres, beside the status
  rows). A free worker claims the next job of the organisation with the fewest
  jobs running fleet-wide, then the one served longest ago: one office's
  reindex no longer queues everyone else; inside one office a job's
  `priority` (`interactive`, the default, or `bulk`) orders the claim. Claims
  heartbeat and are taken again when a worker dies, up to three times, and then
  kept as a `dead` row with a reason (ADR-0079). A worker that must exit hands
  its claims back without spending an attempt; so does a web-tier replica that
  claims (no ingest-worker tier), which stops claiming before it waits for its
  chat turns and gives back what it still holds after.
- **A dedicated `ingest-worker` tier** (same image, `GRID_ROLE=ingest-worker`,
  no port, no PVC) claims them. The web tier stops claiming
  (`GRID_INGEST_QUEUE_CLAIM=false`) while the tier runs, so a PDF's parse no
  longer shares the chat pods' CPU.
- **KEDA scales it on the queue**, not on CPU (a job mostly waits on the
  provider): its `postgresql` trigger counts the table's rows that are not
  `dead` and asks for
  ceil(jobs / `ingestWorkerConcurrency`) replicas between
  `ingestWorkerMinReplicas` and `ingestWorkerMaxReplicas`. Out at once, in a pod
  a minute; dev's floor is 0. Pulumi installs KEDA (`installKeda`, default on)
  and a NetworkPolicy letting it reach Postgres.
- **The provider sees a fixed ceiling.** `AIQ_VLM_FLEET_CONCURRENCY`
  (`vlmFleetConcurrency`, 32) vision calls in flight fleet-wide, a Dragonfly
  lease pool; more workers queue on it instead of multiplying 429s on the shared
  OpenRouter key. A vision call also holds a slot in its model's own limiter pool
  (`providerModelLimitCeiling`, 32), so the fleet pool is held to that too.

Sizing: at `ingestWorkerMaxReplicas` the tier asks for max × the ingest-worker
limits; make the worker group's max hold that (below), or the extra replicas
sit Pending and add nothing. The ceiling is also bounded from the other side:
`ingestWorkerMaxReplicas` × `ingestWorkerConcurrency` × `vlmBatchWorkers` is the
tier's peak of vision calls, and the program fails the deploy when that is more
than twice `vlmFleetConcurrency` (§6.3d). Prod's 5 × 3 × 4 is 60, within 2 × 32 = 64.

### 6.3c BFF background jobs — a pool of frontend-image pods on `bff_job_queue` (ADR-0079)

A project reindex and "Rescan failed ingestions" used to walk up to ten
thousand documents inside one HTTP request on a frontend pod: a request that
died half way left no record of which half. Both are now jobs:

- **The request enqueues and answers 202.** `POST /api/projects/{id}/reindex`
  and `POST /api/organization/documents/reingest-failed` check access, insert
  one `bff_job_queue` row (app database, migration 0104) in the organisation's
  lane, and return `{ jobId }`. A second click returns the open job. The UI
  says the work started; each document's own status is where it reports.
- **A job is a sequence of slices.** A slice is one page of 25 documents,
  re-dispatched to `/v1/ingest` with `priority: "bulk"` (so an upload in the
  same organisation is claimed first); the job saves its place (a keyset
  cursor and the counts) after every slice, so whichever worker claims it next
  resumes there.
- **The `bff-jobs` Deployment runs them.** The frontend image, command
  `node workers/jobs/index.js`: one container that supervises the BFF and a
  claim loop. The loop claims fairly across organisations (fewest running
  first, fleet-wide; then the lane served longest ago; inside a lane
  interactive before bulk, then oldest), heartbeats, and POSTs each slice to
  its own pod's `/api/internal/jobs/run`. **There is no Service and no
  HTTPRoute**, and the work runs here, never on the pods that proxy chat.
- **A drain never costs an attempt; a failure always does.** On SIGTERM the loop stops claiming, lets
  the slice in hand finish (`bffJobsDrainSeconds`, 60), gives every claim back
  without spending an attempt, and only then stops the BFF; the pod's grace
  period is the drain plus 30 s. A claim that lost its worker is taken again
  after `GRID_BFF_JOBS_STALE_SECONDS`. Every other end of an attempt spends
  it (a handler that threw, a slice past `GRID_BFF_JOBS_SLICE_TIMEOUT_MS`, a BFF
  that answered 5xx or not at all) and the job waits `GRID_BFF_JOBS_RETRY_BACKOFF_SECONDS`,
  doubling, before the next, so a job that always times out or kills the BFF
  ends. After `GRID_BFF_JOBS_MAX_ATTEMPTS` the row is marked `dead` with its
  reason in `last_error` and its payload (a report, the requester, storage keys)
  reduced to ids; it is deleted `GRID_BFF_JOBS_DEAD_RETENTION_DAYS` later, or at
  once with its project. The BFF queue has no `grid.queue.*` meters yet (ADR-0079):
  watch it through the depth KEDA reads and the `[bff-jobs] … now dead` ERROR lines.
- **KEDA scales it on the queue.** A `postgresql` trigger (its own
  TriggerAuthentication, on the app database) counts the rows whose status is
  not `dead` and asks for ceil(jobs / `bffJobsConcurrency`) replicas between
  `bffJobsMinReplicas` and `bffJobsMaxReplicas` (prod 1 to 4, dev 0 to 2).
  Out at once, in a pod a minute. The scaler connects as `grid_keda_scaler`, a
  read-only login that sees every lane of the row-level secured queue through a
  policy of its own (§6.3d).

**Three more kinds run here, as one step each** (ADR-0079; they run as the
system, because the person's permission was checked when the work was
requested):

| Kind | Replaces | Priority | The row it keeps true |
|---|---|---|---|
| `bim_extract` | the detached IFC parse in the upload's pod | `interactive` for an upload, `bulk` inside a reindex | `documents.status` (`processing`, then `pending` or `failed`) and the `bim_models` row. A restart no longer strands the model at `extracting` |
| `office_rendition` | the detached conversion behind a per-process queue | same | `documents.status`, as above |
| `file_research_report` | rendering the PDF inside the research outcome callback and the report GET | `interactive` | `task_runs.filing_status`: `queued`, then `filed`, `refused` or `failed` |

- **A row names its job.** A document at `processing` remembers
  `metadata.bffJobId`. A step that throws is retried by the queue; on the last
  attempt it writes `failed` on the row first, so nothing stays `processing` or
  `queued` after the queue gave up. A step whose failure a retry would not
  change (a converter that refuses the file, a requester who may no longer
  file) says so on the row and finishes.
- **A sweep recovers what predates the jobs.** The scheduler worker calls
  `POST /api/internal/maintenance/reconcile-background-work` on every tick: a
  document at `processing` for 15 minutes with no live job gets a new `bulk`
  one, a document whose job is dead is failed with its reason, and a report
  filing `queued` for 15 minutes whose job is gone ends as `filed` (the report
  is there after all) or `failed`. A row whose job is queued or running is left
  alone however long it waits.
- **Gotenberg's capacity is a ceiling on the pool.** Conversions are claimed
  from the queue, so the fleet-wide bound is arithmetic:
  `bffJobsMaxReplicas` times `bffJobsRenditionConcurrency` (the pod's
  `GOTENBERG_MAX_CONCURRENCY`, 1) must not exceed two conversions per Gotenberg
  replica (`gotenbergReplicas`, which defaults to what the pool needs; prod 2).
  `gotenberg.spec.ts` asserts it for both stack files, so raising the pool
  without the converter fails `task infra:test`. The pod's memory limit is 2Gi
  because an IFC model is parsed here, up to several times its own size.
  A reader opening a preview still converts from a frontend pod, under that
  pod's own `GOTENBERG_MAX_CONCURRENCY` and outside this ceiling: the ceiling
  bounds the jobs, not the readers.

Debugging a stuck job:

```sql
-- as the schema owner; RLS does not apply to it
SELECT job_id, kind, lane, status, attempts, claimed_by, heartbeat_at, last_error
FROM bff_job_queue ORDER BY created_at;
```

A `dead` row is a job that failed every attempt: `last_error` says why. Fix
the cause, then delete the row and run the action again from the UI.

### 6.3d KEDA across every ScaledObject (ADR-0079)

Four tiers are scaled by KEDA: `ingest-worker`, `agent-worker` and `bff-jobs` on
their queues, `aiq-agent` on running turns. What they share is one module
(`deploy/pulumi/src/app/keda-scaling.ts`), so they cannot drift apart in the
parts that are not about their own signal, and `keda-scaling.spec.ts` holds it.

- **The chart is pinned.** `KEDA_CHART_VERSION` (`src/platform/keda.ts`, 2.21.0)
  is the Helm chart's version, which is KEDA's own, and the release whose CRDs
  `scripts/validate-crs.mjs` checks the plan against; the script reads the same
  constant. Upgrading KEDA is changing it, after reading the release notes for
  `fallback` and the `postgresql` scaler.
- **A trigger KEDA cannot read has a `fallback`.** Three failed polls (45 s) hold
  the tier at a third of its ceiling, never below its floor or one replica
  (`currentReplicasIfHigher`: a tier already above that keeps its pods rather than
  being scaled in under the jobs it runs). Without it a dead scaler leaves a tier
  at whatever count it had while its queue grows. The one exception is the chat
  tier: KEDA refuses `fallback` beside a `cpu` trigger, so a trigger it cannot
  read makes the HPA hold the current count there, which a tier that holds live
  sockets should do anyway.
- **`cooldownPeriod` is one step.** It is how long after the last active trigger a
  tier is held before it goes from 1 replica to 0, so it does nothing where the
  floor is 1 (prod). Every step from N down to 1 is the HPA's `scaleDown`: a pod a
  minute after a five-minute stabilisation window, because each pod that leaves
  drains for up to its tier's budget.
- **The scaler cannot write.** KEDA reads the queues as `grid_keda_scaler`
  (declared with the other roles on the Cluster, `data/postgres.ts`), a login with
  nothing but `LOGIN` whose rights are SELECT on the `status` column (the one its
  `COUNT(*) … WHERE status <> 'dead'` reads, so a leaked DSN cannot read a
  payload) of `ingest_job_queue` and `research_job_queue` in `aiq_jobs` and of
  `bff_job_queue` in `grid_app`. That last table is secured per organisation, so the role reads it through a policy of
  its own (`FOR SELECT TO grid_keda_scaler`), not through `BYPASSRLS`. Its password
  is `pgScalerPassword`, or an HMAC of `pgAppPassword` when unset, and its DSNs sit
  in the `grid-keda-scaler` Secret, which no pod references: rotating it restarts
  nothing. Before this, the operator held the owner's DSN for both databases.
- **The tables exist before the scaler reads them.** On a fresh stack the Python
  queues create their tables the first time a process touches them, which can be
  after the ScaledObject is created. The `keda-scaler-grants` Job runs after the
  migrations and every ScaledObject waits for it: an init container calls the
  queues' own `ensure_table` (the one definition of their schema, which also
  upgrades an older table), then `psql` waits for the role CloudNativePG reconciles
  and runs the grants. A missing table fails the Job loudly; it never reaches a
  scaler that errors on every poll. It re-runs whenever its spec changes (every
  per-SHA image pin) and is idempotent.
- **A drain is given time to give back.** The grace period of `ingest-worker`,
  `agent-worker` and `bff-jobs` is the tier's `…DrainSeconds` plus 30 s
  (`DRAIN_GIVE_BACK_SECONDS`, `agentWorkerRollout`), so the claims a drain did not
  finish are released without an attempt before the kubelet's SIGKILL.
- **The ingest ceiling is held to the provider budget.** `vlmFleetConcurrency`,
  `vlmBatchWorkers`, `providerLimitCeiling` and `providerModelLimitCeiling` are
  stack config (and reach the pods as `AIQ_VLM_FLEET_CONCURRENCY`,
  `AIQ_VLM_BATCH_WORKERS`, `GRID_PROVIDER_LIMIT_CEILING`,
  `GRID_PROVIDER_MODEL_LIMIT_CEILING`). `assertVlmPeakFitsCeiling` fails the plan
  when `ingestWorkerMaxReplicas` × `ingestWorkerConcurrency` × `vlmBatchWorkers`
  is more than twice `vlmFleetConcurrency`, or when the vision pool is larger
  than the key-wide limit or than the vision model's own limit
  (`providerModelLimitCeiling`: every vision call holds a slot in both pools, so
  a pool above either never fills). Replicas beyond that only wait for a slot. Prod went
  from 12 to 8 replicas for it (144 → 96 against a pool of 48), then to 5 (60
  against a pool of 32) when the vision model's own pool, which the 48 never
  cleared, was counted: the replicas it lost could not have run a vision call a
  slot existed for. Raise the model limit and the pool together, and the
  provider's own limit with them, before the replicas.
- **KEDA reaches exactly its triggers' targets.** Two NetworkPolicies admit the
  KEDA **operator** pod (the metrics server and the webhooks in `keda` poll
  nothing): Postgres on 5432 when any queue tier runs, and the backend on 8000
  when the chat tier autoscales. Nothing else in `grid` is open to the `keda`
  namespace.

- **The scaler login is a direct connection.** KEDA's DSNs name
  `grid-pg-rw.<namespace>.svc.cluster.local`, not the pooler (§5, ADR-0083), and
  the role's `connectionLimit` (8, `KEDA_SCALER_CONNECTION_LIMIT`) is counted in
  the budget's direct reserve.

Debugging a tier that does not scale: `kubectl describe scaledobject <tier>`
(its conditions say whether the trigger is readable and whether `fallback` is
active), `kubectl -n keda logs deploy/keda-operator` (a refused login or a
missing table is named there), and `kubectl -n grid logs job/keda-scaler-grants`.

### 6.4 Multi-replica chat/web tier — IMPLEMENTED (`jobExecution: db`)

In `db` mode the `aiq-agent` web tier now runs `backendReplicas` replicas
(default 2). The chat/retrieval path is replica-safe:

- **Vectors** are shared (Chroma server, §6.3); **job/checkpoint state** is in
  Postgres; **caches + citation registry** are in Dragonfly.
- **Ingestion status is persisted** to a shared `ingest_jobs` table
  (`src/aiq_agent/knowledge/ingest_status_store.py`), so a
  `GET /v1/documents/{job_id}/status` poll resolves from any replica instead of
  404-ing on the replica that didn't accept the upload. The job itself runs
  on the accepting replica, which stamps itself as the row's `owner` and
  refreshes `heartbeat_at` every 30 s; when that replica restarts, its live
  rows are read as `failed` (reason `interrupted`, retryable) once the
  heartbeat is two minutes old, rather than as in progress forever.
- **The knowledge TTL-cleanup thread is single-runner**: it
  (`knowledge/base.py` via `knowledge/leader_lock.py`) elects one runner per
  cycle with a Postgres advisory lock, so N replicas don't race
  `delete_collection` against the shared store.
- **The ghost-job reaper, the job-event cleanup and the chat checkpoint reaper
  are not in the web replicas at all**: they run only as the `housekeeping-*`
  CronJobs, each a call to a one-cycle backend route (ADR-0082 step A1).

It stays a StatefulSet, with no PVC: chat affinity hashes a conversation onto a
pod ordinal (ADR-0028, ADR-0080), which needs the stable per-pod DNS and ordinals
only a StatefulSet gives. It becomes a Deployment when the chat tier stops
depending on that routing (ADR-0082).

**The backend keeps no files (ADR-0082 step A2).** The base corpus is objects in
SeaweedFS (`base-corpus/<file name>` in `SEAWEED_BUCKET`) plus one table,
`oib_corpus_files`, in the knowledge database; the vectors are in the shared
Chroma server, which is required (`chromaEnabled: false` fails the plan: an
embedded store would be wiped at every restart). What a replica holds on disk is
a cache of corpus files in `/tmp/base-corpus`, filled on demand and free to
vanish, so every replica lists, serves, exports and re-ingests the same corpus
and an upload is no longer lost to the replica that received it. What is
not yet indexed becomes a job on the durable ingest queue, queued by an upload or
by the `housekeeping-base-corpus` CronJob and run by the ingest-worker tier (the web
pods claim where that tier does not run); there is no thread at boot and no
ingestion in the web process. See [`oib-sync.md`](../technical-reference/oib-sync.md).

**Rolling this out on a cluster that has the PVC.** The StatefulSet loses its
`volumeClaimTemplates`, an immutable field, so the first `pulumi up` plans a
**replace** of `aiq-agent` (delete-before-replace: a short outage of the chat
tier). The old `data-aiq-agent-*` claims are retained by Kubernetes and nothing
uses them; delete them once the new pods are healthy. The files on them are not
carried over: base-corpus PDFs uploaded before this release must be uploaded
again in the admin UI (the release note says so).

### 6.4b Chat scale-out: affinity off, KEDA on running turns (ADR-0080)

By default (`chatAffinity: true`) nothing in §6.4 changes: the gateway hashes the
conversation id onto a replica (`BACKEND_REPLICAS`, `BACKEND_POD_WS_TEMPLATE`),
so the count is part of the routing and stays at `backendReplicas`. Setting
`grid-oib:chatAffinity: "false"` (it needs `conversationBus`, which is on) lets
the tier autoscale:

- **Routing.** The gateway sends every socket to the `aiq-agent` Service
  (`GRID_CHAT_AFFINITY=0` on the frontend). A socket on any replica is a relay
  for the conversation's Dragonfly stream; the replica that receives a question
  runs that turn and publishes its frames. A running turn never moves.
- **One running turn per conversation.** A newer question stops the stale one,
  takes `conv:<id>:running`, and only then runs (`GRID_CHAT_RUNNING_TTL_SECONDS`,
  `GRID_CHAT_SUPERSEDE_WAIT_SECONDS`). If the stale turn has not stopped in time,
  the question is refused with a retry hint; with Dragonfly down and affinity off
  it is refused too, because nothing else can say no.
- **The owner fences itself.** A turn that cannot renew its marker (Dragonfly
  unreachable from its replica for most of `GRID_CHAT_RUNNING_TTL_SECONDS`, or the
  marker gone) stops writing the conversation's thread, its frames and its
  persisted outcome on a local deadline, and ends cancelled, before a newer turn
  on another replica can take the marker. A failed renewal is retried every
  second, and the renewal is never refused by the bus's fail-fast window, so one
  slow command does not cost a turn its window. The cost is that a Dragonfly
  outage longer than the TTL minus 6 s (6 s at the default 12) ends the answers
  running at that moment; with affinity on nothing is fenced, because one process holds
  both turns.
- **The signal.** `GET /v1/internal/chat-occupancy` on any replica returns the
  fleet's running turns (`activeTurns`, the global admission pool). KEDA's
  `metrics-api` trigger holds `backendTurnsPerReplica` of them per replica
  (AverageValue), and a `cpu` trigger at `backendCpuTargetPercent` sits beside it
  for work that is not a turn. The route is internal-token only (a
  `TriggerAuthentication` reads `GRID_INTERNAL_API_TOKEN` from `grid-secrets`),
  a NetworkPolicy lets the KEDA operator pod reach port 8000 of the backend pods,
  and an unreadable count is a 503, which makes the HPA hold the current count.
- **Floor and ceiling.** `backendReplicas` is the floor and `backendMaxReplicas`
  (default 3) the ceiling. The ScaledObject exists only with `jobExecution: db`,
  affinity off and a ceiling above the floor, and then owns `spec.replicas`
  (`ignoreChanges`). Prod keeps affinity on and `backendMaxReplicas: 1` until the
  cross-replica path (reconnect, clarifier round trip, Stop, supersede, a
  replica draining mid-turn) has been run on dev with the flag off and two
  replicas: the unit tests use an in-memory bus and fakeredis, not Dragonfly.
- **Slow in, a pod at a time.** Scale-out adds one pod a minute (a StatefulSet
  rolls its pods in order, and each boots for minutes); scale-in waits 15
  minutes and removes one pod per 5, and Kubernetes removes the **highest
  ordinal**, not the idlest.
- **Drain.** On SIGTERM the pod has already left the Service endpoints. It
  waits up to `GRID_CHAT_DRAIN_SECONDS` (`backendDrainSeconds`) for the turns it
  runs, cancelling what is left, while relays on other replicas keep streaming
  them. The grace period is that plus the endpoint wait and slack, so every
  rolling update also waits for the longest running turn, one pod at a time
  (about 46 minutes per pod at the default `backendDrainSeconds` of 2730, and
  only while a turn is running; the Pulumi update timeout allows for it). With
  affinity on the default is 20 s (the 90 s grace the tier has always had): a
  StatefulSet starts the replacement only after the old pod is gone, so a
  singleton serves nobody while it drains. With affinity off, other replicas
  serve meanwhile, but a floor of one replica still has that gap when a turn is
  running at a rollout: keep `backendReplicas` at 2 or more if that matters.

What lives on a replica, and what that means for scale-in: the in-process socket
registry, the clarifier future and the running LangGraph task belong to a turn
that is running, and the drain waits for it. An idle conversation has none of
them, and its checkpoints are in Postgres, so the next question on any replica
picks it up. A replica holds no files that matter: the corpus is in SeaweedFS and
a table, and its cache of corpus files is rebuilt on demand, so no replica's
disappearance makes a document unreachable. Chat reads the cache only through
`view_knowledge_image`, which fetches a missing PDF on demand.

### 6.5 Frontend tier — what actually bounds it

The `frontend` Deployment (Next.js UI + BFF + WS gateway, one Node process per
pod) is stateless and HPA-scaled on CPU, `frontendMinReplicas`→`frontendMaxReplicas`
(default 2→6; prod and dev set 1→3). Two things determine
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
this cluster serves `metrics.k8s.io` (metrics-server) and, since ADR-0076,
KEDA's `external.metrics.k8s.io` — but no Prometheus adapter, so there is no
`Pods`-type metric for connections or loop lag yet; one would report
`<unknown>` and never scale. KEDA can now carry such a trigger once the gauge is
emitted somewhere it can read; see §10.

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
  The exception is `gotenberg` (`gotenberg-frontend-only`): it parses untrusted
  office files that can link external URLs, needs no network of its own, and so
  gets ingress from the frontend and the `bff-jobs` pool alone (the pool is the
  same BFF running the background conversions) and no egress at all, DNS
  included.
  With `networkPolicies` off that policy is gone; Gotenberg's
  `--libreoffice-deny-private-ips` and `--libreoffice-deny-public-ips` flags
  still refuse every URL LibreOffice would fetch.
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
- **Edge compression, landing site only.** `grid-web-timeouts` (the web
  route's `BackendTrafficPolicy`) carries `compressor: [Brotli, Gzip]`, Brotli
  winning the tie when a browser weighs both equally. Envoy's default
  content-type list applies, so HTML, CSS, JS, JSON, SVG and text are
  compressed and WebP and WOFF2 pass through. `compressor` is the Envoy Gateway
  v1.6+ field (`compression` is its deprecated predecessor); `gateway-helm` is
  unpinned, and an older controller prunes the unknown field without an error,
  so check the live site rather than the plan:
  `curl -sI -H 'Accept-Encoding: br, gzip' https://<webDomain>/ | grep -i content-encoding`
  must print `br`. The app route has no compressor on purpose: it streams chat
  through the BFF, and nobody has measured what a compressor does to that
  stream. The S3 route serves presigned PDFs and images, which do not shrink.
- **Static caching is the web image's job, not Envoy's.** The container runs
  `frontends/web/runtime/server.mjs`, which sets `Cache-Control` on files that
  exist: `/_astro/*` `public, max-age=31536000, immutable`, `/fonts/*` and
  `/art/*` `public, max-age=604800, stale-while-revalidate=86400`, HTML left at
  `public, max-age=0` with an ETag so every view revalidates. An HTTPRoute
  `ResponseHeaderModifier` would stamp the same header on a 404, and during a
  surge rollout a new page can request an asset from an old pod that does not
  have it yet. The Deployment sets no `command`; the image's `CMD` is the one
  place the entry file is named.

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
is now that budget, and the pod's grace period is that plus 30 s to give back
what is still running (it is requeued without costing an attempt, and another
worker starts it over). The cost is deploy latency: workers roll one at a time
and a draining pod holds its slot for up to the full budget, so `pulumi up` on
this tier can take (drain × replicas) in the worst case. That is the trade being
made deliberately — lower it only if repeating in-flight research is preferable
to waiting.

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
replay non-idempotent BFF POSTs (chat sends, ingest, skill mutations); plain
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
of the chat socket used to allow 3 attempts, i.e. it surrendered ~4–7 seconds
after the drop and put "Unable to connect to the server" in front of every open
chat on every deploy. It is now sized to outlast a roll of both tiers
(`frontends/ui/src/adapters/api/turn-socket.ts`: 12 attempts ≈ 2–4 min,
jittered), and the reopened socket re-attaches a running turn from its last
`seq`. Anything longer than that is a genuinely wedged rollout and should still
surface as an error.

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
  Only purger and skill-scheduler use `Recreate`, and both were already on it.

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
  encrypted (see below), then "at rest" for Postgres, SeaweedFS and Chroma all
  bottom out at the same unencrypted disk.

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
| Frontend and `bff-jobs` → Gotenberg | **No, and unauthenticated** | `http://gotenberg:3000`. It carries the bytes of every office file converted, and anyone who can reach it can have LibreOffice parse a file of their choosing. NetworkPolicy admits the frontend and the `bff-jobs` pool only. |
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
is previewed with the same image pins the apply deploys, resolved **per
service** by `deploy/pulumi/scripts/resolve-image-refs.sh`: services the
triggering Publish Images run built get the commit's `sha-<40-hex>` tag, the
rest the newest develop commit's tag that GHCR has, and a resolved image older
than the stack output `deployedImages` fails the job
([cd.md](cd.md#partial-deploys-per-service-images)). The
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
logger) and the Node tiers (grid-ui, skill-scheduler, purger) via the
`frontends/ui/observability/otel-logs.js` console bridge. Metrics: nothing
emits them yet; that requires explicit meters.
- **`aspire-dashboard`** (`deploy/pulumi/src/platform/observability.ts`) — a
  .NET Aspire standalone dashboard behind the collector, as a live
  trace/span viewer for platform owners.

```text
grid-ui / grid-aiq-agent / grid-agent-worker / grid-skill-scheduler / grid-purger
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
`grid-aiq-agent` / `grid-agent-worker`). Skill-scheduler and purger emit
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

## 9b. Langfuse — durable LLM observability (ADR-0044)

Section 9's dashboard is a live pane over an in-memory ring buffer. This is the
store that outlives a restart: sessions, users, per-model cost, prompt
management, datasets and evals, over history you can query.

**It is the free, self-hosted OSS build.** No licence key is set anywhere. The
one consequence that shows up operationally is at the end of this section.

**Gating (flag AND capability):** deployed only when
`grid-oib:langfuseEnabled` is on — default **`true`**, as in section 9 — and
every credential below is set **and** the observability tier of section 9 is
itself deployed. Langfuse has no receiver of its own here; the collector is what
feeds it, so without section 9 it is four workloads that can only sit idle. Miss
anything and `pulumi preview` warns naming it and skips the tier entirely: no
workloads, no `https-langfuse` listener or certificate, no collector exporter,
and no identity attributes on any span.

### What it deploys

| Workload | Notes |
|---|---|
| `langfuse-web` | UI + public API + the OTLP receiver. Runs the migrations; single replica for that reason. |
| `langfuse-worker` | Drains the ingestion queue into ClickHouse. Migrations disabled; ordered behind the web tier. |
| `clickhouse` | **New stateful technology.** Single node, its own PVC. Langfuse v3 has no Postgres-only mode. |
| `dragonfly-langfuse` | A THIRD Redis-protocol instance. Eviction is OFF — an evicted queue entry is a trace that silently never arrives. |

Reusing what already exists: a `langfuse` database and `langfuse_app` role on the
CNPG cluster, and one `langfuse` bucket on SeaweedFS reached by a dedicated
`grid-langfuse` S3 identity scoped to that bucket alone.

### DNS

Nothing to do by hand on a stack with `dnsEnabled` (§3b): `langfuse.<baseDomain>`
is derived from the Gateway's `https-langfuse` listener like every other host, so
enabling this tier publishes its A record in the same `pulumi up`. The
whole-program test asserts that pairing rather than trusting it
(`index-dns.spec.ts`).

On a stack that still maintains records by hand, add
`langfuse.<baseDomain>` → the Envoy Gateway external IP **before** enabling the
tier. Not doing so is the quiet failure §3b describes: everything deploys
healthy, cert-manager's HTTP-01 challenge never solves because the CA cannot
resolve the name, and the host simply never serves.

### One-time WorkOS setup

Langfuse reuses **the same Connect application** as the Aspire dashboard (§9) —
do not create a second one. Add **both** of these redirect URIs to it:

```text
https://langfuse.<baseDomain>/oauth2/callback          # Envoy's OIDC callback
https://langfuse.<baseDomain>/api/auth/callback/custom # Langfuse's own SSO (NextAuth)
```

Both are required, and the second is the one that is easy to skip. Being behind
Envoy's completed session does not exempt it: WorkOS validates `redirect_uri`
against the application's allowlist on every authorization request, and the
docs are explicit — *"Without a valid redirect URI, your users will be unable
to sign in."* Omit it and the edge gate passes, then Langfuse's SSO button dies
at `/oauth2/authorize`, leaving only the break-glass password account working.
That reads as "SSO is broken" rather than "a URI is missing".

Access requires the `platform:organizations:view` permission, enforced at the
edge exactly as in §9. Langfuse's own SSO alone would admit anyone who can sign
in to the WorkOS environment at all — the narrowing is the Envoy SecurityPolicy,
so do not remove it on the grounds that "Langfuse has its own login".

### Configuration

```bash
# TWO of these are HEX, not base64, and both for reasons that bite at runtime
# rather than at config time:
#
#   langfuseEncryptionKey      must be exactly 64 hex chars (a 256-bit key);
#                              a 44-char base64 value crash-loops the web
#                              container without naming the variable.
#   langfuseClickhousePassword must be URL-safe. Langfuse's ClickHouse migrator
#                              interpolates it into a connection-string query
#                              parameter with no encoding, and base64 always
#                              ends in `=` and often contains `+`.
#
# `loadConfig` rejects both at preview time, so a mistake here is a message,
# not a CrashLoopBackOff.
pulumi config set --secret grid-oib:langfuseEncryptionKey      "$(openssl rand -hex 32)"
pulumi config set --secret grid-oib:langfuseClickhousePassword "$(openssl rand -hex 32)"

# The rest are ordinary base64 secrets — nothing interpolates them unencoded.
for k in langfuseSalt langfuseNextAuthSecret langfuseDbPassword \
         langfuseQueuePassword langfuseS3SecretKey langfuseInitUserPassword; do
  pulumi config set --secret "grid-oib:$k" "$(openssl rand -base64 32)"
done

# Project API keys. The prefixes are validated by Langfuse, not decorative.
pulumi config set --secret grid-oib:langfusePublicKey "pk-lf-$(openssl rand -hex 16)"
pulumi config set --secret grid-oib:langfuseSecretKey "sk-lf-$(openssl rand -hex 16)"

pulumi config set grid-oib:langfuseInitUserEmail ops@example.com

# The flag defaults to true, so the credentials above are what actually turns
# the tier on. Set it explicitly only to opt OUT:
#   pulumi config set grid-oib:langfuseEnabled false
```

`loadConfig` refuses, at preview time rather than at runtime:

- an encryption key that is not exactly 64 hex characters;
- a ClickHouse password containing anything outside `A-Za-z0-9._~-`, because
  the migrator interpolates it into a query string unencoded;
- an API key without its `pk-lf-` / `sk-lf-` prefix;
- `langfuseQueuePassword` equal to `dragonflyPassword` or
  `rateLimitStorePassword` — every app pod holds the cache URL, and a shared
  password would let anything that reads one pod's env drain the ingestion
  queue;
- `langfuseS3SecretKey` equal to any other SeaweedFS secret — SeaweedFS
  authenticates by key, so sharing one grants this tier that identity's bucket
  scope instead of its own.

NetworkPolicies are required. There is no separate check for it here: the tier
depends on §9, whose guard already refuses `networkPolicies=false`.

### Traps worth knowing before the first deploy

- **Web and worker images must be the same Langfuse version.** They are two
  config keys because upstream publishes two images; digests are opaque, so
  nothing can verify it for you. Both defaults are pinned from the same tag
  (4.54.0). Bump them together.
- **ClickHouse must run UTC.** On any other server timezone Langfuse's queries
  return empty or shifted results — a dashboard reporting "no data" for a system
  that is plainly running. `TZ=UTC` is pinned on the container; do not override.
- **`CLICKHOUSE_CLUSTER_ENABLED=false` is a schema decision.** It makes the
  migrator emit plain `MergeTree` rather than `Replicated*`. Moving to a real
  ClickHouse cluster later is a migration, not a replica-count change.
- **First boot is slow.** The web tier runs Postgres and ClickHouse migrations
  before it listens; its startup probe allows ten minutes. A pod killed mid-way
  restarts the migration from the top.
- **The ingestion keys are seeded, not minted.** Headless initialization creates
  the org, project and API keys from config on first boot, which is what lets
  the collector hold a working credential in the same `pulumi up`. Rotating
  `langfuseSalt` invalidates every stored API key, including that one.

### Upgrading to Langfuse v4

The defaults moved from 3.225.11 to **4.48.0**, because no 3.x release fixes
the `next/og` remote code execution in Next 16.2.11 (GHSA-vcvr-r3jv-pc5j). v4
changes the ClickHouse data model, so the upgrade is upstream's three-stage
migration ([guide](https://langfuse.com/self-hosting/upgrade/upgrade-guides/upgrade-v3-to-v4)),
and the first stage runs on the next `npm run up`.

What the program already does:

- **ClickHouse goes to 26.8 LTS first.** v4 needs 25.12 or newer, and v3 runs on
  it unchanged. The Langfuse Deployments depend on the ClickHouse Service, which
  depends on the StatefulSet, so one `up` finishes the ClickHouse roll before the
  v4 pods start. 26.8 adds one always-written system log,
  `background_schedule_pool_log`, which gets the same 14-day TTL as the rest.
- **The ClickHouse login needs no new grants.** The image creates it without a
  `<grants>` list, which in ClickHouse means every privilege, so the extra
  grants v4 asks for are already held.
- **Writes go to both data models** (`langfuseV4WriteMode: dual`): v3's tables,
  which keep the rollback path open, and v4's events table. The collector sends
  `x-langfuse-ingestion-version: 4`, so its spans reach v4 at once rather than
  through the ~15-minute server-side propagation. Users may opt into the v4
  views. Historic traces are **not** rewritten (`langfuseV4HistoricBackfill:
  false`), because upstream asks for about three times the current ClickHouse
  disk as headroom.

What you do before that `up`. None of it can be undone after v4's schema
migrations run, short of a restore:

1. **Back up both stores**: the `langfuse` Postgres database (a CNPG backup)
   and the ClickHouse PVC (a volume snapshot).
2. **Confirm v3 finished its background migrations.** In the `langfuse`
   database, this must return no rows:
   `SELECT name, failed_at, failed_reason FROM background_migrations WHERE finished_at IS NULL;`
3. After the `up`, check that v4's propagation is healthy:
   `kubectl exec deploy/langfuse-worker -- wget -qO- 'localhost:3030/api/health?failIfEventPropagationStuck=true'`
   answers 200, not 503.

**The cutover is a later, one-way config change.** Once the v4 views hold what
you need (new traces at once, history only if you turn the backfill on and have
the disk), set `langfuseV4WriteMode: events_only` and `up`. From then on v3's
tables are no longer written and the legacy public APIs (`/api/public/traces`,
`/observations`, `/sessions`, `/scores`, `/metrics`) answer 404. Nothing in
this repo reads them: traces arrive over OTLP, and the Python SDK only reads
prompts. Rollback before the cutover is upstream's `migrate … goto 37` from the
v4 web container, then the v3 digests. After it, only the backups.

### Signals and attribution

Only **traces** go to Langfuse. Logs and metrics still go to the Aspire
dashboard alone (and ERROR logs to err2issue, ADR-0031). The collector adds one
exporter to the *existing* traces pipeline, so both consumers get every span.

Consequence to know: the two exporters share the pipeline's `memory_limiter`, so
a Langfuse outage long enough to fill its bounded sending queue (2000 batches)
will cost the dashboard spans too. Neither is in a request path.

When the tier is on, the agent tiers get `GRID_TRACE_IDENTITY_ATTRIBUTES=true`,
which stamps `langfuse.user.id`, `langfuse.session.id` and the organization onto
every span. Without it Langfuse receives traces that are anonymous — technically
working, and missing most of the point. It is deliberately keyed off *this* tier
rather than §9: attaching a user id to telemetry makes traces attributable to
named individuals, and an Aspire-only deployment gets none of it.

Session grouping and input/output capture need no configuration — NAT already
emits `session.id` and OpenInference `input.value`/`output.value`, both of which
Langfuse maps natively.

### When Langfuse shows nothing — diagnose from the far end

A turn touches four layers before it becomes a Langfuse row: the NAT exporters
in the agent tier, the collector, `langfuse-web`'s OTLP receiver, and the
BullMQ queue that drains into ClickHouse. Diagnose from the far end backwards,
because a break at any one of them looks identical in the UI: an empty project.
The producer is almost never the culprit — the agent tiers emit spans for every
run unconditionally, and their exporter logs `Started exporter
'otelcollector_redaction'` per turn either way, which proves nothing about
delivery.

The ingestion-tier failure seen on 2026-08-24 had this signature. The queue
Redis (`dragonfly-langfuse`) was missing
`--default_lua_flags=allow-undeclared-keys`, so every BullMQ Lua script failed:

```text
ERR script tried accessing undeclared key, key: bull:otel-ingestion-queue:<n>
```

in the `langfuse-web` / `langfuse-worker` logs, which made the OTLP receiver
answer **HTTP 500**, which made the collector log `Exporting failed. Dropping
data.` for `otlp_http/langfuse` and silently discard every trace batch. All of
them — frontend included. An observation like "only grid-ui arrives, the Python
tiers produce zero spans" during such a window is a memory of two different
eras, not a producer split: check whether anything arrived *recently* before
chasing the wrong layer. The fix lives in the deployment program
(`allowUndeclaredLuaKeys` on the Langfuse Dragonfly instance); the cache and
counter stores must not get it — only the Langfuse queue runs BullMQ scripts.

A second signature with the same empty UI, seen on dev 2026-09-12: the
ClickHouse PVC at 100% with `system.trace_log` (17 GiB) and `system.text_log`
as the bulk — the server's OWN diagnostic logs, not trace data, which the
stock image ships with no TTL ("by default, table growth is unlimited"). The
worker then logs `Cannot reserve ... not enough space` and drops every batch
(`Max attempts reached, dropped N ... records`), so the project stays on
"Waiting for first trace" with all pods Ready:

```bash
kubectl -n grid exec clickhouse-0 -- df -h /var/lib/clickhouse
kubectl -n grid exec clickhouse-0 -- clickhouse-client --query "SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size FROM system.parts WHERE active GROUP BY table ORDER BY sum(bytes_on_disk) DESC LIMIT 10"
kubectl -n grid logs deploy/langfuse-worker --tail=20  # Cannot reserve ... ?
```

The deployment TTL-bounds every system log table at 14 days
(`system-log-ttl.xml` in `src/data/clickhouse.ts`), so the server's logs
self-clean and only trace data can still fill the disk. A disk that filled
before that change still needs one manual clear, and it is a DROP plus a
restart, not a TRUNCATE: on startup with the new TTLs the server renames
the old tables aside (`trace_log_0`, `text_log_0`, ...) and rebuilds fresh
ones, so the bytes sit in detached tables no TTL will ever drain — and a
bare DROP left `df` unchanged here, because the orphaned objects in
`store/` are only released when the server restarts. So: `DROP TABLE
system.<name>_0` for each renamed table, then delete the pod. Afterwards
the TTLs keep it free.

Two sharp edges found while landing this, kept here so the next one does not
re-learn them:

- `opentelemetry_span_log` is the one system table a standalone `<ttl>` must
  NOT touch: the image defines it with a custom `<engine>`, and `<ttl>` next
  to `<engine>` fails the server at startup with Code 36 (BAD_ARGUMENTS) —
  CrashLoopBackOff with all pods otherwise healthy. It stays unbounded on
  purpose (46 KiB, no producer behind it).
- A crashing ClickHouse logs to FILES (`/var/log/...`, ephemeral), so
  `kubectl logs` ends right after "Logging errors to ..." with no error. To
  see the real message, patch the live ConfigMap with
  `<logger><console>1</console></logger>`, delete the pod, and read the
  crashed container's log. Do not ship that section: it duplicates every log
  line to stdout permanently.

Ground truth is a single ClickHouse query — rows here within seconds of a chat
turn mean every layer works, whatever the UI's dashboard filters claim:

```bash
kubectl -n grid exec clickhouse-0 -- clickhouse-client --user langfuse \
  --query "SELECT environment, type, count(), max(start_time)
           FROM langfuse.observations WHERE start_time > now() - INTERVAL 3 HOUR
           GROUP BY environment, type ORDER BY 3 DESC"
```

Agent turns appear as `CHAIN` rows (the `<workflow>` root, per-agent steps) and
`GENERATION` rows named by model id; token usage rides on each `GENERATION` in
`usage_details`. Each knowledge search adds a `retrieve.knowledge_search`
observation carrying the query, the collections searched, the budgets and the
picked chunk ids/files/scores — metadata only, no chunk text (ADR-0058,
Amendment 2).

The frontend tier exports **no request spans** (ADR-0029, Amendment 5): one
trace per HTTP request — health probes, RSC navigations, BFF POSTs — flooded
the project under the `default` environment, and every fact those spans held
arrives better elsewhere (backend-tier spans, the OTel log bridge). If you see
`grid-ui` SPAN rows under `default`, they predate that amendment; filter them
out or let retention... there is none on the OSS build, so prune by hand.

**Model costs stay $0.00 until the model ids are priced.** Token counts land
regardless, but the self-hosted OSS build ships no price catalog entry for the
OpenRouter slugs (e.g. `openai/gpt-5.6-luna`), so `total_cost` stays NULL and
every cost view reads zero. Add input/output prices per model id under
Settings → Models in the Langfuse UI; that is configuration, not deployment.

### Operating it — the retention problem

**Trace data never expires.** Data-retention policies are an Enterprise feature, so on the
free build the trace store grows for as long as the deployment runs. The server's
own diagnostic logs are the exception: every system log table carries a 14-day TTL
(`system-log-ttl.xml` in `src/data/clickhouse.ts`), so ClickHouse chatter self-cleans
and only observations can still fill the disk.

So treat `grid-oib:clickhouseStorageSize` (default `50Gi`) as a number to watch,
not to set once:

```bash
kubectl -n grid exec -it clickhouse-0 -- df -h /var/lib/clickhouse
```

Growing it is a PVC patch (the `volumeClaimTemplates` is immutable and
`ignoreChanges`d — same procedure as SeaweedFS and Chroma, §4). Pruning is a
manual ClickHouse partition drop. And note the store has **no backup**: Postgres
has PITR (§5) and the raw events are archived in SeaweedFS, but ClickHouse has
neither. Its PVC is `Retain` + `protect`ed, and that is the whole of its
durability story.

### Local development

Compose runs the tier behind an opt-in profile:

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml --profile langfuse up -d
# http://localhost:3100 — sign in with LANGFUSE_INIT_USER_* from deploy/.env
```

There is no ingestion path locally: no collector runs, and the backend's OTLP
exporter is gated off in compose by design (§9, ADR-0029). The profile is for
developing against the Langfuse UI and API, not for reproducing ingestion.

## 10. Out of scope (deliberate follow-ups)

- **Capping the job SSE streams.** Each open stream holds one direct `LISTEN`
  connection for as long as its job runs (§5). The budget reserves 20 for them,
  an allowance: nothing in the code caps the streams, and running jobs are
  bounded only by the research tier (3 in prod) times the viewers each has. If
  the allowance is ever the thing that fails, cap streams per replica rather than
  raising the reserve.
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
  Blocked on the item above, not on app code. KEDA is installed now (ADR-0076,
  for the ingest tier), so the cluster-side provider is decided; what is
  missing is a store KEDA can read the gauge from (Prometheus, or a KEDA
  `metrics-api` endpoint on the frontend). The OTel collector already
  carries a metrics pipeline (§9), so the app-side emission is the small half of
  this; the cluster-side provider is the decision.
