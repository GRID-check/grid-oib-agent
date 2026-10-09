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
 *    the others are muted but stay readable. With `{by=key}` the cases are
 *    parsed (`cases.ts`) and carried on the table, so the component marks the
 *    project's case from the profile and overrules a mark that disagrees;
 *  - **`:::procedure`**: each item of the list is a step; its first line is
 *    the row, a bold phrase in it the Frist, everything after it (a
 *    `:::details`, a nested list) the detail that opens on click;
 *  - **`:::metrics`**: the rows or items become figures;
 *  - **`:::compare`**: a column marked `:recommended` is highlighted, status
 *    words become marks in every cell, and a copy per variant is built for a
 *    phone, where columns do not fit;
 *  - **`:::actions`**: a `Wer | Was | bis | Fundstelle` table; each row gets a
 *    trailing cell for „Als Aufgabe", which only fills the composer;
 *  - **`:::not-found`**: three panes, „Gesucht in" (filled by the surface from
 *    the retrieval ledger), the closest rule (the quote line) and who decides;
 *  - **`:::subsumption`**: Norm (the quote line) → Sachverhalt (the list) →
 *    Ergebnis (the closing sentence, its trailing status word as a tone);
 *  - **a blockquote ending in a citation** is an excerpt, drawn with its
 *    source in the margin.
 *
 * Pure over the tree: nothing the answer wrote is dropped, only arranged.
 */

import type { Element, ElementContent, Root, RootContent } from 'hast'

import { ANSWER_BLOCK_LABEL_TAG, ANSWER_BLOCK_TAG, ANSWER_MARKER_TAG } from './directives'
import { isPlaceholder, meetsLimit, parseLimit, parseQuantity } from './quantities'
import { isActiveStatus, isOpenStatus, statusTone, trailingStatus } from './status-marks'
import {
  OUTCOME_CONFLICT,
  OUTCOME_FAIL,
  OUTCOME_PASS,
  figureOutcome,
  rowOutcome,
  statusColumnOf,
  tallyWord,
  valueAndLimit,
} from './check-rows'
import { caseKindFor, parseCases, type CaseDescriptor } from './cases'
import { isProjectKey, type ProjectKey } from '@/lib/text/answer-directives'
import {
  capText,
  cellText,
  columnCells,
  elements,
  isElement,
  tailTableIn,
  markStatusCells,
  tableParts,
  textOf,
  valueText,
  visibleText,
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
export const NOT_FOUND_TAG = 'answer-not-found'
export const PANE_TAG = 'answer-pane'
export const SUBSUMPTION_TAG = 'answer-subsumption'
export const SUBSUMPTION_PART_TAG = 'answer-subsumption-part'

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
  return statusColumnOf(
    rows.map(({ cells }) => cells.map((cell) => valueText(text(cell)))),
    head.cells.length
  )
}

/** `word:count,…` in first-seen order, counted as `statusTally` counts. */
function tallyOf(words: string[]): string | null {
  const counts = new Map<string, { word: string; count: number }>()
  for (const written of words) {
    const word = tallyWord(written)
    const key = word.toLocaleLowerCase('de')
    const entry = counts.get(key) ?? { word, count: 0 }
    entry.count += 1
    counts.set(key, entry)
  }
  return counts.size > 0 ? [...counts.values()].map(({ word, count }) => `${word}:${count}`).join(',') : null
}

const outcomeTone = (word: string) =>
  word === OUTCOME_PASS ? 'success' : word === OUTCOME_FAIL ? 'destructive' : word === OUTCOME_CONFLICT ? 'warning' : statusTone(word)

/** What a row action puts in the composer is capped: a row names a subject, it is not a message. */
const ASK_SUBJECT_CHARS = 120
const ASK_DETAIL_CHARS = 240

/**
 * `shapeCheckTable`'s options. `openTail`: the table may still be arriving, so
 * its last row is not held to its limit (a half-written „≤ 4" would draw a
 * bar that flips a token later) and no tally is drawn until it closes.
 */
interface CheckOptions {
  openTail: boolean
}

