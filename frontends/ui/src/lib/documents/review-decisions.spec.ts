/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./version-repository', () => ({ listRefusedVersionsForConversation: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ resolvePeople: vi.fn() }))

import { resolvePeople } from '@/lib/sharing/directory'
import { buildReviewDecisionsBlock, MAX_REVIEW_DECISIONS, REVIEW_DECISIONS_HEADER } from './review-decisions'
import { listRefusedVersionsForConversation } from './version-repository'

const row = (overrides: Record<string, unknown> = {}) => ({
  versionId: 'ver-1',
  documentId: 'doc-1',
  versionNumber: 2,
  state: 'changes_requested' as const,
  reviewComment: 'Die Fluchtweglänge stimmt nicht: 42 m, nicht 35 m.',
  reviewedBy: 'user_reviewer',
  reviewedAt: new Date('2026-09-09T10:00:00Z'),
  displayName: 'Befund Fluchtweg',
  filename: 'piloti/doc-1/befund-2026-09-08.md',
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolvePeople).mockResolvedValue(
    new Map([['user_reviewer', { userId: 'user_reviewer', name: 'Maria Huber', email: null, profilePictureUrl: null }]]),
  )
})

describe('buildReviewDecisionsBlock', () => {
  it('is null when this conversation has had nothing sent back', async () => {
    // Callers omit the block rather than injecting a bare header, exactly as the
    // memory digest and the proposal decisions do.
    vi.mocked(listRefusedVersionsForConversation).mockResolvedValue([])
    expect(await buildReviewDecisionsBlock('conv-1', 'org_1')).toBeNull()
  })

  it('quotes the reviewer verbatim, under the versioned header', async () => {
    vi.mocked(listRefusedVersionsForConversation).mockResolvedValue([row()])

    const block = await buildReviewDecisionsBlock('conv-1', 'org_1')

    expect(block).toContain(REVIEW_DECISIONS_HEADER)
    // Verbatim: a summarised objection is an objection somebody else made.
    expect(block).toContain('Die Fluchtweglänge stimmt nicht: 42 m, nicht 35 m.')
  })

  it('names the document, the version, the person and the day', async () => {
    vi.mocked(listRefusedVersionsForConversation).mockResolvedValue([row()])
    const block = await buildReviewDecisionsBlock('conv-1', 'org_1')

    expect(block).toContain('Änderungen angefordert')
    expect(block).toContain('Befund Fluchtweg')
    expect(block).toContain('v2')
    expect(block).toContain('Maria Huber')
    expect(block).toContain('2026-09-09')
  })

  it('tells a rejection apart from a request for changes', async () => {
    vi.mocked(listRefusedVersionsForConversation).mockResolvedValue([row({ state: 'rejected' })])
    expect(await buildReviewDecisionsBlock('conv-1', 'org_1')).toContain('abgelehnt')
  })

  it('falls back to the filename when the document has no display name', async () => {
    vi.mocked(listRefusedVersionsForConversation).mockResolvedValue([row({ displayName: null })])
    expect(await buildReviewDecisionsBlock('conv-1', 'org_1')).toContain('piloti/doc-1/befund-2026-09-08.md')
  })

  it('prints no name at all for a reviewer the directory cannot resolve', async () => {
    // A deactivated member, a WorkOS hiccup. A raw `user_01…` at an architect is
    // worse than no name.
    vi.mocked(resolvePeople).mockResolvedValue(new Map())
    vi.mocked(listRefusedVersionsForConversation).mockResolvedValue([row()])

    const block = await buildReviewDecisionsBlock('conv-1', 'org_1')
    expect(block).not.toContain('user_reviewer')
  })

  it('asks for a bounded page, so the block cannot grow with the conversation', async () => {
    vi.mocked(listRefusedVersionsForConversation).mockResolvedValue([row()])
    await buildReviewDecisionsBlock('conv-1', 'org_1')
    expect(listRefusedVersionsForConversation).toHaveBeenCalledWith('conv-1', 'org_1', MAX_REVIEW_DECISIONS)
  })
})
