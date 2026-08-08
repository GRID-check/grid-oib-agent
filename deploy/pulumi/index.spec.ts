import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";

/**
 * Does the whole program construct, in both SeaweedFS topologies?
 *
 * `src/data/seaweedfs.spec.ts` asserts the manifests one module at a time.
 * This asserts the thing no per-module test can: that `index.ts` wires them
 * together without a cycle, in either branch of the ordering it now has to
 * choose between (ADR-0043 — Postgres archives WAL into a SeaweedFS bucket,
 * and the split filer keeps its namespace in a Postgres database, so one of
 * the two has to go first and which one depends on the configuration).
 *
 * A dependency cycle in Pulumi is not a compile error and not a type error. It
 * surfaces as `pulumi up` hanging or failing partway through, on a stack that
 * has already started mutating. This runs the same construction with mocked
 * resources, so the cycle — or an undefined value read from a resource created
 * later in the file — shows up in two seconds instead.
 *
 * It does NOT prove the stack deploys. Nothing here contacts an API server.
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

/**
 * Build the whole stack once, in the split+Postgres configuration — the branch
 * where the ordering is a real cycle and therefore the one worth exercising.
 * `index.ts` runs its work at module scope, so importing it IS the test.
 */
describe("the program constructs in the split topology", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:seaweedfsTopology": "split",
      "grid-oib:seaweedfsFilerStore": "postgres",
      "grid-oib:seaweedfsPerOrgBuckets": "true",
      // The configuration that makes the ordering a cycle: Postgres wants the
      // archive bucket to exist before it boots, and the filer wants the
      // Postgres database to exist before IT boots.
      "grid-oib:pgBackupsEnabled": "true",
      "grid-oib:observabilityEnabled": "false",
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    // Importing the module is not enough. Pulumi registers resources
    // asynchronously, so the import resolves before a single `newResource` has
    // fired. Resolving every exported Output drains that queue — which is also
    // the only way a cycle would show up here rather than as a hang on a real
    // `pulumi up`.
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  function named(type: string): string[] {
    return RESOURCES.filter((r) => r.type === type).map((r) => r.name);
  }

  it("creates all three SeaweedFS workloads", () => {
    expect(named("kubernetes:apps/v1:StatefulSet")).toEqual(
      expect.arrayContaining(["seaweedfs-master", "seaweedfs-volume", "seaweedfs-filer"]),
    );
  });

  it("creates the filer's Postgres database and the nightly base backup", () => {
    // The base backup is a separate resource specifically so it can be ordered
    // after bucket-init; if it ever folds back into `installPostgres` it will
    // fire before the archive bucket exists, fail, and not retry until 02:00.
    expect(named("kubernetes:postgresql.cnpg.io/v1:Database")).toEqual(["pg-seaweedfs-filer-db"]);
    expect(named("kubernetes:postgresql.cnpg.io/v1:ScheduledBackup")).toEqual([
      "pg-scheduled-backup",
    ]);
  });

  it("keeps the S3 endpoint on the name the app tier already uses", () => {
    // A rename here silently removes the `allow-edge-to-seaweedfs` NetworkPolicy
    // from the pods that serve S3, and breaks `SEAWEED_ENDPOINT` for every tier.
    expect(named("kubernetes:core/v1:Service")).toEqual(
      expect.arrayContaining(["seaweedfs", "seaweedfs-master-svc"]),
    );
  });
});
