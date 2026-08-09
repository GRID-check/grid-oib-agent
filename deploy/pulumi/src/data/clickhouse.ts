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

export interface ClickHouse {
  statefulSet: k8s.apps.v1.StatefulSet;
  service: k8s.core.v1.Service;
  secret: k8s.core.v1.Secret;
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
            annotations: secretChecksumAnnotations(secretChecksum(secretValues)),
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
                volumeMounts: [{ name: "data", mountPath: "/var/lib/clickhouse" }],
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
      dependsOn: [...dependsOn, secret],
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
    httpUrl: pulumi.output(`http://${name}:${PORT.clickhouseHttp}`),
    migrationUrl: pulumi.output(`clickhouse://${name}:${PORT.clickhouseNative}`),
  };
}
