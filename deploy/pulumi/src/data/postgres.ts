import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedJobSecurityContext } from "../platform/security";

export interface Postgres {
  operator: k8s.helm.v3.Release;
  cluster: k8s.apiextensions.CustomResource;
  /** Job that ensures job/checkpoint tables exist (idempotent). */
  initJob: k8s.batch.v1.Job;
  /** Nightly PITR base-backup schedule (only when backups are enabled). */
  scheduledBackup?: k8s.apiextensions.CustomResource;
  /** Read/write service host (the CNPG primary), e.g. `grid-pg-rw`. */
  rwHost: string;
  /** Build a DSN for one of the three logical databases. */
  dsn: (opts: { db: string; driver?: string }) => pulumi.Output<string>;
}

/** Small resource envelope for the short-lived bootstrap Jobs. */
const JOB_RESOURCES = {
  requests: { cpu: "25m", memory: "64Mi" },
  limits: { cpu: "250m", memory: "256Mi" },
};

const CLUSTER_NAME = "grid-pg";

// Table DDL adapted from deploy/compose/init-db.sql, minus the psql
// meta-commands (\gexec/\connect) — CNPG creates the databases, this Job only
// creates tables. Every statement is IF NOT EXISTS, so re-runs are safe.
const JOBS_SQL = `
CREATE TABLE IF NOT EXISTS job_info (
  job_id VARCHAR PRIMARY KEY, status VARCHAR NOT NULL, config_file VARCHAR,
  error VARCHAR, output_path VARCHAR, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  expiry_seconds INTEGER, output VARCHAR, is_expired BOOLEAN DEFAULT FALSE);
CREATE INDEX IF NOT EXISTS idx_job_info_status ON job_info(status);
CREATE INDEX IF NOT EXISTS idx_job_info_created_at ON job_info(created_at);
CREATE TABLE IF NOT EXISTS job_access (
  job_id VARCHAR PRIMARY KEY, owner_auth_type VARCHAR NOT NULL, owner_subject VARCHAR NOT NULL,
  owner_email VARCHAR, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_job_access_owner ON job_access(owner_auth_type, owner_subject);
CREATE TABLE IF NOT EXISTS job_events (
  id SERIAL PRIMARY KEY, job_id VARCHAR(64) NOT NULL, event_type VARCHAR(64) NOT NULL,
  event_data TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_job_events_job_id_id ON job_events(job_id, id);
CREATE TABLE IF NOT EXISTS summaries (
  collection VARCHAR(256) NOT NULL, filename VARCHAR(512) NOT NULL, summary TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (collection, filename));
CREATE INDEX IF NOT EXISTS idx_summaries_collection ON summaries(collection);
`;

const CHECKPOINTS_SQL = `
CREATE TABLE IF NOT EXISTS checkpoint_migrations (v INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT, type TEXT, checkpoint JSONB NOT NULL, metadata JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));
CREATE TABLE IF NOT EXISTS checkpoint_blobs (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL,
  version TEXT NOT NULL, type TEXT NOT NULL, blob BYTEA,
  PRIMARY KEY (thread_id, checkpoint_ns, channel, version));
CREATE TABLE IF NOT EXISTS checkpoint_writes (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, blob BYTEA NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
`;

