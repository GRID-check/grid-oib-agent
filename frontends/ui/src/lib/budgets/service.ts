/**
 * LLM budgets & usage service (ADR-0015, ADR-0053,
 * docs/architecture/usage-budgets.md).
 *
 * Business logic and authorization only — all DB access lives in
 * `./repository` (ADR-0017).
 *
 * Money has three units here and this module is where they part ways:
 *
 *   cost    — USD, what OpenRouter charged the platform. Recorded raw, never
 *             shown to a tenant.
 *   price   — USD, what the tenant is charged: cost × margin, frozen on the
 *             ledger row at write time from the active pricing version. No
 *             currency conversion anywhere: the platform reads the charge as
 *             OpenRouter states it.
 *   credits — the tenant's unit: price ÷ the credit price. Limits are credits,
 *             dashboards are credits, the seeded allowance is credits.
 *
 * The backend tracker still meters in cost (it reads OpenRouter's usage
 * object), so the remaining budget crosses to it converted back to USD — the
 * exact inverse of pricing, with no margin for an organization on its own key.
 *
 * Windows are UTC: "daily" = since 00:00 UTC today, "monthly" = since the
 * 1st of the current month 00:00 UTC.
 *
 * Policy precedence is not a hierarchy — every applicable scope (org, member,
 * project) is enforced independently and the FIRST exhausted one blocks.
 * Member/project limits may never exceed the org limits (validated on write).
 */

import 'server-only'
import type { BudgetPolicy, BudgetScope, NewLlmUsageEvent } from '@/lib/db/schema'
import { getCached, invalidateCached } from '@/lib/cache'
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

export { utcDayStart, utcMonthStart } from './repository'
export type { DailySpendRow, MemberSpend, ModelSpend, OrganizationSpend, SpendSummary, SpendTotals, SpendWindow }

export interface BudgetLimits {
  dailyLimitCredits: number | null
  monthlyLimitCredits: number | null
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
    dailyLimitCredits: policy.dailyLimit === null ? null : Number.parseFloat(policy.dailyLimit),
    monthlyLimitCredits: policy.monthlyLimit === null ? null : Number.parseFloat(policy.monthlyLimit),
  }
}

/**
 * The org-wide limits: the explicit row, or the allowance the active pricing
 * version seeds every organization with (ADR-0053 — a plan size is a platform
 * decision, not a code constant).
 */
export async function getOrgBudget(organizationId: string): Promise<EffectiveBudgetPolicy> {
  const policy = await repository.findActivePolicy(organizationId, 'organization', null)
  if (policy) {
    return { scope: 'organization', subjectId: null, explicit: true, policy, ...toLimits(policy) }
  }
  const pricing = await getEffectivePricing()
  return {
    scope: 'organization',
    subjectId: null,
    explicit: false,
    policy: null,
    dailyLimitCredits: pricing.defaultOrgDailyCredits,
    monthlyLimitCredits: pricing.defaultOrgMonthlyCredits,
  }
}

export async function getScopedBudget(
  organizationId: string,
  scope: 'member' | 'project',
  subjectId: string,
): Promise<EffectiveBudgetPolicy | null> {
  const policy = await repository.findActivePolicy(organizationId, scope, subjectId)
  if (!policy) return null
  return { scope, subjectId, explicit: true, policy, ...toLimits(policy) }
}

/** All active member/project policies of an org (for the settings UI). */
export async function listActivePolicies(organizationId: string): Promise<BudgetPolicy[]> {
  return repository.listActivePolicies(organizationId)
}

/** Full policy history (audit view). */
export async function listPolicyHistory(organizationId: string, limit = 100): Promise<BudgetPolicy[]> {
  return repository.listPolicyHistory(organizationId, limit)
}

export class BudgetValidationError extends Error {}

/**
 * Set (or clear a window of) a budget policy, in credits. Supersedes the
 * previous active row — never updates in place, so every change stays
 * auditable.
 *
 * Member and project limits are validated against the org's effective limits:
 * a scoped limit must be set (not unlimited) and must not exceed the org
 * limit for any window the org bounds.
 */
