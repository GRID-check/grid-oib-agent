/**
 * LLM budgets & usage service (ADR-0015, docs/architecture/usage-budgets.md).
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
import { and, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  budgetPolicies,
  llmUsageEvents,
  type BudgetPolicy,
  type BudgetScope,
  type NewLlmUsageEvent,
} from '@/lib/db/schema'

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

async function activePolicy(
  organizationId: string,
  scope: BudgetScope,
  subjectId: string | null,
): Promise<BudgetPolicy | null> {
  const db = getDb()
  const subjectCondition =
    subjectId === null ? isNull(budgetPolicies.subjectId) : eq(budgetPolicies.subjectId, subjectId)
  const [row] = await db
    .select()
    .from(budgetPolicies)
    .where(
      and(
        eq(budgetPolicies.organizationId, organizationId),
        eq(budgetPolicies.scope, scope),
        subjectCondition,
        eq(budgetPolicies.status, 'active'),
      ),
    )
    .limit(1)
  return row ?? null
}

/** The org-wide limits: explicit row or the seeded €10/€100 defaults. */
export async function getOrgBudget(organizationId: string): Promise<EffectiveBudgetPolicy> {
  const policy = await activePolicy(organizationId, 'organization', null)
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
  const policy = await activePolicy(organizationId, scope, subjectId)
  if (!policy) return null
  return { scope, subjectId, explicit: true, policy, ...toLimits(policy) }
}

/** All active member/project policies of an org (for the settings UI). */
export async function listActivePolicies(organizationId: string): Promise<BudgetPolicy[]> {
  const db = getDb()
  return db
    .select()
    .from(budgetPolicies)
    .where(and(eq(budgetPolicies.organizationId, organizationId), eq(budgetPolicies.status, 'active')))
    .orderBy(budgetPolicies.scope, budgetPolicies.subjectId)
}

/** Full policy history (audit view). */
export async function listPolicyHistory(organizationId: string, limit = 100): Promise<BudgetPolicy[]> {
  const db = getDb()
  return db
    .select()
    .from(budgetPolicies)
    .where(eq(budgetPolicies.organizationId, organizationId))
    .orderBy(desc(budgetPolicies.createdAt))
    .limit(limit)
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

  const db = getDb()
  return db.transaction(async (tx) => {
    const subjectCondition =
      subjectId === null ? isNull(budgetPolicies.subjectId) : eq(budgetPolicies.subjectId, subjectId)
    const [previous] = await tx
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.organizationId, organizationId),
          eq(budgetPolicies.scope, scope),
          subjectCondition,
          eq(budgetPolicies.status, 'active'),
        ),
      )
      .limit(1)
    if (previous) {
      await tx.update(budgetPolicies).set({ status: 'superseded' }).where(eq(budgetPolicies.id, previous.id))
    }
    const [inserted] = await tx
      .insert(budgetPolicies)
      .values({
        organizationId,
        scope,
        subjectId,
        dailyLimit: params.dailyLimitEur === null ? null : params.dailyLimitEur.toFixed(4),
        monthlyLimit: params.monthlyLimitEur === null ? null : params.monthlyLimitEur.toFixed(4),
        currency: 'EUR',
        status: 'active',
        supersedesId: previous?.id ?? null,
        createdBy: params.actorUserId,
        note: params.note ?? null,
      })
      .returning()
    return inserted
  })
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
  const db = getDb()
  const [previous] = await db
    .select()
    .from(budgetPolicies)
    .where(
      and(
        eq(budgetPolicies.organizationId, params.organizationId),
        eq(budgetPolicies.scope, params.scope),
        eq(budgetPolicies.subjectId, params.subjectId),
        eq(budgetPolicies.status, 'active'),
      ),
    )
    .limit(1)
  if (!previous) return false
  await db.update(budgetPolicies).set({ status: 'superseded' }).where(eq(budgetPolicies.id, previous.id))
  return true
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export async function recordUsageEvents(events: NewLlmUsageEvent[]): Promise<number> {
  if (events.length === 0) return 0
  const db = getDb()
  const inserted = await db.insert(llmUsageEvents).values(events).returning({ id: llmUsageEvents.id })
  return inserted.length
}

export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export function utcMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export interface ModelSpend {
  model: string
  dayUsd: number
  monthUsd: number
  dayEvents: number
  monthEvents: number
}

export interface SpendSummary {
  dayUsd: number
  monthUsd: number
  perModel: ModelSpend[]
}

/**
 * Windowed spend, org-wide by default or narrowed to one member/project.
 * One month-window aggregation query; the day slice reuses it via FILTER.
 */
