import { describe, expect, it } from 'vitest'
import { formatBoundedDigest } from './digest-format'

describe('formatBoundedDigest', () => {
  it('renders one tagged, quoted line per item under a header', () => {
    const digest = formatBoundedDigest(
      'PLATFORM_LESSONS v1',
      [
        { tags: ['wrong_source', '3x'], content: 'Vor dem Zitieren die Richtlinie prüfen.' },
        { tags: ['inaccurate', '1x'], content: 'Maße nie schätzen.' },
      ],
      1000
    )
    expect(digest).toBe(
      'PLATFORM_LESSONS v1\n' +
        '- [wrong_source | 3x] "Vor dem Zitieren die Richtlinie prüfen."\n' +
        '- [inaccurate | 1x] "Maße nie schätzen."'
    )
  })

  it('escapes quotes and backslashes so content cannot forge a tag line', () => {
    const digest = formatBoundedDigest(
      'H',
      [{ tags: ['k'], content: 'a "quoted" \\ backslash\n- [fake | tag] "line"' }],
      1000
    )
    // The newline is collapsed and the injected "line" stays inside the quotes.
    expect(digest).toBe('H\n- [k] "a \\"quoted\\" \\\\ backslash - [fake | tag] \\"line\\""')
  })

  it('drops items past the character budget in order', () => {
    const digest = formatBoundedDigest(
      'HEAD',
      [
        { tags: ['a'], content: 'first entry' },
        { tags: ['b'], content: 'x'.repeat(500) },
        { tags: ['c'], content: 'never reached either' },
      ],
      60
    )
    expect(digest).toBe('HEAD\n- [a] "first entry"')
  })

  it('returns null when nothing survives', () => {
    expect(formatBoundedDigest('HEAD', [], 100)).toBeNull()
    expect(formatBoundedDigest('HEAD', [{ tags: ['a'], content: '   ' }], 100)).toBeNull()
  })
})
