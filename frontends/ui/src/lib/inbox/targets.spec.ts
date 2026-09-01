/**
 * @vitest-environment node
 */
/**
 * The inbox target registry (ADR-0042).
 *
 * `inbox_items.resource_type` used to be the SHARING union, and the read path
 * went straight to `describeResource()`, which THROWS for a type it does not
 * know. Adding an organization-scoped alert therefore had two ways to go wrong:
 * make the org "shareable" (it must never be — that would make a tenant a thing
 * you can hand somebody a grant on), or crash the inbox route for a row a newer
 * deploy wrote. These tests pin the third way.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/sharing/access', () => ({ resolveResourceAccess: vi.fn() }))
vi.mock('@/lib/sharing/registry', () => ({ describeResource: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))

import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { resolveResourceAccess } from '@/lib/sharing/access'
import { describeResource } from '@/lib/sharing/registry'
import { INBOX_TARGET_REGISTRY, findInboxTarget } from './targets'

function makeSession(organizationId = 'org_1'): AuthorizedSession {
  return {
    userId: 'user_1',
    email: 'user_1@grid.test',
    name: 'Test User',
    accessToken: 'workos_token',
    organizationId,
    organizationMembershipId: 'om_1',
    role: 'admin',
    permissions: [],
    featureFlags: null,
  }
}

describe('findInboxTarget', () => {
  it('resolves the registered target types', () => {
    expect(findInboxTarget('conversation')).toBe(INBOX_TARGET_REGISTRY.conversation)
    expect(findInboxTarget('organization')).toBe(INBOX_TARGET_REGISTRY.organization)
  })

  it('returns null — never throws — for a type this build has never heard of', () => {
    // `resource_type` is a `text` column, so a row written by a newer deploy and
    // read across a rollback carries an unknown value. `describeResource` threw
    // for exactly that case and took the whole inbox route down with it; here it
    // is simply an unreachable target, which renders as a redacted row.
    expect(findInboxTarget('spaceship')).toBeNull()
    expect(findInboxTarget('')).toBeNull()
  })
})

describe('the organization target', () => {
  const organizationTarget = INBOX_TARGET_REGISTRY.organization

  it('deep-links a storage alert to the page that explains it', async () => {
    const access = await organizationTarget.resolve(makeSession(), 'org_1')

    expect(access).not.toBeNull()
    expect(access!.deepLink({ itemType: 'storage.quota_warning' })).toBe(
      '/app/organization/storage',
    )
  })

  it('falls back to the organization overview for a type with no destination', async () => {
    const access = await organizationTarget.resolve(makeSession(), 'org_1')

    // Never wrong, only vague — better than a dead link for a type someone adds
    // later and forgets to map.
    expect(access!.deepLink({ itemType: 'conversation.activity' })).toBe('/app/organization')
  })

  it('redacts a row addressed to a DIFFERENT organization', async () => {
    // The list query is already scoped to `session.organizationId` in SQL, so
    // this is a belt on top of that strap: a row written with the wrong org id
    // (an emitter bug, a bad backfill) renders redacted rather than linking a
    // member into a tenant they do not belong to.
    expect(await organizationTarget.resolve(makeSession('org_1'), 'org_other')).toBeNull()
  })

  it('does not consult the sharing registry at all', async () => {
    await organizationTarget.resolve(makeSession(), 'org_1')

    // An organization is not shareable and must not become shareable; resolving
    // it through the sharing path would be the first step toward that.
    expect(resolveResourceAccess).not.toHaveBeenCalled()
    expect(describeResource).not.toHaveBeenCalled()
  })
})

describe('the conversation target', () => {
  const conversationTarget = INBOX_TARGET_REGISTRY.conversation

  it('delegates to the sharing registry, so shareable access stays defined once', async () => {
    vi.mocked(resolveResourceAccess).mockResolvedValue({
      role: 'collaborator',
      reason: 'visibility-project',
      visibility: 'project',
      container: { organizationId: 'org_1', projectId: 'proj_1' },
      canEscalate: false,
    })
    vi.mocked(describeResource).mockReturnValue({
      deepLink: (resourceId: string, options?: { anchorId?: string; projectId?: string | null }) =>
        `/app/projects/${options?.projectId}/chat?session=${resourceId}` +
        (options?.anchorId ? `#message-${options.anchorId}` : ''),
    } as never)

    const access = await conversationTarget.resolve(makeSession(), 'conv_1')

    expect(access!.deepLink({ itemType: 'conversation.activity', anchorId: 'msg_9' })).toBe(
      '/app/projects/proj_1/chat?session=conv_1#message-msg_9',
    )
  })

  it('is unreachable when the reader has no access role', async () => {
    vi.mocked(resolveResourceAccess).mockResolvedValue({
      role: null,
      // `null`, not a 'none' sentinel: `AccessReason` enumerates the ways access
      // is GRANTED, so the absence of a reason is the absence of access. Typing
      // this fixture properly is what surfaced that — an invented 'none' member
      // would have described a shape the production type never had.
      reason: null,
      visibility: 'private',
      container: { organizationId: 'org_1', projectId: 'proj_1' },
      canEscalate: false,
    })

    // `role: null` is "exists, but you have no access" — as unreachable as a 404.
    expect(await conversationTarget.resolve(makeSession(), 'conv_1')).toBeNull()
  })
})

describe('the project target', () => {
  const projectTarget = INBOX_TARGET_REGISTRY.project

  it('lands a run outcome on the project automation page when the reader may view the project', async () => {
    vi.mocked(requireProjectAccess).mockResolvedValueOnce({ role: 'project-viewer' })
    const access = await projectTarget.resolve(makeSession(), 'proj_1')
    expect(access).not.toBeNull()
    expect(access!.deepLink({ itemType: 'job.completed', anchorId: 'backend-job-1' })).toBe(
      '/app/projects/proj_1/automation?tab=jobs',
    )
    expect(requireProjectAccess).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1' }), 'proj_1', 'project:view')
  })

  it('redacts the row, rather than throwing, for a project the reader can no longer open', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new Error('forbidden'))
    await expect(projectTarget.resolve(makeSession(), 'proj_gone')).resolves.toBeNull()
  })
})
