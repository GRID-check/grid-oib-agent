/**
 * LLM budgets & usage service (ADR-0015, docs/architecture/usage-budgets.md).
 *
 * Business logic and authorization only — all DB access lives in
 * `./repository` (ADR-0017).
 *
 * Limits are stored in EUR (org seed default: €10/day, €100/month); the
 * ledger stores cost in USD exactly as OpenRouter reports it. Comparison
 * happens here at read time via a deployment-configured conversion rate
 * (GRID_BUDGET_EUR_PER_USD = euros per 1 USD, default 0.86) so a rate change
 * applies uniformly to all historical spend.
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
import * as repository from './repository'
import type {
  DailySpendRow,
  MemberSpend,
  ModelSpend,
  OrganizationSpend,
  SpendSummary,
  SpendTotals,
} from './repository'

export { utcDayStart, utcMonthStart } from './repository'
export type { DailySpendRow, MemberSpend, ModelSpend, OrganizationSpend, SpendSummary, SpendTotals }

export const DEFAULT_ORG_DAILY_LIMIT_EUR = 10
export const DEFAULT_ORG_MONTHLY_LIMIT_EUR = 100

/** Euros per 1 USD used to compare USD spend against EUR limits. */
export function eurPerUsd(): number {
  const parsed = Number.parseFloat(process.env.GRID_BUDGET_EUR_PER_USD ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.86
}

export function usdToEur(usd: number): number {
  return usd * eurPerUsd()
}

export function eurToUsd(eur: number): number {
  return eur / eurPerUsd()
}

export interface BudgetLimits {
  dailyLimitEur: number | null
  monthlyLimitEur: number | null
}

export interface EffectiveBudgetPolicy extends BudgetLimits {
  scope: BudgetScope
  subjectId: string | null
  /** False when the org runs on the seeded defaults (no explicit row yet). */
  explicit: boolean
  policy: BudgetPolicy | null
}

function toLimits(policy: BudgetPolicy): BudgetLimits {
  return {
    dailyLimitEur: policy.dailyLimit === null ? null : Number.parseFloat(policy.dailyLimit),
    monthlyLimitEur: policy.monthlyLimit === null ? null : Number.parseFloat(policy.monthlyLimit),
  }
}

/** The org-wide limits: explicit row or the seeded €10/€100 defaults. */
export async function getOrgBudget(organizationId: string): Promise<EffectiveBudgetPolicy> {
  const policy = await repository.findActivePolicy(organizationId, 'organization', null)
  if (policy) {
    return { scope: 'organization', subjectId: null, explicit: true, policy, ...toLimits(policy) }
  }
  return {
    scope: 'organization',
    subjectId: null,
    explicit: false,
    policy: null,
    dailyLimitEur: DEFAULT_ORG_DAILY_LIMIT_EUR,
    monthlyLimitEur: DEFAULT_ORG_MONTHLY_LIMIT_EUR,
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
 * Set (or clear a window of) a budget policy. Supersedes the previous active
 * row — never updates in place, so every change stays auditable.
 *
 * Member and project limits are validated against the org's effective limits:
 * a scoped limit must be set (not unlimited) and must not exceed the org
 * limit for any window the org bounds.
 */
export async function setBudgetPolicy(params: {
  organizationId: string
  scope: BudgetScope
  subjectId: string | null
  dailyLimitEur: number | null
  monthlyLimitEur: number | null
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
  for (const value of [params.dailyLimitEur, params.monthlyLimitEur]) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new BudgetValidationError('limits must be non-negative numbers or null')
    }
  }

  if (scope !== 'organization') {
    const org = await getOrgBudget(organizationId)
    const pairs: Array<[number | null, number | null, string]> = [
      [params.dailyLimitEur, org.dailyLimitEur, 'daily'],
      [params.monthlyLimitEur, org.monthlyLimitEur, 'monthly'],
    ]
    for (const [scoped, orgLimit, window] of pairs) {
      if (orgLimit === null) continue
      if (scoped === null) {
        throw new BudgetValidationError(
          `${scope} ${window} limit cannot be unlimited while the organization ${window} limit is €${orgLimit}`,
        )
      }
      if (scoped > orgLimit) {
        throw new BudgetValidationError(
          `${scope} ${window} limit (€${scoped}) exceeds the organization ${window} limit (€${orgLimit})`,
        )
      }
    }
  }

  const inserted = await repository.insertPolicySuperseding({
    organizationId,
    scope,
    subjectId,
    dailyLimit: params.dailyLimitEur === null ? null : params.dailyLimitEur.toFixed(4),
    monthlyLimit: params.monthlyLimitEur === null ? null : params.monthlyLimitEur.toFixed(4),
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

/**
 * Append ledger rows; the write-through daily rollup (ADR-0019) is
 * incremented in the same transaction by the repository.
 */
export async function recordUsageEvents(events: NewLlmUsageEvent[]): Promise<number> {
  return repository.insertUsageEventsWithRollups(events)
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

export interface DailySpendPoint {
  /** UTC day, `YYYY-MM-DD`. */
  day: string
  usd: number
  events: number
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
      usd: row?.usd ?? 0,
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
  /** Remaining budget in USD per applicable scope; null = unlimited. */
  remainingOrgUsd: number | null
  remainingUserUsd: number | null
  remainingProjectUsd: number | null
}

function remainingUsd(limits: BudgetLimits, spend: SpendTotals): number | null {
  const candidates: number[] = []
  if (limits.dailyLimitEur !== null) candidates.push(eurToUsd(limits.dailyLimitEur) - spend.dayUsd)
  if (limits.monthlyLimitEur !== null) candidates.push(eurToUsd(limits.monthlyLimitEur) - spend.monthUsd)
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
    return { dailyLimitEur: org.dailyLimitEur, monthlyLimitEur: org.monthlyLimitEur }
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
    return { dailyLimitEur: scoped.dailyLimitEur, monthlyLimitEur: scoped.monthlyLimitEur }
  })
}

async function invalidateLimitsCache(
  organizationId: string,
  scope: BudgetScope,
  subjectId: string | null,
): Promise<void> {
  await invalidateCached(limitsCacheKey(organizationId, scope, subjectId))
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
  const [orgBudget, orgSpend, memberBudget, projectBudget] = await Promise.all([
    getCachedOrgLimits(organizationId),
    getSpendTotals(organizationId),
    userId ? getCachedScopedLimits(organizationId, 'member', userId) : Promise.resolve(null),
    projectId ? getCachedScopedLimits(organizationId, 'project', projectId) : Promise.resolve(null),
  ])
  const remainingOrg = remainingUsd(orgBudget, orgSpend)

  const [memberSpend, projectSpend] = await Promise.all([
    memberBudget && userId ? getSpendTotals(organizationId, { userId }) : Promise.resolve(null),
    projectBudget && projectId ? getSpendTotals(organizationId, { projectId }) : Promise.resolve(null),
  ])

  const remainingUser = memberBudget && memberSpend ? remainingUsd(memberBudget, memberSpend) : null
  const remainingProject = projectBudget && projectSpend ? remainingUsd(projectBudget, projectSpend) : null

  const scopes: Array<[BudgetScope, number | null]> = [
    ['organization', remainingOrg],
    ['member', remainingUser],
    ['project', remainingProject],
  ]
  const exhausted = scopes.find(([, remaining]) => remaining !== null && remaining <= 0)

  return {
    blocked: Boolean(exhausted),
    blockedScope: exhausted?.[0] ?? null,
    remainingOrgUsd: remainingOrg,
    remainingUserUsd: remainingUser,
    remainingProjectUsd: remainingProject,
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
  dailyLimitEur: number | null
  monthlyLimitEur: number | null
  note?: string | null
}

/** Set a budget policy for the caller's org (authz + validation + audit). */
export async function saveBudgetPolicy(
  session: AuthorizedSession,
  input: BudgetPolicyInput,
  request: Request,
): Promise<BudgetPolicy> {
  const { scope, dailyLimitEur, monthlyLimitEur } = input
  const subjectId = input.subjectId ?? null

  await authorizePolicyWrite(session, scope, subjectId)

  let policy: BudgetPolicy
  try {
    policy = await setBudgetPolicy({
      organizationId: session.organizationId,
      scope,
      subjectId: scope === 'organization' ? null : subjectId,
      dailyLimitEur,
      monthlyLimitEur,
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
    metadata: { scope, subjectId, dailyLimitEur, monthlyLimitEur },
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

export interface UsageOverview {
  summary: SpendSummary
  perMember: MemberSpend[] | null
  dailyTrend: DailySpendPoint[] | null
  orgBudget: { dailyLimitEur: number | null; monthlyLimitEur: number | null; explicit: boolean }
  status: BudgetStatus
  eurPerUsd: number
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
    summary,
    perMember,
    dailyTrend,
    orgBudget: {
      dailyLimitEur: orgBudget.dailyLimitEur,
      monthlyLimitEur: orgBudget.monthlyLimitEur,
      explicit: orgBudget.explicit,
    },
    status,
    eurPerUsd: eurPerUsd(),
    scope: admin ? filter : { userId: session.userId },
  }
}
