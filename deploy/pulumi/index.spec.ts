import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { baseStackConfig } from "./src/test-support/stack-config";

/**
 * Does the whole program construct, in both SeaweedFS topologies?
 *
 * `src/data/seaweedfs.spec.ts` asserts the manifests one module at a time.
 * This asserts the thing no per-module test can: that `index.ts` wires them
 * together without a cycle, in either branch of the ordering it now has to
 * choose between (ADR-0043 — Postgres archives WAL into a SeaweedFS bucket,
 * and the split filer keeps its namespace in a Postgres database, so one of
 * the two has to go first and which one depends on the configuration).
 *
 * A dependency cycle in Pulumi is not a compile error and not a type error. It
 * surfaces as `pulumi up` hanging or failing partway through, on a stack that
 * has already started mutating. This runs the same construction with mocked
 * resources, so the cycle — or an undefined value read from a resource created
 * later in the file — shows up in two seconds instead.
 *
 * It does NOT prove the stack deploys. Nothing here contacts an API server.
 */

/** The few manifest fields the assertions below read; mock inputs are untyped. */
type Container = { env?: Array<{ name: string; value?: string }> };
type PodSpec = { spec: { containers: Container[] } };
type Manifest = { spec?: { concurrencyPolicy?: string; template?: PodSpec; jobTemplate?: { spec: { template: PodSpec } } } };

const RESOURCES: Array<{ type: string; name: string; inputs: Manifest }> = [];
let STACK: Record<string, unknown> = {};

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

/**
 * Build the whole stack once, in the split+Postgres configuration — the branch
 * where the ordering is a real cycle and therefore the one worth exercising.
 * `index.ts` runs its work at module scope, so importing it IS the test.
 */
