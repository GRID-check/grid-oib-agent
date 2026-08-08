/**
 * @vitest-environment node
 */
/**
 * The bound on a human-in-the-loop prompt's stored shape (ADR-0037).
 *
 * Same reasoning as `sanitizeProvenance`: this is a client payload landing in a
 * jsonb column, and the option list in particular is an array from a browser.
 */
import { describe, expect, it } from 'vitest'

import { sanitizePromptDetail, sanitizePromptState } from './message-prompt'

describe('sanitizePromptDetail', () => {
  it('keeps the fields the card renders, including who was asked', () => {
    expect(
      sanitizePromptDetail({
        promptType: 'choice',
        promptId: 'p-1',
        promptParentId: 'parent-1',
        promptInputType: 'radio',
        promptOptions: ['Nur Kern B', 'Beide Kerne'],
        promptPlaceholder: 'Welcher Kern?',
        promptFor: 'user_matthias',
      }),
    ).toEqual({
      promptType: 'choice',
      promptId: 'p-1',
      promptParentId: 'parent-1',
      promptInputType: 'radio',
      promptOptions: ['Nur Kern B', 'Beide Kerne'],
      promptPlaceholder: 'Welcher Kern?',
      promptFor: 'user_matthias',
    })
  })

  it('drops unknown keys and caps the option list', () => {
    const result = sanitizePromptDetail({
      promptType: 'choice',
      smuggled: 'x'.repeat(50_000),
      promptOptions: Array.from({ length: 500 }, () => 'o'.repeat(5_000)),
    })

    expect(result).not.toHaveProperty('smuggled')
    expect(result!.promptOptions).toHaveLength(32)
    expect(result!.promptOptions![0]).toHaveLength(400)
  })

  it('returns null when there is nothing usable', () => {
    expect(sanitizePromptDetail(null)).toBeNull()
    expect(sanitizePromptDetail({})).toBeNull()
    expect(sanitizePromptDetail([])).toBeNull()
    expect(sanitizePromptDetail({ promptOptions: [] })).toBeNull()
  })
})

describe('sanitizePromptState', () => {
  it('keeps the answer but never the client-supplied instant', () => {
    const result = sanitizePromptState({ response: 'Beide Kerne', respondedAt: '2001-01-01T00:00:00.000Z' })
    expect(result!.response).toBe('Beide Kerne')
    // A backdated decision would reorder a shared transcript — the server stamps it.
    expect(result!.respondedAt).not.toBe('2001-01-01T00:00:00.000Z')
    expect(Date.parse(result!.respondedAt)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'))
  })

  it('stamps an instant when the client omitted one', () => {
    const result = sanitizePromptState({ response: 'ja' })
    expect(result!.response).toBe('ja')
    expect(new Date(result!.respondedAt).toString()).not.toBe('Invalid Date')
  })

  it('rejects an empty answer — that is still a question, not a decision', () => {
    expect(sanitizePromptState({ response: '' })).toBeNull()
    expect(sanitizePromptState({})).toBeNull()
    expect(sanitizePromptState(null)).toBeNull()
  })

  it('caps a long answer', () => {
    expect(sanitizePromptState({ response: 'a'.repeat(99_999) })!.response).toHaveLength(4_000)
  })
})
