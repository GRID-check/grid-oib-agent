import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";
import {
  CONTACT_ZONE,
  CONTACT_ZONE_ID,
  contactStackConfig,
} from "./src/test-support/contact-config";

/**
 * The whole program with the contact address AND the project mail inbox on,
 * in one Cloudflare account, each on its own zone.
 *
 * A separate file for the reason `index-dns.spec.ts` gives: `index.ts` works at
 * module scope and Pulumi's runtime is process-global.
 *
 * What only the whole program shows is that the two Email Routing features do
 * not reach into each other: the inbox's catch-all stays on its zone, the
 * contact rule on the app zone, and each pod gets only its own credentials.
 */

type Recorded = { type: string; name: string; inputs: Record<string, unknown> };
const RESOURCES: Recorded[] = [];

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
      return {
        id: `${args.name}-id`,
        state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
      };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === "cloudflare:index/getZone:getZone") {
        const zoneId = String(args.inputs.zoneId);
        // One account holds both zones, as it will in production.
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

type EnvVar = { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string } } };

const byType = (type: string) => RESOURCES.filter((r) => r.type === type);

function containerEnv(deploymentName: string): EnvVar[] {
  const deployment = RESOURCES.find(
    (r) => r.type === "kubernetes:apps/v1:Deployment" && r.name === deploymentName,
  );
  const spec = deployment?.inputs.spec as {
    template: { spec: { containers: Array<{ env: EnvVar[] }> } };
  };
  return spec.template.spec.containers[0].env;
}

describe("the program with the contact address and the project mail inbox on", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...contactStackConfig(),
      "grid-oib:seaweedfsTopology": "single",
      "grid-oib:seaweedfsPerOrgBuckets": "false",
      "grid-oib:observabilityEnabled": "false",
      "grid-oib:inboundMailDomain": INBOX_DOMAIN,
      "grid-oib:inboundMailZoneId": INBOX_ZONE_ID,
      "grid-oib:inboundMailToken": "inbound-token", // pragma: allowlist secret
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("enables routing once per zone, each on its own apex", () => {
    const routing = byType("cloudflare:index/emailRoutingDns:EmailRoutingDns").map((r) => [
      r.inputs.zoneId,
      r.inputs.name,
    ]);
    expect(routing.sort()).toEqual(
      [
        [CONTACT_ZONE_ID, CONTACT_ZONE],
        [INBOX_ZONE_ID, INBOX_DOMAIN],
      ].sort(),
    );
  });

  it("keeps the catch-all on the inbox zone and the literal rule on the app zone", () => {
    const catchAlls = byType("cloudflare:index/emailRoutingCatchAll:EmailRoutingCatchAll");
    expect(catchAlls.map((r) => r.inputs.zoneId)).toEqual([INBOX_ZONE_ID]);
    const rules = byType("cloudflare:index/emailRoutingRule:EmailRoutingRule");
    expect(rules.map((r) => r.inputs.zoneId)).toEqual([CONTACT_ZONE_ID]);
    expect(rules[0].inputs.matchers).toEqual([
      { type: "literal", field: "to", value: `kontakt@${CONTACT_ZONE}` },
    ]);
  });

  it("gives each feature a provider of its own", () => {
    const providers = byType("pulumi:providers:cloudflare").map((r) => r.name);
    expect(providers).toEqual(
      expect.arrayContaining(["cloudflare-inbound-mail", "cloudflare-contact-mail"]),
    );
  });

  it("gives the web pods the contact form's credentials and nothing of the inbox's", () => {
    const env = containerEnv("web");
    const names = env.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining(["CONTACT_FROM", "CLOUDFLARE_EMAIL_TOKEN", "CONTACT_FORM_SECRET"]),
    );
    expect(names).not.toContain("GRID_INBOUND_MAIL_TOKEN");
    const secretRefs = env.flatMap((e) => e.valueFrom?.secretKeyRef?.name ?? []);
    expect(new Set(secretRefs)).toEqual(new Set(["web-contact"]));
  });

  it("gives the frontend the inbox and nothing of the contact form's", () => {
    const names = containerEnv("frontend").map((e) => e.name);
    expect(names).toContain("GRID_INBOUND_MAIL_DOMAIN");
    for (const name of ["CONTACT_FROM", "CLOUDFLARE_EMAIL_TOKEN", "CONTACT_FORM_SECRET"]) {
      expect(names).not.toContain(name);
    }
  });
});
