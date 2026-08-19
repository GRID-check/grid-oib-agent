/**
 * {@link DocBlock}s to a PDF, with `@react-pdf/renderer`.
 *
 * ## Why this exists next to `docx.ts` and not instead of it
 *
 * `lib/answer-export/blocks.ts` says in its own docstring that the block
 * vocabulary is there "so a second output format can be added later without
 * touching a single card renderer". This module is that second format. It reads
 * exactly the same `DocBlock[]` the Word exporter reads, which means the PDF
 * gets the report prose, the ~40 card types and the reference list from the
 * shape-walker in `cards.ts` — and the day a forty-first card type ships,
 * neither exporter has to learn about it.
 *
 * The two renderers stay separate because their constraints are opposite. Word
 * has named styles, an infinite scroll and a reader who will edit the file;
 * a PDF has fixed pages, a reader who will print it, and no styles at all —
 * every rule below is direct formatting because there is nothing else.
 *
 * ## Shapes, not kinds
 *
 * Four block kinds have to carry a research report, a code listing, a
 * label/value table, a checks table and a numbered reference list. Rather than
 * grow the vocabulary (which would mean a second renderer to keep in step, and
 * a card walker that has to learn the new kinds), this renderer dispatches on
 * the SHAPE of a block the way `cards.ts` dispatches on the shape of a field:
 *
 *   - a paragraph whose only run is monospaced and multi-line is a code listing;
 *   - a paragraph opening with a bold `[7]` is a reference entry, and gets the
 *     marker as a tinted chip so the eye can find it from the prose;
 *   - a two-column table with no header row is a label/value block, and gets a
 *     definition-list treatment instead of a grid.
 *
 * Each of those is a real distinction the AUTHOR of the blocks made; none of
 * them needed a new kind, and a block that fits no special shape still renders
 * correctly as its plain kind.
 *
 * ## Fonts
 *
 * Helvetica, one of the four faces pdfkit carries itself. The app is set in
 * Geist, but no Geist file exists anywhere in this repository and `Font.register`
 * needs actual bytes — a registration pointing at a URL would turn every export
 * into a network fetch at render time, and a registration pointing at a missing
 * path throws. A built-in face that always renders beats a brand face that
 * sometimes does; the day a Geist `.ttf` lands in the repo, `FONT_FAMILY` below
 * is the only line that changes.
 */

import React from 'react'
import { Document, Font, Link, Page, StyleSheet, View } from '@react-pdf/renderer'

// `Text` comes from the transliterating wrapper, never from the library: a raw
// `Text` would print `≤` as `d`. See printable-text.tsx.
import { Text } from './printable-text'
import type { DocBlock, DocRun } from '@/lib/answer-export/blocks'
import { PRODUCT_NAME } from '@/lib/brand'
import { CoverContent, COVER_PAGE_STYLE, PageFooter, RunningHeader, type CoverInfo } from './branding'
import { PDF_PAGE, PDF_THEME, PDF_TYPE } from './theme'

/**
 * The body face. See the module docstring: built-in on purpose, and the single
 * place to change when a real brand font file exists to register.
 */
const FONT_FAMILY = 'Helvetica'
/** pdfkit's own monospaced face — inline code, identifiers, code listings. */
const MONO_FAMILY = 'Courier'

/**
 * Hyphenation off.
 *
 * react-pdf hyphenates English by default, which breaks URLs and German
 * compounds at points no dictionary agrees with — and a hyphen inserted into a
 * URL survives copy-and-paste, so the reader ends up with an address that does
 * not resolve and no way to tell why.
 */
Font.registerHyphenationCallback((word) => [word])

