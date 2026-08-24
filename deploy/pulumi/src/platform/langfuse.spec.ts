import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { loadConfig } from "../config";
import { baseStackConfig, langfuseStackConfig } from "../test-support/stack-config";

/**
 * The Langfuse tier (ADR-0044).
 *
 * The bar for a test here is the same one `config.spec.ts` sets: would the
 * mistake produce a running, healthy-looking deployment? Nearly every failure
 * mode in this tier does.
 *
 *   - A collector exporting to the wrong path 404s inside the exporter. Every
 *     pod is Ready; Langfuse is simply empty.
 *   - A missing `LANGFUSE_OTLP_AUTH` env with the exporter still configured
 *     stops the COLLECTOR from starting — taking the Aspire dashboard's
 *     telemetry down with it, for a tier nobody was looking at yet.
 *   - Two containers both running migrations contend on an advisory lock; the
 *     loser blocks until its startup probe gives up, so a deploy fails on a
 *     probe timeout rather than on anything naming migrations.
 *   - An S3 identity granted a bare action reaches EVERY bucket, including the
 *     Postgres PITR archive. Nothing errors, ever.
 *
 * None of those is visible in `kubectl get pods`, which is why they are here.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

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

/** Resolve a possibly-Output resource input to a plain value. */
function resolve(value: unknown): Promise<any> {
  return new Promise((done) =>
    (pulumi.output(value) as pulumi.Output<any>).apply((v: any) => {
      done(v);
      return v;
    }),
  );
}

function find(type: string, name: string) {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) {
    throw new Error(
      `no ${type} named "${name}". Built: ${RESOURCES.filter((r) => r.type === type).map((r) => r.name).join(", ") || "(none)"}`,
    );
  }
  return hit;
}

function has(type: string, name: string): boolean {
  return RESOURCES.some((r) => r.type === type && r.name === name);
}

/**
 * Unwrap Pulumi's secret sentinel.
 *
 * A `pulumi.secret(...)` reaches the resource mock as
 * `{ <signature>: "1b47…", value: <real> }` rather than as the value itself,
 * and `pulumi.output().apply()` does not strip it. Reading straight through the
 * wrapper yields `undefined`, which as a test failure looks like "the resource
 * was never built".
 */
// Pulumi's public special-signature constant, not a credential.
const SECRET_SIGNATURE = "4dabf18193072939515e22adb298388d"; // pragma: allowlist secret
function unsecret<T>(value: unknown): T {
  return (value && typeof value === "object" && SECRET_SIGNATURE in (value as object)
    ? (value as { value: T }).value
    : value) as T;
}

/** The parsed `s3.json` authorization catalogue, as the filer will read it. */
async function s3Identities(): Promise<Array<{ name: string; actions: string[] }>> {
  const secret = find("kubernetes:core/v1:Secret", "seaweedfs-s3-config");
  const data = unsecret<Record<string, string>>(await resolve(secret.inputs.stringData));
  return JSON.parse(data["s3.json"]).identities;
}

/** Env of the first container of a Deployment, as a plain key→value map. */
async function containerEnv(name: string): Promise<Record<string, unknown>> {
  const spec = (await resolve(find("kubernetes:apps/v1:Deployment", name).inputs.spec)) as any;
  const env = spec.template.spec.containers[0].env as Array<{ name: string; value?: string; valueFrom?: unknown }>;
  return Object.fromEntries(env.map((e) => [e.name, e.value ?? e.valueFrom]));
}

