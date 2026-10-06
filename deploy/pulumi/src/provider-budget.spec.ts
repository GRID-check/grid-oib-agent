import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./test-support/stack-config";

/**
 * The one OpenRouter key's budget (ADR-0076, ADR-0080), as the stack files state it.
 *
 * Vision calls are held to `AIQ_VLM_FLEET_CONCURRENCY` fleet-wide whatever the
 * replica count, so an ingest tier sized past that number only queues: replicas
 * that hold memory and wait for a slot, and a wait that can outlast the client's
 * own timeout. The two numbers are set in different places and neither looks
 * wrong alone, so the program refuses the combination.
 */

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
    }),
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

// src -> deploy/pulumi -> deploy -> repo root
const pulumiDir = join(__dirname, "..");
const repoRoot = join(__dirname, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

async function load(config: Record<string, string> = {}) {
  pulumi.runtime.setAllConfig({
    ...baseStackConfig(),
    "grid-oib:jobExecution": "db",
    "grid-oib:allowPlaintextJobPayloads": "true",
    "grid-oib:observabilityEnabled": "false",
    ...config,
  });
  return import("./config").then((m) => ({ ...m, cfg: m.loadConfig() }));
}

/** A knob as a stack file sets it, or the default the program falls back to. */
function stackKnob(stack: "dev" | "prod", key: string): string | undefined {
  const text = readFileSync(join(pulumiDir, `Pulumi.${stack}.yaml`), "utf8");
  return text.match(new RegExp(`^\\s*grid-oib:${key}: "?([^"\\s]+)"?\\s*$`, "m"))?.[1];
}

describe("the ingest tier's peak vision calls", () => {
  it("are replicas x concurrency x the files' own parallelism", async () => {
    const { vlmPeakCalls } = await load();

    expect(
      vlmPeakCalls({ ingestWorker: { maxReplicas: 8, concurrency: 3 }, providerLimits: { vlmBatchWorkers: 4 } } as never),
    ).toBe(96);
  });

  it.each(["dev", "prod"] as const)("fit the %s stack's fleet pool, which fails the deploy when they do not", async (stack) => {
    const knobs = Object.fromEntries(
      ["ingestWorkerMaxReplicas", "ingestWorkerConcurrency", "vlmFleetConcurrency", "vlmBatchWorkers", "providerLimitCeiling"]
        .map((key) => [key, stackKnob(stack, key)])
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [`grid-oib:${key}`, value as string]),
    );
    const { cfg, assertVlmPeakFitsCeiling, vlmPeakCalls, VLM_OVERSUBSCRIPTION } = await load(knobs);

    expect(() => assertVlmPeakFitsCeiling(cfg)).not.toThrow();
    expect(vlmPeakCalls(cfg)).toBeLessThanOrEqual(VLM_OVERSUBSCRIPTION * cfg.providerLimits.vlmFleetConcurrency);
  });

  it("hold the defaults too, for a stack that sets none of the knobs", async () => {
    const { cfg, assertVlmPeakFitsCeiling } = await load();

    expect(() => assertVlmPeakFitsCeiling(cfg)).not.toThrow();
  });

  it("fail a tier sized past twice the pool, naming every number and what to change", async () => {
    const { cfg, assertVlmPeakFitsCeiling } = await load({ "grid-oib:ingestWorkerMaxReplicas": "12" });

    expect(() => assertVlmPeakFitsCeiling(cfg)).toThrow(
      /ingestWorkerMaxReplicas \(12\) x ingestWorkerConcurrency \(3\) x vlmBatchWorkers \(4\) = 144 vision calls at the peak, more than 2x vlmFleetConcurrency \(48\) = 96/,
    );
    expect(() => assertVlmPeakFitsCeiling(cfg)).toThrow(/Lower ingestWorkerMaxReplicas to 8 or less, or raise vlmFleetConcurrency/);
  });

  it("are allowed twice the pool, no more", async () => {
    const at = await load({ "grid-oib:ingestWorkerMaxReplicas": "8" });
    const over = await load({ "grid-oib:ingestWorkerMaxReplicas": "9" });

    expect(() => at.assertVlmPeakFitsCeiling(at.cfg)).not.toThrow();
    expect(() => over.assertVlmPeakFitsCeiling(over.cfg)).toThrow(/= 108 vision calls/);
  });

  it("follow the pool when it is raised, and the files' parallelism when it is", async () => {
    const raised = await load({ "grid-oib:ingestWorkerMaxReplicas": "12", "grid-oib:vlmFleetConcurrency": "72" });
    const deeper = await load({ "grid-oib:vlmBatchWorkers": "8" });

    expect(() => raised.assertVlmPeakFitsCeiling(raised.cfg)).not.toThrow();
    expect(() => deeper.assertVlmPeakFitsCeiling(deeper.cfg)).toThrow(/vlmBatchWorkers \(8\) = 192/);
  });

  it("are not held to a pool that is switched off", async () => {
    const { cfg, assertVlmPeakFitsCeiling } = await load({
      "grid-oib:vlmFleetConcurrency": "0",
      "grid-oib:ingestWorkerMaxReplicas": "40",
    });

    expect(() => assertVlmPeakFitsCeiling(cfg)).not.toThrow();
  });

  it("refuse a fleet pool larger than the key-wide limit every call passes", async () => {
    const { cfg, assertVlmPeakFitsCeiling } = await load({
      "grid-oib:vlmFleetConcurrency": "200",
      "grid-oib:providerLimitCeiling": "128",
    });

    expect(() => assertVlmPeakFitsCeiling(cfg)).toThrow(/vlmFleetConcurrency \(200\) is above providerLimitCeiling \(128\)/);
  });

  it("is checked where the tier is built, so a plan that over-sizes it never reaches `pulumi up`", async () => {
    const { cfg } = await load({ "grid-oib:ingestWorkerMaxReplicas": "20" });
    const { installIngestWorker } = await import("./app/ingest-worker");
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const wiring = { cfg, namespace: "grid", provider, imagePullSecrets: [] };
    const secrets = { secret: new k8s.core.v1.Secret("s", {}, { provider }), checksum: pulumi.output("x") };

    expect(() => installIngestWorker(wiring as never, cfg, secrets, [])).toThrow(/Invalid ingest sizing/);
  });
});

