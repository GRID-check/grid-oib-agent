import React from 'react'
import { Document, Page, Text, View, StyleSheet, Font, Link } from '@react-pdf/renderer'
import { marked } from 'marked'
// The ONE definition of what a mermaid fence is, shared with the chat renderer
// that draws them. Two definitions would disagree about `language-mermaid `
// with a trailing space inside a month, and the whole point of this module's
// mermaid branch is that the two surfaces agree about which fences are
// drawings.
//
// It is the first import from `shared/components/` into `lib/`, and that is a
// layering inversion worth naming rather than hiding: `lib` sits under
// `shared/components`, not over it. What makes it safe today is that
// `MarkdownRenderer/utils.ts` is a pure predicate module — its only runtime
// import is `@/lib/text/latinize`, and its one component-shaped import is
// `import type`, which is erased. The right home for `isMermaidFence` is a
// module both layers can reach; moving it is a change under `shared/`, which is
// another agent's while this lands.
import { isMermaidFence } from '@/shared/components/MarkdownRenderer/utils'

type Token = ReturnType<typeof marked.lexer>[number]
type HeadingToken = Extract<Token, { type: 'heading' }>
type ParagraphToken = Extract<Token, { type: 'paragraph' }>
type ListToken = Extract<Token, { type: 'list' }>
type TableToken = Extract<Token, { type: 'table' }>
type CodeToken = Extract<Token, { type: 'code' }>
type BlockquoteToken = Extract<Token, { type: 'blockquote' }>
type HtmlToken = Extract<Token, { type: 'html' }>

Font.register({
  family: 'Helvetica',
  fonts: [{ src: 'Helvetica' }, { src: 'Helvetica-Bold', fontWeight: 'bold' }],
})

// Disable hyphenation — react-pdf's default English hyphenation inserts
// hyphens into long words (including URLs), making them unusable when copied.
Font.registerHyphenationCallback((word) => [word])

// PDF palette — derived from the GRID design tokens in src/styles/tokens.css.
// react-pdf's StyleSheet does not support CSS custom properties, so we keep a
// small, named, print-safe mapping that mirrors the system colors.
const PDF_THEME = {
  ink: '#1d1d1f',
  // The label column of a fact row, and nothing else. A cover sheet's left
  // column is a KEY, not a statement: bolding every key makes an eight-row
  // block shout, and this document already has one thing that must shout.
  // Contrast against paper is 5.5:1, which survives a photocopy.
  muted: '#6e6e73',
  hairline: '#d2d2d7',
  surface: '#f2f2f2',
  codeSurface: '#f5f5f5',
  codeBorder: '#d2d2d7',
  link: '#0071e3',
}

