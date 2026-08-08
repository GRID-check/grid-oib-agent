# Grid Agent Contributor Guide

This repo is the Grid-branded AI-Q agent worktree. It contains a Next.js UI, a Python backend using the NeMo Agent Toolkit, and a custom OIB knowledge source.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch/commit/PR-title conventions, local validation steps, the CI merge gate, and secret-scanning + doc-link hygiene.

## Working style: prefer visuals

The maintainer values visual explanations. When explaining architecture, data
flows, deployment topology, sequence/interaction, or any non-trivial design,
render a diagram with the **Excalidraw** tool (`create_view`) rather than
describing it in prose alone. Keep diagrams structured: a clear layered/left-to
-right flow, aligned grid, orthogonal arrows that don't cross boxes, and a short
legend. Offer a diagram proactively for architecture/design discussions.

## Working style: fix causes, not symptoms

Solve the problem at the level it actually exists. A change that makes a number
better without changing what produced it is a bandage, and it makes the real
fault harder to see later because the signal that pointed at it is gone.

The test that surfaced this: `InputArea.spec.tsx` took 45.9s of the UI suite's
209.6s of test execution. Three fixes were available.

| | what it does | level |
|---|---|---|
| Raise the shard count | spreads the same work over more runners | hides it |
| Split the spec file | spreads the same work over more shards | hides it |
| Decompose the component | removes the work | fixes it |

The first two move a 172ms-per-test mount around; only the third makes it stop
costing 172ms. The slow test was never the problem — it was the readout on a
1999-line component that needed eleven mocked modules to render at all. Optimise
that away and the design fault is still there, minus the evidence.

The cause is specific and this repo already solves it elsewhere. 37 of those 102
tests assert on *logic* — mention rules, addressee resolution, draft persistence
— and each mounts the whole React tree to do it, because the logic lives in the
render function. Compare two specs in the same suite:

| spec | tests | test time | per test |
|------|-------|-----------|----------|
| `layout/lib/source-presets.spec.ts` (logic in a module) | 10 | 13ms | **1.3ms** |
| `layout/components/InputArea.spec.tsx` (logic in a component) | 102 | 17,550ms | **172ms** |

132x, from nothing but where the code sits. `src/features/layout/lib/` is the
established pattern — pure modules with their own fast specs. Extend it rather
than reaching for shards.

So: before optimising a measurement, establish what the measurement is *of*.
Ask what would have to be true for this number to be legitimate, and if it
isn't, fix that instead. When a fast fix and a correct fix disagree, take the
correct one or say plainly that you are deferring it and why — never ship the
fast one described as the correct one.

Corollary, learned the same way: verify the cause before acting on it. Two
plausible explanations for that 172ms (userEvent's default keystroke delay, an
unmocked motion library) were both measured and both wrong. A cause that has not
been measured is a guess, and a fix built on a guess is a bandage even when it
happens to work.

## Repository layout

| Path | Purpose |
|------|---------|
| `.devcontainer/` | VS Code dev container configuration |
| `src/aiq_agent/` | Backend agent (LangGraph agents, cards, knowledge layer) |
| `sources/` | NAT data-source packages (web search, knowledge layer, RIS adapter, grid cards) |
| `frontends/ui/` | Next.js app: UI + BFF API routes + WS proxy (`server.js`) |
| `frontends/web/` | Public Piloti landing page + blog (Astro microservice; `de`/`en`, Keystatic CMS for platform-owner blog writing) |
| `frontends/aiq_api/` | The backend FastAPI front-end plugin (`_type: aiq_api`): REST routes, async jobs, `/v1/ingest` |
| `frontends/debug/` | Debug console mounted at `/debug` |
| `frontends/cli/` | `aiq-research` CLI |
| `frontends/benchmarks/` | Evaluation harnesses |
| `configs/` | Workflow configs. **LLM-agnostic** — any OpenAI-compatible endpoint (set `base_url`/key per config). **`config_oib_openrouter.yml` is the working reference config** (`config_grid_oib.yml`/Kimi is currently unmaintained). The `model_name` values are only the **boot fallback**: the live default per agent group is admin-controlled (Platform → Models, `platform_model_defaults`) and a tenant may override it (Organization → Models) — see `docs/architecture/org-model-configuration.md`. Do not edit the YAML to move the fleet to a new model. |
| `deploy/` | Docker Compose assets and environment templates; `deploy/pulumi/` holds the Pulumi (TypeScript) Kubernetes deployment (see `docs/deployment/kubernetes.md`) |
| `docs/architecture/` | Architecture docs (see `backend-deep-dive.md`, `project-memory-design.md`, `citation-system-audit-2026-07.md` for the citation pipeline as built) |
| `skills/` | API-consumer skill examples |
| `scripts/` | Utility scripts, including `scripts/ingest_oib.py` |
| `data/oib/` | OIB Richtlinien PDFs, tracked with Git LFS |

## Verification workflow

