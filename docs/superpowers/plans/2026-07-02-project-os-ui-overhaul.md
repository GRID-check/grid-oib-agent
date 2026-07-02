# Project OS UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the UI around projects as the primary product object, with an overview home, normalized folders, project file management, PDF/image previews, folder-aware uploads, and project-scoped chat inside one shared shell.

**Architecture:** Keep the Next.js BFF as the authority for authorization, project metadata, folder validation, MinIO keys, previews, and overview aggregation. Add a normalized folder model in Drizzle/Postgres, expose folder-aware APIs, then replace the current document table with focused client components for tree navigation, upload intake, file browser, and preview/details. Preserve existing chat and ingestion behavior while moving chat into the project shell hierarchy.

**Tech Stack:** Next.js App Router, React 18, TypeScript, Tailwind, Drizzle/Postgres, MinIO/S3 SDK, Vitest, Testing Library, `react-complex-tree`, Uppy.

---

## Scope Check

The approved spec covers UI shell, overview, folders, upload, preview, chat integration, README repositioning, and testing. This plan keeps those in one phased implementation because the user explicitly approved the full overhaul and the phases produce independently testable slices. Profile capture/setup wizard implementation remains out of scope and is consumed through the existing `projects.profile*` columns already present in this branch.

## File Structure Map

### Data And API

- Modify: `frontends/ui/package.json` and lockfile to add `react-complex-tree`, `@uppy/core`, `@uppy/react`, and `@uppy/xhr-upload`.
- Create: `frontends/ui/src/lib/projects/folders.ts` for folder name validation, path joining, path normalization, folder tree shaping, and MinIO-safe folder segment helpers.
- Test: `frontends/ui/src/lib/projects/folders.spec.ts`.
- Create: `frontends/ui/src/lib/db/schema/project-folders.ts` for the normalized `project_folders` Drizzle table.
- Modify: `frontends/ui/src/lib/db/schema/documents.ts` to add nullable `folderId` and index it.
- Modify: `frontends/ui/src/lib/db/schema/index.ts` to export project folders.
- Create: `frontends/ui/drizzle/0005_project_folders.sql` and update `frontends/ui/drizzle/meta/_journal.json` using `npm run db:migrate` when a database is available; if generation cannot run locally, hand-write SQL and call that out in verification.
- Create: `frontends/ui/src/lib/projects/folder-service.ts` for authorized folder reads/creates and document folder joins.
- Test: `frontends/ui/src/lib/projects/folder-service.spec.ts`.
- Create: `frontends/ui/src/app/api/projects/[id]/folders/route.ts` for `GET` and `POST`.
- Test: `frontends/ui/src/app/api/projects/[id]/folders/route.spec.ts`.
- Modify: `frontends/ui/src/lib/s3.ts` so MinIO keys include folder hierarchy when `folderPath` is supplied.
- Test: `frontends/ui/src/lib/s3.spec.ts`.
- Modify: `frontends/ui/src/app/api/documents/upload/route.ts` to accept `folderId`, authorize it, derive `minioKey`, and persist `folderId`.
- Modify: `frontends/ui/src/app/api/documents/route.ts` to return path-aware rows.
- Create: `frontends/ui/src/app/api/documents/[id]/preview/route.ts` for inline authorized PDF/image previews.
- Test: `frontends/ui/src/app/api/documents/[id]/preview/route.spec.ts`.
- Create: `frontends/ui/src/app/api/projects/[id]/overview/route.ts` for overview aggregation.
- Test: `frontends/ui/src/app/api/projects/[id]/overview/route.spec.ts`.

### Project Shell And Overview

- Modify: `frontends/ui/src/components/projects/project-shell.tsx` to add Overview, Files, Ask Grid, Members navigation and calmer project chrome.
- Test: `frontends/ui/src/components/projects/project-shell.spec.tsx`.
- Modify: `frontends/ui/src/app/projects/[id]/page.tsx` to render the overview instead of the file explorer table.
- Create: `frontends/ui/src/features/projects/types.ts` for overview DTOs shared by route and components.
- Create: `frontends/ui/src/features/projects/components/project-overview.tsx` for the server-fed overview layout.
- Create: `frontends/ui/src/features/projects/components/project-overview.spec.tsx`.
- Modify: `frontends/ui/src/components/projects/project-card.tsx` so the main CTA opens the overview and Files/Ask Grid are secondary actions.
- Modify: `frontends/ui/src/app/page.tsx` so authenticated users are sent toward `/projects` instead of the chat-first home.

### File Workspace

- Create: `frontends/ui/src/app/projects/[id]/files/page.tsx` for the project file manager route.
- Create: `frontends/ui/src/features/documents/components/project-file-workspace.tsx` for the three-pane layout and state orchestration.
- Create: `frontends/ui/src/features/documents/components/folder-tree-pane.tsx` for `react-complex-tree` navigation.
- Create: `frontends/ui/src/features/documents/components/file-browser-pane.tsx` for grid/list, search, filter, sort, and status display.
- Create: `frontends/ui/src/features/documents/components/file-preview-pane.tsx` for PDF/image preview, metadata, download, and unsupported-file states.
- Create: `frontends/ui/src/features/documents/components/project-uppy-upload.tsx` for native-feeling Uppy upload intake.
- Modify: `frontends/ui/src/features/documents/hooks/use-project-documents.ts` and `frontends/ui/src/features/documents/hooks/use-file-upload.ts` to pass `folderId` to project uploads.
- Test: focused component tests beside each new component plus upload hook assertions in `frontends/ui/src/features/documents/hooks/use-file-upload.spec.ts`.

### Chat And Documentation

- Modify: `frontends/ui/src/app/projects/[id]/chat/page.tsx` and `frontends/ui/src/app/projects/[id]/chat/layout.tsx` so chat renders inside the shared project shell without duplicate chrome.
- Modify: `frontends/ui/src/features/layout/components/MainLayout.tsx` only where needed to support project-shell embedding cleanly.
- Test: `frontends/ui/src/features/layout/components/MainLayout.spec.tsx` and project chat route/component tests if existing harness supports them.
- Modify: `frontends/ui/README.md` to position Grid as a project-centered operating system for architects.

---

## Task 1: Add Folder Path Utilities

**Files:**
- Create: `frontends/ui/src/lib/projects/folders.ts`
- Create: `frontends/ui/src/lib/projects/folders.spec.ts`

- [ ] **Step 1: Write failing tests for folder name and path handling**

Create `frontends/ui/src/lib/projects/folders.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  buildFolderPath,
  normalizeFolderName,
  normalizeFolderPath,
  pathSegments,
  validateFolderName,
} from './folders'

describe('folder utilities', () => {
  it('normalizes a user supplied folder name', () => {
    expect(normalizeFolderName('  Fire Safety  ')).toBe('Fire Safety')
    expect(normalizeFolderName('Plans/Fire')).toBe('Plans Fire')
    expect(normalizeFolderName('A\\B')).toBe('A B')
    expect(normalizeFolderName('A\u0000B')).toBe('A B')
  })

  it('rejects unsafe folder names', () => {
    expect(validateFolderName('Plans')).toEqual({ ok: true, name: 'Plans' })
    expect(validateFolderName('')).toEqual({ ok: false, error: 'Folder name is required.' })
    expect(validateFolderName(' . ')).toEqual({ ok: false, error: 'Folder name is required.' })
    expect(validateFolderName('..')).toEqual({ ok: false, error: 'Folder name cannot be . or ...' })
    expect(validateFolderName('CON')).toEqual({ ok: false, error: 'Folder name is reserved.' })
  })

  it('builds stable slash-separated paths from parent path and name', () => {
    expect(buildFolderPath(null, 'Plans')).toBe('Plans')
    expect(buildFolderPath('', 'Plans')).toBe('Plans')
    expect(buildFolderPath('Plans', 'Fire Safety')).toBe('Plans/Fire Safety')
    expect(buildFolderPath('/Plans//', 'Fire/Safety')).toBe('Plans/Fire Safety')
  })

  it('normalizes paths and removes traversal segments', () => {
    expect(normalizeFolderPath(' /Plans//Fire Safety/ ')).toBe('Plans/Fire Safety')
    expect(normalizeFolderPath('../Plans/./Fire')).toBe('Plans/Fire')
    expect(normalizeFolderPath('')).toBe('')
  })

  it('returns normalized path segments', () => {
    expect(pathSegments('Plans/Fire Safety/Level 01')).toEqual(['Plans', 'Fire Safety', 'Level 01'])
  })
})
```

- [ ] **Step 2: Run the utility tests and confirm failure**

Run from `frontends/ui`:

```bash
npm run test -- src/lib/projects/folders.spec.ts
```

Expected: FAIL because `src/lib/projects/folders.ts` does not exist.

- [ ] **Step 3: Implement folder utilities**

Create `frontends/ui/src/lib/projects/folders.ts`:

