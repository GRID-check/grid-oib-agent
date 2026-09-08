/**
 * LLM budgets & usage service (ADR-0015, ADR-0053,
 * docs/architecture/usage-budgets.md).
 *
 * Business logic and authorization only — all DB access lives in
 * `./repository` (ADR-0017).
 *
 * Money has three units here and this module is where they part ways:
 *
 *   cost    — USD, what OpenRouter charged. Recorded raw, never shown to a
 *             tenant. The share that ran on a tenant's own key is kept apart
 *             (`ownKeyCostUsd`) because it was the tenant's bill, not ours.
 *   price   — USD, what a platform-billed tenant is charged: cost × margin,
 *             frozen on the ledger row at write time from the active pricing
 *             version. Zero for a generation on the tenant's own key. No
 *             currency conversion anywhere.
 *   credits — the platform-billed tenant's unit: price ÷ the credit price.
 *
 * And a fourth that is not money at all:
 *
 *   tokens  — the unit of an organization on its OWN key. The platform bills
 *             it nothing for LLM usage, so it sees no credits and no price;
 *             what it sees and limits is the tokens on its own provider bill.
 *
 * Which unit an organization is on (`getOrgBudgetUnit`) follows its key mode
 * and nothing else: `credit` when the platform bills it, `token` when it runs
 * on its own key. Limits are stored with their unit, and only limits in the
 * organization's current unit are honoured.
 *
 * The backend tracker meters cost AND tokens off the same usage object, so
 * the remaining budget crosses to it in whichever family applies: USD of cost
 * (the exact inverse of pricing) for credits, tokens as they are.
 *
 * Windows are UTC: "daily" = since 00:00 UTC today, "monthly" = since the
 * 1st of the current month 00:00 UTC.
 *
 * Policy precedence is not a hierarchy — every applicable scope (org, member,
 * project) is enforced independently and the FIRST exhausted one blocks.
 * Member/project limits may never exceed the org limits (validated on write).
 */

import 'server-only'
import type { BudgetPolicy, BudgetScope, BudgetUnit, NewLlmUsageEvent } from '@/lib/db/schema'
import { getCached, invalidateCached, invalidateCachedPrefix } from '@/lib/cache'
import { canManageBudgets } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findProjectTenancy } from '@/lib/projects/repository'
import { recordAuditEvent } from '@/lib/audit/service'
import { BadRequestError, ForbiddenError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isOrgOnOwnKey } from '@/lib/llm-credentials/service'
import {
  creditsToCostUsd,
  getEffectivePricing,
  getEffectivePricingOrBootFloor,
  priceUsage,
  type EffectivePricing,
} from '@/lib/pricing/service'
import * as repository from './repository'
import type {
  DailySpendRow,
  MemberSpend,
  ModelSpend,
  OrganizationSpend,
  SpendSummary,
  SpendTotals,
  SpendWindow,
} from './repository'

export { EMPTY_SPEND_WINDOW, sumSpendWindows, utcDayStart, utcMonthStart } from './repository'
export type { BudgetUnit }
export type { DailySpendRow, MemberSpend, ModelSpend, OrganizationSpend, SpendSummary, SpendTotals, SpendWindow }

/**
 * The unit this organization is budgeted and shown in. Follows the key mode
 * (ADR-0022) and nothing else; cached for a minute with it.
 */
export async function getOrgBudgetUnit(organizationId: string): Promise<BudgetUnit> {
  return (await isOrgOnOwnKey(organizationId)) ? 'token' : 'credit'
}

export interface BudgetLimits {
  unit: BudgetUnit
  /** In `unit`; null = that window is unlimited. */
  dailyLimit: number | null
  monthlyLimit: number | null
}

export interface EffectiveBudgetPolicy extends BudgetLimits {
  scope: BudgetScope
  subjectId: string | null
  /** False when the org runs on the seeded allowance (no explicit row yet). */
  explicit: boolean
  policy: BudgetPolicy | null
}

function toLimits(policy: BudgetPolicy): BudgetLimits {
  return {
    unit: policy.currency,
    dailyLimit: policy.dailyLimit === null ? null : Number.parseFloat(policy.dailyLimit),
    monthlyLimit: policy.monthlyLimit === null ? null : Number.parseFloat(policy.monthlyLimit),
  }
}

