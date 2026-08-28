import { describe, it, expect, beforeEach } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * Zone-level edge configuration (`platform/edge.ts`).
 *
 * Same bar as `dns.spec.ts`, for the same reason: Cloudflare accepts every
 * mistake in this file. A zone set to "flexible" SSL reports success, shows a
 * padlock and serves the origin over plaintext; a cache rule in the wrong order
 * reports success and caches the admin UI. Nothing here fails at `pulumi up`,
 * so the assertions are about the exact bytes sent to the API.
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

function edgeConfig(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...baseStackConfig(),
    "grid-oib:observabilityEnabled": "false",
    "grid-oib:baseDomain": `dev.${ZONE}`,
    "grid-oib:loadBalancerIp": "203.0.113.10",
    "grid-oib:dnsEnabled": "true",
    "grid-oib:dnsZoneId": "zone-abc123",
    "grid-oib:dnsZoneName": ZONE,
    "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
    "grid-oib:dnsZoneBaseline": "true",
    "grid-oib:dnsProxyEnabled": "true",
    ...overrides,
  };
}

/** Cache-rule shape these tests read back off the mock. */
type CacheRule = {
  description: string;
  expression: string;
  actionParameters: {
    cache: boolean;
    edgeTtl?: { mode: string };
    respectStrongEtags?: boolean;
  };
};

async function install(values: Record<string, string>) {
  RESOURCES.length = 0;
  pulumi.runtime.setAllConfig(values);
  const { loadConfig } = await import("../config");
  const { installDns } = await import("./dns");
  const { installEdge } = await import("./edge");
  const cfg = loadConfig();
  const edge = installEdge(cfg, installDns(cfg));
  if (edge) {
    await Promise.all(edge.settings.map((s) => new Promise((r) => s.settingId.apply(r))));
    if (edge.cacheRules) await new Promise((r) => edge.cacheRules!.name.apply(r));
  }
  const settings = Object.fromEntries(
    RESOURCES.filter((r) => r.type.endsWith(":ZoneSetting")).map((r) => [
      r.inputs.settingId,
      r.inputs.value,
    ]),
  );
  const ruleset = RESOURCES.find(
    (r) => r.type.endsWith(":Ruleset") && r.inputs.phase === "http_request_cache_settings",
  );
  return { edge, settings, rules: (ruleset?.inputs.rules ?? []) as CacheRule[] };
}

describe("installEdge", () => {
  beforeEach(() => {
    RESOURCES.length = 0;
  });

  it("does nothing for a stack that does not own the zone baseline", async () => {
    // Zone settings govern EVERY name in the zone, including the hosts of other
    // stacks. Two stacks writing them is not a conflict Cloudflare reports —
    // the later `pulumi up` simply wins.
    const { edge, settings } = await install({
      ...edgeConfig(),
      "grid-oib:dnsZoneBaseline": "false",
    });
    expect(edge).toBeUndefined();
    expect(settings).toEqual({});
  });

  it("does nothing while the proxy is off, because none of it would apply", async () => {
    const { edge } = await install({ ...edgeConfig(), "grid-oib:dnsProxyEnabled": "false" });
    expect(edge).toBeUndefined();
  });

  it("verifies the origin certificate rather than settling for a padlock", async () => {
    // "flexible" is the setting that makes an insecure site look secure:
    // Cloudflare serves HTTPS to the visitor and plain HTTP to the origin, and
    // every external check passes. "strict" is affordable here only because
    // every listener holds a real certificate already.
    const { settings } = await install(edgeConfig());
    expect(settings.ssl).toBe("strict");
  });

  it("sets an HSTS max-age but never preloads", async () => {
    const { settings } = await install(edgeConfig());
    const hsts = (settings.securityHeader as { strictTransportSecurity: Record<string, unknown> })
      .strictTransportSecurity;
    expect(hsts.enabled).toBe(true);
    expect(hsts.includeSubdomains).toBe(true);
    // Preload is the one-way door here: browsers ship the list compiled in and
    // removal takes months, applying to every future subdomain of the zone.
    expect(hsts.preload).toBe(false);
  });

  it("puts the TLS floor above the broken versions without cutting off real clients", async () => {
    const { settings } = await install(edgeConfig());
    expect(settings.minTlsVersion).toBe("1.2");
    expect(settings.tls13).toBe("on");
  });

  it("leaves WebSockets enabled even though no proxied host serves one today", async () => {
    // Off, this fails with no error message: Cloudflare answers the upgrade
    // with a plain HTTP response and the client only reports a closed socket.
    const { settings } = await install(edgeConfig());
    expect(settings.websockets).toBe("on");
  });

  it("evaluates the never-cache rule before the cache rule", async () => {
    // Cache rules stop at the first match. Reversed, the admin UI is cached and
    // the next visitor is handed somebody's session.
    const { rules } = await install(edgeConfig());
    expect(rules).toHaveLength(2);
    expect(rules[0].actionParameters.cache).toBe(false);
    expect(rules[0].expression).toContain("/keystatic");
    expect(rules[1].actionParameters.cache).toBe(true);
  });

  it("scopes every cache rule to the proxied hosts only", async () => {
    // A rule that matched by path alone would apply to app.<domain> the day
    // that host is ever proxied, silently caching authenticated responses.
    const { rules } = await install(edgeConfig());
    for (const rule of rules) {
      expect(rule.expression).toContain(`http.host in {"dev.${ZONE}"}`);
      expect(rule.expression).not.toContain(`app.dev.${ZONE}`);
    }
  });

  it("defers the cache lifetime to the origin instead of naming a second one", async () => {
    const { rules } = await install(edgeConfig());
    expect(rules[1].actionParameters.edgeTtl?.mode).toBe("respect_origin");
    expect(rules[1].actionParameters.respectStrongEtags).toBe(true);
  });
});
