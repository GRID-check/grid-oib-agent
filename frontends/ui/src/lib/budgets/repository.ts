/**
 * Budgets repository (ADR-0017): the ONLY module that queries the DB for the
 * budgets domain. Raw data access and row shaping only — validation,
 * authorization, pricing, and enforcement semantics live in `./service`.
 *
 * The ledger (`llm_usage_events`) is append-only; the daily rollup
 * (`llm_usage_rollups`, ADR-0019) is incremented in the SAME transaction as
 * every ledger insert, so enforcement reads (`sumRollupTotals`) are exact.
 *
 * Every aggregate carries the three money columns side by side — `costUsd`
 * (what the platform paid), `priceUsd` (what the tenant is charged) and
 * `credits` (the tenant's unit) — and the SERVICE decides which of them a
 * caller may see (ADR-0053: cost never reaches a tenant).
 */

import 'server-only'
import { and, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  budgetPolicies,
  llmUsageEvents,
  llmUsageRollups,
  type BudgetPolicy,
  type BudgetScope,
  type NewLlmUsageEvent,
} from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// UTC windows
// ---------------------------------------------------------------------------

export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export function utcMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export async function findActivePolicy(
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

/**
 * Supersede idiom: mark the active row (if any) superseded and insert the
 * replacement in one transaction, so every limit change stays auditable.
 * Limits are credits (ADR-0053).
 */
export async function insertPolicySuperseding(values: {
  organizationId: string
  scope: BudgetScope
  subjectId: string | null
  dailyLimit: string | null
  monthlyLimit: string | null
  createdBy: string
  note: string | null
}): Promise<BudgetPolicy> {
  const db = getDb()
  return db.transaction(async (tx) => {
    const subjectCondition =
      values.subjectId === null ? isNull(budgetPolicies.subjectId) : eq(budgetPolicies.subjectId, values.subjectId)
    const [previous] = await tx
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.organizationId, values.organizationId),
          eq(budgetPolicies.scope, values.scope),
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
        organizationId: values.organizationId,
        scope: values.scope,
        subjectId: values.subjectId,
        dailyLimit: values.dailyLimit,
        monthlyLimit: values.monthlyLimit,
        currency: 'credit',
        status: 'active',
        supersedesId: previous?.id ?? null,
        createdBy: values.createdBy,
        note: values.note,
      })
      .returning()
    return inserted
  })
}

/** Mark the active scoped policy superseded without replacement. */
export async function supersedeActivePolicy(
  organizationId: string,
  scope: 'member' | 'project',
  subjectId: string,
): Promise<boolean> {
  const db = getDb()
  const [previous] = await db
    .select()
    .from(budgetPolicies)
    .where(
      and(
        eq(budgetPolicies.organizationId, organizationId),
        eq(budgetPolicies.scope, scope),
        eq(budgetPolicies.subjectId, subjectId),
        eq(budgetPolicies.status, 'active'),
      ),
    )
    .limit(1)
  if (!previous) return false
  await db.update(budgetPolicies).set({ status: 'superseded' }).where(eq(budgetPolicies.id, previous.id))
  return true
}

// ---------------------------------------------------------------------------
// Ledger writes (+ write-through rollup, ADR-0019)
// ---------------------------------------------------------------------------

/** UTC calendar day (YYYY-MM-DD) an event belongs to. */
function utcDayOf(createdAt: Date | undefined): string {
  return (createdAt ?? new Date()).toISOString().slice(0, 10)
}

const num = (value: string | number | null | undefined): number => Number.parseFloat(String(value ?? '0')) || 0

interface RollupIncrement {
  organizationId: string
  day: string
  userId: string
  projectId: string
  costUsd: number
  priceUsd: number
  credits: number
  events: number
}