function shapeCheckTable(table: Element, { openTail }: CheckOptions): void {
  const parts = tableParts(table)
  if (!parts) return
  const { head, rows } = parts
  const text = (cell: Element) => cellText(cell)
  setProps(table, { dataVariant: 'check' })
  const statusColumn = statusColumnByContent(head, rows, text)
  if (statusColumn >= 0) markStatusCells(rows.flatMap((row) => row.cells[statusColumn] ?? []), (cell) => valueText(text(cell)))
  const outcomes: string[] = []
  rows.forEach(({ row, cells }, index) => {
    const arriving = openTail && index === rows.length - 1
    const pair = arriving ? null : valueAndLimit(cells.map((cell) => valueText(text(cell))))
    const computed = pair ? meetsLimit(pair.quantity, pair.limit.limit) : null
    if (pair && computed !== null) {
      setProps(cells[pair.value], {
        dataBarLimitText: pair.limit.text,
        dataBarValue: String(pair.quantity.value),
        dataBarLimit: String(pair.limit.limit.value),
        dataBarBound: pair.limit.limit.bound,
        dataBarPass: computed ? 'true' : 'false',
      })
    }
    const status = statusColumn >= 0 ? cells[statusColumn] : undefined
    const outcome = arriving ? null : rowOutcome(status ? valueText(text(status)) : '', computed)
    if (outcome) outcomes.push(outcome.word)
    if (status && outcome?.replaced) setProps(status, { dataOutcome: outcome.word, dataStatus: outcomeTone(outcome.word) })
    if (outcome?.word === OUTCOME_CONFLICT) setProps(row, { dataConflict: 'true' })
    // „Dazu fragen": a row the check leaves open, in the model's words or the renderer's.
    const open = outcome ? outcome.word === OUTCOME_CONFLICT || isOpenStatus(outcome.word) : false
    if (!status || !open) return
    const skip = new Set([0, statusColumn, pair?.value ?? -1, pair?.limit.at ?? -1])
    const detail = cells
      .filter((_, at) => !skip.has(at))
      .map((cell) => valueText(visibleText(cell)))
      .filter((value) => !isPlaceholder(value))
      .join(' · ')
    setProps(status, {
      dataAsk: cells[0] ? capText(valueText(visibleText(cells[0])), ASK_SUBJECT_CHARS) : '',
      dataAskDetail: capText(detail, ASK_DETAIL_CHARS),
    })
  })
  const tally = rows.length >= 2 && outcomes.length === rows.length ? tallyOf(outcomes) : null
  // An open check reserves the tally's line from its header on: a check is
  // read for its outcome, so it nearly always has one, and a line inserted
  // above the rows when the block closed pushed the whole table down.
  // A check that closes without one keeps the line where it streamed
  // (`closed`, as `rehypeTableShape` says it): dropping it pulled the rows up.
  const settledTally = openTail ? undefined : (tally ?? table.properties?.dataTally)
  setProps(table, {
    dataTally: settledTally,
    dataTallyReserve: openTail ? 'true' : settledTally ? undefined : 'closed',
  })
  // A check every row of which passes says so in one line; the rows stay one click away.
  if (tally && outcomes.every((word) => outcomeTone(word) === 'success')) {
    setProps(table, { dataCollapsed: 'true', dataPassCount: String(outcomes.length) })
  }
}

// ---------------------------------------------------------------------------
// :::cases
// ---------------------------------------------------------------------------

/** The texts of one column of `rows`, or null when a row lacks the cell. */
const columnTexts = (rows: Row[], column: number): string[] | null => {
  const cells = columnCells(rows, column)
  return cells ? cells.map((cell) => valueText(cellText(cell))) : null
}

/**
 * The column of a cases table the project's value is held against, and the
 * cases it states. A class case is searched in every column, a range or a text
 * in the first one that parses.
 */
function caseColumn(by: ProjectKey, head: Row, rows: Row[], skip: number): { column: number; cases: CaseDescriptor[] } | null {
  const kind = caseKindFor(by)
  for (let column = 0; column < head.cells.length; column++) {
    if (column === skip) continue
    const texts = columnTexts(rows, column)
    const cases = texts ? parseCases(kind, texts) : null
    if (cases) return { column, cases }
  }
  return null
}

/** Settle a `by=` table's cases on it, for the component that matches the project's value. */
function shapeCasesBy(table: Element, by: ProjectKey, head: Row, rows: Row[], statusColumn: number): void {
  const found = caseColumn(by, head, rows, statusColumn)
  if (!found) return
  // Each case's name on the ruler: the first other column that is not the status („GK 4").
  const labelColumn = head.cells.findIndex((_, column) => column !== found.column && column !== statusColumn)
  const labels = rows.map(({ cells }) => valueText(cellText(cells[labelColumn >= 0 ? labelColumn : found.column] ?? cells[0])))
  setProps(table, {
    dataBy: by,
    dataCases: JSON.stringify(found.cases),
    dataCaseLabels: JSON.stringify(labels),
  })
  rows.forEach(({ row, cells }, index) => {
    setProps(row, { dataCaseIndex: String(index) })
    if (cells[0]) setProps(cells[0], { dataCaseIndex: String(index), dataCaseLead: statusColumn < 0 ? 'true' : undefined })
    const status = statusColumn >= 0 ? cells[statusColumn] : undefined
    if (!status) return
    setProps(status, {
      dataCaseIndex: String(index),
      dataCaseStatus: 'true',
      dataCaseClaim: isActiveStatus(valueText(cellText(status))) ? 'true' : undefined,
    })
  })
}

