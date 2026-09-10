/**
 * The scoping rule for both chat surfaces (UX-8, WS-8/WS-9).
 *
 * The two halves are asymmetric on purpose and that asymmetry is what these
 * tests pin: a project keeps the fail-open rule that has kept legacy history
 * visible, and the Büro does not get it.
 */

import { describe, expect, it } from 'vitest'
import {
  conversationMatchesProject,
  conversationMatchesScope,
  conversationScope,
  isJobConversation,
  normalizeConversationScope,
} from './project-scope'

const inWorkspace = { projectId: null, scope: 'workspace' } as const
const inProject = { projectId: 'proj-a', scope: 'project' } as const

describe('conversationMatchesProject', () => {
  it('shows everything when there is no active project', () => {
    expect(conversationMatchesProject({ projectId: 'proj-b' }, null)).toBe(true)
  })

  it('shows a legacy session with no project in every project (fail-open)', () => {
    expect(conversationMatchesProject({ projectId: null }, 'proj-a')).toBe(true)
  })

  it("hides another project's session", () => {
    expect(conversationMatchesProject({ projectId: 'proj-b' }, 'proj-a')).toBe(false)
  })
})

describe('normalizeConversationScope', () => {
  it.each([
    ['project', 'project'],
    ['workspace', 'workspace'],
  ] as const)('accepts %s', (value, expected) => {
    expect(normalizeConversationScope(value)).toBe(expected)
  })

  it.each([null, undefined, '', 'buero', 7, {}])('rejects %s', (value) => {
    expect(normalizeConversationScope(value)).toBeNull()
  })
})

describe('conversationScope', () => {
  it('trusts the row when it declares a scope', () => {
    expect(conversationScope({ projectId: null, scope: 'project' })).toBe('project')
  })

  it('reads a row that predates the column the way the backfill did', () => {
    expect(conversationScope({ projectId: 'proj-a' })).toBe('project')
    expect(conversationScope({ projectId: null })).toBe('workspace')
  })
})

describe('conversationMatchesScope in the Büro', () => {
  it('never shows a project conversation', () => {
    expect(conversationMatchesScope({ projectId: 'proj-a', scope: 'project' }, inWorkspace)).toBe(
      false,
    )
  })

  it('does not fail open for a project row whose scope is missing', () => {
    expect(conversationMatchesScope({ projectId: 'proj-a' }, inWorkspace)).toBe(false)
  })

  it('shows a legacy row with no project and no scope', () => {
    expect(conversationMatchesScope({ projectId: null }, inWorkspace)).toBe(true)
  })

  it('shows a declared workspace conversation', () => {
    expect(conversationMatchesScope({ projectId: null, scope: 'workspace' }, inWorkspace)).toBe(true)
  })
})

describe('conversationMatchesScope in a project', () => {
  it('keeps the fail-open rule for unscoped legacy sessions', () => {
    expect(conversationMatchesScope({ projectId: null }, inProject)).toBe(true)
  })

  it('hides a conversation that declares itself a Büro chat', () => {
    expect(conversationMatchesScope({ projectId: null, scope: 'workspace' }, inProject)).toBe(false)
  })

  it("hides another project's conversation", () => {
    expect(conversationMatchesScope({ projectId: 'proj-b', scope: 'project' }, inProject)).toBe(
      false,
    )
  })
})

describe('isJobConversation', () => {
  it('marks a job-produced thread', () => {
    expect(isJobConversation({ jobId: 'job-1' })).toBe(true)
    expect(isJobConversation({ jobId: null })).toBe(false)
  })
})