const styles = StyleSheet.create({
  page: {
    padding: 56.69,
    fontFamily: 'Helvetica',
    fontSize: 10,
    lineHeight: 1.5,
  },
  h1: {
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 16,
    marginBottom: 12,
    lineHeight: 1.2,
  },
  h2: {
    fontSize: 14,
    fontWeight: 'bold',
    marginTop: 14,
    marginBottom: 8,
    lineHeight: 1.3,
  },
  h3: {
    fontSize: 12,
    fontWeight: 'bold',
    marginTop: 12,
    marginBottom: 6,
    lineHeight: 1.4,
  },
  paragraph: {
    marginBottom: 8,
    textAlign: 'left',
  },
  listItem: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  listItemWithNested: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  listItemBullet: {
    width: 20,
    marginRight: 5,
    flexShrink: 0,
  },
  listItemText: {
    flex: 1,
    flexDirection: 'column',
  },
  table: {
    marginTop: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: PDF_THEME.hairline,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.hairline,
    minHeight: 30,
  },
  tableHeaderRow: {
    flexDirection: 'row',
    backgroundColor: PDF_THEME.surface,
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.hairline,
    minHeight: 30,
  },
  tableCell: {
    flex: 1,
    padding: 8,
    borderRightWidth: 1,
    borderRightColor: PDF_THEME.hairline,
    justifyContent: 'center',
  },
  tableCellLast: {
    flex: 1,
    padding: 8,
    justifyContent: 'center',
  },
  tableHeaderCell: {
    fontWeight: 'bold',
  },
  codeBlock: {
    backgroundColor: PDF_THEME.codeSurface,
    border: `1px solid ${PDF_THEME.codeBorder}`,
    padding: 10,
    marginTop: 10,
    marginBottom: 10,
    fontFamily: 'Courier',
    fontSize: 9,
  },
  preBlock: {
    fontFamily: 'Courier',
    fontSize: 9,
    marginTop: 8,
    marginBottom: 8,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: PDF_THEME.codeBorder,
    paddingLeft: 10,
    marginLeft: 10,
    marginTop: 8,
    marginBottom: 8,
    fontStyle: 'italic',
  },
  /**
   * A drawing this document does not reproduce, standing where it stood.
   *
   * Rules above and below and nothing else — no fill, no box, no dashes. Each
   * of those was considered and each says the wrong thing on a page that goes
   * to a Behörde: a filled box competes with `styles.notice`, which is the one
   * thing on page one that must be read first; a dashed outline is the
   * universal shape of an image that FAILED to load, and a reader who thinks
   * part of a compliance report failed to render distrusts the rest of it. Two
   * rules are the typographic convention for inserted apparatus — an editorial
   * note, calmly stated, which is exactly what this is.
   *
   * Muted and one point smaller than the body for the same reason: it is a
   * statement ABOUT the document, not a sentence of it.
   */
  diagramPlaceholder: {
    borderTopWidth: 1,
    borderTopColor: PDF_THEME.hairline,
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.hairline,
    paddingTop: 6,
    paddingBottom: 6,
    marginTop: 10,
    marginBottom: 10,
  },
  diagramPlaceholderText: {
    color: PDF_THEME.muted,
    fontSize: 9,
  },
  hr: {
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.codeBorder,
    marginTop: 10,
    marginBottom: 10,
  },
  link: {
    color: PDF_THEME.link,
    textDecoration: 'underline',
  },
  /**
   * The AI marking, as the first thing on page one.
   *
   * A bordered box rather than two paragraphs, for the same reason the .docx
   * renders it as a single-cell table (`answer-export/answer-document.ts`): the
   * border is the part that does the work. It separates a statement ABOUT the
   * document from the document, and it keeps separating them after the page has
   * been printed, scanned and stapled to an Einreichung.
   */
  notice: {
    borderWidth: 1,
    borderColor: PDF_THEME.hairline,
    backgroundColor: PDF_THEME.surface,
    padding: 10,
    marginBottom: 16,
  },
  noticeTitle: {
    fontWeight: 'bold',
    marginBottom: 4,
  },

  /**
   * The identification block: what this document is and what it is about.
   *
   * A hairline UNDER the block and nothing else — no fill, no border, no rule
   * above. The notice directly above it is the page's only filled box, and a
   * second one would compete with the one thing on this page that has to be
   * read first. The rule is there to say where the document's own words begin.
   */
  header: {
    paddingBottom: 10,
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: PDF_THEME.hairline,
  },
  // `styles.h1` with its top margin removed: it follows the notice's own
  // 16pt of space, and stacking both opens a gap the block reads as a break.
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 10,
    lineHeight: 1.2,
  },
  factRow: {
    flexDirection: 'row',
    marginBottom: 3,
  },
  /**
   * `minWidth` and not `width`, which is a boundary this file learned the hard
   * way. A fixed-width label box does not CLIP an over-long label — the glyphs
   * paint past it — and because hyphenation is disabled repo-wide a
   * single-word label has no break opportunity, so it ran straight into its own
   * value with no gap between them: „BundeslandWien" on a page going to a
   * Behörde. A minimum keeps every label of ordinary length on one column edge,
   * which is what makes the block read as a sheet, and lets a long one push its
   * own value right instead of colliding with it. `markdown-pdf.spec.ts`
   * renders a label wider than the column and reads the gap back.
   */
  factLabel: {
    minWidth: 110,
    marginRight: 8,
    flexShrink: 0,
    color: PDF_THEME.muted,
  },
  factValue: {
    flex: 1,
  },
  /**
   * An identifier, set monospace.
   *
   * `docs/design/grid-design-language.md` §3: „Citations, legal-basis and
   * document provenance must look verifiable and exact — monospace for
   * identifiers". A run id is a string somebody TRANSCRIBES to look the
   * document up; proportional Helvetica makes `1`/`l` and `0`/`O` a guess.
   * 9pt because Courier's x-height runs large next to Helvetica at 10 — the
   * same pairing `styles.codeBlock` already ships.
   */
  factValueMono: {
    flex: 1,
    fontFamily: 'Courier',
    fontSize: 9,
  },
  /** A run-in heading over a paragraph — bold, as the .docx sets it. */
  proseLabel: {
    fontWeight: 'bold',
    marginBottom: 2,
  },
})