function buildRollupIncrements(events: NewLlmUsageEvent[]): RollupIncrement[] {
  const byKey = new Map<string, RollupIncrement>()
  for (const event of events) {
    const day = utcDayOf(event.createdAt ?? undefined)
    const userId = event.userId ?? ''
    const projectId = event.projectId ?? ''
    const key = `${event.organizationId} ${day} ${userId} ${projectId}`
    const entry = byKey.get(key) ?? {
      organizationId: event.organizationId,
      day,
      userId,
      projectId,
      costUsd: 0,
      priceUsd: 0,
      credits: 0,
      events: 0,
    }
    entry.costUsd += num(event.costUsd)
    entry.priceUsd += num(event.priceUsd)
    entry.credits += num(event.credits)
    entry.events += 1
    byKey.set(key, entry)
  }
  return [...byKey.values()]
}

/**
 * Append fully priced ledger rows (the service fills `priceUsd`, `credits` and
 * `pricingVersionId` before calling this) and increment the rollup in the same
 * transaction.
 */
export async function insertUsageEventsWithRollups(events: NewLlmUsageEvent[]): Promise<number> {
  if (events.length === 0) return 0
  const db = getDb()
  return db.transaction(async (tx) => {
    const inserted = await tx.insert(llmUsageEvents).values(events).returning({ id: llmUsageEvents.id })

    // Same transaction as the ledger insert, so the rollup is exact.
    for (const increment of buildRollupIncrements(events)) {
      const costUsd = increment.costUsd.toFixed(8)
      const priceUsd = increment.priceUsd.toFixed(8)
      const credits = increment.credits.toFixed(6)
      await tx
        .insert(llmUsageRollups)
        .values({
          organizationId: increment.organizationId,
          day: increment.day,
          userId: increment.userId,
          projectId: increment.projectId,
          costUsd,
          priceUsd,
          credits,
          events: increment.events,
        })
        .onConflictDoUpdate({
          target: [
            llmUsageRollups.organizationId,
            llmUsageRollups.day,
            llmUsageRollups.userId,
            llmUsageRollups.projectId,
          ],
          set: {
            costUsd: sql`${llmUsageRollups.costUsd} + ${costUsd}`,
            priceUsd: sql`${llmUsageRollups.priceUsd} + ${priceUsd}`,
            credits: sql`${llmUsageRollups.credits} + ${credits}`,
            events: sql`${llmUsageRollups.events} + ${increment.events}`,
            updatedAt: new Date(),
          },
        })
    }

    return inserted.length
  })
}

// ---------------------------------------------------------------------------
// Spend reads
// ---------------------------------------------------------------------------

/** One window's money, all three units, plus how many generations made it. */
export interface SpendWindow {
  costUsd: number
  priceUsd: number
  credits: number
  events: number
}

const EMPTY_WINDOW: SpendWindow = { costUsd: 0, priceUsd: 0, credits: 0, events: 0 }

export interface SpendTotals {
  day: SpendWindow
  month: SpendWindow
}

/** Day/month totals from the write-through rollup — the enforcement hot path. */
export async function sumRollupTotals(
  organizationId: string,
  filter: { userId?: string; projectId?: string } = {},
): Promise<SpendTotals> {
  const db = getDb()
  const dayStr = utcDayStart().toISOString().slice(0, 10)
  const monthStr = utcMonthStart().toISOString().slice(0, 10)

  const conditions = [eq(llmUsageRollups.organizationId, organizationId), gte(llmUsageRollups.day, monthStr)]
  if (filter.userId) conditions.push(eq(llmUsageRollups.userId, filter.userId))
  if (filter.projectId) conditions.push(eq(llmUsageRollups.projectId, filter.projectId))

  const isToday = sql`${llmUsageRollups.day} = ${dayStr}`
  const [row] = await db
    .select({
      monthCostUsd: sql<string>`coalesce(sum(${llmUsageRollups.costUsd}), 0)`,
      monthPriceEur: sql<string>`coalesce(sum(${llmUsageRollups.priceUsd}), 0)`,
      monthCredits: sql<string>`coalesce(sum(${llmUsageRollups.credits}), 0)`,
      monthEvents: sql<string>`coalesce(sum(${llmUsageRollups.events}), 0)`,
      dayCostUsd: sql<string>`coalesce(sum(${llmUsageRollups.costUsd}) filter (where ${isToday}), 0)`,
      dayPriceEur: sql<string>`coalesce(sum(${llmUsageRollups.priceUsd}) filter (where ${isToday}), 0)`,
      dayCredits: sql<string>`coalesce(sum(${llmUsageRollups.credits}) filter (where ${isToday}), 0)`,
      dayEvents: sql<string>`coalesce(sum(${llmUsageRollups.events}) filter (where ${isToday}), 0)`,
    })
    .from(llmUsageRollups)
    .where(and(...conditions))

  if (!row) return { day: EMPTY_WINDOW, month: EMPTY_WINDOW }
  return {
    day: { costUsd: num(row.dayCostUsd), priceUsd: num(row.dayPriceEur), credits: num(row.dayCredits), events: num(row.dayEvents) },
    month: {
      costUsd: num(row.monthCostUsd),
      priceUsd: num(row.monthPriceEur),
      credits: num(row.monthCredits),
      events: num(row.monthEvents),
    },
  }
}

