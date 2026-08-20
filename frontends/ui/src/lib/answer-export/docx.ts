/**
 * {@link DocBlock}s to a Word document (.docx).
 *
 * ## Why .docx, and why hand-written
 *
 * DOCX is the format an answer has to arrive in to become a work product: it is
 * what gets opened, edited, pasted into a Befund and forwarded. A PDF is a
 * picture of an answer; a .docx is an answer somebody can revise and sign.
 *
 * `package.json` carries no Word library — `@react-pdf/renderer` is the only
 * document dependency, and it writes the other format. What the repository DOES
 * already have is `@/lib/bim/zip`, a deterministic store-only ZIP writer built
 * for BCF, and a .docx is an OPC package: a zip of four small XML parts. So the
 * whole of this module is the XML, and no dependency is added at all — the same
 * trade `zip.ts` documents for BCF, for the same reason.
 *
 * The subset written here is minimal ON PURPOSE. No numbering part, no theme,
 * no settings, no hyperlink relationships:
 *
 *  - **Bullets** are paragraphs indented with a literal `•`, not a `numPr`
 *    reference. A numbering definition that disagrees with the paragraphs
 *    referencing it makes Word repair the file on open, and a repaired file is
 *    one the reader is told not to trust. A bulleted paragraph cannot fail that
 *    way and is still a real, editable Word list item to the reader.
 *  - **Links** are written as text. A hyperlink needs a relationship per link
 *    in `document.xml.rels`; the URLs in an exported answer belong in the
 *    reference list as readable text anyway, where they can be checked by eye.
 *
 * Everything is escaped through {@link escapeXml}, including the parts that look
 * like they cannot contain markup: a source title is model output, and a `&` in
 * one would otherwise produce a package Word refuses to open.
 *
 * ## The one optional part
 *
 * `docProps/custom.xml` is written only for {@link DocxOptions.aiProvenance}.
 * An OPC part is three edits, not one — the bytes, an `Override` in
 * `[Content_Types].xml` giving them a content type, and a `Relationship` from
 * the package root that reaches them — and a part that is present but
 * unregistered is not an unread part, it is a package Word declines to open.
 * All three live in {@link renderDocx} for that reason, keyed off the same
 * value, so none of them can be added without the others.
 */

import 'server-only'
import { createZip, type ZipEntry } from '@/lib/bim/zip'
import {
  AI_GENERATOR_NAME,
  AI_PROVENANCE_PROPERTIES,
  type AiProvenance,
} from '@/lib/ai-provenance'
import type { DocBlock, DocRun } from './blocks'

/** A4 in twentieths of a point, the unit every OOXML measurement uses. */
const PAGE_WIDTH_TWIPS = 11906
const PAGE_HEIGHT_TWIPS = 16838
const MARGIN_TWIPS = 1134
/** Usable width — the table grid has to add up to this or Word re-flows it. */
const CONTENT_WIDTH_TWIPS = PAGE_WIDTH_TWIPS - 2 * MARGIN_TWIPS

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/**
 * XML text escaping.
 *
 * The control-character strip is not decoration: XML 1.0 has no way to
 * represent most C0 codes at all, not even as a numeric reference, so one
 * stray form feed in a stored answer would produce a package that opens as
 * "unreadable content" rather than as a document missing one character.
 */
export const escapeXml = (value: string): string =>
  value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * One run, with its line breaks preserved.
 *
 * A stored answer's prose keeps its newlines, and `w:t` collapses them — so a
 * multi-line note would arrive in Word as one run-on line. Splitting into
 * `<w:br/>`-separated `w:t` elements keeps the shape the author wrote.
 */
const renderRun = (run: DocRun): string => {
  if (!run.text) return ''
  const properties = [
    run.bold ? '<w:b/>' : '',
    run.italic ? '<w:i/>' : '',
    run.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : '',
  ].join('')
  const body = run.text
    .split('\n')
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join('<w:br/>')
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${body}</w:r>`
}

const renderParagraph = (runs: DocRun[], style?: string, extraProperties = ''): string => {
  const pPr = `${style ? `<w:pStyle w:val="${style}"/>` : ''}${extraProperties}`
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs.map(renderRun).join('')}</w:p>`
}

/** An empty paragraph. Word needs one between two tables, or it merges them. */
const SPACER = '<w:p/>'