/**
 * A statement about the document, printed before the document.
 *
 * The strings are the CALLER's, and deliberately so: the only copy of the
 * „KI-generiert — nicht geprüft" sentence in this repo is the `answerExport`
 * dictionary that the .docx export already reads (`aiNotice.title` /
 * `aiNotice.body`). A renderer that spelled it out again would be a second
 * German sentence with the same job and no test tying the two together — and
 * the two would drift, in the one artifact that reaches a Behörde.
 */
export interface PdfNotice {
  title: string
  body: string
}

/**
 * A label and the value it names, printed as one row of a two-column block.
 *
 * The strings are the CALLER's, for the same reason {@link PdfNotice}'s are: a
 * renderer that knew the words „Projekt" and „Standort" would be a second
 * German vocabulary next to the dictionary, in the document that reaches a
 * Behörde.
 */
export interface PdfFactRow {
  label: string
  value: string
  /**
   * Set for an IDENTIFIER — a run id, a file number, anything a reader
   * transcribes rather than reads. Printed monospace; see
   * {@link styles.factValueMono} for why that is not decoration.
   */
  mono?: boolean
}

/**
 * One piece of a structured section.
 *
 * The same idea as `answer-export/document-model.ts`'s `DocBlock` and
 * deliberately not the same type: that one is shaped by what OOXML can carry,
 * this one by what this renderer draws. What the two DO share is that the
 * producer of the blocks decides the reading order and the renderer only
 * decides the typography.
 */
export type PdfBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'rows'; rows: PdfFactRow[] }
  | { kind: 'prose'; label: string; text: string }

/**
 * Matter appended AFTER the markdown, under a heading of its own.
 *
 * Appended rather than woven in: the markdown is the writer agent's document,
 * its own „Quellen" section included, and an export that cut it open to insert
 * a section would be re-editing a text a sanitizer already owns.
 */
export interface PdfSection {
  heading: string
  blocks: PdfBlock[]
}

/**
 * The block that says what this document is and what it is about.
 *
 * Rendered between the notice and the body — never above the notice. A cover
 * that pushed „KI-generiert — nicht geprüft" below the fold would be the one
 * regression this whole document cannot afford, so the order is fixed here in
 * the renderer rather than left to a caller's array.
 */
export interface PdfHeader {
  /** The document's own title. Absent when the caller has none to state. */
  title?: string
  /** Identifying facts, in the order the caller decided to print them. */
  rows: PdfFactRow[]
}

/**
 * What a machine is told about the document, as `<Document>` will accept it.
 *
 * Only Info-dictionary fields, because those are the only ones react-pdf 4.6.0
 * has — see `@/lib/ai-provenance`'s `aiProvenanceKeywords` for the check that
 * established that and for what it costs.
 */
