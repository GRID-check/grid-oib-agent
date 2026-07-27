import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { APP_DEFAULTS, PORT } from "../constants";

type EnvVar = k8s.types.input.core.v1.EnvVar;

export interface AppWiring {
  cfg: GridConfig;
  namespace: pulumi.Input<string>;
  provider: k8s.Provider;
  redisUrl: pulumi.Output<string>;
  seaweedInternalEndpoint: pulumi.Output<string>;
  seaweedPublicEndpoint: pulumi.Output<string>;
  /** Shared Chroma server URL (set when cfg.chroma.enabled). */
  chromaUrl?: pulumi.Output<string>;
  dsn: (opts: { db: string; driver?: string }) => pulumi.Output<string>;
  /**
   * imagePullSecrets for every app pod spec — references the registry pull
   * Secret when the app images are private, empty when they are public.
   */
  imagePullSecrets: { name: string }[];
}

const SECRET_NAME = "grid-secrets"; // pragma: allowlist secret (Kubernetes Secret resource name, not a credential)
export const PULL_SECRET_NAME = "grid-registry-pull"; // pragma: allowlist secret (Kubernetes Secret resource name, not a credential)

/**
 * dockerconfigjson pull Secret for the app namespace, created only when
 * registry credentials are configured (private app images). Every app pod
 * spec references it via imagePullSecrets; the data tier pulls public
 * upstream images and needs nothing.
 */
export function buildRegistryPullSecret(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
): k8s.core.v1.Secret | undefined {
  const creds = cfg.images.pullCredentials;
  if (!creds) return undefined;
  // Registry server = first path segment of the image registry
  // ("ghcr.io/grid-check" → "ghcr.io").
  const server = cfg.images.registry.split("/")[0];
  const dockerConfigJson = creds.password.apply((pw) =>
    JSON.stringify({
      auths: {
        [server]: {
          username: creds.username,
          password: pw,
          auth: Buffer.from(`${creds.username}:${pw}`).toString("base64"),
        },
      },
    }),
  );
  return new k8s.core.v1.Secret(
    "grid-registry-pull",
    {
      metadata: { name: PULL_SECRET_NAME, namespace },
      type: "kubernetes.io/dockerconfigjson",
      stringData: { ".dockerconfigjson": dockerConfigJson },
    },
    { provider },
  );
}

/**
 * One Kubernetes Secret holding every sensitive value (API keys, tokens, the
 * BYOK KEK, S3 secret key, and the fully-formed DB DSNs — which embed the PG
 * password). Non-secret env is inlined directly on each workload. Values stay
 * encrypted in Pulumi state; this is the only place they are materialised.
 */
export function buildSecrets(w: AppWiring): k8s.core.v1.Secret {
  const { cfg } = w;
  return new k8s.core.v1.Secret(
    "grid-secrets",
    {
      metadata: { name: SECRET_NAME, namespace: w.namespace },
      stringData: {
        OPENROUTER_API_KEY: cfg.llm.openrouterApiKey,
        TAVILY_API_KEY: cfg.llm.tavilyApiKey,
        GRID_INTERNAL_API_TOKEN: cfg.internal.apiToken,
        GRID_ADMIN_TOKEN: cfg.internal.adminToken,
        GRID_JOB_PAYLOAD_KEK: cfg.internal.jobPayloadKek,
        WORKOS_API_KEY: cfg.auth.workosApiKey,
        WORKOS_COOKIE_PASSWORD: cfg.auth.workosCookiePassword,
        GRID_BYOK_LOCAL_KEK: cfg.auth.byokLocalKek,
        SEAWEED_SECRET_KEY: cfg.seaweedfs.secretKey,
        // DSNs (embed the PG password → secret).
        NAT_JOB_STORE_DB_URL: w.dsn({ db: "aiq_jobs", driver: "postgresql+asyncpg" }),
        AIQ_CHECKPOINT_DB: w.dsn({ db: "aiq_checkpoints" }),
        AIQ_SUMMARY_DB: w.dsn({ db: "aiq_jobs", driver: "postgresql+psycopg" }),
        AIQ_LISTEN_DB_URL: w.dsn({ db: "aiq_jobs" }),
        AIQ_DEEP_CHECKPOINT_DB: w.dsn({ db: "aiq_checkpoints" }),
        GRID_APP_DATABASE_URL: w.dsn({ db: "grid_app" }),
        // Aspire dashboard OTLP tracing.
        OTLP_API_KEY: cfg.observability.otelPrimaryApiKey,
        OTEL_EXPORTER_OTLP_HEADERS: cfg.observability.otelPrimaryApiKey.apply(
          (key) => `x-otlp-api-key=${key}`
        ),
      },
    },
    { provider: w.provider },
  );
}

