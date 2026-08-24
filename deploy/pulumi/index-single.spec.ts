import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";

/**
 * The same whole-program construction as `index.spec.ts`, in the OTHER
 * topology.
 *
 * A separate file rather than a second `describe`, because `index.ts` does its
 * work at module scope and Pulumi's runtime holds process-global state — so
 * one process can build the stack exactly once. Vitest isolates test files,
 * which is what makes two configurations testable at all.
 *
 * This is the branch every existing stack is pinned to, so its job is narrow
 * and important: prove that `seaweedfsTopology: single` still produces the
 * one-workload layout, that the split workloads are absent, and that the
 * ordering the split branch needs has not leaked into it.
 */

const RESOURCES: Array<{ type: string; name: string }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name });
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

describe("the program constructs in the single-node topology", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:seaweedfsTopology": "single",
      "grid-oib:seaweedfsPerOrgBuckets": "false",
      "grid-oib:pgBackupsEnabled": "true",
      "grid-oib:observabilityEnabled": "false",
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  function named(type: string): string[] {
    return RESOURCES.filter((r) => r.type === type).map((r) => r.name);
  }

  it("creates exactly one SeaweedFS workload", () => {
    const statefulSets = named("kubernetes:apps/v1:StatefulSet");
    expect(statefulSets).toContain("seaweedfs");
    expect(statefulSets).not.toContain("seaweedfs-master");
    expect(statefulSets).not.toContain("seaweedfs-volume");
    expect(statefulSets).not.toContain("seaweedfs-filer");
  });

  it("creates no filer database, because there is no external filer store", () => {
    expect(named("kubernetes:postgresql.cnpg.io/v1:Database")).toEqual([]);
  });

  it("still creates the nightly base backup", () => {
    // Extracted from `installPostgres` for the split branch's sake; it must not
    // have gone missing from the branch that was already working.
    expect(named("kubernetes:postgresql.cnpg.io/v1:ScheduledBackup")).toEqual([
      "pg-scheduled-backup",
    ]);
  });
});
