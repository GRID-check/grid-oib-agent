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
