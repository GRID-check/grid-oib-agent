/**
 * Fixed platform constants — the single home for every value that is NOT a
 * per-environment knob.
 *
 * The rule of the codebase:
 *   - Something an operator tunes per environment → a `grid-oib:` config key,
 *     declared and defaulted in `config.ts`, set in `Pulumi.<stack>.yaml`.
 *   - Something that is a fixed platform decision (a port, a UID, a resource
 *     envelope for a helper, a shared timeout) → a NAMED constant here, with
 *     the reasoning attached. No inline magic numbers in the modules.
 *
 * If you are looking for "where do I configure X": first `Pulumi.<stack>.yaml`
 * (your values), then `config.ts` (every knob + default), then this file
 * (fixed decisions). The full knob reference lives in README.md.
 */

/** Container UIDs baked into the images (verified against the Dockerfiles). */
export const UID = {
  /** Backend image (`deploy/Dockerfile`): `USER 1000:1000`. */
  backend: 1000,
  /** Frontend image (`frontends/ui/deploy/Dockerfile`): user `nextjs` = 1001. */
  frontend: 1001,
} as const;

/** Service/container ports. One definition; Services, probes, env and
 *  NetworkPolicies must all agree, so they all read from here. */
export const PORT = {
  backend: 8000,
  frontend: 3000,
  chroma: 8000,
  redis: 6379,
  postgres: 5432,
  seaweedS3: 8333,
  seaweedMaster: 9333,
  /** gRPC = HTTP + 10000 (weed convention). Required by `weed shell` — a
   *  Service that omits it makes the bucket-init Job hang (found live). */
  seaweedMasterGrpc: 19333,
  seaweedFiler: 8888,
  seaweedFilerGrpc: 18888,
} as const;

/**
 * Edge timeout budget for long-lived work: streaming chat responses, WebSocket
 * sessions, and large presigned S3 downloads all share it. Envoy's defaults
 * (15s request, ~5min stream-idle) would cut each of those mid-flight.
 */
export const EDGE_TIMEOUT = "3600s";

/**
 * Edge retry budget for requests that never reached a live upstream.
 *
 * A rolling update moves endpoints around: for the few seconds between a pod
 * being marked for deletion and Envoy's cluster losing that endpoint, a request
 * can be dispatched at a socket that is already gone. Without a retry the
 * browser sees that as a failed request — a blank panel, a failed BFF call, or
 * a WebSocket upgrade that never completes — even though a healthy replica was
 * sitting right there. Retrying is what turns "there was a deploy" into
 * "nothing happened".
 *
 * Small and fast on purpose: this covers an endpoint-programming race, which
 * resolves in well under a second. It is NOT a substitute for capacity, and it
 * is deliberately not a retry-on-5xx budget — see the trigger list in
 * `httproutes.ts` for why only never-dispatched failures are retried.
 */
export const EDGE_RETRY = {
  numRetries: 3,
  baseInterval: "100ms",
  maxInterval: "1s",
} as const;

/** Resource envelope for short-lived bootstrap Jobs (waiters, DDL, buckets). */
export const BOOTSTRAP_JOB_RESOURCES = {
  requests: { cpu: "25m", memory: "64Mi" },
  limits: { cpu: "250m", memory: "256Mi" },
} as const;

/** Resource envelope for light single-replica Node workers (purger, scheduler)
 *  and the migration Job — poll loops, no heavy lifting. */
export const LIGHT_WORKER_RESOURCES = {
  requests: { cpu: "50m", memory: "128Mi" },
  limits: { cpu: "500m", memory: "512Mi" },
} as const;

/** Platform add-on controllers (small, steady): requests AND limits everywhere
 *  — the provider's cluster-autoscaler prerequisite applies to every pod. */
export const PLATFORM_RESOURCES = {
  certManager: {
    requests: { cpu: "10m", memory: "64Mi" },
    limits: { cpu: "100m", memory: "128Mi" },
  },
  metricsServer: {
    requests: { cpu: "50m", memory: "64Mi" },
    limits: { cpu: "200m", memory: "256Mi" },
  },
  cnpgOperator: {
    requests: { cpu: "50m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  },
  /** The generated Envoy data-plane fleet (per proxy replica). */
  envoyProxy: {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "1", memory: "512Mi" },
  },
} as const;

/** Data-tier fixed resource envelopes (storage sizes are knobs; CPU/memory of
 *  the single-replica data services are platform decisions). */
export const DATA_RESOURCES = {
  postgres: {
    requests: { cpu: "500m", memory: "1Gi" },
    limits: { cpu: "2", memory: "4Gi" },
  },
  dragonflyRequests: { cpu: "50m", memory: "128Mi" },
  dragonflyCpuLimit: "500m", // memory limit is the `dragonflyMemoryLimit` knob
  chroma: {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "2", memory: "4Gi" },
  },
  seaweedfs: {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "1", memory: "1Gi" },
  },
} as const;

/** Kubernetes Job retry/cleanup defaults for bootstrap work. */
export const JOB_DEFAULTS = {
  /** Generous retry budget: bootstrap Jobs wait on other services. */
  backoffLimit: 10,
  /** Keep finished Jobs visible briefly, then let the cluster reap them. */
  ttlSecondsAfterFinished: 300,
} as const;

/**
 * App-behavior defaults injected as env (not stack knobs on purpose — they are
 * product decisions, not per-cluster tuning; promote one to config.ts if an
 * environment genuinely needs to differ).
 */
export const APP_DEFAULTS = {
  /** WS upgrade attempts per client per minute (frontend gateway). */
  wsUpgradeRateLimit: 30,
  /** Presigned S3 URL lifetime (seconds) for browser preview/download. */
  presignedUrlTtlSeconds: 600,
  /** Grace window before a deleted project is purged for real (days). */
  projectPurgeGraceDays: 7,
  /** Purger poll interval (ms). */
  purgerPollMs: 60_000,
  /** Workflow-scheduler poll interval (ms) and per-tick claim batch. */
  schedulerPollMs: 30_000,
  schedulerBatch: 20,
  /** Workflow run history retention (days). */
  workflowRunsRetentionDays: 90,
} as const;

/** Postgres server tuning (fixed; storage size and instance count are knobs). */
export const POSTGRES_TUNING = {
  maxConnections: "200",
  sharedBuffers: "256MB",
} as const;
