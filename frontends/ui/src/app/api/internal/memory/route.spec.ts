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
  createProjectMemoryItem: vi.fn(),
  createProjectMemoryItemForProject: vi.fn(),
  organizationExists: vi.fn(),
}))

// The audit record itself is `memory-judge-audit.spec.ts`'s subject; here, the
// route hands it over. The schema stays real: the route parses with it.
vi.mock('@/lib/projects/memory-judge-audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects/memory-judge-audit')>()),
  recordMemoryJudgeVerdict: vi.fn().mockResolvedValue(undefined),
  recordRefusedMemoryJudgeVerdict: vi.fn().mockResolvedValue(undefined),
}))

// The cross-project record (ADR-0093): which conversations drew on another project.
const crossProject = vi.hoisted(() => ({ recorded: new Map<string, string[]>() }))
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }))
vi.mock('@/lib/conversations/restricted-use-repository', () => ({
  listRestrictingSourceProjects: vi.fn(async (_db: unknown, _org: string, id: string) => crossProject.recorded.get(id) ?? []),
}))
// No restricted folder of another project recorded: the folder rule is cross-project-use.spec's.
vi.mock('@/lib/conversations/restricted-use', () => ({
  recordedForeignRestrictedFolders: vi.fn(async () => new Map()),
}))
vi.mock('@/lib/projects/repository', () => ({
  findProjectTenancy: vi.fn(async () => ({ organizationId: 'org_1', deletedAt: null })),
}))

import {
  createProjectMemoryItem,
  createProjectMemoryItemForProject,
  organizationExists,
} from '@/lib/projects/memory-service'
import { recordMemoryJudgeVerdict, recordRefusedMemoryJudgeVerdict } from '@/lib/projects/memory-judge-audit'
import { POST } from './route'
import { makeMemoryItem } from '@/test-utils/db-fixtures'

const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const REAL_TOKEN = 'a-real-secret-token'
const PROJECT_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'

const makeRequest = (body: unknown, token?: string) =>
  new Request('https://grid.test/api/internal/memory', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  })

const validProjectPayload = {
  scope: 'project',
  projectId: PROJECT_ID,
  kind: 'derived_fact',
  content: 'The roof load is 2 kN/m2.',
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  crossProject.recorded.clear()
})

describe('POST /api/internal/memory — a conversation that drew on another project (ADR-0093)', () => {
  it('refuses with a typed 409 before anything is written, for project and organization scope', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.stubEnv('GRID_ALLOW_AGENT_ORG_MEMORY', 'true')
    crossProject.recorded.set('s_cross', ['project_other'])
    vi.mocked(organizationExists).mockResolvedValue(true)

    const project = await POST(makeRequest({ ...validProjectPayload, sourceConversationId: 's_cross' }, REAL_TOKEN))
    const organization = await POST(
      makeRequest(
        { scope: 'organization', organizationId: 'org_1', kind: 'derived_fact', content: 'x', sourceConversationId: 's_cross' },
        REAL_TOKEN
      )
    )

    expect(project.status).toBe(409)
    expect((await project.json()).code).toBe('CROSS_PROJECT_MEMORY')
    expect(organization.status).toBe(409)
    expect(createProjectMemoryItemForProject).not.toHaveBeenCalled()
    expect(createProjectMemoryItem).not.toHaveBeenCalled()
  })

  it('writes from a conversation that drew on no other project, as before', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    crossProject.recorded.set('s_cross', ['project_other'])
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(makeMemoryItem())

    const response = await POST(makeRequest({ ...validProjectPayload, sourceConversationId: 's_plain' }, REAL_TOKEN))

    expect(response.status).toBe(201)
  })
})