describe("with the Langfuse tier enabled", () => {
  let collectorConfig: string;

  beforeAll(async () => {
    RESOURCES.length = 0;
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...langfuseStackConfig() });
    await import("../../index");
    // Pulumi resolves resource inputs asynchronously; give the mock registry a
    // turn of the loop to receive them all.
    await new Promise((r) => setTimeout(r, 200));

    const cm = find("kubernetes:core/v1:ConfigMap", "otel-collector");
    collectorConfig = ((await resolve(cm.inputs.data)) as Record<string, string>)["collector.yaml"];
  });

  it("builds the whole tier: web, worker, ClickHouse and a dedicated queue", () => {
    expect(has("kubernetes:apps/v1:Deployment", "langfuse-web")).toBe(true);
    expect(has("kubernetes:apps/v1:Deployment", "langfuse-worker")).toBe(true);
    expect(has("kubernetes:apps/v1:StatefulSet", "clickhouse")).toBe(true);
    expect(has("kubernetes:apps/v1:Deployment", "dragonfly-langfuse")).toBe(true);
  });

  describe("collector fan-out", () => {
    it("adds Langfuse to the EXISTING traces pipeline, keeping Aspire on it", () => {
      // Both, not either. The dashboard is the live pane and Langfuse is the
      // durable store; a change that quietly replaced one with the other would
      // still look like "traces are working".
      expect(collectorConfig).toMatch(
        /traces:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[memory_limiter, batch\]\s*\n\s*exporters: \[otlp_http\/aspire, otlp_http\/langfuse\]/,
      );
    });

    it("leaves the logs and metrics pipelines alone", () => {
      // Langfuse ingests traces. Pointing logs at it would be silently
      // discarded volume — Langfuse's OTLP receiver is a traces endpoint.
      expect(collectorConfig).toMatch(/logs:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[memory_limiter, batch\]\s*\n\s*exporters: \[otlp_http\/aspire\]/);
      expect(collectorConfig).toMatch(/metrics:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[memory_limiter, batch\]\s*\n\s*exporters: \[otlp_http\/aspire\]/);
    });

    it("uses the component's CURRENT type id, not its deprecated alias", () => {
      // Both `otlp_http` and `otlphttp` resolve today, so nothing fails if this
      // drifts — until the deprecated alias is removed upstream and the
      // collector refuses to start, taking the dashboard's telemetry with it.
      // Upstream is explicit: `Type = MustNewType("otlp_http")`,
      // `DeprecatedType = MustNewType("otlphttp")`.
      expect(collectorConfig).toContain("otlp_http/langfuse:");
      expect(collectorConfig).not.toMatch(/^\s+otlphttp\//m);
    });

    it("posts to the full signal path, via traces_endpoint", () => {
      // `endpoint:` would make the exporter append `/v1/traces` to a path that
      // already ends in it — a 404 per batch, and no other symptom.
      expect(collectorConfig).toContain(
        "traces_endpoint: http://langfuse-web:3000/api/public/otel/v1/traces",
      );
      expect(collectorConfig).not.toMatch(/^\s+endpoint: http:\/\/langfuse-web/m);
    });

    it("reads its credential from the environment, never the ConfigMap", async () => {
      // A ConfigMap is not protected the way a Secret is — anyone who can run
      // `kubectl get cm` in the namespace would otherwise be handed a working
      // ingestion key.
      expect(collectorConfig).toContain("Authorization: ${env:LANGFUSE_OTLP_AUTH}");
      expect(collectorConfig).not.toContain("pk-lf-test");
      expect(collectorConfig).not.toContain("sk-lf-test");

      const env = await containerEnv("otel-collector");
      expect(env.LANGFUSE_OTLP_AUTH).toBeDefined();
    });

    it("rolls the collector when the ingestion key rotates", async () => {
      // `secretKeyRef` is read once at container start. Without a checksum on
      // the pod template, rotating the Langfuse keys updates the Secret,
      // restarts nothing, and leaves the collector presenting a retired header
      // — 401s, and traces that simply stop, while `pulumi up` reports success.
      const spec = (await resolve(
        find("kubernetes:apps/v1:Deployment", "otel-collector").inputs.spec,
      )) as any;

      expect(Object.keys(spec.template.metadata.annotations ?? {}).join()).toMatch(/checksum/i);
    });

    it("bounds the Langfuse queue so an outage cannot starve the dashboard", () => {
      // Both exporters share one pipeline, so unbounded buffering on one of
      // them becomes `memory_limiter` back-pressure on the other.
      expect(collectorConfig).toMatch(/sending_queue:\s*\n\s*enabled: true\s*\n\s*queue_size: 2000/);
    });
  });

  describe("migrations", () => {
    it("gives them to exactly one container", async () => {
      const web = await containerEnv("langfuse-web");
      const worker = await containerEnv("langfuse-worker");

      // Both images ship migrations and both run them by default.
      expect(web.LANGFUSE_AUTO_POSTGRES_MIGRATION_DISABLED).toBeUndefined();
      expect(web.LANGFUSE_AUTO_CLICKHOUSE_MIGRATION_DISABLED).toBeUndefined();
      expect(worker.LANGFUSE_AUTO_POSTGRES_MIGRATION_DISABLED).toBe("true");
      expect(worker.LANGFUSE_AUTO_CLICKHOUSE_MIGRATION_DISABLED).toBe("true");
    });

    it("keeps the web tier at one replica while it owns them", async () => {
      const spec = (await resolve(
        find("kubernetes:apps/v1:Deployment", "langfuse-web").inputs.spec,
      )) as any;
      expect(spec.replicas).toBe(1);
    });

    it("gives the migration longer than the rollout deadline allows to fail it", async () => {
      // The failure this guards is the most misleading in the tier: a first
      // deploy whose migrations run for the documented ~10 minutes gets marked
      // ProgressDeadlineExceeded and fails `pulumi up` while the pod is doing
      // exactly what it was configured to do. `assertStartupFitsRollout` throws
      // at plan time if this stops holding; this pins the resulting numbers.
      const spec = (await resolve(
        find("kubernetes:apps/v1:Deployment", "langfuse-web").inputs.spec,
      )) as any;
      const probe = spec.template.spec.containers[0].startupProbe;
      const probeBudget = probe.periodSeconds * probe.failureThreshold;

      expect(spec.progressDeadlineSeconds).toBeGreaterThan(
        probeBudget + spec.minReadySeconds,
      );
    });
  });

  describe("runtime user", () => {
    // Both Dockerfiles build their runtime user at `ARG UID=1001` and chown
    // /app to it. `runAsUser` OVERRIDES the image's USER, so 1000 — the value
    // every other workload in this repo uses — would run the process as an
    // identity owning none of its own files. And it cannot be omitted: the
    // images name their user (`nextjs` / `expressjs`) rather than numbering it,
    // and `runAsNonRoot` against a non-numeric image user makes the kubelet
    // refuse the pod outright.
    it.each(["langfuse-web", "langfuse-worker"])("runs %s as the uid its image owns", async (name) => {
      const spec = (await resolve(
        find("kubernetes:apps/v1:Deployment", name).inputs.spec,
      )) as any;

      expect(spec.template.spec.securityContext).toMatchObject({
        runAsNonRoot: true,
        runAsUser: 1001,
        runAsGroup: 1001,
      });
    });
  });

  describe("ClickHouse", () => {
    it("matches the schema shape the migrator will emit", async () => {
      // `CLICKHOUSE_CLUSTER_ENABLED=false` makes Langfuse emit plain MergeTree
      // DDL. Against a single node that is the only correct value — the
      // Replicated* engines it would otherwise use need a keeper quorum.
      const web = await containerEnv("langfuse-web");
      expect(web.CLICKHOUSE_CLUSTER_ENABLED).toBe("false");
    });

    it("gives the migrator the native port and the app the HTTP one", async () => {
      const web = await containerEnv("langfuse-web");
      expect(web.CLICKHOUSE_URL).toBe("http://clickhouse:8123");
      expect(web.CLICKHOUSE_MIGRATION_URL).toBe("clickhouse://clickhouse:9000");
    });

    it("runs on a non-default login, which is what removes the passwordless superuser", async () => {
      // The image's entrypoint writes `<default remove="remove">` only when
      // CLICKHOUSE_USER is something other than `default`.
      const spec = (await resolve(
        find("kubernetes:apps/v1:StatefulSet", "clickhouse").inputs.spec,
      )) as any;
      const env = Object.fromEntries(
        spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value ?? e.valueFrom]),
      );
      expect(env.CLICKHOUSE_USER).toBe("langfuse");
      expect(env.CLICKHOUSE_USER).not.toBe("default");
      // Langfuse's queries return empty result sets on a non-UTC server.
      expect(env.TZ).toBe("UTC");
    });

    it("keeps its PVC when the StatefulSet goes away", async () => {
      const spec = (await resolve(
        find("kubernetes:apps/v1:StatefulSet", "clickhouse").inputs.spec,
      )) as any;
      // The trace store has no second copy anywhere: no PITR, no S3 mirror.
      expect(spec.persistentVolumeClaimRetentionPolicy).toEqual({
        whenDeleted: "Retain",
        whenScaled: "Retain",
      });
    });
  });

  describe("secrets", () => {
    it("passes every credential by reference, never as a literal env value", async () => {
      for (const name of ["langfuse-web", "langfuse-worker"]) {
        const spec = (await resolve(
          find("kubernetes:apps/v1:Deployment", name).inputs.spec,
        )) as any;
        const literals = (spec.template.spec.containers[0].env as any[])
          .filter((e) => typeof e.value === "string")
          .map((e) => e.value as string);

        for (const secret of ["lf-db", "lf-ch", "lf-queue", "lf-s3", "sk-lf-test", "lf-init-user"]) {
          expect(literals, `${name} leaked ${secret} onto its pod spec`).not.toContain(secret);
        }
      }
    });

    it("rolls the pods when a credential rotates", async () => {
      // `secretKeyRef` is read once at container start, so without the checksum
      // annotation a rotation updates the Secret and changes nothing running.
      for (const name of ["langfuse-web", "langfuse-worker"]) {
        const spec = (await resolve(
          find("kubernetes:apps/v1:Deployment", name).inputs.spec,
        )) as any;
        expect(Object.keys(spec.template.metadata.annotations ?? {}).join()).toMatch(/checksum/i);
      }
    });
  });

  describe("object storage", () => {
    it("scopes the Langfuse S3 identity to its own bucket and nothing else", async () => {
      const identities = await s3Identities();
      const langfuse = identities.find((i) => i.name === "grid-langfuse");
      expect(langfuse?.actions.sort()).toEqual(
        ["List:langfuse", "Read:langfuse", "Tagging:langfuse", "Write:langfuse"],
      );
      // A bare action would match every bucket, including grid-pg-backups.
      for (const action of langfuse?.actions ?? []) {
        expect(action).toContain(":");
      }
    });

    it("withholds the trace bucket from the general-purpose `grid` credential", async () => {
      // The BFF and the purger hold that key. Raw trace events are every
      // tenant's prompts and completions, and neither has any reason to read
      // them — adding a platform bucket must not silently widen an existing
      // credential.
      const identities = await s3Identities();
      const grid = identities.find((i) => i.name === "grid");

      expect(grid?.actions.some((a) => a.endsWith(":langfuse"))).toBe(false);
      // But it does still hold the buckets it is supposed to — the filter must
      // remove one bucket, not collapse the grant.
      expect(grid?.actions).toContain("Write:grid-documents");
    });
  });

  describe("network isolation", () => {
    it("withholds the tier from the wholesale intra-namespace allow", async () => {
      const spec = (await resolve(
        find("kubernetes:networking.k8s.io/v1:NetworkPolicy", "allow-same-namespace").inputs.spec,
      )) as any;
      const withheld = spec.podSelector.matchExpressions[0].values as string[];

      expect(withheld).toEqual(
        expect.arrayContaining(["langfuse-web", "langfuse-worker", "clickhouse"]),
      );
    });

    it("names the only two callers ClickHouse has", async () => {
      const spec = (await resolve(
        find("kubernetes:networking.k8s.io/v1:NetworkPolicy", "allow-langfuse-to-clickhouse")
          .inputs.spec,
      )) as any;
      const from = spec.ingress[0].from as any[];

      expect(from.map((f) => f.podSelector.matchLabels["app.kubernetes.io/name"]).sort()).toEqual([
        "langfuse-web",
        "langfuse-worker",
      ]);
    });

    it("lets the collector and the edge reach the web tier", () => {
      expect(has("kubernetes:networking.k8s.io/v1:NetworkPolicy", "allow-collector-to-langfuse")).toBe(true);
      expect(has("kubernetes:networking.k8s.io/v1:NetworkPolicy", "allow-edge-to-langfuse")).toBe(true);
    });
  });

  describe("edge", () => {
    it("gates the UI on the platform permission, not merely on being signed in", async () => {
      const spec = (await resolve(
        find("kubernetes:gateway.envoyproxy.io/v1alpha1:SecurityPolicy", "grid-langfuse-security-policy")
          .inputs.spec,
      )) as any;

      // Langfuse's own SSO would admit anyone who can authenticate to the
      // WorkOS environment at all. The permission check exists only here.
      expect(spec.authorization.defaultAction).toBe("Deny");
      expect(spec.authorization.rules[0].principal.jwt.scopes).toContain(
        "platform:organizations:view",
      );
      expect(spec.oidc.redirectURL).toBe("https://langfuse.example.test/oauth2/callback");
    });

    it("serves the hostname on its own TLS listener", async () => {
      const spec = (await resolve(
        find("kubernetes:gateway.networking.k8s.io/v1:Gateway", "grid-gateway").inputs.spec,
      )) as any;
      const listener = (spec.listeners as any[]).find((l) => l.name === "https-langfuse");

      expect(listener?.hostname).toBe("langfuse.example.test");
      expect(listener?.tls.certificateRefs[0].name).toBe("grid-langfuse-tls");
    });
  });

  it("turns on backend identity attributes, which is what makes traces attributable", async () => {
    // Without this the traces arrive but carry no user and no tenant — the
    // difference between "Langfuse is receiving spans" and "Langfuse can tell
    // you whose run this was", which is most of why the tier exists.
    const spec = (await resolve(
      find("kubernetes:apps/v1:StatefulSet", "aiq-agent").inputs.spec,
    )) as any;
    const env = Object.fromEntries(
      spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value ?? e.valueFrom]),
    );

    expect(env.GRID_TRACE_IDENTITY_ATTRIBUTES).toBe("true");
  });
});

