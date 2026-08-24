/**
 * @vitest-environment node
 */
/**
 * Whether a reader gets a document.
 *
 * Two kinds of assertion, because there are two kinds of failure.
 *
 * The first is that nothing arrives: react-pdf throws at LAYOUT time, not at
 * element-construction time, so a style it does not understand, an SVG
 * primitive it cannot draw or a `Text` nested where it may not be produces a
 * 500 from the endpoint and no file at all. That is what the `renderToBuffer`
 * cases are for — they run the whole engine, over every block kind and every
 * run flag the vocabulary defines, plus a body assembled by the card
 * shape-walker, which is the code path this exporter exists to reuse.
 *
 * The second is that the document arrives but says the wrong thing. Those are
 * asserted against `blockNodes`, on the element tree, rather than against the
 * bytes: a rendered PDF's content streams are deflate-compressed, so grepping
 * the buffer for a heading proves only that the deflater was not in the mood.
 */

import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { describe, expect, it } from 'vitest'
import type { DocBlock } from '@/lib/answer-export/blocks'
import { cardsBlocks } from '@/lib/answer-export/cards'
import { getDictionary } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
import { BlocksDocument, blockNodes } from './blocks-to-pdf'

const t = createTranslator(getDictionary('en'), 'answerExport')

/** Every block kind and every run flag `blocks.ts` defines, in one body. */
const EVERY_BLOCK: DocBlock[] = [
  { kind: 'heading', level: 1, text: 'Fluchtwege und Ausgänge' },
  { kind: 'heading', level: 2, text: 'Beurteilung' },
  { kind: 'heading', level: 3, text: 'Gebäudeklasse 4' },
  {
    kind: 'paragraph',
    runs: [
      { text: 'Höchstens ', bold: true },
      { text: '40 m', italic: true },
      { text: ' bis zum Ausgang, siehe https://www.ris.bka.gv.at/ oib-2.pdf.' },
      { text: ' GlobalId ', mono: true },
    ],
  },
  { kind: 'paragraph', runs: [{ text: 'OIB-Richtlinie 2, Ausgabe 2023' }], style: 'meta' },
  { kind: 'paragraph', runs: [{ text: 'Wie lang darf der Fluchtweg sein?' }], style: 'quote' },
  { kind: 'paragraph', runs: [{ text: 'const a = 1\nconst b = 2', mono: true }] },
  { kind: 'bullets', items: [[{ text: 'Erster Punkt' }], [{ text: 'Zweiter Punkt' }]] },
  { kind: 'rule' },
  {
    kind: 'table',
    head: ['Position', 'Ist', 'Soll', 'Beurteilung'],
    rows: [
      [[{ text: 'Fluchtweglänge' }], [{ text: '38 m' }], [{ text: '≤ 40 m' }], [{ text: 'erfüllt' }]],
      // Deliberately short: the renderer must pad it to the column count.
      [[{ text: 'Türbreite' }], [{ text: '0,9 m' }]],
    ],
  },
  { kind: 'table', rows: [[[{ text: 'Gebäudeklasse' }], [{ text: '4' }]]] },
  {
    kind: 'paragraph',
    runs: [
      { text: '[3] ', bold: true },
      { text: 'OIB-RL 2 — Brandschutz\nhttps://www.oib.or.at/de/richtlinie-2' },
    ],
  },
]

/**
 * A body built by the card walker, not by hand.
 *
 * The point of this exporter is that it renders the ~40 card types without
 * knowing any of them, so the spec must not hand-write the blocks a card
 * produces: it runs `cardsBlocks` over real stored card shapes and prints
 * whatever comes out. A card with a check, a card with an array of objects, a
 * card with a reference and a quoted excerpt, and a live card that carries no
 * values at all — the four shapes the walker dispatches on.
 */
const CARD_BLOCKS = cardsBlocks(
  [
    {
      type: 'stair_diagram',
      title: 'Haupttreppe',
      riser_count: 17,
      riser_height: { label: 'Steigung', value: 18.2, required: 18, unit: 'cm', comparator: '≤', status: 'warning', provenance: 'computed', tolerance: 0.5 },
      tread_depth: { label: 'Auftritt', value: 28, required: 27, unit: 'cm', comparator: '≥', status: 'pass' },
      comfort_note: 'Schrittmaßregel 2s + a = 63 cm eingehalten.',
      reference: { document: 'OIB-RL 4', section: 'Pkt. 2.2', edition: '2023' },
    },
    {
      type: 'requirement_checklist',
      title: 'Anforderungen',
      items: [
        { label: 'Handlauf beidseitig', status: 'pass', detail: 'ab 1,50 m Laufbreite' },
        { label: 'Podest je 18 Stufen', status: 'needs_input' },
      ],
      note: 'Geprüft gegen die Landesbauordnung.',
    },
    {
      type: 'legal_basis',
      law: 'OIB-Richtlinie 4',
      article: 'Pkt. 2.2',
      reference: {
        document: 'OIB-RL 4',
        section: 'Pkt. 2.2',
        excerpt: 'Treppen müssen eine nutzbare Laufbreite von mindestens 1,20 m aufweisen.',
      },
    },
    { type: 'ifc_viewer', title: 'Modellansicht', note: 'Treppenlauf EG–OG1' },
  ],
  t
)

const COVER = {
  title: 'Fluchtwege und Ausgänge — OIB-Richtlinie 2',
  facts: [
    { label: 'Project', value: 'Wohnhaus Seestadt, Bauteil C' },
    { label: 'Created on', value: '19 August 2026' },
  ],
}

