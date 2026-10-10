/**
 * @vitest-environment node
 */
/**
 * The cross-project lookups (ADR-0094), with the projects listing, the
 * project's own search and the stores mocked: only a solo chat may ask; a
 * project the reader cannot open is invisible (the listing decides, and the
 * search never reaches it); the conversation's own project is left out; one
 * call searches a bounded page of projects and says where the next starts;
 * every hit names its project and status; the filters hold.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { ConversationAudienceRow } from '@/lib/conversations/restricted-use-repository'
import type { Project } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))

const state = vi.hoisted(() => ({
  audience: null as ConversationAudienceRow | null,
  reachable: [] as Project[],
  hits: new Map<string, Array<Record<string, unknown>>>(),
  failing: new Set<string>(),
  searched: [] as Array<{ projectId: string; topK: number; snippetMaxChars?: number; forModel?: boolean }>,
  recorded: [] as Array<{ projectIds: readonly string[]; folderIds: readonly string[] }>,
  /** Restricted collection → source folder, for the project whose folder tree is asked. */
  folders: new Map<string, string>(),
  inFlight: 0,
  peak: 0,
}))

vi.mock('@/lib/db', () => ({ getDb: () => ({}) }))
vi.mock('@/lib/conversations/restricted-use-repository', () => ({
  readConversationAudience: vi.fn(async () => state.audience),
}))
vi.mock('@/lib/projects/service', () => ({ listChatProjects: vi.fn(async () => state.reachable) }))
vi.mock('@/lib/conversations/cross-project-use', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/conversations/cross-project-use')>()),
  recordCrossProjectHandOut: vi.fn(async (_party: unknown, handOut: { projectIds: string[]; folderIds: string[] }) => {
    state.recorded.push(handOut)
  }),
}))
vi.mock('@/lib/authz/folder-access', () => ({
  getProjectFolderAccess: vi.fn(async () => ({ sourceFolderOf: (collection: string) => state.folders.get(collection) ?? null })),
}))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(async (id: string) => state.reachable.find((project) => project.id === id) ?? null),
}))
vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(async (_session: unknown, projectId: string) => {
    if (!state.reachable.some((project) => project.id === projectId)) throw new Error('Not found')
    return { role: 'project-viewer' }
  }),
}))
vi.mock('@/lib/documents/service', () => ({
  searchProjectDocuments: vi.fn(
    async (_session: unknown, projectId: string, _query: string, topK: number, options: { snippetMaxChars?: number; forModel?: boolean }) => {
    state.searched.push({ projectId, topK, snippetMaxChars: options.snippetMaxChars, forModel: options.forModel })
    state.inFlight += 1
    state.peak = Math.max(state.peak, state.inFlight)
    await Promise.resolve()
    state.inFlight -= 1
    if (state.failing.has(projectId)) throw new Error('backend down')
    return { hits: state.hits.get(projectId) ?? [] }
  }),
}))

import { CrossProjectSharedChatError, NotFoundError } from '@/lib/api/errors'
import { requireProjectAccess } from '@/lib/authz/projects'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import {
  CROSS_PROJECT_SNIPPET_CHARS,
  listLookupProjects,
  periodOverlaps,
  readProjectBrief,
  requireSoloConversation,
  searchAcrossProjects,
  SEARCH_CONCURRENCY,
} from './service'
import { CROSS_PROJECT_PAGE_PROJECTS, crossProjectListRequestSchema, crossProjectSearchRequestSchema } from './types'

const ORG = 'org_1'
const OWNER = 'user_owner'
const session = { userId: OWNER, organizationId: ORG, role: 'member', permissions: [] } as unknown as AuthorizedSession

function project(index: number, extra: Partial<Project> = {}): Project {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    organizationId: ORG,
    name: `Projekt ${index}`,
    createdBy: OWNER,
    collectionName: `proj_${index}`,
    workosResourceId: null,
    profile: { facts: {}, goals: {}, unknowns: [], assumptions: {} },
    profileVersion: 1,
    profilePromptView: null,
    profileDisplay: null,
    profileUpdatedAt: null,
    status: 'active',
    closedAt: null,
    closedBy: null,
    startedOn: null,
    endedOn: null,
    deletedAt: null,
    createdAt: new Date(`2026-0${(index % 9) + 1}-15T10:00:00Z`),
    ...extra,
  }
}

