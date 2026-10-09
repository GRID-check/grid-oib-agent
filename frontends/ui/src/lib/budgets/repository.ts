/**
 * Budgets repository (ADR-0017): the ONLY module that queries the DB for the
 * budgets domain. Raw data access and row shaping only — validation,
 * authorization, pricing, and enforcement semantics live in `./service`.
 *
 * The ledger (`llm_usage_events`) is append-only; the daily rollup
 * (`llm_usage_rollups`, ADR-0019) is incremented in the SAME transaction as
 * every ledger insert, so enforcement reads (`sumRollupTotals`) are exact.
 *
 * Every aggregate carries the money columns side by side — `costUsd` (what
 * OpenRouter charged, of which `ownKeyCostUsd` was the tenant's own bill),
 * `priceUsd` (what the tenant is charged), `credits` (the platform-billed
 * tenant's unit) and `tokens` (the own-key tenant's unit) — and the SERVICE
 * decides which of them a caller may see (ADR-0053: cost never reaches a
 * tenant).
 */

import 'server-only'
import { and, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  budgetPolicies,
  llmUsageEvents,
  llmUsageRollups,
  UNBILLED_USAGE_ACTIVITIES,
  type BudgetPolicy,
  type BudgetScope,
  type BudgetUnit,
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

/**
 * The active policy for a subject IN THE GIVEN UNIT. A policy in the other
 * unit is not this organization's limit today (it belongs to the key mode the
 * organization is not in), so it is invisible here rather than converted.
 */
export async function findActivePolicy(
  organizationId: string,
  scope: BudgetScope,
  subjectId: string | null,
  unit: BudgetUnit,
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
        eq(budgetPolicies.currency, unit),
      ),
    )
    .limit(1)
  return row ?? null
}

/** All active member/project policies of an org in one unit (for the settings UI). */
export async function listActivePolicies(organizationId: string, unit: BudgetUnit): Promise<BudgetPolicy[]> {
  const db = getDb()
  return db
    .select()
    .from(budgetPolicies)
    .where(
      and(
        eq(budgetPolicies.organizationId, organizationId),
        eq(budgetPolicies.status, 'active'),
        eq(budgetPolicies.currency, unit),
      ),
    )
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
 * Supersede idiom: mark the active row of the same unit (if any) superseded
 * and insert the replacement in one transaction, so every limit change stays
 * auditable. Limits are in `unit` — credits or tokens (ADR-0053).
 */
export async function insertPolicySuperseding(values: {
  organizationId: string
  scope: BudgetScope
  subjectId: string | null
  unit: BudgetUnit
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
          eq(budgetPolicies.currency, values.unit),
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
        currency: values.unit,
        status: 'active',
        supersedesId: previous?.id ?? null,
        createdBy: values.createdBy,
        note: values.note,
      })
      .returning()
    return inserted
  })
}

/** Mark the active scoped policy of one unit superseded without replacement. */
export async function supersedeActivePolicy(
  organizationId: string,
  scope: 'member' | 'project',
  subjectId: string,
  unit: BudgetUnit,
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
        eq(budgetPolicies.currency, unit),
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
  ownKeyCostUsd: number
  priceUsd: number
  credits: number
  tokens: number
  events: number
}

/**
 * The rollup increments a batch adds. An unbilled activity (voice dictation)
 * adds none: the rollup is what every budget reads, and a member is never
 * blocked by spend they are not billed for. Its ledger row still carries the
 * real cost for the platform views, which read the ledger.
 */