Host-native checks are the default; Docker is not required. Every command lives
in the root `Taskfile.yml` and is run with [go-task](https://taskfile.dev)
(`npm i -g @go-task/cli`), from the repo root, on any OS:

| Check | Command |
|-------|---------|
| **Everything CI runs** (repo lint + `be:verify` + `fe:verify` + `web:verify` + `infra:types`) | `task verify` |
| The same set, minus only the slow production build | `task verify:fast` |
| First-time toolchain setup | `task setup` |
| Frontend typecheck | `task fe:types` |
| Frontend tests | `task fe:test` |
| Frontend lint / build | `task fe:lint` / `task fe:build` |
| Backend lint (ruff check + format) | `task be:lint` |
| Backend tests | `task be:test` (plugin suite: `task be:test:api`) |
| Infra typecheck (Pulumi + policy pack) | `task infra:types` |
| Web check (Astro typecheck + build) | `task web:verify` |
| Repo lint (pre-commit, all files) | `task lint:repo` |
| UI screenshot evidence | `task fe:screenshots [-- <id>]` → PNGs in `frontends/ui/visual/screenshots/` |
| Tenant-isolation suite (throwaway Postgres, restricted role) | `task db:test:rls` |
| WorkOS authz drift | `WORKOS_API_KEY=sk_… task fe:provision:authz` (read-only; `-- --apply` reconciles) |

`task --list` is the full, always-current list. CI calls these same tasks
(`.github/workflows/ci.yml`), so there is no second copy of the commands to
drift out of sync. One caveat: `task db:test:rls` is a required merge check but
is NOT part of `task verify` (it needs PostgreSQL server binaries), so run it
separately when you touch the tenant boundary.

CI *distributes* them differently, though: the frontend tier's lint, types and
build run in one job while the suite is sharded four ways (`fe:test:shard`) and
stitched back together by `fe:test:merge` for the coverage comment. The commands
are still the Taskfile's — only the scheduling differs, because run in series on
one runner the tests were ~63% of the job's wall clock. Locally `task fe:verify`
still runs all four in order.

The tasks also absorb two things that used to have to be remembered: the venv
lives in `.venv/Scripts` on Windows and `.venv/bin` elsewhere, and **backend
tests need `PYTHONPATH=src`** (otherwise pytest resolves `aiq_agent` from
whatever the venv has installed — possibly another worktree — and validates the
wrong code while appearing to pass). Both are set in `Taskfile.yml`; if you
bypass the tasks and call `pytest` directly, you own them again.

Note: the UI tsconfig includes test files, so spec type errors block the production `next build`.

**Visual screenshots (UI evidence).** User-visible UI changes are "done" only
with a committed screenshot. This repo has a reproducible harness: a registry
(`frontends/ui/visual/registry.mjs`) of `/dev/*` preview routes that render real
components with fixture data (no backend), captured in light + dark by
`task fe:screenshots`. When you build a user-visible surface, add a `/dev/<name>`
preview route + a registry target and commit the resulting PNGs. The
`visual-coverage` workflow nudges (comment-only, phase 1) when a PR adds a
component without that evidence — opt out non-visual components with a
`// no-visual: <reason>` marker. Full playbook
(dark-mode `.dark` class, module-scope fetch shims, pre-installed Chromium):
**`docs/ux/visual-screenshots.md`**.

**Security & static analysis (free, runs entirely in CI).** `.github/workflows/security.yml` runs on push/PR + weekly: **Semgrep** (SAST for Python/TS/JS/Actions — replaces CodeQL and Sonar's security rules), **OSV-Scanner** (dependency CVEs from lockfiles — replaces Sonar SCA), **pip-audit + npm audit**, **gitleaks** (secret scan, full history), and **trivy** (`image-scan` job: blocks on **fixable** HIGH/CRITICAL findings — it runs with `--ignore-unfixed` — in the digest-pinned observability images from `deploy/pulumi/src/config.ts`; findings inside those upstream images that no digest bump can clear go in `.trivyignore.yaml` as time-boxed exceptions with a justification and an `expired_at`, never by loosening the gate). No GitHub Advanced Security licence or SonarQube Cloud subscription needed. Semgrep and OSV-Scanner are currently non-blocking (Phase 1: findings in the job log while noise is tuned via `.semgrepignore` / `.gitleaks.toml`); drop their `continue-on-error` to make them required checks. **Dependabot** (`.github/dependabot.yml`) opens the dependency fix PRs. Code smells / maintainability are covered by the native linters and the coverage gate in `ci.yml` (ruff, eslint, `--cov-fail-under`); note this drops Sonar's **clean-as-you-code** gate, so the `PLR09xx` refactor rules ruff ignores (too-many-arguments/branches/statements) are no longer reported on new code.

## Authorization (RBAC)

The access model is **permission-driven, never role-name driven** (ADR-0016,
ADR-0038). Three things to know before touching it:

1. **`frontends/ui/src/lib/authz/catalog.ts` is the source of truth** for every
   resource type, permission and role. The app derives its permission types from
   it and `bun run provision:authz` applies it to WorkOS, so the code and the
   identity provider cannot drift apart. Add a permission there first.
2. **Every `app/api` route must declare how it is authorized.** `apiRoute` does
   not compile without an `authz` option — `{ permission }` (factory-checked),
   `{ enforcedBy }` (the service authorizes; name the function), or
   `{ sessionOnly, why }`. `src/app/api/authz-coverage.spec.ts` fails when a
   handler escapes the factories entirely.
3. **`lib/authz/decide.ts` is the single decision point** across the org,
   platform, project and workflow tiers. Every decision carries the named rule
   that produced it, so bypasses (`org-admin-bypass`, `platform-membership`) are
   visible rather than implicit.

Resource topology is `Organization → Project → Workflow`; Organization is the
immutable WorkOS root. Provisioning runbook:
[`docs/deployment/workos-provisioning.md`](docs/deployment/workos-provisioning.md).

## Tenant isolation is enforced in the database (obligation)

Authorization decides whether a caller may act; it says nothing about which rows
a query returns. That second half is enforced by **PostgreSQL row-level
security** (ADR-0041) — a real boundary underneath the `WHERE organization_id`
convention, not a replacement for it. Three things to know:

1. **The app connects as `grid_app_rw`**, which holds DML only and is subject to
   every policy. Migrations connect as the owner (`GRID_APP_MIGRATION_DATABASE_URL`),
   because RLS does not apply to a table's owner — that is what keeps DDL and
   data backfills working.
2. **A new table must join the boundary in the same migration that creates it**:
   one `SELECT grid_secure_table('<table>', '<tenancy predicate>');` line.
   `src/lib/db/rls-coverage.spec.ts` fails by name until you do, and there is no
   `ALTER DEFAULT PRIVILEGES`, so forgetting yields `permission denied` rather
   than a quiet cross-tenant read.
3. **Context comes from `getGridSession()`** for every authenticated path, so
   repositories keep their signatures. Callers without a session state it —
   `withTenant`, `withPlatformAccess`, `withOptionalTenant` — and
   `internalApiRoute` does not compile without a `tenancy` declaration.

Cross-tenant access is never implicit: it is a `SET LOCAL ROLE` to
`grid_app_platform`, visible as `current_user` in the query log.

**What this does and does not buy you.** `grid_app_rw` is `NOINHERIT`, so it
never picks up the platform role's privileges by accident — but it *is* a member
of that role, so `SET ROLE grid_app_platform` is always available to it, and that
role holds `BYPASSRLS`. The settings the policies read are unprivileged too, so
anything that can run arbitrary SQL as `grid_app_rw` can name any tenant. RLS is
a boundary against **application bugs** — the missing `WHERE`, the widened join,
the raw fragment — not against a compromised process or a stolen credential.
Which is why every platform-scope caller still carries its own authorization
check: keep `withPlatformAccess` behind `platformApiRoute` or an equivalent gate,
and never treat "we stepped up" as the authorization itself.

Runbook: [`docs/database/row-level-security.md`](docs/database/row-level-security.md).

## Environment variables

Secrets and deployment knobs live in environment variables only (`deploy/.env`). Beyond the LLM API keys, notable variables:

| Variable | Purpose |
|----------|---------|
| `GRID_INTERNAL_API_TOKEN` | Shared token for the internal BFF API (e.g. `POST /api/internal/memory`). Must match between the frontend and aiq-agent services. **Never ship the dev default.** |
| `GRID_APP_DATABASE_URL` | PostgreSQL URL for the BFF and both workers. Connects as **`grid_app_rw`** — DML only, no DDL, and subject to row-level security (ADR-0041), so a query that loses its `organization_id` filter returns no rows instead of another tenant's. Pointing it at the owner credential silently disables enforcement, because RLS does not apply to a table's owner. |
| `GRID_APP_MIGRATION_DATABASE_URL` | Owner credential, set **only** on the one-shot migrator — `grid-migrate` in both compose stacks, the migration Job on Kubernetes — and never on a long-lived serving container, which would hand a compromised frontend a full RLS bypass. DDL needs the schema owner, and a backfill run as `grid_app_rw` would silently update zero rows. `drizzle.config.ts` falls back to `GRID_APP_DATABASE_URL` only for a single-credential local database. |
| `GRID_APP_RUNTIME_PASSWORD` | Password set on `grid_app_rw` by `deploy/compose/init-db.sql` (dev default `grid_app_rw_dev`); Kubernetes takes it from the Pulumi secret `pgRuntimePassword`. |
| `GRID_DB_POOL_MAX` | Default `10`. Upper bound on PostgreSQL connections the Next.js BFF pool holds open. Bounds resource use so connection acquisition fails fast under load rather than piling requests up behind a saturated/unreachable database. Invalid/non-positive values fall back to `10`. |
| `GRID_ALLOW_AGENT_ORG_MEMORY` | Default `false`. When `true`, the internal memory endpoint accepts agent-authored **organization-scoped** writes. Default-deny protects against tenant-wide memory poisoning (audit finding S1); org-wide findings are otherwise a human-only action. |
| `GRID_MEMORY_REFLECTION_ENABLED` | Default `true`. Non-enforced-flags fallback that gates the post-answer **memory-reflection** stage (the agent's cross-chat learning loop). With `GRID_ENFORCE_FEATURE_FLAGS=true`, the per-org `memory-reflection` WorkOS flag controls it instead (fail-closed, including org-less sessions); without enforcement it defaults ON, anonymous sessions included. Reflection is a shipped core capability, not a dark-launched product gate. Frontend service; on Kubernetes set via the Pulumi stack key `grid-oib:memoryReflectionEnabled` (default `true`); see `docs/architecture/project-memory-design.md` §3.5. |
| `GRID_PROJECT_KNOWLEDGE_PAGE_ENABLED` | Default `false`. Non-enforced-flags fallback that shows the project-level "Knowledge" page (nav section + `/knowledge` route). With `GRID_ENFORCE_FEATURE_FLAGS=true`, the per-org `project-knowledge-page` WorkOS flag controls it instead. The platform owner's base-knowledge manager is independent of this. |
| `GRID_ADMIN_TOKEN` (frontend) | Now also required on the frontend service (must match aiq-agent): authenticates the platform-owner base-knowledge routes (`/api/platform/knowledge/*`) against the backend's `/v1/admin/oib/*` endpoints. |
| `OIB_UPLOADS_DIR` | Default `data/oib_uploads` (inside the persistent `aiq-data` volume). Writable home for base-corpus PDFs uploaded via the platform admin UI; scanned by OIB sync alongside the read-only repo corpus. aiq-agent service. |
| `GRID_JOB_EXECUTION` | Default `dask`. Execution backend for deep-research jobs: `dask` (a per-pod cluster) or `db` (DB-claimed workers, ADR-0021 — dedicated containers claim `research_job_queue` rows with `FOR UPDATE SKIP LOCKED`, which is what lets research scale horizontally, independently of the web tier). aiq-agent + research-worker services. |
| `GRID_JOB_PAYLOAD_KEK` | Unset by default. 32-byte base64 key (`openssl rand -base64 32`) that AES-256-GCM encrypts the queued job payload at rest. **Set it in any multi-node or production deployment running `GRID_JOB_EXECUTION=db`**: the `research_job_queue.payload` row durably persists the full `run_agent_job` payload, which carries **the user's auth token** plus identity/budget context. The Dask path held that only transiently in worker memory; a queue row is real at-rest exposure (table, WAL, backups, replicas). Unset keeps dev/single-node working as plaintext JSON with a one-time warning. aiq-agent + research-worker services. |
| `FRONTEND_INTERNAL_URL` | Backend→frontend base URL on the compose network (default `http://frontend:3000`) |
| `SEAWEED_ENDPOINT` | Internal SeaweedFS endpoint (backend-consumed presigns/uploads) |
| `SEAWEED_PUBLIC_ENDPOINT` | Browser-reachable SeaweedFS endpoint for presigned preview/download URLs (dev default `http://localhost:8333`) |
| `SEAWEED_PER_ORG_BUCKETS` | Default `false`. `true` writes each organization's objects into its own bucket instead of a key prefix inside `SEAWEED_BUCKET` (ADR-0043): erasing a tenant becomes one `DeleteBucket` instead of a paginated sweep that can half-finish, and a key-construction bug stops being a cross-tenant bug. **Not a cutover** — the bucket is recorded per row (`documents.storage_bucket`, NULL = the shared bucket), so flipping it changes where the next object goes and leaves everything already written readable in place. Frontend + purger services; on Kubernetes set via `grid-oib:seaweedfsPerOrgBuckets`. |
| `SEAWEED_TENANT_BUCKET_PREFIX` | Default `grid-org-`. Leading segment of a tenant bucket name; the rest is the slugged org id plus a truncated SHA-256 of the original id. The naming rule is one CommonJS module (`src/lib/storage/tenant-bucket.js`) loaded by both the BFF and the purger rather than reimplemented — the purger is what ERASES a tenant, and a naming disagreement there sweeps a bucket that does not exist and reports success. Also the string the tenant S3 grants are wildcarded on (`Read:<prefix>*`), so it must never be a prefix of a platform bucket name. Frontend + purger services. |
| `SEAWEED_TENANT_ADMIN_ACCESS_KEY` / `SEAWEED_TENANT_ADMIN_SECRET_KEY` | Credential for the only identity scoped to create and drop tenant buckets (`Admin:<prefix>*`). A separate key rather than a second client on the ordinary one, because SeaweedFS's `Admin:<bucket>` authorises CreateBucket and DeleteBucket together and cannot express one without the other — a distinct credential is the only way to keep "drop a tenant" off the request path. **Frontend service only**: the purger gets the two naming variables above but not this, since an unattended queue worker is the last process that should be able to drop a bucket. Unset falls back to `SEAWEED_ACCESS_KEY`/`SEAWEED_SECRET_KEY`, which is what a deployment with per-org buckets off has (nothing calls it there). |
| `PROJECT_PURGE_GRACE_DAYS` | Grace period before soft-deleted projects are hard-purged |
| `GRID_BUDGET_EUR_PER_USD` | Default `0.86`. Euros per 1 USD for comparing EUR budget limits against the USD costs OpenRouter reports (ADR-0015). Frontend service. |
| `GRID_PLATFORM_OWNER_EMAILS` | Break-glass platform-owner bootstrap (comma-separated emails). Empty in steady state; the WorkOS `org-platform-owner` role is the source of truth (ADR-0016). |
| `GRID_PLATFORM_ORG_EXTERNAL_ID` | Default `grid-platform`. External id of the GRID Platform organization in WorkOS (ADR-0016). |
| `GRID_LANDING_URL` | Base URL of the public landing site (`frontends/web`, the Astro microservice on the `webDomain` apex host). The signed-out app root (`/`) redirects here when `REQUIRE_AUTH=true`; unset falls back to the WorkOS sign-in URL. `/?sign-in` opts out of the bounce and goes to WorkOS — that is the landing site's sign-in target (`SIGN_IN_URL`, `frontends/web/src/consts.ts`); linking it at the bare app URL loops the visitor back to the landing site. Frontend service; injected by the Kubernetes deployment. |
| `GRID_DISABLE_SELF_SERVE_ORGS` | Default `false`. `true` = invite-only platform: no self-service organization creation. |
| `GRID_ENFORCE_FEATURE_FLAGS` | Default `false`. `true` enforces WorkOS feature flags (registry: `frontends/ui/src/lib/authz/feature-flags.ts`) — flip only after provisioning the flags in WorkOS. |
| `GRID_BYOK_SECRET_BACKEND` | BYOK key store (ADR-0022): `vault` (WorkOS Vault, default when `WORKOS_API_KEY` is set) or `local` (AES-256-GCM under `GRID_BYOK_LOCAL_KEK`). Frontend service. |
| `GRID_BYOK_LOCAL_KEK` | 32-byte base64 KEK for the `local` BYOK backend (`openssl rand -base64 32`). Frontend service. |
| `GRID_BYOK_ALLOW_PRIVATE_BASE_URLS` | Default `false`. `true` lets org admins point BYOK base URLs at private-network hosts (self-hosted OpenAI-compatible gateways). |
| `OPENROUTER_API_KEY` (frontend) | Also passed to the frontend service now: authenticates the OpenRouter model-catalog fetch for the model-config pickers, platform and org alike (ADR-0014). |
| `GRID_DEFAULT_MODEL` | Boot-floor model id for every `llms:` entry in `config_oib_openrouter.yml` (default `openai/gpt-5.6-luna`). Only applies where no platform default and no org override exist. The BFF bootstraps a platform default on first boot, so for the eight `llms:` entries an agent group covers this is normally unreachable; it still fully controls `summary_llm` and `rerank_llm`, which have no group. Changing the fleet's model is a save under Platform → Models, not this variable. Backend (aiq-agent) service. |
| `REDIS_URL` | Redis-protocol URL of the shared cache (Dragonfly service in compose, ADR-0020). Both services. Unset = per-process in-memory fallback — everything still works on a single replica. **On Kubernetes this is a secret value**: Dragonfly runs with `requirepass` there, so the URL is `redis://:<url-encoded-password>@dragonfly:6379/0` and ships in the `grid-secrets` Secret rather than inline on the pod spec. Empty username on purpose (ioredis and redis-py both then send the one-arg `AUTH <password>` that `requirepass` wants); percent-encode the password, since `openssl rand -base64 32` routinely emits `/`, `+` and `=`. Compose keeps the passwordless form. |
| `DFLY_requirepass` | Dragonfly's `requirepass`, on both Kubernetes instances (`dragonfly` cache, `dragonfly-ratelimit` counter store). Injected by `secretKeyRef`, never as a container arg — a pod spec is readable by anything with `get pod`. The `DFLY_<flag>` spelling is **case sensitive**; `DFLY_PASSWORD` is deprecated and exits fatally. Comes from the Pulumi secrets `grid-oib:dragonflyPassword` / `grid-oib:rateLimitStorePassword`, which are required (explicit opt-out: `allowUnauthenticatedRedis`) and must differ from each other. Not set in compose. |
| `REDIS_AUTH` | Same counter-store password, as read by Envoy Gateway's rate limit service in `envoy-gateway-system`. It cannot ride in the URL — `RateLimitRedisSettings` has only `url`/`urlRef`/`tls`, and the URL becomes a bare `host:port` dial address — so Pulumi injects it via `provider.kubernetes.rateLimitDeployment.container.env`. A mismatch is fail-open: limits stop enforcing, traffic keeps flowing. |
| `GRID_NORMS_DIR` | Default `configs/norms`. YAML seed root of the flat norm catalog (ADR-0025 v2, `configs/norms/<country>/registry.yml`): verified RIS pointers + curated prose legal notes, consumed by the `ris_search` short-circuit, `ris_catalog_lookup`, and the researcher prompt block. The admin store (summary DB, platform UI) supersedes the YAML at runtime; fail-open on missing/invalid. Backend (aiq-agent) service. |
| `GRID_RIS_CACHE_TTL_DAYS` | Default `7`. Days a fetched RIS full text (and a live `ris_search` result) is kept in the shared Dragonfly/Redis cache (`aiq_agent.common.cache`, ADR-0020) and served without re-hitting the RIS API — cutting repeated OGD-RIS + planner-LLM spend across turns, replicas, and restarts. Cache-only/fail-open: a miss or cache error just does a live fetch. `0`/invalid falls back to `7`. Backend (aiq-agent) service. |
| `GRID_CITATION_EVENTS_ENABLED` | Default `true`. Emits one citation-health batch per research turn to the internal BFF endpoint `POST /api/internal/citation-events`, which backs the platform dashboard's **Citation health** surface (clean rate, defect mix, removal reasons, missing-source candidates, the derived action list, and the JSON diagnostic export). Best-effort and off the answer path: emission runs on a daemon thread and never raises. Set to `false` to disable. Backend (aiq-agent) service. |
| `GRID_WS_UPGRADE_RATE_LIMIT` | Default `30`. Max WebSocket upgrades per client IP per minute at the gateway (`rate-limiter-flexible` over Dragonfly, ADR-0040 L2). `0` disables. The edge carries the same budget (`rateLimitAppWsUpgrade`); this one keeps working while that policy is in shadow mode. Frontend gateway. |
| `GRID_WS_MESSAGE_LIMITS` | Default `1` (on). Bounds the frames a client sends on an ALREADY-OPEN WebSocket (ADR-0040 L2b) — the chat turns no edge policy can see, because to the gateway a whole session is one upgrade request (ADR-0009). Budgets live in the shared catalog (`src/lib/limits/rules.js`); a socket past budget is closed with WS status 1008. `0` restores the pre-ADR-0040 behaviour. Frontend gateway. |
| `GRID_SHUTDOWN_DRAIN_MS` | Default `2000`. Frontend gateway shutdown drain: after SIGTERM, `server.js` fails readiness, refuses new WS upgrades, and keeps serving in-flight requests/streams for this long before forcing exit. The Kubernetes deployment sets 30s and sizes `terminationGracePeriodSeconds` above it so rolling updates don't drop live chat (`deploy/pulumi/src/platform/rollout.ts`). Frontend service. |
| `GRID_MAX_ACTIVE_JOBS` / `GRID_MAX_ACTIVE_JOBS_PER_ORG` | Defaults `8` / `3`. Admission control for async research jobs (global / per-org caps); beyond a cap, submits get 429 / a friendly chat message. `0` disables. Scheduled workflow runs (ADR-0023) go through the same caps; rejected occurrences are recorded as `skipped` runs. |
| `GRID_DEFAULT_STORAGE_QUOTA_BYTES` | Unset = unlimited (the pre-existing behaviour). Fleet-wide default per-org storage quota in bytes (ADR-0042); an org value in Organization → Storage overrides it, and an explicit org-level unlimited beats it. Enforced before any bytes reach SeaweedFS, so a refused upload leaves no orphan object. |
| `GRID_STORAGE_ALERT_THRESHOLD_PERCENT` | Default `80`. Share of its storage quota at which an organization is warned (ADR-0042), as a percentage. The hourly `storage-alerts` CronJob calls `POST /api/internal/storage/alerts`, which raises an inbox item for every active member holding `org:settings:manage`. Escalation at 90% and 100% is automatic and not configurable. Fires **once per crossing**, not once per sweep — a live row suppresses re-emission — and re-arms when usage falls back below the threshold, so a later re-crossing alerts again. A value outside `(0, 100]` falls back to 80 rather than disabling the warning; on Kubernetes the same value is validated at deploy time and rejected (`grid-oib:storageAlertThresholdPercent`). Frontend service. |
| `GRID_MAX_ACTIVE_TURNS` / `GRID_MAX_ACTIVE_TURNS_PER_ORG` / `GRID_TURN_LEASE_SECONDS` | Defaults `24` / `6` / `900`. Admission control for INTERACTIVE chat turns (ADR-0040 L3, `src/aiq_agent/common/turn_admission.py`). A **separate pool** from `GRID_MAX_ACTIVE_JOBS` on purpose — that partition is what stops background research from starving chat and vice versa. Lease-based, so a replica killed mid-turn cannot leak a slot forever. `0` disables a cap. Backend (aiq-agent) service. |
| `GRID_MAX_RUN_COMPLETION_TOKENS` | Default `0` (disabled). Per-run completion (output) token ceiling for `deep_research_agent` jobs, enforced across every LLM call in the run including concurrent researcher workers (`BudgetGuardCallback`, `src/aiq_agent/common/budget_guard.py`, backlog T4-4). Exceeding it fails the job with an explicit budget-exceeded message instead of a generic internal error. Independent of the USD budget ledger (`GRID_BUDGET_EUR_PER_USD` etc.). Backend (aiq-agent) service. |
| `GRID_RESEARCHER_RECURSION_LIMIT` | Default `100`. Per-worker step cap for single-query researcher runnables (source: `RESEARCHER_RECURSION_LIMIT` in `tools/research.py`). A stuck researcher is caught by the `GraphRecursionError` → terminal `ResearcherExhaustedError` path instead of by the wall-clock kill. Backend (aiq-agent) service. |
| `GRID_WRITER_CHAR_BUDGET` | Default `200000`. Total-character ceiling for the writer's tool-result context (`ToolResultPruningMiddleware.total_char_budget`). Oversized tool results within the keep-last-N window are monotonically truncated when their sum exceeds this budget, preventing unbounded growth. Backend (aiq-agent) service. |
| `GRID_MAX_QUERY_SUBMISSIONS` | Default `3`. Maximum number of times the same query digest can be re-submitted before it is returned as a terminal unresearchable gap. Backend (aiq-agent) service. |
| `AIQ_DEEP_CHECKPOINT_DB` | Default unset = durability OFF (strictly opt-in; a default-on relative path crashed container startup on read-only workdirs — post-#72 hotfix, unopenable values now fail open with a warning). Optional SQLite path or Postgres DSN for durable per-job LangGraph checkpointing of async deep-research runs (`thread_id = job_id`, `durability="async"`, backlog T3-8). A worker crash no longer silently loses execution state, but resume today is manual-resubmit-based, not automatic — resubmitting a duplicate `job_id` still errors; see `docs/architecture/backend-deep-dive.md` §9. Mirrors the existing `AIQ_CHECKPOINT_DB` pattern for the sync chat graph. Backend (aiq-agent) service. |
| `OTEL_SERVICE_NAME` / `OTEL_EXPORTER_OTLP_ENDPOINT` | Kubernetes-only, Pulumi-injected (ADR-0029): per-tier `service.name` (`grid-ui` / `grid-aiq-agent` / `grid-agent-worker`) plus the OTLP collector endpoint. Python tiers get the FULL path (`http://otel-collector:4318/v1/traces` — the NAT exporter posts as-is); the frontend gets the BASE URL (JS exporter appends `/v1/traces` per spec). Unset → frontend `src/instrumentation.ts` no-ops. Producers hold no ingestion key — it lives in the Kubernetes Secret `aspire-dashboard-secrets`, referenced only by the OTel Collector and the Aspire dashboard (cluster's single ingestion point; `docs/deployment/kubernetes.md` §9). |
| `GRID_COLLABORATION_ENABLED` | Default `false`. Dark-launch gate for collaboration (ADR-0032…0035: shared chats, `@`-mentions with the agent hand-off, the inbox). Shows the inbox nav entry + page, the share surfaces and the mention picker, and enables the `/api/inbox/*`, `/api/sharing/*`, `/api/mentions/*`, `/api/stream` and the per-conversation `/live` + `/typing` routes (ADR-0039) while `GRID_ENFORCE_FEATURE_FLAGS` is off; with enforcement on, the per-org `collaboration` WorkOS flag controls them. Unlike an ordinary flag this is **default-deny rather than fail-open** — the feature changes who can see conversations, so an operator must choose it. No paired capability var: without `REDIS_URL` live updates degrade to polling, so there is no infrastructure dependency to derive one from — the one capability genuinely reduced without a shared cache tier is **watching a colleague's turn stream in** (ADR-0039, the frames come off the Python tier's conversation bus), which falls back to the static turn banner plus the finished answer. Frontend service. |
| `GRID_WORKFLOWS_ENABLED` | Default `false`. Dark-launch gate for the Workflows feature (per-project scheduled deep research, ADR-0023): shows the Workflows tab + BFF routes while `GRID_ENFORCE_FEATURE_FLAGS` is off, and gates the `workflow-scheduler` worker's start. With enforcement on, the per-org `workflows` WorkOS flag controls the UI/API instead. Frontend + workflow-scheduler services. |
| `GRID_WORKFLOW_SCHEDULER_POLL_MS` / `GRID_WORKFLOW_SCHEDULER_BATCH` / `GRID_WORKFLOW_RUNS_RETENTION_DAYS` | Defaults `30000` / `20` / `90`. Workflow-scheduler knobs: tick interval, max due schedules claimed per tick (`FOR UPDATE SKIP LOCKED`), and run-history retention. workflow-scheduler service. |
| `GRID_WORKFLOW_MIN_INTERVAL_MINUTES` | Default `15`. Minimum cron cadence accepted when saving a workflow schedule (validated in the BFF). Frontend service. |
| Unified LLM credential resolution | The bespoke (non-NAT) LLM call sites — VLM (`AIQ_VLM_API_KEY`), embeddings (`AIQ_EMBED_API_KEY`), the backfill script, and the two BFF routes below — resolve through one shared helper (`aiq_agent.common.credential_resolution.resolve_llm_credential`). Order: org BYOK (when an org id is supplied — swaps key + base URL only, never the model) → explicit key env → fallback envs → **provider inference** (the conventional key env for the resolved base URL host: `openrouter.ai`→`OPENROUTER_API_KEY`, `integrate.api.nvidia.com`→`NVIDIA_API_KEY`, `api.openai.com`→`OPENAI_API_KEY`). All env reads treat a literal `${...}` placeholder as unset. **VLM ingestion now reaches BYOK + runtime model override** — `/v1/ingest` forwards `x-grid-organization-id` into the (detached) ingest thread's job config, so per-project/Archiv uploads resolve the org's BYOK vision key + base URL (`resolve_vlm_credential(org_id)`) and its `ingest_vlm` model override (`AgentGroup.INGEST_VLM`); org-agnostic base-corpus sync passes no org id and gets the deployment default. Embeddings BYOK is still a follow-up (needs an embeddings-capable BYOK endpoint). |
| `AIQ_VLM_API_KEY` / `AIQ_EMBED_API_KEY` | Explicit VLM / embeddings key overrides. Each resolves via the shared helper: explicit → `NVIDIA_API_KEY` fallback → provider inference from `AIQ_VLM_BASE_URL` / `AIQ_EMBED_BASE_URL`. `AIQ_VLM_API_KEY` is the single source of truth both image ingestion and the `vlm_available` capability bit consult. Provider inference never changes the base URL (embeddings need an embeddings-capable endpoint). Backend (aiq-agent) service. |
| `AIQ_VLM_BATCH_WORKERS` / `AIQ_VLM_TIMEOUT_SECONDS` / `AIQ_EMBED_BATCH_SIZE` | Defaults `4` / `180` / `64`. Ingestion-pipeline tuning knobs: concurrent VLM caption calls per file in `enrich_vlm_batch`; per-request timeout on the VLM OpenAI client (single retry — SDK defaults let a hung provider park an ingest worker ~20 min); texts per embedding HTTP call (llama-index default 10 serialized ~50 round-trips for a 500-chunk document). The VLM caption cache key is model-scoped (`vlm:caption:{model}:{prompt_type}:{sha256}`), and failed VLM analyses (exception or placeholder caption) are skipped rather than indexed as content-free chunks — and never cached, so a re-ingest retries them instead of replaying the failure for the 30-day TTL. Backend (aiq-agent) service. |
| `AIQ_RENDER_VISUAL_PAGES` (+ `AIQ_PAGE_RENDER_MAX_DIM`, `AIQ_VISUAL_PAGE_MIN_TEXT_CHARS`, `AIQ_VISUAL_PAGE_MIN_PATHS`, `AIQ_MAX_RENDERED_PAGES`) | Default `true`. Renders **text-sparse / vector-heavy PDF pages** to a full-page image (long edge ≈`AIQ_PAGE_RENDER_MAX_DIM`, default `2048`px) and VLM-captions them with a drawing-aware German prompt, so vector CAD/architectural drawings (plans, sections, elevations, perspectives) — which carry almost no extractable text and no embedded raster image, and which text + image extraction therefore miss entirely — are captured with their drawing type, scale and spatial relationships. A page is "visual" when its watermark-stripped text is below `AIQ_VISUAL_PAGE_MIN_TEXT_CHARS` (default `200`) OR it has ≥`AIQ_VISUAL_PAGE_MIN_PATHS` (default `300`) vector paths; at most `AIQ_MAX_RENDERED_PAGES` (default `20`) pages are rendered per document. Effective only when a VLM key resolves; text PDFs skip it (zero extra cost). For such drawing PDFs the rendered-page description also feeds the document summary, so the summary describes the drawing instead of a licence watermark (e.g. "VECTORWORKS EDUCATIONAL VERSION"). Backend (aiq-agent) service. |
| `AIQ_HYBRID_RETRIEVAL` | Default `true`. Hybrid lexical + vector retrieval (ADR-0039): an extra exact-term lexical query per collection (up to 3 technical tokens via the shared `extract_exact_terms` utility, matched with Chroma `$contains`) fused with the vector channel by reciprocal rank fusion (Cormack k=60), fixing exact-keyword misses without re-embedding. `false` disables it (plain vector retrieval). Fail-open. Backend (aiq-agent) service. |
| `AIQ_VIEW_IMAGES_ENABLED` | Default `true`. Enables the `view_knowledge_image` NAT tool (ADR-0039): returns a knowledge visual as a **multimodal image block during a research turn** — PDF pages re-rendered on demand (pypdfium2 → JPEG, long edge `AIQ_PAGE_RENDER_MAX_DIM`, default `2048`px; base corpus from disk, project/Archiv from SeaweedFS bytes) and standalone image uploads (PNG/JPG) fetched from SeaweedFS. Project/Archiv resolution goes through the token-guarded BFF route `GET /api/internal/document-file` + boto3, which is why the aiq-agent tier now carries the `SEAWEED_*` set (read-only `get_object`). Effective only when a VLM key resolves (`AIQ_VLM_API_KEY`); every failure path degrades to a text-only explanation block. `false` disables the tool. Backend (aiq-agent) service. |
| `CONSISTENCY_LLM_MODEL` / `CONSISTENCY_LLM_API_KEY` / `CONSISTENCY_LLM_BASE_URL` / `SUMMARY_LLM_*` | LLMs for the end-of-wizard free-text consistency-check (`POST /v1/consistency-check`) and AI project-summary (`POST /v1/generate-summary`) endpoints. Both resolve the key through the shared helper and reach org **BYOK**: the BFF (`profile-service`) forwards `x-grid-organization-id` on these POSTs, the routes pass it to the resolver, so a tenant's own key + base URL are used when configured (fail-open to the env chain: `CONSISTENCY_LLM_*`/`SUMMARY_LLM_*` → `LLM_*` → `OPENROUTER_API_KEY`/provider inference). Model/base URL keep their two-level env fallback; BYOK never changes the model. Best-effort: no key resolvable → `error=llm_not_configured` (HTTP 200) and the wizard saves anyway. Backend (aiq-agent) service. |
| `BACKFILL_SUMMARY_API_KEY` / `BACKFILL_SUMMARY_BASE_URL` / `BACKFILL_SUMMARY_MODEL` | Credentials for the one-off `scripts/backfill_document_tags.py` tagging LLM (runs outside the NAT runtime, so it builds an OpenAI-compatible client from env via the shared resolver). `BACKFILL_SUMMARY_API_KEY` falls back to `NVIDIA_API_KEY`, then provider inference from `BACKFILL_SUMMARY_BASE_URL`; none resolvable → the script exits `2`. `BACKFILL_SUMMARY_BASE_URL` default `https://integrate.api.nvidia.com/v1`; `BACKFILL_SUMMARY_MODEL` default `nvidia/nemotron-mini-4b-instruct`. BYOK N/A (runs outside NAT). Must match the config's `summary_llm` block. |

## BFF architecture (obligation)

The Next.js BFF follows a **repository/service architecture** (ADR-0017,
`docs/architecture/bff-service-architecture.md`). **Every future service and
every change to an existing endpoint MUST follow it** — this is not optional:

- **Routes** (`frontends/ui/src/app/api/**/route.ts`) are thin transport
  adapters declared via the factories in `@/lib/api/handler` (`apiRoute`,
  `internalApiRoute`, `publicApiRoute`). No bare `export async function GET`,
  no drizzle/`getDb()` imports, no hand-rolled error responses in routes.
- **Services** (`frontends/ui/src/lib/<domain>/service.ts`) own business
  logic and authorization (tenancy + `requireProjectAccess`/permission
  checks) and throw typed errors from `@/lib/api/errors`.
- **Repositories** (`frontends/ui/src/lib/<domain>/repository.ts`) are the
  only modules that query the DB for their domain; `organizationId` scoping
  lives in the SQL WHERE clause and every list query is bounded.
- Every endpoint is authenticated through a factory; `publicApiRoute` is for
  health checks only and anything else needs an ADR.

The projects domain (`lib/projects/repository.ts`, `lib/projects/service.ts`,
`app/api/projects/**`) is the reference implementation.

## Cards — interactive cards must persist the user's answer (obligation)

Cards are the agent's rich-UI presentation layer (ADR-0012,
`docs/architecture/cards.md`). Most are pure presentation, but a card with a
button that **writes something** — today `project_profile_patch` (applies a JSON
Patch to the project brief) and `memory_proposal` (writes an org/project memory
row) — is a different kind of object. Those cards follow *propose, never
auto-apply*, so the user's click is the only place that authorization exists.

**Never hold that outcome in component-local `useState`.** The card *payload*
persists (localStorage and `messages.metadata.cards`), so a lost decision means
the card returns after a reload looking untouched, with a live button that
applies the patch or writes the memory **a second time** — neither endpoint is
idempotent. The decision is conversation history and belongs on the
`ChatMessage`, exactly like `isPromptResponded` does for a HITL prompt:
`ChatMessage.cardInteractions`, keyed by `cardKey(card, index)`, read and
written through `useCardDecision`. Rationale and full contract: **ADR-0030**.

Adding a card type? You must classify it in `CARD_INTERACTIVITY`
(`frontends/ui/src/features/grid-cards/card-decision.ts`) — the map is
exhaustive over the generated union, so `task fe:types` fails until you do.
Classify it `'interactive'` if answering it starts a commitment that is not
safely repeatable; opening a read-only preview is not one. Two further guards
back this up: `card-interactivity.spec.tsx` (an interactive card must actually
reach the store) and `tests/aiq_agent/cards/test_interactive_card_parity.py`
(the backend `INTERACTIVE_CARD_TYPES` must agree with the frontend map). Full
checklist for a new card type: `docs/architecture/cards.md`.

## Knowledge systems

GRID has two distinct "knowledge" systems: **project knowledge** (the intake-wizard profile plus the agent-curated project/org memory, injected as WS headers `x-grid-project-context` and `x-grid-project-memory`; memory writes go through the token-guarded internal BFF endpoint so `grid_app` stays single-writer) and **RAG document knowledge** (SeaweedFS uploads ingested into scoped collections via `/v1/ingest`). See `docs/architecture/backend-deep-dive.md` and `docs/architecture/project-memory-design.md`.

**Project profile — one surface, one editor.** The project profile (facts like
building class, use, location) has a single editor: the **intake wizard**. The
project **Settings** page *displays* it read-only via the `ProjectBrief` card
(facts, summary, assumptions, open gaps) and links to the wizard to change it —
do **not** add a second parameters form or inline field-editing on Settings.
The facts are interdependent (they drive which OIB standards apply), so edits
must run through the wizard's guided, consistency-checked flow. Rationale:
`docs/design/click-dummy-overhaul-spec.md` §9.1.

RAG document knowledge has **three tiers**, all sharing one pipeline (SeaweedFS → `/v1/ingest` → per-collection retrieval): the platform-owner **base corpus** (`oib_knowledge`, org-agnostic, always in scope); per-**project** documents (`proj_<uuid>`, in scope for that project only); and the org-wide **Archiv** (ADR-0024, `archiv_<orgId>`, `scope='archiv'` rows in the `documents` table, injected into every project's scope for that org). The Archiv reuses the project document machinery (`lib/documents/*`) wholesale — only the authorization scope differs (org-level `org:archiv:manage` for writes; any member reads). See `lib/archiv/*`, `/api/archiv/*`, and `computeCollectionScope`.

**Source-kind model (obligation).** Every source the agent surfaces — OIB corpus, RIS live law, Büroarchiv, Projektwissen, web — is classified into **one coarse `SourceKind`** (`baurecht | buero | projekt | web`) that drives *all* rendering: the "Belegt durch" chips, the Herleitung fan-out, and the report sources section. The taxonomy is defined once in `src/aiq_agent/common/source_kinds.py` (backend) and mirrored in `frontends/ui/src/features/chat/lib/source-kinds.ts` (frontend); the fine `norm_registry.lane_for_hit` lanes (OIB-Richtlinie, Bundesrecht, …) are the *sub-label within* a kind, not a competing taxonomy. **The OIB corpus and RIS are the same kind (`baurecht`)** — do not add per-surface kind mappings or a second source taxonomy. Rationale and rollout: ADR-0026. This unifies the two knowledge planes at the presentation/doctrine layer while keeping them as separate stores (Chroma corpus for semantic retrieval, the norm registry for authoritative live law — ADR-0025).

**Document classification (`doc_class` / "Dokumentart").** What a base-corpus document *is* (OIB-Richtlinie verbindlich, OIB-Leitfaden/Erläuterung, Norm, Gesetz, Sonstiges) is an **explicit, human-set fact**, not a filename guess. The vocabulary lives in `src/aiq_agent/knowledge/document_classification.py` (`DOCUMENT_CLASSES`/`DOCUMENT_CLASS_LANES`) mirrored in `frontends/ui/src/lib/knowledge/doc-class.ts` (parity-tested); it is stored on `summaries.doc_class`, pre-filled at ingest from `norm_registry.guess_doc_class(filename)`, and **preferred over the filename/collection heuristic everywhere** — `lane_for_hit(doc_class=…)`, the citation `SourceKind`, and the `Dokumentart:` line the LLM reads. Retrieval is **store-authoritative** for `doc_class` (chunk metadata is a fallback), so reclassifying reflects immediately with no re-ingest. Platform owners manage it in the base-knowledge admin panel (`app/app/platform/base-knowledge.tsx`): PDF/ZIP upload (non-blocking, status-polled), a pre-filled Dokumentart dropdown per document (`PATCH /v1/admin/oib/documents/{file}/doc-class`), and a binding-OIB-vs-other split.

## Documentation is part of the work (obligation)

Updating documentation is **not optional and not a follow-up** — it is part of the same change that alters behavior. When you (human or agent) do any of the following, you MUST update the relevant docs in the SAME change, before it is considered done:

| You changed… | Update… |
|---|---|
| Architecture, a data flow, a subsystem, or a cross-cutting mechanism | `docs/architecture/backend-deep-dive.md` (and the specific subsystem doc) |
| A significant/hard-to-reverse decision (new subsystem, transport, storage, provider model, security boundary) | add an **ADR** under `docs/adr/` (copy `0000-template.md`, next number) |
| An env var, config key, or default | this file's Environment-variables table + `docs/deployment/environment-variables.md` |
| An API route, WS message, or tool contract | `docs/api/*` |
| A DB schema / migration | `docs/database/*` |
| User-facing behavior | the relevant `docs/user-guides/*` |
| Setup, containers, or the run/verify flow | `README.md` + the Quick-start / Verification sections here |

Rules of thumb: prefer updating an existing doc over adding a new one; delete docs that a change makes wrong rather than leaving them stale; keep the `docs/architecture/` deep-dives and the ADR log as the source of truth. If a change is significant enough to explain in a PR, it is significant enough to document in the repo.

## Git workflow (branching & commits)

- **One feature, one branch.** Each distinct feature/fix gets its **own branch cut
  from `develop`** (e.g. `feature/rich-ui-cards`, `fix/research-403`). Do **not**
  keep piling unrelated work onto an existing feature branch that already has an
  open PR — that makes the PR unreviewable and couples unrelated changes.
- **Merge target is `develop`.** Open the PR against `develop`; `develop` is the
  integration branch. Only release promotes `develop` onward.
- If new work genuinely depends on an unmerged branch, **stack** the new branch on
  it (branch from that tip) and note the dependency in the PR — but prefer branching
  from `develop` whenever the work is independent.
- **Conventional Commits** (`type(scope): summary`), imperative, small and
  independently revertible — one logical change per commit. Reference the ADR/issue
  when relevant.
- Never commit secrets. Branch before committing if you're on `develop`/`main`.

## Conventions

- Python: ruff, line length 120, Python 3.11.
- New tools use `@register_function` and a `FunctionBaseConfig` subclass.
- Secrets live in environment variables only.
- Capability doctrine: feature flags are **product decisions**, environment
  variables are **real infrastructure dependencies**, a **capability** is
  DERIVED from a dependency (never a second flag), and a feature's
  **availability = flag AND capability**. Example: image upload = the
  `image-upload` flag AND `vlm_available` (derived from the VLM key) — do not
  add a redundant env opt-in for something the dependency already implies.
- **Raw `sql<T>` results are not runtime-validated — coerce at the repository
  boundary.** Drizzle only decodes column values for direct column references;
  a raw `sql<Date>\`max(...)\`` / `sql<number>\`count(...)\`` fragment is a
  *compile-time assertion only*, so `tsc` and the LSP see no error even when the
  driver returns a string. Convert on the way out of the repository (e.g.
  `new Date(row.x)`, `Number(row.x)`) — never trust the annotation downstream.
  A missing coercion here caused the profiler `toISOString is not a function`
  crash; the fix and the `totalDurationMsRaw` sibling are the reference pattern.
- **`any` is not a type we accept — in production code or in tests.**
  `@typescript-eslint/no-explicit-any` is an **error** (not a warning) in
  `frontends/ui/eslint.config.mjs`, and the suite is clean. Reach for the real
  type, a `Partial<T>`/`Pick<T, …>` of it, `unknown`, or a deliberate
  `as unknown as T` at a single documented boundary. For spec fixtures use
  `@/test-utils/store-fixtures` (`DeepPartial<TState>` + `asStoreState` for
  zustand selector mocks — the fixture stays partial but every field is still
  checked against the real store) and `@/test-utils/db-fixtures`
  (`makeProject` / `makeDocument` / `makeMemoryItem` for whole repository rows,
  `asDb` for the one drizzle query-builder-stub boundary).
  `any` in a test double is how fixtures silently drift from the code they
  stand in for. `no-console` allows `warn`/`error`/`debug`; `console.debug` is
  the dev-only diagnostic channel and its call sites are `NODE_ENV`-gated.
- Documentation obligations above apply to every change — treat stale docs as a bug.
- **Fix errors you find — never dismiss them as "pre-existing."** If, while
  working, you identify a bug, a failing/broken test, or wrong behavior — even
  one that pre-dates your change — fix it. "It was already broken" is not a
  reason to leave it broken. If a fix is genuinely out of scope, flag it loudly
  and explicitly (in the PR/log), never silently wave it away.
- **Question necessity, then simplify — "the best part is no part."** START every
  task by asking why the thing must exist at all and whether existing machinery
  already covers it — the cheapest code is the code you don't write. FINISH every
  task with a skeptical review that tries to DELETE: remove parts, collapse
  layers, reuse instead of add, cut complexity — while keeping the feature set
  intact (reduce complexity, never features). Reducing complexity is part of
  "done," not a follow-up. When work is finished, a senior-skeptic review pass
  (its own sub-agent) that challenges necessity and hunts deletions is expected.
- Git workflow above (feature-branch-per-feature, Conventional Commits, PR to
  `develop`) applies to every change.
