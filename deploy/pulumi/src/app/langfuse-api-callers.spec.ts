import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig, langfuseStackConfig } from "../test-support/stack-config";

/**
 * Who may call Langfuse's public API (ADR-0044), and for what. The purger
 * erases an erased chat's traces and those of a folder purge's removed answers,
 * and the scheduler erases the ones past retention: deletion is theirs alone.
 * The frontend writes every answer vote as a score (Amendment 3) and deletes
 * nothing. The bff-jobs pool, built from the frontend's environment, holds no
 * keys at all.
 *
 * Two layers say so and must agree. The network policy admits exactly those
 * three pods into Langfuse web (`platform/network-policies.ts`, rules 11b and
 * 11c), and only their environments carry the API's host and keys. Trace
 * deletion run from anywhere but the two workers fails silently or by
 * accident, which is how the Papierkorb's „Endgültig löschen" once "erased"
 * traces from the BFF while it held no keys: the client answered "not
 * configured", the count read 0 and the traces stayed. So the deletion client
 * stays out of the BFF's code, and the folder purge hands its traces to the
 * purger instead.
 */

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({ id: `${args.name}-id`, state: args.inputs }),
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

const repoRoot = join(__dirname, "..", "..", "..", "..");
const LANGFUSE_API = /^LANGFUSE_(HOST|PUBLIC_KEY|SECRET_KEY)$/;

type EnvVar = k8s.types.input.core.v1.EnvVar;
const apiNames = (env: EnvVar[]) => env.map((e) => String(e.name)).filter((name) => LANGFUSE_API.test(name));

describe("Langfuse's API credentials, with the tier deployed", () => {
  const envs: Record<string, EnvVar[]> = {};

  beforeAll(async () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...langfuseStackConfig() });
    const { loadConfig } = await import("../config");
    const { bffJobsEnv, frontendEnv, purgerEnv, schedulerEnv } = await import("./config");
    const cfg = loadConfig();
    expect(cfg.langfuse.enabled).toBe(true);
    const wiring = {
      cfg,
      namespace: "grid",
      provider: new k8s.Provider("test", { kubeconfig: "apiVersion: v1" }),
      redisUrl: pulumi.output("redis://dragonfly:6379"),
      seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
      seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
      chromaUrl: pulumi.output("http://chroma:8000"),
      dsn: () => pulumi.output("postgresql://x"),
      imagePullSecrets: [],
    };
    envs.frontend = frontendEnv(wiring as never);
    envs.bffJobs = bffJobsEnv(wiring as never);
    envs.purger = purgerEnv(wiring as never);
    envs.scheduler = schedulerEnv(wiring as never);
  });

  it("are in the frontend's, which scores votes, and not in the bff-jobs pool's built from it", () => {
    expect(apiNames(envs.frontend).sort()).toEqual(["LANGFUSE_HOST", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]);
    expect(apiNames(envs.bffJobs)).toEqual([]);
  });

  it("are in the purger's and the scheduler's, the two pods the network policy admits", () => {
    // Not vacuous: the pattern finds all three names where they belong.
    expect(apiNames(envs.purger).sort()).toEqual(["LANGFUSE_HOST", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]);
    expect(apiNames(envs.scheduler).sort()).toEqual(["LANGFUSE_HOST", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]);
    const policies = readFileSync(join(repoRoot, "deploy", "pulumi", "src", "platform", "network-policies.ts"), "utf8");
    expect(policies).toContain('from: ["purger", "skill-scheduler"].map(');
  });

  it("are not reached for by the BFF's own code", () => {
    // The trace client lives in `workers/` for the purger and the scheduler. A
    // BFF module that imports it erases nothing, and says it did.
    const src = join(repoRoot, "frontends", "ui", "src");
    const importers = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.spec\.tsx?$/.test(file))
      .filter((file) => readFileSync(join(src, file), "utf8").includes("workers/langfuse-traces"));
    expect(importers).toEqual([]);
  });
});
