import { describe, it, expect, beforeAll } from "vitest";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * The two recovery knobs of `data/qdrant.ts`, set: the second key of a key
 * rotation (`qdrantAltApiKey`) and the load mode for a peer that OOMs while
 * loading (`qdrantLowMemoryMode`). Both were drilled against real Qdrant
 * 1.19.2 (`docs/deployment/qdrant-runbook.md`); these hold the manifest to the
 * env names that worked there. Unset, neither reaches the pod
 * (`index-qdrant.spec.ts`).
 */

type Env = { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } };
const RESOURCES: Array<{ type: string; name: string; inputs: unknown }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

function resolve<T>(value: pulumi.Input<T>): Promise<T> {
  return new Promise((done) => pulumi.output(value).apply((v) => done(v as T)));
}

describe("qdrant during a key rotation, loading in low-memory mode", () => {
  let env: Record<string, Env>;
  let secret: Record<string, string>;

  beforeAll(async () => {
    const { loadConfig } = await import("../config");
    const { installQdrant } = await import("./qdrant");
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:qdrantAltApiKey": "qd-next", // pragma: allowlist secret
      "grid-oib:qdrantLowMemoryMode": "no_populate",
    });
    const qdrant = installQdrant(loadConfig(), new k8s.Provider("test", {}), "grid", "http://seaweedfs:8333");
    await Promise.all([qdrant.statefulSet.id, qdrant.snapshotCronJob.id].map(resolve));
    const sts = RESOURCES.find((r) => r.type === "kubernetes:apps/v1:StatefulSet" && r.name === "qdrant")!;
    const spec = await resolve(sts.inputs as { spec: { template: { spec: { containers: Array<{ env: Env[] }> } } } });
    env = Object.fromEntries(spec.spec.template.spec.containers[0].env.map((e) => [e.name, e]));
    const sec = RESOURCES.find((r) => r.type === "kubernetes:core/v1:Secret" && r.name === "qdrant-credentials")!;
    const data = (await resolve(sec.inputs as { stringData: unknown })).stringData as Record<string, unknown>;
    secret = ("value" in data ? data.value : data) as Record<string, string>;
  });

  it("hands every peer the second key from its own Secret, never as a literal", () => {
    expect(env.QDRANT__SERVICE__ALT_API_KEY.valueFrom!.secretKeyRef).toEqual({
      name: "qdrant-credentials",
      key: "alt-api-key",
    });
    expect(env.QDRANT__SERVICE__ALT_API_KEY.value).toBeUndefined();
    expect(secret["alt-api-key"]).toBe("qd-next");
    // Peers still present the first key on p2p: internal auth stays on.
    expect(env.QDRANT__SERVICE__ENFORCE_INTERNAL_AUTH.value).toBe("true");
  });

  it("sets the load mode under the key Qdrant reads (`storage.low_memory_mode`)", () => {
    expect(env.QDRANT__STORAGE__LOW_MEMORY_MODE.value).toBe("no_populate");
  });
});
