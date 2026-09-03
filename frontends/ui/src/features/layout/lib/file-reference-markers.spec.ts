import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Link, Root } from 'mdast'
import { visit } from 'unist-util-visit'
import { remarkFileReferences } from './file-reference-markers'

const parse = (markdown: string, fileNames: string[]): Root => {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root
  remarkFileReferences({ fileNames })(tree)
  return tree
}

/** Every file-reference link in the tree, as `[label, filename]`. */
const references = (tree: Root): Array<[string, string]> => {
  const found: Array<[string, string]> = []
  visit(tree, 'link', (node: Link) => {
    if (!node.url.startsWith('#file-ref-')) return
    const label = node.children.map((c) => ('value' in c ? c.value : '')).join('')
    found.push([label, decodeURIComponent(node.url.slice('#file-ref-'.length))])
  })
  return found
}

describe('remarkFileReferences', () => {
  it('links a filename the reader owns', () => {
    const tree = parse('Beginnen Sie mit pd8280-2.pdf.', ['pd8280-2.pdf'])
    expect(references(tree)).toEqual([['pd8280-2.pdf', 'pd8280-2.pdf']])
  })

  it('links every occurrence in one sentence', () => {
    const tree = parse('Zuerst A.pdf, dann B.pdf.', ['A.pdf', 'B.pdf'])
    expect(references(tree)).toEqual([
      ['A.pdf', 'A.pdf'],
      ['B.pdf', 'B.pdf'],
    ])
  })

  it('keeps the spelling the answer used', () => {
    const tree = parse('Siehe PD8280-2.PDF.', ['pd8280-2.pdf'])
    expect(references(tree)).toEqual([['PD8280-2.PDF', 'PD8280-2.PDF']])
  })

  // The whole reason this is a set rather than a grammar: a chip that opens
  // nothing is worse than plain text.
  it('leaves a filename the reader does not own as prose', () => {
    const tree = parse('Siehe Konzept.pdf.', ['pd8280-2.pdf'])
    expect(references(tree)).toEqual([])
  })

  it('does not link the tail of a longer token', () => {
    const tree = parse('Siehe Bestand-Plan.pdf und 03_Einreichung/Plan.pdf.', ['Plan.pdf'])
    expect(references(tree)).toEqual([])
  })

  it('does not link a name that is a prefix of a longer one', () => {
    const tree = parse('Siehe Plan.pdfx.', ['Plan.pdf'])
    expect(references(tree)).toEqual([])
  })

  it('lets the longer name win when both are owned', () => {
    // Longest-first is the caller's contract (`fileNamesPresentIn`).
    const tree = parse('Siehe Grundriss Plan.pdf.', ['Grundriss Plan.pdf', 'Plan.pdf'])
    expect(references(tree)).toEqual([['Grundriss Plan.pdf', 'Grundriss Plan.pdf']])
  })

  it('links inside a table cell, which is where a reading list puts it', () => {
    const table = ['| Kriterium | Datei |', '| --- | --- |', '| Grundlagen | pd8280-2.pdf |'].join('\n')
    expect(references(parse(table, ['pd8280-2.pdf']))).toEqual([['pd8280-2.pdf', 'pd8280-2.pdf']])
  })

  it('never touches code, which the parser has already settled', () => {
    const tree = parse('Run `cat pd8280-2.pdf`.\n\n```\ncat pd8280-2.pdf\n```', ['pd8280-2.pdf'])
    expect(references(tree)).toEqual([])
  })

  it('never touches an existing link label or an image alt', () => {
    const tree = parse(
      '[pd8280-2.pdf](https://example.test/x) und ![pd8280-2.pdf](https://example.test/i.png)',
      ['pd8280-2.pdf']
    )
    expect(references(tree)).toEqual([])
  })

  it('is a no-op with no names', () => {
    const markdown = 'Beginnen Sie mit pd8280-2.pdf.'
    const before = unified().use(remarkParse).parse(markdown)
    const after = parse(markdown, [])
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  })

  it('leaves the prose either side of a reference intact', () => {
    const tree = parse('Zuerst A.pdf lesen.', ['A.pdf'])
    const paragraph = tree.children[0]
    expect(paragraph.type).toBe('paragraph')
    const values = 'children' in paragraph
      ? paragraph.children.map((c) => ('value' in c ? c.value : 'LINK'))
      : []
    expect(values).toEqual(['Zuerst ', 'LINK', ' lesen.'])
  })
})