export async function getSpendSummary(
  organizationId: string,
  filter: { userId?: string; projectId?: string } = {},
): Promise<SpendSummary> {
  const db = getDb()
  const dayStart = utcDayStart()
  const monthStart = utcMonthStart()
  // Raw `sql` fragments bypass drizzle's column-type mapping, and the
  // postgres-js driver rejects Date instances for inferred parameters — pass
  // ISO strings there (the typed gte() below handles the Date itself).
  const dayStartIso = dayStart.toISOString()

  const conditions = [eq(llmUsageEvents.organizationId, organizationId), gte(llmUsageEvents.createdAt, monthStart)]
  if (filter.userId) conditions.push(eq(llmUsageEvents.userId, filter.userId))
  if (filter.projectId) conditions.push(eq(llmUsageEvents.projectId, filter.projectId))

  const rows = await db
    .select({
      model: sql<string>`coalesce(${llmUsageEvents.model}, 'unknown')`,
      monthUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}), 0)`,
      dayUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${llmUsageEvents.createdAt} >= ${dayStartIso}), 0)`,
      monthEvents: sql<string>`count(*)`,
      dayEvents: sql<string>`count(*) filter (where ${llmUsageEvents.createdAt} >= ${dayStartIso})`,
    })
    .from(llmUsageEvents)
    .where(and(...conditions))
    .groupBy(sql`coalesce(${llmUsageEvents.model}, 'unknown')`)

  const perModel: ModelSpend[] = rows
    .map((row) => ({
      model: row.model,
      dayUsd: Number.parseFloat(row.dayUsd) || 0,
      monthUsd: Number.parseFloat(row.monthUsd) || 0,
      dayEvents: Number.parseInt(row.dayEvents, 10) || 0,
      monthEvents: Number.parseInt(row.monthEvents, 10) || 0,
    }))
    .sort((a, b) => b.monthUsd - a.monthUsd)

  return {
    dayUsd: perModel.reduce((total, m) => total + m.dayUsd, 0),
    monthUsd: perModel.reduce((total, m) => total + m.monthUsd, 0),
    perModel,
  }
}

export interface MemberSpend {
  userId: string
  dayUsd: number
  monthUsd: number
  dayEvents: number
  monthEvents: number
}

/**
 * Windowed spend per member (admin view — the member usage table).
 * Events without a user id (anonymous mode) are excluded.
 */
export async function getSpendByMember(organizationId: string): Promise<MemberSpend[]> {
  const db = getDb()
  const dayStartIso = utcDayStart().toISOString()
  const monthStart = utcMonthStart()

  const rows = await db
    .select({
      userId: llmUsageEvents.userId,
      monthUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}), 0)`,
      dayUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${llmUsageEvents.createdAt} >= ${dayStartIso}), 0)`,
      monthEvents: sql<string>`count(*)`,
      dayEvents: sql<string>`count(*) filter (where ${llmUsageEvents.createdAt} >= ${dayStartIso})`,
    })
    .from(llmUsageEvents)
    .where(
      and(
        eq(llmUsageEvents.organizationId, organizationId),
        gte(llmUsageEvents.createdAt, monthStart),
        isNotNull(llmUsageEvents.userId),
      ),
    )
    .groupBy(llmUsageEvents.userId)

  return rows
    .map((row) => ({
      userId: row.userId as string,
      dayUsd: Number.parseFloat(row.dayUsd) || 0,
      monthUsd: Number.parseFloat(row.monthUsd) || 0,
      dayEvents: Number.parseInt(row.dayEvents, 10) || 0,
      monthEvents: Number.parseInt(row.monthEvents, 10) || 0,
    }))
    .sort((a, b) => b.monthUsd - a.monthUsd)
}

export interface OrganizationSpend {
  organizationId: string
  dayUsd: number
  monthUsd: number
  dayEvents: number
  monthEvents: number
}

/**
 * Windowed spend per organization across the WHOLE platform (platform-tier
 * dashboards only — caller must hold `platform:usage:view`, ADR-0016).
 */
export async function getSpendAcrossOrganizations(): Promise<OrganizationSpend[]> {
  const db = getDb()
  const dayStartIso = utcDayStart().toISOString()
  const monthStart = utcMonthStart()

  const rows = await db
    .select({
      organizationId: llmUsageEvents.organizationId,
      monthUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}), 0)`,
      dayUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${llmUsageEvents.createdAt} >= ${dayStartIso}), 0)`,
      monthEvents: sql<string>`count(*)`,
      dayEvents: sql<string>`count(*) filter (where ${llmUsageEvents.createdAt} >= ${dayStartIso})`,
    })
    .from(llmUsageEvents)
    .where(gte(llmUsageEvents.createdAt, monthStart))
    .groupBy(llmUsageEvents.organizationId)

  return rows
    .map((row) => ({
      organizationId: row.organizationId,
      dayUsd: Number.parseFloat(row.dayUsd) || 0,
      monthUsd: Number.parseFloat(row.monthUsd) || 0,
      dayEvents: Number.parseInt(row.dayEvents, 10) || 0,
      monthEvents: Number.parseInt(row.monthEvents, 10) || 0,
    }))
    .sort((a, b) => b.monthUsd - a.monthUsd)
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

function remainingUsd(limits: BudgetLimits, spend: SpendSummary): number | null {
  const candidates: number[] = []
  if (limits.dailyLimitEur !== null) candidates.push(eurToUsd(limits.dailyLimitEur) - spend.dayUsd)
  if (limits.monthlyLimitEur !== null) candidates.push(eurToUsd(limits.monthlyLimitEur) - spend.monthUsd)
  if (candidates.length === 0) return null
  return Math.max(0, Math.min(...candidates))
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
  const orgBudget = await getOrgBudget(organizationId)
  const orgSpend = await getSpendSummary(organizationId)
  const remainingOrg = remainingUsd(orgBudget, orgSpend)

  let remainingUser: number | null = null
  if (userId) {
    const memberBudget = await getScopedBudget(organizationId, 'member', userId)
    if (memberBudget) {
      remainingUser = remainingUsd(memberBudget, await getSpendSummary(organizationId, { userId }))
    }
  }

  let remainingProject: number | null = null
  if (projectId) {
    const projectBudget = await getScopedBudget(organizationId, 'project', projectId)
    if (projectBudget) {
      remainingProject = remainingUsd(projectBudget, await getSpendSummary(organizationId, { projectId }))
    }
  }

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
