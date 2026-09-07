/**
 * @vitest-environment node
 */
/**
 * The pricing arithmetic (ADR-0053). What is pinned here is the property the
 * whole billing model rests on — credits ADD — plus the two rules a reader
 * would otherwise have to trust a comment for: BYOK takes no margin, and the
 * budget conversion is the exact inverse of pricing.
 */
import { describe, expect, it } from 'vitest'
import { creditsToCostUsd, estimateCreditsPerRequest, priceUsage, REFERENCE_REQUEST } from './model'

const RATES = { marginMultiplier: 2.5, usdPerCredit: 0.1 }

describe('priceUsage', () => {
  it('prices a platform-billed generation as cost × margin, in credits of the credit price', () => {
    const priced = priceUsage(1, null, RATES)
    expect(priced.priceUsd).toBeCloseTo(2.5, 10)
    expect(priced.credits).toBeCloseTo(25, 10)
  })

  it('is additive: the credits of a sum are the sum of the credits', () => {
    const costs = [0.00012, 0.0431, 0.9, 2.75]
    const total = priceUsage(
      costs.reduce((sum, cost) => sum + cost, 0),
      false,
      RATES,
    ).credits
    const summed = costs.reduce((sum, cost) => sum + priceUsage(cost, false, RATES).credits, 0)
    expect(summed).toBeCloseTo(total, 9)
  })

  it('takes no margin on a BYOK generation', () => {
    const byok = priceUsage(1, true, RATES)
    expect(byok.priceUsd).toBeCloseTo(1, 10)
    expect(byok.credits).toBeCloseTo(10, 10)
    // Unknown BYOK status is treated as platform-billed.
    expect(priceUsage(1, null, RATES).priceUsd).toBeCloseTo(2.5, 10)
  })

  it('never prices a negative or non-finite cost', () => {
    expect(priceUsage(-1, false, RATES)).toEqual({ priceUsd: 0, credits: 0 })
    expect(priceUsage(Number.NaN, false, RATES)).toEqual({ priceUsd: 0, credits: 0 })
  })
})

describe('creditsToCostUsd', () => {
  it('is the inverse of priceUsage, for platform-billed and BYOK alike', () => {
    for (const isByok of [false, true]) {
      const credits = priceUsage(3.21, isByok, RATES).credits
      expect(creditsToCostUsd(credits, RATES, isByok)).toBeCloseTo(3.21, 9)
    }
  })
})

describe('estimateCreditsPerRequest', () => {
  it('prices the reference request on the model, platform-billed', () => {
    const model = { promptPrice: 0.000003, completionPrice: 0.000015 }
    const costUsd =
      REFERENCE_REQUEST.promptTokens * model.promptPrice + REFERENCE_REQUEST.completionTokens * model.completionPrice
    expect(estimateCreditsPerRequest(model, RATES)).toBeCloseTo(priceUsage(costUsd, false, RATES).credits, 10)
  })

  it('orders models the way their list prices order them', () => {
    const cheap = estimateCreditsPerRequest({ promptPrice: 1e-7, completionPrice: 4e-7 }, RATES)
    const pricey = estimateCreditsPerRequest({ promptPrice: 1.5e-5, completionPrice: 7.5e-5 }, RATES)
    expect(cheap).toBeLessThan(pricey)
  })
})
