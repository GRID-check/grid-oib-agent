/**
 * @vitest-environment node
 */

/**
 * The similar-projects page's service, with the access and the repositories
 * mocked: the page reads only the closed projects the reader may view, other
 * than the current one, most alike first and at most twelve; the access asked
 * is `project:view` on the current project before anything is listed; a project
 * whose read is refused is left out and no other; decisions are the project
 * memory's own read, active project-scope decisions and constraints only, at
 * most five; permit records come through the memory's clearance, bounded; and
 * the unconfirmed values are marked as such.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Project } from '@/lib/db/schema'
import { makeMemoryItem, makeProject } from '@/test-utils/db-fixtures'

vi.mock('server-only', () => ({}))

const ORG = 'org_1'
const session = { userId: 'user_me', organizationId: ORG, role: 'member', permissions: [] } as unknown as AuthorizedSession

const state = vi.hoisted(() => ({
  /** Every project of the organization: the ones the reader may not view are in here and nowhere the page can see. */
  inOrg: [] as Project[],
  /** What `listProjects` answers: the projects this reader may view. */
  visible: [] as Project[],
  memory: new Map<string, unknown[]>(),
  /** Projects whose memory read is refused between the listing and the read. */
  refused: new Set<string>(),
  failing: new Set<string>(),
  cleared: new Map<string, string[]>(),
  permits: new Map<string, unknown[]>(),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(async () => ({})),
}))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(async (id: string) => state.inOrg.find((project) => project.id === id) ?? null),
  listProjectsInOrg: vi.fn(async () => state.inOrg),
}))
vi.mock('@/lib/projects/service', () => ({
  listProjects: vi.fn(async () => state.visible),
  getProjectMemory: vi.fn(async (_session: unknown, projectId: string) => {
    if (state.refused.has(projectId)) throw new ForbiddenError('no access')
    if (state.failing.has(projectId)) throw new Error('database down')
    return state.memory.get(projectId) ?? []
  }),
  memoryClearance: vi.fn(async (_session: unknown, projectId: string) => ({ cleared: state.cleared.get(projectId) ?? [] })),
}))
// Live folder judgement is live-access.spec's subject; here the cleared folders pass through as the visible ones.
vi.mock('@/lib/permits/live-access', () => ({
  liveFolderAccess: vi.fn(async (_org: string, _projectId: string, readable: readonly string[]) => ({
    visibleFolderIds: [...readable],
    restrictionOf: () => null,
  })),
}))

vi.mock('@/lib/permits/repository', () => ({
  listPermitRecordsForProject: vi.fn(async (_org: string, projectId: string) => state.permits.get(projectId) ?? []),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { getProjectMemory, listProjects, memoryClearance } from '@/lib/projects/service'
import { listPermitRecordsForProject } from '@/lib/permits/repository'
import { getSimilarProjects } from './service'
import { SIMILAR_PERMIT_REQUIREMENTS_MAX, SIMILAR_PERMIT_RECORDS_READ, SIMILAR_PERMITS_MAX, SIMILAR_PROJECTS_MAX } from './types'

const fact = (value: unknown) => ({ value, confidence: 'confirmed', source: 'user_confirmed', updatedAt: '2026-01-01T00:00:00Z' })
const suggestion = (value: unknown) => ({
  value,
  status: 'unconfirmed',
  reason: 'Baubeschreibung, S. 2',
  source: 'agent_suggested',
  updatedAt: '2026-01-01T00:00:00Z',
})

/** A profile from its confirmed facts and its suggested ones. */
function profileOf(facts: Record<string, unknown> = {}, assumptions: Record<string, unknown> = {}) {
  return {
    facts: Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, fact(value)])),
    goals: {},
    unknowns: [],
    assumptions,
  } as unknown as Project['profile']
}

const HOLZBAU = { bundesland: 'niederoesterreich', gebaeudeklasse: 4, bauweise: ['holzbau'], nutzungen: ['wohnen'] }

function closed(id: string, extra: Partial<Project> = {}): Project {
  return makeProject({
    id,
    organizationId: ORG,
    name: `Projekt ${id}`,
    status: 'closed',
    closedAt: new Date('2024-05-03T10:00:00Z'),
    createdAt: new Date('2019-02-01T00:00:00Z'),
    ...extra,
  })
}

