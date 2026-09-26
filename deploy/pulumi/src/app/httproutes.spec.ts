import { describe, it, expect, beforeAll } from "vitest";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * Edge policies on the public routes (`app/httproutes.ts`).
 *
 * Every field here is a string the API server accepts whatever it says: a
 * compressor on the wrong route, or under a name the installed CRD does not
 * know, plans and applies clean. So the assertions read the exact spec sent.
 */

type Policy = { metadata: { name: string }; spec: Record<string, unknown> };
const POLICIES: Policy[] = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      if (args.inputs.kind === "BackendTrafficPolicy") POLICIES.push(args.inputs as Policy);
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

function policy(name: string): Record<string, unknown> {
  const found = POLICIES.find((p) => p.metadata.name === name);
  if (!found) throw new Error(`no BackendTrafficPolicy named ${name}`);
  return found.spec;
}

describe("BackendTrafficPolicies", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:observabilityEnabled": "false" });
    const { loadConfig } = await import("../config");
    const { installHttpRoutes } = await import("./httproutes");
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const routes = installHttpRoutes(loadConfig(), provider, "grid", []);
    // Registration is asynchronous; the policies depend on the routes, so
    // draining the route outputs and one more tick leaves POLICIES complete.
    await Promise.all(
      Object.values(routes).map((r) => new Promise((resolve) => r.id.apply(resolve))),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("creates one policy per public route", () => {
    expect(POLICIES.map((p) => p.metadata.name).sort()).toEqual([
      "grid-app-timeouts",
      "grid-s3-timeouts",
      "grid-web-timeouts",
    ]);
  });

  it("compresses the landing site, Brotli first", () => {
    // `compressor`, the field EG v1.6+ reads; order is the tie-break when a
    // browser sends br and gzip at equal weight, which every browser does.
    expect(policy("grid-web-timeouts").compressor).toEqual([{ type: "Brotli" }, { type: "Gzip" }]);
    expect(policy("grid-web-timeouts")).not.toHaveProperty("compression");
  });

  it("leaves the streaming app route and presigned S3 bodies uncompressed", () => {
    // The app route carries the chat token stream; a compressor there is a
    // decision that needs its own measurement, not a side effect of this one.
    for (const name of ["grid-app-timeouts", "grid-s3-timeouts"]) {
      expect(policy(name)).not.toHaveProperty("compressor");
      expect(policy(name)).not.toHaveProperty("compression");
    }
  });
});
