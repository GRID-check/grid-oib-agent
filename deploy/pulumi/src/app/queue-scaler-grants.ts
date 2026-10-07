import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, appPullPolicy, backendImage } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedContainerSecurityContext, hardenedJobSecurityContext } from "../platform/security";
import {
  BOOTSTRAP_JOB_RESOURCES,
  JOB_DEFAULTS,
  KEDA_SCALER_ROLE,
  LIGHT_WORKER_RESOURCES,
  UID,
} from "../constants";
import { AppWiring } from "./config";
import { QUEUE_TABLE as RESEARCH_TABLE } from "./agent-worker";
import { QUEUE_TABLE as BFF_TABLE } from "./bff-jobs";
import { QUEUE_TABLE as INGEST_TABLE } from "./ingest-worker";

/**
 * What the read-only scaler login may read, and the step that makes the tables it
 * reads exist (ADR-0079).
 *
 * KEDA's `postgresql` scaler runs one `COUNT(*)` per queue. It used to do so as
 * the schema owner of `aiq_jobs` and of `grid_app`, which meant a credential
 * held by an operator in another namespace could write every table in both. The
 * login it reads through now (`KEDA_SCALER_ROLE`, declared with the other roles
 * in `data/postgres.ts`) has SELECT on the queue tables and nothing else. That
 * needs two things the Cluster cannot say, and this Job does them once per
 * deploy, after the migrations Job:
 *
 *   1. THE TABLES EXIST FIRST. The Python queues create their tables the first
 *      time any process touches them, so on a fresh stack a scaler that is
 *      created before the first worker boots reads a table that is not there and
 *      errors on every poll, and a `GRANT` on it would fail the same way. An
 *      init container runs the queues' own `ensure_table` (the one definition of
 *      their schema, and the upgrade path of an older table) before anything is
 *      granted. The bff_job_queue's table is the migrations Job's, which this Job
 *      runs after.
 *   2. THE GRANTS. SELECT on the one column the count reads, `status`, on each
 *      table, per database. A table-wide SELECT would let a leaked scaler DSN
 *      read every tenant's `payload` (a research report, a requester's email and
 *      permissions, storage keys and, on the Python queues, presigned URLs): the
 *      count never needs them, and `COUNT(*)` needs only one readable column. An
 *      earlier version of this Job granted the whole table, so each run REVOKEs
 *      that first. `bff_job_queue` is row level secured per organisation and the
 *      scaler's one read crosses every lane, so it also gets a policy of its own,
 *      for SELECT only and for this role only. That is the narrowest way across
 *      the boundary: `BYPASSRLS` would be an attribute of the role, to hold for
 *      whatever it is ever granted next, and the tenant policy
 *      (`grid_tenant_isolation`) is left as the migrations wrote it.
 *
 * Idempotent, so it re-runs whenever its spec changes (every per-SHA image pin)
 * and the Python init container doubles as the upgrade of a queue table.
 *
 * Every ScaledObject, and the TriggerAuthentication that points an existing one at
 * this login, is created after this Job (`index.ts`), so a scaler never counts a
 * table it cannot read. If a table is missing the Job fails loudly
 * (`ON_ERROR_STOP`); the role CloudNativePG reconciles asynchronously is waited for.
 */

/** The queue tables of the aiq_jobs database a stack with these tiers needs the scaler to read. */
export function jobsDatabaseTables(cfg: Pick<GridConfig, "jobExecution" | "ingestWorker">): string[] {
  return [
    ...(cfg.ingestWorker.enabled ? [INGEST_TABLE] : []),
    ...(cfg.jobExecution === "db" ? [RESEARCH_TABLE] : []),
  ];
}

/** What the scaler may read of a queue table: the column its `COUNT(*) ... WHERE status <> 'dead'` filters on. */
export const SCALER_READABLE_COLUMNS = ["status"] as const;

/**
 * The rights the scaler holds on `tables`: the table-wide SELECT an earlier
 * version granted is taken back, then SELECT on `SCALER_READABLE_COLUMNS` only.
 */
function scalerTableGrants(tables: string): string {
  return (
    `REVOKE SELECT ON ${tables} FROM ${KEDA_SCALER_ROLE};\n` +
    `GRANT SELECT (${SCALER_READABLE_COLUMNS.join(", ")}) ON ${tables} TO ${KEDA_SCALER_ROLE};\n`
  );
}

/** The `GRANT` for the Python queues, as run against `aiq_jobs`. */
export function jobsGrantsSql(tables: string[]): string {
  return scalerTableGrants(tables.join(", "));
}

/**
 * The grants for the BFF queue, as run against `grid_app`: SELECT on `status`, and the one
 * policy that lets the scaler's read cross the organisation boundary. Dropped
 * first so a re-run replaces it rather than failing on it.
 */
export function appGrantsSql(): string {
  const policy = "grid_keda_scaler_count";
  return (
    scalerTableGrants(BFF_TABLE) +
    `DROP POLICY IF EXISTS ${policy} ON ${BFF_TABLE};\n` +
    `CREATE POLICY ${policy} ON ${BFF_TABLE} FOR SELECT TO ${KEDA_SCALER_ROLE} USING (true);\n`
  );
}

