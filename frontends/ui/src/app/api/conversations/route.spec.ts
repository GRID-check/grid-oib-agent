/**
 * @vitest-environment node
 */
/**
 * The conversation list is where the accidental org-wide readability of chats was
 * visible from the outside: it used to return EVERY conversation in the
 * organization (spec §3 fact 1, ADR-0032). It now returns what the caller may
 * actually see, filtered in SQL.
 *
 * The DB is a drizzle `pg-proxy` instance — a real query builder over a callback
 * "driver" that records the statement instead of connecting anywhere — because the
 * assertion that matters is which rows Postgres will hand back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'
import { NotFoundError } from '@/lib/api/errors'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    // A Member with no explicit claims: `org:chat` reaches this session through
    // the bounded catalog implication in `hasPermission`, which is what a
    // tenant whose WorkOS provisioning has not been replayed actually looks
    // like. If the implication broke, the Büro would 403 here.
    role: 'member',
    permissions: [],
  }),
  authzErrorResponse: () => null,
}))

const requireProjectAccessMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: requireProjectAccessMock,
}))

const captured = vi.hoisted(() => [] as Array<{ sql: string; params: unknown[] }>)
/**
 * What the fake driver answers an INSERT ... RETURNING with: one row of column
 * values in `conversations` declaration order, exactly as postgres hands them
 * over. Reads keep answering with nothing, which is all the list tests need.
 *
 * It has to be a real row rather than `[]`: `createConversation` treats an
 * empty `returning()` as an id conflict and goes off to resolve the existing
 * thread, so a create test would end up asserting the CONFLICT path.
 */
const insertedRow = vi.hoisted(() => ({ current: [] as unknown[] }))
vi.mock('@/lib/db', () => {
  const db = drizzle(async (sql, params) => {
    captured.push({ sql, params })
    return { rows: sql.startsWith('insert into "conversations"') ? [insertedRow.current] : [] }
  })
  return { getDb: () => db }
})

import { GET, POST } from './route'

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

/** The one statement the request produced. */
function onlyQuery(): { sql: string; params: unknown[] } {
  expect(captured).toHaveLength(1)
  return captured[0]
}

describe('GET /api/conversations', () => {
  beforeEach(() => {
    captured.length = 0
    requireProjectAccessMock.mockReset()
    requireProjectAccessMock.mockResolvedValue({ role: 'project-editor' })
  })

  it('narrows an unscoped list to the caller — own, granted, or org-visible', async () => {
    const res = await GET(new Request('https://grid.example/api/conversations'))

    expect(res.status).toBe(200)
    expect(requireProjectAccessMock).not.toHaveBeenCalled()

    const { sql, params } = onlyQuery()
    // Tenancy lives in SQL, as before.
    expect(sql).toContain('"conversations"."organization_id" = $1')
    // ...but org membership alone is no longer enough to see a row. Deliberate
    // tightening (spec MG-1): this list used to return the whole organization.
    expect(sql).toContain('"conversations"."created_by" = $2')
    expect(sql).toContain('exists (select 1 from "resource_shares"')
    expect(params).toContain('organization')
    expect(params).toContain('user_1')
  })

  it('scopes by projectId, keeping tenancy, unstamped rows, and privacy', async () => {
    const res = await GET(
      new Request(`https://grid.example/api/conversations?projectId=${PROJECT_ID}`)
    )

    expect(res.status).toBe(200)
    const { sql, params } = onlyQuery()
    // Rows stamped with the project, or unstamped legacy rows — never rows from
    // another project, always inside the org. The two are separate disjuncts with
    // separate visibility rules: an unstamped row is judged on creator/grant/org
    // visibility, because the caller's proof about THIS project says nothing about
    // a row that is not in it (see `conversations/repository.spec.ts`).
    expect(sql).toContain('"conversations"."organization_id" = $1')
    expect(sql).toContain('("conversations"."project_id" = $2 and (')
    expect(sql).toContain('or ("conversations"."project_id" is null and (')
    // Project access is proven, so only `private` rows inside it need narrowing.
    expect(sql).toContain('"conversations"."visibility" <> $3')
    expect(sql).toContain('exists (select 1 from "resource_shares"')
    expect(params).toContain('private')
  })

  it('requires project access for a projectId filter (cross-org probing -> 404)', async () => {
    requireProjectAccessMock.mockRejectedValue(new NotFoundError())

    const res = await GET(
      new Request(`https://grid.example/api/conversations?projectId=${PROJECT_ID}`)
    )

    expect(requireProjectAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1', userId: 'user_1' }),
      PROJECT_ID,
      'project:view'
    )
    expect(res.status).toBe(404)
    // The repository must never be reached for a project the caller can't see.
    expect(captured).toHaveLength(0)
  })

  it('rejects a malformed projectId with 400', async () => {
    const res = await GET(
      new Request('https://grid.example/api/conversations?projectId=not-a-uuid')
    )

    expect(res.status).toBe(400)
    expect(requireProjectAccessMock).not.toHaveBeenCalled()
    expect(captured).toHaveLength(0)
  })

  it('narrows to the Büro when asked, in SQL, without touching a project', async () => {
    const res = await GET(new Request('https://grid.example/api/conversations?scope=workspace'))

    expect(res.status).toBe(200)
    expect(requireProjectAccessMock).not.toHaveBeenCalled()

    const { sql, params } = onlyQuery()
    expect(sql).toContain('"conversations"."organization_id" = $1')
    expect(sql).toContain('"conversations"."scope" = ')
    expect(params).toContain('workspace')
  })

  it('rejects a level nobody can render with 400', async () => {
    const res = await GET(new Request('https://grid.example/api/conversations?scope=buero'))

    expect(res.status).toBe(400)
    expect(captured).toHaveLength(0)
  })
})

