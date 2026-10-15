import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, pullPolicyFor } from "../config";
import { AUTOSCALER_SAFE_TO_EVICT, BOOTSTRAP_JOB_RESOURCES, JOB_DEFAULTS, PORT, QDRANT, UID } from "../constants";
import { commonLabels } from "../platform/namespaces";
import {
  ROLLOUT,
  gracefulShutdown,
  orderedRollout,
  secretChecksum,
  secretChecksumAnnotations,
} from "../platform/rollout";
import { installPdb, onNodeGroup } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { qdrantAlertRules } from "./qdrant-alerts";

type EnvVar = k8s.types.input.core.v1.EnvVar;

export interface Qdrant {
  statefulSet: k8s.apps.v1.StatefulSet;
  service: k8s.core.v1.Service;
  snapshotCronJob: k8s.batch.v1.CronJob;
  /** The Prometheus alerting rules, rendered against this stack's limits. */
  alertRules: k8s.core.v1.ConfigMap;
  /** In-cluster URL every backend tier points AIQ_QDRANT_URL at. */
  url: pulumi.Output<string>;
  /** `host:port` of every peer's metrics listener, which the collector scrapes. */
  metricsTargets: pulumi.Output<string[]>;
}

/** Keys of the `qdrant-credentials` Secret. */
const KEY = {
  apiKey: "api-key", // pragma: allowlist secret (Secret key name, not a credential)
  readOnlyApiKey: "read-only-api-key", // pragma: allowlist secret (Secret key name, not a credential)
  altApiKey: "alt-api-key", // pragma: allowlist secret (Secret key name, not a credential)
  s3SecretKey: "s3-secret-key", // pragma: allowlist secret (Secret key name, not a credential)
} as const;

/** The curl image's user (`curl_user`, uid 100 in `curlimages/curl`), numeric so `runAsNonRoot` can be verified. */
const CURL_UID = 100;

/**
 * Self-hosted Qdrant 1.19 (ADR-0113), the stack's one vector store.
 *
 * A raw StatefulSet, with `qdrant-helm` 1.19.2 as the oracle
 * for everything Qdrant-specific: the cluster bootstrap, `Parallel` pod
 * management, the probes, and the read-only root with emptyDirs for the two
 * paths the image writes outside its data. Diff against the chart on every
 * minor upgrade. `docs/architecture/qdrant-retrieval-design.md` §9 is the
 * reasoning behind each setting.
 *
 * What differs from the chart, on purpose:
 * - Configuration is env (`QDRANT__…`), not a mounted `production.yaml`, so
 *   the keys come from a Secret by `secretKeyRef` and never sit in a ConfigMap.
 * - No root `chown` init container: the pod runs as uid 1000 from its first
 *   start, and `fsGroup` owns the volume.
 * - Shard snapshots go to the in-cluster SeaweedFS (`snapshots_config` s3),
 *   taken by the `qdrant-snapshot` CronJob below, which also records the
 *   aliases no snapshot holds.
 * - `/metrics` is served on its own port without the key, for the collector
 *   (`otel-collector.ts`), and the alerting rules ship as a ConfigMap.
 *
 * Operating it (restore, peer replacement, rebuilds, upgrades, key rotation):
 * `docs/deployment/qdrant-runbook.md`.
 */
