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

type Selector = {
  sourceCIDR: { value: string; type: string };
  path?: { type: string; value: string; invert?: boolean };
};
type Rule = { clientSelectors: Selector[]; limit: { requests: number; unit: string } };

function appRules(): Rule[] {
  const spec = policy("grid-app-timeouts") as { rateLimit?: { global?: { rules: Rule[] } } };
  return spec.rateLimit?.global?.rules ?? [];
}

describe("the project mail inbox webhook at the edge", () => {
  const PATH = "/api/internal/inbound-mail";

  it("has a per-client bucket of its own, in both address families", () => {
    // All inbound mail arrives from Cloudflare's shared egress addresses.
    const own = appRules().filter((r) => {
      const path = r.clientSelectors[0].path;
      return path?.value === PATH && path.invert !== true;
    });
    expect(own.map((r) => r.clientSelectors[0].sourceCIDR.value).sort()).toEqual([
      "0.0.0.0/0",
      "::/0",
    ]);
    for (const rule of own) {
      expect(rule.clientSelectors[0].sourceCIDR.type).toBe("Distinct");
      expect(rule.limit).toEqual({ requests: 600, unit: "Minute" });
    }
  });

  it("is exempt from the catch-all, and nothing else is", () => {
    // Every rule without a narrowing prefix is the catch-all. If one of them
    // lost its inverted match, the mail webhook would share a bucket with every
    // other client behind the same Cloudflare address again.
    const catchAll = appRules().filter(
      (r) => r.clientSelectors[0].path === undefined || r.clientSelectors[0].path.invert === true,
    );
    expect(catchAll).toHaveLength(2);
    for (const rule of catchAll) {
      expect(rule.clientSelectors[0].path).toEqual({ type: "PathPrefix", value: PATH, invert: true });
    }
  });

  it("puts no request-body cap on the app route, which carries mail up to 25 MiB", () => {
    // `requestBuffer` would buffer and cap every body on the route; the mail
    // webhook needs at least 26 MiB (`INBOUND_MAIL_MAX_BODY_BYTES`).
    expect(policy("grid-app-timeouts")).not.toHaveProperty("requestBuffer");
  });
});
