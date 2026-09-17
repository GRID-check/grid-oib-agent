import { describe, expect, it } from 'vitest'
import { filingReference } from '@/lib/conversations/draft-filing'

describe('filingReference — uniqueness after the bound', () => {
  it('keeps the short readable form', () => {
    expect(filingReference('conv-1', '/entwuerfe/Aktenvermerk Fluchtweg.md')).toBe(
      'conv-1-aktenvermerk-fluchtweg',
    )
  })

  it('bounds a long conversation id and keeps a hash suffix', () => {
    const ref = filingReference('c'.repeat(300), '/entwuerfe/a.md')
    expect(ref).toHaveLength(200)
    expect(ref).toMatch(/-[0-9a-f]{8}$/)
  })

  it('does not collide two long keys that share a truncated prefix', () => {
    const longId = 'c'.repeat(300)
    expect(filingReference(longId, '/entwuerfe/a.md')).not.toBe(
      filingReference(longId, '/entwuerfe/b.md'),
    )
  })

  it('treats path fringe as the same key', () => {
    expect(filingReference('conv-1', ' /entwuerfe/Aktenvermerk.md')).toBe(
      filingReference('conv-1', '/entwuerfe/Aktenvermerk.md'),
    )
  })
})
