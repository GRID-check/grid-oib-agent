import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import * as pulumi from "@pulumi/pulumi";
import { NODE_GROUP_LABEL } from "./src/constants";
import { baseStackConfig, langfuseStackConfig } from "./src/test-support/stack-config";

/**
 * Worker-group placement, with the knobs prod sets (IPAX, 2026-10).
 *
 * Prod was placed by hand first: the vector store on `data`, the ingest workers on
 * `batch`, the chat tier on `Node`. A `pulumi up` that renders anything else
 * moves them back, and one that places a tier nobody meant to (a store with a
 * PVC) moves it without its migration. So the whole program is built here and
 * every `nodeSelector` it emits is checked, not just the three expected ones.
 * `index.spec.ts` holds the other half: with the knobs unset, none at all.
 */

type Inputs = Record<string, unknown>;
const RESOURCES: Array<{ type: string; name: string; inputs: Inputs }> = [];

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

/** The prod stack file's config, as `pulumi up` would read it. */
const PROD = (load(readFileSync(join(__dirname, "Pulumi.prod.yaml"), "utf8")) as { config: Record<string, unknown> })
  .config;
const PROD_KNOBS = [
  "nodeGroupApp",
  "nodeGroupData",
  "nodeGroupBatch",
  "ingestWorkerRequestsCpu",
  "ingestWorkerRequestsMemory",
  "ingestWorkerLimitsCpu",
  "ingestWorkerLimitsMemory",
  "seaweedfsTopology",
];

/** Every `nodeSelector` anywhere in a resource's inputs, by resource. */
function nodeSelectors(): Record<string, unknown[]> {
  const found: Record<string, unknown[]> = {};
  const walk = (value: unknown, owner: string): void => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, owner));
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "nodeSelector") (found[owner] ??= []).push(child);
      walk(child, owner);
    }
  };
  for (const r of RESOURCES) walk(r.inputs, `${r.type.split(":").pop()}/${r.name}`);
  return found;
}

/** Pulumi names of the workloads that belong on the data and batch groups. */
const DATA = [
  "grid-pg",
  "grid-pg-pooler-rw",
  "qdrant",
  "seaweedfs",
  "clickhouse",
  "dragonfly",
  "dragonfly-ratelimit",
  "dragonfly-langfuse",
];
const BATCH = ["ingest-worker", "gotenberg", "legacy-corpus-import"];

/** Every resource that makes pods, as `Kind/name`: what must carry a group. */
function workloads(): string[] {
  const podMakers = /:(apps\/v1:(Deployment|StatefulSet)|batch\/v1:(Job|CronJob)|postgresql\.cnpg\.io\/v1:(Cluster|Pooler))$/;
  return RESOURCES.filter((r) => podMakers.test(r.type)).map((r) => `${r.type.split(":").pop()}/${r.name}`);
}

type Pod = {
  metadata: { annotations?: Record<string, string> };
  spec: { containers: Array<{ resources: unknown }> };
};
const podOf = (type: string, name: string): Pod =>
  (RESOURCES.find((r) => r.type === type && r.name === name)!.inputs.spec as { template: Pod }).template;

