import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { loadConfig } from "../src/config";
import { installIngestWorker } from "../src/app/ingest-worker";
import { installJobsQueueAuth } from "../src/app/jobs-queue-auth";
import { baseStackConfig } from "../src/test-support/stack-config";

const ROOT = mkdtempSync(join(__dirname, "..", ".validate-crs-test-"));
const KEDA_URL = "https://github.com/kedacore/keda/releases/download/v2.21.0/keda-2.21.0-crds.yaml";
const CNPG_URL = "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/v1.28.0/releases/cnpg-1.28.0.yaml";
const UNKNOWN = "04da6b54-80e4-46f7-8ec5-a065f938c709";
const resources: Array<{ urn: string; inputs: Record<string, unknown> }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      if (args.type.startsWith("kubernetes:keda.sh/")) {
        resources.push({ urn: `urn:pulumi:test::grid-oib::${args.type}::${args.name}`, inputs: args.inputs });
      }
      return { id: `${args.name}-id`, state: args.inputs };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

type Schema = Record<string, unknown>;
const string = { type: "string" };
const integer = { type: "integer" };
const object = (properties: Schema, required: string[] = []): Schema => ({
  type: "object", properties, required,
});
const array = (items: Schema): Schema => ({ type: "array", items });

// Small CRD fixtures test dispatch, version selection and failure handling
// without making CI depend on GitHub availability. Production uses upstream CRDs.
function crd(group: string, kind: string, version: string, spec: Schema): Schema {
  return {
    kind: "CustomResourceDefinition",
    spec: {
      group,
      names: { kind },
      versions: [{
        name: version,
        storage: true,
        schema: { openAPIV3Schema: object({ apiVersion: string, kind: string, metadata: { type: "object" }, spec }, ["spec"]) },
      }],
    },
  };
}

const kedaCrds = [
  crd("keda.sh", "TriggerAuthentication", "v1alpha1", object({
    secretTargetRef: array(object({ parameter: string, name: string, key: string }, ["parameter", "name", "key"])),
  })),
  crd("keda.sh", "ScaledObject", "v1alpha1", object({
    scaleTargetRef: object({ name: string }, ["name"]),
    minReplicaCount: integer,
    maxReplicaCount: integer,
    pollingInterval: integer,
    cooldownPeriod: integer,
    advanced: { type: "object" },
    triggers: array(object({
      type: string,
      metadata: { type: "object", additionalProperties: string },
      authenticationRef: object({ name: string }, ["name"]),
    }, ["type"])),
  }, ["scaleTargetRef", "triggers"])),
];
const cnpgCrds = [
  crd("postgresql.cnpg.io", "Database", "v1", object({
    name: string,
    cluster: object({ name: string }, ["name"]),
  }, ["name", "cluster"])),
];

