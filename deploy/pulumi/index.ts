/**
 * Grid OIB — Kubernetes deployment (Pulumi / TypeScript).
 *
 * Provisions the whole stack against a provider-supplied kubeconfig:
 *   platform  → cert-manager (+ Let's Encrypt issuer), Envoy Gateway, metrics-server
 *   data      → CloudNativePG Postgres (3 DBs), Dragonfly cache, SeaweedFS (S3)
 *   app       → aiq-agent (StatefulSet, the singleton agent), frontend
 *               (Deployment + HPA), purger, workflow-scheduler, a migration Job
 *   edge      → Gateway API (Envoy Gateway) + HTTPRoutes with cert-manager TLS,
 *               for the app and the public S3 endpoint
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
import { installPostgres } from "./src/data/postgres";
import { installDragonfly } from "./src/data/dragonfly";
import { installSeaweedFS } from "./src/data/seaweedfs";
import { installChroma } from "./src/data/chroma";
import { AppWiring, PULL_SECRET_NAME, buildRegistryPullSecret, buildSecrets } from "./src/app/config";
import { runMigrations } from "./src/app/migrations-job";
import { installBackend } from "./src/app/backend";
import { installFrontend } from "./src/app/frontend";
import { installWorkers } from "./src/app/workers";
import { installAgentWorker } from "./src/app/agent-worker";
import { installHttpRoutes } from "./src/app/httproutes";
import { installObservabilityDashboard } from "./src/platform/observability";
import { installOtelCollector } from "./src/platform/otel-collector";

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
const gatewayController = installGatewayController(provider);
const certManager = installCertManager(cfg, provider, namespace, [gatewayController]);
if (cfg.ingress.installMetricsServer) {
  installMetricsServer(provider);
}

// ── Data tier ─────────────────────────────────────────────────────────────
// SeaweedFS first so Postgres can gate its PITR backups on the backup bucket.
const seaweed = installSeaweedFS(
  cfg,
  provider,
  namespace,
  cfg.postgres.backups.enabled ? [cfg.postgres.backups.bucket] : [],
);
const postgres = installPostgres(
  cfg,
  provider,
  namespace,
  cfg.postgres.backups.enabled ? [seaweed.bucketInitJob] : [],
);
const dragonfly = installDragonfly(cfg, provider, namespace);
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

const secret = buildSecrets(wiring);

// grid_app DB is created at cluster bootstrap; run drizzle migrations before
// the frontend/workers that read it.
const migrations = runMigrations(wiring, cfg, secret, [postgres.cluster, postgres.initJob]);

// ── App workloads ──────────────────────────────────────────────────────────
const backend = installBackend(wiring, cfg, secret, [
  postgres.initJob,
  seaweed.bucketInitJob,
  dragonfly.service,
  ...(chroma ? [chroma.service] : []),
]);

const frontend = installFrontend(wiring, cfg, secret, [migrations, backend.service]);
const workers = installWorkers(wiring, cfg, secret, [migrations]);

// Research worker tier — only when execution is DB-claimed (ADR-0021).
const agentWorker =
  cfg.jobExecution === "db"
    ? installAgentWorker(wiring, cfg, secret, [
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
]);

// ── Observability (Aspire dashboard) ───────────────────────────────────────────
const obs = installObservabilityDashboard(
  cfg, provider, namespace,
  cfg.observability.otelPrimaryApiKey,
  cfg.auth.workosApiKey,
  [gatewayResources.gateway],
);
installOtelCollector(
  cfg, provider, namespace,
  obs.ingestionSecret,
  [obs.service],
);

// ── Stack outputs ────────────────────────────────────────────────────────────
export const appUrl = pulumi.interpolate`https://${cfg.ingress.appDomain}`;
export const s3Url = pulumi.interpolate`https://${cfg.ingress.s3Domain}`;
export const appNamespace = namespace;
export const postgresRwHost = postgres.rwHost;
export const backendService = backend.service.metadata.name;
export const frontendService = frontend.service.metadata.name;
export const purgerDeployment = workers.purger.metadata.name;
export const schedulerDeployment = workers.scheduler
  ? workers.scheduler.metadata.name
  : pulumi.output("(none: workflows disabled)");
export const appRoute = routes.app.metadata.name;
export const gatewayName = gatewayResources.gateway.metadata.name;
export const chromaUrl = chroma ? chroma.url : pulumi.output("embedded");
export const jobExecution = cfg.jobExecution;
export const pgInstances = cfg.postgres.instances;
export const pgBackupsEnabled = cfg.postgres.backups.enabled;
export const networkPoliciesEnabled = cfg.networkPolicies;
export const otelUrl = pulumi.interpolate`https://${cfg.observability.otelDomain}`;
export const agentWorkerDeployment = agentWorker
  ? agentWorker.deployment.metadata.name
  : pulumi.output("(none: dask mode)");
