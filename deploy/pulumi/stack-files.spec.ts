import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

/**
 * The committed stack files, checked against EACH OTHER.
 *
 * `loadConfig` sees one stack at a time, so it cannot notice two stacks that
 * split a Cloudflare zone between them. That is how piloti.at kept redirecting
 * to dev.piloti.at after prod shipped: prod published the apex, while the dev
 * stack still owned www and the apex-redirect ruleset that answers at the edge
 * before prod's record is ever used. Every piece deployed cleanly.
 */

type StackConfig = Record<string, unknown>;

const DIR = __dirname;

function stacks(): Array<{ file: string; config: StackConfig }> {
  return readdirSync(DIR)
    .filter((f) => /^Pulumi\.[^.]+\.yaml$/.test(f))
    .map((file) => {
      const doc = load(readFileSync(join(DIR, file), "utf8")) as { config?: StackConfig };
      return { file, config: doc.config ?? {} };
    });
}

const str = (c: StackConfig, key: string): string | undefined => {
  const v = c[`grid-oib:${key}`];
  return typeof v === "string" ? v : undefined;
};

/** The stacks that manage records in each Cloudflare zone, keyed by zone id. */
function stacksByZone(): Map<string, Array<{ file: string; config: StackConfig }>> {
  const zones = new Map<string, Array<{ file: string; config: StackConfig }>>();
  for (const stack of stacks()) {
    const zoneId = str(stack.config, "dnsZoneId");
    if (str(stack.config, "dnsEnabled") !== "true" || zoneId === undefined) continue;
    zones.set(zoneId, [...(zones.get(zoneId) ?? []), stack]);
  }
  return zones;
}

describe("committed stack files", () => {
  it("finds the stacks it is meant to compare", () => {
    expect(stacks().map((s) => s.file)).toEqual(
      expect.arrayContaining(["Pulumi.dev.yaml", "Pulumi.prod.yaml"]),
    );
  });

  it("give each Cloudflare zone at most one baseline owner", () => {
    for (const [zoneId, members] of stacksByZone()) {
      const owners = members.filter((s) => str(s.config, "dnsZoneBaseline") === "true");
      const files = owners.map((s) => s.file).join(", ");
      expect(owners.length, `zone ${zoneId} is claimed by ${files}`).toBeLessThanOrEqual(1);
    }
  });

  it("leave no apex redirect standing once any stack in the zone serves the apex", () => {
    for (const [zoneId, members] of stacksByZone()) {
      const apexServers = members.filter((s) => {
        const web = str(s.config, "webDomain") ?? str(s.config, "baseDomain");
        return web === str(s.config, "dnsZoneName");
      });
      if (apexServers.length === 0) continue;
      const redirecting = members.filter((s) => str(s.config, "dnsApexRedirectTo") !== undefined);
      expect(redirecting.map((s) => s.file), `zone ${zoneId}`).toEqual([]);
    }
  });
});

describe("the prod image pin the deploy verifies", () => {
  // deploy.yml's "Verify the pinned images exist" reads the tag with
  // `sed -n 's/^  grid-oib:imageTag: *//p'` before any Pulumi is installed. If
  // the pin moves or changes shape, that step fails closed; this says why
  // before a deploy does.
  it("is one immutable sha tag, on the line the deploy step reads", () => {
    const text = readFileSync(join(DIR, "Pulumi.prod.yaml"), "utf8");
    const pins = text
      .split("\n")
      .map((line) => /^  grid-oib:imageTag: *(.*)$/.exec(line)?.[1]?.replace(/["']/g, ""))
      .filter((tag): tag is string => tag !== undefined);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatch(/^sha-[0-9a-f]{40}$/);
  });
});