function hit(id: string, score: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    filename: `${id}.pdf`,
    displayName: null,
    collectionName: 'proj_1',
    createdAt: new Date('2026-05-01T08:00:00Z'),
    snippet: `Auszug aus ${id}`,
    page: 2,
    score,
    tags: ['Detail', 'Brandschutz'],
    ...extra,
  }
}

const solo: ConversationAudienceRow = { exists: true, projectId: null, createdBy: OWNER, visibility: 'private', grantees: [] }
const caller = (currentProjectId: string | null = null) => ({ session, conversationId: 's_conv', currentProjectId })
const search = (body: Record<string, unknown>) => crossProjectSearchRequestSchema.parse({ query: 'Dachdetail Holzbau', ...body })

beforeEach(() => {
  vi.clearAllMocks()
  state.audience = solo
  state.reachable = [project(1), project(2), project(3)]
  state.hits = new Map()
  state.failing = new Set()
  state.searched = []
  state.recorded = []
  state.folders = new Map()
  state.inFlight = 0
  state.peak = 0
})

describe('who may ask', () => {
  it('refuses a shared chat with a typed 409 whose German sentence the agent relays, before searching anything', async () => {
    state.audience = { ...solo, grantees: ['user_ina'] }

    const error = await searchAcrossProjects(caller(), search({})).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CrossProjectSharedChatError)
    expect((error as CrossProjectSharedChatError).code).toBe('CROSS_PROJECT_SHARED_CHAT')
    expect((error as CrossProjectSharedChatError).message).toContain('neuen Chat')
    expect(state.searched).toEqual([])
    expect(state.recorded).toEqual([])
    await expect(listLookupProjects(caller(), crossProjectListRequestSchema.parse({}))).rejects.toBeInstanceOf(
      CrossProjectSharedChatError
    )
    await expect(requireSoloConversation(session, 's_conv')).rejects.toBeInstanceOf(CrossProjectSharedChatError)
  })
})

