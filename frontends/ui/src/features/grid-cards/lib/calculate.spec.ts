/**
 * @vitest-environment node
 */

/**
 * The guard on the one thing `CalculationCard` promises: the RENDERER produces
 * the result, the band and the verdict, and the model supplies only inputs.
 *
 * These are the assertions that would catch the failure the card exists to make
 * impossible — a Rechenweg whose printed answer does not follow from its own
 * operands. They run against the pure module rather than through a mounted
 * component for the reason AGENTS.md gives: the arithmetic is the part that must
 * be tested hardest, and logic in a module costs 1.3ms per test where the same
 * assertion through a React tree costs 172ms.
 */

import { describe, expect, it } from 'vitest'
import { evaluate, resultDecimals, verdictFor } from './calculate'
import type { CalculationStepData } from '../schematics/types'

const step = (partial: Partial<CalculationStepData> & Pick<CalculationStepData, 'operation' | 'operands'>) =>
  ({ label: 'Schritt', unit: '', ...partial }) as CalculationStepData

describe('evaluate — the five operation shapes', () => {
  it('sums with the rule’s own multiplier (2 × Steigung + Auftritt)', () => {
    const [result] = evaluate([
      step({
        operation: 'sum',
        unit: 'cm',
        operands: [
          { label: 'Steigung', value: 17, unit: 'cm', factor: 2 },
          { label: 'Auftritt', value: 30, unit: 'cm' },
        ],
      }),
    ])

    expect(result.value).toBe(64)
    expect(result.unit).toBe('cm')
  })

  it('subtracts on a negative factor', () => {
    const [result] = evaluate([
      step({
        operation: 'sum',
        operands: [
          { label: 'Rohbaubreite', value: 300 },
          { label: 'Verputz', value: 20, factor: -2 },
        ],
      }),
    ])

    expect(result.value).toBe(260)
  })

  it('divides for a GFZ and multiplies for a Stellplatzbedarf', () => {
    const [gfz, spaces] = evaluate([
      step({
        operation: 'quotient',
        operands: [
          { label: 'BGF', value: 2400, unit: 'm²' },
          { label: 'Grundfläche', value: 800, unit: 'm²' },
        ],
      }),
      step({
        operation: 'product',
        unit: 'Stpl.',
        operands: [
          { label: 'Wohneinheiten', value: 14 },
          { label: 'Stellplätze je WE', value: 1 },
        ],
      }),
    ])

    expect(gfz.value).toBe(3)
    expect(spaces.value).toBe(14)
  })

  it('reads percent_of as a share and percent_ratio as a percentage', () => {
    const [required, coverage] = evaluate([
      step({
        operation: 'percent_of',
        unit: 'm²',
        operands: [
          { label: 'Bodenfläche', value: 25 },
          { label: 'Anteil', value: 10, unit: '%' },
        ],
      }),
      step({
        operation: 'percent_ratio',
        unit: 'ignoriert',
        operands: [
          { label: 'bebaut', value: 320 },
          { label: 'Grundstück', value: 800 },
        ],
      }),
    ])

    expect(required.value).toBe(2.5)
    expect(coverage.value).toBe(40)
    // The unit of a ratio-as-percentage is the renderer's, never the model's.
    expect(coverage.unit).toBe('%')
  })

  it('chains a later step onto an earlier result (U = 1 ÷ Rges)', () => {
    const [total, uValue] = evaluate([
      step({
        label: 'Rges',
        operation: 'sum',
        unit: 'm²K/W',
        operands: [
          { label: 'Rsi', value: 0.13 },
          { label: 'Dämmung', value: 3.5 },
          { label: 'Ziegel', value: 0.31 },
          { label: 'Rse', value: 0.04 },
        ],
      }),
      step({
        label: 'U-Wert',
        operation: 'quotient',
        unit: 'W/(m²K)',
        operands: [
          { label: '', value: 1 },
          { label: 'Rges', step: 1 },
        ],
      }),
    ])

    expect(total.value).toBeCloseTo(3.98, 10)
    expect(uValue.value).toBeCloseTo(1 / 3.98, 10)
  })
})

describe('evaluate — what it refuses to invent', () => {
  it('has no result at all when an operand has no value', () => {
    const [result] = evaluate([
      step({
        operation: 'sum',
        operands: [
          { label: 'Steigung', value: null },
          { label: 'Auftritt', value: 30 },
        ],
      }),
    ])

    // Never a partial sum: 30 cm printed as the Schrittmaß would be a wrong
    // number stated with full confidence.
    expect(result.value).toBeNull()
    expect(result.undecidable).toBe('missing')
  })

  it('reports a division by zero instead of Infinity', () => {
    const [result] = evaluate([
      step({
        operation: 'quotient',
        operands: [
          { label: 'BGF', value: 2400 },
          { label: 'Grundfläche', value: 0 },
        ],
      }),
    ])

    expect(result.value).toBeNull()
    expect(result.undecidable).toBe('undefined')
  })

  it('carries the undecidability into every step built on it', () => {
    const [, second] = evaluate([
      step({ operation: 'sum', operands: [{ label: 'a', value: null }, { label: 'b', value: 1 }] }),
      step({
        operation: 'quotient',
        operands: [
          { label: '', value: 1 },
          { label: 'Erstes', step: 1 },
        ],
      }),
    ])

    expect(second.value).toBeNull()
  })
})

