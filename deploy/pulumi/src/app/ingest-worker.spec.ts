import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QUEUE_DEPTH_QUERY } from "./ingest-worker";

// src/app -> src -> deploy/pulumi -> deploy -> repo root
const repoRoot = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

const pythonSources = [
  read("frontends", "aiq_api", "src", "aiq_api", "jobs", "ingest_dispatch.py"),
  read("frontends", "aiq_api", "src", "aiq_api", "jobs", "ingest_worker.py"),
  // The per-organisation cap is read where the in-process pool and the queue share it.
  read("src", "aiq_agent", "knowledge", "ingest_scheduler.py"),
].join("\n");
const configSource = read("deploy", "pulumi", "src", "app", "config.ts");

const names = (source: string, pattern: RegExp): Set<string> =>
  new Set([...source.matchAll(pattern)].map((m) => m[1]));

/**
 * The ingest tier crosses two process boundaries this program cannot see into:
 * the Python worker reads its env, and KEDA queries the Python queue's table.
 * A name that drifts on one side plans and applies clean, and the tier then
 * either never scales or claims nothing. Both sides are read here as source.
 */
describe("the ingest-worker tier", () => {
  it("emits only GRID_INGEST_ names the worker reads", () => {
    const readByPython = names(pythonSources, /"(GRID_INGEST_[A-Z_]+)"/g);
    const emitted = names(configSource, /name: "(GRID_INGEST_[A-Z_]+)"/g);
    expect(emitted.size).toBeGreaterThan(2);
    expect([...emitted].filter((n) => !readByPython.has(n))).toEqual([]);
  });

  it("scales on the table the queue actually writes", () => {
    const table = read("src", "aiq_agent", "knowledge", "ingest_queue.py").match(/^TABLE = "([a-z_]+)"$/m)?.[1];
    expect(table).toBeDefined();
    const dead = read("src", "aiq_agent", "common", "claim_queue.py").match(/^DEAD = "([a-z_]+)"$/m)?.[1];
    expect(dead).toBeDefined();
    // Dead rows stay in the table as a trace; they must not keep replicas up.
    expect(QUEUE_DEPTH_QUERY).toBe(`SELECT COUNT(*) FROM ${table} WHERE status <> '${dead}'`);
  });

  it("gives KEDA a DSN it can resolve from its own namespace", () => {
    // The operator runs in `keda`; a bare `grid-pg-rw` resolves there to
    // nothing, the scaler errors on every poll, and the tier never scales out.
    // The TriggerAuthentication is shared with the research tier (one database).
    const key = read("deploy", "pulumi", "src", "app", "jobs-queue-auth.ts").match(
      /JOBS_QUEUE_DSN_KEY = "([A-Z_]+)"/,
    )?.[1];
    expect(key).toBeDefined();
    expect(configSource).toMatch(new RegExp(`${key}: w\\.dsn\\(\\{[^}]*clusterWide: true`));
    expect(read("deploy", "pulumi", "src", "app", "ingest-worker.ts")).toContain("JOBS_QUEUE_AUTH");
  });

  it("runs the role the entrypoint knows", () => {
    expect(read("deploy", "entrypoint.py")).toContain('role == "ingest-worker"');
    expect(configSource).toContain('{ name: "GRID_ROLE", value: "ingest-worker" }');
  });
});
