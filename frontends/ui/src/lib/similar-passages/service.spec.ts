/**
 * @vitest-environment node
 *
 * „Im Büro behandelt" with the stores and the backend mocked: what one search
 * may name (the backend's collection cap, the reader's own project first).
 * Who may see what is proven against a real Postgres in
 * `service.integration.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Project } from '@/lib/db/schema'
import { makeProject } from '@/test-utils/db-fixtures'

vi.mock('server-only', () => ({}))

const state = vi.hoisted(() => ({
  reach: [] as Project[],
  /** Per project id, the restricted collections the reader is cleared for. */
  cleared: new Map<string, string[]>(),
  /** What the backend was asked, per call. */
  asked: [] as string[][],
}))

vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('@/lib/request-context', () => ({ buildGridRequestContextWireHeaders: () => ({}) }))
vi.mock('@/lib/documents/access', () => ({
  getAccessibleDocument: vi.fn(async (_session: unknown, id: string) => ({
    id,
    collectionName: 'proj_1',
    filename: 'quelle.pdf',
    projectId: 'p1',
    status: 'completed',
    screeningOutcome: 'clean',
  })),
}))
vi.mock('@/lib/projects/service', () => ({ listChatProjects: vi.fn(async () => state.reach) }))
vi.mock('@/lib/archiv/repository', () => ({ findArchivDocumentsByFilenames: vi.fn(async () => []) }))
vi.mock('@/lib/documents/shelf-listing', () => ({ toListedDocuments: vi.fn(async () => []) }))
vi.mock('@/lib/documents/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents/service')>()
  return {
    BACKEND_SEARCH_MAX_COLLECTIONS: actual.BACKEND_SEARCH_MAX_COLLECTIONS,
    projectsWithinCollectionCap: actual.projectsWithinCollectionCap,
    joinHitsToFiles: actual.joinHitsToFiles,
    planProjectSearch: vi.fn(async (_session: unknown, projectId: string) => {
      const project = state.reach.find((one) => one.id === projectId)
      if (!project) throw new Error('not found')
      return {
        project,
        access: { hiddenFolderIds: new Set() },
        collections: [project.collectionName, ...(state.cleared.get(projectId) ?? [])],
      }
    }),
    hydrateProjectHits: vi.fn(async () => []),
  }
})

import { ServiceUnavailableError } from '@/lib/api/errors'
import { findArchivDocumentsByFilenames } from '@/lib/archiv/repository'
import { BACKEND_SEARCH_MAX_COLLECTIONS, hydrateProjectHits } from '@/lib/documents/service'
import { findSimilarPassages, foldDocuments } from './service'

const session = { userId: 'u1', organizationId: 'org_1', role: 'member', permissions: [] } as unknown as AuthorizedSession
const request = {
  document: { kind: 'stored' as const, documentId: 'd-source' },
  passage: { text: 'Brandabschnitt im Dachgeschoss', cited: true },
}
const restricted = (project: Project, count: number) =>
  Array.from({ length: count }, (_, n) => `${project.collectionName}_r${String(n).padStart(12, '0')}`)

beforeEach(() => {
  vi.clearAllMocks()
  state.reach = Array.from({ length: 30 }, (_, index) =>
    makeProject({ id: `p${index + 1}`, collectionName: `proj_${index + 1}`, name: `Projekt ${index + 1}` })
  )
  state.cleared = new Map()
  state.asked = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      state.asked.push((JSON.parse(String(init.body)) as { collections: string[] }).collections)
      return new Response(JSON.stringify({ documents: [], origin: 'point' }), { status: 200 })
    })
  )
})

describe('the backend’s collection cap', () => {
  it('stops adding projects before the collections pass it, the reader’s own project and the Büroablage kept', async () => {
    // 30 projects of 40 collections each would be 1 200 collections.
    for (const project of state.reach) state.cleared.set(project.id, restricted(project, 39))

    const response = await findSimilarPassages(session, request)

    const [collections] = state.asked
    expect(BACKEND_SEARCH_MAX_COLLECTIONS).toBe(500)
    expect(collections.length).toBeLessThanOrEqual(BACKEND_SEARCH_MAX_COLLECTIONS)
    expect(collections.slice(0, 40)).toEqual(['proj_1', ...restricted(state.reach[0], 39)])
    expect(collections).toContain('archiv_org_1')
    // The reader's own and eleven others fit (12 × 40 = 480, plus the Büroablage); the thirteenth would pass.
    expect(response.projectsSearched).toBe(11)
  })

  it('cuts the reader’s own project to the cap when it alone passes it, and still asks the Büroablage', async () => {
    state.cleared.set('p1', restricted(state.reach[0], BACKEND_SEARCH_MAX_COLLECTIONS + 5))

    const response = await findSimilarPassages(session, request)

    const [collections] = state.asked
    expect(collections).toHaveLength(BACKEND_SEARCH_MAX_COLLECTIONS)
    expect(collections[0]).toBe('proj_1')
    expect(collections).toContain('archiv_org_1')
    expect(response.projectsSearched).toBe(0)
  })
})

describe('a failed join to the documents', () => {
  const answering = (collection: string, fileName: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              documents: [{ collection, file_name: fileName, passages: [{ chunk_id: 'c1', snippet: 'Treppe', page_number: 1, score: 0.9 }] }],
              origin: 'point',
            }),
            { status: 200 }
          )
      )
    )

  it('is the error state for a project’s hits, never "not dealt with in the office"', async () => {
    answering('proj_2', 'treppe.pdf')
    vi.mocked(hydrateProjectHits).mockRejectedValueOnce(new Error('connection terminated'))

    await expect(findSimilarPassages(session, request)).rejects.toBeInstanceOf(ServiceUnavailableError)
  })

  it('is the error state for the Büroablage’s hits too', async () => {
    answering('archiv_org_1', 'musterdetail.pdf')
    vi.mocked(findArchivDocumentsByFilenames).mockRejectedValueOnce(new Error('connection terminated'))

    await expect(findSimilarPassages(session, request)).rejects.toBeInstanceOf(ServiceUnavailableError)
  })
})

describe('foldDocuments', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) =>
    ({
      id,
      filename: `${id}.pdf`,
      displayName: null,
      contentType: 'application/pdf',
      revisionFacts: null,
      fassung: null,
      page: 2,
      snippet: `Auszug aus ${id}`,
      score: 0.8,
      rank: 0,
      ...extra,
    }) as unknown as Parameters<typeof foldDocuments>[0][number]

  it('leaves out a Fassung a person confirmed a newer one replaces, as knowledge_search does: the vector copy can lag', () => {
    const folded = foldDocuments(
      [row('aktuell'), row('alt', { fassung: { supersededBy: { id: 'aktuell', filename: 'aktuell.pdf' } } })],
      null
    )

    expect(folded.map((entry) => entry.document.documentId)).toEqual(['aktuell'])
  })
})
