import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";
import { CONTACT_ZONE, CONTACT_ZONE_ID, contactStackConfig } from "../test-support/contact-config";

/**
 * Email Routing per zone (`installMailZones` in `email-routing.ts`): one
 * enablement and one provider per zone that routes mail, shared by the contact
 * address and the project mail inbox when they are on the same apex.
 */

type Recorded = { type: string; name: string; inputs: Record<string, unknown> };
const RESOURCES: Recorded[] = [];
const CALLS: Array<{ token: string; inputs: Record<string, unknown> }> = [];

const INBOX_ZONE_ID = "zone-mail-1";
const INBOX_DOMAIN = "post.example.org";
const ZONES: Record<string, string> = {
  [CONTACT_ZONE_ID]: CONTACT_ZONE,
  [INBOX_ZONE_ID]: INBOX_DOMAIN,
};

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      CALLS.push({ token: args.token, inputs: args.inputs });
      if (args.token === "cloudflare:index/getZone:getZone") {
        const zoneId = String(args.inputs.zoneId);
        return { id: zoneId, name: ZONES[zoneId], account: { id: "account-1", name: "Grid" } };
      }
      if (args.token === "cloudflare:index/getDnsRecords:getDnsRecords") {
        return { results: [] };
      }
      return {};
    },
  },
  "grid-oib",
  "test",
  false,
);

const INBOX = {
  "grid-oib:inboundMailToken": "inbound-token", // pragma: allowlist secret
};

async function zones(values: Record<string, string>) {
  RESOURCES.length = 0;
  CALLS.length = 0;
  pulumi.runtime.setAllConfig({
    ...baseStackConfig(),
    "grid-oib:observabilityEnabled": "false",
    ...values,
  });
  const { loadConfig } = await import("../config");
  const { installMailZones } = await import("./email-routing");
  const result = installMailZones(loadConfig());
  const created = [result.contact, result.inbound].flatMap((z) => (z ? [z.routing.id] : []));
  await Promise.all(created.map((id) => new Promise((resolve) => id.apply(resolve))));
  return result;
}

const routing = () =>
  RESOURCES.filter((r) => r.type === "cloudflare:index/emailRoutingDns:EmailRoutingDns").map(
    (r) => [r.inputs.zoneId, r.inputs.name],
  );
const providers = () =>
  RESOURCES.filter((r) => r.type === "pulumi:providers:cloudflare").map((r) => r.name);
const dmarcLookups = () =>
  CALLS.filter(
    (c) => c.token === "cloudflare:index/getDnsRecords:getDnsRecords" && c.inputs.type === "TXT",
  ).map((c) => c.inputs.zoneId);

describe("Email Routing per zone", () => {
  it("routes nothing when neither feature is on", async () => {
    const result = await zones({});
    expect(result).toEqual({ contact: undefined, inbound: undefined });
    expect(routing()).toEqual([]);
  });

  it("shares one zone between the contact address and an inbox on the app apex", async () => {
    const result = await zones({
      ...contactStackConfig(),
      ...INBOX,
      "grid-oib:inboundMailDomain": CONTACT_ZONE,
    });
    expect(result.inbound).toBe(result.contact);
    expect(routing()).toEqual([[CONTACT_ZONE_ID, CONTACT_ZONE]]);
    expect(providers()).toEqual([`cloudflare-mail-${CONTACT_ZONE.replace(/[^a-z0-9]+/g, "-")}`]);
    // The contact form's sender domain is checked for a second _dmarc record.
    expect(dmarcLookups()).toEqual([CONTACT_ZONE_ID]);
  });

  it("gives an inbox on a zone of its own its own enablement and provider", async () => {
    const result = await zones({
      ...contactStackConfig(),
      ...INBOX,
      "grid-oib:inboundMailDomain": INBOX_DOMAIN,
      "grid-oib:inboundMailZoneId": INBOX_ZONE_ID,
    });
    expect(result.inbound).not.toBe(result.contact);
    expect(routing().sort()).toEqual(
      [
        [CONTACT_ZONE_ID, CONTACT_ZONE],
        [INBOX_ZONE_ID, INBOX_DOMAIN],
      ].sort(),
    );
    expect(providers()).toHaveLength(2);
    // Only the contact zone sends mail, so only it has a _dmarc to watch.
    expect(dmarcLookups()).toEqual([CONTACT_ZONE_ID]);
  });

  it("routes the inbox alone, without the contact address", async () => {
    const result = await zones({
      ...INBOX,
      "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
      "grid-oib:inboundMailDomain": INBOX_DOMAIN,
      "grid-oib:inboundMailZoneId": INBOX_ZONE_ID,
    });
    expect(result.contact).toBeUndefined();
    expect(routing()).toEqual([[INBOX_ZONE_ID, INBOX_DOMAIN]]);
    expect(dmarcLookups()).toEqual([]);
  });
});