```ts
const RESERVED_FOLDER_NAMES = new Set(['con', 'prn', 'aux', 'nul'])

export interface FolderNameValidationResult {
  ok: boolean
  name?: string
  error?: string
}

export function normalizeFolderName(value: string): string {
  return value
    .replace(/[\\/\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function validateFolderName(value: string): FolderNameValidationResult {
  const name = normalizeFolderName(value)

  if (!name || name === '.') {
    return { ok: false, error: 'Folder name is required.' }
  }

  if (name === '..') {
    return { ok: false, error: 'Folder name cannot be . or ...' }
  }

  if (RESERVED_FOLDER_NAMES.has(name.toLowerCase())) {
    return { ok: false, error: 'Folder name is reserved.' }
  }

  if (name.length > 120) {
    return { ok: false, error: 'Folder name must be 120 characters or fewer.' }
  }

  return { ok: true, name }
}

export function normalizeFolderPath(value: string | null | undefined): string {
  if (!value) return ''

  return value
    .split(/[\\/]+/)
    .map(normalizeFolderName)
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/')
}

export function pathSegments(value: string | null | undefined): string[] {
  const normalized = normalizeFolderPath(value)
  return normalized ? normalized.split('/') : []
}

export function buildFolderPath(parentPath: string | null | undefined, name: string): string {
  const validated = validateFolderName(name)
  if (!validated.ok || !validated.name) {
    throw new Error(validated.error ?? 'Invalid folder name.')
  }

  const normalizedParent = normalizeFolderPath(parentPath)
  return normalizedParent ? `${normalizedParent}/${validated.name}` : validated.name
}
```

- [ ] **Step 4: Run the utility tests and confirm pass**

Run from `frontends/ui`:

```bash
npm run test -- src/lib/projects/folders.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the utilities**

```bash
git add src/lib/projects/folders.ts src/lib/projects/folders.spec.ts
git commit -m "feat(ui): add project folder path utilities"
```

---

## Task 2: Add Normalized Folder Schema

**Files:**
- Create: `frontends/ui/src/lib/db/schema/project-folders.ts`
- Modify: `frontends/ui/src/lib/db/schema/documents.ts`
- Modify: `frontends/ui/src/lib/db/schema/index.ts`
- Create: `frontends/ui/drizzle/0005_project_folders.sql`
- Modify: `frontends/ui/drizzle/meta/_journal.json`

- [ ] **Step 1: Add the Drizzle table and document foreign key**

Create `frontends/ui/src/lib/db/schema/project-folders.ts`:

```ts
// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects'

export const projectFolders = pgTable('project_folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  name: text('name').notNull(),
  path: text('path').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  projectParentIdx: index('project_folders_project_parent_idx').on(table.projectId, table.parentId),
  projectPathIdx: index('project_folders_project_path_idx').on(table.projectId, table.path),
  uniqueProjectParentName: uniqueIndex('project_folders_project_parent_name_idx').on(
    table.projectId,
    table.parentId,
    table.name,
  ),
}))

export type ProjectFolder = typeof projectFolders.$inferSelect
export type NewProjectFolder = typeof projectFolders.$inferInsert
```

Modify `frontends/ui/src/lib/db/schema/documents.ts` to import `projectFolders`, add `folderId`, and add a folder index:

```ts
import { projectFolders } from './project-folders'

// inside documents columns, after projectId
  folderId: uuid('folder_id').references(() => projectFolders.id, { onDelete: 'set null' }),

// inside indexes
  folderIdx: index('documents_folder_idx').on(table.folderId),
```

Modify `frontends/ui/src/lib/db/schema/index.ts`:

```ts
export * from './conversations'
export * from './documents'
export * from './messages'
export * from './project-folders'
export * from './projects'
export * from './user-preferences'
```

- [ ] **Step 2: Add migration SQL**

Create `frontends/ui/drizzle/0005_project_folders.sql`:

```sql
CREATE TABLE "project_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "parent_id" uuid,
  "name" text NOT NULL,
  "path" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_parent_id_project_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."project_folders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "folder_id" uuid;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_project_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."project_folders"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "project_folders_project_parent_idx" ON "project_folders" USING btree ("project_id","parent_id");
--> statement-breakpoint
CREATE INDEX "project_folders_project_path_idx" ON "project_folders" USING btree ("project_id","path");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_folders_project_parent_name_idx" ON "project_folders" USING btree ("project_id","parent_id","name");
--> statement-breakpoint
CREATE INDEX "documents_folder_idx" ON "documents" USING btree ("folder_id");
```

Modify `frontends/ui/drizzle/meta/_journal.json` by appending an entry after `0004_project_profile_context`:

```json
{
  "idx": 5,
  "version": "7",
  "when": 1782850583192,
  "tag": "0005_project_folders",
  "breakpoints": true
}
```

- [ ] **Step 3: Run type check to validate schema references**

Run from `frontends/ui`:

```bash
npm run type-check
```

Expected: PASS or unrelated pre-existing errors only. If Drizzle reports the self-reference is invalid, replace `parentId: uuid('parent_id')` with a non-referenced column in the schema file while keeping the SQL foreign key, then re-run type-check.

- [ ] **Step 4: Commit schema and migration**

```bash
git add src/lib/db/schema/project-folders.ts src/lib/db/schema/documents.ts src/lib/db/schema/index.ts drizzle/0005_project_folders.sql drizzle/meta/_journal.json
git commit -m "feat(ui): add normalized project folder schema"
```

---

## Task 3: Add Folder Service And Routes

**Files:**
- Create: `frontends/ui/src/lib/projects/folder-service.ts`
- Create: `frontends/ui/src/lib/projects/folder-service.spec.ts`
- Create: `frontends/ui/src/app/api/projects/[id]/folders/route.ts`
- Create: `frontends/ui/src/app/api/projects/[id]/folders/route.spec.ts`

- [ ] **Step 1: Write failing service tests for folder creation rules**

Create `frontends/ui/src/lib/projects/folder-service.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createProjectFolder } from './folder-service'

const baseSession = { organizationId: 'org_1', userId: 'user_1' }

describe('createProjectFolder', () => {
  it('creates a root folder with a normalized path', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'folder_1', name: 'Plans', path: 'Plans' }])
    const values = vi.fn(() => ({ returning }))
    const insert = vi.fn(() => ({ values }))
    const db = { insert, select: vi.fn() } as never

    const folder = await createProjectFolder({
      db,
      session: baseSession,
      projectId: 'project_1',
      name: ' Plans ',
      parentId: null,
    })

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org_1',
      projectId: 'project_1',
      parentId: null,
      name: 'Plans',
      path: 'Plans',
      createdBy: 'user_1',
    }))
    expect(folder).toEqual({ id: 'folder_1', name: 'Plans', path: 'Plans' })
  })

  it('rejects invalid names before touching the database', async () => {
    const db = { insert: vi.fn(), select: vi.fn() } as never

    await expect(createProjectFolder({
      db,
      session: baseSession,
      projectId: 'project_1',
      name: '..',
      parentId: null,
    })).rejects.toThrow('Folder name cannot be . or ...')

    expect(db.insert).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run service tests and confirm failure**

Run from `frontends/ui`:

```bash
npm run test -- src/lib/projects/folder-service.spec.ts
```

Expected: FAIL because `folder-service.ts` does not exist.

- [ ] **Step 3: Implement the service**

Create `frontends/ui/src/lib/projects/folder-service.ts`:

```ts
import { and, asc, eq, isNull } from 'drizzle-orm'
import { projectFolders, type ProjectFolder } from '@/lib/db/schema'
import { buildFolderPath, validateFolderName } from './folders'

interface SessionLike {
  organizationId: string
  userId: string
}

interface DbLike {
  select: Function
  insert: Function
}

export interface CreateProjectFolderInput {
  db: DbLike
  session: SessionLike
  projectId: string
  name: string
  parentId?: string | null
}

export interface FolderTreeItem {
  id: string
  parentId: string | null
  name: string
  path: string
  createdAt: Date
  updatedAt: Date
}

export async function listProjectFolders(db: DbLike, organizationId: string, projectId: string): Promise<FolderTreeItem[]> {
  return db
    .select({
      id: projectFolders.id,
      parentId: projectFolders.parentId,
      name: projectFolders.name,
      path: projectFolders.path,
      createdAt: projectFolders.createdAt,
      updatedAt: projectFolders.updatedAt,
    })
    .from(projectFolders)
    .where(and(eq(projectFolders.projectId, projectId), eq(projectFolders.organizationId, organizationId)))
    .orderBy(asc(projectFolders.path))
}

export async function createProjectFolder(input: CreateProjectFolderInput): Promise<ProjectFolder> {
  const validation = validateFolderName(input.name)
  if (!validation.ok || !validation.name) {
    throw new Error(validation.error ?? 'Invalid folder name.')
  }

  let parentPath = ''
  if (input.parentId) {
    const [parent] = await input.db
      .select({ path: projectFolders.path })
      .from(projectFolders)
      .where(and(
        eq(projectFolders.id, input.parentId),
        eq(projectFolders.projectId, input.projectId),
        eq(projectFolders.organizationId, input.session.organizationId),
      ))
      .limit(1)

    if (!parent) {
      throw new Error('Parent folder was not found in this project.')
    }

    parentPath = parent.path
  }

  const path = buildFolderPath(parentPath, validation.name)

  const [folder] = await input.db.insert(projectFolders).values({
    organizationId: input.session.organizationId,
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    name: validation.name,
    path,
    createdBy: input.session.userId,
  }).returning()

  return folder
}
```

- [ ] **Step 4: Run service tests and confirm pass**

Run from `frontends/ui`:

```bash
npm run test -- src/lib/projects/folder-service.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Add API route tests**

Create `frontends/ui/src/app/api/projects/[id]/folders/route.spec.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from './route'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(async () => ({ organizationId: 'org_1', userId: 'user_1' })),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(async () => undefined),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({ mocked: true })),
}))

const listProjectFolders = vi.fn()
const createProjectFolder = vi.fn()

