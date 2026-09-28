/**
 * A number with a unit, and a limit it is held to, read off a table cell.
 *
 * The answer writes values the way a planner writes them: „1.200 m²", „3,5 %",
 * „0,35 W/m²K", and limits as „≥ 55 dB", „max. 1.200 m²". Two things in the
 * renderer read them: a column of nothing but values is set right-aligned
 * (`table-shape.ts`), and a check row that has a value and a limit draws the
 * one against the other (`directive-shape.ts`). Both need the number itself, so
 * it is parsed once, here, and nothing is guessed that the cell did not say:
 * „EI 60" is a class, not a value, and a unit that differs from the limit's
 * draws no bar.
 */

export interface Quantity {
  value: number
  /** As written, or '' for a bare number. */
  unit: string
}

export interface Limit extends Quantity {
  /** `min`: the value must reach it. `max`: the value must stay under it. */
  bound: 'min' | 'max'
  /** `>` and `<`: the limit itself does not pass. */
  strict: boolean
}

/** Digits with the separators a German or English number may carry. */
const NUMBER = '[+\\-\u2212]?\\d(?:[\\d.,\'\u2019\\u00a0\\u202f ]*\\d)?'
/** A unit: one run of letters and symbols after the number, never a second number. */
const UNIT = String.raw`[^\d\s|][^\s|]{0,11}`
const QUANTITY = new RegExp(String.raw`^(?:ca\.\s*|~\s*|≈\s*)?(${NUMBER})\s*(${UNIT})?$`)

/** Longer than any value or limit a cell states; the patterns never see more. */
const MAX_VALUE_CHARS = 48

const LIMIT_WORDS: ReadonlyArray<readonly [RegExp, Limit['bound'], boolean]> = [
  [/^(?:≥|>=|min\.|mind\.|mindestens|minimal|min)\s*/i, 'min', false],
  [/^(?:≤|<=|max\.|höchstens|maximal|max)\s*/i, 'max', false],
  [/^>\s*/, 'min', true],
  [/^<\s*/, 'max', true],
]

/**
 * The number a string of digits and separators stands for.
 *
 * With both marks, the later one is the decimal. With dots only, groups of
 * exactly three after each dot are thousands („1.200"), anything else a decimal
 * point („1.25"). A comma alone is the German decimal comma. Spaces and
 * apostrophes group thousands.
 */
export function parseNumber(raw: string): number | null {
  const text = raw.replace(/[\s  '’]/g, '').replace('−', '-')
  if (!/^[+-]?\d[\d.,]*$/.test(text)) return null
  const dot = text.lastIndexOf('.')
  const comma = text.lastIndexOf(',')
  let normal: string
  if (dot >= 0 && comma >= 0) {
    normal = dot > comma ? text.replace(/,/g, '') : text.replace(/\./g, '').replace(',', '.')
  } else if (comma >= 0) {
    if ((text.match(/,/g) ?? []).length > 1) return null
    normal = text.replace(',', '.')
  } else if (dot >= 0) {
    normal = /^[+-]?\d{1,3}(\.\d{3})+$/.test(text) ? text.replace(/\./g, '') : text
    if ((normal.match(/\./g) ?? []).length > 1) return null
  } else {
    normal = text
  }
  const value = Number(normal)
  return Number.isFinite(value) ? value : null
}

/** A cell that is a number, optionally with one unit: „1.200 m²", „90 min", „3,5 %". */
export function parseQuantity(text: string): Quantity | null {
  // A value is a few characters; a sentence is not one, and is not scanned.
  if (text.length > MAX_VALUE_CHARS) return null
  const match = QUANTITY.exec(text.trim())
  if (!match) return null
  const value = parseNumber(match[1])
  return value === null ? null : { value, unit: (match[2] ?? '').trim() }
}

/** A cell that states a bound: „≥ 55 dB", „max. 1.200 m²", „< 0,35 W/m²K". */
export function parseLimit(text: string): Limit | null {
  if (text.length > MAX_VALUE_CHARS) return null
  const trimmed = text.trim()
  for (const [pattern, bound, strict] of LIMIT_WORDS) {
    const match = pattern.exec(trimmed)
    if (!match) continue
    const quantity = parseQuantity(trimmed.slice(match[0].length))
    return quantity ? { ...quantity, bound, strict } : null
  }
  return null
}

/** Whether `value` keeps `limit`, or null when the units say they are not comparable. */
export function meetsLimit(value: Quantity, limit: Limit): boolean | null {
  if (value.unit && limit.unit && value.unit !== limit.unit) return null
  if (limit.bound === 'min') return limit.strict ? value.value > limit.value : value.value >= limit.value
  return limit.strict ? value.value < limit.value : value.value <= limit.value
}

/** A cell that says „no value here": empty, or a dash. */
export const isPlaceholder = (text: string): boolean => /^[\s—–-]*$/.test(text)
