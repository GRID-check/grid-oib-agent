import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { load } from "js-yaml";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * Gotenberg, the office → PDF converter (ADR-0070).
 *
 * Every mistake worth catching here plans clean and runs green:
 *   - A flag the pinned 8.x image does not know stops Gotenberg at boot, and
 *     the frontend fails open, so the only symptom is that office previews
 *     quietly never appear.
 *   - A converter that keeps egress, or that any pod may call, works
 *     perfectly — while an office file's linked image fetches whatever URL it
 *     names from inside the cluster.
 *   - Compose and Pulumi disagreeing on the image or the flags is found in
 *     production (deploy/AGENTS.md).
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, any> }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return {
        id: `${args.name}-id`,
        state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
      };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

function find(type: string, name: string) {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) throw new Error(`no ${type} named "${name}"`);
  return hit;
}

function resolve<T>(value: pulumi.Input<T>): Promise<T> {
  return new Promise((done) => pulumi.output(value).apply((v) => done(v as T)));
}

const NETPOL = "kubernetes:networking.k8s.io/v1:NetworkPolicy";

type ComposeService = { image: string; command: string[]; ports?: unknown };
function composeService(file: string): ComposeService {
  const path = join(__dirname, "..", "..", "..", "compose", file);
  const doc = load(readFileSync(path, "utf8")) as { services: Record<string, ComposeService> };
  return doc.services.gotenberg;
}

describe("gotenberg", () => {
  let env: k8s.types.input.core.v1.EnvVar[] = [];
  let envDisabled: k8s.types.input.core.v1.EnvVar[] = [];
  let cfgImage = "";

  beforeAll(async () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:observabilityEnabled": "false" });
    const { loadConfig } = await import("../config");
    const { installGotenberg } = await import("./gotenberg");
    const { installNetworkPolicies } = await import("../platform/network-policies");
    const { frontendEnv } = await import("./config");
    const cfg = loadConfig();
    cfgImage = cfg.gotenberg.image;
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const g = installGotenberg(cfg, provider, "grid", []);
    installNetworkPolicies(cfg, provider, "grid");
    const wiring = {
      cfg,
      namespace: "grid",
      provider,
      redisUrl: pulumi.output("redis://dragonfly:6379"),
      seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
      seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
      dsn: () => pulumi.output("postgresql://x"),
      imagePullSecrets: [],
    };
    env = frontendEnv({ ...wiring, gotenbergUrl: g.url });
    envDisabled = frontendEnv(wiring);
    await new Promise((done) => g.service.id.apply(done));
  });

  it("defaults on, pinned to a concrete 8.x LibreOffice-only tag", () => {
    // A floating tag would let a new release change flag semantics under a
    // deploy that changed nothing. The `-libreoffice` variant ships no
    // Chromium, so the HTML/URL → PDF routes do not exist at all.
    expect(cfgImage).toMatch(/^gotenberg\/gotenberg:8\.\d+\.\d+-libreoffice$/);
  });

  it("runs only the LibreOffice route, with every URL-fetching feature off", async () => {
    const spec = await resolve(find("kubernetes:apps/v1:Deployment", "gotenberg").inputs.spec);
    const pod = spec.template.spec;
    const c = pod.containers[0];

    expect(c.image).toBe(cfgImage);
    expect(c.args).toEqual(
      expect.arrayContaining([
        "--api-timeout=120s",
        "--api-disable-download-from",
        "--webhook-disable",
      ]),
    );
    // That binary rejects Chromium flags at boot; one slipping back in would
    // take the converter down with a green plan.
    expect(c.args.some((a: string) => a.startsWith("--chromium"))).toBe(false);
    // The image's ENTRYPOINT is tini; a `command` would replace it.
    expect(c).not.toHaveProperty("command");
    expect(c.readinessProbe.httpGet).toEqual({ path: "/health", port: 3000 });
    expect(c.livenessProbe.httpGet).toEqual({ path: "/health", port: 3000 });
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1001 });
  });

  it("hands the frontend the Service's address", async () => {
    const svc = await resolve(find("kubernetes:core/v1:Service", "gotenberg").inputs.spec);
    expect(svc.ports[0].port).toBe(3000);

    const url = env.find((e) => e.name === "GOTENBERG_URL");
    expect(await resolve(url?.value)).toBe("http://gotenberg:3000");
    // Disabled means absent, which the BFF reads as "download only".
    expect(envDisabled.some((e) => e.name === "GOTENBERG_URL")).toBe(false);
  });

  it("admits the frontend alone and denies every egress", async () => {
    const pol = await resolve(find(NETPOL, "gotenberg-frontend-only").inputs.spec);
    expect(pol.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(pol.egress).toEqual([]);
    expect(pol.ingress).toEqual([
      {
        from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "frontend" } } }],
        ports: [{ protocol: "TCP", port: 3000 }],
      },
    ]);

    // Allows are additive: left in the wholesale intra-namespace allow, any pod
    // could still call it and the rule above would narrow nothing.
    const intra = await resolve(find(NETPOL, "allow-same-namespace").inputs.spec);
    expect(intra.podSelector.matchExpressions[0].values).toContain("gotenberg");
  });

  it("matches the Compose services, image and flags", async () => {
    const { GOTENBERG } = await import("../constants");
    for (const file of ["docker-compose.yaml", "docker-compose.coolify.yaml"]) {
      const svc = composeService(file);
      expect(svc.image, file).toBe(cfgImage);
      expect(svc.command, file).toEqual([...GOTENBERG.args]);
      // Internal only: a published port would put an unauthenticated
      // converter on the host.
      expect(svc.ports, file).toBeUndefined();
    }
  });
});