const styles = StyleSheet.create({
  /**
   * The page carries the face, the size and the colour — but NOT the leading.
   *
   * A `lineHeight` on the `Page` is inherited by its absolutely positioned
   * children, and react-pdf then lays the fixed footer out somewhere it drops
   * it: the document renders, no error is thrown, and the page numbers and the
   * wordmark are simply not on the sheet. So every text style below states its
   * own leading, and this one deliberately states none.
   */
  page: {
    fontFamily: FONT_FAMILY,
    fontSize: PDF_TYPE.body,
    color: PDF_THEME.body,
    backgroundColor: PDF_THEME.paper,
    paddingTop: PDF_PAGE.marginTop,
    paddingBottom: PDF_PAGE.marginBottom,
    paddingHorizontal: PDF_PAGE.margin,
  },

  // ---- headings ------------------------------------------------------------
  h1Group: { marginTop: 20, marginBottom: 12 },
  h1: {
    fontSize: PDF_TYPE.h1,
    fontWeight: 'bold',
    color: PDF_THEME.ink,
    lineHeight: PDF_TYPE.lineHeightTight,
    letterSpacing: -0.4,
  },
  h1Rule: {
    width: 34,
    height: 2.5,
    marginTop: 8,
    backgroundColor: PDF_THEME.accent,
  },
  h2Group: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.rule,
  },
  /** One square of the mark, reused as a section bullet. */
  h2Mark: {
    width: 5,
    height: 5,
    marginRight: 8,
    backgroundColor: PDF_THEME.accent,
  },
  h2: {
    fontSize: PDF_TYPE.h2,
    fontWeight: 'bold',
    color: PDF_THEME.ink,
    lineHeight: PDF_TYPE.lineHeightTight,
    letterSpacing: -0.2,
  },
  h3: {
    fontSize: PDF_TYPE.h3,
    fontWeight: 'bold',
    color: PDF_THEME.ink,
    letterSpacing: 0.3,
    marginTop: 14,
    marginBottom: 5,
  },

  // ---- paragraphs ----------------------------------------------------------
  body: { marginBottom: 8, lineHeight: PDF_TYPE.lineHeight },
  meta: {
    fontSize: PDF_TYPE.meta,
    color: PDF_THEME.subtle,
    marginBottom: 5,
    lineHeight: 1.4,
  },
  quote: {
    borderLeftWidth: 2.5,
    borderLeftColor: PDF_THEME.accent,
    backgroundColor: PDF_THEME.panel,
    paddingLeft: 12,
    paddingRight: 10,
    paddingVertical: 8,
    marginTop: 4,
    marginBottom: 10,
  },
  quoteText: { fontStyle: 'italic', color: PDF_THEME.ink, lineHeight: PDF_TYPE.lineHeight },

  code: {
    backgroundColor: PDF_THEME.surface,
    borderWidth: 1,
    borderColor: PDF_THEME.hairline,
    padding: 10,
    marginTop: 6,
    marginBottom: 10,
  },
  codeText: {
    fontFamily: MONO_FAMILY,
    fontSize: PDF_TYPE.mono,
    lineHeight: 1.4,
    color: PDF_THEME.ink,
  },

  // ---- reference entries ---------------------------------------------------
  reference: {
    flexDirection: 'row',
    marginBottom: 7,
  },
  referenceChip: {
    backgroundColor: PDF_THEME.accentTint,
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    marginRight: 8,
    borderRadius: 3,
  },
  referenceChipText: {
    fontSize: PDF_TYPE.meta,
    fontWeight: 'bold',
    color: PDF_THEME.accentInk,
    lineHeight: 1.2,
  },
  referenceBody: { flexGrow: 1, flexBasis: 1, lineHeight: 1.45 },

  // ---- lists ---------------------------------------------------------------
  bulletRow: { flexDirection: 'row', marginBottom: 4 },
  bulletMark: {
    width: 12,
    color: PDF_THEME.accent,
    fontWeight: 'bold',
  },
  bulletBody: { flexGrow: 1, flexBasis: 1, lineHeight: PDF_TYPE.lineHeight },

  // ---- tables --------------------------------------------------------------
  table: {
    marginTop: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: PDF_THEME.hairline,
  },
  definitionTable: {
    marginTop: 4,
    marginBottom: 12,
    borderTopWidth: 1,
    borderTopColor: PDF_THEME.hairline,
  },
  headRow: {
    flexDirection: 'row',
    backgroundColor: PDF_THEME.surface,
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.rule,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.hairline,
  },
  rowAlt: {
    flexDirection: 'row',
    backgroundColor: PDF_THEME.surfaceAlt,
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.hairline,
  },
  cell: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: PDF_TYPE.table,
    lineHeight: 1.4,
  },
  headCell: {
    paddingVertical: 7,
    paddingHorizontal: 8,
    fontSize: PDF_TYPE.meta,
    fontWeight: 'bold',
    color: PDF_THEME.ink,
    lineHeight: 1.3,
  },
  definitionLabel: {
    paddingVertical: 6,
    paddingHorizontal: 0,
    paddingRight: 10,
    fontSize: PDF_TYPE.table,
    color: PDF_THEME.subtle,
    lineHeight: 1.4,
  },
  definitionValue: {
    paddingVertical: 6,
    paddingHorizontal: 0,
    fontSize: PDF_TYPE.table,
    color: PDF_THEME.ink,
    lineHeight: 1.4,
  },

  // ---- rule ----------------------------------------------------------------
  rule: {
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.rule,
    marginTop: 14,
    marginBottom: 16,
  },

  // ---- inline --------------------------------------------------------------
  bold: { fontWeight: 'bold', color: PDF_THEME.ink },
  italic: { fontStyle: 'italic' },
  mono: { fontFamily: MONO_FAMILY, fontSize: PDF_TYPE.mono },
  link: { color: PDF_THEME.accentInk, textDecoration: 'underline' },
})

