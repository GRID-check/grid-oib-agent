import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * Project mail inbox on Cloudflare (`platform/inbound-mail.ts`).
 *
 * Every field below is a string the Cloudflare API accepts whatever it says: a
 * catch-all naming a script that does not exist, a binding under the wrong
 * name, routing enabled on a domain the catch-all does not cover. None of
 * those fail `pulumi up`; each one bounces or loses real mail. So the
 * assertions read the exact inputs sent.
 */

type Recorded = { type: string; name: string; inputs: Record<string, unknown> };
const RESOURCES: Recorded[] = [];
const CALLS: Array<{ token: string; inputs: Record<string, unknown> }> = [];

const ZONE_ID = "zone-mail-1";
const DOMAIN = "post.example.test";

/** What the MX lookup answers; each test sets it before `install`. */
let MX_RECORDS: Array<{ name: string; content: string; type: string }> = [];

const CLOUDFLARE_MX = ["route1", "route2", "route3"].map((host) => ({
  name: DOMAIN,
  content: `${host}.mx.cloudflare.net`,
  type: "MX",
}));

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      CALLS.push({ token: args.token, inputs: args.inputs });
      if (args.token === "cloudflare:index/getZone:getZone") {
        return { id: args.inputs.zoneId, name: DOMAIN, account: { id: "account-1", name: "Grid" } };
      }
      if (args.token === "cloudflare:index/getDnsRecords:getDnsRecords") {
        return { results: MX_RECORDS };
      }
      return {};
    },
  },
  "grid-oib",
  "test",
  false,
);

function mailConfig(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...baseStackConfig(),
    "grid-oib:observabilityEnabled": "false",
    "grid-oib:baseDomain": "example.test",
    "grid-oib:inboundMailDomain": DOMAIN,
    "grid-oib:inboundMailZoneId": ZONE_ID,
    "grid-oib:inboundMailToken": "inbound-token", // pragma: allowlist secret
    "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
    ...overrides,
  };
}

async function install(values: Record<string, string>, mx: typeof MX_RECORDS = []) {
  RESOURCES.length = 0;
  CALLS.length = 0;
  MX_RECORDS = mx;
  pulumi.runtime.setAllConfig(values);
  const { loadConfig } = await import("../config");
  const { installInboundMail } = await import("./inbound-mail");
  const { installMailZones } = await import("./email-routing");
  const cfg = loadConfig();
  const result = installInboundMail(cfg, installMailZones(cfg).inbound);
  if (result) {
    await Promise.all(
      [result.script.id, result.zone.routing.id, result.catchAll.id].map(
        (id) => new Promise((resolve) => id.apply(resolve)),
      ),
    );
  }
  return result;
}

const byType = (type: string) => RESOURCES.filter((r) => r.type === type);
const one = (type: string): Recorded => {
  const found = byType(type);
  expect(found, type).toHaveLength(1);
  return found[0];
};

type Binding = { name: string; type: string; text: string };

/** Pulumi's wire marker for a secret value, as the mock monitor receives it. */
const SECRET_SIG = "4dabf18193072939515e22adb298388d"; // pragma: allowlist secret (Pulumi secret-marker constant, not a credential)

/** Unwrap a mock input, reporting whether Pulumi marked it secret. */
function reveal(value: unknown): { secret: boolean; value: unknown } {
  if (typeof value === "object" && value !== null && SECRET_SIG in value && "value" in value) {
    return { secret: true, value: value.value };
  }
  return { secret: false, value };
}

