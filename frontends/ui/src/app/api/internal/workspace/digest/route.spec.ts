/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/projects/memory-service', () => ({
  buildProjectMemoryDigest: vi.fn(async () => null),
  organizationExists: vi.fn(async () => true),
}))

vi.mock('@/lib/workspace/register-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/register-service')>()
  return { ...actual, recallSteckbriefe: vi.fn(async () => []) }
})

import { buildProjectMemoryDigest, organizationExists } from '@/lib/projects/memory-service'
import { recallSteckbriefe } from '@/lib/workspace/register-service'
import { GET } from './route'

const REAL_TOKEN = 'a-real-secret-token'
const ORG_ID = 'org_123'
const MEMBERSHIP_ID = 'om_01HQ9'

const makeRequest = (query: string, token?: string) =>
  new Request(`https://grid.test/api/internal/workspace/digest${query}`, {
    method: 'GET',
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

beforeEach(() => {
  // `clearAllMocks` forgets calls, not implementations, so every case restates
  // the baseline it wants rather than inheriting the previous one's.
  vi.mocked(organizationExists).mockResolvedValue(true)
  vi.mocked(buildProjectMemoryDigest).mockResolvedValue(null)
  vi.mocked(recallSteckbriefe).mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('GET /api/internal/workspace/digest', () => {
  it('is token-guarded exactly like the memory digest it mirrors', async () => {
    // No token configured at all → 503, not a served digest.
    expect((await GET(makeRequest(`?organizationId=${ORG_ID}`, REAL_TOKEN))).status).toBe(503)

    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    expect((await GET(makeRequest(`?organizationId=${ORG_ID}`, 'nope'))).status).toBe(403)
    expect((await GET(makeRequest(`?organizationId=${ORG_ID}`))).status).toBe(403)
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
  })

  it('returns 400 without an organizationId — it has no tenant to enter', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    expect((await GET(makeRequest('', REAL_TOKEN))).status).toBe(400)
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
  })

  it('serves the organization digest and the ranked Steckbriefe in one round trip', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue('PROJECT_MEMORY v1\n- [x] "y"')
    vi.mocked(recallSteckbriefe).mockResolvedValue([
      { id: 'p1', name: 'Seestadt', steckbrief: 'PROJECT_STECKBRIEF v1', score: 0.9 },
    ])

    const response = await GET(
      makeRequest(
        `?organizationId=${ORG_ID}&membershipId=${MEMBERSHIP_ID}&q=Holzbau%20GK5&limit=3`,
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      digest: 'PROJECT_MEMORY v1\n- [x] "y"',
      projects: [{ id: 'p1', name: 'Seestadt', steckbrief: 'PROJECT_STECKBRIEF v1', score: 0.9 }],
    })
    // `undefined` for the project id is what makes this the ORGANIZATION
    // digest — the same call the memory digest route makes for a project-less
    // caller.
    expect(buildProjectMemoryDigest).toHaveBeenCalledWith(undefined, ORG_ID, {
      query: 'Holzbau GK5',
    })
    expect(recallSteckbriefe).toHaveBeenCalledWith(
      { organizationId: ORG_ID, organizationMembershipId: MEMBERSHIP_ID },
      'Holzbau GK5',
      3
    )
  })

  it('serves the digest with NO projects when the caller has no membership', async () => {
    // Readability is keyed on the membership, so an unattributable caller must
    // not be shown a project list (spec PR-16) — and must still get its
    // memory, because the office half needs no membership at all.
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue('PROJECT_MEMORY v1')

    const response = await GET(makeRequest(`?organizationId=${ORG_ID}`, REAL_TOKEN))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ digest: 'PROJECT_MEMORY v1', projects: [] })
    expect(recallSteckbriefe).toHaveBeenCalledWith(
      { organizationId: ORG_ID, organizationMembershipId: null },
      null,
      5
    )
  })

  it('answers an unknown organization with the empty shape, not a 404', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(organizationExists).mockResolvedValue(false)

    const response = await GET(makeRequest('?organizationId=org_nope', REAL_TOKEN))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ digest: null, projects: [] })
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
    expect(recallSteckbriefe).not.toHaveBeenCalled()
  })

  it('clamps the limit to the recall ceiling', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    await GET(makeRequest(`?organizationId=${ORG_ID}&limit=99`, REAL_TOKEN))
    expect(recallSteckbriefe).toHaveBeenCalledWith(expect.anything(), null, 10)
  })

  it('degrades to an empty register rather than failing the turn', async () => {
    // Spec PR-11, near side: a slow or broken register costs the answer its
    // "Passende Projekte" block, never the turn its memory.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue('PROJECT_MEMORY v1')
    vi.mocked(recallSteckbriefe).mockRejectedValue(new Error('register down'))

    const response = await GET(
      makeRequest(`?organizationId=${ORG_ID}&membershipId=${MEMBERSHIP_ID}`, REAL_TOKEN)
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ digest: 'PROJECT_MEMORY v1', projects: [] })
  })
})