/** EnvVar sourced from the shared Secret. */
function sref(key: string): EnvVar {
  return { name: key, valueFrom: { secretKeyRef: { name: SECRET_NAME, key } } };
}

/** EnvVar with the container name differing from the secret key. */
function srefAs(name: string, key: string): EnvVar {
  return { name, valueFrom: { secretKeyRef: { name: SECRET_NAME, key } } };
}

/**
 * Backend (aiq-agent) environment. Postgres DSNs everywhere (never SQLite) —
 * the hard precondition for durability and any future replica. The Dask
 * worker/thread knobs and admission caps are the agent's VERTICAL scaling
 * levers (see docs/architecture/scaling-review-2026-07.md §4, §6).
 */
export function backendEnv(w: AppWiring): EnvVar[] {
  const { cfg } = w;
  const env: EnvVar[] = [
    { name: "APP_ENV", value: "production" },
    { name: "LOG_LEVEL", value: "INFO" },
    { name: "HOST", value: "0.0.0.0" },
    { name: "PORT", value: String(PORT.backend) },
    { name: "CONFIG_FILE", value: cfg.backend.configFile },
    { name: "COLLECTION_NAME", value: "oib_knowledge" },
    // Research execution backend (dask = per-pod; db = DB-claimed workers).
    { name: "GRID_JOB_EXECUTION", value: cfg.jobExecution },
    // Encrypts DB-claimed job payloads at rest (empty = plaintext, dev only).
    sref("GRID_JOB_PAYLOAD_KEK"),
    // Embedded fallback dir (used only when AIQ_CHROMA_URL is unset).
    { name: "AIQ_CHROMA_DIR", value: cfg.backend.chromaDir },
    { name: "OIB_UPLOADS_DIR", value: "/app/data/oib_uploads" },
    { name: "GRID_NORMS_DIR", value: "configs/norms" },
    // Databases (Postgres, not SQLite).
    sref("NAT_JOB_STORE_DB_URL"),
    sref("AIQ_CHECKPOINT_DB"),
    sref("AIQ_SUMMARY_DB"),
    sref("AIQ_LISTEN_DB_URL"),
    // Durable per-job LangGraph checkpointing for async deep-research runs.
    sref("AIQ_DEEP_CHECKPOINT_DB"),
    // Shared cache.
    { name: "REDIS_URL", value: w.redisUrl },
    // Stateless chat tier via the Dragonfly pub/sub conversation bus (ADR-0028).
    // ON by default — the intended architecture; uses REDIS_URL, fails open to
    // local delivery. Set conversationBus=false to fall back to affinity.
    { name: "GRID_CONVERSATION_BUS", value: cfg.conversationBus ? "1" : "0" },
    // Project-memory write path (backend → frontend BFF).
    { name: "FRONTEND_INTERNAL_URL", value: `http://frontend:${PORT.frontend}` },
    sref("GRID_INTERNAL_API_TOKEN"),
    sref("GRID_ADMIN_TOKEN"),
    // Aspire dashboard OTLP tracing.
    { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: `http://aspire-dashboard:4317` },
    sref("OTEL_EXPORTER_OTLP_HEADERS"),
    // Dask (in-process research execution) — vertical scaling knobs.
    { name: "DASK_NWORKERS", value: String(cfg.backend.daskWorkers) },
    { name: "DASK_NTHREADS", value: String(cfg.backend.daskThreads) },
    // Admission control (bounds concurrent heavy work — §4.2).
    { name: "GRID_MAX_ACTIVE_JOBS", value: String(cfg.backend.maxActiveJobs) },
    { name: "GRID_MAX_ACTIVE_JOBS_PER_ORG", value: String(cfg.backend.maxActiveJobsPerOrg) },
    { name: "AIQ_INGEST_MAX_WORKERS", value: String(cfg.backend.ingestMaxWorkers) },
    // LLM / embeddings / VLM (all via OpenRouter).
    sref("OPENROUTER_API_KEY"),
    sref("TAVILY_API_KEY"),
    { name: "AIQ_EMBED_MODEL", value: cfg.llm.embedModel },
    { name: "AIQ_EMBED_BASE_URL", value: cfg.llm.embedBaseUrl },
    srefAs("AIQ_EMBED_API_KEY", "OPENROUTER_API_KEY"),
    srefAs("NVIDIA_API_KEY", "OPENROUTER_API_KEY"),
    { name: "AIQ_VLM_MODEL", value: cfg.llm.vlmModel },
    { name: "AIQ_VLM_BASE_URL", value: cfg.llm.vlmBaseUrl },
    srefAs("AIQ_VLM_API_KEY", "OPENROUTER_API_KEY"),
    // NOTE: no SEAWEED_* here on purpose — the backend Python tree has zero
    // consumers (verified by grep across src/, frontends/aiq_api/, sources/,
    // shared/; compose gives them only to frontend + purger). Injecting the S3
    // root credential into tiers that never use it just widens the attack
    // surface.
  ];
  // Shared Chroma server (horizontal scaling): when set, the adapter uses an
  // HttpClient instead of the embedded per-pod store.
  if (w.chromaUrl) {
    env.push({ name: "AIQ_CHROMA_URL", value: w.chromaUrl });
  }
  return env;
}

