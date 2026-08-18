/**
 * The answer's prose, as document blocks.
 *
 * An answer is stored as markdown, and pasting that markdown into Word verbatim
 * would hand the reader `## Fluchtwege` and `**40 m**` — the notation, not the
 * document. So it is lexed with `marked` (already a dependency, and already the
 * lexer the PDF path uses in `@/lib/pdf/ReactPdfDocument`) and mapped onto the
 * same block vocabulary the cards and the reference list build.
 *
 * Inline emphasis IS carried through, because in a building-code answer bold is
 * rarely decorative — it is the number, the Gebäudeklasse, the verdict. Links
 * are flattened to `label (url)` rather than dropped: an exported answer that
 * silently loses the address of the source it points at is the failure this
 * whole feature exists to fix.
 *
 * What it deliberately does NOT do is invent structure. An unrecognised token
 * falls back to its raw text as a paragraph, so a construct marked's lexer
 * grows tomorrow arrives in the document unformatted instead of missing.
 */

import { marked, type Token, type Tokens } from 'marked'
import type { DocBlock, DocRun } from './blocks'

/** Inline tokens carried on a block token, when it has any. */
type InlineHost = { tokens?: Token[]; text?: string; raw?: string }

/**
 * Flatten inline tokens into runs.
 *
 * Recursive because emphasis nests (`**bold with *italic* inside**`), and the
 * inherited style has to survive the descent or the inner run loses the bold
 * its parent gave it.
 */
const runsFrom = (tokens: Token[] | undefined, inherited: Partial<DocRun> = {}): DocRun[] => {
  if (!tokens) return []
  const runs: DocRun[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
        runs.push(...runsFrom((token as Tokens.Strong).tokens, { ...inherited, bold: true }))
        break
      case 'em':
        runs.push(...runsFrom((token as Tokens.Em).tokens, { ...inherited, italic: true }))
        break
      case 'del':
        runs.push(...runsFrom((token as Tokens.Del).tokens, inherited))
        break
      case 'codespan':
        runs.push({ ...inherited, text: (token as Tokens.Codespan).text, mono: true })
        break
      case 'link': {
        const link = token as Tokens.Link
        const label = link.text?.trim() || link.href
        // Only append the address when it is not already the visible text —
        // "https://… (https://…)" is noise, a missing href is a lost source.
        const suffix = link.href && link.href !== label ? ` (${link.href})` : ''
        runs.push({ ...inherited, text: `${label}${suffix}` })
        break
      }
      case 'br':
        runs.push({ ...inherited, text: '\n' })
        break
      case 'image':
        // No picture reaches the package (no media part, by design), so the
        // caption is emitted rather than nothing: a dropped image reads as an
        // answer that never had one.
        runs.push({ ...inherited, text: (token as Tokens.Image).text || '', italic: true })
        break
      default: {
        const text = (token as InlineHost).text ?? (token as InlineHost).raw ?? ''
        if (text) runs.push({ ...inherited, text })
      }
    }
  }
  return runs
}

/** Table cells arrive as `{ text, tokens }` in current marked, as strings in older output. */
const cellRuns = (cell: unknown): DocRun[] => {
  if (typeof cell === 'string') return [{ text: cell }]
  if (cell && typeof cell === 'object') {
    const host = cell as InlineHost
    const runs = runsFrom(host.tokens)
    if (runs.length > 0) return runs
    return [{ text: host.text ?? host.raw ?? '' }]
  }
  return [{ text: '' }]
}

const listBlocks = (token: Tokens.List): DocBlock[] => {
  const blocks: DocBlock[] = []
  const items: DocRun[][] = []
  token.items.forEach((item, index) => {
    const inline = (item.tokens ?? []).filter((child) => child.type !== 'list')
    const nested = (item.tokens ?? []).filter(
      (child): child is Tokens.List => child.type === 'list'
    )
    // An ordered list keeps its number in the text: the bullet renderer writes a
    // literal marker (see `docx.ts`), so "1." has to be part of the item or the
    // reader loses the ordering the answer relied on.
    const prefix = token.ordered ? `${(token.start || 1) + index}. ` : ''
    const runs = inline.flatMap((child) =>
      child.type === 'text' || child.type === 'paragraph'
        ? runsFrom((child as InlineHost).tokens ?? [], {})
        : runsFrom([child])
    )
    items.push(prefix ? [{ text: prefix }, ...runs] : runs)
    // A nested list becomes its own flat list rather than an indented one: Word
    // renders it identically without a numbering part, and a nested structure
    // that cannot be expressed is better flattened than dropped.
    for (const child of nested) blocks.push(...listBlocks(child))
  })
  if (items.length > 0) blocks.unshift({ kind: 'bullets', items })
  return blocks
}

const blockFrom = (token: Token): DocBlock[] => {
  switch (token.type) {
    case 'space':
      return []
    case 'heading': {
      const heading = token as Tokens.Heading
      // Clamped to 3: the document's own chrome owns level 1 and 2, so an `h1`
      // inside the answer must not outrank the "Antwort" heading above it.
      const level = Math.min(3, Math.max(1, heading.depth + 1)) as 1 | 2 | 3
      return [{ kind: 'heading', level, text: heading.text }]
    }
    case 'paragraph':
      return [{ kind: 'paragraph', runs: runsFrom((token as Tokens.Paragraph).tokens) }]
    case 'text': {
      const runs = runsFrom((token as InlineHost).tokens)
      return [{ kind: 'paragraph', runs: runs.length > 0 ? runs : [{ text: (token as InlineHost).text ?? '' }] }]
    }
    case 'list':
      return listBlocks(token as Tokens.List)
    case 'blockquote':
      return (token as Tokens.Blockquote).tokens.flatMap(blockFrom).map((block) =>
        block.kind === 'paragraph' ? { ...block, style: 'quote' as const } : block
      )
    case 'code':
      return [{ kind: 'paragraph', runs: [{ text: (token as Tokens.Code).text, mono: true }] }]
    case 'table': {
      const table = token as Tokens.Table
      return [
        {
          kind: 'table',
          head: table.header.map((cell) =>
            typeof cell === 'string' ? cell : ((cell as InlineHost).text ?? '')
          ),
          rows: table.rows.map((row) => row.map(cellRuns)),
        },
      ]
    }
    case 'hr':
      return []
    default: {
      const raw = ((token as InlineHost).text ?? (token as InlineHost).raw ?? '').trim()
      return raw ? [{ kind: 'paragraph', runs: [{ text: raw }] }] : []
    }
  }
}

/** Lex markdown into document blocks. Empty input yields no blocks, not an empty one. */
export function markdownToBlocks(markdown: string): DocBlock[] {
  if (!markdown.trim()) return []
  return marked.lexer(markdown).flatMap(blockFrom)
}