describe("inbound mail on Cloudflare", () => {
  it("creates nothing when inboundMailDomain is unset", async () => {
    const result = await install(mailConfig({ "grid-oib:inboundMailDomain": "" }));
    expect(result).toBeUndefined();
    expect(RESOURCES.filter((r) => r.type.startsWith("cloudflare:"))).toEqual([]);
    expect(CALLS).toEqual([]);
  });

  it("uploads the Worker module verbatim, into the zone's account", async () => {
    await install(mailConfig());
    const script = one("cloudflare:index/workersScript:WorkersScript");
    expect(script.inputs.accountId).toBe("account-1");
    expect(script.inputs.scriptName).toBe("grid-inbound-mail-test");
    expect(script.inputs.mainModule).toBe("inbound-mail-worker.js");
    // The module syntax Worker, not a service-worker script: that is the shape
    // whose default export's `email` handler Email Routing invokes.
    expect(script.inputs.content).toContain("async email(message, env)");
    expect(script.inputs.content).toContain("export default");
    // The zone lookup is what gates the account id, i.e. the apex check ran.
    expect(CALLS.map((c) => c.token)).toContain("cloudflare:index/getZone:getZone");
  });

  it("keeps the Worker's route in step with the edge rate-limit bucket", async () => {
    // Two copies of one path: the Worker posts to INBOUND_MAIL_PATH, the edge
    // gives that path its own bucket. If they drift, mail lands in the shared
    // per-client bucket, where Cloudflare's few egress addresses exhaust it.
    const { EDGE_RATE_LIMIT } = await import("../constants");
    await install(mailConfig());
    const script = one("cloudflare:index/workersScript:WorkersScript");
    expect(script.inputs.content).toContain(
      `INBOUND_MAIL_PATH = "${EDGE_RATE_LIMIT.paths.inboundMail}"`,
    );
  });

  it("binds the BFF origin and the token under the names the Worker reads", async () => {
    await install(mailConfig());
    const bindings = reveal(one("cloudflare:index/workersScript:WorkersScript").inputs.bindings);
    // The token makes the whole list a secret in state, which is the point.
    expect(bindings.secret).toBe(true);
    expect(bindings.value as Binding[]).toEqual([
      { name: "BFF_URL", type: "plain_text", text: "https://app.example.test" },
      // secret_text, never plain_text: a plain binding is readable by anyone
      // with Workers read access to the account.
      { name: "INBOUND_MAIL_TOKEN", type: "secret_text", text: "inbound-token" }, // pragma: allowlist secret
    ]);
  });

  it("enables Email Routing on the inbound domain itself", async () => {
    await install(mailConfig());
    const routing = one("cloudflare:index/emailRoutingDns:EmailRoutingDns");
    expect(routing.inputs).toMatchObject({ zoneId: ZONE_ID, name: DOMAIN });
  });

  it("sends every address to the Worker through the zone's catch-all", async () => {
    await install(mailConfig());
    const catchAll = one("cloudflare:index/emailRoutingCatchAll:EmailRoutingCatchAll");
    expect(catchAll.inputs).toMatchObject({
      zoneId: ZONE_ID,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", values: ["grid-inbound-mail-test"] }],
    });
  });

  it("reads the apex's MX records before creating anything", async () => {
    await install(mailConfig());
    const lookup = CALLS.find((c) => c.token === "cloudflare:index/getDnsRecords:getDnsRecords");
    // The apex only: the catch-all reaches nothing else, so a subdomain's MX
    // (an outbound provider's bounce host, say) is no concern of the guard.
    expect(lookup?.inputs).toMatchObject({
      zoneId: ZONE_ID,
      type: "MX",
      name: { exact: DOMAIN },
    });
  });

  it("creates the routing on a fresh apex with no MX records (the first run)", async () => {
    await install(mailConfig(), []);
    one("cloudflare:index/emailRoutingDns:EmailRoutingDns");
    one("cloudflare:index/emailRoutingCatchAll:EmailRoutingCatchAll");
  });

  it("creates the routing on an apex that holds only Cloudflare's MX (every later run)", async () => {
    await install(mailConfig(), CLOUDFLARE_MX);
    one("cloudflare:index/emailRoutingDns:EmailRoutingDns");
    one("cloudflare:index/emailRoutingCatchAll:EmailRoutingCatchAll");
  });

  it("uses the zone's provider, holding the configured token", async () => {
    await install(mailConfig());
    const provider = RESOURCES.find(
      (r) => r.type === "pulumi:providers:cloudflare" && r.name === "cloudflare-mail-post-example-test",
    );
    expect(reveal(provider?.inputs.apiToken)).toEqual({ secret: true, value: "cf-token" }); // pragma: allowlist secret
  });
});

describe("the zone apex check", () => {
  const KEY = "grid-oib:inboundMailDomain";

  it("accepts the zone's own apex", async () => {
    const { assertZoneApex } = await import("./email-routing");
    expect(() => assertZoneApex(KEY, DOMAIN, ZONE_ID, DOMAIN)).not.toThrow();
  });

  it("refuses a subdomain of the zone, because the catch-all would not cover it", async () => {
    // eingang.<zone> is the design that looks right and silently refuses every
    // project address: Cloudflare's catch-all exists only for the apex.
    const { assertZoneApex } = await import("./email-routing");
    expect(() => assertZoneApex(KEY, `eingang.${DOMAIN}`, ZONE_ID, DOMAIN)).toThrow(
      /grid-oib:inboundMailDomain.*must be the zone's apex/,
    );
  });
});