describe('searchAcrossProjects', () => {
  it('searches only the projects the reader may chat in, never its own, and names each hit’s project and status', async () => {
    const [one, two, three] = state.reachable
    state.hits.set(one.id, [hit('a', 0.5)])
    state.hits.set(three.id, [hit('c', 0.9, { displayName: 'Dachdetail Traufe', collectionName: 'proj_3' })])

    const result = await searchAcrossProjects(caller(two.id), search({}))

    expect(state.searched.map((call) => call.projectId)).toEqual([one.id, three.id])
    expect(result.hits.map((found) => [found.project.name, found.project.status, found.filename])).toEqual([
      ['Projekt 3', 'active', 'c.pdf'],
      ['Projekt 1', 'active', 'a.pdf'],
    ])
    expect(result.hits[0]).toMatchObject({ title: 'Dachdetail Traufe', collection: 'proj_3', page: 2 })
    expect(result).toMatchObject({ projectsInScope: 2, projectsSearched: 2, nextOffset: null, statusKnown: false })
  })

  it('records the projects of the hits it hands out, and only those, before it answers', async () => {
    const [one, , three] = state.reachable
    state.hits.set(one.id, [hit('a', 0.5)])

    await searchAcrossProjects(caller(), search({}))

    expect(state.recorded).toEqual([{ projectIds: [one.id], folderIds: [] }])
    expect(state.recorded[0].projectIds).not.toContain(three.id)
  })

  it('records the restricted folder a passage came from, and drops one whose folder cannot be named', async () => {
    const [one] = state.reachable
    state.folders.set('proj_1_rabcdef012345', 'folder-honorare')
    state.hits.set(one.id, [
      hit('honorar', 0.9, { collectionName: 'proj_1_rabcdef012345' }),
      hit('unnamed', 0.8, { collectionName: 'proj_1_r999999999999' }),
      hit('plan', 0.7),
    ])

    const result = await searchAcrossProjects(caller(), search({}))

    expect(result.hits.map((found) => found.filename)).toEqual(['honorar.pdf', 'plan.pdf'])
    expect(state.recorded).toEqual([{ projectIds: [one.id, one.id], folderIds: ['folder-honorare'] }])
  })

  it('returns nothing when the record refuses: a chat shared while the search ran', async () => {
    const { recordCrossProjectHandOut } = await import('@/lib/conversations/cross-project-use')
    vi.mocked(recordCrossProjectHandOut).mockRejectedValueOnce(new CrossProjectSharedChatError('geteilt'))
    state.hits.set(state.reachable[0].id, [hit('a', 0.5)])

    await expect(searchAcrossProjects(caller(), search({}))).rejects.toBeInstanceOf(CrossProjectSharedChatError)
  })

  it('makes a project out of chat reach invisible, even when named', async () => {
    const stranger = project(9)

    const result = await searchAcrossProjects(
      caller(),
      search({ scope: 'named', projectIds: [stranger.id, state.reachable[0].id] })
    )

    expect(state.searched.map((call) => call.projectId)).toEqual([state.reachable[0].id])
    expect(result.projectsInScope).toBe(1)
  })

  it('asks each project for the longer passage the agent answers from', async () => {
    await searchAcrossProjects(caller(), search({}))

    expect(state.searched.every((call) => call.snippetMaxChars === CROSS_PROJECT_SNIPPET_CHARS)).toBe(true)
  })

  it('searches every project as a model reads it: screened documents only, never the asker’s held uploads', async () => {
    await searchAcrossProjects(caller(), search({}))

    expect(state.searched.length).toBeGreaterThan(0)
    expect(state.searched.every((call) => call.forModel === true)).toBe(true)
  })

  it('searches one bounded page of projects, a bounded number at a time, and says where the next starts', async () => {
    state.reachable = Array.from({ length: CROSS_PROJECT_PAGE_PROJECTS + 3 }, (_, index) => project(index + 1))

    const first = await searchAcrossProjects(caller(), search({}))
    expect(first).toMatchObject({ projectsSearched: CROSS_PROJECT_PAGE_PROJECTS, nextOffset: CROSS_PROJECT_PAGE_PROJECTS })
    expect(state.peak).toBeLessThanOrEqual(SEARCH_CONCURRENCY)

    state.searched = []
    const second = await searchAcrossProjects(caller(), search({ offset: first.nextOffset }))
    expect(second).toMatchObject({ projectsSearched: 3, nextOffset: null })
    expect(state.searched).toHaveLength(3)
  })

  it('finds nothing in the closed scope while project status is not recorded, and says so', async () => {
    const result = await searchAcrossProjects(caller(), search({ scope: 'closed' }))

    expect(result).toMatchObject({ hits: [], projectsInScope: 0, statusKnown: false })
    expect(state.searched).toEqual([])
  })

  it('narrows by the PROJECT’s period before searching, not by when a file was uploaded', async () => {
    // Projekt 1 began 2026-02-15, Projekt 2 2026-03-15, Projekt 3 2026-04-15; all still open.
    const result = await searchAcrossProjects(caller(), search({ to: '2026-03-31' }))

    expect(state.searched.map((call) => call.projectId)).toEqual([state.reachable[0].id, state.reachable[1].id])
    expect(result.projectsInScope).toBe(2)
  })

  it('filters by type and discipline after retrieval, asking each project for more', async () => {
    const [one] = state.reachable
    state.hits.set(one.id, [
      hit('detail', 0.9),
      hit('vertrag', 0.8, { tags: ['Vertrag'] }),
      hit('schall', 0.6, { tags: ['Detail', 'Schallschutz'] }),
    ])

    const result = await searchAcrossProjects(
      caller(),
      search({ documentTypes: ['Detail'], disciplines: ['Brandschutz'], limit: 5 })
    )

    expect(result.hits.map((found) => found.filename)).toEqual(['detail.pdf'])
    expect(state.searched[0].topK).toBe(15)
  })

  it('keeps the other projects when one fails, and cuts the merged ranking to the limit', async () => {
    const [one, two] = state.reachable
    state.failing.add(one.id)
    state.hits.set(two.id, [hit('x', 0.4, { collectionName: 'proj_2' }), hit('y', 0.3, { collectionName: 'proj_2' }), hit('z', 0.2, { collectionName: 'proj_2' })])

    const result = await searchAcrossProjects(caller(), search({ limit: 2 }))

    expect(result.hits.map((found) => found.filename)).toEqual(['x.pdf', 'y.pdf'])
  })
})

