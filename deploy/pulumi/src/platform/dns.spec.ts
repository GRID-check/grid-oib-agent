import { describe, it, expect, beforeEach } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import {
  BACKEND_WS_PING_SECONDS,
  FREE_PLAN_MAX_BODY_MB,
  FREE_PLAN_WS_IDLE_SECONDS,
  hostsOutsideZone,
  managedHosts,
  proxiedHosts,
  proxyPlan,
  TTL_AUTOMATIC,
  UNROUTABLE_PLACEHOLDER,
} from "./dns";
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
    if (result.dnssec) {
      await new Promise((resolve) => result.dnssec!.zoneId.apply(resolve));
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
      // `dnsProxyEnabled` defaults false, so every host is grey regardless of
      // what `proxyPlan` would say about it. Turning the proxy on is a deploy
      // to watch, never a default that arrives with a merge.
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

/**
 * The orange/grey policy.
 *
 * These assertions are about the REASONS as much as the verdicts. A refusal
 * whose reason has gone stale is worse than no refusal: it keeps a host off the
 * proxy for a constraint that no longer exists, and nobody re-checks a decision
 * that looks explained.
 */
describe("proxyPlan", () => {
  const hosts = {
    webDomain: "d.test",
    appDomain: "app.d.test",
    s3Domain: "s3.d.test",
    otelDomain: "otel.d.test",
  };
  const all = managedHosts(hosts);

  it("proxies nothing at all while the flag is off, and says so", () => {
    const plan = proxyPlan({ enabled: false, hosts: all, ...hosts });
    expect(proxiedHosts(plan)).toEqual([]);
    for (const decision of plan) {
      expect(decision.proxied).toBe(false);
      if (!decision.proxied) expect(decision.reason).toContain("dnsProxyEnabled");
    }
  });

  it("proxies the landing site and nothing else", () => {
    const plan = proxyPlan({ enabled: true, hosts: all, ...hosts });
    expect(proxiedHosts(plan)).toEqual(["d.test"]);
  });

  it("refuses the APP host for the body cap, because uploads cross it", () => {
    // The correction this test exists to hold. Uploads are not presigned to
    // storage: `use-file-upload.ts` POSTs multipart FormData to the same-origin
    // /api/documents/upload, so every uploaded byte crosses app.<domain> and
    // the edge's request-body cap lands HERE.
    const plan = proxyPlan({ enabled: true, hosts: all, ...hosts });
    const app = plan.find((d) => d.host === "app.d.test");
    expect(app?.proxied).toBe(false);
    expect(app && !app.proxied && app.reason).toContain(`${FREE_PLAN_MAX_BODY_MB} MB`);
    expect(app && !app.proxied && app.reason).toContain("/api/documents/upload");
  });

  it("does NOT blame the WebSocket idle timeout for anything", () => {
    // The reason this policy carried when it was first written, and it was
    // wrong: uvicorn sends a protocol-level PING every 20s (pinned in
    // deploy/start_web.py), which passes through the http-proxy splice and is
    // answered by the browser. A chat socket is never idle for 100s. Asserting
    // the ABSENCE keeps the retired reason from drifting back in.
    expect(BACKEND_WS_PING_SECONDS * 4).toBeLessThan(FREE_PLAN_WS_IDLE_SECONDS);
    const plan = proxyPlan({ enabled: true, hosts: all, ...hosts });
    for (const decision of plan) {
      if (!decision.proxied) expect(decision.reason).not.toMatch(/WebSocket|idle/i);
    }
  });

  it("refuses the storage host on cache-key grounds, not on the body cap", () => {
    // It serves presigned preview/download GETs and the browser never PUTs
    // here, so the request-body cap does not apply. Saying it does would retire
    // a proxyable host for a constraint it does not have.
    const plan = proxyPlan({ enabled: true, hosts: all, ...hosts });
    const s3 = plan.find((d) => d.host === "s3.d.test");
    expect(s3?.proxied).toBe(false);
    expect(s3 && !s3.proxied && s3.reason).toContain("bearer credential");
    expect(s3 && !s3.proxied && s3.reason).not.toContain(`${FREE_PLAN_MAX_BODY_MB} MB`);
  });

  it("gives every host a verdict, so a new listener cannot arrive unclassified", () => {
    const plan = proxyPlan({ enabled: true, hosts: [...all, "new.d.test"], ...hosts });
    expect(plan.map((d) => d.host)).toEqual([...all, "new.d.test"]);
    // The fall-through is grey. A host nobody has thought about defaults to the
    // posture that cannot break it.
    expect(plan.find((d) => d.host === "new.d.test")?.proxied).toBe(false);
  });
});

describe("installDns with the proxy on", () => {
  beforeEach(() => {
    RESOURCES.length = 0;
  });

  const proxied = (overrides: Record<string, string> = {}) =>
    install({ ...dnsConfig(), "grid-oib:dnsProxyEnabled": "true", ...overrides });

  it("turns the landing site orange and leaves app and s3 grey", async () => {
    const { records } = await proxied();
    const byName = Object.fromEntries(records.map((r) => [r.inputs.name, r.inputs]));
    expect(byName[`dev.${ZONE}`].proxied).toBe(true);
    expect(byName[`app.dev.${ZONE}`].proxied).toBe(false);
    expect(byName[`s3.dev.${ZONE}`].proxied).toBe(false);
  });

  it("drops the explicit TTL on the proxied record only", async () => {
    // Cloudflare REJECTS a TTL on a proxied record — it answers for the name
    // itself. Sending 600 here fails the whole update, so the TTL has to follow
    // the verdict rather than being set once for the map.
    const { records } = await proxied();
    const byName = Object.fromEntries(records.map((r) => [r.inputs.name, r.inputs]));
    expect(byName[`dev.${ZONE}`].ttl).toBe(TTL_AUTOMATIC);
    expect(byName[`app.dev.${ZONE}`].ttl).toBe(600);
  });

  it("writes the refusal reason into the record comment, where an operator looks first", async () => {
    const { records } = await proxied();
    const app = records.find((r) => r.inputs.name === `app.dev.${ZONE}`);
    expect(app?.inputs.comment).toContain("not proxied");
    // Cloudflare caps a record comment at 100 characters and rejects a longer
    // one, so the reason is truncated rather than sent whole.
    expect(String(app?.inputs.comment).length).toBeLessThanOrEqual(100);
  });
});

describe("zone hardening", () => {
  beforeEach(() => {
    RESOURCES.length = 0;
  });

  const baseline = (overrides: Record<string, string> = {}) =>
    install({ ...dnsConfig(), "grid-oib:dnsZoneBaseline": "true", ...overrides });

  it("publishes no CAA unless asked — the flag turns off every CA nobody listed", async () => {
    const { records } = await baseline();
    expect(records.filter((r) => r.inputs.type === "CAA")).toEqual([]);
  });

  it("allows Cloudflare's edge CAs as well as Let's Encrypt", async () => {
    const { records } = await baseline({ "grid-oib:dnsCaaEnabled": "true" });
    const issue = records
      .filter((r) => r.inputs.type === "CAA")
      .map((r) => (r.inputs.data as { tag: string; value: string }))
      .filter((d) => d.tag === "issue")
      .map((d) => d.value);
    // Listing only letsencrypt.org is the trap: the ORIGIN certificates come
    // from there, but a proxied host is served by a Cloudflare EDGE certificate
    // that Cloudflare issues from any of these at its own discretion.
    //
    // `sectigo.com` is the one that is not in Cloudflare's published list and
    // is in this one anyway. The CT log for the real zone shows Cloudflare
    // issuing a Sectigo edge certificate for `piloti.at` + `*.piloti.at` on
    // 2026-08-10, alongside the Google Trust Services one. Dropping it because
    // the documentation does not mention it is how this set breaks — months
    // later, on a renewal.
    expect(issue).toEqual([
      "letsencrypt.org",
      "pki.goog; cansignhttpexchanges=yes",
      "ssl.com",
      "sectigo.com",
    ]);
  });

  it("refuses wildcards and points a report address at the ACME mailbox", async () => {
    const { records } = await baseline({ "grid-oib:dnsCaaEnabled": "true" });
    const caa = records
      .filter((r) => r.inputs.type === "CAA")
      .map((r) => r.inputs.data as { tag: string; value: string });
    expect(caa.find((d) => d.tag === "issuewild")?.value).toBe(";");
    expect(caa.find((d) => d.tag === "iodef")?.value).toMatch(/^mailto:/);
  });

  it("signs the zone only when asked, because the other half is at the registrar", async () => {
    expect((await baseline()).result?.dnssec).toBeUndefined();
    const { result } = await baseline({ "grid-oib:dnsDnssecEnabled": "true" });
    expect(result?.dnssec).toBeDefined();
  });

  it("keeps www proxied when the apex it follows is", async () => {
    // An unproxied CNAME to a proxied apex hands the client Cloudflare's edge
    // address WITHOUT the proxy state, so www answers from the edge for a zone
    // it has no configuration for. The two have to move together.
    const { records } = await install({
      ...dnsConfig(),
      "grid-oib:baseDomain": ZONE,
      "grid-oib:dnsZoneBaseline": "true",
      "grid-oib:dnsProxyEnabled": "true",
    });
    const byName = Object.fromEntries(records.map((r) => [r.inputs.name, r.inputs]));
    expect(byName[ZONE].proxied).toBe(true);
    expect(byName[`www.${ZONE}`].proxied).toBe(true);
    expect(byName[`www.${ZONE}`].ttl).toBe(TTL_AUTOMATIC);
  });
});

/**
 * The guards `loadConfig` applies before any of this reaches Cloudflare.
 *
 * All four refuse a combination that Cloudflare and Kubernetes would BOTH
 * accept. The XFF one is the reason this policy is not a plain boolean.
 */
describe("proxy configuration guards", () => {
  it("refuses to trust a forwarded client IP while any host bypasses the proxy", async () => {
    // `xffNumTrustedHops` lives on a ClientTrafficPolicy that targets the
    // Gateway, so there is no per-host form of it. With one hop trusted and
    // app.<domain> still reachable at the LoadBalancer address, any client can
    // send its own X-Forwarded-For and choose which per-IP bucket (ADR-0040) it
    // is counted in. The limits keep working; they just stop meaning anything,
    // and nothing reports it.
    const error = await loadWith({
      ...dnsConfig(),
      "grid-oib:dnsProxyEnabled": "true",
      "grid-oib:xffNumTrustedHops": "1",
    });
    expect(error?.message).toContain("xffNumTrustedHops");
    expect(error?.message).toContain(`app.dev.${ZONE}`);
    expect(error?.message).toContain("X-Forwarded-For");
  });

  it("allows the same hop count once nothing is left unproxied", async () => {
    // The supported way to reach 1 hop: no grey hosts to forge against. Nothing
    // in this stack is there yet, so the case is exercised through a plan with
    // no refusals rather than through config.
    const plan = proxyPlan({
      enabled: true,
      hosts: ["d.test"],
      webDomain: "d.test",
      appDomain: "app.other.test",
      s3Domain: "s3.other.test",
    });
    expect(plan.every((d) => d.proxied)).toBe(true);
  });

  it("refuses CAA and DNSSEC from a stack that does not own the zone", async () => {
    for (const key of ["dnsCaaEnabled", "dnsDnssecEnabled"]) {
      const error = await loadWith({ ...dnsConfig(), [`grid-oib:${key}`]: "true" });
      expect(error?.message).toContain("dnsZoneBaseline");
    }
  });

  it("refuses a proxy flag set while DNS itself is unmanaged", async () => {
    // Nothing else in this program holds a Cloudflare provider, so these keys
    // would be read by nothing: configured-looking and inert.
    const error = await loadWith({
      ...dnsConfig(),
      "grid-oib:dnsEnabled": "false",
      "grid-oib:dnsProxyEnabled": "true",
    });
    expect(error?.message).toContain("dnsEnabled is false");
  });
});
