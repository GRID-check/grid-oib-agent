import { describe, it, expect, beforeEach } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { hostsOutsideZone, managedHosts, TTL_AUTOMATIC, UNROUTABLE_PLACEHOLDER } from "./dns";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * Public DNS (`platform/dns.ts`).
 *
 * The bar for a test here is the same one the module exists for: every mistake
 * it guards against produces records the Cloudflare API ACCEPTS. There is no
 * failed resource to notice afterwards — a wrong record is a name that resolves
 * to the wrong place, discovered by whoever eventually types it into a browser.
 * So the assertions are about the exact bytes sent to the API, not about
 * whether the call succeeded.
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

/** The slice of a dynamic-redirect rule these tests read back off the mock. */
type RedirectRule = {
  expression: string;
  actionParameters: { fromValue: { statusCode: number; targetUrl: { value: string } } };
};

/** The stack config a working Cloudflare setup needs, on top of the shared base. */
function dnsConfig(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...baseStackConfig(),
    "grid-oib:observabilityEnabled": "false",
    "grid-oib:baseDomain": `dev.${ZONE}`,
    "grid-oib:loadBalancerIp": "203.0.113.10",
    "grid-oib:dnsEnabled": "true",
    "grid-oib:dnsZoneId": "zone-abc123",
    "grid-oib:dnsZoneName": ZONE,
    "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
    ...overrides,
  };
}

/**
 * Build the DNS resources for a config, returning only the records this run
 * created. `loadConfig` and `installDns` are imported lazily per call because
 * both read the memoized Pulumi runtime config at call time.
 */
async function install(values: Record<string, string>) {
  RESOURCES.length = 0;
  pulumi.runtime.setAllConfig(values);
  const { loadConfig } = await import("../config");
  const { installDns } = await import("./dns");
  const result = installDns(loadConfig());
  // Pulumi registers resources asynchronously; resolving one output per
  // resource drains the queue so `RESOURCES` is complete when we assert.
  if (result) {
    await Promise.all(
      [...result.hostRecords, ...result.baselineRecords].map(
        (r) => new Promise((resolve) => r.name.apply(resolve)),
      ),
    );
    if (result.apexRedirect) {
      await new Promise((resolve) => result.apexRedirect!.ruleset.name.apply(resolve));
    }
  }
  return { result, records: RESOURCES.filter((r) => r.type.endsWith(":DnsRecord")) };
}

