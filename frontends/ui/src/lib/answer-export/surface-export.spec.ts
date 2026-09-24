/**
 * A composed surface in a Word file (ADR-0065): a document has no tabs and no
 * columns, so every card the reader could open on screen is printed in order,
 * a tab's title set above its card. A variant missing from the file would read
 * as a finding the answer never made.
 */
import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries'
import { cardBlocks } from './cards'
import type { DocBlock } from './blocks'

const t = (key: string): string =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], de.answerExport) as string

const text = (blocks: DocBlock[]): string =>
  blocks
    .map((block) =>
      block.kind === 'heading'
        ? block.text
        : block.kind === 'paragraph'
          ? block.runs.map((run) => run.text).join('')
          : block.kind === 'table'
            ? block.rows.map((row) => row.map((cell) => cell.map((run) => run.text).join('')).join(' | ')).join('\n')
            : ''
    )
    .join('\n')

const basis = (id: string, summary: string) => ({ id, component: 'legal_basis', law: 'OIB-Richtlinie 2', summary })

describe('a surface in the export', () => {
  it('prints every tab, its title above its card, in tab order', () => {
    const blocks = cardBlocks(
      {
        type: 'surface',
        title: 'Tragende Bauteile nach Gebäudeklasse',
        components: [
          { id: 'root', component: 'Tabs', tabs: [{ title: 'GK 4', child: 'a' }, { title: 'GK 5', child: 'b' }] },
          basis('b', 'In GK 5 verlangen tragende Bauteile R 90.'),
          basis('a', 'In GK 4 genügt REI 60.'),
        ],
      },
      t
    )
    const printed = text(blocks)
    expect(printed).toContain('Tragende Bauteile nach Gebäudeklasse')
    const order = ['GK 4', 'In GK 4 genügt REI 60.', 'GK 5', 'In GK 5 verlangen tragende Bauteile R 90.']
    const positions = order.map((needle) => printed.indexOf(needle))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('walks nested rows and columns, and prints a component nothing reaches not at all', () => {
    const blocks = cardBlocks(
      {
        type: 'surface',
        components: [
          { id: 'root', component: 'Column', children: ['row', 'c'] },
          { id: 'row', component: 'Row', children: ['a', 'b'] },
          basis('a', 'Erste.'),
          basis('b', 'Zweite.'),
          basis('c', 'Dritte.'),
          basis('stray', 'Unerreichbar.'),
        ],
      },
      t
    )
    const printed = text(blocks)
    expect(printed.indexOf('Erste.')).toBeLessThan(printed.indexOf('Zweite.'))
    expect(printed.indexOf('Zweite.')).toBeLessThan(printed.indexOf('Dritte.'))
    expect(printed).not.toContain('Unerreichbar.')
  })
})