const renderCell = (runs: DocRun[], width: number, header: boolean): string => {
  const shading = header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''
  const content = header ? runs.map((run) => ({ ...run, bold: true })) : runs
  // `w:tc` must contain at least one `w:p`: an empty cell with no paragraph is
  // the single most common way a hand-written table makes Word repair the file.
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shading}</w:tcPr>` +
    `${renderParagraph(content.length > 0 ? content : [{ text: '' }], 'TableText')}</w:tc>`
  )
}

const BORDER =
  '<w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
    .join('') +
  '</w:tblBorders>'

const renderTable = (block: Extract<DocBlock, { kind: 'table' }>): string => {
  const columns = Math.max(block.head?.length ?? 0, ...block.rows.map((row) => row.length), 1)
  // Distributed evenly rather than measured: the remainder goes to the last
  // column so the grid sums to the text width exactly. A grid that does not is
  // silently re-flowed by Word, which is how a two-column label table ends up
  // with a 90%-wide label column.
  const width = Math.floor(CONTENT_WIDTH_TWIPS / columns)
  const widths = Array.from({ length: columns }, (_, index) =>
    index === columns - 1 ? CONTENT_WIDTH_TWIPS - width * (columns - 1) : width
  )

  const pad = (row: DocRun[][]): DocRun[][] =>
    Array.from({ length: columns }, (_, index) => row[index] ?? [{ text: '' }])

  const headerRow = block.head
    ? `<w:tr><w:trPr><w:tblHeader/></w:trPr>${block.head
        .map((text, index) => renderCell([{ text }], widths[index], true))
        .join('')}</w:tr>`
    : ''

  const bodyRows = block.rows
    .map(
      (row) =>
        `<w:tr>${pad(row)
          .map((runs, index) => renderCell(runs, widths[index], false))
          .join('')}</w:tr>`
    )
    .join('')

  return (
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' +
    `${BORDER}<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>` +
    '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    `${headerRow}${bodyRows}</w:tbl>${SPACER}`
  )
}

const renderBlock = (block: DocBlock): string => {
  switch (block.kind) {
    case 'heading':
      return renderParagraph([{ text: block.text }], `Heading${block.level}`)
    case 'paragraph':
      return renderParagraph(
        block.runs,
        block.style === 'meta' ? 'Meta' : block.style === 'quote' ? 'Quote' : 'Body'
      )
    case 'bullets':
      return block.items
        .map((runs) =>
          renderParagraph(
            [{ text: '• ' }, ...runs],
            'Body',
            '<w:ind w:left="360" w:hanging="360"/>'
          )
        )
        .join('')
    case 'table':
      return renderTable(block)
  }
}

const SECTION =
  `<w:sectPr><w:pgSz w:w="${PAGE_WIDTH_TWIPS}" w:h="${PAGE_HEIGHT_TWIPS}"/>` +
  `<w:pgMar w:top="${MARGIN_TWIPS}" w:right="${MARGIN_TWIPS}" w:bottom="${MARGIN_TWIPS}" ` +
  `w:left="${MARGIN_TWIPS}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/**
 * What a machine is told about how the document came to exist.
 *
 * The printed block on page one is for the reader; this is for everything else
 * — a records system, a Behörde's intake, a compliance scan — which is what
 * the AI Act's transparency obligation actually asks for: marking that does
 * not depend on somebody reading page one and believing it.
 *
 * An alias rather than its own shape since the same report is also filed as a
 * PDF: the two formats carry the marking through different mechanisms (an OPC
 * part here, the Info dictionary there) but they must agree on WHAT is being
 * marked, and two structurally identical interfaces are how they stop agreeing.
 * The names live in `@/lib/ai-provenance`; see that module's header.
 */
export type DocxProvenance = AiProvenance

export interface DocxOptions {
  /**
   * Present when the content was generated and not reviewed by a human.
   *
   * Absent — the default — leaves the package byte-identical to what it was
   * before this option existed: no part, no override, no relationship. A
   * marking on every file marks nothing.
   */
  aiProvenance?: DocxProvenance
}

/**
 * The FMTID every user-defined custom property carries.
 *
 * Not a value we choose — OOXML fixes it for the user-defined property set,
 * and a different GUID puts the properties in a set Word does not show.
 */
const CUSTOM_PROPERTIES_FMTID = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}'

