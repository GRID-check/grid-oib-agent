import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";
import { SIGNED_INTERNAL_ROUTE } from "../constants";
import { decimalAtMost } from "./httproutes";
import { HTTPRoute } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/HTTPRoute";
import { HTTPRouteFilter } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/HTTPRouteFilter";
import { BackendTrafficPolicy } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/BackendTrafficPolicy";

/**
 * Edge policies on the public routes (`app/httproutes.ts`).
 *
 * Every field here is a string the API server accepts whatever it says: a
 * compressor on the wrong route, or under a name the installed CRD does not
 * know, plans and applies clean. So the assertions read the exact spec sent.
 */

type Policy = { metadata: { name: string }; spec: Record<string, unknown> };
const POLICIES: Policy[] = [];
/** Every HTTPRoute and HTTPRouteFilter, by kind. */
const OTHERS: Array<Policy & { kind: string }> = [];
/** The full objects, for the upstream CRD schema check. */
const OBJECTS: Array<Record<string, unknown>> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      if (typeof args.inputs.kind === "string") OBJECTS.push(args.inputs);
      if (args.inputs.kind === "BackendTrafficPolicy") POLICIES.push(args.inputs as Policy);
      else if (args.inputs.kind === "HTTPRoute" || args.inputs.kind === "HTTPRouteFilter") {
        OTHERS.push(args.inputs as Policy & { kind: string });
      }
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

function named(kind: string, name: string): Record<string, unknown> {
  const found = OTHERS.find((r) => r.kind === kind && r.metadata.name === name);
  if (!found) throw new Error(`no ${kind} named ${name}`);
  return found.spec;
}

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
      "grid-app-signed-timeouts",
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

describe("decimalAtMost", () => {
  const matches = (max: number, value: string) => new RegExp(decimalAtMost(max)).test(value);

  it.each([0, 1, 9, 10, 99, 100, 1000, 28311552, 27262976, 20000000, 29999999])(
    "matches exactly 0..%i, around every digit boundary",
    (max) => {
      const probes = new Set<number>([0, 1, 9, 10, 11, 99, 100, 101, 999, 1000, max - 1, max, max + 1, max * 10]);
      for (let digit = 0; digit < String(max).length; digit++) {
        const step = 10 ** digit;
        for (const delta of [-step, step]) probes.add(max + delta);
      }
      for (const probe of probes) {
        if (probe < 0) continue;
        expect(matches(max, String(probe)), `${probe} against ${max}`).toBe(probe <= max);
      }
    },
  );

  it("agrees with a numeric comparison on random lengths", () => {
    const max = 28311552;
    let seed = 7;
    for (let i = 0; i < 5000; i++) {
      seed = (seed * 48271) % 2147483647;
      const value = seed % 40_000_000;
      expect(matches(max, String(value)), String(value)).toBe(value <= max);
    }
  });

  it.each(["", "-1", "+5", "007", "1e7", "28311552 ", "0x10", "١٢"])("refuses %j", (value) => {
    expect(matches(28311552, value)).toBe(false);
  });
});

