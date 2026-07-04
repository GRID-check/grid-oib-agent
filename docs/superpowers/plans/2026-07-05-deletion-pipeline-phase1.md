# Deletion Pipeline Phase 1 (Projects) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Soft-delete + asynchronous purge for projects across all five stores (grid_app Postgres, aiq_jobs Postgres, aiq_checkpoints Postgres, MinIO, Chroma) plus WorkOS, with type-to-confirm UI, restore within a grace period, and legal holds that block purge.

**Architecture:** A `deletion_queue` table in grid_app is simultaneously tombstone, work queue, and audit record. A dedicated `purger` compose service (frontend image, `node purger/index.js` — plain-JS like `server.js`) polls the queue with `FOR UPDATE SKIP LOCKED`, guarded by a `legal_holds` NOT EXISTS clause, and runs ordered idempotent steps: backend internal endpoint (Chroma + job rows + checkpoints) → MinIO prefix delete → WorkOS resource → grid_app rows (project row last). The Python backend gains one internal maintenance endpoint; it still never touches grid_app (single-writer rule preserved).

**Tech Stack:** Next.js 16 App Router, Drizzle ORM (postgres-js), Zod, Radix Dialog, vitest + testing-library, FastAPI + psycopg, `postgres` npm package (purger), @aws-sdk/client-s3, @workos-inc/node.

**Spec:** `docs/superpowers/specs/2026-07-05-deletion-pipeline-design.md` (this plan implements Phase 1 only: queue + holds + purger + project deletion end-to-end).

**Environment notes (from project workflow):**
- Host `npm` hangs. Run node tooling in a throwaway container:
  `docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx vitest run <paths>`
  `docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx tsc --noEmit`
- No local docker-compose testing; verification is static (typecheck + unit tests).
- Never add SPDX/copyright headers to new files.
- Commit after every task (Conventional Commits).

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `frontends/ui/src/lib/db/schema/deletion-queue.ts` | create | Drizzle table for the queue |
| `frontends/ui/src/lib/db/schema/legal-holds.ts` | create | Drizzle table for holds |
| `frontends/ui/src/lib/db/schema/{projects,documents,conversations}.ts` | modify | add `deletedAt` |
| `frontends/ui/src/lib/db/schema/index.ts` | modify | export new tables |
| `frontends/ui/drizzle/0009_deletion_pipeline.sql` + `drizzle/meta/_journal.json` | create/modify | migration |
| `frontends/ui/src/lib/deletion/policy.ts` (+ `.spec.ts`) | create | grace-period + purge-after computation (pure, tested) |
| `frontends/ui/src/app/api/projects/[id]/route.ts` | modify | DELETE → soft-delete + enqueue; GET hides deleted |
| `frontends/ui/src/app/api/projects/route.ts` | modify | GET filters deleted |
| `frontends/ui/src/lib/authz/projects.ts` | modify | treat deleted as not-found (opt-out flag for restore) |
| `frontends/ui/src/app/api/projects/[id]/restore/route.ts` | create | restore within grace |
| `frontends/ui/src/app/api/deletions/route.ts` | create | list pending/failed deletions (org admin) |
| `frontends/ui/src/app/api/holds/route.ts`, `holds/[id]/release/route.ts` | create | legal-hold API |
| `frontends/ui/src/components/ui/type-to-confirm-dialog.tsx` (+ `.spec.tsx`) | create | reusable type-to-confirm dialog |
| `frontends/ui/src/features/projects/components/project-danger-zone.tsx` | create | delete-project UI section |
| `frontends/ui/src/features/projects/components/recently-deleted.tsx` | create | pending deletions + restore |
| `frontends/ui/src/features/projects/components/project-overview.tsx`, `src/app/app/projects/page.tsx` | modify | wire the two components in |
| `frontends/aiq_api/src/aiq_api/routes/maintenance.py` | create | internal purge endpoint (Chroma, jobs, checkpoints) |
| `frontends/aiq_api/src/aiq_api/routes/__init__.py`, `plugin.py` | modify | register route |
| `frontends/ui/purger/{index.js,db.js,minio.js,purge-project.js}` (+ `purge-project.spec.mjs`) | create | purger service (CJS, like `server.js`) |
| `frontends/ui/vitest.config.ts` | modify | include `purger/**` specs |
| `frontends/ui/deploy/Dockerfile`, `deploy/compose/docker-compose.yaml` | modify | ship + run purger |

---

### Task 1: Schema + migration (queue, holds, deleted_at, FK fixes)

**Files:**
- Create: `frontends/ui/src/lib/db/schema/deletion-queue.ts`, `frontends/ui/src/lib/db/schema/legal-holds.ts`, `frontends/ui/drizzle/0009_deletion_pipeline.sql`
- Modify: `frontends/ui/src/lib/db/schema/projects.ts`, `documents.ts`, `conversations.ts`, `index.ts`, `frontends/ui/drizzle/meta/_journal.json`

- [ ] **Step 1: Create `deletion-queue.ts`**

```ts
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export type DeletionEntityType =
  | 'project'
  | 'document'
  | 'conversation'
  | 'organization'
  | 'user'

export type DeletionStatus = 'pending' | 'purging' | 'purged' | 'restored' | 'failed'

export const deletionQueue = pgTable('deletion_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: text('entity_type').$type<DeletionEntityType>().notNull(),
  entityId: text('entity_id').notNull(),
  displayName: text('display_name').notNull(),
  organizationId: text('organization_id').notNull(),
  requestedBy: text('requested_by').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  purgedAt: timestamp('purged_at', { withTimezone: true }),
  status: text('status').$type<DeletionStatus>().notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
})

export type DeletionQueueEntry = typeof deletionQueue.$inferSelect
export type NewDeletionQueueEntry = typeof deletionQueue.$inferInsert
```

- [ ] **Step 2: Create `legal-holds.ts`**

```ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import type { DeletionEntityType } from './deletion-queue'

export const legalHolds = pgTable('legal_holds', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: text('entity_type').$type<DeletionEntityType>().notNull(),
  entityId: text('entity_id').notNull(),
  organizationId: text('organization_id').notNull(),
  reason: text('reason').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
})

export type LegalHold = typeof legalHolds.$inferSelect
export type NewLegalHold = typeof legalHolds.$inferInsert
```

- [ ] **Step 3: Add `deletedAt` to the three entity tables**

In `projects.ts`, `documents.ts`, and `conversations.ts`, add this column to the table definition (before `createdAt`):

