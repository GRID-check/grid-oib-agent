import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * The err2issue sink (ADR-0031).
 *
 * Every mistake here deploys a healthy pod. A moving image tag upgrades the
 * sink on its next restart, behaviour changes included, without a commit
 * saying so. A trace template err2issue rejects stops its /readyz, which at
 * least fails the rollout; a template it accepts but that points nowhere
 * files every issue with a dead link. Those are what this pins.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

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

function resolve(value: unknown): Promise<any> {
  return new Promise((done) =>
    (pulumi.output(value) as pulumi.Output<any>).apply((v: any) => {
      done(v);
      return v;
    }),
  );
}

describe("err2issue, enabled behind the observability tier", () => {
  let container: {
    image: string;
    imagePullPolicy: string;
    env: Array<{ name: string; value?: string; valueFrom?: unknown }>;
  };

  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:otelPrimaryApiKey": "otel-key", // pragma: allowlist secret
      "grid-oib:otelOidcIssuer": "https://grid.authkit.app",
      "grid-oib:otelOidcClientId": "client_otel",
      "grid-oib:otelOidcClientSecret": "otel-client-secret", // pragma: allowlist secret
      "grid-oib:err2issueEnabled": "true",
      "grid-oib:err2issueGithubRepo": "GRID-check/grid-oib-agent",
      "grid-oib:err2issueGithubToken": "gh-token", // pragma: allowlist secret
    });
    await import("../../index");
    await new Promise((r) => setTimeout(r, 200));
    const deployment = RESOURCES.find((r) => r.type === "kubernetes:apps/v1:Deployment" && r.name === "err2issue");
    if (!deployment) throw new Error("err2issue was not deployed");
    container = (await resolve(deployment.inputs.spec)).template.spec.containers[0];
  }, 120_000);

  function env(name: string): string | undefined {
    return container.env.find((e) => e.name === name)?.value;
  }

  it("runs a digest-pinned image, so an upgrade is a commit", () => {
    expect(container.image).toMatch(/^ghcr\.io\/matthiasbigl\/err2issue@sha256:[a-f0-9]{64}$/);
    expect(container.imagePullPolicy).toBe("IfNotPresent");
  });

  it("links trace ids to the Aspire dashboard's trace view", () => {
    expect(env("E2I_TRACE_URL_TEMPLATE")).toBe("https://otel.example.test/traces/detail/{trace_id}");
  });

  it("keeps issues closed as not planned closed, and leaves unset options to err2issue", () => {
    expect(env("E2I_REOPEN_NOT_PLANNED")).toBe("false");
    const names = container.env.map((e) => e.name);
    expect(names).not.toContain("E2I_ISSUE_ASSIGNEES");
    expect(names).not.toContain("E2I_ROUTE_MAP");
  });
});