describe('POST /api/internal/memory', () => {
  it('returns 503 when the internal token is not configured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')

    const response = await POST(makeRequest(validProjectPayload, REAL_TOKEN))

    expect(response.status).toBe(503)
    expect(createProjectMemoryItemForProject).not.toHaveBeenCalled()
  })

  it('returns 403 for a wrong token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest(validProjectPayload, 'wrong-token'))

    expect(response.status).toBe(403)
    expect(createProjectMemoryItemForProject).not.toHaveBeenCalled()
  })

  it('returns 403 when the token header is missing', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest(validProjectPayload))

    expect(response.status).toBe(403)
  })

  it('refuses the well-known dev default token outside dev environments (503)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', DEV_DEFAULT_TOKEN)
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('NODE_ENV', 'production')

    const response = await POST(makeRequest(validProjectPayload, DEV_DEFAULT_TOKEN))

    expect(response.status).toBe(503)
    expect(createProjectMemoryItemForProject).not.toHaveBeenCalled()
  })

  it('creates a project-scoped item with a valid token (201)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(
      makeMemoryItem({ id: 'item-1', projectId: PROJECT_ID })
    )

    const response = await POST(makeRequest(validProjectPayload, REAL_TOKEN))

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.item).toMatchObject({ id: 'item-1' })
    expect(createProjectMemoryItemForProject).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        kind: 'derived_fact',
        content: 'The roof load is 2 kN/m2.',
        provenanceType: 'agent',
      }),
      expect.objectContaining({ supersedesContent: undefined })
    )
  })

  it('threads the provenanceType through (distillation from the reflection stage)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(makeMemoryItem({ id: 'item-d' }))

    const response = await POST(
      makeRequest({ ...validProjectPayload, provenanceType: 'distillation' }, REAL_TOKEN)
    )

    expect(response.status).toBe(201)
    expect(createProjectMemoryItemForProject).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ provenanceType: 'distillation' }),
      expect.objectContaining({ supersedesContent: undefined })
    )
  })

  /**
   * The agent correcting its own memory: it quotes the outdated entry verbatim
   * out of the digest, and the service resolves that quote to the row it
   * retires. Without this passing through, reflection can only ever append —
   * the stale entry stays live next to its own correction.
   */
  it('threads a supersedes quote through to the write path', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(createProjectMemoryItemForProject).mockImplementation(
      async (_projectId, _values, options) => {
        options?.onSuperseded?.('item-old')
        return makeMemoryItem({ id: 'item-new', supersedesId: 'item-old' })
      }
    )

    const response = await POST(
      makeRequest(
        { ...validProjectPayload, supersedesContent: 'OIB-RL 2.1 is not applicable here' },
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(201)
    expect(createProjectMemoryItemForProject).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ kind: 'derived_fact' }),
      expect.objectContaining({ supersedesContent: 'OIB-RL 2.1 is not applicable here' })
    )
    // The caller is told which entry was actually retired (null when the quote
    // resolved to nothing, or to an entry an agent may not touch).
    expect((await response.json()).supersededId).toBe('item-old')
  })

  /**
   * A duplicate/paraphrase refresh returns an EXISTING row, and that row may
   * already carry a `supersedesId` from an earlier correction. Deriving the
   * response from the row would then claim this request retired an entry it
   * never touched — the id must come from the write itself.
   */
  it('reports no retirement when the write refreshed a row that was already a correction', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(
      makeMemoryItem({ id: 'item-existing', supersedesId: 'retired-last-week' })
    )

    const response = await POST(
      makeRequest(
        { ...validProjectPayload, supersedesContent: 'OIB-RL 2.1 is not applicable here' },
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(201)
    expect((await response.json()).supersededId).toBeNull()
  })

  it('denies agent org-scoped writes by default (403), before touching the DB', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    // GRID_ALLOW_AGENT_ORG_MEMORY unset → default-deny (audit finding S1).

    const response = await POST(
      makeRequest(
        {
          scope: 'organization',
          organizationId: 'org-1',
          kind: 'preference',
          content: 'Prefer metric units.',
        },
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(403)
    // Distinct machine-readable code so the backend does not mislabel this
    // deliberate default-deny as a GRID_INTERNAL_API_TOKEN mismatch.
    const body = await response.json()
    expect(body.code).toBe('ORG_MEMORY_DISABLED')
    expect(organizationExists).not.toHaveBeenCalled()
    expect(createProjectMemoryItem).not.toHaveBeenCalled()
  })

  it('rejects org-scoped writes for an unknown organization (404) when org writes are enabled', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.stubEnv('GRID_ALLOW_AGENT_ORG_MEMORY', 'true')
    vi.mocked(organizationExists).mockResolvedValue(false)

    const response = await POST(
      makeRequest(
        {
          scope: 'organization',
          organizationId: 'org-unknown',
          kind: 'preference',
          content: 'Prefer metric units.',
        },
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error).toBe('Unknown organization')
    expect(createProjectMemoryItem).not.toHaveBeenCalled()
  })

  it('accepts org-scoped writes for a known organization when explicitly enabled (201)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.stubEnv('GRID_ALLOW_AGENT_ORG_MEMORY', 'true')
    vi.mocked(organizationExists).mockResolvedValue(true)
    // The row the route echoes back must be org-scoped like the write itself —
    // `makeMemoryItem` defaults to a project row, which would let the fixture
    // contradict the operation under test.
    vi.mocked(createProjectMemoryItem).mockResolvedValue(
      makeMemoryItem({ id: 'item-2', scope: 'organization', projectId: null })
    )

    const response = await POST(
      makeRequest(
        {
          scope: 'organization',
          organizationId: 'org-1',
          kind: 'preference',
          content: 'Prefer metric units.',
        },
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(201)
    expect(organizationExists).toHaveBeenCalledWith('org-1')
    expect(createProjectMemoryItem).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'organization', organizationId: 'org-1', projectId: null }),
      expect.objectContaining({ supersedesContent: undefined })
    )
  })
})

/**
 * ADR-0087: a finding from a turn that read a restricted folder is written as
 * restricted project memory. The route checks the shape and the scope; the
 * service checks each name is a current restricted collection of the project.
 */