vi.mock('@/lib/projects/folder-service', () => ({
  listProjectFolders: (...args: unknown[]) => listProjectFolders(...args),
  createProjectFolder: (...args: unknown[]) => createProjectFolder(...args),
}))

describe('/api/projects/[id]/folders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns folders for the project', async () => {
    listProjectFolders.mockResolvedValue([{ id: 'folder_1', name: 'Plans', parentId: null, path: 'Plans' }])

    const response = await GET(new Request('http://test.local'), { params: Promise.resolve({ id: 'project_1' }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.folders).toEqual([{ id: 'folder_1', name: 'Plans', parentId: null, path: 'Plans' }])
  })

  it('creates a folder in the project', async () => {
    createProjectFolder.mockResolvedValue({ id: 'folder_1', name: 'Plans', parentId: null, path: 'Plans' })

    const response = await POST(new Request('http://test.local', {
      method: 'POST',
      body: JSON.stringify({ name: 'Plans', parentId: null }),
    }), { params: Promise.resolve({ id: 'project_1' }) })
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.folder).toEqual({ id: 'folder_1', name: 'Plans', parentId: null, path: 'Plans' })
  })
})
```

- [ ] **Step 6: Implement the folders route**

Create `frontends/ui/src/app/api/projects/[id]/folders/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { createProjectFolder, listProjectFolders } from '@/lib/projects/folder-service'

const createFolderSchema = z.object({
  name: z.string(),
  parentId: z.string().uuid().nullable().optional(),
})

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const folders = await listProjectFolders(getDb(), session.organizationId, id)
  return NextResponse.json({ folders })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:edit')

  const body = await request.json().catch(() => null)
  const parsed = createFolderSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Folder name is required.' }, { status: 400 })
  }

  try {
    const folder = await createProjectFolder({
      db: getDb(),
      session,
      projectId: id,
      name: parsed.data.name,
      parentId: parsed.data.parentId ?? null,
    })
    return NextResponse.json({ folder }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create folder.'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
```

- [ ] **Step 7: Run route tests and type check**

Run from `frontends/ui`:

```bash
npm run test -- src/app/api/projects/[id]/folders/route.spec.ts src/lib/projects/folder-service.spec.ts
npm run type-check
```

Expected: PASS.

- [ ] **Step 8: Commit folder service and route**

```bash
git add src/lib/projects/folder-service.ts src/lib/projects/folder-service.spec.ts src/app/api/projects/[id]/folders/route.ts src/app/api/projects/[id]/folders/route.spec.ts
git commit -m "feat(ui): add project folder API"
```

---

## Task 4: Make Uploads Folder-Aware

**Files:**
- Modify: `frontends/ui/src/lib/s3.ts`
- Create: `frontends/ui/src/lib/s3.spec.ts`
- Modify: `frontends/ui/src/app/api/documents/upload/route.ts`
- Modify: `frontends/ui/src/app/api/documents/route.ts`
- Modify: `frontends/ui/src/features/documents/hooks/use-project-documents.ts`
- Modify: `frontends/ui/src/features/documents/hooks/use-file-upload.ts`
- Modify: `frontends/ui/src/features/documents/hooks/use-file-upload.spec.ts`

- [ ] **Step 1: Write failing MinIO key tests**

Create `frontends/ui/src/lib/s3.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildMinioKey } from './s3'

describe('buildMinioKey', () => {
  it('builds the existing root-level key when no folder path is supplied', () => {
    expect(buildMinioKey('org_1', 'project_1', 'doc_1', 'plan.pdf')).toBe(
      'org/org_1/project/project_1/doc/doc_1/plan.pdf',
    )
  })

  it('builds a folder-aware key when folder path is supplied', () => {
    expect(buildMinioKey('org_1', 'project_1', 'doc_1', 'plan.pdf', 'Plans/Fire Safety')).toBe(
      'org/org_1/project/project_1/Plans/Fire Safety/doc_1-plan.pdf',
    )
  })

  it('normalizes unsafe folder path and filename characters', () => {
    expect(buildMinioKey('org_1', 'project_1', 'doc_1', 'evacuation/plan.pdf', '/Plans//Fire/')).toBe(
      'org/org_1/project/project_1/Plans/Fire/doc_1-evacuation plan.pdf',
    )
  })
})
```

- [ ] **Step 2: Implement folder-aware MinIO keys**

Modify `frontends/ui/src/lib/s3.ts`:

```ts
import { S3Client } from '@aws-sdk/client-s3'
import { normalizeFolderName, normalizeFolderPath } from '@/lib/projects/folders'

export const s3Client = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || '',
    secretAccessKey: process.env.MINIO_SECRET_KEY || '',
  },
  forcePathStyle: true,
})

export const bucketName = process.env.MINIO_BUCKET || 'grid-documents'

export function buildMinioKey(
  organizationId: string,
  projectId: string,
  documentId: string,
  filename: string,
  folderPath?: string | null,
): string {
  const safeFilename = normalizeFolderName(filename) || 'file'
  const normalizedFolderPath = normalizeFolderPath(folderPath)

  if (!normalizedFolderPath) {
    return `org/${organizationId}/project/${projectId}/doc/${documentId}/${safeFilename}`
  }

  return `org/${organizationId}/project/${projectId}/${normalizedFolderPath}/${documentId}-${safeFilename}`
}
```

- [ ] **Step 3: Run MinIO key tests**

Run from `frontends/ui`:

```bash
npm run test -- src/lib/s3.spec.ts src/lib/projects/folders.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Update upload route to accept `folderId`**

Modify `frontends/ui/src/app/api/documents/upload/route.ts`:

```ts
// add import
import { projectFolders } from '@/lib/db/schema'

// after reading projectId and file
const folderId = formData.get('folderId') as string | null

// after project lookup
let folderPath: string | null = null
if (folderId) {
  const [folder] = await db
    .select({ id: projectFolders.id, path: projectFolders.path })
    .from(projectFolders)
    .where(and(
      eq(projectFolders.id, folderId),
      eq(projectFolders.projectId, projectId),
      eq(projectFolders.organizationId, session.organizationId),
    ))
    .limit(1)

  if (!folder) {
    return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
  }

  folderPath = folder.path
}

// replace current key call
const minioKey = buildMinioKey(session.organizationId, projectId, documentId, file.name, folderPath)

// add folderId to inserted document values
folderId: folderId || null,
```

- [ ] **Step 5: Update document listing to include folder fields**

Modify `frontends/ui/src/app/api/documents/route.ts`:

```ts
import { projectFolders } from '@/lib/db/schema'

// add to select
folderId: documents.folderId,
folderPath: projectFolders.path,

// add left join before where
.leftJoin(projectFolders, eq(documents.folderId, projectFolders.id))
```

- [ ] **Step 6: Update project upload hooks to pass selected folder**

Modify `frontends/ui/src/features/documents/hooks/use-project-documents.ts`:

```ts
interface UseProjectDocumentsOptions {
  projectId?: string
  folderId?: string | null
  onComplete?: () => void
  onError?: (error: Error) => void
}

const { projectId, folderId, onComplete, onError } = options
const upload = useFileUpload({ collectionName, projectId, folderId, onComplete, onError })
```

Modify `frontends/ui/src/features/documents/hooks/use-file-upload.ts`:

```ts
interface UseFileUploadOptions {
  collectionName?: string
  projectId?: string
  folderId?: string | null
  onComplete?: () => void
  onError?: (error: Error) => void
}

const { collectionName, projectId, folderId, onComplete, onError } = options

// inside project upload formData creation
if (folderId) {
  formData.append('folderId', folderId)
}

// add folderId to the uploadFiles dependency array
```

- [ ] **Step 7: Add hook assertion for folder id**

In `frontends/ui/src/features/documents/hooks/use-file-upload.spec.ts`, add a project-upload test that renders the hook with `projectId: 'project_1'`, `folderId: 'folder_1'`, uploads one file, and asserts the mocked `fetch('/api/documents/upload')` body FormData contains `folderId === 'folder_1'`.

Use this assertion body in the test:

```ts
const request = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/documents/upload')?.[1]
expect(request?.body).toBeInstanceOf(FormData)
expect((request?.body as FormData).get('folderId')).toBe('folder_1')
```

- [ ] **Step 8: Run upload-related checks**

Run from `frontends/ui`:

```bash
npm run test -- src/lib/s3.spec.ts src/features/documents/hooks/use-file-upload.spec.ts
npm run type-check
```

Expected: PASS.

- [ ] **Step 9: Commit folder-aware uploads**

```bash
git add src/lib/s3.ts src/lib/s3.spec.ts src/app/api/documents/upload/route.ts src/app/api/documents/route.ts src/features/documents/hooks/use-project-documents.ts src/features/documents/hooks/use-file-upload.ts src/features/documents/hooks/use-file-upload.spec.ts
git commit -m "feat(ui): upload documents into project folders"
```

---

## Task 5: Add Authorized Preview Route

**Files:**
- Create: `frontends/ui/src/app/api/documents/[id]/preview/route.ts`
- Create: `frontends/ui/src/app/api/documents/[id]/preview/route.spec.ts`

- [ ] **Step 1: Write failing preview route tests**

