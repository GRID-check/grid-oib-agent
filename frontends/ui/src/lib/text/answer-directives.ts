/**
 * The answer's Markdown dialect: a few `remark-directive` blocks that tell the
 * renderer what a run of plain Markdown IS, so it can draw it as richly as the
 * retired cards drew the same content.
 *
 * Markdown is the transport. A directive never carries data a reader would lose
 * without it: wrapped around a GFM table or a list, it only says "this table is
 * a check" or "this list is a procedure". So the dialect has two readers:
 *
 *  - the renderer (`shared/components/MarkdownRenderer/directives.ts`), which
 *    turns each block into its designed form;
 *  - everything that leaves the app as text (copy, Word, PDF), which reads the
 *    same Markdown with the directives taken out ({@link stripDirectives}): a
 *    table stays a table, a `details` block is printed open, `:energy-class[B]` is
 *    „B".
 *
 * The vocabulary is deliberately this small. A name the renderer does not know
 * degrades to its content, never to nothing and never to `:::` on the page.
 */

import { closesCodeFence, openingCodeFence, type CodeFence } from './code-fence'
import {
  OUTCOME_FAIL,
  OUTCOME_PASS,
  figureOutcome,
  rowOutcome,
  statusColumnOf,
  valueAndLimit,
} from '@/shared/components/MarkdownRenderer/check-rows'
import { meetsLimit } from '@/shared/components/MarkdownRenderer/quantities'
import { valueText } from '@/shared/components/MarkdownRenderer/table-shape'

/**
 * Blocks, written `:::name` … `:::` around the Markdown they describe. Mirrors
 * `DIRECTIVE_BLOCKS` in `src/aiq_agent/common/answer_dialect.py`; the parity
 * test (`tests/aiq_agent/common/test_answer_dialect_parity.py`) reads this list.
 */
export const DIRECTIVE_BLOCKS = [
  'check',
  'procedure',
  'cases',
  'metrics',
  'compare',
  'details',
  'actions',
  'not-found',
  'subsumption',
] as const
export type DirectiveBlock = (typeof DIRECTIVE_BLOCKS)[number]

/**
 * Inline markers, written `:name` inside a list item, a table cell or a header.
 * Each maps to the word it prints as when the directives are stripped: German,
 * because that is the answer's language and the word is what the reader keeps.
 */
export const DIRECTIVE_MARKERS = {
  /** The step of a `:::procedure` the project is at. */
  current: 'aktuell',
  /** The case of a `:::cases` that applies to this project. */
  applies: 'trifft zu',
  /** The column of a `:::compare` the answer recommends. */
  recommended: 'empfohlen',
} as const
export type DirectiveMarker = keyof typeof DIRECTIVE_MARKERS

/** The inline project binding, `:project[building_class]`: the model names a key, the renderer prints the value. */
export const PROJECT_DIRECTIVE = 'project'

/**
 * The keys `:project[…]` accepts, each with the project-profile fact it reads
 * (`lib/project-profile/intake-definition.ts` writes them). Mirrors
 * `PROJECT_KEYS` in `src/aiq_agent/common/answer_dialect.py`. There is no
 * `parcel_area_m2`: the profile records no Grundstücksfläche.
 */
export const PROJECT_KEYS = {
  building_class: 'gebaeudeklasse',
  escape_level_m: 'fluchtniveau_m',
  use: 'nutzungen',
  state: 'bundesland',
  storeys: 'geschosse_oberirdisch',
  gross_floor_area_m2: 'bgf_oberirdisch',
} as const
export type ProjectKey = keyof typeof PROJECT_KEYS

export const isProjectKey = (key: string): key is ProjectKey =>
  Object.prototype.hasOwnProperty.call(PROJECT_KEYS, key)

/** The inline directive for an energy performance class, `:energy-class[B]`. */
export const ENERGY_CLASS_DIRECTIVE = 'energy-class'

