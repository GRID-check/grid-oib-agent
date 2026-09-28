/**
 * What each block of the answer's dialect IS, settled once over the hast tree
 * so the components that draw it only read properties.
 *
 * Runs after `rehypeTableShape`, whose general table treatment (status marks,
 * the tally, a row that holds, value columns) every table gets. On top of it:
 *
 *  - **markers**: `:current`, `:applies` and `:recommended` mark the list item,
 *    the table row or the header cell they sit in, and are removed;
 *  - **`:::check`**: the status column is found by its CONTENT (every cell
 *    a status word), tallied, and a row that holds a value and a limit
 *    („57 dB" beside „≥ 55 dB") draws the one against the other; an open row
 *    can be asked about;
 *  - **`:::cases`**: once a row or item is marked as the case that applies,
 *    the others are muted but stay readable;
 *  - **`:::procedure`**: each item of the list is a step; its first line is
 *    the row, a bold phrase in it the Frist, everything after it (a
 *    `:::details`, a nested list) the detail that opens on click;
 *  - **`:::metrics`**: the rows or items become figures;
 *  - **`:::compare`**: a column marked `:recommended` is highlighted, status
 *    words become marks in every cell, and a copy per variant is built for a
 *    phone, where columns do not fit;
 *  - **a blockquote ending in a citation** is an excerpt, drawn with its
 *    source in the margin.
 *
 * Pure over the tree: nothing the answer wrote is dropped, only arranged.
 */

import type { Element, ElementContent, Root, RootContent } from 'hast'

import { ANSWER_BLOCK_LABEL_TAG, ANSWER_BLOCK_TAG, ANSWER_MARKER_TAG } from './directives'
import { isPlaceholder, meetsLimit, parseLimit, parseQuantity, type Limit, type Quantity } from './quantities'
import { isActiveStatus, isOpenStatus, statusTone } from './status-marks'
import {
  cellText,
  columnCells,
  elements,
  isElement,
  markStatusCells,
  tableParts,
  textOf,
  valueText,
  type Row,
} from './table-shape'

export const BLOCK_BODY_TAG = 'answer-block-body'
export const STEP_HEAD_TAG = 'answer-step-head'
export const STEP_DUE_TAG = 'answer-step-due'
export const STEP_DETAIL_TAG = 'answer-step-detail'
export const FIGURES_TAG = 'answer-figures'
export const FIGURE_TAG = 'answer-figure'
export const FIGURE_VALUE_TAG = 'answer-figure-value'
export const FIGURE_LABEL_TAG = 'answer-figure-label'
export const FIGURE_LIMIT_TAG = 'answer-figure-limit'
export const COMPARE_STACK_TAG = 'answer-compare-stack'
export const COMPARE_VARIANT_TAG = 'answer-compare-variant'
export const COMPARE_TITLE_TAG = 'answer-compare-title'
export const COMPARE_ROW_TAG = 'answer-compare-row'
export const COMPARE_LABEL_TAG = 'answer-compare-label'
export const COMPARE_VALUE_TAG = 'answer-compare-value'

const el = (tagName: string, properties: Element['properties'], children: ElementContent[]): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
})

const setProps = (node: Element, properties: Element['properties']) => {
  node.properties = { ...node.properties, ...properties }
}

const blockName = (node: Element): string | null =>
  node.tagName === ANSWER_BLOCK_TAG ? String(node.properties?.dataBlock ?? '') : null

