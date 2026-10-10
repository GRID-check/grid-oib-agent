import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('server-only', () => ({}))

let held = new Set<string>()
vi.mock('@/lib/authz/decide', () => ({
  can: async (_session: unknown, permission: string) => held.has(permission),
}))

let budgetAdmin = false
let managesEvenWhenClosed = false
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: async () => {
    if (!managesEvenWhenClosed) throw new Error('Not found')
    return { role: 'project-admin', closed: true, readsBecauseClosed: false }
  },
}))
vi.mock('@/lib/authz/organizations', () => ({ canManageBudgets: () => budgetAdmin }))

import { resolveProjectSettingsAccess } from './settings-access'

const session = { organizationId: 'org-1', userId: 'u1' } as AuthorizedSession

beforeEach(() => {
  held = new Set()
  budgetAdmin = false
  managesEvenWhenClosed = false
})

describe('resolveProjectSettingsAccess', () => {
  test('a plain viewer may change nothing', async () => {
    held = new Set(['project:view'])
    await expect(resolveProjectSettingsAccess(session, 'p1')).resolves.toEqual({
      manage: false,
      changeStatus: false,
      manageMembers: false,
      editProfile: false,
      writeMemory: false,
      writeDocuments: false,
      manageBudget: false,
    })
  })

  test('decides by permission, so a custom role holding only members:manage gets the roster', async () => {
    // The old page asked `role === 'project-admin'` and would have refused this.
    held = new Set(['project:view', 'project:members:manage'])
    const access = await resolveProjectSettingsAccess(session, 'p1')
    expect(access.manageMembers).toBe(true)
    expect(access.manage).toBe(false)
  })

  test('the legacy project:edit umbrella still grants the narrow writes', async () => {
    held = new Set(['project:view', 'project:edit'])
    const access = await resolveProjectSettingsAccess(session, 'p1')
    expect(access).toMatchObject({ editProfile: true, writeMemory: true, writeDocuments: true })
  })

  test('a closed project keeps status changes and the roster for its manager, nothing else (ADR-0090)', async () => {
    // `can` refuses every write into a closed project but members:manage, so
    // only the roster survives it; closing, reopening and deleting are asked
    // with `evenWhenClosed`.
    held = new Set(['project:view', 'project:members:manage'])
    managesEvenWhenClosed = true
    const access = await resolveProjectSettingsAccess(session, 'p1')
    expect(access).toMatchObject({ manage: false, changeStatus: true, manageMembers: true, writeMemory: false })
  })

  test('the project budget is open to project admins and to org budget admins', async () => {
    held = new Set(['project:view', 'project:manage'])
    expect((await resolveProjectSettingsAccess(session, 'p1')).manageBudget).toBe(true)

    held = new Set(['project:view'])
    budgetAdmin = true
    expect((await resolveProjectSettingsAccess(session, 'p1')).manageBudget).toBe(true)
  })
})
