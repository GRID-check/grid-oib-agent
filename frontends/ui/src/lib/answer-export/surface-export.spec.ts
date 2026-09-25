/**
 * A composed surface in a Word file (ADR-0065): a document has no tabs and no
 * columns, so every card the reader could open on screen is printed in order,
 * a tab's title set above its card. A variant missing from the file would read
 * as a finding the answer never made.
 */
import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries'
import { cardBlocks, cardsBlocks } from './cards'
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
  it('exports a Text tab as the prose would, its table a table', () => {
    const blocks = cardBlocks(
      {
        type: 'surface',
        components: [
          { id: 'root', component: 'Tabs', tabs: [{ title: 'Außentreppe', child: 'a' }, { title: 'Treppenhaus', child: 'b' }] },
          { id: 'a', component: 'Text', text: '| Kriterium | Status |\n|---|---|\n| Rauchabzug | offen |' },
          basis('b', 'REI 90.'),
        ],
      },
      t
    )
    expect(blocks.some((block) => block.kind === 'table')).toBe(true)
    expect(text(blocks)).toContain('Außentreppe')
    expect(text(blocks)).toContain('Rauchabzug | offen')
  })

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

  const PLACEHOLDER = 'In Piloti als Grafik dargestellt.'
  const mermaidTab = {
    type: 'surface',
    components: [
      { id: 'root', component: 'Tabs', tabs: [{ title: 'Ablauf', child: 'a' }] },
      { id: 'a', component: 'Text', text: '```mermaid\nflowchart TD\n  A[Bauanzeige] --> B{Vollständig?}\n```' },
    ],
  }

  it('prints a diagram in a Text tab as the format asks, like one in the prose', () => {
    // The PDF goes to a Behörde: the fence's source is noise on it, and the
    // placeholder the prose already honours must reach a tab too.
    const printed = text(cardsBlocks([mermaidTab], t, { diagramPlaceholder: PLACEHOLDER }))
    expect(printed).toContain(PLACEHOLDER)
    expect(printed).not.toContain('flowchart TD')
    // Without one (the Word file) the source is kept, as for the prose.
    expect(text(cardsBlocks([mermaidTab], t))).toContain('flowchart TD')
  })

  it('prints a diagram card as the format asks', () => {
    const diagram = { type: 'diagram', title: 'Ablauf', source: 'flowchart TD\n  A --> B' }
    const printed = text(cardsBlocks([diagram], t, { diagramPlaceholder: PLACEHOLDER }))
    expect(printed).toContain(PLACEHOLDER)
    expect(printed).not.toContain('flowchart TD')
  })

  it('sets a titled surface’s cards one level below its title', () => {
    const blocks = cardBlocks(
      { type: 'surface', title: 'Varianten', components: [{ id: 'root', component: 'Column', children: ['a'] }, basis('a', 'REI 60.')] },
      t
    )
    const headings = blocks.flatMap((block) => (block.kind === 'heading' ? [block.level] : []))
    expect(headings).toEqual([3, 4])
    // Without a title the cards stand at the answer's own card level.
    const untitled = cardBlocks({ type: 'surface', components: [{ id: 'root', component: 'Column', children: ['a'] }, basis('a', 'REI 60.')] }, t)
    expect(untitled.flatMap((block) => (block.kind === 'heading' ? [block.level] : []))).toEqual([3])
  })

  const levels = (blocks: DocBlock[]) =>
    blocks.flatMap((block) => (block.kind === 'heading' ? [[block.level, block.text] as const] : []))

  it('sets a tab’s title as a heading one level below the surface, its card one lower', () => {
    const tabbed = (title?: string) => ({
      type: 'surface',
      ...(title ? { title } : {}),
      components: [
        { id: 'root', component: 'Tabs', tabs: [{ title: 'GK 4', child: 'a' }] },
        basis('a', 'REI 60.'),
      ],
    })
    expect(levels(cardBlocks(tabbed('Varianten'), t))).toEqual([
      [3, 'Varianten'],
      [4, 'GK 4'],
      [5, 'Rechtsgrundlage'],
    ])
    expect(levels(cardBlocks(tabbed(), t))).toEqual([
      [3, 'GK 4'],
      [4, 'Rechtsgrundlage'],
    ])
  })

  it('keeps a Text leaf’s headings below the surface title', () => {
    const blocks = cardBlocks(
      {
        type: 'surface',
        title: 'Varianten',
        components: [
          { id: 'root', component: 'Column', children: ['x', 'a'] },
          { id: 'x', component: 'Text', text: 'A\n\n# Überblick\n\n## Detail\n\nB' },
          basis('a', 'REI 60.'),
        ],
      },
      t
    )
    expect(levels(blocks)).toEqual([
      [3, 'Varianten'],
      [4, 'Überblick'],
      [4, 'Detail'],
      [4, 'Rechtsgrundlage'],
    ])
  })
})