/** Every descendant element with `tagName`, in document order, not descending into a nested block. */
function descendants(node: Element | Root, tagName: string): Element[] {
  const found: Element[] = []
  for (const child of node.children as (RootContent | ElementContent)[]) {
    if (!isElement(child)) continue
    if (child.tagName === tagName) found.push(child)
    if (child.tagName !== ANSWER_BLOCK_TAG) found.push(...descendants(child, tagName))
  }
  return found
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const MARKER_HOSTS = new Set(['li', 'tr', 'th'])

/** Move every marker onto the list item, row or header cell it sits in. */
function consumeMarkers(node: Element | Root, hosts: Element[]): void {
  const kept: (RootContent | ElementContent)[] = []
  let changed = false
  for (const child of node.children as (RootContent | ElementContent)[]) {
    if (isElement(child) && child.tagName === ANSWER_MARKER_TAG) {
      const host = hosts[hosts.length - 1]
      const marker = String(child.properties?.dataMarker ?? '')
      if (host) {
        if (marker === 'current') setProps(host, { dataCurrent: 'true', dataActive: 'true' })
        else if (marker === 'applies') setProps(host, { dataActive: 'true' })
        else if (marker === 'recommended') setProps(host, { dataRecommended: 'true' })
        // A header cell says „empfohlen" itself; anywhere else the marker
        // stays and is drawn as its word beside the tint.
        if (host.tagName === 'th') {
          changed = true
          continue
        }
      }
    }
    if (isElement(child)) {
      const isHost = MARKER_HOSTS.has(child.tagName)
      consumeMarkers(child, isHost ? [...hosts, child] : hosts)
    }
    kept.push(child)
  }
  if (!changed) return
  // The space the marker was written after is not part of the text.
  const last = kept[kept.length - 1]
  if (last?.type === 'text') last.value = last.value.trimEnd()
  node.children = kept as typeof node.children
}

// ---------------------------------------------------------------------------
// :::check
// ---------------------------------------------------------------------------

/** The last column every one of whose (non-empty) cells is a status word, or -1. */
function statusColumnByContent(head: Row, rows: Row[], text: (cell: Element) => string): number {
  for (let column = head.cells.length - 1; column >= 0; column--) {
    const cells = columnCells(rows, column)
    if (!cells || cells.length === 0) continue
    const words = cells.map((cell) => valueText(text(cell))).filter((word) => !isPlaceholder(word))
    if (words.length > 0 && words.every((word) => statusTone(word))) return column
  }
  return -1
}

/** A row's value and limit: the first limit cell, and the nearest value before it. */
function valueAndLimit(cells: Element[], text: (cell: Element) => string): { value: number; limit: Limit; quantity: Quantity } | null {
  const limitAt = cells.findIndex((cell, index) => index > 0 && parseLimit(valueText(text(cell))))
  if (limitAt < 0) return null
  const limit = parseLimit(valueText(text(cells[limitAt]))) as Limit
  for (let at = limitAt - 1; at > 0; at--) {
    const quantity = parseQuantity(valueText(text(cells[at])))
    if (quantity) return { value: at, limit, quantity }
  }
  return null
}

/**
 * The outcome a check row states, as a tally word: the model's own status
 * word, or one of the renderer's (`OUTCOME_*`), which the table draws in the
 * reader's language.
 */
export const OUTCOME_PASS = '@pass'
export const OUTCOME_FAIL = '@fail'
export const OUTCOME_CONFLICT = '@conflict'

/**
 * A check row's outcome. When the row holds a value and a limit, the renderer
 * computes it, and the computation wins over the word the model wrote: a
 * status that agrees is kept as written, one that is not a verdict („offen")
 * is replaced by the computed one, and one that CONTRADICTS it („erfüllt"
 * beside 52 dB against ≥ 55 dB) is a Widerspruch the reader must check, never
 * silently either.
 */
function rowOutcome(written: string, computed: boolean | null): { word: string; replaced: boolean } | null {
  const tone = statusTone(written)
  if (computed === null) return tone ? { word: written, replaced: false } : null
  const expected = computed ? 'success' : 'destructive'
  if (tone === expected) return { word: written, replaced: false }
  if (tone === 'success' || tone === 'destructive') return { word: OUTCOME_CONFLICT, replaced: true }
  return { word: computed ? OUTCOME_PASS : OUTCOME_FAIL, replaced: true }
}

/** `word:count,…` in first-seen order, counted as `statusTally` counts. */
function tallyOf(words: string[]): string | null {
  const counts = new Map<string, { word: string; count: number }>()
  for (const word of words) {
    const key = word.toLocaleLowerCase('de')
    const entry = counts.get(key) ?? { word, count: 0 }
    entry.count += 1
    counts.set(key, entry)
  }
  return counts.size > 0 ? [...counts.values()].map(({ word, count }) => `${word}:${count}`).join(',') : null
}

const outcomeTone = (word: string) =>
  word === OUTCOME_PASS ? 'success' : word === OUTCOME_FAIL ? 'destructive' : word === OUTCOME_CONFLICT ? 'warning' : statusTone(word)

function shapeCheckTable(table: Element): void {
  const parts = tableParts(table)
  if (!parts) return
  const { head, rows } = parts
  const text = (cell: Element) => cellText(cell)
  setProps(table, { dataVariant: 'check' })
  const statusColumn = statusColumnByContent(head, rows, text)
  if (statusColumn >= 0) markStatusCells(rows.flatMap((row) => row.cells[statusColumn] ?? []), (cell) => valueText(text(cell)))
  const outcomes: string[] = []
  for (const { row, cells } of rows) {
    const pair = valueAndLimit(cells, text)
    const limitAt = cells.findIndex((cell, index) => index > 0 && parseLimit(valueText(text(cell))))
    const computed = pair ? meetsLimit(pair.quantity, pair.limit) : null
    if (pair && computed !== null) {
      setProps(cells[pair.value], {
        dataBarLimitText: valueText(text(cells[limitAt])),
        dataBarValue: String(pair.quantity.value),
        dataBarLimit: String(pair.limit.value),
        dataBarBound: pair.limit.bound,
        dataBarPass: computed ? 'true' : 'false',
      })
    }
    const status = statusColumn >= 0 ? cells[statusColumn] : undefined
    const outcome = rowOutcome(status ? valueText(text(status)) : '', computed)
    if (outcome) outcomes.push(outcome.word)
    if (status && outcome?.replaced) setProps(status, { dataOutcome: outcome.word, dataStatus: outcomeTone(outcome.word) })
    if (outcome?.word === OUTCOME_CONFLICT) setProps(row, { dataConflict: 'true' })
    // „Dazu fragen": a row the check leaves open, in the model's words or the renderer's.
    const open = outcome ? outcome.word === OUTCOME_CONFLICT || isOpenStatus(outcome.word) : false
    if (!status || !open) continue
    const skip = new Set([0, statusColumn, pair?.value ?? -1, limitAt])
    const detail = cells
      .filter((_, index) => !skip.has(index))
      .map((cell) => valueText(text(cell)))
      .filter((value) => !isPlaceholder(value))
      .join(' · ')
    setProps(status, { dataAsk: cells[0] ? valueText(text(cells[0])) : '', dataAskDetail: detail })
  }
  const tally = rows.length >= 2 && outcomes.length === rows.length ? tallyOf(outcomes) : null
  setProps(table, { dataTally: tally ?? table.properties?.dataTally })
  // A check every row of which passes says so in one line; the rows stay one click away.
  if (tally && outcomes.every((word) => outcomeTone(word) === 'success')) {
    setProps(table, { dataCollapsed: 'true', dataPassCount: String(outcomes.length) })
  }
}

// ---------------------------------------------------------------------------
// :::cases
// ---------------------------------------------------------------------------

function shapeCases(block: Element): void {
  for (const table of descendants(block, 'table')) {
    const parts = tableParts(table)
    if (!parts) continue
    setProps(table, { dataVariant: 'cases' })
    const statusColumn = statusColumnByContent(parts.head, parts.rows, cellText)
    for (const { row, cells } of parts.rows) {
      const status = cells[statusColumn]
      if (status && isActiveStatus(valueText(cellText(status)))) setProps(row, { dataActive: 'true' })
    }
    const rows = parts.rows.map(({ row }) => row)
    if (!rows.some((row) => row.properties?.dataActive)) continue
    for (const row of rows) if (!row.properties?.dataActive) setProps(row, { dataMuted: 'true' })
  }
  for (const list of [...descendants(block, 'ul'), ...descendants(block, 'ol')]) {
    const items = elements(list, 'li')
    setProps(list, { dataVariant: 'cases' })
    if (!items.some((item) => item.properties?.dataActive)) continue
    for (const item of items) if (!item.properties?.dataActive) setProps(item, { dataMuted: 'true' })
  }
}

// ---------------------------------------------------------------------------
// :::procedure
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set(['ul', 'ol', 'table', 'blockquote', 'pre', ANSWER_BLOCK_TAG, 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'])

/** One step: its first line (the row), the Frist in it, and what opens on click. */
function shapeStep(item: Element): void {
  const children = item.children.filter((child) => !(child.type === 'text' && !child.value.trim()))
  let head: ElementContent[]
  let rest: ElementContent[]
  const first = children[0]
  if (first && isElement(first) && first.tagName === 'p') {
    head = first.children
    rest = children.slice(1)
  } else {
    const split = children.findIndex((child) => isElement(child) && BLOCK_TAGS.has(child.tagName))
    head = split < 0 ? children : children.slice(0, split)
    rest = split < 0 ? [] : children.slice(split)
  }
  // The step line says „hier stehen Sie" itself.
  head = head.filter((child) => !(isElement(child) && child.tagName === ANSWER_MARKER_TAG))
  const dueAt = head.findIndex((child) => isElement(child) && child.tagName === 'strong')
  const due = dueAt >= 0 ? (head[dueAt] as Element) : null
  const title = due ? head.filter((_, index) => index !== dueAt) : head
  if (title.length > 0) {
    const last = title[title.length - 1]
    if (last.type === 'text') last.value = last.value.replace(/[\s,–—-]+$/, '')
  }
  for (const detail of rest) {
    if (isElement(detail) && detail.tagName === ANSWER_BLOCK_TAG) setProps(detail, { dataInline: 'true' })
  }
  item.children = [
    el(STEP_HEAD_TAG, {}, title),
    ...(due ? [el(STEP_DUE_TAG, {}, due.children)] : []),
    ...(rest.length > 0 ? [el(STEP_DETAIL_TAG, {}, rest)] : []),
  ]
}

function shapeSteps(block: Element): void {
  const list = block.children.find(
    (child): child is Element => isElement(child) && (child.tagName === 'ol' || child.tagName === 'ul')
  )
  if (!list) return
  const items = elements(list, 'li')
  const current = items.findIndex((item) => item.properties?.dataCurrent)
  setProps(list, { dataVariant: 'steps' })
  items.forEach((item, index) => {
    const phase = current < 0 ? 'none' : index < current ? 'done' : index === current ? 'current' : 'upcoming'
    setProps(item, { dataPhase: phase, dataStep: String(index + 1), dataLast: index === items.length - 1 ? 'true' : undefined })
    shapeStep(item)
  })
}

// ---------------------------------------------------------------------------
// :::metrics
// ---------------------------------------------------------------------------

interface Figure {
  label: ElementContent[]
  value: ElementContent[]
  limit: ElementContent[]
  tone: string
  /** The verdict in words: the stated status, or the renderer's `OUTCOME_*`. */
  verdict: string
}

/** The figure's verdict: its value against its limit when both are there (which wins), else the status it states. */
function figureVerdict(valueText_: string, limitText: string, statusText: string): { tone: string; verdict: string } {
  const quantity = parseQuantity(valueText_)
  const limit = parseLimit(limitText)
  const pass = quantity && limit ? meetsLimit(quantity, limit) : null
  const outcome = rowOutcome(statusText, pass)
  if (!outcome) return { tone: 'none', verdict: '' }
  return { tone: outcomeTone(outcome.word) ?? 'none', verdict: outcome.word }
}

function figuresFromTable(table: Element): Figure[] {
  const parts = tableParts(table)
  if (!parts) return []
  return parts.rows.map(({ cells }) => {
    const texts = cells.map((cell) => valueText(cellText(cell)))
    const limitAt = texts.findIndex((value, index) => index > 1 && parseLimit(value))
    const statusAt = texts.findIndex((value, index) => index > 1 && statusTone(value))
    return {
      label: cells[0]?.children ?? [],
      value: cells[1]?.children ?? [],
      limit: limitAt >= 0 ? cells[limitAt].children : [],
      ...figureVerdict(texts[1] ?? '', limitAt >= 0 ? texts[limitAt] : '', statusAt >= 0 ? texts[statusAt] : ''),
    }
  })
}

/** Split an inline run at the first occurrence of `mark` in a text node. */
function splitAt(nodes: ElementContent[], mark: RegExp): [ElementContent[], ElementContent[]] | null {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (node.type !== 'text') continue
    const match = mark.exec(node.value)
    if (!match) continue
    const before: ElementContent[] = [...nodes.slice(0, index), { type: 'text', value: node.value.slice(0, match.index) }]
    const after: ElementContent[] = [{ type: 'text', value: node.value.slice(match.index + match[0].length) }, ...nodes.slice(index + 1)]
    return [before, after]
  }
  return null
}

/** `Label: Wert (≤ Grenze)`, one list item. */
function figureFromItem(item: Element): Figure | null {
  const first = item.children.find((child) => isElement(child) && child.tagName === 'p') as Element | undefined
  const inline = first ? first.children : item.children
  const parts = splitAt(inline, /:\s*/)
  if (!parts) return null
  const [label, rest] = parts
  const limitSplit = splitAt(rest, /\s*\((?=[^)]*\)\s*$)/)
  const value = limitSplit ? limitSplit[0] : rest
  const limit = limitSplit ? limitSplit[1] : []
  const lastLimit = limit[limit.length - 1]
  if (lastLimit?.type === 'text') lastLimit.value = lastLimit.value.replace(/\)\s*$/, '')
  const valueString = value.map((node) => textOf(node)).join('').trim()
  const limitString = limit.map((node) => textOf(node)).join('').trim()
  return { label, value, limit, ...figureVerdict(valueText(valueString), limitString, '') }
}