/** The month-window ledger aggregation every breakdown below shares. */
function windowColumns(dayStartIso: string) {
  const isToday = sql`${llmUsageEvents.createdAt} >= ${dayStartIso}`
  return {
    monthCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}), 0)`,
    monthPriceEur: sql<string>`coalesce(sum(${llmUsageEvents.priceUsd}), 0)`,
    monthCredits: sql<string>`coalesce(sum(${llmUsageEvents.credits}), 0)`,
    monthEvents: sql<string>`count(*)`,
    dayCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${isToday}), 0)`,
    dayPriceEur: sql<string>`coalesce(sum(${llmUsageEvents.priceUsd}) filter (where ${isToday}), 0)`,
    dayCredits: sql<string>`coalesce(sum(${llmUsageEvents.credits}) filter (where ${isToday}), 0)`,
    dayEvents: sql<string>`count(*) filter (where ${isToday})`,
  }
}

interface WindowRow {
  monthCostUsd: string
  monthPriceEur: string
  monthCredits: string
  monthEvents: string
  dayCostUsd: string
  dayPriceEur: string
  dayCredits: string
  dayEvents: string
}

/** Coerce at the repository boundary: raw `sql<T>` columns arrive as strings. */
function toWindows(row: WindowRow): { day: SpendWindow; month: SpendWindow } {
  return {
    day: { costUsd: num(row.dayCostUsd), priceUsd: num(row.dayPriceEur), credits: num(row.dayCredits), events: num(row.dayEvents) },
    month: {
      costUsd: num(row.monthCostUsd),
      priceUsd: num(row.monthPriceEur),
      credits: num(row.monthCredits),
      events: num(row.monthEvents),
    },
  }
}

const sumWindows = (windows: SpendWindow[]): SpendWindow =>
  windows.reduce(
    (total, w) => ({
      costUsd: total.costUsd + w.costUsd,
      priceUsd: total.priceUsd + w.priceUsd,
      credits: total.credits + w.credits,
      events: total.events + w.events,
    }),
    EMPTY_WINDOW,
  )

export interface ModelSpend {
  model: string
  day: SpendWindow
  month: SpendWindow
}

export interface SpendSummary {
  day: SpendWindow
  month: SpendWindow
  perModel: ModelSpend[]
}

/**
 * Windowed spend with per-model breakdown, org-wide by default or narrowed to
 * one member/project. One month-window ledger aggregation; the day slice
 * reuses it via FILTER. (Admin views only — enforcement uses sumRollupTotals.)
 */