export interface PdfMetadata {
  title?: string
  author?: string
  subject?: string
  keywords?: string
  creator?: string
}

export interface MarkdownPDFProps {
  markdown: string
  /**
   * What to print where a ```mermaid fence stands. **Required, and the one
   * string on this type that is.**
   *
   * A mermaid fence is not a listing. Its text is instructions for drawing
   * something, not the something — printing it is printing an image's base64.
   * And it is the one token type where this renderer and the chat DISAGREE
   * about what the same markdown means: `MarkdownRenderer` draws the fence as
   * a diagram, so a reader sees a picture in the thread and the document filed
   * from that same answer carried `flowchart TD / A[Bauanzeige] --> B{…}` in a
   * grey box. Nobody compares the two, because they only ever look at the good
   * one.
   *
   * Not optional, because there is no acceptable default. Printing the source
   * is the bug. Printing nothing removes content from a document that goes to
   * an authority. A German or English sentence hardcoded here is the second
   * vocabulary this whole file's strings exist to avoid. So the type asks, and
   * every caller of this renderer today renders model-written markdown that
   * can contain a fence — `POST /api/generate-pdf` renders the report a person
   * is reading, `research-report.ts` renders the one being filed.
   *
   * What it may say is bounded by what is TRUE at render time. The diagram is
   * usually not lost — the chat wraps the answer in `DiagramFilingProvider`, so
   * the reader can file the drawing as its own SVG and PDF — but whether they
   * did is unknowable here, so the words must not promise a second document
   * that may not exist.
   */
  diagramPlaceholder: string
  /** Printed above the markdown, on the first page. Omitted when absent. */
  notice?: PdfNotice
  /**
   * The identification block, printed under the notice. Omitted when absent —
   * which is what keeps `POST /api/generate-pdf`'s output unchanged.
   */
  header?: PdfHeader
  /** Appended after the markdown, each under its own heading. */
  sections?: PdfSection[]
  /**
   * Info-dictionary fields. Omitted entirely by default, which leaves the file
   * byte-for-byte what it was before this prop existed — a marking on every
   * PDF marks nothing, exactly as `DocxOptions.aiProvenance` argues.
   */
  metadata?: PdfMetadata
}

export const MarkdownPDF: React.FC<MarkdownPDFProps> = ({
  markdown,
  diagramPlaceholder,
  notice,
  header,
  sections,
  metadata,
}) => {
  const tokens = marked.lexer(markdown)

  return (
    <Document
      title={metadata?.title}
      author={metadata?.author}
      subject={metadata?.subject}
      keywords={metadata?.keywords}
      // `creator` is left off rather than passed as `undefined` when there is no
      // metadata: react-pdf destructures it with a DEFAULT of `'react-pdf'`, and
      // an explicit `undefined` takes that default too — so spreading is only
      // about not restating the library's own choice, never about hiding it.
      {...(metadata?.creator ? { creator: metadata.creator } : {})}
    >
      <Page size="A4" style={styles.page}>
        {notice ? (
          // `wrap={false}` so the marking cannot be split across a page break.
          // Half a notice at the foot of page one is the shape a reader skips.
          <View style={styles.notice} wrap={false}>
            <Text style={styles.noticeTitle}>{notice.title}</Text>
            <Text>{notice.body}</Text>
          </View>
        ) : null}
        {renderHeader(header)}
        {tokens.map((token, index) => renderToken(token, index, diagramPlaceholder))}
        {sections?.map((section, index) => renderSection(section, index))}
      </Page>
    </Document>
  )
}

/**
 * The two-column fact block, used by the header and by a section's `rows`.
 *
 * One function and not two, because a cover sheet's „Gebäudeklasse  GK 4" and a
 * Fundstelle's „Paragraf  § 3" are the same object — a named value the reader
 * checks — and two renderers would let them drift into looking like different
 * kinds of claim in the same document.
 *
 * `wrap={false}` per ROW rather than on the block: a label orphaned at the foot
 * of a page from the value it names is a fact the document no longer states,
 * while a block that refuses to break at all would push a long list onto a page
 * of its own.
 */
