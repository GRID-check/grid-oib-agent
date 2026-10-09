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
  /** Gotenberg image (upstream `build/Dockerfile`): user `gotenberg` = 1001. */
  gotenberg: 1001,
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
  /** Langfuse web (UI + public API + the OTLP receiver). Upstream default. */
  langfuseWeb: 3000,
  /**
   * Langfuse worker. Upstream default, and NOT a port anything outside the
   * worker's own probes should dial: the queue is how work reaches it.
   */
  langfuseWorker: 3030,
  /** ClickHouse HTTP interface — `CLICKHOUSE_URL`. */
  clickhouseHttp: 8123,
  /**
   * ClickHouse native TCP interface — `CLICKHOUSE_MIGRATION_URL`. Langfuse
   * needs BOTH: the app talks HTTP, its schema migrator speaks native.
   */
  clickhouseNative: 9000,
  /** Gotenberg API (office → PDF, ADR-0070). Upstream default. */
  gotenberg: 3000,
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
  kedaOperator: {
    requests: { cpu: "50m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  },
  kedaMetricServer: {
    requests: { cpu: "50m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  },
  kedaWebhooks: {
    requests: { cpu: "10m", memory: "64Mi" },
    limits: { cpu: "200m", memory: "256Mi" },
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
  /**
   * ClickHouse — the analytical store behind Langfuse (ADR-0044).
   *
   * Sized for the ingest rate of ONE deployment's traces, not for a warehouse.
   * The memory limit is the number that matters: ClickHouse sizes its mark
   * cache and merge buffers from what it believes is available, and the server
   * reads the CGROUP limit, so this value is also the tuning input. Below ~2Gi
   * merges of the trace tables start failing under load with
   * `MEMORY_LIMIT_EXCEEDED` rather than degrading.
   */
  clickhouse: {
    requests: { cpu: "250m", memory: "1Gi" },
    limits: { cpu: "2", memory: "4Gi" },
  },
} as const;

/**
 * Langfuse (ADR-0044) — the fixed parts of the LLM-observability tier.
 *
 * What is a knob (`config.ts` → `langfuse`): the hostname, the images, the
 * storage sizes, and every credential. What is here: the names and layout that
 * several modules must agree on, and the resource envelopes.
 */
export const LANGFUSE = {
  /** Deployment/Service name and `app.kubernetes.io/name` of the web tier. */
  web: "langfuse-web",
  /** Deployment/Service name and `app.kubernetes.io/name` of the worker. */
  worker: "langfuse-worker",
  /** StatefulSet/Service name of the ClickHouse instance. */
  clickhouse: "clickhouse",
  /**
   * The Langfuse ingestion queue — a THIRD Dragonfly, never the ADR-0020 cache
   * and never the rate-limit counter store. `installLangfuseQueue` carries the
   * reasoning; the short version is that this one runs with eviction OFF
   * because an evicted queue entry is a trace that silently never arrives.
   */
  queue: "dragonfly-langfuse",
  /**
   * Postgres database AND role for Langfuse's transactional state (projects,
   * API keys, users, prompts, datasets). Not a knob, for the same reason
   * `SEAWEED_FILER_DB` is not: it is referenced from the CNPG `managed.roles`
   * entry, the `Database` CR and the DSN, and those three must agree exactly.
   *
   * Its own database and its own login rather than a schema in `grid_app`:
   * Langfuse runs its own Prisma migrations as the database owner, so handing
   * it the application role would hand a third-party image DDL rights over
   * every tenant table in the product.
   */
  database: "langfuse",
  databaseUser: "langfuse_app",
  /**
   * ClickHouse database name. `default` is deliberately avoided — Langfuse's
   * migrator creates and drops tables, and doing that in `default` makes an
   * accidental `DROP DATABASE` unrecoverable-by-name.
   */
  clickhouseDatabase: "langfuse",
  /** ClickHouse login. Langfuse needs SELECT/INSERT/ALTER/CREATE/DELETE. */
  clickhouseUser: "langfuse",
  /**
   * One SeaweedFS bucket, three key prefixes — not three buckets.
   *
   * The bucket is the authorization boundary in this stack (ADR-0043), so one
   * bucket means the Langfuse S3 identity is scoped by exactly one rule and
   * cannot be widened by adding a feature. The prefixes keep the three
   * workloads separable for lifecycle policies later.
   */
  bucket: "langfuse",
  eventPrefix: "events/",
  batchExportPrefix: "exports/",
  /**
   * Dedicated S3 identity for the Langfuse tier. Object CRUD on the bucket
   * above and NOTHING else — in particular not `Admin` (no bucket lifecycle)
   * and not the tenant bucket prefix. See `s3IdentityCatalog`.
   */
  s3Identity: "grid-langfuse",
  /**
   * HTTPRoute name. The SecurityPolicy attaches to it by name, so the two are
   * one decision.
   */
  routeName: "grid-langfuse",
  /** Gateway listener name for the Langfuse hostname. */
  listenerName: "https-langfuse",
  /**
   * OTLP/HTTP trace-ingestion path on the web tier. Langfuse also serves
   * `/api/public/otel` as a base, but the collector's `otlp_http` exporter is
   * given an explicit `traces_endpoint`, which is used AS-IS — so the signal
   * path has to be spelled out here.
   */
  otlpTracesPath: "/api/public/otel/v1/traces",
  /** Resource envelopes. The web tier serves the UI; the worker does ingest. */
  webResources: {
    requests: { cpu: "200m", memory: "1Gi" },
    limits: { cpu: "1", memory: "2Gi" },
  },
  workerResources: {
    requests: { cpu: "200m", memory: "1Gi" },
    limits: { cpu: "2", memory: "3Gi" },
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

/**
 * Gotenberg (ADR-0070) — the office → PDF converter behind the document viewer.
 *
 * The image is a knob (`gotenbergImage`); the name, the flags and the envelope
 * are fixed, because the frontend's `GOTENBERG_URL`, the NetworkPolicies and
 * the Compose service all have to agree with them.
 */
export const GOTENBERG = {
  /** Deployment/Service name and `app.kubernetes.io/name`. */
  name: "gotenberg",
  /**
   * The container args. Only the LibreOffice route is used, by the frontend
   * BFF alone; every other way Gotenberg can reach the network is switched off:
   *   - The `-libreoffice` image (config.ts) has no Chromium, so the HTML/URL
   *     → PDF routes, the SSRF surface, do not exist. That binary also rejects
   *     every `--chromium-*` flag at boot, so none belongs here.
   *   - download-from / webhooks: it never fetches an input from a URL nor
   *     calls one back.
   *   - `--libreoffice-deny-private-ips` / `--libreoffice-deny-public-ips`:
   *     an office file can link external images, and LibreOffice would fetch
   *     them. With both flags Gotenberg refuses every such fetch, whatever
   *     the address resolves to, so a crafted file cannot reach an in-cluster
   *     service either.
   * The egress NetworkPolicy is the second layer, where networkPolicies is on.
   *
   * `--api-timeout` matches the BFF's own 120s conversion timeout, so the
   * converter never keeps working on a request its caller has abandoned for
   * long. `--libreoffice-auto-start` pays soffice's cold start at boot instead
   * of inside the first user's upload. `--gotenberg-graceful-shutdown-duration`
   * lets a conversion in flight at SIGTERM run to that same 120s instead of
   * the upstream 30s: since ADR-0071 a cut conversion is a failed ingest.
   */
  args: [
    "gotenberg",
    "--api-timeout=120s",
    "--api-disable-download-from",
    "--webhook-disable",
    "--libreoffice-auto-start=true",
    "--gotenberg-graceful-shutdown-duration=120s",
    "--libreoffice-deny-private-ips",
    "--libreoffice-deny-public-ips",
  ],
  /**
   * Upstream's own floor is 512Mi / 0.2 CPU. The limit is what a large
   * spreadsheet needs; one LibreOffice conversion runs at a time per pod.
   */
  resources: {
    requests: { cpu: "200m", memory: "512Mi" },
    limits: { cpu: "1", memory: "1Gi" },
  },
} as const;

/**
 * The read-only Postgres login KEDA's `postgresql` scaler counts the queues with
 * (ADR-0079). It is the one name the Cluster's managed roles, the grants Job and
 * the DSNs in `grid-secrets` must agree on. Its password is
 * `postgres.scalerPassword` (`config.ts`).
 */
export const KEDA_SCALER_ROLE = "grid_keda_scaler";

/**
 * `CONNECTION LIMIT` on {@link KEDA_SCALER_ROLE}: the operator opens one
 * connection per poll, and the role's own cap is the most it can ever hold.
 * Declared on the Cluster's managed role and counted in the pooler budget's
 * direct-connection reserve (`pgConnectionBudget`), so the two cannot disagree.
 */
export const KEDA_SCALER_CONNECTION_LIMIT = 8;
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
  /** Skill-scheduler poll interval (ms) and per-tick claim batch. */
  schedulerPollMs: 30_000,
  schedulerBatch: 20,
  /** Job run history retention (days). */
  skillRunsRetentionDays: 90,
  /**
   * How long Langfuse traces live before the scheduler deletes them (days).
   * Langfuse's own retention setting is Enterprise-only (ADR-0044); the
   * scheduler job reads this and never goes below Langfuse's minimum of 3.
   */
  langfuseTraceRetentionDays: 30,
} as const;

/** Postgres server tuning (fixed; storage size and instance count are knobs). */
export const POSTGRES_TUNING = {
  maxConnections: "200",
  sharedBuffers: "256MB",
} as const;

/**
 * The transaction pooler in front of the pooled DSNs (ADR-0083). The two sizes
 * that differ per stack (`pgPoolerInstances`, `pgPoolerPoolSize`) are knobs in
 * `config.ts`; these are fixed.
 */
export const POSTGRES_POOLER = {
  /** The CNPG `Pooler` resource, and the Service the pooled DSNs name. */
  name: "grid-pg-pooler-rw",
  /** Client connections one PgBouncer accepts. A few KB each, so far above what every tier opens. */
  maxClientConn: "2000",
  /**
   * Named prepared statements PgBouncer tracks per client connection. psycopg3
   * prepares a statement after its fifth run and asyncpg prepares every one, both
   * at the protocol level. In transaction mode PgBouncer (>= 1.21) maps their
   * names onto whichever server connection it hands over, which is why neither
   * driver needs a `prepare_threshold=None` style workaround here.
   */
  maxPreparedStatements: "200",
  /**
   * Server sessions each PgBouncer holds for its own `auth_query`
   * (`cnpg_pooler_pgbouncer` on `postgres`). One in the steady state; a second
   * while two new logins are checked at the same instant, which the CloudNativePG
   * part of {@link POSTGRES_DIRECT_RESERVE} absorbs.
   */
  authConnections: 1,
  resources: {
    requests: { cpu: "100m", memory: "64Mi" },
    limits: { cpu: "1", memory: "256Mi" },
  },
} as const;

/**
 * The (database, role) pairs the pooled DSNs connect as. PgBouncer keeps one
 * server pool per pair, so this count is what multiplies `pgPoolerPoolSize` in
 * the connection budget. `postgres.spec.ts` derives the same set from the
 * pooled env vars in `grid-secrets` and fails when the two differ, so a new
 * pooled DSN cannot be added without paying for it here.
 *
 * `app` is the owner login (`pgAppUser`), `runtime` is `grid_app_rw` (ADR-0041).
 */
export const POOLED_POOLS = [
  { database: "aiq_jobs", login: "app" },
  { database: "aiq_checkpoints", login: "app" },
  { database: "grid_app", login: "runtime" },
] as const;

/**
 * What the Postgres primary must keep free for connections that do NOT go
 * through the pooler, in `max_connections` slots (ADR-0083). `pgConnectionBudget`
 * adds these to the pooler's worst case and the plan fails when the sum passes
 * `POSTGRES_TUNING.maxConnections`. Each part names its bound, because a reserve
 * that is only a number is where the next person stops checking.
 */
export const POSTGRES_DIRECT_RESERVE = {
  /** `superuser_reserved_connections` (the PostgreSQL default). Counted inside `max_connections`. */
  superuser: 3,
  /**
   * CloudNativePG's own: the instance manager, its metrics exporter, and the
   * backup and archiving sessions. An estimate (two or three when idle, doubled
   * for a base backup running during a failover), not a measurement: read
   * `pg_stat_activity` on the primary before lowering it.
   */
  cnpg: 6,
  /**
   * `AIQ_LISTEN_DB_URL`: one asyncpg connection per open job SSE stream, held for
   * as long as the job runs, by the `api` role (the chat role serves no job
   * stream, ADR-0082). So the bound is the jobs and their viewers, not the number
   * of api pods: scaling `aiq-api` out spreads the streams, it adds none. Running jobs are bounded by the research tier
   * (`agentWorkerMaxReplicas` x `agentWorkerConcurrency`, 3 in prod) and each has a
   * handful of viewers. Nothing in the code caps the streams themselves, so this
   * is an allowance, not a limit.
   */
  sseListen: 20,
  /**
   * Session advisory locks (`AIQ_LOCK_DB_URL`) that are not tied to ingest
   * volume: the ghost-job reaper, the collection TTL cleanup, and an api
   * replica's own re-ingest. One connection each, held for the length of a cycle.
   * The ingest tier adds one `keyed_lock` per job in flight, counted separately.
   */
  sessionLocksBackground: 4,
  /**
   * Migration and bootstrap Jobs on the owner DSN: `pg-init-tables` (one psql at a
   * time), `grid-migrate` (`ensure-rls-roles` plus drizzle-kit) and the queue
   * scaler's grants. They overlap on a first deploy, so this is their sum rather
   * than their largest.
   */
  bootstrapJobs: 6,
  /**
   * Langfuse web and worker (Prisma, direct): Prisma sizes its pool at
   * `cpus * 2 + 1`, so two pods at four cores each. Counted only when the tier
   * is deployed.
   */
  langfuse: 20,
  /**
   * The SeaweedFS filer's `[postgres2]` store, per filer replica
   * (`connection_max_open` in `seaweedfs-split.ts`). Counted only when the filer
   * keeps its namespace in Postgres.
   */
  filerPerReplica: 40,
} as const;