describe("worker-group placement with prod's knobs", () => {
  beforeAll(async () => {
    // Prod's shape: Langfuse and its ClickHouse, queue and collector deployed,
    // SeaweedFS as one node. Every workload prod runs is rendered and checked.
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...langfuseStackConfig(),
      "grid-oib:observabilityEnabled": "true",
      ...Object.fromEntries(PROD_KNOBS.map((key) => [`grid-oib:${key}`, String(PROD[`grid-oib:${key}`])])),
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("names IPAX's groups as the nodes carry them, case and all", () => {
    expect(PROD["grid-oib:nodeGroupApp"]).toBe("Node");
    expect(PROD["grid-oib:nodeGroupData"]).toBe("data");
    expect(PROD["grid-oib:nodeGroupBatch"]).toBe("batch");
  });

  it("places every workload, the stores on data and ingestion on batch", () => {
    // A group cannot be tainted, so the data nodes stay the stores' only while
    // nothing else selects them: an unplaced pod lands wherever there is room,
    // which on 2026-10-12 was the 32 GB data nodes for the frontend tier, and
    // the Postgres primary, both PgBouncers and every Dragonfly on one app node.
    const selectors = nodeSelectors();
    const unplaced = workloads().filter((w) => !(w in selectors));
    const groupOf = (w: string): string => {
      const found = selectors[w] ?? [];
      expect(found, w).toHaveLength(1);
      return (found[0] as Record<string, string>)[NODE_GROUP_LABEL];
    };

    expect(unplaced).toEqual([]);
    for (const w of workloads()) {
      const name = w.split("/")[1];
      const want = DATA.includes(name) ? "data" : BATCH.includes(name) ? "batch" : "Node";
      expect(groupOf(w), w).toBe(want);
    }
    expect(workloads()).toEqual(expect.arrayContaining(DATA.map((n) => expect.stringContaining(`/${n}`))));
  });

  it("keeps the Postgres instances on different nodes, required", () => {
    const cluster = RESOURCES.find((r) => r.name === "grid-pg")!.inputs as {
      spec: { affinity: { podAntiAffinityType: string; topologyKey: string } };
    };

    expect(cluster.spec.affinity.podAntiAffinityType).toBe("required");
    expect(cluster.spec.affinity.topologyKey).toBe("kubernetes.io/hostname");
  });

  it("spreads the PgBouncers by a label their pods carry, and budgets them by it", () => {
    // CloudNativePG overwrites `app.kubernetes.io/name` and `managed-by` on the
    // pods it builds from the template. Selecting on those matched no pod: the
    // spread did nothing and the PDB guarded nothing (2026-10-12).
    const pooler = RESOURCES.find((r) => r.type.endsWith(":Pooler"))!.inputs as {
      spec: { template: { spec: { topologySpreadConstraints: unknown[] } } };
    };
    const pdb = RESOURCES.find((r) => r.name === "grid-pg-pooler-rw" && r.type.endsWith(":PodDisruptionBudget"))!
      .inputs as { spec: { selector: unknown } };
    const operatorSet = { matchLabels: { "cnpg.io/poolerName": "grid-pg-pooler-rw" } };

    expect(pooler.spec.template.spec.topologySpreadConstraints).toEqual([
      {
        maxSkew: 1,
        topologyKey: "kubernetes.io/hostname",
        whenUnsatisfiable: "DoNotSchedule",
        labelSelector: operatorSet,
      },
    ]);
    expect(pdb.spec.selector).toEqual(operatorSet);
  });

  it("selects on the label IPAX sets", () => {
    expect(NODE_GROUP_LABEL).toBe("k8s.at/node-group");
  });

  it("sizes prod's ingest workers for big PDFs on the batch nodes", () => {
    // OOMKilled at a 6Gi limit with three files in parallel (2026-10).
    const [container] = podOf("kubernetes:apps/v1:Deployment", "ingest-worker").spec.containers;

    expect(container.resources).toEqual({
      requests: { cpu: "500m", memory: "8Gi" },
      limits: { cpu: "4", memory: "12Gi" },
    });
  });

  it("keeps Qdrant's autoscaler annotation on the data group too", () => {
    const pod = podOf("kubernetes:apps/v1:StatefulSet", "qdrant");

    expect(pod.metadata.annotations?.["cluster-autoscaler.kubernetes.io/safe-to-evict"]).toBe("false");
  });

  it.each(["Node group", "-data", "batch/x", "x".repeat(64)])(
    "refuses a group name no node label can carry: %s",
    async (value) => {
      const { loadConfig } = await import("./src/config");
      pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:nodeGroupData": value });

      expect(() => loadConfig()).toThrow(/grid-oib:nodeGroupData must be a Kubernetes label value/);
    },
  );
});