Create `frontends/ui/src/app/api/documents/[id]/preview/route.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { GET } from './route'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(async () => ({ organizationId: 'org_1', userId: 'user_1' })),
}))

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://minio.local/preview.pdf'),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  GetObjectCommand: vi.fn(function GetObjectCommand(input) { return input }),
}))

const dbRow = vi.fn()
vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({
    select: () => ({ from: () => ({ where: () => ({ limit: dbRow }) }) }),
  })),
}))

vi.mock('@/lib/s3', () => ({ s3Client: {}, bucketName: 'bucket' }))

describe('/api/documents/[id]/preview', () => {
  it('returns inline preview URL for a PDF in the organization', async () => {
    dbRow.mockResolvedValue([{ organizationId: 'org_1', filename: 'plan.pdf', minioKey: 'key', contentType: 'application/pdf', fileSize: 123 }])

    const response = await GET(new Request('http://test.local'), { params: Promise.resolve({ id: 'doc_1' }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.previewUrl).toBe('https://minio.local/preview.pdf')
    expect(body.contentType).toBe('application/pdf')
  })

  it('rejects unsupported file types', async () => {
    dbRow.mockResolvedValue([{ organizationId: 'org_1', filename: 'model.ifc', minioKey: 'key', contentType: 'application/octet-stream', fileSize: 123 }])

    const response = await GET(new Request('http://test.local'), { params: Promise.resolve({ id: 'doc_1' }) })

    expect(response.status).toBe(415)
  })
})
```

- [ ] **Step 2: Implement preview route**

Create `frontends/ui/src/app/api/documents/[id]/preview/route.ts`:

```ts
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getDb } from '@/lib/db'
import { documents } from '@/lib/db/schema'
import { bucketName, s3Client } from '@/lib/s3'

const PREVIEWABLE_TYPES = ['application/pdf']

function canPreview(contentType: string | null): boolean {
  return Boolean(contentType && (PREVIEWABLE_TYPES.includes(contentType) || contentType.startsWith('image/')))
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  const [row] = await getDb().select().from(documents).where(eq(documents.id, id)).limit(1)

  if (!row || row.organizationId !== session.organizationId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (!row.minioKey) {
    return NextResponse.json({ error: 'File not available' }, { status: 404 })
  }

  if (!canPreview(row.contentType)) {
    return NextResponse.json({ error: 'Preview is not available for this file type.' }, { status: 415 })
  }

  const previewUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: row.minioKey,
      ResponseContentDisposition: `inline; filename="${row.filename}"`,
      ResponseContentType: row.contentType ?? undefined,
    }),
    { expiresIn: Number(process.env.MINIO_PRESIGNED_URL_TTL_SECONDS || 600) },
  )

  return NextResponse.json({
    previewUrl,
    filename: row.filename,
    contentType: row.contentType,
    fileSize: row.fileSize,
  })
}
```

- [ ] **Step 3: Run preview route tests**

Run from `frontends/ui`:

```bash
npm run test -- src/app/api/documents/[id]/preview/route.spec.ts
npm run type-check
```

Expected: PASS.

- [ ] **Step 4: Commit preview route**

```bash
git add src/app/api/documents/[id]/preview/route.ts src/app/api/documents/[id]/preview/route.spec.ts
git commit -m "feat(ui): add inline document previews"
```

---

## Task 6: Add Project Overview API And UI

**Files:**
- Create: `frontends/ui/src/features/projects/types.ts`
- Create: `frontends/ui/src/app/api/projects/[id]/overview/route.ts`
- Create: `frontends/ui/src/app/api/projects/[id]/overview/route.spec.ts`
- Create: `frontends/ui/src/features/projects/components/project-overview.tsx`
- Create: `frontends/ui/src/features/projects/components/project-overview.spec.tsx`
- Modify: `frontends/ui/src/app/projects/[id]/page.tsx`

- [ ] **Step 1: Create overview DTO types**

Create `frontends/ui/src/features/projects/types.ts`:

```ts
import type { ProjectProfileDisplay } from '@/lib/project-profile/types'

export interface ProjectOverviewDocument {
  id: string
  filename: string
  fileSize: number | null
  contentType: string | null
  status: string
  createdAt: string
  errorMessage: string | null
}

export interface ProjectOverviewConversation {
  id: string
  title: string | null
  updatedAt: string
}

export interface ProjectOverviewData {
  project: {
    id: string
    name: string
    collectionName: string
    createdAt: string
    profileDisplay: ProjectProfileDisplay | null
    profileHighlights: ProjectProfileDisplay['keyFacts'] | null
    profileUpdatedAt: string | null
  }
  stats: {
    documentCount: number
    ingestedCount: number
    processingCount: number
    failedCount: number
  }
  recentDocuments: ProjectOverviewDocument[]
  recentConversations: ProjectOverviewConversation[]
  setup: {
    hasProfile: boolean
    missingInfoCount: number
  }
}
```

- [ ] **Step 2: Add overview route aggregation**

Create `frontends/ui/src/app/api/projects/[id]/overview/route.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { conversations, documents, projects } from '@/lib/db/schema'
import type { ProjectOverviewData } from '@/features/projects/types'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const db = getDb()
  const [project] = await db.select().from(projects).where(and(
    eq(projects.id, id),
    eq(projects.organizationId, session.organizationId),
  )).limit(1)

  if (!project) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const docRows = await db.select({
    id: documents.id,
    filename: documents.filename,
    fileSize: documents.fileSize,
    contentType: documents.contentType,
    status: documents.status,
    createdAt: documents.createdAt,
    errorMessage: documents.errorMessage,
  }).from(documents).where(and(
    eq(documents.projectId, id),
    eq(documents.organizationId, session.organizationId),
  )).orderBy(desc(documents.createdAt)).limit(8)

  const conversationRows = await db.select({
    id: conversations.id,
    title: conversations.title,
    updatedAt: conversations.updatedAt,
  }).from(conversations).where(and(
    eq(conversations.projectId, id),
    eq(conversations.organizationId, session.organizationId),
  )).orderBy(desc(conversations.updatedAt)).limit(4)

  const allProjectDocs = await db.select({ status: documents.status }).from(documents).where(and(
    eq(documents.projectId, id),
    eq(documents.organizationId, session.organizationId),
  ))

  const data: ProjectOverviewData = {
    project: {
      id: project.id,
      name: project.name,
      collectionName: project.collectionName,
      createdAt: project.createdAt.toISOString(),
      profileDisplay: project.profileDisplay ?? null,
      profileHighlights: project.profileHighlights ?? null,
      profileUpdatedAt: project.profileUpdatedAt?.toISOString() ?? null,
    },
    stats: {
      documentCount: allProjectDocs.length,
      ingestedCount: allProjectDocs.filter((doc) => doc.status === 'ingested' || doc.status === 'success').length,
      processingCount: allProjectDocs.filter((doc) => doc.status === 'pending' || doc.status === 'uploaded').length,
      failedCount: allProjectDocs.filter((doc) => doc.status === 'failed').length,
    },
    recentDocuments: docRows.map((doc) => ({ ...doc, createdAt: doc.createdAt.toISOString() })),
    recentConversations: conversationRows.map((conversation) => ({
      ...conversation,
      updatedAt: conversation.updatedAt.toISOString(),
    })),
    setup: {
      hasProfile: Boolean(project.profileDisplay),
      missingInfoCount: project.profileDisplay?.missingInfo?.length ?? 0,
    },
  }

  return NextResponse.json(data)
}
```

- [ ] **Step 3: Implement overview page component**

Create `frontends/ui/src/features/projects/components/project-overview.tsx`:

