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
 *    table draws it above the rows.
 *  - **The label of every cell.** On a phone a four-column table does not fit;
 *    below a container width each row stacks, and a cell names its column from
 *    `data-label`, the way a form does.
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

/** The table's header cells and body rows, or null for a table without both. */
function tableParts(table: Element): { head: Element[]; rows: Element[][] } | null {
  const thead = elements(table, 'thead')[0]
  const tbody = elements(table, 'tbody')[0]
  const headRow = thead && elements(thead, 'tr')[0]
  if (!headRow || !tbody) return null
  const cellsOf = (row: Element) =>
    (row.children as ElementContent[]).filter(
      (child): child is Element => isElement(child) && (child.tagName === 'td' || child.tagName === 'th')
    )
  return { head: cellsOf(headRow), rows: elements(tbody, 'tr').map(cellsOf) }
}

/** Every row's cell in `column`, or null when a row is short of it. */
const columnCells = (rows: Element[][], column: number): Element[] | null => {
  const cells = rows.map((row) => row[column])
  return cells.every(Boolean) ? cells : null
}

/** Lift a single-valued Fundstelle column into a caption; true when it did. */
function liftSharedSource(table: Element, head: Element[], rows: Element[][]): boolean {
  const column = head.findIndex((cell) => SOURCE_HEADERS.has(key(cellText(cell))))
  if (column < 0 || rows.length < 2 || head.length < 3) return false
  const cells = columnCells(rows, column)
  if (!cells) return false
  const first = cellText(cells[0])
  if (!first || cells.some((cell) => cellText(cell) !== first)) return false
  for (const row of [head, ...rows]) {
    const cell = row[column]
    const parent = findParent(table, cell)
    if (parent) parent.children = parent.children.filter((child) => child !== cell)
  }
  table.children.push({
    type: 'element',
    tagName: 'caption',
    properties: { dataLabel: cellText(head[column]) },
    children: cells[0].children,
  })
  return true
}

function findParent(root: Element, target: Element): Element | null {
  for (const child of root.children) {
    if (!isElement(child)) continue
    if (child.children.includes(target)) return child
    const found = findParent(child, target)
    if (found) return found
  }
  return null
}

/** `word:count,…` for a status column, in first-seen order; null when there is none worth counting. */
function statusTally(head: Element[], rows: Element[][]): string | null {
  const column = head.findIndex((cell) => STATUS_HEADERS.has(key(cellText(cell))))
  const cells = column < 0 ? null : columnCells(rows, column)
  if (!cells || cells.length < 3) return null
  const counts = new Map<string, number>()
  for (const cell of cells) {
    const word = cellText(cell)
    if (!statusTone(word)) return null
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return counts.size > 0 ? [...counts].map(([word, count]) => `${word}:${count}`).join(',') : null
}

function shapeTable(table: Element): void {
  const parts = tableParts(table)
  if (!parts) return
  const { head, rows } = parts
  const tally = statusTally(head, rows)
  if (tally) table.properties = { ...table.properties, dataTally: tally }
  liftSharedSource(table, head, rows)
  // Labels AFTER the lift, so a cell names the column it still sits in.
  const labels = head.filter((cell) => findParent(table, cell)).map(cellText)
  if (labels.length >= 3) table.properties = { ...table.properties, dataStack: 'true' }
  for (const row of rows) {
    row
      .filter((cell) => findParent(table, cell))
      .forEach((cell, index) => {
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
