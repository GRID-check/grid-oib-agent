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

import {
  createProjectMemoryItem,
  createProjectMemoryItemForProject,
  organizationExists,
} from '@/lib/projects/memory-service'
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
      { supersedesContent: undefined }
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
      { supersedesContent: undefined }
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
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(
      makeMemoryItem({ id: 'item-new', supersedesId: 'item-old' })
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
      { supersedesContent: 'OIB-RL 2.1 is not applicable here' }
    )
    // The caller is told which entry was actually retired (null when the quote
    // resolved to nothing, or to an entry an agent may not touch).
    expect((await response.json()).supersededId).toBe('item-old')
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
      { supersedesContent: undefined }
    )
  })
})