export function installQdrant(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  /** In-cluster S3 endpoint the snapshots are uploaded to. */
  s3Endpoint: pulumi.Input<string>,
  /** What the snapshot CronJob waits on: the bucket it writes into. */
  snapshotDeps: pulumi.Resource[] = [],
): Qdrant {
  const labels = commonLabels(QDRANT.name);
  const { secret, checksum } = qdrantSecret(cfg, provider, namespace);
  const ns = pulumi.output(namespace);

  const statefulSet = new k8s.apps.v1.StatefulSet(
    QDRANT.name,
    {
      metadata: { name: QDRANT.name, namespace, labels },
      spec: {
        serviceName: QDRANT.headless,
        replicas: cfg.qdrant.replicas,
        // Set at creation and never changed, which is the only way this
        // immutable field is safe (the `statefulset-no-immutable-field-writes`
        // policy names this StatefulSet as its one exception). OrderedReady
        // deadlocks the bootstrap: qdrant-1 waits on qdrant-0's readiness while
        // qdrant-0 waits on a quorum.
        podManagementPolicy: "Parallel",
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        ...orderedRollout(ROLLOUT.vectorStore),
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            annotations: {
              // An eviction for a cheaper node is a peer down and a shard
              // recovery, with the PVC following the pod.
              [AUTOSCALER_SAFE_TO_EVICT]: "false",
              ...secretChecksumAnnotations(checksum),
            },
          },
          spec: qdrantPodSpec(cfg, ns, s3Endpoint, labels),
        },
        volumeClaimTemplates: [
          {
            metadata: { name: "data" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              storageClassName: cfg.storage.className,
              resources: { requests: { storage: cfg.qdrant.storageSize } },
            },
          },
        ],
      },
    },
    {
      provider,
      dependsOn: [secret],
      // Immutable volumeClaimTemplates, as in seaweedfs-single.ts: grow via PVC patch.
      ignoreChanges: ["spec.volumeClaimTemplates"],
      // Fixed name: a create-before-delete replace collides with itself. The
      // PVCs are Retain and rebind by template name.
      deleteBeforeReplace: true,
      protect: cfg.protectDataResources,
      // A rollout restarts one peer at a time, each loading its segments and
      // catching up with consensus before `/readyz`, then soaking 30 s.
      customTimeouts: { create: "30m", update: "30m" },
    },
  );

  // Governing Service: per-pod DNS (`qdrant-0.qdrant-headless`) for bootstrap
  // and the snapshot CronJob. Not-ready addresses are published because a peer
  // must resolve its bootstrap peer before either is Ready.
  new k8s.core.v1.Service(
    QDRANT.headless,
    {
      metadata: { name: QDRANT.headless, namespace, labels },
      spec: {
        clusterIP: "None",
        publishNotReadyAddresses: true,
        selector: labels,
        ports: [
          { port: PORT.qdrantHttp, targetPort: PORT.qdrantHttp, name: "http" },
          { port: PORT.qdrantGrpc, targetPort: PORT.qdrantGrpc, name: "grpc" },
          { port: PORT.qdrantP2p, targetPort: PORT.qdrantP2p, name: "p2p" },
          { port: PORT.qdrantMetrics, targetPort: PORT.qdrantMetrics, name: "metrics" },
        ],
      },
    },
    { provider },
  );

  // What clients connect to. No p2p port: only peers speak it.
  const service = new k8s.core.v1.Service(
    QDRANT.name,
    {
      metadata: { name: QDRANT.name, namespace, labels },
      spec: {
        selector: labels,
        ports: [
          { port: PORT.qdrantHttp, targetPort: PORT.qdrantHttp, name: "http" },
          { port: PORT.qdrantGrpc, targetPort: PORT.qdrantGrpc, name: "grpc" },
        ],
      },
    },
    { provider, dependsOn: statefulSet },
  );

  // One peer at a time through a drain (scheduling.ts). A single replica gets
  // none, like every single-replica workload here.
  if (cfg.qdrant.replicas > 1) {
    installPdb(QDRANT.name, namespace, provider, labels, [statefulSet]);
  }

  const snapshotCronJob = installSnapshotCronJob(cfg, provider, namespace, s3Endpoint, [
    secret,
    service,
    ...snapshotDeps,
  ]);

  // Rules, not an evaluator: nothing in the cluster evaluates Prometheus rules
  // today (`qdrant-alerts.ts` says what reads them). Rendered here so the
  // memory rule divides by this stack's limit, not a number copied by hand.
  const alertRules = new k8s.core.v1.ConfigMap(
    QDRANT.alertRules,
    {
      metadata: { name: QDRANT.alertRules, namespace, labels },
      data: { "qdrant.rules.yaml": qdrantAlertRules(cfg) },
    },
    { provider },
  );

  return {
    statefulSet,
    service,
    snapshotCronJob,
    alertRules,
    url: pulumi.interpolate`http://${QDRANT.name}.${ns}.svc.cluster.local:${PORT.qdrantHttp}`,
    metricsTargets: ns.apply((n) => metricsTargets(n, cfg.qdrant.replicas)),
  };
}

