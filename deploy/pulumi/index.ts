/**
 * Grid OIB — Kubernetes deployment (Pulumi / TypeScript).
 *
 * Provisions the whole stack against a provider-supplied kubeconfig:
 *   platform  → cert-manager (+ Let's Encrypt issuer), ingress-nginx
 *   data      → CloudNativePG Postgres (3 DBs), Dragonfly cache, SeaweedFS (S3)
 *   app       → aiq-agent (StatefulSet, the singleton agent), frontend
 *               (Deployment + HPA), purger, workflow-scheduler, a migration Job
 *   edge      → TLS ingress for the app and the public S3 endpoint
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
import { installIngressNginx } from "./src/platform/ingress-nginx";
import { installPostgres } from "./src/data/postgres";
import { installDragonfly } from "./src/data/dragonfly";
import { installSeaweedFS } from "./src/data/seaweedfs";
import { installChroma } from "./src/data/chroma";
import { AppWiring, buildSecrets } from "./src/app/config";
import { runMigrations } from "./src/app/migrations-job";
import { installBackend } from "./src/app/backend";
import { installFrontend } from "./src/app/frontend";
import { installWorkers } from "./src/app/workers";
import { installAgentWorker } from "./src/app/agent-worker";
import { installIngress } from "./src/app/ingress";

const cfg = loadConfig();
const provider = makeProvider(cfg);

// ── Namespace + platform add-ons ──────────────────────────────────────────
const ns = makeAppNamespace(cfg, provider);
const namespace = ns.metadata.name;

const certManager = installCertManager(cfg, provider);
const ingressNginx = installIngressNginx(provider);

// ── Data tier ─────────────────────────────────────────────────────────────
const postgres = installPostgres(cfg, provider, namespace);
const dragonfly = installDragonfly(cfg, provider, namespace);
const seaweed = installSeaweedFS(cfg, provider, namespace);
const chroma = cfg.chroma.enabled ? installChroma(cfg, provider, namespace) : undefined;

// ── Shared wiring for the app tier ─────────────────────────────────────────
const wiring: AppWiring = {
  cfg,
  namespace,
  provider,
  redisUrl: dragonfly.url,
  seaweedInternalEndpoint: seaweed.internalEndpoint,
  seaweedPublicEndpoint: seaweed.publicEndpoint,
  chromaUrl: chroma?.url,
  dsn: postgres.dsn,
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
    ? installAgentWorker(wiring, cfg, secret, [postgres.initJob, ...(chroma ? [chroma.service] : [])])
    : undefined;

// ── Edge ────────────────────────────────────────────────────────────────────
const ingress = installIngress(cfg, provider, namespace, certManager.issuerName, [
  ingressNginx,
  frontend.service,
  seaweed.service,
]);

// ── Stack outputs ────────────────────────────────────────────────────────────
export const appUrl = pulumi.interpolate`https://${cfg.ingress.appDomain}`;
export const s3Url = pulumi.interpolate`https://${cfg.ingress.s3Domain}`;
export const appNamespace = namespace;
export const postgresRwHost = postgres.rwHost;
export const backendService = backend.service.metadata.name;
export const frontendService = frontend.service.metadata.name;
export const purgerDeployment = workers.purger.metadata.name;
export const schedulerDeployment = workers.scheduler.metadata.name;
export const appIngress = ingress.app.metadata.name;
export const chromaUrl = chroma ? chroma.url : pulumi.output("embedded");
export const jobExecution = cfg.jobExecution;
export const agentWorkerDeployment = agentWorker
  ? agentWorker.deployment.metadata.name
  : pulumi.output("(none: dask mode)");
