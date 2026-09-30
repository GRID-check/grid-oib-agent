import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";
import { INBOUND_MAIL_MAX_BODY_BYTES } from "./src/platform/inbound-mail";

/**
 * The whole program with the project mail inbox turned on.
 *
 * A separate file for the reason `index-dns.spec.ts` gives: `index.ts` works at
 * module scope and Pulumi's runtime is process-global, so one process builds
 * one configuration.
 *
 * What only the whole program can show is that the two halves meet: the Worker
 * Cloudflare runs presents a token, and the frontend pod must hold the same one
 * under the name the BFF reads, next to the domain that switches the UI on. The
 * per-module specs each see one side.
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
    call: (args: pulumi.runtime.MockCallArgs) =>
      args.token === "cloudflare:index/getZone:getZone"
        ? { id: args.inputs.zoneId, name: DOMAIN, account: { id: "account-1", name: "Grid" } }
        : {},
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

describe("the program constructs with the project mail inbox on", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:seaweedfsTopology": "single",
      "grid-oib:seaweedfsPerOrgBuckets": "false",
      "grid-oib:observabilityEnabled": "false",
      "grid-oib:inboundMailDomain": DOMAIN,
      "grid-oib:inboundMailZoneId": "zone-mail-1",
      "grid-oib:inboundMailToken": "inbound-token", // pragma: allowlist secret
      "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  function frontendEnv(): EnvVar[] {
    const deployment = RESOURCES.find(
      (r) => r.type === "kubernetes:apps/v1:Deployment" && r.name === "frontend",
    );
    const spec = deployment?.inputs.spec as {
      template: { spec: { containers: Array<{ name: string; env: EnvVar[] }> } };
    };
    return spec.template.spec.containers[0].env;
  }

  it("creates the Worker, the routing and the catch-all", () => {
    const types = RESOURCES.map((r) => r.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "cloudflare:index/workersScript:WorkersScript",
        "cloudflare:index/emailRoutingDns:EmailRoutingDns",
        "cloudflare:index/emailRoutingCatchAll:EmailRoutingCatchAll",
      ]),
    );
  });

  it("gives the frontend the domain and the token, the token from the Secret", () => {
    const env = frontendEnv();
    expect(env.find((e) => e.name === "GRID_INBOUND_MAIL_DOMAIN")?.value).toBe(DOMAIN);
    const token = env.find((e) => e.name === "GRID_INBOUND_MAIL_TOKEN");
    // Never inline: anything with `get pod` could read it.
    expect(token?.value).toBeUndefined();
    expect(token?.valueFrom?.secretKeyRef?.key).toBe("GRID_INBOUND_MAIL_TOKEN");
  });

  it("puts the same token in grid-secrets that the Worker is bound with", () => {
    const secret = RESOURCES.find((r) => r.name === "grid-secrets");
    const data = reveal<Record<string, unknown>>(secret?.inputs.stringData);
    expect(reveal(data.GRID_INBOUND_MAIL_TOKEN)).toBe("inbound-token"); // pragma: allowlist secret

    const script = RESOURCES.find((r) => r.type === "cloudflare:index/workersScript:WorkersScript");
    const bindings = reveal<Array<{ name: string; text: string }>>(script?.inputs.bindings);
    expect(bindings.find((b) => b.name === "INBOUND_MAIL_TOKEN")?.text).toBe("inbound-token"); // pragma: allowlist secret
  });

  it("sets no connection buffer limit at the edge", () => {
    // Envoy streams request bodies, so today nothing at the edge caps a mail.
    // A `connection.bufferLimit` would start to bite the moment anything
    // buffers (a request-buffer policy, an ext-auth body), and a mail cut off
    // there is a 413 the Worker turns into a permanent bounce. Adding one
    // means clearing INBOUND_MAIL_MAX_BODY_BYTES (26 MiB) and updating this.
    const ctp = RESOURCES.find((r) => r.inputs.kind === "ClientTrafficPolicy");
    expect(ctp).toBeDefined();
    const spec = ctp?.inputs.spec as { connection?: { bufferLimit?: string } };
    expect(spec.connection?.bufferLimit).toBeUndefined();
    expect(INBOUND_MAIL_MAX_BODY_BYTES).toBe(26 * 1024 * 1024);
  });
});
