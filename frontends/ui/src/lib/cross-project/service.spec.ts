/**
 * @vitest-environment node
 */
/**
 * The cross-project lookups (ADR-0093), with the audience's reach, the
 * project's own search and the stores mocked: a project out of reach is
 * invisible (the reach decides, and the search never reaches it); a shared
 * chat gets no restricted folder; the record is checked against the audience
 * the reach was computed for; the conversation's own project is left out; the
 * `similar` scope walks the most alike projects first; one call searches a
 * bounded page of projects and says where the next starts; every hit names its
 * project and status; the filters hold. The reach itself: `audience-reach.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Project } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))

const state = vi.hoisted(() => ({
  reachable: [] as Project[],
  /** Projects of the organization out of the audience's reach: they exist, the lookups must not see them. */
  outOfReach: [] as Project[],
  restrictedFolders: true,
  hits: new Map<string, Array<Record<string, unknown>>>(),
  /** Rows of a project's documents the backend did NOT hit: same-named siblings in other collections. */
  siblingRows: new Map<string, Array<Record<string, unknown>>>(),
  failing: new Set<string>(),
  searched: [] as Array<{ projectId: string; topK: number; snippetMaxChars?: number; forModel?: boolean }>,
  recorded: [] as Array<{ projectIds: readonly string[]; folderIds: readonly string[] }>,
  recordedFor: [] as string[],
  /** What the decisions repository answers, and the scopes it was asked with. */
  decisions: [] as Array<Record<string, unknown>>,
  decisionScopes: [] as Array<{ projectId: string; readableFolderIds: readonly string[] }>,
  /** What the permit repository answers, and the scopes it was asked with. */
  permits: [] as Array<Record<string, unknown>>,
  permitScopes: [] as Array<{ projectId: string; readableFolderIds: readonly string[] }>,
  /** Per project, the folders the asker may read (solo chat only). */
  readable: new Map<string, string[]>(),
  /** Restricted collection → source folder, for the project whose folder tree is asked. */
  folders: new Map<string, string>(),
  inFlight: 0,
  peak: 0,
}))

vi.mock('./audience-reach', () => ({
  audienceReach: vi.fn(async () => ({ projects: state.reachable, restrictedFolders: state.restrictedFolders, key: 'audience-key' })),
}))
vi.mock('@/lib/conversations/cross-project-use', () => ({
  recordCrossProjectHandOut: vi.fn(
    async (_party: unknown, handOut: { projectIds: string[]; folderIds: string[] }, searchedFor: string) => {
      state.recorded.push(handOut)
      state.recordedFor.push(searchedFor)
    }
  ),
}))
vi.mock('@/lib/authz/folder-access', () => ({
  getProjectFolderAccess: vi.fn(async () => ({ sourceFolderOf: (collection: string) => state.folders.get(collection) ?? null })),
  clearanceOf: vi.fn(async () => ({ roles: ['org-gf'], seesEverything: false })),
  readableFolderIdsFor: vi.fn(async (_org: string, projectId: string) => state.readable.get(projectId) ?? []),
}))
vi.mock('./decisions-repository', () => ({
  searchProjectDecisions: vi.fn(async (_org: string, scopes: Array<{ projectId: string; readableFolderIds: readonly string[] }>) => {
    state.decisionScopes.push(...scopes)
    return state.decisions
  }),
}))
vi.mock('@/lib/permits/repository', () => ({
  searchPermitRequirements: vi.fn(async (_org: string, scopes: Array<{ projectId: string; readableFolderIds: readonly string[] }>) => {
    state.permitScopes.push(...scopes)
    return state.permits
  }),
}))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(
    async (id: string) => [...state.reachable, ...state.outOfReach].find((project) => project.id === id) ?? null
  ),
}))
// Only the backend call and the row lookup are replaced; the join is the real
// `joinHitsToFiles`. A mock that handed back already-joined hits carrying their
// own `collectionName` is what let a hit from a restricted folder's collection
// be labelled with an open collection (a newer same-named row) unnoticed.
vi.mock('@/lib/documents/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents/service')>()
  return {
    searchProjectDocuments: vi.fn(
      async (_session: unknown, projectId: string, _query: string, topK: number, options: { snippetMaxChars?: number; forModel?: boolean }) => {
        state.searched.push({ projectId, topK, snippetMaxChars: options.snippetMaxChars, forModel: options.forModel })
        state.inFlight += 1
        state.peak = Math.max(state.peak, state.inFlight)
        await Promise.resolve()
        state.inFlight -= 1
        if (state.failing.has(projectId)) throw new Error('backend down')
        // What the backend answers: one hit per passage, naming the collection it was found in.
        const found = state.hits.get(projectId) ?? []
        const backendHits = found.map((row) => ({
          file_name: row.filename as string,
          collection: row.collectionName as string,
          score: row.score as number,
          snippet: row.snippet as string,
          page_number: row.page as number | null,
        }))
        // What the database answers for those names: the hit documents' rows and any same-named siblings.
        const rows = [
          ...found.map(({ snippet: _snippet, page: _page, score: _score, ...row }) => ({ authoredBy: 'user', ...row })),
          ...(state.siblingRows.get(projectId) ?? []),
        ] as unknown as Array<{ filename: string; collectionName: string; createdAt: Date; authoredBy: string }>
        return { hits: actual.joinHitsToFiles(backendHits, rows) }
      }
    ),
  }
})