/** The Energieeffizienzklassen `:energy-class[…]` accepts, best first. */
export const ENERGY_CLASSES = ['A++', 'A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const

/** `:energy-class[b ]` → `B`, or null for anything that is not a class. */
export function energyClass(label: string): (typeof ENERGY_CLASSES)[number] | null {
  const normal = label.replace(/\s+/g, '').toUpperCase()
  return (ENERGY_CLASSES as readonly string[]).includes(normal) ? (normal as (typeof ENERGY_CLASSES)[number]) : null
}

export const isDirectiveBlock = (name: string): name is DirectiveBlock =>
  (DIRECTIVE_BLOCKS as readonly string[]).includes(name)

export const isDirectiveMarker = (name: string): name is DirectiveMarker =>
  Object.prototype.hasOwnProperty.call(DIRECTIVE_MARKERS, name)

/**
 * A container opener: `:::name`, optionally `[label]` and `{attributes}`. A
 * space after the colons (`::: check`) is a slip the renderer repairs, not
 * prose: no answer starts a line with three colons and a word otherwise.
 */
const OPENER = /^([ \t]*)(:{3,})[ \t]*([A-Za-z][\w-]*)(.*)$/
/** A container closer: colons alone on the line. */
const CLOSER = /^([ \t]*)(:{3,})[ \t]*$/
/** A line of colons only, inside code: the parser would read it as a closer of the block around the code. */
const COLON_LINE = /^[ \t]*(:{3,})[ \t]*$/

/**
 * How deep blocks nest, and how many one answer opens. The dialect needs two
 * or three levels (a procedure, a step's details); every level past that
 * lengthens every fence around it, and the parser's work grows with depth
 * times colons, on every streamed token. Past either bound an opener is
 * unwrapped: its fences go, its content stays.
 */
export const MAX_DIRECTIVE_DEPTH = 4
export const MAX_DIRECTIVE_BLOCKS = 64

/**
 * What a line is to the dialect's block structure: an opener, a closer that
 * closes an open block, a line of code, a closer with nothing open (`stray`),
 * an opener or closer past the bounds (`unwrapped`), or none of these.
 */
export type FenceEvent = 'open' | 'close' | 'code' | 'stray' | 'unwrapped' | null

/**
 * Each line's part in the block structure. Code is skipped (`:::` in a fence
 * is code). The one scanner every reader of the structure uses:
 * {@link normalizeDirectiveFences}, and the renderer's block splitter, which
 * must never cut inside an open block. `common/answer_dialect.py` ports it.
 */
export function scanDirectiveFences(lines: readonly string[]): FenceEvent[] {
  let fence: CodeFence | null = null
  /** Open blocks, each `true` when it was unwrapped for the bounds. */
  const stack: boolean[] = []
  let opened = 0
  return lines.map((line): FenceEvent => {
    if (fence) {
      if (closesCodeFence(line, fence)) fence = null
      return 'code'
    }
    const codeFence = openingCodeFence(line)
    if (codeFence) {
      fence = codeFence
      return 'code'
    }
    if (OPENER.test(line)) {
      const kept = stack.filter((unwrapped) => !unwrapped).length
      const unwrapped = kept >= MAX_DIRECTIVE_DEPTH || opened >= MAX_DIRECTIVE_BLOCKS
      stack.push(unwrapped)
      if (unwrapped) return 'unwrapped'
      opened += 1
      return 'open'
    }
    if (CLOSER.test(line)) {
      if (stack.length === 0) return 'stray'
      return stack.pop() ? 'unwrapped' : 'close'
    }
    return null
  })
}

/** How many blocks are open BEFORE each line (an opener's line is at the depth outside it). */
export function directiveDepths(lines: readonly string[]): number[] {
  let depth = 0
  return scanDirectiveFences(lines).map((event) => {
    const before = depth
    if (event === 'open') depth += 1
    else if (event === 'close') depth -= 1
    return before
  })
}

interface OpenContainer {
  /** Line index of the opener. */
  line: number
  /** The colons its fences need: more than any fence or colon line inside it. */
  colons: number
}

/** An opener written canonically: no space after the colons, free words as the `[label]`. */
function canonicalOpener(line: string, colons: string): string {
  return line.replace(OPENER, (_m, indent: string, _c, name: string, rest: string) => {
    const trimmed = rest.trim()
    const words = trimmed && !/^[[{]/.test(trimmed) && /^\s/.test(rest) ? `[${trimmed.replace(/[[\]]/g, '')}]` : rest
    return `${indent}${colons}${name}${words}`
  })
}

/**
 * The same text with every container fence given the colons its nesting needs.
 *
 * `remark-directive` closes a container at the first closing fence with at
 * least as many colons as its opener, so `:::procedure` holding a
 * `:::details` is closed by the details' own `:::` and the procedure's list is
 * cut in two. The outer fence has to be longer (`::::procedure`), which is a
 * rule a writer (a model, a person) gets wrong. So the renderer does not ask:
 * a bare `:::` closes the innermost open block, and each fence is rewritten to
 * one colon more than any fence nested inside it, and more than any line of
 * colons in a code block it holds (the parser closes a container at such a
 * line, fence or not). An unclosed block (a streamed one) stays open and runs
 * to the end of the text, as `remark-directive` runs it.
 *
 * Repairs on the way, so no `:::` reaches the page:
 * - `::: check` and `:::check Brandschutz` become `:::check` and
 *   `:::check[Brandschutz]`;
 * - a closer with nothing open is dropped (after a table it became a row);
 * - an opener past {@link MAX_DIRECTIVE_DEPTH} or {@link MAX_DIRECTIVE_BLOCKS}
 *   loses its fences and keeps its content.
 */
export function normalizeDirectiveFences(markdown: string): string {
  if (!markdown.includes(':::')) return markdown
  const lines = markdown.split('\n')
  const stack: OpenContainer[] = []
  const pairs: { open: number; close: number | null; colons: number }[] = []
  const dropped: number[] = []
  const events = scanDirectiveFences(lines)
  events.forEach((event, index) => {
    if (event === 'open') {
      stack.push({ line: index, colons: 3 })
      return
    }
    if (event === 'stray' || event === 'unwrapped') {
      dropped.push(index)
      return
    }
    if (event === 'code') {
      const run = COLON_LINE.exec(lines[index])
      const inner = stack[stack.length - 1]
      if (run && inner) inner.colons = Math.max(inner.colons, run[1].length + 1)
      return
    }
    if (event !== 'close') return
    const closed = stack.pop() as OpenContainer
    pairs.push({ open: closed.line, close: index, colons: closed.colons })
    const parent = stack[stack.length - 1]
    if (parent) parent.colons = Math.max(parent.colons, closed.colons + 1)
  })
  // Still open at the end of the text: the stream has not closed them yet.
  for (let at = stack.length - 1; at >= 0; at--) {
    const open = stack[at]
    pairs.push({ open: open.line, close: null, colons: open.colons })
    const parent = stack[at - 1]
    if (parent) parent.colons = Math.max(parent.colons, open.colons + 1)
  }
  let changed = dropped.length > 0
  for (const { open, close, colons } of pairs) {
    const fence = ':'.repeat(colons)
    const opener = canonicalOpener(lines[open], fence)
    const closer = close === null ? null : lines[close].replace(CLOSER, (_m, indent: string) => `${indent}${fence}`)
    if (opener !== lines[open] || (close !== null && closer !== lines[close])) changed = true
    lines[open] = opener
    if (close !== null && closer !== null) lines[close] = closer
  }
  if (!changed) return markdown
  for (const index of dropped) lines[index] = ''
  return lines.join('\n')
}

/** `[label]` of an opener, unescaped enough to print. */
const openerLabel = (rest: string): string => {
  const trimmed = rest.trim()
  const match = /^\[([^\]]*)\]/.exec(trimmed)
  if (match) return match[1].trim()
  // Free words after the name (`:::check Brandschutz`) are the label the renderer draws.
  return trimmed && !trimmed.startsWith('{') && /^\s/.test(rest) ? trimmed : ''
}

/**
 * A text directive: `:name`, `:name[label]`, either with `{attributes}`. The
 * label and attributes are bounded: an unclosed `[` over a long line would
 * otherwise be rescanned from every `:name` on it.
 */
const TEXT_DIRECTIVE = /(^|[^\w:\\])(:)([A-Za-z][\w-]{0,63})(?:\[([^\]\n]{0,200})\])?(?:\{[^}\n]{0,200}\})?/g

