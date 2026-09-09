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
  assertAgentMayWriteOrgMemory: vi.fn(),
  createProjectMemoryItem: vi.fn(),
  createProjectMemoryItemForProject: vi.fn(),
  organizationExists: vi.fn(),
}))

import {
  assertAgentMayWriteOrgMemory,
  createProjectMemoryItem,
  createProjectMemoryItemForProject,
  organizationExists,
} from '@/lib/projects/memory-service'
import { OrgMemoryDisabledError } from '@/lib/api/errors'
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

beforeEach(() => {
  // The acting user holds `org:memory:write` unless a case says otherwise; the
  // permission itself is exercised in `lib/projects/memory-service.spec.ts`.
  vi.mocked(assertAgentMayWriteOrgMemory).mockResolvedValue(undefined)
})

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
        options?.onSuperseded?.({ id: 'item-old', content: 'OIB-RL 2.1 is not applicable here' })
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
    // resolved to nothing, or to an entry an agent may not touch) — AND its own
    // words, which the transcript notice renders and which no later caller
    // could get without asking the database for a row this write already held.
    const body = await response.json()
    expect(body.supersededId).toBe('item-old')
    expect(body.supersededContent).toBe('OIB-RL 2.1 is not applicable here')
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
    const body = await response.json()
    expect(body.supersededId).toBeNull()
    // Both halves are absent together: a content without a retirement would
    // let a transcript state a correction that did not happen.
    expect(body.supersededContent).toBeNull()
  })

  it('denies agent org-scoped writes by default (403), before touching the DB', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    // GRID_ALLOW_AGENT_ORG_MEMORY unset → default-deny (audit finding S1).

    const response = await POST(
      makeRequest(
        {
          scope: 'organization',
          organizationId: 'org-1',
          userId: 'user_1',
          organizationMembershipId: 'om_1',
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

  it('refuses an org-scoped write the ACTING USER may not make (403), before touching the DB', async () => {
    // The service token proves the caller is the backend and says nothing about
    // the person whose turn it is: without `org:memory:write` the write is
    // refused with the SAME code the deployment gate uses, so `remember`
    // degrades into the proposal card either way (spec AG-8, AG-9).
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.stubEnv('GRID_ALLOW_AGENT_ORG_MEMORY', 'true')
    vi.mocked(assertAgentMayWriteOrgMemory).mockRejectedValue(
      new OrgMemoryDisabledError('The acting user may not record organization memory')
    )

    const response = await POST(
      makeRequest(
        {
          scope: 'organization',
          organizationId: 'org-1',
          userId: 'user_1',
          organizationMembershipId: 'om_member',
          kind: 'preference',
          content: 'Prefer metric units.',
        },
        REAL_TOKEN
      )
    )

    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('ORG_MEMORY_DISABLED')
    expect(organizationExists).not.toHaveBeenCalled()
    expect(createProjectMemoryItem).not.toHaveBeenCalled()
  })

  /**
   * ADR-0055 C6. The permission is the gate, and it is asked FIRST.
   *
   * It used to be asked behind the deployment off-switch, which defaults to
   * off — so in every ordinary deployment the sentence that reached a person
   * said the feature was switched off, when the truth about them was that
   * their role does not hold `org:memory:write`. A permission denial reported
   * as a service state tells someone who could be granted the right that there
   * is nothing to grant.
   */
  describe('the refusal tells the truth', () => {
    it('asks the acting user’s permission even with the deployment switch OFF', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
      // GRID_ALLOW_AGENT_ORG_MEMORY unset — the old order never reached the
      // permission here, so an unheld permission and a switched-off deployment
      // were indistinguishable to everybody downstream.

      await POST(
        makeRequest(
          {
            scope: 'organization',
            organizationId: 'org-1',
            userId: 'user_1',
            organizationMembershipId: 'om_1',
            kind: 'preference',
            content: 'Prefer metric units.',
          },
          REAL_TOKEN
        )
      )

      expect(assertAgentMayWriteOrgMemory).toHaveBeenCalledWith({
        organizationId: 'org-1',
        organizationMembershipId: 'om_1',
      })
    })

    it('states the missing permission rather than an outage, keeping the code', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
      vi.mocked(assertAgentMayWriteOrgMemory).mockRejectedValue(
        new OrgMemoryDisabledError(
          'The acting user may not record organization-wide memory: their role does not hold org:memory:write'
        )
      )

      const response = await POST(
        makeRequest(
          {
            scope: 'organization',
            organizationId: 'org-1',
            userId: 'user_1',
            organizationMembershipId: 'om_member',
            kind: 'preference',
            content: 'Prefer metric units.',
          },
          REAL_TOKEN
        )
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      // The code is untouched: the Python proposal-card branch keys on it.
      expect(body.code).toBe('ORG_MEMORY_DISABLED')
      // The MESSAGE is a permission statement, and names what is missing.
      expect(body.error).toContain('org:memory:write')
      expect(body.error).not.toMatch(/unavailable|disabled in this deployment/i)
    })

    it('says "switched off in this deployment" only to someone who holds the permission', async () => {
      vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
      // The permission resolves (the default mock), the operator’s switch does
      // not — which is exactly when the deployment IS the whole answer.
      const response = await POST(
        makeRequest(
          {
            scope: 'organization',
            organizationId: 'org-1',
            userId: 'user_1',
            organizationMembershipId: 'om_admin',
            kind: 'preference',
            content: 'Prefer metric units.',
          },
          REAL_TOKEN
        )
      )

      expect(response.status).toBe(403)
      const body = await response.json()
      expect(body.code).toBe('ORG_MEMORY_DISABLED')
      expect(body.error).toContain('deployment')
    })
  })

  it('authorizes as the membership the envelope names, never as the service', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.stubEnv('GRID_ALLOW_AGENT_ORG_MEMORY', 'true')
    vi.mocked(organizationExists).mockResolvedValue(true)
    vi.mocked(createProjectMemoryItem).mockResolvedValue(
      makeMemoryItem({ id: 'item-3', scope: 'organization', projectId: null })
    )

    await POST(
      makeRequest(
        {
          scope: 'organization',
          organizationId: 'org-1',
          userId: 'user_1',
          organizationMembershipId: 'om_1',
          kind: 'preference',
          content: 'Prefer metric units.',
        },
        REAL_TOKEN
      )
    )

    expect(assertAgentMayWriteOrgMemory).toHaveBeenCalledWith({
      organizationId: 'org-1',
      organizationMembershipId: 'om_1',
    })
  })

  it('never asks the permission for a PROJECT-scoped write', async () => {
    // A project write is addressed by a project row and authorized by the row's
    // own tenancy; asking an org-tier question about it would be a round trip
    // for an answer nothing reads.
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(createProjectMemoryItemForProject).mockResolvedValue(makeMemoryItem({ id: 'item-p' }))

    await POST(makeRequest(validProjectPayload, REAL_TOKEN))

    expect(assertAgentMayWriteOrgMemory).not.toHaveBeenCalled()
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
          userId: 'user_1',
          organizationMembershipId: 'om_1',
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
