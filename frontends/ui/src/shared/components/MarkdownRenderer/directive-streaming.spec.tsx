/**
 * A directive block while it streams: drawn as it arrives, never cut.
 *
 * The renderer parses a long answer block by block (`markdown-blocks.ts`),
 * cutting at a blank line once a block is long enough. A cut inside an open
 * `:::check` would end the block there, and the rows after the cut would be
 * parsed apart from their table, so they were lost. The splitter reads the
 * dialect's one fence scanner (`directiveDepths`) and never cuts inside.
 */
import { render } from '@/test-utils'
import { describe, expect, it } from 'vitest'

import { holdHalfDirective, MarkdownRenderer } from './MarkdownRenderer'
import { splitMarkdownBlocks } from './markdown-blocks'

const ROWS = 25

/** A long check, with blank lines around it and a long paragraph before, so the splitter wants to cut. */
const LONG_CHECK = [
  'Einleitung. '.repeat(120).trim(),
  '',
  ':::check',
  '| Anforderung | Ist | Soll | Stand |',
  '|---|---|---|---|',
  ...Array.from({ length: ROWS }, (_, i) => `| Kriterium ${i + 1} | ${50 + i} dB | ≥ 50 dB | erfüllt |`),
  '',
  ':::',
  '',
  'Schluss. '.repeat(160).trim(),
].join('\n')

describe('a long :::check', () => {
  it('is never cut by the block splitter', () => {
    const blocks = splitMarkdownBlocks(LONG_CHECK, 200)
    expect(blocks).not.toBeNull()
    const holding = blocks!.filter((block) => block.source.includes(':::check'))
    expect(holding).toHaveLength(1)
    expect(holding[0].source).toContain(`Kriterium ${ROWS} `)
  })

  it('loses no row at any streamed prefix, and never draws fewer rows than before', () => {
    const { container, rerender } = render(<MarkdownRenderer content="" isStreaming />)
    const lines = LONG_CHECK.split('\n')
    let previous = 0
    for (let end = 1; end <= lines.length; end++) {
      const prefix = lines.slice(0, end).join('\n')
      rerender(<MarkdownRenderer content={prefix} isStreaming />)
      const rows = container.querySelectorAll('tbody tr').length
      const written = lines.slice(0, end).filter((line) => /^\| Kriterium /.test(line)).length
      expect(rows).toBeGreaterThanOrEqual(previous)
      // Every row written so far is drawn, as soon as the delimiter row is there.
      if (end > 5) expect(rows).toBe(written)
      previous = rows
    }
    rerender(<MarkdownRenderer content={LONG_CHECK} />)
    // All passing, but the reader was reading it: the table stays open when
    // the stream ends, so the page does not shrink under them.
    expect(container.querySelectorAll('tbody tr')).toHaveLength(ROWS)
    expect(container.textContent).not.toContain(`${ROWS} of ${ROWS} met`)
    // Loaded as final, it collapses to its tally.
    const { container: loaded } = render(<MarkdownRenderer content={LONG_CHECK} />)
    expect(loaded.textContent).toContain(`${ROWS} of ${ROWS} met`)
  })

  it('does not hold a half-written last row to its limit, nor tally, while it streams', () => {
    const table = [':::check', '| Anforderung | Ist | Soll | Stand |', '|---|---|---|---|', '| A | 57 dB | ≥ 55 dB | erfüllt |']
    const { container } = render(<MarkdownRenderer content={[...table, '| B | 38 m | ≤ 4'].join('\n')} isStreaming />)
    const rows = container.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[1].textContent).not.toContain('not met')
    expect(container.querySelector('[data-testid="status-tally"]')).toBeNull()
    // …but holds its line, so the tally fades in where the rows already are.
    expect(container.querySelector('[data-testid="status-tally-reserve"]')).not.toBeNull()
  })
})

describe('holdHalfDirective', () => {
  it('holds a fence line being typed, and an inline label not yet closed', () => {
    expect(holdHalfDirective('Text\n::')).toBe('Text\n')
    expect(holdHalfDirective('Text\n:::details[Was es br')).toBe('Text\n')
    expect(holdHalfDirective('Klasse :energy-class[A')).toBe('Klasse ')
    expect(holdHalfDirective('Text\n:::cases{by=escape_le')).toBe('Text\n')
    expect(holdHalfDirective('In :project[building_cl')).toBe('In ')
  })

  it('keeps a closer of an open block, a complete opener, and plain text', () => {
    expect(holdHalfDirective(':::check\n| a |\n:::')).toBe(':::check\n| a |\n:::')
    expect(holdHalfDirective('Text\n:::check')).toBe('Text\n:::check')
    expect(holdHalfDirective('Text\n:::cases{by=escape_level_m}')).toBe('Text\n:::cases{by=escape_level_m}')
    expect(holdHalfDirective('Um 10:30')).toBe('Um 10:30')
  })
})
