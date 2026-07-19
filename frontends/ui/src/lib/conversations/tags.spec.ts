import { describe, it, expect } from 'vitest'
import {
  CONVERSATION_TAG_KEYS,
  isConversationTagKey,
  normalizeConversationTags,
} from './tags'

describe('conversation tags vocabulary', () => {
  it('recognises every key in the vocabulary', () => {
    for (const key of CONVERSATION_TAG_KEYS) {
      expect(isConversationTagKey(key)).toBe(true)
    }
  })

  it('rejects unknown keys', () => {
    expect(isConversationTagKey('unknown')).toBe(false)
    expect(isConversationTagKey('')).toBe(false)
  })

  it('keeps only known keys, lowercased and trimmed', () => {
    expect(normalizeConversationTags(['Brandschutz', ' schallschutz ', 'nope'])).toEqual([
      'brandschutz',
      'schallschutz',
    ])
  })

  it('de-duplicates while preserving first-seen order', () => {
    expect(normalizeConversationTags(['energie', 'statik', 'energie'])).toEqual(['energie', 'statik'])
  })

  it('returns an empty array for an all-unknown or empty input', () => {
    expect(normalizeConversationTags([])).toEqual([])
    expect(normalizeConversationTags(['foo', 'bar'])).toEqual([])
  })
})
