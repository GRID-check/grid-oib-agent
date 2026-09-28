import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * How the landing site starts (`app/web.ts` + `frontends/web/Dockerfile`).
 *
 * The entry file is the image's business. When this program also named one,
 * the two had to change in lockstep across a boundary no test crossed: a new
 * entry in the Deployment with an old image, or the reverse, is a
 * CrashLoopBackOff that plans clean.
 */

type Container = { name: string; command?: string[] };
let container: Container | undefined;

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      if (args.type === "kubernetes:apps/v1:Deployment" && args.name === "web") {
        container = args.inputs.spec.template.spec.containers[0];
      }
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

const webDir = join(__dirname, "..", "..", "..", "..", "frontends", "web");

describe("the web Deployment", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:observabilityEnabled": "false" });
    const { loadConfig } = await import("../config");
    const { installWeb } = await import("./web");
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const web = installWeb(loadConfig(), provider, "grid", [], []);
    await new Promise((resolve) => web.deployment.id.apply(resolve));
  });

  it("leaves the entry command to the image", () => {
    expect(container?.name).toBe("web");
    expect(container).not.toHaveProperty("command");
  });

  it("starts an image entry file that the image copies in", () => {
    const dockerfile = readFileSync(join(webDir, "Dockerfile"), "utf8");
    const cmd = dockerfile.match(/^CMD \["node", "([^"]+)"\]/m)?.[1];
    expect(cmd).toBe("runtime/server.mjs");
    expect(existsSync(join(webDir, cmd!))).toBe(true);
    // The runner stage copies dist/ and node_modules/ by name; a new top-level
    // directory the entry lives in has to be copied too.
    expect(dockerfile).toMatch(/^COPY --from=builder .* \/app\/runtime \.\/runtime$/m);
  });
});