/** The case text of a list item: what it says before its colon („Fluchtniveau bis 7 m: GK 3"). */
function itemCaseText(item: Element, kind: CaseDescriptor['kind']): string {
  const text = textOf(item).replace(/\s+/g, ' ').trim()
  if (kind === 'class') return text
  const colon = text.indexOf(':')
  return colon > 0 ? text.slice(0, colon) : text
}

function shapeCases(block: Element): void {
  const byValue = String(block.properties?.dataBy ?? '')
  const by = isProjectKey(byValue) ? byValue : null
  for (const table of descendants(block, 'table')) {
    const parts = tableParts(table)
    if (!parts) continue
    setProps(table, { dataVariant: 'cases' })
    const statusColumn = statusColumnByContent(parts.head, parts.rows, cellText)
    for (const { row, cells } of parts.rows) {
      const status = cells[statusColumn]
      if (status && isActiveStatus(valueText(cellText(status)))) setProps(row, { dataActive: 'true' })
    }
    if (by) shapeCasesBy(table, by, parts.head, parts.rows, statusColumn)
    const rows = parts.rows.map(({ row }) => row)
    if (!rows.some((row) => row.properties?.dataActive)) continue
    for (const row of rows) if (!row.properties?.dataActive) setProps(row, { dataMuted: 'true' })
  }
  for (const list of [...descendants(block, 'ul'), ...descendants(block, 'ol')]) {
    const items = elements(list, 'li')
    setProps(list, { dataVariant: 'cases' })
    if (by) {
      const kind = caseKindFor(by)
      const cases = parseCases(kind, items.map((item) => itemCaseText(item, kind)))
      if (cases) {
        const labels = items.map((item) => {
          const text = textOf(item).replace(/\s+/g, ' ').trim()
          const colon = text.indexOf(':')
          return colon > 0 ? text.slice(colon + 1).trim() : text
        })
        setProps(list, { dataBy: by, dataCases: JSON.stringify(cases), dataCaseLabels: JSON.stringify(labels) })
        items.forEach((item, index) => setProps(item, { dataCaseIndex: String(index) }))
      }
    }
    if (!items.some((item) => item.properties?.dataActive)) continue
    for (const item of items) if (!item.properties?.dataActive) setProps(item, { dataMuted: 'true' })
  }
}

// ---------------------------------------------------------------------------
// :::actions
// ---------------------------------------------------------------------------

const ACTION_HEADERS: Record<'who' | 'what' | 'by' | 'source', ReadonlySet<string>> = {
  who: new Set(['wer', 'who', 'rolle', 'role', 'zuständig', 'zustaendig', 'owner']),
  what: new Set(['was', 'what', 'maßnahme', 'massnahme', 'aufgabe', 'task', 'action']),
  by: new Set(['bis', 'by', 'frist', 'termin', 'wann', 'when', 'due']),
  source: new Set(['fundstelle', 'quelle', 'grundlage', 'source', 'reference']),
}

/** Each role's column, by its header, else by its place in `Wer | Was | bis | Fundstelle`. */
function actionColumns(head: Row): Record<keyof typeof ACTION_HEADERS, number> {
  const headers = head.cells.map((cell) => cellText(cell).toLocaleLowerCase('de'))
  const find = (role: keyof typeof ACTION_HEADERS, fallback: number) => {
    const at = headers.findIndex((header) => ACTION_HEADERS[role].has(header))
    return at >= 0 ? at : fallback < headers.length ? fallback : -1
  }
  return { who: find('who', 0), what: find('what', 1), by: find('by', 2), source: find('source', 3) }
}

export const TASK_CELL = 'task'

