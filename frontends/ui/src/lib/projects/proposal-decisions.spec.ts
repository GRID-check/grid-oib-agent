/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/conversations/repository', () => ({
  listRecentMessagesWithCardDecisions: vi.fn(),
}))

import { listRecentMessagesWithCardDecisions } from '@/lib/conversations/repository'
import { buildProposalDecisionsBlock, composeMemoryContext } from './proposal-decisions'

const patchCard = {
  type: 'project_profile_patch',
  title: 'Projektkontext aktualisieren: Fluchtniveau',
  rationale: 'r',
  patch: [{ op: 'replace', path: '/fluchtniveau', value: '4' }],
  preview: [{ label: 'Fluchtniveau', before: '3', after: '4' }],
}
const noteCard = {
  type: 'memory_proposal',
  title: 'Merken',
  content: 'Atrium wird als OIB 2.3 behandelt.',
  kind: 'decision',
  confidence: 'high',
}

beforeEach(() => {
  vi.mocked(listRecentMessagesWithCardDecisions).mockReset()
})

describe('buildProposalDecisionsBlock', () => {
  it('renders each decision with its verdict, in the card\'s own words, newest first', async () => {
    vi.mocked(listRecentMessagesWithCardDecisions).mockResolvedValue([
      {
        createdAt: new Date('2026-09-01T10:00:00Z'),
        metadata: {
          cards: [patchCard, noteCard],
          cardInteractions: {
            'project_profile_patch-0': { decision: 'rejected', decidedAt: '2026-09-01T10:05:00.000Z' },
            'memory_proposal-1': { decision: 'savedProject', decidedAt: '2026-09-01T10:06:00.000Z' },
          },
        },
      },
    ])
    const block = await buildProposalDecisionsBlock('proj-1', 'org-1')
    expect(block).toBe(
      [
        'PROPOSAL_DECISIONS v1',
        '- [angenommen | Notiz | 2026-09-01] "Atrium wird als OIB 2.3 behandelt."',
        '- [abgelehnt | Profil | 2026-09-01] "Projektkontext aktualisieren: Fluchtniveau (Fluchtniveau: 3 → 4)"',
      ].join('\n'),
    )
    expect(listRecentMessagesWithCardDecisions).toHaveBeenCalledWith('proj-1', 'org-1', 40)
  })

  it('is null when nothing was decided, and ignores interactions with no card behind them', async () => {
    vi.mocked(listRecentMessagesWithCardDecisions).mockResolvedValue([
      { createdAt: new Date(), metadata: { cards: [], cardInteractions: { 'project_profile_patch-3': { decision: 'rejected' } } } },
      { createdAt: new Date(), metadata: { cardInteractions: 'garbage' } },
    ])
    expect(await buildProposalDecisionsBlock('proj-1', 'org-1')).toBeNull()
  })
})

describe('composeMemoryContext', () => {
  it('joins the digest and the decisions, and is null when both are empty', () => {
    expect(composeMemoryContext('PROJECT_MEMORY v1\n- x', 'PROPOSAL_DECISIONS v1\n- y')).toBe(
      'PROJECT_MEMORY v1\n- x\n\nPROPOSAL_DECISIONS v1\n- y',
    )
    expect(composeMemoryContext(null, 'PROPOSAL_DECISIONS v1\n- y')).toBe('PROPOSAL_DECISIONS v1\n- y')
    expect(composeMemoryContext(null, null)).toBeNull()
  })
})
