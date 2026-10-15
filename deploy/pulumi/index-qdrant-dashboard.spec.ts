import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";
import { DependencyGraph } from "./src/test-support/dependency-graph";

/**
 * Qdrant's web dashboard at the edge (`qdrantDashboardEnabled`), the whole
 * program built once with it on and DNS managed.
 *
 * Every assertion here is a string that plans clean and is wrong only on a
 * cluster: a listener whose certificate name nothing issues, a route that sends
 * the dashboard somewhere its REST calls do not follow, a policy whose
 * redirect URI WorkOS has never heard of, a gate that admits analysts to raw
 * vectors, a NetworkPolicy that times out every request behind a green gate,
 * a WorkOS token handed on to Qdrant. The off side (nothing at all) is in
 * `index.spec.ts` and `index-dns.spec.ts`.
 */

const HOST = "qdrant.dev.example.test";

type Listener = {
  name: string;
  port: number;
  protocol: string;
  hostname?: string;
  tls?: { mode: string; certificateRefs: Array<{ name: string }> };
  allowedRoutes?: unknown;
};
type HeaderFilter = { type: "RequestHeaderModifier"; requestHeaderModifier: { remove?: string[]; set?: unknown; add?: unknown } };
type RedirectFilter = {
  type: "RequestRedirect";
  requestRedirect: { path: { type: string; replaceFullPath: string }; statusCode: number };
};
type Rule = {
  matches?: Array<{ path: { type: string; value: string } }>;
  filters?: Array<HeaderFilter | RedirectFilter>;
  backendRefs?: Array<{ name: string; port: number }>;
  timeouts?: { request: string; backendRequest: string };
};
type Route = { spec: { parentRefs: Array<{ name: string; sectionName: string }>; hostnames: string[]; rules: Rule[] } };
type Policy = {
  spec: {
    targetRefs: Array<{ kind: string; name: string }>;
    oidc: { clientID: string; clientSecret: { name: string }; scopes: string[]; redirectURL: string; forwardAccessToken: boolean };
    authorization: { defaultAction: string; rules: Array<{ name: string; principal: { jwt: { scopes: string[] } } }> };
  };
};
type NetworkPolicy = {
  spec: {
    podSelector: { matchLabels: Record<string, string> };
    ingress: Array<{
      from: Array<{ namespaceSelector?: { matchLabels: Record<string, string> } }>;
      ports: Array<{ protocol: string; port: number }>;
    }>;
  };
};

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];
let graph: DependencyGraph;

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

const TYPE = {
  route: "kubernetes:gateway.networking.k8s.io/v1:HTTPRoute",
  policy: "kubernetes:gateway.envoyproxy.io/v1alpha1:SecurityPolicy",
  networkPolicy: "kubernetes:networking.k8s.io/v1:NetworkPolicy",
  secret: "kubernetes:core/v1:Secret",
  dns: "cloudflare:index/dnsRecord:DnsRecord",
} as const;

function find<T>(type: string, name: string): T {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  expect(hit, `${type} ${name}`).toBeDefined();
  return hit!.inputs as unknown as T;
}
const listeners = (): Listener[] =>
  (RESOURCES.find((r) => r.name === "grid-gateway")!.inputs.spec as { listeners: Listener[] }).listeners;
const route = () => find<Route>(TYPE.route, "grid-qdrant-dashboard-route");
const policy = () => find<Policy>(TYPE.policy, "grid-qdrant-dashboard-security-policy");
/** A Secret's `stringData`, unwrapped from the mock's secret envelope. */
const secretData = (name: string): Record<string, string> => {
  const data = find<{ stringData: Record<string, unknown> }>(TYPE.secret, name).stringData;
  return (typeof data.value === "object" ? data.value : data) as Record<string, string>;
};

