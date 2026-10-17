import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";
import {
  CONTACT_ZONE,
  CONTACT_ZONE_ID,
  contactStackConfig,
} from "./src/test-support/contact-config";

/**
 * The whole program as production runs it: the contact address AND the
 * project mail inbox on the product's own apex, one zone, one stack.
 *
 * A separate file for the reason `index-dns.spec.ts` gives: `index.ts` works at
 * module scope and Pulumi's runtime is process-global.
 *
 * What only the whole program shows: the zone's Email Routing is enabled once,
 * by one provider, for both features (`installMailZones`); the contact rule and
 * the inbox's catch-all sit side by side on it; and each pod gets only its own
 * credentials. The inbox on a zone of its own is `index-inbound-mail.spec.ts`;
 * the two shapes side by side, `src/platform/mail-zones.spec.ts`.
 */

type Recorded = { type: string; name: string; inputs: Record<string, unknown> };
const RESOURCES: Recorded[] = [];

const ZONES: Record<string, string> = {
  [CONTACT_ZONE_ID]: CONTACT_ZONE,
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
      // No inboundMailZoneId: on the app zone's apex it defaults to dnsZoneId.
      "grid-oib:inboundMailDomain": CONTACT_ZONE,
      "grid-oib:inboundMailToken": "inbound-token", // pragma: allowlist secret
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("enables routing on the apex once, for both features", () => {
    // Two enablements of one zone would each believe they owned it, and
    // deleting either would switch routing off for both.
    const routing = byType("cloudflare:index/emailRoutingDns:EmailRoutingDns");
    expect(routing.map((r) => [r.inputs.zoneId, r.inputs.name])).toEqual([
      [CONTACT_ZONE_ID, CONTACT_ZONE],
    ]);
  });

  it("puts the contact rule and the inbox's catch-all side by side on the one zone", () => {
    // Cloudflare matches the literal rule first, so kontakt@ never reaches the
    // Worker; every other address on the apex does, and the Worker refuses all
    // but project addresses.
    const catchAlls = byType("cloudflare:index/emailRoutingCatchAll:EmailRoutingCatchAll");
    expect(catchAlls.map((r) => r.inputs.zoneId)).toEqual([CONTACT_ZONE_ID]);
    expect(catchAlls[0].inputs.actions).toEqual([
      { type: "worker", values: ["grid-inbound-mail-test"] },
    ]);
    const rules = byType("cloudflare:index/emailRoutingRule:EmailRoutingRule");
    expect(rules.map((r) => r.inputs.zoneId)).toEqual([CONTACT_ZONE_ID]);
    expect(rules[0].inputs.matchers).toEqual([
      { type: "literal", field: "to", value: `kontakt@${CONTACT_ZONE}` },
    ]);
  });

  it("uses one Cloudflare provider for the zone's mail", () => {
    const providers = byType("pulumi:providers:cloudflare").map((r) => r.name);
    expect(providers.filter((name) => name.startsWith("cloudflare-mail-"))).toEqual([
      `cloudflare-mail-${CONTACT_ZONE.replace(/[^a-z0-9]+/g, "-")}`,
    ]);
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
