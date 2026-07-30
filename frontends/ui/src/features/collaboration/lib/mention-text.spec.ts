import { describe, expect, test } from 'vitest'

import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import {
  findMentionQuery,
  humanMentions,
  insertMention,
  reconcileMentions,
  splitMentionSegments,
  toMentionInputs,
  type DraftMention,
} from './mention-text'

const anna: DraftMention = { targetId: 'u-anna', display: 'Anna' }
const annaBerger: DraftMention = { targetId: 'u-anna-b', display: 'Anna Berger' }
const markus: DraftMention = { targetId: 'u-markus', display: 'Markus Hofer' }
const agent: DraftMention = { targetId: AGENT_MENTION_ID, display: 'Piloti' }

describe('findMentionQuery — the trigger', () => {
  test('fires on `@` at the start of the input', () => {
    expect(findMentionQuery('@', 1)).toEqual({ query: '', start: 0, end: 1 })
  })

  test('fires on `@` after whitespace and captures what follows as the query', () => {
    expect(findMentionQuery('Frage an @ann', 13)).toEqual({ query: 'ann', start: 9, end: 13 })
  })

  test('does not fire inside a word — an email address is not a mention', () => {
    expect(findMentionQuery('anna@example.com', 16)).toBeNull()
  })

  test('closes as soon as whitespace follows the fragment', () => {
    expect(findMentionQuery('@anna bitte', 11)).toBeNull()
  })

  test('is caret-relative, so it reopens on a fresh `@` later in the text', () => {
    const text = '@anna und @mar'
    expect(findMentionQuery(text, 5)).toEqual({ query: 'anna', start: 0, end: 5 })
    expect(findMentionQuery(text, 14)).toEqual({ query: 'mar', start: 10, end: 14 })
  })

  test('gives up on an over-long fragment instead of scanning a whole pasted line', () => {
    expect(findMentionQuery(`@${'x'.repeat(200)}`, 201)).toBeNull()
  })

  test('is null when there is no `@` before the caret', () => {
    expect(findMentionQuery('kein Treffer', 5)).toBeNull()
  })
})

describe('insertMention', () => {
  test('replaces the fragment with `@Display ` and reports the caret', () => {
    const range = findMentionQuery('Frage an @ann', 13)
    expect(range).not.toBeNull()
    expect(insertMention('Frage an @ann', range!, 'Anna Berger')).toEqual({
      text: 'Frage an @Anna Berger ',
      caret: 22,
    })
  })

  test('keeps the tail intact and does not double the space when one follows', () => {
    const text = 'Frage an @ann — passt das?'
    const range = findMentionQuery(text, 13)
    const result = insertMention(text, range!, 'Anna')
    expect(result.text).toBe('Frage an @Anna — passt das?')
    // Caret sits right after "@Anna"; the space that was already there is reused.
    expect(result.caret).toBe(14)
  })

  test('inserts at the caret when the trigger is a bare `@`', () => {
    const range = findMentionQuery('@', 1)
    expect(insertMention('@', range!, 'Piloti')).toEqual({ text: '@Piloti ', caret: 8 })
  })
})

describe('reconcileMentions — structured, never re-derived (MN-3)', () => {
  test('keeps a mention whose token still stands in the text', () => {
    expect(reconcileMentions('@Anna passt das?', [anna])).toEqual([anna])
  })

  test('drops a mention the user deleted from the text', () => {
    expect(reconcileMentions('passt das?', [anna])).toEqual([])
  })

  test('never invents a mention from text that only looks like a name', () => {
    // "@Markus Hofer" is typed but was never picked: it stays prose.
    expect(reconcileMentions('@Anna und @Markus Hofer', [anna])).toEqual([anna])
  })

  test('prefers the longest display when one is a prefix of another', () => {
    expect(reconcileMentions('@Anna Berger bitte', [anna, annaBerger])).toEqual([annaBerger])
  })

  test('keeps both when both tokens stand in the text', () => {
    expect(reconcileMentions('@Anna Berger und @Anna', [anna, annaBerger])).toEqual([
      annaBerger,
      anna,
    ])
  })

  test('returns mentions in text order, not insertion order', () => {
    expect(reconcileMentions('@Markus Hofer und @Anna', [anna, markus])).toEqual([markus, anna])
  })

  test('keeps one entry per occurrence when the same person is named twice', () => {
    expect(reconcileMentions('@Anna … und nochmal @Anna', [anna, anna])).toEqual([anna, anna])
  })

  test('never yields more entries than were recorded', () => {
    expect(reconcileMentions('@Anna @Anna @Anna', [anna])).toEqual([anna])
  })

  test('ignores a token that is not at a word boundary', () => {
    expect(reconcileMentions('mail@Anna.example', [anna])).toEqual([])
  })

  test('is a no-op for a message with no recorded mentions', () => {
    expect(reconcileMentions('@Anna', [])).toEqual([])
  })
})

describe('toMentionInputs / humanMentions', () => {
  test('collapses repeats to one addressee per person, in first-mentioned order', () => {
    expect(toMentionInputs([markus, anna, markus])).toEqual([
      { targetId: 'u-markus' },
      { targetId: 'u-anna' },
    ])
  })

  test('separates the assistant from the people', () => {
    expect(humanMentions([agent, anna])).toEqual([anna])
    expect(humanMentions([agent])).toEqual([])
  })
})

describe('splitMentionSegments — rendering', () => {
  test('splits prose around a mention token', () => {
    expect(splitMentionSegments('Hallo @Anna, passt das?', [anna])).toEqual([
      { kind: 'text', text: 'Hallo ' },
      { kind: 'mention', text: '@Anna', display: 'Anna', targetId: 'u-anna' },
      { kind: 'text', text: ', passt das?' },
    ])
  })

  test('renders only the message’s own mentions — lookalike text stays prose', () => {
    expect(splitMentionSegments('@Anna und @Fremde', [anna])).toEqual([
      { kind: 'mention', text: '@Anna', display: 'Anna', targetId: 'u-anna' },
      { kind: 'text', text: ' und @Fremde' },
    ])
  })

  test('prefers the longest display so the right person is highlighted', () => {
    expect(splitMentionSegments('@Anna Berger', [anna, annaBerger])).toEqual([
      { kind: 'mention', text: '@Anna Berger', display: 'Anna Berger', targetId: 'u-anna-b' },
    ])
  })

  test('handles a message without mentions and an empty message', () => {
    expect(splitMentionSegments('nur Text', [])).toEqual([{ kind: 'text', text: 'nur Text' }])
    expect(splitMentionSegments('', [anna])).toEqual([])
  })
})
