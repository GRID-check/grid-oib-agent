import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedJobSecurityContext } from "../platform/security";
import {
  BOOTSTRAP_JOB_RESOURCES,
  DATA_RESOURCES,
  JOB_DEFAULTS,
  LANGFUSE,
  PLATFORM_RESOURCES,
  PORT,
  POSTGRES_TUNING,
} from "../constants";

export interface Postgres {
  operator: k8s.helm.v3.Release;
  cluster: k8s.apiextensions.CustomResource;
  /** Job that ensures job/checkpoint tables exist (idempotent). */
  initJob: k8s.batch.v1.Job;
  /** Read/write service host (the CNPG primary), e.g. `grid-pg-rw`. */
  rwHost: string;
  /** Build a DSN for one of the three logical databases. */
  dsn: (opts: { db: string; driver?: string }) => pulumi.Output<string>;
  /**
   * Resources the SeaweedFS filer must wait for before it can open its store
   * (ADR-0043): the dedicated role, its database, and the grant lockdown.
   * Empty when the filer is not using Postgres.
   */
  filerStoreDeps: pulumi.Resource[];
  /**
   * DSN for the Langfuse database as its own owning role (ADR-0044), or
   * undefined when the tier is not deployed.
   */
  langfuseDsn?: pulumi.Output<string>;
  /**
   * Resources Langfuse must wait for before its Prisma migrations can run: the
   * dedicated role and its database. Empty when the tier is not deployed.
   */
  langfuseStoreDeps: pulumi.Resource[];
}

const CLUSTER_NAME = "grid-pg";
export const CNPG_CHART_REPOSITORY =
  "https://raw.githubusercontent.com/cloudnative-pg/charts/gh-pages";

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

/**
 * Lock down the filer's database (ADR-0043).
 *
 * PostgreSQL grants `CONNECT` on every new database to `PUBLIC`, which here
 * means the application logins can open a session against the store holding an
 * AES key for every chunk in the object store. They would find no tables they
 * could read — the filer owns them and grants nothing — but "the grant table
 * happens to be empty" is not a boundary, and `[postgres2]` creates a new table
 * per bucket at runtime, so the set of objects to protect is not even fixed.
 *
 * Run as the database OWNER, which is exactly the privilege needed and nothing
 * more. Idempotent: re-revoking an absent grant is a no-op.
 */
const seaweedFilerSql = (database: string): string =>
  `REVOKE CONNECT ON DATABASE "${database}" FROM PUBLIC;\n`;

/**
 * Which TLS query parameter this driver understands.
 *
 * A named function rather than an inline ternary because the two names are not
 * interchangeable and the failure is not a downgrade — it is a refusal to
 * connect, at runtime, on a stack that planned and deployed cleanly.
 *
 * `asyncpg` takes `ssl`. SQLAlchemy's asyncpg dialect passes the URL's query
 * keys straight through — `opts.update(url.query)`, with no translation
 * (verified against the installed SQLAlchemy 2.0.51,
 * `dialects/postgresql/asyncpg.py`) — and `asyncpg.connect()` has an `ssl`
 * parameter and no `**kwargs`, so a `sslmode` key arrives as an unexpected
 * keyword argument and the job store dies on its first connection.
 *
 * Everything else here is libpq or postgres-js (psycopg, psql, barman, node),
 * all of which take `sslmode`. `ssl=require` means to asyncpg what
 * `sslmode=require` means to them: encrypt, do not verify the CA.
 */