/**
 * A markdown link, or a bare address, inside otherwise plain run text.
 *
 * Runs carry no href — `markdown.ts` flattens a link to `label (url)` because
 * that is what survives into Word, where a hyperlink would need a relationship
 * part. A PDF has real link annotations and nothing to keep in step, so the
 * address is found again here and made clickable. Both spellings are matched:
 * the flattened `(https://…)` form, and the raw `[label](https://…)` that a
 * written sources section still carries when the model wrote its own list.
 */
const LINKISH = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()[\]]+)/g

/** Punctuation that ends the sentence rather than the address. */
const trimUrl = (url: string): string => url.replace(/[.,;:!?'"]+$/, '')

/**
 * Text, with its addresses turned into link annotations.
 *
 * Newlines are left in place: react-pdf breaks a line on `\n` inside a `Text`,
 * which is what a card's `missing` sentence and a reference's URL-on-its-own-line
 * were written expecting.
 */
const inlineNodes = (text: string, keyPrefix: string): React.ReactNode[] => {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  let key = 0

  LINKISH.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LINKISH.exec(text)) !== null) {
    const [full, mdLabel, mdUrl, bare] = match
    // A bare address gives its trailing punctuation back to the prose: the
    // period at the end of "…see https://example.org/a." is the sentence's, and
    // linking it produces an address that 404s when the reader clicks it.
    const url = bare ? trimUrl(bare) : mdUrl
    const label = bare ? url : mdLabel
    const end = bare ? match.index + url.length : match.index + full.length

    if (match.index > cursor) {
      nodes.push(<Text key={`${keyPrefix}-t${key++}`}>{text.slice(cursor, match.index)}</Text>)
    }
    nodes.push(
      <Link key={`${keyPrefix}-a${key++}`} src={url} style={styles.link}>
        {label}
      </Link>
    )
    cursor = end
    LINKISH.lastIndex = end
  }

  if (cursor < text.length) {
    nodes.push(<Text key={`${keyPrefix}-t${key++}`}>{text.slice(cursor)}</Text>)
  }
  return nodes
}

/**
 * One run's emphasis, as a react-pdf style array.
 *
 * Built by spreading rather than by filtering a nullable list: react-pdf's
 * `style` prop takes `Style[]`, and a `null` in it is a type error rather than
 * a no-op.
 */
const runStyle = (run: DocRun) => [
  ...(run.bold ? [styles.bold] : []),
  ...(run.italic ? [styles.italic] : []),
  ...(run.mono ? [styles.mono] : []),
]

/** A paragraph's runs, in order. */
const runNodes = (runs: DocRun[], keyPrefix: string): React.ReactNode[] =>
  runs.map((run, index) => (
    <Text key={`${keyPrefix}-r${index}`} style={runStyle(run)}>
      {inlineNodes(run.text, `${keyPrefix}-r${index}`)}
    </Text>
  ))

// ---------------------------------------------------------------------------
// Shape detection. Each of these is a distinction the block AUTHOR made; see the
// module docstring for why they are read off the shape instead of given a kind.
// ---------------------------------------------------------------------------

