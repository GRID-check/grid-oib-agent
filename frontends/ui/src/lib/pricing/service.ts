/**
 * The platform price list (ADR-0053, Platform → Overview → Pricing).
 *
 * Resolves the pricing every generation is priced with, validates and records
 * a new version, and exposes the boot floor a deployment runs on until a
 * platform owner has decided otherwise. The arithmetic itself is in
 * `./model.ts`; the table access in `./repository.ts`.
 *
 * Platform-only by design — no org layer. A tenant chooses models; the price
 * of a model is the platform's.
 */

import 'server-only'
import { getCached, invalidateCached } from '@/lib/cache'
import { UnprocessableError } from '@/lib/api/errors'
import type { PlatformPricingVersion } from '@/lib/db/schema'
import type { PricingRates } from './model'
import { findActivePricingVersion, insertPricingVersionSuperseding, listPricingHistory } from './repository'

export { creditsToCostUsd, estimateCreditsPerRequest, priceUsage, REFERENCE_REQUEST } from './model'
export type { PricedUsage, PricingRates } from './model'

/**
 * Short TTL, write-invalidated: pricing is read on every ledger flush and every
 * WebSocket upgrade, and a save must reach the next generation, not the next
 * five minutes. The organization is deliberately absent from the key — this is
 * the one price list every tenant is priced with.
 */
const PRICING_CACHE_TTL_MS = 60 * 1000
const PRICING_CACHE_KEY = 'platformpricing:active'

/**
 * The boot floor — what an empty `platform_pricing_versions` table means.
 *
 * Margin 1 and one credit = one US cent make credits read as cents of cost,
 * and the seeded allowance is $10 a day / $100 a month in that unit — the old
 * €10/€100 guardrail, give or take the rate nobody wants to maintain — so an
 * upgraded deployment behaves as it did until someone decides a price.
 */
export const BOOT_FLOOR_MARGIN_MULTIPLIER = 1
export const BOOT_FLOOR_USD_PER_CREDIT = 0.01
export const BOOT_FLOOR_DAILY_CREDITS = 1_000
export const BOOT_FLOOR_MONTHLY_CREDITS = 10_000

/** The active price list as the arithmetic and the budget seed need it. */
export interface EffectivePricing extends PricingRates {
  /** NULL when running on the boot floor (nothing decided yet). */
  versionId: string | null
  /** Seeded org allowance per window; null = unlimited by default. */
  defaultOrgDailyCredits: number | null
  defaultOrgMonthlyCredits: number | null
  /** False on the boot floor. */
  explicit: boolean
}

function bootFloor(): EffectivePricing {
  return {
    versionId: null,
    marginMultiplier: BOOT_FLOOR_MARGIN_MULTIPLIER,
    usdPerCredit: BOOT_FLOOR_USD_PER_CREDIT,
    defaultOrgDailyCredits: BOOT_FLOOR_DAILY_CREDITS,
    defaultOrgMonthlyCredits: BOOT_FLOOR_MONTHLY_CREDITS,
    explicit: false,
  }
}

const numberOrNull = (value: string | null): number | null =>
  value === null ? null : Number.parseFloat(value)

function toEffective(row: PlatformPricingVersion): EffectivePricing {
  return {
    versionId: row.id,
    marginMultiplier: Number.parseFloat(row.marginMultiplier),
    usdPerCredit: Number.parseFloat(row.usdPerCredit),
    defaultOrgDailyCredits: numberOrNull(row.defaultOrgDailyCredits),
    defaultOrgMonthlyCredits: numberOrNull(row.defaultOrgMonthlyCredits),
    explicit: true,
  }
}

/**
 * The pricing every generation is priced with right now. Cached; a save
 * invalidates. Throws on a database failure — callers on the answer path
 * decide whether to fail open (the ledger write does: a generation is recorded
 * at the boot floor rather than dropped).
 */
export async function getEffectivePricing(): Promise<EffectivePricing> {
  return getCached(PRICING_CACHE_KEY, PRICING_CACHE_TTL_MS, async () => {
    const row = await findActivePricingVersion()
    return row ? toEffective(row) : bootFloor()
  })
}

/**
 * Pricing for a write path that must never fail because of it: a broken
 * lookup prices at the boot floor and says so in the log, instead of losing
 * the generation from the ledger.
 */
export async function getEffectivePricingOrBootFloor(): Promise<EffectivePricing> {
  try {
    return await getEffectivePricing()
  } catch (error) {
    console.warn('[Pricing] Falling back to the boot floor — active pricing could not be read:', error)
    return bootFloor()
  }
}

