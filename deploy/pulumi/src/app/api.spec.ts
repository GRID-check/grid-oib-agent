import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * The api tier (ADR-0082 step B).
 *
 * What goes wrong here plans clean and deploys green:
 *   - A `GRID_ROLE` the Python image does not know stops every pod of the tier
 *     at start (the entrypoint refuses it), and a role nobody sets gets no route
 *     at all. Both sides are read as source below.
 *   - A BFF whose `BACKEND_URL` still names the chat tier sends every HTTP call
 *     through pods that drain turns, which is the coupling the split removes;
 *     one whose `BACKEND_CHAT_URL` is missing cannot open a socket.
 *   - An api rollout that waits as long as a chat drain makes every deploy of
 *     the knowledge API as slow as the longest answer.
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

// src/app -> src -> deploy/pulumi -> deploy -> repo root
const repoRoot = join(__dirname, "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), "utf8");

function find(type: string, name: string) {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) throw new Error(`no ${type} named "${name}"`);
  return hit;
}

function resolve<T>(value: pulumi.Input<T>): Promise<T> {
  return new Promise((done) => pulumi.output(value).apply((v) => done(v as T)));
}

const DEPLOYMENT = "kubernetes:apps/v1:Deployment";
const STATEFULSET = "kubernetes:apps/v1:StatefulSet";
const SERVICE = "kubernetes:core/v1:Service";
const HPA = "kubernetes:autoscaling/v2:HorizontalPodAutoscaler";
const PDB = "kubernetes:policy/v1:PodDisruptionBudget";

const TUNED = {
  "grid-oib:apiMinReplicas": "3",
  "grid-oib:apiMaxReplicas": "7",
  "grid-oib:apiHpaCpuTargetPercent": "60",
  "grid-oib:observabilityEnabled": "false",
};

async function wiringFor(config: Record<string, string>) {
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...config });
  const { loadConfig } = await import("../config");
  const cfg = loadConfig();
  const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
  const wiring = {
    cfg,
    namespace: "grid",
    provider,
    redisUrl: pulumi.output("redis://dragonfly:6379"),
    seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
    seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
    dsn: () => pulumi.output("postgresql://x"),
    imagePullSecrets: [],
  };
  return { cfg, provider, wiring };
}

const literal = (env: k8s.types.input.core.v1.EnvVar[]) =>
  Object.fromEntries(env.filter((e) => typeof e.value === "string").map((e) => [e.name, e.value as string]));

