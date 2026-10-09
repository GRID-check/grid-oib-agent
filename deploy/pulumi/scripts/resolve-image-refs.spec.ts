import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The staging image resolver and its downgrade guard, run as the workflow runs
 * them: bash, a real git history, and stubs for everything that would touch the
 * network (`pulumi`, the GHCR lookup, `curl`).
 *
 * On 09-28 the deploy resolved the backend from the Actions run index, which
 * returned a list without the newest build, and pinned a 09-11 image. Nothing
 * compared that to what was running. These cases pin both halves: resolution
 * from git + registry, and the refusal to move a service backwards.
 */

const SCRIPTS = __dirname;
const ROOT = mkdtempSync(join(tmpdir(), "resolve-image-refs-"));
const REPO = join(ROOT, "repo");
const BIN = join(ROOT, "bin");

// Commits by name. Develop's first-parent line is c1 c2 c3 m4 c5; `side` was
// merged by m4 and is on develop's history but NOT its first-parent line, so
// CI never published images for it.
const C: Record<string, string> = {};

const GIT_ENV = {
  ...process.env,
  HOME: ROOT,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, env: GIT_ENV, encoding: "utf8" }).trim();
}

function commit(name: string): void {
  git("commit", "--allow-empty", "-q", "-m", name);
  C[name] = git("rev-parse", "HEAD");
}