```ts
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
```

- [ ] **Step 4: Export from `schema/index.ts`** (keep alphabetical order)

```ts
export * from './conversations'
export * from './deletion-queue'
export * from './documents'
export * from './legal-holds'
export * from './messages'
export * from './project-folders'
export * from './project-memory'
export * from './projects'
export * from './user-preferences'
```

- [ ] **Step 5: Verify FK constraint names before writing the migration**

Run: `grep -rn "conversations_project_id\|documents_folder_id" frontends/ui/drizzle/*.sql`
Expected: the exact constraint names (Drizzle convention `conversations_project_id_projects_id_fk`, `documents_folder_id_project_folders_id_fk`). If they differ, use the actual names in Step 6.

- [ ] **Step 6: Write `frontends/ui/drizzle/0009_deletion_pipeline.sql`**

```sql
CREATE TABLE "deletion_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"display_name" text NOT NULL,
	"organization_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"payload" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_queue_active_entity_idx" ON "deletion_queue" ("entity_type", "entity_id") WHERE "status" IN ('pending', 'purging');
--> statement-breakpoint
CREATE INDEX "deletion_queue_claim_idx" ON "deletion_queue" ("status", "purge_after");
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "legal_holds_active_idx" ON "legal_holds" ("entity_type", "entity_id") WHERE "released_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_folder_id_project_folders_id_fk";
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_project_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."project_folders"("id") ON DELETE cascade ON UPDATE no action;
```

Also update `conversations.ts` schema to match: `{ onDelete: 'cascade' }` instead of `{ onDelete: 'set null' }`, and check `project-folders.ts` / `documents.ts` for the `folderId` reference and set `{ onDelete: 'cascade' }` there too.

- [ ] **Step 7: Append journal entry to `frontends/ui/drizzle/meta/_journal.json`**

Add after the idx 8 entry (`when` must be greater than `1783270000000`):

```json
    {
      "idx": 9,
      "version": "7",
      "when": 1783300000000,
      "tag": "0009_deletion_pipeline",
      "breakpoints": true
    }
```

- [ ] **Step 8: Typecheck**

Run: `docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add frontends/ui/src/lib/db/schema frontends/ui/drizzle
git commit -m "feat(db): deletion_queue + legal_holds tables, deleted_at columns, cascade FK fixes"
```

---

### Task 2: Deletion policy helper (pure, TDD)

**Files:**
- Create: `frontends/ui/src/lib/deletion/policy.ts`
- Test: `frontends/ui/src/lib/deletion/policy.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { computePurgeAfter, projectGraceDays } from './policy'

describe('projectGraceDays', () => {
  it('defaults to 7 when env is unset', () => {
    delete process.env.PROJECT_PURGE_GRACE_DAYS
    expect(projectGraceDays()).toBe(7)
  })

  it('reads the env override', () => {
    process.env.PROJECT_PURGE_GRACE_DAYS = '0'
    expect(projectGraceDays()).toBe(0)
  })

  it('caps at 23 days to stay inside the GDPR one-month window', () => {
    process.env.PROJECT_PURGE_GRACE_DAYS = '90'
    expect(projectGraceDays()).toBe(23)
  })

  it('falls back to 7 on garbage input', () => {
    process.env.PROJECT_PURGE_GRACE_DAYS = 'soon'
    expect(projectGraceDays()).toBe(7)
  })
})

describe('computePurgeAfter', () => {
  it('adds whole days to the request time', () => {
    const now = new Date('2026-07-05T12:00:00Z')
    expect(computePurgeAfter(now, 7).toISOString()).toBe('2026-07-12T12:00:00.000Z')
  })

  it('returns the request time itself for zero grace', () => {
    const now = new Date('2026-07-05T12:00:00Z')
    expect(computePurgeAfter(now, 0).getTime()).toBe(now.getTime())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx vitest run src/lib/deletion/policy.spec.ts`
Expected: FAIL — cannot resolve `./policy`.

- [ ] **Step 3: Implement `policy.ts`**

```ts
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Grace must stay ≤ 23 days so grace + purge retries fit inside the GDPR
 * Art. 12(3) one-month response window for erasure requests.
 */
const MAX_GRACE_DAYS = 23
const DEFAULT_GRACE_DAYS = 7

export function projectGraceDays(): number {
  const raw = Number(process.env.PROJECT_PURGE_GRACE_DAYS)
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_GRACE_DAYS
  return Math.min(raw, MAX_GRACE_DAYS)
}

export function computePurgeAfter(requestedAt: Date, graceDays: number): Date {
  return new Date(requestedAt.getTime() + graceDays * DAY_MS)
}
```

- [ ] **Step 4: Run test to verify it passes** (same command). Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/lib/deletion
git commit -m "feat(deletion): grace-period policy helper"
```

---

### Task 3: Soft-delete DELETE endpoint + hide deleted projects

**Files:**
- Modify: `frontends/ui/src/app/api/projects/[id]/route.ts`, `frontends/ui/src/app/api/projects/route.ts:20-30`, `frontends/ui/src/lib/authz/projects.ts`

- [ ] **Step 1: Rework `DELETE` in `api/projects/[id]/route.ts`**

Replace the existing `DELETE` handler (lines 76-104) entirely. Remove the `getWorkOS` import if now unused. Add imports: `deletionQueue` from `@/lib/db/schema`, `computePurgeAfter, projectGraceDays` from `@/lib/deletion/policy`.

```ts
const deleteProjectSchema = z.object({
  confirmName: z.string().min(1),
})

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:manage')

  const body = await request.json().catch(() => null)
  const parsed = deleteProjectSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Type the project name to confirm deletion.' },
      { status: 400 },
    )
  }

  const db = getDb()
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)

  if (!project || project.deletedAt) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (parsed.data.confirmName !== project.name) {
    return NextResponse.json(
      { error: 'Project name does not match.' },
      { status: 400 },
    )
  }

  const now = new Date()
  const purgeAfter = computePurgeAfter(now, projectGraceDays())

  // Soft delete + enqueue atomically. The purger hard-deletes every store
  // after the grace period; nothing is destroyed here.
  await db.transaction(async (tx) => {
    await tx.update(projects).set({ deletedAt: now }).where(eq(projects.id, id))
    await tx
      .insert(deletionQueue)
      .values({
        entityType: 'project',
        entityId: id,
        displayName: project.name,
        organizationId: project.organizationId,
        requestedBy: session.userId,
        purgeAfter,
        payload: { collectionName: project.collectionName },
      })
      .onConflictDoNothing()
  })

  return NextResponse.json(
    { status: 'pending', purgeAfter: purgeAfter.toISOString() },
    { status: 202 },
  )
}
```

- [ ] **Step 2: Hide deleted in the same file's `GET`**

After the existing `if (!project)` check in `GET`, extend it:

```ts
  if (!project || project.deletedAt) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