/**
 * Research worker (ADR-0021) environment: the full backend env (DB DSNs, shared
 * Chroma, LLM keys, object storage — the worker runs the same `run_agent_job`)
 * plus the worker role + per-process concurrency. `GRID_ROLE=worker` makes the
 * entrypoint run `python -m aiq_api.jobs.worker` with no web server or Dask.
 */
export function workerEnv(w: AppWiring): EnvVar[] {
  return [
    ...backendEnv(w),
    { name: "GRID_ROLE", value: "worker" },
    { name: "GRID_RESEARCH_WORKERS", value: String(w.cfg.agentWorker.concurrency) },
  ];
}

/** Frontend (Next.js + BFF + WS gateway) environment. */
export function frontendEnv(w: AppWiring): EnvVar[] {
  const { cfg } = w;
  return [
    { name: "APP_ENV", value: "production" },
    { name: "REQUIRE_AUTH", value: String(cfg.auth.requireAuth) },
    { name: "BACKEND_URL", value: `http://aiq-agent:${PORT.backend}` },
    // Conversation affinity for horizontal aiq-agent scaling (ADR-0028): the
    // WS proxy pins a conversation to `aiq-agent-<hash>.aiq-agent-headless` so
    // its in-process WS/HITL/task state is always on the same replica. With 1
    // replica the proxy falls back to the load-balanced BACKEND_URL.
    { name: "BACKEND_REPLICAS", value: String(cfg.jobExecution === "db" ? cfg.backend.replicas : 1) },
    // In-cluster headless-service pod address; traffic never leaves the pod
    // network, so the non-TLS ws scheme below is intentional.
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    { name: "BACKEND_POD_WS_TEMPLATE", value: `ws://aiq-agent-{i}.aiq-agent-headless:${PORT.backend}` },
    // Frontend replica baseline — lets server.js warn if a multi-replica deploy
    // is missing REDIS_URL (shared cache + WS rate limiter would diverge per pod).
    { name: "FRONTEND_REPLICAS", value: String(cfg.frontend.minReplicas) },
    sref("GRID_APP_DATABASE_URL"),
    sref("GRID_INTERNAL_API_TOKEN"),
    sref("GRID_ADMIN_TOKEN"),
    { name: "GRID_ALLOW_AGENT_ORG_MEMORY", value: String(cfg.auth.allowAgentOrgMemory) },
    // WorkOS AuthKit.
    { name: "WORKOS_CLIENT_ID", value: cfg.auth.workosClientId },
    sref("WORKOS_API_KEY"),
    sref("WORKOS_COOKIE_PASSWORD"),
    // Set BOTH: authkit-nextjs reads the literal NEXT_PUBLIC_ var (works at
    // runtime only while the image is built without it — Next.js would inline
    // a build-time value); WORKOS_REDIRECT_URI is the first-party callback
    // route's explicit runtime override and is immune to build-time inlining.
    { name: "NEXT_PUBLIC_WORKOS_REDIRECT_URI", value: `https://${cfg.ingress.appDomain}/api/auth/callback` },
    { name: "WORKOS_REDIRECT_URI", value: `https://${cfg.ingress.appDomain}/api/auth/callback` },
    // BYOK.
    { name: "GRID_BYOK_SECRET_BACKEND", value: cfg.auth.byokSecretBackend },
    sref("GRID_BYOK_LOCAL_KEK"),
    { name: "GRID_BYOK_ALLOW_PRIVATE_BASE_URLS", value: "false" },
    // Object storage (public endpoint signs browser presigned URLs).
    { name: "SEAWEED_ENDPOINT", value: w.seaweedInternalEndpoint },
    { name: "SEAWEED_PUBLIC_ENDPOINT", value: w.seaweedPublicEndpoint },
    { name: "SEAWEED_ACCESS_KEY", value: cfg.seaweedfs.accessKey },
    sref("SEAWEED_SECRET_KEY"),
    { name: "SEAWEED_BUCKET", value: cfg.seaweedfs.bucket },
    { name: "SEAWEED_PRESIGNED_URL_TTL_SECONDS", value: String(APP_DEFAULTS.presignedUrlTtlSeconds) },
    { name: "PROJECT_PURGE_GRACE_DAYS", value: String(APP_DEFAULTS.projectPurgeGraceDays) },
    // Model catalog + budgets.
    sref("OPENROUTER_API_KEY"),
    { name: "GRID_BUDGET_EUR_PER_USD", value: cfg.llm.budgetEurPerUsd },
    // Platform tier.
    { name: "GRID_PLATFORM_OWNER_EMAILS", value: cfg.auth.platformOwnerEmails },
    { name: "GRID_PLATFORM_ORG_EXTERNAL_ID", value: cfg.auth.platformOrgExternalId },
    { name: "GRID_DISABLE_SELF_SERVE_ORGS", value: String(cfg.auth.disableSelfServeOrgs) },
    { name: "GRID_ENFORCE_FEATURE_FLAGS", value: String(cfg.auth.enforceFeatureFlags) },
    // Shared cache + WS rate limiting (needed for >1 replica correctness).
    { name: "REDIS_URL", value: w.redisUrl },
    { name: "GRID_WS_UPGRADE_RATE_LIMIT", value: String(APP_DEFAULTS.wsUpgradeRateLimit) },
    // Workflows.
    { name: "GRID_WORKFLOWS_ENABLED", value: String(cfg.workflows.enabled) },
    { name: "GRID_WORKFLOW_MIN_INTERVAL_MINUTES", value: String(cfg.workflows.minIntervalMinutes) },
  ];
}

