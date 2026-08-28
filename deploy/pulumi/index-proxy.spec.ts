import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";

/**
 * The whole program, constructed with Cloudflare's proxy on.
 *
 * A separate file from `index-dns.spec.ts` because `import("./index")` runs the
 * program exactly once per module registry, so one config per file is all there
 * is. What it buys over the unit tests: the pieces of proxying live in three
 * modules that never call each other — `platform/dns.ts` decides which hosts
 * are orange, `platform/cert-manager.ts` has to issue certificates for those
 * same hosts by a different challenge, and `platform/edge.ts` configures the
 * zone they now pass through. Each is right on its own in `dns.spec.ts`,
 * `edge.spec.ts` and the guards; only here do they have to agree.
 *
 * The failure this exists for: a host turns orange, and its certificate keeps
 * renewing over HTTP-01 through an edge that may or may not forward the
 * challenge. Nothing fails at `pulumi up`. The certificate is valid for another
 * 90 days, and the outage is a quarter away.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

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

const ZONE = "example.test";

/**
 * Pulumi's own marker for a wrapped secret, as it appears in serialised inputs.
 * A published SDK constant in all but name — not a credential.
 */
const SECRET_SIG = "4dabf18193072939515e22adb298388d"; // pragma: allowlist secret

/** The ClusterIssuer slice this file reads back off the mock. */
type Solver = {
  selector?: { dnsNames?: string[] };
  dns01?: { cloudflare?: { apiTokenSecretRef: { name: string; key: string } } };
  http01?: unknown;
};

describe("the program constructs with the Cloudflare proxy on", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:baseDomain": `dev.${ZONE}`,
      "grid-oib:seaweedfsTopology": "single",
      "grid-oib:seaweedfsPerOrgBuckets": "false",
      "grid-oib:observabilityEnabled": "false",
      "grid-oib:loadBalancerIp": "203.0.113.10",
      "grid-oib:dnsEnabled": "true",
      "grid-oib:dnsZoneId": "zone-abc123",
      "grid-oib:dnsZoneName": ZONE,
      "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
      "grid-oib:dnsZoneBaseline": "true",
      "grid-oib:dnsProxyEnabled": "true",
      "grid-oib:dnsCaaEnabled": "true",
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  /** Hosts whose A record actually went out orange, this run. */
  function proxiedHosts(): string[] {
    return RESOURCES.filter(
      (r) => r.type === "cloudflare:index/dnsRecord:DnsRecord" && r.inputs.proxied === true,
    ).map((r) => r.inputs.name as string);
  }

  function solvers(): Solver[] {
    const issuer = RESOURCES.find((r) => r.name === "letsencrypt-issuer");
    const spec = issuer?.inputs.spec as { acme: { solvers: Solver[] } } | undefined;
    return spec?.acme.solvers ?? [];
  }

  it("solves ACME over DNS-01 for exactly the hosts it proxied", () => {
    // Not "for the proxied hosts" as a list someone maintains — the SAME
    // derivation, so the two cannot drift. A host that turns orange without its
    // solver following is a certificate that stops renewing silently.
    const dns01 = solvers().find((s) => s.dns01 !== undefined);
    expect(dns01?.selector?.dnsNames).toEqual(proxiedHosts());
    expect(proxiedHosts()).toEqual([`dev.${ZONE}`]);
  });

  it("keeps HTTP-01 as the catch-all for everything still direct", () => {
    // app.<domain> and s3.<domain> are grey and issue exactly as they did
    // before this feature existed. The DNS-01 solver must not become the
    // zone-wide default just because one host needed it.
    const list = solvers();
    expect(list.at(-1)?.http01).toBeDefined();
    expect(list.at(-1)?.selector).toBeUndefined();
  });

  it("gives the solver a token to read, in cert-manager's own namespace", () => {
    // A `secretKeyRef` cannot cross namespaces. Pointed at the wrong one, the
    // Certificate simply stays Pending — no event on the Gateway, no failed
    // resource at `pulumi up`.
    const ref = solvers().find((s) => s.dns01)?.dns01?.cloudflare?.apiTokenSecretRef;
    const secret = RESOURCES.find((r) => r.name === "cert-manager-cloudflare-token");
    const meta = secret?.inputs.metadata as { name: string; namespace: string } | undefined;
    expect(meta?.namespace).toBe("cert-manager");
    expect(meta?.name).toBe(ref?.name);
    // Pulumi's secret marker. The token is a `getSecret` value all the way
    // through, so what lands in stack state is encrypted rather than the token
    // in plaintext — worth asserting because the wrapping is invisible at the
    // call site and easy to lose to a well-meaning `.apply(String)`.
    const data = secret?.inputs.stringData as {
      [SECRET_SIG]?: string;
      value?: Record<string, string>;
    };
    expect(data[SECRET_SIG]).toBeDefined();
    expect(Object.keys(data.value ?? {})).toEqual([ref?.key]);
  });

  it("configures the zone it just started sending traffic through", () => {
    const settings = RESOURCES.filter((r) => r.type.endsWith(":ZoneSetting"));
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.map((s) => s.inputs.settingId)).toContain("ssl");
    expect(
      RESOURCES.some(
        (r) => r.type.endsWith(":Ruleset") && r.inputs.phase === "http_request_cache_settings",
      ),
    ).toBe(true);
  });

  it("names Cloudflare's edge CAs in CAA, now that Cloudflare issues for a host here", () => {
    // The coupling worth a test: turning a host orange means a Cloudflare EDGE
    // certificate exists for it. A CAA set listing only letsencrypt.org would
    // be correct on the day it was written and block renewal later.
    const issuers = RESOURCES.filter(
      (r) => r.type === "cloudflare:index/dnsRecord:DnsRecord" && r.inputs.type === "CAA",
    ).map((r) => (r.inputs.data as { tag: string; value: string }).value);
    expect(issuers).toContain("letsencrypt.org");
    expect(issuers).toContain("pki.goog; cansignhttpexchanges=yes");
    expect(issuers).toContain("ssl.com");
    // Not in Cloudflare's published list; in this zone's CT log anyway.
    expect(issuers).toContain("sectigo.com");
  });
});
