# Grid MVP Integration + Sequencing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the four subsystem plans in a safe order, handle cross-cutting concerns (DB setup, env, compose), and verify end-to-end locally before declaring MVP done.

**Architecture:** The four subsystems are not independent at runtime: conversation persistence and document upload both need the auth/session helper, collection scoping needs the project-membership helper, and all three need the `grid_app` database. Therefore we run them in a specific sequence with integration checkpoints.

**Tech Stack:** Same as subsystem plans.

**Documentation rule:** Every task in this plan MUST update or create the relevant component documentation before it is considered complete. Do not track progress in a separate file — document the component itself (what it does, why it exists, how to use it, file paths, env vars, key decisions). Update `docs/architecture/`, `docs/aiq/`, or the relevant ADR cross-references as appropriate.

---

## Phase 0: Shared foundation

Before subsystem implementation, set up the shared infrastructure.

### Task 0.1: Initialize `grid_app` database and Drizzle in Next.js

**Files:**
- Modify: `frontends/ui/package.json`
- Create: `frontends/ui/src/lib/db/index.ts`
- Create: `frontends/ui/drizzle.config.ts`

- [ ] **Step 1: Add Drizzle dependencies**

```json
"drizzle-orm": "^0.31.0",
"postgres": "^3.4.0",
"drizzle-kit": "^0.22.0"
```

- [ ] **Step 2: Configure Drizzle**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.GRID_APP_DATABASE_URL!,
  },
});
```

- [ ] **Step 3: Create DB client**

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString = process.env.GRID_APP_DATABASE_URL!;
const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client);
```

- [ ] **Step 4: Add env var**

```bash
cat >> frontends/ui/.env.example << 'EOF'
GRID_APP_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/grid_app
EOF
```

- [ ] **Step 5: Document the component**

Create or update `docs/architecture/grid-app-database.md` describing:
- Why `grid_app` exists (BFF-owned application data).
- Drizzle ORM + `postgres` driver choice.
- `GRID_APP_DATABASE_URL` environment variable.
- Lazy `getDb()` / `closeDb()` pattern in `frontends/ui/src/lib/db/index.ts`.
- Where schemas live (`frontends/ui/src/lib/db/schema/`).

- [ ] **Step 6: Commit**

```bash
git add frontends/ui/package.json frontends/ui/drizzle.config.ts frontends/ui/src/lib/db/index.ts frontends/ui/.env.example docs/architecture/grid-app-database.md
git commit -m "feat: initialize drizzle and grid_app db client"
```

### Task 0.2: Add `grid_app` database to Postgres init

**Files:**
- Modify: `deploy/compose/docker-compose.yaml`

- [ ] **Step 1: Ensure `grid_app` database is created**

If using a custom init script, add:

```sql
CREATE DATABASE grid_app;
```

Or set `POSTGRES_DB` to `grid_app` and create separate DBs via command:

```yaml
postgres:
  environment:
    POSTGRES_DB: grid_app
```

For MVP, a single `grid_app` DB is enough; AI-Q can keep using `aiq_jobs` and `aiq_checkpoints`.

- [ ] **Step 2: Update `docs/architecture/grid-app-database.md`**

Document how the `grid_app` database is initialized in Docker Compose and the connection string convention.

- [ ] **Step 3: Commit**

```bash
git add deploy/compose/docker-compose.yaml docs/architecture/grid-app-database.md
git commit -m "chore: ensure grid_app database exists"
```

### Task 0.3: Add shared schema barrel

**Files:**
- Create: `frontends/ui/src/lib/db/schema/index.ts`

- [ ] **Step 1: Export all schemas**

```typescript
export * from "./conversations";
export * from "./documents";
```

- [ ] **Step 2: Update `docs/architecture/grid-app-database.md`**

Document the schema barrel and how new tables are added.

- [ ] **Step 3: Commit**

```bash
git add frontends/ui/src/lib/db/schema/index.ts docs/architecture/grid-app-database.md
git commit -m "chore: add schema barrel"
```

