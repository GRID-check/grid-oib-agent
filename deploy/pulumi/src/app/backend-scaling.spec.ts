import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * The chat tier's scale-out (ADR-0079).
 *
 * What goes wrong here plans clean and deploys green:
 *   - A ScaledObject whose URL, field or header drifted from the Python route
 *     errors on every KEDA poll; the HPA then holds whatever count it has, and
 *     the tier never scales. Both sides are read as source below.
 *   - Autoscaling beside the hash routing (affinity on) remaps live
 *     conversations at every scale event and sends sockets to replicas that do
 *     not exist yet.
 *   - A grace period shorter than the drain kills a long answer on every
 *     rollout, which the old fixed 90 s did.
 *   - A NetworkPolicy that does not admit the KEDA namespace turns the trigger
 *     into a timeout, again silently.
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
const route = read("frontends", "aiq_api", "src", "aiq_api", "routes", "chat_occupancy.py");
const chatSocket = read("frontends", "aiq_api", "src", "aiq_api", "chat_socket.py");

function find(type: string, name: string) {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) throw new Error(`no ${type} named "${name}"`);
  return hit;
}

function resolve<T>(value: pulumi.Input<T>): Promise<T> {
  return new Promise((done) => pulumi.output(value).apply((v) => done(v as T)));
}

const SCALED = "kubernetes:keda.sh/v1alpha1:ScaledObject";
const AUTH = "kubernetes:keda.sh/v1alpha1:TriggerAuthentication";
const NETPOL = "kubernetes:networking.k8s.io/v1:NetworkPolicy";
const STATEFULSET = "kubernetes:apps/v1:StatefulSet";

