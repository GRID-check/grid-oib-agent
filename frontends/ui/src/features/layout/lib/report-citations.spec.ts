import { describe, test, expect } from 'vitest'
import {
  splitReportSources,
  linkifyCitationMarkers,
  REPORT_SOURCE_ANCHOR_PREFIX,
} from './report-citations'

describe('splitReportSources', () => {
  test('extracts a trailing "## Sources" section with numbered entries', () => {
    const markdown = [
      '# Report',
      '',
      'Fire safety duties differ by class [1].',
      '',
      '## Sources',
      '1. OIB Richtlinie 2 — https://oib.or.at/ri2',
      '2. RIS Bauordnung — https://ris.bka.gv.at',
    ].join('\n')

    const result = splitReportSources(markdown)

    expect(result.heading).toBe('Sources')
    expect(result.entries).toEqual([
      { number: 1, markdown: 'OIB Richtlinie 2 — https://oib.or.at/ri2' },
      { number: 2, markdown: 'RIS Bauordnung — https://ris.bka.gv.at' },
    ])
    expect(result.body).not.toContain('## Sources')
    expect(result.body).toContain('Fire safety duties differ by class [1].')
  })

  test('recognizes the German "## Quellen" heading and [N] entry markers', () => {
    const markdown = ['Text [1].', '', '## Quellen', '[1] OIB RL 2'].join('\n')

    const result = splitReportSources(markdown)

    expect(result.heading).toBe('Quellen')
    expect(result.entries).toEqual([{ number: 1, markdown: 'OIB RL 2' }])
  })

  test('merges wrapped continuation lines into the previous entry', () => {
    const markdown = [
      '## Sources',
      '1. A very long source title',
      '   https://example.com/long-url',
    ].join('\n')

    const result = splitReportSources(markdown)

    expect(result.entries).toEqual([
      { number: 1, markdown: 'A very long source title https://example.com/long-url' },
    ])
  })

  test('returns the report unchanged when there is no sources heading', () => {
    const markdown = '# Report\n\nBody [1].'

    const result = splitReportSources(markdown)

    expect(result.body).toBe(markdown)
    expect(result.heading).toBeNull()
    expect(result.entries).toEqual([])
  })

  test('returns the report unchanged when the heading has no numbered entries', () => {
    const markdown = '# Report\n\n## Sources\n\nNo numbered list here.'

    const result = splitReportSources(markdown)

    expect(result.body).toBe(markdown)
    expect(result.entries).toEqual([])
  })

  test('ignores a "## Sources" line inside a fenced code block', () => {
    const markdown = ['```md', '## Sources', '1. fake', '```', '', 'Body text.'].join('\n')

    const result = splitReportSources(markdown)

    expect(result.entries).toEqual([])
    expect(result.body).toBe(markdown)
  })

  test('stops collecting entries at the next heading', () => {
    const markdown = [
      '## Sources',
      '1. Real source',
      '## Appendix',
      '2. Not a source',
    ].join('\n')

    const result = splitReportSources(markdown)

    expect(result.entries).toEqual([{ number: 1, markdown: 'Real source' }])
    expect(result.body).toContain('## Appendix')
    expect(result.body).toContain('2. Not a source')
  })

  test('parses leading origin tokens into sourceKind and strips them from the text', () => {
    const markdown = [
      '## Sources',
      '[1] [KB] OIB-Richtlinie 2, p.3',
      '[2] [Web] Example — https://example.com',
      '[3] [RIS] BauO — https://www.ris.bka.gv.at/eli/bgbl/1985/446',
    ].join('\n')

    const result = splitReportSources(markdown)

    expect(result.entries).toEqual([
      { number: 1, markdown: 'OIB-Richtlinie 2, p.3', sourceKind: 'kb' },
      { number: 2, markdown: 'Example — https://example.com', sourceKind: 'web' },
      {
        number: 3,
        markdown: 'BauO — https://www.ris.bka.gv.at/eli/bgbl/1985/446',
        sourceKind: 'ris',
      },
    ])
  })

  test('matches origin tokens case-insensitively', () => {
    const markdown = ['## Sources', '1. [web] lower — https://example.com'].join('\n')

    const result = splitReportSources(markdown)

    expect(result.entries).toEqual([
      { number: 1, markdown: 'lower — https://example.com', sourceKind: 'web' },
    ])
  })

  test('leaves entries without an origin token unlabeled (backward compatible)', () => {
    // Older reports and replays predate the token; sourceKind must be undefined
    // and the display text must be preserved verbatim.
    const markdown = ['## Sources', '1. OIB Richtlinie 2 — https://oib.or.at/ri2'].join('\n')

    const result = splitReportSources(markdown)

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].sourceKind).toBeUndefined()
    expect(result.entries[0].markdown).toBe('OIB Richtlinie 2 — https://oib.or.at/ri2')
  })

  test('does not treat a non-origin bracket token as a source kind', () => {
    const markdown = ['## Sources', '1. [2024] Annual outlook — https://example.com'].join('\n')

    const result = splitReportSources(markdown)

    expect(result.entries[0].sourceKind).toBeUndefined()
    expect(result.entries[0].markdown).toBe('[2024] Annual outlook — https://example.com')
  })
})

