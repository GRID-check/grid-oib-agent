import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";
import { mailStackConfig, SIGNING_KEY_ID, SIGNING_SECRET } from "../test-support/app-zone-config";

/**
 * Project mail on Cloudflare (`platform/inbound-mail.ts`).
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
const CONTRACT = JSON.parse(
  readFileSync(join(__dirname, "../../../../shared/inbound-mail-contract.json"), "utf8"),
) as { path: string };

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
    ...mailStackConfig(),
    "grid-oib:observabilityEnabled": "false",
    "grid-oib:baseDomain": "example.test",
    "grid-oib:inboundMailDomain": DOMAIN,
    "grid-oib:inboundMailZoneId": ZONE_ID,
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
  const { installInboundMailZone } = await import("./email-routing");
  const cfg = loadConfig();
  const result = installInboundMail(cfg, installInboundMailZone(cfg));
  if (result) {
    const ids = [result.zone.routing.id, result.catchAll.id, ...(result.script ? [result.script.id] : [])];
    await Promise.all(ids.map((id) => new Promise((resolve) => id.apply(resolve))));
  }
  return result;
}

const byType = (type: string) => RESOURCES.filter((r) => r.type === type);
const one = (type: string): Recorded => {
  const found = byType(type);
  expect(found, type).toHaveLength(1);
  return found[0];
};

const SCRIPT = "cloudflare:index/workersScript:WorkersScript";
const CATCH_ALL = "cloudflare:index/emailRoutingCatchAll:EmailRoutingCatchAll";
const ROUTING = "cloudflare:index/emailRoutingDns:EmailRoutingDns";

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

describe("project mail on Cloudflare", () => {
  it("creates nothing when inboundMailDomain is unset", async () => {
    const result = await install(mailConfig({ "grid-oib:inboundMailDomain": "" }));
    expect(result).toBeUndefined();
    expect(RESOURCES.filter((r) => r.type.startsWith("cloudflare:"))).toEqual([]);
    expect(CALLS).toEqual([]);
  });

  it("uploads the Worker module verbatim, into the zone's account", async () => {
    await install(mailConfig());
    const script = one(SCRIPT);
    expect(script.inputs.accountId).toBe("account-1");
    expect(script.inputs.scriptName).toBe("grid-inbound-mail-test");
    expect(script.inputs.mainModule).toBe("inbound-mail-worker.js");
    expect(script.inputs.content).toBe(readFileSync(join(__dirname, "inbound-mail-worker.js"), "utf8"));
    // The module syntax Worker, not a service-worker script: that is the shape
    // whose default export's `email` handler Email Routing invokes.
    expect(script.inputs.content).toContain("async email(message, env)");
    expect(script.inputs.content).toContain(`INBOUND_MAIL_PATH = "${CONTRACT.path}"`);
    // The zone lookup is what gates the account id, i.e. the apex check ran.
    expect(CALLS.map((c) => c.token)).toContain("cloudflare:index/getZone:getZone");
  });

  it("switches Workers observability off explicitly", async () => {
    // Workers Logs would keep a record of every delivery at Cloudflare.
    await install(mailConfig());
    expect(one(SCRIPT).inputs.observability).toEqual({ enabled: false });
  });

  it("pins a compatibility date less than a year old", async () => {
    // The retry-on-throw behaviour the Worker relies on is undocumented
    // platform behaviour; a stale date is a decision nobody re-made (G8).
    const { COMPATIBILITY_DATE } = await import("./inbound-mail");
    await install(mailConfig());
    expect(one(SCRIPT).inputs.compatibilityDate).toBe(COMPATIBILITY_DATE);
    const ageDays = (Date.now() - Date.parse(`${COMPATIBILITY_DATE}T00:00:00Z`)) / 86_400_000;
    expect(ageDays, "bump COMPATIBILITY_DATE and re-run launch gates G1 and G2 (G8)").toBeLessThan(365);
  });

  it("binds the BFF origin, the key and the pause under the names the Worker reads", async () => {
    await install(mailConfig());
    const bindings = reveal(one(SCRIPT).inputs.bindings);
    // The key makes the whole list a secret in state, which is the point.
    expect(bindings.secret).toBe(true);
    expect(bindings.value as Binding[]).toEqual([
      { name: "BFF_URL", type: "plain_text", text: "https://app.example.test" },
      { name: "SIGNING_KEY_ID", type: "plain_text", text: SIGNING_KEY_ID },
      // secret_text, never plain_text: a plain binding is readable by anyone
      // with Workers read access to the account.
      { name: "SIGNING_KEY", type: "secret_text", text: SIGNING_SECRET },
      { name: "PAUSED", type: "plain_text", text: "false" },
    ]);
  });

  it("signs with the key the stack names during a rotation", async () => {
    const successor = Buffer.alloc(32, 0x22).toString("base64");
    await install(
      mailConfig({
        "grid-oib:inboundMailSigningKeys": JSON.stringify({ [SIGNING_KEY_ID]: SIGNING_SECRET, "mi-2027-01": successor }),
        "grid-oib:inboundMailSigningKeyId": "mi-2027-01",
      }),
    );
    const bindings = reveal(one(SCRIPT).inputs.bindings).value as Binding[];
    expect(bindings.find((b) => b.name === "SIGNING_KEY_ID")?.text).toBe("mi-2027-01");
    expect(bindings.find((b) => b.name === "SIGNING_KEY")?.text).toBe(successor);
  });

  it("passes the pause to the Worker", async () => {
    await install(mailConfig({ "grid-oib:inboundMailPaused": "true" }));
    const bindings = reveal(one(SCRIPT).inputs.bindings).value as Binding[];
    expect(bindings.find((b) => b.name === "PAUSED")?.text).toBe("true");
  });

  it("enables Email Routing on the inbound domain itself", async () => {
    await install(mailConfig());
    expect(one(ROUTING).inputs).toMatchObject({ zoneId: ZONE_ID, name: DOMAIN });
  });

  it("sends every address to the Worker through the zone's catch-all", async () => {
    await install(mailConfig());
    expect(one(CATCH_ALL).inputs).toMatchObject({
      zoneId: ZONE_ID,
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", values: ["grid-inbound-mail-test"] }],
    });
  });

  it("reads the apex's MX records before creating anything", async () => {
    await install(mailConfig());
    const lookup = CALLS.find((c) => c.token === "cloudflare:index/getDnsRecords:getDnsRecords");
    expect(lookup?.inputs).toMatchObject({ zoneId: ZONE_ID, type: "MX", name: { exact: DOMAIN } });
  });

  it.each([
    ["a fresh apex with no MX records (the first run)", []],
    ["an apex that holds only Cloudflare's MX (every later run)", CLOUDFLARE_MX],
  ])("creates the routing on %s", async (_label, mx) => {
    await install(mailConfig(), mx);
    one(ROUTING);
    one(CATCH_ALL);
  });

  it("uses a provider of its own, holding the configured token", async () => {
    await install(mailConfig());
    const provider = RESOURCES.find(
      (r) => r.type === "pulumi:providers:cloudflare" && r.name === "cloudflare-inbound-mail",
    );
    expect(reveal(provider?.inputs.apiToken)).toEqual({ secret: true, value: "cf-token" }); // pragma: allowlist secret
  });
});

describe("project mail, switched off (inboundMailEnabled: false)", () => {
  const off = () =>
    mailConfig({ "grid-oib:inboundMailEnabled": "false", "grid-oib:inboundMailSigningKeys": "" });

  it("keeps the catch-all, disabled, so Cloudflare refuses at SMTP time", async () => {
    // Disabled, not Drop: Drop accepts and discards, and the sender never
    // learns the mail was lost.
    const result = await install(off());
    expect(result?.script).toBeUndefined();
    expect(byType(SCRIPT)).toEqual([]);
    const catchAll = one(CATCH_ALL);
    expect(catchAll.inputs).toMatchObject({ zoneId: ZONE_ID, enabled: false, matchers: [{ type: "all" }] });
    expect(catchAll.inputs.actions).toEqual([{ type: "drop" }]);
    expect(JSON.stringify(catchAll.inputs)).not.toContain("grid-inbound-mail-test");
  });

  it("is the same Pulumi resource as the live catch-all, so the switch is an update, not a delete", async () => {
    // A delete of the catch-all is a no-op at Cloudflare: it would stay
    // pointed at the Worker this `up` deletes.
    await install(mailConfig());
    const onName = one(CATCH_ALL).name;
    await install(off());
    expect(one(CATCH_ALL).name).toBe(onName);
  });

  it("keeps Email Routing on the zone, which company addresses depend on", async () => {
    await install(off());
    one(ROUTING);
  });
});

describe("the zone apex check", () => {
  const KEY = "grid-oib:inboundMailDomain";

  it("accepts the zone's own apex", async () => {
    const { assertZoneApex } = await import("./email-routing");
    expect(() => assertZoneApex(KEY, DOMAIN, ZONE_ID, DOMAIN)).not.toThrow();
  });

  it("refuses a subdomain of the zone, because the catch-all would not cover it", async () => {
    const { assertZoneApex } = await import("./email-routing");
    expect(() => assertZoneApex(KEY, `mail.${DOMAIN}`, ZONE_ID, DOMAIN)).toThrow(
      /grid-oib:inboundMailDomain.*must be the zone's apex/,
    );
  });
});