export function buildRollupIncrements(events: NewLlmUsageEvent[]): RollupIncrement[] {
  const byKey = new Map<string, RollupIncrement>()
  for (const event of events) {
    if (event.activity && UNBILLED_USAGE_ACTIVITIES.has(event.activity)) continue
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
      ownKeyCostUsd: 0,
      priceUsd: 0,
      credits: 0,
      tokens: 0,
      events: 0,
    }
    entry.costUsd += num(event.costUsd)
    if (event.isByok === true) entry.ownKeyCostUsd += num(event.costUsd)
    entry.priceUsd += num(event.priceUsd)
    entry.credits += num(event.credits)
    entry.tokens += event.totalTokens ?? 0
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
      const ownKeyCostUsd = increment.ownKeyCostUsd.toFixed(8)
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
          ownKeyCostUsd,
          priceUsd,
          credits,
          tokens: increment.tokens,
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
            ownKeyCostUsd: sql`${llmUsageRollups.ownKeyCostUsd} + ${ownKeyCostUsd}`,
            priceUsd: sql`${llmUsageRollups.priceUsd} + ${priceUsd}`,
            credits: sql`${llmUsageRollups.credits} + ${credits}`,
            tokens: sql`${llmUsageRollups.tokens} + ${increment.tokens}`,
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

/** One window's money in every unit, plus how many generations made it. */
export interface SpendWindow {
  /** USD as OpenRouter charged it, whoever's key it was. */
  costUsd: number
  /** The share of `costUsd` that was the tenant's own provider bill (`is_byok`). */
  ownKeyCostUsd: number
  priceUsd: number
  credits: number
  tokens: number
  events: number
  /**
   * What document ingestion cost the PLATFORM in this window: `activity =
   * 'ingest'` rows not on a tenant's own key (migration 0101). Present only
   * where the window was summed from the ledger itself; the rollup the
   * budgets read does not know which spend was ingestion.
   */
  ingestCostUsd?: number
  /**
   * What voice dictation cost the PLATFORM in this window: `activity =
   * 'dictation'` rows not on a tenant's own key (migration 0107). Ledger-summed
   * windows only, like `ingestCostUsd`; dictation never reaches the rollup.
   */
  dictationCostUsd?: number
}

export const EMPTY_SPEND_WINDOW: SpendWindow = {
  costUsd: 0,
  ownKeyCostUsd: 0,
  priceUsd: 0,
  credits: 0,
  tokens: 0,
  events: 0,
  ingestCostUsd: 0,
  dictationCostUsd: 0,
}
const EMPTY_WINDOW = EMPTY_SPEND_WINDOW

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
      monthOwnKeyCostUsd: sql<string>`coalesce(sum(${llmUsageRollups.ownKeyCostUsd}), 0)`,
      monthPriceUsd: sql<string>`coalesce(sum(${llmUsageRollups.priceUsd}), 0)`,
      monthCredits: sql<string>`coalesce(sum(${llmUsageRollups.credits}), 0)`,
      monthTokens: sql<string>`coalesce(sum(${llmUsageRollups.tokens}), 0)`,
      monthEvents: sql<string>`coalesce(sum(${llmUsageRollups.events}), 0)`,
      dayCostUsd: sql<string>`coalesce(sum(${llmUsageRollups.costUsd}) filter (where ${isToday}), 0)`,
      dayOwnKeyCostUsd: sql<string>`coalesce(sum(${llmUsageRollups.ownKeyCostUsd}) filter (where ${isToday}), 0)`,
      dayPriceUsd: sql<string>`coalesce(sum(${llmUsageRollups.priceUsd}) filter (where ${isToday}), 0)`,
      dayCredits: sql<string>`coalesce(sum(${llmUsageRollups.credits}) filter (where ${isToday}), 0)`,
      dayTokens: sql<string>`coalesce(sum(${llmUsageRollups.tokens}) filter (where ${isToday}), 0)`,
      dayEvents: sql<string>`coalesce(sum(${llmUsageRollups.events}) filter (where ${isToday}), 0)`,
    })
    .from(llmUsageRollups)
    .where(and(...conditions))

  if (!row) return { day: EMPTY_WINDOW, month: EMPTY_WINDOW }
  return toWindows(row)
}

