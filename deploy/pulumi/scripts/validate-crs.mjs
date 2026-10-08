#!/usr/bin/env node
/**
 * Schema-validates every CustomResource in a Pulumi plan against the real
 * upstream CRD schemas — the cluster-free "dry run" for the untyped half of the
 * program (apiextensions.CustomResource fields are NOT checked by tsc).
 *
 * Usage:
 *   pulumi preview --json > plan.json && node scripts/validate-crs.mjs plan.json
 *
 * Validators:
 *   - Gateway API / Envoy Gateway / cert-manager kinds: the runtime validators
 *     bundled with @kubernetes-models (generated from the upstream CRDs).
 *   - CloudNativePG and KEDA kinds: validated with ajv against the
 *     openAPIV3Schema from pinned upstream release manifests. Fetched on first
 *     run, cached in .schemas-cache/ (gitignored).
 *
 * This is a GATE and it fails closed:
 *   - exit 1 on any schema failure;
 *   - exit 1 when a non-native CR has no validator (SKIP) — set ALLOW_SKIP=1
 *     to relax while wiring a new validator;
 *   - exit 1 when the CNPG schemas can't be fetched — set
 *     CNPG_SCHEMAS_OPTIONAL=1 to relax for offline runs.
 *
 * Whole-object checks beyond the spec schema: metadata name/namespace RFC-1123
 * sanity and rejection of unexpected top-level fields (a `hostnames` sitting
 * next to `spec` instead of inside it is a silent no-op on the cluster).
 * Pulumi's unknown-value sentinel (computed Outputs) is elided from the object
 * before validation — such fields can't be checked pre-deploy; they're counted
 * and reported so a PASS with elisions is visible.
 *
 * Delete steps are not validated: a schema-invalid legacy resource must not
 * block the deploy that removes it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

/** Pinned CNPG release (tag ref, immutable) whose CRDs the plan is validated against. */
const CNPG_RELEASE_URL =
  "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/v1.28.0/releases/cnpg-1.28.0.yaml";
const CNPG_GROUP = "postgresql.cnpg.io/v1";
const CNPG_KINDS = new Set(["Cluster", "ScheduledBackup", "Backup", "Pooler", "Database"]);
/**
 * The KEDA release whose CRDs the plan is validated against IS the chart the
 * program installs: one constant, `KEDA_CHART_VERSION` in `src/platform/keda.ts`,
 * read from there so the two cannot be moved apart. (The chart's version is
 * KEDA's own.) Fails closed when the constant cannot be found.
 */
function kedaVersion() {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/platform/keda.ts"), "utf8");
  const version = /KEDA_CHART_VERSION = "(\d+\.\d+\.\d+)"/.exec(source)?.[1];
  if (!version) throw new Error("KEDA_CHART_VERSION not found in src/platform/keda.ts");
  return version;
}
const KEDA_VERSION = kedaVersion();

const RELEASE_SCHEMAS = {
  [CNPG_GROUP]: {
    name: "CNPG",
    prefix: "cnpg",
    url: CNPG_RELEASE_URL,
    kinds: CNPG_KINDS,
    optionalEnv: "CNPG_SCHEMAS_OPTIONAL",
  },
  "keda.sh/v1alpha1": {
    name: "KEDA",
    prefix: "keda",
    url: `https://github.com/kedacore/keda/releases/download/v${KEDA_VERSION}/keda-${KEDA_VERSION}-crds.yaml`,
    kinds: new Set(["TriggerAuthentication", "ClusterTriggerAuthentication", "ScaledObject", "ScaledJob"]),
  },
};

/** Pulumi's preview placeholder for not-yet-known Output values. */
const UNKNOWN_SENTINEL = "04da6b54-80e4-46f7-8ec5-a065f938c709";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const Ajv = require("ajv");

