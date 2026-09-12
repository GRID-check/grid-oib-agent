import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, pullPolicyFor } from "../config";
import { commonLabels } from "../platform/namespaces";
import {
  ROLLOUT,
  gracefulShutdown,
  orderedRollout,
  secretChecksum,
  secretChecksumAnnotations,
} from "../platform/rollout";
import { DATA_RESOURCES, LANGFUSE, PORT } from "../constants";

/** Secret key holding the ClickHouse login password. */
export const CLICKHOUSE_PASSWORD_SECRET_KEY = "clickhouse-password"; // pragma: allowlist secret (Secret key name, not a credential)

const SECRET_NAME = "clickhouse-auth"; // pragma: allowlist secret (Kubernetes Secret resource name, not a credential)

/**
 * How long ClickHouse keeps its own diagnostic logs: fourteen days.
 *
 * These are logs ABOUT the server, not the product's trace data, and nothing
 * on this stack reads them after the incident they belong to is over. Two
 * weeks covers the last deploy cycle; anything older is disk with no reader.
 */
const SYSTEM_LOG_TTL_DAYS = 14;

/**
 * `config.d` drop-in bounding every MergeTree-backed system log table the
 * pinned image creates.
 *
 * The stock image ships all of these WITHOUT a TTL ("by default, table growth
 * is unlimited" - ClickHouse docs), and in August 2026 `system.trace_log`
 * alone grew to 17 GiB on dev and filled the PVC: from then on every insert
 * failed with "Cannot reserve ... not enough space", the Langfuse worker
 * dropped every batch it flushed, and the UI sat on "Waiting for first trace"
 * with all pods Ready. Nothing in `kubectl get pods` pointed at the disk -
 * the failure surfaces two layers away from its cause.
 *
 * This covers the SERVER's logs only. Langfuse trace/observation data keeps
 * growing without bound (retention policies are an Enterprise feature), so
 * the sizing note on `clickhouseStorageSize` still applies - to that, not to
 * this.
 *
 * Overlay, not a full config: each `<ttl>` MERGES with the image's own
 * `config.xml` section for that log (same tags), so partition_by, flush
 * intervals and the rest stay upstream's. `<table>` is repeated so no entry
 * dangles off an image default a future bump could rename.
 *
 * The table list is exact, and `clickhouse.spec.ts` asserts it: the eleven
 * MergeTree-backed log tables the pinned 25.8 image creates (verified by
 * `SHOW TABLES FROM system LIKE '%log'`), each with the date column it
 * actually carries. `opentelemetry_span_log` has no `event_date`, only
 * `finish_date` - a TTL over a missing column fails the server at startup,
 * so it gets its own expression rather than sharing the common one.
 */
const SYSTEM_LOG_TTL_XML = `<clickhouse>
  <asynchronous_insert_log><table>asynchronous_insert_log</table><ttl>event_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></asynchronous_insert_log>
  <asynchronous_metric_log><table>asynchronous_metric_log</table><ttl>event_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></asynchronous_metric_log>
  <error_log><table>error_log</table><ttl>event_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></error_log>
  <metric_log><table>metric_log</table><ttl>event_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></metric_log>
  <opentelemetry_span_log><table>opentelemetry_span_log</table><ttl>finish_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></opentelemetry_span_log>
  <part_log><table>part_log</table><ttl>event_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></part_log>
  <processors_profile_log><table>processors_profile_log</table><ttl>event_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></processors_profile_log>
  <query_log><table>query_log</table><ttl>event_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></query_log>
  <query_metric_log><table>query_metric_log</table><ttl>event_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></query_metric_log>
  <text_log><table>text_log</table><ttl>event_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></text_log>
  <trace_log><table>trace_log</table><ttl>event_date + INTERVAL ${SYSTEM_LOG_TTL_DAYS} DAY DELETE</ttl></trace_log>
</clickhouse>`;

export interface ClickHouse {
  statefulSet: k8s.apps.v1.StatefulSet;
  service: k8s.core.v1.Service;
  secret: k8s.core.v1.Secret;
  /** `config.d` drop-in bounding the server's own system logs (see SYSTEM_LOG_TTL_XML). */
  config: k8s.core.v1.ConfigMap;
  /** `CLICKHOUSE_URL` — the HTTP interface Langfuse's app code queries. */
  httpUrl: pulumi.Output<string>;
  /** `CLICKHOUSE_MIGRATION_URL` — the native TCP interface its migrator uses. */
  migrationUrl: pulumi.Output<string>;
}