export function installPostgres(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  /** Gate the ScheduledBackup on the SeaweedFS bucket-init when backups are on. */
  backupDeps: pulumi.Resource[] = [],
): Postgres {
  // 1. CloudNativePG operator (cluster-wide; installs the CRDs we use below).
  const opNs = new k8s.core.v1.Namespace(
    "cnpg-system-ns",
    { metadata: { name: "cnpg-system" } },
    { provider },
  );

  const operator = new k8s.helm.v3.Release(
    "cloudnative-pg",
    {
      chart: "cloudnative-pg",
      // Unpinned: track the latest CloudNativePG operator chart.
      namespace: opNs.metadata.name,
      repositoryOpts: { repo: "https://cloudnative-pg.github.io/charts" },
      // The chart ships no resources by default; set both (autoscaler prereq).
      values: {
        resources: {
          requests: { cpu: "50m", memory: "128Mi" },
          limits: { cpu: "500m", memory: "512Mi" },
        },
      },
    },
    { provider, dependsOn: opNs },
  );

  // The CNPG chart ships no `startupapicheck` hook, so a "ready" operator
  // Deployment can briefly precede its validating/mutating webhook actually
  // serving TLS on :9443. Applying the Cluster CR into that window fails first
  // `pulumi up` with `failed calling webhook "vcluster.cnpg.io": ... connection
  // refused`, and Pulumi does not retry a CustomResource apply. Gate the Cluster
  // on the webhook endpoint actually accepting connections.
  const webhookReady = new k8s.batch.v1.Job(
    "cnpg-webhook-wait",
    {
      metadata: { namespace: opNs.metadata.name },
      spec: {
        backoffLimit: 30,
        ttlSecondsAfterFinished: 120,
        template: {
          spec: {
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "wait",
                image: "curlimages/curl:latest",
                securityContext: hardenedJobSecurityContext(),
                resources: JOB_RESOURCES,
                command: ["/bin/sh", "-c"],
                args: [
                  // Any HTTP response (even 404) means the webhook TLS listener
                  // is up; connection-refused/timeout keeps us waiting.
                  "echo 'waiting for cnpg webhook…'; " +
                    "until curl -sk -o /dev/null --max-time 5 " +
                    "https://cnpg-webhook-service.cnpg-system.svc:443/readyz; do sleep 3; done; " +
                    "echo 'cnpg webhook is serving'",
                ],
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn: operator },
  );

  // 2. App-role credentials as a basic-auth secret the cluster bootstrap uses,
  //    so the password is deterministic and we can build DSNs from it.
  const appSecret = new k8s.core.v1.Secret(
    "pg-app-credentials",
    {
      metadata: { name: `${CLUSTER_NAME}-app-credentials`, namespace },
      type: "kubernetes.io/basic-auth",
      stringData: {
        username: cfg.postgres.appUser,
        password: cfg.postgres.appPassword,
      },
    },
    { provider },
  );

  // 2b. Object-store credentials for continuous backup (only when enabled). The
  //     provider's StorageClasses reclaim `Delete`, so WAL archiving + scheduled
  //     base backups to SeaweedFS are the only path to point-in-time recovery
  //     after an accidental PVC/volume loss.
  const backupSecretName = "grid-pg-backup-s3"; // pragma: allowlist secret
  const backupSecret = cfg.postgres.backups.enabled
    ? new k8s.core.v1.Secret(
        "pg-backup-s3",
        {
          metadata: { name: backupSecretName, namespace },
          stringData: {
            // Defaults to the in-cluster SeaweedFS identity; overridable for an
            // external S3 endpoint (offsite PITR — see config.ts).
            ACCESS_KEY_ID: cfg.postgres.backups.accessKey ?? cfg.seaweedfs.accessKey,
            SECRET_ACCESS_KEY: cfg.postgres.backups.secretKey ?? cfg.seaweedfs.secretKey,
          },
        },
        { provider },
      )
    : undefined;

  // NOTE: this uses CNPG's in-tree `barmanObjectStore`. It is stable and works
  // on current operators but is being superseded by the barman-cloud plugin;
  // if a future auto-pulled operator (chart is unpinned) drops the in-tree path,
  // the webhook will reject this at `pulumi up` — switch to the plugin then.
  const backupSpec = cfg.postgres.backups.enabled
    ? {
        backup: {
          retentionPolicy: cfg.postgres.backups.retention,
          barmanObjectStore: {
            destinationPath: `s3://${cfg.postgres.backups.bucket}/`,
            endpointURL: cfg.postgres.backups.endpoint,
            s3Credentials: {
              accessKeyId: { name: backupSecretName, key: "ACCESS_KEY_ID" },
              secretAccessKey: { name: backupSecretName, key: "SECRET_ACCESS_KEY" },
            },
            wal: { compression: "gzip", maxParallel: 2 },
            data: { compression: "gzip" },
          },
        },
      }
    : {};

  // 3. The Postgres cluster. `aiq_jobs` is the bootstrapped app DB; the other
  //    two databases are created by postInitSQL (as superuser, once) owned by
  //    the app role, so the same credentials reach all three.
  const cluster = new k8s.apiextensions.CustomResource(
    "grid-pg",
    {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: CLUSTER_NAME, namespace, labels: commonLabels("postgres") },
      spec: {
        instances: cfg.postgres.instances,
        // Major-pinned, patch-floating: gets every 17.x minor/security patch
        // automatically (safe in-place for Postgres), but never auto-crosses a
        // major — CloudNativePG treats a major bump as a declarative migration,
        // and a floating `latest` could refuse to start on the old data dir.
        imageName: "ghcr.io/cloudnative-pg/postgresql:17",
        // Automatic switchover + rolling restart on operator/image updates — the
        // right default when the provider drains/replaces nodes on its own.
        primaryUpdateStrategy: cfg.postgres.primaryUpdateStrategy,
        // Keep primary and replicas off the same worker node so a single node
        // loss / upgrade drain can't take the whole cluster down. `preferred` so
        // a small (or single-node) cluster still schedules.
        affinity: {
          enablePodAntiAffinity: true,
          topologyKey: "kubernetes.io/hostname",
          podAntiAffinityType: "preferred",
        },
        storage: {
          size: cfg.postgres.storageSize,
          storageClass: cfg.storage.className,
        },
        bootstrap: {
          initdb: {
            database: "aiq_jobs",
            owner: cfg.postgres.appUser,
            secret: { name: appSecret.metadata.name },
            postInitSQL: [
              `CREATE DATABASE aiq_checkpoints OWNER ${cfg.postgres.appUser}`,
              `CREATE DATABASE grid_app OWNER ${cfg.postgres.appUser}`,
            ],
          },
        },
        // Sensible defaults; SSE LISTEN/NOTIFY needs a direct session, which it
        // gets since we hand the app the -rw service directly (no pooler here).
        postgresql: {
          parameters: {
            max_connections: "200",
            shared_buffers: "256MB",
          },
        },
        resources: {
          requests: { cpu: "500m", memory: "1Gi" },
          limits: { cpu: "2", memory: "4Gi" },
        },
        // Continuous WAL archiving + base-backup target (empty unless enabled).
        ...backupSpec,
      },
    },
    {
      provider,
      // backupDeps gates the CLUSTER (not just the ScheduledBackup) on the
      // backup bucket existing: WAL archiving starts the moment the cluster
      // boots and would otherwise race bucket-init into NoSuchBucket-degraded
      // ContinuousArchiving on every first deploy.
      dependsOn: [operator, webhookReady, ...(backupSecret ? [backupSecret] : []), ...backupDeps],
    },
  );

  const rwHost = `${CLUSTER_NAME}-rw`;

  const user = encodeURIComponent(cfg.postgres.appUser);
  const dsn = (opts: { db: string; driver?: string }): pulumi.Output<string> => {
    const scheme = opts.driver ?? "postgresql";
    // Percent-encode the password. The `pgAppPassword` value is documented as
    // `openssl rand -base64 24`, which routinely contains `/` or `+` — raw
    // interpolation there breaks URI parsing (asyncpg/psycopg/node-pg/psql all
    // misparse the authority), which looks like an auth failure across the whole
    // stack. Encoding in the DSN keeps the Postgres role password itself intact.
    return cfg.postgres.appPassword.apply(
      (pw) => `${scheme}://${user}:${encodeURIComponent(pw)}@${rwHost}:5432/${opts.db}`,
    );
  };

  // 4. Idempotent table bootstrap. Waits for the cluster's -rw service to
  //    answer, then applies the DDL to aiq_jobs and aiq_checkpoints.
  const initSqlCm = new k8s.core.v1.ConfigMap(
    "pg-init-sql",
    {
      metadata: { namespace },
      data: { "jobs.sql": JOBS_SQL, "checkpoints.sql": CHECKPOINTS_SQL },
    },
    { provider },
  );

  // DSNs embed the app password — put them in a Secret and env them via
  // secretKeyRef, so `kubectl get job/pod -o yaml` in the namespace doesn't
  // hand out the DB credential (the app tier already works this way).
  const initDsnSecret = new k8s.core.v1.Secret(
    "pg-init-dsns",
    {
      metadata: { namespace },
      stringData: {
        JOBS_DSN: dsn({ db: "aiq_jobs" }),
        CHECKPOINTS_DSN: dsn({ db: "aiq_checkpoints" }),
      },
    },
    { provider },
  );

  const initJob = new k8s.batch.v1.Job(
    "pg-init-tables",
    {
      metadata: { namespace },
      spec: {
        backoffLimit: 10,
        // Re-runs whenever the Job spec changes or `pulumi up --refresh` notices
        // the TTL reaped it — DDL is idempotent either way.
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: { labels: commonLabels("pg-init") },
          spec: {
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "psql",
                image: "postgres:17-alpine",
                securityContext: hardenedJobSecurityContext(),
                resources: JOB_RESOURCES,
                envFrom: [{ secretRef: { name: initDsnSecret.metadata.name } }],
                command: ["/bin/sh", "-c"],
                args: [
                  [
                    "echo 'waiting for postgres…';",
                    'until pg_isready -d "$JOBS_DSN" >/dev/null 2>&1; do sleep 2; done;',
                    'psql "$JOBS_DSN" -v ON_ERROR_STOP=1 -f /sql/jobs.sql;',
                    'psql "$CHECKPOINTS_DSN" -v ON_ERROR_STOP=1 -f /sql/checkpoints.sql;',
                    "echo 'db init complete';",
                  ].join(" "),
                ],
                volumeMounts: [{ name: "sql", mountPath: "/sql" }],
              },
            ],
            volumes: [{ name: "sql", configMap: { name: initSqlCm.metadata.name } }],
          },
        },
      },
    },
    { provider, dependsOn: [cluster, initSqlCm, initDsnSecret] },
  );

  // 5. Nightly base backup (WAL is archived continuously by the cluster above).
  //    Gated on the SeaweedFS bucket-init (passed via backupDeps) so the first
  //    run has a bucket to write to.
  const scheduledBackup = cfg.postgres.backups.enabled
    ? new k8s.apiextensions.CustomResource(
        "pg-scheduled-backup",
        {
          apiVersion: "postgresql.cnpg.io/v1",
          kind: "ScheduledBackup",
          metadata: { name: "grid-pg-nightly", namespace, labels: commonLabels("postgres") },
          spec: {
            schedule: cfg.postgres.backups.schedule,
            backupOwnerReference: "self",
            cluster: { name: CLUSTER_NAME },
            method: "barmanObjectStore",
            // Take the first base backup immediately on creation — without it
            // PITR is impossible until the first scheduled (02:00) run.
            immediate: true,
          },
        },
        { provider, dependsOn: [cluster, ...backupDeps] },
      )
    : undefined;

  return { operator, cluster, initJob, scheduledBackup, rwHost, dsn };
}