describe("the signed internal routes at the edge", () => {
  type Rule = {
    matches: Array<{ path: { type: string; value: string }; headers?: Array<{ type: string; name: string; value: string }> }>;
    backendRefs?: Array<{ name: string; port: number }>;
    filters?: Array<{ type: string; extensionRef: { group: string; kind: string; name: string } }>;
  };
  const contract = JSON.parse(
    readFileSync(join(__dirname, "../../../../shared/inbound-mail-contract.json"), "utf8"),
  ) as { path: string; signedPathPrefix: string; maxRawMessageBytes: number; edgeMaxBodyBytes: number };

  const rules = () => named("HTTPRoute", SIGNED_INTERNAL_ROUTE.routeName).rules as Rule[];

  it("covers the prefix the contract names, and the mail path under it", () => {
    expect(SIGNED_INTERNAL_ROUTE.pathPrefix).toBe(contract.signedPathPrefix);
    expect(contract.path.startsWith(SIGNED_INTERNAL_ROUTE.pathPrefix)).toBe(true);
  });

  it("holds the ceiling above the BFF's message cap, at the contract's number", () => {
    // Below the BFF's cap, a mail the BFF would answer 413 + reject (a bounce)
    // would instead meet the edge's bare 413 (a retry, for days).
    expect(SIGNED_INTERNAL_ROUTE.maxBodyBytes).toBe(contract.edgeMaxBodyBytes);
    expect(SIGNED_INTERNAL_ROUTE.maxBodyBytes).toBeGreaterThanOrEqual(contract.maxRawMessageBytes);
  });

  it("forwards only a Content-Length within the ceiling, to the frontend", () => {
    const [forward] = rules();
    expect(forward.matches).toEqual([
      {
        path: { type: "PathPrefix", value: SIGNED_INTERNAL_ROUTE.pathPrefix },
        headers: [
          { type: "RegularExpression", name: "content-length", value: decimalAtMost(SIGNED_INTERNAL_ROUTE.maxBodyBytes) },
        ],
      },
    ]);
    expect(forward.backendRefs).toEqual([{ name: "frontend", port: 3000 }]);
  });

  it("answers everything else under the prefix with Envoy's own 413", () => {
    const [, refuse] = rules();
    expect(refuse.matches).toEqual([{ path: { type: "PathPrefix", value: SIGNED_INTERNAL_ROUTE.pathPrefix } }]);
    expect(refuse.backendRefs).toBeUndefined();
    expect(refuse.filters).toEqual([
      {
        type: "ExtensionRef",
        extensionRef: {
          group: "gateway.envoyproxy.io",
          kind: "HTTPRouteFilter",
          name: SIGNED_INTERNAL_ROUTE.refusalFilterName,
        },
      },
    ]);
    const filter = named("HTTPRouteFilter", SIGNED_INTERNAL_ROUTE.refusalFilterName) as {
      directResponse: { statusCode: number };
    };
    expect(filter.directResponse.statusCode).toBe(413);
  });

  it("never buffers a body at the edge, on any route", () => {
    // `requestBuffer` holds the whole body in the proxy: on the unauthenticated
    // signed path, a few dozen 27 MiB uploads would OOM the 512Mi Envoy pods.
    for (const p of POLICIES) expect(p.spec, p.metadata.name).not.toHaveProperty("requestBuffer");
  });

  it("gives them a short upstream budget and no rate limit", () => {
    const spec = policy(`${SIGNED_INTERNAL_ROUTE.routeName}-timeouts`);
    expect(spec.targetRefs).toEqual([
      { group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: SIGNED_INTERNAL_ROUTE.routeName },
    ]);
    expect(spec.timeout).toEqual({ http: { requestTimeout: "120s" } });
    // Every mail arrives from Cloudflare's shared egress: a per-client bucket
    // would let another Cloudflare customer's traffic defer it (RT-S9).
    expect(spec).not.toHaveProperty("rateLimit");
  });

  it("passes the upstream CRD schemas (what `npm run validate` checks on a plan)", () => {
    // The Gateway API and Envoy Gateway models are generated from the CRDs, so
    // a field the installed controller would prune or refuse fails here.
    const named = (kind: string, name: string) =>
      OBJECTS.find((o) => o.kind === kind && (o.metadata as { name: string }).name === name);
    const objects = [
      new HTTPRoute(named("HTTPRoute", SIGNED_INTERNAL_ROUTE.routeName) as never),
      new HTTPRouteFilter(named("HTTPRouteFilter", SIGNED_INTERNAL_ROUTE.refusalFilterName) as never),
      new BackendTrafficPolicy(named("BackendTrafficPolicy", `${SIGNED_INTERNAL_ROUTE.routeName}-timeouts`) as never),
    ];
    for (const object of objects) expect(() => object.validate()).not.toThrow();
  });

  it("leaves the app route's buckets as they were: no inverted exemptions", () => {
    // The signed routes are outside the app route, so the catch-all needs no
    // carve-out; an inverted match here would mean someone added one anyway.
    const app = policy("grid-app-timeouts") as {
      rateLimit?: { global: { rules: Array<{ clientSelectors: Array<{ path?: { invert?: boolean } }> }> } };
    };
    for (const rule of app.rateLimit?.global.rules ?? []) {
      expect(rule.clientSelectors[0].path?.invert).toBeUndefined();
    }
  });
});

describe("the plain-HTTP listener", () => {
  it("redirects every host to HTTPS permanently, so a favicon fetch over http finds the site", () => {
    expect(named("HTTPRoute", "grid-https-redirect")).toEqual({
      parentRefs: [{ name: "grid-gateway", sectionName: "http" }],
      rules: [{ filters: [{ type: "RequestRedirect", requestRedirect: { scheme: "https", statusCode: 301 } }] }],
    });
  });
});
