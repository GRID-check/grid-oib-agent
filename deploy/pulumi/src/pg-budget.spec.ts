import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig, langfuseStackConfig } from "./test-support/stack-config";

/**
 * The primary's connection budget (ADR-0083).
 *
 * PgBouncer keeps a server pool per (database, role), so what the pooler can
 * take from `max_connections` is `instances x pooled pairs x pool size`, and the
 * connections that bypass it by design are held back on top. The three knobs
 * behind that sum are set in different places (the pooler's two, the ingest
 * tier's size) and none looks wrong alone, so the program refuses a stack whose
 * sum passes the limit instead of finding out as "too many clients" on the first
 * tier to reconnect.
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

const pulumiDir = join(__dirname, "..");

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

/** A knob as a stack file sets it; undefined when the stack leaves it to the default. */
function stackKnob(stack: "dev" | "prod", key: string): string | undefined {
  const text = readFileSync(join(pulumiDir, `Pulumi.${stack}.yaml`), "utf8");
  return text.match(new RegExp(`^\\s*grid-oib:${key}: "?([^"\\s]+)"?\\s*$`, "m"))?.[1];
}

/** The reserve part with this name, so a test reads the number it is about. */
function part(budget: { reserve: Array<{ name: string; connections: number }> }, name: RegExp): number {
  const found = budget.reserve.find((p) => name.test(p.name));
  if (!found) throw new Error(`no reserve part matching ${name}`);
  return found.connections;
}

describe("pgConnectionBudget", () => {
  it("is the pooler's worst case plus the direct reserve", async () => {
    const { cfg, pgConnectionBudget } = await load({
      "grid-oib:pgPoolerInstances": "2",
      "grid-oib:pgPoolerPoolSize": "16",
      "grid-oib:ingestWorkerMaxReplicas": "5",
      "grid-oib:ingestWorkerConcurrency": "3",
    });

    const budget = pgConnectionBudget(cfg);

    // 2 poolers x (3 pooled pairs x 16 + 1 auth session)
    expect(budget.pooled).toBe(98);
    // One keyed_lock per ingest job in flight (5 x 3), plus the background ones.
    expect(part(budget, /advisory locks/)).toBe(15 + 4);
    expect(budget.total).toBe(budget.pooled + budget.reserveTotal);
    expect(budget.limit).toBe(200);
  });

  it("scales the pooled side with both knobs, one server pool per pair per instance", async () => {
    const one = await load({ "grid-oib:pgPoolerInstances": "1", "grid-oib:pgPoolerPoolSize": "10" });
    const three = await load({ "grid-oib:pgPoolerInstances": "3", "grid-oib:pgPoolerPoolSize": "10" });

    expect(one.pgConnectionBudget(one.cfg).pooled).toBe(1 * (3 * 10 + 1));
    expect(three.pgConnectionBudget(three.cfg).pooled).toBe(3 * (3 * 10 + 1));
  });

  it("does not grow with the api tier: its pods spread the SSE streams, they add none", async () => {
    const small = await load({ "grid-oib:apiMinReplicas": "2", "grid-oib:apiMaxReplicas": "4" });
    const large = await load({ "grid-oib:apiMinReplicas": "6", "grid-oib:apiMaxReplicas": "20" });

    expect(large.pgConnectionBudget(large.cfg)).toEqual(small.pgConnectionBudget(small.cfg));
  });

  it("counts what is deployed and nothing that is not", async () => {
    const full = await load({ "grid-oib:langfuseEnabled": "false", "grid-oib:seaweedfsTopology": "single" });
    const withFiler = await load({
      "grid-oib:langfuseEnabled": "false",
      "grid-oib:seaweedfsTopology": "split",
      "grid-oib:seaweedfsFilerStore": "postgres",
      "grid-oib:seaweedfsFilerReplicas": "2",
    });

    expect(part(full.pgConnectionBudget(full.cfg), /Langfuse/)).toBe(0);
    expect(part(full.pgConnectionBudget(full.cfg), /filer/)).toBe(0);
    expect(part(withFiler.pgConnectionBudget(withFiler.cfg), /filer/)).toBe(2 * 40);
    expect(part(full.pgConnectionBudget(full.cfg), /KEDA/)).toBe(8);
  });
});

