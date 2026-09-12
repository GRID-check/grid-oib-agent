/**
 * @vitest-environment node
 */

/**
 * `summaryDuplicatesBody` — the gate behind the masthead hiding a summary
 * that merely restates how the body opens.
 *
 * A pure module spec, deliberately: this is comparison logic, and logic that
 * lives in a render function costs a mount per case instead of a millisecond
 * (AGENTS.md).
 */

import { describe, expect, test } from 'vitest'
import { summaryDuplicatesBody } from './answer-meta-cards'

describe('summaryDuplicatesBody', () => {
  test('a verbatim restatement of the opening duplicates it', () => {
    expect(
      summaryDuplicatesBody('In GK 4 gilt REI 60.', 'In GK 4 gilt REI 60.\n\nMaßgeblich ist das Fluchtniveau.')
    ).toBe(true)
  })

  test('a citation-suffixed restatement still duplicates the opening', () => {
    // The backend is told to write `[2][3]` behind a claim, so either side
    // may carry the markers — both are stripped before the comparison.
    expect(summaryDuplicatesBody('In GK 4 gilt REI 60. [1]', 'In GK 4 gilt REI 60.')).toBe(true)
    expect(summaryDuplicatesBody('In GK 4 gilt REI 60.', 'In GK 4 gilt REI 60. [2][3]\n\nWeiter.')).toBe(
      true
    )
  })

  test('a citation glued to the first terminator is still the opening sentence', () => {
    // `REI 60.[1] Weitere Details.` — the first period is followed by a
    // marker, not whitespace. The sentence cut has to consume the marker
    // or the comparison swallows the next sentence and misses the duplicate.
    expect(
      summaryDuplicatesBody('In GK 4 gilt REI 60.', 'In GK 4 gilt REI 60.[1] Weitere Details.')
    ).toBe(true)
  })

  test('whitespace and case differences are not a second statement', () => {
    expect(
      summaryDuplicatesBody('  In  GK 4\ngilt REI 60. ', 'in gk 4 gilt rei 60.\n\nWeiter.')
    ).toBe(true)
  })

  test('a genuinely different summary is kept', () => {
    expect(
      summaryDuplicatesBody(
        'In GK 4 gilt REI 60; maßgeblich ist das Fluchtniveau.',
        'REI 60 gilt, und maßgeblich ist das Fluchtniveau.'
      )
    ).toBe(false)
  })

  test('a summary matching a later paragraph is not the opening restated', () => {
    expect(
      summaryDuplicatesBody('Maßgeblich ist das Fluchtniveau.', 'In GK 4 gilt REI 60.\n\nMaßgeblich ist das Fluchtniveau.')
    ).toBe(false)
  })

  test('absence on either side duplicates nothing', () => {
    expect(summaryDuplicatesBody(undefined, 'In GK 4 gilt REI 60.')).toBe(false)
    expect(summaryDuplicatesBody('In GK 4 gilt REI 60.', undefined)).toBe(false)
    expect(summaryDuplicatesBody('', 'In GK 4 gilt REI 60.')).toBe(false)
    expect(summaryDuplicatesBody('   ', 'In GK 4 gilt REI 60.')).toBe(false)
    expect(summaryDuplicatesBody('In GK 4 gilt REI 60.', '')).toBe(false)
  })
})
