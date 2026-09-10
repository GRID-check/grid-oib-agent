/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/projects/memory-service', () => ({
  buildProjectMemoryDigestReport: vi.fn(),
  resolveProjectOrganization: vi.fn(),
}))

vi.mock('@/lib/projects/proposal-decisions', () => ({
  buildProposalDecisionsBlock: vi.fn(async () => null),
  composeMemoryContext: (digest: string | null, decisions: string | null) =>
    [digest, decisions].filter(Boolean).join('\n\n') || null,
}))

import {
  buildProjectMemoryDigestReport,
  resolveProjectOrganization,
} from '@/lib/projects/memory-service'
import { buildProposalDecisionsBlock } from '@/lib/projects/proposal-decisions'
import { GET } from './route'

const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const REAL_TOKEN = 'a-real-secret-token'
const PROJECT_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
const ORG_ID = 'org_123'

/** A digest report whose `carried`/`omitted`/`total` are consistent by default. */
const report = (
  text: string,
  overrides: Partial<{
    carried: { id: string; kind: 'decision'; content: string }[]
    omitted: number
    total: number
  }> = {}
) => {
  const carried = overrides.carried ?? [{ id: 'note-1', kind: 'decision' as const, content: 'x' }]
  const omitted = overrides.omitted ?? 0
  return { text, carried, omitted, total: overrides.total ?? carried.length + omitted }
}