describe('restricted memory', () => {
  const RESTRICTED = 'proj_4f9c1d2e3b4a4c5d8e6f7a8b9c0d1e2f_r0123456789ab'

  it('passes the restriction through to the project write', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(
      makeMemoryItem({ id: 'item-r', restrictedFolderIds: ['22222222-aaaa-4bbb-8ccc-000000000002'] })
    )

    const response = await POST(
      makeRequest({ ...validProjectPayload, restrictedCollections: [RESTRICTED] }, REAL_TOKEN)
    )

    expect(response.status).toBe(201)
    expect(createProjectMemoryItemForProject).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ restrictedCollections: [RESTRICTED] }),
      expect.anything()
    )
  })

  it("audits the judge's verdict with the item it was about (AI Act)", async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const item = makeMemoryItem({ id: 'item-open' })
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(item)
    const restrictionJudge = { verdict: 'none', judgedCollections: [RESTRICTED], drawnCollections: [] }

    const response = await POST(makeRequest({ ...validProjectPayload, restrictionJudge }, REAL_TOKEN))

    expect(response.status).toBe(201)
    expect(recordMemoryJudgeVerdict).toHaveBeenCalledWith(item, restrictionJudge)
  })

  it('hands the judge\'s verdict to the write, so a restricted note can say a model helped decide', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(makeMemoryItem())
    const restrictionJudge = { verdict: 'drawn', judgedCollections: [RESTRICTED], drawnCollections: [RESTRICTED] }

    await POST(
      makeRequest({ ...validProjectPayload, restrictedCollections: [RESTRICTED], restrictionJudge }, REAL_TOKEN)
    )

    const values = vi.mocked(createProjectMemoryItemForProject).mock.calls[0][1]
    expect(values).toMatchObject({ restrictedCollections: [RESTRICTED], restrictionJudge: 'drawn' })
  })

  // The default deployment refuses agent organization memory, and the agent
  // then offers the finding as a card that writes it open: the judge's "none"
  // decided that, so it is in the trail although no item exists.
  it("audits the judge's verdict on an organization write the deployment refused", async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(organizationExists).mockResolvedValue(true)
    const restrictionJudge = { verdict: 'none', judgedCollections: [RESTRICTED], drawnCollections: [] }

    const response = await POST(
      makeRequest(
        {
          scope: 'organization',
          organizationId: 'org-1',
          kind: 'preference',
          content: 'Honorare immer netto angeben.',
          sourceConversationId: 'conv-1',
          restrictionJudge,
        },
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(403)
    expect(recordRefusedMemoryJudgeVerdict).toHaveBeenCalledWith(
      { organizationId: 'org-1', provenanceType: 'agent', sourceConversationId: 'conv-1' },
      restrictionJudge
    )
    expect(createProjectMemoryItem).not.toHaveBeenCalled()
  })

  it('audits no refused verdict into an organization this deployment does not know', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(organizationExists).mockResolvedValue(false)
    const restrictionJudge = { verdict: 'none', judgedCollections: [RESTRICTED], drawnCollections: [] }

    const response = await POST(
      makeRequest(
        { scope: 'organization', organizationId: 'org-x', kind: 'preference', content: 'x', restrictionJudge },
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(403)
    expect(recordRefusedMemoryJudgeVerdict).not.toHaveBeenCalled()
  })

  it('audits nothing when no judge was asked', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(makeMemoryItem())

    await POST(makeRequest(validProjectPayload, REAL_TOKEN))

    expect(recordMemoryJudgeVerdict).not.toHaveBeenCalled()
  })

  it('writes open memory when no restriction is named', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(makeMemoryItem())

    await POST(makeRequest(validProjectPayload, REAL_TOKEN))

    const values = vi.mocked(createProjectMemoryItemForProject).mock.calls[0][1]
    expect(values).not.toHaveProperty('restrictedCollections')
    expect(values).not.toHaveProperty('restrictionJudge')
  })

  it('refuses restricted organization memory (400) — it reaches every project', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.stubEnv('GRID_ALLOW_AGENT_ORG_MEMORY', 'true')

    const response = await POST(
      makeRequest(
        {
          scope: 'organization',
          organizationId: 'org_1',
          kind: 'decision',
          content: 'x',
          restrictedCollections: [RESTRICTED],
        },
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(400)
    expect(createProjectMemoryItem).not.toHaveBeenCalled()
    expect(organizationExists).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty list', []],
    ['an open collection name', ['proj_4f9c1d2e3b4a4c5d8e6f7a8b9c0d1e2f']],
    ['more than twenty', Array.from({ length: 21 }, (_, i) => `proj_x_r${String(i).padStart(12, '0')}`)],
  ])('rejects %s (400)', async (_label, restrictedCollections) => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest({ ...validProjectPayload, restrictedCollections }, REAL_TOKEN))

    expect(response.status).toBe(400)
    expect(createProjectMemoryItemForProject).not.toHaveBeenCalled()
  })
})