// ── Load the plan ───────────────────────────────────────────────────────────
const planPath = process.argv[2];
if (!planPath) {
  console.error("usage: validate-crs.mjs <pulumi-preview-json-file>");
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const steps = plan.steps ?? [];

/** Native API groups typed by the Pulumi SDK itself — no CR validation needed. */
const NATIVE_GROUPS = new Set([
  "networking.k8s.io",
  "apiextensions.k8s.io",
  "rbac.authorization.k8s.io",
  "storage.k8s.io",
  "policy",
  "autoscaling",
  "batch",
  "apps",
]);

/** Pull every planned (non-delete) resource state that looks like a k8s CR. */
const crs = [];
for (const step of steps) {
  if (step.op === "delete" || step.op === "delete-replaced") continue;
  const state = step.newState;
  const inputs = state?.inputs;
  if (!inputs?.apiVersion || !inputs?.kind) continue;
  const group = String(inputs.apiVersion).split("/")[0];
  if (!group.includes(".") || NATIVE_GROUPS.has(group)) continue; // typed, skip
  crs.push({ urn: state.urn ?? step.urn, inputs });
}

// ── Pre-validation whole-object checks ──────────────────────────────────────
const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const NS_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const TOP_LEVEL_OK = new Set(["apiVersion", "kind", "metadata", "spec", "status"]);

/** Returns a list of structural problems the spec schema alone can't catch. */
function structuralIssues(inputs) {
  const issues = [];
  const md = inputs.metadata ?? {};
  if (md.name !== undefined && md.name !== UNKNOWN_SENTINEL && !NAME_RE.test(md.name)) {
    issues.push(`metadata.name ${JSON.stringify(md.name)} is not a valid DNS-1123 subdomain`);
  }
  if (
    md.namespace !== undefined &&
    md.namespace !== UNKNOWN_SENTINEL &&
    !NS_RE.test(md.namespace)
  ) {
    issues.push(`metadata.namespace ${JSON.stringify(md.namespace)} is not a valid DNS-1123 label`);
  }
  for (const key of Object.keys(inputs)) {
    if (!TOP_LEVEL_OK.has(key)) {
      issues.push(
        `unexpected top-level field "${key}" — did it belong under spec? (the apiserver would silently drop it)`,
      );
    }
  }
  return issues;
}

/** Deep-copy inputs with unknown-Output sentinel fields removed; count elisions. */
function elideUnknowns(value, counter) {
  if (value === UNKNOWN_SENTINEL) {
    counter.n++;
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((v) => elideUnknowns(v, counter)).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const e = elideUnknowns(v, counter);
      if (e !== undefined) out[k] = e;
    }
    return out;
  }
  return value;
}

// ── @kubernetes-models validators (ESM subpath imports) ─────────────────────
const MODEL_PACKAGES = {
  // Subpath exports already map `<Kind>` → `<Kind>.js` — no extension here.
  "gateway.networking.k8s.io/v1": (kind) =>
    import(`@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/${kind}`),
  "gateway.envoyproxy.io/v1alpha1": (kind) =>
    import(`@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/${kind}`),
  "cert-manager.io/v1": (kind) =>
    import(`@kubernetes-models/cert-manager/cert-manager.io/v1/${kind}`),
};

// ── Schemas from pinned release manifests (fetched + cached) ───────────────
// validateFormats off: CRD int32/date-time formats are advisory (the apiserver
// doesn't enforce them either); logger off to keep CI output readable.
// allErrors reports every schema violation in a CR at once instead of stopping
// at the first. The DoS-via-unbounded-errors concern the ajv-allerrors rule
// flags needs attacker-controlled input, but the only input here is our own
// pulumi-preview plan generated locally in CI, so it does not apply.
// nosemgrep: javascript.ajv.security.audit.ajv-allerrors-true.ajv-allerrors-true
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, logger: false });
const releaseSchemas = new Map();
async function loadReleaseSchemas(apiVersion) {
  if (releaseSchemas.has(apiVersion)) return releaseSchemas.get(apiVersion);
  const release = RELEASE_SCHEMAS[apiVersion];
  const result = { schemas: {}, error: null };
  releaseSchemas.set(apiVersion, result);
  const cacheDir = join(here, "../.schemas-cache");
  // The cache stores ONLY the kinds selected at write time, so its identity is
  // (release URL, kind set) — not just the group. Without that in the filename, a
  // checkout carrying a cache written before a kind was added takes the
  // `existsSync` branch, finds no schema for the new kind, and FAILS the gate
  // with "no schema for this kind in the pinned CNPG release" — a wrong answer
  // that `rm -rf .schemas-cache` fixes and nothing in the output suggests.
  const cacheKey = createHash("sha256")
    .update(release.url)
    .update("\u0000")
    .update([...release.kinds].sort().join(","))
    .digest("hex")
    .slice(0, 12);
  const cacheFile = join(cacheDir, `${release.prefix}-crds.${cacheKey}.yaml`);
  try {
    let raw;
    const cached = existsSync(cacheFile);
    if (cached) {
      raw = readFileSync(cacheFile, "utf8");
    } else {
      const res = await fetch(release.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const full = await res.text();
      // Cache only the CRDs we validate — the full release manifest is >1 MB.
      const docs = yaml
        .loadAll(full)
        .filter(
          (d) =>
            d?.kind === "CustomResourceDefinition" &&
            d.spec?.group === apiVersion.split("/")[0] &&
            release.kinds.has(d.spec?.names?.kind),
        );
      raw = docs.map((d) => yaml.dump(d)).join("---\n");
    }
    for (const doc of yaml.loadAll(raw)) {
      if (doc?.kind !== "CustomResourceDefinition") continue;
      if (doc.spec?.group !== apiVersion.split("/")[0]) continue;
      const kind = doc.spec?.names?.kind;
      const version = doc.spec?.versions?.find((v) => v.name === apiVersion.split("/")[1]);
      const schema = version?.schema?.openAPIV3Schema;
      if (release.kinds.has(kind) && schema) result.schemas[kind] = ajv.compile(schema);
    }
    if (!Object.keys(result.schemas).length) {
      throw new Error(`no schemas for ${apiVersion} in the pinned release`);
    }
    if (!cached) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, raw);
    }
  } catch (err) {
    result.error = err;
  }
  return result;
}

