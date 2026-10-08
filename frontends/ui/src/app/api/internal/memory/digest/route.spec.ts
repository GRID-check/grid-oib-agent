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
  buildProjectMemoryDigest: vi.fn(),
  PROJECT_MEMORY_MAX_RESTRICTED_FOLDERS: 20,
  resolveProjectOrganization: vi.fn(),
}))

vi.mock('@/lib/documents/review-decisions', () => ({ buildReviewDecisionsBlock: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({
  ANY_MEMBER: { roles: [], seesEverything: false },
  clearanceOfMember: vi.fn(async () => ({ roles: ['org-gf'], seesEverything: false })),
  // Every member reads OPEN; the asker (org-gf) reads OPEN and SECRET.
  readableFolderIdsFor: vi.fn(async (_org: string, _project: string, clearance: { roles: string[] }) =>
    clearance.roles.includes('org-gf') ? ['folder-open', 'folder-secret'] : ['folder-open']
  ),
}))
vi.mock('@/lib/conversations/restricted-use', () => ({
  admitSourceFolders: vi.fn(async (_request: unknown, folderIds: string[]) => ({
    admitted: folderIds,
    refused: [],
    recorded: folderIds,
  })),
}))
vi.mock('@/lib/projects/proposal-decisions', () => ({
  buildProposalDecisionsBlock: vi.fn(async () => null),
  // The real function's shape, three blocks on one channel — kept in step with
  // `composeMemoryContext` rather than reimplemented differently, so a spec
  // asserting on the joined string is asserting the same join the route makes.
  composeMemoryContext: (digest: string | null, decisions: string | null, reviewDecisions: string | null = null) =>
    [digest, decisions, reviewDecisions].filter(Boolean).join('\n\n') || null,
}))

import { buildProjectMemoryDigest, resolveProjectOrganization } from '@/lib/projects/memory-service'
import { buildProposalDecisionsBlock } from '@/lib/projects/proposal-decisions'
import { buildReviewDecisionsBlock } from '@/lib/documents/review-decisions'
import { clearanceOfMember, readableFolderIdsFor } from '@/lib/authz/folder-access'
import { admitSourceFolders } from '@/lib/conversations/restricted-use'
import { GET } from './route'

const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const REAL_TOKEN = 'a-real-secret-token'
const PROJECT_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
const ORG_ID = 'org_123'

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
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
  })

  it('returns 403 for a wrong token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, 'nope'))
    expect(response.status).toBe(403)
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
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
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
  })

  it('returns the digest for a valid token (200)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue(
      'PROJECT_MEMORY v1\n- [decision | high | user_confirmed] "x"'
    )

    const response = await GET(
      makeRequest(`?projectId=${PROJECT_ID}&organizationId=${ORG_ID}`, REAL_TOKEN)
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.digest).toContain('PROJECT_MEMORY v1')
    expect(buildProjectMemoryDigest).toHaveBeenCalledWith(PROJECT_ID, ORG_ID, {
      query: undefined,
      readableFolderIds: expect.any(Array),
      admitRestricted: expect.any(Function),
    })
  })

  it('returns digest:null (200) when there is no active memory', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue(null)

    const response = await GET(makeRequest(`?organizationId=${ORG_ID}`, REAL_TOKEN))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.digest).toBeNull()
    expect(buildProjectMemoryDigest).toHaveBeenCalledWith(undefined, ORG_ID, {
      query: undefined,
      readableFolderIds: expect.any(Array),
      admitRestricted: expect.any(Function),
    })
  })

  it('returns 500 when the digest builder throws', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(resolveProjectOrganization).mockResolvedValue(ORG_ID)
    vi.mocked(buildProjectMemoryDigest).mockRejectedValue(new Error('db down'))

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
      vi.mocked(buildProjectMemoryDigest).mockResolvedValue('PROJECT_MEMORY v1')

      const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))

      expect(response.status).toBe(200)
      expect(resolveProjectOrganization).toHaveBeenCalledWith(PROJECT_ID)
      // The organization the PROJECT names — never undefined, which is what
      // made the read unscoped.
      expect(buildProjectMemoryDigest).toHaveBeenCalledWith(PROJECT_ID, ORG_ID, {
      query: undefined,
      readableFolderIds: expect.any(Array),
      admitRestricted: expect.any(Function),
    })
    })

    it('reads nothing at all when the project does not exist', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
      vi.mocked(resolveProjectOrganization).mockResolvedValue(null)

      const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ digest: null })
      expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
    })

    it('does not consult the project row when the caller already named the tenant', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
      vi.mocked(buildProjectMemoryDigest).mockResolvedValue(null)

      await GET(makeRequest(`?projectId=${PROJECT_ID}&organizationId=${ORG_ID}`, REAL_TOKEN))

      expect(resolveProjectOrganization).not.toHaveBeenCalled()
    })
  })
})

describe('the decisions the project made about earlier proposals', () => {
  it('ride the digest, after the memory', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(resolveProjectOrganization).mockResolvedValue(ORG_ID)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue('PROJECT_MEMORY v1\n- [decision | high | user_confirmed] "x"')
    vi.mocked(buildProposalDecisionsBlock).mockResolvedValueOnce('PROPOSAL_DECISIONS v1\n- [abgelehnt | Profil | 2026-09-01] "y"')

    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      digest: 'PROJECT_MEMORY v1\n- [decision | high | user_confirmed] "x"\n\nPROPOSAL_DECISIONS v1\n- [abgelehnt | Profil | 2026-09-01] "y"',
      restrictedFoldersServed: [],
    })
    expect(buildProposalDecisionsBlock).toHaveBeenCalledWith(PROJECT_ID, ORG_ID)
  })
})

