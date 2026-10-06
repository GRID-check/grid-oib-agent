/**
 * @vitest-environment node
 */
/**
 * Watching a turn is reading the conversation (ADR-0079): the frames carry the
 * answer as it is written, so a person who may no longer read a folder the
 * conversation drew on may neither open the stream nor keep one open.
 *
 * The REAL `@/lib/sharing/access` runs; only the conversation's probe, the grant
 * lookup and the answer to "who may read what it recorded" are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/conversations/repository', () => ({ findConversationTenancy: vi.fn() }))
vi.mock('@/lib/sharing/repository', () => ({ findGrantForSubject: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({
  isFolderVisibleTo: vi.fn(),
  clearanceOf: vi.fn(() => ({ roles: [], seesEverything: false })),
  requireFolderWrite: vi.fn(),
}))
vi.mock('@/lib/conversations/restricted-use', () => ({
  peopleWhoMayRead: vi.fn(),
  assertMayWidenConversation: vi.fn(),
  widenConversationAudience: vi.fn(),
}))

import { ResourceRightsLostError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { peopleWhoMayRead } from '@/lib/conversations/restricted-use'
import { findGrantForSubject } from '@/lib/sharing/repository'
import { requireConversationSpectator, stillMayWatchConversation } from './live'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
  role: 'member',
  roles: ['member'],
  permissions: [],
} as unknown as AuthorizedSession

/** The set of people who may read what the conversation recorded; the watcher is in it or not. */
function readers(...userIds: string[]): void {
  vi.mocked(peopleWhoMayRead).mockImplementation(async (_org, _id, asked) => new Set(asked.filter((id) => userIds.includes(id))))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findConversationTenancy).mockResolvedValue({
    organizationId: 'org_1',
    projectId: 'proj_1',
    visibility: 'private',
    createdBy: 'user_creator',
    deletedAt: null,
  })
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' })
  vi.mocked(findGrantForSubject).mockResolvedValue({ role: 'viewer' } as never)
  readers(session.userId)
})

describe('the live stream of a turn (ADR-0079)', () => {
  it('opens for a grantee who may read every folder the conversation recorded', async () => {
    await expect(requireConversationSpectator(session, 'conv_1')).resolves.toBeUndefined()
    await expect(stillMayWatchConversation(session, 'conv_1')).resolves.toBe(true)
  })

  it('is refused for a grantee who lost a recorded folder, before a frame is relayed', async () => {
    readers()

    await expect(requireConversationSpectator(session, 'conv_1')).rejects.toBeInstanceOf(ResourceRightsLostError)
  })

  it('is refused for the CREATOR who lost it: the thread is theirs, its frames are not', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1',
      projectId: 'proj_1',
      visibility: 'private',
      createdBy: session.userId,
      deletedAt: null,
    })
    vi.mocked(findGrantForSubject).mockResolvedValue(null)
    readers()

    await expect(requireConversationSpectator(session, 'conv_1')).rejects.toBeInstanceOf(ResourceRightsLostError)
  })

  it('closes an OPEN stream at the next re-check once the role is gone, and reopens when it is given back', async () => {
    await expect(stillMayWatchConversation(session, 'conv_1')).resolves.toBe(true)

    readers() // the role is taken away while the stream is open
    await expect(stillMayWatchConversation(session, 'conv_1')).resolves.toBe(false)

    readers(session.userId) // and given back
    await expect(stillMayWatchConversation(session, 'conv_1')).resolves.toBe(true)
  })
})