```

Apply the same guard in `PATCH` by adding `isNull(projects.deletedAt)` to its `where` (import `and, isNull` from `drizzle-orm`):

```ts
    .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
```

- [ ] **Step 3: Filter the list in `api/projects/route.ts` `GET`**

```ts
import { and, eq, isNull } from 'drizzle-orm'
// ...
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, session.organizationId),
        isNull(projects.deletedAt),
      ),
    )
```

- [ ] **Step 4: Treat deleted as not-found in `requireProjectAccess`, with an opt-out for restore**

In `frontends/ui/src/lib/authz/projects.ts`, change the signature and the project lookup:

```ts
export async function requireProjectAccess(
  session: AuthorizedSession,
  projectId: string,
  permission: ProjectPermission = "project:view",
  options: { includeDeleted?: boolean } = {},
): Promise<{ role: "project-viewer" | "project-editor" | "project-admin" }> {
  // Org admins bypass per-project checks.
  if (session.role === "admin") {
    return { role: "project-admin" };
  }

  // Verify the project belongs to the current org (and is not soft-deleted,
  // unless the caller explicitly needs deleted projects, e.g. restore).
  const db = getDb();
  const [project] = await db
    .select({
      organizationId: projects.organizationId,
      deletedAt: projects.deletedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (
    !project ||
    project.organizationId !== session.organizationId ||
    (project.deletedAt && !options.includeDeleted)
  ) {
    throw new Error("Not found");
  }
  // ... rest unchanged
```

- [ ] **Step 5: Typecheck**

Run: `docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx tsc --noEmit`
Expected: no errors. (If other callers of `requireProjectAccess` break, the added parameter is optional — they should not.)

- [ ] **Step 6: Commit**

```bash
git add frontends/ui/src/app/api/projects frontends/ui/src/lib/authz/projects.ts
git commit -m "feat(projects): soft-delete with type-to-confirm contract, hide deleted projects"
```

---

### Task 4: Restore + deletions-list endpoints

**Files:**
- Create: `frontends/ui/src/app/api/projects/[id]/restore/route.ts`, `frontends/ui/src/app/api/deletions/route.ts`

- [ ] **Step 1: Create `api/projects/[id]/restore/route.ts`**

```ts
/**
 * Restore a soft-deleted project during its grace period.
 * Only valid while the deletion_queue row is still 'pending' —
 * once the purger claims it, data is being destroyed and restore is refused.
 */

import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { deletionQueue, projects } from '@/lib/db/schema'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:manage', {
    includeDeleted: true,
  })

  const db = getDb()
  const restored = await db.transaction(async (tx) => {
    const [entry] = await tx
      .update(deletionQueue)
      .set({ status: 'restored' })
      .where(
        and(
          eq(deletionQueue.entityType, 'project'),
          eq(deletionQueue.entityId, id),
          eq(deletionQueue.status, 'pending'),
        ),
      )
      .returning()

    if (!entry) return false

    await tx
      .update(projects)
      .set({ deletedAt: null })
      .where(eq(projects.id, id))
    return true
  })

  if (!restored) {
    return NextResponse.json(
      { error: 'No pending deletion to restore (already purged or purging).' },
      { status: 409 },
    )
  }

  return NextResponse.json({ status: 'restored' })
}
```

(The unused `isNull` import above is a lint error — do not import it. Final import line: `import { and, eq } from 'drizzle-orm'`.)

- [ ] **Step 2: Create `api/deletions/route.ts`**

```ts
/**
 * Lists pending/failed deletions for the current organization (org admins).
 * Powers the "Recently deleted" UI; failed rows surface stuck purges.
 */

import { NextResponse } from 'next/server'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { deletionQueue } from '@/lib/db/schema'

export async function GET(): Promise<Response> {
  const session = await requireAuthorizedSession()

  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = getDb()
  const rows = await db
    .select({
      id: deletionQueue.id,
      entityType: deletionQueue.entityType,
      entityId: deletionQueue.entityId,
      displayName: deletionQueue.displayName,
      requestedAt: deletionQueue.requestedAt,
      purgeAfter: deletionQueue.purgeAfter,
      status: deletionQueue.status,
    })
    .from(deletionQueue)
    .where(
      and(
        eq(deletionQueue.organizationId, session.organizationId),
        inArray(deletionQueue.status, ['pending', 'failed']),
      ),
    )
    .orderBy(desc(deletionQueue.requestedAt))

  return NextResponse.json(rows)
}
```

- [ ] **Step 3: Typecheck** (same docker tsc command). Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontends/ui/src/app/api/projects frontends/ui/src/app/api/deletions
git commit -m "feat(deletion): restore endpoint and org-admin deletions list"
```

---

### Task 5: Legal-hold API

**Files:**
- Create: `frontends/ui/src/app/api/holds/route.ts`, `frontends/ui/src/app/api/holds/[id]/release/route.ts`

- [ ] **Step 1: Create `api/holds/route.ts`**

```ts
/**
 * Legal holds: preserve data and block purge (GDPR Art. 18 restriction).
 * Org-admin only. No management UI yet by design — holds are rare,
 * deliberate legal events driven via API.
 */

import { NextResponse } from 'next/server'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { legalHolds } from '@/lib/db/schema'
import { z } from 'zod'

const createHoldSchema = z.object({
  entityType: z.enum(['project', 'document', 'conversation', 'organization', 'user']),
  entityId: z.string().min(1),
  reason: z.string().min(1).max(2000),
})

export async function GET(): Promise<Response> {
  const session = await requireAuthorizedSession()
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = getDb()
  const rows = await db
    .select()
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.organizationId, session.organizationId),
        isNull(legalHolds.releasedAt),
      ),
    )
    .orderBy(desc(legalHolds.createdAt))

  return NextResponse.json(rows)
}

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuthorizedSession()
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  const parsed = createHoldSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid hold request.' }, { status: 400 })
  }

  const db = getDb()
  const [hold] = await db
    .insert(legalHolds)
    .values({
      ...parsed.data,
      organizationId: session.organizationId,
      createdBy: session.userId,
    })
    .returning()

  return NextResponse.json(hold, { status: 201 })
}
```

