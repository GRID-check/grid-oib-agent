/**
 * @vitest-environment node
 */
/**
 * The cover says the report's title, in the report's characters.
 *
 * The WinAnsi wiring was checked on the body and not on the frame. An
 * independent pass pointed `branding.tsx` back at the library's raw `Text` and
 * every PDF spec stayed green — because nothing asserted a single string on the
 * cover, the running header or the footer.
 *
 * That frame is not decoration. The cover title is the report's own lifted
 * heading, i.e. model-written German about an Austrian building regulation, and
 * `RunningHeader` reprints it on every page. A comparator or an `Ø` in it is
 * exactly the silent corruption the transliteration exists to stop, multiplied
 * by the page count.
 *
 * Asserted on the element tree, not the bytes: a PDF's content streams are
 * deflate-compressed, so grepping the buffer proves nothing about the text.
 */

import React from 'react'
import { describe, expect, it } from 'vitest'
import { CoverContent, RunningHeader } from './branding'

/**
 * Every string in a rendered tree, in document order.
 *
 * The union in the parameter is what calling a component directly hands back:
 * React 19 types a function component as returning `ReactNode |
 * Promise<ReactNode>`, because a server component may be async. Nothing here
 * is — `@react-pdf` cannot render a promise — so the narrowing is stated once,
 * at the top of the walk.
 */
const strings = (
  node: React.ReactNode | Promise<React.ReactNode>,
  out: string[] = []
): string[] => {
  React.Children.forEach(node as React.ReactNode, (child) => {
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

describe('the frame is transliterated like the body', () => {
  it('renders a comparator in the cover title as <=', () => {
    const rendered = strings(
      CoverContent({ cover: { title: 'Fluchtweglänge ≤ 40 m', facts: [] } } as never)
    ).join(' ')
    expect(rendered).toContain('<= 40 m')
    expect(rendered).not.toContain('≤')
    // The specific corruption: WinAnsi prints U+2264 as the letter `d`.
    expect(rendered).not.toContain('d 40 m')
  })

  it('renders a comparator in the running header, which repeats on every page', () => {
    const rendered = strings(RunningHeader({ title: 'Auftritt ≥ 27 cm' } as never)).join(' ')
    expect(rendered).toContain('>= 27 cm')
    expect(rendered).not.toContain('≥')
  })

  it('leaves ordinary German prose on the cover exactly as written', () => {
    const prose = 'Prüfung der Gebäudeklasse für Größe und Türbreite'
    const rendered = strings(
      CoverContent({ cover: { title: prose, facts: [] } } as never)
    ).join(' ')
    expect(rendered).toContain(prose)
  })
})