function renderFactRows(rows: PdfFactRow[], key: React.Key): React.ReactNode {
  return (
    <View key={key}>
      {rows.map((row, index) => (
        <View key={index} style={styles.factRow} wrap={false}>
          <Text style={styles.factLabel}>{row.label}</Text>
          <Text style={row.mono ? styles.factValueMono : styles.factValue}>{row.value}</Text>
        </View>
      ))}
    </View>
  )
}

/**
 * The identification block.
 *
 * Nothing at all when the caller supplied neither a title nor a row — an empty
 * bordered strip above the report would read as a block whose contents failed
 * to print, which is worse than the absence it would be standing in for.
 */
function renderHeader(header: PdfHeader | undefined): React.ReactNode {
  if (!header) return null
  const hasTitle = Boolean(header.title?.trim())
  if (!hasTitle && header.rows.length === 0) return null
  return (
    <View style={styles.header} wrap={false}>
      {hasTitle ? <Text style={styles.headerTitle}>{header.title}</Text> : null}
      {header.rows.length > 0 ? renderFactRows(header.rows, 'header-rows') : null}
    </View>
  )
}

/**
 * One block of a section, verbatim.
 *
 * Deliberately NOT run through `parseInlineFormatting`: these strings are
 * payload — a paragraph number, a law's name, the literal wording of a
 * provision — and an excerpt whose `*` turned into italics would be an export
 * silently editing the sentence a reviewer is meant to check against the
 * regulation.
 */
function renderBlock(block: PdfBlock, index: number): React.ReactNode {
  switch (block.kind) {
    case 'heading':
      return (
        <Text key={index} style={styles.h3}>
          {block.text}
        </Text>
      )
    case 'rows':
      return renderFactRows(block.rows, index)
    case 'prose':
      return (
        <View key={index}>
          <Text style={styles.proseLabel}>{block.label}</Text>
          <Text style={styles.paragraph}>{block.text}</Text>
        </View>
      )
  }
}

function renderSection(section: PdfSection, index: number): React.ReactNode {
  return (
    <View key={`section-${index}`}>
      <Text style={styles.h2}>{section.heading}</Text>
      {section.blocks.map((block, blockIndex) => renderBlock(block, blockIndex))}
    </View>
  )
}

/**
 * `diagramPlaceholder` is threaded down rather than read from a module-level
 * value, because it is the CALLER's sentence — the same rule every other string
 * in this file follows. It travels through `renderBlockquote` too: a fence
 * inside a quote is still a drawing, and a branch that only checked top-level
 * tokens would print the source for exactly the shape a model uses when it
 * quotes a procedure.
 */
function renderToken(token: Token, index: number, diagramPlaceholder: string): React.ReactNode {
  switch (token.type) {
    case 'heading':
      return renderHeading(token as HeadingToken, index)
    case 'paragraph':
      return renderParagraph(token as ParagraphToken, index)
    case 'list':
      return renderList(token as ListToken, index)
    case 'table':
      return renderTable(token as TableToken, index)
    case 'code':
      return renderCode(token as CodeToken, index, diagramPlaceholder)
    case 'blockquote':
      return renderBlockquote(token as BlockquoteToken, index, diagramPlaceholder)
    case 'hr':
      return <View key={index} style={styles.hr} />
    case 'html':
      return renderHtml(token as HtmlToken, index)
    case 'space':
      return null
    default:
      return null
  }
}

function renderHeading(token: HeadingToken, index: number): React.ReactNode {
  const styleMap: Record<number, typeof styles.h1> = {
    1: styles.h1,
    2: styles.h2,
    3: styles.h3,
  }

  return (
    <Text key={index} style={styleMap[token.depth] || styles.h3}>
      {parseInlineFormatting(token.text)}
    </Text>
  )
}