function shapeActions(block: Element): void {
  for (const table of descendants(block, 'table')) {
    const parts = tableParts(table)
    if (!parts) continue
    setProps(table, { dataVariant: 'actions' })
    const columns = actionColumns(parts.head)
    // What goes into the composer is what the reader sees in the cell, capped.
    const at = (cells: Element[], column: number) =>
      column >= 0 && cells[column] ? capText(valueText(visibleText(cells[column])), ASK_DETAIL_CHARS) : ''
    // The trailing column „Als Aufgabe" sits in: a header only a screen reader reads.
    parts.head.row.children.push(el('th', { dataTaskHead: 'true' }, []))
    for (const { row, cells } of parts.rows) {
      if (columns.who >= 0 && cells[columns.who]) setProps(cells[columns.who], { dataRole: 'true' })
      const what = at(cells, columns.what)
      row.children.push(
        el(
          'td',
          {
            dataCell: TASK_CELL,
            dataTaskWho: at(cells, columns.who),
            dataTaskWhat: what,
            dataTaskBy: isPlaceholder(at(cells, columns.by)) ? '' : at(cells, columns.by),
            dataTaskSource: at(cells, columns.source),
          },
          []
        )
      )
    }
  }
}

// ---------------------------------------------------------------------------
// :::not-found
// ---------------------------------------------------------------------------

const DECIDES_LEAD = /^\s*(?:entscheidet|zuständig|zustaendig|decides|decided by)\s*:\s*/i

/** „Entscheidet: die Baubehörde …" without the lead the pane's own label says. */
function dropDecidesLead(nodes: ElementContent[]): ElementContent[] {
  const first = nodes.find((node) => isElement(node) && node.tagName === 'p') as Element | undefined
  if (!first) return nodes
  const lead = first.children[0]
  if (lead?.type === 'text' && DECIDES_LEAD.test(lead.value)) {
    lead.value = lead.value.replace(DECIDES_LEAD, '')
  } else if (lead && isElement(lead) && lead.tagName === 'strong' && DECIDES_LEAD.test(`${textOf(lead)} `)) {
    first.children = first.children.slice(1)
    const next = first.children[0]
    if (next?.type === 'text') next.value = next.value.replace(/^\s*:?\s*/, '')
  }
  return nodes
}

const contentOf = (block: Element): ElementContent[] =>
  block.children.filter((child) => !(child.type === 'text' && !child.value.trim()))

function shapeNotFound(block: Element): void {
  const children = contentOf(block)
  const rule = children.filter((child) => isElement(child) && child.tagName === 'blockquote')
  const rest = children.filter((child) => !rule.includes(child))
  block.children = [
    el(NOT_FOUND_TAG, {}, [
      el(PANE_TAG, { dataPane: 'searched' }, []),
      el(PANE_TAG, { dataPane: 'rule' }, rule),
      el(PANE_TAG, { dataPane: 'decides' }, dropDecidesLead(rest)),
    ]),
  ]
}

// ---------------------------------------------------------------------------
// :::subsumption
// ---------------------------------------------------------------------------

function shapeSubsumption(block: Element): void {
  const children = contentOf(block)
  const listAt = children.findIndex((child) => isElement(child) && (child.tagName === 'ul' || child.tagName === 'ol'))
  const lastList = children.reduce((last, child, index) => (isElement(child) && (child.tagName === 'ul' || child.tagName === 'ol') ? index : last), -1)
  const norm = listAt < 0 ? children.filter((child) => isElement(child) && child.tagName === 'blockquote') : children.slice(0, listAt)
  const facts = listAt < 0 ? [] : children.slice(listAt, lastList + 1)
  const result = listAt < 0 ? children.filter((child) => !norm.includes(child)) : children.slice(lastList + 1)
  const outcome = trailingStatus(result.map((node) => textOf(node)).join(' '))
  block.children = [
    el(SUBSUMPTION_TAG, {}, [
      el(SUBSUMPTION_PART_TAG, { dataPart: 'norm' }, norm),
      el(SUBSUMPTION_PART_TAG, { dataPart: 'facts' }, facts),
      el(SUBSUMPTION_PART_TAG, { dataPart: 'result', dataTone: outcome?.tone, dataStatusWord: outcome?.word }, result),
    ]),
  ]
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
  return verdictOf(rowOutcome(statusText, pass))
}

const verdictOf = (outcome: ReturnType<typeof rowOutcome>): { tone: string; verdict: string } =>
  outcome ? { tone: outcomeTone(outcome.word) ?? 'none', verdict: outcome.word } : { tone: 'none', verdict: '' }

