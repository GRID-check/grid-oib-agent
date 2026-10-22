/**
 * @vitest-environment node
 */
/**
 * The escape is held against both of its readers. CommonMark is read by the
 * parser the preview's renderer uses (remark with GFM), the oracle: escaped
 * text is one paragraph of the same characters, never a heading, a list, a
 * fence or a link. The knowledge layer's chunker is read by its own two
 * expressions over Python's `splitlines()`, mirrored in
 * `@/test-utils/markdown-chunker`.
 */
import type { Root, RootContent } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { chunkerReads } from '@/test-utils/markdown-chunker'
import { describe, expect, it } from 'vitest'
import { escapeInline, escapeLineStarts, escapeMarkdown } from './markdown-escape'

const parse = (markdown: string): Root => unified().use(remarkParse).use(remarkGfm).parse(markdown)

/** The node types a parse produced, depth first. */
function types(node: Root | RootContent): string[] {
  const own = node.type === 'root' ? [] : [node.type]
  return 'children' in node ? [...own, ...node.children.flatMap(types)] : own
}

/**
 * The structure a parse produced: every node but the paragraph and its text.
 * A bare URL is a link in GFM wherever it stands (the autolink literal), so
 * a link that shows exactly its own address is text that happens to be
 * clickable, not structure the text made.
 */
function structure(tree: Root): string[] {
  const walk = (node: Root | RootContent): string[] => {
    if (node.type === 'link' && text(node) === node.url.replace(/^mailto:/, '')) return []
    const own = node.type === 'root' || node.type === 'paragraph' || node.type === 'text' ? [] : [node.type]
    return 'children' in node ? [...own, ...node.children.flatMap(walk)] : own
  }
  return walk(tree)
}

/** The text a parse produced, with every line break as `\n`. */
function text(node: Root | RootContent): string {
  if (node.type === 'text') return node.value
  if (node.type === 'break') return '\n'
  if (!('children' in node)) return ''
  return node.children.map(text).join(node.type === 'root' ? '\n\n' : '')
}

/**
 * Lines a person types or a stranger sends that are structure if written as
 * they are. Each one, escaped, must be a plain paragraph of itself.
 */
const STRUCTURE: Array<[string, string]> = [
  ['an ATX heading', '## 14.10.2026 · MA 37'],
  ['an indented ATX heading', '   # Bescheid'],
  ['a heading with a closing sequence', '### Auflage ###'],
  ['a dash bullet', '- offen'],
  ['a plus bullet', '+ erledigt'],
  ['a star bullet', '* Punkt'],
  ['an ordered item with a dot', '1. Stock'],
  ['an ordered item with a parenthesis', '2) Variante'],
  ['a dash thematic break', '---'],
  ['a spaced dash thematic break', '- - -'],
  ['a star thematic break', '***'],
  ['an underscore thematic break', '___'],
  ['a block quote', '> zitiert'],
  ['a backtick fence', '```js'],
  ['a tilde fence', '~~~'],
  ['a longer backtick fence', '`````'],
  ['raw HTML', '<div onclick="x">'],
  ['an HTML comment', '<!-- verborgen -->'],
  ['a link reference definition', '[1]: https://example.com'],
  ['an image', '![Logo](https://tracker.example/pixel.gif)'],
  ['a link', '[Bescheid](https://example.com)'],
  ['a table row', '| a | b |'],
  ['emphasis', '*wichtig* und _dringend_'],
  ['strikethrough', '~~gestrichen~~'],
  ['a code span', '`code`'],
  ['a task item', '- [ ] offen'],
]