const AUTOSCALING = {
  "grid-oib:jobExecution": "db",
  "grid-oib:allowPlaintextJobPayloads": "true",
  "grid-oib:chatAffinity": "false",
  "grid-oib:backendReplicas": "1",
  "grid-oib:backendMaxReplicas": "3",
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

describe("the chat tier's scale-out", () => {
  let cfg: Awaited<ReturnType<typeof wiringFor>>["cfg"];
  let backendEnvNames: Record<string, string> = {};
  let frontendEnvNames: Record<string, string> = {};

  beforeAll(async () => {
    const made = await wiringFor(AUTOSCALING);
    cfg = made.cfg;
    const { installBackend } = await import("./backend");
    const { installBackendScaling } = await import("./backend-scaling");
    const { installNetworkPolicies } = await import("../platform/network-policies");
    const { backendEnv, frontendEnv } = await import("./config");
    const secrets = {
      secret: new k8s.core.v1.Secret("grid-secrets", {}, { provider: made.provider }),
      checksum: pulumi.output("abc"),
    };
    const backend = installBackend(made.wiring as never, cfg, secrets, []);
    installBackendScaling(made.wiring as never, cfg, backend.statefulSet, []);
    installNetworkPolicies(cfg, made.provider, "grid");
    const literal = (env: k8s.types.input.core.v1.EnvVar[]) =>
      Object.fromEntries(env.filter((e) => typeof e.value === "string").map((e) => [e.name, e.value as string]));
    backendEnvNames = literal(backendEnv(made.wiring as never));
    frontendEnvNames = literal(frontendEnv(made.wiring as never));
    await new Promise((done) => backend.service.id.apply(done));
  });

  it("autoscales only with affinity off, a database-claimed tier and room between floor and ceiling", async () => {
    const { backendAutoscaled } = await import("../config");
    const { loadConfig } = await import("../config");
    expect(backendAutoscaled(cfg)).toBe(true);

    for (const [changed, why] of [
      [{ "grid-oib:chatAffinity": "true" }, "the hash routes by the replica count"],
      [{ "grid-oib:backendMaxReplicas": "1" }, "no room"],
      [{ "grid-oib:jobExecution": "dask" }, "dask mode is a hard singleton"],
    ] as const) {
      pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...AUTOSCALING, ...changed });
      expect(backendAutoscaled(loadConfig()), why).toBe(false);
    }
  });

  it("scales the StatefulSet between its floor and ceiling", async () => {
    const spec = await resolve(find(SCALED, "aiq-agent").inputs.spec);
    expect(spec.scaleTargetRef).toMatchObject({ apiVersion: "apps/v1", kind: "StatefulSet", name: "aiq-agent" });
    expect(spec.minReplicaCount).toBe(1);
    expect(spec.maxReplicaCount).toBe(3);
  });

  it("reads the fleet's running turns from the route the backend serves, the way it serves them", async () => {
    const spec = await resolve(find(SCALED, "aiq-agent").inputs.spec);
    const trigger = spec.triggers.find((t: { type: string }) => t.type === "metrics-api");

    // The operator is in another namespace: the Service name must be qualified.
    expect(trigger.metadata.url).toBe("http://aiq-agent.grid.svc.cluster.local:8000/v1/internal/chat-occupancy");
    expect(trigger.metricType).toBe("AverageValue");
    expect(trigger.metadata.targetValue).toBe(String(cfg.backend.turnsPerReplica));

    // Both sides, as source: the route's path, the JSON field it answers, the header it guards on.
    expect(route).toContain(`CHAT_OCCUPANCY_PATH = "${new URL(trigger.metadata.url).pathname}"`);
    expect(route).toContain(`"${trigger.metadata.valueLocation}": active`);
    expect(read("frontends", "aiq_api", "src", "aiq_api", "routes", "internal_auth.py")).toContain(
      `"${trigger.metadata.keyParamName}"`,
    );
    expect(trigger.metadata).toMatchObject({ authMode: "apiKey", method: "header" });
  });

  it("sends the shared internal token from the Secret the pods read it from", async () => {
    const spec = await resolve(find(AUTH, "aiq-agent-occupancy-auth").inputs.spec);
    expect(spec.secretTargetRef).toEqual([{ parameter: "apiKey", name: "grid-secrets", key: "GRID_INTERNAL_API_TOKEN" }]);
    const scaled = await resolve(find(SCALED, "aiq-agent").inputs.spec);
    const trigger = scaled.triggers.find((t: { type: string }) => t.type === "metrics-api");
    expect(trigger.authenticationRef.name).toBe("aiq-agent-occupancy-auth");
  });

  it("adds a cpu trigger beside it, and scales in slowly and one pod at a time", async () => {
    const spec = await resolve(find(SCALED, "aiq-agent").inputs.spec);
    expect(spec.triggers.map((t: { type: string }) => t.type).sort()).toEqual(["cpu", "metrics-api"]);
    const behavior = spec.advanced.horizontalPodAutoscalerConfig.behavior;
    expect(behavior.scaleDown.stabilizationWindowSeconds).toBeGreaterThanOrEqual(600);
    expect(behavior.scaleDown.policies).toEqual([{ type: "Pods", value: 1, periodSeconds: 300 }]);
    // KEDA refuses `fallback` beside a cpu trigger; a scaler it cannot read holds the count instead.
    expect(spec).not.toHaveProperty("fallback");
  });

  it("lets KEDA's operator reach the backend port, and nothing else", async () => {
    expect(RESOURCES.filter((r) => r.type === NETPOL).map((r) => r.name)).toContain("allow-keda-to-aiq-agent");
    const pol = await resolve(find(NETPOL, "allow-keda-to-aiq-agent").inputs.spec);
    expect(pol.podSelector.matchLabels).toEqual({ "app.kubernetes.io/name": "aiq-agent" });
    expect(pol.ingress).toEqual([
      {
        // The operator runs the scalers; the metrics server and the webhooks in the
        // same namespace poll nothing and get no connection into `grid`.
        from: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "keda" } },
            podSelector: { matchLabels: { "app.kubernetes.io/name": "keda-operator" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 8000 }],
      },
    ]);
  });

  it("gives a terminating replica the whole drain, and the drain covers the longest chat turn", async () => {
    const spec = await resolve(find(STATEFULSET, "aiq-agent").inputs.spec);
    const grace = spec.template.spec.terminationGracePeriodSeconds;
    const drain = Number(backendEnvNames.GRID_CHAT_DRAIN_SECONDS);

    expect(drain).toBe(cfg.backend.drainSeconds);
    expect(grace).toBeGreaterThan(drain + 10); // the preStop endpoint drain comes out of the same budget
    const deadline = Number(chatSocket.match(/GRID_CHAT_TURN_DEADLINE_SECONDS", "(\d+)"/)?.[1]);
    expect(deadline).toBeGreaterThan(0);
    expect(drain).toBeGreaterThanOrEqual(deadline);
  });

  it("hands both tiers the one affinity flag, in the spelling each reads", () => {
    expect(backendEnvNames.GRID_CHAT_AFFINITY).toBe("0");
    expect(frontendEnvNames.GRID_CHAT_AFFINITY).toBe("0");
    expect(chatSocket).toContain('"GRID_CHAT_AFFINITY"');
    expect(read("frontends", "ui", "server.js")).toContain("GRID_CHAT_AFFINITY");
  });

  it("leaves the replica count to KEDA once it exists", () => {
    // `ignoreChanges` is a resource option, which the mocks do not carry.
    expect(read("deploy", "pulumi", "src", "app", "backend.ts")).toMatch(
      /ignoreChanges: \["spec\.volumeClaimTemplates", \.\.\.\(autoscaled \? \["spec\.replicas"\] : \[\]\)\]/,
    );
  });
});