type Step = { op: string; newState?: { urn: string; inputs: Record<string, unknown> } };
type Plan = { steps: Step[] };
function emittedPlan(): Plan {
  return structuredClone({ steps: resources.map((newState) => ({ op: "create", newState })) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replaceSpec(plan: Plan, kind: string, overrides: Record<string, unknown>): Plan {
  const inputs = plan.steps.find((step) => step.newState?.inputs.kind === kind)?.newState?.inputs;
  if (!inputs || !isRecord(inputs.spec)) throw new Error(`missing ${kind} spec`);
  inputs.spec = { ...inputs.spec, ...overrides };
  return plan;
}

function workspace(): string {
  const dir = mkdtempSync(join(ROOT, "case-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(__dirname, "validate-crs.mjs"), join(dir, "scripts", "validate-crs.mjs"));
  writeFileSync(join(dir, "fetch.mjs"), `
import { readFileSync } from "node:fs";
const releases = JSON.parse(readFileSync(new URL("./releases.json", import.meta.url), "utf8"));
globalThis.fetch = async (url) => {
  console.error("FETCH " + url);
  if (!Object.hasOwn(releases, url)) throw new Error("unexpected schema URL " + url);
  if (process.env.TEST_SCHEMAS_FAILURE === "1") throw new Error("fixture network unavailable");
  return new Response(releases[url], { status: 200 });
};
`);
  return dir;
}

function run(plan: Plan, options: {
  dir?: string;
  keda?: Schema[];
  env?: Record<string, string>;
} = {}) {
  const dir = options.dir ?? workspace();
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(dir, "releases.json"), JSON.stringify({
    [KEDA_URL]: (options.keda ?? kedaCrds).map((doc) => JSON.stringify(doc)).join("\n---\n"),
    [CNPG_URL]: cnpgCrds.map((doc) => JSON.stringify(doc)).join("\n---\n"),
  }));
  return spawnSync(process.execPath, [
    "--import", pathToFileURL(join(dir, "fetch.mjs")).href,
    join(dir, "scripts", "validate-crs.mjs"), join(dir, "plan.json"),
  ], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, ALLOW_SKIP: "", CNPG_SCHEMAS_OPTIONAL: "", ...options.env },
  });
}

beforeAll(async () => {
  pulumi.runtime.setAllConfig({
    ...baseStackConfig(),
    "grid-oib:seaweedfsEncryptVolumeData": "false",
    "grid-oib:observabilityEnabled": "false",
    "grid-oib:langfuseEnabled": "false",
  });
  const cfg = loadConfig();
  const provider = new k8s.Provider("schema-test", { kubeconfig: "apiVersion: v1" });
  const secret = new k8s.core.v1.Secret("schema-test-secret", { metadata: { name: "grid-secrets" } }, { provider });
  const wiring = {
    cfg,
    namespace: "grid",
    provider,
    redisUrl: pulumi.output("redis://dragonfly:6379"),
    seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
    seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
    dsn: () => pulumi.output("postgresql://fixture"),
    imagePullSecrets: [],
  };
  // The ScaledObject names a TriggerAuthentication the program creates once for
  // both claim-queue tiers; both resources are what the validator is shown.
  const auth = installJobsQueueAuth(wiring, []);
  const worker = installIngestWorker(wiring, cfg, { secret, checksum: pulumi.output("fixture-checksum") }, [auth]);
  await new Promise((done) => auth.urn.apply(done));
  await new Promise((done) => worker.scaledObject.urn.apply(done));
  expect(resources.map((resource) => resource.inputs.kind).sort()).toEqual(["ScaledObject", "TriggerAuthentication"]);
}, 30_000);

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("the deploy's CR schema validator", () => {
  it("accepts both KEDA resources emitted by the ingest module, with no skip override", () => {
    const result = run(emittedPlan());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("2 passed, 0 failed, 0 skipped (of 2 custom resources)");
    expect(result.stderr.match(/FETCH /g)).toHaveLength(1);
  });

  it.each([
    ["ScaledObject", { maxReplicaCount: "twelve" }],
    ["ScaledObject", { scaleTargetRef: {} }],
    ["TriggerAuthentication", { secretTargetRef: [{ parameter: "connection", name: "grid-secrets" }] }],
  ])("rejects an invalid %s spec even with ALLOW_SKIP=1", (kind, overrides) => {
    const result = run(replaceSpec(emittedPlan(), kind, overrides), { env: { ALLOW_SKIP: "1" } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("1 passed, 1 failed, 0 skipped");
    expect(result.stderr).toContain("must");
  });

  it("fails closed when KEDA schemas cannot be fetched, even with CNPG's offline override", () => {
    const result = run(emittedPlan(), {
      env: { TEST_SCHEMAS_FAILURE: "1", ALLOW_SKIP: "1", CNPG_SCHEMAS_OPTIONAL: "1" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("0 passed, 2 failed, 0 skipped");
    expect(result.stderr).toContain("KEDA schemas unavailable (fixture network unavailable)");
  });

  it("reuses the release cache without fetching again", () => {
    const dir = workspace();
    const first = run(emittedPlan(), { dir });
    expect(first.status, first.stderr).toBe(0);
    expect(readdirSync(join(dir, ".schemas-cache"))).toEqual([expect.stringMatching(/^keda-crds\.[a-f0-9]{12}\.yaml$/)]);
    const second = run(emittedPlan(), { dir, env: { TEST_SCHEMAS_FAILURE: "1" } });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).not.toContain("FETCH");
  });

  it("fails closed on an unreadable cached schema", () => {
    const dir = workspace();
    const first = run(emittedPlan(), { dir });
    expect(first.status, first.stderr).toBe(0);
    const cacheDir = join(dir, ".schemas-cache");
    writeFileSync(join(cacheDir, readdirSync(cacheDir)[0]), "broken: [");
    const result = run(emittedPlan(), { dir });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("0 passed, 2 failed, 0 skipped");
    expect(result.stderr).toContain("KEDA schemas unavailable");
    expect(result.stderr).not.toContain("FETCH");
  });

  it("rejects a kind missing from the pinned release rather than skipping it", () => {
    const plan = emittedPlan();
    const state = plan.steps[0].newState;
    if (!state) throw new Error("missing resource state");
    state.inputs.kind = "UnknownKedaKind";
    const result = run(plan, { env: { ALLOW_SKIP: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown keda.sh/v1alpha1 kind "UnknownKedaKind"');
  });

  it("selects the requested API version instead of the CRD's storage version", () => {
    const docs = structuredClone(kedaCrds);
    for (const doc of docs) {
      if (!isRecord(doc.spec) || !Array.isArray(doc.spec.versions)) throw new Error("invalid fixture CRD");
      doc.spec.versions.unshift({ name: "v2", storage: true, schema: { openAPIV3Schema: { not: {} } } });
    }
    const result = run(emittedPlan(), { keda: docs });
    expect(result.status, result.stderr).toBe(0);
  });

  it("fails closed when the release has no schemas for the requested version", () => {
    const result = run(emittedPlan(), { keda: [crd("keda.sh", "ScaledObject", "v2", {})] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no schemas for keda.sh/v1alpha1 in the pinned release");
  });

  it("reports elided Pulumi Outputs and continues checking known fields", () => {
    const result = run(replaceSpec(emittedPlan(), "ScaledObject", { cooldownPeriod: UNKNOWN }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 unknown Output field(s) elided");
  });

  it("retains CNPG validation through the shared release loader", () => {
    const plan: Plan = { steps: [{ op: "update", newState: {
      urn: "urn:pulumi:test::grid-oib::kubernetes:postgresql.cnpg.io/v1:Database::database",
      inputs: {
        apiVersion: "postgresql.cnpg.io/v1", kind: "Database",
        metadata: { name: "database" }, spec: { name: "aiq_jobs", cluster: { name: "grid-pg" } },
      },
    } }] };
    const result = run(plan);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 passed, 0 failed, 0 skipped");
    const invalid = run(replaceSpec(plan, "Database", { cluster: {} }));
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("must have required property 'name'");
    const offline = run(plan, { env: { TEST_SCHEMAS_FAILURE: "1", CNPG_SCHEMAS_OPTIONAL: "1" } });
    expect(offline.status, offline.stderr).toBe(0);
    expect(offline.stdout).toContain("0 passed, 0 failed, 1 skipped");
  });

  it("still fails closed on an unregistered group and ignores resources being deleted", () => {
    const plan: Plan = { steps: [{ op: "create", newState: {
      urn: "urn:pulumi:test::grid-oib::kubernetes:unknown.example/v1:Thing::unknown",
      inputs: { apiVersion: "unknown.example/v1", kind: "Thing", metadata: { name: "unknown" }, spec: {} },
    } }] };
    const result = run(plan);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no validator wired for unknown.example/v1");
    const deleted = run({ steps: emittedPlan().steps.map((step) => ({ ...step, op: "delete" })) });
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(deleted.stdout).toContain("0 passed, 0 failed, 0 skipped (of 0 custom resources)");
    expect(deleted.stderr).not.toContain("FETCH");
  });
});