export function sslParamFor(driver: string): "ssl" | "sslmode" {
  return driver.includes("asyncpg") ? "ssl" : "sslmode";
}

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
      repositoryOpts: { repo: CNPG_CHART_REPOSITORY },
      // The chart ships no resources by default; set both (autoscaler prereq).
      values: { resources: PLATFORM_RESOURCES.cnpgOperator },
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
                resources: BOOTSTRAP_JOB_RESOURCES,
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

  /**
   * Login for `grid_app_rw`, the least-privilege role the app tier connects as
   * under row-level security (ADR-0041).
   *
   * CloudNativePG reads this and reconciles the role's password itself, as
   * superuser. That is the whole reason the roles are declared on the Cluster
   * rather than created by a migration: `grid_app_platform` needs BYPASSRLS,
   * and Postgres only lets a role grant an attribute it already holds — which
   * the application user does not, and must not.
   */
  const runtimeCredentials = new k8s.core.v1.Secret(
    "pg-runtime-credentials",
    {
      metadata: { name: `${CLUSTER_NAME}-runtime-credentials`, namespace },
      type: "kubernetes.io/basic-auth",
      stringData: {
        username: "grid_app_rw",
        password: cfg.postgres.runtimePassword,
      },
    },
    { provider },
  );

  /**
   * Login for the SeaweedFS filer's metadata store (ADR-0043).
   *
   * Its own role and its own database, deliberately not one of the three
   * application databases and deliberately not the application login. The
   * filer store holds an AES key for every chunk in the object store, so a
   * credential that reaches it must not also reach `grid_app`, and vice versa:
   * compromising the storage daemon should not yield the tenant database, and
   * compromising the app should not yield the keys to decrypt objects it was
   * never authorized to read.
   *
   * Declared here for the same reason the RLS roles are: CloudNativePG
   * reconciles it as superuser, so the role exists before anything tries to log
   * in as it.
   */
  const filerStoreEnabled =
    cfg.seaweedfs.topology === "split" && cfg.seaweedfs.filerStore === "postgres";

  const filerCredentials = filerStoreEnabled
    ? new k8s.core.v1.Secret(
        "pg-seaweedfs-filer-credentials",
        {
          metadata: { name: `${CLUSTER_NAME}-seaweedfs-filer-credentials`, namespace },
          type: "kubernetes.io/basic-auth",
          stringData: {
            username: cfg.seaweedfs.filerDatabaseUser,
            password: cfg.seaweedfs.filerDatabasePassword,
          },
        },
        { provider },
      )
    : undefined;

  /**
   * Login for Langfuse's own database (ADR-0044).
   *
   * Its own role and its own database, on the same reasoning as the filer's
   * above. Langfuse runs Prisma migrations at startup — `CREATE TABLE`,
   * `ALTER TABLE`, `DROP` — so whatever credential it holds is a credential
   * with DDL rights. Confining that to a database it owns is what keeps a
   * third-party image's migrator away from `grid_app`, where every tenant's
   * conversations live. It has no CREATEDB and no CREATEROLE, so it cannot
   * give itself another database either.
   */
  const langfuseCredentials = cfg.langfuse.enabled
    ? new k8s.core.v1.Secret(
        "pg-langfuse-credentials",
        {
          metadata: { name: `${CLUSTER_NAME}-langfuse-credentials`, namespace },
          type: "kubernetes.io/basic-auth",
          stringData: {
            username: LANGFUSE.databaseUser,
            password: cfg.langfuse.databasePassword,
          },
        },
        { provider },
      )
    : undefined;

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
  //
  // ENCRYPTION. `encryption` is a field of `wal` and `data`, NOT of
  // `barmanObjectStore` itself, and its CRD enum is `AES256;"aws:kms"` with no
  // empty member — so "inherit the bucket policy" is the key being ABSENT, and
  // emitting `encryption: ""` would be rejected by the webhook. That is why this
  // spreads conditionally instead of always setting the field.
  //
  // What it actually does: barman-cloud sends `--encryption`, which becomes an
  // `x-amz-server-side-encryption` header on the PUT. It therefore encrypts
  // exactly nothing unless the DESTINATION implements SSE. The default
  // destination is this cluster's own SeaweedFS, which does not: SSE-S3/KMS/C
  // land in 3.97, prod pins 3.80, and even a newer image would need a KMS this
  // program never configures. SeaweedFS answers such a PUT 200 and writes the
  // object in the clear, so the header would leave "encryption: AES256" in the
  // Cluster spec while the bytes are plaintext. `loadConfig` refuses that
  // combination outright; the knob is here for a real external S3 destination.
  //
  // With the in-cluster destination and no SSE, the archive — every row of every
  // database, WAL included — is at rest exactly as protected as the SeaweedFS
  // volumes underneath it (`seaweedfsEncryptVolumeData`) and nothing more. Said
  // plainly in docs/deployment/kubernetes.md § Encryption posture.
  const backupEncryption = cfg.postgres.backups.encryption;
  const encryptionField = backupEncryption ? { encryption: backupEncryption } : {};
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
            wal: { compression: "gzip", maxParallel: 2, ...encryptionField },
            data: { compression: "gzip", ...encryptionField },
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
        // Row-level-security roles (ADR-0041). Declared here, NOT in a migration:
        // creating a BYPASSRLS role requires the creator to hold BYPASSRLS
        // itself, and the application user has neither that nor CREATEROLE.
        // The operator reconciles these as superuser, so they exist before the
        // migration Job runs — and migration 0030 asserts exactly that rather
        // than trying to create them.
        managed: {
          roles: [
            { name: "grid_app_owner", ensure: "present", login: true, superuser: false, createdb: false, createrole: false },
            { name: "grid_app_platform", ensure: "present", login: false, bypassrls: true },
            {
              name: "grid_app_rw",
              ensure: "present",
              login: true,
              inherit: false,
              bypassrls: false,
              inRoles: ["grid_app_platform"],
              passwordSecret: { name: runtimeCredentials.metadata.apply((m) => m!.name!) },
            },
            // The SeaweedFS filer's own login (ADR-0043). It owns exactly one
            // database and needs DDL inside it — the `[postgres2]` store
            // creates a table per S3 bucket on demand, which is what makes
            // dropping a tenant a DROP TABLE instead of a row sweep. That DDL
            // right is confined to a database it owns; it has no CREATEDB and
            // no CREATEROLE, so it cannot make itself another one.
            ...(filerCredentials
              ? [
                  {
                    name: cfg.seaweedfs.filerDatabaseUser,
                    ensure: "present",
                    login: true,
                    superuser: false,
                    createdb: false,
                    createrole: false,
                    bypassrls: false,
                    passwordSecret: { name: filerCredentials.metadata.apply((m) => m!.name!) },
                  },
                ]
              : []),
            // Langfuse's own login (ADR-0044) — same shape and same reasoning
            // as the filer's: DDL inside one database it owns, nothing outside.
            ...(langfuseCredentials
              ? [
                  {
                    name: LANGFUSE.databaseUser,
                    ensure: "present",
                    login: true,
                    superuser: false,
                    createdb: false,
                    createrole: false,
                    bypassrls: false,
                    passwordSecret: { name: langfuseCredentials.metadata.apply((m) => m!.name!) },
                  },
                ]
              : []),
          ],
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
            max_connections: POSTGRES_TUNING.maxConnections,
            shared_buffers: POSTGRES_TUNING.sharedBuffers,
          },
        },
        resources: DATA_RESOURCES.postgres,
        // Continuous WAL archiving + base-backup target (empty unless enabled).
        ...backupSpec,
      },
    },
    {
      provider,
      // `backupDeps` gates the CLUSTER on the archive bucket existing, where
      // the ordering allows it: WAL archiving starts the moment the cluster
      // boots and would otherwise race bucket-init into NoSuchBucket-degraded
      // ContinuousArchiving on every first deploy. It is EMPTY in the one
      // configuration where SeaweedFS depends on Postgres rather than the other
      // way round (split topology, Postgres filer store), because there the
      // gate would be a cycle. That is survivable for WAL — `archive_command`
      // retries indefinitely — which is exactly why the one-shot base backup is
      // NOT created here; see `installScheduledBackup`.
      dependsOn: [operator, webhookReady, ...(backupSecret ? [backupSecret] : []), ...backupDeps],
      // The single most destructive resource in the program. CloudNativePG OWNS
      // the cluster's PVCs, so unlike the StatefulSets (whose PVCs are pinned
      // Retain) deleting this CR takes every database with it — irreversibly on
      // a `Delete`-reclaim StorageClass, and completely if pgBackupsEnabled is
      // off. `protect` makes Pulumi refuse the delete/replace outright.
      // Deliberate teardown: `pulumi state unprotect <urn>` first.
      protect: cfg.protectDataResources,
    },
  );

  const rwHost = `${CLUSTER_NAME}-rw`;

  /**
   * The filer's database, declared rather than bootstrapped.
   *
   * `bootstrap.initdb.postInitSQL` — where `aiq_checkpoints` and `grid_app` are
   * created — runs EXACTLY ONCE, at cluster initialisation. Adding a fourth
   * database there would create it on a fresh stack and silently do nothing on
   * every existing one, which is the worst of both: the manifest would claim a
   * database that, on the cluster that matters, does not exist. The `Database`
   * CR is reconciled continuously by the operator instead, so it converges on
   * a running cluster.
   *
   * `databaseReclaimPolicy: retain` (the CRD default, pinned here because it is
   * load-bearing): deleting this CR must not drop the database. Under volume
   * encryption that database holds the only copy of every chunk key — dropping
   * it turns the entire object store into ciphertext nobody can open.
   */
  const filerDatabase = filerCredentials
    ? new k8s.apiextensions.CustomResource(
        "pg-seaweedfs-filer-db",
        {
          apiVersion: "postgresql.cnpg.io/v1",
          kind: "Database",
          metadata: {
            // The CR's own object name, which must be a DNS-1123 subdomain —
            // no underscores. The DATABASE and the ROLE keep the underscore
            // (`spec.name` / `spec.owner` below), because those are Postgres
            // identifiers and a hyphen there would need quoting everywhere it
            // appears. Getting this wrong is not a subtle failure: the API
            // server rejects the CR outright, `pg-init-tables` never runs
            // because it waits on it, and the filer never starts.
            name: cfg.seaweedfs.filerDatabase.replace(/_/g, "-"),
            namespace,
            labels: commonLabels("postgres"),
          },
          spec: {
            cluster: { name: CLUSTER_NAME },
            name: cfg.seaweedfs.filerDatabase,
            owner: cfg.seaweedfs.filerDatabaseUser,
            ensure: "present",
            databaseReclaimPolicy: "retain",
          },
        },
        { provider, dependsOn: [cluster], protect: cfg.protectDataResources },
      )
    : undefined;

  /**
   * Langfuse's database (ADR-0044), declared as a `Database` CR for the same
   * reason the filer's is: `bootstrap.initdb.postInitSQL` runs EXACTLY ONCE at
   * cluster initialisation, so adding a database there would create it on a
   * fresh stack and silently do nothing on every existing one. The operator
   * reconciles this CR continuously, so it converges on a running cluster —
   * which is the only case that matters, since this tier is being added to
   * clusters that already exist.
   *
   * `databaseReclaimPolicy: retain`: deleting the CR (turning
   * `langfuseEnabled` off, renaming a resource) must not drop the database.
   * It holds the API keys, the SSO account links and the prompt history —
   * none of which is in ClickHouse and none of which the traces can rebuild.
   */
  const langfuseDatabase = langfuseCredentials
    ? new k8s.apiextensions.CustomResource(
        "pg-langfuse-db",
        {
          apiVersion: "postgresql.cnpg.io/v1",
          kind: "Database",
          metadata: {
            // DNS-1123 for the CR's object name; the DATABASE and ROLE keep
            // their Postgres-identifier spelling in `spec` below.
            name: LANGFUSE.database.replace(/_/g, "-"),
            namespace,
            labels: commonLabels("postgres"),
          },
          spec: {
            cluster: { name: CLUSTER_NAME },
            name: LANGFUSE.database,
            owner: LANGFUSE.databaseUser,
            ensure: "present",
            databaseReclaimPolicy: "retain",
          },
        },
        { provider, dependsOn: [cluster], protect: cfg.protectDataResources },
      )
    : undefined;

  const appUser = encodeURIComponent(cfg.postgres.appUser);
  /**
   * Build a DSN. `as` selects a non-default role — used for the least-privilege
   * runtime credential (ADR-0041), which is the same cluster with a different
   * login, not a different database.
   */
  const dsn = (opts: {
    db: string;
    driver?: string;
    as?: { user: string; password: pulumi.Output<string> };
  }): pulumi.Output<string> => {
    const scheme = opts.driver ?? "postgresql";
    const user = opts.as ? encodeURIComponent(opts.as.user) : appUser;
    const password = opts.as ? opts.as.password : cfg.postgres.appPassword;
    // Percent-encode the password. The `pgAppPassword` value is documented as
    // `openssl rand -base64 24`, which routinely contains `/` or `+` — raw
    // interpolation there breaks URI parsing (asyncpg/psycopg/node-pg/psql all
    // misparse the authority), which looks like an auth failure across the whole
    // stack. Encoding in the DSN keeps the Postgres role password itself intact.
    // `sslmode=require` on every DSN. CloudNativePG serves TLS on 5432 with a
    // cert it manages, but nothing was asking for it: postgres-js defaults to
    // `ssl: false` and libpq defaults to `prefer`, which silently downgrades.
    // So the role password crossed the pod network in the startup packet, and
    // every row of every query followed it in cleartext — on a namespace where
    // the NetworkPolicy lets ANY pod reach 5432.
    //
    // `require` (encrypt, do not verify the CA) rather than `verify-full`
    // deliberately: CNPG issues its own internal CA, and pinning it here means
    // shipping that CA to five different clients (node, asyncpg, psycopg, psql,
    // barman) and rotating it in lockstep. `require` closes the passive-sniff
    // hole today with no moving parts; `verify-full` closes active MITM and is
    // the documented follow-up.
    //
    // The parameter NAME is driver-specific — see `sslParamFor`.
    const sslParam = sslParamFor(scheme);
    return password.apply(
      (pw) =>
        `${scheme}://${user}:${encodeURIComponent(pw)}@${rwHost}:${PORT.postgres}/${opts.db}` +
        `?${sslParam}=require`,
    );
  };

  // 4. Idempotent table bootstrap. Waits for the cluster's -rw service to
  //    answer, then applies the DDL to aiq_jobs and aiq_checkpoints.
  const initSqlCm = new k8s.core.v1.ConfigMap(
    "pg-init-sql",
    {
      metadata: { namespace },
      data: {
        "jobs.sql": JOBS_SQL,
        "checkpoints.sql": CHECKPOINTS_SQL,
        ...(filerCredentials
          ? { "seaweedfs-filer.sql": seaweedFilerSql(cfg.seaweedfs.filerDatabase) }
          : {}),
      },
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
        // As the filer's own role, which is the only login that can revoke a
        // grant on the database it owns — the app user has no rights there at
        // all, which is the whole point.
        ...(filerCredentials
          ? {
              SEAWEED_FILER_DSN: dsn({
                db: cfg.seaweedfs.filerDatabase,
                as: {
                  user: cfg.seaweedfs.filerDatabaseUser,
                  password: cfg.seaweedfs.filerDatabasePassword,
                },
              }),
            }
          : {}),
      },
    },
    { provider },
  );

  const initJob = new k8s.batch.v1.Job(
    "pg-init-tables",
    {
      metadata: { namespace },
      spec: {
        backoffLimit: JOB_DEFAULTS.backoffLimit,
        // Re-runs whenever the Job spec changes or `pulumi up --refresh` notices
        // the TTL reaped it — DDL is idempotent either way.
        ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
        template: {
          metadata: { labels: commonLabels("pg-init") },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "psql",
                image: "postgres:17-alpine",
                securityContext: hardenedJobSecurityContext(),
                resources: BOOTSTRAP_JOB_RESOURCES,
                envFrom: [{ secretRef: { name: initDsnSecret.metadata.name } }],
                command: ["/bin/sh", "-c"],
                args: [
                  [
                    "echo 'waiting for postgres…';",
                    'until pg_isready -d "$JOBS_DSN" >/dev/null 2>&1; do sleep 2; done;',
                    'psql "$JOBS_DSN" -v ON_ERROR_STOP=1 -f /sql/jobs.sql;',
                    'psql "$CHECKPOINTS_DSN" -v ON_ERROR_STOP=1 -f /sql/checkpoints.sql;',
                    // The filer database is reconciled by the CNPG operator, not
                    // by the cluster bootstrap, so it can appear seconds AFTER
                    // the cluster is ready. Wait for it rather than racing it —
                    // and wait with a real connection, because `pg_isready`
                    // reports the SERVER, not whether this database exists yet.
                    ...(filerCredentials
                      ? [
                          "echo 'waiting for the seaweedfs filer database…';",
                          'until psql "$SEAWEED_FILER_DSN" -c "select 1" >/dev/null 2>&1;',
                          "do sleep 2; done;",
                          'psql "$SEAWEED_FILER_DSN" -v ON_ERROR_STOP=1 -f /sql/seaweedfs-filer.sql;',
                        ]
                      : []),
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
    {
      provider,
      dependsOn: [
        cluster,
        initSqlCm,
        initDsnSecret,
        ...(filerDatabase ? [filerDatabase] : []),
      ],
    },
  );

  // The filer must not open its store until the role, the database and the
  // CONNECT lockdown are all in place. The init Job is the last of the three,
  // so it is the one to gate on — and it is also the step that proves the
  // database is actually reachable, not merely declared.
  const filerStoreDeps: pulumi.Resource[] = filerDatabase ? [filerDatabase, initJob] : [];

  // Langfuse gates on the DATABASE CR only, not on `initJob` the way the filer
  // does. The difference is real: the filer needs the init Job because that Job
  // is what revokes `CONNECT` from `PUBLIC` on its database, and it needs
  // tables created for it. Langfuse creates its own schema with Prisma and
  // needs nothing bootstrapped, so gating it on a Job that does no work on its
  // behalf would only couple its rollout to unrelated DDL.
  const langfuseStoreDeps: pulumi.Resource[] = langfuseDatabase ? [langfuseDatabase] : [];

  return {
    operator,
    cluster,
    initJob,
    rwHost,
    dsn,
    filerStoreDeps,
    langfuseStoreDeps,
    langfuseDsn: cfg.langfuse.enabled
      ? dsn({
          db: LANGFUSE.database,
          as: { user: LANGFUSE.databaseUser, password: cfg.langfuse.databasePassword },
        })
      : undefined,
  };
}

/**
 * The nightly base backup, as a resource of its own rather than part of
 * `installPostgres`.
 *
 * It is separated because of an ordering problem that only appears in one
 * configuration and is invisible in the others. `immediate: true` fires a
 * Backup the moment the CR is created, and CloudNativePG does **not** retry a
 * failed `Backup` object — the next attempt is the cron, i.e. 02:00 the
 * following day. So a first Backup that lands before the archive bucket exists
 * leaves the stack with archived WAL and no base backup, which is not a
 * recoverable PITR, while `kubectl cnpg status` reports continuous archiving as
 * healthy.
 *
 * Under the split topology with the Postgres filer store, Postgres has to be
 * created BEFORE SeaweedFS (the filer cannot open its store otherwise), so the
 * bucket genuinely does not exist yet at that point. WAL archiving survives
 * that — `archive_command` retries indefinitely and pg_wal buffers — but the
 * one-shot base backup does not. Creating the schedule here, after
 * `bucketInitJob`, is what makes the first backup succeed in every topology.
 */
export function installScheduledBackup(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  /** The cluster, and the Job that proves the archive bucket exists. */
  dependsOn: pulumi.Resource[],
): k8s.apiextensions.CustomResource | undefined {
  if (!cfg.postgres.backups.enabled) return undefined;
  return new k8s.apiextensions.CustomResource(
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
        // Take the first base backup immediately on creation — without it there
        // is no PITR at all until the first scheduled run. See the header for
        // why that makes this resource's ordering load-bearing.
        immediate: true,
      },
    },
    { provider, dependsOn },
  );
}