/**
 * The keys the pods and the snapshot CronJob read, in a Secret of their own
 * rather than `grid-secrets`: its checksum rolls the Qdrant peers, and a
 * rotated OpenRouter key must not restart a Raft cluster.
 */
function qdrantSecret(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
): { secret: k8s.core.v1.Secret; checksum: pulumi.Output<string> } {
  const values: Record<string, pulumi.Input<string>> = {
    [KEY.apiKey]: cfg.qdrant.apiKey,
    [KEY.readOnlyApiKey]: cfg.qdrant.readOnlyApiKey,
    [KEY.s3SecretKey]: cfg.qdrant.snapshots.s3SecretKey,
    // Only during a key rotation; its arrival and its removal each roll the peers.
    ...(cfg.qdrant.altApiKey ? { [KEY.altApiKey]: cfg.qdrant.altApiKey } : {}),
  };
  const secret = new k8s.core.v1.Secret(
    QDRANT.secret,
    { metadata: { name: QDRANT.secret, namespace }, stringData: values },
    { provider },
  );
  return { secret, checksum: secretChecksum(values) };
}

function qref(name: string, key: string): EnvVar {
  return { name, valueFrom: { secretKeyRef: { name: QDRANT.secret, key } } };
}

/** The peer's p2p URI (`--uri`/`--bootstrap`), by StatefulSet ordinal or a shell expression for it. */
function p2pUri(namespace: string, ordinal: string): string {
  return `http://${QDRANT.name}-${ordinal}.${QDRANT.headless}.${namespace}:${PORT.qdrantP2p}`;
}

/**
 * The container's `bash -c` script: the `qdrant-helm` `initialize.sh`, inline.
 *
 * Peer 0 founds the cluster under its own URI; every other peer bootstraps
 * from peer 0 and announces itself under its pod DNS name. On a restart the
 * same flags are harmless: a peer that already holds Raft state ignores
 * `--bootstrap`. One replica runs without cluster mode, so it gets no URI.
 *
 * `ulimit -n` to the hard limit, as the chart does: every segment is a set of
 * open files, and the soft default runs out on a large collection.
 */
export function bootstrapScript(namespace: string, replicas: number): string {
  const head = ["set -eu", 'ulimit -n "$(ulimit -Hn)"'];
  if (replicas === 1) return [...head, "exec ./entrypoint.sh"].join("\n");
  return [
    ...head,
    'ordinal="${HOSTNAME##*-}"',
    'if [ "$ordinal" = "0" ]; then',
    `  exec ./entrypoint.sh --uri '${p2pUri(namespace, "0")}'`,
    "fi",
    `exec ./entrypoint.sh --bootstrap '${p2pUri(namespace, "0")}' --uri "${p2pUri(namespace, "${ordinal}")}"`,
  ].join("\n");
}