```tsx
import Link from 'next/link'
import { Button, Flex, Text } from '@/adapters/ui'
import { Chat, Document, Upload, Users } from '@/adapters/ui/icons'
import type { ProjectOverviewData } from '../types'

interface ProjectOverviewProps {
  overview: ProjectOverviewData
}

export function ProjectOverview({ overview }: ProjectOverviewProps): JSX.Element {
  const { project, stats, recentDocuments, recentConversations, setup } = overview

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 md:px-8">
      <section className="rounded-[2rem] border border-base bg-surface-base p-6 shadow-[0_35px_100px_-75px_rgba(15,23,42,0.8)] md:p-8">
        <Flex align="start" justify="between" gap="6" className="flex-col lg:flex-row">
          <Flex direction="col" gap="3" className="max-w-3xl">
            <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.24em]">Project OS</Text>
            <Text kind="title/xl" className="text-primary tracking-[-0.04em] md:text-5xl md:leading-none">{project.name}</Text>
            <Text kind="body/regular/md" className="max-w-2xl text-subtle">
              {project.profileDisplay?.summary ?? 'Complete project setup and upload files to turn this workspace into the shared source of truth for your OIB work.'}
            </Text>
          </Flex>
          <Flex gap="3" className="w-full flex-col sm:w-auto sm:flex-row">
            <Button as={Link} href={`/projects/${project.id}/chat`} kind="primary"><Chat className="mr-2 h-4 w-4" />Ask Grid</Button>
            <Button as={Link} href={`/projects/${project.id}/files`} kind="secondary"><Upload className="mr-2 h-4 w-4" />Upload Files</Button>
          </Flex>
        </Flex>
      </section>

      {!setup.hasProfile || setup.missingInfoCount > 0 ? (
        <section className="rounded-[1.75rem] border border-brand/30 bg-surface-raised-30 p-5">
          <Text kind="label/bold/md" className="text-primary">Complete project context</Text>
          <Text kind="body/regular/sm" className="mt-2 max-w-2xl text-subtle">
            Add the missing facts once the setup flow is available. Grid will use that durable context in project-scoped conversations without calling AI on this page load.
          </Text>
        </section>
      ) : null}

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        <Metric label="Files" value={stats.documentCount} />
        <Metric label="Ready" value={stats.ingestedCount} />
        <Metric label="Processing" value={stats.processingCount} />
        <Metric label="Needs attention" value={stats.failedCount} />
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.5fr_1fr]">
        <div className="rounded-[1.75rem] border border-base bg-surface-base p-5">
          <Flex align="center" justify="between" gap="3">
            <Text kind="label/bold/lg" className="text-primary">Recent files</Text>
            <Link href={`/projects/${project.id}/files`} className="text-sm font-semibold text-brand">Open files</Link>
          </Flex>
          <div className="mt-4 divide-y divide-base">
            {recentDocuments.length === 0 ? <EmptyLine icon={<Document className="h-4 w-4" />} text="No project files yet." /> : recentDocuments.map((doc) => (
              <Link key={doc.id} href={`/projects/${project.id}/files?documentId=${doc.id}`} className="flex items-center justify-between gap-4 py-3 text-sm hover:text-brand">
                <span className="truncate text-primary">{doc.filename}</span>
                <span className="rounded-full bg-surface-sunken px-2 py-1 text-xs text-subtle">{doc.status}</span>
              </Link>
            ))}
          </div>
        </div>
        <div className="rounded-[1.75rem] border border-base bg-surface-base p-5">
          <Text kind="label/bold/lg" className="text-primary">Assistant activity</Text>
          <div className="mt-4 divide-y divide-base">
            {recentConversations.length === 0 ? <EmptyLine icon={<Chat className="h-4 w-4" />} text="No project conversations yet." /> : recentConversations.map((conversation) => (
              <Link key={conversation.id} href={`/projects/${project.id}/chat?conversationId=${conversation.id}`} className="block py-3 text-sm font-semibold text-primary hover:text-brand">
                {conversation.title ?? 'Untitled conversation'}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-[1.75rem] border border-base bg-surface-base p-5">
        <Flex align="center" gap="3">
          <Users className="h-5 w-5 text-brand" />
          <Text kind="label/bold/md" className="text-primary">Collaboration lives with the project files and context.</Text>
        </Flex>
      </section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-[1.5rem] border border-base bg-surface-base p-5">
      <Text kind="body/bold/2xl" className="text-primary">{value}</Text>
      <Text kind="body/regular/xs" className="mt-1 text-subtle uppercase tracking-[0.18em]">{label}</Text>
    </div>
  )
}

function EmptyLine({ icon, text }: { icon: React.ReactNode; text: string }): JSX.Element {
  return <div className="flex items-center gap-2 py-3 text-sm text-subtle">{icon}{text}</div>
}
```

- [ ] **Step 4: Replace project page with overview data fetch**

Modify `frontends/ui/src/app/projects/[id]/page.tsx` to render the overview directly from server-side queries:

```tsx
// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { and, desc, eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { conversations, documents, projects } from '@/lib/db/schema'
import { ProjectOverview } from '@/features/projects/components/project-overview'
import type { ProjectOverviewData } from '@/features/projects/types'

interface ProjectPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectPage({ params }: ProjectPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const db = getDb()
  const [project] = await db.select().from(projects).where(and(
    eq(projects.id, id),
    eq(projects.organizationId, session.organizationId),
  )).limit(1)

  if (!project) {
    throw new Error('Project not found')
  }

  const docRows = await db.select({
    id: documents.id,
    filename: documents.filename,
    fileSize: documents.fileSize,
    contentType: documents.contentType,
    status: documents.status,
    createdAt: documents.createdAt,
    errorMessage: documents.errorMessage,
  }).from(documents).where(and(
    eq(documents.projectId, id),
    eq(documents.organizationId, session.organizationId),
  )).orderBy(desc(documents.createdAt)).limit(8)

  const conversationRows = await db.select({
    id: conversations.id,
    title: conversations.title,
    updatedAt: conversations.updatedAt,
  }).from(conversations).where(and(
    eq(conversations.projectId, id),
    eq(conversations.organizationId, session.organizationId),
  )).orderBy(desc(conversations.updatedAt)).limit(4)

  const allProjectDocs = await db.select({ status: documents.status }).from(documents).where(and(
    eq(documents.projectId, id),
    eq(documents.organizationId, session.organizationId),
  ))

  const overview: ProjectOverviewData = {
    project: {
      id: project.id,
      name: project.name,
      collectionName: project.collectionName,
      createdAt: project.createdAt.toISOString(),
      profileDisplay: project.profileDisplay ?? null,
      profileHighlights: project.profileHighlights ?? null,
      profileUpdatedAt: project.profileUpdatedAt?.toISOString() ?? null,
    },
    stats: {
      documentCount: allProjectDocs.length,
      ingestedCount: allProjectDocs.filter((doc) => doc.status === 'ingested' || doc.status === 'success').length,
      processingCount: allProjectDocs.filter((doc) => doc.status === 'pending' || doc.status === 'uploaded').length,
      failedCount: allProjectDocs.filter((doc) => doc.status === 'failed').length,
    },
    recentDocuments: docRows.map((doc) => ({ ...doc, createdAt: doc.createdAt.toISOString() })),
    recentConversations: conversationRows.map((conversation) => ({
      ...conversation,
      updatedAt: conversation.updatedAt.toISOString(),
    })),
    setup: {
      hasProfile: Boolean(project.profileDisplay),
      missingInfoCount: project.profileDisplay?.missingInfo?.length ?? 0,
    },
  }

  return <ProjectOverview overview={overview} />
}
```

- [ ] **Step 5: Add overview component tests**

Create `frontends/ui/src/features/projects/components/project-overview.spec.tsx` with Testing Library assertions:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProjectOverview } from './project-overview'

