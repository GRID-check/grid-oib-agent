/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/projects/memory-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects/memory-service')>()
  return {
    ...actual,
    searchProjectMemory: vi.fn(async () => ({ items: [], total: 0, returned: 0 })),
  }
})

import { searchProjectMemory } from '@/lib/projects/memory-service'
import { GET } from './route'

const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const REAL_TOKEN = 'a-real-secret-token'
const PROJECT_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
const ORG_ID = 'org_123'

const makeRequest = (query: string, token?: string) =>
  new Request(`https://grid.test/api/internal/memory/search${query}`, {
    method: 'GET',
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

beforeEach(() => {
  vi.mocked(searchProjectMemory).mockResolvedValue({ items: [], total: 0, returned: 0 })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('GET /api/internal/memory/search', () => {
  it('is token-guarded exactly like the digest route beside it', async () => {
    // No token configured at all → 503, not a served result.
    expect((await GET(makeRequest(`?organizationId=${ORG_ID}&q=dach`, REAL_TOKEN))).status).toBe(503)

    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    expect((await GET(makeRequest(`?organizationId=${ORG_ID}&q=dach`, 'nope'))).status).toBe(403)
    expect((await GET(makeRequest(`?organizationId=${ORG_ID}&q=dach`))).status).toBe(403)

    vi.stubEnv('GRID_INTERNAL_API_TOKEN', DEV_DEFAULT_TOKEN)
    vi.stubEnv('NODE_ENV', 'production')
    expect(
      (await GET(makeRequest(`?organizationId=${ORG_ID}&q=dach`, DEV_DEFAULT_TOKEN))).status
    ).toBe(503)

    expect(searchProjectMemory).not.toHaveBeenCalled()
  })

  it('refuses an empty question with a 400 rather than reading everything', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    expect((await GET(makeRequest(`?organizationId=${ORG_ID}&q=`, REAL_TOKEN))).status).toBe(400)
    expect((await GET(makeRequest(`?organizationId=${ORG_ID}&q=%20%20`, REAL_TOKEN))).status).toBe(
      400
    )
    expect((await GET(makeRequest(`?organizationId=${ORG_ID}`, REAL_TOKEN))).status).toBe(400)
    expect(searchProjectMemory).not.toHaveBeenCalled()
  })

  it('refuses a request with no organization — it has no tenant to enter', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    expect((await GET(makeRequest('?q=dach', REAL_TOKEN))).status).toBe(400)
    expect(searchProjectMemory).not.toHaveBeenCalled()
  })

  it('answers with the search result shape the tool declares', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(searchProjectMemory).mockResolvedValue({
      items: [
        {
          id: 'note-1',
          kind: 'constraint',
          content: 'Flachdach ist nicht zulässig',
          confidence: 'high',
          verification: 'user_confirmed',
          pinned: true,
          scope: 'project',
          updatedAt: '2026-09-01T00:00:00.000Z',
          score: 4.2,
        },
      ],
      total: 137,
      returned: 1,
    })

    const response = await GET(
      makeRequest(`?organizationId=${ORG_ID}&projectId=${PROJECT_ID}&q=dach`, REAL_TOKEN)
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      items: [
        {
          id: 'note-1',
          kind: 'constraint',
          content: 'Flachdach ist nicht zulässig',
          confidence: 'high',
          verification: 'user_confirmed',
          pinned: true,
          scope: 'project',
          updatedAt: '2026-09-01T00:00:00.000Z',
          score: 4.2,
        },
      ],
      total: 137,
      returned: 1,
    })
  })

  it('defaults the page to 8 and clamps it to 20', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    await GET(makeRequest(`?organizationId=${ORG_ID}&q=dach`, REAL_TOKEN))
    expect(searchProjectMemory).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 8 }))

    await GET(makeRequest(`?organizationId=${ORG_ID}&q=dach&limit=99`, REAL_TOKEN))
    expect(searchProjectMemory).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20 }))

    await GET(makeRequest(`?organizationId=${ORG_ID}&q=dach&limit=0`, REAL_TOKEN))
    expect(searchProjectMemory).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }))

    await GET(makeRequest(`?organizationId=${ORG_ID}&q=dach&limit=3`, REAL_TOKEN))
    expect(searchProjectMemory).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 3 }))
  })

  /**
   * The rule ADR-0055 calls non-negotiable. The condition itself is asserted in
   * `lib/projects/memory-repository.spec.ts`; these cases assert that the route
   * hands the service exactly the scope the caller named and never invents one.
   */
  describe('the scope rule', () => {
    it('passes a project turn its project AND its organization', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

      await GET(
        makeRequest(`?organizationId=${ORG_ID}&projectId=${PROJECT_ID}&q=dach`, REAL_TOKEN)
      )

      expect(searchProjectMemory).toHaveBeenCalledWith({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        query: 'dach',
        limit: 8,
      })
    })

    it('passes a project-less turn NO project, so it reads organization notes only', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

      await GET(makeRequest(`?organizationId=${ORG_ID}&q=dach`, REAL_TOKEN))

      expect(searchProjectMemory).toHaveBeenCalledWith({
        organizationId: ORG_ID,
        projectId: undefined,
        query: 'dach',
        limit: 8,
      })
    })

    it('treats an empty projectId as absent rather than as a project', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

      await GET(makeRequest(`?organizationId=${ORG_ID}&projectId=&q=dach`, REAL_TOKEN))

      expect(searchProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: undefined })
      )
    })
  })

  it('answers an unknown organization with an empty result, not an error', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    // Nothing is special-cased: an organization nothing has written notes for
    // falls out of the scope condition as no rows, which is the same answer as
    // an organization with no notes.
    vi.mocked(searchProjectMemory).mockResolvedValue({ items: [], total: 0, returned: 0 })

    const response = await GET(makeRequest('?organizationId=org_never_heard_of&q=dach', REAL_TOKEN))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ items: [], total: 0, returned: 0 })
  })

  it('returns 500 when the search itself fails — a broken read is not an empty shelf', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(searchProjectMemory).mockRejectedValue(new Error('db down'))

    const response = await GET(makeRequest(`?organizationId=${ORG_ID}&q=dach`, REAL_TOKEN))

    expect(response.status).toBe(500)
  })
})
