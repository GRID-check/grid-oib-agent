import { GridConfig } from "../config";
import { QDRANT } from "../constants";

/**
 * Prometheus alerting rules for the Qdrant cluster (ADR-0113), rendered
 * against this stack's limits and shipped as the `qdrant-alert-rules`
 * ConfigMap (`qdrant.rules.yaml`).
 *
 * Nothing in the stack evaluates them yet: there is no Prometheus and no
 * metrics backend (`docs/deployment/kubernetes.md` §9). They are written in
 * the one rule format every candidate reads (Prometheus, Grafana Mimir and
 * Alloy, VictoriaMetrics' vmalert), against the series the collector
 * re-exposes on `otel-collector:8889/metrics` (`metricsPipeline` in
 * `platform/otel-collector.ts`). Those names are the collector's, not raw
 * Qdrant's: a counter gains `_total` on the way through (`cluster_commit` is
 * exported as `cluster_commit_total`), so a rule written from Qdrant's own
 * `/metrics` can name a series that never arrives. `qdrant-alerts.spec.ts`
 * holds every name used here to the collector's real export of Qdrant 1.19.2,
 * captured in the 2026-10-13 drill.
 *
 * Until something evaluates them, each rule's `check` annotation is the
 * by-hand command that answers the same question, and the runbook section
 * each points at is what to do about it.
 *
 * One rule needs a series this stack does not collect: disk use comes from
 * the kubelet (`kubelet_volume_stats_*`), which the collector does not scrape
 * (it holds no API token). Qdrant's own disk signal is the quota: at
 * `qdrantQuotaDiskPercent` writes stop and `quota_exceeded{resource="disk"}`
 * turns 1, which IS collected.
 */

const RUNBOOK = "docs/deployment/qdrant-runbook.md";
const PEERS = `job="qdrant"`;

/** Warning thresholds, from `qdrant-retrieval-design.md` §9 "Operations". */
export const QDRANT_ALERT_THRESHOLDS = {
  /** Resident memory as a share of the container limit; the quota refuses writes at its own, higher, percentage. */
  memoryRatio: 0.8,
  /** Data volume use; the disk quota refuses writes at its own, higher, percentage. */
  diskRatio: 0.7,
  /** p99 of a search on one peer, in seconds. Gate G2 holds p95 to 230 ms per `knowledge_search`. */
  searchP99Seconds: 0.5,
  /** Memory maps in use as a share of `vm.max_map_count`: past it, segment loads fail. */
  mmapRatio: 0.8,
  /** Hours without a new snapshot on any peer: the daily CronJob plus two hours of slack. */
  snapshotStaleHours: 26,
} as const;