const makeRequest = (query: string, token?: string) =>
  new Request(`https://grid.test/api/internal/memory/digest${query}`, {
    method: 'GET',
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('GET /api/internal/memory/digest', () => {
  it('returns 503 when the internal token is not configured', async () => {
    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))
    expect(response.status).toBe(503)
    expect(buildProjectMemoryDigestReport).not.toHaveBeenCalled()
  })

  it('returns 403 for a wrong token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, 'nope'))
    expect(response.status).toBe(403)
    expect(buildProjectMemoryDigestReport).not.toHaveBeenCalled()
  })

  it('returns 403 when the token header is missing', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`))
    expect(response.status).toBe(403)
  })

  it('refuses the well-known dev default token outside dev environments (503)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', DEV_DEFAULT_TOKEN)
    vi.stubEnv('NODE_ENV', 'production')
    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, DEV_DEFAULT_TOKEN))
    expect(response.status).toBe(503)
  })

  it('returns 400 when neither projectId nor organizationId is provided', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const response = await GET(makeRequest('', REAL_TOKEN))
    expect(response.status).toBe(400)
    expect(buildProjectMemoryDigestReport).not.toHaveBeenCalled()
  })

  it('returns the digest for a valid token (200)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigestReport).mockResolvedValue(
      report('PROJECT_MEMORY v1\n- [decision | high | user_confirmed] "x"')
    )

    const response = await GET(
      makeRequest(`?projectId=${PROJECT_ID}&organizationId=${ORG_ID}`, REAL_TOKEN)
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.digest).toContain('PROJECT_MEMORY v1')
    expect(buildProjectMemoryDigestReport).toHaveBeenCalledWith(PROJECT_ID, ORG_ID, {
      query: undefined,
    })
  })

  it('returns digest:null (200) when there is no active memory', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigestReport).mockResolvedValue(null)

    const response = await GET(makeRequest(`?organizationId=${ORG_ID}`, REAL_TOKEN))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.digest).toBeNull()
    expect(buildProjectMemoryDigestReport).toHaveBeenCalledWith(undefined, ORG_ID, {
      query: undefined,
    })
  })

  it('returns 500 when the digest builder throws', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(resolveProjectOrganization).mockResolvedValue(ORG_ID)
    vi.mocked(buildProjectMemoryDigestReport).mockRejectedValue(new Error('db down'))

    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))
    expect(response.status).toBe(500)
  })

  /**
   * A project-only request used to read under platform scope — RLS bypassed —
   * with the query filtered by project id alone, so ANY project id returned
   * that project's memory to any holder of the internal token. The tenant is
   * now resolved from the project row and the read happens inside it.
   */
  describe('a request that names only a project', () => {
    it('resolves the tenant from the project row and reads the digest inside it', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
      vi.mocked(resolveProjectOrganization).mockResolvedValue(ORG_ID)
      vi.mocked(buildProjectMemoryDigestReport).mockResolvedValue(report('PROJECT_MEMORY v1'))

      const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))

      expect(response.status).toBe(200)
      expect(resolveProjectOrganization).toHaveBeenCalledWith(PROJECT_ID)
      // The organization the PROJECT names — never undefined, which is what
      // made the read unscoped.
      expect(buildProjectMemoryDigestReport).toHaveBeenCalledWith(PROJECT_ID, ORG_ID, {
      query: undefined,
    })
    })

    it('reads nothing at all when the project does not exist', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
      vi.mocked(resolveProjectOrganization).mockResolvedValue(null)

      const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        digest: null,
        carried: [],
        omitted: 0,
        total: 0,
      })
      expect(buildProjectMemoryDigestReport).not.toHaveBeenCalled()
    })

    it('does not consult the project row when the caller already named the tenant', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
      vi.mocked(buildProjectMemoryDigestReport).mockResolvedValue(null)

      await GET(makeRequest(`?projectId=${PROJECT_ID}&organizationId=${ORG_ID}`, REAL_TOKEN))

      expect(resolveProjectOrganization).not.toHaveBeenCalled()
    })
  })
})

/**
 * ADR-0055 C2. The digest STRING does not change — the backend and the WS
 * handshake keep reading exactly what they read before — and beside it the
 * response now names what went into it.
 */
describe('what the digest carried', () => {
  it('forwards the report the builder produced, without a second query', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigestReport).mockResolvedValue(
      report('PROJECT_MEMORY v1\n- [decision | high | user_confirmed] "Flachdach"', {
        carried: [{ id: 'note-1', kind: 'decision', content: 'Flachdach' }],
        omitted: 136,
        total: 137,
      })
    )

    const response = await GET(
      makeRequest(`?projectId=${PROJECT_ID}&organizationId=${ORG_ID}&query=dach`, REAL_TOKEN)
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      digest: 'PROJECT_MEMORY v1\n- [decision | high | user_confirmed] "Flachdach"',
      carried: [{ id: 'note-1', kind: 'decision', content: 'Flachdach' }],
      omitted: 136,
      total: 137,
    })
    // ONE call. `carried` is the builder's own render, not a second read that
    // could disagree with the text that was sent.
    expect(buildProjectMemoryDigestReport).toHaveBeenCalledTimes(1)
  })

  it('answers an empty store with an empty report rather than a missing one', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigestReport).mockResolvedValue(null)

    const response = await GET(makeRequest(`?organizationId=${ORG_ID}`, REAL_TOKEN))

    expect(await response.json()).toEqual({ digest: null, carried: [], omitted: 0, total: 0 })
  })
})

describe('the decisions the project made about earlier proposals', () => {
  it('ride the digest, after the memory', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(resolveProjectOrganization).mockResolvedValue(ORG_ID)
    vi.mocked(buildProjectMemoryDigestReport).mockResolvedValue(
      report('PROJECT_MEMORY v1\n- [decision | high | user_confirmed] "x"')
    )
    vi.mocked(buildProposalDecisionsBlock).mockResolvedValueOnce('PROPOSAL_DECISIONS v1\n- [abgelehnt | Profil | 2026-09-01] "y"')

    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      digest: 'PROJECT_MEMORY v1\n- [decision | high | user_confirmed] "x"\n\nPROPOSAL_DECISIONS v1\n- [abgelehnt | Profil | 2026-09-01] "y"',
    })
    expect(buildProposalDecisionsBlock).toHaveBeenCalledWith(PROJECT_ID, ORG_ID)
  })
})