- [ ] **Step 2: Create `api/holds/[id]/release/route.ts`**

```ts
import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { legalHolds } from '@/lib/db/schema'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { id } = await params

  const db = getDb()
  const [hold] = await db
    .update(legalHolds)
    .set({ releasedAt: new Date() })
    .where(
      and(
        eq(legalHolds.id, id),
        eq(legalHolds.organizationId, session.organizationId),
        isNull(legalHolds.releasedAt),
      ),
    )
    .returning()

  if (!hold) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(hold)
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
git add frontends/ui/src/app/api/holds
git commit -m "feat(deletion): legal-hold API (create, list, release)"
```

---

### Task 6: TypeToConfirmDialog component (TDD)

**Files:**
- Create: `frontends/ui/src/components/ui/type-to-confirm-dialog.tsx`
- Test: `frontends/ui/src/components/ui/type-to-confirm-dialog.spec.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TypeToConfirmDialog } from './type-to-confirm-dialog'

function renderDialog(onConfirm = vi.fn()) {
  render(
    <TypeToConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete project"
      description="This permanently deletes everything."
      confirmName="Alpha Plant"
      confirmLabel="Delete project"
      onConfirm={onConfirm}
    />,
  )
  return onConfirm
}

describe('TypeToConfirmDialog', () => {
  it('disables the destructive button until the exact name is typed', async () => {
    const user = userEvent.setup()
    renderDialog()
    const button = screen.getByRole('button', { name: 'Delete project' })
    expect(button).toBeDisabled()

    await user.type(screen.getByRole('textbox'), 'alpha plant')
    expect(button).toBeDisabled()
  })

  it('enables and fires onConfirm on an exact match', async () => {
    const user = userEvent.setup()
    const onConfirm = renderDialog()

    await user.type(screen.getByRole('textbox'), 'Alpha Plant')
    const button = screen.getByRole('button', { name: 'Delete project' })
    expect(button).toBeEnabled()

    await user.click(button)
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('disables everything while pending', async () => {
    const user = userEvent.setup()
    render(
      <TypeToConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete project"
        description="desc"
        confirmName="Alpha Plant"
        confirmLabel="Delete project"
        onConfirm={vi.fn()}
        pending
      />,
    )
    await user.type(screen.getByRole('textbox'), 'Alpha Plant')
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx vitest run src/components/ui/type-to-confirm-dialog.spec.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
'use client'

import { useId, useState, type FC, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface TypeToConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  /** The exact string the user must type (e.g. the project name). */
  confirmName: string
  /** Label of the destructive button. */
  confirmLabel: string
  onConfirm: () => void | Promise<void>
  /** Disables all controls while the deletion request is in flight. */
  pending?: boolean
}

export const TypeToConfirmDialog: FC<TypeToConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmName,
  confirmLabel,
  onConfirm,
  pending = false,
}) => {
  const [value, setValue] = useState('')
  const inputId = useId()
  const matches = value === confirmName

  const handleOpenChange = (next: boolean) => {
    if (pending) return
    if (!next) setValue('')
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />
            <span>{title}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="text-sm">{description}</div>
          <label htmlFor={inputId} className="text-sm">
            Type <span className="font-semibold">{confirmName}</span> to confirm:
          </label>
          <Input
            id={inputId}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={confirmName}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={!matches || pending}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run test to verify it passes** (same command). Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/components/ui/type-to-confirm-dialog.tsx frontends/ui/src/components/ui/type-to-confirm-dialog.spec.tsx
git commit -m "feat(ui): reusable type-to-confirm destructive dialog"
```

---

### Task 7: Wire deletion into the project UI

**Files:**
- Create: `frontends/ui/src/features/projects/components/project-danger-zone.tsx`, `frontends/ui/src/features/projects/components/recently-deleted.tsx`
- Modify: `frontends/ui/src/features/projects/components/project-overview.tsx`, `frontends/ui/src/app/app/projects/page.tsx`

- [ ] **Step 1: Create `project-danger-zone.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { TypeToConfirmDialog } from '@/components/ui/type-to-confirm-dialog'

export interface ProjectDangerZoneProps {
  projectId: string
  projectName: string
}

export function ProjectDangerZone({ projectId, projectName }: ProjectDangerZoneProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  const handleConfirm = async () => {
    setPending(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmName: projectName }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? 'Failed to delete project.')
      }
      toast.success('Project deleted. It can be restored from "Recently deleted" during the grace period.')
      router.push('/app/projects')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete project.')
      setPending(false)
      setOpen(false)
    }
  }

  return (
    <section className="rounded-lg border border-destructive/40 p-4">
      <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Deleting a project removes its documents, chats, research history, and
        knowledge base everywhere. Restorable for a limited grace period, then
        permanently purged.
      </p>
      <Button
        variant="destructive"
        className="mt-3"
        onClick={() => setOpen(true)}
      >
        Delete project
      </Button>
      <TypeToConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete project"
        description={
          <p>
            This deletes <span className="font-semibold">{projectName}</span> and
            all associated data across the entire app: files, chats, research
            runs, and its knowledge base.
          </p>
        }
        confirmName={projectName}
        confirmLabel="Delete project"
        onConfirm={handleConfirm}
        pending={pending}
      />
    </section>
  )
}
```

- [ ] **Step 2: Create `recently-deleted.tsx`**

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

