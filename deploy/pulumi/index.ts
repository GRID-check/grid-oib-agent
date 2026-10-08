/**
 * Grid OIB — Kubernetes deployment (Pulumi / TypeScript).
 *
 * Provisions the whole stack against a provider-supplied kubeconfig:
 *   platform  → cert-manager (+ Let's Encrypt issuer), Envoy Gateway, metrics-server
 *   data      → CloudNativePG Postgres (3 DBs), Dragonfly cache, SeaweedFS (S3)
 *   app       → aiq-agent (StatefulSet, the chat role), aiq-api (Deployment +
 *               HPA, the api role), frontend (Deployment + HPA), purger, skill-scheduler, gotenberg (office
 *               → PDF), a migration Job and a WorkOS audit-schema reconcile Job
 *   edge      → Gateway API (Envoy Gateway) + HTTPRoutes with cert-manager TLS,
 *               for the app, the landing site and the public S3 endpoint
 *
 * The agent tier scales VERTICALLY here (resources + admission
 * caps); every precondition for later HORIZONTAL scaling is already wired
 * (Postgres DSNs instead of SQLite, a shared Redis/Dragonfly cache). See
 * docs/deployment/kubernetes.md for the scale-out roadmap.
 */
import * as pulumi from "@pulumi/pulumi";

import { backendAutoscaled, backendImage, frontendImage, loadConfig, webImage } from "./src/config";
import { makeProvider } from "./src/platform/providers";
import { makeAppNamespace } from "./src/platform/namespaces";
import { installCertManager } from "./src/platform/cert-manager";
import { installGatewayController, installGatewayResources } from "./src/platform/gateway";
import { installMetricsServer } from "./src/platform/metrics-server";
import { installNetworkPolicies } from "./src/platform/network-policies";
import { installPostgres, installScheduledBackup, type Postgres } from "./src/data/postgres";
import { installDragonfly, installLangfuseQueue, installRateLimitStore } from "./src/data/dragonfly";
import { installClickHouse } from "./src/data/clickhouse";
import { installSeaweedFS, type SeaweedFS } from "./src/data/seaweedfs";
import { installSeaweedFSBackup } from "./src/data/seaweedfs-backup";
import { installChroma } from "./src/data/chroma";
import { AppWiring, PULL_SECRET_NAME, buildRegistryPullSecret, buildScalerSecret, buildSecrets } from "./src/app/config";
import { runMigrations } from "./src/app/migrations-job";
import { reconcileAuditSchemas } from "./src/app/audit-schemas-job";
import { importLegacyCorpus } from "./src/app/legacy-corpus-import-job";
import { installBackend } from "./src/app/backend";
import { installBackendScaling } from "./src/app/backend-scaling";
import { installApi } from "./src/app/api";
import { installFrontend } from "./src/app/frontend";
import { installWeb } from "./src/app/web";
import { installGotenberg } from "./src/app/gotenberg";
import { installWorkers } from "./src/app/workers";
import { installAgentWorker } from "./src/app/agent-worker";
import { installIngestWorker } from "./src/app/ingest-worker";
import { installJobsQueueAuth } from "./src/app/jobs-queue-auth";
import { installBffJobs } from "./src/app/bff-jobs";
import { installQueueScalerGrants } from "./src/app/queue-scaler-grants";
import { installKeda } from "./src/platform/keda";
import { installHttpRoutes } from "./src/app/httproutes";
import { installObservabilityDashboard } from "./src/platform/observability";
import { installOtelCollector } from "./src/platform/otel-collector";
import { installErr2Issue } from "./src/platform/err2issue";
import { installDns, managedRecordNames } from "./src/platform/dns";
import { installLangfuse } from "./src/platform/langfuse";
import { LANGFUSE } from "./src/constants";

const cfg = loadConfig();
const provider = makeProvider(cfg);

// ── Namespace + platform add-ons ──────────────────────────────────────────
const ns = makeAppNamespace(cfg, provider);
const namespace = ns.metadata.name;

// Default-deny ingress + least-privilege allows for the app namespace.
if (cfg.networkPolicies) {
  installNetworkPolicies(cfg, provider, namespace);
}

// Gateway API edge: install the Envoy Gateway controller (+ Gateway API CRDs)
// FIRST so cert-manager can enable its Gateway integration at startup.
const gatewayController = installGatewayController(cfg, provider);
const certManager = installCertManager(cfg, provider, namespace, [gatewayController]);
if (cfg.ingress.installMetricsServer) {
  installMetricsServer(provider);
}