/** Drive `loadConfig` alone, returning the error it refused with (or null). */
async function loadWith(values: Record<string, string>): Promise<Error | null> {
  pulumi.runtime.setAllConfig(values);
  const { loadConfig } = await import("../config");
  try {
    loadConfig();
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe("managedHosts", () => {
  it("mirrors the Gateway's HTTPS listeners, otel included only when observability is on", () => {
    const base = { webDomain: "d.test", appDomain: "app.d.test", s3Domain: "s3.d.test" };
    expect(managedHosts(base)).toEqual(["d.test", "app.d.test", "s3.d.test"]);
    expect(managedHosts({ ...base, otelDomain: "otel.d.test" })).toEqual([
      "d.test",
      "app.d.test",
      "s3.d.test",
      "otel.d.test",
    ]);
  });
});

describe("hostsOutsideZone", () => {
  it("accepts the apex and anything under it", () => {
    expect(hostsOutsideZone(["piloti.at", "app.dev.piloti.at"], "piloti.at")).toEqual([]);
  });

  it("rejects a zone that is only a string suffix, not a DNS parent", () => {
    // The failure this exists for: `notpiloti.at`.endsWith("piloti.at") is true,
    // so a naive suffix check would let a completely unrelated domain through
    // and Cloudflare would create the record under the wrong zone.
    expect(hostsOutsideZone(["notpiloti.at"], "piloti.at")).toEqual(["notpiloti.at"]);
  });

  it("rejects a host from a different zone entirely", () => {
    expect(hostsOutsideZone(["app.other.test", "app.piloti.at"], "piloti.at")).toEqual([
      "app.other.test",
    ]);
  });
});

describe("installDns", () => {
  beforeEach(() => {
    RESOURCES.length = 0;
  });

  it("returns undefined and creates nothing when disabled", async () => {
    const { result, records } = await install({
      ...dnsConfig(),
      "grid-oib:dnsEnabled": "false",
    });
    expect(result).toBeUndefined();
    expect(records).toEqual([]);
  });

  it("creates one unproxied A record per Gateway listener host, at the LoadBalancer IP", async () => {
    const { records } = await install(dnsConfig());
    expect(records.map((r) => r.inputs.name)).toEqual([
      `dev.${ZONE}`,
      `app.dev.${ZONE}`,
      `s3.dev.${ZONE}`,
    ]);
    for (const record of records) {
      expect(record.inputs.type).toBe("A");
      expect(record.inputs.content).toBe("203.0.113.10");
      expect(record.inputs.ttl).toBe(600);
      // Proxying breaks ACME HTTP-01 through the Gateway, caps S3 uploads at
      // 100 MB, and puts an uncontrolled idle timeout on the WebSockets the app
      // tier depends on. If this ever flips, all three need answers first.
      expect(record.inputs.proxied).toBe(false);
    }
  });

  it("adds the otel host when the observability tier is deployed", async () => {
    const { records } = await install({
      ...dnsConfig(),
      "grid-oib:observabilityEnabled": "true",
      "grid-oib:otelPrimaryApiKey": "otel-key", // pragma: allowlist secret
      "grid-oib:otelOidcIssuer": "https://tenant.authkit.app",
      "grid-oib:otelOidcClientId": "client_test",
      "grid-oib:otelOidcClientSecret": "otel-secret", // pragma: allowlist secret
    });
    expect(records.map((r) => r.inputs.name)).toContain(`otel.dev.${ZONE}`);
  });

  it("leaves the zone-level records alone unless this stack claims the baseline", async () => {
    const { result, records } = await install(dnsConfig());
    expect(result?.baselineRecords).toEqual([]);
    expect(result?.apexRedirect).toBeUndefined();
    expect(records.map((r) => r.inputs.name)).not.toContain(`www.${ZONE}`);
  });

  it("publishes www and _dmarc when it does", async () => {
    const { records } = await install({
      ...dnsConfig(),
      "grid-oib:dnsZoneBaseline": "true",
      "grid-oib:dnsDmarc": "v=DMARC1; p=quarantine;",
    });
    const www = records.find((r) => r.inputs.name === `www.${ZONE}`);
    expect(www?.inputs.type).toBe("CNAME");
    expect(www?.inputs.content).toBe(ZONE);
    // No apex redirect in play, so www is a plain unproxied CNAME with a real TTL.
    expect(www?.inputs.proxied).toBe(false);
    expect(www?.inputs.ttl).toBe(600);

    const dmarc = records.find((r) => r.inputs.name === `_dmarc.${ZONE}`);
    expect(dmarc?.inputs.type).toBe("TXT");
    expect(dmarc?.inputs.content).toBe("v=DMARC1; p=quarantine;");
  });

  it("parks the apex on an unroutable proxied placeholder plus a 302 ruleset", async () => {
    const { result, records } = await install({
      ...dnsConfig(),
      "grid-oib:dnsZoneBaseline": "true",
      "grid-oib:dnsApexRedirectTo": `https://dev.${ZONE}`,
    });

    const apex = records.find((r) => r.inputs.name === ZONE);
    // Unroutable on purpose: the redirect answers at Cloudflare's edge and no
    // packet is ever forwarded, so a real address here would become a silent
    // traffic destination the day the rule is removed.
    expect(apex?.inputs.content).toBe(UNROUTABLE_PLACEHOLDER);
    // A dynamic-redirect rule only runs on proxied traffic, and Cloudflare
    // rejects an explicit TTL on a proxied record.
    expect(apex?.inputs.proxied).toBe(true);
    expect(apex?.inputs.ttl).toBe(TTL_AUTOMATIC);

    // www has to follow the apex into the proxy or it reaches the edge without
    // the hostname the rule matches on.
    const www = records.find((r) => r.inputs.name === `www.${ZONE}`);
    expect(www?.inputs.proxied).toBe(true);
    expect(www?.inputs.ttl).toBe(TTL_AUTOMATIC);

    const ruleset = RESOURCES.find((r) => r.type.endsWith(":Ruleset"));
    expect(ruleset?.inputs.phase).toBe("http_request_dynamic_redirect");
    expect(ruleset?.inputs.kind).toBe("zone");
    // The one widening in this file, and it is confined here: `MockResourceArgs`
    // types every input as `unknown`, so the shape the module built has to be
    // named somewhere to be asserted against.
    const rule = (ruleset?.inputs.rules as RedirectRule[])[0];
    expect(rule.expression).toBe(`http.host in {"${ZONE}" "www.${ZONE}"}`);
    expect(rule.actionParameters.fromValue.targetUrl.value).toBe(`https://dev.${ZONE}`);
    // 302, never 301: this redirect is removed the moment a stack serves the
    // apex, and a browser that cached a 301 would keep being bounced off the
    // real site with no server-side way to undo it.
    expect(rule.actionParameters.fromValue.statusCode).toBe(302);

    expect(result?.apexRedirect).toBeDefined();
  });
});

describe("loadConfig refuses DNS configurations that would deploy cleanly and be wrong", () => {
  it("requires the whole Cloudflare triple, naming what is missing", async () => {
    const config = dnsConfig();
    delete config["grid-oib:dnsZoneId"];
    delete config["grid-oib:cloudflareApiToken"];
    const error = await loadWith(config);
    expect(error?.message).toContain("grid-oib:dnsZoneId");
    expect(error?.message).toContain("grid-oib:cloudflareApiToken");
  });

  it("requires a pinned LoadBalancer IP", async () => {
    const config = dnsConfig();
    delete config["grid-oib:loadBalancerIp"];
    const error = await loadWith(config);
    expect(error?.message).toContain("grid-oib:loadBalancerIp");
  });

  it("refuses hosts that fall outside the zone", async () => {
    // The silent failure: Cloudflare would append the zone and create
    // `dev.elsewhere.test.example.test`, reporting success.
    const error = await loadWith({
      ...dnsConfig(),
      "grid-oib:baseDomain": "dev.elsewhere.test",
    });
    expect(error?.message).toContain("dev.elsewhere.test");
    expect(error?.message).toContain("RELATIVE");
  });

  it("refuses an apex redirect on a stack that already serves the apex", async () => {
    const error = await loadWith({
      ...dnsConfig(),
      "grid-oib:baseDomain": ZONE,
      "grid-oib:dnsZoneBaseline": "true",
      "grid-oib:dnsApexRedirectTo": "https://elsewhere.test",
    });
    expect(error?.message).toContain("already serves the apex");
  });

  it("refuses an apex redirect from a stack that does not own the zone baseline", async () => {
    const error = await loadWith({
      ...dnsConfig(),
      "grid-oib:dnsApexRedirectTo": `https://dev.${ZONE}`,
    });
    expect(error?.message).toContain("grid-oib:dnsZoneBaseline");
  });

  it("refuses a redirect target that is not an absolute URL", async () => {
    const error = await loadWith({
      ...dnsConfig(),
      "grid-oib:dnsZoneBaseline": "true",
      "grid-oib:dnsApexRedirectTo": `dev.${ZONE}`,
    });
    expect(error?.message).toContain("absolute URL");
  });

  it("stays silent when DNS is off, whatever else is unset", async () => {
    const config = dnsConfig({ "grid-oib:dnsEnabled": "false" });
    delete config["grid-oib:dnsZoneId"];
    delete config["grid-oib:loadBalancerIp"];
    delete config["grid-oib:cloudflareApiToken"];
    expect(await loadWith(config)).toBeNull();
  });
});
