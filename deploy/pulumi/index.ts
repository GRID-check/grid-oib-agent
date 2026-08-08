/**
 * Grid OIB — Kubernetes deployment (Pulumi / TypeScript).
 *
 * Provisions the whole stack against a provider-supplied kubeconfig:
 *   platform  → cert-manager (+ Let's Encrypt issuer), Envoy Gateway, metrics-server
 *   data      → CloudNativePG Postgres (3 DBs), Dragonfly cache, SeaweedFS (S3)
 *   app       → aiq-agent (StatefulSet, the singleton agent), frontend
 *               (Deployment + HPA), purger, workflow-scheduler, a migration Job
 *               and a WorkOS audit-schema reconcile Job
 *   edge      → Gateway API (Envoy Gateway) + HTTPRoutes with cert-manager TLS,
 *               for the app, the landing site and the public S3 endpoint
 *
 * The agent tier scales VERTICALLY here (resources + Dask knobs + admission
 * caps); every precondition for later HORIZONTAL scaling is already wired
 * (Postgres DSNs instead of SQLite, a shared Redis/Dragonfly cache). See
 * docs/deployment/kubernetes.md for the scale-out roadmap.
 */
import * as pulumi from "@pulumi/pulumi";

import { loadConfig } from "./src/config";
import { makeProvider } from "./src/platform/providers";
import { makeAppNamespace } from "./src/platform/namespaces";
import { installCertManager } from "./src/platform/cert-manager";
import { installGatewayController, installGatewayResources } from "./src/platform/gateway";
import { installMetricsServer } from "./src/platform/metrics-server";
import { installNetworkPolicies } from "./src/platform/network-policies";
import { installPostgres, installScheduledBackup, type Postgres } from "./src/data/postgres";
import { installDragonfly, installRateLimitStore } from "./src/data/dragonfly";
import { installSeaweedFS, type SeaweedFS } from "./src/data/seaweedfs";
import { installSeaweedFSBackup } from "./src/data/seaweedfs-backup";
import { installChroma } from "./src/data/chroma";
import { AppWiring, PULL_SECRET_NAME, buildRegistryPullSecret, buildSecrets } from "./src/app/config";
import { runMigrations } from "./src/app/migrations-job";
import { reconcileAuditSchemas } from "./src/app/audit-schemas-job";
import { installBackend } from "./src/app/backend";
import { installFrontend } from "./src/app/frontend";
import { installWeb } from "./src/app/web";
import { installWorkers } from "./src/app/workers";
import { installAgentWorker } from "./src/app/agent-worker";
import { installHttpRoutes } from "./src/app/httproutes";
import { installObservabilityDashboard } from "./src/platform/observability";
import { installOtelCollector } from "./src/platform/otel-collector";
import { installErr2Issue } from "./src/platform/err2issue";

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
const extraBuckets = cfg.postgres.backups.enabled ? [cfg.postgres.backups.bucket] : [];
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
// Counter store for edge rate limiting (ADR-0040 L1) — deliberately a SECOND
// instance, never the cache above; `data/dragonfly.ts` explains why. Only the
// rate limit service in `envoy-gateway-system` talks to it, over the allow in
// `platform/network-policies.ts`.
const rateLimitStore = cfg.rateLimit.enabled
  ? installRateLimitStore(cfg, provider, namespace)
  : undefined;
const chroma = cfg.chroma.enabled ? installChroma(cfg, provider, namespace) : undefined;

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
  chromaUrl: chroma?.url,
  dsn: postgres.dsn,
  imagePullSecrets: pullSecret ? [{ name: PULL_SECRET_NAME }] : [],
};

// The Secret AND the checksum every consumer stamps on its pod template, so a
// rotated credential is a gated rolling update rather than a silent no-op
// (src/platform/rollout.ts).
const secrets = buildSecrets(wiring);

// grid_app DB is created at cluster bootstrap; run drizzle migrations before
// the frontend/workers that read it.
const migrations = runMigrations(wiring, cfg, secrets, [postgres.cluster, postgres.initJob]);

// WorkOS must know every audit action the code emits, or it rejects the events
// and the trail silently thins out (issues #255/#256). Reconciled per deploy so
// the environment follows the code; skipped when auth is off, because then
// there is no WorkOS environment and no key to reconcile against.
if (cfg.auth.requireAuth) {
  reconcileAuditSchemas(wiring, cfg, secrets, [ns]);
}

// ── App workloads ──────────────────────────────────────────────────────────
const backend = installBackend(wiring, cfg, secrets, [
  postgres.initJob,
  seaweed.bucketInitJob,
  dragonfly.service,
  ...(chroma ? [chroma.service] : []),
]);

const frontend = installFrontend(wiring, cfg, secrets, [migrations, backend.service]);
const workers = installWorkers(wiring, cfg, secrets, [migrations]);
// Landing site + blog (Astro, frontends/web) — static-first, no app secrets,
// but it pulls from the same registry, so it gets the pull Secret too.
const web = installWeb(cfg, provider, namespace, wiring.imagePullSecrets, [
  ns,
  ...(pullSecret ? [pullSecret] : []),
]);

// Research worker tier — only when execution is DB-claimed (ADR-0021).
const agentWorker =
  cfg.jobExecution === "db"
    ? installAgentWorker(wiring, cfg, secrets, [
        postgres.initJob,
        dragonfly.service,
        seaweed.bucketInitJob,
        ...(chroma ? [chroma.service] : []),
      ])
    : undefined;

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

  installOtelCollector(
    cfg, provider, namespace,
    obs.secrets,
    [obs.service, ...(errorSink ? [errorSink.service] : [])],
  );
}

// ── Stack outputs ────────────────────────────────────────────────────────────
export const appUrl = pulumi.interpolate`https://${cfg.ingress.appDomain}`;
export const s3Url = pulumi.interpolate`https://${cfg.ingress.s3Domain}`;
export const webUrl = pulumi.interpolate`https://${cfg.ingress.webDomain}`;
export const appNamespace = namespace;
export const postgresRwHost = postgres.rwHost;
export const backendService = backend.service.metadata.name;
export const frontendService = frontend.service.metadata.name;
export const webService = web.service.metadata.name;
export const purgerDeployment = workers.purger.metadata.name;
export const schedulerDeployment = workers.scheduler
  ? workers.scheduler.metadata.name
  : pulumi.output("(none: workflows disabled)");
export const appRoute = routes.app.metadata.name;
export const webRoute = routes.web.metadata.name;
export const gatewayName = gatewayResources.gateway.metadata.name;
export const chromaUrl = chroma ? chroma.url : pulumi.output("embedded");
export const jobExecution = cfg.jobExecution;
export const pgInstances = cfg.postgres.instances;
export const pgBackupsEnabled = cfg.postgres.backups.enabled;
export const networkPoliciesEnabled = cfg.networkPolicies;
export const otelUrl = cfg.observability.enabled
  ? pulumi.interpolate`https://${cfg.observability.otelDomain}`
  : pulumi.output("(none: observability disabled)");
export const errorIssueRepo = cfg.err2issue.enabled
  ? pulumi.output(cfg.err2issue.githubRepo)
  : pulumi.output("(none: err2issue disabled)");
export const agentWorkerDeployment = agentWorker
  ? agentWorker.deployment.metadata.name
  : pulumi.output("(none: dask mode)");
