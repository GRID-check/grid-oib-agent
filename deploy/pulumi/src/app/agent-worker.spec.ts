import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";
import { RESEARCH_QUEUE_DEPTH_QUERY } from "./agent-worker";
import { TRANSFER_HPA_OWNERSHIP } from "./keda-scaling";

// src/app -> src -> deploy/pulumi -> deploy -> repo root
const repoRoot = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

/**
 * The research worker tier (ADR-0021, ADR-0079).
 *
 * It crosses two boundaries this program cannot see into, and each plans and
 * applies clean when it drifts:
 *   - KEDA counts the research queue's table. A table or status that moves
 *     leaves the tier at its floor with jobs waiting, or up forever for dead
 *     rows;
 *   - the Python worker reads its env. A renamed knob leaves it on its defaults,
 *     and the drain budget is the one that decides whether a deploy repeats work.
 *
 * The tier used to scale on CPU, which a job that waits on a model provider does
 * not move, so a queue could stand while the HPA saw an idle pod.
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
const HPA = "kubernetes:autoscaling/v2:HorizontalPodAutoscaler";
const NETPOL = "kubernetes:networking.k8s.io/v1:NetworkPolicy";

describe("the agent-worker tier", () => {
  let env: k8s.types.input.core.v1.EnvVar[] = [];
  let backendEnvVars: k8s.types.input.core.v1.EnvVar[] = [];
  let drainSeconds = 0;
  let concurrency = 0;

  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:jobExecution": "db",
      "grid-oib:allowPlaintextJobPayloads": "true",
      "grid-oib:observabilityEnabled": "false",
    });
    const { loadConfig } = await import("../config");
    const { installAgentWorker } = await import("./agent-worker");
    const { installJobsQueueAuth } = await import("./jobs-queue-auth");
    const { buildSecrets, workerEnv, backendEnv } = await import("./config");
    const { installNetworkPolicies } = await import("../platform/network-policies");
    const cfg = loadConfig();
    drainSeconds = cfg.agentWorker.drainSeconds;
    concurrency = cfg.agentWorker.concurrency;
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const wiring = {
      cfg,
      namespace: "grid",
      provider,
      redisUrl: pulumi.output("redis://dragonfly:6379"),
      seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
      seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
      chromaUrl: pulumi.output("http://chroma:8000"),
      dsn: (opts: { db: string; clusterWide?: boolean }) => pulumi.output(`postgresql://x/${opts.db}`),
      imagePullSecrets: [],
    };
    env = workerEnv(wiring);
    backendEnvVars = backendEnv(wiring);
    const secrets = buildSecrets(wiring);
    installJobsQueueAuth(wiring, []);
    const tier = installAgentWorker(wiring, cfg, secrets, []);
    installNetworkPolicies(cfg, provider, "grid");
    await new Promise((done) => tier.deployment.id.apply(done));
    await new Promise((done) => tier.scaledObject.id.apply(done));
  });

  it("scales on a KEDA ScaledObject and no longer has a CPU HPA", () => {
    expect(RESOURCES.filter((r) => r.type === HPA && r.name === "agent-worker")).toEqual([]);
    expect(find(SCALED_OBJECT, "agent-worker")).toBeDefined();
    expect(read("deploy", "pulumi", "src", "app", "agent-worker.ts")).not.toMatch(/HorizontalPodAutoscaler\(/);
  });

  it("scales on the table the research queue is written to, leaving dead rows out", () => {
    const table = read("frontends", "aiq_api", "src", "aiq_api", "jobs", "queue.py").match(
      /^TABLE = "([a-z_]+)"$/m,
    )?.[1];
    const dead = read("src", "aiq_agent", "common", "claim_queue.py").match(/^DEAD = "([a-z_]+)"$/m)?.[1];

    expect(table).toBe("research_job_queue");
    expect(dead).toBeDefined();
    // Dead rows stay in the table as a trace; they must not keep replicas up.
    expect(RESEARCH_QUEUE_DEPTH_QUERY).toBe(`SELECT COUNT(*) FROM ${table} WHERE status <> '${dead}'`);
  });

  it("counts every row a worker could still run, because a finished job's row is deleted", () => {
    // The query has no clause for finished jobs, so the worker must delete them.
    const queue = read("frontends", "aiq_api", "src", "aiq_api", "jobs", "queue.py");
    expect(queue).toMatch(/def mark_done\(/);
    expect(read("src", "aiq_agent", "common", "claim_queue.py")).toMatch(/DELETE FROM \{self\.table\}/);
  });

  it("asks KEDA for one replica per `concurrency` open jobs, within the configured bounds", async () => {
    const spec = await resolve(find(SCALED_OBJECT, "agent-worker").inputs.spec);

    expect(spec.triggers).toHaveLength(1);
    expect(spec.triggers[0].type).toBe("postgresql");
    expect(spec.triggers[0].metadata).toMatchObject({
      query: RESEARCH_QUEUE_DEPTH_QUERY,
      targetQueryValue: String(concurrency),
      activationTargetQueryValue: "0",
    });
    expect(spec.maxReplicaCount).toBeGreaterThanOrEqual(spec.minReplicaCount);
    // In slowly and a pod at a time: each one drains for up to its budget.
    expect(spec.advanced.horizontalPodAutoscalerConfig.behavior.scaleDown.policies[0]).toMatchObject({
      type: "Pods",
      value: 1,
    });
    expect(spec.scaleTargetRef.name).toBe("agent-worker");
  });

  it("takes over the plain HPA a stack from before KEDA still holds, instead of being refused", async () => {
    // Pulumi creates the ScaledObject before it deletes the dropped HPA, and
    // KEDA's webhook refuses a second scaler on one workload: without this the
    // update fails at the ScaledObject on every deploy (seen on dev).
    const scaled = find(SCALED_OBJECT, "agent-worker");
    const metadata = await resolve(scaled.inputs.metadata);
    const spec = await resolve(scaled.inputs.spec);

    expect(metadata.annotations).toEqual({ [TRANSFER_HPA_OWNERSHIP]: "true" });
    expect(spec.advanced.horizontalPodAutoscalerConfig.name).toBe("agent-worker");
  });

  it("reads the queue through the TriggerAuthentication the ingest tier shares, as the read-only scaler login", async () => {
    const spec = await resolve(find(SCALED_OBJECT, "agent-worker").inputs.spec);
    const auth = await resolve(find(TRIGGER_AUTH, "jobs-queue-auth").inputs.spec);

    expect(spec.triggers[0].authenticationRef.name).toBe("jobs-queue-auth");
    // The DSN is in the scaler's own Secret, not `grid-secrets`: no pod reads it,
    // so a rotation must not roll the tier.
    expect(auth.secretTargetRef).toEqual([
      { parameter: "connection", name: "grid-keda-scaler", key: "KEDA_JOBS_QUEUE_DB_URL" },
    ]);
    // Created once by the program, not by either tier, so the research tier runs
    // with the ingest tier switched off.
    expect(read("deploy", "pulumi", "index.ts")).toMatch(/installJobsQueueAuth\(wiring/);
  });

  it("gives a pod its drain budget plus time to give back what it did not finish", async () => {
    const spec = await resolve(find(DEPLOYMENT, "agent-worker").inputs.spec);

    // The worker waits `drainSeconds`, then requeues what still runs: SIGKILL
    // before that is done would cost the job its claim until the stale window.
    expect(spec.template.spec.terminationGracePeriodSeconds).toBe(drainSeconds + 30);
    expect(spec.strategy.rollingUpdate.maxUnavailable).toBe(0);
  });

  it("hands the worker the same drain budget it derives the grace period from", () => {
    const drain = env.find((e) => e.name === "GRID_RESEARCH_WORKER_DRAIN_SECONDS");

    expect(drain?.value).toBe(String(drainSeconds));
    // A name the Python worker does not read would leave it on its default.
    expect(read("frontends", "aiq_api", "src", "aiq_api", "jobs", "worker.py")).toContain(
      '"GRID_RESEARCH_WORKER_DRAIN_SECONDS"',
    );
  });

  it("emits the per-organization caps the queue's claim and admission read", () => {
    const names = new Set([...env, ...backendEnvVars].map((e) => e.name));
    const queue = read("frontends", "aiq_api", "src", "aiq_api", "jobs", "queue.py");

    for (const name of ["GRID_MAX_ACTIVE_JOBS_PER_ORG", "GRID_MAX_QUEUED_JOBS_PER_ORG"]) {
      expect(names.has(name), name).toBe(true);
      expect(queue).toContain(`"${name}"`);
    }
  });

  it("names no variable twice", () => {
    const names = env.map((e) => e.name as string);

    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });

  it("lets KEDA reach Postgres when only the research tier runs", async () => {
    // The scaler runs one COUNT(*) there and needs nothing else.
    const pol = await resolve(find(NETPOL, "allow-keda-to-postgres").inputs.spec);

    expect(pol.policyTypes).toEqual(["Ingress"]);
    expect(pol.ingress[0].ports).toEqual([{ protocol: "TCP", port: 5432 }]);
  });

  it("sets its floor per stack: zero in dev, one warm worker in prod", () => {
    const prod = read("deploy", "pulumi", "Pulumi.prod.yaml");
    const dev = read("deploy", "pulumi", "Pulumi.dev.yaml");

    expect(prod).toMatch(/grid-oib:agentWorkerMinReplicas: "1"/);
    expect(dev).toMatch(/grid-oib:agentWorkerMinReplicas: "0"/);
  });
});