// ── Data tier ─────────────────────────────────────────────────────────────
//
// The two data stores depend on each other, and which way round depends on the
// SeaweedFS topology:
//
//   - Postgres archives its WAL into a SeaweedFS bucket, so it wants the bucket
//     to exist before the cluster boots.
//   - The SPLIT topology's filer keeps its namespace in a Postgres database, so
//     it cannot start until that database exists.
//
// Run both at once and it is a cycle. It is only a real cycle in one
// configuration, though — split topology with the Postgres filer store — so
// rather than degrade every deployment to the weaker ordering, each branch
// takes the ordering that is actually correct for it.
const extraBuckets = [
  ...(cfg.postgres.backups.enabled ? [cfg.postgres.backups.bucket] : []),
  // Langfuse's event archive + batch exports (ADR-0044). A platform bucket, so
  // the init Job creates it — but withheld from the general-purpose `grid` S3
  // identity in `s3IdentityCatalog`; Langfuse reaches it as `grid-langfuse`.
  ...(cfg.langfuse.enabled ? [LANGFUSE.bucket] : []),
];
const filerNeedsPostgres =
  cfg.seaweedfs.topology === "split" && cfg.seaweedfs.filerStore === "postgres";

let seaweed: SeaweedFS;
let postgres: Postgres;

if (filerNeedsPostgres) {
  // Postgres first: the filer cannot open its store otherwise, and Pulumi would
  // sit waiting for a StatefulSet that is crash-looping on a database this same
  // `up` has not created yet.
  //
  // The cost, and it is a real one: with `pgBackupsEnabled` the cluster now
  // boots BEFORE its WAL archive bucket exists, so the first minutes of a fresh
  // deploy report `ContinuousArchiving: false` with NoSuchBucket. That
  // resolves itself — Postgres retries `archive_command` indefinitely and picks
  // up the moment bucket-init lands, holding the segments in pg_wal until then
  // — but it is visible in `kubectl cnpg status` and should not be mistaken for
  // a broken backup. Gating the cluster on the bucket is exactly what would
  // close the cycle back up.
  postgres = installPostgres(cfg, provider, namespace, []);
  seaweed = installSeaweedFS(
    cfg,
    provider,
    namespace,
    extraBuckets,
    postgres.rwHost,
    postgres.filerStoreDeps,
  );
} else {
  // No cycle: SeaweedFS first, so the cluster only boots once its archive
  // bucket is there.
  seaweed = installSeaweedFS(cfg, provider, namespace, extraBuckets);
  postgres = installPostgres(
    cfg,
    provider,
    namespace,
    cfg.postgres.backups.enabled ? [seaweed.bucketInitJob] : [],
  );
}

// The nightly Postgres base backup, created AFTER the archive bucket exists in
// both branches. `immediate: true` fires one Backup on creation and CNPG does
// not retry a failed one — so a schedule created before bucket-init leaves the
// stack with archived WAL, no base backup, and a status page that says
// archiving is healthy. That is not a recoverable PITR.
installScheduledBackup(cfg, provider, namespace, [postgres.cluster, seaweed.bucketInitJob]);

// Offsite backup for the documents bucket (ADR-0042). Gated on an EXTERNAL S3
// target; `loadConfig` refuses an in-cluster endpoint, which would put the
// backup on the very volumes it exists to survive.
installSeaweedFSBackup(
  cfg,
  provider,
  namespace,
  [seaweed.service, seaweed.bucketInitJob],
  { master: seaweed.masterAddress, filer: seaweed.filerAddress },
);
const dragonfly = installDragonfly(cfg, provider, namespace);
// ClickHouse + the ingestion queue for Langfuse (ADR-0044). Both live in the
// data tier because that is what they are, even though the tier they serve is
// an observability one — the Pulumi module layout follows what a workload IS,
// not who consumes it.
const clickhouse = cfg.langfuse.enabled
  ? installClickHouse(cfg, provider, namespace, [ns])
  : undefined;
const langfuseQueue = cfg.langfuse.enabled
  ? installLangfuseQueue(cfg, provider, namespace)
  : undefined;
// Counter store for edge rate limiting (ADR-0040 L1) — deliberately a SECOND
// instance, never the cache above; `data/dragonfly.ts` explains why. Only the
// rate limit service in `envoy-gateway-system` talks to it, over the allow in
// `platform/network-policies.ts`.
const rateLimitStore = cfg.rateLimit.enabled
  ? installRateLimitStore(cfg, provider, namespace)
  : undefined;