describe("the budget reaches the pods that spend it", () => {
  it("is emitted from the stack's numbers, under the names the Python modules read", async () => {
    const { cfg } = await load({
      "grid-oib:vlmFleetConcurrency": "40",
      "grid-oib:vlmBatchWorkers": "5",
      "grid-oib:providerLimitCeiling": "100",
      "grid-oib:providerModelLimitCeiling": "20",
    });
    const { backendEnv, ingestWorkerEnv } = await import("./app/config");
    const wiring = {
      cfg,
      namespace: "grid",
      provider: new k8s.Provider("test-env", { kubeconfig: "apiVersion: v1" }),
      redisUrl: pulumi.output("redis://dragonfly:6379"),
      seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
      seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
      dsn: () => pulumi.output("postgresql://x"),
      imagePullSecrets: [],
    };
    const expected = {
      AIQ_VLM_FLEET_CONCURRENCY: "40",
      AIQ_VLM_BATCH_WORKERS: "5",
      GRID_PROVIDER_LIMIT_CEILING: "100",
      GRID_PROVIDER_MODEL_LIMIT_CEILING: "20",
    };

    for (const env of [backendEnv(wiring as never), ingestWorkerEnv(wiring as never, "/tmp/alive")]) {
      const literal = Object.fromEntries(env.map((e) => [e.name, e.value]));
      expect(literal).toMatchObject(expected);
    }

    const sources = [
      read("sources", "knowledge_layer", "src", "llamaindex", "adapter.py"),
      read("sources", "knowledge_layer", "src", "llamaindex", "processing.py"),
      read("src", "aiq_agent", "common", "provider_limiter.py"),
    ].join("\n");
    for (const name of Object.keys(expected)) expect(sources, name).toContain(`"${name}"`);
  });

  it("states the numbers the Python modules default to, so the stack file is where they are read", async () => {
    const { cfg } = await load();
    const python = (path: string[], pattern: RegExp) => Number(read(...path).match(pattern)?.[1]);

    expect(cfg.providerLimits.vlmFleetConcurrency).toBe(
      python(["sources", "knowledge_layer", "src", "llamaindex", "adapter.py"], /VLM_FLEET_CONCURRENCY = _env_int\("AIQ_VLM_FLEET_CONCURRENCY", (\d+)\)/),
    );
    expect(cfg.providerLimits.vlmBatchWorkers).toBe(
      python(["sources", "knowledge_layer", "src", "llamaindex", "processing.py"], /os\.environ\.get\("AIQ_VLM_BATCH_WORKERS", "(\d+)"\)/),
    );
    expect(cfg.providerLimits.limitCeiling).toBe(
      python(["src", "aiq_agent", "common", "provider_limiter.py"], /^_DEFAULT_CEILING = (\d+)$/m),
    );
    expect(cfg.providerLimits.modelLimitCeiling).toBe(
      python(["src", "aiq_agent", "common", "provider_limiter.py"], /^_DEFAULT_MODEL_CEILING = (\d+)$/m),
    );
  });
});