/**
 * Single-node ClickHouse — the analytical store behind Langfuse (ADR-0044).
 *
 * Langfuse v3 splits its state in two and needs both: Postgres holds the
 * transactional side (projects, users, API keys, prompts, datasets) and
 * ClickHouse holds the observations — every span, every token count, every
 * cost. There is no Postgres-only mode to fall back to, which is why adopting
 * Langfuse means adopting this.
 *
 * **Single node on purpose.** `CLICKHOUSE_CLUSTER_ENABLED=false` on the Langfuse
 * side tells its migrator to emit plain `MergeTree` DDL instead of the
 * `Replicated*` engines a cluster needs, so this is not a "start small and add
 * replicas later" arrangement — the schema differs. Growing to a real cluster
 * is a migration, and the ADR says so rather than implying otherwise here.
 *
 * **UTC is load-bearing, not a default worth inheriting quietly.** ClickHouse
 * applies its server timezone to `DateTime` parsing, and Langfuse writes
 * timestamps assuming UTC; on a server set to anything else its queries return
 * empty or shifted result sets — a dashboard that reports "no data" for a
 * system that is plainly running. The image defaults to UTC and nothing here
 * changes it, and `TZ` is pinned below so a future base-image change cannot.
 */
export function installClickHouse(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): ClickHouse {
  const name = LANGFUSE.clickhouse;
  const labels = commonLabels(name);
  const image = cfg.langfuse.clickhouseImage;

  // The password rides a Secret + `secretKeyRef`, never an inline env value or
  // an arg: a pod spec is readable by anything with `get pod` in the namespace,
  // and this credential opens every tenant's trace content.
  const secretValues = { [CLICKHOUSE_PASSWORD_SECRET_KEY]: cfg.langfuse.clickhousePassword };
  const secret = new k8s.core.v1.Secret(
    SECRET_NAME,
    {
      metadata: { name: SECRET_NAME, namespace, labels },
      stringData: secretValues,
    },
    { provider, dependsOn },
  );

  // Bounds the server's own logs (see SYSTEM_LOG_TTL_XML). Plain data, never
  // secrets - but content-hashed into the pod annotation below anyway: a
  // mounted ConfigMap restarts nothing by itself, and subPath mounts (used
  // here) do not even refresh in a running pod, so without the checksum a TTL
  // change would deploy successfully and never take effect anywhere.
  const syslogTtl = new k8s.core.v1.ConfigMap(
    `${name}-config`,
    {
      metadata: { name: `${name}-config`, namespace, labels },
      data: { "system-log-ttl.xml": SYSTEM_LOG_TTL_XML },
    },
    { provider, dependsOn },
  );

  const statefulSet = new k8s.apps.v1.StatefulSet(
    name,
    {
      metadata: { name, namespace, labels },
      spec: {
        serviceName: `${name}-headless`,
        replicas: 1,
        // Retain across delete/scale: this is the trace store. Matches the k8s
        // default, pinned against a future default flip (as in chroma.ts).
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        ...orderedRollout(ROLLOUT.dataPlane),
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            // `secretKeyRef` is read once at container start, so a rotated
            // password would otherwise leave this pod enforcing the old one
            // while every consumer holds the new one — a total outage that
            // `pulumi up` reports as success (rollout.ts §5).
            // The system-log TTL drop-in rides the same checksum with one extra
            // turn of the screw: subPath mounts never refresh in a running pod,
            // so without this a TTL change would land in the ConfigMap and in
            // nothing else.
            annotations: secretChecksumAnnotations(
              secretChecksum({ ...secretValues, "system-log-ttl.xml": SYSTEM_LOG_TTL_XML }),
            ),
          },
          spec: {
            enableServiceLinks: false,
            // No Kubernetes API access needed — don't hand the pod a token.
            automountServiceAccountToken: false,
            // UID 101 is `clickhouse` in the official image. fsGroup is what
            // makes the PVC writable to it; without it the server exits on
            // first boot unable to create /var/lib/clickhouse/store.
            securityContext: { runAsNonRoot: true, runAsUser: 101, runAsGroup: 101, fsGroup: 101 },
            terminationGracePeriodSeconds:
              gracefulShutdown(ROLLOUT.dataPlane).terminationGracePeriodSeconds,
            volumes: [{ name: "syslog-ttl", configMap: { name: syslogTtl.metadata.name } }],
            containers: [
              {
                name: "clickhouse",
                image,
                imagePullPolicy: pullPolicyFor(image),
                ports: [
                  { containerPort: PORT.clickhouseHttp, name: "http" },
                  { containerPort: PORT.clickhouseNative, name: "native" },
                ],
                env: [
                  { name: "CLICKHOUSE_DB", value: LANGFUSE.clickhouseDatabase },
                  { name: "CLICKHOUSE_USER", value: LANGFUSE.clickhouseUser },
                  {
                    name: "CLICKHOUSE_PASSWORD",
                    valueFrom: {
                      secretKeyRef: { name: SECRET_NAME, key: CLICKHOUSE_PASSWORD_SECRET_KEY },
                    },
                  },
                  // Denies this login the right to create other users/roles.
                  // Already the image default; pinned because it is the one
                  // setting standing between "the app's database login" and
                  // "an account that can mint itself more accounts".
                  //
                  // Note what removes the image's passwordless `default`
                  // SUPERUSER: it is `CLICKHOUSE_USER` above being something
                  // other than `default`. On that condition the entrypoint
                  // writes `users.d/default-user.xml` containing
                  // `<default remove="remove">` (verified in
                  // ClickHouse/docker/server/entrypoint.sh). Renaming this
                  // login back to `default` would silently restore an
                  // unauthenticated admin on a port the namespace can dial.
                  { name: "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", value: "0" },
                  // See the header — Langfuse's queries silently return nothing
                  // on a non-UTC server.
                  { name: "TZ", value: "UTC" },
                ],
                volumeMounts: [
                  { name: "data", mountPath: "/var/lib/clickhouse" },
                  // subPath, NOT a whole-directory mount over config.d: the
                  // image ships docker_related_config.xml there (listen_host
                  // ::/0.0.0.0), and mounting a ConfigMap over the directory
                  // would shadow it - leaving ClickHouse listening on
                  // localhost only, with Langfuse unable to connect and no
                  // error naming the mount. config.d merging still applies:
                  // drop-ins are read by filename, not by volume shape.
                  {
                    name: "syslog-ttl",
                    mountPath: "/etc/clickhouse-server/config.d/system-log-ttl.xml",
                    subPath: "system-log-ttl.xml",
                    readOnly: true,
                  },
                ],
                resources: DATA_RESOURCES.clickhouse,
                // `/ping` answers before the server will accept queries, which
                // is exactly what a startup probe wants and exactly what a
                // readiness probe must not settle for — but ClickHouse's
                // query-ready signal has no unauthenticated endpoint, and a
                // probe cannot present the password. `/ping` on all three, with
                // a generous startup budget: the first boot creates the
                // database and the store layout, and a pod killed mid-way
                // through that comes back needing recovery time.
                startupProbe: {
                  httpGet: { path: "/ping", port: PORT.clickhouseHttp },
                  periodSeconds: 10,
                  failureThreshold: 30,
                },
                readinessProbe: {
                  httpGet: { path: "/ping", port: PORT.clickhouseHttp },
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                },
                livenessProbe: {
                  httpGet: { path: "/ping", port: PORT.clickhouseHttp },
                  periodSeconds: 20,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: "data" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              storageClassName: cfg.storage.className,
              resources: { requests: { storage: cfg.langfuse.clickhouseStorageSize } },
            },
          },
        ],
      },
    },
    {
      provider,
      dependsOn: [...dependsOn, secret, syslogTtl],
      // Immutable volumeClaimTemplates — grow via a PVC patch (see seaweedfs.ts).
      ignoreChanges: ["spec.volumeClaimTemplates"],
      // Fixed-name StatefulSet: create-before-delete collides with the existing
      // object. Safe to delete first — the PVC is pinned Retain and rebinds by
      // template name.
      deleteBeforeReplace: true,
      // Holds every trace ever ingested, and it is the ONE store in this tier
      // with no second copy anywhere: Postgres has PITR (ADR-0042) and the S3
      // event archive is in SeaweedFS, but ClickHouse has neither. Deleting it
      // is unrecoverable observability history.
      protect: cfg.protectDataResources,
    },
  );

  // Headless governing Service — required by the StatefulSet per-pod DNS
  // contract. Clients use the ClusterIP Service below.
  new k8s.core.v1.Service(
    `${name}-headless`,
    {
      metadata: { name: `${name}-headless`, namespace, labels },
      spec: {
        clusterIP: "None",
        selector: labels,
        ports: [
          { port: PORT.clickhouseHttp, name: "http" },
          { port: PORT.clickhouseNative, name: "native" },
        ],
      },
    },
    { provider },
  );

  const service = new k8s.core.v1.Service(
    name,
    {
      metadata: { name, namespace, labels },
      spec: {
        selector: labels,
        ports: [
          { port: PORT.clickhouseHttp, targetPort: PORT.clickhouseHttp, name: "http" },
          { port: PORT.clickhouseNative, targetPort: PORT.clickhouseNative, name: "native" },
        ],
      },
    },
    { provider, dependsOn: statefulSet },
  );

  return {
    statefulSet,
    service,
    secret,
    config: syslogTtl,
    httpUrl: pulumi.output(`http://${name}:${PORT.clickhouseHttp}`),
    migrationUrl: pulumi.output(`clickhouse://${name}:${PORT.clickhouseNative}`),
  };
}