const chroma = installChroma(cfg, provider, namespace);
// Office → PDF converter for the document viewer (ADR-0070). Stateless and
// fail-open, so nothing waits on it; its NetworkPolicies admit the frontend
// alone and deny it every egress.
const gotenberg = cfg.gotenberg.enabled
  ? installGotenberg(cfg, provider, namespace, [ns])
  : undefined;

// ── Shared wiring for the app tier ─────────────────────────────────────────
// Pull Secret for private app images (no-op when none are configured).
const pullSecret = buildRegistryPullSecret(cfg, provider, namespace);
const wiring: AppWiring = {
  cfg,
  namespace,
  provider,
  redisUrl: dragonfly.url,
  seaweedInternalEndpoint: seaweed.internalEndpoint,
  seaweedPublicEndpoint: seaweed.publicEndpoint,
  chromaUrl: chroma.url,
  gotenbergUrl: gotenberg?.url,
  dsn: postgres.dsn,
  imagePullSecrets: pullSecret ? [{ name: PULL_SECRET_NAME }] : [],
};

// The Secret AND the checksum every consumer stamps on its pod template, so a
// rotated credential is a gated rolling update rather than a silent no-op
// (src/platform/rollout.ts).
const secrets = buildSecrets(wiring);

// grid_app DB is created at cluster bootstrap; run drizzle migrations before
// the frontend/workers that read it. The migrations themselves go straight to
// the primary; the pooler is listed so everything ordered after them (the BFF
// tiers, which connect through it) is created after it too (ADR-0083).
const migrations = runMigrations(wiring, cfg, secrets, [
  postgres.cluster,
  postgres.initJob,
  postgres.pooler,
]);

// WorkOS must know every audit action the code emits, or it rejects the events
// and the trail silently thins out (issues #255/#256). Reconciled per deploy so
// the environment follows the code; skipped when auth is off, because then
// there is no WorkOS environment and no key to reconcile against.
if (cfg.auth.requireAuth) {
  reconcileAuditSchemas(wiring, cfg, secrets, [ns]);
}

// ── App workloads ──────────────────────────────────────────────────────────
//
// Rollout order (ADR-0082 step B): the api tier, then the frontend, then the
// chat tier. A frontend from before the split sends every HTTP call to
// `aiq-agent`, and a new `aiq-agent` serves only the chat socket, so the chat
// tier may change only once the frontend that calls `aiq-api` instead has
// rolled out; and that frontend needs `aiq-api` to be there. Pulumi awaits a
// workload's rollout before it creates what depends on it, so the `dependsOn`
// below is the whole mechanism and no operator sequences anything.

// The api role: every backend HTTP route but the chat socket, behind the
// Service BACKEND_URL names.
const api = installApi(wiring, cfg, secrets, [
  postgres.initJob,
  seaweed.bucketInitJob,
  dragonfly.service,
  ...(chroma ? [chroma.service] : []),
]);

// Not after `aiq-agent`: the chat tier waits on the frontend (above), so the
// reverse edge would be a cycle. The old chat pods serve the socket meanwhile.
const frontend = installFrontend(wiring, cfg, secrets, [migrations, api.service]);

const backend = installBackend(wiring, cfg, secrets, [
  postgres.initJob,
  postgres.pooler,
  seaweed.bucketInitJob,
  dragonfly.service,
  ...(chroma ? [chroma.service] : []),
  frontend.deployment,
]);

// The pre-A2 base corpus, carried off the old backend data volume once
// (ADR-0082 A2). Only where that volume exists: see `storage.legacyCorpusClaim`.
if (cfg.storage.legacyCorpusClaim) {
  importLegacyCorpus(wiring, cfg, secrets, cfg.storage.legacyCorpusClaim, [
    backend.statefulSet,
    frontend.deployment,
  ]);
}

const workers = installWorkers(wiring, cfg, secrets, [migrations]);
// Landing site + blog (Astro, frontends/web) — static-first, no app secrets,
// but it pulls from the same registry, so it gets the pull Secret too.
const web = installWeb(cfg, provider, namespace, wiring.imagePullSecrets, [
  ns,
  ...(pullSecret ? [pullSecret] : []),
]);

// KEDA scales the research and ingest workers and the BFF job pool (queue depth,
// ADR-0079/0076) and the chat tier (running turns, ADR-0080).
const keda = cfg.keda.install ? installKeda(provider) : undefined;

