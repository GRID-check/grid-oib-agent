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
    edgeTtl?: { mode: string; default?: number };
    browserTtl?: { mode: string };
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

  it("puts the never-cache rule LAST, because the last match wins", async () => {
    // Cache rules are not first-match-wins: every matching rule in the phase
    // runs and, for conflicting settings, the last one wins. The first rule
    // here is a catch-all across the whole host, so if the exclusions did not
    // come after it they would be overridden — and Cloudflare would accept the
    // ruleset, report success, and cache the Keystatic admin UI.
    const { rules } = await install(edgeConfig());
    expect(rules).toHaveLength(3);
    expect(rules[0].expression).not.toContain("/keystatic");
    expect(rules[0].actionParameters.cache).toBe(true);
    const last = rules[rules.length - 1];
    expect(last.actionParameters.cache).toBe(false);
    expect(last.expression).toContain("/keystatic");
  });

  it("never caches the sign-in hand-off, whose target is read from the environment", async () => {
    // It 302s to PUBLIC_APP_URL at request time. An edge copy would freeze one
    // stack's app URL into the other's landing page — the failure its own
    // `no-store` header exists to prevent.
    const { rules } = await install(edgeConfig());
    expect(rules[rules.length - 1].expression).toContain("/sign-in");
  });

  it("scopes every cache rule to the proxied hosts only", async () => {
    // The catch-all is a catch-all across ONE host. Matched by path alone it
    // would apply to app.<domain> the day that host is ever proxied, silently
    // caching authenticated responses.
    const { rules } = await install(edgeConfig());
    for (const rule of rules) {
      expect(rule.expression).toContain(`http.host in {"dev.${ZONE}"}`);
      expect(rule.expression).not.toContain(`app.dev.${ZONE}`);
    }
  });

  it("overrides the shared TTL for HTML while leaving the browser's alone", async () => {
    // The origin serves prerendered HTML with `public, max-age=0`. Right for a
    // browser, useless for a shared cache — taken literally the edge stores
    // nothing. Overriding the edge TTL and NOT the browser's is what makes the
    // edge copy the only stale one, and the only one that can be purged.
    const { rules } = await install(edgeConfig());
    expect(rules[0].actionParameters.edgeTtl?.mode).toBe("override_origin");
    expect(rules[0].actionParameters.edgeTtl?.default).toBe(300);
    expect(rules[0].actionParameters.browserTtl?.mode).toBe("respect_origin");
  });

  it("takes hashed assets back off the HTML TTL and defers to the origin", async () => {
    // The catch-all gave every path five minutes. These are content-addressed
    // and the origin says a year, so this rule exists to hand them back.
    const { rules } = await install(edgeConfig());
    expect(rules[1].expression).toContain("/_astro/");
    expect(rules[1].actionParameters.edgeTtl?.mode).toBe("respect_origin");
    expect(rules[1].actionParameters.respectStrongEtags).toBe(true);
  });
});
