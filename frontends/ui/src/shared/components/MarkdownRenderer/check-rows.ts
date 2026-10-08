/**
 * A check row's outcome, read off its cell texts: the one reconciliation the
 * page (`directive-shape.ts`) and everything that leaves the app as text
 * (`stripDirectives`, for copy, Word and PDF) share, so the filed document
 * never states a compliance the page refutes (guardrails 1 and 4).
 *
 * Pure over strings: each cell's text as the reader sees it, its trailing
 * `[N]` removed (`valueText`).
 */

import { meetsLimit, parseLimit, parseQuantity, trailingLimit, isPlaceholder, type Limit, type Quantity } from './quantities'
import { isActiveStatus, isOpenStatus, statusTone } from './status-marks'

/** The renderer's own outcome words, drawn in the reader's language. */
export const OUTCOME_PASS = '@pass'
export const OUTCOME_FAIL = '@fail'
export const OUTCOME_CONFLICT = '@conflict'

/** Where a row states its limit: a cell of its own, or the end of the label („Luftschalldämmung ≥ 55 dB"). */
export interface RowLimit {
  limit: Limit
  /** The cell the limit stands in (0 for the label). */
  at: number
  /** The limit as written, for the bar's label. */
  text: string
}

export function rowLimit(texts: readonly string[]): RowLimit | null {
  for (let at = 1; at < texts.length; at++) {
    const limit = parseLimit(texts[at])
    if (limit) return { limit, at, text: texts[at] }
  }
  const embedded = texts[0] ? trailingLimit(texts[0]) : null
  return embedded ? { limit: embedded.limit, at: 0, text: embedded.text } : null
}

export interface RowMeasure {
  /** The cell holding the value. */
  value: number
  limit: RowLimit
  quantity: Quantity
}

/**
 * A row's value and limit. The limit is the first limit cell, or one written
 * at the end of the label; the value is the nearest quantity to it, before it
 * first (`Ist | Soll`), then after it (`Soll | Ist`). Column order is the
 * model's to choose; the reading of it is not.
 */
export function valueAndLimit(texts: readonly string[]): RowMeasure | null {
  const limit = rowLimit(texts)
  if (!limit) return null
  const order = [
    ...Array.from({ length: Math.max(0, limit.at - 1) }, (_, index) => limit.at - 1 - index),
    ...Array.from({ length: Math.max(0, texts.length - limit.at - 1) }, (_, index) => limit.at + 1 + index),
  ]
  for (const at of order) {
    const quantity = parseQuantity(texts[at])
    if (quantity) return { value: at, limit, quantity }
  }
  return null
}

/**
 * A check row's outcome. When the row holds a value and a limit, the renderer
 * computes it, and the computation wins over the word the model wrote: a
 * status that agrees is kept as written; an open word („offen", „zu prüfen")
 * or none is replaced by the computed one; a verdict that CONTRADICTS it
 * („erfüllt" beside 52 dB against ≥ 55 dB, or „teilweise" beside a value that
 * plainly holds) is a Widerspruch the reader must check, never silently
 * either. A word that is no verdict on the value („nicht anwendbar",
 * „ausstehend") stands as written.
 */
export function rowOutcome(written: string, computed: boolean | null): { word: string; replaced: boolean } | null {
  const tone = statusTone(written)
  if (computed === null) return tone ? { word: written, replaced: false } : null
  const expected = computed ? 'success' : 'destructive'
  if (tone === expected) return { word: written, replaced: false }
  if (tone === 'muted') return { word: written, replaced: false }
  if (!tone || isOpenStatus(written)) return { word: computed ? OUTCOME_PASS : OUTCOME_FAIL, replaced: true }
  return { word: OUTCOME_CONFLICT, replaced: true }
}

/**
 * The tally key of an outcome: a written word whose tone is a plain pass or
 * fail counts with the renderer's own, so „erfüllt" and a computed pass land
 * in one bucket and one chip.
 */
export function tallyWord(word: string): string {
  if (word === OUTCOME_PASS || word === OUTCOME_FAIL || word === OUTCOME_CONFLICT) return word
  const tone = statusTone(word)
  if (tone === 'success' && !isActiveStatus(word)) return OUTCOME_PASS
  if (tone === 'destructive' && !isOpenStatus(word)) return OUTCOME_FAIL
  return word
}

/** The last column every one of whose (non-empty) cells is a status word, or -1. */
export function statusColumnOf(rows: readonly (readonly string[])[], columns: number): number {
  for (let column = columns - 1; column >= 0; column--) {
    if (rows.some((texts) => texts.length <= column)) continue
    const words = rows.map((texts) => texts[column]).filter((word) => !isPlaceholder(word))
    if (words.length > 0 && words.every((word) => statusTone(word))) return column
  }
  return -1
}

/** A `:::metrics` row: its value in the second cell, its limit and status after it. */
export function figureOutcome(texts: readonly string[]): { outcome: ReturnType<typeof rowOutcome>; statusAt: number } {
  const limitAt = texts.findIndex((value, index) => index > 1 && parseLimit(value))
  const statusAt = texts.findIndex((value, index) => index > 1 && statusTone(value))
  const quantity = parseQuantity(texts[1] ?? '')
  const limit = limitAt >= 0 ? parseLimit(texts[limitAt]) : null
  const computed = quantity && limit ? meetsLimit(quantity, limit) : null
  return { outcome: rowOutcome(statusAt >= 0 ? texts[statusAt] : '', computed), statusAt }
}
