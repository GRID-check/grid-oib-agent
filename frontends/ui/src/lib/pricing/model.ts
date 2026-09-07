/**
 * The pricing model (ADR-0053): pure arithmetic, no I/O, shared by the server
 * (write-time pricing, budget conversion) and by anything that wants to show a
 * tenant what a call would cost in credits.
 *
 * Three words, kept apart on purpose:
 *
 *   cost    — USD, what OpenRouter charged the platform. Raw, never shown to a
 *             tenant.
 *   price   — USD, what the tenant is charged for that generation.
 *   credits — the unit the tenant sees, buys and budgets in.
 *
 *   price_usd = cost_usd × marginMultiplier   (margin 1 for BYOK)
 *   credits   = price_usd ÷ usdPerCredit
 *
 * USD end to end. There is no currency conversion in this system: the platform
 * reads the charge as OpenRouter states it, and what a tenant pays for a bundle
 * of credits in euros is the contract's business, not the ledger's.
 *
 * Every step is linear, which is the property that makes credits a currency:
 * the credits of a month are the sum of the credits of its requests, a per-model
 * breakdown adds up to the total, and a limit of N credits means N credits'
 * worth of price, whatever mix of models produced it. A compressive transform
 * (points = A · cost^p, p < 1) was proposed to blur the margin and rejected
 * here: it breaks additivity, so a budget, a breakdown or an invoice in such
 * points would say nothing about the money behind it — and it hides nothing
 * from a reader who knows the model ids, whose list prices are public.
 */

/** The numbers a pricing version carries, as the arithmetic needs them. */
export interface PricingRates {
  /** Price ÷ cost for platform-billed generations. */
  marginMultiplier: number
  /** USD of price one credit stands for. */
  usdPerCredit: number
}

/** What the ledger stores for one generation, beside its raw cost. */
export interface PricedUsage {
  priceUsd: number
  credits: number
}

/**
 * Price one generation.
 *
 * A BYOK generation ran on the tenant's own provider key, so the platform paid
 * nothing for it and takes no margin: the credits then measure the tenant's own
 * spend at the credit rate, so budgets keep working, but they are not an
 * invoice. `isByok` is what OpenRouter reported on the usage object (null when
 * it said nothing, which is treated as platform-billed).
 */
export function priceUsage(costUsd: number, isByok: boolean | null, rates: PricingRates): PricedUsage {
  const safeCost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0
  const margin = isByok === true ? 1 : rates.marginMultiplier
  const priceUsd = safeCost * margin
  return { priceUsd, credits: priceUsd / rates.usdPerCredit }
}

/**
 * The USD of platform-billed cost a given number of credits buys — the
 * inverse of {@link priceUsage}, used to hand the backend tracker a remaining
 * budget in the unit it meters (cost), without teaching it about pricing.
 */
export function creditsToCostUsd(credits: number, rates: PricingRates, isByok = false): number {
  const margin = isByok ? 1 : rates.marginMultiplier
  return (credits * rates.usdPerCredit) / margin
}

/**
 * A typical single call, for the "≈ N credits per request" hint beside a
 * model in the tenant's picker. The point of the hint is the ORDER of models
 * by price, not an accurate forecast — a deep-research turn makes many calls
 * of varying size. Kept here, in one place, so the hint on every surface
 * assumes the same request.
 */
export const REFERENCE_REQUEST = { promptTokens: 4_000, completionTokens: 800 } as const

/** Credits the reference request costs on a model priced per token in USD. */
export function estimateCreditsPerRequest(
  model: { promptPrice: number; completionPrice: number },
  rates: PricingRates,
): number {
  const costUsd =
    REFERENCE_REQUEST.promptTokens * model.promptPrice +
    REFERENCE_REQUEST.completionTokens * model.completionPrice
  return priceUsage(costUsd, false, rates).credits
}
