/**
 * `mergeMessageMetadata` is what keeps two clients from erasing each other's
 * card decisions. Each client PATCHes the whole `cardInteractions` map IT knows
 * about, so a plain top-level merge lets the second overwrite the first — which
 * resurrects a settled card and re-invites the duplicate write the whole
 * mechanism exists to prevent (ADR-0030).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const selectedRow = vi.hoisted(() => ({ current: null as unknown }))
const updateSpy = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (selectedRow.current ? [selectedRow.current] : []) }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updateSpy(values)
        return { where: () => ({ returning: async () => [{ id: 'm1', ...values }] }) }
      },
    }),
  }),
}))

import { mergeMessageMetadata } from './repository'

const DECIDED_AT = '2026-07-28T09:00:00.000Z'

describe('mergeMessageMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectedRow.current = null
  })

  it('returns null when the message is not in that conversation', async () => {
    expect(await mergeMessageMetadata('conv_1', 'm1', { cardInteractions: {} })).toBeNull()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('preserves the metadata keys it is not patching', async () => {
    selectedRow.current = {
      id: 'm1',
      metadata: { messageType: 'agent_response', cards: [{ type: 'memory_proposal' }] },
    }

    await mergeMessageMetadata('conv_1', 'm1', {
      cardInteractions: { 'memory_proposal-0': { decision: 'savedOrg', decidedAt: DECIDED_AT } },
    })

    expect(updateSpy.mock.calls[0][0].metadata).toEqual({
      messageType: 'agent_response',
      cards: [{ type: 'memory_proposal' }],
      cardInteractions: { 'memory_proposal-0': { decision: 'savedOrg', decidedAt: DECIDED_AT } },
    })
  })

  it('replaces a listed key wholesale when it is NOT deep-merged', async () => {
    selectedRow.current = { id: 'm1', metadata: { cardInteractions: { a: 1 } } }

    await mergeMessageMetadata('conv_1', 'm1', { cardInteractions: { b: 2 } })

    expect(updateSpy.mock.calls[0][0].metadata.cardInteractions).toEqual({ b: 2 })
  })

  it('deep-merges a listed key entry-by-entry, keeping decisions the writer never saw', async () => {
    selectedRow.current = {
      id: 'm1',
      metadata: {
        cardInteractions: { 'memory_proposal-0': { decision: 'savedOrg', decidedAt: DECIDED_AT } },
      },
    }

    await mergeMessageMetadata(
      'conv_1',
      'm1',
      {
        cardInteractions: {
          'project_profile_patch-1': { decision: 'rejected', decidedAt: DECIDED_AT },
        },
      },
      ['cardInteractions'],
    )

    expect(updateSpy.mock.calls[0][0].metadata.cardInteractions).toEqual({
      'memory_proposal-0': { decision: 'savedOrg', decidedAt: DECIDED_AT },
      'project_profile_patch-1': { decision: 'rejected', decidedAt: DECIDED_AT },
    })
  })

  it('lets the newer write win for the SAME card key', async () => {
    // Per-entry last-writer-wins is correct: one card is decided once.
    selectedRow.current = {
      id: 'm1',
      metadata: { cardInteractions: { 'memory_proposal-0': { decision: 'dismissed', decidedAt: DECIDED_AT } } },
    }

    await mergeMessageMetadata(
      'conv_1',
      'm1',
      { cardInteractions: { 'memory_proposal-0': { decision: 'savedOrg', decidedAt: DECIDED_AT } } },
      ['cardInteractions'],
    )

    expect(updateSpy.mock.calls[0][0].metadata.cardInteractions).toEqual({
      'memory_proposal-0': { decision: 'savedOrg', decidedAt: DECIDED_AT },
    })
  })

  it('tolerates a null metadata column', async () => {
    selectedRow.current = { id: 'm1', metadata: null }

    await mergeMessageMetadata('conv_1', 'm1', { cardInteractions: { a: 1 } }, ['cardInteractions'])

    expect(updateSpy.mock.calls[0][0].metadata).toEqual({ cardInteractions: { a: 1 } })
  })
})