/**
 * The Python that creates the queue tables, from the modules that own them. It
 * names the same environment the worker reads (`ingest_queue.db_url`,
 * `NAT_JOB_STORE_DB_URL`), so the tables land in the database the worker
 * will look in.
 */
export function ensureTablesPython(cfg: Pick<GridConfig, "jobExecution" | "ingestWorker">): string {
  const lines = [
    "import os",
    ...(cfg.ingestWorker.enabled ? ["from aiq_agent.knowledge import ingest_queue"] : []),
    ...(cfg.jobExecution === "db" ? ["from aiq_api.jobs import queue"] : []),
    ...(cfg.ingestWorker.enabled ? ["ingest_queue.ensure_table(ingest_queue.db_url())"] : []),
    ...(cfg.jobExecution === "db" ? ['queue.ensure_research_queue_table(os.environ["NAT_JOB_STORE_DB_URL"])'] : []),
  ];
  return lines.join("\n");
}

export function installQueueScalerGrants(
  w: AppWiring,
  cfg: GridConfig,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  const jobsTables = jobsDatabaseTables(cfg);
  const bff = cfg.bffJobs.enabled;
  const labels = commonLabels("keda-scaler-grants");

  const sql = new k8s.core.v1.ConfigMap(
    "keda-scaler-grants-sql",
    {
      metadata: { namespace: w.namespace, labels },
      data: {
        ...(jobsTables.length ? { "jobs.sql": jobsGrantsSql(jobsTables) } : {}),
        ...(bff ? { "app.sql": appGrantsSql() } : {}),
      },
    },
    // The Job re-runs when its SQL changes.
    { provider: w.provider, replaceOnChanges: ["data"] },
  );

  // The owner's DSNs, in a Secret of this Job's own like the init Job's: `kubectl
  // get job -o yaml` then shows no credential. The driver-qualified ones are what
  // the Python queues read.
  const dsns = new k8s.core.v1.Secret(
    "keda-scaler-grants-dsns",
    {
      metadata: { namespace: w.namespace, labels },
      stringData: {
        JOBS_DSN: w.dsn({ db: "aiq_jobs" }),
        APP_DSN: w.dsn({ db: "grid_app" }),
        NAT_JOB_STORE_DB_URL: w.dsn({ db: "aiq_jobs", driver: "postgresql+asyncpg" }),
        AIQ_SUMMARY_DB: w.dsn({ db: "aiq_jobs", driver: "postgresql+psycopg" }),
      },
    },
    { provider: w.provider },
  );

  const waitForRole =
    `until [ "$(psql "$JOBS_DSN" -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${KEDA_SCALER_ROLE}'")" = 1 ]; ` +
    "do sleep 3; done;";
  const script = [
    "echo 'waiting for the scaler role…';",
    waitForRole,
    ...(jobsTables.length ? ['psql "$JOBS_DSN" -v ON_ERROR_STOP=1 -f /sql/jobs.sql;'] : []),
    ...(bff ? ['psql "$APP_DSN" -v ON_ERROR_STOP=1 -f /sql/app.sql;'] : []),
    "echo 'scaler grants complete';",
  ].join(" ");

  return new k8s.batch.v1.Job(
    "keda-scaler-grants",
    {
      metadata: { namespace: w.namespace, labels },
      spec: {
        backoffLimit: JOB_DEFAULTS.backoffLimit,
        ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            restartPolicy: "OnFailure",
            initContainers: jobsTables.length
              ? [
                  {
                    name: "queue-tables",
                    image: backendImage(cfg),
                    imagePullPolicy: appPullPolicy(cfg, backendImage(cfg)),
                    securityContext: {
                      ...hardenedContainerSecurityContext(),
                      runAsNonRoot: true,
                      runAsUser: UID.backend,
                      runAsGroup: UID.backend,
                    },
                    // Not the image's entrypoint: no role to run, only the schema.
                    command: ["python", "-c", ensureTablesPython(cfg)],
                    envFrom: [{ secretRef: { name: dsns.metadata.name } }],
                    resources: LIGHT_WORKER_RESOURCES,
                  },
                ]
              : [],
            containers: [
              {
                name: "psql",
                image: "postgres:17-alpine",
                securityContext: hardenedJobSecurityContext(),
                resources: BOOTSTRAP_JOB_RESOURCES,
                envFrom: [{ secretRef: { name: dsns.metadata.name } }],
                command: ["/bin/sh", "-c"],
                args: [script],
                volumeMounts: [{ name: "sql", mountPath: "/sql" }],
              },
            ],
            volumes: [{ name: "sql", configMap: { name: sql.metadata.name } }],
          },
        },
      },
    },
    // `dependsOn` is the cluster (the role) and the migrations Job (`bff_job_queue`).
    {
      provider: w.provider,
      dependsOn: [sql, dsns, ...dependsOn],
      // The init container pulls the backend image, which on a node that has not
      // run it is minutes, and the role may take a reconcile or two to appear.
      customTimeouts: { create: "20m", update: "20m" },
    },
  );
}