describe("Qdrant's dashboard, switched on", () => {
  beforeAll(async () => {
    graph = new DependencyGraph();
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:baseDomain": "dev.example.test",
      "grid-oib:observabilityEnabled": "false",
      "grid-oib:otelOidcIssuer": "https://grid.authkit.app",
      "grid-oib:otelOidcClientId": "client_otel",
      "grid-oib:otelOidcClientSecret": "otel-client-secret", // pragma: allowlist secret
      "grid-oib:qdrantDashboardEnabled": "true",
      "grid-oib:loadBalancerIp": "203.0.113.10",
      "grid-oib:dnsEnabled": "true",
      "grid-oib:dnsZoneId": "zone-abc123",
      "grid-oib:dnsZoneName": "example.test",
      "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("adds an https-qdrant listener on 443 whose certificate cert-manager issues as grid-qdrant-tls", () => {
    expect(listeners().find((l) => l.name === "https-qdrant")).toEqual({
      name: "https-qdrant",
      port: 443,
      protocol: "HTTPS",
      hostname: HOST,
      tls: { mode: "Terminate", certificateRefs: [{ name: "grid-qdrant-tls" }] },
      allowedRoutes: { namespaces: { from: "Same" } },
    });
  });

  it("publishes the host to DNS, so every HTTPS listener still has exactly one record", () => {
    const records = RESOURCES.filter((r) => r.type === TYPE.dns).map((r) => r.inputs.name as string);
    const hosts = listeners()
      .filter((l) => l.protocol === "HTTPS" && l.hostname !== undefined)
      .map((l) => l.hostname as string);
    expect(records).toContain(HOST);
    expect([...records].sort()).toEqual([...hosts].sort());
  });

  it("routes the whole host to the qdrant Service on 6333, with the edge timeout", () => {
    const spec = route().spec;
    expect(spec.parentRefs).toEqual([{ name: "grid-gateway", sectionName: "https-qdrant" }]);
    expect(spec.hostnames).toEqual([HOST]);
    // The catch-all: no `matches`, so `/collections`, `/cluster`, … all arrive.
    const backend = spec.rules.find((r) => r.backendRefs !== undefined)!;
    expect(backend.matches).toBeUndefined();
    expect(backend.backendRefs).toEqual([{ name: "qdrant", port: 6333 }]);
    expect(backend.timeouts).toEqual({ request: "3600s", backendRequest: "3600s" });
  });

  it("removes the forwarded WorkOS token, header and cookie, before Qdrant sees the request", () => {
    // The gate forwards the access token as `Authorization: Bearer`, which
    // Qdrant reads as an API key; the OAuth2 filter's BearerToken cookie
    // carries the same token.
    const backend = route().spec.rules.find((r) => r.backendRefs !== undefined)!;
    const modifiers = (backend.filters ?? []).filter((f): f is HeaderFilter => f.type === "RequestHeaderModifier");
    expect(modifiers).toEqual([
      { type: "RequestHeaderModifier", requestHeaderModifier: { remove: ["Authorization", "Cookie"] } },
    ]);
  });

  it("injects no Qdrant key at the edge", () => {
    // A `set` here would be a literal value: the key in plaintext in the
    // HTTPRoute and in Pulumi state.
    const serialized = JSON.stringify(route());
    expect(serialized).not.toMatch(/api-key/i);
    expect(serialized).not.toContain("qd-rw");
    expect(serialized).not.toContain("qd-ro");
  });

  it("redirects exactly / to /dashboard, temporarily", () => {
    const redirect = route().spec.rules.find((r) => r.backendRefs === undefined)!;
    expect(redirect.matches).toEqual([{ path: { type: "Exact", value: "/" } }]);
    expect(redirect.filters).toEqual([
      {
        type: "RequestRedirect",
        requestRedirect: { path: { type: "ReplaceFullPath", replaceFullPath: "/dashboard" }, statusCode: 302 },
      },
    ]);
  });

  it("gates the route on the platform Connect application, with this host's callback", () => {
    const spec = policy().spec;
    expect(spec.targetRefs).toEqual([
      { group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: "grid-qdrant-dashboard" },
    ]);
    expect(spec.oidc.redirectURL).toBe(`https://${HOST}/oauth2/callback`);
    expect(spec.oidc.clientID).toBe("client_otel");
    expect(spec.oidc.clientSecret).toEqual({ name: "qdrant-dashboard-oidc" });
    expect(secretData("qdrant-dashboard-oidc")).toEqual({ "client-secret": "otel-client-secret" });
  });

  it("admits the operator permission alone: analysts get Langfuse, not raw vectors", () => {
    const spec = policy().spec;
    expect(spec.oidc.scopes).toEqual(["openid", "profile", "email", "offline_access", "platform:organizations:view"]);
    expect(spec.authorization.defaultAction).toBe("Deny");
    expect(spec.authorization.rules.map((r) => [r.name, r.principal.jwt.scopes])).toEqual([
      ["platform-permission-only", ["platform:organizations:view"]],
    ]);
  });

  it("creates the gate before the route, so the route is never served without it", () => {
    expect(
      graph.waitsOn(TYPE.route, "grid-qdrant-dashboard-route", TYPE.policy, "grid-qdrant-dashboard-security-policy"),
    ).toBe(true);
  });

  it("lets the edge reach Qdrant's REST port and nothing else of it", () => {
    const rule = find<NetworkPolicy>(TYPE.networkPolicy, "allow-edge-to-qdrant-dashboard").spec;
    expect(rule.podSelector).toEqual({ matchLabels: { "app.kubernetes.io/name": "qdrant" } });
    expect(rule.ingress).toEqual([
      {
        from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "envoy-gateway-system" } } }],
        ports: [{ protocol: "TCP", port: 6333 }],
      },
    ]);
  });
});
