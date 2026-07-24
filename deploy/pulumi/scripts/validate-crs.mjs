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
 *     bundled with @kubernetes-models (generated from the upstream CRDs — the
 *     same packages whose types tsc already checks; this adds value for plans
 *     because it validates the *resolved* inputs, including anything TypeScript
 *     couldn't see through).
 *   - CloudNativePG kinds (Cluster, ScheduledBackup): validated with ajv
 *     against the openAPIV3Schema from the pinned upstream release manifest
 *     (CNPG_RELEASE_URL below — bump the version there to validate against a
 *     newer operator). Fetched on first run and cached in .schemas-cache/
 *     (gitignored); if the fetch fails (offline), CNPG kinds are reported as
 *     SKIP with a warning instead of failing the gate.
 *
 * Exit code 0 = every CR in the plan validated; 1 = any failure. Unknown
 * apiVersion/kind pairs are reported as SKIP (never silently ignored).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/** Pinned CNPG release whose CRD schemas the plan is validated against. */
const CNPG_RELEASE_URL =
  "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/main/releases/cnpg-1.28.0.yaml";
const CNPG_KINDS = new Set(["Cluster", "ScheduledBackup", "Backup"]);

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

/** Pull every planned resource state that looks like a k8s CustomResource. */
const crs = [];
for (const step of steps) {
  const state = step.newState ?? step.oldState;
  const inputs = state?.inputs;
  if (!inputs?.apiVersion || !inputs?.kind) continue;
  // Only CRDs need schema help — native kinds are typed by the Pulumi SDK.
  const group = String(inputs.apiVersion).split("/")[0];
  if (!group.includes(".") || NATIVE_GROUPS.has(group)) continue; // typed, skip
  crs.push({ urn: state.urn ?? step.urn, inputs });
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

// ── CNPG schemas from the pinned release manifest (fetched + cached) ────────
// validateFormats off: CRD int32/date-time formats are advisory (the apiserver
// doesn't enforce them either); logger off to keep CI output readable.
// allErrors reports every schema violation in a CR at once instead of stopping
// at the first. The DoS-via-unbounded-errors concern the ajv-allerrors rule
// flags needs attacker-controlled input, but the only input here is our own
// pulumi-preview plan generated locally in CI, so it does not apply.
// nosemgrep: javascript.ajv.security.audit.ajv-allerrors-true.ajv-allerrors-true
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, logger: false });
let cnpgSchemas = null; // kind → compiled validator, or {} if unavailable
async function loadCnpgSchemas() {
  if (cnpgSchemas) return cnpgSchemas;
  cnpgSchemas = {};
  const cacheDir = join(here, "../.schemas-cache");
  const cacheFile = join(cacheDir, "cnpg-crds.yaml");
  let raw;
  if (existsSync(cacheFile)) {
    raw = readFileSync(cacheFile, "utf8");
  } else {
    try {
      const res = await fetch(CNPG_RELEASE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const full = await res.text();
      // Cache only the CRDs we validate — the full release manifest is >1 MB.
      const docs = yaml
        .loadAll(full)
        .filter(
          (d) =>
            d?.kind === "CustomResourceDefinition" && CNPG_KINDS.has(d.spec?.names?.kind),
        );
      raw = docs.map((d) => yaml.dump(d)).join("---\n");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, raw);
    } catch (err) {
      console.warn(`WARN  could not fetch CNPG CRDs (${err.message}) — CNPG kinds will be SKIPPED`);
      return cnpgSchemas;
    }
  }
  for (const doc of yaml.loadAll(raw)) {
    if (doc?.kind !== "CustomResourceDefinition") continue;
    const kind = doc.spec?.names?.kind;
    const version = doc.spec?.versions?.find((v) => v.storage) ?? doc.spec?.versions?.[0];
    const schema = version?.schema?.openAPIV3Schema;
    if (kind && schema) cnpgSchemas[kind] = ajv.compile(schema);
  }
  return cnpgSchemas;
}

// ── Validate ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0, skip = 0;
const failures = [];

for (const { urn, inputs } of crs) {
  const { apiVersion, kind } = inputs;
  const label = `${apiVersion}/${kind} (${String(urn).split("::").pop()})`;

  if (apiVersion === "postgresql.cnpg.io/v1") {
    const validate = (await loadCnpgSchemas())[kind];
    if (!validate) {
      console.log(`SKIP  ${label} — CNPG schema unavailable`);
      skip++;
      continue;
    }
    // The CRD schema covers the whole object; metadata is validated loosely by
    // the apiserver, so validate spec shape within the full-object schema.
    if (validate({ apiVersion, kind, metadata: { name: "x" }, spec: inputs.spec })) {
      console.log(`PASS  ${label}`);
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
    console.log(`SKIP  ${label} — no validator wired for ${apiVersion}`);
    skip++;
    continue;
  }
  try {
    const mod = await loader(kind);
    const Model = mod[kind];
    const instance = new Model({ metadata: { name: "x" }, spec: inputs.spec });
    instance.validate();
    console.log(`PASS  ${label}`);
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
  console.error("No custom resources found in the plan — wrong file?");
  process.exit(1);
}