const current = makeProject({
  id: 'current',
  organizationId: ORG,
  name: 'Wohnhaus Ried',
  profile: profileOf(HOLZBAU),
})
const nearby = closed('closed-near', { profile: profileOf(HOLZBAU), startedOn: '2019-03-01', endedOn: '2021-11-30' })
const mid = closed('closed-mid', { profile: profileOf({ bundesland: 'niederoesterreich' }, {}) })
const far = closed('closed-far', { profile: profileOf({ bundesland: 'wien', gebaeudeklasse: 1, bauweise: ['massivbau'] }) })
const activeTwin = makeProject({ id: 'active-twin', organizationId: ORG, profile: profileOf(HOLZBAU), status: 'active' })
const hidden = closed('closed-hidden', { profile: profileOf(HOLZBAU) })

const decision = (id: string, extra: Record<string, unknown> = {}) =>
  makeMemoryItem({ id, projectId: 'closed-near', kind: 'decision', status: 'active', content: `Entscheidung ${id}`, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  state.inOrg = [current, nearby, mid, far, activeTwin, hidden]
  state.visible = [nearby, mid, far, activeTwin, current]
  state.memory = new Map()
  state.refused = new Set()
  state.failing = new Set()
  state.cleared = new Map()
  state.permits = new Map()
})

describe('getSimilarProjects: which projects', () => {
  it('lists only the closed projects other than the current one, most alike first', async () => {
    const result = await getSimilarProjects(session, 'current')
    expect(result.map((project) => project.id)).toEqual(['closed-near', 'closed-mid', 'closed-far'])
  })

  it('never lists a project the reader cannot view, and reads none of its memory', async () => {
    // `hidden` is as alike as `nearby`, but it is not in what the reader may view.
    const result = await getSimilarProjects(session, 'current')
    expect(result.map((project) => project.id)).not.toContain('closed-hidden')
    expect(vi.mocked(getProjectMemory).mock.calls.map(([, id]) => id)).not.toContain('closed-hidden')
    expect(vi.mocked(listPermitRecordsForProject).mock.calls.map(([, id]) => id)).not.toContain('closed-hidden')
  })

  it('asks view on the current project before listing anything', async () => {
    await getSimilarProjects(session, 'current')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'current', 'project:view')
    expect(vi.mocked(requireProjectAccess).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(listProjects).mock.invocationCallOrder[0]
    )
  })

  it('lists nothing when the access check refuses the current project', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError())
    await expect(getSimilarProjects(session, 'current')).rejects.toBeInstanceOf(NotFoundError)
    expect(listProjects).not.toHaveBeenCalled()
  })

  it('answers an empty list when no closed project is like this one', async () => {
    state.visible = [activeTwin, current]
    expect(await getSimilarProjects(session, 'current')).toEqual([])
    expect(getProjectMemory).not.toHaveBeenCalled()
  })

  it('lists at most twelve projects', async () => {
    const many = Array.from({ length: SIMILAR_PROJECTS_MAX + 4 }, (_, index) =>
      closed(`closed-${index}`, { profile: profileOf(HOLZBAU) })
    )
    state.visible = [...many, current]
    const result = await getSimilarProjects(session, 'current')
    expect(result).toHaveLength(SIMILAR_PROJECTS_MAX)
  })

  it('drops a project whose read is refused in between, and keeps the others', async () => {
    state.refused.add('closed-near')
    const result = await getSimilarProjects(session, 'current')
    expect(result.map((project) => project.id)).toEqual(['closed-mid', 'closed-far'])
  })

  it('lets any other failure through rather than hiding it', async () => {
    state.failing.add('closed-near')
    await expect(getSimilarProjects(session, 'current')).rejects.toThrow('database down')
  })
})

