/**
 * The job envelope signs the project only for a caller who may steer its runs.
 *
 * ADR-0084 lets anyone signed into a project's scope read and control that
 * project's jobs. A closed project is readable by the whole office (ADR-0090),
 * but steering somebody else's run stays a member's: a caller who reads the
 * project only because it is closed is signed no project, so the backend lets
 * them reach their own jobs and nothing more through it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GridSession } from '@/lib/auth/types'
import { GRID_HEADER_NAMES, verifyGridRequestContextEnvelope } from '@/lib/request-context'

import { type AuthorizedJobScope, signJobRequestContext } from './request-envelope'

const SECRET = 'request-envelope-spec-secret'
const NOW = 1_800_000_000_000

const session = { organizationId: 'org_1', userId: 'user_1' } as GridSession

const scope: AuthorizedJobScope = {
  projectId: 'p-1',
  scopedCollections: [
    { collection: 'oib_knowledge', shelf: 'base' },
    { collection: 'archiv_org_1', shelf: 'archiv' },
    { collection: 'proj_p1', shelf: 'project' },
    { collection: 's_conv-1', shelf: 'session' },
  ],
  verifiedConversationId: 'conv-1',
}

function signed(jobScope: AuthorizedJobScope) {
  const headers = signJobRequestContext(session, jobScope, {}, NOW)
  const verified = verifyGridRequestContextEnvelope(
    headers[GRID_HEADER_NAMES.REQUEST_CONTEXT],
    headers[GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG],
    SECRET,
    NOW
  )
  if (!verified) throw new Error('the envelope did not verify')
  return verified
}

describe('signJobRequestContext', () => {
  let previous: string | undefined
  beforeEach(() => {
    previous = process.env.GRID_INTERNAL_API_TOKEN
    process.env.GRID_INTERNAL_API_TOKEN = SECRET
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.GRID_INTERNAL_API_TOKEN
    else process.env.GRID_INTERNAL_API_TOKEN = previous
  })

  it('signs the project and its collection for a member', () => {
    const envelope = signed(scope)
    expect(envelope.projectId).toBe('p-1')
    expect(envelope.collectionScope).toContain('proj_p1')
    expect(envelope.conversationId).toBe('conv-1')
  })

  it('signs no project for a caller who reads it only because it is closed', () => {
    const envelope = signed({ ...scope, projectReadOnly: true })
    expect(envelope.projectId).toBeNull()
    expect(envelope.collectionScope).not.toContain('proj_p1')
    // The rest of the scope, and the conversation they may view, still travel.
    expect(envelope.collectionScope).toEqual(['oib_knowledge', 'archiv_org_1', 's_conv-1'])
    expect(envelope.conversationId).toBe('conv-1')
  })
})
