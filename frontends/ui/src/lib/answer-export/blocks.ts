/**
 * The intermediate document model every exporter writes into.
 *
 * Nothing here knows about OOXML, and nothing that BUILDS blocks (the answer
 * assembler, the card renderers, the markdown reader) may know about it either.
 * That separation is the reason a card renderer can be tested by reading its
 * blocks instead of by unzipping a .docx and parsing XML — and it is what lets a
 * second output format be added later without touching a single card renderer.
 *
 * The vocabulary is deliberately small: heading, paragraph, bullet list, table.
 * It is the subset that survives into Word legibly AND stays editable there —
 * which is the whole point of exporting a .docx rather than a picture of one.
 */

/** A run of text inside a paragraph, carrying the emphasis it was written with. */
export interface DocRun {
  text: string
  bold?: boolean
  italic?: boolean
  /** Monospaced — an inline code span or a raw identifier (a GlobalId, a path). */
  mono?: boolean
}

export type DocBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  /** `meta` is the small grey line under a heading (the date, the project). */
  | { kind: 'paragraph'; runs: DocRun[]; style?: 'body' | 'meta' | 'quote' }
  | { kind: 'bullets'; items: DocRun[][] }
  /**
   * `head` is optional because a two-column label/value block is the same
   * structure as a table with no header row, and giving it a second block kind
   * would mean two renderers that must stay in step for no gain.
   */
  | { kind: 'table'; head?: string[]; rows: DocRun[][][] }

/** A plain paragraph — the common case, so it gets a name rather than a literal. */
export const paragraph = (text: string, style?: 'body' | 'meta' | 'quote'): DocBlock => ({
  kind: 'paragraph',
  runs: [{ text }],
  style,
})

/**
 * A `Label: value` line.
 *
 * Used for the document's own header facts rather than for card data: a fact
 * with no value is not emitted as an empty label, because a document that says
 * "Projekt:" with nothing after it states that the answer has no project, which
 * is a claim the stored answer never made.
 */
export const labelled = (label: string, value: string): DocBlock => ({
  kind: 'paragraph',
  runs: [{ text: `${label}: `, bold: true }, { text: value }],
  style: 'meta',
})

/** One table cell holding a single unformatted string. */
export const cell = (text: string): DocRun[] => [{ text }]

/** Drop empty paragraphs and empty tables, so callers can build unconditionally. */
export const compact = (blocks: (DocBlock | null | undefined)[]): DocBlock[] =>
  blocks.filter((block): block is DocBlock => {
    if (!block) return false
    if (block.kind === 'bullets') return block.items.length > 0
    if (block.kind === 'table') return block.rows.length > 0
    if (block.kind === 'paragraph') return block.runs.some((run) => run.text.trim().length > 0)
    return block.text.trim().length > 0
  })