export async function setBudgetPolicy(params: {
  organizationId: string
  scope: BudgetScope
  subjectId: string | null
  dailyLimitCredits: number | null
  monthlyLimitCredits: number | null
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
  for (const value of [params.dailyLimitCredits, params.monthlyLimitCredits]) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new BudgetValidationError('limits must be non-negative numbers or null')
    }
  }

  if (scope !== 'organization') {
    const org = await getOrgBudget(organizationId)
    const pairs: Array<[number | null, number | null, string]> = [
      [params.dailyLimitCredits, org.dailyLimitCredits, 'daily'],
      [params.monthlyLimitCredits, org.monthlyLimitCredits, 'monthly'],
    ]
    for (const [scoped, orgLimit, window] of pairs) {
      if (orgLimit === null) continue
      if (scoped === null) {
        throw new BudgetValidationError(
          `${scope} ${window} limit cannot be unlimited while the organization ${window} limit is ${orgLimit} credits`,
        )
      }
      if (scoped > orgLimit) {
        throw new BudgetValidationError(
          `${scope} ${window} limit (${scoped} credits) exceeds the organization ${window} limit (${orgLimit} credits)`,
        )
      }
    }
  }

  const inserted = await repository.insertPolicySuperseding({
    organizationId,
    scope,
    subjectId,
    dailyLimit: params.dailyLimitCredits === null ? null : params.dailyLimitCredits.toFixed(4),
    monthlyLimit: params.monthlyLimitCredits === null ? null : params.monthlyLimitCredits.toFixed(4),
    createdBy: params.actorUserId,
    note: params.note ?? null,
  })
  await invalidateLimitsCache(organizationId, scope, subjectId)
  return inserted
}

/**
 * Remove a scoped (member/project) policy: supersede the active row without a
 * replacement, so the subject falls back to the org limits alone. The row
 * itself stays for the audit trail. Org-scope policies are never removed —
 * they are replaced (the org always has effective limits, seeded or explicit).
 */
export async function clearBudgetPolicy(params: {
  organizationId: string
  scope: 'member' | 'project'
  subjectId: string
  actorUserId: string
}): Promise<boolean> {
  const removed = await repository.supersedeActivePolicy(params.organizationId, params.scope, params.subjectId)
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
 * price change never rewrites what a tenant was shown (ADR-0053). The
 * write-through daily rollup (ADR-0019) is incremented in the same
 * transaction by the repository.
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
      priceUsd: row?.priceUsd ?? 0,
      credits: row?.credits ?? 0,
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
  /** Remaining budget in credits per applicable scope; null = unlimited. */
  remainingOrgCredits: number | null
  remainingUserCredits: number | null
  remainingProjectCredits: number | null
  /**
   * The same remainders as platform-billed cost in USD — what the backend
   * tracker meters in. The inverse of pricing at the active version; for an
   * organization on its own key the margin is left out, as it is at write time.
   */
  remainingOrgUsd: number | null
  remainingUserUsd: number | null
  remainingProjectUsd: number | null
}

function remainingCredits(limits: BudgetLimits, spend: SpendTotals): number | null {
  const candidates: number[] = []
  if (limits.dailyLimitCredits !== null) candidates.push(limits.dailyLimitCredits - spend.day.credits)
  if (limits.monthlyLimitCredits !== null) candidates.push(limits.monthlyLimitCredits - spend.month.credits)
  if (candidates.length === 0) return null
  return Math.max(0, Math.min(...candidates))
}

/**
 * Policy LIMITS for the enforcement path, via the shared cache
 * (write-invalidate on policy writes, ADR-0020). Only the numeric limits are
 * cached — policy rows with their audit fields stay uncached in the
 * settings/admin reads.
 */
const LIMITS_CACHE_TTL_MS = 5 * 60 * 1000

const limitsCacheKey = (organizationId: string, scope: BudgetScope, subjectId: string | null): string =>
  `budgetlimits:${organizationId}:${scope}:${subjectId ?? ''}`

