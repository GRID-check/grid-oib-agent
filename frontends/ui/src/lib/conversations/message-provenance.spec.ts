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
    // 'medium', why a measured answer with an un-cited legal claim did not, and
    // why an answer whose only source was attached rather than cited did not.
    for (const reason of [
      'normative_claim_uncited',
      'measurement_only',
      'citation_fallback',
    ] as const) {
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

describe('the truncation flag survives storage', () => {
  it('keeps a real truncation on the way in', () => {
    // Dropped here, a reloaded conversation shows an answer whose search was
    // cut off as though it had run to the end — the record has to keep saying
    // what the live answer said.
    expect(sanitizeProvenance({ researchTruncated: true })).toEqual({ researchTruncated: true })
  })

  it('accepts nothing but literal true', () => {
    // Untrusted stored JSON, rendered to a reader as a statement about the
    // evidence: a stray truthy value must not become one.
    expect(sanitizeProvenance({ researchTruncated: 'yes' })).toBeNull()
    expect(sanitizeProvenance({ researchTruncated: 1 })).toBeNull()
    expect(sanitizeProvenance({ researchTruncated: false })).toBeNull()
  })
})

/**
 * The cutoff's cause and its cost, on the way into the column.
 *
 * These arrive as stable TOKENS and are the one part of the provenance the
 * reader is shown as words the frontend chose. So the column is where the
 * allow-list belongs: a token no build has a sentence for must not sit in a row
 * waiting for a renderer that will fall back to printing the key path.
 */
describe('why the run stopped, and what it cost', () => {
  it('keeps the cause beside the flag', () => {
    expect(
      sanitizeProvenance({ researchTruncated: true, truncationReason: 'wall_clock' })
    ).toEqual({ researchTruncated: true, truncationReason: 'wall_clock' })
    expect(sanitizeProvenance({ truncationReason: 'step_limit' })).toEqual({
      truncationReason: 'step_limit',
    })
  })

  it("refuses a cause outside the backend's own vocabulary", () => {
    expect(sanitizeProvenance({ truncationReason: 'because_it_felt_like_it' })).toBeNull()
    expect(sanitizeProvenance({ truncationReason: 42 })).toBeNull()
  })

  it('keeps the degradations, de-duplicated', () => {
    expect(
      sanitizeProvenance({
        degradedReasons: ['no_report_file', 'no_valid_citations', 'no_report_file'],
      })
    ).toEqual({ degradedReasons: ['no_report_file', 'no_valid_citations'] })
  })

  it('drops an unknown degradation without losing the ones beside it', () => {
    expect(sanitizeProvenance({ degradedReasons: ['quantum_flux', 'no_report_file'] })).toEqual({
      degradedReasons: ['no_report_file'],
    })
  })

  it('writes no key for an empty list — that is not a claim', () => {
    // "Degraded in zero ways" is the ordinary case. Stored as `[]` it becomes a
    // statement a later reader has to interpret, and the ordinary case is the
    // one that must cost nothing.
    expect(sanitizeProvenance({ degradedReasons: [] })).toBeNull()
    expect(sanitizeProvenance({ degradedReasons: ['quantum_flux'] })).toBeNull()
    expect(sanitizeProvenance({ degradedReasons: 'no_report_file' })).toBeNull()
  })
})

describe('the turn event on a stored step', () => {
  it('keeps the key and its values, bounded', () => {
    const result = sanitizeProvenance({
      thinkingSteps: [
        step({
          turnEvent: {
            key: 'status.retrieval.withQuery',
            values: { corpus: 'knowledge', query: 'Fluchtweglänge GK4' },
          },
        }),
      ],
    })
    expect(result!.thinkingSteps![0].turnEvent).toEqual({
      key: 'status.retrieval.withQuery',
      values: { corpus: 'knowledge', query: 'Fluchtweglänge GK4' },
    })
  })

  it('caps every string and the number of values, and drops a keyless event', () => {
    const values = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v'.repeat(500)]))
    const result = sanitizeProvenance({
      thinkingSteps: [
        step({ turnEvent: { key: 'x'.repeat(500), values } }),
        step({ id: 's2', turnEvent: { values: { query: 'no key' } } }),
        step({ id: 's3', turnEvent: 'not an object' }),
      ],
    })
    const [first, second, third] = result!.thinkingSteps!
    expect(first.turnEvent!.key).toHaveLength(64)
    expect(Object.keys(first.turnEvent!.values!)).toHaveLength(8)
    expect(first.turnEvent!.values!.k0).toHaveLength(64)
    expect(second).not.toHaveProperty('turnEvent')
    expect(third).not.toHaveProperty('turnEvent')
  })
})