/** Bytes in a Kubernetes quantity (`16Gi`, `512Mi`, `8G`, `1e9`). Throws on anything else. */
export function quantityBytes(quantity: string): number {
  const match = /^(\d+(?:\.\d+)?(?:e\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(quantity.trim());
  if (!match) throw new Error(`not a byte quantity: "${quantity}"`);
  const unit = match[2] ?? "";
  const scale: Record<string, number> = {
    "": 1,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    Ki: 2 ** 10,
    Mi: 2 ** 20,
    Gi: 2 ** 30,
    Ti: 2 ** 40,
  };
  return Math.round(Number(match[1]) * scale[unit]);
}

interface Rule {
  alert: string;
  expr: string;
  for: string;
  severity: "critical" | "warning";
  summary: string;
  /** A command that answers the same question by hand, while nothing evaluates the rule. */
  check: string;
  /** Anchor in the runbook. */
  runbook: string;
}

function rules(cfg: GridConfig): Rule[] {
  const t = QDRANT_ALERT_THRESHOLDS;
  const limit = quantityBytes(cfg.qdrant.memory);
  const clustered = cfg.qdrant.replicas > 1;
  const peerCurl = "curl -sS -H \"api-key: $QDRANT_API_KEY\" $PEER";
  const list: Rule[] = [
    {
      alert: "QdrantPeerDown",
      expr: `up{${PEERS}} == 0`,
      for: "2m",
      severity: "critical",
      summary: "Qdrant peer {{ $labels.peer }} has not answered a metrics scrape for 2 minutes",
      check: "kubectl -n grid get pods -l app.kubernetes.io/name=qdrant",
      runbook: "replace-a-failed-peer",
    },
    {
      alert: "QdrantDeadReplicas",
      expr: `max by (peer) (collection_dead_replicas{${PEERS}}) > 0`,
      for: "5m",
      severity: "critical",
      summary:
        "{{ $labels.peer }} sees {{ $value }} dead shard replicas: a peer is gone or a transfer failed, and nothing re-replicates by itself",
      check: `${peerCurl}/collections/piloti_office/cluster`,
      runbook: "replace-a-failed-peer",
    },
    {
      alert: "QdrantShardWithoutActiveReplica",
      expr: `min(collection_active_replicas_min{${PEERS}}) < 1`,
      for: "1m",
      severity: "critical",
      summary: "A shard has no active replica: its points are unreadable and writes to it fail",
      check: `${peerCurl}/collections/piloti_office/cluster`,
      runbook: "restore-one-shard-every-replica-dead",
    },
    {
      alert: "QdrantPendingRaftOperations",
      expr: `max by (peer) (cluster_pending_operations_total{${PEERS}}) > 0`,
      for: "10m",
      severity: "warning",
      summary: "{{ $labels.peer }} has had uncommitted consensus operations for 10 minutes: quorum is lost or a peer lags",
      check: `${peerCurl}/cluster`,
      runbook: "replace-a-failed-peer",
    },
    {
      alert: "QdrantConsensusStopped",
      expr: `cluster_working_state{${PEERS},state="stopped"} == 1`,
      for: "2m",
      severity: "critical",
      summary: "The consensus thread on {{ $labels.peer }} has stopped",
      check: `${peerCurl}/cluster`,
      runbook: "replace-a-failed-peer",
    },
    {
      alert: "QdrantMemoryHigh",
      expr: `max by (peer) (memory_resident_bytes{${PEERS}}) / ${limit} > ${t.memoryRatio}`,
      for: "10m",
      severity: "warning",
      summary: `{{ $labels.peer }} holds more than ${t.memoryRatio * 100}% of its ${cfg.qdrant.memory} limit; writes stop at ${cfg.qdrant.quotas.memoryPercent}%`,
      check: `${peerCurl}/quotas`,
      runbook: "oom-crash-loop",
    },
    {
      alert: "QdrantQuotaExceeded",
      expr: `max by (peer, resource) (quota_exceeded{${PEERS}}) == 1`,
      for: "1m",
      severity: "critical",
      summary: "{{ $labels.peer }} is over its {{ $labels.resource }} quota and refuses writes with HTTP 507",
      check: `${peerCurl}/quotas`,
      runbook: "quotas",
    },
    {
      alert: "QdrantDiskHigh",
      expr:
        `max by (persistentvolumeclaim) (kubelet_volume_stats_used_bytes{persistentvolumeclaim=~"data-${QDRANT.name}-[0-9]+"}` +
        ` / kubelet_volume_stats_capacity_bytes{persistentvolumeclaim=~"data-${QDRANT.name}-[0-9]+"}) > ${t.diskRatio}`,
      for: "15m",
      severity: "warning",
      summary: `{{ $labels.persistentvolumeclaim }} is more than ${t.diskRatio * 100}% full; snapshots stage on it and writes stop at ${cfg.qdrant.quotas.diskPercent}%`,
      check: `${peerCurl}/quotas   # usage.disk_usage_percent`,
      runbook: "quotas",
    },
    {
      alert: "QdrantSearchLatencyHigh",
      expr:
        `histogram_quantile(0.99, sum by (peer, le) (rate(rest_responses_duration_seconds_bucket{${PEERS},` +
        `endpoint=~".*/points/(query|query/groups|search|search/groups)"}[5m]))) > ${t.searchP99Seconds}`,
      for: "10m",
      severity: "warning",
      summary: `p99 search latency on {{ $labels.peer }} above ${t.searchP99Seconds * 1000} ms for 10 minutes`,
      check: "Langfuse: retrieve.knowledge_search spans, store time",
      runbook: "oom-crash-loop",
    },
    {
      alert: "QdrantMmapsNearLimit",
      expr: `max by (peer) (process_open_mmaps{${PEERS}} / system_max_mmaps{${PEERS}}) > ${t.mmapRatio}`,
      for: "10m",
      severity: "warning",
      summary: "{{ $labels.peer }} uses more than 80% of vm.max_map_count; segment loads fail past it",
      check: `${peerCurl}/telemetry`,
      runbook: "oom-crash-loop",
    },
    {
      alert: "QdrantRecoveryMode",
      expr: `app_status_recovery_mode{${PEERS}} == 1`,
      for: "5m",
      severity: "warning",
      summary: "{{ $labels.peer }} is running in recovery mode",
      check: "kubectl -n grid logs qdrant-N | grep -i recovery",
      runbook: "oom-crash-loop",
    },
    {
      // A `for` of the whole window over a one-hour increase, not an increase
      // over the window: the counter lives as long as the process, and a
      // freshly started evaluator holding minutes of samples would otherwise
      // read "no snapshot in 26 hours" at once (it did, in the drill).
      alert: "QdrantSnapshotsStale",
      expr: `sum(increase(snapshot_created_total{${PEERS}}[1h])) == 0`,
      for: `${t.snapshotStaleHours}h`,
      severity: "warning",
      summary: `No Qdrant snapshot taken on any peer in ${t.snapshotStaleHours} hours: the qdrant-snapshot CronJob is failing or not scheduled`,
      check: "kubectl -n grid get jobs -l app.kubernetes.io/name=qdrant-snapshot",
      runbook: "restore-from-snapshots",
    },
  ];
  if (clustered) {
    list.splice(3, 0, {
      alert: "QdrantShardUnderReplicated",
      expr: `min(collection_active_replicas_min{${PEERS}}) < ${QDRANT.tenantReplicationFactor}`,
      for: "15m",
      severity: "warning",
      summary: `A shard has fewer than ${QDRANT.tenantReplicationFactor} active replicas: one more peer lost loses its points`,
      check: `${peerCurl}/collections/piloti_office/cluster`,
      runbook: "replace-a-failed-peer",
    });
  }
  return list;
}

/** YAML-quote a string (JSON strings are valid YAML double-quoted scalars). */
const q = (s: string): string => JSON.stringify(s);

/** The rule file, in Prometheus' `groups:` format. Exported for the spec and the ConfigMap. */
export function qdrantAlertRules(cfg: GridConfig): string {
  const body = rules(cfg)
    .map(
      (r) => `      - alert: ${r.alert}
        expr: ${q(r.expr)}
        for: ${r.for}
        labels:
          severity: ${r.severity}
        annotations:
          summary: ${q(r.summary)}
          check: ${q(r.check)}
          runbook: ${q(`${RUNBOOK}#${r.runbook}`)}`,
    )
    .join("\n");
  return `# Rendered by deploy/pulumi/src/data/qdrant-alerts.ts. Edit there, not here.
groups:
  - name: qdrant
    rules:
${body}
`;
}

/** The alert names, for the spec and the docs. */
export function qdrantAlertNames(cfg: GridConfig): string[] {
  return rules(cfg).map((r) => r.alert);
}
