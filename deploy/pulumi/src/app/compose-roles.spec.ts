import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

// src/app -> src -> deploy/pulumi -> deploy -> repo root
const repoRoot = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

type Service = { environment?: string[] | Record<string, unknown>; depends_on?: Record<string, unknown> | string[] };
type Compose = { services: Record<string, Service> };

const COMPOSE_FILES = ["docker-compose.yaml", "docker-compose.coolify.yaml"];
const compose = (file: string) => load(read("deploy", "compose", file)) as Compose;

/** A service's environment as a map, whether the file wrote it as a list or as a map. */
function env(service: Service): Record<string, string> {
  const raw = service.environment ?? {};
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map((item) => item.split(/=(.*)/s).slice(0, 2) as [string, string]));
  }
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
}

const roleOf = (file: string, name: string) => env(compose(file).services[name]).GRID_ROLE;

/**
 * The Compose files and the Pulumi program deploy the same four processes of one
 * image (ADR-0082), and `deploy/AGENTS.md` makes keeping them equal the author's
 * job. Nothing else does: a Compose file that still points the frontend at the chat
 * service for HTTP, or has no tier to claim ingestion, runs clean until a reader
 * uploads a file. Both are read here as source, like the Python they configure.
 */
describe.each(COMPOSE_FILES)("%s", (file) => {
  it("runs one service per role of the image, each under its own GRID_ROLE", () => {
    expect(roleOf(file, "aiq-agent")).toBe("chat");
    expect(roleOf(file, "aiq-api")).toBe("api");
    expect(roleOf(file, "agent-worker")).toBe("worker");
    expect(roleOf(file, "ingest-worker")).toBe("ingest-worker");
  });

  it("names exactly the roles the entrypoint accepts", () => {
    const roles = Object.values(compose(file).services)
      .map((service) => env(service).GRID_ROLE)
      .filter((role): role is string => role !== undefined);
    const accepted = read("deploy", "entrypoint.py").match(/^ROLES = \((.*)\)$/m)?.[1];

    expect(accepted).toBeDefined();
    expect(new Set(roles)).toEqual(new Set([...accepted!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1])));
  });

  it("gives the frontend the api service for HTTP and the chat service for the socket", () => {
    const frontend = env(compose(file).services.frontend);

    expect(frontend.BACKEND_URL).toContain("http://aiq-api:8000");
    expect(frontend.BACKEND_CHAT_URL).toContain("http://aiq-agent:8000");
  });

  it("points every other HTTP consumer of the backend at the api service", () => {
    const consumers = Object.entries(compose(file).services)
      .filter(([name]) => name !== "frontend")
      .map(([name, service]) => [name, env(service).BACKEND_URL] as const)
      .filter(([, url]) => url !== undefined);

    expect(consumers.map(([name]) => name)).toEqual(expect.arrayContaining(["housekeeping", "purger"]));
    for (const [name, url] of consumers) expect(url, name).toContain("http://aiq-api:8000");
  });

  it("starts the services that call the api role only after it is up", () => {
    const services = compose(file).services;
    for (const name of ["frontend", "housekeeping", "purger"]) {
      const dependsOn = services[name].depends_on ?? {};
      expect(Object.keys(dependsOn), name).toContain("aiq-api");
    }
  });

  it("holds the shared Chroma ahead of every backend role, and the research queue on the database", () => {
    const services = compose(file).services;
    for (const name of ["aiq-agent", "aiq-api", "agent-worker", "ingest-worker"]) {
      expect(Object.keys(services[name].depends_on ?? {}), name).toContain("chroma");
    }
    expect(env(services["aiq-agent"]).GRID_JOB_EXECUTION).toBe("db");
  });
});

/** The removed names must not come back through a file nobody greps. */
describe("the retired role and claim switch", () => {
  const files = [
    ...COMPOSE_FILES.map((f) => join("deploy", "compose", f)),
    join("deploy", "entrypoint.py"),
    join("deploy", "pulumi", "src", "app", "config.ts"),
    join("deploy", "pulumi", "src", "app", "api.ts"),
    join("deploy", "pulumi", "src", "app", "backend.ts"),
  ];

  it.each(files)("%s has no GRID_ROLE=web and no GRID_INGEST_QUEUE_CLAIM", (file) => {
    const source = read(file);

    expect(source).not.toMatch(/GRID_ROLE[=:"' ]+web\b/);
    expect(source).not.toContain("GRID_INGEST_QUEUE_CLAIM");
  });

  it("is no longer read anywhere under the Python image sources", () => {
    const python = readdirSync(join(repoRoot, "frontends", "aiq_api", "src", "aiq_api"), { recursive: true })
      .filter((f): f is string => typeof f === "string" && f.endsWith(".py"))
      .map((f) => read("frontends", "aiq_api", "src", "aiq_api", f))
      .join("\n");

    expect(python).not.toContain("GRID_INGEST_QUEUE_CLAIM");
  });
});