// What the read-only scaler login may read, and the queue tables it reads, in
// place before any ScaledObject is created (`app/queue-scaler-grants.ts`): after
// the cluster (the role) and the migrations (`bff_job_queue`).
const scalerGrants = installQueueScalerGrants(wiring, cfg, [postgres.cluster, postgres.initJob, migrations]);

// What KEDA connects with, in a Secret of its own that no pod reads.
const scalerSecret = buildScalerSecret(wiring);

// How KEDA reads the two Python claim queues, which share one database. Created
// once for both tiers. After the grants: on a stack that already runs, the
// existing ScaledObjects start reading through the scaler login the moment this
// points at it, and the login can read nothing before the Job has run.
const jobsQueueAuth = installJobsQueueAuth(wiring, [...(keda ? [keda] : []), scalerGrants, scalerSecret]);
const queueScalerDeps = [...(keda ? [keda] : []), jobsQueueAuth, scalerGrants, scalerSecret];

// Research worker tier (ADR-0021) — claims the research queue fairly across
// organizations (ADR-0079), scaled by KEDA on the queue's depth.
const agentWorker = installAgentWorker(wiring, cfg, secrets, [
  postgres.initJob,
  postgres.pooler,
  dragonfly.service,
  seaweed.bucketInitJob,
  ...(chroma ? [chroma.service] : []),
  ...queueScalerDeps,
]);

// Ingestion tier (ADR-0076) — the only process that claims the durable ingest
// queue, fairly across organisations, scaled by KEDA on the queue's depth.
const ingestWorker = installIngestWorker(wiring, cfg, secrets, [
  postgres.initJob,
  postgres.pooler,
  dragonfly.service,
  seaweed.bucketInitJob,
  ...(chroma ? [chroma.service] : []),
  ...queueScalerDeps,
]);

// BFF background pool (ADR-0079) — claims bff_job_queue fairly across
// organisations and runs project reindex and rescan jobs in its own BFF,
// scaled by KEDA on the queue's depth. Internal only: no Service, no route.
const bffJobs = cfg.bffJobs.enabled
  ? installBffJobs(wiring, cfg, secrets, [
      migrations,
      api.service,
      ...(keda ? [keda] : []),
      scalerGrants,
      scalerSecret,
    ])
  : undefined;

// Chat tier scale-out (ADR-0080) — KEDA moves the aiq-agent StatefulSet between
// its floor and ceiling on the fleet's running turns. Only with affinity off.
if (backendAutoscaled(cfg)) {
  installBackendScaling(wiring, cfg, backend.statefulSet, keda ? [keda] : []);
}

// ── Edge (Gateway API) ───────────────────────────────────────────────────────
const gatewayResources = installGatewayResources(cfg, provider, namespace, certManager.issuerName, [
  gatewayController,
  certManager.release,
  // Gate the annotated Gateway on the ClusterIssuer so the cert-manager shim
  // never creates a Certificate referencing a not-yet-existent issuer.
  certManager.issuer,
]);
const routes = installHttpRoutes(cfg, provider, namespace, [
  gatewayResources.gateway,
  frontend.service,
  seaweed.service,
  web.service,
  // Don't program rate limit rules before their counter store exists: the
  // window in between is fail-open, so the limits would read as configured
  // while enforcing nothing.
  ...(rateLimitStore ? [rateLimitStore.service] : []),
]);

