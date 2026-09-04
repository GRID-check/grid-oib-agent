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

  // The matching used to compile the names into a regex alternation, so every
  // one of these characters had to be escaped by hand and correctly. There is
  // no pattern any more, so there is nothing left to escape wrongly — these pin
  // that the names are treated as literal text.
  it('treats regex metacharacters in a filename as literal text', () => {
    const awkward = 'Plan (Rev.2) [final] +neu $1.pdf'
    expect(references(parse(`Siehe ${awkward} bitte.`, [awkward]))).toEqual([[awkward, awkward]])
  })

  it('does not let a filename act as a pattern against the prose', () => {
    // `.` would match any character, `.*` would swallow the sentence.
    expect(references(parse('Siehe PlanXpdf und Plan.pdf.', ['Plan.pdf']))).toEqual([
      ['Plan.pdf', 'Plan.pdf'],
    ])
    expect(references(parse('Siehe irgendwas.', ['.*']))).toEqual([])
  })

  // Case-insensitive search runs over a lowercased copy, which is only sound
  // while the fold preserves length. `İ` (U+0130) folds to two code units, so a
  // name carrying one takes the slower path that compares slices of the
  // original. Getting it wrong would not lose the match — it would slide every
  // later index and draw the chip over the WRONG span, so the prose either side
  // is what this asserts.
  it('keeps the span right for a name whose lowercase is longer than itself', () => {
    const turkish = 'İstanbul-Lageplan.pdf'
    expect(turkish.toLowerCase().length).toBeGreaterThan(turkish.length)

    const tree = parse(`Siehe ${turkish} bitte.`, [turkish])
    expect(references(tree)).toEqual([[turkish, turkish]])

    const paragraph = tree.children[0]
    const values =
      paragraph.type === 'paragraph'
        ? paragraph.children.map((c) => ('value' in c ? c.value : 'LINK'))
        : []
    expect(values).toEqual(['Siehe ', 'LINK', ' bitte.'])
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
