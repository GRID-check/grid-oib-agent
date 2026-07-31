/**
 * Composing presence: who may claim it, and who hears about it.
 *
 * Three properties are worth a test each, because each one is a way this feature
 * could quietly become something it is not:
 *
 *  1. a solo thread must publish nothing at all (spec NF-8 — a user who never
 *     shares anything cannot notice collaboration exists);
 *  2. a viewer must not be able to announce a draft that can never be sent;
 *  3. the typist is `session.userId`, never anything the caller supplied.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/events/bus', () => ({ publishToUsers: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/sharing/access', () => ({
  isShared: (visibility: string, grants: number) => visibility !== 'private' || grants > 0,
  requireResourceAccess: vi.fn(),
}))
vi.mock('@/lib/sharing/repository', () => ({ countGrantsForResource: vi.fn() }))
vi.mock('@/lib/sharing/service', () => ({ resolveParticipants: vi.fn() }))
vi.mock('@/lib/authz/feature-flags', () => ({ isCollaborationEnabled: vi.fn(() => true) }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { publishToUsers } from '@/lib/events/bus'
import { requireResourceAccess } from '@/lib/sharing/access'
import { countGrantsForResource } from '@/lib/sharing/repository'
import { resolveParticipants } from '@/lib/sharing/service'
import { NotFoundError } from '@/lib/api/errors'
import { publishTypingPresence } from './presence'
import { TYPING_TTL_MS } from './presence-contract'

const CONVERSATION_ID = 'conv_1'
const ME = 'user_me'
const ANNA = 'user_anna'

const session = {
  userId: ME,
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

function allowAccess(visibility: 'private' | 'project' | 'organization' = 'private'): void {
  vi.mocked(requireResourceAccess).mockResolvedValue({ visibility } as never)
}

describe('publishTypingPresence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isCollaborationEnabled).mockReturnValue(true)
    vi.mocked(countGrantsForResource).mockResolvedValue(0)
    vi.mocked(resolveParticipants).mockResolvedValue([ME, ANNA])
  })

  it('publishes to the other participants, naming the session user', async () => {
    allowAccess()
    vi.mocked(countGrantsForResource).mockResolvedValue(1)

    await publishTypingPresence(session, CONVERSATION_ID, true)

    expect(publishToUsers).toHaveBeenCalledWith([ANNA], {
      kind: 'conversation.typing',
      conversationId: CONVERSATION_ID,
      userId: ME,
      typing: true,
      ttlMs: TYPING_TTL_MS,
    })
  })

  it('never echoes the claim back to the typist', async () => {
    allowAccess()
    vi.mocked(countGrantsForResource).mockResolvedValue(1)

    await publishTypingPresence(session, CONVERSATION_ID, true)

    const [audience] = vi.mocked(publishToUsers).mock.calls[0]
    expect(audience).not.toContain(ME)
  })

  it('publishes nothing for a solo thread', async () => {
    // Private, no grants: there is nobody to tell, and a user who never shares
    // must not be able to notice this feature exists.
    allowAccess('private')
    vi.mocked(countGrantsForResource).mockResolvedValue(0)

    await publishTypingPresence(session, CONVERSATION_ID, true)

    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('publishes nothing when the thread has only the caller in it', async () => {
    allowAccess('organization')
    vi.mocked(resolveParticipants).mockResolvedValue([ME])

    await publishTypingPresence(session, CONVERSATION_ID, true)

    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('refuses a caller who may not contribute', async () => {
    // `requireResourceAccess(..., 'collaborator')` throws for a viewer, and the
    // denial is a 404 rather than a 403 — a refusal must not confirm the thread
    // exists.
    vi.mocked(requireResourceAccess).mockRejectedValue(new NotFoundError())

    await expect(publishTypingPresence(session, CONVERSATION_ID, true)).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('asks for the collaborator role, not viewer', async () => {
    allowAccess('organization')
    await publishTypingPresence(session, CONVERSATION_ID, true)
    expect(requireResourceAccess).toHaveBeenCalledWith(
      session,
      'conversation',
      CONVERSATION_ID,
      'collaborator'
    )
  })

  it('does nothing at all with the feature off', async () => {
    vi.mocked(isCollaborationEnabled).mockReturnValue(false)

    await publishTypingPresence(session, CONVERSATION_ID, true)

    expect(requireResourceAccess).not.toHaveBeenCalled()
    expect(publishToUsers).not.toHaveBeenCalled()
  })

  it('carries the withdrawal too', async () => {
    allowAccess('organization')
    await publishTypingPresence(session, CONVERSATION_ID, false)
    expect(publishToUsers).toHaveBeenCalledWith(
      [ANNA],
      expect.objectContaining({ typing: false })
    )
  })
})