/**
 * The create half. `scope='workspace'` with a `projectId` is the request the
 * database would refuse with migration 0081's CHECK — a 500 the caller could do
 * nothing with. The `superRefine` turns it into a 400 that says what is wrong,
 * which is the whole reason for stating an invariant twice.
 */
describe('POST /api/conversations', () => {
  beforeEach(() => {
    captured.length = 0
    insertedRow.current = []
    requireProjectAccessMock.mockReset()
    requireProjectAccessMock.mockResolvedValue({ role: 'project-editor' })
  })

  /** One `conversations` row, column values in declaration order. */
  function row(overrides: { projectId?: string | null; scope?: string } = {}): unknown[] {
    return [
      's_1',
      'org_1',
      'user_1',
      null,
      'private',
      null,
      '{}',
      overrides.projectId ?? null,
      overrides.scope ?? 'workspace',
      null,
      null,
      null,
      null,
      '2026-09-08T10:00:00.000Z',
      '2026-09-08T10:00:00.000Z',
    ]
  }

  function post(body: unknown): Promise<Response> {
    return POST(
      new Request('https://grid.example/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  }

  it('400s a workspace conversation that also names a project', async () => {
    const res = await post({ id: 's_1', scope: 'workspace', projectId: PROJECT_ID })

    expect(res.status).toBe(400)
    // Refused at the edge: nothing reached the database to be refused there.
    expect(captured).toHaveLength(0)
  })

  it('400s an unknown level rather than storing it', async () => {
    const res = await post({ id: 's_1', scope: 'buero' })

    expect(res.status).toBe(400)
    expect(captured).toHaveLength(0)
  })

  it('creates a workspace conversation with the level stamped on the row', async () => {
    insertedRow.current = row({ scope: 'workspace' })

    const res = await post({ id: 's_1', scope: 'workspace' })

    expect(res.status).toBe(201)
    expect(requireProjectAccessMock).not.toHaveBeenCalled()
    const { sql, params } = onlyQuery()
    expect(sql).toContain('insert into "conversations"')
    expect(params).toContain('workspace')
    expect(params).not.toContain(PROJECT_ID)
  })

  it('leaves a project conversation on the path it was already on', async () => {
    insertedRow.current = row({ projectId: PROJECT_ID, scope: 'project' })

    const res = await post({ id: 's_1', projectId: PROJECT_ID })

    expect(res.status).toBe(201)
    expect(requireProjectAccessMock).toHaveBeenCalled()
    const { params } = onlyQuery()
    expect(params).toContain(PROJECT_ID)
    expect(params).toContain('project')
  })
})
