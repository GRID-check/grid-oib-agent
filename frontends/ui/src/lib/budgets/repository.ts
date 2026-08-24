/**
 * Budgets repository (ADR-0017): the ONLY module that queries the DB for the
 * budgets domain. Raw data access and row shaping only — validation,
 * authorization, currency conversion, and enforcement semantics live in
 * `./service`.
 *
 * The ledger (`llm_usage_events`) is append-only; the daily rollup
 * (`llm_usage_rollups`, ADR-0019) is incremented in the SAME transaction as
 * every ledger insert, so enforcement reads (`sumRollupTotals`) are exact.
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
        currency: 'EUR',
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

interface RollupIncrement {
  organizationId: string
  day: string
  userId: string
  projectId: string
  costUsd: number
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
      events: 0,
    }
    entry.costUsd += Number.parseFloat(String(event.costUsd ?? '0')) || 0
    entry.events += 1
    byKey.set(key, entry)
  }
  return [...byKey.values()]
}

export async function insertUsageEventsWithRollups(events: NewLlmUsageEvent[]): Promise<number> {
  if (events.length === 0) return 0
  const db = getDb()
  return db.transaction(async (tx) => {
    const inserted = await tx.insert(llmUsageEvents).values(events).returning({ id: llmUsageEvents.id })

    // Same transaction as the ledger insert, so the rollup is exact.
    for (const increment of buildRollupIncrements(events)) {
      await tx
        .insert(llmUsageRollups)
        .values({
          organizationId: increment.organizationId,
          day: increment.day,
          userId: increment.userId,
          projectId: increment.projectId,
          costUsd: increment.costUsd.toFixed(8),
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
            costUsd: sql`${llmUsageRollups.costUsd} + ${increment.costUsd.toFixed(8)}`,
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

export interface SpendTotals {
  dayUsd: number
  monthUsd: number
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

  const [row] = await db
    .select({
      monthUsd: sql<string>`coalesce(sum(${llmUsageRollups.costUsd}), 0)`,
      dayUsd: sql<string>`coalesce(sum(${llmUsageRollups.costUsd}) filter (where ${llmUsageRollups.day} = ${dayStr}), 0)`,
    })
    .from(llmUsageRollups)
    .where(and(...conditions))

  return {
    dayUsd: Number.parseFloat(row?.dayUsd ?? '0') || 0,
    monthUsd: Number.parseFloat(row?.monthUsd ?? '0') || 0,
  }
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
 * Windowed spend with per-model breakdown, org-wide by default or narrowed to
 * one member/project. One month-window ledger aggregation; the day slice
 * reuses it via FILTER. (Admin views only — enforcement uses sumRollupTotals.)
 */
export async function aggregateSpendSummary(
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
export async function aggregateSpendByMember(organizationId: string): Promise<MemberSpend[]> {
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
 * dashboards only — the service enforces `platform:usage:view`, ADR-0016).
 */
export async function aggregateSpendAcrossOrganizations(): Promise<OrganizationSpend[]> {
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

export interface DailySpendRow {
  /** UTC day, `YYYY-MM-DD`. */
  day: string
  usd: number
  events: number
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
      usd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}), 0)`,
      events: sql<string>`count(*)`,
    })
    .from(llmUsageEvents)
    .where(and(...conditions))
    .groupBy(sql`1`)

  return rows.map((row) => ({
    day: row.day,
    usd: Number.parseFloat(row.usd) || 0,
    events: Number.parseInt(row.events, 10) || 0,
  }))
}
