import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { load } from "js-yaml";
import { baseStackConfig } from "./src/test-support/stack-config";

/**
 * Qdrant's metrics, end to end through the manifests: the whole program built
 * once with Qdrant (three peers) and the collector both on.
 *
 * Nothing here would fail a plan. A scrape target on the ClusterIP Service
 * samples a different peer each time; a missing NetworkPolicy rule reads as
 * `up == 0` for every peer, which is indistinguishable from the cluster being
 * down; a collector given the API key is one more holder of a key that writes
 * every office's vectors. The rendered config was also run in the pinned
 * collector image against three real `qdrant/qdrant:v1.19.2` peers (the
 * 2026-10-13 drill, `docs/deployment/qdrant-runbook.md`); this suite holds the
 * strings to what ran.
 */

type Env = { name: string; value?: string; valueFrom?: unknown };
type Policy = {
  spec: {
    podSelector: { matchLabels: Record<string, string> };
    ingress: Array<{ from: Array<{ podSelector: { matchLabels: Record<string, string> } }>; ports: Array<{ port: number }> }>;
  };
};
type CollectorConfig = {
  receivers: Record<string, { config?: { scrape_configs: ScrapeConfig[] } }>;
  exporters: Record<string, { endpoint?: string }>;
  service: { pipelines: Record<string, { receivers: string[]; exporters: string[] }> };
};
type ScrapeConfig = {
  job_name: string;
  metrics_path: string;
  scrape_interval: string;
  static_configs: Array<{ targets: string[]; labels: { peer: string } }>;
};

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } } };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

function find(type: string, name: string): Record<string, unknown> {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  expect(hit, `${type} ${name}`).toBeDefined();
  return hit!.inputs;
}

let collector: CollectorConfig;

describe("Qdrant metrics through the collector", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig(baseStackConfig());
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
    const data = find("kubernetes:core/v1:ConfigMap", "otel-collector").data as Record<string, string>;
    collector = load(data["collector.yaml"]) as CollectorConfig;
  }, 120_000);

  it("scrapes every peer by its headless name on the metrics port, each labelled", () => {
    const scrape = collector.receivers["prometheus/qdrant"].config!.scrape_configs;
    expect(scrape).toHaveLength(1);
    expect(scrape[0]).toMatchObject({ job_name: "qdrant", metrics_path: "/metrics", scrape_interval: "30s" });
    expect(scrape[0].static_configs).toEqual(
      [0, 1, 2].map((i) => ({
        targets: [`qdrant-${i}.qdrant-headless.grid.svc.cluster.local:6336`],
        labels: { peer: `qdrant-${i}` },
      })),
    );
  });

  it("re-exposes the series on :8889 through a pipeline of its own", () => {
    expect(collector.exporters.prometheus.endpoint).toBe("0.0.0.0:8889");
    expect(collector.service.pipelines["metrics/qdrant"]).toMatchObject({
      receivers: ["prometheus/qdrant"],
      exporters: ["prometheus"],
    });
    // The OTLP pipelines keep their receivers; the scrape feeds metrics only.
    expect(collector.service.pipelines.traces.receivers).toEqual(["otlp"]);
    const ports = (find("kubernetes:core/v1:Service", "otel-collector").spec as { ports: Array<{ port: number; name: string }> }).ports;
    expect(ports).toContainEqual(expect.objectContaining({ port: 8889, name: "metrics" }));
  });

  // The collector reads its file once, at start, and the ConfigMap keeps its
  // name: without the config in the pod's digest, turning Qdrant on would add
  // a pipeline that waits for the next unrelated restart.
  it("rolls the collector when its config changes", async () => {
    const { loadConfig } = await import("./src/config");
    const { secretChecksum, SECRET_CHECKSUM_ANNOTATION } = await import("./src/platform/rollout");
    const { langfuseOtlpBasicAuth } = await import("./src/platform/langfuse");
    const cfg = loadConfig();
    const data = (find("kubernetes:core/v1:ConfigMap", "otel-collector").data as Record<string, string>)["collector.yaml"];
    const template = (find("kubernetes:apps/v1:Deployment", "otel-collector").spec as {
      template: { metadata: { annotations: Record<string, string> } };
    }).template;
    const expected = await new Promise<string>((done) =>
      secretChecksum({
        ...(cfg.langfuse.enabled ? { "langfuse-otlp-auth": langfuseOtlpBasicAuth(cfg) } : {}),
        "collector.yaml": data,
      }).apply(done),
    );
    expect(template.metadata.annotations[SECRET_CHECKSUM_ANNOTATION]).toBe(expected);
  });

  it("gives the collector no Qdrant credential: the metrics port needs none", () => {
    const pod = (find("kubernetes:apps/v1:Deployment", "otel-collector").spec as {
      template: { spec: { containers: Array<{ env?: Env[] }> } };
    }).template.spec;
    const env = pod.containers[0].env ?? [];
    expect(JSON.stringify(env)).not.toContain("qdrant");
  });

  it("admits the collector to the metrics port alone, and nothing else to it", () => {
    const rule = find("kubernetes:networking.k8s.io/v1:NetworkPolicy", "allow-collector-to-qdrant-metrics") as Policy;
    expect(rule.spec.podSelector.matchLabels).toEqual({ "app.kubernetes.io/name": "qdrant" });
    expect(rule.spec.ingress).toEqual([
      {
        from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "otel-collector" } } }],
        ports: [{ protocol: "TCP", port: 6336 }],
      },
    ]);
    // The client and peer rules never open 6336, so this rule is its only door.
    for (const name of ["allow-app-to-qdrant", "qdrant-peers"]) {
      const ports = (find("kubernetes:networking.k8s.io/v1:NetworkPolicy", name) as Policy).spec.ingress[0].ports;
      expect(ports.map((p) => p.port), name).not.toContain(6336);
    }
  });
});
