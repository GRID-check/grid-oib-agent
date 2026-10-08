import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// src/app -> src -> deploy/pulumi -> deploy -> repo root
const repoRoot = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

const jobsRoutes = read("frontends", "aiq_api", "src", "aiq_api", "routes", "jobs.py");
const workers = read("deploy", "pulumi", "src", "app", "workers.ts");
const composeClock = read("frontends", "ui", "workers", "housekeeping-clock.js");
const appConfig = read("deploy", "pulumi", "src", "app", "config.ts");

const names = (source: string, pattern: RegExp): string[] => [...source.matchAll(pattern)].map((m) => m[1]).sort();

/**
 * The backend's housekeeping crosses a process boundary this program cannot see
 * into (ADR-0082 step A1): the CronJobs call routes the Python app registers,
 * and nothing else runs that work. A route renamed on one side, or a new route
 * given no CronJob, plans and applies clean and the work simply stops happening.
 */
describe("the backend housekeeping CronJobs", () => {
  it("schedule exactly the housekeeping routes the backend registers", () => {
    const registered = names(jobsRoutes, /"\/v1\/maintenance\/housekeeping\/([a-z-]+)"/g);
    const scheduled = names(workers, /route: "([a-z-]+)"/g);
    expect(registered.length).toBe(4);
    expect(scheduled).toEqual(registered);
  });

  it("call the api role, which is the one that registers the routes", () => {
    // The routes are `add_*` on the api role's router (ADR-0082 step B); the
    // chat tier does not mount them, so a CronJob aimed at it gets a 404.
    expect(workers).toContain("`${BACKEND_URL}/v1/maintenance/housekeeping/${route}`");
    expect(appConfig).toContain("export const BACKEND_URL = `http://aiq-api:${PORT.backend}`;");
  });

  it("are matched by the Compose clock, which calls the same routes where there are no CronJobs", () => {
    const registered = names(jobsRoutes, /"\/v1\/maintenance\/housekeeping\/([a-z-]+)"/g);
    const clocked = names(composeClock, /route: '([a-z-]+)'/g);
    expect(clocked).toEqual(registered);
  });
});