// ── Observability (OTel Collector + Aspire dashboard, ADR-0029) ──────────────
// Availability = flag AND capability (see config.ts): skipped whole when the
// stack has no otelDomain / OTLP key / dashboard Connect application,
// rather than shipping a dashboard nobody can log into.
if (cfg.observability.enabled) {
  const obs = installObservabilityDashboard(
    cfg, provider, namespace,
    cfg.observability.otelPrimaryApiKey,
    cfg.observability.oidcClientSecret,
    [gatewayResources.gateway],
  );
  // err2issue (ADR-0031) before the collector: the collector's logs/err2issue
  // pipeline starts exporting the moment it boots, so having the Service
  // resolvable first avoids a burst of connection-refused export errors on
  // every deploy. Its own `enabled` already implies observability is on.
  const errorSink = cfg.err2issue.enabled
    ? installErr2Issue(cfg, provider, namespace, [ns])
    : undefined;

  // Langfuse (ADR-0044) before the collector, for the same reason err2issue is:
  // the collector's `otlp_http/langfuse` exporter starts exporting the moment it
  // boots, so having the Service resolvable first avoids a burst of
  // connection-refused export errors on every deploy. Its own `enabled` already
  // implies observability is on.
  //
  // `clickhouse` / `langfuseQueue` are non-undefined exactly when
  // `cfg.langfuse.enabled` is true — the same flag guards all three — but
  // TypeScript cannot see that, so the check is written where the values are
  // used rather than asserted away.
  const langfuse =
    cfg.langfuse.enabled && clickhouse && langfuseQueue && postgres.langfuseDsn
      ? installLangfuse(
          cfg,
          provider,
          namespace,
          {
            databaseUrl: postgres.langfuseDsn,
            clickhouseHttpUrl: clickhouse.httpUrl,
            clickhouseMigrationUrl: clickhouse.migrationUrl,
            redisUrl: langfuseQueue.url,
            s3Endpoint: seaweed.internalEndpoint,
          },
          [
            gatewayResources.gateway,
            clickhouse.service,
            langfuseQueue.service,
            seaweed.bucketInitJob,
            ...postgres.langfuseStoreDeps,
          ],
        )
      : undefined;

  installOtelCollector(
    cfg, provider, namespace,
    obs.secrets,
    [
      obs.service,
      ...(errorSink ? [errorSink.service] : []),
      ...(langfuse ? [langfuse.webService] : []),
    ],
    langfuse ? langfuse.secret.metadata.name : undefined,
  );
}

// ── Public DNS ───────────────────────────────────────────────────────────────
//
// Last, and deliberately independent of every resource above: these records are
// managed at Cloudflare, not in the cluster, so they carry no `dependsOn` and
// nothing in the cluster waits on them. Publishing a name before the Gateway
// answers on it is harmless (the browser gets a connection refused, cert-manager
// retries its challenge); the reverse — a Gateway nobody can find — is the state
// this exists to prevent.
const dns = installDns(cfg);

// ── Stack outputs ────────────────────────────────────────────────────────────
export const appUrl = pulumi.interpolate`https://${cfg.ingress.appDomain}`;
export const s3Url = pulumi.interpolate`https://${cfg.ingress.s3Domain}`;
export const webUrl = pulumi.interpolate`https://${cfg.ingress.webDomain}`;
export const appNamespace = namespace;
export const postgresRwHost = postgres.rwHost;
export const backendService = backend.service.metadata.name;
export const apiService = api.service.metadata.name;
export const frontendService = frontend.service.metadata.name;
export const webService = web.service.metadata.name;
export const purgerDeployment = workers.purger.metadata.name;
export const schedulerDeployment = workers.scheduler.metadata.name;
export const appRoute = routes.app.metadata.name;
export const webRoute = routes.web.metadata.name;
export const gatewayName = gatewayResources.gateway.metadata.name;
export const chromaUrl = chroma.url;
export const pgInstances = cfg.postgres.instances;
export const pgBackupsEnabled = cfg.postgres.backups.enabled;
export const networkPoliciesEnabled = cfg.networkPolicies;
export const otelUrl = cfg.observability.enabled
  ? pulumi.interpolate`https://${cfg.observability.otelDomain}`
  : pulumi.output("(none: observability disabled)");
export const langfuseUrl = cfg.langfuse.enabled
  ? pulumi.interpolate`https://${cfg.langfuse.domain}`
  : pulumi.output("(none: langfuse disabled)");
export const errorIssueRepo = cfg.err2issue.enabled
  ? pulumi.output(cfg.err2issue.githubRepo)
  : pulumi.output("(none: err2issue disabled)");
export const dnsRecords = dns
  ? pulumi.all(managedRecordNames(dns)).apply((names) => names.join(", "))
  : pulumi.output("(none: dnsEnabled=false — records are maintained by hand)");
// The image refs this update deployed. `deploy.yml` reads them back before the
// next staging deploy and refuses one that would move a service to an older
// commit (`scripts/resolve-image-refs.sh`). The stack file cannot answer that:
// CI's `pulumi config set` never reaches git, so the committed file still says
// `imageTag: latest` whatever is running. Rename this and the guard goes blind.
export const deployedImages = {
  backend: backendImage(cfg),
  frontend: frontendImage(cfg),
  web: webImage(cfg),
};
export const ingestWorkerDeployment = ingestWorker.deployment.metadata.name;
export const bffJobsDeployment = bffJobs
  ? bffJobs.deployment.metadata.name
  : pulumi.output("(none: reindex and rescan jobs are not run)");
export const agentWorkerDeployment = agentWorker.deployment.metadata.name;