/**
 * `docProps/custom.xml`.
 *
 * `pid` counts from 2 because 0 and 1 are reserved in the property set, and it
 * is assigned here from the array's own order rather than written per property
 * — two properties sharing a pid is the malformed shape, and hand-numbering is
 * how it happens.
 */
const customProperties = (provenance: DocxProvenance): string => {
  const properties: { name: string; value: string }[] = [
    { name: AI_PROVENANCE_PROPERTIES.generated, value: '<vt:bool>true</vt:bool>' },
    {
      name: AI_PROVENANCE_PROPERTIES.generator,
      value: `<vt:lpwstr>${escapeXml(AI_GENERATOR_NAME)}</vt:lpwstr>`,
    },
    { name: AI_PROVENANCE_PROPERTIES.humanReviewed, value: '<vt:bool>false</vt:bool>' },
  ]
  if (provenance.runId) {
    properties.push({
      name: AI_PROVENANCE_PROPERTIES.runId,
      value: `<vt:lpwstr>${escapeXml(provenance.runId)}</vt:lpwstr>`,
    })
  }

  return (
    XML_DECLARATION +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    properties
      .map(
        (property, index) =>
          `<property fmtid="${CUSTOM_PROPERTIES_FMTID}" pid="${index + 2}" ` +
          `name="${escapeXml(property.name)}">${property.value}</property>`
      )
      .join('') +
    '</Properties>'
  )
}

const contentTypes = (withProvenance: boolean): string =>
  XML_DECLARATION +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  (withProvenance
    ? '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>'
    : '') +
  '</Types>'

const packageRels = (withProvenance: boolean): string =>
  XML_DECLARATION +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  (withProvenance
    ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>'
    : '') +
  '</Relationships>'

const DOCUMENT_RELS =
  XML_DECLARATION +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>'

/**
 * One paragraph style per block kind.
 *
 * Real named styles rather than direct formatting, because the reader is going
 * to EDIT this file: a heading that is a style is one they can restyle,
 * renumber and pull into a table of contents; a heading that is bold 16pt text
 * is one they have to redo by hand in every document we ever send them.
 */
const style = (id: string, name: string, definition: string): string =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
  `<w:basedOn w:val="Normal"/><w:qFormat/>${definition}</w:style>`

const heading = (level: number, size: number, spacing: number): string =>
  style(
    `Heading${level}`,
    `heading ${level}`,
    `<w:pPr><w:keepNext/><w:spacing w:before="${spacing}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
      `<w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`
  )

const STYLES =
  XML_DECLARATION +
  `<w:styles xmlns:w="${W_NS}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/>' +
  '</w:rPr></w:rPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style>' +
  heading(1, 36, 0) +
  heading(2, 28, 240) +
  heading(3, 24, 200) +
  style('Body', 'Body Text', '') +
  style(
    'Meta',
    'Meta',
    '<w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="20"/></w:rPr>'
  ) +
  style(
    'Quote',
    'Quote',
    '<w:pPr><w:ind w:left="360"/><w:spacing w:after="120"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr>'
  ) +
  style(
    'TableText',
    'Table Text',
    '<w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr>'
  ) +
  '</w:styles>'

/**
 * Render blocks into the bytes of a .docx file.
 *
 * The body always ends with a paragraph before `sectPr` — a body whose last
 * element is a table is malformed, and the trailing spacer every table already
 * emits is not enough on its own when the document ends with one.
 */
export function renderDocx(blocks: DocBlock[], options: DocxOptions = {}): Uint8Array {
  const provenance = options.aiProvenance
  const body = blocks.map(renderBlock).join('')
  const document =
    XML_DECLARATION +
    `<w:document xmlns:w="${W_NS}"><w:body>${body}${SPACER}${SECTION}</w:body></w:document>`

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', content: contentTypes(Boolean(provenance)) },
    { path: '_rels/.rels', content: packageRels(Boolean(provenance)) },
    { path: 'word/document.xml', content: document },
    { path: 'word/_rels/document.xml.rels', content: DOCUMENT_RELS },
    { path: 'word/styles.xml', content: STYLES },
  ]
  if (provenance) {
    entries.push({ path: 'docProps/custom.xml', content: customProperties(provenance) })
  }
  return createZip(entries)
}

/** The MIME type a browser needs to hand the bytes to Word. */
export const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