interface DeletionEntry {
  id: string
  entityType: string
  entityId: string
  displayName: string
  purgeAfter: string
  status: 'pending' | 'failed'
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/**
 * Org-admin panel of pending deletions with restore. Renders nothing for
 * non-admins (the API returns 403) or when there is nothing pending.
 */
export function RecentlyDeleted() {
  const [entries, setEntries] = useState<DeletionEntry[]>([])

  const refresh = useCallback(async () => {
    const res = await fetch('/api/deletions')
    if (!res.ok) return
    const rows: DeletionEntry[] = await res.json()
    setEntries(rows.filter((row) => row.entityType === 'project'))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleRestore = async (entry: DeletionEntry) => {
    const res = await fetch(`/api/projects/${entry.entityId}/restore`, {
      method: 'POST',
    })
    if (res.ok) {
      toast.success(`Restored "${entry.displayName}".`)
      await refresh()
    } else {
      const data = await res.json().catch(() => null)
      toast.error(data?.error ?? 'Restore failed.')
    }
  }

  if (entries.length === 0) return null

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-muted-foreground">
        Recently deleted
      </h2>
      <ul className="mt-2 flex flex-col gap-2">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center justify-between rounded-lg border p-3"
          >
            <div>
              <p className="text-sm font-medium">{entry.displayName}</p>
              <p className="text-xs text-muted-foreground">
                {entry.status === 'failed'
                  ? 'Purge failed — contact support'
                  : `Permanently purged after ${dateFormatter.format(new Date(entry.purgeAfter))}`}
              </p>
            </div>
            {entry.status === 'pending' && (
              <Button variant="outline" size="sm" onClick={() => void handleRestore(entry)}>
                Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 3: Wire `ProjectDangerZone` into `project-overview.tsx`**

Open `frontends/ui/src/features/projects/components/project-overview.tsx`. First check the props shape: `grep -n "ProjectOverviewProps" -A 8 frontends/ui/src/features/projects/components/project-overview.tsx` to learn how the project's `id` and `name` are accessed from `data`. Then add the import and render `<ProjectDangerZone projectId={…} projectName={…} />` as the last child of the component's top-level container (inside `ProjectOverview`'s returned JSX, after the existing sections), using the accessors found. Only project admins can successfully delete (the API enforces `project:manage`), so no client-side role gating is needed beyond what the API returns.

- [ ] **Step 4: Wire `RecentlyDeleted` into `src/app/app/projects/page.tsx`**

Add `import { RecentlyDeleted } from '@/features/projects/components/recently-deleted'` and render `<RecentlyDeleted />` after the projects list/grid in the page's JSX (bottom of the main container).

- [ ] **Step 5: Typecheck + run component tests**

```
docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx tsc --noEmit
docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx vitest run src/features/projects
```
Expected: no type errors; existing project specs still pass.

- [ ] **Step 6: Commit**

```bash
git add frontends/ui/src/features/projects/components frontends/ui/src/app/app/projects/page.tsx
git commit -m "feat(projects): delete-project danger zone and recently-deleted restore panel"
```

---

### Task 8: Backend internal purge endpoint (Chroma + jobs + checkpoints)

**Files:**
- Create: `frontends/aiq_api/src/aiq_api/routes/maintenance.py`
- Modify: `frontends/aiq_api/src/aiq_api/routes/__init__.py`, `frontends/aiq_api/src/aiq_api/plugin.py:208-212`

- [ ] **Step 1: Create `maintenance.py`**

```python
"""Internal maintenance endpoints used by the purger service.

Deletes the Python-side resources of a purged project: the Chroma
collection (+ its summaries), aiq_jobs rows, and LangGraph checkpoints.
Guarded by GRID_INTERNAL_API_TOKEN; never exposed to end users.
All operations are idempotent — re-running on already-deleted data is a no-op.
"""

import logging
import os

import psycopg
from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class PurgeProjectResourcesRequest(BaseModel):
    collection_name: str | None = None
    conversation_ids: list[str] = []


def _require_internal_token(request: Request) -> None:
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token or request.headers.get("x-internal-token") != token:
        raise HTTPException(status_code=403, detail="Forbidden")


def _jobs_dsn() -> str | None:
    dsn = os.environ.get("AIQ_SUMMARY_DB")
    return dsn.replace("+psycopg", "") if dsn else None


async def _purge_jobs(collection_name: str) -> int:
    """Delete job rows whose events reference the project's collection.

    job_info has no project/collection column (see spec §4), so matching is
    LIKE-based on job_events.event_data. Collection names are `proj_<uuid>`,
    unique enough for a substring match. Improvement tracked for Phase 4:
    tag job_info with a collection column at submission time.
    """
    dsn = _jobs_dsn()
    if dsn is None:
        return 0
    pattern = f"%{collection_name}%"
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT DISTINCT job_id FROM job_events WHERE event_data LIKE %s",
                (pattern,),
            )
            job_ids = [row[0] for row in await cur.fetchall()]
            if not job_ids:
                return 0
            await cur.execute(
                "DELETE FROM job_events WHERE job_id = ANY(%s)", (job_ids,)
            )
            await cur.execute(
                "DELETE FROM job_access WHERE job_id = ANY(%s)", (job_ids,)
            )
            await cur.execute(
                "DELETE FROM job_info WHERE job_id = ANY(%s)", (job_ids,)
            )
        await conn.commit()
    return len(job_ids)


async def _purge_checkpoints(conversation_ids: list[str]) -> None:
    dsn = os.environ.get("AIQ_CHECKPOINT_DB")
    if not dsn or not conversation_ids:
        return
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        async with conn.cursor() as cur:
            for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
                await cur.execute(
                    f"DELETE FROM {table} WHERE thread_id = ANY(%s)",  # nosec B608 - fixed table names
                    (conversation_ids,),
                )
        await conn.commit()


def add_maintenance_routes(router: APIRouter) -> None:
    """Add internal maintenance routes to the FastAPI app."""

    @router.post(
        "/v1/maintenance/purge-project-resources",
        tags=["maintenance"],
        summary="Purge Python-side resources of a deleted project (internal)",
    )
    async def purge_project_resources(
        body: PurgeProjectResourcesRequest,
        request: Request,
    ) -> dict:
        _require_internal_token(request)

        collection_deleted = False
        jobs_deleted = 0

        if body.collection_name:
            from aiq_agent.knowledge.factory import clear_collection_summaries
            from aiq_agent.knowledge.factory import get_active_ingestor

            ingestor = get_active_ingestor()
            if ingestor is not None and ingestor.get_collection(body.collection_name):
                collection_deleted = ingestor.delete_collection(body.collection_name)
            # delete_collection clears summaries too, but run it explicitly so a
            # previously half-failed purge (collection gone, summaries left) heals.
            clear_collection_summaries(body.collection_name)
            jobs_deleted = await _purge_jobs(body.collection_name)

        await _purge_checkpoints(body.conversation_ids)

        return {
            "collection_deleted": collection_deleted,
            "jobs_deleted": jobs_deleted,
            "checkpoints_purged_for": len(body.conversation_ids),
        }
```

Before finishing, verify the factory function names: `grep -n "def clear_collection_summaries\|def get_active_ingestor" src/aiq_agent/knowledge/factory.py` — adjust imports if signatures differ (e.g. `clear_collection_summaries` may be async; if `grep -n "async def clear_collection_summaries"` matches, `await` it).

- [ ] **Step 2: Register the route**

In `frontends/aiq_api/src/aiq_api/routes/__init__.py`, add alongside the existing imports/exports:

```python
from .maintenance import add_maintenance_routes
```

and `"add_maintenance_routes",` in `__all__`.

In `frontends/aiq_api/src/aiq_api/plugin.py`: add `from .routes.maintenance import add_maintenance_routes` next to the other route imports (near line 58), and `add_maintenance_routes(knowledge_router)` after `add_oib_routes(knowledge_router)` (line 212).

- [ ] **Step 3: Static check**

Run: `docker run --rm -v "F:/GRID/grid-oib-agent:/repo" -w /repo python:3.12-slim python -m py_compile frontends/aiq_api/src/aiq_api/routes/maintenance.py`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontends/aiq_api/src/aiq_api
git commit -m "feat(api): internal purge-project-resources endpoint (chroma, jobs, checkpoints)"
```

---

### Task 9: Purger service (TDD on the step logic)

**Files:**
- Create: `frontends/ui/purger/db.js`, `purger/minio.js`, `purger/purge-project.js`, `purger/index.js`
- Test: `frontends/ui/purger/purge-project.spec.mjs`
- Modify: `frontends/ui/vitest.config.ts:13`

CJS modules (like `server.js`) so `node purger/index.js` runs in the production image without a build step. All dependencies (`postgres`, `@aws-sdk/client-s3`, `@workos-inc/node`) are already in `package.json`.

- [ ] **Step 1: Extend vitest include** in `vitest.config.ts`:

```ts
    include: [
      'src/**/*.{spec,test}.{ts,tsx}',
      'tests/**/*.test.{ts,tsx}',
      'purger/**/*.spec.mjs',
    ],
```

- [ ] **Step 2: Write the failing test `purger/purge-project.spec.mjs`**

```js
import { describe, expect, it, vi } from 'vitest'
import { purgeProject } from './purge-project.js'

function makeTx({ projectRow, conversationRows }) {
  const executed = []
  const tx = (strings, ...values) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    executed.push({ text, values })
    if (text.startsWith('SELECT') && text.includes('FROM projects')) {
      return Promise.resolve(projectRow ? [projectRow] : [])
    }
    if (text.startsWith('SELECT') && text.includes('FROM conversations')) {
      return Promise.resolve(conversationRows)
    }
    return Promise.resolve([])
  }
  return { tx, executed }
}

function makeDeps(overrides = {}) {
  return {
    backendUrl: 'http://backend:8000',
    internalToken: 'tok',
    bucket: 'grid-documents',
    fetchImpl: vi.fn().mockResolvedValue({ ok: true }),
    deleteMinioPrefix: vi.fn().mockResolvedValue(3),
    workos: {
      authorization: {
        deleteResourceByExternalId: vi.fn().mockResolvedValue(undefined),
      },
    },
    ...overrides,
  }
}

const entry = {
  id: 'q1',
  entity_id: 'p1',
  organization_id: 'org1',
  payload: { collectionName: 'proj_fallback' },
}

describe('purgeProject', () => {
  it('runs steps in order: backend, minio, workos, rows — project row last', async () => {
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc', name: 'Alpha' },
      conversationRows: [{ id: 'c1' }, { id: 'c2' }],
    })
    const deps = makeDeps()

    await purgeProject(tx, entry, deps)

    const backendCall = deps.fetchImpl.mock.calls[0]
    expect(backendCall[0]).toBe('http://backend:8000/v1/maintenance/purge-project-resources')
    expect(JSON.parse(backendCall[1].body)).toEqual({
      collection_name: 'proj_abc',
      conversation_ids: ['c1', 'c2'],
    })
    expect(deps.deleteMinioPrefix).toHaveBeenCalledWith(
      'grid-documents',
      'org/org1/project/p1/',
    )
    expect(deps.workos.authorization.deleteResourceByExternalId).toHaveBeenCalledWith({
      organizationId: 'org1',
      resourceTypeSlug: 'project',
      externalId: 'p1',
      cascadeDelete: true,
    })
    const deletes = executed.filter((q) => q.text.startsWith('DELETE'))
    expect(deletes.at(-1).text).toContain('FROM projects')
  })

  it('falls back to payload pointers when the project row is already gone', async () => {
    const { tx } = makeTx({ projectRow: null, conversationRows: [] })
    const deps = makeDeps()

    await purgeProject(tx, entry, deps)

    const body = JSON.parse(deps.fetchImpl.mock.calls[0][1].body)
    expect(body.collection_name).toBe('proj_fallback')
  })

  it('propagates backend failure without touching grid_app rows', async () => {
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [],
    })
    const deps = makeDeps({
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 502 }),
    })

    await expect(purgeProject(tx, entry, deps)).rejects.toThrow(/backend purge failed/)
    expect(executed.some((q) => q.text.startsWith('DELETE'))).toBe(false)
  })

  it('treats an already-deleted WorkOS resource as success (idempotency)', async () => {
    const { tx } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [],
    })
    const notFound = Object.assign(new Error('Resource not found'), { status: 404 })
    const deps = makeDeps({
      workos: {
        authorization: {
          deleteResourceByExternalId: vi.fn().mockRejectedValue(notFound),
        },
      },
    })

    await expect(purgeProject(tx, entry, deps)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx vitest run purger/purge-project.spec.mjs`
Expected: FAIL — `./purge-project.js` not found.

- [ ] **Step 4: Implement `purger/purge-project.js`**

```js
/**
 * Ordered, idempotent purge steps for one project. Runs inside a single
 * grid_app transaction (`tx`) held open by the caller: the queue row stays
 * locked, and grid_app rows are only deleted after every external store
 * confirmed cleanup — the project row dies last so pointers stay recoverable.
 */

function isNotFound(error) {
  return error && (error.status === 404 || /not found/i.test(String(error.message)))
}

async function purgeProject(tx, entry, deps) {
  const { backendUrl, internalToken, bucket, workos, deleteMinioPrefix } = deps
  const fetchImpl = deps.fetchImpl || fetch
  const projectId = entry.entity_id
  const orgId = entry.organization_id

  // Gather pointers BEFORE destroying anything. Fall back to the payload
  // snapshot if a previous partial run already removed the row.
  const [project] = await tx`SELECT * FROM projects WHERE id = ${projectId}`
  const collectionName = project
    ? project.collection_name
    : (entry.payload && entry.payload.collectionName) || null
  const conversations = await tx`SELECT id FROM conversations WHERE project_id = ${projectId}`

  // 1. Python-side stores: Chroma collection, summaries, job rows, checkpoints.
  const res = await fetchImpl(`${backendUrl}/v1/maintenance/purge-project-resources`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': internalToken,
    },
    body: JSON.stringify({
      collection_name: collectionName,
      conversation_ids: conversations.map((c) => c.id),
    }),
  })
  if (!res.ok) {
    throw new Error(`backend purge failed with status ${res.status}`)
  }

  // 2. MinIO objects under the project prefix.
  await deleteMinioPrefix(bucket, `org/${orgId}/project/${projectId}/`)

  // 3. WorkOS FGA resource (+ role assignments). Already-gone is success.
  try {
    await workos.authorization.deleteResourceByExternalId({
      organizationId: orgId,
      resourceTypeSlug: 'project',
      externalId: projectId,
      cascadeDelete: true,
    })
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  // 4. grid_app rows: conversations explicitly (messages cascade), then the
  //    project row (documents / folders / project-scoped memory cascade).
  await tx`DELETE FROM conversations WHERE project_id = ${projectId}`
  await tx`DELETE FROM projects WHERE id = ${projectId}`
}

module.exports = { purgeProject }
```

- [ ] **Step 5: Run test to verify it passes** (same command). Expected: PASS (4 tests).

- [ ] **Step 6: Implement `purger/minio.js`**

```js
/**
 * Prefix-based MinIO cleanup. Paginated list + batched delete; a prefix with
 * no objects is a successful no-op (idempotent re-runs).
 */

const {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} = require('@aws-sdk/client-s3')

function createS3Client() {
  return new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY || '',
      secretAccessKey: process.env.MINIO_SECRET_KEY || '',
    },
    forcePathStyle: true,
  })
}

