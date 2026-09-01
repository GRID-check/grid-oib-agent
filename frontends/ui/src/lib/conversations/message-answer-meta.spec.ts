import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ANSWER_META_VERSION,
  VERDICT_VALUE_MAX_CHARS,
  sanitizeAnswerMeta,
} from './message-answer-meta'

/**
 * The Python↔TS crossing, pinned to one artifact: the backend's own gate wrote
 * this fixture (`tests/aiq_agent/common/test_answer_envelope.py` asserts it
 * still does), and this side asserts the sanitizer passes it through verbatim.
 * A renamed key or a moved cap on either side fails one of the two tests
 * instead of shipping green with the anatomy silently dropped.
 */
const FIXTURE_PATH = resolve(__dirname, '../../../../../tests/fixtures/answer_meta/wire_payload.json')

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, unknown>

describe('sanitizeAnswerMeta', () => {
  test('the backend-gated wire payload survives verbatim', () => {
    expect(sanitizeAnswerMeta(fixture)).toEqual(fixture)
  })

  test('nothing usable yields null, never an empty object', () => {
    expect(sanitizeAnswerMeta(undefined)).toBeNull()
    expect(sanitizeAnswerMeta('answer')).toBeNull()
    expect(sanitizeAnswerMeta({})).toBeNull()
    expect(sanitizeAnswerMeta({ v: 1 })).toBeNull()
  })

  test('a verdict longer than the gate was never a verdict — dropped whole', () => {
    const meta = sanitizeAnswerMeta({
      v: 1,
      verdict: { value: 'x'.repeat(VERDICT_VALUE_MAX_CHARS + 1), subject: 's' },
      callout: fixture.callout,
    })
    expect(meta?.verdict).toBeUndefined()
    expect(meta?.callout).toBeDefined()
  })

  test('a single takeaway is a sentence, not a block', () => {
    expect(sanitizeAnswerMeta({ v: 1, takeaways: [{ text: 'nur einer' }] })).toBeNull()
  })

  test('takeaways are capped at five', () => {
    const meta = sanitizeAnswerMeta({
      v: 1,
      takeaways: Array.from({ length: 8 }, (_, i) => ({ text: `Punkt ${i}` })),
    })
    expect(meta?.takeaways).toHaveLength(5)
  })

  test('an unknown callout kind is not a callout', () => {
    expect(sanitizeAnswerMeta({ v: 1, callout: { kind: 'warnung', text: 'x' } })).toBeNull()
  })

  test('a future version keeps its known fields and its version stamp', () => {
    // Additive evolution: a rollback must not blank what a newer writer stored.
    const meta = sanitizeAnswerMeta({ v: 3, verdict: fixture.verdict, hologram: { shiny: true } })
    expect(meta?.v).toBe(3)
    expect(meta?.verdict).toEqual(fixture.verdict)
    expect(meta && 'hologram' in meta).toBe(false)
  })

  test('a legacy payload without a stamp reads as version 1', () => {
    const meta = sanitizeAnswerMeta({ verdict: fixture.verdict })
    expect(meta?.v).toBe(ANSWER_META_VERSION)
  })
})
