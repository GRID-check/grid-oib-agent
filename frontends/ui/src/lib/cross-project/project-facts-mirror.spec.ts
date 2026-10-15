/**
 * @vitest-environment node
 *
 * The vector store's copy of each project's facts: what is copied (exactly
 * what the similarity reads), where (every collection of the project, each
 * signed for itself), and that a failure or a deployment without Qdrant never
 * reaches the person whose save triggered it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/lib/db/schema'
import { makeProject } from '@/test-utils/db-fixtures'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))

const findProjectInOrg = vi.fn()
const listProjectFactsPage = vi.fn()
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: (...args: unknown[]) => findProjectInOrg(...args),
  listProjectFactsPage: (...args: unknown[]) => listProjectFactsPage(...args),
}))
const currentRestrictedCollections = vi.fn(async (): Promise<string[]> => [])
vi.mock('@/lib/authz/folder-access', () => ({
  currentRestrictedCollections: (...args: unknown[]) => currentRestrictedCollections(...(args as [])),
}))

import {
  PROJECT_FACTS_LIMITS,
  projectFactsForIngest,
  projectFactsOf,
  similarityBoostOf,
  syncAllProjectFacts,
  syncProjectFacts,
} from './project-facts-mirror'
import { SIMILARITY_WEIGHTS, similarityFacts } from './similarity'

const fetchMock = vi.fn()

const profile = (facts: Record<string, unknown>, assumptions: Record<string, unknown> = {}) =>
  ({
    facts: Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, { value, source: 'user_confirmed' }])),
    goals: {},
    unknowns: [],
    assumptions,
  }) as unknown as Project['profile']

const HOLZBAU_WIEN = profile({
  bundesland: 'Wien',
  'gebaeudeklasse@bw1': 4,
  'bauweise@bw1': ['holzbau'],
  nutzungen: ['wohnen', 'offen'],
  vorhabensart: 'neubau',
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(new Response('{"applied":true}', { status: 200 }))
  currentRestrictedCollections.mockResolvedValue([])
})

describe('what is copied', () => {
  it('is exactly what the similarity reads: tokens, every building, „offen“ left out', () => {
    expect(projectFactsOf(HOLZBAU_WIEN)).toEqual({
      bundesland: 'wien',
      gebaeudeklasse: [4],
      bauweise: ['holzbau'],
      nutzungen: ['wohnen'],
      vorhabensart: ['neubau'],
    })
    const facts = similarityFacts(HOLZBAU_WIEN)
    expect(projectFactsOf(HOLZBAU_WIEN).gebaeudeklasse).toEqual([...facts.gebaeudeklasse])
  })

  it('takes the agent’s suggestion where no fact is confirmed, as the similarity does', () => {
    const suggested = profile({}, { bauweise: { value: ['massivbau'], source: 'agent_suggested' } })
    expect(projectFactsOf(suggested).bauweise).toEqual(['massivbau'])
  })
})

describe('what the Python tier accepts (`ProjectFacts` in `models/requests.py`)', () => {
  // A value it refuses is a 422 on every upload of the project and on every
  // boosted search, so the wire carries only what it accepts.
  const MALFORMED = profile({
    bundesland: 'x'.repeat(81),
    'gebaeudeklasse@bw1': 'Fluchtniveau 8 m → GK4',
    'gebaeudeklasse@bw2': 0,
    'gebaeudeklasse@bw3': 6,
    bauweise: Array.from({ length: 25 }, (_, n) => `bauweise${n}`),
    nutzungen: [...Array.from({ length: 45 }, (_, n) => `nutzung${n}`), 'y'.repeat(81)],
    vorhabensart: ['neubau', 'z'.repeat(81)],
  })

  it('keeps a Gebäudeklasse of 1 to 5 only, tokens of at most 80 characters, and lists the Python tier’s length', () => {
    const facts = projectFactsOf(MALFORMED)
    expect(facts.bundesland).toBeNull()
    expect(facts.gebaeudeklasse).toEqual([4])
    expect(facts.bauweise).toHaveLength(PROJECT_FACTS_LIMITS.bauweise)
    expect(facts.nutzungen).toHaveLength(PROJECT_FACTS_LIMITS.nutzungen)
    expect(facts.nutzungen).not.toContain('y'.repeat(81))
    expect(facts.vorhabensart).toEqual(['neubau'])
    expect(PROJECT_FACTS_LIMITS).toEqual({ token: 80, gebaeudeklasse: 20, bauweise: 20, nutzungen: 40, vorhabensart: 20 })
  })

  it('sends the same bounded facts as the boost, and no boost when nothing valid is left', () => {
    expect(similarityBoostOf(MALFORMED)?.facts).toEqual(projectFactsOf(MALFORMED))
    expect(similarityBoostOf(profile({ gebaeudeklasse: 7, bundesland: 'x'.repeat(90) }))).toBeNull()
  })
})

describe('the boost', () => {
  it('carries the current project’s facts and every similarity weight, in the Python tier’s names', () => {
    const boost = similarityBoostOf(HOLZBAU_WIEN)
    expect(boost?.facts).toEqual(projectFactsOf(HOLZBAU_WIEN))
    expect(boost?.weights).toEqual({
      bundesland: SIMILARITY_WEIGHTS.bundesland,
      gebaeudeklasse: SIMILARITY_WEIGHTS.gebaeudeklasse,
      gebaeudeklasse_adjacent: SIMILARITY_WEIGHTS.gebaeudeklasseAdjacent,
      bauweise: SIMILARITY_WEIGHTS.bauweise,
      nutzung: SIMILARITY_WEIGHTS.nutzung,
      nutzung_max: SIMILARITY_WEIGHTS.nutzungMax,
      vorhabensart: SIMILARITY_WEIGHTS.vorhabensart,
    })
  })

  it('is null for a project with no fact to share', () => {
    expect(similarityBoostOf(profile({}))).toBeNull()
    expect(similarityBoostOf(null)).toBeNull()
  })
})

describe('syncProjectFacts', () => {
  it('re-reads the project and PUTs its facts and status onto every collection, each signed for itself', async () => {
    findProjectInOrg.mockResolvedValue(makeProject({ id: 'p1', collectionName: 'proj_p1', status: 'closed', profile: HOLZBAU_WIEN }))
    currentRestrictedCollections.mockResolvedValue(['proj_p1_rabcdef012345'])

    expect(await syncProjectFacts('org_1', 'p1')).toBe('pushed')

    expect(findProjectInOrg).toHaveBeenCalledWith('p1', 'org_1')
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init.method,
      body: JSON.parse(init.body),
      scope: JSON.parse(
        Buffer.from(
          String(Object.entries(init.headers as Record<string, string>).find(([name]) => name.toLowerCase() === 'x-grid-request-context')?.[1]),
          'base64url'
        ).toString()
      ).collectionScope,
    }))
    expect(calls.map((call) => [call.url, call.method, call.scope])).toEqual([
      ['http://backend:8000/v1/collections/proj_p1/project-facts', 'PUT', ['proj_p1']],
      ['http://backend:8000/v1/collections/proj_p1_rabcdef012345/project-facts', 'PUT', ['proj_p1_rabcdef012345']],
    ])
    expect(calls[0].body).toEqual({ facts: projectFactsOf(HOLZBAU_WIEN), status: 'closed' })
  })

  it('never throws: a refusal, a dead backend or a failed read is an outcome, not an error', async () => {
    findProjectInOrg.mockResolvedValue(makeProject({ id: 'p1' }))
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 409 }))
    expect(await syncProjectFacts('org_1', 'p1')).toBe('unsupported')

    fetchMock.mockRejectedValueOnce(new Error('down'))
    expect(await syncProjectFacts('org_1', 'p1')).toBe('failed')

    findProjectInOrg.mockRejectedValueOnce(new Error('db down'))
    expect(await syncProjectFacts('org_1', 'p1')).toBe('failed')

    findProjectInOrg.mockResolvedValueOnce(null)
    expect(await syncProjectFacts('org_1', 'gone')).toBeNull()
  })
})

describe('projectFactsForIngest', () => {
  it('is the project as it is now, and null outside a project or when it cannot be read', async () => {
    findProjectInOrg.mockResolvedValue(makeProject({ id: 'p1', status: 'paused', profile: HOLZBAU_WIEN }))
    expect(await projectFactsForIngest('p1', 'org_1')).toEqual({ facts: projectFactsOf(HOLZBAU_WIEN), status: 'paused' })
    expect(await projectFactsForIngest(null, 'org_1')).toBeNull()
    findProjectInOrg.mockRejectedValueOnce(new Error('db down'))
    expect(await projectFactsForIngest('p1', 'org_1')).toBeNull()
  })
})

describe('syncAllProjectFacts', () => {
  const row = (id: string) => ({ id, organizationId: 'org_1', collectionName: `proj_${id}`, profile: profile({}), status: 'active' })

  it('pages through every live project and counts the failures', async () => {
    listProjectFactsPage
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, index) => row(`a${String(index).padStart(3, '0')}`)))
      .mockResolvedValueOnce([row('b1')])
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }))

    const result = await syncAllProjectFacts()

    expect(result).toEqual({ projects: 201, failed: 1, unsupported: false })
    expect(listProjectFactsPage.mock.calls).toEqual([
      [null, 200],
      ['a199', 200],
    ])
  })

  it('stops at the first answer that this deployment writes no Qdrant', async () => {
    listProjectFactsPage.mockResolvedValueOnce([row('a'), row('b'), row('c')])
    fetchMock.mockResolvedValue(new Response('{}', { status: 409 }))

    expect(await syncAllProjectFacts()).toEqual({ projects: 0, failed: 0, unsupported: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