type ParagraphBlock = Extract<DocBlock, { kind: 'paragraph' }>
type TableBlock = Extract<DocBlock, { kind: 'table' }>

/** A whole paragraph set in mono across several lines is a code listing. */
const isCodeListing = (block: ParagraphBlock): boolean =>
  block.runs.length === 1 && block.runs[0].mono === true && block.runs[0].text.includes('\n')

/** `[7] ` in bold, the marker `answer-document.ts` writes for a reference. */
const REFERENCE_MARKER = /^\[(\d{1,3})\]\s*$/

const referenceNumber = (block: ParagraphBlock): string | null => {
  const first = block.runs[0]
  if (!first?.bold) return null
  return REFERENCE_MARKER.exec(first.text)?.[1] ?? null
}

/**
 * A headerless two-column table is a label/value block.
 *
 * `blocks.ts` says so itself: it gave the two the same kind deliberately, "for
 * no gain" in splitting them. That is true for the vocabulary and false for the
 * page — a scalar block from a card looks like a form when it is ruled like a
 * grid, and like a fact sheet when it is not.
 */
const isDefinitionList = (block: TableBlock): boolean =>
  !block.head && block.rows.length > 0 && block.rows.every((row) => row.length === 2)

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

const headingNode = (
  block: Extract<DocBlock, { kind: 'heading' }>,
  key: string
): React.ReactNode => {
  // `minPresenceAhead` keeps a heading from being the last thing on a page.
  // A section title stranded above a page break reads as an empty section.
  if (block.level === 1) {
    return (
      <View key={key} style={styles.h1Group} wrap={false} minPresenceAhead={72}>
        <Text style={styles.h1}>{block.text}</Text>
        <View style={styles.h1Rule} />
      </View>
    )
  }
  if (block.level === 2) {
    return (
      <View key={key} style={styles.h2Group} wrap={false} minPresenceAhead={64}>
        <View style={styles.h2Mark} />
        <Text style={styles.h2}>{block.text}</Text>
      </View>
    )
  }
  return (
    <Text key={key} style={styles.h3} minPresenceAhead={56}>
      {block.text}
    </Text>
  )
}

const paragraphNode = (block: ParagraphBlock, key: string): React.ReactNode => {
  if (isCodeListing(block)) {
    return (
      <View key={key} style={styles.code}>
        <Text style={styles.codeText}>{block.runs[0].text}</Text>
      </View>
    )
  }

  const number = referenceNumber(block)
  if (number) {
    return (
      <View key={key} style={styles.reference} wrap={false}>
        <View style={styles.referenceChip}>
          <Text style={styles.referenceChipText}>{number}</Text>
        </View>
        <Text style={styles.referenceBody}>{runNodes(block.runs.slice(1), key)}</Text>
      </View>
    )
  }

  if (block.style === 'quote') {
    return (
      <View key={key} style={styles.quote}>
        <Text style={styles.quoteText}>{runNodes(block.runs, key)}</Text>
      </View>
    )
  }

  return (
    <Text key={key} style={block.style === 'meta' ? styles.meta : styles.body}>
      {runNodes(block.runs, key)}
    </Text>
  )
}

const bulletsNode = (
  block: Extract<DocBlock, { kind: 'bullets' }>,
  key: string
): React.ReactNode => (
  <View key={key} style={{ marginBottom: 8 }}>
    {block.items.map((item, index) => (
      <View key={`${key}-i${index}`} style={styles.bulletRow}>
        <Text style={styles.bulletMark}>•</Text>
        <Text style={styles.bulletBody}>{runNodes(item, `${key}-i${index}`)}</Text>
      </View>
    ))}
  </View>
)

/**
 * Column widths, as percentages.
 *
 * Even, with one exception: in a table that HAS a header row and three or more
 * columns, the first column is the one carrying names — a checks table's "Item",
 * a components table's label — and it is reliably the longest. Giving it half
 * again the share of the others is what stops "Fluchtweg vom entferntesten
 * Punkt" from setting one word per line next to three columns of white space.
 */
const columnWidths = (columns: number, headed: boolean): string[] => {
  const weights = Array.from({ length: columns }, (_, index) =>
    headed && columns >= 3 && index === 0 ? 1.5 : 1
  )
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  return weights.map((weight) => `${(weight / total) * 100}%`)
}