describe("the rollout-budget guard", () => {
  // A guard that cannot fire is worse than no guard — it reads as protection
  // that was considered and applied. So this asserts the arithmetic REFUSES a
  // bad combination, not merely that today's numbers happen to pass.
  it("refuses a probe budget that can outlive its rollout deadline", async () => {
    const { assertStartupFitsRollout } = await import("./rollout");

    expect(() =>
      assertStartupFitsRollout(
        "test-workload",
        { minReadySeconds: 10, progressDeadlineSeconds: 600, terminationGracePeriodSeconds: 30, endpointDrainSeconds: 0 },
        600, // exactly the deadline — the shape the Langfuse web tier shipped with
      ),
    ).toThrow(/exceeds progressDeadlineSeconds/);
  });

  it("accepts a deadline with room for the probe, the soak and the image pull", async () => {
    const { assertStartupFitsRollout, ROLLOUT, startupBudgetSeconds } = await import("./rollout");

    expect(() =>
      assertStartupFitsRollout("langfuse-web", ROLLOUT.langfuse, startupBudgetSeconds(10, 60)),
    ).not.toThrow();
  });
});

describe("config gating", () => {
  function loadWith(values: Record<string, string>, omit: string[] = []): Error | null {
    const config: Record<string, string> = {
      ...baseStackConfig(),
      ...langfuseStackConfig(),
      ...values,
    };
    for (const key of omit) delete config[key];
    pulumi.runtime.setAllConfig(config);
    try {
      loadConfig();
      return null;
    } catch (error) {
      return error as Error;
    }
  }

  it("accepts the fully configured tier", () => {
    expect(loadWith({})).toBeNull();
  });

  it("refuses a base64 encryption key, which is the natural mistake", () => {
    // Every other secret in this program is `openssl rand -base64 32`. This one
    // is hex, and Langfuse's own failure for a wrong-length value is a crash
    // loop with a stack trace that does not name the variable.
    const error = loadWith({
      "grid-oib:langfuseEncryptionKey": "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4",
    });
    expect(error?.message).toMatch(/64 hex characters/);
  });

  it.each([
    ["langfusePublicKey", "pk-lf-"],
    ["langfuseSecretKey", "sk-lf-"],
  ])("refuses %s without the prefix Langfuse validates", (key, prefix) => {
    const error = loadWith({ [`grid-oib:${key}`]: "not-a-key" });
    expect(error?.message).toContain(prefix);
  });

  // The house convention for every other secret here is `openssl rand -base64
  // 32`, which for 32 bytes ALWAYS ends in `=` and often contains `+`. Langfuse
  // interpolates this one into a connection-string query parameter unencoded
  // (`clickhouse/scripts/up.sh`), so following the convention breaks the
  // ClickHouse migration and crash-loops langfuse-web — with nothing in the
  // logs but a generic hint about special characters.
  it.each([
    ["base64 padding", "c2VjcmV0LXZhbHVlLWZvci10ZXN0aW5nLW9ubHk="],
    ["a plus sign", "abc+def"],
    ["an ampersand", "abc&def"],
    ["a slash", "abc/def"],
  ])("refuses a ClickHouse password containing %s", (_label, value) => {
    const error = loadWith({ "grid-oib:langfuseClickhousePassword": value });
    expect(error?.message).toMatch(/must contain only URL-safe characters/);
  });

  it("accepts a hex ClickHouse password, which is what the docs now generate", () => {
    expect(loadWith({ "grid-oib:langfuseClickhousePassword": "a".repeat(64) })).toBeNull();
  });

  it("refuses a queue password shared with another Redis instance", () => {
    // Every app pod holds the ADR-0020 cache URL. A shared password would let
    // anything that reads one pod's env drain the ingestion queue.
    const error = loadWith({ "grid-oib:langfuseQueuePassword": "df" });
    expect(error?.message).toMatch(/must differ from grid-oib:dragonflyPassword/);
  });

  it("refuses an S3 key shared with a wider-scoped identity", () => {
    // SeaweedFS authenticates by key, so this would hand the Langfuse tier
    // object CRUD across every tenant bucket instead of its own.
    const error = loadWith({ "grid-oib:langfuseS3SecretKey": "s3-secret" });
    expect(error?.message).toMatch(/must differ from grid-oib:seaweedfsSecretKey/);
  });

  it("refuses the tier with NetworkPolicies off — via the dependency it inherits", () => {
    // Langfuse needs policies as much as the dashboard does, but it does not
    // carry its own check: `langfuseEnabled` implies `observabilityEnabled`,
    // whose guard fires first, so a second one could never run. Pinned here so
    // that relaxing the observability guard fails a test that says why rather
    // than silently allowing an exposed trace store.
    const error = loadWith({ "grid-oib:networkPolicies": "false" });
    expect(error?.message).toMatch(/requires grid-oib:networkPolicies/);
  });

  it("skips the tier, rather than half-deploying it, when a credential is missing", () => {
    // Availability = flag AND capability: no throw, no tier.
    expect(loadWith({}, ["grid-oib:langfuseSalt"])).toBeNull();
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...langfuseStackConfig(),
      "grid-oib:langfuseSalt": "",
    });
    expect(loadConfig().langfuse.enabled).toBe(false);
  });

  it("skips the tier when the collector that feeds it is not deployed", () => {
    // Langfuse has no receiver of its own here — without the collector it is
    // four workloads that can only ever sit idle.
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...langfuseStackConfig(),
      "grid-oib:observabilityEnabled": "false",
    });
    expect(loadConfig().langfuse.enabled).toBe(false);
  });

  it("stays off by default", () => {
    pulumi.runtime.setAllConfig(baseStackConfig());
    expect(loadConfig().langfuse.enabled).toBe(false);
  });
});
