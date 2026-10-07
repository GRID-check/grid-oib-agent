import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { POOLED_POOLS } from "./src/constants";
import { baseStackConfig, langfuseStackConfig } from "./src/test-support/stack-config";

/**
 * Postgres connections go through a transaction pooler, and every session
 * feature takes a direct connection (ADR-0083). This is the confirmation for
 * both halves, against the whole program rather than one module, because the
 * routing is spread across seven files and no one of them sees the table.
 *
 * The failure it exists to catch is silent. A session advisory lock taken
 * through a transaction pooler "works": the lock is acquired on one server
 * connection and released on another, and the first stays locked until it is
 * recycled. LISTEN through one registers on a server connection the client does
 * not keep, and no notification ever arrives. Neither raises an error.
 *
 * In the split topology with Langfuse on, so every consumer of a DSN is built:
 * the filer's store, Langfuse's Prisma, KEDA's two scaler DSNs.
 */

type Inputs = Record<string, unknown>;
const RESOURCES: Array<{ type: string; name: string; inputs: Inputs }> = [];

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

const NAMESPACE = "grid";
const DIRECT = "grid-pg-rw";
const POOLER = "grid-pg-pooler-rw";
const KEDA_DIRECT = `${DIRECT}.${NAMESPACE}.svc.cluster.local`;

/**
 * The route of every Postgres DSN the program emits, by `<resource>/<key>`.
 * A new DSN that is not in this table fails the test below, so choosing a route
 * is not something a new consumer can skip.
 */
const EXPECTED_HOSTS: Record<string, string> = {
  // The pooled five: self-contained per transaction.
  "grid-secrets/NAT_JOB_STORE_DB_URL": POOLER,  // pragma: allowlist secret
  "grid-secrets/AIQ_CHECKPOINT_DB": POOLER,  // pragma: allowlist secret
  "grid-secrets/AIQ_DEEP_CHECKPOINT_DB": POOLER,
  "grid-secrets/AIQ_SUMMARY_DB": POOLER,
  "grid-secrets/GRID_APP_DATABASE_URL": POOLER,
  // Session-scoped: LISTEN/NOTIFY, session advisory locks, DDL under the owner.
  "grid-secrets/AIQ_LISTEN_DB_URL": DIRECT,
  "grid-secrets/AIQ_LOCK_DB_URL": DIRECT,
  "grid-secrets/GRID_APP_MIGRATION_DATABASE_URL": DIRECT,
  // KEDA polls from another namespace, so by FQDN, and straight to the primary.
  "grid-keda-scaler/KEDA_JOBS_QUEUE_DB_URL": KEDA_DIRECT,
  "grid-keda-scaler/KEDA_BFF_QUEUE_DB_URL": KEDA_DIRECT,
  // The init and grants Jobs.
  "pg-init-dsns/JOBS_DSN": DIRECT,
  "pg-init-dsns/CHECKPOINTS_DSN": DIRECT,
  "pg-init-dsns/SEAWEED_FILER_DSN": DIRECT,
  "keda-scaler-grants-dsns/JOBS_DSN": DIRECT,
  "keda-scaler-grants-dsns/APP_DSN": DIRECT,
  "keda-scaler-grants-dsns/NAT_JOB_STORE_DB_URL": DIRECT,  // pragma: allowlist secret
  "keda-scaler-grants-dsns/AIQ_SUMMARY_DB": DIRECT,
  // Prisma migrates under a session advisory lock of its own.
  "langfuse-secrets/database-url": DIRECT,
};

/**
 * A Secret's `stringData` as the mock receives it: any value that is a pulumi
 * secret arrives wrapped as `{ <secret sigil>: ..., value }`, and a Secret
 * built from secret Outputs is wrapped whole.
 */
function unsecret(stringData: unknown): Record<string, unknown> {
  const wrapped = stringData as { value?: Record<string, unknown> } | undefined;
  return (wrapped && "value" in wrapped ? wrapped.value : (stringData as Record<string, unknown>)) ?? {};
}

/** Every `<resource>/<key>` whose value is a Postgres URL, with the URL parsed. */
function postgresDsns(): Array<{ id: string; url: URL }> {
  const found: Array<{ id: string; url: URL }> = [];
  for (const resource of RESOURCES) {
    if (resource.type !== "kubernetes:core/v1:Secret") continue;
    const data = unsecret(resource.inputs.stringData);
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== "string" || !/^postgres(ql)?(\+\w+)?:\/\//.test(value)) continue;
      // `new URL` does not know the `postgresql+asyncpg` scheme's authority rules.
      found.push({ id: `${resource.name}/${key}`, url: new URL(value.replace(/^postgres(ql)?(\+\w+)?:/, "postgres:")) });
    }
  }
  return found;
}

