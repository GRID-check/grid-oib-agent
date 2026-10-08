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
    const detail = {
      promptId: 'p-1',
      promptParentId: 'parent-1',
      promptInputType: 'choice',
      promptOptions: [
        { id: 'b', label: 'Nur Kern B' },
        { id: 'both', label: 'Beide Kerne' },
      ],
      promptPlaceholder: 'Welcher Kern?',
      promptFor: 'user_matthias',
    }
    expect(sanitizePromptDetail(detail)).toEqual(detail)
  })

  it('drops unknown keys, unknown input shapes and bare-string options, and caps the list', () => {
    const result = sanitizePromptDetail({
      promptInputType: 'radio',
      smuggled: 'x'.repeat(50_000),
      promptOptions: ['bare', ...Array.from({ length: 500 }, (_, n) => ({ id: `o${n}`, label: 'o'.repeat(5_000) }))],
    })

    expect(result).not.toHaveProperty('smuggled')
    expect(result).not.toHaveProperty('promptInputType')
    expect(result!.promptOptions).toHaveLength(31)
    expect(result!.promptOptions![0]!.label).toHaveLength(400)
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
