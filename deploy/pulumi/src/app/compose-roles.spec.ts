import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

// src/app -> src -> deploy/pulumi -> deploy -> repo root
const repoRoot = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

type Service = {
  environment?: string[] | Record<string, unknown>;
  depends_on?: Record<string, unknown> | string[];
  profiles?: string[];
  extends?: { service: string };
};
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
 * The environment a container actually gets: the YAML merge key
 * (`<<: *backend-environment`, which js-yaml leaves as a key) and `extends`
 * resolved, the service's own entries winning.
 */
function effectiveEnv(file: string, name: string): Record<string, string> {
  const service = compose(file).services[name];
  const base = service.extends ? effectiveEnv(file, service.extends.service) : {};
  const raw = service.environment;
  const anchor = raw && !Array.isArray(raw) ? raw["<<"] : undefined;
  const merged = typeof anchor === "object" && anchor !== null ? env({ environment: anchor as Record<string, unknown> }) : {};
  const own = Object.fromEntries(Object.entries(env(service)).filter(([key]) => key !== "<<"));
  return { ...base, ...merged, ...own };
}

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

  it("holds the shared Qdrant ahead of every backend role and points each at it", () => {
    const services = compose(file).services;
    for (const name of ["aiq-agent", "aiq-api", "agent-worker", "ingest-worker"]) {
      expect(Object.keys(services[name].depends_on ?? {}), name).toContain("qdrant");
      const vars = effectiveEnv(file, name);
      expect(vars.AIQ_QDRANT_URL, name).toContain("http://qdrant:6333");
      expect(vars.AIQ_QDRANT_API_KEY, name).toBeDefined();
    }
  });

  // ADR-0113: Qdrant is the only store, started by a plain `up`.
  it("runs Qdrant by default and no Chroma, nor anything that picks between the two", () => {
    const services = compose(file).services;
    expect(services.qdrant.profiles).toBeUndefined();
    expect(Object.keys(services).filter((name) => /chroma/i.test(name))).toEqual([]);
    for (const name of Object.keys(services)) {
      const retired = Object.keys(effectiveEnv(file, name)).filter(
        (k) => k.startsWith("AIQ_CHROMA") || k === "AIQ_VECTOR_BACKEND",
      );
      expect(retired, name).toEqual([]);
    }
  });

  it("gives Qdrant the Pulumi peers' keyless metrics port and write quotas", () => {
    const qdrant = env(compose(file).services.qdrant);
    expect(qdrant.QDRANT__SERVICE__METRICS_PORT).toBe("6336");
    expect(qdrant.QDRANT__STORAGE__QUOTAS__ENABLED).toBe("true");
    // The Pulumi defaults, overridable as QDRANT_QUOTA_*_PERCENT.
    expect(qdrant.QDRANT__STORAGE__QUOTAS__MAX_RESIDENT_MEMORY_PERCENT).toBe("${QDRANT_QUOTA_MEMORY_PERCENT:-90}");
    expect(qdrant.QDRANT__STORAGE__QUOTAS__MAX_DISK_USAGE_PERCENT).toBe("${QDRANT_QUOTA_DISK_PERCENT:-85}");
  });

  // A store loading large collections answers /readyz late. Without a grace
  // period its two minutes of retries run out, the container reads unhealthy,
  // and every backend role that waits on `service_healthy` never starts.
  it("gives Qdrant five minutes to load before its health check counts", () => {
    const check = (compose(file).services.qdrant as { healthcheck?: { start_period?: string } }).healthcheck;
    expect(check?.start_period).toBe("300s");
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

/** Research runs on the database queue alone: no execution switch, scheduler address or worker-pool knob survives. */
describe("the research queue is the only execution path", () => {
  const retired = /GRID_JOB_EXECUTION|NAT_DASK_SCHEDULER_ADDRESS|NAT_USE_DASK_THREADS|DASK_|GRID_MAX_ACTIVE_JOBS(?!_)/;
  const files = [
    ...COMPOSE_FILES.map((f) => join("deploy", "compose", f)),
    join("deploy", ".env.example"),
    join("deploy", "entrypoint.py"),
    join("deploy", "pulumi", "src", "config.ts"),
    join("deploy", "pulumi", "src", "app", "config.ts"),
    join("deploy", "pulumi", "src", "app", "api.ts"),
    join("deploy", "pulumi", "src", "app", "backend.ts"),
  ];

  it.each(files)("%s names no retired execution setting", (file) => {
    expect(read(file)).not.toMatch(retired);
  });

  it("the Python sources read none of them either", () => {
    const python = [join("frontends", "aiq_api", "src", "aiq_api"), join("src", "aiq_agent")]
      .flatMap((dir) =>
        readdirSync(join(repoRoot, dir), { recursive: true })
          .filter((f): f is string => typeof f === "string" && f.endsWith(".py"))
          .map((f) => read(dir, f)),
      )
      .join("\n");

    expect(python).not.toMatch(retired);
  });
});