function renderParagraph(token: ParagraphToken, index: number): React.ReactNode {
  return (
    <Text key={index} style={styles.paragraph}>
      {parseInlineFormatting(token.text)}
    </Text>
  )
}

function renderList(token: ListToken, index: number, _nested: boolean = false): React.ReactNode {
  return token.items.map((item, itemIndex) => {
    const bullet = token.ordered ? `${itemIndex + 1}.` : '•'
    const textTokens: Token[] = []
    const nestedLists: Token[] = []

    if (item.tokens?.length) {
      item.tokens.forEach((t: Token) => {
        if (t.type === 'list') {
          nestedLists.push(t)
        } else {
          textTokens.push(t)
        }
      })
    }

    const mainText = textTokens.length
      ? textTokens
          .map((t) => {
            if ('text' in t) {
              return stripHtml(preserveHtmlLinks(t.text as string))
            }
            if ('raw' in t) {
              return stripHtml(preserveHtmlLinks(t.raw as string))
            }
            return ''
          })
          .join(' ')
      : stripHtml(preserveHtmlLinks(item.text))

    const hasNestedContent = nestedLists.length > 0

    return (
      <View
        key={`${index}-${itemIndex}`}
        style={hasNestedContent ? styles.listItemWithNested : styles.listItem}
        wrap={!hasNestedContent}
      >
        <Text style={styles.listItemBullet}>{bullet}</Text>
        <View style={styles.listItemText}>
          <Text>{parseInlineFormatting(mainText)}</Text>
          {nestedLists.map((nestedList, nlIndex) =>
            renderList(nestedList as ListToken, nlIndex, true)
          )}
        </View>
      </View>
    )
  })
}

function renderTable(token: TableToken, index: number): React.ReactNode {
  const getCellText = (cell: unknown): string => {
    if (typeof cell === 'string') {
      return cell
    }
    if (cell && typeof cell === 'object' && 'text' in cell) {
      return (
        (cell as { text?: string; raw?: string }).text ||
        (cell as { text?: string; raw?: string }).raw ||
        String(cell)
      )
    }
    return ''
  }

  const isSmallTable = token.rows.length <= 3

  return (
    <View key={index} style={styles.table} wrap={!isSmallTable}>
      <View style={styles.tableHeaderRow} wrap={false}>
        {token.header.map((cell, cellIndex) => {
          const isLast = cellIndex === token.header.length - 1
          return (
            <View key={cellIndex} style={isLast ? styles.tableCellLast : styles.tableCell}>
              <Text style={styles.tableHeaderCell}>{parseInlineFormatting(getCellText(cell))}</Text>
            </View>
          )
        })}
      </View>

      {token.rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.tableRow} wrap={false}>
          {row.map((cell, cellIndex) => {
            const isLast = cellIndex === row.length - 1
            return (
              <View key={cellIndex} style={isLast ? styles.tableCellLast : styles.tableCell}>
                <Text>{parseInlineFormatting(getCellText(cell))}</Text>
              </View>
            )
          })}
        </View>
      ))}
    </View>
  )
}

function renderCode(token: CodeToken, index: number, diagramPlaceholder: string): React.ReactNode {
  // `language-${lang}` and not `lang` itself, because `isMermaidFence` is
  // asked of a react-markdown className on the other side and there must be one
  // predicate, not two. marked puts the whole info string in `lang`, so
  // ```mermaid, ```mermaid with options and ~~~mermaid all arrive here and all
  // match — and `mermaidjs` does not, which is what the word boundaries in the
  // predicate are for.
  if (isMermaidFence(`language-${token.lang ?? ''}`)) {
    return (
      // `wrap={false}`: two rules with the text of one of them on the next page
      // is a reader seeing a rule under a paragraph that has nothing to do with
      // it, and the whole line is three inches wide.
      <View key={index} style={styles.diagramPlaceholder} wrap={false}>
        <Text style={styles.diagramPlaceholderText}>{diagramPlaceholder}</Text>
      </View>
    )
  }

  const lineCount = token.text.split('\n').length
  const isSmallCodeBlock = lineCount <= 5

  return (
    <View key={index} style={styles.codeBlock} wrap={!isSmallCodeBlock}>
      <Text>{token.text}</Text>
    </View>
  )
}

