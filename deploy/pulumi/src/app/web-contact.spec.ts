import { describe, it, expect } from "vitest";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";
import { contactStackConfig } from "../test-support/contact-config";

/**
 * The contact form's wiring on the web tier (`app/web.ts`).
 *
 * The five names are the contract with `frontends/web/src/lib/contact.ts`,
 * which reads them from `process.env` and answers 503 when one is missing. A
 * misspelt name plans and applies clean and turns the form off, so the names
 * are pinned here, and the two credentials must never be inline values.
 */

type EnvVar = {
  name: string;
  value?: unknown;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
};
type Recorded = { type: string; name: string; inputs: Record<string, unknown> };
const RESOURCES: Recorded[] = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

const SECRET_SIG = "4dabf18193072939515e22adb298388d"; // pragma: allowlist secret (Pulumi secret-marker constant, not a credential)
function reveal<T>(value: unknown): T {
  const secret =
    typeof value === "object" && value !== null && SECRET_SIG in value && "value" in value;
  return (secret ? (value as { value: unknown }).value : value) as T;
}

const CONTACT_NAMES = [
  "CONTACT_FROM",
  "CONTACT_FORWARD_TO",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_EMAIL_TOKEN",
  "CONTACT_FORM_SECRET",
];

async function installWith(values: Record<string, string>, accountId?: string) {
  RESOURCES.length = 0;
  pulumi.runtime.setAllConfig({
    ...baseStackConfig(),
    "grid-oib:observabilityEnabled": "false",
    ...values,
  });
  const { loadConfig } = await import("../config");
  const { installWeb } = await import("./web");
  const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
  const web = installWeb(
    loadConfig(),
    provider,
    "grid",
    [],
    [],
    accountId === undefined ? undefined : pulumi.output(accountId),
  );
  await new Promise((resolve) => web.deployment.id.apply(resolve));
  const deployment = RESOURCES.find(
    (r) => r.type === "kubernetes:apps/v1:Deployment" && r.name === "web",
  );
  const template = (
    deployment?.inputs.spec as {
      template: {
        metadata: { annotations?: Record<string, string> };
        spec: { containers: Array<{ env: EnvVar[] }> };
      };
    }
  ).template;
  const secret = RESOURCES.find(
    (r) => r.type === "kubernetes:core/v1:Secret" && r.name === "web-contact",
  );
  return {
    env: template.spec.containers[0].env,
    annotations: template.metadata.annotations,
    secret,
  };
}

describe("the web tier without the contact address", () => {
  it("gets none of the contact env and no Secret", async () => {
    const { env, annotations, secret } = await installWith({});
    for (const name of CONTACT_NAMES) expect(env.map((e) => e.name)).not.toContain(name);
    expect(secret).toBeUndefined();
    expect(annotations).toBeUndefined();
  });
});

describe("the web tier with the contact address", () => {
  it("sends from the contact address to the forward targets, through the zone's account", async () => {
    const { env } = await installWith(contactStackConfig(), "account-1");
    const byName = new Map(env.map((e) => [e.name, e]));
    expect(byName.get("CONTACT_FROM")?.value).toBe("kontakt@example.test");
    expect(byName.get("CONTACT_FORWARD_TO")?.value).toBe(
      "mail@founder-one.example,mail@founder-two.example",
    );
    expect(byName.get("CLOUDFLARE_ACCOUNT_ID")?.value).toBe("account-1");
  });

  it("takes the token and the form key from the web tier's own Secret, never inline", async () => {
    const { env } = await installWith(contactStackConfig(), "account-1");
    for (const name of ["CLOUDFLARE_EMAIL_TOKEN", "CONTACT_FORM_SECRET"]) {
      const entry = env.find((e) => e.name === name);
      expect(entry?.value, name).toBeUndefined();
      // `web-contact`, not `grid-secrets`: the landing site holds no app
      // credential, and gets only these two.
      expect(entry?.valueFrom?.secretKeyRef).toEqual({ name: "web-contact", key: name });
    }
  });

  it("puts exactly those two values in that Secret, as secrets", async () => {
    const { secret } = await installWith(contactStackConfig(), "account-1");
    const data = reveal<Record<string, unknown>>(secret?.inputs.stringData);
    expect(Object.keys(data).sort()).toEqual(["CLOUDFLARE_EMAIL_TOKEN", "CONTACT_FORM_SECRET"]);
    expect(reveal(data.CLOUDFLARE_EMAIL_TOKEN)).toBe("cf-email-sending-token"); // pragma: allowlist secret
    expect(reveal(data.CONTACT_FORM_SECRET)).toBe("form-hmac-key"); // pragma: allowlist secret
    // Not the stack's DNS token, which may edit the whole zone.
    expect(JSON.stringify(data)).not.toContain("cf-token");
  });

  it("stamps the Secret's checksum on the pod template, so a rotation rolls the pods", async () => {
    const first = await installWith(contactStackConfig(), "account-1");
    const rotated = await installWith(
      { ...contactStackConfig(), "grid-oib:contactEmailToken": "rotated-token" }, // pragma: allowlist secret
      "account-1",
    );
    const key = Object.keys(first.annotations ?? {})[0];
    expect(key).toBeDefined();
    expect(first.annotations?.[key]).toMatch(/^[0-9a-f]{16}$/);
    expect(rotated.annotations?.[key]).not.toBe(first.annotations?.[key]);
  });
});