describe('escapeMarkdown', () => {
  it.each(STRUCTURE)('keeps %s text', (_name, line) => {
    const tree = parse(escapeMarkdown(line))
    expect(structure(tree)).toEqual([])
    // A paragraph's leading indent is not part of its text.
    expect(text(tree)).toBe(line.trimStart())
  })

  /**
   * The one place the escape shows: GFM's URL literal runs to the next space
   * or `<`, so it takes the backslash before an escaped `>` into the address.
   * Still one paragraph and no autolink of the angle brackets' making.
   */
  it('keeps an autolink text, showing the backslash a bare URL swallowed', () => {
    const tree = parse(escapeMarkdown('<https://example.com>'))
    expect(types(tree).filter((type) => type !== 'text')).toEqual(['paragraph', 'link'])
    expect(text(tree)).toBe('<https://example.com\\>')
  })

  it('keeps a setext underline from making the line above a heading', () => {
    for (const underline of ['===', '---', '= = =']) {
      const tree = parse(escapeMarkdown(`Bescheid\n${underline}`))
      expect(types(tree), underline).not.toContain('heading')
      expect(text(tree), underline).toBe(`Bescheid\n${underline}`)
    }
  })

  it('keeps an unclosed fence from swallowing what follows', () => {
    const body = 'Anbei:\n```\n## Danach\nnoch Text'
    const tree = parse(escapeMarkdown(body))
    expect(types(tree)).not.toContain('code')
    expect(types(tree)).not.toContain('heading')
    expect(chunkerReads(escapeMarkdown(body))).toEqual({ headings: [], fences: 0 })
  })

  it('leaves text that is no structure as it is', () => {
    for (const plain of ['Bitte um Prüfung.', 'Stiege 2, Top 14', '#hashtag', '1.5 m', 'E-Mail', '10:30 Uhr', 'a-b+c']) {
      expect(escapeMarkdown(plain), plain).toBe(plain)
    }
  })

  /**
   * The chunker splits where Python does. A heading after a form feed, a NEL,
   * a record separator or a line separator is a line start to it, so it is one
   * to the escape too, though JavaScript's `^` would not see it.
   */
  it('escapes a heading after every terminator the chunker splits at', () => {
    for (const terminator of ['\n', '\r', '\r\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029']) {
      const body = `Sehr geehrte Damen und Herren,${terminator}## 14.10.2026 · MA 37${terminator}Die Frist ist verlängert.`
      expect(chunkerReads(body).headings, JSON.stringify(terminator)).toHaveLength(1)
      expect(chunkerReads(escapeMarkdown(body)).headings, JSON.stringify(terminator)).toEqual([])
    }
  })

  it('escapes a heading whose space only Python counts as one', () => {
    for (const space of ['\x1f', '\x85', '\u00a0']) {
      const line = `##${space}Bescheid`
      expect(chunkerReads(escapeMarkdown(line)).headings, JSON.stringify(space)).toEqual([])
    }
  })

  it('opens no fence for the chunker, whatever the indent', () => {
    expect(chunkerReads(escapeMarkdown('```\n  ~~~\n\u00a0```')).fences).toBe(0)
  })
})

describe('escapeInline and escapeLineStarts', () => {
  it('escapes the characters that act anywhere, the backslash first among them', () => {
    expect(escapeInline('a\\b *c* _d_ [e](f) <g> |h| ~i~ `j`')).toBe(
      'a\\\\b \\*c\\* \\_d\\_ \\[e\\](f) \\<g\\> \\|h\\| \\~i\\~ \\`j\\`',
    )
  })

  it('escapes only the markers at a line start, and keeps the indent', () => {
    expect(escapeLineStarts('# a\n  - b\n3. c\nd - e\n===')).toBe('\\# a\n  \\- b\n3\\. c\nd - e\n\\===')
  })

  it('leaves inline marks alone, so Markdown that is meant stays Markdown', () => {
    expect(escapeLineStarts('**fett** und *kursiv*')).toBe('**fett** und *kursiv*')
  })

  it('keeps each line start to its own line, so blank lines before a marker change nothing', () => {
    expect(escapeLineStarts('  \n \t\n  # a\n\n\n- b')).toBe('  \n \t\n  \\# a\n\n\n\\- b')
    expect(escapeLineStarts(' \f \v 1. c\u2028\u2029 + d')).toBe(' \f \v 1\\. c\u2028\u2029 \\+ d')
    expect(escapeLineStarts('Text\n===  \n\n  \nweiter')).toBe('Text\n\\===  \n\n  \nweiter')
    expect(escapeLineStarts('=\n\n= x')).toBe('\\=\n\n= x')
  })
})

/**
 * A mail body is untrusted, and one of whitespace-only lines is cheap to send.
 * An indent that crossed line ends ran on over every blank line after each line
 * start, so 20,000 such lines took seconds; within one line it is milliseconds.
 * The bound is generous, so a slow runner does not fail it and quadratic time
 * still does.
 */
describe('escapeMarkdown on hostile input', () => {
  it.each([
    ['spaces', '   \n'],
    ['tabs and form feeds', '\t \f'],
    ['line separators', ' \u2028 \u2029'],
  ])('stays linear over 20,000 lines of %s', (_name, line) => {
    const body = `${line.repeat(20_000)}x`
    const started = performance.now()
    escapeMarkdown(body)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