describe('listLookupProjects', () => {
  it('lists the reachable projects with their address and period, finds by name or address, and records them', async () => {
    state.reachable = [
      project(1, { profile: { facts: { standort_adresse: { value: 'Hauptstraße 3, Graz', confidence: 'confirmed', source: 'onboarding', updatedAt: '' } }, goals: {}, unknowns: [], assumptions: {} } }),
      project(2),
    ]
    const [one, two] = state.reachable

    const all = await listLookupProjects(caller(two.id), crossProjectListRequestSchema.parse({}))
    expect(all.projects.map((found) => [found.name, found.address, found.current, found.collection])).toEqual([
      ['Projekt 1', 'Hauptstraße 3, Graz', false, 'proj_1'],
      ['Projekt 2', null, true, 'proj_2'],
    ])
    expect(all.projects[0].period).toEqual({ start: '2026-02-15', end: null })
    // The conversation's own project is not another project: not recorded.
    expect(state.recorded).toEqual([{ projectIds: [one.id], folderIds: [] }])

    const graz = await listLookupProjects(caller(), crossProjectListRequestSchema.parse({ query: 'graz' }))
    expect(graz).toMatchObject({ total: 1, statusKnown: false })
  })

  it('filters by period and status, cuts to the limit while counting the rest, and records only what it lists', async () => {
    const result = await listLookupProjects(
      caller(),
      crossProjectListRequestSchema.parse({ from: '2026-03-01', status: 'active', limit: 1 })
    )

    // Open periods overlap every later day, so all three match.
    expect(result.total).toBe(3)
    expect(result.projects).toHaveLength(1)
    expect(state.recorded).toEqual([{ projectIds: [state.reachable[0].id], folderIds: [] }])
    expect((await listLookupProjects(caller(), crossProjectListRequestSchema.parse({ status: 'closed' }))).total).toBe(0)
  })
})

describe('readProjectBrief', () => {
  it('reads the confirmed facts and the summary of a project the reader may chat in, and records it', async () => {
    state.reachable = [
      project(1, {
        profile: { facts: { bauweise: { value: 'holzbau', confidence: 'confirmed', source: 'onboarding', updatedAt: '' } }, goals: {}, unknowns: [], assumptions: {} },
        profileDisplay: { title: 'P1', summary: 'Ein Holzbau in Graz.', keyFacts: [], missingInfo: [] },
      }),
    ]

    const brief = await readProjectBrief(caller(), { projectId: state.reachable[0].id })

    expect(brief.summary).toBe('Ein Holzbau in Graz.')
    expect(brief.facts).toContain('bauweise=holzbau')
    expect(brief.project.collection).toBe('proj_1')
    expect(vi.mocked(requireProjectAccess)).toHaveBeenCalledWith(session, state.reachable[0].id, CHAT_PERMISSIONS)
    expect(state.recorded).toEqual([{ projectIds: [state.reachable[0].id], folderIds: [] }])
  })

  it('is a not-found for a project the reader may not chat in, and records nothing', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError())

    await expect(readProjectBrief(caller(), { projectId: project(9).id })).rejects.toBeInstanceOf(NotFoundError)
    expect(state.recorded).toEqual([])
  })
})

describe('periodOverlaps', () => {
  it('is inclusive at both ends, treats an open end as running on, and is open when a bound is missing', () => {
    expect(periodOverlaps({ start: '2020-01-01', end: '2021-06-30' }, '2021-06-30', '2022-01-01')).toBe(true)
    expect(periodOverlaps({ start: '2020-01-01', end: '2021-06-30' }, '2021-07-01')).toBe(false)
    expect(periodOverlaps({ start: '2026-05-01', end: null }, undefined, '2026-04-30')).toBe(false)
    expect(periodOverlaps({ start: '2020-01-01', end: null }, '2030-01-01')).toBe(true)
  })
})