function stub(name: string, body: string): void {
  const path = join(BIN, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  execFileSync("mkdir", ["-p", REPO, BIN]);
  git("init", "-q", "-b", "develop");
  commit("c1");
  commit("c2");
  git("checkout", "-q", "-b", "side");
  commit("side");
  git("checkout", "-q", "develop");
  commit("c3");
  git("merge", "-q", "--no-ff", "-m", "m4", "side");
  C.m4 = git("rev-parse", "HEAD");
  commit("c5");

  // `pulumi stack output --json` prints $STUB_OUTPUTS, or fails on demand.
  stub(
    "pulumi",
    [
      '[ "$1 $2" = "stack output" ] || exit 64',
      '[ -z "${STUB_PULUMI_FAIL:-}" ] || exit 1',
      'out="${STUB_OUTPUTS:-}"; [ -n "$out" ] || out="{}"',
      "printf '%s' \"$out\"",
    ].join("\n"),
  );
  // The registry: $STUB_PUBLISHED holds "service tag" lines. Same contract as
  // find-published-tag.sh — first published tag in argument order, exit 1 for
  // none, exit 2 when the registry "fails".
  stub(
    "find-published-tag",
    [
      '[ -z "${STUB_REGISTRY_DOWN:-}" ] || exit 2',
      'service="$2"; shift 2',
      'for tag in "$@"; do',
      '  if printf \'%s\\n\' "${STUB_PUBLISHED:-}" | grep -qxF "$service $tag"; then echo "$tag"; exit 0; fi',
      "done",
      "exit 1",
    ].join("\n"),
  );
  // curl, for find-published-tag.sh itself: the token endpoint answers a
  // token, a manifest HEAD answers the code listed in $STUB_CURL_CODES
  // ("<image path>:<tag> <code>" lines), 404 when unlisted.
  stub(
    "curl",
    [
      'url=""; for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done',
      'case "$url" in',
      '  *"/token?"*) echo \'{"token":"t"}\' ;;',
      '  *"/manifests/"*)',
      '    key="${url#https://ghcr.io/v2/}"; key="${key/\\/manifests\\//:}"',
      '    code="$(printf \'%s\\n\' "${STUB_CURL_CODES:-}" | awk -v k="$key" \'$1 == k { print $2 }\')"',
      '    printf \'%s\' "${code:-404}" ;;',
      "esac",
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

type Run = { status: number | null; stdout: string; stderr: string };

function run(script: string, env: Record<string, string>, args: string[] = []): Run {
  const result = spawnSync("bash", [join(SCRIPTS, script), ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...GIT_ENV,
      PATH: `${BIN}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY_OWNER: "GRID-check",
      GITHUB_REPOSITORY: "GRID-check/grid-oib-agent",
      GITHUB_ACTOR: "ci",
      GH_TOKEN: "token",
      FIND_PUBLISHED_TAG: join(BIN, "find-published-tag"),
      RUN_ID: "",
      EXPLICIT_TAG: "",
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const ref = (service: string, commitName: string) =>
  `ghcr.io/grid-check/grid-oib-${service}:sha-${C[commitName]}`;

/** Every service published at `commitName`, as "service tag" lines. */
const publishedAt = (...commitNames: string[]) =>
  commitNames
    .flatMap((n) => ["backend", "frontend", "web"].map((s) => `${s} sha-${C[n]}`))
    .join("\n");

const deployed = (refs: Record<string, string>) => JSON.stringify({ deployedImages: refs });

function resolve(env: Record<string, string>): Run {
  return run("resolve-image-refs.sh", { DEPLOY_SHA: C.c5, ...env });
}

function pinned(out: Run): Record<string, string> {
  return Object.fromEntries(
    out.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2) as [string, string]),
  );
}

describe("resolve-image-refs.sh", () => {
  it("picks the deploy commit's own image when the registry has it", () => {
    const out = resolve({ STUB_PUBLISHED: publishedAt("c3", "c5") });
    expect(out.status, out.stderr).toBe(0);
    expect(pinned(out)).toEqual({
      BACKEND_IMAGE_REF: ref("backend", "c5"),
      FRONTEND_IMAGE_REF: ref("frontend", "c5"),
      WEB_IMAGE_REF: ref("web", "c5"),
    });
  });

  it("walks past a commit whose publish failed to the newest tagged one", () => {
    // c5 and m4 have no tags: their publish failed (the PyPI timeout of run
    // 36411247085) or built nothing for this service.
    const out = resolve({ STUB_PUBLISHED: publishedAt("c3") });
    expect(out.status, out.stderr).toBe(0);
    expect(pinned(out).BACKEND_IMAGE_REF).toBe(ref("backend", "c3"));
  });

  it("walks develop's first-parent line only, never a merged branch's commits", () => {
    const out = resolve({ STUB_PUBLISHED: [publishedAt("c2"), `backend sha-${C.side}`].join("\n") });
    expect(out.status, out.stderr).toBe(0);
    expect(pinned(out).BACKEND_IMAGE_REF).toBe(ref("backend", "c2"));
  });

  it("pins every service to the deploy commit when a green CI run triggered it, without asking the registry", () => {
    // CI tags all three images for a commit only once every check passed, so
    // a green run means the tags exist (the workflow verifies them before
    // this runs). An older commit in the registry must not win.
    const out = resolve({ RUN_ID: "123", STUB_PUBLISHED: publishedAt("c3") });
    expect(out.status, out.stderr).toBe(0);
    expect(pinned(out)).toEqual({
      BACKEND_IMAGE_REF: ref("backend", "c5"),
      FRONTEND_IMAGE_REF: ref("frontend", "c5"),
      WEB_IMAGE_REF: ref("web", "c5"),
    });
  });

  it("refuses to move a service to a commit older than the one deployed", () => {
    // The 09-28 incident: c5's backend is running, and resolution came back
    // with an older image.
    const out = resolve({
      STUB_PUBLISHED: [publishedAt("c3"), `frontend sha-${C.c5}`, `web sha-${C.c5}`].join("\n"),
      STUB_OUTPUTS: deployed({
        backend: ref("backend", "c5"),
        frontend: ref("frontend", "c3"),
        web: ref("web", "c3"),
      }),
    });
    expect(out.status).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("::error::backend: refusing to downgrade");
    expect(out.stderr).toContain(ref("backend", "c5"));
    expect(out.stderr).toContain(ref("backend", "c3"));
    // Every service is still reported, so the log shows the whole picture.
    expect(out.stderr).toContain(`frontend: ${ref("frontend", "c3")} -> ${ref("frontend", "c5")}`);
  });

  it("lets an operator's explicit rollback go backwards, with a warning", () => {
    const tag = `sha-${C.c2}`;
    const out = resolve({
      EXPLICIT_TAG: tag,
      STUB_OUTPUTS: deployed({
        backend: ref("backend", "c5"),
        frontend: ref("frontend", "c5"),
        web: ref("web", "c5"),
      }),
    });
    expect(out.status, out.stderr).toBe(0);
    expect(pinned(out).BACKEND_IMAGE_REF).toBe(ref("backend", "c2"));
    expect(out.stderr).toContain("::warning::backend: operator rollback");
  });

  it("allows, with a warning, when the deployed ref is not a sha tag", () => {
    const out = resolve({
      STUB_PUBLISHED: publishedAt("c3"),
      STUB_OUTPUTS: deployed({
        backend: "ghcr.io/grid-check/grid-oib-backend:latest",
        frontend: "ghcr.io/grid-check/grid-oib-frontend:latest",
        web: "ghcr.io/grid-check/grid-oib-web:latest",
      }),
    });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain("::warning::backend: deployed ref 'ghcr.io/grid-check/grid-oib-backend:latest'");
    expect(out.stderr).toContain(`backend: ghcr.io/grid-check/grid-oib-backend:latest -> ${ref("backend", "c3")}`);
  });

  it("allows, with a warning, before the stack has ever recorded its images", () => {
    const out = resolve({ STUB_PUBLISHED: publishedAt("c3") });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain(`backend: unknown -> ${ref("backend", "c3")}`);
    expect(out.stderr).toContain("::warning::backend:");
  });

  it("allows, with a warning, a deployed commit this checkout does not have", () => {
    const stranger = "ab".repeat(20);
    const out = resolve({
      STUB_PUBLISHED: publishedAt("c3"),
      STUB_OUTPUTS: deployed({
        backend: `ghcr.io/grid-check/grid-oib-backend:sha-${stranger}`,
        frontend: ref("frontend", "c3"),
        web: ref("web", "c3"),
      }),
    });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain(`::warning::backend: the deployed commit ${stranger} is not in this checkout`);
  });

  it("fails rather than guess when the registry cannot answer", () => {
    const out = resolve({ STUB_REGISTRY_DOWN: "1", STUB_PUBLISHED: publishedAt("c3") });
    expect(out.status).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("refusing to guess an older image");
  });

  it("fails when the deployed images cannot be read at all", () => {
    const out = resolve({ STUB_PULUMI_FAIL: "1", STUB_PUBLISHED: publishedAt("c5") });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("could not read the stack outputs");
  });

  it("keeps the deployed ref when no image is found in the walk", () => {
    const keep = ref("backend", "c1");
    const out = resolve({
      RESOLVE_DEPTH: "2",
      STUB_PUBLISHED: publishedAt("c1"),
      STUB_OUTPUTS: deployed({ backend: keep, frontend: ref("frontend", "c1"), web: ref("web", "c1") }),
    });
    expect(out.status, out.stderr).toBe(0);
    expect(pinned(out).BACKEND_IMAGE_REF).toBe(keep);
    expect(out.stderr).toContain("::warning::backend: no image in the last 2 develop commits");
  });
});

describe("find-published-tag.sh", () => {
  const find = (codes: string, ...tags: string[]) =>
    run("find-published-tag.sh", { STUB_CURL_CODES: codes }, ["GRID-check", "backend", ...tags]);

  it("prints the first tag GHCR answers 200 for, stepping over 404s", () => {
    const out = find("grid-check/grid-oib-backend:sha-b 200\ngrid-check/grid-oib-backend:sha-c 200", "sha-a", "sha-b", "sha-c");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout.trim()).toBe("sha-b");
  });

  it("exits 1 when every tag is a 404", () => {
    expect(find("", "sha-a", "sha-b").status).toBe(1);
  });

  it("exits 2 on any other status, so a registry error never reads as 'not built'", () => {
    const out = find("grid-check/grid-oib-backend:sha-a 503", "sha-a", "sha-b");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("HTTP 503");
  });
});

describe("verify-image-tag.sh", () => {
  const all = (tag: string, code: string) =>
    ["backend", "frontend", "web"].map((s) => `grid-check/grid-oib-${s}:${tag} ${code}`).join("\n");

  it("passes when all three images carry the tag", () => {
    const out = run("verify-image-tag.sh", { STUB_CURL_CODES: all("sha-a", "200") }, ["GRID-check", "sha-a"]);
    expect(out.status, out.stdout + out.stderr).toBe(0);
  });

  it("fails when one image lacks it", () => {
    const codes = all("sha-a", "200").replace("grid-oib-web:sha-a 200", "grid-oib-web:sha-a 404");
    const out = run("verify-image-tag.sh", { STUB_CURL_CODES: codes }, ["GRID-check", "sha-a"]);
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("not published for grid-oib-web");
  });
});