/**
 * The org-wide limits in the org's unit: the explicit row, or for a
 * platform-billed organization the allowance the active pricing version
 * seeds it with (ADR-0053 — a plan size is a platform decision, not a code
 * constant). An organization on its own key is seeded with no limit at all:
 * the platform is not paying, so the platform has nothing to cap by default,
 * and the organization sets its own.
 */
export async function getOrgBudget(organizationId: string, unit?: BudgetUnit): Promise<EffectiveBudgetPolicy> {
  const resolvedUnit = unit ?? (await getOrgBudgetUnit(organizationId))
  const policy = await repository.findActivePolicy(organizationId, 'organization', null, resolvedUnit)
  if (policy) {
    return { scope: 'organization', subjectId: null, explicit: true, policy, ...toLimits(policy) }
  }
  if (resolvedUnit === 'token') {
    return { scope: 'organization', subjectId: null, explicit: false, policy: null, unit: 'token', dailyLimit: null, monthlyLimit: null }
  }
  const pricing = await getEffectivePricing()
  return {
    scope: 'organization',
    subjectId: null,
    explicit: false,
    policy: null,
    unit: 'credit',
    dailyLimit: pricing.defaultOrgDailyCredits,
    monthlyLimit: pricing.defaultOrgMonthlyCredits,
  }
}

export async function getScopedBudget(
  organizationId: string,
  scope: 'member' | 'project',
  subjectId: string,
  unit?: BudgetUnit,
): Promise<EffectiveBudgetPolicy | null> {
  const resolvedUnit = unit ?? (await getOrgBudgetUnit(organizationId))
  const policy = await repository.findActivePolicy(organizationId, scope, subjectId, resolvedUnit)
  if (!policy) return null
  return { scope, subjectId, explicit: true, policy, ...toLimits(policy) }
}

/** All active member/project policies of an org in its current unit (for the settings UI). */
export async function listActivePolicies(organizationId: string, unit?: BudgetUnit): Promise<BudgetPolicy[]> {
  return repository.listActivePolicies(organizationId, unit ?? (await getOrgBudgetUnit(organizationId)))
}

/** Full policy history (audit view), every unit. */
export async function listPolicyHistory(organizationId: string, limit = 100): Promise<BudgetPolicy[]> {
  return repository.listPolicyHistory(organizationId, limit)
}

export class BudgetValidationError extends Error {}

/**
 * Set (or clear a window of) a budget policy in the org's CURRENT unit.
 * Supersedes the previous active row of that unit — never updates in place,
 * so every change stays auditable.
 *
 * Member and project limits are validated against the org's effective limits:
 * a scoped limit must be set (not unlimited) and must not exceed the org
 * limit for any window the org bounds.
 */
export async function setBudgetPolicy(params: {
  organizationId: string
  scope: BudgetScope
  subjectId: string | null
  dailyLimit: number | null
  monthlyLimit: number | null
  actorUserId: string
  note?: string | null
}): Promise<BudgetPolicy> {
  const { organizationId, scope, subjectId } = params
  if (scope === 'organization' && subjectId !== null) {
    throw new BudgetValidationError('organization scope must not carry a subjectId')
  }
  if (scope !== 'organization' && !subjectId) {
    throw new BudgetValidationError(`${scope} scope requires a subjectId`)
  }
  for (const value of [params.dailyLimit, params.monthlyLimit]) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new BudgetValidationError('limits must be non-negative numbers or null')
    }
  }

  const unit = await getOrgBudgetUnit(organizationId)
  if (scope !== 'organization') {
    const org = await getOrgBudget(organizationId, unit)
    const pairs: Array<[number | null, number | null, string]> = [
      [params.dailyLimit, org.dailyLimit, 'daily'],
      [params.monthlyLimit, org.monthlyLimit, 'monthly'],
    ]
    for (const [scoped, orgLimit, window] of pairs) {
      if (orgLimit === null) continue
      if (scoped === null) {
        throw new BudgetValidationError(
          `${scope} ${window} limit cannot be unlimited while the organization ${window} limit is ${orgLimit} ${unit}s`,
        )
      }
      if (scoped > orgLimit) {
        throw new BudgetValidationError(
          `${scope} ${window} limit (${scoped} ${unit}s) exceeds the organization ${window} limit (${orgLimit} ${unit}s)`,
        )
      }
    }
  }

  const inserted = await repository.insertPolicySuperseding({
    organizationId,
    scope,
    subjectId,
    unit,
    dailyLimit: params.dailyLimit === null ? null : params.dailyLimit.toFixed(4),
    monthlyLimit: params.monthlyLimit === null ? null : params.monthlyLimit.toFixed(4),
    createdBy: params.actorUserId,
    note: params.note ?? null,
  })
  await invalidateLimitsCache(organizationId, scope, subjectId)
  return inserted
}