async function deleteMinioPrefix(s3, bucket, prefix) {
  let deleted = 0
  let continuationToken
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    const keys = (page.Contents || []).map((obj) => ({ Key: obj.Key }))
    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }),
      )
      deleted += keys.length
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)
  return deleted
}

module.exports = { createS3Client, deleteMinioPrefix }
```

- [ ] **Step 7: Implement `purger/db.js`**

```js
const postgres = require('postgres')

function createSql() {
  const url = process.env.GRID_APP_DATABASE_URL
  if (!url) throw new Error('GRID_APP_DATABASE_URL is not defined')
  return postgres(url, { prepare: false })
}

const MAX_ATTEMPTS = 10
const STALE_CLAIM_MINUTES = 15

/**
 * Claim one due queue entry. Guards:
 * - legal holds (entity-level, or org-level covering everything in the org)
 * - stale 'purging' rows from a crashed purger are re-claimable after 15 min
 * The row lock (FOR UPDATE SKIP LOCKED) serializes competing purgers and
 * purge-vs-restore races.
 */
async function claimNext(tx) {
  const rows = await tx`
    SELECT q.* FROM deletion_queue q
    WHERE (
        (q.status = 'pending' AND q.purge_after <= now())
        OR (q.status = 'purging' AND q.claimed_at < now() - make_interval(mins => ${STALE_CLAIM_MINUTES}))
      )
      AND q.attempts < ${MAX_ATTEMPTS}
      AND NOT EXISTS (
        SELECT 1 FROM legal_holds h
        WHERE h.released_at IS NULL
          AND (
            (h.entity_type = q.entity_type AND h.entity_id = q.entity_id)
            OR (h.entity_type = 'organization' AND h.entity_id = q.organization_id)
          )
      )
    ORDER BY q.requested_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  `
  if (rows.length === 0) return null
  const entry = rows[0]
  await tx`
    UPDATE deletion_queue
    SET status = 'purging', claimed_at = now(), attempts = attempts + 1
    WHERE id = ${entry.id}
  `
  return entry
}

