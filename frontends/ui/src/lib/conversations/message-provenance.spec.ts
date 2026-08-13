/**
 * @vitest-environment node
 */
/**
 * The bound on what a client may write into a message's jsonb column (ADR-0037).
 *
 * This is the only thing between an untrusted browser payload and the database, so
 * what these tests pin is that it is a WHITELIST — unknown keys dropped, unions
 * checked, strings capped, arrays truncated — and not a cast.
 */
import { describe, expect, it } from 'vitest'

import { sanitizeProvenance } from './message-provenance'

const step = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  userMessageId: 'm1',
  functionName: 'oib_lookup',
  displayName: 'OIB-Richtlinie durchsucht',
  category: 'tools',
  timestamp: '2026-07-30T09:00:00.000Z',
  isComplete: true,
  ...overrides,
})

describe('sanitizeProvenance', () => {
  it('keeps the fields the reasoning surface renders', () => {
    const result = sanitizeProvenance({
      thinkingSteps: [step()],
      answerConfidence: 'high',
      answerConfidenceReason: 'Zwei übereinstimmende Quellen.',
      routingDecision: 'shallow',
      routingReason: 'Direkte Normfrage.',
      citationsRemoved: { count: 2, reasons: ['ungrounded', 'duplicate'] },
      deepResearchJobId: 'job_1',
      showViewReport: true,
    })

    expect(result).toEqual({
      thinkingSteps: [
        {
          id: 's1',
          userMessageId: 'm1',
          functionName: 'oib_lookup',
          displayName: 'OIB-Richtlinie durchsucht',
          category: 'tools',
          timestamp: '2026-07-30T09:00:00.000Z',
          isComplete: true,
        },
      ],
      answerConfidence: 'high',
      answerConfidenceReason: 'Zwei übereinstimmende Quellen.',
      routingDecision: 'shallow',
      routingReason: 'Direkte Normfrage.',
      citationsRemoved: { count: 2, reasons: ['ungrounded', 'duplicate'] },
      deepResearchJobId: 'job_1',
      showViewReport: true,
    })
  })

  it('drops everything it does not know about', () => {
    // The whole point: a client cannot smuggle a field — or a payload — into the
    // column by naming it something new.
    const result = sanitizeProvenance({
      answerConfidence: 'high',
      somethingNew: 'x'.repeat(10_000),
      thinkingSteps: [step({ content: 'x'.repeat(100_000), rawPayload: 'y'.repeat(100_000) })],
    })

    expect(result).not.toHaveProperty('somethingNew')
    expect(result!.thinkingSteps![0]).not.toHaveProperty('content')
    expect(result!.thinkingSteps![0]).not.toHaveProperty('rawPayload')
  })

  it('rejects values outside the closed unions rather than storing them', () => {
    const result = sanitizeProvenance({
      answerConfidence: 'extremely-high',
      routingDecision: 'sideways',
      answerConfidenceCappedReason: 'because',
    })

    expect(result).toBeNull()
  })

  it('stores the measurement-grounding cap reasons', () => {
    // Persisted so a reopened thread still explains why a measured answer sat at
    // 'medium', and why a measured answer with an un-cited legal claim did not.
    for (const reason of ['normative_claim_uncited', 'measurement_only'] as const) {
      const result = sanitizeProvenance({ answerConfidenceCappedReason: reason })
      expect(result!.answerConfidenceCappedReason).toBe(reason)
    }
  })

  it('caps reasons and truncates the step list', () => {
    const result = sanitizeProvenance({
      answerConfidenceReason: 'a'.repeat(5_000),
      routingReason: 'b'.repeat(5_000),
      escalationReason: 'c'.repeat(5_000),
      thinkingSteps: Array.from({ length: 500 }, (_, index) => step({ id: `s${index}` })),
    })

    expect(result!.answerConfidenceReason).toHaveLength(600)
    expect(result!.routingReason).toHaveLength(600)
    expect(result!.escalationReason).toHaveLength(600)
    expect(result!.thinkingSteps).toHaveLength(200)
  })

  it('bounds citationsRemoved, and coerces its count', () => {
    const result = sanitizeProvenance({
      citationsRemoved: {
        count: 3.7,
        reasons: Array.from({ length: 100 }, () => 'r'.repeat(500)),
      },
    })

    expect(result!.citationsRemoved!.count).toBe(3)
    expect(result!.citationsRemoved!.reasons).toHaveLength(20)
    expect(result!.citationsRemoved!.reasons[0]).toHaveLength(120)
  })

  it('never lets a negative count through — it is rendered as a number of things', () => {
    const result = sanitizeProvenance({ citationsRemoved: { count: -5, reasons: [] } })
    expect(result!.citationsRemoved!.count).toBe(0)
  })

  it('drops a step with no identity, which nothing could render or key', () => {
    const result = sanitizeProvenance({
      thinkingSteps: [step(), { displayName: 'orphan' }, step({ id: '', userMessageId: 'm1' })],
    })
    expect(result!.thinkingSteps).toHaveLength(1)
  })

  it('accepts a Date timestamp as well as an ISO string', () => {
    // The store holds Dates; JSON turns them into strings at exactly one boundary,
    // and being strict here would silently drop the whole Herleitung if that
    // boundary ever moved.
    const result = sanitizeProvenance({
      thinkingSteps: [step({ timestamp: new Date('2026-07-30T09:00:00.000Z') })],
    })
    expect(result!.thinkingSteps![0].timestamp).toBe('2026-07-30T09:00:00.000Z')
  })

  it('returns null for anything with nothing usable in it', () => {
    expect(sanitizeProvenance(null)).toBeNull()
    expect(sanitizeProvenance('nope')).toBeNull()
    expect(sanitizeProvenance([])).toBeNull()
    expect(sanitizeProvenance({})).toBeNull()
    expect(sanitizeProvenance({ thinkingSteps: [] })).toBeNull()
  })
})