import { CrossProjectAudienceChangedError, NotFoundError } from '@/lib/api/errors'
import {
  CROSS_PROJECT_SNIPPET_CHARS,
  listLookupProjects,
  periodOverlaps,
  readProjectBrief,
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

const caller = (currentProjectId: string | null = null) => ({ session, conversationId: 's_conv', currentProjectId })
const search = (body: Record<string, unknown>) => crossProjectSearchRequestSchema.parse({ query: 'Dachdetail Holzbau', ...body })

beforeEach(() => {
  vi.clearAllMocks()
  state.reachable = [project(1), project(2), project(3)]
  state.outOfReach = [project(9)]
  state.restrictedFolders = true
  state.hits = new Map()
  state.siblingRows = new Map()
  state.failing = new Set()
  state.searched = []
  state.recorded = []
  state.recordedFor = []
  state.decisions = []
  state.decisionScopes = []
  state.permits = []
  state.permitScopes = []
  state.readable = new Map()
  state.folders = new Map()
  state.inFlight = 0
  state.peak = 0
})

describe('searchAcrossProjects', () => {
  it('searches only the projects in reach, never its own, and names each hit’s project and status', async () => {
    state.reachable = [project(1), project(2), project(3, { status: 'closed', closedAt: new Date(), closedBy: OWNER })]
    const [one, two, three] = state.reachable
    state.hits.set(one.id, [hit('a', 0.5)])
    state.hits.set(three.id, [hit('c', 0.9, { displayName: 'Dachdetail Traufe', collectionName: 'proj_3' })])

    const result = await searchAcrossProjects(caller(two.id), search({}))

    expect(state.searched.map((call) => call.projectId)).toEqual([one.id, three.id])
    expect(result.hits.map((found) => [found.project.name, found.project.status, found.filename])).toEqual([
      ['Projekt 3', 'closed', 'c.pdf'],
      ['Projekt 1', 'active', 'a.pdf'],
    ])
    expect(result.hits[0]).toMatchObject({ title: 'Dachdetail Traufe', collection: 'proj_3', page: 2 })
    expect(result).toMatchObject({ projectsInScope: 2, projectsSearched: 2, nextOffset: null })
  })

  it('records the projects of the hits it hands out, and only those, before it answers', async () => {
    const [one, , three] = state.reachable
    state.hits.set(one.id, [hit('a', 0.5)])

    await searchAcrossProjects(caller(), search({}))

    expect(state.recorded).toEqual([{ projectIds: [one.id], folderIds: [] }])
    expect(state.recorded[0].projectIds).not.toContain(three.id)
    // Checked under the lock against the audience the reach was computed for.
    expect(state.recordedFor).toEqual(['audience-key'])
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

  it('searches no restricted folder from a shared chat: only the project’s open collection reaches it', async () => {
    const [one] = state.reachable
    state.restrictedFolders = false
    state.folders.set('proj_1_rabcdef012345', 'folder-honorare')
    state.hits.set(one.id, [hit('honorar', 0.9, { collectionName: 'proj_1_rabcdef012345' }), hit('plan', 0.7)])

    const result = await searchAcrossProjects(caller(), search({}))

    expect(result.hits.map((found) => found.filename)).toEqual(['plan.pdf'])
    expect(state.recorded).toEqual([{ projectIds: [one.id], folderIds: [] }])
  })

  // Filenames are unique per collection, not per project: a restricted folder has
  // its own collection, so „GF intern/Protokoll.pdf" and a NEWER root „Protokoll.pdf"
  // coexist. The backend hit comes from the GF collection; a join on the name alone
  // handed it to the root row and labelled it with the open collection, which a
  // shared chat keeps and records nowhere.
  describe('a restricted passage and a newer same-named open document', () => {
    const GF_COLLECTION = 'proj_1_rabcdef012345'
    const newerOpenRow = () => ({
      id: 'protokoll-root',
      authoredBy: 'user',
      filename: 'protokoll.pdf',
      displayName: null,
      collectionName: 'proj_1',
      createdAt: new Date('2026-09-01T08:00:00Z'),
      tags: [],
    })

    function arrange() {
      const [one] = state.reachable
      state.folders.set(GF_COLLECTION, 'folder-gf')
      // The backend found the passage in the GF collection only.
      state.hits.set(one.id, [hit('protokoll', 0.9, { collectionName: GF_COLLECTION, snippet: 'Honorar GF intern' })])
      state.siblingRows.set(one.id, [newerOpenRow()])
      return one
    }

    it('keeps the passage out of a shared chat instead of passing it off as the open document', async () => {
      arrange()
      state.restrictedFolders = false

      const result = await searchAcrossProjects(caller(), search({}))

      expect(result.hits).toEqual([])
      // Nothing was handed out, so nothing names a project or a folder.
      expect(state.recorded.flatMap((handOut) => [...handOut.projectIds, ...handOut.folderIds])).toEqual([])
    })

    it('returns it from a solo chat as the restricted document, recorded with its folder', async () => {
      const one = arrange()

      const result = await searchAcrossProjects(caller(), search({}))

      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]).toMatchObject({ documentId: 'protokoll', collection: GF_COLLECTION, snippet: 'Honorar GF intern' })
      expect(result.hits[0].documentId).not.toBe('protokoll-root')
      expect(state.recorded).toEqual([{ projectIds: [one.id], folderIds: ['folder-gf'] }])
    })
  })

  describe('openFoldersOnly in a solo chat', () => {
    const FOLDER_COLLECTION = 'proj_1_rabcdef012345'

    function arrange() {
      const [one] = state.reachable
      state.folders.set(FOLDER_COLLECTION, 'folder-honorare')
      state.readable.set(one.id, ['folder-honorare'])
      state.hits.set(one.id, [hit('honorar', 0.9, { collectionName: FOLDER_COLLECTION }), hit('plan', 0.7)])
      return one
    }

    it('returns and records no restricted passage, and asks decisions and permits with no readable folder', async () => {
      const one = arrange()

      const result = await searchAcrossProjects(caller(), search({ openFoldersOnly: true }))

      expect(result.hits.map((found) => found.filename)).toEqual(['plan.pdf'])
      expect(state.decisionScopes.length).toBeGreaterThan(0)
      expect(state.decisionScopes.every((scope) => scope.readableFolderIds.length === 0)).toBe(true)
      expect(state.permitScopes).toEqual(state.decisionScopes)
      expect(state.recorded).toEqual([{ projectIds: [one.id], folderIds: [] }])
    })

    it('still gives the solo chat its restricted passages, decisions and permits without it', async () => {
      const one = arrange()

      const result = await searchAcrossProjects(caller(), search({}))

      expect(result.hits.map((found) => found.filename)).toEqual(['honorar.pdf', 'plan.pdf'])
      expect(state.decisionScopes.find((scope) => scope.projectId === one.id)?.readableFolderIds).toEqual(['folder-honorare'])
      expect(state.permitScopes).toEqual(state.decisionScopes)
      expect(state.recorded.map((handOut) => [...new Set(handOut.projectIds)])).toEqual([[one.id]])
      expect(state.recorded.flatMap((handOut) => handOut.folderIds)).toEqual(['folder-honorare'])
    })
  })

  it('returns nothing when the record refuses: the audience changed while the search ran', async () => {
    const { recordCrossProjectHandOut } = await import('@/lib/conversations/cross-project-use')
    vi.mocked(recordCrossProjectHandOut).mockRejectedValueOnce(new CrossProjectAudienceChangedError('geändert'))
    state.hits.set(state.reachable[0].id, [hit('a', 0.5)])

    await expect(searchAcrossProjects(caller(), search({}))).rejects.toBeInstanceOf(CrossProjectAudienceChangedError)
  })

  it('walks the projects most like the current one first by default', async () => {
    const facts = (bundesland: string, gk: number) => ({
      facts: {
        bundesland: { value: bundesland, confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: '' },
        gebaeudeklasse: { value: gk, confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: '' },
      },
      goals: {},
      unknowns: [],
      assumptions: {},
    })
    state.reachable = [
      project(1, { profile: facts('wien', 2) }),
      project(2, { profile: facts('niederoesterreich', 4) }),
      project(3, { profile: facts('niederoesterreich', 4) }),
    ]

    await searchAcrossProjects(caller(state.reachable[2].id), search({}))

    expect(state.searched.map((call) => call.projectId)).toEqual([state.reachable[1].id, state.reachable[0].id])
  })

  it('says each hit’s Bundesland, so the agent can tell a precedent decided under another Bauordnung', async () => {
    state.reachable = [
      project(1, {
        profile: {
          facts: { bundesland: { value: 'steiermark', confidence: 'confirmed', source: 'onboarding', updatedAt: '' } },
          goals: {},
          unknowns: [],
          assumptions: {},
        },
      }),
    ]
    state.hits.set(state.reachable[0].id, [hit('a', 0.5)])

    const result = await searchAcrossProjects(caller(), search({}))

    expect(result.hits[0].project.bundesland).toBe('steiermark')
  })

  it('says a project abroad as ausserhalb_oesterreichs, so the agent can label it outside Austria', async () => {
    state.reachable = [
      project(1, {
        profile: {
          facts: {
            bundesland: { value: 'ausserhalb_oesterreichs', confidence: 'confirmed', source: 'onboarding', updatedAt: '' },
          },
          goals: {},
          unknowns: [],
          assumptions: {},
        },
      }),
    ]
    state.hits.set(state.reachable[0].id, [hit('a', 0.5)])

    const result = await searchAcrossProjects(caller(), search({}))

    expect(result.hits[0].project.bundesland).toBe('ausserhalb_oesterreichs')
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

  it('searches only the closed projects in the closed scope', async () => {
    state.reachable = [project(1), project(2, { status: 'closed', closedAt: new Date(), closedBy: OWNER })]

    const result = await searchAcrossProjects(caller(), search({ scope: 'closed' }))

    expect(result).toMatchObject({ projectsInScope: 1 })
    expect(state.searched.map((call) => call.projectId)).toEqual([state.reachable[1].id])
  })

  it('narrows by the PROJECT’s period before searching, not by when a file was uploaded', async () => {
    // Projekt 1 began 2026-02-15, Projekt 2 2026-03-15, Projekt 3 2026-04-15; all still open.
    const result = await searchAcrossProjects(caller(), search({ to: '2026-03-31' }))

    expect(state.searched.map((call) => call.projectId)).toEqual([state.reachable[0].id, state.reachable[1].id])
    expect(result.projectsInScope).toBe(2)

    // The Steckbrief's Beginn and Abschluss win over the day the project was created in Piloti.
    state.reachable = [project(1, { startedOn: '2015-03-01', endedOn: '2017-06-01' }), project(2)]
    state.searched = []
    await searchAcrossProjects(caller(), search({ from: '2015-01-01', to: '2018-01-01' }))
    expect(state.searched.map((call) => call.projectId)).toEqual([state.reachable[0].id])
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

describe('the decisions other projects recorded', () => {
  const decision = (projectId: string, extra: Record<string, unknown> = {}) => ({
    projectId,
    kind: 'decision',
    content: 'Stiegenhaus in Stahlbeton, weil das Gutachten nur so die Abweichung zuließ.',
    confirmed: true,
    updatedAt: new Date('2022-05-01T08:00:00Z'),
    restrictedFolderIds: null,
    ...extra,
  })

  it('come first in the answer, named by their project, and are recorded with their project and folders', async () => {
    const [one, two] = state.reachable
    state.decisions = [decision(one.id), decision(two.id, { kind: 'constraint', restrictedFolderIds: ['folder-vertrag'] })]

    const result = await searchAcrossProjects(caller(), search({}))

    expect(result.decisions).toEqual([
      {
        project: { id: one.id, name: 'Projekt 1', status: 'active', bundesland: null },
        collection: 'proj_1',
        kind: 'decision',
        content: 'Stiegenhaus in Stahlbeton, weil das Gutachten nur so die Abweichung zuließ.',
        confirmed: true,
        recordedAt: '2022-05-01T08:00:00.000Z',
        restricted: false,
      },
      expect.objectContaining({ kind: 'constraint', restricted: true }),
    ])
    expect(state.recorded).toEqual([{ projectIds: [one.id, two.id], folderIds: ['folder-vertrag'] }])
  })

  it('come only from the page of projects searched, never from the conversation’s own', async () => {
    const [one, two, three] = state.reachable

    await searchAcrossProjects(caller(two.id), search({}))

    expect(state.decisionScopes.map((scope) => scope.projectId)).toEqual([one.id, three.id])
  })

  it('include restricted memory only in a solo chat, by the asker’s clearance in each project', async () => {
    const [one] = state.reachable
    state.readable.set(one.id, ['folder-vertrag'])

    await searchAcrossProjects(caller(), search({}))
    expect(state.decisionScopes.find((scope) => scope.projectId === one.id)?.readableFolderIds).toEqual(['folder-vertrag'])

    state.decisionScopes = []
    state.restrictedFolders = false
    await searchAcrossProjects(caller(), search({}))
    expect(state.decisionScopes.every((scope) => scope.readableFolderIds.length === 0)).toBe(true)
  })
})

describe('the permit records other projects went through', () => {
  const permit = (projectId: string, extra: Record<string, unknown> = {}) => ({
    projectId,
    collectionName: 'proj_1',
    fileName: 'Baubescheid_Baden_2020.pdf',
    kind: 'nachforderung',
    authority: 'Stadtgemeinde Baden',
    municipality: 'Baden',
    bundesland: 'niederoesterreich',
    issuedOn: '2020-03-12',
    reference: 'BA-123/2020',
    requirements: [
      { kind: 'nachforderung', content: 'Ein Brandschutzgutachten ist vorzulegen.', evidence: 'Gutachten', legalBasis: '§ 13 Abs. 3 AVG', page: 2 },
    ],
    restrictedFolderIds: null,
    ...extra,
  })

  it('are named by their project, shaped as the contract says, and recorded with their project and folders', async () => {
    const [one, two] = state.reachable
    state.permits = [permit(one.id), permit(two.id, { collectionName: 'proj_2__vertrag', restrictedFolderIds: ['folder-vertrag'] })]

    const result = await searchAcrossProjects(caller(), search({}))

    expect(result.permits).toEqual([
      {
        project: { id: one.id, name: 'Projekt 1', status: 'active', bundesland: null },
        collection: 'proj_1',
        fileName: 'Baubescheid_Baden_2020.pdf',
        kind: 'nachforderung',
        authority: 'Stadtgemeinde Baden',
        municipality: 'Baden',
        issuedOn: '2020-03-12',
        reference: 'BA-123/2020',
        requirements: [
          { kind: 'nachforderung', content: 'Ein Brandschutzgutachten ist vorzulegen.', evidence: 'Gutachten', legalBasis: '§ 13 Abs. 3 AVG', page: 2 },
        ],
        restricted: false,
      },
      expect.objectContaining({ collection: 'proj_2__vertrag', restricted: true }),
    ])
    expect(state.recorded).toEqual([{ projectIds: [one.id, two.id], folderIds: ['folder-vertrag'] }])
  })

  it('record a running project and a restricted folder even when nothing else was found', async () => {
    const [one] = state.reachable
    state.permits = [permit(one.id, { restrictedFolderIds: ['folder-a', 'folder-b'] })]

    await searchAcrossProjects(caller(), search({}))

    expect(state.recorded).toEqual([{ projectIds: [one.id], folderIds: ['folder-a', 'folder-b'] }])
    expect(state.recordedFor).toEqual(['audience-key'])
  })

  it('are searched over the decisions’ scopes: the page of projects searched, never the conversation’s own', async () => {
    const [one, two, three] = state.reachable
    state.readable.set(one.id, ['folder-vertrag'])

    await searchAcrossProjects(caller(two.id), search({}))

    expect(state.permitScopes).toEqual([
      { projectId: one.id, readableFolderIds: ['folder-vertrag'] },
      { projectId: three.id, readableFolderIds: [] },
    ])
    expect(state.permitScopes).toEqual(state.decisionScopes)
  })

  it('leave a restricted folder to a solo chat: a shared chat asks with no clearance', async () => {
    const [one] = state.reachable
    state.readable.set(one.id, ['folder-vertrag'])
    state.restrictedFolders = false

    await searchAcrossProjects(caller(), search({}))

    expect(state.permitScopes.length).toBeGreaterThan(0)
    expect(state.permitScopes.every((scope) => scope.readableFolderIds.length === 0)).toBe(true)
  })

  it('leave out a record of a project outside the page, as a decision of one is left out', async () => {
    state.permits = [permit(project(9).id)]

    const result = await searchAcrossProjects(caller(), search({}))

    expect(result.permits).toEqual([])
    expect(state.recorded).toEqual([{ projectIds: [], folderIds: [] }])
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
    expect(graz).toMatchObject({ total: 1 })
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
  it('reads the confirmed facts and the summary of a project in reach, and records it', async () => {
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
    expect(state.recorded).toEqual([{ projectIds: [state.reachable[0].id], folderIds: [] }])
  })

  it('is a not-found for a project out of reach, and records nothing', async () => {
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