export async function aggregateSpendSummary(
  organizationId: string,
  filter: { userId?: string; projectId?: string } = {},
): Promise<SpendSummary> {
  const db = getDb()
  const monthStart = utcMonthStart()
  // Raw `sql` fragments bypass drizzle's column-type mapping, and the
  // postgres-js driver rejects Date instances for inferred parameters — pass
  // ISO strings there (the typed gte() below handles the Date itself).
  const dayStartIso = utcDayStart().toISOString()

  const conditions = [eq(llmUsageEvents.organizationId, organizationId), gte(llmUsageEvents.createdAt, monthStart)]
  if (filter.userId) conditions.push(eq(llmUsageEvents.userId, filter.userId))
  if (filter.projectId) conditions.push(eq(llmUsageEvents.projectId, filter.projectId))

  const modelColumn = sql`coalesce(${llmUsageEvents.model}, 'unknown')`
  const rows = await db
    .select({ model: sql<string>`${modelColumn}`, ...windowColumns(dayStartIso) })
    .from(llmUsageEvents)
    .where(and(...conditions))
    .groupBy(modelColumn)

  const perModel: ModelSpend[] = rows
    .map((row) => ({ model: row.model, ...toWindows(row) }))
    .sort((a, b) => b.month.credits - a.month.credits)

  return {
    day: sumWindows(perModel.map((m) => m.day)),
    month: sumWindows(perModel.map((m) => m.month)),
    perModel,
  }
}

export interface MemberSpend {
  userId: string
  day: SpendWindow
  month: SpendWindow
}

/**
 * Windowed spend per member (admin view — the member usage table).
 * Events without a user id (anonymous mode) are excluded.
 */
export async function aggregateSpendByMember(organizationId: string): Promise<MemberSpend[]> {
  const db = getDb()
  const dayStartIso = utcDayStart().toISOString()
  const monthStart = utcMonthStart()

  const rows = await db
    .select({ userId: llmUsageEvents.userId, ...windowColumns(dayStartIso) })
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
    .map((row) => ({ userId: row.userId as string, ...toWindows(row) }))
    .sort((a, b) => b.month.credits - a.month.credits)
}

export interface OrganizationSpend {
  organizationId: string
  day: SpendWindow
  month: SpendWindow
}

/**
 * Windowed spend per organization across the WHOLE platform (platform-tier
 * dashboards only — the service enforces `platform:usage:view`, ADR-0016).
 */
export async function aggregateSpendAcrossOrganizations(): Promise<OrganizationSpend[]> {
  const db = getDb()
  const dayStartIso = utcDayStart().toISOString()
  const monthStart = utcMonthStart()

  const rows = await db
    .select({ organizationId: llmUsageEvents.organizationId, ...windowColumns(dayStartIso) })
    .from(llmUsageEvents)
    .where(gte(llmUsageEvents.createdAt, monthStart))
    .groupBy(llmUsageEvents.organizationId)

  return rows
    .map((row) => ({ organizationId: row.organizationId, ...toWindows(row) }))
    .sort((a, b) => b.month.priceUsd - a.month.priceUsd)
}

export interface DailySpendRow extends SpendWindow {
  /** UTC day, `YYYY-MM-DD`. */
  day: string
}

/** Daily spend rows since `start` (sparse — the service zero-fills the series). */
export async function aggregateDailySpend(options: {
  organizationId?: string
  start: Date
}): Promise<DailySpendRow[]> {
  const db = getDb()
  const conditions = [gte(llmUsageEvents.createdAt, options.start)]
  if (options.organizationId) {
    conditions.push(eq(llmUsageEvents.organizationId, options.organizationId))
  }
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${llmUsageEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      costUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}), 0)`,
      priceUsd: sql<string>`coalesce(sum(${llmUsageEvents.priceUsd}), 0)`,
      credits: sql<string>`coalesce(sum(${llmUsageEvents.credits}), 0)`,
      events: sql<string>`count(*)`,
    })
    .from(llmUsageEvents)
    .where(and(...conditions))
    .groupBy(sql`1`)

  return rows.map((row) => ({
    day: row.day,
    costUsd: num(row.costUsd),
    priceUsd: num(row.priceUsd),
    credits: num(row.credits),
    events: num(row.events),
  }))
}