describe("Postgres routing", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...langfuseStackConfig(),
      "grid-oib:seaweedfsTopology": "split",
      "grid-oib:seaweedfsFilerStore": "postgres",
      "grid-oib:seaweedfsPerOrgBuckets": "true",
      "grid-oib:jobExecution": "db",
      "grid-oib:allowPlaintextJobPayloads": "true",
      "grid-oib:pgInstances": "3",
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  it("sends each DSN where the table says: pooled ones to the pooler, session ones to the primary", () => {
    const actual = Object.fromEntries(postgresDsns().map(({ id, url }) => [id, url.hostname]));

    expect(actual).toEqual(EXPECTED_HOSTS);
  });

  it("keeps LISTEN, the session locks and the migrations off the pooler, whatever else moves", () => {
    // The same fact as the table, stated as the rule it enforces, so a reviewer
    // reading a failure sees the reason and not only a diff of hostnames.
    const hosts = Object.fromEntries(postgresDsns().map(({ id, url }) => [id, url.hostname]));

    for (const key of ["AIQ_LISTEN_DB_URL", "AIQ_LOCK_DB_URL", "GRID_APP_MIGRATION_DATABASE_URL"]) {
      expect(hosts[`grid-secrets/${key}`], key).toBe(DIRECT);
    }
  });

  it("points AIQ_LOCK_DB_URL at the jobs database as the owner, like the other Python DSNs", () => {
    const lock = postgresDsns().find(({ id }) => id === "grid-secrets/AIQ_LOCK_DB_URL")!.url;
    const listen = postgresDsns().find(({ id }) => id === "grid-secrets/AIQ_LISTEN_DB_URL")!.url;

    expect(lock.pathname).toBe("/aiq_jobs");
    expect(lock.username).toBe(listen.username);
    expect(lock.port).toBe("5432");
  });

  it("reads the filer's store from the primary", () => {
    const filer = RESOURCES.map((r) => JSON.stringify(r.inputs)).find((json) => json.includes("[postgres2]"));

    expect(filer, "a resource carrying filer.toml").toBeDefined();
    expect(filer).toContain(`hostname = \\"${DIRECT}\\"`);
    expect(filer).not.toContain(POOLER);
  });

  it("pools exactly the (database, role) pairs the connection budget pays for", () => {
    const pooled = postgresDsns().filter(({ url }) => url.hostname === POOLER);
    const pairs = new Set(pooled.map(({ url }) => `${url.pathname.slice(1)}/${decodeURIComponent(url.username)}`));
    const budgeted = new Set(
      POOLED_POOLS.map(({ database, login }) => `${database}/${login === "app" ? "aiq" : "grid_app_rw"}`),
    );

    expect(pairs).toEqual(budgeted);
  });

  it("gives every pod that runs the Python code the lock DSN", () => {
    const env = (name: string) =>
      RESOURCES.filter(
        (r) =>
          (r.type === "kubernetes:apps/v1:Deployment" || r.type === "kubernetes:apps/v1:StatefulSet") &&
          r.name === name,
      ).flatMap((r) => {
        const spec = r.inputs.spec as { template: { spec: { containers: Array<{ env?: Array<{ name: string }> }> } } };
        return spec.template.spec.containers.flatMap((c) => (c.env ?? []).map((e) => e.name));
      });

    for (const tier of ["aiq-agent", "agent-worker", "ingest-worker"]) {
      const names = env(tier);
      expect(names, `${tier} has env`).toContain("AIQ_LISTEN_DB_URL");
      expect(names, `${tier} takes its locks on the direct DSN`).toContain("AIQ_LOCK_DB_URL");
    }
  });

  describe("the Pooler", () => {
    const pooler = () => RESOURCES.find((r) => r.type === "kubernetes:postgresql.cnpg.io/v1:Pooler")!;
    const spec = () => pooler().inputs.spec as {
      cluster: { name: string };
      instances: number;
      type: string;
      pgbouncer: { poolMode: string; parameters: Record<string, string> };
      template: {
        metadata: { labels: Record<string, string> };
        spec: { containers: Array<{ name: string; image: string }>; topologySpreadConstraints?: unknown[] };
      };
    };

    it("is one resource, named for the Service the pooled DSNs resolve", () => {
      expect(RESOURCES.filter((r) => r.type === "kubernetes:postgresql.cnpg.io/v1:Pooler")).toHaveLength(1);
      expect((pooler().inputs.metadata as { name: string }).name).toBe(POOLER);
    });

    it("pools the read-write primary in transaction mode", () => {
      expect(spec().cluster.name).toBe("grid-pg");
      expect(spec().type).toBe("rw");
      expect(spec().pgbouncer.poolMode).toBe("transaction");
    });

    it("lets psycopg3 and asyncpg keep their prepared statements, and sizes the pools", () => {
      expect(spec().pgbouncer.parameters).toEqual({
        max_client_conn: "2000",
        default_pool_size: "12",
        max_prepared_statements: "200",
      });
    });

    it("runs a digest-pinned PgBouncer, in the container the operator names pgbouncer", () => {
      const [container] = spec().template.spec.containers;

      expect(container.name).toBe("pgbouncer");
      expect(container.image).toMatch(/^ghcr\.io\/cloudnative-pg\/pgbouncer:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/);
    });

    it("spreads two poolers across nodes and budgets a disruption for them", () => {
      expect(spec().instances).toBe(2);
      expect(spec().template.spec.topologySpreadConstraints).toHaveLength(1);
      const pdb = RESOURCES.find((r) => r.type === "kubernetes:policy/v1:PodDisruptionBudget" && r.name === POOLER);

      expect(pdb, "a PDB for the poolers").toBeDefined();
      const pdbSpec = pdb!.inputs.spec as { maxUnavailable: number; selector: { matchLabels: Record<string, string> } };
      expect(pdbSpec.maxUnavailable).toBe(1);
      // The PDB selects the pods the Pooler template labels.
      expect(pdbSpec.selector.matchLabels).toEqual(spec().template.metadata.labels);
    });
  });
});