/** `by=building_class` out of an opener's `{attributes}`, when it names a project key. */
export function casesBy(attributes: string): ProjectKey | null {
  const match = /(?:^|[\s{])by=["']?([A-Za-z][\w-]*)/.exec(attributes)
  return match && isProjectKey(match[1]) ? match[1] : null
}

/**
 * The project keys an answer reads, in the order it first reads them: every
 * `:project[key]`, and the `by=` of every `:::cases`. What the Projektbezug
 * strip under the masthead lists. Code is skipped.
 */
export function projectKeysIn(markdown: string): ProjectKey[] {
  if (!markdown.includes(':')) return []
  const found: ProjectKey[] = []
  const add = (key: string | null) => {
    if (key && isProjectKey(key) && !found.includes(key)) found.push(key)
  }
  let fence: CodeFence | null = null
  for (const line of markdown.split('\n')) {
    if (fence) {
      if (closesCodeFence(line, fence)) fence = null
      continue
    }
    fence = openingCodeFence(line)
    if (fence) continue
    const opener = OPENER.exec(line)
    if (opener) {
      if (opener[3] === 'cases') add(casesBy(opener[4]))
      continue
    }
    for (const [index, part] of line.split(/(`[^`]*`)/).entries()) {
      if (index % 2 === 1) continue
      for (const match of part.matchAll(TEXT_DIRECTIVE)) {
        if (match[3] === PROJECT_DIRECTIVE && match[4] !== undefined) add(match[4].trim())
      }
    }
  }
  return found
}

/** How {@link stripDirectives} prints what only the surface knows. */
export interface StripOptions {
  /** A project fact as text („GK 4", „10,8 m"), or null when the profile lacks it. */
  projectValue?: (key: ProjectKey) => string | null
  /** The renderer's outcome words in the reader's language; German by default, as the answer is. */
  outcomeWords?: OutcomeWords
}

/** The words a reconciled check row prints (`markdown.limitKept`, `limitMissed`, `outcomeConflict`). */
export interface OutcomeWords {
  pass: string
  fail: string
  conflict: string
}

const GERMAN_OUTCOMES: OutcomeWords = { pass: 'erfüllt', fail: 'nicht erfüllt', conflict: 'Widerspruch – prüfen' }

/** A GFM table row's cells, split at unescaped pipes, or null for a line that is not a row. */
function rowCells(line: string): { indent: string; cells: string[] } | null {
  const match = /^([ \t]*)\|(.*)$/.exec(line)
  if (!match) return null
  const cells = match[2].split(/(?<!\\)\|/)
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return { indent: match[1], cells: cells.map((cell) => cell.trim()) }
}

const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/

/**
 * A `:::check` or `:::metrics` table with each row's Status cell as the page
 * draws it: the computed outcome where the row holds a value and a limit
 * (`check-rows.ts`), a contradiction spelled out with the word the answer
 * wrote. The page says „Widerspruch – prüfen"; the copy and the filed
 * document say it too, never the model's „erfüllt" beside it.
 */
function reconcileTable(lines: string[], block: 'check' | 'metrics', words: OutcomeWords): string[] {
  const parsed = lines.map(rowCells)
  if (parsed.length < 3 || parsed.some((row) => row === null) || !DELIMITER_ROW.test(lines[1])) return lines
  const body = (parsed.slice(2) as { indent: string; cells: string[] }[]).map((row) => ({
    ...row,
    texts: row.cells.map((cell) => valueText(cell)),
  }))
  const statusColumn = block === 'check' ? statusColumnOf(body.map((row) => row.texts), (parsed[0] as { cells: string[] }).cells.length) : -1
  const printed = (word: string, written: string) =>
    word === OUTCOME_PASS ? words.pass : word === OUTCOME_FAIL ? words.fail : `${words.conflict} (${written})`
  return [
    lines[0],
    lines[1],
    ...body.map((row, index) => {
      const line = lines[index + 2]
      let at = statusColumn
      let outcome: ReturnType<typeof rowOutcome> = null
      if (block === 'check') {
        if (at < 0) return line
        const measure = valueAndLimit(row.texts)
        const computed = measure ? meetsLimit(measure.quantity, measure.limit.limit) : null
        outcome = rowOutcome(row.texts[at] ?? '', computed)
      } else {
        const figure = figureOutcome(row.texts)
        at = figure.statusAt
        outcome = figure.outcome
      }
      if (at < 0 || !outcome?.replaced) return line
      const cells = [...row.cells]
      const citation = cells[at].slice(valueText(cells[at]).length)
      cells[at] = `${printed(outcome.word, row.texts[at])}${citation}`
      return `${row.indent}| ${cells.join(' | ')} |`
    }),
  ]
}

/**
 * The Markdown with the dialect taken out, for everything that leaves the app
 * as text: the copy button, the Word and PDF export.
 *
 * - A block's fences go; what they held stays as it was written, so a table
 *   is still a table. A `details` block's label becomes a bold line over its
 *   content, which is printed open.
 * - A marker becomes its word in brackets (`:current` → „(aktuell)"), because
 *   it is information: the step the project is at.
 * - `:energy-class[B]` becomes „B".
 * - `:project[key]` becomes the project's value where the surface knows it
 *   ({@link StripOptions.projectValue}), else the key as written: a handle
 *   never reaches paper, and a value the profile lacks is never invented.
 * - Anything else that merely looks like a directive (`10:30`, `Hinweis:Text`)
 *   is left exactly as written, which is also how the renderer shows it.
 *
 * Code is left alone.
 */
export function stripDirectives(markdown: string, options: StripOptions = {}): string {
  if (!markdown.includes(':')) return markdown
  const words = options.outcomeWords ?? GERMAN_OUTCOMES
  let fence: CodeFence | null = null
  const out: string[] = []
  /** The names of the blocks open around the line. */
  const open: string[] = []
  /** The table lines of the check or metrics block being read, held until the table ends. */
  let table: string[] = []
  let tableBlock: 'check' | 'metrics' | null = null
  const flush = () => {
    if (table.length > 0 && tableBlock) out.push(...reconcileTable(table, tableBlock, words).map((line) => stripTextDirectives(line, options)))
    table = []
    tableBlock = null
  }
  for (const line of markdown.split('\n')) {
    const inner = open[open.length - 1]
    if (!fence && (inner === 'check' || inner === 'metrics') && /^[ \t]*\|/.test(line)) {
      tableBlock = inner
      table.push(line)
      continue
    }
    flush()
    if (fence) {
      if (closesCodeFence(line, fence)) fence = null
      out.push(line)
      continue
    }
    fence = openingCodeFence(line)
    if (fence) {
      out.push(line)
      continue
    }
    const opener = OPENER.exec(line)
    if (opener) {
      open.push(opener[3])
      const label = openerLabel(opener[4])
      if (label) out.push(`${opener[1]}**${label}**`, '')
      continue
    }
    if (CLOSER.test(line)) {
      open.pop()
      continue
    }
    out.push(stripTextDirectives(line, options))
  }
  flush()
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** One line's text directives, as {@link stripDirectives} prints them. */
function stripTextDirectives(line: string, options: StripOptions): string {
  if (!line.includes(':')) return line
  // Inline code spans are split out first and left alone.
  return line
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(TEXT_DIRECTIVE, (whole, before: string, _colon, name: string, label?: string) => {
            if (name === ENERGY_CLASS_DIRECTIVE && label !== undefined && energyClass(label)) return `${before}${energyClass(label)}`
            if (isDirectiveMarker(name) && label === undefined) return `${before}(${DIRECTIVE_MARKERS[name]})`
            if (name === PROJECT_DIRECTIVE && label !== undefined) {
              const key = label.trim()
              return `${before}${(isProjectKey(key) && options.projectValue?.(key)) || key}`
            }
            return whole
          })
    )
    .join('')
}