/** Qdrant's configuration, as env. Exported for the spec. */
export function qdrantEnv(cfg: GridConfig, s3Endpoint: pulumi.Input<string>): EnvVar[] {
  const clustered = cfg.qdrant.replicas > 1;
  return [
    // Where `entrypoint.sh` marks a finished start; the root is read-only.
    { name: "QDRANT_INIT_FILE_PATH", value: "/qdrant/init/.qdrant-initialized" },
    { name: "QDRANT__LOG_LEVEL", value: "INFO" },
    { name: "QDRANT__TELEMETRY_DISABLED", value: "true" },
    { name: "QDRANT__SERVICE__HTTP_PORT", value: String(PORT.qdrantHttp) },
    // `/metrics` alone, without the key, on a port only the collector may
    // dial. On 6333 the same path needs a key the collector would then hold.
    { name: "QDRANT__SERVICE__METRICS_PORT", value: String(PORT.qdrantMetrics) },
    // Explicit: the image's production.yaml leaves gRPC commented out, and the
    // client prefers it.
    { name: "QDRANT__SERVICE__GRPC_PORT", value: String(PORT.qdrantGrpc) },
    { name: "QDRANT__STORAGE__STORAGE_PATH", value: "/qdrant/storage" },
    { name: "QDRANT__STORAGE__SNAPSHOTS_PATH", value: "/qdrant/snapshots" },
    // Open-source Qdrant answers anyone without these. The health endpoints
    // the probes use stay open (they are whitelisted in Qdrant itself).
    qref("QDRANT__SERVICE__API_KEY", KEY.apiKey),
    qref("QDRANT__SERVICE__READ_ONLY_API_KEY", KEY.readOnlyApiKey),
    // A second read-write key, accepted on the API and on p2p, for the length
    // of a rotation (drilled 2026-10-13: three rolls, no failed write).
    ...(cfg.qdrant.altApiKey ? [qref("QDRANT__SERVICE__ALT_API_KEY", KEY.altApiKey)] : []),
    { name: "QDRANT__CLUSTER__ENABLED", value: String(clustered) },
    // Writes refused with 507 near the memory limit or a full volume, rather
    // than an OOM kill mid-optimisation or a WAL that cannot grow. The ingest
    // queue retries a refused write. Seeds the quota manager on a cluster's
    // first start only (config.ts `quotas`); `PUT /quotas` changes it after.
    { name: "QDRANT__STORAGE__QUOTAS__ENABLED", value: "true" },
    {
      name: "QDRANT__STORAGE__QUOTAS__MAX_RESIDENT_MEMORY_PERCENT",
      value: String(cfg.qdrant.quotas.memoryPercent),
    },
    { name: "QDRANT__STORAGE__QUOTAS__MAX_DISK_USAGE_PERCENT", value: String(cfg.qdrant.quotas.diskPercent) },
    // Recovery only: load segments without making them resident, for a peer
    // that OOMs while loading. Unset is Qdrant's `disabled`.
    ...(cfg.qdrant.lowMemoryMode
      ? [{ name: "QDRANT__STORAGE__LOW_MEMORY_MODE", value: cfg.qdrant.lowMemoryMode }]
      : []),
    // Peers must present the read-write key on p2p (1.18+). Safe because every
    // peer runs one version from its first start; a future rolling upgrade
    // across a version that changes internal auth turns it off for the roll
    // (Qdrant's own config.yaml says so). No p2p without a cluster.
    ...(clustered ? [{ name: "QDRANT__SERVICE__ENFORCE_INTERNAL_AUTH", value: "true" }] : []),
    // Snapshots are uploaded to SeaweedFS, staged on the data PVC first
    // (`storage/snapshots_temp`); nothing lands in /qdrant/snapshots.
    { name: "QDRANT__STORAGE__SNAPSHOTS_CONFIG__SNAPSHOTS_STORAGE", value: "s3" },
    { name: "QDRANT__STORAGE__SNAPSHOTS_CONFIG__S3_CONFIG__BUCKET", value: QDRANT.snapshotBucket },
    { name: "QDRANT__STORAGE__SNAPSHOTS_CONFIG__S3_CONFIG__REGION", value: QDRANT.s3Region },
    // http:// is what lets Qdrant's object_store client speak plain HTTP.
    { name: "QDRANT__STORAGE__SNAPSHOTS_CONFIG__S3_CONFIG__ENDPOINT_URL", value: s3Endpoint },
    { name: "QDRANT__STORAGE__SNAPSHOTS_CONFIG__S3_CONFIG__ACCESS_KEY", value: cfg.qdrant.snapshots.s3AccessKey },
    qref("QDRANT__STORAGE__SNAPSHOTS_CONFIG__S3_CONFIG__SECRET_KEY", KEY.s3SecretKey),
  ];
}

/**
 * Keep peers on separate nodes: one node lost is one voter lost. Required
 * once there is a data group, which is sized for the stores, and preferred
 * otherwise, so a small unplaced cluster can still schedule mid node-replacement.
 */
