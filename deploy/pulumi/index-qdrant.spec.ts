import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { NODE_GROUP_LABEL } from "./src/constants";
import { baseStackConfig } from "./src/test-support/stack-config";
import { DependencyGraph } from "./src/test-support/dependency-graph";

/**
 * Qdrant, the one vector store (ADR-0113), with three peers and a data group:
 * the whole program built once and every manifest string the design (`qdrant-retrieval-design.md` §9) depends on checked.
 *
 * Each of these is a value that plans clean and fails only on a cluster: a
 * liveness probe on `/readyz` cascades restarts during Raft catch-up, a
 * bootstrap URI the peers cannot resolve leaves three one-node clusters, a
 * caller missing from the NetworkPolicy times out on every search.
 * `bootstrapScript` and `snapshotScript` were also run against real
 * `qdrant/qdrant:v1.19.2`, `chrislusf/seaweedfs:3.80` and `curlimages/curl`
 * containers when they were written; this suite holds the strings to what ran.
 */

type Env = { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } };
type Container = {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: Env[];
  ports?: Array<{ containerPort: number; name: string }>;
  resources: { requests: Record<string, string>; limits: Record<string, string> };
  startupProbe?: { httpGet: { path: string; port: number }; periodSeconds: number; failureThreshold: number };
  readinessProbe?: { httpGet: { path: string; port: number } };
  livenessProbe?: { httpGet: { path: string; port: number } };
  securityContext?: Record<string, unknown>;
  volumeMounts?: Array<{ name: string; mountPath: string }>;
};
type PodSpec = {
  nodeSelector?: Record<string, string>;
  affinity?: { podAntiAffinity: Record<string, unknown> };
  terminationGracePeriodSeconds?: number;
  enableServiceLinks?: boolean;
  securityContext?: Record<string, unknown>;
  containers: Container[];
  volumes?: Array<{ name: string; emptyDir?: object }>;
};
type Port = { port: number };
type PolicyPeer = { podSelector: { matchLabels: Record<string, string> } };
type Manifests = {
  StatefulSet: {
    spec: {
      podManagementPolicy?: string;
      replicas: number;
      serviceName: string;
      updateStrategy: unknown;
      minReadySeconds: number;
      persistentVolumeClaimRetentionPolicy: unknown;
      volumeClaimTemplates: unknown;
      template: { spec: PodSpec };
    };
  };
  Deployment: { spec: { template: { spec: PodSpec } } };
  Service: { spec: { clusterIP?: string; publishNotReadyAddresses?: boolean; ports: Port[] } };
  CronJob: {
    spec: { schedule: string; concurrencyPolicy: string; jobTemplate: { spec: { template: { spec: PodSpec } } } };
  };
  Job: { spec: unknown };
  PodDisruptionBudget: { spec: { maxUnavailable: number } };
  NetworkPolicy: {
    spec: {
      podSelector: { matchExpressions: Array<{ values: string[] }> };
      ingress: Array<{ from: PolicyPeer[]; ports: Port[] }>;
    };
  };
  Secret: { stringData: Record<string, string> | { value: Record<string, string> } };
  ConfigMap: { data: Record<string, string> };
};

const RESOURCES: Array<{ type: string; name: string; inputs: unknown }> = [];
let STACK: Record<string, unknown> = {};
let graph: DependencyGraph;

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return {
        id: `${args.name}-id`,
        state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
      };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

const TYPE = {
  StatefulSet: "kubernetes:apps/v1:StatefulSet",
  Deployment: "kubernetes:apps/v1:Deployment",
  Service: "kubernetes:core/v1:Service",
  CronJob: "kubernetes:batch/v1:CronJob",
  Job: "kubernetes:batch/v1:Job",
  PodDisruptionBudget: "kubernetes:policy/v1:PodDisruptionBudget",
  NetworkPolicy: "kubernetes:networking.k8s.io/v1:NetworkPolicy",
  Secret: "kubernetes:core/v1:Secret",
  ConfigMap: "kubernetes:core/v1:ConfigMap",
} as const;
const DEPLOYMENT = TYPE.Deployment;
const SERVICE = TYPE.Service;