describe('ProjectOverview', () => {
  it('renders primary actions and file stats', () => {
    render(<ProjectOverview overview={{
      project: { id: 'project_1', name: 'Hotel Vienna', collectionName: 'project_1', createdAt: new Date().toISOString(), profileDisplay: null, profileHighlights: null, profileUpdatedAt: null },
      stats: { documentCount: 2, ingestedCount: 1, processingCount: 1, failedCount: 0 },
      recentDocuments: [{ id: 'doc_1', filename: 'fire-plan.pdf', fileSize: 100, contentType: 'application/pdf', status: 'ingested', createdAt: new Date().toISOString(), errorMessage: null }],
      recentConversations: [],
      setup: { hasProfile: false, missingInfoCount: 0 },
    }} />)

    expect(screen.getByText('Hotel Vienna')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Ask Grid/i })).toHaveAttribute('href', '/projects/project_1/chat')
    expect(screen.getByRole('link', { name: /Upload Files/i })).toHaveAttribute('href', '/projects/project_1/files')
    expect(screen.getByText('fire-plan.pdf')).toBeInTheDocument()
    expect(screen.getByText('Complete project context')).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Add overview route tests**

Create `frontends/ui/src/app/api/projects/[id]/overview/route.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { GET } from './route'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(async () => ({ organizationId: 'org_1', userId: 'user_1' })),
}))

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => undefined) }))

const projectRows = [{
  id: 'project_1',
  name: 'Hotel Vienna',
  collectionName: 'collection_1',
  createdAt: new Date('2026-07-02T00:00:00.000Z'),
  profileDisplay: null,
  profileHighlights: null,
  profileUpdatedAt: null,
}]
const docRows = [{ id: 'doc_1', filename: 'plan.pdf', fileSize: 10, contentType: 'application/pdf', status: 'ingested', createdAt: new Date('2026-07-02T00:00:00.000Z'), errorMessage: null }]
const conversationRows = [{ id: 'conversation_1', title: 'Fire safety', updatedAt: new Date('2026-07-02T00:00:00.000Z') }]
const statsRows = [{ status: 'ingested' }, { status: 'failed' }]

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => {
    let call = 0
    return {
      select: () => {
        call += 1
        const rows = call === 1 ? projectRows : call === 2 ? docRows : call === 3 ? conversationRows : statsRows
        return { from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }), limit: async () => rows }) }) }
      },
    }
  }),
}))

describe('/api/projects/[id]/overview', () => {
  it('returns project overview data without AI calls', async () => {
    const response = await GET(new Request('http://test.local'), { params: Promise.resolve({ id: 'project_1' }) })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.project.name).toBe('Hotel Vienna')
    expect(body.stats.documentCount).toBe(2)
    expect(body.stats.ingestedCount).toBe(1)
    expect(body.stats.failedCount).toBe(1)
    expect(body.recentDocuments[0].filename).toBe('plan.pdf')
    expect(body.recentConversations[0].title).toBe('Fire safety')
  })
})
```

- [ ] **Step 7: Run overview checks**

Run from `frontends/ui`:

```bash
npm run test -- src/features/projects/components/project-overview.spec.tsx src/app/api/projects/[id]/overview/route.spec.ts
npm run type-check
```

Expected: PASS.

- [ ] **Step 8: Commit overview work**

```bash
git add src/features/projects/types.ts src/app/api/projects/[id]/overview/route.ts src/app/api/projects/[id]/overview/route.spec.ts src/features/projects/components/project-overview.tsx src/features/projects/components/project-overview.spec.tsx src/app/projects/[id]/page.tsx
git commit -m "feat(ui): add project overview home"
```

---

## Task 7: Install File Workspace Libraries

**Files:**
- Modify: `frontends/ui/package.json`
- Modify: `frontends/ui/package-lock.json`

- [ ] **Step 1: Install the selected libraries**

Run from `frontends/ui`:

```bash
npm install react-complex-tree @uppy/core @uppy/react @uppy/xhr-upload
```

Expected: `package.json` and `package-lock.json` update with the selected dependencies.

- [ ] **Step 2: Run dependency validation checks**

Run from `frontends/ui`:

```bash
npm run type-check
npm run lint
```

Expected: PASS or unrelated pre-existing errors only.

- [ ] **Step 3: Commit dependency changes**

```bash
git add package.json package-lock.json
git commit -m "build(ui): add file workspace libraries"
```

---

## Task 8: Build Project File Workspace UI

**Files:**
- Create: `frontends/ui/src/app/projects/[id]/files/page.tsx`
- Create: `frontends/ui/src/features/documents/components/project-file-workspace.tsx`
- Create: `frontends/ui/src/features/documents/components/folder-tree-pane.tsx`
- Create: `frontends/ui/src/features/documents/components/file-browser-pane.tsx`
- Create: `frontends/ui/src/features/documents/components/file-preview-pane.tsx`
- Create: `frontends/ui/src/features/documents/components/project-uppy-upload.tsx`
- Modify: `frontends/ui/src/features/documents/components/index.ts`
- Add tests beside each new component.

- [ ] **Step 1: Define workspace row types inside `project-file-workspace.tsx`**

Use this shared shape across the workspace components:

```ts
export interface ProjectFileRow {
  id: string
  filename: string
  fileSize: number | null
  contentType: string | null
  status: string
  createdAt: string
  errorMessage: string | null
  folderId: string | null
  folderPath: string | null
}

export interface ProjectFolderRow {
  id: string
  parentId: string | null
  name: string
  path: string
}
```

- [ ] **Step 2: Implement `FolderTreePane`**

Create `frontends/ui/src/features/documents/components/folder-tree-pane.tsx`:

```tsx
'use client'

import { Tree, UncontrolledTreeEnvironment, StaticTreeDataProvider } from 'react-complex-tree'
import 'react-complex-tree/lib/style-modern.css'
import type { ProjectFolderRow } from './project-file-workspace'

interface FolderTreePaneProps {
  folders: ProjectFolderRow[]
  selectedFolderId: string | null
  onSelectFolder: (folderId: string | null) => void
}

export function FolderTreePane({ folders, selectedFolderId, onSelectFolder }: FolderTreePaneProps): JSX.Element {
  const items = buildTreeItems(folders)
  const provider = new StaticTreeDataProvider(items, (item, data) => ({ ...item, data }))

  return (
    <aside className="rounded-[1.5rem] border border-base bg-surface-base p-3">
      <button className={`mb-2 w-full rounded-xl px-3 py-2 text-left text-sm font-semibold ${selectedFolderId === null ? 'bg-surface-sunken text-primary' : 'text-subtle'}`} onClick={() => onSelectFolder(null)}>
        All files
      </button>
      <UncontrolledTreeEnvironment dataProvider={provider} getItemTitle={(item) => String(item.data)} viewState={{}}>
        <Tree treeId="project-folders" rootItem="root" treeLabel="Project folders" onSelectItems={(items) => onSelectFolder(items[0] === 'root' ? null : String(items[0]))} />
      </UncontrolledTreeEnvironment>
    </aside>
  )
}

function buildTreeItems(folders: ProjectFolderRow[]) {
  const childrenByParent = new Map<string | null, string[]>()
  for (const folder of folders) {
    const children = childrenByParent.get(folder.parentId) ?? []
    children.push(folder.id)
    childrenByParent.set(folder.parentId, children)
  }

  const items: Record<string, { index: string; data: string; isFolder: boolean; children: string[] }> = {
    root: { index: 'root', data: 'Folders', isFolder: true, children: childrenByParent.get(null) ?? [] },
  }

  for (const folder of folders) {
    items[folder.id] = { index: folder.id, data: folder.name, isFolder: true, children: childrenByParent.get(folder.id) ?? [] }
  }

  return items
}
```

- [ ] **Step 3: Implement `FileBrowserPane`**

Create `frontends/ui/src/features/documents/components/file-browser-pane.tsx`:

```tsx
'use client'

import { useMemo, useState } from 'react'
import { Button, Flex, Text } from '@/adapters/ui'
import { Document } from '@/adapters/ui/icons'
import type { ProjectFileRow } from './project-file-workspace'

interface FileBrowserPaneProps {
  files: ProjectFileRow[]
  selectedFileId: string | null
  onSelectFile: (fileId: string) => void
}

export function FileBrowserPane({ files, selectedFileId, onSelectFile }: FileBrowserPaneProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('list')
  const filteredFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return files
    return files.filter((file) => file.filename.toLowerCase().includes(normalized))
  }, [files, query])

  return (
    <section className="rounded-[1.5rem] border border-base bg-surface-base p-4">
      <Flex align="center" justify="between" gap="3" className="flex-col md:flex-row">
        <Text kind="label/bold/lg" className="text-primary">Files</Text>
        <Flex gap="2">
          <Button kind={view === 'list' ? 'primary' : 'secondary'} size="small" onClick={() => setView('list')}>List</Button>
          <Button kind={view === 'grid' ? 'primary' : 'secondary'} size="small" onClick={() => setView('grid')}>Grid</Button>
        </Flex>
      </Flex>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" className="mt-4 w-full rounded-2xl border border-base bg-surface-sunken px-4 py-3 text-sm text-primary outline-none focus:border-brand" />
      <div className={view === 'grid' ? 'mt-4 grid grid-cols-1 gap-3 md:grid-cols-2' : 'mt-4 divide-y divide-base'}>
        {filteredFiles.length === 0 ? (
          <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 text-center text-subtle">
            <Document className="h-8 w-8" />
            <Text kind="label/bold/md" className="text-primary">No files in this view</Text>
          </div>
        ) : filteredFiles.map((file) => (
          <button key={file.id} type="button" onClick={() => onSelectFile(file.id)} className={`flex w-full items-center justify-between gap-4 rounded-2xl px-3 py-3 text-left transition hover:bg-surface-sunken ${selectedFileId === file.id ? 'bg-surface-sunken ring-1 ring-brand' : ''}`}>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-primary">{file.filename}</span>
              <span className="mt-1 block truncate text-xs text-subtle">{file.folderPath || 'Project root'} · {file.contentType || 'Unknown type'}</span>
            </span>
            <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${statusClassName(file.status)}`}>{file.status}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function statusClassName(status: string): string {
  if (status === 'uploaded' || status === 'pending') return 'bg-yellow-100 text-yellow-800'
  if (status === 'ingested' || status === 'success') return 'bg-green-100 text-green-800'
  if (status === 'failed') return 'bg-red-100 text-red-800'
  return 'bg-gray-100 text-gray-800'
}
```

- [ ] **Step 4: Implement `FilePreviewPane`**

Create `frontends/ui/src/features/documents/components/file-preview-pane.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { Button, Text } from '@/adapters/ui'
import type { ProjectFileRow } from './project-file-workspace'

interface FilePreviewPaneProps {
  file: ProjectFileRow | null
}

export function FilePreviewPane({ file }: FilePreviewPaneProps): JSX.Element {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)

  const isPreviewable = Boolean(file?.contentType && (file.contentType === 'application/pdf' || file.contentType.startsWith('image/')))

  useEffect(() => {
    if (!file || !isPreviewable) {
      setPreviewUrl(null)
      setPreviewError(null)
      return
    }

    let cancelled = false
    setIsLoadingPreview(true)
    setPreviewError(null)
    fetch(`/api/documents/${file.id}/preview`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Preview failed')))
      .then((body: { previewUrl: string }) => {
        if (!cancelled) setPreviewUrl(body.previewUrl)
      })
      .catch((error: Error) => {
        if (!cancelled) setPreviewError(error.message)
      })
      .finally(() => {
        if (!cancelled) setIsLoadingPreview(false)
      })

    return () => { cancelled = true }
  }, [file, isPreviewable])

  if (!file) {
    return <aside className="rounded-[1.5rem] border border-base bg-surface-base p-5 text-subtle">Select a file to preview it.</aside>
  }

  return (
    <aside className="rounded-[1.5rem] border border-base bg-surface-base p-5">
      <Text kind="label/bold/lg" className="text-primary">{file.filename}</Text>
      <Text kind="body/regular/xs" className="mt-1 text-subtle">{file.folderPath || 'Project root'} · {file.contentType || 'Unknown type'}</Text>
      <div className="mt-4 overflow-hidden rounded-2xl border border-base bg-surface-sunken">
        {isLoadingPreview ? <div className="p-8 text-sm text-subtle">Loading preview...</div> : null}
        {previewError ? <div className="p-8 text-sm text-error">{previewError}</div> : null}
        {previewUrl && file.contentType === 'application/pdf' ? <iframe title={file.filename} src={previewUrl} className="h-[520px] w-full" /> : null}
        {previewUrl && file.contentType?.startsWith('image/') ? <img src={previewUrl} alt={file.filename} className="max-h-[520px] w-full object-contain" /> : null}
        {!isPreviewable ? <div className="p-8 text-sm text-subtle">Preview is not available for this file type yet.</div> : null}
      </div>
      <Button kind="secondary" size="small" className="mt-4" onClick={() => window.open(`/api/documents/${file.id}/download`, '_blank')}>Download</Button>
    </aside>
  )
}
```

- [ ] **Step 5: Implement `ProjectUppyUpload`**

Create `frontends/ui/src/features/documents/components/project-uppy-upload.tsx`:

```tsx
'use client'

import Uppy from '@uppy/core'
import { useEffect, useMemo, useState } from 'react'
import { Button, Text } from '@/adapters/ui'
import { Upload } from '@/adapters/ui/icons'
import { useProjectDocuments } from '@/features/documents/hooks/use-project-documents'

interface ProjectUppyUploadProps {
  projectId: string
  folderId: string | null
  onUploaded?: () => void
}

export function ProjectUppyUpload({ projectId, folderId, onUploaded }: ProjectUppyUploadProps): JSX.Element {
  const [selectedCount, setSelectedCount] = useState(0)
  const uppy = useMemo(() => new Uppy({ restrictions: { maxNumberOfFiles: 100 } }), [])
  const { uploadFiles, isUploading, error } = useProjectDocuments({ projectId, folderId, onComplete: onUploaded })

  useEffect(() => () => { uppy.close() }, [uppy])

  async function handleFiles(files: FileList | null): Promise<void> {
    const selected = Array.from(files ?? [])
    setSelectedCount(selected.length)
    if (selected.length === 0) return
    for (const file of selected) {
      uppy.addFile({ name: file.name, type: file.type, data: file })
    }
    await uploadFiles(selected)
    onUploaded?.()
  }

  return (
    <section className="rounded-[1.5rem] border border-base bg-surface-base p-4">
      <Text kind="label/bold/md" className="text-primary">Upload to {folderId ? 'selected folder' : 'project root'}</Text>
      <Text kind="body/regular/sm" className="mt-1 text-subtle">Select files and Grid will preserve the current project folder context.</Text>
      <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-brand px-4 py-3 text-sm font-semibold text-white">
        <Upload className="h-4 w-4" />
        {isUploading ? 'Uploading...' : 'Choose files'}
        <input type="file" multiple className="sr-only" onChange={(event) => void handleFiles(event.currentTarget.files)} />
      </label>
      {selectedCount > 0 ? <Text kind="body/regular/xs" className="mt-3 text-subtle">{selectedCount} file(s) selected</Text> : null}
      {error ? <Text kind="body/regular/xs" className="mt-3 text-error">{error}</Text> : null}
    </section>
  )
}
```

- [ ] **Step 6: Implement `ProjectFileWorkspace`**

Create `frontends/ui/src/features/documents/components/project-file-workspace.tsx`:

```tsx
'use client'

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { FileBrowserPane } from './file-browser-pane'
import { FilePreviewPane } from './file-preview-pane'
import { FolderTreePane } from './folder-tree-pane'
import { ProjectUppyUpload } from './project-uppy-upload'

export interface ProjectFileRow {
  id: string
  filename: string
  fileSize: number | null
  contentType: string | null
  status: string
  createdAt: string
  errorMessage: string | null
  folderId: string | null
  folderPath: string | null
}

export interface ProjectFolderRow {
  id: string
  parentId: string | null
  name: string
  path: string
}

interface ProjectFileWorkspaceProps {
  projectId: string
  folders: ProjectFolderRow[]
  files: ProjectFileRow[]
}

export function ProjectFileWorkspace({ projectId, folders, files }: ProjectFileWorkspaceProps): JSX.Element {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialFileId = searchParams.get('documentId')
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(initialFileId)
  const visibleFiles = useMemo(() => selectedFolderId ? files.filter((file) => file.folderId === selectedFolderId) : files, [files, selectedFolderId])
  const selectedFile = files.find((file) => file.id === selectedFileId) ?? visibleFiles[0] ?? null

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-6 md:px-8">
      <ProjectUppyUpload projectId={projectId} folderId={selectedFolderId} onUploaded={() => router.refresh()} />
      <div className="grid min-h-[720px] grid-cols-1 gap-4 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
        <FolderTreePane folders={folders} selectedFolderId={selectedFolderId} onSelectFolder={setSelectedFolderId} />
        <FileBrowserPane files={visibleFiles} selectedFileId={selectedFile?.id ?? null} onSelectFile={setSelectedFileId} />
        <FilePreviewPane file={selectedFile} />
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Implement files page route**

Create `frontends/ui/src/app/projects/[id]/files/page.tsx`:

```tsx
import { and, desc, eq } from 'drizzle-orm'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { documents, projectFolders } from '@/lib/db/schema'
import { listProjectFolders } from '@/lib/projects/folder-service'
import { ProjectFileWorkspace } from '@/features/documents/components/project-file-workspace'

interface ProjectFilesPageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectFilesPage({ params }: ProjectFilesPageProps): Promise<JSX.Element> {
  const session = await requireAuthorizedSession()
  const { id } = await params

  await requireProjectAccess(session, id, 'project:view')

  const db = getDb()
  const folders = await listProjectFolders(db, session.organizationId, id)
  const files = await db.select({
    id: documents.id,
    filename: documents.filename,
    fileSize: documents.fileSize,
    contentType: documents.contentType,
    status: documents.status,
    createdAt: documents.createdAt,
    errorMessage: documents.errorMessage,
    folderId: documents.folderId,
    folderPath: projectFolders.path,
  }).from(documents).leftJoin(projectFolders, eq(documents.folderId, projectFolders.id)).where(and(
    eq(documents.projectId, id),
    eq(documents.organizationId, session.organizationId),
  )).orderBy(desc(documents.createdAt))

  return <ProjectFileWorkspace projectId={id} folders={folders} files={files.map((file) => ({ ...file, createdAt: file.createdAt.toISOString() }))} />
}
```

- [ ] **Step 8: Add workspace component tests**

Create `frontends/ui/src/features/documents/components/project-file-workspace.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProjectFileWorkspace } from './project-file-workspace'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const files = [
  { id: 'doc_1', filename: 'root.pdf', fileSize: 1, contentType: 'application/pdf', status: 'ingested', createdAt: new Date().toISOString(), errorMessage: null, folderId: null, folderPath: null },
  { id: 'doc_2', filename: 'fire.png', fileSize: 1, contentType: 'image/png', status: 'uploaded', createdAt: new Date().toISOString(), errorMessage: null, folderId: 'folder_1', folderPath: 'Plans' },
]

describe('ProjectFileWorkspace', () => {
  it('renders upload, folder tree, file browser, and preview panes', () => {
    render(<ProjectFileWorkspace projectId="project_1" folders={[{ id: 'folder_1', parentId: null, name: 'Plans', path: 'Plans' }]} files={files} />)

    expect(screen.getByText('Upload to project root')).toBeInTheDocument()
    expect(screen.getByText('Files')).toBeInTheDocument()
    expect(screen.getByText('root.pdf')).toBeInTheDocument()
    expect(screen.getByText('Select a file to preview it')).toBeInTheDocument()
  })

  it('filters files by search text', async () => {
    const user = userEvent.setup()
    render(<ProjectFileWorkspace projectId="project_1" folders={[]} files={files} />)

    await user.type(screen.getByPlaceholderText('Search files'), 'fire')

    expect(screen.queryByText('root.pdf')).not.toBeInTheDocument()
    expect(screen.getByText('fire.png')).toBeInTheDocument()
  })
})
```

Create `frontends/ui/src/features/documents/components/file-preview-pane.spec.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePreviewPane } from './file-preview-pane'

describe('FilePreviewPane', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ previewUrl: 'https://minio.local/plan.pdf' }), { status: 200 })))
  })

  it('loads a PDF preview URL', async () => {
    render(<FilePreviewPane file={{ id: 'doc_1', filename: 'plan.pdf', fileSize: 1, contentType: 'application/pdf', status: 'ingested', createdAt: new Date().toISOString(), errorMessage: null, folderId: null, folderPath: null }} />)

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/documents/doc_1/preview'))
    expect(await screen.findByTitle('plan.pdf')).toHaveAttribute('src', 'https://minio.local/plan.pdf')
  })

  it('renders unsupported file metadata', () => {
    render(<FilePreviewPane file={{ id: 'doc_2', filename: 'model.ifc', fileSize: 1, contentType: 'application/octet-stream', status: 'uploaded', createdAt: new Date().toISOString(), errorMessage: null, folderId: null, folderPath: null }} />)

    expect(screen.getByText('Preview is not available for this file type yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download/i })).toBeInTheDocument()
  })
})
```

Create `frontends/ui/src/features/documents/components/project-uppy-upload.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProjectUppyUpload } from './project-uppy-upload'

const uploadFiles = vi.fn(async () => undefined)
vi.mock('@/features/documents/hooks/use-project-documents', () => ({
  useProjectDocuments: (options: { folderId: string | null }) => {
    ;(globalThis as unknown as { lastFolderId: string | null }).lastFolderId = options.folderId
    return { uploadFiles, isUploading: false, error: null }
  },
}))

describe('ProjectUppyUpload', () => {
  it('passes selected folder id into the project upload hook', async () => {
    const user = userEvent.setup()
    render(<ProjectUppyUpload projectId="project_1" folderId="folder_1" />)

    await user.upload(screen.getByLabelText(/Choose files/i), new File(['x'], 'plan.pdf', { type: 'application/pdf' }))

    expect((globalThis as unknown as { lastFolderId: string | null }).lastFolderId).toBe('folder_1')
    expect(uploadFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'plan.pdf' })])
  })
})
```

- [ ] **Step 9: Run file workspace checks**

Run from `frontends/ui`:

```bash
npm run test -- src/features/documents/components
npm run type-check
npm run lint
```

Expected: PASS.

- [ ] **Step 10: Commit file workspace**

```bash
git add src/app/projects/[id]/files/page.tsx src/features/documents/components/project-file-workspace.tsx src/features/documents/components/folder-tree-pane.tsx src/features/documents/components/file-browser-pane.tsx src/features/documents/components/file-preview-pane.tsx src/features/documents/components/project-uppy-upload.tsx src/features/documents/components/index.ts src/features/documents/components/*.spec.tsx
git commit -m "feat(ui): add project file workspace"
```

---

## Task 9: Unify Project Shell And Chat Hierarchy

**Files:**
- Modify: `frontends/ui/src/components/projects/project-shell.tsx`
- Create: `frontends/ui/src/components/projects/project-shell.spec.tsx`
- Modify: `frontends/ui/src/app/projects/[id]/chat/page.tsx`
- Modify: `frontends/ui/src/app/projects/[id]/chat/layout.tsx`
- Modify: `frontends/ui/src/features/layout/components/MainLayout.tsx`
- Modify: `frontends/ui/src/features/layout/components/MainLayout.spec.tsx`

- [ ] **Step 1: Add shell nav test**

Create `frontends/ui/src/components/projects/project-shell.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProjectShell } from './project-shell'

describe('ProjectShell', () => {
  it('renders project OS navigation', () => {
    render(<ProjectShell projectId="project_1" projectName="Hotel Vienna"><div>Content</div></ProjectShell>)

    expect(screen.getByRole('link', { name: /Overview/i })).toHaveAttribute('href', '/projects/project_1')
    expect(screen.getByRole('link', { name: /Files/i })).toHaveAttribute('href', '/projects/project_1/files')
    expect(screen.getByRole('link', { name: /Ask Grid/i })).toHaveAttribute('href', '/projects/project_1/chat')
    expect(screen.getByRole('link', { name: /Members/i })).toHaveAttribute('href', '/projects/project_1/members')
  })
})
```

- [ ] **Step 2: Update project shell nav and visual hierarchy**

Modify `frontends/ui/src/components/projects/project-shell.tsx` nav items:

```ts
const projectNavItems = [
  { label: 'Overview', href: '', icon: SelectEllipse },
  { label: 'Files', href: '/files', icon: Document },
  { label: 'Ask Grid', href: '/chat', icon: Chat },
  { label: 'Members', href: '/members', icon: Users },
]
```

Keep `AppShell` but reduce duplicate top-level messaging inside project pages. Add a mobile top nav row with the same links if absent.

- [ ] **Step 3: Ensure chat uses project layout only once**

Inspect `frontends/ui/src/app/projects/[id]/chat/layout.tsx`. If it wraps another shell, replace it with:

```tsx
export default function ProjectChatLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return <>{children}</>
}
```

Modify `frontends/ui/src/app/projects/[id]/chat/page.tsx` so it keeps `MainLayout withShell={false}` because `src/app/projects/[id]/layout.tsx` already supplies `ProjectShell`.

- [ ] **Step 4: Tune `MainLayout` for embedded project chat**

In `frontends/ui/src/features/layout/components/MainLayout.tsx`, ensure `withShell={false}` does not render global top bars or fixed full-viewport assumptions that fight `ProjectShell`. Keep WebSocket/store behavior unchanged.

- [ ] **Step 5: Run shell and chat tests**

Run from `frontends/ui`:

```bash
npm run test -- src/components/projects/project-shell.spec.tsx src/features/layout/components/MainLayout.spec.tsx
npm run type-check
```

Expected: PASS.

- [ ] **Step 6: Commit shell/chat hierarchy**

```bash
git add src/components/projects/project-shell.tsx src/components/projects/project-shell.spec.tsx src/app/projects/[id]/chat/page.tsx src/app/projects/[id]/chat/layout.tsx src/features/layout/components/MainLayout.tsx src/features/layout/components/MainLayout.spec.tsx
git commit -m "feat(ui): unify project shell navigation"
```

---

## Task 10: Reposition Projects Home, Cards, Root Route, And README

**Files:**
- Modify: `frontends/ui/src/app/page.tsx`
- Modify: `frontends/ui/src/app/projects/page.tsx`
- Modify: `frontends/ui/src/components/projects/project-card.tsx`
- Modify: `frontends/ui/src/components/projects/project-card.spec.tsx`
- Modify: `frontends/ui/README.md`

- [ ] **Step 1: Update project card tests**

In `frontends/ui/src/components/projects/project-card.spec.tsx`, assert that the primary project link opens `/projects/{id}`, and that secondary actions include `/files` and `/chat`.

Required assertions:

```tsx
expect(screen.getByRole('link', { name: /Open overview/i })).toHaveAttribute('href', '/projects/project_1')
expect(screen.getByRole('link', { name: /Files/i })).toHaveAttribute('href', '/projects/project_1/files')
expect(screen.getByRole('link', { name: /Ask Grid/i })).toHaveAttribute('href', '/projects/project_1/chat')
```

- [ ] **Step 2: Update project card component**

Modify `frontends/ui/src/components/projects/project-card.tsx` so the card language says "Project overview", the primary CTA is "Open overview", and Files/Ask Grid/Members are secondary actions.

- [ ] **Step 3: Update projects landing copy**

Modify `frontends/ui/src/app/projects/page.tsx` copy:

- Replace "Project command" with "Architecture project OS".
- Replace "Put every OIB investigation into a controlled workspace." with "Run every building project from one calm workspace."
- Replace "Projects isolate documents, project roles, and chat context so the agent stops mixing workstreams." with "Grid keeps files, context, colleagues, OIB research, and project conversations together so the assistant is only one part of the workspace."

- [ ] **Step 4: Route authenticated root to projects**

Modify `frontends/ui/src/app/page.tsx` so authenticated users land on `/projects`. If the file is a server component, use `redirect('/projects')` after auth; if it must preserve public unauthenticated behavior, keep that behavior and only redirect authenticated sessions.

- [ ] **Step 5: Rewrite README positioning**

Modify `frontends/ui/README.md` opening section to state:

```md
# Grid UI

Grid is a project-centered operating system for architects working with OIB building regulations. The UI is organized around projects: each project owns its files, folders, context, collaborators, and Grid assistant conversations.

Chat is an important project feature, but it is not the product frame. The primary workspace is the project overview and file library, with the assistant available wherever project context and documents need to be interpreted.
```

Keep the existing command and folder-reference sections if still accurate.

- [ ] **Step 6: Run final UI checks**

Run from `frontends/ui`:

```bash
npm run test -- src/components/projects/project-card.spec.tsx
npm run type-check
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit positioning changes**

```bash
git add src/app/page.tsx src/app/projects/page.tsx src/components/projects/project-card.tsx src/components/projects/project-card.spec.tsx README.md
git commit -m "feat(ui): position Grid around project workspaces"
```

---

## Task 11: End-To-End Verification And Polish Pass

**Files:**
- Modify only files touched in prior tasks if verification exposes defects.

- [ ] **Step 1: Run targeted test suites**

Run from `frontends/ui`:

```bash
npm run test -- src/lib/projects src/lib/s3.spec.ts src/app/api/projects/[id]/folders/route.spec.ts src/app/api/documents/[id]/preview/route.spec.ts src/features/projects/components/project-overview.spec.tsx src/features/documents/components src/components/projects
```

Expected: PASS.

- [ ] **Step 2: Run full frontend quality gates**

Run from `frontends/ui`:

```bash
npm run lint
npm run type-check
npm run test:ci
```

Expected: PASS. If existing unrelated failures appear, capture exact failing files/tests and do not claim the whole suite passed.

- [ ] **Step 3: Build the Next.js app**

Run from `frontends/ui`:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual browser verification**

Run the stack using the repo’s Docker-first path or local UI if the backend dependencies are available:

```bash
npm run dev
```

Verify these screens manually:

- `/projects` shows project OS positioning.
- `/projects/{id}` shows overview with Ask Grid and Upload Files actions.
- `/projects/{id}/files` shows folder tree, file browser, preview pane, upload entry, empty states.
- Creating a folder sends `POST /api/projects/{id}/folders`.
- Uploading into a selected folder sends `folderId` and creates a folder-aware MinIO key.
- Selecting a PDF/image loads `/api/documents/{id}/preview`.
- `/projects/{id}/chat` remains project-scoped and does not show duplicate app chrome.

- [ ] **Step 5: Inspect final diff and commit polish fixes**

```bash
git status --short
git diff --stat
git diff
```

If verification fixes were needed:

```bash
git add <only-files-fixed-in-this-step>
git commit -m "fix(ui): polish project OS workspace"
```

---

## Self-Review Notes

- Spec coverage: application structure is handled in Tasks 6, 9, and 10; overview in Task 6; folders in Tasks 1-3; upload and MinIO paths in Task 4; preview in Task 5; file workspace in Tasks 7-8; chat shell in Task 9; README positioning in Task 10; verification in Task 11.
- Placeholder scan: the plan does not leave unresolved placeholder markers. Follow-up features from the spec, such as rename/move and per-folder permissions, remain outside v1 and are not represented as implementation steps.
- Type consistency: folder identifiers use `folderId`; folder rows use `ProjectFolderRow`; document rows use `ProjectFileRow`; overview API and component share `ProjectOverviewData`.