function antiAffinity(
  cfg: GridConfig,
  labels: pulumi.Input<{ [k: string]: string }>,
): k8s.types.input.core.v1.Affinity {
  const term = { labelSelector: { matchLabels: labels }, topologyKey: "kubernetes.io/hostname" };
  if (cfg.qdrant.replicas > 1 && cfg.nodeGroups.data) {
    return { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [term] } };
  }
  return { podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 100, podAffinityTerm: term }] } };
}

function qdrantPodSpec(
  cfg: GridConfig,
  namespace: pulumi.Output<string>,
  s3Endpoint: pulumi.Input<string>,
  labels: pulumi.Input<{ [k: string]: string }>,
): k8s.types.input.core.v1.PodSpec {
  const shutdown = gracefulShutdown(ROLLOUT.vectorStore, "coreutils");
  const envelope = { cpu: cfg.qdrant.cpu, memory: cfg.qdrant.memory };
  const http = { port: PORT.qdrantHttp };
  return {
    ...onNodeGroup(cfg.nodeGroups.data),
    affinity: antiAffinity(cfg, labels),
    terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
    // QDRANT_* service-link vars would land in Qdrant's own env namespace.
    enableServiceLinks: false,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: UID.qdrant,
      runAsGroup: UID.qdrant,
      fsGroup: UID.qdrant,
      // A 100Gi volume re-chowned on every start is minutes of downtime.
      fsGroupChangePolicy: "OnRootMismatch",
    },
    containers: [
      {
        name: QDRANT.name,
        image: cfg.qdrant.image,
        imagePullPolicy: pullPolicyFor(cfg.qdrant.image),
        command: ["/bin/bash", "-c"],
        args: [namespace.apply((ns) => bootstrapScript(ns, cfg.qdrant.replicas))],
        env: qdrantEnv(cfg, s3Endpoint),
        ports: [
          { containerPort: PORT.qdrantHttp, name: "http" },
          { containerPort: PORT.qdrantGrpc, name: "grpc" },
          { containerPort: PORT.qdrantP2p, name: "p2p" },
          { containerPort: PORT.qdrantMetrics, name: "metrics" },
        ],
        // Loading segments precedes the API, so a large collection takes
        // minutes to answer at all: 15 minutes before liveness takes over.
        startupProbe: { httpGet: { path: "/livez", ...http }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 90 },
        // /readyz is false while the peer catches up with consensus. As
        // liveness it would restart peers during catch-up and cascade.
        readinessProbe: { httpGet: { path: "/readyz", ...http }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 6 },
        livenessProbe: { httpGet: { path: "/livez", ...http }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 },
        lifecycle: shutdown.lifecycle,
        // request = limit (Guaranteed): the scheduler promised all of it.
        resources: { requests: envelope, limits: envelope },
        securityContext: { ...hardenedContainerSecurityContext(), readOnlyRootFilesystem: true },
        volumeMounts: [
          { name: "data", mountPath: "/qdrant/storage" },
          { name: "snapshots", mountPath: "/qdrant/snapshots" },
          { name: "init", mountPath: "/qdrant/init" },
        ],
      },
    ],
    volumes: [
      { name: "snapshots", emptyDir: {} },
      { name: "init", emptyDir: {} },
    ],
  };
}

/** Peer `i`'s fully qualified headless DNS name. */
function peerHost(namespace: string, i: number): string {
  return `${QDRANT.name}-${i}.${QDRANT.headless}.${namespace}.svc.cluster.local`;
}

/** Every peer's REST URL, by headless DNS name. */
export function peerUrls(namespace: string, replicas: number): string[] {
  return Array.from({ length: replicas }, (_, i) => `http://${peerHost(namespace, i)}:${PORT.qdrantHttp}`);
}

/**
 * Every peer's metrics listener as a scrape target. Per peer, never the
 * ClusterIP Service: `/metrics` reports only the peer that answers, so a
 * load-balanced scrape would sample a different peer each time.
 */
