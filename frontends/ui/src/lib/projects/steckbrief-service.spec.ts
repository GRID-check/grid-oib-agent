/**
 * @vitest-environment node
 *
 * The Steckbrief service (ADR-0089): who may read, change and erase, that an
 * account link must name a member, and that the audit trail never names a
 * person.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const requireProjectAccess = vi.fn()
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: (...args: unknown[]) => requireProjectAccess(...args),
}))
const isUserInOrganization = vi.fn()
vi.mock('@/lib/authz/project-membership', () => ({
  isUserInOrganization: (...args: unknown[]) => isUserInOrganization(...args),
}))
const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (...args: unknown[]) => recordAuditEvent(...args) }))
vi.mock('@/lib/sharing/directory', () => ({
  loadOrganizationDirectory: vi.fn(async () => new Map([['user_anna', { userId: 'user_anna', name: 'Anna Weber', email: 'a@b.at' }]])),
}))
vi.mock('./repository', () => ({
  findProjectProfile: vi.fn(async () => ({
    facts: { standort_adresse: { value: 'Seestadtstraße 12, 1220 Wien' } },
    goals: {},
    unknowns: [],
    assumptions: {},
  })),
}))
const repo = vi.hoisted(() => ({
  findProjectPeriod: vi.fn(),
  updateProjectPeriod: vi.fn(),
  listProjectPeople: vi.fn(),
  insertProjectPerson: vi.fn(),
  updateProjectPersonRow: vi.fn(),
  deleteProjectPersonRow: vi.fn(),
}))
vi.mock('./steckbrief-repository', () => repo)

import { NotFoundError } from '@/lib/api/errors'
import { projectClosedError } from './project-status'
import type { AuthorizedSession } from '@/lib/auth/types'
import { addProjectPerson, deleteProjectPerson, getSteckbrief, setProjectPeriod } from './steckbrief-service'
import { projectPersonSchema } from './steckbrief-types'

const session: AuthorizedSession = {
  userId: 'user_pl',
  email: 'pl@buero.at',
  name: 'PL',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'person-1',
  organizationId: 'org_1',
  projectId: 'p1',
  name: 'DI Maria Huber',
  function: 'Statik',
  company: 'Huber ZT GmbH',
  startedOn: '2023-03-01',
  endedOn: '2025-11-01',
  userId: null,
  createdBy: 'user_pl',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const access = (closed: boolean) => ({ role: 'project-editor', closed, readsBecauseClosed: false })

/** A project where the reader may do everything a closed or active project lets them. */
function allow(closed: boolean) {
  requireProjectAccess.mockImplementation(async (_s, _p, permission, options?: { evenWhenClosed?: boolean }) => {
    const asked = Array.isArray(permission) ? permission : [permission]
    if (closed && !options?.evenWhenClosed && !asked.includes('project:view')) throw projectClosedError()
    return access(closed)
  })
}

