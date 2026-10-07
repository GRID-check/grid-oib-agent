import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "../test-support/stack-config";
import { fallbackReplicas, queueDepthQuery } from "./keda-scaling";

/**
 * KEDA across every ScaledObject (ADR-0079, phase 3).
 *
 * Four tiers are scaled by it (`ingest-worker`, `agent-worker`, `bff-jobs` on
 * their queues, `aiq-agent` on running turns). What goes wrong here plans clean
 * and deploys green, and shows up as a tier that does not scale and an alert
 * that says nothing:
 *   - a trigger that cannot be read and no `fallback`, so the tier sits at
 *     whatever count it had while its queue grows;
 *   - a scaler credential that is the schema owner's, held by an operator in
 *     another namespace;
 *   - a scaler that reads a table which does not exist yet on a fresh stack;
 *   - a grace period shorter than the drain, so the release-on-drain path never
 *     runs before SIGKILL;
 *   - a chart nobody pinned, validated against CRDs of another release.
 */

type Resource = { type: string; name: string; inputs: Record<string, any> };
const RESOURCES: Resource[] = [];

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

function find(type: string, name: string): Resource {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) throw new Error(`no ${type} named "${name}"`);
  return hit;
}

function resolve<T>(value: pulumi.Input<T>): Promise<T> {
  return new Promise((done) => pulumi.output(value).apply((v) => done(v as T)));
}

const SCALED = "kubernetes:keda.sh/v1alpha1:ScaledObject";
const AUTH = "kubernetes:keda.sh/v1alpha1:TriggerAuthentication";
const DEPLOYMENT = "kubernetes:apps/v1:Deployment";
const SECRET = "kubernetes:core/v1:Secret"; // pragma: allowlist secret (a Pulumi resource type)
const NETPOL = "kubernetes:networking.k8s.io/v1:NetworkPolicy";
const RELEASE = "kubernetes:helm.sh/v3:Release";
const JOB = "kubernetes:batch/v1:Job";
const CLUSTER = "kubernetes:postgresql.cnpg.io/v1:Cluster";

const QUEUE_TIERS = ["ingest-worker", "agent-worker", "bff-jobs"];
const ALL_TIERS = [...QUEUE_TIERS, "aiq-agent"];

const STACK = {
  "grid-oib:jobExecution": "db",
  "grid-oib:allowPlaintextJobPayloads": "true",
  "grid-oib:chatAffinity": "false",
  "grid-oib:backendReplicas": "1",
  "grid-oib:backendMaxReplicas": "3",
  "grid-oib:observabilityEnabled": "false",
};

let cfg: Awaited<ReturnType<typeof import("../config")["loadConfig"]>>;
const dsnRequests: Array<Record<string, any>> = [];
let scalerPassword = "";

// A Secret's `stringData` is wrapped whole when any value in it is secret.
const SECRET_SIGNATURE = "4dabf18193072939515e22adb298388d"; // pragma: allowlist secret (Pulumi's public secret marker)
async function stringData(name: string): Promise<Record<string, string>> {
  const data = await resolve(find(SECRET, name).inputs.stringData as Record<string, any>);
  return data[SECRET_SIGNATURE] ? data.value : data;
}

async function scaled(name: string): Promise<Record<string, any>> {
  return resolve(find(SCALED, name).inputs.spec);
}

