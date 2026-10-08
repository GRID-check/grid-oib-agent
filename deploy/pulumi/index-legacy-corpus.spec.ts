import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";

/**
 * The pre-A2 base corpus is carried off the old backend data volume by a
 * one-shot Job (ADR-0082 A2), so an upgrade needs no re-upload by hand. The Job
 * must mount the claim the stack names read-only, run the importer against the
 * mount, and wait for the new StatefulSet (the claim is ReadWriteOnce) and the
 * frontend (the BFF signs the uploads).
 */

type Inputs = Record<string, unknown>;
const RESOURCES: Array<{ type: string; name: string; inputs: Inputs }> = [];

interface JobPod {
  volumes: unknown[];
  containers: Array<{ command: string[]; volumeMounts: unknown[]; env: Array<{ name: string }> }>;
}

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

describe("the legacy corpus import Job", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:legacyCorpusClaim": "data-aiq-agent-0" });
    await import("./index");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("mounts the named claim read-only and runs the importer on the mount", () => {
    const job = RESOURCES.find((r) => r.type === "kubernetes:batch/v1:Job" && r.name === "legacy-corpus-import");
    expect(job).toBeDefined();
    const pod = (job!.inputs.spec as { template: { spec: JobPod } }).template.spec;
    expect(pod.volumes).toEqual([
      { name: "legacy", persistentVolumeClaim: { claimName: "data-aiq-agent-0", readOnly: true } },
    ]);
    const container = pod.containers[0];
    expect(container.command).toEqual(["python", "-m", "aiq_agent.legacy_corpus_import", "/legacy"]);
    expect(container.volumeMounts).toEqual([{ name: "legacy", mountPath: "/legacy", readOnly: true }]);
    const env = new Set(container.env.map((e) => e.name));
    for (const name of ["AIQ_SUMMARY_DB", "FRONTEND_INTERNAL_URL", "GRID_INTERNAL_API_TOKEN"]) {
      expect(env, name).toContain(name);
    }
  });
});