/** The month-window ledger aggregation every breakdown below shares. */
function windowColumns(dayStartIso: string) {
  const isToday = sql`${llmUsageEvents.createdAt} >= ${dayStartIso}`
  const ownKey = sql`${llmUsageEvents.isByok} = true`
  const platformIngest = sql`${llmUsageEvents.activity} = 'ingest' and ${llmUsageEvents.isByok} is not true`
  const platformDictation = sql`${llmUsageEvents.activity} = 'dictation' and ${llmUsageEvents.isByok} is not true`
  return {
    monthIngestCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${platformIngest}), 0)`,
    dayIngestCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${isToday} and ${platformIngest}), 0)`,
    monthDictationCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${platformDictation}), 0)`,
    dayDictationCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${isToday} and ${platformDictation}), 0)`,
    monthCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}), 0)`,
    monthOwnKeyCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${ownKey}), 0)`,
    monthPriceUsd: sql<string>`coalesce(sum(${llmUsageEvents.priceUsd}), 0)`,
    monthCredits: sql<string>`coalesce(sum(${llmUsageEvents.credits}), 0)`,
    monthTokens: sql<string>`coalesce(sum(${llmUsageEvents.totalTokens}), 0)`,
    monthEvents: sql<string>`count(*)`,
    dayCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${isToday}), 0)`,
    dayOwnKeyCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${isToday} and ${ownKey}), 0)`,
    dayPriceUsd: sql<string>`coalesce(sum(${llmUsageEvents.priceUsd}) filter (where ${isToday}), 0)`,
    dayCredits: sql<string>`coalesce(sum(${llmUsageEvents.credits}) filter (where ${isToday}), 0)`,
    dayTokens: sql<string>`coalesce(sum(${llmUsageEvents.totalTokens}) filter (where ${isToday}), 0)`,
    dayEvents: sql<string>`count(*) filter (where ${isToday})`,
  }
}

interface WindowRow {
  monthCostUsd: string
  monthOwnKeyCostUsd: string
  monthPriceUsd: string
  monthCredits: string
  monthTokens: string
  monthEvents: string
  dayCostUsd: string
  dayOwnKeyCostUsd: string
  dayPriceUsd: string
  dayCredits: string
  dayTokens: string
  dayEvents: string
  /** Only the ledger-summed windows carry these (`windowColumns`); the rollup does not. */
  monthIngestCostUsd?: string
  dayIngestCostUsd?: string
  monthDictationCostUsd?: string
  dayDictationCostUsd?: string
}

/** Coerce at the repository boundary: raw `sql<T>` columns arrive as strings. */
function toWindows(row: WindowRow): { day: SpendWindow; month: SpendWindow } {
  return {
    day: {
      costUsd: num(row.dayCostUsd),
      ownKeyCostUsd: num(row.dayOwnKeyCostUsd),
      priceUsd: num(row.dayPriceUsd),
      credits: num(row.dayCredits),
      tokens: num(row.dayTokens),
      events: num(row.dayEvents),
      ...(row.dayIngestCostUsd !== undefined ? { ingestCostUsd: num(row.dayIngestCostUsd) } : {}),
      ...(row.dayDictationCostUsd !== undefined ? { dictationCostUsd: num(row.dayDictationCostUsd) } : {}),
    },
    month: {
      costUsd: num(row.monthCostUsd),
      ownKeyCostUsd: num(row.monthOwnKeyCostUsd),
      priceUsd: num(row.monthPriceUsd),
      credits: num(row.monthCredits),
      tokens: num(row.monthTokens),
      events: num(row.monthEvents),
      ...(row.monthIngestCostUsd !== undefined ? { ingestCostUsd: num(row.monthIngestCostUsd) } : {}),
      ...(row.monthDictationCostUsd !== undefined ? { dictationCostUsd: num(row.monthDictationCostUsd) } : {}),
    },
  }
}

export const sumSpendWindows = (windows: SpendWindow[]): SpendWindow =>
  windows.reduce(
    (total, w) => ({
      costUsd: total.costUsd + w.costUsd,
      ownKeyCostUsd: total.ownKeyCostUsd + w.ownKeyCostUsd,
      priceUsd: total.priceUsd + w.priceUsd,
      credits: total.credits + w.credits,
      tokens: total.tokens + w.tokens,
      events: total.events + w.events,
      ingestCostUsd: (total.ingestCostUsd ?? 0) + (w.ingestCostUsd ?? 0),
      dictationCostUsd: (total.dictationCostUsd ?? 0) + (w.dictationCostUsd ?? 0),
    }),
    EMPTY_WINDOW,
  )