const definitionNode = (block: TableBlock, key: string): React.ReactNode => (
  <View key={key} style={styles.definitionTable}>
    {block.rows.map((row, index) => (
      <View key={`${key}-r${index}`} style={styles.row} wrap={false}>
        <Text style={[styles.definitionLabel, { width: '34%' }]}>
          {runNodes(row[0] ?? [], `${key}-r${index}-c0`)}
        </Text>
        <Text style={[styles.definitionValue, { width: '66%' }]}>
          {runNodes(row[1] ?? [], `${key}-r${index}-c1`)}
        </Text>
      </View>
    ))}
  </View>
)

const tableNode = (block: TableBlock, key: string): React.ReactNode => {
  if (isDefinitionList(block)) return definitionNode(block, key)

  const columns = Math.max(
    block.head?.length ?? 0,
    ...block.rows.map((row) => row.length),
    1
  )
  const widths = columnWidths(columns, Boolean(block.head))
  // Short rows are padded rather than left ragged: a row with fewer cells than
  // the grid would otherwise stretch its last cell across the missing columns,
  // silently putting a value under the wrong heading.
  const padded = (row: DocRun[][]): DocRun[][] =>
    Array.from({ length: columns }, (_, index) => row[index] ?? [])

  return (
    <View key={key} style={styles.table}>
      {block.head ? (
        <View style={styles.headRow} wrap={false}>
          {Array.from({ length: columns }, (_, index) => (
            <Text key={`${key}-h${index}`} style={[styles.headCell, { width: widths[index] }]}>
              {block.head?.[index] ?? ''}
            </Text>
          ))}
        </View>
      ) : null}
      {block.rows.map((row, rowIndex) => (
        <View
          key={`${key}-r${rowIndex}`}
          style={rowIndex % 2 === 1 ? styles.rowAlt : styles.row}
          wrap={false}
        >
          {padded(row).map((cell, cellIndex) => (
            <Text
              key={`${key}-r${rowIndex}-c${cellIndex}`}
              style={[styles.cell, { width: widths[cellIndex] }]}
            >
              {runNodes(cell, `${key}-r${rowIndex}-c${cellIndex}`)}
            </Text>
          ))}
        </View>
      ))}
    </View>
  )
}

/** One block, as react-pdf nodes. Every kind in `blocks.ts` is handled here. */
const blockNode = (block: DocBlock, index: number): React.ReactNode => {
  const key = `b${index}`
  switch (block.kind) {
    case 'heading':
      return headingNode(block, key)
    case 'paragraph':
      return paragraphNode(block, key)
    case 'bullets':
      return bulletsNode(block, key)
    case 'table':
      return tableNode(block, key)
    case 'rule':
      return <View key={key} style={styles.rule} />
  }
}

/**
 * Blocks as react-pdf nodes, without a page around them.
 *
 * Exported so a spec can assert on the rendering of one block without building
 * a whole document, and so a future caller can compose the body into a page of
 * its own shape.
 */
export const blockNodes = (blocks: DocBlock[]): React.ReactNode[] => blocks.map(blockNode)

export interface BlocksDocumentProps {
  /** Title and header facts. Drawn on the cover, not into the block stream. */
  cover: CoverInfo
  /** The document's body — prose, cards and references, already assembled. */
  blocks: DocBlock[]
}

/**
 * A complete, branded document: cover sheet, then the body under running chrome.
 *
 * The `Document` metadata is filled in as well as the visible chrome. It is
 * what a document management system files the PDF under and what the reader's
 * viewer puts in its title bar, and leaving it blank means an exported answer
 * shows up in a DMS as an untitled file from an unnamed producer.
 */
export const BlocksDocument: React.FC<BlocksDocumentProps> = ({ cover, blocks }) => (
  <Document
    title={cover.title}
    author={PRODUCT_NAME}
    creator={PRODUCT_NAME}
    producer={PRODUCT_NAME}
  >
    <Page size="A4" style={COVER_PAGE_STYLE}>
      <CoverContent cover={cover} />
    </Page>
    <Page size="A4" style={styles.page}>
      <RunningHeader title={cover.title} />
      <PageFooter />
      {blockNodes(blocks)}
    </Page>
  </Document>
)