function renderBlockquote(
  token: BlockquoteToken,
  index: number,
  diagramPlaceholder: string
): React.ReactNode {
  return (
    <View key={index} style={styles.blockquote}>
      {token.tokens.map((subToken: Token, subIndex: number) =>
        renderToken(subToken, subIndex, diagramPlaceholder)
      )}
    </View>
  )
}

function renderHtml(token: HtmlToken, index: number): React.ReactNode {
  const preMatch = token.raw?.match(/<pre>([\s\S]*?)<\/pre>/i)

  if (preMatch) {
    const content = preMatch[1].trim()
    const lineCount = content.split('\n').length
    const charCount = content.length
    const isSmall = lineCount <= 5 && charCount <= 500

    return (
      <Text key={index} style={styles.preBlock} wrap={!isSmall}>
        {content}
      </Text>
    )
  }

  return null
}

function stripHtml(text: string): string {
  // A single <[^>]*> pass is not idempotent: `<<a>x` loses one tag and the
  // remainder still ends in bare markup. Re-apply until no tag remains so
  // nothing strikes-through into the PDF (js/incomplete-multi-character-sanitization).
  let stripped = text
  let next = text
  do {
    stripped = next
    next = stripped.replace(/<[^>]*>/g, '')
  } while (next !== stripped)
  return stripped
}

/** Convert HTML <a> tags to markdown link syntax so they survive stripHtml. */
function preserveHtmlLinks(text: string): string {
  return text.replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)')
}

function parseInlineFormatting(text: string): React.ReactNode {
  text = preserveHtmlLinks(text)
  text = stripHtml(text)

  const parts: React.ReactNode[] = []
  // Links: [text](url) — supports balanced parens in URLs (e.g. Wikipedia)
  // Bold: **text** or __text__ | Italic: *text* or _text_
  const inlineRegex =
    /(\[([^\]]+)\]\(((?:[^()\s]|\([^)]*\))+)\)|\*\*(.+?)\*\*|\*(.+?)\*|__(.+?)__|_(.+?)_)/g
  let key = 0
  let lastIndex = 0
  let match

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={`text-${key++}`}>{text.substring(lastIndex, match.index)}</Text>)
    }

    const fullMatch = match[0]

    if (fullMatch.startsWith('[') && match[2] && match[3]) {
      const linkText = match[2]
      const linkUrl = match[3]

      if (linkUrl.startsWith('#')) {
        // Anchor links have no destination in a PDF — render as styled text
        parts.push(
          <Text key={`anchor-${key++}`} style={{ fontWeight: 'bold' }}>
            {linkText}
          </Text>
        )
      } else {
        parts.push(
          <Link key={`link-${key++}`} src={linkUrl} style={styles.link}>
            {linkText}
          </Link>
        )
      }
    } else if (fullMatch.startsWith('**') || fullMatch.startsWith('__')) {
      const content = match[4] || match[6]
      parts.push(
        <Text key={`bold-${key++}`} style={{ fontWeight: 'bold' }}>
          {content}
        </Text>
      )
    } else {
      const content = match[5] || match[7]
      parts.push(
        <Text key={`italic-${key++}`} style={{ fontStyle: 'italic' }}>
          {content}
        </Text>
      )
    }

    lastIndex = match.index + fullMatch.length
  }

  if (lastIndex < text.length) {
    parts.push(<Text key={`text-${key++}`}>{text.substring(lastIndex)}</Text>)
  }

  return parts.length > 0 ? parts : text
}