async function markPurged(sql, entryId) {
  await sql`
    UPDATE deletion_queue
    SET status = 'purged', purged_at = now(), last_error = NULL
    WHERE id = ${entryId}
  `
}

async function markFailed(sql, entryId, message) {
  await sql`
    UPDATE deletion_queue
    SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
        last_error = ${String(message).slice(0, 2000)}
    WHERE id = ${entryId}
  `
}

module.exports = { claimNext, createSql, markFailed, markPurged, MAX_ATTEMPTS }
```

- [ ] **Step 8: Implement `purger/index.js`**

```js
/**
 * GRID purger service.
 *
 * Dedicated container (frontend image, `node purger/index.js`) that polls the
 * deletion_queue in grid_app and hard-deletes soft-deleted entities across all
 * stores after their grace period. See
 * docs/superpowers/specs/2026-07-05-deletion-pipeline-design.md.
 *
 * Environment:
 *   GRID_APP_DATABASE_URL   - grid_app Postgres DSN
 *   BACKEND_URL             - aiq-agent base URL (Python-side purge endpoint)
 *   GRID_INTERNAL_API_TOKEN - shared token for the internal endpoint
 *   MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_BUCKET
 *   WORKOS_API_KEY          - WorkOS API key (FGA resource cleanup)
 *   PURGER_POLL_INTERVAL_MS - poll interval (default 60000)
 */

const { WorkOS } = require('@workos-inc/node')
const { claimNext, createSql, markFailed, markPurged } = require('./db')
const { createS3Client, deleteMinioPrefix } = require('./minio')
const { purgeProject } = require('./purge-project')

const pollIntervalMs = parseInt(process.env.PURGER_POLL_INTERVAL_MS || '60000', 10)

const sql = createSql()
const s3 = createS3Client()
const workos = new WorkOS(process.env.WORKOS_API_KEY)

const deps = {
  backendUrl: (process.env.BACKEND_URL || 'http://aiq-agent:8000').replace(/\/$/, ''),
  internalToken: process.env.GRID_INTERNAL_API_TOKEN || '',
  bucket: process.env.MINIO_BUCKET || 'grid-documents',
  workos,
  deleteMinioPrefix: (bucket, prefix) => deleteMinioPrefix(s3, bucket, prefix),
}

const purgers = {
  project: purgeProject,
  // document / conversation / organization / user: later phases
}

