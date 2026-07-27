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
 *   - CloudNativePG kinds: validated with ajv against the openAPIV3Schema from
 *     the pinned upstream release manifest (CNPG_RELEASE_URL — bump the tag to
 *     validate against a newer operator). Fetched on first run, cached in
 *     .schemas-cache/ (gitignored).
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

/** Pinned CNPG release (tag ref, immutable) whose CRDs the plan is validated against. */
const CNPG_RELEASE_URL =
  "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/v1.28.0/releases/cnpg-1.28.0.yaml";
const CNPG_GROUP = "postgresql.cnpg.io/v1";
const CNPG_KINDS = new Set(["Cluster", "ScheduledBackup", "Backup", "Pooler"]);

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

// ── CNPG schemas from the pinned release manifest (fetched + cached) ────────
// validateFormats off: CRD int32/date-time formats are advisory (the apiserver
// doesn't enforce them either); logger off to keep CI output readable.
// allErrors reports every schema violation in a CR at once instead of stopping
// at the first. The DoS-via-unbounded-errors concern the ajv-allerrors rule
// flags needs attacker-controlled input, but the only input here is our own
// pulumi-preview plan generated locally in CI, so it does not apply.
// nosemgrep: javascript.ajv.security.audit.ajv-allerrors-true.ajv-allerrors-true
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, logger: false });
let cnpgSchemas = null; // kind → compiled validator; null until loaded
let cnpgLoadError = null;
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
      cnpgLoadError = err;
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

  if (apiVersion === CNPG_GROUP) {
    const schemas = await loadCnpgSchemas();
    if (cnpgLoadError) {
      const msg = `CNPG schemas unavailable (${cnpgLoadError.message})`;
      if (process.env.CNPG_SCHEMAS_OPTIONAL === "1") {
        console.log(`SKIP  ${label} — ${msg} [CNPG_SCHEMAS_OPTIONAL=1]`);
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
      // A cnpg.io kind we have no schema for is a typo or a new kind — either
      // way it must not slide through a gate that claims to cover this group.
      console.log(`FAIL  ${label} — no schema for this kind in the pinned CNPG release`);
      failures.push({ label, errors: `unknown ${CNPG_GROUP} kind "${kind}"` });
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
