/**
 * @vitest-environment node
 */
/**
 * Unmounting (ADR-0054, spec MT-13).
 *
 * One property worth its own file: the 204 is the SAME 204 whether a row was
 * there or not. The caller asked for "this conversation no longer reads that
 * project", and that is true either way — which also means the endpoint cannot
 * be used to sort guessed project ids into mounted and not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
  }),
  authzErrorResponse: () => null,
}))

vi.mock('@/lib/workspace/mounts-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/mounts-service')>()
  return { ...actual, unmountProject: vi.fn() }
})

import { NotFoundError } from '@/lib/api/errors'
import { unmountProject } from '@/lib/workspace/mounts-service'
import { DELETE } from './route'

const CONVERSATION = 'conv_buero'
const PROJECT = '11111111-1111-1111-1111-111111111111'

const del = () =>
  DELETE(
    new Request(`https://grid.test/api/conversations/${CONVERSATION}/mounts/${PROJECT}`, {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ id: CONVERSATION, projectId: PROJECT }) }
  )

afterEach(() => vi.clearAllMocks())

describe('DELETE /api/conversations/:id/mounts/:projectId', () => {
  it('removes the mount and answers 204 with no body', async () => {
    vi.mocked(unmountProject).mockResolvedValue(undefined)

    const response = await del()

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(unmountProject).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      CONVERSATION,
      PROJECT
    )
  })

  it('answers the same 204 for a project that was never mounted', async () => {
    vi.mocked(unmountProject).mockResolvedValue(undefined)

    expect((await del()).status).toBe(204)
  })

  it('refuses a thread the caller may not contribute to', async () => {
    vi.mocked(unmountProject).mockRejectedValue(new NotFoundError())

    expect((await del()).status).toBe(404)
  })
})
