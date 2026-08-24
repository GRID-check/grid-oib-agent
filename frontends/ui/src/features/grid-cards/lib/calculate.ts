/**
 * The arithmetic behind `CalculationCard` — evaluated HERE, never received.
 *
 * The whole card rests on one invariant: the model supplies operands, an
 * operation and a limit, and this module produces the result, the propagated
 * tolerance band and the verdict. It is the same contract the fifteen
 * schematics are built on (`docs/architecture/cards.md`: the renderer draws to
 * scale and does every piece of geometry and ratio arithmetic itself, so a card
 * cannot show a diagram that disagrees with its own numbers), and it matters
 * more here, because a Rechenweg whose printed result disagrees with its own
 * operands is the artefact that gets screenshotted into an Einreichung.
 *
 * There is no expression parser and there is nothing to parse: a step is one of
 * five closed shapes. A general evaluator would hand the model a grammar and
 * hand this module the job of re-deriving what it meant — and the first
 * ambiguous parse (precedence, a unit inside the expression, a stray bracket)
 * would put a confident wrong number on the card.
 *
 * A pure module rather than logic inside the component, for the reason
 * AGENTS.md gives: the same assertion costs 1.3ms here and 172ms through a
 * mounted tree, and the arithmetic is the part that must be tested hardest.
 */

import type {
  CalculationLimitData,
  CalculationOperandData,
  CalculationStepData,
  DimStatus,
} from '../schematics/types'

/** What one evaluated step yields. `value === null` means it cannot be decided. */
export interface StepResult {
  value: number | null
  /** The propagated ± band, in the step's own unit; null when no input carried one. */
  tolerance: number | null
  /** The step's result unit — `%` on a `percent_ratio`, whatever was declared otherwise. */
  unit: string
  /** Why there is no value: a missing operand, or a division by zero. */
  undecidable: 'missing' | 'undefined' | null
}

/** The evaluated derivation: one result per step, in the same order. */
export type Derivation = StepResult[]

/** `percent_ratio` always yields a percentage — the declared unit is ignored. */
const PERCENT = '%'

const unitOf = (step: CalculationStepData): string =>
  step.operation === 'percent_ratio' ? PERCENT : (step.unit ?? '')

/**
 * One operand resolved against the steps already evaluated.
 *
 * A `step` reference borrows the referenced result's value, band and unit;
 * everything else comes off the operand itself. The backend guarantees the
 * reference points strictly backwards, so `earlier[…]` is always already
 * evaluated — but an out-of-range index is still treated as missing rather than
 * throwing, because a card must degrade to "cannot be decided" and never take
 * the answer's whole card block down.
 */
const resolve = (
  operand: CalculationOperandData,
  earlier: Derivation
): { value: number | null; tolerance: number | null } => {
  if (operand.step != null) {
    const referenced = earlier[operand.step - 1]
    if (!referenced) return { value: null, tolerance: null }
    return { value: referenced.value, tolerance: referenced.tolerance }
  }
  const value = typeof operand.value === 'number' && Number.isFinite(operand.value) ? operand.value : null
  // A band is only ever OUR measurement's; a declared figure is the file's own
  // statement and carries no band of ours, exactly as `LimitBar` reads it.
  const tolerance =
    operand.provenance === 'computed' && typeof operand.tolerance === 'number' && operand.tolerance > 0
      ? operand.tolerance
      : null
  return { value, tolerance }
}

const missing = (unit: string, why: 'missing' | 'undefined'): StepResult => ({
  value: null,
  tolerance: null,
  unit,
  undecidable: why,
})

/**
 * Relative-error propagation for a product or a quotient.
 *
 * To first order the relative errors add: Δ(ab)/|ab| ≈ Δa/|a| + Δb/|b|, and the
 * same for a ratio. An operand sitting exactly at zero has no defined relative
 * error, so the band is dropped rather than reported as infinite — a missing
 * band reads as "not stated", which is what it is, while an infinite one would
 * render as a number.
 */
const relativeBand = (result: number, parts: Array<{ value: number; tolerance: number | null }>): number | null => {
  let relative = 0
  let any = false
  for (const part of parts) {
    if (part.tolerance == null) continue
    if (part.value === 0) return null
    relative += part.tolerance / Math.abs(part.value)
    any = true
  }
  return any ? Math.abs(result) * relative : null
}