async function processOne() {
  let claimed = null
  try {
    const result = await sql.begin(async (tx) => {
      const entry = await claimNext(tx)
      if (!entry) return null
      claimed = entry
      const purge = purgers[entry.entity_type]
      if (!purge) {
        throw new Error(`no purger for entity_type '${entry.entity_type}'`)
      }
      await purge(tx, entry, deps)
      return entry
    })
    if (result) {
      await markPurged(sql, result.id)
      console.log(`[purger] purged ${result.entity_type} ${result.entity_id} ("${result.display_name}")`)
      return true
    }
    return false
  } catch (error) {
    console.error('[purger] purge failed:', error)
    if (claimed) {
      await markFailed(sql, claimed.id, error.message || error).catch((e) =>
        console.error('[purger] failed to record error:', e),
      )
    }
    return false
  }
}

let running = false
async function tick() {
  if (running) return
  running = true
  try {
    // Drain everything due, one at a time.
    while (await processOne()) {
      /* keep going */
    }
  } finally {
    running = false
  }
}

console.log(`[purger] started, polling every ${pollIntervalMs}ms`)
void tick()
setInterval(() => void tick(), pollIntervalMs)
```

Note on transactionality: a failure inside `sql.begin` rolls back the claim (`status='purging'`) together with any grid_app deletes — so `markFailed` runs against a row still in `pending`... **it does not**: the claim UPDATE rolled back too, meaning attempts weren't persisted. That silently loses attempt counting. Fix: persist the claim in its own short transaction. Replace `processOne` with:

```js
async function processOne() {
  // Phase A: claim (own transaction so the claim + attempts survive failures).
  const claimed = await sql.begin(async (tx) => claimNext(tx))
  if (!claimed) return false

  // Phase B: purge. grid_app row deletes are atomic within this transaction;
  // external steps are idempotent so a mid-flight crash re-runs safely after
  // the 15-minute stale-claim window.
  try {
    const purge = purgers[claimed.entity_type]
    if (!purge) throw new Error(`no purger for entity_type '${claimed.entity_type}'`)
    await sql.begin(async (tx) => purge(tx, claimed, deps))
    await markPurged(sql, claimed.id)
    console.log(`[purger] purged ${claimed.entity_type} ${claimed.entity_id} ("${claimed.display_name}")`)
    return true
  } catch (error) {
    console.error('[purger] purge failed:', error)
    await markFailed(sql, claimed.id, error.message || error).catch((e) =>
      console.error('[purger] failed to record error:', e),
    )
    return false
  }
}
```

Use this second version; do not include the first.

- [ ] **Step 9: Run the full purger test suite + typecheck**

```
docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx vitest run purger
docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx tsc --noEmit
```
Expected: PASS; no type errors (purger is JS, excluded from tsc by tsconfig `include` — verify with `grep -n "include" frontends/ui/tsconfig.json`; if `purger` gets picked up, add it to `exclude`).

- [ ] **Step 10: Commit**

```bash
git add frontends/ui/purger frontends/ui/vitest.config.ts
git commit -m "feat(purger): queue-polling purge service with legal-hold guard and stale-claim recovery"
```

---

### Task 10: Ship the purger (Dockerfile + compose)

**Files:**
- Modify: `frontends/ui/deploy/Dockerfile:128-135`, `deploy/compose/docker-compose.yaml`

- [ ] **Step 1: Copy the purger into the runner image** — in `frontends/ui/deploy/Dockerfile`, after the `server.js` COPY line (133):

```dockerfile
COPY --from=builder --chown=nextjs:nodejs /app/purger ./purger
```

- [ ] **Step 2: Add the grace-period env to the `frontend` service** in `deploy/compose/docker-compose.yaml` (in the `frontend` `environment:` block):

```yaml
      - PROJECT_PURGE_GRACE_DAYS=${PROJECT_PURGE_GRACE_DAYS:-7}
```

- [ ] **Step 3: Add the `purger` service** after the `frontend` service block:

```yaml
  purger:
    image: ${FRONTEND_IMAGE:-nvcr.io/nvidia/blueprint/aiq-frontend:2.0.0}
    build:
      context: ../../frontends/ui
      dockerfile: deploy/Dockerfile
    container_name: grid-purger
    command: ["node", "purger/index.js"]
    environment:
      - GRID_APP_DATABASE_URL=${GRID_APP_DATABASE_URL:-postgresql://aiq:aiq_dev@postgres:5432/grid_app}
      - BACKEND_URL=${BACKEND_URL:-http://aiq-agent:8000}
      - GRID_INTERNAL_API_TOKEN=${GRID_INTERNAL_API_TOKEN:-grid-internal-dev-token}
      - MINIO_ENDPOINT=http://minio:9000
      - MINIO_ACCESS_KEY=minioadmin
      - MINIO_SECRET_KEY=minioadmin
      - MINIO_BUCKET=grid-documents
      - WORKOS_API_KEY=${WORKOS_API_KEY}
      - PURGER_POLL_INTERVAL_MS=${PURGER_POLL_INTERVAL_MS:-60000}
    networks:
      - aiq-network
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_healthy
      aiq-agent:
        condition: service_healthy
    restart: unless-stopped
```

No ports — the purger accepts no inbound traffic.

- [ ] **Step 4: Validate compose syntax**

Run: `docker compose -f deploy/compose/docker-compose.yaml config --quiet`
Expected: exit 0 (warnings about missing env vars are fine).

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/deploy/Dockerfile deploy/compose/docker-compose.yaml
git commit -m "feat(deploy): dedicated purger service (frontend image, no inbound ports)"
```

---

### Task 11: Final verification + docs

- [ ] **Step 1: Full frontend check**

```
docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx tsc --noEmit
docker run --rm -v "F:/GRID/grid-oib-agent/frontends/ui:/app" -w /app node:22 npx vitest run
```
Expected: typecheck clean; full suite passes (pre-existing failures unrelated to this work are acceptable — note them).

- [ ] **Step 2: Verify spec coverage against `docs/superpowers/specs/2026-07-05-deletion-pipeline-design.md` Phase 1**: queue ✓, holds + reaper guard ✓, purger service ✓, project soft-delete + type-to-confirm ✓, restore + recently-deleted ✓, migrations (FK cascades) ✓, GDPR grace cap ✓.

- [ ] **Step 3: Commit any stragglers and update the spec status line to `Status: Phase 1 implemented`.**

```bash
git add -A docs/superpowers
git commit -m "docs: mark deletion pipeline phase 1 implemented"
```
