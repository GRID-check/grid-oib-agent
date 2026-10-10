/**
 * @vitest-environment node
 */
/**
 * The download log's two routes: the admin read, gated by `org:downloads:view`
 * and mapped onto the service's query, and the retention write, which is the
 * ONLY way to set `downloadLogRetentionDays` (the generic settings save refuses
 * the key) and takes 30 to 365 days, nothing else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const session = {
  userId: 'user-1',
  organizationId: 'org_1',
  email: 'admin@grid.com',
  role: 'admin' as string | null,
  permissions: [] as string[],
}
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))

const listAccessLog = vi.fn()
vi.mock('@/lib/download-log/repository', () => ({
  listAccessLog: (...args: unknown[]) => listAccessLog(...args),
  insertAccessLogEntry: vi.fn(),
}))
vi.mock('@/lib/sharing/directory', () => ({ resolvePeople: vi.fn(async () => new Map()) }))

const stored: { settings: Record<string, unknown> } = { settings: {} }
const upsertOrganization = vi.fn(async (row: { settings: Record<string, unknown> }) => {
  stored.settings = row.settings
})
vi.mock('@/lib/organizations/repository', () => ({
  findOrganization: vi.fn(async () => ({
    workosOrganizationId: 'org_1',
    displayName: null,
    defaultLocale: 'de',
    settings: stored.settings,
  })),
  upsertOrganization: (row: { settings: Record<string, unknown> }) => upsertOrganization(row),
}))
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateCached: vi.fn(),
}))
vi.mock('@/lib/model-config/backend-key', () => ({ invalidateBackendModelConfig: vi.fn() }))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn(), WEB_SEARCH_FLAG: 'web-search' }))
vi.mock('@/lib/authz/folder-access', () => ({
  loadCustomFolderTree: vi.fn(async () => null),
  // An organization admin: a name filter narrows to nothing they may not read.
  clearanceOf: vi.fn(async () => ({ levels: {}, seesEverything: true })),
  readableFoldersOfRestrictedProjects: vi.fn(async () => []),
  seesEveryFolder: vi.fn(async () => true),
}))
const recordAuditEvent = vi.fn()
const recordAuditEventOrThrow = vi.fn()
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (event: unknown) => recordAuditEvent(event),
  recordAuditEventOrThrow: (event: unknown) => recordAuditEventOrThrow(event),
}))

import { GET } from './route'
import { PUT } from './retention/route'
import { PUT as PUT_SETTINGS } from '../settings/route'

const get = (query = ''): Promise<Response> => GET(new Request(`http://localhost/api/organization/download-log${query}`))
const put = (body: unknown): Promise<Response> =>
  PUT(
    new Request('http://localhost/api/organization/download-log/retention', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

beforeEach(() => {
  vi.clearAllMocks()
  session.role = 'admin'
  session.permissions = []
  stored.settings = {}
  listAccessLog.mockResolvedValue([])
})

describe('GET /api/organization/download-log', () => {
  it('serves an organization admin, newest first, with the retention in force', async () => {
    const res = await get()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: [], nextCursor: null, retentionDays: 365 })
  })

  it('serves a custom role that holds only org:downloads:view', async () => {
    session.role = 'org-custom'
    session.permissions = ['org:downloads:view']

    expect((await get()).status).toBe(200)
  })

  it.each([['member', []], ['org-auditor', ['org:audit:view']], ['org-compliance-officer', ['org:compliance:manage', 'org:audit:view']]])(
    'refuses %s: it is not an audit-trail or compliance permission',
    async (role, permissions) => {
      session.role = role
      session.permissions = permissions

      const res = await get()

      expect(res.status).toBe(403)
      expect(listAccessLog).not.toHaveBeenCalled()
      expect(recordAuditEventOrThrow).not.toHaveBeenCalled()
    }
  )

  it('hands the filters to the query, with `to` as the end of that day', async () => {
    await get('?userId=user_9&document=Werkvertrag&kind=download&from=2026-09-01&to=2026-09-30&limit=20')

    const [filter, cursor, limit] = listAccessLog.mock.calls[0]
    expect(filter).toMatchObject({
      organizationId: 'org_1',
      userId: 'user_9',
      documentName: 'Werkvertrag',
      kind: 'download',
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-10-01T00:00:00.000Z'),
    })
    expect(cursor).toBeNull()
    expect(limit).toBe(21)
  })

  it.each(['?from=yesterday', '?to=2026-13-45', '?kind=stream', '?limit=0', '?limit=101', '?cursor='])(
    'refuses %s as a bad request, reading nothing',
    async (query) => {
      expect((await get(query)).status).toBe(400)
      expect(listAccessLog).not.toHaveBeenCalled()
    }
  )
})

describe('PUT /api/organization/download-log/retention', () => {
  it.each([30, 90, 365])('stores %i days', async (days) => {
    session.permissions = ['org:settings:manage']

    const res = await put({ days })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ days, previous: 365 })
    expect(stored.settings).toEqual({ downloadLogRetentionDays: days })
  })

  it.each([{ days: 29 }, { days: 366 }, { days: 730 }, { days: 90.5 }, { days: '90' }, {}])(
    'refuses %j, and stores nothing',
    async (body) => {
      session.permissions = ['org:settings:manage']

      expect((await put(body)).status).toBe(400)
      expect(upsertOrganization).not.toHaveBeenCalled()
    }
  )

  it('is not a way for a role without org:settings:manage', async () => {
    session.role = 'org-auditor'
    session.permissions = ['org:downloads:view']

    expect((await put({ days: 90 })).status).toBe(403)
    expect(upsertOrganization).not.toHaveBeenCalled()
  })

  it('cannot be set through the generic settings save, which is how the 365-day ceiling would be skipped', async () => {
    session.permissions = ['org:settings:manage']

    const res = await PUT_SETTINGS(
      new Request('http://localhost/api/organization/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { downloadLogRetentionDays: 3650 } }),
      })
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('/api/organization/download-log/retention')
    expect(upsertOrganization).not.toHaveBeenCalled()
  })
})