/** Evaluate one step against the steps already evaluated before it. */
const evaluateStep = (step: CalculationStepData, earlier: Derivation): StepResult => {
  const unit = unitOf(step)
  const parts = step.operands.map((operand) => ({ operand, ...resolve(operand, earlier) }))
  if (parts.some((part) => part.value == null)) return missing(unit, 'missing')
  const values = parts as Array<{ operand: CalculationOperandData; value: number; tolerance: number | null }>

  switch (step.operation) {
    case 'sum': {
      // The rule's own multiplier scales both the term and its band; |factor|,
      // because a band is a width and a subtraction widens it just as much.
      let total = 0
      let band = 0
      let banded = false
      for (const part of values) {
        const factor = typeof part.operand.factor === 'number' ? part.operand.factor : 1
        total += factor * part.value
        if (part.tolerance != null) {
          band += Math.abs(factor) * part.tolerance
          banded = true
        }
      }
      return { value: total, tolerance: banded ? band : null, unit, undecidable: null }
    }
    case 'product': {
      const product = values.reduce((acc, part) => acc * part.value, 1)
      return { value: product, tolerance: relativeBand(product, values), unit, undecidable: null }
    }
    case 'quotient': {
      const [numerator, denominator] = values
      if (denominator.value === 0) return missing(unit, 'undefined')
      const quotient = numerator.value / denominator.value
      return { value: quotient, tolerance: relativeBand(quotient, values), unit, undecidable: null }
    }
    case 'percent_of': {
      const [base, percent] = values
      const result = (base.value * percent.value) / 100
      return { value: result, tolerance: relativeBand(result, values), unit, undecidable: null }
    }
    case 'percent_ratio': {
      const [part, whole] = values
      if (whole.value === 0) return missing(PERCENT, 'undefined')
      const ratio = (part.value / whole.value) * 100
      return { value: ratio, tolerance: relativeBand(ratio, values), unit: PERCENT, undecidable: null }
    }
    default:
      // `operation` arrives through a `z.any()`-typed union member, so an
      // unknown one must render as undecidable rather than crash the block.
      return missing(unit, 'missing')
  }
}

/** Evaluate every step in order, each seeing the ones before it. */
export const evaluate = (steps: CalculationStepData[]): Derivation => {
  const results: Derivation = []
  for (const step of steps) results.push(evaluateStep(step, results))
  return results
}

/**
 * The verdict of a result against its limit — computed, never supplied.
 *
 * `warning` means the band STRADDLES the bound: at the precision we actually
 * have, the value is on both sides of the line, and drawing a clean pass or
 * fail there would assert a verdict the measurement does not support. Same rule
 * `LimitBar` applies to a measured dimension, and comparator-dependent for the
 * same reason — every value in [45, 55] meets a „≤ 55", so 50 ±5 must not warn
 * against it.
 */
export const verdictFor = (result: StepResult, limit: CalculationLimitData | null | undefined): DimStatus | null => {
  if (!limit) return null
  if (result.value == null) return 'needs_input'
  const band = result.tolerance ?? 0
  const low = result.value - band
  const high = result.value + band

  if (limit.comparator === 'between') {
    const upper = limit.upper ?? limit.value
    // Straddles either bound: part of the band is inside the range and part is
    // not. With no band low === high and neither test can fire.
    if ((low < limit.value && high >= limit.value) || (low <= upper && high > upper)) return 'warning'
    return result.value >= limit.value && result.value <= upper ? 'pass' : 'fail'
  }
  if (limit.comparator === '<=') {
    if (low <= limit.value && high > limit.value) return 'warning'
    return result.value <= limit.value ? 'pass' : 'fail'
  }
  if (high >= limit.value && low < limit.value) return 'warning'
  return result.value >= limit.value ? 'pass' : 'fail'
}

/**
 * How many decimals the result must be printed to so the printed number and the
 * printed verdict cannot disagree.
 *
 * Two decimals is the house format (`fmtNum`), and for almost every derivation
 * here — 2 × 17 + 30, 2.400 ÷ 800, 14 × 1 — it is exact. But a U-value of
 * 0,2504 against a „≤ 0,25" limit rounds to „0,25" and would be printed beside
 * „nicht erfüllt", which is a card arguing with itself in the one place a
 * reader is least able to check it.
 *
 * So: keep the house format, unless rounding to it would move the value across
 * the bound, and in that case print exactly as far as it takes to land on the
 * right side. The verdict stays the one computed from the exact value — it is
 * the DISPLAY that yields, never the arithmetic.
 */
export const resultDecimals = (result: StepResult, limit: CalculationLimitData | null | undefined): number => {
  const exact = verdictFor(result, limit)
  if (result.value == null || exact == null) return 2
  for (let decimals = 2; decimals < 6; decimals += 1) {
    const factor = 10 ** decimals
    const rounded = Math.round(result.value * factor) / factor
    if (verdictFor({ ...result, value: rounded }, limit) === exact) return decimals
  }
  return 6
}