/** What the admin surface shows: the effective numbers plus who set them. */
export interface PricingView extends EffectivePricing {
  note: string | null
  updatedByEmail: string | null
  updatedAt: string | null
  /** The last few versions, newest first, for the change trail. */
  history: Array<{
    id: string
    marginMultiplier: number
    usdPerCredit: number
    defaultOrgDailyCredits: number | null
    defaultOrgMonthlyCredits: number | null
    note: string | null
    createdByEmail: string | null
    createdAt: string
    status: PlatformPricingVersion['status']
  }>
}

export async function getPricingView(): Promise<PricingView> {
  const [active, history] = await Promise.all([findActivePricingVersion(), listPricingHistory(10)])
  const effective = active ? toEffective(active) : bootFloor()
  return {
    ...effective,
    note: active?.note ?? null,
    updatedByEmail: active?.createdByEmail ?? null,
    updatedAt: active?.createdAt.toISOString() ?? null,
    history: history.map((row) => ({
      id: row.id,
      marginMultiplier: Number.parseFloat(row.marginMultiplier),
      usdPerCredit: Number.parseFloat(row.usdPerCredit),
      defaultOrgDailyCredits: numberOrNull(row.defaultOrgDailyCredits),
      defaultOrgMonthlyCredits: numberOrNull(row.defaultOrgMonthlyCredits),
      note: row.note,
      createdByEmail: row.createdByEmail,
      createdAt: row.createdAt.toISOString(),
      status: row.status,
    })),
  }
}

export interface SavePricingInput {
  marginMultiplier: number
  usdPerCredit: number
  defaultOrgDailyCredits: number | null
  defaultOrgMonthlyCredits: number | null
  note: string | null
  actorUserId: string
  actorEmail: string | null
}

/**
 * Bounds a platform owner cannot type past. Wide — the database CHECKs already
 * refuse zero and negatives — but a margin of 100× or a credit worth $1,000 is
 * a slipped decimal, not a price list, and a slipped decimal on this row
 * reprices every tenant at once.
 */
export const PRICING_BOUNDS = {
  marginMultiplier: { min: 0.1, max: 50 },
  usdPerCredit: { min: 0.0001, max: 100 },
  defaultCredits: { min: 0, max: 100_000_000 },
} as const

function validate(input: SavePricingInput): string[] {
  const errors: string[] = []
  const inRange = (label: string, value: number, bounds: { min: number; max: number }): void => {
    if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
      errors.push(`${label}: ${bounds.min}–${bounds.max}`)
    }
  }
  inRange('marginMultiplier', input.marginMultiplier, PRICING_BOUNDS.marginMultiplier)
  inRange('usdPerCredit', input.usdPerCredit, PRICING_BOUNDS.usdPerCredit)
  for (const [label, value] of [
    ['defaultOrgDailyCredits', input.defaultOrgDailyCredits],
    ['defaultOrgMonthlyCredits', input.defaultOrgMonthlyCredits],
  ] as const) {
    if (value !== null) inRange(label, value, PRICING_BOUNDS.defaultCredits)
  }
  return errors
}

/**
 * Record a new price list. Validates, supersedes the active version and
 * invalidates the cache; the audit event is the route's (it knows the platform
 * org and the request).
 */
export async function savePricing(input: SavePricingInput): Promise<PlatformPricingVersion> {
  const errors = validate(input)
  if (errors.length > 0) {
    throw new UnprocessableError('Invalid pricing', { errors })
  }
  const inserted = await insertPricingVersionSuperseding({
    marginMultiplier: input.marginMultiplier.toFixed(4),
    usdPerCredit: input.usdPerCredit.toFixed(6),
    defaultOrgDailyCredits: input.defaultOrgDailyCredits === null ? null : input.defaultOrgDailyCredits.toFixed(4),
    defaultOrgMonthlyCredits:
      input.defaultOrgMonthlyCredits === null ? null : input.defaultOrgMonthlyCredits.toFixed(4),
    note: input.note,
    createdBy: input.actorUserId,
    createdByEmail: input.actorEmail,
  })
  await invalidateCached(PRICING_CACHE_KEY)
  return inserted
}

/** Drop the cached price list (after a write, or from tests). */
export async function invalidatePricingCache(): Promise<void> {
  await invalidateCached(PRICING_CACHE_KEY)
}
