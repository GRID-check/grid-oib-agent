import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";
import { CONTACT_ZONE, CONTACT_ZONE_ID, contactStackConfig } from "../test-support/contact-config";

/**
 * The contact address on Cloudflare (`platform/contact-mail.ts`).
 *
 * As with the inbox, every field is a string Cloudflare accepts whatever it
 * says: a matcher of the wrong type is a catch-all on the product's own
 * domain, a forward to an address that was never created is a rule that drops
 * mail. So the assertions read the exact inputs sent.
 */

type Recorded = { type: string; name: string; inputs: Record<string, unknown> };
const RESOURCES: Recorded[] = [];
const CALLS: Array<{ token: string; inputs: Record<string, unknown> }> = [];

let MX_RECORDS: Array<{ name: string; content: string; type: string }> = [];
let TXT_RECORDS: Array<{ name: string; content: string; type: string }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      CALLS.push({ token: args.token, inputs: args.inputs });
      if (args.token === "cloudflare:index/getZone:getZone") {
        return {
          id: args.inputs.zoneId,
          name: CONTACT_ZONE,
          account: { id: "account-1", name: "Grid" },
        };
      }
      if (args.token === "cloudflare:index/getDnsRecords:getDnsRecords") {
        return { results: args.inputs.type === "TXT" ? TXT_RECORDS : MX_RECORDS };
      }
      return {};
    },
  },
  "grid-oib",
  "test",
  false,
);