function shapeFigures(block: Element): void {
  const index = block.children.findIndex(
    (child) => isElement(child) && (child.tagName === 'table' || child.tagName === 'ul' || child.tagName === 'ol')
  )
  if (index < 0) return
  const source = block.children[index] as Element
  const figures =
    source.tagName === 'table'
      ? figuresFromTable(source)
      : elements(source, 'li').map(figureFromItem)
  if (figures.length === 0 || figures.some((figure) => figure === null)) return
  block.children[index] = el(
    FIGURES_TAG,
    { dataCount: String(figures.length) },
    (figures as Figure[]).map((figure) =>
      el(FIGURE_TAG, { dataTone: figure.tone, dataVerdict: figure.verdict || undefined }, [
        el(FIGURE_VALUE_TAG, {}, figure.value),
        el(FIGURE_LABEL_TAG, {}, figure.label),
        ...(figure.limit.length > 0 ? [el(FIGURE_LIMIT_TAG, {}, figure.limit)] : []),
      ])
    )
  )
}

// ---------------------------------------------------------------------------
// :::compare
// ---------------------------------------------------------------------------

function shapeComparison(block: Element): void {
  const index = block.children.findIndex((child) => isElement(child) && child.tagName === 'table')
  if (index < 0) return
  const table = block.children[index] as Element
  const parts = tableParts(table)
  if (!parts) return
  const { head, rows } = parts
  setProps(table, { dataVariant: 'compare', dataStack: undefined, dataLabels: undefined })
  const recommended = head.cells.findIndex((cell) => cell.properties?.dataRecommended)
  for (const { cells } of rows) {
    cells.forEach((cell, column) => {
      if (column === 0) return
      const tone = statusTone(valueText(cellText(cell)))
      if (tone) setProps(cell, { dataStatus: tone })
      if (column === recommended) setProps(cell, { dataRecommended: 'true' })
    })
  }
  const clone = (nodes: ElementContent[]): ElementContent[] => structuredClone(nodes)
  const variants = head.cells.slice(1).map((headCell, offset) => {
    const column = offset + 1
    return el(COMPARE_VARIANT_TAG, { dataRecommended: column === recommended ? 'true' : undefined }, [
      el(COMPARE_TITLE_TAG, {}, clone(headCell.children)),
      ...rows.map(({ cells }) =>
        el(COMPARE_ROW_TAG, {}, [
          el(COMPARE_LABEL_TAG, {}, clone(cells[0]?.children ?? [])),
          el(COMPARE_VALUE_TAG, { dataStatus: cells[column]?.properties?.dataStatus }, clone(cells[column]?.children ?? [])),
        ])
      ),
    ])
  })
  block.children.splice(index + 1, 0, el(COMPARE_STACK_TAG, {}, variants))
}

