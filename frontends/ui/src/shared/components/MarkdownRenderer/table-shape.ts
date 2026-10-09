/**
 * What a GFM table in an answer IS, read once off its cells, for the renderer.
 *
 * The answer writes its checks, comparisons and values-by-class as tables
 * (`piloti_static.md`, <formatting> STRUCTURE). Four things about such a table
 * are knowable only from all of its rows at once, which a per-cell component
 * never sees, so this rehype pass settles them and leaves the answer on the
 * element's properties:
 *
 *  - **A Fundstelle column that says one thing.** When every row cites the same
 *    source, the column is the same `[1]` five times over and the reader learns
 *    nothing per row. It is lifted out of the grid into a `<caption>` (drawn
 *    under the table), keeping its citation link.
 *  - **The tally of a Status column.** A check of eight criteria is read for
 *    its outcome first: `data-tally` carries the count per status word, and the
 *    table draws it above the rows. Each status cell carries its tone
 *    (`data-status`), so only a Status column's words are drawn as marks.
 *  - **A citation said twice in a row.** A row whose Fundstelle cell carries
 *    `[2]` does not also need `[2]` at the end of its Geltungsbereich; the
 *    trailing copy is dropped (live answers wrote both on every row).
 *  - **The row that holds.** A row whose Status cell says „trifft zu" or
 *    „aktuell" is the case that applies or the step the project is at; it
 *    carries `data-active` and is tinted, as `condition_tree`'s active branch
 *    and `process_map`'s current step were.
 *  - **A column of values.** When every cell of a column is a number with a
 *    unit („1.200 m²", „3,5 %") or a limit („≥ 55 dB"), the column carries
 *    `data-numeric` and is set right-aligned, so the digits line up.
 *  - **The label of every cell.** On a phone a four-column table does not fit;
 *    below a container width each row stacks, and a cell names its column from
 *    `data-label`, the way a form does. A table whose cells hold sentences
 *    (`data-stack="always"`) stacks at every width: a paragraph in a 200px
 *    column is a tower of three-word lines on any screen.
 *
 * Pure over the hast tree, so the answer's own citation links and status words
 * are untouched: only where they sit changes.
 */

import type { Element, ElementContent, Root, RootContent } from 'hast'

import { isPlaceholder, parseLimit, parseQuantity } from './quantities'
import { isActiveStatus, statusTone } from './status-marks'

/** Headers a Fundstelle column goes by. */
const SOURCE_HEADERS = new Set(['fundstelle', 'quelle', 'grundlage', 'source', 'reference', 'references'])
/** Headers a status column goes by. */
const STATUS_HEADERS = new Set(['status', 'erfüllt', 'ergebnis', 'bewertung', 'result'])

export const isElement = (node: RootContent | ElementContent | Root): node is Element =>
  (node as Element).type === 'element'

export const elements = (node: Element | Root, tag: string): Element[] =>
  (node.children as (RootContent | ElementContent)[]).filter(
    (child): child is Element => isElement(child) && child.tagName === tag
  )

export function textOf(node: ElementContent | RootContent): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(textOf).join('')
  return ''
}

export const cellText = (cell: Element) => textOf(cell).trim().replace(/\s+/g, ' ')

const MATH_CLASSES = new Set(['katex', 'katex-display'])
const isMath = (node: Element): boolean => {
  const classes = node.properties?.className
  return Array.isArray(classes) && classes.some((name) => MATH_CLASSES.has(String(name)))
}

/** Control, zero-width and bidi-override characters: nothing a reader sees. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/**
 * The text a reader SEES in a node, for anything that leaves the page as the
 * reader's own words (a question put in the composer). Math is left out: its
 * hidden MathML and TeX annotation are not what the cell shows, and
 * `\phantom{…}` or `\color{transparent}{…}` would otherwise carry text the
 * reader never saw into a user turn.
 */
export function visibleText(node: ElementContent | RootContent): string {
  const raw = (function walk(current: ElementContent | RootContent): string {
    if (current.type === 'text') return current.value
    if (current.type !== 'element' || isMath(current)) return ''
    return current.children.map(walk).join('')
  })(node)
  return raw.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
}

/** `text` cut to `max` characters, the cut marked. */
export const capText = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
const key = (text: string) => text.toLocaleLowerCase('de')

/** A body row and its cells, the row kept so a cell is removed from it without a search. */
export interface Row {
  row: Element
  cells: Element[]
}

export const cellsOf = (row: Element) =>
  (row.children as ElementContent[]).filter(
    (child): child is Element => isElement(child) && (child.tagName === 'td' || child.tagName === 'th')
  )