// ── Validate ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0, skip = 0;
const failures = [];

for (const { urn, inputs } of crs) {
  const { apiVersion, kind } = inputs;
  const label = `${apiVersion}/${kind} (${String(urn).split("::").pop()})`;

  const issues = structuralIssues(inputs);
  if (issues.length) {
    console.log(`FAIL  ${label}`);
    failures.push({ label, errors: issues });
    fail++;
    continue;
  }

  const unknowns = { n: 0 };
  const cleaned = elideUnknowns(inputs, unknowns);
  const suffix = unknowns.n ? `  (${unknowns.n} unknown Output field(s) elided)` : "";
  const object = {
    apiVersion,
    kind,
    metadata: cleaned.metadata ?? { name: "placeholder" },
    spec: cleaned.spec,
  };

  const release = RELEASE_SCHEMAS[apiVersion];
  if (release) {
    const { schemas, error } = await loadReleaseSchemas(apiVersion);
    if (error) {
      const msg = `${release.name} schemas unavailable (${error.message})`;
      if (release.optionalEnv && process.env[release.optionalEnv] === "1") {
        console.log(`SKIP  ${label} — ${msg} [${release.optionalEnv}=1]`);
        skip++;
      } else {
        console.log(`FAIL  ${label} — ${msg}; the gate fails closed`);
        failures.push({ label, errors: msg });
        fail++;
      }
      continue;
    }
    const validate = schemas[kind];
    if (!validate) {
      // A registered kind we have no schema for is a typo or a new kind — either
      // way it must not slide through a gate that claims to cover this group.
      console.log(`FAIL  ${label} — no schema for this kind in the pinned ${release.name} release`);
      failures.push({ label, errors: `unknown ${apiVersion} kind "${kind}"` });
      fail++;
      continue;
    }
    if (validate(object)) {
      console.log(`PASS  ${label}${suffix}`);
      pass++;
    } else {
      console.log(`FAIL  ${label}`);
      failures.push({ label, errors: validate.errors });
      fail++;
    }
    continue;
  }

  const loader = MODEL_PACKAGES[apiVersion];
  if (!loader) {
    if (process.env.ALLOW_SKIP === "1") {
      console.log(`SKIP  ${label} — no validator wired for ${apiVersion} [ALLOW_SKIP=1]`);
      skip++;
    } else {
      console.log(`FAIL  ${label} — no validator wired for ${apiVersion}; the gate fails closed`);
      failures.push({ label, errors: `no validator for ${apiVersion} — wire one or set ALLOW_SKIP=1` });
      fail++;
    }
    continue;
  }
  try {
    const mod = await loader(kind);
    const Model = mod[kind];
    const instance = new Model({ metadata: object.metadata, spec: object.spec });
    instance.validate();
    console.log(`PASS  ${label}${suffix}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${label}`);
    failures.push({ label, errors: String(err?.message ?? err).slice(0, 2000) });
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped (of ${crs.length} custom resources)`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) {
    console.error(`\n--- ${f.label} ---`);
    console.error(typeof f.errors === "string" ? f.errors : JSON.stringify(f.errors, null, 2));
  }
  process.exit(1);
}
if (crs.length === 0) {
  console.warn("No custom resources changed in this plan — nothing to validate.");
  process.exit(0);
}