describe('getSimilarProjects: what each project shares and records', () => {
  it('names what the two projects share, in the intake’s own labels', async () => {
    const [near] = await getSimilarProjects(session, 'current')
    expect(near.sharedTraits).toEqual(['Niederösterreich', 'GK 4', 'Holzbau', 'Wohnen'])
    const [, , farProject] = await getSimilarProjects(session, 'current')
    expect(farProject.sharedTraits).toEqual([])
  })

  it('reads the Bundesland and the period, and ends a closed project without an end date on its closing day', async () => {
    const result = await getSimilarProjects(session, 'current')
    const byId = Object.fromEntries(result.map((project) => [project.id, project]))
    expect(byId['closed-near'].period).toEqual({ start: '2019-03-01', end: '2021-11-30' })
    expect(byId['closed-far'].period).toEqual({ start: '2019-02-01', end: '2024-05-03' })
    expect(byId['closed-near'].bundesland).toEqual({ value: 'Niederösterreich', confirmed: true })
  })

  it('marks an OIB edition read from the documents as unconfirmed, and a confirmed one as confirmed', async () => {
    const suggested = closed('closed-near', {
      profile: profileOf(HOLZBAU, { oib_ausgabe: suggestion('2019') }),
    })
    const confirmed = closed('closed-mid', { profile: profileOf({ bundesland: 'niederoesterreich', oib_ausgabe: '2015' }) })
    state.visible = [suggested, confirmed, far, current]
    const result = await getSimilarProjects(session, 'current')
    const byId = Object.fromEntries(result.map((project) => [project.id, project]))
    expect(byId['closed-near'].oibEdition).toEqual({ value: '2019', confirmed: false })
    expect(byId['closed-mid'].oibEdition).toEqual({ value: '2015', confirmed: true })
    expect(byId['closed-far'].oibEdition).toBeNull()
  })

  it('marks a Bundesland read from the documents as unconfirmed', async () => {
    const suggestedLand = closed('closed-near', {
      profile: profileOf({ gebaeudeklasse: 4 }, { bundesland: suggestion('niederoesterreich') }),
    })
    state.visible = [suggestedLand, current]
    const [only] = await getSimilarProjects(session, 'current')
    expect(only.bundesland).toEqual({ value: 'Niederösterreich', confirmed: false })
  })

  it('takes decisions from the project memory read: active project decisions and constraints only, at most five', async () => {
    state.memory.set('closed-near', [
      ...Array.from({ length: 7 }, (_, index) => decision(`d${index}`)),
      decision('question', { kind: 'open_question' }),
      decision('superseded', { status: 'superseded' }),
      decision('org-wide', { scope: 'organization', projectId: null }),
    ])
    const [near] = await getSimilarProjects(session, 'current')
    expect(getProjectMemory).toHaveBeenCalledWith(session, 'closed-near')
    expect(near.decisions).toHaveLength(5)
    expect(near.decisions.map((entry) => entry.id)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4'])
    expect(near.decisions.every((entry) => entry.kind === 'decision' || entry.kind === 'constraint')).toBe(true)
  })

  it('gives each decision its origin: a person, the documents, or Piloti’s own note', async () => {
    state.memory.set('closed-near', [
      decision('person', { provenanceType: 'user', verification: 'user_confirmed' }),
      decision('documents', {
        provenanceType: 'distillation',
        verification: 'source_grounded',
        evidence: [{ fileName: 'Bescheid.pdf', page: '3' }],
      }),
      decision('agent', { provenanceType: 'agent', verification: 'unverified' }),
    ])
    const [near] = await getSimilarProjects(session, 'current')
    const origins = Object.fromEntries(near.decisions.map((entry) => [entry.id, entry.origin]))
    expect(origins).toEqual({ person: 'person', documents: 'documents', agent: 'agent' })
    expect(near.decisions[1].sources).toEqual([{ fileName: 'Bescheid.pdf', page: '3' }])
  })

  it('takes permit records through the memory clearance, at most five, each with at most four requirements', async () => {
    state.cleared.set('closed-near', ['folder-open'])
    const requirements = Array.from({ length: 6 }, (_, index) => ({
      kind: 'auflage',
      content: `Auflage ${index}`,
      evidence: null,
      legalBasis: null,
      page: null,
    }))
    state.permits.set(
      'closed-near',
      Array.from({ length: SIMILAR_PERMITS_MAX + 2 }, (_, index) => ({
        id: `r${index}`,
        fileName: `Bescheid ${index}.pdf`,
        kind: 'bewilligung',
        authority: 'Stadtgemeinde Mödling',
        issuedOn: '2020-06-18',
        requirements,
      }))
    )
    const [near] = await getSimilarProjects(session, 'current')
    expect(listPermitRecordsForProject).toHaveBeenCalledWith(ORG, 'closed-near', ['folder-open'], {
      maxRecords: SIMILAR_PERMIT_RECORDS_READ,
      maxPerRecord: SIMILAR_PERMIT_REQUIREMENTS_MAX,
    })
    expect(memoryClearance).toHaveBeenCalledWith(session, 'closed-near')
    expect(near.permits).toHaveLength(SIMILAR_PERMITS_MAX)
    expect(near.permits.every((permit) => permit.requirements.length === SIMILAR_PERMIT_REQUIREMENTS_MAX)).toBe(true)
    expect(near.permits[0]).toEqual({
      id: 'r0',
      fileName: 'Bescheid 0.pdf',
      kind: 'bewilligung',
      authority: 'Stadtgemeinde Mödling',
      issuedOn: '2020-06-18',
      requirements: requirements.slice(0, SIMILAR_PERMIT_REQUIREMENTS_MAX).map(({ kind, content }) => ({ kind, content })),
    })
  })
})