describe("the api tier", () => {
  let cfg: Awaited<ReturnType<typeof wiringFor>>["cfg"];
  let wiring: Awaited<ReturnType<typeof wiringFor>>["wiring"];
  let chatEnvValues: Record<string, string> = {};
  let apiEnvValues: Record<string, string> = {};
  let frontendEnvValues: Record<string, string> = {};

  beforeAll(async () => {
    const made = await wiringFor(TUNED);
    cfg = made.cfg;
    wiring = made.wiring;
    const { installApi } = await import("./api");
    const { installBackend } = await import("./backend");
    const { apiEnv, chatEnv, frontendEnv } = await import("./config");
    const secrets = {
      secret: new k8s.core.v1.Secret("grid-secrets", {}, { provider: made.provider }),
      checksum: pulumi.output("abc"),
    };
    const api = installApi(made.wiring as never, cfg, secrets, []);
    installBackend(made.wiring as never, cfg, secrets, []);
    chatEnvValues = literal(chatEnv(made.wiring as never));
    apiEnvValues = literal(apiEnv(made.wiring as never));
    frontendEnvValues = literal(frontendEnv(made.wiring as never));
    // Pulumi registers asynchronously: wait for each resource a test reads.
    await Promise.all([api.service.id, api.hpa.id, api.pdb.id].map((id) => new Promise((done) => id.apply(done))));
  });

  it("is a Deployment, a Service and an HPA of the backend image, with a PDB", async () => {
    const deployment = find(DEPLOYMENT, "aiq-api");
    const service = find(SERVICE, "aiq-api");
    const hpa = find(HPA, "aiq-api");
    find(PDB, "aiq-api");

    const container = (await resolve(deployment.inputs.spec)).template.spec.containers[0];
    const { backendImage } = await import("../config");
    expect(container.image).toBe(backendImage(cfg));
    expect(container.ports).toEqual([{ containerPort: 8000, name: "http" }]);
    expect((await resolve(service.inputs.spec)).ports).toEqual([{ port: 8000, targetPort: 8000, name: "http" }]);
    expect((await resolve(service.inputs.spec)).selector).toEqual(
      (await resolve(deployment.inputs.spec)).selector.matchLabels,
    );
    expect((await resolve(hpa.inputs.spec)).scaleTargetRef).toMatchObject({ kind: "Deployment", name: "aiq-api" });
  });

  it("scales between the configured floor and ceiling on CPU", async () => {
    const spec = await resolve(find(HPA, "aiq-api").inputs.spec);

    expect(spec.minReplicas).toBe(3);
    expect(spec.maxReplicas).toBe(7);
    expect(spec.metrics).toEqual([
      { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 60 } } },
    ]);
    expect((await resolve(find(DEPLOYMENT, "aiq-api").inputs.spec)).replicas).toBe(3);
  });

  it("holds no volume: it is stateless, like the worker tiers", async () => {
    const pod = (await resolve(find(DEPLOYMENT, "aiq-api").inputs.spec)).template.spec;

    expect(pod.volumes).toBeUndefined();
    expect(pod.containers[0].volumeMounts).toBeUndefined();
  });

  it("probes /health the way the chat tier does", async () => {
    const container = (await resolve(find(DEPLOYMENT, "aiq-api").inputs.spec)).template.spec.containers[0];
    const chat = (await resolve(find(STATEFULSET, "aiq-agent").inputs.spec)).template.spec.containers[0];

    for (const probe of ["startupProbe", "readinessProbe", "livenessProbe"]) {
      expect(container[probe].httpGet, probe).toEqual({ path: "/health", port: 8000 });
      expect(container[probe].httpGet, probe).toEqual(chat[probe].httpGet);
    }
  });

  it("drains for the SSE close and short requests, not for a chat turn", async () => {
    const { ROLLOUT, API_DRAIN_SECONDS, backendRollout } = await import("../platform/rollout");
    const pod = (await resolve(find(DEPLOYMENT, "aiq-api").inputs.spec)).template.spec;

    expect(pod.terminationGracePeriodSeconds).toBe(ROLLOUT.api.terminationGracePeriodSeconds);
    expect(pod.terminationGracePeriodSeconds).toBeGreaterThan(ROLLOUT.api.endpointDrainSeconds + API_DRAIN_SECONDS);
    expect(pod.terminationGracePeriodSeconds).toBeLessThan(backendRollout(cfg.backend.drainSeconds).terminationGracePeriodSeconds);
  });

  it("runs as GRID_ROLE=api, and the chat StatefulSet as GRID_ROLE=chat", async () => {
    const api = (await resolve(find(DEPLOYMENT, "aiq-api").inputs.spec)).template.spec.containers[0].env;
    const chat = (await resolve(find(STATEFULSET, "aiq-agent").inputs.spec)).template.spec.containers[0].env;
    const role = (env: Array<{ name: string; value?: string }>) =>
      env.filter((e) => e.name === "GRID_ROLE").map((e) => e.value);

    expect(role(api)).toEqual(["api"]);
    expect(role(chat)).toEqual(["chat"]);
  });

  it("names exactly the web roles the Python image knows", () => {
    const python = read("frontends", "aiq_api", "src", "aiq_api", "roles.py");
    const entrypoint = read("deploy", "entrypoint.py");
    const known = [...python.matchAll(/^\s+[A-Z]+ = "([a-z]+)"$/gm)].map((m) => m[1]).sort();

    expect(known).toEqual(["api", "chat"]);
    expect(entrypoint).toContain('ROLES = ("chat", "api", "worker", "ingest-worker")');
    expect(chatEnvValues.GRID_ROLE).toBe("chat");
    expect(apiEnvValues.GRID_ROLE).toBe("api");
  });

  it("is the chat tier's env without what only chat reads", () => {
    const chatOnly = ["GRID_CHAT_DRAIN_SECONDS", "GRID_CHAT_AFFINITY", "GRID_CONVERSATION_BUS"];
    for (const name of chatOnly) {
      expect(chatEnvValues[name], name).toBeDefined();
      expect(apiEnvValues[name], name).toBeUndefined();
    }
    const apart = [...chatOnly, "GRID_ROLE", "OTEL_SERVICE_NAME"];
    const shared = Object.keys(chatEnvValues).filter((n) => !apart.includes(n));
    expect(shared.filter((n) => apiEnvValues[n] !== chatEnvValues[n])).toEqual([]);
  });

  it("gives the frontend the api URL for HTTP and the chat URL for the socket", () => {
    expect(frontendEnvValues.BACKEND_URL).toBe("http://aiq-api:8000");
    expect(frontendEnvValues.BACKEND_CHAT_URL).toBe("http://aiq-agent:8000");
  });

  it("points every HTTP consumer of the backend at the api Service", async () => {
    const { BACKEND_URL, BACKEND_CHAT_URL, purgerEnv } = await import("./config");

    expect(BACKEND_URL).toBe("http://aiq-api:8000");
    expect(BACKEND_CHAT_URL).toBe("http://aiq-agent:8000");
    expect(literal(purgerEnv(wiring as never)).BACKEND_URL).toBe(BACKEND_URL);
  });

  it("only hands ingestion to the tier: the queue has no off switch and nothing in the roles claims", async () => {
    expect(chatEnvValues.GRID_INGEST_QUEUE).toBeUndefined();
    expect(apiEnvValues.GRID_INGEST_QUEUE).toBeUndefined();
    expect(cfg.ingestWorker).not.toHaveProperty("enabled");
  });

  it("runs research on the database queue alone: the api workload carries no execution switch", () => {
    expect(apiEnvValues).not.toHaveProperty("GRID_JOB_EXECUTION");
  });

  it("is reachable from the frontend and the CronJobs through the namespace-wide ingress allow", async () => {
    // Intra-namespace ingress is allowed wholesale except for the pods named in
    // the policy's `NotIn` list (the dashboard, err2issue, Langfuse, Gotenberg).
    // The api tier must never join that list, or every BFF call times out.
    const { installNetworkPolicies } = await import("../platform/network-policies");
    const made = await wiringFor(TUNED);
    const policies = installNetworkPolicies(made.cfg, made.provider, "grid");
    await Promise.all(policies.map((policy) => new Promise((done) => policy.id.apply(done))));
    const spec = await resolve(find("kubernetes:networking.k8s.io/v1:NetworkPolicy", "allow-same-namespace").inputs.spec);

    expect(spec.ingress).toEqual([{ from: [{ podSelector: {} }] }]);
    expect(spec.podSelector.matchExpressions[0].values).not.toContain("aiq-api");
    // KEDA scrapes the chat tier's occupancy route and nothing of the api tier's.
    const keda = RESOURCES.filter((r) => r.name === "allow-keda-to-aiq-api");
    expect(keda).toEqual([]);
  });

  it("refuses a ceiling below its floor", async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:apiMinReplicas": "4",
      "grid-oib:apiMaxReplicas": "2",
    });
    const { loadConfig } = await import("../config");

    expect(() => loadConfig()).toThrow(/apiMaxReplicas \(2\) must be >= apiMinReplicas \(4\)/);
  });
});
