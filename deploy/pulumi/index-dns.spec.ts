import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";

/**
 * The whole-program construction with public DNS turned on.
 *
 * A separate file for the reason `index-single.spec.ts` gives: `index.ts` works
 * at module scope and Pulumi's runtime is process-global, so one process builds
 * the stack exactly once and vitest's file isolation is what makes a second
 * configuration testable at all.
 *
 * Its job is the one invariant no per-module test can reach. `platform/dns.ts`
 * and `platform/gateway.ts` both derive their host lists from config, and the
 * whole claim of the DNS module is that the two lists ARE the same list — every
 * HTTPS listener has an A record and no A record points at a host with no
 * listener. Nothing about the type system enforces that. Adding a fifth
 * listener to the Gateway without touching `managedHosts` compiles, deploys,
 * and produces a host that serves a certificate error to anyone who finds it;
 * the reverse produces a name resolving to a Gateway with no route for it.
 *
 * So the assertion below reads the hostnames off the Gateway resource this run
 * actually built and compares them to the DNS records this run actually built,
 * rather than to a list written down here — a list written down here would just
 * be a third thing to keep in step.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

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

const ZONE = "example.test";

/** The `spec.listeners` slice this file reads back off the Gateway resource. */
type GatewaySpec = { listeners: Array<{ name: string; protocol: string; hostname?: string }> };

describe("the program constructs with public DNS enabled", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:baseDomain": `dev.${ZONE}`,
      "grid-oib:seaweedfsTopology": "single",
      "grid-oib:seaweedfsPerOrgBuckets": "false",
      // Observability ON, so the conditional `https-otel` listener exists and
      // the otel host is actually part of the set being compared. With it off
      // the invariant holds trivially and the test proves much less.
      "grid-oib:observabilityEnabled": "true",
      "grid-oib:otelPrimaryApiKey": "otel-key", // pragma: allowlist secret
      "grid-oib:otelOidcIssuer": "https://tenant.authkit.app",
      "grid-oib:otelOidcClientId": "client_test",
      "grid-oib:otelOidcClientSecret": "otel-secret", // pragma: allowlist secret
      "grid-oib:loadBalancerIp": "203.0.113.10",
      "grid-oib:dnsEnabled": "true",
      "grid-oib:dnsZoneId": "zone-abc123",
      "grid-oib:dnsZoneName": ZONE,
      "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  /** Hostnames the Gateway actually terminates TLS for, this run. */
  function listenerHosts(): string[] {
    const gateway = RESOURCES.find((r) => r.name === "grid-gateway");
    const spec = gateway?.inputs.spec as GatewaySpec | undefined;
    return (spec?.listeners ?? [])
      .filter((l) => l.protocol === "HTTPS" && l.hostname !== undefined)
      .map((l) => l.hostname as string);
  }

  /** Names the program actually published to DNS, this run. */
  function dnsHosts(): string[] {
    return RESOURCES.filter((r) => r.type === "cloudflare:index/dnsRecord:DnsRecord").map(
      (r) => r.inputs.name as string,
    );
  }

  it("publishes an A record for every HTTPS listener, and nothing else", () => {
    expect([...dnsHosts()].sort()).toEqual([...listenerHosts()].sort());
  });

  it("covers the conditional otel listener too", () => {
    // Guards the test above against passing because BOTH sides went empty, and
    // pins the specific host whose listener only exists when the observability
    // tier is deployed.
    expect(listenerHosts()).toContain(`otel.dev.${ZONE}`);
    expect(dnsHosts()).toContain(`otel.dev.${ZONE}`);
    expect(dnsHosts()).toHaveLength(4);
  });

  it("points every record at the pinned LoadBalancer IP", () => {
    // The address the Envoy Service is annotated with and the address in DNS are
    // read from one config key precisely so they cannot disagree.
    const records = RESOURCES.filter((r) => r.type === "cloudflare:index/dnsRecord:DnsRecord");
    for (const record of records) {
      expect(record.inputs.content).toBe("203.0.113.10");
    }
  });
});
