/**
 * @vitest-environment node
 *
 * Run against the REAL parser, with the same plugins the renderer uses. The
 * defect these replace was in the interaction between bracket syntax and a
 * rewrite that guessed at it, so a test that stubbed the parse would have
 * agreed with the bug.
 */
import { describe, test, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Node, Parent } from 'unist'
import { remarkCitationMarkers } from './citation-markers'
import { REPORT_SOURCE_ANCHOR_PREFIX } from './report-citations'

interface LinkNode extends Parent {
  type: 'link'
  url: string
}

const parse = (markdown: string, numbers: number[], anchorPrefix?: string): Node =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCitationMarkers, { numbers: new Set(numbers), anchorPrefix })
    .runSync(unified().use(remarkParse).use(remarkGfm).parse(markdown))

const isParent = (node: Node): node is Parent => Array.isArray((node as Parent).children)

/** Every node of a type, in document order. */
const collect = (node: Node, type: string): Node[] => {
  const found = node.type === type ? [node] : []
  if (isParent(node)) for (const child of node.children) found.push(...collect(child, type))
  return found
}

/** `[N] → #anchor` for every citation link in the tree. */
const links = (node: Node): Array<[string, string]> =>
  collect(node, 'link').map((link) => {
    const { url, children } = link as LinkNode
    return [children.map(text).join(''), url]
  })

/** The document's text, links flattened back to their labels. */
const text = (node: Node): string =>
  isParent(node) ? node.children.map(text).join('') : value(node)

const value = (node: Node): string => {
  const literal = (node as Node & { value?: unknown }).value
  return typeof literal === 'string' ? literal : ''
}

describe('remarkCitationMarkers', () => {
  test('links a marker to its source row', () => {
    expect(links(parse('Fluchtniveau ist definiert [3].', [1, 2, 3]))).toEqual([
      ['[3]', `#${REPORT_SOURCE_ANCHOR_PREFIX}3`],
    ])
  })

  // The defect: two sources behind one claim is `[2][3]` — what the report
  // writers are instructed to emit — and the old source-text rewrite read the
  // pair as reference-link syntax, leaving BOTH markers as literal text.
  test('links adjacent markers separately', () => {
    const tree = parse('Anforderungen an Feuerwiderstand [2][3].', [1, 2, 3])

    expect(links(tree)).toEqual([
      ['[2]', `#${REPORT_SOURCE_ANCHOR_PREFIX}2`],
      ['[3]', `#${REPORT_SOURCE_ANCHOR_PREFIX}3`],
    ])
    expect(text(tree)).toBe('Anforderungen an Feuerwiderstand [2][3].')
  })

  test('links a run of three, the shape long reports write', () => {
    expect(links(parse('Gebäudeklassen [1][4][7] gelten.', [1, 4, 7]))).toEqual([
      ['[1]', `#${REPORT_SOURCE_ANCHOR_PREFIX}1`],
      ['[4]', `#${REPORT_SOURCE_ANCHOR_PREFIX}4`],
      ['[7]', `#${REPORT_SOURCE_ANCHOR_PREFIX}7`],
    ])
  })

  test('honours a per-answer anchor prefix', () => {
    expect(links(parse('Siehe [1][2].', [1, 2], 'answer-source-m7-'))).toEqual([
      ['[1]', '#answer-source-m7-1'],
      ['[2]', '#answer-source-m7-2'],
    ])
  })

  test('leaves a marker with no source entry as text', () => {
    const tree = parse('Siehe [1] und [9].', [1])

    expect(links(tree)).toEqual([['[1]', `#${REPORT_SOURCE_ANCHOR_PREFIX}1`]])
    expect(text(tree)).toContain('[9]')
  })

  test('links markers inside emphasis, headings, lists and tables', () => {
    const markdown = [
      '## Klasse 5 [1]',
      '',
      '- **Fett [2]** und *kursiv [3]*',
      '',
      '| Klasse | Beleg |',
      '| --- | --- |',
      '| GK 5 | [1][2] |',
    ].join('\n')

    expect(links(parse(markdown, [1, 2, 3]))).toEqual([
      ['[1]', `#${REPORT_SOURCE_ANCHOR_PREFIX}1`],
      ['[2]', `#${REPORT_SOURCE_ANCHOR_PREFIX}2`],
      ['[3]', `#${REPORT_SOURCE_ANCHOR_PREFIX}3`],
      ['[1]', `#${REPORT_SOURCE_ANCHOR_PREFIX}1`],
      ['[2]', `#${REPORT_SOURCE_ANCHOR_PREFIX}2`],
    ])
  })

  // Everything below is decided by the parser rather than by this module — the
  // point of moving off the source text. They are asserted because they are the
  // guarantees the old rewrite hand-rolled and could get wrong.
  test('leaves markers in fenced code and code spans alone', () => {
    const markdown = ['Siehe [1].', '```ts', 'const x = array[2]', '```', 'Auch `items[3]`.'].join(
      '\n'
    )
    const tree = parse(markdown, [1, 2, 3])

    expect(links(tree)).toEqual([['[1]', `#${REPORT_SOURCE_ANCHOR_PREFIX}1`]])
    expect(collect(tree, 'code')).toHaveLength(1)
    expect(collect(tree, 'inlineCode')).toHaveLength(1)
  })

  test('does not touch a link the model wrote, or nest inside one', () => {
    const tree = parse('[1](https://example.com) and [see [2]](https://example.com)', [1, 2])

    expect(links(tree)).toEqual([
      // The label is `1`, not `[1]` — the brackets were link syntax, which is
      // exactly the distinction a rewrite over source text cannot make.
      ['1', 'https://example.com'],
      ['see [2]', 'https://example.com'],
    ])
  })

  test('does not touch a resolved reference link, but does link a bare pair', () => {
    // `[label][1]` with a definition is a linkReference; `[1][2]` with no
    // definition is what it renders as — two literal markers.
    const defined = parse('[label][1]\n\n[1]: https://example.com', [1, 2])
    expect(collect(defined, 'linkReference')).toHaveLength(1)
    expect(links(defined)).toEqual([])

    expect(links(parse('Beleg [1][2].', [1, 2]))).toHaveLength(2)
  })

  test('leaves an image and its alt text alone', () => {
    const tree = parse('![Abb. [1]](https://example.com/a.png)', [1])

    expect(links(tree)).toEqual([])
    expect(collect(tree, 'image')).toHaveLength(1)
  })

  test('does nothing when the answer has no source entries', () => {
    const tree = parse('Fluchtniveau [1][2].', [])

    expect(links(tree)).toEqual([])
    expect(text(tree)).toBe('Fluchtniveau [1][2].')
  })

  test('ignores bracketed numbers too long to be a citation', () => {
    expect(links(parse('Ausgabe [2024] und [12].', [12]))).toEqual([
      ['[12]', `#${REPORT_SOURCE_ANCHOR_PREFIX}12`],
    ])
  })

  test('links the marker inside a doubled bracket', () => {
    expect(links(parse('Beleg [[1]].', [1]))).toEqual([['[1]', `#${REPORT_SOURCE_ANCHOR_PREFIX}1`]])
  })
})