function figuresFromTable(table: Element): Figure[] {
  const parts = tableParts(table)
  if (!parts) return []
  return parts.rows.map(({ cells }) => {
    const texts = cells.map((cell) => valueText(cellText(cell)))
    const limitAt = texts.findIndex((value, index) => index > 1 && parseLimit(value))
    return {
      label: cells[0]?.children ?? [],
      value: cells[1]?.children ?? [],
      limit: limitAt >= 0 ? cells[limitAt].children : [],
      ...verdictOf(figureOutcome(texts).outcome),
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

/**
 * A label set in bold or italics, its colon inside (`**Dichte:** 0,8`) or
 * right after it (`**Dichte**: 0,8`): the colon is in no top-level text node.
 */
function boldLabel(nodes: ElementContent[]): [ElementContent[], ElementContent[]] | null {
  const at = nodes.findIndex((node) => !(node.type === 'text' && !node.value.trim()))
  const lead = nodes[at]
  if (!lead || !isElement(lead) || (lead.tagName !== 'strong' && lead.tagName !== 'em')) return null
  const rest = nodes.slice(at + 1)
  const label = textOf(lead)
  if (/:\s*$/.test(label)) {
    return [[{ type: 'text', value: label.replace(/\s*:\s*$/, '') }], trimLeadingSpace(rest)]
  }
  const next = rest[0]
  if (next?.type === 'text' && /^\s*:/.test(next.value)) {
    return [[lead], trimLeadingSpace([{ type: 'text', value: next.value.replace(/^\s*:/, '') }, ...rest.slice(1)])]
  }
  return null
}

const trimLeadingSpace = (nodes: ElementContent[]): ElementContent[] => {
  const first = nodes[0]
  return first?.type === 'text' ? [{ type: 'text', value: first.value.trimStart() }, ...nodes.slice(1)] : nodes
}

/** `Label: Wert (≤ Grenze)`, one list item. */
function figureFromItem(item: Element): Figure | null {
  const first = item.children.find((child) => isElement(child) && child.tagName === 'p') as Element | undefined
  const inline = first ? first.children : item.children
  const parts = boldLabel(inline) ?? splitAt(inline, /:\s*/)
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
  // A copy per variant, without ids: a footnote reference's id would be
  // duplicated, and a back-link could land on the hidden copy.
  const withoutIds = (node: ElementContent): ElementContent => {
    if (node.type !== 'element') return node
    const { id: _id, ...properties } = node.properties ?? {}
    return { ...node, properties, children: node.children.map(withoutIds) }
  }
  const clone = (nodes: ElementContent[]): ElementContent[] => structuredClone(nodes).map(withoutIds)
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

interface ShapeOptions {
  /** The text is still arriving and this tree is its last block. */
  openTail: boolean
  /** The table the tree ends in, the one an open tail may still be writing (`tailTableIn`). */
  lastTable: Element | null
}

function shapeBlocks(node: Element | Root, options: ShapeOptions): void {
  const isLastTable = (table: Element) => table === options.lastTable
  for (const child of node.children as (RootContent | ElementContent)[]) {
    if (!isElement(child)) continue
    shapeBlocks(child, options)
    if (child.tagName === 'blockquote') {
      const citation = excerptCitation(child)
      if (citation) setProps(child, { dataExcerpt: citation.number, dataExcerptHref: citation.href || undefined })
      continue
    }
    const name = blockName(child)
    // A check is its first table: a block left unclosed runs to the end of the
    // text, and a later, unrelated table is not a check.
    if (name === 'check') {
      const table = descendants(child, 'table')[0]
      if (table) shapeCheckTable(table, { openTail: options.openTail && isLastTable(table) })
    }
    else if (name === 'cases') shapeCases(child)
    else if (name === 'procedure') shapeSteps(child)
    else if (name === 'metrics') shapeFigures(child)
    else if (name === 'compare') shapeComparison(child)
    else if (name === 'details') shapeDetails(child)
    else if (name === 'actions') shapeActions(child)
    else if (name === 'not-found') shapeNotFound(child)
    else if (name === 'subsumption') shapeSubsumption(child)
  }
}

export interface DirectiveShapeOptions {
  /** The text is still arriving and this is its last block: its last table row may be half-written. */
  openTail?: boolean
}

/** The rehype plugin; run it after `rehypeTableShape`. */
export function rehypeDirectiveShape(options: DirectiveShapeOptions = {}) {
  return (tree: Root) => {
    consumeMarkers(tree, [])
    const openTail = options.openTail === true
    shapeBlocks(tree, { openTail, lastTable: openTail ? tailTableIn(tree) : null })
  }
}
