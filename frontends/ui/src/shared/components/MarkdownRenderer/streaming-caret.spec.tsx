/**
 * Where the streaming caret goes: after the last word of the block being
 * written, inside it, so no block gives up its display to trail it.
 */
import { render } from '@/test-utils'
import { describe, expect, it } from 'vitest'

import { MarkdownRenderer } from './MarkdownRenderer'

const CARET = <span data-testid="caret" />

const caretIn = (content: string, isStreaming = true) => {
  const { container } = render(<MarkdownRenderer content={content} isStreaming={isStreaming} caret={CARET} />)
  const caret = container.querySelector('[data-testid="caret"]')
  return { container, caret, host: caret?.parentElement?.parentElement ?? null }
}

describe('the streaming caret', () => {
  it('follows the last word of a paragraph, inside it', () => {
    const { host, container } = caretIn('Erste Zeile.\n\nDer zweite Absatz wird gerade')
    expect(host?.tagName).toBe('P')
    expect(host?.textContent).toBe('Der zweite Absatz wird gerade')
    expect(container.querySelectorAll('[data-testid="caret"]')).toHaveLength(1)
  })

  it('follows bold text the stream is writing, with the veil allowed', () => {
    const { caret } = caretIn('Das ist **wichtig')
    expect(caret?.parentElement).toHaveAttribute('data-caret-after', 'text')
  })

  it('says when it follows markup with a ground of its own, for the veil to stand aside', () => {
    const { caret } = caretIn('Der Wert `REI 90`')
    expect(caret?.parentElement).toHaveAttribute('data-caret-after', 'markup')
  })

  it('goes into the last item of a list, nested lists included', () => {
    expect(caretIn('- eins\n- zwei').host?.tagName).toBe('LI')
    const nested = caretIn('- eins\n  - innen')
    expect(nested.host?.tagName).toBe('LI')
    expect(nested.host?.textContent).toBe('innen')
  })

  it('goes into a heading being written', () => {
    expect(caretIn('Text.\n\n## Brandschutz').host?.tagName).toBe('H2')
  })

  it('goes into the last cell written into, not the empty cells GFM pads a row with', () => {
    const { host } = caretIn('| A | B | C |\n|---|---|---|\n| eins | zwei | drei |\n| vier')
    expect(host?.tagName).toBe('TD')
    expect(host?.textContent).toBe('vier')
  })

  it('is absent when the text ends in a code block', () => {
    expect(caretIn('Text.\n\n```ts\nconst a = 1').caret).toBeNull()
  })

  it('is absent once the text has arrived', () => {
    expect(caretIn('Fertig.', false).caret).toBeNull()
  })

  it('sits in the last block only: the blocks above keep their DOM', () => {
    const first = `${'Ein langer Absatz. '.repeat(80)}`
    const { container } = caretIn(`${first}\n\nDer neue Absatz`)
    const paragraphs = container.querySelectorAll('p')
    expect(paragraphs[0]!.querySelector('[data-testid="caret"]')).toBeNull()
    expect(paragraphs[paragraphs.length - 1]!.querySelector('[data-testid="caret"]')).not.toBeNull()
  })

  it('leaves no wrapper of its own in layout', () => {
    const { caret } = caretIn('Ein Satz')
    expect(caret?.parentElement).toHaveClass('contents')
  })
})
