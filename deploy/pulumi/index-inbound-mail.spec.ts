import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";
import { mailStackConfig, SIGNING_KEY_ID, SIGNING_KEYS, SIGNING_SECRET } from "./src/test-support/app-zone-config";

/**
 * The whole program with project mail on, on a zone of its own.
 *
 * A separate file for the reason `index-dns.spec.ts` gives: `index.ts` works at
 * module scope and Pulumi's runtime is process-global, so one process builds
 * one configuration.
 *
 * What only the whole program can show is that the two halves meet: the Worker
 * Cloudflare runs signs with one key of a map and posts to one origin, and the
 * frontend pod must hold the same map under the name the BFF reads, with
 * `WORKOS_REDIRECT_URI` on the origin the Worker signs for. The per-module
 * specs each see one side. The program on the app zone's apex is
 * `index-inbound-mail-apex.spec.ts`.
 */

type Recorded = { type: string; name: string; inputs: Record<string, unknown> };
const RESOURCES: Recorded[] = [];

const DOMAIN = "post.example.test";

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
        return { id: args.inputs.zoneId, name: DOMAIN, account: { id: "account-1", name: "Grid" } };
      }
      if (args.token === "cloudflare:index/getDnsRecords:getDnsRecords") {
        // The apex MX guard's lookup: Cloudflare's own MX, as after a first `up`.
        return { results: [{ name: DOMAIN, content: "route1.mx.cloudflare.net", type: "MX" }] };
      }
      return {};
    },
  },
  "grid-oib",
  "test",
  false,
);

type EnvVar = { name: string; value?: string; valueFrom?: { secretKeyRef?: { key: string } } };

/** Unwrap a mock input that Pulumi marked secret. */
function reveal<T>(value: unknown): T {
  const sig = "4dabf18193072939515e22adb298388d"; // pragma: allowlist secret (Pulumi secret-marker constant, not a credential)
  const secret = typeof value === "object" && value !== null && sig in value && "value" in value;
  return (secret ? value.value : value) as T;
}

function containerEnv(deploymentName: string): EnvVar[] {
  const deployment = RESOURCES.find(
    (r) =>
      r.type === "kubernetes:apps/v1:Deployment" &&
      (r.inputs.metadata as { name?: string } | undefined)?.name === deploymentName,
  );
  const spec = deployment?.inputs.spec as {
    template: { spec: { containers: Array<{ name: string; env?: EnvVar[] }> } };
  };
  return spec.template.spec.containers[0].env ?? [];
}

describe("the program constructs with project mail on", () => {
  let outputs: Record<string, unknown> = {};

  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...mailStackConfig(),
      "grid-oib:seaweedfsTopology": "single",
      "grid-oib:seaweedfsPerOrgBuckets": "false",
      "grid-oib:observabilityEnabled": "false",
      "grid-oib:inboundMailDomain": DOMAIN,
      "grid-oib:inboundMailZoneId": "zone-mail-1",
      "grid-oib:inboundMailPaused": "true",
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.entries(stack)
        .filter((entry): entry is [string, pulumi.Output<unknown>] => pulumi.Output.isInstance(entry[1]))
        .map(([name, output]) => new Promise((resolve) => output.apply((v) => resolve((outputs[name] = v))))),
    );
  }, 120_000);

  it("creates the Worker, the routing and the catch-all", () => {
    expect(RESOURCES.map((r) => r.type)).toEqual(
      expect.arrayContaining([
        "cloudflare:index/workersScript:WorkersScript",
        "cloudflare:index/emailRoutingDns:EmailRoutingDns",
        "cloudflare:index/emailRoutingCatchAll:EmailRoutingCatchAll",
      ]),
    );
    expect(outputs.inboundMailWorker).toBe("grid-inbound-mail-test (paused)");
  });

  it("gives the frontend the domain, the pause and the key map, the map from the Secret", () => {
    const env = containerEnv("frontend");
    expect(env.find((e) => e.name === "GRID_INBOUND_MAIL_DOMAIN")?.value).toBe(DOMAIN);
    expect(env.find((e) => e.name === "GRID_INBOUND_MAIL_PAUSED")?.value).toBe("true");
    const keys = env.find((e) => e.name === "GRID_INBOUND_MAIL_SIGNING_KEYS");
    // Never inline: anything with `get pod` could read it.
    expect(keys?.value).toBeUndefined();
    expect(keys?.valueFrom?.secretKeyRef?.key).toBe("GRID_INBOUND_MAIL_SIGNING_KEYS");
  });

  it("signs in the Worker with the key the BFF's map holds under the same keyid", () => {
    const secret = RESOURCES.find((r) => r.name === "grid-secrets");
    const data = reveal<Record<string, unknown>>(secret?.inputs.stringData);
    expect(reveal(data.GRID_INBOUND_MAIL_SIGNING_KEYS)).toBe(SIGNING_KEYS);

    const script = RESOURCES.find((r) => r.type === "cloudflare:index/workersScript:WorkersScript");
    const bindings = reveal<Array<{ name: string; text: string }>>(script?.inputs.bindings);
    const text = (name: string) => bindings.find((b) => b.name === name)?.text;
    expect(text("SIGNING_KEY_ID")).toBe(SIGNING_KEY_ID);
    expect(text("SIGNING_KEY")).toBe(SIGNING_SECRET);
    expect((JSON.parse(SIGNING_KEYS) as Record<string, string>)[SIGNING_KEY_ID]).toBe(SIGNING_SECRET);
    expect(text("PAUSED")).toBe("true");
  });

  it("points the Worker at the origin the BFF checks @target-uri against", () => {
    // `configuredAppOrigin()` is the origin of WORKOS_REDIRECT_URI; a Worker
    // signing for another origin is refused `bad-signature`, every time.
    const redirect = containerEnv("frontend").find((e) => e.name === "WORKOS_REDIRECT_URI")?.value;
    const script = RESOURCES.find((r) => r.type === "cloudflare:index/workersScript:WorkersScript");
    const bindings = reveal<Array<{ name: string; text: string }>>(script?.inputs.bindings);
    expect(bindings.find((b) => b.name === "BFF_URL")?.text).toBe(new URL(String(redirect)).origin);
  });

  it("gives the bff-jobs pool the domain, but no key to verify with", () => {
    const names = containerEnv("bff-jobs").map((e) => e.name);
    expect(names).toContain("GRID_INBOUND_MAIL_DOMAIN");
    expect(names).not.toContain("GRID_INBOUND_MAIL_SIGNING_KEYS");
    expect(names).not.toContain("GRID_INBOUND_MAIL_PAUSED");
  });

  it("gives the web pods nothing of it", () => {
    const names = containerEnv("web").map((e) => e.name);
    expect(names.filter((n) => n.startsWith("GRID_INBOUND_MAIL"))).toEqual([]);
  });

  it("deploys the scanner the feature refuses to run without", () => {
    expect(containerEnv("frontend").map((e) => e.name)).toContain("GRID_MALWARE_SCAN_URL");
  });
});