/** The mock's inputs of one resource, read with the fields these cases use. */
function find<K extends keyof Manifests>(kind: K, name: string): Manifests[K] {
  const hit = RESOURCES.find((r) => r.type === TYPE[kind] && r.name === name);
  expect(hit, `${kind} ${name}`).toBeDefined();
  return hit!.inputs as Manifests[K];
}
const qdrantPod = (): PodSpec => find("StatefulSet", "qdrant").spec.template.spec;
/** A Secret's `stringData`, unwrapped from the mock's secret envelope. */
const secretData = (name: string): Record<string, string> => {
  const data = find("Secret", name).stringData;
  return "value" in data && typeof data.value === "object" ? data.value : (data as Record<string, string>);
};
const envOf = (c: Container) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e]));

describe("Qdrant, three peers on the data group", () => {
  beforeAll(async () => {
    graph = new DependencyGraph();
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:nodeGroupData": "data",
      "grid-oib:nodeGroupApp": "Node",
      "grid-oib:observabilityEnabled": "false",
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    STACK = stack;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("runs a Parallel StatefulSet of three peers behind the headless Service", () => {
    const spec = find("StatefulSet", "qdrant").spec;
    // OrderedReady deadlocks the bootstrap; the policy pack allows this one.
    expect(spec.podManagementPolicy).toBe("Parallel");
    expect(spec.replicas).toBe(3);
    expect(spec.serviceName).toBe("qdrant-headless");
    expect(spec.updateStrategy).toEqual({ type: "RollingUpdate" });
    expect(spec.minReadySeconds).toBe(30);
  });

  it("keeps the data volumes through a delete or a scale-down", () => {
    const spec = find("StatefulSet", "qdrant").spec;
    expect(spec.persistentVolumeClaimRetentionPolicy).toEqual({ whenDeleted: "Retain", whenScaled: "Retain" });
    expect(spec.volumeClaimTemplates).toEqual([
      {
        metadata: { name: "data" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "premium",
          resources: { requests: { storage: "100Gi" } },
        },
      },
    ]);
  });

  it("bootstraps every peer from qdrant-0 by its namespaced headless name", () => {
    const [container] = qdrantPod().containers;
    const script = container.args![0];
    expect(container.command).toEqual(["/bin/bash", "-c"]);
    expect(script).toContain(`exec ./entrypoint.sh --uri 'http://qdrant-0.qdrant-headless.grid:6335'`);
    expect(script).toContain(
      `exec ./entrypoint.sh --bootstrap 'http://qdrant-0.qdrant-headless.grid:6335' ` +
        `--uri "http://qdrant-\${ordinal}.qdrant-headless.grid:6335"`,
    );
    expect(script).toContain('ordinal="${HOSTNAME##*-}"');
  });

  it("probes readiness on /readyz and liveness on /livez, never liveness on /readyz", () => {
    const [container] = qdrantPod().containers;
    expect(container.readinessProbe!.httpGet).toEqual({ path: "/readyz", port: 6333 });
    expect(container.livenessProbe!.httpGet).toEqual({ path: "/livez", port: 6333 });
    expect(container.startupProbe!.httpGet).toEqual({ path: "/livez", port: 6333 });
    // Generous: loading segments precedes the API.
    expect(container.startupProbe!.periodSeconds * container.startupProbe!.failureThreshold).toBeGreaterThanOrEqual(600);
  });

  it("gives the WAL flush 120 s and memory request = limit", () => {
    const pod = qdrantPod();
    expect(pod.terminationGracePeriodSeconds).toBe(120);
    expect(pod.containers[0].resources).toEqual({
      requests: { cpu: "4", memory: "16Gi" },
      limits: { cpu: "4", memory: "16Gi" },
    });
  });

  it("runs as uid 1000 on a read-only root, with emptyDirs where the image writes", () => {
    const pod = qdrantPod();
    const [container] = pod.containers;
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 });
    expect(container.securityContext).toMatchObject({ readOnlyRootFilesystem: true, allowPrivilegeEscalation: false });
    expect(container.volumeMounts).toEqual([
      { name: "data", mountPath: "/qdrant/storage" },
      { name: "snapshots", mountPath: "/qdrant/snapshots" },
      { name: "init", mountPath: "/qdrant/init" },
    ]);
    expect(envOf(container).QDRANT_INIT_FILE_PATH.value).toBe("/qdrant/init/.qdrant-initialized");
    expect(pod.enableServiceLinks).toBe(false);
  });

  it("pins peers to the data group, one per node, required", () => {
    const pod = qdrantPod();
    expect(pod.nodeSelector).toEqual({ [NODE_GROUP_LABEL]: "data" });
    expect(pod.affinity!.podAntiAffinity).toEqual({
      requiredDuringSchedulingIgnoredDuringExecution: [
        {
          labelSelector: { matchLabels: expect.objectContaining({ "app.kubernetes.io/name": "qdrant" }) },
          topologyKey: "kubernetes.io/hostname",
        },
      ],
    });
  });

  it("enables cluster mode, both keys from its own Secret, and internal auth", () => {
    const env = envOf(qdrantPod().containers[0]);
    expect(env.QDRANT__CLUSTER__ENABLED.value).toBe("true");
    expect(env.QDRANT__SERVICE__ENFORCE_INTERNAL_AUTH.value).toBe("true");
    expect(env.QDRANT__TELEMETRY_DISABLED.value).toBe("true");
    expect(env.QDRANT__SERVICE__API_KEY.valueFrom!.secretKeyRef).toEqual({ name: "qdrant-credentials", key: "api-key" });
    expect(env.QDRANT__SERVICE__READ_ONLY_API_KEY.valueFrom!.secretKeyRef).toEqual({
      name: "qdrant-credentials",
      key: "read-only-api-key",
    });
    expect(secretData("qdrant-credentials")).toEqual({
      "api-key": "qd-rw",
      "read-only-api-key": "qd-ro",
      "s3-secret-key": "qd-s3",
    });
  });

  it("sends snapshots to the SeaweedFS bucket as the grid-qdrant identity", () => {
    const env = envOf(qdrantPod().containers[0]);
    const s3 = "QDRANT__STORAGE__SNAPSHOTS_CONFIG__";
    expect(env[`${s3}SNAPSHOTS_STORAGE`].value).toBe("s3");
    expect(env[`${s3}S3_CONFIG__BUCKET`].value).toBe("qdrant-snapshots");
    expect(env[`${s3}S3_CONFIG__ENDPOINT_URL`].value).toBe("http://seaweedfs:8333");
    expect(env[`${s3}S3_CONFIG__ACCESS_KEY`].value).toBe("grid-qdrant");
    expect(env[`${s3}S3_CONFIG__SECRET_KEY`].valueFrom!.secretKeyRef).toEqual({
      name: "qdrant-credentials",
      key: "s3-secret-key",
    });
    // The init Job creates the bucket and verifies it.
    expect(JSON.stringify(find("Job", "seaweedfs-bucket-init").spec)).toContain(
      "s3.bucket.create -name qdrant-snapshots",
    );
  });

  it("publishes the four ports on the headless Service, not-ready addresses included", () => {
    const spec = find("Service", "qdrant-headless").spec;
    expect(spec.clusterIP).toBe("None");
    expect(spec.publishNotReadyAddresses).toBe(true);
    expect(spec.ports.map((p) => p.port)).toEqual([6333, 6334, 6335, 6336]);
    // Clients never see p2p, nor the keyless metrics port.
    expect(find("Service", "qdrant").spec.ports.map((p) => p.port)).toEqual([6333, 6334]);
  });

  // `service.metrics_port` serves /metrics without the key and nothing else
  // (drilled: 200 there, 401 on 6333, 404 for any other path on it).
  it("serves /metrics on its own keyless port", () => {
    const [container] = qdrantPod().containers;
    expect(envOf(container).QDRANT__SERVICE__METRICS_PORT.value).toBe("6336");
    expect(container.ports).toContainEqual({ containerPort: 6336, name: "metrics" });
  });

  // 507 near the limits instead of an OOM kill or a full volume; the env path
  // and the quota_exceeded metric were checked against the real image.
  it("turns the quotas on below the memory limit and a full volume", () => {
    const env = envOf(qdrantPod().containers[0]);
    expect(env.QDRANT__STORAGE__QUOTAS__ENABLED.value).toBe("true");
    expect(env.QDRANT__STORAGE__QUOTAS__MAX_RESIDENT_MEMORY_PERCENT.value).toBe("90");
    expect(env.QDRANT__STORAGE__QUOTAS__MAX_DISK_USAGE_PERCENT.value).toBe("85");
    // Recovery knobs stay off unless set.
    expect(env.QDRANT__STORAGE__LOW_MEMORY_MODE).toBeUndefined();
    expect(env.QDRANT__SERVICE__ALT_API_KEY).toBeUndefined();
  });

  it("lets a drain take one peer at a time", () => {
    expect(find("PodDisruptionBudget", "qdrant").spec.maxUnavailable).toBe(1);
  });

  it("snapshots every peer daily with a pinned curl image on the app group", () => {
    const cron = find("CronJob", "qdrant-snapshot").spec;
    const pod = cron.jobTemplate.spec.template.spec;
    const [container] = pod.containers;
    expect(cron.schedule).toBe("30 1 * * *");
    expect(cron.concurrencyPolicy).toBe("Forbid");
    expect(container.image).toBe("curlimages/curl:8.16.0");
    expect(container.command!.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(container.command![2]).toMatch(/^set -eu -o pipefail/);
    expect(pod.nodeSelector).toEqual({ [NODE_GROUP_LABEL]: "Node" });
    const env = envOf(container);
    expect(env.PEERS.value!.split(" ")).toEqual([0, 1, 2].map(
      (i) => `http://qdrant-${i}.qdrant-headless.grid.svc.cluster.local:6333`,
    ));
    expect(env.RETENTION_DAYS.value).toBe("7");
    expect(env.QDRANT_API_KEY.valueFrom!.secretKeyRef).toEqual({ name: "qdrant-credentials", key: "api-key" });
  });

  // Aliases live in consensus, not in any snapshot: a cluster restored from
  // snapshots alone answers every search "collection not found".
  it("records the aliases beside the snapshots, as the snapshot identity", () => {
    const [container] = find("CronJob", "qdrant-snapshot").spec.jobTemplate.spec.template.spec.containers;
    const env = envOf(container);
    // The same endpoint Qdrant uploads its snapshots to.
    expect(env.S3_ENDPOINT.value).toBe("http://seaweedfs:8333");
    expect(env.S3_BUCKET.value).toBe("qdrant-snapshots");
    expect(env.S3_ACCESS_KEY.value).toBe("grid-qdrant");
    expect(env.S3_SECRET_KEY.valueFrom!.secretKeyRef).toEqual({ name: "qdrant-credentials", key: "s3-secret-key" });
    expect(env.ALIASES_PREFIX.value).toBe("aliases/");
    const script = container.command![2];
    expect(script).toContain('--aws-sigv4 "aws:amz:$S3_REGION:s3"');
    // Called, and before the snapshot loop, so a long pass cannot starve it.
    const call = script.indexOf("\nrecord_aliases\n");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(script.indexOf("\nfor peer in $PEERS; do\n  collections="));
  });

  it("ships the alert rules, rendered against this stack's memory limit", () => {
    const rules = find("ConfigMap", "qdrant-alert-rules").data["qdrant.rules.yaml"];
    expect(rules).toContain("alert: QdrantPeerDown");
    expect(rules).toContain(`memory_resident_bytes{job=\\"qdrant\\"}) / ${16 * 2 ** 30} > 0.8`);
  });

  it("hands every backend tier the URL and the key, and no Chroma or backend selector", () => {
    const tiers: Array<["StatefulSet" | "Deployment", string]> = [
      ["StatefulSet", "aiq-agent"],
      ["Deployment", "aiq-api"],
      ["Deployment", "agent-worker"],
      ["Deployment", "ingest-worker"],
    ];
    for (const [kind, name] of tiers) {
      const env = envOf(find(kind, name).spec.template.spec.containers[0]);
      expect(env.AIQ_QDRANT_URL?.value, name).toBe("http://qdrant.grid.svc.cluster.local:6333");
      expect(env.AIQ_QDRANT_API_KEY?.valueFrom?.secretKeyRef, name).toEqual({
        name: "grid-secrets",
        key: "AIQ_QDRANT_API_KEY",
      });
      // The tenant collection spread over the peers, not created on one.
      expect(env.AIQ_QDRANT_SHARD_NUMBER?.value, name).toBe("6");
      expect(env.AIQ_QDRANT_REPLICATION_FACTOR?.value, name).toBe("2");
      // Qdrant is the only store: nothing points a tier at Chroma or picks between the two.
      const retired = Object.keys(env).filter((k) => k.startsWith("AIQ_CHROMA") || k === "AIQ_VECTOR_BACKEND");
      expect(retired, name).toEqual([]);
    }
    expect(secretData("grid-secrets").AIQ_QDRANT_API_KEY).toBe("qd-rw");
  });

  it("rolls the backend tiers out after Qdrant is up", () => {
    expect(graph.waitsOn(DEPLOYMENT, "aiq-api", SERVICE, "qdrant")).toBe(true);
    expect(graph.waitsOn(DEPLOYMENT, "ingest-worker", SERVICE, "qdrant")).toBe(true);
    expect(graph.waitsOn(DEPLOYMENT, "agent-worker", SERVICE, "qdrant")).toBe(true);
  });

  it("withholds Qdrant from the namespace allow and names its callers", () => {
    const policy = (name: string) => find("NetworkPolicy", name).spec;
    expect(policy("allow-same-namespace").podSelector.matchExpressions[0].values).toContain("qdrant");

    const app = policy("allow-app-to-qdrant").ingress[0];
    const callers = app.from.map((f) => f.podSelector.matchLabels["app.kubernetes.io/name"]);
    expect(callers).toEqual(
      expect.arrayContaining([
        "aiq-agent",
        "aiq-api",
        "agent-worker",
        "ingest-worker",
        "qdrant-snapshot",
        "chroma-migration",
        "qdrant-ops",
      ]),
    );
    expect(app.ports.map((p) => p.port)).toEqual([6333, 6334]);

    const peers = policy("qdrant-peers").ingress[0];
    expect(peers.from).toEqual([{ podSelector: { matchLabels: { "app.kubernetes.io/name": "qdrant" } } }]);
    expect(peers.ports.map((p) => p.port)).toEqual([6333, 6334, 6335]);
    // No collector on this stack, so nobody is admitted to the metrics port.
    expect(RESOURCES.some((r) => r.name === "allow-collector-to-qdrant-metrics")).toBe(false);
  });

  it("exports the in-cluster URL", () => {
    return new Promise<void>((resolve) =>
      (STACK.qdrantUrl as pulumi.Output<string>).apply((url) => {
        expect(url).toBe("http://qdrant.grid.svc.cluster.local:6333");
        resolve();
      }),
    );
  });
});