describe('evaluate — the tolerance band travels', () => {
  it('scales a band by the rule’s multiplier on a sum', () => {
    const [result] = evaluate([
      step({
        operation: 'sum',
        unit: 'cm',
        operands: [
          { label: 'Steigung', value: 17, factor: 2, provenance: 'computed', tolerance: 0.5 },
          { label: 'Auftritt', value: 30, provenance: 'declared' },
        ],
      }),
    ])

    // 2 × (17 ± 0,5) + 30 → 64 ± 1,0. Dropping the band here is how a derived
    // number stops being as honest as the measurement it was built from.
    expect(result.tolerance).toBeCloseTo(1, 10)
  })

  it('adds relative errors through a quotient', () => {
    const [result] = evaluate([
      step({
        operation: 'quotient',
        operands: [
          { label: 'BGF', value: 2400, provenance: 'computed', tolerance: 24 },
          { label: 'Grundfläche', value: 800 },
        ],
      }),
    ])

    // 1 % on the numerator alone → 1 % on a result of 3.
    expect(result.tolerance).toBeCloseTo(0.03, 10)
  })

  it('ignores a band on a DECLARED figure, which is the file’s claim and not ours', () => {
    const [result] = evaluate([
      step({
        operation: 'sum',
        operands: [
          { label: 'Steigung', value: 17, provenance: 'declared', tolerance: 5 },
          { label: 'Auftritt', value: 30 },
        ],
      }),
    ])

    expect(result.tolerance).toBeNull()
  })
})

describe('verdictFor — the card decides, it is not told', () => {
  const at = (value: number, tolerance: number | null = null) => ({
    value,
    tolerance,
    unit: 'cm',
    undecidable: null as null,
  })

  it('reads a range limit at both ends', () => {
    const limit = { comparator: 'between' as const, value: 59, upper: 65 }
    expect(verdictFor(at(64), limit)).toBe('pass')
    expect(verdictFor(at(58), limit)).toBe('fail')
    expect(verdictFor(at(66), limit)).toBe('fail')
  })

  it('reads ≤ and ≥ limits', () => {
    expect(verdictFor(at(3), { comparator: '<=', value: 2.5 })).toBe('fail')
    expect(verdictFor(at(2.4), { comparator: '<=', value: 2.5 })).toBe('pass')
    expect(verdictFor(at(90), { comparator: '>=', value: 100 })).toBe('fail')
    expect(verdictFor(at(110), { comparator: '>=', value: 100 })).toBe('pass')
  })

  it('warns rather than deciding when the band straddles the bound', () => {
    // 2,498 m ±5 mm against a 2,50 m minimum is genuinely undecided; drawing a
    // clean red fail would assert a verdict the measurement cannot support.
    // 2,49 ±5 mm is NOT: no point of that band clears the limit.
    expect(verdictFor(at(2.498, 0.005), { comparator: '>=', value: 2.5 })).toBe('warning')
    expect(verdictFor(at(2.49, 0.005), { comparator: '>=', value: 2.5 })).toBe('fail')
    expect(verdictFor(at(64.8, 0.5), { comparator: 'between', value: 59, upper: 65 })).toBe('warning')
  })

  it('does NOT warn where every value in the band satisfies the limit', () => {
    // 50 ±5 against „≤ 55": the whole band meets it, and a warning would be
    // manufactured doubt.
    expect(verdictFor(at(50, 5), { comparator: '<=', value: 55 })).toBe('pass')
    expect(verdictFor(at(62, 1), { comparator: 'between', value: 59, upper: 65 })).toBe('pass')
  })

  it('has no verdict without a limit, and needs input without a result', () => {
    expect(verdictFor(at(64), null)).toBeNull()
    expect(
      verdictFor({ value: null, tolerance: null, unit: 'cm', undecidable: 'missing' }, { comparator: '<=', value: 3 })
    ).toBe('needs_input')
  })
})

describe('resultDecimals — the printed number cannot contradict the printed verdict', () => {
  it('prints further than the house two decimals when rounding would flip the verdict', () => {
    // 0,2504 W/(m²K) against „≤ 0,25" fails, but rounds to „0,25", which passes.
    // A card printing „0,25 — nicht erfüllt" argues with itself in the one
    // place a reader cannot check it.
    const result = { value: 0.2504, tolerance: null, unit: 'W/(m²K)', undecidable: null as null }
    expect(resultDecimals(result, { comparator: '<=', value: 0.25 })).toBe(4)
  })

  it('keeps the house format when rounding changes nothing', () => {
    const result = { value: 64, tolerance: null, unit: 'cm', undecidable: null as null }
    expect(resultDecimals(result, { comparator: 'between', value: 59, upper: 65 })).toBe(2)
    expect(resultDecimals(result, null)).toBe(2)
  })
})