describe('what a person decided about the drafts this conversation filed', () => {
  it('rides the same digest, scoped to the conversation the caller names', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(resolveProjectOrganization).mockResolvedValue(ORG_ID)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue(null)
    vi.mocked(buildProposalDecisionsBlock).mockResolvedValue(null)
    vi.mocked(buildReviewDecisionsBlock).mockResolvedValue(
      'REVIEW_DECISIONS v1\n- [Änderungen angefordert | Befund | v2] "Die Länge stimmt nicht"',
    )

    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}&conversationId=s_conv_1`, REAL_TOKEN))

    expect(await response.json()).toEqual({
      digest: 'REVIEW_DECISIONS v1\n- [Änderungen angefordert | Befund | v2] "Die Länge stimmt nicht"',
      restrictedFoldersServed: [],
    })
    expect(buildReviewDecisionsBlock).toHaveBeenCalledWith('s_conv_1', ORG_ID)
  })

  it('is not asked for at all when the caller has no conversation', async () => {
    // The WS handshake and a background run: the digest and the proposal
    // decisions are exactly what they were before this block existed.
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(resolveProjectOrganization).mockResolvedValue(ORG_ID)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue(null)
    vi.mocked(buildProposalDecisionsBlock).mockResolvedValue(null)

    await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))
    expect(buildReviewDecisionsBlock).not.toHaveBeenCalled()
  })

  it('costs the turn nothing when the scan breaks', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(resolveProjectOrganization).mockResolvedValue(ORG_ID)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue('PROJECT_MEMORY v1\n- x')
    vi.mocked(buildProposalDecisionsBlock).mockResolvedValue(null)
    vi.mocked(buildReviewDecisionsBlock).mockRejectedValue(new Error('db down'))

    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}&conversationId=s_conv_1`, REAL_TOKEN))
    expect(await response.json()).toEqual({ digest: 'PROJECT_MEMORY v1\n- x', restrictedFoldersServed: [] })
  })
})

/**
 * ADR-0087, ADR-0088: restricted memory names its source folders and is judged
 * at read time. An interactive chat turn (one that sends the restricted
 * collections it may draw on) is served the notes whose folders its ASKER may
 * read now, each admitted for the conversation before it is printed; any other
 * caller only the notes whose folders every member may read now.
 */
describe('restricted memory in the per-turn digest', () => {
  const DRAWABLE = 'proj_x_raaaaaaaaaaaa'
  const ANSWER_ID = '0b7c6d2e-5f1a-5c3b-9d4e-8f7a6b5c4d3e'
  const options = () => vi.mocked(buildProjectMemoryDigest).mock.calls[0][2] ?? {}

  it("serves an interactive turn the notes its asker may read, admitting each note's folders for the conversation", async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigest).mockImplementation(async (_project, _org, opts) => {
      const admitted = await opts?.admitRestricted?.(['folder-secret'])
      return admitted?.has('folder-secret') ? 'PROJECT_MEMORY v1\n- [restricted | decision] "Honorar"' : null
    })

    const response = await GET(
      makeRequest(
        `?projectId=${PROJECT_ID}&organizationId=${ORG_ID}&conversationId=s_conv_1&userId=user_gf&restrictedCollections=${DRAWABLE}&answerMessageId=${ANSWER_ID}`,
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(200)
    expect(clearanceOfMember).toHaveBeenCalledWith(ORG_ID, 'user_gf', PROJECT_ID)
    expect(options().readableFolderIds).toEqual(['folder-open', 'folder-secret'])
    // The answer the turn writes is marked in the admission's transaction (ADR-0092).
    expect(admitSourceFolders).toHaveBeenCalledWith(
      {
        organizationId: ORG_ID,
        conversationId: 's_conv_1',
        userId: 'user_gf',
        projectId: PROJECT_ID,
        answerMessageId: ANSWER_ID,
      },
      ['folder-secret']
    )
    // The agent counts the served folders as this turn's use.
    expect(await response.json()).toMatchObject({ restrictedFoldersServed: ['folder-secret'] })
  })

  it('serves a turn without restricted scope only notes every member may read now, and records nothing', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    let admitted: ReadonlySet<string> | undefined
    vi.mocked(buildProjectMemoryDigest).mockImplementation(async (_project, _org, opts) => {
      admitted = await opts?.admitRestricted?.(['folder-open', 'folder-secret'])
      return null
    })

    const response = await GET(
      makeRequest(`?projectId=${PROJECT_ID}&organizationId=${ORG_ID}&conversationId=s_conv_1&userId=user_gf`, REAL_TOKEN)
    )

    expect(options().readableFolderIds).toEqual(['folder-open'])
    expect([...(admitted ?? [])]).toEqual(['folder-open'])
    expect(admitSourceFolders).not.toHaveBeenCalled()
    expect(clearanceOfMember).not.toHaveBeenCalled()
    expect(await response.json()).toMatchObject({ restrictedFoldersServed: [] })
  })

  it('serves nothing restricted to an organization-only digest', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue(null)

    await GET(makeRequest(`?organizationId=${ORG_ID}&restrictedCollections=${DRAWABLE}`, REAL_TOKEN))

    expect(readableFolderIdsFor).not.toHaveBeenCalled()
    expect(options().readableFolderIds).toEqual([])
  })
})
