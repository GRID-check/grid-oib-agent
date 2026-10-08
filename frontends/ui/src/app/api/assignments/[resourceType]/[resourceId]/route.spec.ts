/**
 * @vitest-environment node
 */
/**
 * GET reads through the access-checked single-resource service call, so a
 * refusal is the same 404 as a missing id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    permissions: [],
  }),
}))

vi.mock('@/lib/authz/feature-flags', () => ({
  requireCollaborationEnabled: vi.fn(() => null),
}))

vi.mock('@/lib/assignments/service', () => ({
  listResourceAssignments: vi.fn(),
  addResourceAssignment: vi.fn(),
  removeResourceAssignment: vi.fn(),
}))

import { NotFoundError } from '@/lib/api/errors'
import { listResourceAssignments } from '@/lib/assignments/service'
import { GET } from './route'

const get = (resourceType: string, resourceId: string) =>
  GET(new Request(`https://grid.test/api/assignments/${resourceType}/${resourceId}`), {
    params: Promise.resolve({ resourceType, resourceId }),
  })

describe('GET /api/assignments/[resourceType]/[resourceId]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads through the access-checked service call, for the one id in the path', async () => {
    vi.mocked(listResourceAssignments).mockResolvedValue([])

    const response = await get('document', 'doc-1')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ assignees: [] })
    expect(listResourceAssignments).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'document',
      'doc-1'
    )
  })

  it('answers 404 when the caller cannot reach the resource', async () => {
    vi.mocked(listResourceAssignments).mockRejectedValue(new NotFoundError())

    const response = await get('conversation', 's_private')

    expect(response.status).toBe(404)
  })
})