async function getCachedOrgLimits(organizationId: string): Promise<BudgetLimits> {
  return getCached(limitsCacheKey(organizationId, 'organization', null), LIMITS_CACHE_TTL_MS, async () => {
    const org = await getOrgBudget(organizationId)
    return { dailyLimitCredits: org.dailyLimitCredits, monthlyLimitCredits: org.monthlyLimitCredits }
  })
}

async function getCachedScopedLimits(
  organizationId: string,
  scope: 'member' | 'project',
  subjectId: string,
): Promise<BudgetLimits | null> {
  return getCached(limitsCacheKey(organizationId, scope, subjectId), LIMITS_CACHE_TTL_MS, async () => {
    const scoped = await getScopedBudget(organizationId, scope, subjectId)
    if (!scoped) return null
    return { dailyLimitCredits: scoped.dailyLimitCredits, monthlyLimitCredits: scoped.monthlyLimitCredits }
  })
}

async function invalidateLimitsCache(
  organizationId: string,
  scope: BudgetScope,
  subjectId: string | null,
): Promise<void> {
  await invalidateCached(limitsCacheKey(organizationId, scope, subjectId))
}

/** Drop every cached org-scope limit that came from the seeded allowance — a pricing save changes it. */
export async function invalidateSeededLimits(): Promise<void> {
  // Org-scope limits are cached per organization; the seeded allowance is
  // part of the pricing version, so a pricing change must not serve the old
  // allowance for the TTL. Prefix invalidation covers every org at once.
  const { invalidateCachedPrefix } = await import('@/lib/cache')
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
  // Two parallel waves instead of up to six serial round-trips: policies and
  // org spend first, then the scoped spend aggregations only where a policy
  // actually exists.
  const [orgBudget, orgSpend, memberBudget, projectBudget, pricing, ownKey] = await Promise.all([
    getCachedOrgLimits(organizationId),
    getSpendTotals(organizationId),
    userId ? getCachedScopedLimits(organizationId, 'member', userId) : Promise.resolve(null),
    projectId ? getCachedScopedLimits(organizationId, 'project', projectId) : Promise.resolve(null),
    getEffectivePricing(),
    isOrgOnOwnKey(organizationId),
  ])
  const remainingOrg = remainingCredits(orgBudget, orgSpend)

  const [memberSpend, projectSpend] = await Promise.all([
    memberBudget && userId ? getSpendTotals(organizationId, { userId }) : Promise.resolve(null),
    projectBudget && projectId ? getSpendTotals(organizationId, { projectId }) : Promise.resolve(null),
  ])

  const remainingUser = memberBudget && memberSpend ? remainingCredits(memberBudget, memberSpend) : null
  const remainingProject = projectBudget && projectSpend ? remainingCredits(projectBudget, projectSpend) : null

  const scopes: Array<[BudgetScope, number | null]> = [
    ['organization', remainingOrg],
    ['member', remainingUser],
    ['project', remainingProject],
  ]
  const exhausted = scopes.find(([, remaining]) => remaining !== null && remaining <= 0)
  const toUsd = (credits: number | null): number | null =>
    credits === null ? null : creditsToCostUsd(credits, pricing, ownKey)

  return {
    blocked: Boolean(exhausted),
    blockedScope: exhausted?.[0] ?? null,
    remainingOrgCredits: remainingOrg,
    remainingUserCredits: remainingUser,
    remainingProjectCredits: remainingProject,
    remainingOrgUsd: toUsd(remainingOrg),
    remainingUserUsd: toUsd(remainingUser),
    remainingProjectUsd: toUsd(remainingProject),
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
  organization: EffectiveBudgetPolicy
  ownMemberLimit: EffectiveBudgetPolicy | null
  /** Only present for budget admins: every active member/project policy. */
  policies?: BudgetPolicy[]
}

/**
 * Budget view for the settings page: every member sees the org limits and
 * their own member limit; budget admins additionally get all active policies.
 */
export async function getBudgetOverview(session: AuthorizedSession): Promise<BudgetOverview> {
  const [organization, ownMemberLimit] = await Promise.all([
    getOrgBudget(session.organizationId),
    getScopedBudget(session.organizationId, 'member', session.userId),
  ])
  const overview: BudgetOverview = { organization, ownMemberLimit }
  if (canManageBudgets(session)) {
    overview.policies = await listActivePolicies(session.organizationId)
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
  dailyLimitCredits: number | null
  monthlyLimitCredits: number | null
  note?: string | null
}

/** Set a budget policy for the caller's org (authz + validation + audit). */
export async function saveBudgetPolicy(
  session: AuthorizedSession,
  input: BudgetPolicyInput,
  request: Request,
): Promise<BudgetPolicy> {
  const { scope, dailyLimitCredits, monthlyLimitCredits } = input
  const subjectId = input.subjectId ?? null

  await authorizePolicyWrite(session, scope, subjectId)

  let policy: BudgetPolicy
  try {
    policy = await setBudgetPolicy({
      organizationId: session.organizationId,
      scope,
      subjectId: scope === 'organization' ? null : subjectId,
      dailyLimitCredits,
      monthlyLimitCredits,
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
    metadata: { scope, subjectId, dailyLimitCredits, monthlyLimitCredits },
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
// The tenant's view: credits only
// ---------------------------------------------------------------------------

/**
 * What a tenant is shown of a window. Cost and price are deliberately absent:
 * the tenant's unit is credits, and the platform's purchase price is not the
 * tenant's business (ADR-0053). This projection is the ONE place the ledger's
 * money columns are narrowed for tenant surfaces, so a new tenant endpoint
 * that reuses it cannot leak cost by accident.
 */
export interface TenantSpendWindow {
  credits: number
  events: number
}

const toTenantWindow = (window: SpendWindow): TenantSpendWindow => ({
  credits: window.credits,
  events: window.events,
})

export interface UsageOverview {
  summary: {
    day: TenantSpendWindow
    month: TenantSpendWindow
    perModel: Array<{ model: string; day: TenantSpendWindow; month: TenantSpendWindow }>
  }
  perMember: Array<{ userId: string; day: TenantSpendWindow; month: TenantSpendWindow }> | null
  dailyTrend: Array<{ day: string } & TenantSpendWindow> | null
  orgBudget: BudgetLimits & { explicit: boolean }
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

  const [summary, orgBudget, status, perMember, dailyTrend] = await Promise.all([
    getSpendSummary(session.organizationId, filter),
    getOrgBudget(session.organizationId),
    getBudgetStatus(session.organizationId, session.userId, null),
    // Member breakdown + trend feed the admin dashboard only.
    admin ? getSpendByMember(session.organizationId) : Promise.resolve(null),
    admin ? getDailySpendTrend({ organizationId: session.organizationId, days: 30 }) : Promise.resolve(null),
  ])

  return {
    summary: {
      day: toTenantWindow(summary.day),
      month: toTenantWindow(summary.month),
      perModel: summary.perModel.map((entry) => ({
        model: entry.model,
        day: toTenantWindow(entry.day),
        month: toTenantWindow(entry.month),
      })),
    },
    perMember: perMember
      ? perMember.map((entry) => ({
          userId: entry.userId,
          day: toTenantWindow(entry.day),
          month: toTenantWindow(entry.month),
        }))
      : null,
    dailyTrend: dailyTrend ? dailyTrend.map((point) => ({ day: point.day, ...toTenantWindow(point) })) : null,
    orgBudget: {
      dailyLimitCredits: orgBudget.dailyLimitCredits,
      monthlyLimitCredits: orgBudget.monthlyLimitCredits,
      explicit: orgBudget.explicit,
    },
    status: { blocked: status.blocked, blockedScope: status.blockedScope },
    scope: admin ? filter : { userId: session.userId },
  }
}

/** Re-exported so platform surfaces can convert cost with the active rate. */
export type { EffectivePricing }