/** Purger worker environment. */
export function purgerEnv(w: AppWiring): EnvVar[] {
  const { cfg } = w;
  return [
    sref("GRID_APP_DATABASE_URL"),
    { name: "BACKEND_URL", value: `http://aiq-agent:${PORT.backend}` },
    sref("GRID_INTERNAL_API_TOKEN"),
    { name: "SEAWEED_ENDPOINT", value: w.seaweedInternalEndpoint },
    { name: "SEAWEED_ACCESS_KEY", value: cfg.seaweedfs.accessKey },
    sref("SEAWEED_SECRET_KEY"),
    { name: "SEAWEED_BUCKET", value: cfg.seaweedfs.bucket },
    sref("WORKOS_API_KEY"),
    { name: "PURGER_POLL_INTERVAL_MS", value: String(APP_DEFAULTS.purgerPollMs) },
  ];
}

/** Workflow-scheduler worker environment. */
export function schedulerEnv(w: AppWiring): EnvVar[] {
  const { cfg } = w;
  return [
    sref("GRID_APP_DATABASE_URL"),
    { name: "FRONTEND_INTERNAL_URL", value: `http://frontend:${PORT.frontend}` },
    sref("GRID_INTERNAL_API_TOKEN"),
    { name: "GRID_WORKFLOWS_ENABLED", value: String(cfg.workflows.enabled) },
    { name: "GRID_ENFORCE_FEATURE_FLAGS", value: String(cfg.auth.enforceFeatureFlags) },
    { name: "GRID_WORKFLOW_SCHEDULER_POLL_MS", value: String(APP_DEFAULTS.schedulerPollMs) },
    { name: "GRID_WORKFLOW_SCHEDULER_BATCH", value: String(APP_DEFAULTS.schedulerBatch) },
    { name: "GRID_WORKFLOW_RUNS_RETENTION_DAYS", value: String(APP_DEFAULTS.workflowRunsRetentionDays) },
  ];
}

/** Minimal env for the drizzle migration Job. */
export function migrationEnv(): EnvVar[] {
  return [sref("GRID_APP_DATABASE_URL")];
}