export function metricsTargets(namespace: string, replicas: number): string[] {
  return Array.from({ length: replicas }, (_, i) => `${peerHost(namespace, i)}:${PORT.qdrantMetrics}`);
}

/**
 * The CronJob's script, in two parts.
 *
 * First the aliases. Every client addresses a collection through an alias
 * (`piloti_office` → `piloti_office_v1`), aliases live in consensus, and no
 * snapshot holds them: a cluster restored from snapshots alone answers every
 * search with "collection not found". So `GET /aliases` is read from the first
 * peer that answers and uploaded to `$S3_BUCKET/aliases/` as the snapshot
 * identity, SigV4-signed by curl itself.
 *
 * Then the shards. Qdrant has no cluster-wide snapshot: a collection snapshot
 * taken on a peer holds that peer's shards only, so every collection is
 * snapshotted on every peer.
 *
 * Both are expired after RETENTION_DAYS, read from the timestamp in each name
 * (`<collection>-<peer>-YYYY-MM-DD-HH-MM-SS.snapshot`,
 * `aliases-YYYY-MM-DD-HH-MM-SS.json`); a name in any other shape is never
 * deleted. A 404 on a snapshot delete is another peer having deleted the same
 * object from the shared bucket first.
 *
 * Every peer and collection is attempted; any failure fails the Job at the
 * end, with each one named in the log. `names` and the key listing end in
 * `|| true` because grep exits 1 on no match, and under `pipefail` an empty
 * cluster would otherwise read as one that cannot be listed.
 */
export function snapshotScript(): string {
  return String.raw`set -eu -o pipefail
q() { curl -fsS --connect-timeout 10 -H "api-key: $QDRANT_API_KEY" "$@"; }
s3() { curl -fsS --connect-timeout 10 --aws-sigv4 "aws:amz:$S3_REGION:s3" --user "$S3_ACCESS_KEY:$S3_SECRET_KEY" "$@"; }
# No collection yet is no name, not a failure: under pipefail a grep with no
# match would fail the listing and report every fresh cluster as a broken backup.
names() { { grep -o '"name":"[^"]*"' || true; } | cut -d'"' -f4; }
cutoff=$(date -u -d "@$(( $(date +%s) - RETENTION_DAYS * 86400 ))" +%Y%m%d%H%M%S)
failed=0
fail() { echo "FAILED: $*"; failed=1; }
# True when a name stamped -YYYY-MM-DD-HH-MM-SS before suffix $2 is older than the cutoff.
expired() {
  ts=$(echo "$1" | sed -n "s/.*-\([0-9]\{4\}\)-\([0-9]\{2\}\)-\([0-9]\{2\}\)-\([0-9]\{2\}\)-\([0-9]\{2\}\)-\([0-9]\{2\}\)$2\$/\1\2\3\4\5\6/p")
  [ -n "$ts" ] && awk -v t="$ts" -v c="$cutoff" 'BEGIN { exit !(t < c) }'
}
expire() {
  peer=$1 c=$2
  snapshots=$(q "$peer/collections/$c/snapshots" | names) || { fail "cannot list snapshots of $c on $peer"; return; }
  for s in $snapshots; do
    expired "$s" '\.snapshot' || continue
    code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "api-key: $QDRANT_API_KEY" "$peer/collections/$c/snapshots/$s?wait=true") || code=000
    case "$code" in
      200|404) echo "expired $s" ;;
      *) fail "delete $s on $peer (HTTP $code)" ;;
    esac
  done
}
expire_aliases() {
  keys=$(s3 "$S3_ENDPOINT/$S3_BUCKET?list-type=2&prefix=$ALIASES_PREFIX" | { grep -o '<Key>[^<]*</Key>' || true; } | sed 's/<[^>]*>//g') || { fail "cannot list $ALIASES_PREFIX"; return; }
  for k in $keys; do
    expired "$k" '\.json' || continue
    if s3 -X DELETE "$S3_ENDPOINT/$S3_BUCKET/$k" >/dev/null; then echo "expired $k"; else fail "delete $k"; fi
  done
}
record_aliases() {
  for peer in $PEERS; do
    aliases=$(q --retry 3 --retry-all-errors "$peer/aliases") || continue
    key="$ALIASES_PREFIX""aliases-$(date -u +%Y-%m-%d-%H-%M-%S).json"
    if printf '%s' "$aliases" | s3 -X PUT -H 'content-type: application/json' --data-binary @- "$S3_ENDPOINT/$S3_BUCKET/$key" >/dev/null; then
      echo "recorded $key from $peer: $aliases"
      expire_aliases
    else
      fail "upload $key"
    fi
    return
  done
  fail "cannot read aliases from any peer"
}
record_aliases
for peer in $PEERS; do
  collections=$(q --retry 3 --retry-all-errors "$peer/collections" | names) || { fail "cannot list collections on $peer"; continue; }
  [ -n "$collections" ] || echo "no collections on $peer"
  for c in $collections; do
    if q --max-time 3600 -X POST "$peer/collections/$c/snapshots?wait=true" >/dev/null; then
      echo "snapshot $c on $peer"
      expire "$peer" "$c"
    else
      fail "snapshot $c on $peer"
    fi
  done
done
exit "$failed"`;
}