describe('linkifyCitationMarkers', () => {
  const valid = new Set([1, 2, 3])

  test('turns [N] into an in-page anchor link', () => {
    const result = linkifyCitationMarkers('Duties differ [1] and [2].', valid)

    expect(result).toBe(
      `Duties differ [\\[1\\]](#${REPORT_SOURCE_ANCHOR_PREFIX}1) and [\\[2\\]](#${REPORT_SOURCE_ANCHOR_PREFIX}2).`
    )
  })

  test('ignores numbers without a matching source entry', () => {
    const result = linkifyCitationMarkers('See [1] and [9].', new Set([1]))

    expect(result).toContain(`[\\[1\\]](#${REPORT_SOURCE_ANCHOR_PREFIX}1)`)
    expect(result).toContain('[9].')
    expect(result).not.toContain(`#${REPORT_SOURCE_ANCHOR_PREFIX}9`)
  })

  test('leaves [N] inside fenced code blocks alone', () => {
    const markdown = ['See [1].', '```', 'array[1] = x // [2]', '```', 'And [2].'].join('\n')

    const result = linkifyCitationMarkers(markdown, valid)

    expect(result).toContain(`[\\[1\\]](#${REPORT_SOURCE_ANCHOR_PREFIX}1)`)
    expect(result).toContain('array[1] = x // [2]')
    expect(result).toContain(`[\\[2\\]](#${REPORT_SOURCE_ANCHOR_PREFIX}2)`)
  })

  test('leaves [N] inside inline code spans alone', () => {
    const result = linkifyCitationMarkers('Use `items[1]` for access [1].', valid)

    expect(result).toContain('`items[1]`')
    expect(result).toContain(`access [\\[1\\]](#${REPORT_SOURCE_ANCHOR_PREFIX}1).`)
  })

  test('does not rewrite existing markdown link syntax', () => {
    expect(linkifyCitationMarkers('[1](https://example.com)', valid)).toBe(
      '[1](https://example.com)'
    )
    expect(linkifyCitationMarkers('[text][1]', valid)).toBe('[text][1]')
  })

  test('skips documents that declare numeric link-reference definitions', () => {
    const markdown = 'See [1].\n\n[1]: https://example.com'

    expect(linkifyCitationMarkers(markdown, valid)).toBe(markdown)
  })

  test('returns input unchanged for empty input or empty number set', () => {
    expect(linkifyCitationMarkers('', valid)).toBe('')
    expect(linkifyCitationMarkers('See [1].', new Set())).toBe('See [1].')
  })
})
