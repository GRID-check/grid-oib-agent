/**
 * What a GFM table in an answer IS, read once off its cells, for the renderer.
 *
 * The answer writes its checks, comparisons and values-by-class as tables
 * (`piloti_static.md`, <formatting> STRUCTURE). Three things about such a table
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

import { statusTone } from './status-marks'

/** Headers a Fundstelle column goes by. */
const SOURCE_HEADERS = new Set(['fundstelle', 'quelle', 'grundlage', 'source', 'reference', 'references'])
/** Headers a status column goes by. */
const STATUS_HEADERS = new Set(['status', 'erfüllt', 'ergebnis', 'bewertung', 'result'])

const isElement = (node: RootContent | ElementContent | Root): node is Element =>
  (node as Element).type === 'element'

const elements = (node: Element | Root, tag: string): Element[] =>
  (node.children as (RootContent | ElementContent)[]).filter(
    (child): child is Element => isElement(child) && child.tagName === tag
  )

export function textOf(node: ElementContent | RootContent): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(textOf).join('')
  return ''
}

const cellText = (cell: Element) => textOf(cell).trim().replace(/\s+/g, ' ')
const key = (text: string) => text.toLocaleLowerCase('de')

/** A body row and its cells, the row kept so a cell is removed from it without a search. */
interface Row {
  row: Element
  cells: Element[]
}

const cellsOf = (row: Element) =>
  (row.children as ElementContent[]).filter(
    (child): child is Element => isElement(child) && (child.tagName === 'td' || child.tagName === 'th')
  )

/** The table's header row and body rows, or null for a table without both. */
function tableParts(table: Element): { head: Row; rows: Row[] } | null {
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
const columnCells = (rows: Row[], column: number): Element[] | null => {
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
const TRAILING_CITATIONS = /(?:\s*\[(\d+)\])+\s*$/

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
      const match = last.value.match(TRAILING_CITATIONS)
      const trimmed = last.value.replace(/\s+$/, '')
      if (match && [...match[0].matchAll(/\[(\d+)\]/g)].every((m) => cited.has(m[1]))) {
        last.value = last.value.slice(0, match.index).replace(/\s+$/, '')
      } else if (trimmed !== last.value) {
        last.value = trimmed
      } else {
        break
      }
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

/** A cell holding a sentence rather than a value or a phrase. */
const PROSE_CELL_CHARS = 140
/** A column name too long to sit beside its value in a stacked row. */
const LONG_LABEL_CHARS = 16

/**
 * `word:count,…` for a status column, in first-seen order; null when there is
 * none worth counting. Counted by the word, not its spelling: „Erfüllt" and
 * „erfüllt" are one outcome, shown as it was first written.
 */
function statusTally(cells: Element[] | null, text: (cell: Element) => string): string | null {
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
function markStatusCells(cells: Element[], text: (cell: Element) => string): void {
  for (const cell of cells) {
    const tone = statusTone(text(cell))
    if (tone) cell.properties = { ...cell.properties, dataStatus: tone }
  }
}

function shapeTable(table: Element): void {
  const parts = tableParts(table)
  if (!parts) return
  const { head, rows } = parts
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
    const cells = columnCells(rows, statusColumn)
    const tally = statusTally(cells, text)
    if (tally) table.properties = { ...table.properties, dataTally: tally }
    markStatusCells(rows.flatMap((row) => row.cells[statusColumn] ?? []), text)
  }
  const lifted = liftSharedSource(table, sourceColumn, head, rows, text) ? sourceColumn : -1
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

function visitTables(node: Root | Element): void {
  for (const child of node.children) {
    if (!isElement(child)) continue
    if (child.tagName === 'table') shapeTable(child)
    else visitTables(child)
  }
}

/** The rehype plugin. */
export function rehypeTableShape() {
  return (tree: Root) => visitTables(tree)
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
