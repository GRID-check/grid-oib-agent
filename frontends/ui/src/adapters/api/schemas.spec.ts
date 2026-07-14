import { describe, expect, test } from 'vitest'
import { NATMessageType, NATSystemResponseMessageSchema, WebSocketMessageStatus } from './schemas'

describe('NATSystemResponseMessageSchema content union', () => {
  const base = {
    type: NATMessageType.SYSTEM_RESPONSE,
    status: WebSocketMessageStatus.COMPLETE,
  }

  test('GenerateResponse content ({output}) is preserved, not stripped to {}', () => {
    // Regression: SystemResponseContent has only optional fields and zod strips
    // unknown keys, so if it is tried first it matches {output: ...} and parses
    // to {} — silently discarding the response text.
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      content: { output: 'hello world' },
    })
    expect(parsed.content).toEqual({ output: 'hello world' })
  })

  test('SystemResponseContent ({text}) still parses to the text branch', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      content: { text: 'a shallow answer' },
    })
    expect(parsed.content).toEqual({ text: 'a shallow answer' })
  })

  test('string content still parses', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      content: 'plain string',
    })
    expect(parsed.content).toBe('plain string')
  })
})

describe('NATSystemResponseMessageSchema answer_confidence', () => {
  const base = {
    type: NATMessageType.SYSTEM_RESPONSE,
    status: WebSocketMessageStatus.COMPLETE,
    content: 'an answer',
  }

  test.each(['low', 'medium', 'high'] as const)('accepts %s', (level) => {
    const parsed = NATSystemResponseMessageSchema.parse({ ...base, answer_confidence: level })
    expect(parsed.answer_confidence).toBe(level)
  })

  test('omitted answer_confidence parses to undefined (backward compatible)', () => {
    const parsed = NATSystemResponseMessageSchema.parse(base)
    expect(parsed.answer_confidence).toBeUndefined()
  })

  test('rejects an invalid level', () => {
    expect(() =>
      NATSystemResponseMessageSchema.parse({ ...base, answer_confidence: 'certain' })
    ).toThrow()
  })
})
