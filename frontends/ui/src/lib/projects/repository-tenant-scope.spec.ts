/**
 * Every repository query must establish its own tenant scope.
 *
 * `server-component-db-access.spec.ts` proved pages do not query directly. It
 * could not prove that what they *call* works — and it didn't. `requireProjectAccess`
 * runs on every project page and calls `findProjectTenancy`, which carried the
 * note "unscoped by design". That note was about the WHERE clause; it was read
 * as covering the tenant context too, so the function established no scope and
 * every project page threw `MissingTenantContextError` (issue #344) even after
 * the rest of the repository was fixed.
 *
 * The lesson is that "does this work without an ambient context?" is a question
 * about the *call path*, not about imports, so it needs a test that actually
 * runs the path. This one does: it drives each exported repository function
 * inside an empty tenant slot — precisely the state a server component is in,
 * since its `enterWith` publish does not survive the render — and records the
 * context in force at the moment each query is awaited. A function that
 * establishes none fails here instead of in production.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }))

import { getDb } from '@/lib/db'
import { getTenantContext, runWithTenantSlot, type TenantContext } from '@/lib/db/tenant-context'
import { asDb, makeProject } from '@/test-utils/db-fixtures'
import * as repository from './repository'

/** Contexts observed at the moment a query was awaited. */
let observed: (TenantContext | undefined)[] = []

/**
 * A drizzle stand-in that records the tenant context when the query resolves.
 *
 * Any method returns the same chainable object, so it satisfies every chain the
 * repository builds without the spec having to know which. Awaiting it is what
 * a real query does at the point the db proxy demands a context, so that is
 * where the observation is taken.
 */
function recordingDb(rows: unknown[] = [makeProject()]) {
  const chain: Record<string | symbol, unknown> = {}
  const proxy: unknown = new Proxy(chain, {
    get(_target, property) {
      if (property === 'then') {
        return (resolve: (value: unknown) => unknown) => {
          observed.push(getTenantContext())
          return Promise.resolve(rows).then(resolve)
        }
      }
      // `transaction(cb)` hands the callback the same recorder.
      if (property === 'transaction') {
        return (callback: (tx: unknown) => unknown) => {
          observed.push(getTenantContext())
          return callback(proxy)
        }
      }
      return () => proxy
    },
  })
  return proxy
}

/** Each exported function, with arguments that exercise its query. */
const CALLS: Array<[string, () => Promise<unknown>]> = [
  ['listProjectsInOrg', () => repository.listProjectsInOrg('org-1')],
  ['findProjectInOrg', () => repository.findProjectInOrg('proj-1', 'org-1')],
  ['findProjectTenancy', () => repository.findProjectTenancy('proj-1')],
  [
    'insertProject',
    () =>
      repository.insertProject({
        organizationId: 'org-1',
        name: 'n',
        createdBy: 'u',
        collectionName: 'c',
      }),
  ],
  ['setProjectWorkosResourceId', () => repository.setProjectWorkosResourceId('proj-1', 'org-1', 'res-1')],
  ['renameProjectInOrg', () => repository.renameProjectInOrg('proj-1', 'org-1', 'n')],
  [
    'softDeleteProjectAndEnqueue',
    () =>
      repository.softDeleteProjectAndEnqueue(
        { id: 'proj-1', name: 'n', organizationId: 'org-1', collectionName: 'c' },
        'user-1',
        new Date('2026-08-01T00:00:00Z'),
      ),
  ],
  ['findProjectProfileInOrg', () => repository.findProjectProfileInOrg('proj-1', 'org-1')],
  [
    'updateProjectProfileIfVersion',
    () =>
      repository.updateProjectProfileIfVersion('proj-1', 'org-1', 1, {
        profile: makeProject().profile,
        profileVersion: 2,
        profilePromptView: null,
        profileDisplay: null,
        profileUpdatedAt: null,
      }),
  ],
  ['findProjectWorkosResourceId', () => repository.findProjectWorkosResourceId('proj-1', 'org-1')],
  ['restoreProjectIfPending', () => repository.restoreProjectIfPending('proj-1', 'org-1')],
]

describe('projects repository establishes its own tenant scope', () => {
  beforeEach(() => {
    observed = []
    vi.mocked(getDb).mockReturnValue(asDb(recordingDb() as Record<string, unknown>))
  })

  it.each(CALLS)('%s runs every query inside a scope', async (_name, call) => {
    // An EMPTY slot: the request has begun but nothing published a tenant —
    // exactly a server component, whose session publish does not reach here.
    await runWithTenantSlot(async () => {
      await call()
    })

    expect(observed.length, 'the function ran no query — the recorder never fired').toBeGreaterThan(0)
    expect(
      observed.filter((context) => context === undefined),
      'a query ran with no tenant context. Wrap it in withTenant({ organizationId }) — or, if it ' +
        'genuinely spans tenants, withPlatformAccess(reason).',
    ).toEqual([])
  })

  it('the recorder really does observe an absent context', () => {
    // Guards the guard: if `getTenantContext()` returned something even outside
    // a scope, every case above would pass vacuously.
    expect(getTenantContext()).toBeUndefined()
  })

  it('the tenancy probe states a platform reason rather than a tenant', async () => {
    // It reads a row that may belong to another organization so the caller can
    // decide whether a mismatch is a 404, so a tenant scope would be a lie.
    await runWithTenantSlot(() => repository.findProjectTenancy('proj-1'))

    expect(observed.map((context) => context?.kind)).toContain('platform')
  })
})
