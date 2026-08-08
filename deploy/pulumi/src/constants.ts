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
  /** Web (landing/blog) image (`frontends/web/Dockerfile`): user `piloti` = 1001. */
  web: 1001,
} as const;

/** Service/container ports. One definition; Services, probes, env and
 *  NetworkPolicies must all agree, so they all read from here. */
export const PORT = {
  backend: 8000,
  frontend: 3000,
  /** Astro Node standalone adapter default port (`frontends/web/Dockerfile`). */
  web: 4321,
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
  /** `weed volume` default http port. The filer reads and writes chunks here
   *  directly, using the address each volume server registers with the master. */
  seaweedVolume: 8080,
  seaweedVolumeGrpc: 18080,
} as const;

/**
 * SeaweedFS service names. The topology is three workloads (ADR-0043), and
 * every one of them is addressed by name from somewhere else — the filer from
 * the app tier, the master from `weed shell`, the volume servers from the
 * filer — so the names are a contract, not an implementation detail.
 *
 * `filer` deliberately keeps the bare name `seaweedfs`. It is the workload the
 * S3 gateway runs in, so `SEAWEED_ENDPOINT=http://seaweedfs:8333` continues to
 * resolve exactly as it did before the split, and the edge NetworkPolicy
 * (`allow-edge-to-seaweedfs`, which selects `app.kubernetes.io/name=seaweedfs`)
 * keeps selecting the pods that actually serve S3.
 */
export const SEAWEED = {
  /** Filer + S3 gateway. The name the app tier and the edge already know. */
  filer: "seaweedfs",
  /** Headless peer service backing the filer StatefulSet's stable DNS. */
  filerPeer: "seaweedfs-filer-peer",
  master: "seaweedfs-master",
  /** Headless peer service backing the master StatefulSet's stable DNS. */
  masterPeer: "seaweedfs-master-peer",
  volume: "seaweedfs-volume",
  /** Headless peer service backing the volume StatefulSet's stable DNS. */
  volumePeer: "seaweedfs-volume-peer",
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
  /**
   * The single-node topology: one process doing all three jobs. Left exactly as
   * it was before ADR-0043 so that `seaweedfsTopology: single` stays a true
   * no-op for the stacks still on it — a resource change here would restart the
   * only storage server in those deployments for no reason.
   */
  seaweedfs: {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "1", memory: "1Gi" },
  },
  /**
   * SeaweedFS, per role (ADR-0043). The old single `weed server` process did
   * all three jobs inside one envelope; splitting the workloads means splitting
   * the budget, and the three roles are not alike:
   *
   * - **master** is a Raft node holding the topology and the volume-id
   *   sequence. Tiny and steady — it never touches object bytes.
   * - **volume** is where the bytes land. Its memory is dominated by the
   *   in-memory needle index (`-index=memory`), which scales with object
   *   COUNT, not object size.
   * - **filer** carries the S3 gateway and every object's metadata round trip.
   *   With the store on Postgres it holds no index of its own, but it does
   *   stream object bodies through, so it is the one that wants headroom.
   */
  seaweedfsMaster: {
    requests: { cpu: "50m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  },
  seaweedfsVolume: {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "1", memory: "2Gi" },
  },
  seaweedfsFiler: {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "1", memory: "1Gi" },
  },
} as const;

/**
 * Edge rate limiting (ADR-0040, layer L1) — the fixed parts.
 *
 * The per-route budgets themselves are knobs (`config.ts` → `rateLimit.limits`)
 * because they are the numbers an operator retunes from observed traffic. What
 * lives here is the machinery that must not drift: where the counter store is,
 * how long Envoy waits for a verdict, and the path prefixes the rules select on.
 *
 * Every limit is per client IP and per route. They are ABUSE BOUNDS, never
 * accounting — anything that must be exact belongs in the ADR-0015 ledger.
 */
export const EDGE_RATE_LIMIT = {
  /**
   * Service name of the DEDICATED counter store. Deliberately not the ADR-0020
   * cache: that instance runs `--cache_mode=true` and evicts under memory
   * pressure, so a burst of ordinary cache traffic would quietly drop rate-limit
   * counters and reset the limits with nothing in any log to say so.
   */
  storeService: "dragonfly-ratelimit",
  /**
   * How long Envoy waits for the rate limit service before giving up. Short on
   * purpose: this sits in front of EVERY request, so a slow store must cost
   * milliseconds, not seconds. Combined with fail-open (see `failClosed` in
   * `config.ts`), a dead store degrades to "not limited", never to "down".
   */
  timeout: "250ms",
  /** Request-path prefixes the per-route rules select on. */
  paths: {
    /** Session/login endpoints — the credential-stuffing surface. */
    auth: "/api/auth",
    /**
     * The chat WebSocket (`frontends/ui/server.js` upgrade handler). One upgrade
     * here fans out into agent runs — and it is the LAST thing the edge sees of
     * that session, because every later turn rides the open socket (ADR-0009).
     */
    ws: "/websocket",
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
