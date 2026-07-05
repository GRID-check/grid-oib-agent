# Testing & verification workflow

> How to verify changes on this project. The host toolchain is unreliable for JS,
> so verification runs in containers / the project venv. This is the workflow the
> repo's CI and contributors follow.

## Why not just `npm install` / `npm test`?

Host `npm install`/`npm ci` is unreliable on this project (observed hanging), so
the frontend is typechecked and tested inside a **throwaway Docker image** built
from `frontends/ui/Dockerfile.typecheck` (public `node:22-slim`, no registry auth).
The dependency layer caches, so source-only reruns are fast.

## Frontend

```bash
cd frontends/ui
# build the throwaway image (deps layer caches after the first run)
docker build -q -f Dockerfile.typecheck -t grid-tsc .

# typecheck (tsc --noEmit)
docker run --rm grid-tsc

# run the test suite (vitest)
docker run --rm grid-tsc npx vitest run

# iterate without rebuilding: bind-mount your working src over the image's
docker run --rm -v "$PWD/src:/app/src" grid-tsc npx vitest run <path/to/spec>
```

**Important:** the UI `tsconfig` includes test files, so **spec type errors block
the production `next build`**. A green `tsc` in the image means the build will
typecheck.

## Backend

Use the project virtualenv directly (uv can hang on cross-filesystem sync on some
hosts, so prefer the venv binaries):

```bash
.venv/Scripts/python.exe -m py_compile <changed files>     # syntax
.venv/Scripts/ruff.exe check <changed files>               # lint
.venv/Scripts/ruff.exe format --check <changed files>      # format
.venv/Scripts/python.exe -m pytest tests/                  # tests
```

The purger (Node) has its own specs under `frontends/ui/purger/*.spec.mjs`, run via
the same frontend image: `docker run --rm grid-tsc npx vitest run purger`.

## What "verified" means here

- **Static verification** (typecheck + lint + unit tests) is the bar for most
  changes and is what the container/venv commands above provide.
- **Runtime verification** — driving the running stack end-to-end — requires the
  full Compose stack with real API keys and is developer-run (the stack is not
  auto-started in this workflow). Changes with runtime-only behavior (WS flows,
  auth, deletion) should be smoke-tested against a running stack before release.

## Before opening a PR

- Frontend `tsc` green + affected suites green (in the image).
- Backend `py_compile` + `ruff` clean + affected `pytest` green.
- Docs updated per the obligation in [`../../AGENTS.md`](../../AGENTS.md).