/** The table's header row and body rows, or null for a table without both. */
export function tableParts(table: Element): { head: Row; rows: Row[] } | null {
  const thead = elements(table, 'thead')[0]
  const tbody = elements(table, 'tbody')[0]
  const headRow = thead && elements(thead, 'tr')[0]
  if (!headRow || !tbody) return null
  return {
    head: { row: headRow, cells: cellsOf(headRow) },
    rows: elements(tbody, 'tr').map((row) => ({ row, cells: cellsOf(row) })),
  }
}

/** Every row's cell in `column`, or null when a row is short of it. */
export const columnCells = (rows: Row[], column: number): Element[] | null => {
  const cells = rows.map((row) => row.cells[column])
  return cells.every(Boolean) ? cells : null
}

/** Lift a single-valued Fundstelle column into a caption; true when it did. */
function liftSharedSource(table: Element, column: number, head: Row, rows: Row[], text: (cell: Element) => string): boolean {
  if (column < 0 || rows.length < 2 || head.cells.length < 3) return false
  const cells = columnCells(rows, column)
  if (!cells) return false
  const first = text(cells[0])
  if (!first || cells.some((cell) => text(cell) !== first)) return false
  for (const { row, cells: rowCells } of [head, ...rows]) {
    const cell = rowCells[column]
    row.children = row.children.filter((child) => child !== cell)
  }
  table.children.push({
    type: 'element',
    tagName: 'caption',
    properties: { dataLabel: text(head.cells[column]) },
    children: cells[0].children,
  })
  return true
}

const CITATION = /^\[(\d+)\]$/

/** The `[N]` `value` ends with, read backwards by hand: a regex anchored at `$` rescans the whole cell per start position. */
function lastCitation(value: string): { number: string; start: number } | null {
  if (!value.endsWith(']')) return null
  let open = value.length - 1
  while (open > 0 && value[open - 1] >= '0' && value[open - 1] <= '9') open--
  if (open === value.length - 1 || value[open - 1] !== '[') return null
  return { number: value.slice(open, -1), start: open - 1 }
}

/**
 * `value` without trailing whitespace and without the run of `[N]` it ends
 * with, when `cited` holds every number in that run; otherwise only trimmed.
 * Linear in the text: a `/(?:\s*\[(\d+)\])+\s*$/` over a long cell was not.
 */
function withoutTrailingCitations(value: string, cited: Set<string>): string {
  const trimmed = value.trimEnd()
  let rest = trimmed
  for (let citation = lastCitation(rest); citation; citation = lastCitation(rest)) {
    if (!cited.has(citation.number)) return trimmed
    rest = rest.slice(0, citation.start).trimEnd()
  }
  return rest
}

/** The citation numbers a cell holds, e.g. `{2}` for a Fundstelle cell `[2]`. */
const citationsIn = (cell: Element): Set<string> =>
  new Set([...textOf(cell).matchAll(/\[(\d+)\]/g)].map((match) => match[1]))

/**
 * Drop the `[N]` a cell ends with when its row's Fundstelle already carries
 * every one of them — unless that is all the cell says. A cell whose whole
 * content is the repeated citation was emptied to a blank, which reads as a
 * value missing; the citation in its place says where the row stands.
 */
function dropTrailingCitations(cell: Element, cited: Set<string>): void {
  // Worked on a copy, text nodes included, so a drop that would empty the
  // cell is simply not applied.
  const children = (cell.children as ElementContent[]).map((child) => (child.type === 'text' ? { ...child } : child))
  for (;;) {
    const last = children[children.length - 1]
    if (!last) break
    if (last.type === 'text') {
      const value = withoutTrailingCitations(last.value, cited)
      if (value === last.value) break
      last.value = value
      if (!last.value) children.pop()
      continue
    }
    const marker = isElement(last) ? textOf(last).trim().match(CITATION) : null
    if (!marker || !cited.has(marker[1])) break
    children.pop()
  }
  if (children.map(textOf).join('').trim()) cell.children = children
}

/** A row's other cells lose the trailing citations its Fundstelle cell repeats. */
function dropRepeatedCitations(column: number, rows: Row[]): void {
  if (column < 0) return
  for (const { cells } of rows) {
    const source = cells[column]
    if (!source) continue
    const cited = citationsIn(source)
    if (cited.size === 0) continue
    cells.forEach((cell, index) => {
      if (index !== column) dropTrailingCitations(cell, cited)
    })
  }
}

/** A cell's text without the citations it ends with, for reading its value. */
export const valueText = (text: string): string => {
  // By hand, as `withoutTrailingCitations`: an anchored `(?:\s*\[\d+\])+\s*$`
  // rescans a long run of citations once per start position.
  let rest = text.trimEnd()
  for (let citation = lastCitation(rest); citation; citation = lastCitation(rest)) {
    rest = rest.slice(0, citation.start).trimEnd()
  }
  return rest.trim()
}

