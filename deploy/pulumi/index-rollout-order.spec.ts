import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";
import { DependencyGraph } from "./src/test-support/dependency-graph";

/**
 * The api tier rolls out first, then the frontend, then the chat tier
 * (ADR-0082 step B), so an upgrade needs no sequencing by hand.
 *
 * A frontend from before the split sends every HTTP call to `aiq-agent`, and a
 * new `aiq-agent` serves only the chat socket: chat first, and every API call
 * from the old frontend 404s until the frontend catches up. The new frontend
 * calls `aiq-api`, so that must exist before it. Pulumi awaits a workload's
 * rollout before it creates what depends on it, so `dependsOn` is the whole
 * mechanism, and nothing in a green `pulumi up` says it went missing.
 *
 * Nothing here contacts a cluster. It reads the dependencies the SDK registers.
 */

const DEPLOYMENT = "kubernetes:apps/v1:Deployment";
const STATEFULSET = "kubernetes:apps/v1:StatefulSet";
const SERVICE = "kubernetes:core/v1:Service";

let graph: DependencyGraph;

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
    }),
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

describe("rollout order: api, then the frontend, then chat", () => {
  beforeAll(async () => {
    graph = new DependencyGraph();
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:observabilityEnabled": "false" });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("rolls the frontend out only after the api Service", () => {
    expect(graph.waitsOn(DEPLOYMENT, "frontend", SERVICE, "aiq-api")).toBe(true);
  });

  it("rolls the chat StatefulSet out only after the frontend Deployment", () => {
    expect(graph.waitsOn(STATEFULSET, "aiq-agent", DEPLOYMENT, "frontend")).toBe(true);
  });

  it("never makes the frontend wait on the chat tier, which would be a cycle", () => {
    expect(graph.waitsOn(DEPLOYMENT, "frontend", STATEFULSET, "aiq-agent")).toBe(false);
    expect(graph.waitsOn(DEPLOYMENT, "frontend", SERVICE, "aiq-agent")).toBe(false);
  });
});