/**
 * Daily shard snapshots of every collection, and the aliases beside them, to
 * the SeaweedFS bucket (design §9 "Backups"). `Forbid`: a run that overruns
 * into the next tick must not be joined by it, or two snapshot passes stage on
 * the PVC at once.
 */
function installSnapshotCronJob(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  s3Endpoint: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.CronJob {
  const labels = commonLabels(QDRANT.snapshotJob);
  return new k8s.batch.v1.CronJob(
    QDRANT.snapshotJob,
    {
      metadata: { name: QDRANT.snapshotJob, namespace, labels },
      spec: {
        schedule: cfg.qdrant.snapshots.schedule,
        concurrencyPolicy: "Forbid",
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            // A failed pass is retried by the next tick; two retries cover a
            // peer restarting at the wrong moment.
            backoffLimit: 2,
            // Bounds a wedged pass so the next tick is not skipped by Forbid.
            activeDeadlineSeconds: 6 * 3600,
            ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
            template: {
              metadata: { labels },
              spec: {
                enableServiceLinks: false,
                restartPolicy: "OnFailure",
                securityContext: { runAsNonRoot: true, runAsUser: CURL_UID, runAsGroup: CURL_UID },
                ...onNodeGroup(cfg.nodeGroups.app),
                containers: [
                  {
                    name: QDRANT.snapshotJob,
                    image: QDRANT.curlImage,
                    imagePullPolicy: pullPolicyFor(QDRANT.curlImage),
                    securityContext: { ...hardenedContainerSecurityContext(), readOnlyRootFilesystem: true },
                    resources: BOOTSTRAP_JOB_RESOURCES,
                    command: ["/bin/sh", "-c", snapshotScript()],
                    env: [
                      {
                        name: "PEERS",
                        value: pulumi.output(namespace).apply((ns) => peerUrls(ns, cfg.qdrant.replicas).join(" ")),
                      },
                      { name: "RETENTION_DAYS", value: String(cfg.qdrant.snapshots.retentionDays) },
                      // From the env: the script names the variable, so
                      // `kubectl describe pod` shows no key.
                      qref("QDRANT_API_KEY", KEY.apiKey),
                      // The alias record goes up as the snapshot identity,
                      // the one credential already scoped to this bucket alone.
                      { name: "S3_ENDPOINT", value: s3Endpoint },
                      { name: "S3_BUCKET", value: QDRANT.snapshotBucket },
                      { name: "S3_REGION", value: QDRANT.s3Region },
                      { name: "S3_ACCESS_KEY", value: cfg.qdrant.snapshots.s3AccessKey },
                      qref("S3_SECRET_KEY", KEY.s3SecretKey),
                      { name: "ALIASES_PREFIX", value: QDRANT.aliasesPrefix },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
    { provider, dependsOn },
  );
}
