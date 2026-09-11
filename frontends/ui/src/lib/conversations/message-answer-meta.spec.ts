import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ANSWER_KINDS,
  ANSWER_META_VERSION,
  CONTEXT_MAX_CHARS,
  TOPIC_MAX_CHARS,
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

  test('a summary longer than the gate was never a standfirst — dropped whole', () => {
    const meta = sanitizeAnswerMeta({ v: 1, summary: 'x'.repeat(321), verdict: fixture.verdict })
    expect(meta?.summary).toBeUndefined()
    expect(meta?.verdict).toBeDefined()
    // A summary alone is a valid payload — it is the near-universal field.
    expect(sanitizeAnswerMeta({ v: 1, summary: 'REI 60 in GK 4.' })).toEqual({
      v: 1,
      summary: 'REI 60 in GK 4.',
    })
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

  test('kind=ruling keeps the verdict', () => {
    expect(
      sanitizeAnswerMeta({ v: 1, kind: 'ruling', verdict: fixture.verdict }),
    ).toEqual({ v: 1, kind: 'ruling', verdict: fixture.verdict })
  })

  test('walkthrough, direct and handoff drop the verdict even if present', () => {
    for (const kind of ANSWER_KINDS.filter((k) => k !== 'ruling')) {
      expect(sanitizeAnswerMeta({ v: 1, kind, verdict: fixture.verdict })).toEqual({
        v: 1,
        kind,
      })
    }
  })

  test('legacy: no kind keeps the verdict', () => {
    const meta = sanitizeAnswerMeta({ v: 1, verdict: fixture.verdict })
    expect(meta?.kind).toBeUndefined()
    expect(meta?.verdict).toEqual(fixture.verdict)
  })

  test('an unknown kind is a walkthrough and drops the verdict', () => {
    const meta = sanitizeAnswerMeta({ v: 1, kind: 'essay', verdict: fixture.verdict })
    expect(meta).toEqual({ v: 1, kind: 'walkthrough' })
  })

  test('kind alone is a usable payload', () => {
    expect(sanitizeAnswerMeta({ v: 1, kind: 'walkthrough' })).toEqual({
      v: 1,
      kind: 'walkthrough',
    })
  })

  test('a topic longer than the gate was never a headline — dropped whole', () => {
    const meta = sanitizeAnswerMeta({
      v: 1,
      topic: 'x'.repeat(TOPIC_MAX_CHARS + 1),
      summary: 'REI 60 in GK 4.',
    })
    expect(meta?.topic).toBeUndefined()
    expect(meta?.summary).toBeDefined()
  })

  test('a topic at the gate survives verbatim, and alone is a usable payload', () => {
    const topic = 'x'.repeat(TOPIC_MAX_CHARS)
    expect(sanitizeAnswerMeta({ v: 1, topic })).toEqual({ v: 1, topic })
    expect(sanitizeAnswerMeta({ v: 1, topic: '  Geländerhöhe bei Balkonen  ' })).toEqual({
      v: 1,
      topic: 'Geländerhöhe bei Balkonen',
    })
  })

  test('a blank topic is not a topic', () => {
    expect(sanitizeAnswerMeta({ v: 1, topic: '   ' })).toBeNull()
  })

  test('a context longer than the gate was never a scope line — dropped whole', () => {
    const meta = sanitizeAnswerMeta({
      v: 1,
      topic: 'Geländerhöhe bei Balkonen',
      context: 'x'.repeat(CONTEXT_MAX_CHARS + 40),
    })
    expect(meta?.topic).toBeDefined()
    expect(meta?.context).toBeUndefined()
  })

  test('a context at the gate survives verbatim, and alone is a usable payload', () => {
    const context = 'x'.repeat(CONTEXT_MAX_CHARS)
    expect(sanitizeAnswerMeta({ v: 1, context })).toEqual({ v: 1, context })
    expect(sanitizeAnswerMeta({ v: 1, context: '  Neubau in GK 4.  ' })).toEqual({
      v: 1,
      context: 'Neubau in GK 4.',
    })
  })

  test('a future version keeps a topic and a context with its version stamp', () => {
    const meta = sanitizeAnswerMeta({
      v: 3,
      topic: 'Geländerhöhe bei Balkonen',
      context: 'Neubau in GK 4.',
    })
    expect(meta).toEqual({ v: 3, topic: 'Geländerhöhe bei Balkonen', context: 'Neubau in GK 4.' })
  })
})
