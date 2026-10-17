import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";
import { APP_ZONE, APP_ZONE_ID, appZoneStackConfig } from "./src/test-support/app-zone-config";

/**
 * The whole program as production runs it: the project mail inbox on the
 * product's own apex, the zone this stack already manages for DNS.
 *
 * A separate file for the reason `index-dns.spec.ts` gives: `index.ts` works at
 * module scope and Pulumi's runtime is process-global.
 *
 * What only the whole program shows: with no `inboundMailZoneId`, routing and
 * the catch-all land on the app zone, beside the DNS module's records, and the
 * inbox's credentials reach the frontend and no other pod. The inbox on a zone
 * of its own is `index-inbound-mail.spec.ts`.
 */

type Recorded = { type: string; name: string; inputs: Record<string, unknown> };
const RESOURCES: Recorded[] = [];

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
        const name = zoneId === APP_ZONE_ID ? APP_ZONE : undefined;
        return { id: zoneId, name, account: { id: "account-1", name: "Grid" } };
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

type EnvVar = { name: string };

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

describe("the program with the project mail inbox on the app zone's apex", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...appZoneStackConfig(),
      "grid-oib:seaweedfsTopology": "single",
      "grid-oib:seaweedfsPerOrgBuckets": "false",
      "grid-oib:observabilityEnabled": "false",
      // No inboundMailZoneId: on the app zone's apex it defaults to dnsZoneId.
      "grid-oib:inboundMailDomain": APP_ZONE,
      "grid-oib:inboundMailToken": "inbound-token", // pragma: allowlist secret
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("enables routing once, on the app zone's apex", () => {
    const routing = byType("cloudflare:index/emailRoutingDns:EmailRoutingDns");
    expect(routing.map((r) => [r.inputs.zoneId, r.inputs.name])).toEqual([[APP_ZONE_ID, APP_ZONE]]);
  });

  it("points the app zone's catch-all at this stack's Worker", () => {
    // Every address no literal rule claims reaches the Worker, which refuses
    // all but project addresses.
    const catchAlls = byType("cloudflare:index/emailRoutingCatchAll:EmailRoutingCatchAll");
    expect(catchAlls.map((r) => r.inputs.zoneId)).toEqual([APP_ZONE_ID]);
    expect(catchAlls[0].inputs.actions).toEqual([
      { type: "worker", values: ["grid-inbound-mail-test"] },
    ]);
  });

  it("gives the frontend the inbox, and the web pods nothing of it", () => {
    const frontend = containerEnv("frontend").map((e) => e.name);
    expect(frontend).toEqual(
      expect.arrayContaining(["GRID_INBOUND_MAIL_DOMAIN", "GRID_INBOUND_MAIL_TOKEN"]),
    );
    const web = containerEnv("web").map((e) => e.name);
    expect(web).not.toContain("GRID_INBOUND_MAIL_TOKEN");
    expect(web).not.toContain("GRID_INBOUND_MAIL_DOMAIN");
  });
});