describe("the program's ScaledObjects", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...STACK });
    const { loadConfig } = await import("../config");
    const { installKeda } = await import("../platform/keda");
    const { installNetworkPolicies } = await import("../platform/network-policies");
    const { installPostgres } = await import("../data/postgres");
    const { buildScalerSecret, buildSecrets } = await import("./config");
    const { installJobsQueueAuth } = await import("./jobs-queue-auth");
    const { installIngestWorker } = await import("./ingest-worker");
    const { installAgentWorker } = await import("./agent-worker");
    const { installBffJobs } = await import("./bff-jobs");
    const { installBackend } = await import("./backend");
    const { installBackendScaling } = await import("./backend-scaling");
    const { installQueueScalerGrants } = await import("./queue-scaler-grants");

    cfg = loadConfig();
    scalerPassword = await resolve(cfg.postgres.scalerPassword);
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const wiring = {
      cfg,
      namespace: "grid",
      provider,
      redisUrl: pulumi.output("redis://dragonfly:6379"),
      seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
      seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
      dsn: (opts: Record<string, any>) => {
        dsnRequests.push(opts);
        return pulumi.output(`postgresql://x/${opts.db}`);
      },
      imagePullSecrets: [],
    };

    installKeda(provider);
    installPostgres(cfg, provider, "grid");
    const secrets = buildSecrets(wiring as never);
    buildScalerSecret(wiring as never);
    const grants = installQueueScalerGrants(wiring as never, cfg, []);
    installJobsQueueAuth(wiring as never, [grants]);
    const ingest = installIngestWorker(wiring as never, cfg, secrets, [grants]);
    const agent = installAgentWorker(wiring as never, cfg, secrets, [grants]);
    const bff = installBffJobs(wiring as never, cfg, secrets, [grants]);
    const backend = installBackend(wiring as never, cfg, secrets, []);
    const chat = installBackendScaling(wiring as never, cfg, backend.statefulSet, []);
    installNetworkPolicies(cfg, provider, "grid");
    // Pulumi registers resources asynchronously: wait for each one the tests read.
    const registered = [ingest, agent, bff].flatMap((t) => [t.deployment, t.scaledObject]);
    for (const r of [...registered, chat.scaledObject, chat.auth, backend.service, grants]) {
      await new Promise((done) => r.id.apply(done));
    }
  }, 60_000);

  it("are four, and poll their triggers at one interval", async () => {
    expect(RESOURCES.filter((r) => r.type === SCALED).map((r) => r.name).sort()).toEqual([...ALL_TIERS].sort());
    for (const tier of ALL_TIERS) expect((await scaled(tier)).pollingInterval, tier).toBe(15);
  });

  describe("fallback", () => {
    it("holds every ScaledObject that can have one to the same rule: three failed polls, then a count of its own", async () => {
      for (const tier of QUEUE_TIERS) {
        const spec = await scaled(tier);
        expect(spec.fallback, tier).toMatchObject({ failureThreshold: 3, behavior: "currentReplicasIfHigher" });
        expect(spec.fallback.replicas, tier).toBeGreaterThanOrEqual(Math.max(1, spec.minReplicaCount));
        expect(spec.fallback.replicas, tier).toBeLessThanOrEqual(spec.maxReplicaCount);
      }
    });

    it("leaves it off only where a cpu trigger forbids it, which is the chat tier alone", async () => {
      // KEDA refuses `fallback` beside a cpu trigger. The rule is stated as a
      // property, not a list, so a fifth tier cannot quietly be the exception.
      const withoutFallback: string[] = [];
      for (const r of RESOURCES.filter((x) => x.type === SCALED)) {
        const spec = await resolve(r.inputs.spec as Record<string, any>);
        const hasCpu = spec.triggers.some((t: { type: string }) => t.type === "cpu");
        if (spec.fallback === undefined) withoutFallback.push(r.name);
        if (hasCpu) expect(spec, r.name).not.toHaveProperty("fallback");
        else expect(spec, r.name).toHaveProperty("fallback");
      }
      expect(withoutFallback).toEqual(["aiq-agent"]);
    });

    it("sizes the blind count from the tier's own floor and ceiling", () => {
      // A third of the ceiling, at least one pod and the floor, never above the ceiling.
      expect(fallbackReplicas(0, 3)).toBe(1);
      expect(fallbackReplicas(1, 8)).toBe(3);
      expect(fallbackReplicas(0, 20)).toBe(7);
      expect(fallbackReplicas(5, 6)).toBe(5);
      expect(fallbackReplicas(1, 1)).toBe(1);
      expect(fallbackReplicas(4, 2)).toBe(2);
    });
  });

  describe("the queue tiers, which differ only in what they count", () => {
    it("poll, cool down and scale on one policy", async () => {
      const [first, ...rest] = await Promise.all(QUEUE_TIERS.map(scaled));
      for (const spec of rest) {
        expect(spec.pollingInterval).toBe(first.pollingInterval);
        expect(spec.cooldownPeriod).toBe(first.cooldownPeriod);
        expect(spec.advanced).toEqual(first.advanced);
      }
      expect(first.pollingInterval).toBe(15);
      const behavior = first.advanced.horizontalPodAutoscalerConfig.behavior;
      expect(behavior.scaleUp.stabilizationWindowSeconds).toBe(0);
      // A pod at a time on the way in: each one drains for up to its budget.
      expect(behavior.scaleDown.policies).toEqual([{ type: "Pods", value: 1, periodSeconds: 60 }]);
    });

    it("count their own table, leave dead rows out and ask for one replica per `concurrency` jobs", async () => {
      const tables: Record<string, [string, number]> = {
        "ingest-worker": ["ingest_job_queue", cfg.ingestWorker.concurrency],
        "agent-worker": ["research_job_queue", cfg.agentWorker.concurrency],
        "bff-jobs": ["bff_job_queue", cfg.bffJobs.concurrency],
      };
      for (const [tier, [table, concurrency]] of Object.entries(tables)) {
        const [trigger] = (await scaled(tier)).triggers;
        expect(trigger.type, tier).toBe("postgresql");
        // The type `fallback` requires, and the one that reads as jobs per replica.
        expect(trigger.metricType, tier).toBe("AverageValue");
        expect(trigger.metadata, tier).toEqual({
          query: queueDepthQuery(table),
          targetQueryValue: String(concurrency),
          activationTargetQueryValue: "0",
        });
        expect(trigger.metadata.query, tier).toBe(`SELECT COUNT(*) FROM ${table} WHERE status <> 'dead'`);
      }
    });

    it("explain what the cooldown does, which is one step", () => {
      // `cooldownPeriod` is 1 -> 0 only; the comment used to say it delayed every scale-in.
      expect(read("deploy", "pulumi", "src", "app", "keda-scaling.ts")).toMatch(
        /ONE step only: how long after the last\s+\*\s+active trigger a tier is held before it is taken from 1 replica to 0/,
      );
      for (const tier of QUEUE_TIERS) {
        expect(read("deploy", "pulumi", "src", "app", `${tier}.ts`), tier).not.toMatch(/Scale-in waits this long/);
      }
    });
  });

  describe("the chart", () => {
    it("is pinned to the release the plan's CRDs are validated against, from one constant", async () => {
      const { KEDA_CHART_VERSION } = await import("../platform/keda");
      const release = find(RELEASE, "keda").inputs;

      expect(release.version).toBe(KEDA_CHART_VERSION);
      expect(KEDA_CHART_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
      // The validator reads the constant instead of repeating it.
      const validator = read("deploy", "pulumi", "scripts", "validate-crs.mjs");
      expect(validator).toContain("KEDA_CHART_VERSION");
      expect(validator).not.toMatch(/keda\/releases\/download\/v\d/);
    });
  });

  describe("the scaler's credential", () => {
    it("is a read-only login of its own, declared with the other roles and holding nothing but LOGIN", async () => {
      const { KEDA_SCALER_ROLE } = await import("../constants");
      const spec = await resolve(find(CLUSTER, "grid-pg").inputs.spec as Record<string, any>);
      const role = spec.managed.roles.find((r: { name: string }) => r.name === KEDA_SCALER_ROLE);

      expect(role).toMatchObject({
        ensure: "present",
        login: true,
        superuser: false,
        createdb: false,
        createrole: false,
        replication: false,
        // Not the attribute: its one read of a tenant table is a policy of its own.
        bypassrls: false,
        inherit: false,
      });
      expect(role.inRoles).toBeUndefined();
      expect(role.connectionLimit).toBeGreaterThan(0);
      expect(role.passwordSecret.name).toBe("grid-pg-keda-scaler-credentials");
    });

    it("has a password that is neither the owner's nor the runtime role's, and is stable", async () => {
      const secret = await stringData("pg-keda-scaler-credentials");

      expect(secret.username).toBe("grid_keda_scaler");
      expect(secret.password).toBe(scalerPassword);
      expect(scalerPassword).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect([scalerPassword]).not.toContain(await resolve(cfg.postgres.appPassword));
      expect([scalerPassword]).not.toContain(await resolve(cfg.postgres.runtimePassword));
    });

    it("can be set on its own, to rotate it without touching the owner's", async () => {
      pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...STACK, "grid-oib:pgScalerPassword": "chosen-scaler-secret" }); // pragma: allowlist secret
      const { loadConfig } = await import("../config");

      expect(await resolve(loadConfig().postgres.scalerPassword)).toBe("chosen-scaler-secret");
      pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...STACK });
    });

    it("is what KEDA connects with: the scaler's login on each database, by FQDN, never the owner", () => {
      const scalerRequests = dsnRequests.filter((r) => r.as?.user === "grid_keda_scaler");

      expect(scalerRequests.map((r) => r.db).sort()).toEqual(["aiq_jobs", "grid_app"]);
      expect(scalerRequests.every((r) => r.clusterWide === true)).toBe(true);
    });

    it("lives in a Secret no pod reads, so a rotation rolls nothing", async () => {
      const scaler = await stringData("grid-keda-scaler");
      const shared = await stringData("grid-secrets");

      expect(Object.keys(scaler).sort()).toEqual(["KEDA_BFF_QUEUE_DB_URL", "KEDA_JOBS_QUEUE_DB_URL"]);
      expect(Object.keys(shared).filter((k) => k.startsWith("KEDA_"))).toEqual([]);
      // Every TriggerAuthentication names a Secret that holds the key it asks for.
      const holds: Record<string, string[]> = {
        "grid-keda-scaler": Object.keys(scaler),
        "grid-secrets": Object.keys(shared),
      };
      for (const auth of RESOURCES.filter((r) => r.type === AUTH)) {
        const { secretTargetRef } = await resolve(auth.inputs.spec as Record<string, any>);
        for (const ref of secretTargetRef) expect(holds[ref.name], `${auth.name}: ${ref.name}`).toContain(ref.key);
      }
    });
  });

  describe("the tables the scaler reads", () => {
    const grants = () => find("kubernetes:core/v1:ConfigMap", "keda-scaler-grants-sql").inputs.data as Record<string, string>;

    it("get SELECT on the status column for the scaler and no other right", () => {
      const { "jobs.sql": jobs, "app.sql": app } = grants();

      expect(jobs).toBe(
        "REVOKE SELECT ON ingest_job_queue, research_job_queue FROM grid_keda_scaler;\n" +
          "GRANT SELECT (status) ON ingest_job_queue, research_job_queue TO grid_keda_scaler;\n",
      );
      expect(app).toContain("REVOKE SELECT ON bff_job_queue FROM grid_keda_scaler;");
      expect(app).toContain("GRANT SELECT (status) ON bff_job_queue TO grid_keda_scaler;");
      for (const sql of [jobs, app]) {
        expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|ALL PRIVILEGES|BYPASSRLS/i);
        // Never table-wide: a payload (reports, requester emails, presigned URLs) must stay unreadable to the scaler.
        expect(sql).not.toMatch(/GRANT SELECT ON/);
      }
    });

    it("cover the column every depth query filters on, and no other", async () => {
      const { SCALER_READABLE_COLUMNS } = await import("./queue-scaler-grants");
      const { queueDepthQuery } = await import("./keda-scaling");

      expect(SCALER_READABLE_COLUMNS).toEqual(["status"]);
      expect(queueDepthQuery("any_queue")).toBe("SELECT COUNT(*) FROM any_queue WHERE status <> 'dead'");
    });

    it("cross the organisation boundary by a policy of their own, for SELECT and for that role only", () => {
      const { "app.sql": app } = grants();

      expect(app).toContain("CREATE POLICY grid_keda_scaler_count ON bff_job_queue FOR SELECT TO grid_keda_scaler USING (true);");
      // Replaced, not stacked, on a re-run, and the tenant policy is left alone.
      expect(app).toContain("DROP POLICY IF EXISTS grid_keda_scaler_count ON bff_job_queue;");
      expect(app).not.toContain("grid_tenant_isolation");
    });

    it("are the tables the queues write", () => {
      const table = (path: string[]) => read(...path).match(/^TABLE = "([a-z_]+)"$/m)?.[1];
      expect(table(["src", "aiq_agent", "knowledge", "ingest_queue.py"])).toBe("ingest_job_queue");
      expect(table(["frontends", "aiq_api", "src", "aiq_api", "jobs", "queue.py"])).toBe("research_job_queue");
      expect(read("frontends", "ui", "drizzle", "0104_bff_job_queue.sql")).toContain('CREATE TABLE IF NOT EXISTS "bff_job_queue"');
    });

    it("exist before anything is granted: the grants Job creates them with the queues' own code, then grants", async () => {
      const { ensureTablesPython } = await import("./queue-scaler-grants");
      const spec = await resolve(find(JOB, "keda-scaler-grants").inputs.spec as Record<string, any>);
      const pod = spec.template.spec;
      const [init] = pod.initContainers;
      const psql = pod.containers[0];
      const script: string = psql.args[0];

      // Python first (an init container), psql after: a GRANT on a table that is
      // not there fails, and so does a scaler that polls one.
      expect(init.image).toMatch(/grid-oib-backend/);
      expect(init.command.slice(0, 2)).toEqual(["python", "-c"]);
      expect(init.command[2]).toBe(ensureTablesPython(cfg));
      expect(psql.image).toMatch(/^postgres:/);
      expect(script).toMatch(/pg_roles WHERE rolname = 'grid_keda_scaler'/);
      expect(script.indexOf("pg_roles")).toBeLessThan(script.indexOf("/sql/jobs.sql"));
      expect(script).toContain("-v ON_ERROR_STOP=1 -f /sql/app.sql");
      expect(spec.template.spec.restartPolicy).toBe("OnFailure");

      // Every name the snippet calls is one the Python modules define.
      const ingest = read("src", "aiq_agent", "knowledge", "ingest_queue.py");
      const research = read("frontends", "aiq_api", "src", "aiq_api", "jobs", "queue.py");
      expect(ingest).toMatch(/^def db_url\(\)/m);
      expect(ingest).toMatch(/^def ensure_table\(/m);
      expect(research).toMatch(/^def ensure_research_queue_table\(/m);
      expect(research).toMatch(/^TABLE = "research_job_queue"/m);
      expect(read("frontends", "aiq_api", "src", "aiq_api", "jobs", "worker.py")).toContain('"NAT_JOB_STORE_DB_URL"');
    });

    it("are created with only the tiers that need them", async () => {
      const { ensureTablesPython, jobsDatabaseTables } = await import("./queue-scaler-grants");
      const none = { jobExecution: "dask", ingestWorker: { enabled: false } } as never;
      const research = { jobExecution: "db", ingestWorker: { enabled: false } } as never;

      expect(jobsDatabaseTables(none)).toEqual([]);
      expect(jobsDatabaseTables(research)).toEqual(["research_job_queue"]);
      expect(ensureTablesPython(research)).not.toContain("ingest_queue");
      expect(ensureTablesPython(cfg)).toContain("ingest_queue.ensure_table(ingest_queue.db_url())");
    });

    it("are in place before any ScaledObject exists, by the program's own ordering", () => {
      const index = read("deploy", "pulumi", "index.ts");

      // The grants Job follows the cluster (the role) and the migrations (the BFF table)...
      expect(index).toMatch(/installQueueScalerGrants\(wiring, cfg, \[postgres\.cluster, postgres\.initJob, migrations\]\)/);
      // ...and every tier that owns a ScaledObject waits for it.
      expect(index).toMatch(/const queueScalerDeps = \[[\s\S]*?\.\.\.\(scalerGrants \? \[scalerGrants\] : \[\]\)/);
      expect(index).toMatch(/installBffJobs\(wiring, cfg, secrets, \[[\s\S]*?\.\.\.\(scalerGrants \? \[scalerGrants\] : \[\]\)/);
      // The TriggerAuthentication that points existing scalers at the new login moves
      // after the grants too, or they read through a login that can read nothing yet.
      expect(index).toMatch(/installJobsQueueAuth\(wiring, \[[\s\S]*?scalerGrants \? \[scalerGrants\]/);
      // The queue-driven ScaledObjects are built from `dependsOn` by one helper.
      expect(read("deploy", "pulumi", "src", "app", "keda-scaling.ts")).toMatch(
        /dependsOn: \[tier\.deployment, \.\.\.tier\.dependsOn\]/,
      );
    });
  });

  describe("the grace period", () => {
    it("is the drain plus 30 s on both Python worker tiers and the BFF pool, so the release path runs before SIGKILL", async () => {
      const drains: Record<string, number> = {
        "ingest-worker": cfg.ingestWorker.drainSeconds,
        "agent-worker": cfg.agentWorker.drainSeconds,
        "bff-jobs": cfg.bffJobs.drainSeconds,
      };
      for (const [tier, drain] of Object.entries(drains)) {
        const spec = await resolve(find(DEPLOYMENT, tier).inputs.spec as Record<string, any>);
        expect(spec.template.spec.terminationGracePeriodSeconds, tier).toBe(drain + 30);
      }
    });

    it("is one rule in one place", async () => {
      const { DRAIN_GIVE_BACK_SECONDS } = await import("../platform/rollout");
      expect(DRAIN_GIVE_BACK_SECONDS).toBe(30);
      for (const tier of QUEUE_TIERS) {
        expect(read("deploy", "pulumi", "src", "app", `${tier}.ts`), tier).not.toMatch(/\+ (GIVE_BACK|EXIT)_SLACK_SECONDS/);
      }
    });
  });

  describe("the network", () => {
    it("lets KEDA's operator, and only it, reach exactly the targets its triggers name", async () => {
      const operator = {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "keda" } },
        podSelector: { matchLabels: { "app.kubernetes.io/name": "keda-operator" } },
      };
      const kedaPolicies = [];
      for (const r of RESOURCES.filter((x) => x.type === NETPOL)) {
        const spec = await resolve(r.inputs.spec as Record<string, any>);
        if (JSON.stringify(spec.ingress ?? []).includes('"kubernetes.io/metadata.name":"keda"')) {
          kedaPolicies.push({ name: r.name, spec });
        }
      }

      // Postgres for the queues, the backend for the occupancy route: nothing more.
      expect(kedaPolicies.map((p) => p.name).sort()).toEqual(["allow-keda-to-aiq-agent", "allow-keda-to-postgres"]);
      const byName = Object.fromEntries(kedaPolicies.map((p) => [p.name, p.spec]));
      expect(byName["allow-keda-to-postgres"].ingress).toEqual([{ from: [operator], ports: [{ protocol: "TCP", port: 5432 }] }]);
      expect(byName["allow-keda-to-postgres"].podSelector.matchLabels).toEqual({ "cnpg.io/cluster": "grid-pg" });
      expect(byName["allow-keda-to-aiq-agent"].ingress).toEqual([{ from: [operator], ports: [{ protocol: "TCP", port: 8000 }] }]);
    });

    it("selects the operator by the label the pinned chart gives its pods", () => {
      // chart keda-2.21.0, templates/manager/deployment.yaml: pod labels
      // `app.kubernetes.io/name: {{ .Values.operator.name }}`, default `keda-operator`.
      return import("../platform/keda").then(({ KEDA_OPERATOR_LABEL }) => {
        expect(KEDA_OPERATOR_LABEL).toEqual({ "app.kubernetes.io/name": "keda-operator" });
      });
    });
  });
});
