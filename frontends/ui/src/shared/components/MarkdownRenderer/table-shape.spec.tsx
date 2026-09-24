/**
 * What only a whole table can say, drawn: the tally of a check, one Fundstelle
 * for every row as a caption, and each cell's column for the phone layout.
 */
import { render, screen } from '@/test-utils'
import { describe, expect, it } from 'vitest'

import { MarkdownRenderer } from './MarkdownRenderer'
import { parseTally } from './table-shape'

const CHECK = [
  '| Kriterium | Konzept | Status | Fundstelle |',
  '|---|---|---|---|',
  '| Stützen | R 90 | erfüllt | [1] |',
  '| Kellerdecke | R 90 | teilweise | [1] |',
  '| Trennwände | REI 60 | nicht erfüllt | [1] |',
  '| Dachdecke | — | erfüllt | [1] |',
].join('\n')

describe('an answer table', () => {
  it('tallies a Status column above the rows', () => {
    render(<MarkdownRenderer content={CHECK} />)
    expect(screen.getByTestId('status-tally').textContent).toContain('2 erfüllt')
    expect(screen.getByTestId('status-tally').textContent).toContain('1 nicht erfüllt')
  })

  it('lifts a Fundstelle every row shares into one caption', () => {
    const { container } = render(<MarkdownRenderer content={CHECK} />)
    expect(container.querySelectorAll('th')).toHaveLength(3)
    expect(container.querySelector('caption')?.textContent).toMatch(/Fundstelle.*\[1\]|Fundstelle.*1/)
  })

  it('keeps a Fundstelle column whose rows differ', () => {
    const mixed = CHECK.replace('| Dachdecke | — | erfüllt | [1] |', '| Dachdecke | — | erfüllt | [2] |')
    const { container } = render(<MarkdownRenderer content={mixed} />)
    expect(container.querySelectorAll('th')).toHaveLength(4)
    expect(container.querySelector('caption')).toBeNull()
  })

  it('labels every cell with its column and marks a wide table for stacking', () => {
    const { container } = render(<MarkdownRenderer content={CHECK} />)
    expect(container.querySelector('table')).toHaveAttribute('data-stack', 'true')
    const labels = [...container.querySelectorAll('tbody tr:first-child td')].map((td) => td.getAttribute('data-label'))
    expect(labels).toEqual(['Kriterium', 'Konzept', 'Status'])
  })

  it('leaves a two-column table and a table without a status alone', () => {
    const { container } = render(<MarkdownRenderer content={'| Lage | Wert |\n|---|---|\n| a | 1 |\n| b | 2 |'} />)
    expect(container.querySelector('table')).not.toHaveAttribute('data-stack')
    expect(screen.queryByTestId('status-tally')).toBeNull()
  })

  it('reads a tally back, words with spaces included', () => {
    expect(parseTally('erfüllt:2,nicht erfüllt:1')).toEqual([
      ['erfüllt', 2],
      ['nicht erfüllt', 1],
    ])
    expect(parseTally(undefined)).toEqual([])
  })
})

describe('what live answers wrote into their tables', () => {
  it('drops the trailing citation a row’s Fundstelle already carries', () => {
    const table = [
      '| Teil | Geltungsbereich | Fundstelle |',
      '|---|---|---|',
      '| RL 2 | Gebäude allgemein [1] | [1] |',
      '| RL 2.1 | Betriebsbauten [2] | [2] |',
    ].join('\n')
    const { container } = render(<MarkdownRenderer content={table} />)
    const cells = [...container.querySelectorAll('tbody td')].map((td) => td.textContent)
    expect(cells).toEqual(['RL 2', 'Gebäude allgemein', '[1]', 'RL 2.1', 'Betriebsbauten', '[2]'])
  })

  it('keeps a citation the Fundstelle does not carry', () => {
    const table = '| Teil | Gilt für | Fundstelle |\n|---|---|---|\n| a | x [3] | [1] |\n| b | y | [2] |'
    const { container } = render(<MarkdownRenderer content={table} />)
    expect(container.querySelector('tbody td:nth-child(2)')?.textContent).toBe('x [3]')
  })

  it('stacks a table whose cells hold sentences at every width', () => {
    const sentence = 'Die Treppe besteht aus A2 und wird so angeordnet, dass sie im Brandfall nicht durch Flammen, Strahlungswärme oder Rauch beeinträchtigt wird; Lage und Abstände zu Fassadenöffnungen gehören in die Pläne.'
    const table = `| Variante | Nachweis |\n|---|---|\n| Außentreppe | ${sentence} |\n| Treppenhaus | REI 60 |`
    const { container } = render(<MarkdownRenderer content={table} />)
    expect(container.querySelector('table')).toHaveAttribute('data-stack', 'always')
  })
})

describe('a stacked row’s labels', () => {
  it('sets long column names above their values', () => {
    const table =
      '| Nachweis | Was darzustellen bzw. zu belegen ist | Fundstelle |\n|---|---|---|\n| a | b | [1] |\n| c | d | [2] |'
    const { container } = render(<MarkdownRenderer content={table} />)
    expect(container.querySelector('table')).toHaveAttribute('data-labels', 'above')
  })

  it('keeps short ones beside them', () => {
    const { container } = render(<MarkdownRenderer content={CHECK} />)
    expect(container.querySelector('table')).not.toHaveAttribute('data-labels')
  })
})