/** Every row whose status cell names it the one that holds carries `data-active`. */
function markActiveRows(rows: Row[], column: number, text: (cell: Element) => string): void {
  for (const { row, cells } of rows) {
    const cell = cells[column]
    if (cell && isActiveStatus(text(cell))) row.properties = { ...row.properties, dataActive: 'true' }
  }
}

/**
 * Every column whose cells are all values or limits (a dash for a missing one
 * allowed, at least one real value) carries `data-numeric`, header included.
 */
function markNumericColumns(head: Row, rows: Row[], text: (cell: Element) => string, judged: Row[] = rows): void {
  head.cells.forEach((headCell, column) => {
    const cells = columnCells(judged, column)
    if (!cells || cells.length === 0) return
    let values = 0
    for (const cell of cells) {
      const value = valueText(text(cell))
      if (isPlaceholder(value)) continue
      if (!parseQuantity(value) && !parseLimit(value)) return
      values += 1
    }
    if (values === 0) return
    const marked = judged === rows ? cells : rows.flatMap((row) => row.cells[column] ?? [])
    for (const cell of [headCell, ...marked]) cell.properties = { ...cell.properties, dataNumeric: 'true' }
  })
}

/** A cell holding a sentence rather than a value or a phrase. */
const PROSE_CELL_CHARS = 140
/** A column name too long to sit beside its value in a stacked row. */
const LONG_LABEL_CHARS = 16

/**
 * `word:count,…` for a status column, in first-seen order; null when there is
 * none worth counting. Counted by the word, not its spelling: „Erfüllt" and
 * „erfüllt" are one outcome, shown as it was first written.
 */
export function statusTally(cells: Element[] | null, text: (cell: Element) => string): string | null {
  if (!cells || cells.length < 3) return null
  const counts = new Map<string, { word: string; count: number }>()
  for (const cell of cells) {
    const word = text(cell)
    if (!statusTone(word)) return null
    const entry = counts.get(key(word)) ?? { word, count: 0 }
    entry.count += 1
    counts.set(key(word), entry)
  }
  return counts.size > 0 ? [...counts.values()].map(({ word, count }) => `${word}:${count}`).join(',') : null
}

/** Every cell of a Status column that holds a status word carries its tone, for the renderer's mark. */
export function markStatusCells(cells: Element[], text: (cell: Element) => string): void {
  for (const cell of cells) {
    const tone = statusTone(text(cell))
    if (tone) cell.properties = { ...cell.properties, dataStatus: tone }
  }
}

/**
 * `open`: the table may still be arriving (the last table of the block the
 * stream is writing). GFM pads a row still being written with empty cells, so
 * its cells say nothing yet about the whole table, and a decision read off
 * them toggled per token: the Fundstelle column was lifted, restored and
 * lifted again, the tally above the table came and went, a column flipped
 * its alignment (stream audit 2026-10, A5). So an open table:
 *
 *  - judges its columns by its complete rows only (every row but the last);
 *  - lifts no column: a lift is undone by the first row that cites something
 *    else, and only a closed table cannot get one. It lifts once, when it
 *    closes;
 *  - draws no tally, but reserves its line (`data-tally-reserve`) from the
 *    header on, so the chips fade into a line that was already there instead
 *    of pushing the table down by a row when it closes. A table that closes
 *    with no tally after all (too few rows to count, or a last row without a
 *    status word) says `closed`: the renderer keeps the empty line where the
 *    table streamed, because dropping it then pulled the table up by a row at
 *    the very moment it finished. A reload has no line to keep.
 *
 * Stacking reads every row, the last included: a cell only grows, so a table
 * that turns prose-stacked stays so.
 */