describe("the program constructs in the split topology", () => {
  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:seaweedfsTopology": "split",
      "grid-oib:seaweedfsFilerStore": "postgres",
      "grid-oib:seaweedfsPerOrgBuckets": "true",
      // The configuration that makes the ordering a cycle: Postgres wants the
      // archive bucket to exist before it boots, and the filer wants the
      // Postgres database to exist before IT boots.
      "grid-oib:pgBackupsEnabled": "true",
      "grid-oib:observabilityEnabled": "false",
    });
    const stack = (await import("./index")) as Record<string, unknown>;
    STACK = stack;
    // Importing the module is not enough. Pulumi registers resources
    // asynchronously, so the import resolves before a single `newResource` has
    // fired. Resolving every exported Output drains that queue — which is also
    // the only way a cycle would show up here rather than as a hang on a real
    // `pulumi up`.
    await Promise.all(
      Object.values(stack)
        .filter((v): v is pulumi.Output<unknown> => pulumi.Output.isInstance(v))
        .map((output) => new Promise((resolve) => output.apply(resolve))),
    );
  }, 120_000);

  function named(type: string): string[] {
    return RESOURCES.filter((r) => r.type === type).map((r) => r.name);
  }

  it("creates all three SeaweedFS workloads", () => {
    expect(named("kubernetes:apps/v1:StatefulSet")).toEqual(
      expect.arrayContaining(["seaweedfs-master", "seaweedfs-volume", "seaweedfs-filer"]),
    );
  });

  it("creates the filer's Postgres database and the nightly base backup", () => {
    // The base backup is a separate resource specifically so it can be ordered
    // after bucket-init; if it ever folds back into `installPostgres` it will
    // fire before the archive bucket exists, fail, and not retry until 02:00.
    expect(named("kubernetes:postgresql.cnpg.io/v1:Database")).toEqual(["pg-seaweedfs-filer-db"]);
    expect(named("kubernetes:postgresql.cnpg.io/v1:ScheduledBackup")).toEqual([
      "pg-scheduled-backup",
    ]);
  });

  it("schedules both internal sweeps as CronJobs by default", () => {
    // Both are default-on because what they recover is invisible in the
    // product. A sweep that silently stopped being created would leave the
    // storage alert dead, or the vector store slowly filling with chunks of
    // deleted documents, behind a green `pulumi up`.
    expect(named("kubernetes:batch/v1:CronJob")).toEqual(
      expect.arrayContaining(["storage-alerts", "vector-reconcile"]),
    );
  });

  it("schedules the backend's housekeeping as CronJobs, the only thing that runs it", () => {
    // ADR-0082 step A1. The backend has no loop of its own: a missing CronJob is
    // housekeeping silently gone, which nothing else alerts on.
    const cronJobs = RESOURCES.filter((r) => r.type === "kubernetes:batch/v1:CronJob");
    const housekeeping = cronJobs.filter((r) => r.name.startsWith("housekeeping-"));
    expect(housekeeping.map((r) => r.name).sort()).toEqual([
      "housekeeping-base-corpus",
      "housekeeping-chat-checkpoints",
      "housekeeping-ghost-jobs",
      "housekeeping-job-events",
    ]);
    for (const job of housekeeping) {
      const container = job.inputs.spec?.jobTemplate?.spec.template.spec.containers[0];
      const url = container?.env?.find((e) => e.name === "SWEEP_URL")?.value;
      // The api role serves them (ADR-0082 step B), not the chat tier.
      expect(url).toBe(`http://aiq-api:8000/v1/maintenance/housekeeping/${job.name.replace("housekeeping-", "")}`);
      expect(job.inputs.spec?.concurrencyPolicy).toBe("Forbid");
    }
    // Suspended only while `chromaMigration` is on (index-chroma-migration.spec.ts);
    // written as false otherwise, so switching the flag off resumes the clock.
    const baseCorpus = housekeeping.find((r) => r.name === "housekeeping-base-corpus");
    expect((baseCorpus?.inputs.spec as { suspend?: boolean }).suspend).toBe(false);
    const reconcile = cronJobs.find((r) => r.name === "vector-reconcile");
    expect((reconcile?.inputs.spec as { suspend?: boolean }).suspend).toBe(false);
  });

  it("keeps no files on the web role: no volume claim, nothing mounted at /app/data", () => {
    // ADR-0082 step A2's gate. The base corpus is in the object store and a
    // table, the vectors in the shared Qdrant; a claim here would bring back the
    // one replica's disk an upload could land on.
    const web = RESOURCES.find((r) => r.type === "kubernetes:apps/v1:StatefulSet" && r.name === "aiq-agent");
    const spec = web?.inputs.spec;
    expect(spec).toBeDefined();
    expect(spec?.volumeClaimTemplates).toBeUndefined();
    expect(spec?.persistentVolumeClaimRetentionPolicy).toBeUndefined();
    const containers = spec?.template?.spec.containers ?? [];
    expect(containers.length).toBeGreaterThan(0);
    for (const container of containers) {
      expect(container.volumeMounts ?? []).toEqual([]);
      const env = container.env ?? [];
      expect(env.find((e) => e.name === "AIQ_QDRANT_URL")?.value).toBeDefined();
      for (const gone of ["AIQ_CHROMA_DIR", "OIB_UPLOADS_DIR", "GRID_BASE_CORPUS_STORE"]) {
        expect(env.find((e) => e.name === gone)).toBeUndefined();
      }
    }
    expect(spec?.template?.spec.volumes ?? []).toEqual([]);
  });

  it("runs the backend as two roles: the chat StatefulSet and the api Deployment, Service and HPA", () => {
    // ADR-0082 step B. Each role is its own workload because each rolls, scales
    // and fails on its own signal; a missing api tier is every BFF HTTP call
    // failing behind a green `pulumi up`.
    expect(named("kubernetes:apps/v1:StatefulSet")).toContain("aiq-agent");
    expect(named("kubernetes:apps/v1:Deployment")).toContain("aiq-api");
    expect(named("kubernetes:core/v1:Service")).toEqual(expect.arrayContaining(["aiq-agent", "aiq-api"]));
    expect(named("kubernetes:autoscaling/v2:HorizontalPodAutoscaler")).toContain("aiq-api");

    const role = (type: string, name: string) => {
      const spec = RESOURCES.find((r) => r.type === type && r.name === name)?.inputs.spec;
      const env = spec?.template?.spec.containers[0].env as Array<{ name: string; value?: string }> | undefined;
      return env?.filter((e) => e.name === "GRID_ROLE").map((e) => e.value);
    };
    expect(role("kubernetes:apps/v1:StatefulSet", "aiq-agent")).toEqual(["chat"]);
    expect(role("kubernetes:apps/v1:Deployment", "aiq-api")).toEqual(["api"]);
  });

  it("gives every backend tier the frontend's WorkOS posture, with a client id to validate against", () => {
    // The backend once had neither REQUIRE_AUTH nor WORKOS_CLIENT_ID, so it ran
    // with job ownership off while the frontend required login. Each tier must
    // carry the frontend's value, and the client id must be non-empty: without
    // it the backend has no validator, and with auth required it refuses to boot.
    const envOf = (type: string, name: string) => {
      const spec = RESOURCES.find((r) => r.type === type && r.name === name)?.inputs.spec;
      return (spec?.template?.spec.containers[0].env ?? []) as Array<{ name: string; value?: string }>;
    };
    const valueIn = (env: Array<{ name: string; value?: string }>, name: string) =>
      env.find((e) => e.name === name)?.value;

    const frontend = envOf("kubernetes:apps/v1:Deployment", "frontend");
    // The stack default (`requireAuth`, true): the posture the tiers must match.
    expect(valueIn(frontend, "REQUIRE_AUTH")).toBe("true");
    const tiers = {
      chat: envOf("kubernetes:apps/v1:StatefulSet", "aiq-agent"),
      api: envOf("kubernetes:apps/v1:Deployment", "aiq-api"),
      "agent-worker": envOf("kubernetes:apps/v1:Deployment", "agent-worker"),
      "ingest-worker": envOf("kubernetes:apps/v1:Deployment", "ingest-worker"),
    };
    for (const [tier, env] of Object.entries(tiers)) {
      expect(valueIn(env, "REQUIRE_AUTH"), `${tier} REQUIRE_AUTH`).toBe(valueIn(frontend, "REQUIRE_AUTH"));
      expect(valueIn(env, "WORKOS_CLIENT_ID"), `${tier} WORKOS_CLIENT_ID`).toBe(valueIn(frontend, "WORKOS_CLIENT_ID"));
      expect(valueIn(env, "WORKOS_CLIENT_ID"), `${tier} WORKOS_CLIENT_ID`).toBeTruthy();
    }
  });

  it("gives the frontend the api URL for HTTP and the chat URL for the socket", () => {
    const frontend = RESOURCES.find((r) => r.type === "kubernetes:apps/v1:Deployment" && r.name === "frontend");
    const env = frontend?.inputs.spec?.template?.spec.containers[0].env as Array<{ name: string; value?: string }>;
    const value = (name: string) => env.find((e) => e.name === name)?.value;

    expect(value("BACKEND_URL")).toBe("http://aiq-api:8000");
    expect(value("BACKEND_CHAT_URL")).toBe("http://aiq-agent:8000");
  });

  it("creates the scheduler, because it is the run reconciler's clock", () => {
    // Runs exist without Agent Skills (an escalated chat question is a run with
    // no definition), and the scheduler is what closes the ones whose ending
    // never reached the BFF. Left out, those runs would read "running" forever.
    expect(named("kubernetes:apps/v1:Deployment")).toContain("skill-scheduler");
  });

  it("exports the image refs it deployed, which the staging downgrade guard reads back", () => {
    // `scripts/resolve-image-refs.sh` reads `deployedImages.<service>` from the
    // stack outputs to refuse a deploy that moves a service to an older commit.
    // A renamed output would not fail the deploy; it would turn the guard into
    // a warning, which is how the 09-28 backend downgrade went unnoticed.
    const tag = pulumi.runtime.allConfig()["grid-oib:imageTag"] ?? "latest";
    expect(STACK.deployedImages).toEqual({
      backend: `ghcr.io/grid-check/grid-oib-backend:${tag}`,
      frontend: `ghcr.io/grid-check/grid-oib-frontend:${tag}`,
      web: `ghcr.io/grid-check/grid-oib-web:${tag}`,
    });
  });

  it("deploys the office converter and fences it by default (ADR-0070)", () => {
    // Default-on: without it every Word/Excel/PowerPoint file is download-only,
    // and nothing in a green `pulumi up` says so.
    expect(named("kubernetes:apps/v1:Deployment")).toContain("gotenberg");
    expect(named("kubernetes:core/v1:Service")).toContain("gotenberg");
    expect(named("kubernetes:networking.k8s.io/v1:NetworkPolicy")).toContain(
      "gotenberg-frontend-only",
    );
  });

  it("leaves the geocoder off by default, and the frontend without its URL (ADR-0120)", () => {
    // Prepared, not switched on: a stack opts in with `geocoderEnabled`. A
    // default flip would start a 1 GB download on every stack at the next `up`.
    expect(named("kubernetes:apps/v1:StatefulSet")).not.toContain("geocoder");
    expect(named("kubernetes:networking.k8s.io/v1:NetworkPolicy")).not.toContain("geocoder-frontend-only");
    const frontend = RESOURCES.find((r) => r.type === "kubernetes:apps/v1:Deployment" && r.name === "frontend");
    const env = frontend?.inputs.spec?.template?.spec.containers[0].env ?? [];
    expect(env.length).toBeGreaterThan(0);
    expect(env.map((e) => e.name)).not.toContain("GRID_GEOCODER_URL");
    expect(STACK.geocoderUrl).toBeDefined();
  });

  it("leaves the malware scanner off by default, and the frontend without its URL (ADR-0133)", () => {
    // Prepared, not switched on: a stack opts in with `malwareScanEnabled`.
    // Off, `npm run preview` shows no change, and the BFF fails every scan
    // closed (`not-configured`).
    expect(named("kubernetes:apps/v1:Deployment")).not.toContain("clamav");
    expect(named("kubernetes:core/v1:ConfigMap")).not.toContain("clamav-config");
    expect(named("kubernetes:networking.k8s.io/v1:NetworkPolicy")).not.toContain("clamav-bff-only");
    for (const name of ["frontend", "bff-jobs"]) {
      const deployment = RESOURCES.find((r) => r.type === "kubernetes:apps/v1:Deployment" && r.name === name);
      const env = deployment?.inputs.spec?.template?.spec.containers[0].env ?? [];
      expect(env.length, name).toBeGreaterThan(0);
      expect(env.map((e) => e.name), name).not.toContain("GRID_MALWARE_SCAN_URL");
    }
  });

  /** A workload's pod template, read with the fields the sizing cases need. */
  type SizedPod = {
    metadata: { labels: Record<string, string> };
    spec: {
      topologySpreadConstraints?: Array<{
        maxSkew: number;
        topologyKey: string;
        whenUnsatisfiable: string;
        labelSelector: { matchLabels: Record<string, string> };
      }>;
      containers: Array<{ name: string; resources: { requests: Record<string, string>; limits: Record<string, string> } }>;
    };
  };
  const podOf = (type: string, name: string): SizedPod => {
    const found = RESOURCES.find((r) => r.type === type && r.name === name);
    expect(found, `${type} ${name}`).toBeDefined();
    return (found!.inputs.spec as unknown as { template: SizedPod }).template;
  };

  it("reserves what an ingest worker holds while it parses, not its idle floor", () => {
    // 2026-10: at a 1536Mi request three workers packed onto one 16 GB node,
    // grew to 4-6 GB each against a 6Gi limit, and the node went NotReady.
    const [container] = podOf("kubernetes:apps/v1:Deployment", "ingest-worker").spec.containers;

    expect(container.resources.requests.memory).toBe("4Gi");
    expect(container.resources.limits.memory).toBe("6Gi");
  });

  it("spreads the ingest workers across nodes, softly, by their own pod labels", () => {
    const pod = podOf("kubernetes:apps/v1:Deployment", "ingest-worker");

    expect(pod.spec.topologySpreadConstraints).toEqual([
      {
        maxSkew: 1,
        topologyKey: "kubernetes.io/hostname",
        whenUnsatisfiable: "ScheduleAnyway",
        labelSelector: { matchLabels: pod.metadata.labels },
      },
    ]);
  });

  it("places nothing on a worker group when the stack sets no nodeGroup knob", () => {
    // Dev and any stack without IPAX worker groups: a nodeSelector here would
    // match no node and leave the tier Pending. `index-node-groups.spec.ts`
    // has prod's placement.
    const withSelector = RESOURCES.filter((r) => JSON.stringify(r.inputs).includes('"nodeSelector"'));

    expect(withSelector.map((r) => r.name)).toEqual([]);
  });

  it("deploys Qdrant on a stack that sets no Qdrant knob, and no Chroma (ADR-0115)", () => {
    // The StatefulSet, its two Services and the claims of every Chroma pod are
    // gone; Qdrant is always there. A resource named for Chroma would be the
    // old server coming back.
    expect(RESOURCES.filter((r) => /chroma/i.test(r.name)).map((r) => `${r.type}/${r.name}`)).toEqual([]);
    expect(named("kubernetes:apps/v1:StatefulSet")).toContain("qdrant");
    expect(named("kubernetes:core/v1:Service")).toEqual(expect.arrayContaining(["qdrant", "qdrant-headless"]));
    for (const [type, name] of [
      ["kubernetes:apps/v1:StatefulSet", "aiq-agent"],
      ["kubernetes:apps/v1:Deployment", "aiq-api"],
      ["kubernetes:apps/v1:Deployment", "agent-worker"],
      ["kubernetes:apps/v1:Deployment", "ingest-worker"],
    ]) {
      const env = RESOURCES.find((r) => r.type === type && r.name === name)?.inputs.spec?.template?.spec.containers[0].env;
      const names = (env ?? []).map((e) => e.name);
      expect(names, name).toContain("AIQ_QDRANT_URL");
      expect(names, name).toContain("AIQ_QDRANT_API_KEY");
      expect(names.filter((n) => n.startsWith("AIQ_CHROMA") || n === "AIQ_VECTOR_BACKEND"), name).toEqual([]);
    }
  });

  it("puts nothing of Qdrant's dashboard at the edge on a stack without the Connect application", () => {
    // `qdrantDashboardEnabled` defaults on, but only where the WorkOS Connect
    // application is set (this base stack sets none): without its gate the
    // route would be a public window onto the store, and the stack must render
    // exactly what it rendered before the knob existed.
    // `index-qdrant-dashboard.spec.ts` builds the on side.
    const gateway = RESOURCES.find((r) => r.name === "grid-gateway");
    const listeners = (gateway?.inputs.spec as unknown as { listeners: Array<{ name: string }> }).listeners;
    expect(listeners.map((l) => l.name)).toEqual(["http", "https-app", "https-s3", "https-web"]);
    expect(RESOURCES.filter((r) => /qdrant-dashboard/.test(r.name)).map((r) => r.name)).toEqual([]);
    expect(named("kubernetes:gateway.networking.k8s.io/v1:HTTPRoute")).not.toContain(
      "grid-qdrant-dashboard-route",
    );
    expect(named("kubernetes:gateway.envoyproxy.io/v1alpha1:SecurityPolicy")).toEqual([]);
    expect(named("kubernetes:networking.k8s.io/v1:NetworkPolicy")).not.toContain("allow-edge-to-qdrant-dashboard");
  });

  it("manages no PersistentVolumeClaim, so removing Chroma cannot delete its volume", () => {
    // The old `data-chroma-0` was the StatefulSet's volumeClaimTemplate, kept
    // on delete (`whenDeleted: Retain`), never a resource of this program. A
    // claim resource here would be one a later `up` could delete.
    expect(named("kubernetes:core/v1:PersistentVolumeClaim")).toEqual([]);
  });

  it("leaves project mail off while inboundMailDomain is unset", () => {
    // Off means nothing at Cloudflare and no domain on the frontend, which is
    // what hides the address in the UI. The key map is still wired (empty),
    // so the signed route answers 503 rather than reading an unset variable.
    expect(RESOURCES.filter((r) => r.type.startsWith("cloudflare:"))).toEqual([]);
    const frontend = RESOURCES.find(
      (r) => r.type === "kubernetes:apps/v1:Deployment" && r.name === "frontend",
    );
    const spec = frontend?.inputs.spec as {
      template: { spec: { containers: Array<{ env: Array<{ name: string }> }> } };
    };
    const names = spec.template.spec.containers[0].env.map((e) => e.name);
    expect(names).not.toContain("GRID_INBOUND_MAIL_DOMAIN");
    expect(names).toContain("GRID_INBOUND_MAIL_SIGNING_KEYS");
  });

  it("serves the signed internal routes on a route of their own, mail or not", () => {
    // The family exists before any caller does (PR-C's routes), so its edge
    // ceiling and its exemption from the app buckets do too.
    expect(
      RESOURCES.filter((r) => r.inputs.kind === "HTTPRoute").map(
        (r) => (r.inputs.metadata as { name: string }).name,
      ),
    ).toContain("grid-app-signed");
  });

  it("keeps the S3 endpoint on the name the app tier already uses", () => {
    // A rename here silently removes the `allow-edge-to-seaweedfs` NetworkPolicy
    // from the pods that serve S3, and breaks `SEAWEED_ENDPOINT` for every tier.
    expect(named("kubernetes:core/v1:Service")).toEqual(
      expect.arrayContaining(["seaweedfs", "seaweedfs-master-svc"]),
    );
  });
});