describe('the Steckbrief', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    repo.findProjectPeriod.mockResolvedValue({ startedOn: '2023-03-01', endedOn: null })
    repo.listProjectPeople.mockResolvedValue([row(), row({ id: 'person-2', name: 'Anna Weber', userId: 'user_anna' })])
  })

  it('reads the address from the profile, the period as months, and the people with their linked accounts', async () => {
    allow(false)
    const view = await getSteckbrief(session, 'p1')
    expect(view).toMatchObject({
      address: 'Seestadtstraße 12, 1220 Wien',
      startedOn: '2023-03',
      endedOn: null,
      canEdit: true,
      canErase: true,
    })
    expect(view.people[0]).toEqual({
      id: 'person-1',
      name: 'DI Maria Huber',
      function: 'Statik',
      company: 'Huber ZT GmbH',
      startedOn: '2023-03',
      endedOn: '2025-11',
      account: null,
    })
    expect(view.people[1].account).toEqual({ userId: 'user_anna', name: 'Anna Weber' })
    // No e-mail anywhere in what the reader gets.
    expect(JSON.stringify(view)).not.toContain('a@b.at')
  })

  it('a closed project: read-only for the Steckbrief, but whoever manages it may still erase a person', async () => {
    allow(true)
    const view = await getSteckbrief(session, 'p1')
    expect(view).toMatchObject({ canEdit: false, canErase: true })

    await expect(setProjectPeriod(session, 'p1', { startedOn: '2023-03', endedOn: '2025-12' })).rejects.toMatchObject({
      details: { reason: 'project-closed' },
    })
    await expect(
      addProjectPerson(session, 'p1', projectPersonSchema.parse({ name: 'X', function: null, company: null, startedOn: null, endedOn: null, userId: null }))
    ).rejects.toMatchObject({ details: { reason: 'project-closed' } })

    repo.deleteProjectPersonRow.mockResolvedValue(true)
    await deleteProjectPerson(session, 'p1', 'person-1')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'p1', 'project:manage', { evenWhenClosed: true })
    expect(repo.deleteProjectPersonRow).toHaveBeenCalledWith('p1', 'org_1', 'person-1')
  })

  it('in a closed project, someone who does not manage it erases nobody', async () => {
    requireProjectAccess.mockImplementation(async (_s, _p, permission) => {
      if (permission === 'project:view') return access(true)
      throw new NotFoundError()
    })
    await expect(deleteProjectPerson(session, 'p1', 'person-1')).rejects.toBeInstanceOf(NotFoundError)
    expect(repo.deleteProjectPersonRow).not.toHaveBeenCalled()
  })

  it('stores months as the first of the month, and audits the period', async () => {
    allow(false)
    repo.updateProjectPeriod.mockResolvedValue({ startedOn: '2023-03-01', endedOn: '2025-12-01' })
    await expect(setProjectPeriod(session, 'p1', { startedOn: '2023-03', endedOn: '2025-12' })).resolves.toEqual({
      startedOn: '2023-03',
      endedOn: '2025-12',
    })
    expect(repo.updateProjectPeriod).toHaveBeenCalledWith('p1', 'org_1', { startedOn: '2023-03-01', endedOn: '2025-12-01' })
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.period.changed' }))
  })

  it('links an account only to a member of the organization', async () => {
    allow(false)
    isUserInOrganization.mockResolvedValue(false)
    const input = projectPersonSchema.parse({
      name: 'Anna Weber',
      function: 'Projektleitung',
      company: null,
      startedOn: '2023-03',
      endedOn: null,
      userId: 'user_foreign',
    })
    await expect(addProjectPerson(session, 'p1', input)).rejects.toMatchObject({ status: 400, details: { reason: 'unknown-account' } })
    expect(repo.insertProjectPerson).not.toHaveBeenCalled()
  })

  it('audits a person by id, never by name', async () => {
    allow(false)
    repo.insertProjectPerson.mockResolvedValue(row())
    await addProjectPerson(
      session,
      'p1',
      projectPersonSchema.parse({ name: 'DI Maria Huber', function: 'Statik', company: 'Huber ZT GmbH', startedOn: '2023-03', endedOn: '2025-11', userId: null })
    )
    repo.deleteProjectPersonRow.mockResolvedValue(true)
    await deleteProjectPerson(session, 'p1', 'person-1')

    expect(recordAuditEvent.mock.calls.map(([event]) => event.action)).toEqual(['project.person.added', 'project.person.deleted'])
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain('Huber')
  })
})

describe('projectPersonSchema', () => {
  const base = { name: 'Maria Huber', function: '', company: '  ', startedOn: '2023-03', endedOn: '2023-01', userId: null }

  it('refuses a period that runs backwards, and a day-precise date', () => {
    expect(projectPersonSchema.safeParse(base).success).toBe(false)
    expect(projectPersonSchema.safeParse({ ...base, startedOn: '2023-03-15', endedOn: null }).success).toBe(false)
  })

  it('takes nothing beyond the fields it names: no e-mail, no phone', () => {
    expect(projectPersonSchema.safeParse({ ...base, endedOn: null, email: 'm@h.at' }).success).toBe(false)
    expect(projectPersonSchema.safeParse({ ...base, endedOn: null, phone: '+43 1' }).success).toBe(false)
  })

  it('stores an empty Funktion or Firma as nothing', () => {
    expect(projectPersonSchema.parse({ ...base, endedOn: null })).toMatchObject({ function: null, company: null })
  })
})