describe("assertPgConnectionBudget", () => {
  it.each(["dev", "prod"] as const)("passes the %s stack as its file sets it", async (stack) => {
    const knobs = Object.fromEntries(
      [
        "pgPoolerInstances",
        "pgPoolerPoolSize",
        "ingestWorkerMaxReplicas",
        "ingestWorkerConcurrency",
        "seaweedfsTopology",
        "seaweedfsFilerStore",
      ]
        .map((key) => [key, stackKnob(stack, key)])
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [`grid-oib:${key}`, value as string]),
    );
    const { cfg, assertPgConnectionBudget, pgConnectionBudget } = await load(knobs);

    expect(() => assertPgConnectionBudget(cfg)).not.toThrow();
    expect(pgConnectionBudget(cfg).total).toBeLessThanOrEqual(200);
  });

  it("passes the defaults, for a stack that sets none of the knobs", async () => {
    const { cfg, assertPgConnectionBudget } = await load();

    expect(() => assertPgConnectionBudget(cfg)).not.toThrow();
  });

  it("holds production at 156 of 200: Langfuse and KEDA on, the ingest tier at its ceiling, the single topology", async () => {
    // The arithmetic Pulumi.prod.yaml's comment and the pgPoolerPoolSize doc
    // state. A change here is a change to those numbers, on purpose.
    const { cfg, pgConnectionBudget } = await load({
      ...langfuseStackConfig(),
      "grid-oib:observabilityEnabled": "true",
      "grid-oib:seaweedfsTopology": "single",
      "grid-oib:pgInstances": "3",
      "grid-oib:pgPoolerInstances": "2",
    });
    const budget = pgConnectionBudget(cfg);

    expect(cfg.langfuse.enabled).toBe(true);
    // 2 x (3 x 12 + 1)
    expect(budget.pooled).toBe(74);
    // 3 superuser + 6 CNPG + 20 LISTEN + (5 x 3 + 4) locks + 6 Jobs + 8 KEDA + 20 Langfuse
    expect(budget.reserveTotal).toBe(82);
    expect(budget.total).toBe(156);
  });

  it("passes a fresh stack with everything on, which is the defaults' worst case", async () => {
    // Split topology with the Postgres filer store is the default for a new
    // stack, and Langfuse is default-on: every reserve part at once. It must fit,
    // or the first `pulumi up` on a new stack is a refusal nobody chose.
    const { cfg, assertPgConnectionBudget, pgConnectionBudget } = await load({
      ...langfuseStackConfig(),
      "grid-oib:observabilityEnabled": "true",
    });

    expect(cfg.seaweedfs.topology).toBe("split");
    expect(cfg.seaweedfs.filerStore).toBe("postgres");
    expect(() => assertPgConnectionBudget(cfg)).not.toThrow();
    expect(pgConnectionBudget(cfg).total).toBe(196);
  });

  it("fails a pooler sized past the limit, naming every number and what to change", async () => {
    const { cfg, assertPgConnectionBudget } = await load({ "grid-oib:pgPoolerPoolSize": "40" });

    // 2 x (3 x 40 + 1) = 242 pooled, before the reserve.
    expect(() => assertPgConnectionBudget(cfg)).toThrow(/more than max_connections \(200\)/);
    expect(() => assertPgConnectionBudget(cfg)).toThrow(
      /can hold 242 \(pgPoolerInstances 2 x \(3 pooled database\/role pairs x pgPoolerPoolSize 40 \+ 1 auth session\)\)/,
    );
    expect(() => assertPgConnectionBudget(cfg)).toThrow(/CloudNativePG \(instance manager, exporter, backup\) 6/);
    expect(() => assertPgConnectionBudget(cfg)).toThrow(/Lower pgPoolerPoolSize or pgPoolerInstances/);
  });

  it("fails an ingest tier that grows the session locks past what is left", async () => {
    const { cfg, assertPgConnectionBudget } = await load({
      "grid-oib:pgPoolerPoolSize": "20",
      "grid-oib:ingestWorkerMaxReplicas": "20",
      "grid-oib:ingestWorkerConcurrency": "4",
    });

    expect(() => assertPgConnectionBudget(cfg)).toThrow(/session advisory locks \(ingest jobs in flight \+ background\) 84/);
  });

  it("is allowed to total the limit exactly, not a connection more", async () => {
    const { cfg, assertPgConnectionBudget, pgConnectionBudget } = await load({ "grid-oib:pgPoolerInstances": "1" });
    const withPoolSize = (poolSize: number) => ({
      ...cfg,
      postgres: { ...cfg.postgres, pooler: { ...cfg.postgres.pooler, poolSize } },
    });
    // The largest pool that still fits: each step of it costs three connections.
    let fits = 1;
    while (pgConnectionBudget(withPoolSize(fits + 1)).total <= 200) fits += 1;

    expect(() => assertPgConnectionBudget(withPoolSize(fits))).not.toThrow();
    expect(pgConnectionBudget(withPoolSize(fits)).total).toBeLessThanOrEqual(200);
    expect(pgConnectionBudget(withPoolSize(fits + 1)).total).toBeGreaterThan(200);
    expect(() => assertPgConnectionBudget(withPoolSize(fits + 1))).toThrow(/more than max_connections/);
  });
});

describe("the pooler knobs", () => {
  it.each([
    ["pgPoolerInstances", "0"],
    ["pgPoolerInstances", "1.5"],
    ["pgPoolerPoolSize", "0"],
    ["pgPoolerPoolSize", "-4"],
  ])("refuse %s = %s: a pool of nothing is a stack that cannot reach its database", async (key, value) => {
    await expect(load({ [`grid-oib:${key}`]: value })).rejects.toThrow(
      new RegExp(`grid-oib:${key} must be a whole number of at least 1`),
    );
  });

  it("default to two poolers of twelve, on a PgBouncer new enough for prepared statements", async () => {
    const { cfg } = await load();

    expect(cfg.postgres.pooler.instances).toBe(2);
    expect(cfg.postgres.pooler.poolSize).toBe(12);
    const version = cfg.postgres.pooler.image.match(/^ghcr\.io\/cloudnative-pg\/pgbouncer:(\d+)\.(\d+)\.\d+@sha256:[a-f0-9]{64}$/);
    expect(version, "the image is a tag AND a digest").not.toBeNull();
    const [major, minor] = [Number(version![1]), Number(version![2])];
    // max_prepared_statements, which psycopg3 and asyncpg need in transaction
    // mode, arrived in PgBouncer 1.21.
    expect(major > 1 || (major === 1 && minor >= 21)).toBe(true);
  });
});
