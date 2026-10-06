import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { load } from "js-yaml";
import { baseStackConfig } from "../test-support/stack-config";
import { BFF_QUEUE_DEPTH_QUERY } from "./bff-jobs";

// src/app -> src -> deploy/pulumi -> deploy -> repo root
const repoRoot = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

/**
 * The BFF's background pool (ADR-0078).
 *
 * It crosses three boundaries this program cannot see into, and each one plans
 * and applies clean when it drifts:
 *   - the runner reads its env (`frontends/ui/workers/jobs/index.js`), and a
 *     renamed knob leaves the pool on its defaults;
 *   - KEDA counts the queue's table, and a table or status that moves leaves
 *     the pool at its floor with work waiting (or up forever for dead rows);
 *   - nothing may route to the pod: its internal route runs a job's work as
 *     whoever the queue row names, and its only legitimate caller is the loop
 *     on its own loopback.
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

const DEPLOYMENT = "kubernetes:apps/v1:Deployment";
const SCALED_OBJECT = "kubernetes:keda.sh/v1alpha1:ScaledObject";
const TRIGGER_AUTH = "kubernetes:keda.sh/v1alpha1:TriggerAuthentication";
const NETPOL = "kubernetes:networking.k8s.io/v1:NetworkPolicy";

type ComposeService = {
  extends?: { service: string };
  command: string[];
  ports?: unknown;
  environment?: string[];
};
function composeServices(file: string): Record<string, ComposeService> {
  return (load(read("deploy", "compose", file)) as { services: Record<string, ComposeService> }).services;
}

describe("the bff-jobs pool", () => {
  let env: k8s.types.input.core.v1.EnvVar[] = [];
  let drainSeconds = 0;
  let concurrency = 0;
  const dsnRequests: Array<{ db: string; clusterWide?: boolean }> = [];

  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      // The pool logs under its own name only where the observability tier runs,
      // and that tier needs its collector's credentials to count as deployed.
      "grid-oib:otelPrimaryApiKey": "otel-key", // pragma: allowlist secret
      "grid-oib:otelOidcIssuer": "https://grid.authkit.app",
      "grid-oib:otelOidcClientId": "client_otel",
      "grid-oib:otelOidcClientSecret": "otel-client-secret", // pragma: allowlist secret
    });
    const { loadConfig } = await import("../config");
    const { installBffJobs } = await import("./bff-jobs");
    const { buildSecrets, bffJobsEnv } = await import("./config");
    const { installNetworkPolicies } = await import("../platform/network-policies");
    const cfg = loadConfig();
    drainSeconds = cfg.bffJobs.drainSeconds;
    concurrency = cfg.bffJobs.concurrency;
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const wiring = {
      cfg,
      namespace: "grid",
      provider,
      redisUrl: pulumi.output("redis://dragonfly:6379"),
      seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
      seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
      dsn: (opts: { db: string; clusterWide?: boolean }) => {
        dsnRequests.push({ db: opts.db, clusterWide: opts.clusterWide });
        return pulumi.output(`postgresql://x/${opts.db}`);
      },
      imagePullSecrets: [],
    };
    env = bffJobsEnv(wiring);
    const secrets = buildSecrets(wiring);
    const pool = installBffJobs(wiring, cfg, secrets, []);
    installNetworkPolicies(cfg, provider, "grid");
    await new Promise((done) => pool.deployment.id.apply(done));
  });

  it("runs the supervisor, which owns the BFF, in ONE container with no Service in front", async () => {
    const spec = await resolve(find(DEPLOYMENT, "bff-jobs").inputs.spec);
    const pod = spec.template.spec;

    expect(pod.containers).toHaveLength(1);
    expect(pod.containers[0].command).toEqual(["node", "workers/jobs/index.js"]);
    // A path that moves leaves a pod that crash-loops with a green plan.
    expect(existsSync(join(repoRoot, "frontends", "ui", "workers", "jobs", "index.js"))).toBe(true);
    // The image copies `workers/` whole; a second COPY line per file is how
    // `purger/` once shipped without a module it required.
    expect(read("frontends", "ui", "deploy", "Dockerfile")).toMatch(/COPY .*\/app\/workers \.\/workers/);
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true });
    expect(RESOURCES.filter((r) => r.type === "kubernetes:core/v1:Service" && r.name === "bff-jobs")).toEqual([]);
  });

  it("is never routed to: no HTTPRoute names it", () => {
    expect(read("deploy", "pulumi", "src", "app", "httproutes.ts")).not.toMatch(/bff-jobs/);
    // And this module creates no Service: the runner reaches the BFF on loopback.
    expect(read("deploy", "pulumi", "src", "app", "bff-jobs.ts")).not.toMatch(/core\.v1\.Service/);
  });

  it("gives a pod its drain budget plus time to stop the BFF it supervises", async () => {
    const spec = await resolve(find(DEPLOYMENT, "bff-jobs").inputs.spec);

    // The runner drains for `drainSeconds`, then stops the BFF: SIGKILL before
    // that would cost every claim in hand its stale window and an attempt.
    expect(spec.template.spec.terminationGracePeriodSeconds).toBe(drainSeconds + 30);
    expect(spec.strategy.rollingUpdate.maxUnavailable).toBe(0);
    expect(spec.template.spec.containers[0].readinessProbe.httpGet.path).toBe("/api/healthz");
  });

  it("emits only GRID_BFF_JOBS_ names the runner reads, and the ones it needs", async () => {
    const readByRunner = new Set(
      [...read("frontends", "ui", "workers", "jobs", "index.js").matchAll(/(GRID_BFF_JOBS_[A-Z_]+)/g)].map((m) => m[1]),
    );
    const emitted = env.map((e) => e.name as string).filter((name) => name.startsWith("GRID_BFF_JOBS_"));

    expect(emitted.length).toBeGreaterThan(2);
    expect(emitted.filter((name) => !readByRunner.has(name))).toEqual([]);
    // What the runner and the BFF in its pod cannot start without.
    const names = env.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["GRID_APP_DATABASE_URL", "GRID_INTERNAL_API_TOKEN"]));
  });

  it("names no variable twice, and logs under its own service name", async () => {
    const names = env.map((e) => e.name as string);

    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
    expect(env.find((e) => e.name === "OTEL_SERVICE_NAME")?.value).toBe("grid-bff-jobs");
    // Stopped after the runner has drained, so it needs no long WebSocket drain.
    expect(env.find((e) => e.name === "GRID_SHUTDOWN_DRAIN_MS")?.value).toBe("5000");
  });

  it("scales on the table the queue is written to, leaving dead rows out", () => {
    const migration = read("frontends", "ui", "drizzle", "0102_bff_job_queue.sql");
    const table = migration.match(/CREATE TABLE IF NOT EXISTS "([a-z_]+)"/)?.[1];

    expect(table).toBe("bff_job_queue");
    expect(read("frontends", "ui", "workers", "job-queue.js")).toContain(`FROM ${table}`);
    expect(BFF_QUEUE_DEPTH_QUERY).toBe(`SELECT COUNT(*) FROM ${table} WHERE status <> 'dead'`);
    // The status the query excludes is one the schema allows.
    expect(migration).toMatch(/"status" IN \('queued', 'claimed', 'dead'\)/);
  });

  it("asks KEDA for one replica per `concurrency` open jobs, within the configured bounds", async () => {
    const spec = await resolve(find(SCALED_OBJECT, "bff-jobs").inputs.spec);

    expect(spec.triggers).toHaveLength(1);
    expect(spec.triggers[0].type).toBe("postgresql");
    expect(spec.triggers[0].metadata).toMatchObject({
      query: BFF_QUEUE_DEPTH_QUERY,
      targetQueryValue: String(concurrency),
      activationTargetQueryValue: "0",
    });
    expect(spec.maxReplicaCount).toBeGreaterThanOrEqual(spec.minReplicaCount);
    // In slowly and a pod at a time: each one drains for up to its budget.
    expect(spec.advanced.horizontalPodAutoscalerConfig.behavior.scaleDown.policies[0]).toMatchObject({
      type: "Pods",
      value: 1,
    });
  });

  it("gives KEDA a DSN it can resolve from its own namespace, for the app database", async () => {
    const auth = await resolve(find(TRIGGER_AUTH, "bff-jobs-queue-auth").inputs.spec);
    const key = auth.secretTargetRef[0].key as string;

    // The operator runs in `keda`; a bare `grid-pg-rw` resolves there to
    // nothing, the scaler errors on every poll, and the pool never scales out.
    expect(key).toBe("KEDA_BFF_QUEUE_DB_URL");
    // The Secret's values are secret-wrapped, so what is checked is how the
    // entry the scaler reads is BUILT: the FQDN host, for the app database.
    expect(read("deploy", "pulumi", "src", "app", "config.ts")).toMatch(
      new RegExp(`${key}: w\\.dsn\\(\\{ db: "grid_app", clusterWide: true \\}\\)`),
    );
    expect(dsnRequests).toContainEqual({ db: "grid_app", clusterWide: true });
  });

  it("lets KEDA reach Postgres even when the ingest tier is off", async () => {
    // `jobExecution` defaults to dask, so the ingest tier is off here: this
    // policy is only there for the bff-jobs pool.
    const pol = await resolve(find(NETPOL, "allow-keda-to-postgres").inputs.spec);

    expect(pol.policyTypes).toEqual(["Ingress"]);
    expect(pol.ingress[0].ports).toEqual([{ protocol: "TCP", port: 5432 }]);
  });

  it("matches the Compose services: same command, nothing published", () => {
    for (const file of ["docker-compose.yaml", "docker-compose.coolify.yaml"]) {
      const services = composeServices(file);
      const svc = services["bff-jobs"];
      expect(svc, file).toBeDefined();
      expect(svc.command, file).toEqual(["node", "workers/jobs/index.js"]);
      // Internal only: a published port would put the pod's BFF on the host.
      expect(svc.ports, file).toBeUndefined();
    }
    // The dev file shares the frontend's environment by alias, so the two
    // cannot disagree; the Coolify one inherits it. Either way it is the
    // frontend's, in full, because a job calls the same services a route does.
    const dev = composeServices("docker-compose.yaml");
    expect(dev["bff-jobs"].environment).toEqual(dev.frontend.environment);
    expect(composeServices("docker-compose.coolify.yaml")["bff-jobs"].extends).toEqual({ service: "frontend" });
  });

  it("sets its knobs per stack: a floor of zero in dev, a pool in prod", () => {
    const prod = read("deploy", "pulumi", "Pulumi.prod.yaml");
    const dev = read("deploy", "pulumi", "Pulumi.dev.yaml");

    expect(prod).toMatch(/grid-oib:bffJobsMinReplicas: "1"/);
    expect(prod).toMatch(/grid-oib:bffJobsMaxReplicas: "4"/);
    expect(dev).toMatch(/grid-oib:bffJobsMinReplicas: "0"/);
  });
});
