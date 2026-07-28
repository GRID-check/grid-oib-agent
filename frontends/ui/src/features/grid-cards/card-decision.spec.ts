import { describe, expect, it } from 'vitest'
import type { GridCard } from '@/shared/cards/schemas'
import {
  cardKey,
  isCardDecision,
  reconcileCardInteractions,
  sanitizeCardInteractions,
} from './card-decision'

describe('cardKey', () => {
  it('identifies a card by its type and position in the message', () => {
    expect(cardKey({ type: 'memory_proposal' }, 0)).toBe('memory_proposal-0')
    expect(cardKey({ type: 'project_profile_patch' }, 2)).toBe('project_profile_patch-2')
  })

  it('separates two cards of the same type in one message', () => {
    expect(cardKey({ type: 'memory_proposal' }, 0)).not.toBe(cardKey({ type: 'memory_proposal' }, 1))
  })
})

describe('isCardDecision', () => {
  it('accepts the closed union', () => {
    for (const decision of ['accepted', 'rejected', 'savedOrg', 'savedProject', 'dismissed']) {
      expect(isCardDecision(decision)).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isCardDecision('pending')).toBe(false)
    expect(isCardDecision('')).toBe(false)
    expect(isCardDecision(undefined)).toBe(false)
    expect(isCardDecision({ decision: 'accepted' })).toBe(false)
  })
})

describe('reconcileCardInteractions', () => {
  const decided = (key: string) => ({
    [key]: { decision: 'accepted' as const, decidedAt: '2026-07-28T09:00:00.000Z' },
  })

  const memory = (content: string) =>
    ({
      type: 'memory_proposal',
      title: 'Merken?',
      content,
      kind: 'preference',
      confidence: 'high',
    }) as unknown as GridCard

  const summary = () => ({ type: 'summary', title: 'Überblick' }) as unknown as GridCard

  it('keeps a decision when the card at that index is unchanged', () => {
    const cards = [summary(), memory('REI 90')]
    expect(reconcileCardInteractions(decided('memory_proposal-1'), cards, [...cards])).toEqual(
      decided('memory_proposal-1'),
    )
  })

  it('drops a decision when a card is inserted ahead of the answered one', () => {
    // A streaming answer replaces `message.cards` wholesale; without this the
    // recorded key would point at a DIFFERENT card.
    const before = [memory('REI 90')]
    const after = [summary(), memory('REI 90')]
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, after)).toBeUndefined()
  })

  it('drops a decision when the same card TYPE at that index carries a different proposal', () => {
    // The critical case: same type, same index, different content. Carrying
    // "accepted" over would mark a proposal the user never saw as decided.
    const before = [memory('REI 90')]
    const after = [memory('REI 60')]
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, after)).toBeUndefined()
  })

  it('drops a decision whose card disappeared entirely', () => {
    const before = [memory('REI 90')]
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, [summary()])).toBeUndefined()
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, [])).toBeUndefined()
    expect(reconcileCardInteractions(decided('memory_proposal-0'), before, undefined)).toBeUndefined()
    expect(reconcileCardInteractions(decided('memory_proposal-0'), undefined, before)).toBeUndefined()
  })

  it('keeps only the still-valid subset, at their ORIGINAL indices', () => {
    const interactions = {
      ...decided('memory_proposal-0'),
      'summary-1': { decision: 'rejected' as const, decidedAt: '2026-07-28T09:00:00.000Z' },
    }
    const before = [memory('REI 90'), summary()]
    // Index 0 unchanged, index 1 replaced → only index 0's decision survives.
    const after = [memory('REI 90'), memory('etwas anderes')]
    expect(reconcileCardInteractions(interactions, before, after)).toEqual(decided('memory_proposal-0'))
  })

  it('is a no-op when nothing was decided', () => {
    expect(reconcileCardInteractions(undefined, [memory('x')], [memory('x')])).toBeUndefined()
  })
})

describe('sanitizeCardInteractions', () => {
  it('keeps well-formed entries', () => {
    const raw = {
      'memory_proposal-0': { decision: 'savedOrg', decidedAt: '2026-07-28T09:00:00.000Z' },
    }
    expect(sanitizeCardInteractions(raw)).toEqual(raw)
  })

  it('drops entries whose decision is not in the union', () => {
    // A message row written by a future/foreign build must never smuggle an
    // unknown lifecycle state into the renderer.
    const clean = sanitizeCardInteractions({
      'memory_proposal-0': { decision: 'exfiltrated', decidedAt: '2026-07-28T09:00:00.000Z' },
      'memory_proposal-1': { decision: 'dismissed', decidedAt: '2026-07-28T09:00:00.000Z' },
    })
    expect(clean).toEqual({
      'memory_proposal-1': { decision: 'dismissed', decidedAt: '2026-07-28T09:00:00.000Z' },
    })
  })

  it('substitutes a missing or non-string timestamp rather than dropping the decision', () => {
    const clean = sanitizeCardInteractions({ 'x-0': { decision: 'accepted' } })
    expect(clean?.['x-0'].decision).toBe('accepted')
    expect(typeof clean?.['x-0'].decidedAt).toBe('string')
  })

  it('returns undefined for non-objects and for input with nothing usable', () => {
    expect(sanitizeCardInteractions(undefined)).toBeUndefined()
    expect(sanitizeCardInteractions(null)).toBeUndefined()
    expect(sanitizeCardInteractions('accepted')).toBeUndefined()
    expect(sanitizeCardInteractions([{ decision: 'accepted' }])).toBeUndefined()
    expect(sanitizeCardInteractions({})).toBeUndefined()
    expect(sanitizeCardInteractions({ 'x-0': { decision: 'nope' } })).toBeUndefined()
  })
})
