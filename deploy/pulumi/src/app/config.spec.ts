import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { schedulerEnv, type AppWiring } from "./config";
import type { GridConfig } from "../config";

const here = __dirname;
// src/app -> src -> deploy/pulumi -> deploy -> repo root
const repoRoot = join(here, "..", "..", "..", "..");
// The whole worker, not just its entrypoint: `db.js` reads the DSN, and the
// point of this guard is to see every name the process consumes.
const schedulerDir = join(repoRoot, "frontends", "ui", "scheduler");
const schedulerSource = readdirSync(schedulerDir)
  .filter((file) => file.endsWith(".js") && !file.endsWith(".spec.js"))
  .map((file) => readFileSync(join(schedulerDir, file), "utf8"))
  .join("\n");
const configSource = readFileSync(join(here, "config.ts"), "utf8");

/** Every `env.GRID_*` / `process.env.GRID_*` the scheduler actually reads. */
function envNamesReadBy(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/(?:process\.)?env\.(GRID_[A-Z0-9_]+)/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * The env names this program EMITS must be the names its consumers READ.
 *
 * This is the bug that shipped Agent Skills as an invisible feature. The
 * scheduler worker and the BFF moved to `GRID_SKILLS_ENABLED` /
 * `GRID_SKILL_SCHEDULER_*` when Workflows was replaced; this file kept emitting
 * `GRID_WORKFLOWS_ENABLED` / `GRID_WORKFLOW_SCHEDULER_*`, whose readers had been
 * deleted. Nothing failed: the stack planned clean, applied clean, every unit
 * suite on both sides passed, and the container started, read an unset start
 * gate and exited 0 exactly as designed. The only symptom was a user saying the
 * tab was not there.
 *
 * A name mismatch across a process boundary cannot be caught by testing either
 * side alone, which is why this test reads the consumer's source rather than a
 * list someone has to remember to update.
 */
describe("schedulerEnv", () => {
  const cfg = {
    skills: { enabled: true, minIntervalMinutes: 15 },
    auth: { enforceFeatureFlags: false },
    observability: { enabled: false },
  } as unknown as GridConfig;
  const env = schedulerEnv({ cfg } as unknown as AppWiring);
  // `EnvVar.name` is `Input<string>`; every entry in this block is a literal.
  const emitted = new Set(
    env.map((e) => e.name).filter((name): name is string => typeof name === "string"),
  );

  it("emits every GRID_ env var the scheduler reads", () => {
    const read = envNamesReadBy(schedulerSource);
    // Sanity: if the extraction stops finding anything, the assertion below
    // would pass vacuously and the guard would be silently dead.
    expect(read.length).toBeGreaterThan(3);
    expect([...read].filter((name) => !emitted.has(name))).toEqual([]);
  });

  it("emits no GRID_ var the scheduler does not read", () => {
    // The other half of the mismatch: a stale name left behind here is how the
    // block LOOKED correct while the gate it was supposed to set stayed unset.
    const read = new Set(envNamesReadBy(schedulerSource));
    const gridEmitted = [...emitted].filter((name) => name.startsWith("GRID_"));
    expect(gridEmitted.filter((name) => !read.has(name))).toEqual([]);
  });

  it("passes the skills gate through, so the worker can start at all", () => {
    expect(env.find((e) => e.name === "GRID_SKILLS_ENABLED")?.value).toBe("true");
  });
});

describe("frontendEnv", () => {
  it("emits the Agent Skills gate", () => {
    // Read from source rather than by calling frontendEnv: it touches most of
    // GridConfig, and a stub deep enough to call it would assert more about the
    // stub than about the program. The name is what matters here.
    expect(configSource).toContain('name: "GRID_SKILLS_ENABLED"');
    expect(configSource).not.toContain('name: "GRID_WORKFLOWS_ENABLED"');
  });

  it("emits the mail import gate under the name the BFF reads", () => {
    // `isMailImportEnabled` in frontends/ui/src/lib/authz/feature-flags.ts.
    const reader = readFileSync(
      join(repoRoot, "frontends", "ui", "src", "lib", "authz", "feature-flags.ts"),
      "utf8",
    );
    expect(reader).toContain("process.env.GRID_MAIL_IMPORT_ENABLED");
    expect(configSource).toContain('name: "GRID_MAIL_IMPORT_ENABLED"');
  });

  it("hands the BFF the GitHub token and the repo it files bug reports into", () => {
    // The names the BFF reads (`lib/github/issues.ts`, `lib/product-feedback/github.ts`).
    expect(configSource).toContain('sref("GRID_GITHUB_TOKEN")');
    expect(configSource).toContain('name: "GRID_FEEDBACK_ISSUES_REPO"');
  });
});

/**
 * Extraction is on because the CODE says so, not because a deployment
 * remembered a flag. Production once set only AIQ_EXTRACT_IMAGES: uncaptioned
 * tables were indexed as garbled page text, and every raster the VLM typed as a
 * chart was analysed, paid for, and dropped. The rule is now "no flag set in a
 * deployment = on", which holds only while the adapter reads each flag as an
 * off-switch. Both halves are checked here, across the process boundary.
 */
describe("backendEnv extraction switches", () => {
  const adapterSource = readFileSync(
    join(repoRoot, "sources", "knowledge_layer", "src", "llamaindex", "adapter.py"),
    "utf8",
  );
  const switches = ["AIQ_EXTRACT_TABLES", "AIQ_EXTRACT_IMAGES", "AIQ_EXTRACT_CHARTS"];

  it("sets none of them, so none can be left off by omission", () => {
    for (const name of switches) {
      expect(configSource).not.toContain(`"${name}"`);
    }
  });

  it("relies on the adapter reading each as on-unless-false", () => {
    for (const name of switches) {
      expect(adapterSource).toContain(`_env_switch("${name}")`);
    }
  });
});