---

## Phase 1: WorkOS auth + org/project scaffolding

Run first because every other subsystem needs the session/authz helpers.

Use plan: `docs/superpowers/plans/2026-06-30-workos-auth-plan.md`

**Exit criteria:**
- `requireAuthorizedSession()` and `requireProjectAccess()` exist and have passing tests.
- AuthKit middleware is active.
- Org onboarding page redirects users without `org_id`.
- Python `JWTValidator` verifies WorkOS JWKS.

---

## Phase 2: Collection scoping + retrieval

Run second because conversation persistence and document upload both need to know how to compute and forward `collection_scope[]`.

Use plan: `docs/superpowers/plans/2026-06-30-collection-scoping-plan.md`

**Exit criteria:**
- `computeCollectionScope()` returns correct ordered list.
- `X-Grid-Collection-Scope` header is injected on HTTP and WebSocket paths.
- Python `knowledge_retrieval` and `available_documents` use the header.
- `configs/config_grid_oib.yml` has deprecated flags zeroed.

---

## Phase 3: Server-side conversation persistence

Run third because it depends on auth and scoping (conversation corpus needs `s_<id>`).

Use plan: `docs/superpowers/plans/2026-06-30-conversation-persistence-plan.md`

**Exit criteria:**
- `conversations` and `messages` tables exist.
- REST CRUD endpoints return data.
- WebSocket loads history on connect.
- Messages are persisted during chat.

---

## Phase 4: Document upload + MinIO

Run fourth because it depends on auth, project membership, and collection naming policy.

Use plan: `docs/superpowers/plans/2026-06-30-document-upload-minio-plan.md`

**Exit criteria:**
- MinIO service is running.
- `/api/documents/upload` writes bytes and inserts `documents` row.
- Python `/v1/ingest` fetches from presigned URL and embeds.
- Status route reflects embedding result.

---

## Phase 5: Integration verification

### Task 5.1: Run full compose stack locally

**Files:**
- All

- [ ] **Step 1: Start stack**

```bash
cd deploy/compose
docker compose up --build -d
```

- [ ] **Step 2: Verify health**

```bash
docker compose ps
```
Expected: all services healthy.

- [ ] **Step 3: Run migrations**

```bash
cd frontends/ui
npm run db:migrate
```

### Task 5.2: End-to-end smoke test

- [ ] **Step 1: Sign in via WorkOS AuthKit**
- [ ] **Step 2: Create organization**
- [ ] **Step 3: Create project (manual or via seed)**
- [ ] **Step 4: Start chat and verify messages persist after reload**
- [ ] **Step 5: Upload a PDF to project and verify it appears in retrieval**
- [ ] **Step 6: Verify agent only cites documents from allowed scopes**

### Task 5.3: Update docs

- [ ] **Step 1: Update `docs/aiq/conversations/persistence.md`** with implemented behavior.
- [ ] **Step 2: Update `docs/aiq/documents/upload-and-ingestion.md`** with new flow.
- [ ] **Step 3: Update `docs/aiq/knowledge/retrieval-and-scoping.md`** with header policy.
- [ ] **Step 4: Update `docs/architecture/multitenancy-and-auth-spec.md`** if data model changed.

### Task 5.4: Final commit + status report

```bash
git add .
git commit -m "feat: grid mvp - workos, persistence, minio, scoping"
```

---

## Rollback / safety notes

- Keep `REQUIRE_AUTH=false` fallback working for local dev until WorkOS integration is verified.
- Old `s_<uuid>` collections remain valid and TTL-reaped; new `proj_<id>` collections are created on demand.
- Python `/v1/ingest` does not delete old `/v1/collections/{name}/documents` route; it can be deprecated after BFF upload is stable.

---

## Execution handoff

Integration plan complete and saved to `docs/superpowers/plans/2026-06-30-integration-plan.md`.

Defaulting to **Subagent-Driven** implementation. Begin with Phase 0.