const sumWindows = sumSpendWindows

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
    // Tokens order every model regardless of unit; credits are 0 on own keys.
    .sort((a, b) => b.month.tokens - a.month.tokens)

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
    .sort((a, b) => b.month.tokens - a.month.tokens)
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
      ownKeyCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${llmUsageEvents.isByok} = true), 0)`,
      priceUsd: sql<string>`coalesce(sum(${llmUsageEvents.priceUsd}), 0)`,
      credits: sql<string>`coalesce(sum(${llmUsageEvents.credits}), 0)`,
      tokens: sql<string>`coalesce(sum(${llmUsageEvents.totalTokens}), 0)`,
      events: sql<string>`count(*)`,
      ingestCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${llmUsageEvents.activity} = 'ingest' and ${llmUsageEvents.isByok} is not true), 0)`,
      dictationCostUsd: sql<string>`coalesce(sum(${llmUsageEvents.costUsd}) filter (where ${llmUsageEvents.activity} = 'dictation' and ${llmUsageEvents.isByok} is not true), 0)`,
    })
    .from(llmUsageEvents)
    .where(and(...conditions))
    .groupBy(sql`1`)

  return rows.map((row) => ({
    day: row.day,
    costUsd: num(row.costUsd),
    ownKeyCostUsd: num(row.ownKeyCostUsd),
    priceUsd: num(row.priceUsd),
    credits: num(row.credits),
    tokens: num(row.tokens),
    events: num(row.events),
    ingestCostUsd: num(row.ingestCostUsd),
    dictationCostUsd: num(row.dictationCostUsd),
  }))
}

/** What one chat answer cost, summed over the ledger rows stamped with its id (migration 0098). */
export interface AnswerUsageRow {
  calls: number
  credits: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  totalTokens: number
}

/**
 * Sum the frozen `credits` and the tokens of one answer's generations. The
 * credits are the ones written at record time (ADR-0053), so the answer shows
 * what was billed, not a re-pricing. `null` when no row names the answer
 * (an answer from before 0098, or a turn that made no model call).
 */
export async function sumAnswerUsage(
  organizationId: string,
  conversationId: string,
  messageId: string,
): Promise<AnswerUsageRow | null> {
  const db = getDb()
  const [row] = await db
    .select({
      calls: sql<string>`count(*)`,
      credits: sql<string>`coalesce(sum(${llmUsageEvents.credits}), 0)`,
      promptTokens: sql<string>`coalesce(sum(${llmUsageEvents.promptTokens}), 0)`,
      completionTokens: sql<string>`coalesce(sum(${llmUsageEvents.completionTokens}), 0)`,
      reasoningTokens: sql<string>`coalesce(sum(${llmUsageEvents.reasoningTokens}), 0)`,
      totalTokens: sql<string>`coalesce(sum(${llmUsageEvents.totalTokens}), 0)`,
    })
    .from(llmUsageEvents)
    .where(
      and(
        eq(llmUsageEvents.organizationId, organizationId),
        eq(llmUsageEvents.conversationId, conversationId),
        eq(llmUsageEvents.messageId, messageId),
      ),
    )
  const calls = Number.parseInt(String(row?.calls ?? '0'), 10) || 0
  if (calls === 0) return null
  const asNumber = (value: unknown): number => Number.parseFloat(String(value ?? '0')) || 0
  return {
    calls,
    credits: asNumber(row?.credits),
    promptTokens: asNumber(row?.promptTokens),
    completionTokens: asNumber(row?.completionTokens),
    reasoningTokens: asNumber(row?.reasoningTokens),
    totalTokens: asNumber(row?.totalTokens),
  }
}
