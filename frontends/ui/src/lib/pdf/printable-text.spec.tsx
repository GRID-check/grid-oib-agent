/**
 * @vitest-environment node
 */
/**
 * The comparator survives the trip to the page.
 *
 * `printable()` has its own unit tests, and they pass whether or not anything
 * calls it. This file asserts the wiring instead, because the wiring is what
 * was actually missing: the transliteration table shipped complete and correct,
 * imported by nobody, while `≤ 40 m` still rendered as `d 40 m`.
 *
 * The assertions walk the element tree rather than the rendered bytes, for the
 * reason `blocks-to-pdf.spec.tsx` gives: a PDF's content streams are
 * deflate-compressed, so grepping the buffer proves nothing about the text.
 */

import React from 'react'
import { describe, expect, it } from 'vitest'
import type { DocBlock } from '@/lib/answer-export/blocks'
import { blockNodes } from './blocks-to-pdf'

/** Every string in a rendered tree, in document order. */
const strings = (node: React.ReactNode, out: string[] = []): string[] => {
  React.Children.forEach(node, (child) => {
    if (typeof child === 'string') out.push(child)
    else if (React.isValidElement(child)) {
      const rendered =
        typeof child.type === 'function'
          ? (child.type as (p: unknown) => React.ReactNode)(child.props)
          : (child.props as { children?: React.ReactNode }).children
      strings(rendered, out)
    }
  })
  return out
}

const textOf = (blocks: DocBlock[]): string => strings(blockNodes(blocks)).join(' ')

describe('the comparator reaches the page as a comparator', () => {
  it('renders ≤ as <=, not as the letter WinAnsi would print', () => {
    const rendered = textOf([
      { kind: 'paragraph', runs: [{ text: 'Fluchtweglänge ≤ 40 m' }] },
    ])
    expect(rendered).toContain('<= 40 m')
    // The specific silent corruption this exists to prevent: `≤` encoded as
    // WinAnsi 0x64 prints the letter `d` beside a still-correct number.
    expect(rendered).not.toContain('d 40 m')
    expect(rendered).not.toContain('≤')
  })

  it('renders ≥ as >=', () => {
    expect(textOf([{ kind: 'paragraph', runs: [{ text: 'Auftritt ≥ 27 cm' }] }])).toContain(
      '>= 27 cm'
    )
  })

  it('transliterates inside table cells, where the checks actually live', () => {
    const rendered = textOf([
      {
        kind: 'table',
        head: ['Position', 'Soll'],
        rows: [[[{ text: 'Fluchtweglänge' }], [{ text: '≤ 40 m' }]]],
      },
    ])
    expect(rendered).toContain('<= 40 m')
    expect(rendered).not.toContain('≤')
  })

  it('leaves ordinary German prose exactly as written', () => {
    // The umlauts and the ß are IN WinAnsi; rewriting them would be damage.
    const prose = 'Für Gebäude der Größe muß die Tür schließen'
    expect(textOf([{ kind: 'paragraph', runs: [{ text: prose }] }])).toContain(prose)
  })
})

describe('a link label is prose too', () => {
  it('transliterates inside a markdown link label', () => {
    // The gap the first pass left: `Text` was wrapped and `Link` was not, so a
    // comparator inside a LABEL printed corrupted while the identical text one
    // word earlier came out right. Model-written source lists and card fields
    // reach the renderer with raw `[label](url)` in the run text, so this shape
    // is ordinary, not exotic.
    const rendered = textOf([
      {
        kind: 'paragraph',
        runs: [{ text: 'Siehe [OIB-RL 2 \u2264 40 m Regel](https://example.org/oib) fuer Details.' }],
      },
    ])
    expect(rendered).toContain('<= 40 m')
    expect(rendered).not.toContain('\u2264')
    expect(rendered).not.toContain('d 40 m')
  })

  it('leaves the href alone', () => {
    // An address is machinery, not prose. Transliterating a character inside it
    // would break the link rather than the glyph.
    const nodes = blockNodes([
      { kind: 'paragraph', runs: [{ text: 'Siehe [Regel](https://example.org/a\u2264b) hier.' }] },
    ])
    const hrefs: string[] = []
    const walk = (node: React.ReactNode): void => {
      React.Children.forEach(node, (child) => {
        if (!React.isValidElement(child)) return
        const props = child.props as { src?: string; children?: React.ReactNode }
        if (typeof props.src === 'string') hrefs.push(props.src)
        walk(props.children)
      })
    }
    walk(nodes)
    expect(hrefs.some((href) => href.includes('\u2264'))).toBe(true)
  })
})
