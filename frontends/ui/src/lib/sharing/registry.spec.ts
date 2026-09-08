/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

// The Büro rule the conversation descriptor delegates to. Mocked so this file
// can assert WHICH rows it is asked about without a database.
vi.mock('@/lib/workspace/conversation-sharing', () => ({
  assertMountedProjectsReadable: vi.fn(),
  assertSubjectMayJoinConversation: vi.fn(),
}))

import { SHAREABLE_RESOURCE_TYPES } from '@/lib/db/schema'
import type { AuthorizedSession } from '@/lib/auth/types'
import { assertMountedProjectsReadable } from '@/lib/workspace/conversation-sharing'
import { SHAREABLE_REGISTRY, describeResource, type ResourceProbe } from './registry'

describe('SHAREABLE_REGISTRY', () => {
  it('registers every shareable type', () => {
    expect(Object.keys(SHAREABLE_REGISTRY).sort()).toEqual([...SHAREABLE_RESOURCE_TYPES].sort())
  })

  it('conversation and document both persist visibility through the descriptor', () => {
    expect(typeof describeResource('conversation').setVisibility).toBe('function')
    expect(typeof describeResource('document').setVisibility).toBe('function')
  })

  it('reads declared descriptor fields instead of leaving them unread', () => {
    const document = describeResource('document')
    expect(document.defaultVisibility).toBe('project')
    expect(document.supportsMentions).toBe(false)
    expect(document.labelKey).toBe('document')
    expect(document.deepLink('doc-1', { projectId: 'p1' })).toBe('/app/projects/p1/files?doc=doc-1')
  })

  /**
   * The mounted-project rule (spec AC-7) applies to a Büro thread and to
   * nothing else. Which rows it is asked about is the difference between one
   * indexed count on office threads and one on EVERY conversation read.
   */
  describe('the conversation read precondition', () => {
    const session = { userId: 'user_1', organizationId: 'org_1' } as AuthorizedSession
    const probe = (projectId: string | null): ResourceProbe => ({
      organizationId: 'org_1',
      projectId,
      container: projectId
        ? { kind: 'project', id: projectId }
        : { kind: 'organization', id: 'org_1' },
      visibility: 'private',
      createdBy: 'user_1',
      deletedAt: null,
    })

    it('asks it for an organization-level conversation', async () => {
      await describeResource('conversation').assertReadable?.(session, 'conv_1', probe(null))
      expect(assertMountedProjectsReadable).toHaveBeenCalledWith(session, 'conv_1')
    })

    it('never asks it for a project conversation, which can mount nothing', async () => {
      await describeResource('conversation').assertReadable?.(session, 'conv_1', probe('proj_1'))
      expect(assertMountedProjectsReadable).not.toHaveBeenCalled()
    })

    it('is absent on a type with no such rule', () => {
      expect(describeResource('document').assertReadable).toBeUndefined()
      expect(describeResource('document').assertGrantable).toBeUndefined()
    })
  })
})