/**
 * Remove a scoped (member/project) policy in the org's current unit:
 * supersede the active row without a replacement, so the subject falls back
 * to the org limits alone. The row itself stays for the audit trail.
 * Org-scope policies are never removed — they are replaced (the org always
 * has effective limits, seeded or explicit).
 */
export async function clearBudgetPolicy(params: {
  organizationId: string
  scope: 'member' | 'project'
  subjectId: string
  actorUserId: string
}): Promise<boolean> {
  const unit = await getOrgBudgetUnit(params.organizationId)
  const removed = await repository.supersedeActivePolicy(params.organizationId, params.scope, params.subjectId, unit)
  if (removed) {
    await invalidateLimitsCache(params.organizationId, params.scope, params.subjectId)
  }
  return removed
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** A ledger row as the backend reports it — cost only; pricing happens here. */
export type UsageEventInput = Omit<NewLlmUsageEvent, 'priceUsd' | 'credits' | 'pricingVersionId'>

/**
 * Price and append ledger rows. Each row is priced ONCE, here, from the
 * pricing active at this moment, and carries that version's id — a later
 * price change never rewrites what a tenant was shown (ADR-0053). A row on
 * the tenant's own key is priced at nothing. The write-through daily rollup
 * (ADR-0019) is incremented in the same transaction by the repository.
 *
 * A pricing lookup failure prices at the boot floor rather than dropping the
 * batch: an unpriced generation is reconcilable, a missing one is not.
 */
export async function recordUsageEvents(events: UsageEventInput[]): Promise<number> {
  if (events.length === 0) return 0
  const pricing = await getEffectivePricingOrBootFloor()
  return repository.insertUsageEventsWithRollups(
    events.map((event) => {
      const priced = priceUsage(Number.parseFloat(String(event.costUsd ?? '0')) || 0, event.isByok ?? null, pricing)
      return {
        ...event,
        priceUsd: priced.priceUsd.toFixed(8),
        credits: priced.credits.toFixed(6),
        pricingVersionId: pricing.versionId,
      }
    }),
  )
}

/**
 * Day/month spend totals from the write-through rollup (ADR-0019) — the
 * enforcement hot path. Per-model breakdowns stay on getSpendSummary
 * (admin views only).
 */
export async function getSpendTotals(
  organizationId: string,
  filter: { userId?: string; projectId?: string } = {},
): Promise<SpendTotals> {
  return repository.sumRollupTotals(organizationId, filter)
}

/**
 * Windowed spend, org-wide by default or narrowed to one member/project.
 * One month-window aggregation query; the day slice reuses it via FILTER.
 */
export async function getSpendSummary(
  organizationId: string,
  filter: { userId?: string; projectId?: string } = {},
): Promise<SpendSummary> {
  return repository.aggregateSpendSummary(organizationId, filter)
}

/**
 * Windowed spend per member (admin view — the member usage table).
 * Events without a user id (anonymous mode) are excluded.
 */
export async function getSpendByMember(organizationId: string): Promise<MemberSpend[]> {
  return repository.aggregateSpendByMember(organizationId)
}

/**
 * Windowed spend per organization across the WHOLE platform (platform-tier
 * dashboards only — caller must hold `platform:usage:view`, ADR-0016).
 */
export async function getSpendAcrossOrganizations(): Promise<OrganizationSpend[]> {
  return repository.aggregateSpendAcrossOrganizations()
}

export interface DailySpendPoint extends SpendWindow {
  /** UTC day, `YYYY-MM-DD`. */
  day: string
}

/**
 * Daily spend series for trend charts — one point per UTC day, zero-filled
 * so the series is continuous. Org-scoped when `organizationId` is given,
 * platform-wide otherwise (platform dashboards only).
 */
export async function getDailySpendTrend(options: {
  organizationId?: string
  days?: number
} = {}): Promise<DailySpendPoint[]> {
  const days = Math.min(Math.max(options.days ?? 30, 1), 90)
  const start = repository.utcDayStart()
  start.setUTCDate(start.getUTCDate() - (days - 1))

  const rows = await repository.aggregateDailySpend({ organizationId: options.organizationId, start })

  const byDay = new Map(rows.map((row) => [row.day, row]))
  const series: DailySpendPoint[] = []
  const cursor = new Date(start)
  for (let i = 0; i < days; i += 1) {
    const key = cursor.toISOString().slice(0, 10)
    const row = byDay.get(key)
    series.push({
      day: key,
      costUsd: row?.costUsd ?? 0,
      ownKeyCostUsd: row?.ownKeyCostUsd ?? 0,
      priceUsd: row?.priceUsd ?? 0,
      credits: row?.credits ?? 0,
      tokens: row?.tokens ?? 0,
      events: row?.events ?? 0,
    })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return series
}

// ---------------------------------------------------------------------------
// Enforcement snapshot
// ---------------------------------------------------------------------------

export interface BudgetStatus {
  blocked: boolean
  blockedScope: BudgetScope | null
  /** The unit every remainder below is expressed in for the tenant. */
  unit: BudgetUnit
  /** Remaining budget in `unit` per applicable scope; null = unlimited. */
  remainingOrg: number | null
  remainingUser: number | null
  remainingProject: number | null
  /**
   * The same remainders as the backend tracker meters them. A credit
   * organization gets USD of platform-billed cost (the inverse of pricing at
   * the active version) and no token family; a token organization gets tokens
   * and no USD family. The tracker enforces whichever is present.
   */
  remainingOrgUsd: number | null
  remainingUserUsd: number | null
  remainingProjectUsd: number | null
  remainingOrgTokens: number | null
  remainingUserTokens: number | null
  remainingProjectTokens: number | null
}

/** What one window has consumed in a given unit. */
const consumed = (window: SpendWindow, unit: BudgetUnit): number =>
  unit === 'token' ? window.tokens : window.credits

function remainingIn(limits: BudgetLimits, spend: SpendTotals): number | null {
  const candidates: number[] = []
  if (limits.dailyLimit !== null) candidates.push(limits.dailyLimit - consumed(spend.day, limits.unit))
  if (limits.monthlyLimit !== null) candidates.push(limits.monthlyLimit - consumed(spend.month, limits.unit))
  if (candidates.length === 0) return null
  return Math.max(0, Math.min(...candidates))
}

/**
 * Policy LIMITS for the enforcement path, via the shared cache
 * (write-invalidate on policy writes, ADR-0020). Only the numeric limits are
 * cached — policy rows with their audit fields stay uncached in the
 * settings/admin reads. The unit is part of the key: flipping the key mode
 * must never serve the other unit's limits for a TTL.
 */
const LIMITS_CACHE_TTL_MS = 5 * 60 * 1000

const limitsCacheKey = (organizationId: string, unit: BudgetUnit, scope: BudgetScope, subjectId: string | null): string =>
  `budgetlimits:${organizationId}:${unit}:${scope}:${subjectId ?? ''}`

async function getCachedOrgLimits(organizationId: string, unit: BudgetUnit): Promise<BudgetLimits> {
  return getCached(limitsCacheKey(organizationId, unit, 'organization', null), LIMITS_CACHE_TTL_MS, async () => {
    const org = await getOrgBudget(organizationId, unit)
    return { unit: org.unit, dailyLimit: org.dailyLimit, monthlyLimit: org.monthlyLimit }
  })
}

async function getCachedScopedLimits(
  organizationId: string,
  unit: BudgetUnit,
  scope: 'member' | 'project',
  subjectId: string,
): Promise<BudgetLimits | null> {
  return getCached(limitsCacheKey(organizationId, unit, scope, subjectId), LIMITS_CACHE_TTL_MS, async () => {
    const scoped = await getScopedBudget(organizationId, scope, subjectId, unit)
    if (!scoped) return null
    return { unit: scoped.unit, dailyLimit: scoped.dailyLimit, monthlyLimit: scoped.monthlyLimit }
  })
}

async function invalidateLimitsCache(
  organizationId: string,
  scope: BudgetScope,
  subjectId: string | null,
): Promise<void> {
  // Both units: a write in one unit must not leave a stale read in the other.
  await Promise.all(
    (['credit', 'token'] as const).map((unit) => invalidateCached(limitsCacheKey(organizationId, unit, scope, subjectId))),
  )
}

/**
 * Drop every cached org-scope limit — a pricing save changes the seeded
 * allowance, which is what the cache holds for organizations without an
 * explicit row. Prefix invalidation covers every org at once.
 */
export async function invalidateSeededLimits(): Promise<void> {
  await invalidateCachedPrefix('budgetlimits:')
}

/**
 * The enforcement snapshot forwarded to the backend as `X-Grid-Budget` on the
 * WS upgrade, and used to refuse the upgrade outright when already exhausted.
 */
export async function getBudgetStatus(
  organizationId: string,
  userId: string | null,
  projectId: string | null,
): Promise<BudgetStatus> {
  const unit = await getOrgBudgetUnit(organizationId)
  // Two parallel waves instead of up to six serial round-trips: policies and
  // org spend first, then the scoped spend aggregations only where a policy
  // actually exists.
  const [orgBudget, orgSpend, memberBudget, projectBudget, pricing] = await Promise.all([
    getCachedOrgLimits(organizationId, unit),
    getSpendTotals(organizationId),
    userId ? getCachedScopedLimits(organizationId, unit, 'member', userId) : Promise.resolve(null),
    projectId ? getCachedScopedLimits(organizationId, unit, 'project', projectId) : Promise.resolve(null),
    unit === 'credit' ? getEffectivePricing() : Promise.resolve(null),
  ])
  const remainingOrg = remainingIn(orgBudget, orgSpend)

  const [memberSpend, projectSpend] = await Promise.all([
    memberBudget && userId ? getSpendTotals(organizationId, { userId }) : Promise.resolve(null),
    projectBudget && projectId ? getSpendTotals(organizationId, { projectId }) : Promise.resolve(null),
  ])

  const remainingUser = memberBudget && memberSpend ? remainingIn(memberBudget, memberSpend) : null
  const remainingProject = projectBudget && projectSpend ? remainingIn(projectBudget, projectSpend) : null

  const scopes: Array<[BudgetScope, number | null]> = [
    ['organization', remainingOrg],
    ['member', remainingUser],
    ['project', remainingProject],
  ]
  const exhausted = scopes.find(([, remaining]) => remaining !== null && remaining <= 0)

  const toUsd = (credits: number | null): number | null =>
    credits === null || !pricing ? null : creditsToCostUsd(credits, pricing)
  const tokens = (remaining: number | null): number | null => (unit === 'token' ? remaining : null)

  return {
    blocked: Boolean(exhausted),
    blockedScope: exhausted?.[0] ?? null,
    unit,
    remainingOrg,
    remainingUser,
    remainingProject,
    remainingOrgUsd: toUsd(remainingOrg),
    remainingUserUsd: toUsd(remainingUser),
    remainingProjectUsd: toUsd(remainingProject),
    remainingOrgTokens: tokens(remainingOrg),
    remainingUserTokens: tokens(remainingUser),
    remainingProjectTokens: tokens(remainingProject),
  }
}

export interface ConnectionDiagnostics {
  /** True when a budget scope that applies to this caller is already exhausted. */
  budgetExhausted: boolean
  /** Which scope is blocking (organization/member/project), or null. */
  blockedScope: BudgetScope | null
  /** Whether the caller can raise limits (budget admin) — drives the UI copy. */
  canManageBudgets: boolean
}

/**
 * Read-only reason discovery for a failed chat WebSocket upgrade.
 *
 * When a budget scope is exhausted the gateway (server.js) refuses the WS
 * upgrade with a bare failed handshake the browser cannot read, so chat only
 * sees a generic connection failure. After its retries are exhausted the chat
 * client calls this same-origin endpoint to learn whether the real cause was
 * budget exhaustion and render a distinct, actionable banner.
 *
 * Reuses the exact enforcement snapshot the websocket-scope route uses
 * (`getBudgetStatus`) so the answer can never disagree with what actually
 * blocked the upgrade. No side effects.
 */
export async function getConnectionDiagnostics(
  session: AuthorizedSession,
  requested: { projectId?: string } = {},
): Promise<ConnectionDiagnostics> {
  const status = await getBudgetStatus(session.organizationId, session.userId, requested.projectId ?? null)
  return {
    budgetExhausted: status.blocked,
    blockedScope: status.blockedScope,
    canManageBudgets: canManageBudgets(session),
  }
}

// ---------------------------------------------------------------------------
// Session-facing operations (route handlers delegate here)
// ---------------------------------------------------------------------------

export interface BudgetOverview {
  unit: BudgetUnit
  organization: EffectiveBudgetPolicy
  ownMemberLimit: EffectiveBudgetPolicy | null
  /** Only present for budget admins: every active member/project policy in the unit. */
  policies?: BudgetPolicy[]
}

/**
 * Budget view for the settings page: every member sees the org limits and
 * their own member limit; budget admins additionally get all active policies.
 */
export async function getBudgetOverview(session: AuthorizedSession): Promise<BudgetOverview> {
  const unit = await getOrgBudgetUnit(session.organizationId)
  const [organization, ownMemberLimit] = await Promise.all([
    getOrgBudget(session.organizationId, unit),
    getScopedBudget(session.organizationId, 'member', session.userId, unit),
  ])
  const overview: BudgetOverview = { unit, organization, ownMemberLimit }
  if (canManageBudgets(session)) {
    overview.policies = await listActivePolicies(session.organizationId, unit)
  }
  return overview
}

/**
 * Authorization for policy writes. Org and member scopes: budget admins only.
 * Project scope: budget admins (with the subject validated against the org)
 * or that project's admins (requireProjectAccess enforces tenancy + FGA).
 */
async function authorizePolicyWrite(
  session: AuthorizedSession,
  scope: BudgetScope,
  subjectId: string | null,
): Promise<void> {
  if (scope === 'project') {
    if (!subjectId) {
      throw new BadRequestError('project scope requires subjectId')
    }
    if (canManageBudgets(session)) {
      // Admins skip the per-project FGA check, but the subject must still be
      // a real project of THIS org — never store a foreign or made-up id.
      const project = await findProjectTenancy(subjectId)
      if (!project || project.organizationId !== session.organizationId) {
        throw new BadRequestError('Unknown project')
      }
    } else {
      // Project admins may manage their own project's budget.
      await requireProjectAccess(session, subjectId, 'project:manage')
    }
    return
  }
  // TODO: for scope='member' the subjectId is not verified against the
  // organization's member roster — an admin can store a policy for an
  // arbitrary user id (it simply never matches spend).
  if (!canManageBudgets(session)) {
    throw new ForbiddenError()
  }
}

export interface BudgetPolicyInput {
  scope: BudgetScope
  subjectId?: string | null
  /** In the org's current unit — the caller does not choose the unit. */
  dailyLimit: number | null
  monthlyLimit: number | null
  note?: string | null
}

/** Set a budget policy for the caller's org (authz + validation + audit). */
export async function saveBudgetPolicy(
  session: AuthorizedSession,
  input: BudgetPolicyInput,
  request: Request,
): Promise<BudgetPolicy> {
  const { scope, dailyLimit, monthlyLimit } = input
  const subjectId = input.subjectId ?? null

  await authorizePolicyWrite(session, scope, subjectId)

  let policy: BudgetPolicy
  try {
    policy = await setBudgetPolicy({
      organizationId: session.organizationId,
      scope,
      subjectId: scope === 'organization' ? null : subjectId,
      dailyLimit,
      monthlyLimit,
      actorUserId: session.userId,
      note: input.note ?? null,
    })
  } catch (error) {
    if (error instanceof BudgetValidationError) {
      throw new UnprocessableError(error.message)
    }
    throw error
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'budget.policy.set',
    targetType: 'budget_policy',
    targetId: policy.id,
    metadata: { scope, subjectId, unit: policy.currency, dailyLimit, monthlyLimit },
    request,
  })
  return policy
}

/** Remove a scoped limit — the subject falls back to the org limits alone. */
export async function removeBudgetPolicy(
  session: AuthorizedSession,
  input: { scope: 'member' | 'project'; subjectId: string },
  request: Request,
): Promise<boolean> {
  const { scope, subjectId } = input

  await authorizePolicyWrite(session, scope, subjectId)

  const removed = await clearBudgetPolicy({
    organizationId: session.organizationId,
    scope,
    subjectId,
    actorUserId: session.userId,
  })
  if (removed) {
    await recordAuditEvent({
      organizationId: session.organizationId,
      actor: { userId: session.userId, email: session.email },
      action: 'budget.policy.cleared',
      targetType: 'budget_policy',
      targetId: subjectId,
      metadata: { scope, subjectId },
      request,
    })
  }
  return removed
}

// ---------------------------------------------------------------------------
// The tenant's view: its own unit, nothing else
// ---------------------------------------------------------------------------

/**
 * What a tenant is shown of a window: the amount in ITS unit, and how many
 * generations made it. Cost and price are deliberately absent, and so is the
 * other unit — a token organization sees no credits, a credit organization
 * no tokens (ADR-0053). This projection is the ONE place the ledger's columns
 * are narrowed for tenant surfaces, so a new tenant endpoint that reuses it
 * cannot leak cost by accident.
 */
export interface TenantSpendWindow {
  /** In the organization's unit (see `UsageOverview.unit`). */
  amount: number
  events: number
}

const toTenantWindow =
  (unit: BudgetUnit) =>
  (window: SpendWindow): TenantSpendWindow => ({
    amount: consumed(window, unit),
    events: window.events,
  })

export interface UsageOverview {
  /** The unit every `amount` and limit below is in. */
  unit: BudgetUnit
  summary: {
    day: TenantSpendWindow
    month: TenantSpendWindow
    perModel: Array<{ model: string; day: TenantSpendWindow; month: TenantSpendWindow }>
  }
  perMember: Array<{ userId: string; day: TenantSpendWindow; month: TenantSpendWindow }> | null
  dailyTrend: Array<{ day: string } & TenantSpendWindow> | null
  orgBudget: { dailyLimit: number | null; monthlyLimit: number | null; explicit: boolean }
  status: { blocked: boolean; blockedScope: BudgetScope | null }
  scope: { userId?: string; projectId?: string }
}

/**
 * Spend summary for the budget UI. Budget admins see the org-wide summary
 * (optionally narrowed to one member/project); everyone else always gets
 * their own usage only.
 */
export async function getUsageOverview(
  session: AuthorizedSession,
  requested: { userId?: string; projectId?: string } = {},
): Promise<UsageOverview> {
  const admin = canManageBudgets(session)

  const filter: { userId?: string; projectId?: string } = {}
  if (admin) {
    if (requested.userId) filter.userId = requested.userId
    if (requested.projectId) filter.projectId = requested.projectId
  } else {
    filter.userId = session.userId
  }

  const unit = await getOrgBudgetUnit(session.organizationId)
  const project = toTenantWindow(unit)

  const [summary, orgBudget, status, perMember, dailyTrend] = await Promise.all([
    getSpendSummary(session.organizationId, filter),
    getOrgBudget(session.organizationId, unit),
    getBudgetStatus(session.organizationId, session.userId, null),
    // Member breakdown + trend feed the admin dashboard only.
    admin ? getSpendByMember(session.organizationId) : Promise.resolve(null),
    admin ? getDailySpendTrend({ organizationId: session.organizationId, days: 30 }) : Promise.resolve(null),
  ])

  return {
    unit,
    summary: {
      day: project(summary.day),
      month: project(summary.month),
      perModel: summary.perModel.map((entry) => ({
        model: entry.model,
        day: project(entry.day),
        month: project(entry.month),
      })),
    },
    perMember: perMember
      ? perMember.map((entry) => ({ userId: entry.userId, day: project(entry.day), month: project(entry.month) }))
      : null,
    dailyTrend: dailyTrend ? dailyTrend.map((point) => ({ day: point.day, ...project(point) })) : null,
    orgBudget: {
      dailyLimit: orgBudget.dailyLimit,
      monthlyLimit: orgBudget.monthlyLimit,
      explicit: orgBudget.explicit,
    },
    status: { blocked: status.blocked, blockedScope: status.blockedScope },
    scope: admin ? filter : { userId: session.userId },
  }
}

/** Re-exported so platform surfaces can convert cost with the active rate. */
export type { EffectivePricing }