/** Every `Text` string in a react element tree, in document order. */
const textsIn = (node: React.ReactNode, found: string[] = []): string[] => {
  if (typeof node === 'string') found.push(node)
  else if (typeof node === 'number') found.push(String(node))
  else if (Array.isArray(node)) node.forEach((child) => textsIn(child, found))
  else if (React.isValidElement(node)) {
    textsIn((node.props as { children?: React.ReactNode }).children, found)
  }
  return found
}

/** Depth-first list of elements, so a spec can look at what was drawn. */
const elementsIn = (node: React.ReactNode, found: React.ReactElement[] = []): React.ReactElement[] => {
  if (Array.isArray(node)) node.forEach((child) => elementsIn(child, found))
  else if (React.isValidElement(node)) {
    found.push(node)
    elementsIn((node.props as { children?: React.ReactNode }).children, found)
  }
  return found
}

describe('rendering a document', () => {
  it('produces a PDF for every block kind and run flag the vocabulary defines', async () => {
    const buffer = await renderToBuffer(<BlocksDocument cover={COVER} blocks={EVERY_BLOCK} />)

    // "%PDF-" — the header every reader sniffs for before it opens anything.
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(buffer.length).toBeGreaterThan(1000)
  })

  it('produces a PDF for a body the card shape-walker assembled', async () => {
    // The blocks are not hand-written: whatever `cards.ts` emits for these four
    // card shapes has to lay out, or the day a new card type ships the export
    // 500s instead of printing it.
    expect(CARD_BLOCKS.length).toBeGreaterThan(0)

    const buffer = await renderToBuffer(<BlocksDocument cover={COVER} blocks={CARD_BLOCKS} />)

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('lays out a document long enough to paginate', async () => {
    // The footer's page numbers and the fixed running header are only exercised
    // once there is a second page to repeat them onto.
    const long: DocBlock[] = Array.from({ length: 90 }, (_, index) => ({
      kind: 'paragraph',
      runs: [{ text: `Absatz ${index}: ${'Fluchtweg '.repeat(24)}` }],
    }))

    const buffer = await renderToBuffer(<BlocksDocument cover={COVER} blocks={long} />)

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('renders an empty body rather than refusing one', async () => {
    // A cards-only answer whose prose was empty still has a cover to print.
    const buffer = await renderToBuffer(<BlocksDocument cover={COVER} blocks={[]} />)

    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})

describe('the shapes the renderer reads off a block', () => {
  it('gives a reference entry its marker as a chip, without repeating it in the text', () => {
    const nodes = blockNodes([
      { kind: 'paragraph', runs: [{ text: '[3] ', bold: true }, { text: 'OIB-RL 2' }] },
    ])

    const texts = textsIn(nodes)
    expect(texts).toContain('3')
    // The bold `[3] ` run became the chip; leaving it in the body as well would
    // print the marker twice.
    expect(texts.some((text) => text.includes('[3]'))).toBe(false)
    expect(texts).toContain('OIB-RL 2')
  })

  it('keeps a bracketed number in running prose as prose', () => {
    const nodes = blockNodes([
      { kind: 'paragraph', runs: [{ text: 'Siehe [3] und [4].' }] },
    ])

    expect(textsIn(nodes)).toContain('Siehe [3] und [4].')
  })

  it('pads a short table row to the column count', () => {
    const nodes = blockNodes([
      {
        kind: 'table',
        head: ['A', 'B', 'C'],
        rows: [[[{ text: 'nur eine' }]]],
      },
    ])

    // Three header cells and three body cells: a row left short would stretch
    // its one value across the columns and file it under the wrong heading.
    const texts = textsIn(nodes)
    expect(texts.filter((text) => ['A', 'B', 'C'].includes(text))).toHaveLength(3)
    expect(texts).toContain('nur eine')
  })

  it('makes an address in run text a real link', () => {
    const nodes = blockNodes([
      { kind: 'paragraph', runs: [{ text: 'Quelle: https://www.oib.or.at/rl2.pdf.' }] },
    ])

    const links = elementsIn(nodes).filter(
      (element) => (element.props as { src?: string }).src !== undefined
    )
    expect(links).toHaveLength(1)
    // The sentence's full stop is not part of the address.
    expect((links[0].props as { src: string }).src).toBe('https://www.oib.or.at/rl2.pdf')
  })

  it('unwraps a markdown link left in a written sources entry', () => {
    const nodes = blockNodes([
      { kind: 'paragraph', runs: [{ text: '[OIB-RL 2](https://www.oib.or.at/rl2.pdf), S. 18' }] },
    ])

    const links = elementsIn(nodes).filter(
      (element) => (element.props as { src?: string }).src !== undefined
    )
    expect(links).toHaveLength(1)
    expect((links[0].props as { src: string }).src).toBe('https://www.oib.or.at/rl2.pdf')
    expect(textsIn(nodes)).toContain('OIB-RL 2')
    expect(textsIn(nodes)).toContain(', S. 18')
  })

  it('renders one node per block, for every kind', () => {
    expect(blockNodes(EVERY_BLOCK)).toHaveLength(EVERY_BLOCK.length)
    // Nothing silently dropped: a kind with no branch would be `undefined`.
    expect(blockNodes(EVERY_BLOCK).every((node) => node !== undefined)).toBe(true)
  })
})