async function install(
  values: Record<string, string>,
  mx: typeof MX_RECORDS = [],
  txt: typeof TXT_RECORDS = [],
) {
  RESOURCES.length = 0;
  CALLS.length = 0;
  MX_RECORDS = mx;
  TXT_RECORDS = txt;
  pulumi.runtime.setAllConfig({
    ...baseStackConfig(),
    "grid-oib:observabilityEnabled": "false",
    ...values,
  });
  const { loadConfig } = await import("../config");
  const { installContactMail } = await import("./contact-mail");
  const { installMailZones } = await import("./email-routing");
  const cfg = loadConfig();
  const result = installContactMail(cfg, installMailZones(cfg).contact);
  if (result) {
    await Promise.all(
      [result.zone.routing.id, result.rule.id, ...result.addresses.map((a) => a.id)].map(
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

const SECRET_SIG = "4dabf18193072939515e22adb298388d"; // pragma: allowlist secret (Pulumi secret-marker constant, not a credential)
function reveal(value: unknown): { secret: boolean; value: unknown } {
  if (typeof value === "object" && value !== null && SECRET_SIG in value && "value" in value) {
    return { secret: true, value: value.value };
  }
  return { secret: false, value };
}

describe("the contact address on Cloudflare", () => {
  it("creates nothing when contactAddress is unset", async () => {
    const result = await install({ ...contactStackConfig(), "grid-oib:contactAddress": "" });
    expect(result).toBeUndefined();
    expect(RESOURCES.filter((r) => r.type.startsWith("cloudflare:"))).toEqual([]);
    expect(CALLS).toEqual([]);
  });

  it("enables Email Routing on the app zone's apex", async () => {
    await install(contactStackConfig());
    const routing = one("cloudflare:index/emailRoutingDns:EmailRoutingDns");
    expect(routing.inputs).toMatchObject({ zoneId: CONTACT_ZONE_ID, name: CONTACT_ZONE });
  });

  it("creates one destination address per target, in the zone's account", async () => {
    // Each create makes Cloudflare mail a verification link to that inbox;
    // nothing is forwarded there until its owner clicks it.
    await install(contactStackConfig());
    const addresses = byType("cloudflare:index/emailRoutingAddress:EmailRoutingAddress");
    expect(addresses.map((a) => a.inputs)).toEqual([
      { accountId: "account-1", email: "mail@founder-one.example" },
      { accountId: "account-1", email: "mail@founder-two.example" },
    ]);
    // Named by address, not by position: reordering the list must not
    // replace (and so re-verify) an address that did not change.
    expect(addresses.map((a) => a.name)).toEqual([
      "contact-mail-destination-mail-founder-one-example",
      "contact-mail-destination-mail-founder-two-example",
    ]);
  });

  it("forwards the one address with a literal rule to every target", async () => {
    await install(contactStackConfig());
    const rule = one("cloudflare:index/emailRoutingRule:EmailRoutingRule");
    expect(rule.inputs).toMatchObject({
      zoneId: CONTACT_ZONE_ID,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "kontakt@example.test" }],
      actions: [
        { type: "forward", values: ["mail@founder-one.example", "mail@founder-two.example"] },
      ],
    });
  });

  it("puts no catch-all on the product's own domain", async () => {
    // A catch-all here would route every address on the apex; every one but
    // the contact address must keep being refused.
    await install(contactStackConfig());
    expect(byType("cloudflare:index/emailRoutingCatchAll:EmailRoutingCatchAll")).toEqual([]);
    expect(byType("cloudflare:index/workersScript:WorkersScript")).toEqual([]);
  });

  it("reads the apex's MX records before creating anything", async () => {
    await install(contactStackConfig());
    const lookup = CALLS.find((c) => c.token === "cloudflare:index/getDnsRecords:getDnsRecords");
    expect(lookup?.inputs).toMatchObject({
      zoneId: CONTACT_ZONE_ID,
      type: "MX",
      name: { exact: CONTACT_ZONE },
    });
  });

  it("creates the routing on an apex with no MX records (the first run)", async () => {
    await install(contactStackConfig(), []);
    one("cloudflare:index/emailRoutingRule:EmailRoutingRule");
  });

  it("creates the routing on an apex that holds only Cloudflare's MX (every later run)", async () => {
    const mx = ["route1", "route2", "route3"].map((h) => ({
      name: CONTACT_ZONE,
      content: `${h}.mx.cloudflare.net`,
      type: "MX",
    }));
    await install(contactStackConfig(), mx);
    one("cloudflare:index/emailRoutingRule:EmailRoutingRule");
  });

  it("reads the zone's DMARC records, which Email Sending onboarding adds to", async () => {
    await install(contactStackConfig());
    const lookups = CALLS.filter(
      (c) => c.token === "cloudflare:index/getDnsRecords:getDnsRecords" && c.inputs.type === "TXT",
    );
    expect(lookups.map((c) => c.inputs)).toEqual([
      expect.objectContaining({
        zoneId: CONTACT_ZONE_ID,
        name: { exact: `_dmarc.${CONTACT_ZONE}` },
      }),
    ]);
  });

  it("creates the routing beside the one DMARC record dnsDmarc manages", async () => {
    await install(
      contactStackConfig(),
      [],
      [{ name: `_dmarc.${CONTACT_ZONE}`, content: "v=DMARC1; p=quarantine;", type: "TXT" }],
    );
    one("cloudflare:index/emailRoutingRule:EmailRoutingRule");
  });

  it("uses the zone's provider, holding the stack's token, not the web pods' one", async () => {
    await install(contactStackConfig());
    const provider = RESOURCES.find(
      (r) =>
        r.type === "pulumi:providers:cloudflare" &&
        r.name === `cloudflare-mail-${CONTACT_ZONE.replace(/[^a-z0-9]+/g, "-")}`,
    );
    expect(reveal(provider?.inputs.apiToken)).toEqual({ secret: true, value: "cf-token" }); // pragma: allowlist secret
  });

  it("hands the web tier the zone's account id", async () => {
    const result = await install(contactStackConfig());
    const accountId = await new Promise((resolve) => result?.accountId.apply(resolve));
    expect(accountId).toBe("account-1");
  });
});

describe("the contact zone check", () => {
  const KEY = "grid-oib:contactAddress";

  it("accepts the zone whose real name is dnsZoneName", async () => {
    const { assertZoneApex } = await import("./email-routing");
    expect(() => assertZoneApex(KEY, CONTACT_ZONE, CONTACT_ZONE_ID, CONTACT_ZONE)).not.toThrow();
  });

  it("refuses a dnsZoneId that names another zone", async () => {
    const { assertZoneApex } = await import("./email-routing");
    expect(() => assertZoneApex(KEY, CONTACT_ZONE, CONTACT_ZONE_ID, "other.example")).toThrow(
      /grid-oib:contactAddress route mail on .* but zone zone-app-1 is "other.example"/,
    );
  });
});