// ---------------------------------------------------------------------------
// :::details
// ---------------------------------------------------------------------------

/** A `details` block as its label and one body, so the body can open and close as one. */
function shapeDetails(block: Element): void {
  const children = block.children.filter((child) => !(child.type === 'text' && !child.value.trim()))
  const label = children[0] && isElement(children[0]) && children[0].tagName === ANSWER_BLOCK_LABEL_TAG ? children[0] : null
  const body = label ? children.slice(1) : children
  block.children = [...(label ? [label] : []), el(BLOCK_BODY_TAG, {}, body)]
}

// ---------------------------------------------------------------------------
// Excerpts
// ---------------------------------------------------------------------------

const CITATION_TEXT = /\[(\d+)\]\s*$/

/** The citation a blockquote ends with: its number and, once linked, its href. */
function excerptCitation(quote: Element): { number: string; href: string } | null {
  const paragraphs = elements(quote, 'p')
  const last = paragraphs[paragraphs.length - 1]
  if (!last) return null
  const inline = last.children.filter((child) => !(child.type === 'text' && !child.value.trim()))
  const tail = inline[inline.length - 1]
  if (!tail) return null
  if (isElement(tail) && tail.tagName === 'a') {
    const match = /^\[(\d+)\]$/.exec(textOf(tail).trim())
    const href = String(tail.properties?.href ?? '')
    return match && href.startsWith('#') ? { number: match[1], href } : null
  }
  if (tail.type === 'text') {
    const match = CITATION_TEXT.exec(tail.value)
    return match ? { number: match[1], href: '' } : null
  }
  return null
}

// ---------------------------------------------------------------------------

function shapeBlocks(node: Element | Root): void {
  for (const child of node.children as (RootContent | ElementContent)[]) {
    if (!isElement(child)) continue
    shapeBlocks(child)
    if (child.tagName === 'blockquote') {
      const citation = excerptCitation(child)
      if (citation) setProps(child, { dataExcerpt: citation.number, dataExcerptHref: citation.href || undefined })
      continue
    }
    const name = blockName(child)
    if (name === 'check') descendants(child, 'table').forEach(shapeCheckTable)
    else if (name === 'cases') shapeCases(child)
    else if (name === 'procedure') shapeSteps(child)
    else if (name === 'metrics') shapeFigures(child)
    else if (name === 'compare') shapeComparison(child)
    else if (name === 'details') shapeDetails(child)
  }
}

/** The rehype plugin; run it after `rehypeTableShape`. */
export function rehypeDirectiveShape() {
  return (tree: Root) => {
    consumeMarkers(tree, [])
    shapeBlocks(tree)
  }
}