function shapeTable(table: Element, open: boolean): void {
  const parts = tableParts(table)
  if (!parts) {
    stackHeaderOnly(table, open)
    return
  }
  const { head, rows } = parts
  const complete = open ? rows.slice(0, -1) : rows
  const columnOf = (headers: ReadonlySet<string>) => head.cells.findIndex((cell) => headers.has(key(cellText(cell))))
  const sourceColumn = columnOf(SOURCE_HEADERS)
  // First, so the tally and the lift read the cells as they will be shown: a
  // status cell „erfüllt [2]" beside a Fundstelle „[2]" is „erfüllt".
  dropRepeatedCitations(sourceColumn, rows)
  // Each cell's text once: read by the tally, the lift, the labels and the
  // prose test, and this pass runs on every streamed token.
  const texts = new Map<Element, string>()
  const text = (cell: Element) => {
    let value = texts.get(cell)
    if (value === undefined) texts.set(cell, (value = cellText(cell)))
    return value
  }
  const statusColumn = columnOf(STATUS_HEADERS)
  if (statusColumn >= 0) {
    // What the open table reserved on its last frame: every row but the one
    // being written says a status word. Read the same way once it closes.
    const held = rows
      .slice(0, -1)
      .every(({ cells }) => cells[statusColumn] !== undefined && statusTone(text(cells[statusColumn])))
    const tally = open ? null : statusTally(columnCells(rows, statusColumn), text)
    if (tally) table.properties = { ...table.properties, dataTally: tally }
    else if (held) table.properties = { ...table.properties, dataTallyReserve: open ? 'true' : 'closed' }
    markStatusCells(rows.flatMap((row) => row.cells[statusColumn] ?? []), text)
    markActiveRows(rows, statusColumn, text)
  }
  const lifted = !open && liftSharedSource(table, sourceColumn, head, rows, text) ? sourceColumn : -1
  markNumericColumns(head, rows, text, complete)
  // Labels AFTER the lift, so a cell names the column it still sits in.
  const kept = <T>(items: T[]) => items.filter((_, index) => index !== lifted)
  const labels = kept(head.cells).map(text)
  const prose = rows.some((row) => row.cells.some((cell) => text(cell).length > PROSE_CELL_CHARS))
  if (labels.length >= 2 && prose) table.properties = { ...table.properties, dataStack: 'always' }
  else if (labels.length >= 3) table.properties = { ...table.properties, dataStack: 'true' }
  // A label the stacked row sets beside its value gets 38% of a phone: a long
  // one („Was darzustellen bzw. zu belegen ist") wraps to three lines and
  // squeezes the value, so such a table sets every label above its value.
  if (labels.slice(1).some((label) => label.length > LONG_LABEL_CHARS)) {
    table.properties = { ...table.properties, dataLabels: 'above' }
  }
  for (const row of rows) {
    kept(row.cells).forEach((cell, index) => {
      cell.properties = { ...cell.properties, dataLabel: labels[index] ?? '' }
    })
  }
}

/**
 * A table of its header alone (its rows still to come) stacks as it will once
 * they do. Undecided, it drew its header as a table row on a phone and then,
 * at the first row, hid it and restacked: the header showed for a frame and
 * vanished (stream audit 2026-10). Only the column count is known here, so
 * only the container-width stack is decided; a prose stack waits for a cell.
 * An open one with a Status column reserves the tally's line already: held
 * only from the first row on, the line pushed the header down a row there.
 */
function stackHeaderOnly(table: Element, open: boolean): void {
  const thead = elements(table, 'thead')[0]
  const headRow = thead && elements(thead, 'tr')[0]
  if (!headRow) return
  const headers = cellsOf(headRow)
  if (headers.length >= 3) table.properties = { ...table.properties, dataStack: 'true' }
  if (open && headers.some((cell) => STATUS_HEADERS.has(key(cellText(cell))))) {
    table.properties = { ...table.properties, dataTallyReserve: 'true' }
  }
}

function visitTables(node: Root | Element, open: Element | null): void {
  for (const child of node.children) {
    if (!isElement(child)) continue
    if (child.tagName === 'table') shapeTable(child, child === open)
    else visitTables(child, open)
  }
}

/**
 * The table a text still arriving may be writing: the one its tree ENDS in,
 * found down the chain of last children (a table at the end of a list item or
 * a `:::check` counts). A table with anything after it is finished, and so is
 * every table but this one; reading "the last table in the tree" instead held
 * a finished table open while the paragraph after it streamed, and the block
 * view and the whole document disagreed about it.
 */
export function tailTableIn(node: Element | Root): Element | null {
  let current: Element | Root = node
  for (;;) {
    const children = current.children as (RootContent | ElementContent)[]
    let last: RootContent | ElementContent | undefined
    for (let index = children.length - 1; index >= 0 && !last; index--) {
      const child = children[index]
      if (!(child.type === 'text' && child.value.trim() === '') && child.type !== 'comment') last = child
    }
    if (!last || !isElement(last)) return null
    if (last.tagName === 'table') return last
    current = last
  }
}

export interface TableShapeOptions {
  /** The text is still arriving and this tree is its last block: its last table may be half-written. */
  openTail?: boolean
}

/** The rehype plugin. */
export function rehypeTableShape(options: TableShapeOptions = {}) {
  return (tree: Root) => visitTables(tree, options.openTail === true ? tailTableIn(tree) : null)
}

/** A `data-tally` value back as `[word, count]` pairs. */
export function parseTally(tally: unknown): [string, number][] {
  if (typeof tally !== 'string' || !tally) return []
  return tally.split(',').flatMap((entry) => {
    const at = entry.lastIndexOf(':')
    const count = Number(entry.slice(at + 1))
    return at > 0 && Number.isFinite(count) ? [[entry.slice(0, at), count] as [string, number]] : []
  })
}
