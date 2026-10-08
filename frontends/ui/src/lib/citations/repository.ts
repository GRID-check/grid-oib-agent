/**
 * Citation-health repository: the ONLY module that queries the DB for the
 * citation-quality domain. Raw data access and row shaping only —
 * authorization lives in the routes (platform-owner gate, mirrors
 * `api/platform/overview/route.ts`); rollup shaping lives in `./service`.
 *
 * Every query is windowed on `created_at >= start`, and every aggregate keys
 * off the invariant the emitter guarantees: one `turn_verified` row per
 * observed research turn, plus one row per defect on that turn.
 */

import 'server-only'
import { and, desc, gte, ne, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  CITATION_BASELINE_KIND,
  CITATION_PRECISION_KIND,
  citationEvents,
  type CitationEvent,
  type CitationEventKind,
  type NewCitationEvent,
} from '@/lib/db/schema'

/**
 * A window bound for a RAW `db.execute(sql\`…\`)` query.
 *
 * The drizzle select-builder knows `createdAt` is a timestamptz and encodes a
 * `Date` for it. A raw fragment carries no column type, so postgres-js receives
 * an unencodable `Date` and the query dies at bind time with
 * `The "string" argument must be of type string … Received an instance of Date`.
 * Passing an ISO string with an explicit cast is the portable fix — every raw
 * query below MUST use this, never a bare `Date`.
 */
function windowStart(start: Date): string {
  return start.toISOString()
}

/**
 * Insert one turn's batch. `onConflictDoNothing` on (turn_id, kind) makes a
 * retried flush idempotent — the backend posts best-effort, so the same batch
 * can legitimately arrive twice.
 */
export async function insertCitationEvents(events: NewCitationEvent[]): Promise<number> {
  if (events.length === 0) return 0
  const db = getDb()
  const inserted = await db
    .insert(citationEvents)
    .values(events)
    .onConflictDoNothing({ target: [citationEvents.turnId, citationEvents.kind] })
    .returning({ id: citationEvents.id })
  return inserted.length
}

export interface KindTotalRow {
  kind: CitationEventKind
  /** Turns carrying this kind (one row per turn per kind, so also the row count). */
  turns: number
  /** Summed `count` — individual citations dropped, quotes unverified, … */
  items: number
}

/** Rows per kind in the window — the headline mix. */
export async function aggregateByKind(start: Date): Promise<KindTotalRow[]> {
  const db = getDb()
  const rows = await db
    .select({
      kind: citationEvents.kind,
      turns: sql<string>`count(distinct ${citationEvents.turnId})`,
      items: sql<string>`coalesce(sum(${citationEvents.count}), 0)`,
    })
    .from(citationEvents)
    .where(gte(citationEvents.createdAt, start))
    .groupBy(citationEvents.kind)

  return rows.map((row) => ({
    kind: row.kind as CitationEventKind,
    turns: Number(row.turns),
    items: Number(row.items),
  }))
}

/**
 * Distinct turns in the window, across every kind.
 *
 * NOT the count of `turn_verified` rows: a turn that failed with
 * `registry_empty` never reaches verification and so has no baseline row, yet
 * it is unquestionably an observed turn. Counting distinct turn ids keeps
 * `defectTurns <= turns` and the clean rate honest.
 */
export async function countObservedTurns(start: Date): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ turns: sql<string>`count(distinct ${citationEvents.turnId})` })
    .from(citationEvents)
    .where(gte(citationEvents.createdAt, start))
  return Number(row?.turns ?? 0)
}

/** Distinct turns in the window that carry at least one DEFECT row. */
export async function countDefectiveTurns(start: Date): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ turns: sql<string>`count(distinct ${citationEvents.turnId})` })
    .from(citationEvents)
    .where(
      and(
        gte(citationEvents.createdAt, start),
        ne(citationEvents.kind, CITATION_BASELINE_KIND),
        ne(citationEvents.kind, CITATION_PRECISION_KIND)
      )
    )
  return Number(row?.turns ?? 0)
}

export interface DailyTurnRow {
  day: string
  turns: number
  /** Distinct turns that day carrying at least one DEFECT row. */
  defectTurns: number
}

/**
 * Distinct turns per UTC day — the trend's denominator, same rule as above —
 * and, of those, the distinct turns that carried a defect.
 *
 * The defect count has to come from here: per-kind daily turn counts are not
 * additive (one turn often carries several defects), so nothing derived from
 * `aggregateDailyByKind` can say how many turns were bad, only bound it.
 */
export async function aggregateDailyTurns(start: Date): Promise<DailyTurnRow[]> {
  const db = getDb()
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${citationEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      turns: sql<string>`count(distinct ${citationEvents.turnId})`,
      defectTurns: sql<string>`count(distinct ${citationEvents.turnId}) filter (where ${citationEvents.kind} <> ${CITATION_BASELINE_KIND} and ${citationEvents.kind} <> ${CITATION_PRECISION_KIND})`,
    })
    .from(citationEvents)
    .where(gte(citationEvents.createdAt, start))
    .groupBy(sql`date_trunc('day', ${citationEvents.createdAt} at time zone 'UTC')`)

  return rows.map((row) => ({
    day: row.day,
    turns: Number(row.turns),
    defectTurns: Number(row.defectTurns ?? 0),
  }))
}

export interface DailyKindRow {
  day: string
  kind: CitationEventKind
  turns: number
}

/** Per-UTC-day rows by kind — the trend chart's raw series (zero-filled in the service). */
export async function aggregateDailyByKind(start: Date): Promise<DailyKindRow[]> {
  const db = getDb()
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${citationEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      kind: citationEvents.kind,
      turns: sql<string>`count(distinct ${citationEvents.turnId})`,
    })
    .from(citationEvents)
    .where(gte(citationEvents.createdAt, start))
    .groupBy(
      sql`date_trunc('day', ${citationEvents.createdAt} at time zone 'UTC')`,
      citationEvents.kind
    )

  return rows.map((row) => ({
    day: row.day,
    kind: row.kind as CitationEventKind,
    turns: Number(row.turns),
  }))
}

export interface ReasonTotalRow {
  kind: CitationEventKind
  reason: string
  occurrences: number
}

/** Distinct reasons kept PER KIND; the emitter's taxonomy is far smaller. */
const REASONS_PER_KIND = 20

/**
 * Expand the `reasons` jsonb into (kind, reason, occurrences) — the "WHY did
 * verification drop it" breakdown. `jsonb_each_text` needs a lateral join, so
 * this one is raw SQL rather than the select builder.
 *
 * Ranked and bounded PER KIND, never across kinds: a global top-N let one
 * kind's reasons (`confidence_capped`) crowd another's (`citations_removed`)
 * out of the list, and the findings read their shares off this list.
 */
export async function aggregateReasons(start: Date): Promise<ReasonTotalRow[]> {
  const db = getDb()
  const rows = await db.execute<{ kind: string; reason: string; occurrences: string }>(sql`
    with per_reason as (
      select
        e.kind as kind,
        r.key as reason,
        coalesce(sum((r.value)::int), 0) as occurrences
      from ${citationEvents} e
      cross join lateral jsonb_each_text(e.reasons) r
      -- jsonb_each_text ERRORS on an array or scalar, so the type check must gate
      -- the lateral join, not merely filter its output.
      where e.created_at >= ${windowStart(start)}::timestamptz and jsonb_typeof(e.reasons) = 'object'
      group by e.kind, r.key
    ),
    ranked as (
      select kind, reason, occurrences,
        row_number() over (partition by kind order by occurrences desc, reason) as position
      from per_reason
    )
    select kind, reason, occurrences
    from ranked
    where position <= ${REASONS_PER_KIND}
    order by occurrences desc, kind, reason
  `)

  return Array.from(rows).map((row) => ({
    kind: row.kind as CitationEventKind,
    reason: row.reason,
    occurrences: Number(row.occurrences),
  }))
}

export type SourceMixDimension = 'origin' | 'lane' | 'tool'

export interface SourceMixRow {
  dimension: SourceMixDimension
  label: string
  turns: number
}

/** Labels kept PER DIMENSION, so a busy dimension cannot crowd out the others. */
const SOURCE_MIX_PER_DIMENSION = 12

const SOURCE_MIX_DIMENSIONS: readonly SourceMixDimension[] = ['origin', 'lane', 'tool']

/**
 * Which retrieval origins, lanes and tools were in play on turns that hit a
 * defect.
 *
 * The source mix lives on the `turn_verified` baseline row (one per turn), so
 * this joins those rows to the set of turns carrying at least one defect. It
 * answers the most actionable diagnostic question — "which lane keeps
 * producing output the verifier can't tie back to a source?" The emitter
 * writes `detail.origins`, `detail.lanes` and `detail.tools`
 * (`citation_events.build_turn_events`); all three are read here.
 */
export async function aggregateDefectiveSourceMix(start: Date): Promise<SourceMixRow[]> {
  const db = getDb()
  const rows = await db.execute<{ dimension: string; label: string; turns: string }>(sql`
    with defective as (
      select distinct turn_id
      from ${citationEvents}
      where created_at >= ${windowStart(start)}::timestamptz
        and kind <> ${CITATION_BASELINE_KIND}
        and kind <> ${CITATION_PRECISION_KIND}
    ),
    baseline as (
      select e.detail
      from ${citationEvents} e
      join defective d on d.turn_id = e.turn_id
      where e.created_at >= ${windowStart(start)}::timestamptz and e.kind = ${CITATION_BASELINE_KIND} and e.detail is not null
    ),
    labels as (
      select 'origin' as dimension, o.key as label
      from baseline, lateral jsonb_each_text(baseline.detail -> 'origins') o
      where jsonb_typeof(baseline.detail -> 'origins') = 'object'
      union all
      select 'lane' as dimension, l.key as label
      from baseline, lateral jsonb_each_text(baseline.detail -> 'lanes') l
      where jsonb_typeof(baseline.detail -> 'lanes') = 'object'
      union all
      select 'tool' as dimension, t.key as label
      from baseline, lateral jsonb_each_text(baseline.detail -> 'tools') t
      where jsonb_typeof(baseline.detail -> 'tools') = 'object'
    ),
    counted as (
      select dimension, label, count(*) as turns,
        row_number() over (partition by dimension order by count(*) desc, label) as position
      from labels
      group by dimension, label
    )
    select dimension, label, turns
    from counted
    where position <= ${SOURCE_MIX_PER_DIMENSION}
    order by turns desc, dimension, label
  `)

  return Array.from(rows).map((row) => ({
    dimension: SOURCE_MIX_DIMENSIONS.find((dimension) => dimension === row.dimension) ?? 'origin',
    label: row.label,
    turns: Number(row.turns),
  }))
}

/**
 * A bounded list together with the size of the whole set it was cut from.
 * `total` comes from `count(*) over ()`, which Postgres evaluates BEFORE the
 * limit, so it is exact even when `rows` is not the whole set.
 */
export interface BoundedRows<T> {
  rows: T[]
  total: number
}

export interface FailedTargetRow {
  target: string
  reason: string
  /** Distinct turns that cited this target and had it rejected. */
  turns: number
  /** Distinct organizations affected. */
  organizations: number
  lastSeenAt: Date
}

/**
 * How many distinct targets one snapshot reads. The dashboard shows far
 * fewer; the rest still feed the findings' totals, and `total` says how many
 * exist beyond this scan.
 */
export const FAILED_TARGET_SCAN_CAP = 1000

/**
 * Which specific sources the model cited but verification could not confirm,
 * grouped by target and ranked by how often it happened.
 *
 * This is the raw material for the "missing sources" list: a document key or
 * URL cited again and again but never present in retrieval is either absent
 * from the corpus (add it) or present but unretrievable (an indexing problem).
 * The service decides which by cross-checking the live corpus.
 */
export async function aggregateFailedTargets(start: Date): Promise<BoundedRows<FailedTargetRow>> {
  const db = getDb()
  const rows = await db.execute<{
    target: string
    reason: string
    turns: string
    organizations: string
    last_seen_at: string | Date
    total: string
  }>(sql`
    select
      t.target as target,
      -- The reason that actually recurs for this target; max() would pick
      -- the alphabetically last one, which is meaningless here.
      mode() within group (order by t.reason) as reason,
      count(distinct t.turn_id) as turns,
      count(distinct t.organization_id) as organizations,
      max(t.created_at) as last_seen_at,
      count(*) over () as total
    from (
      select
        e.turn_id,
        e.organization_id,
        e.created_at,
        item ->> 'target' as target,
        coalesce(item ->> 'reason', 'unverifiable') as reason
      from ${citationEvents} e
      cross join lateral jsonb_array_elements(e.detail -> 'targets') item
      where e.created_at >= ${windowStart(start)}::timestamptz
        and jsonb_typeof(e.detail -> 'targets') = 'array'
        and item ->> 'target' is not null
    ) t
    group by t.target
    order by turns desc, organizations desc, target
    limit ${FAILED_TARGET_SCAN_CAP}
  `)

  const list = Array.from(rows)
  return {
    total: Number(list[0]?.total ?? 0),
    rows: list.map((row) => ({
      target: row.target,
      reason: row.reason,
      turns: Number(row.turns),
      organizations: Number(row.organizations),
      lastSeenAt: new Date(row.last_seen_at),
    })),
  }
}

/**
 * Distinct turns on which ANY of `targets` was the cited source verification
 * rejected.
 *
 * Needed because per-target turn counts are NOT additive: three documents
 * rejected on the SAME turn are three rows of `aggregateFailedTargets`, each
 * with `turns: 1`. Summing them reports "3 turns" for a window that only ever
 * saw one — which is how a single bad turn came to read as a platform-wide
 * trend. The union has to come from the database.
 *
 * Targets are bound as individual parameters (never interpolated), and the
 * caller passes at most `FAILED_TARGET_SCAN_CAP` of them.
 */
export async function countTurnsForTargets(start: Date, targets: string[]): Promise<number> {
  if (targets.length === 0) return 0
  const db = getDb()
  const list = sql.join(
    targets.map((target) => sql`${target}`),
    sql`, `
  )
  const rows = await db.execute<{ turns: string }>(sql`
    select count(distinct t.turn_id) as turns
    from (
      select e.turn_id, item ->> 'target' as target
      from ${citationEvents} e
      cross join lateral jsonb_array_elements(e.detail -> 'targets') item
      where e.created_at >= ${windowStart(start)}::timestamptz
        and jsonb_typeof(e.detail -> 'targets') = 'array'
    ) t
    where t.target in (${list})
  `)
  return Number(Array.from(rows)[0]?.turns ?? 0)
}

export interface UnavailableToolRow {
  tool: string
  turns: number
}

const UNAVAILABLE_TOOL_LIMIT = 8

/**
 * Tools the backend reported as unavailable on turns that captured no source
 * at all (`registry_empty` detail). This is the single most actionable signal
 * in the ledger: it names the retrieval integration that is actually down.
 */
export async function aggregateUnavailableTools(
  start: Date
): Promise<BoundedRows<UnavailableToolRow>> {
  const db = getDb()
  const rows = await db.execute<{ tool: string; turns: string; total: string }>(sql`
    select tool, count(*) as turns, count(*) over () as total
    from (
      select jsonb_array_elements_text(e.detail -> 'unavailable_tools') as tool
      from ${citationEvents} e
      where e.created_at >= ${windowStart(start)}::timestamptz
        and e.kind = 'registry_empty'
        and jsonb_typeof(e.detail -> 'unavailable_tools') = 'array'
    ) tools
    group by tool
    order by turns desc, tool
    limit ${UNAVAILABLE_TOOL_LIMIT}
  `)

  const list = Array.from(rows)
  return {
    total: Number(list[0]?.total ?? 0),
    rows: list.map((row) => ({ tool: row.tool, turns: Number(row.turns) })),
  }
}

export interface OrganizationTotalRow {
  organizationId: string | null
  turns: number
  defectTurns: number
  errorTurns: number
}

/**
 * How many organizations one snapshot reads. Every one of them feeds the
 * outlier finding (an org outside the displayed top list can still be the
 * outlier); the dashboard shows fewer, and `total` is exact either way.
 */
export const ORGANIZATION_SCAN_CAP = 1000

/** Per-organization observed vs. defective turns — most defective turns first. */
export async function aggregateByOrganization(
  start: Date
): Promise<BoundedRows<OrganizationTotalRow>> {
  const db = getDb()
  const rows = await db.execute<{
    organization_id: string | null
    turns: string
    defect_turns: string
    error_turns: string
    total: string
  }>(sql`
    select
      organization_id,
      count(distinct turn_id) as turns,
      count(distinct turn_id) filter (
        where kind <> ${CITATION_BASELINE_KIND} and kind <> ${CITATION_PRECISION_KIND}
      ) as defect_turns,
      count(distinct turn_id) filter (where severity = 'error') as error_turns,
      count(*) over () as total
    from ${citationEvents}
    where created_at >= ${windowStart(start)}::timestamptz
    group by organization_id
    order by defect_turns desc, turns desc, organization_id
    limit ${ORGANIZATION_SCAN_CAP}
  `)

  const list = Array.from(rows)
  return {
    total: Number(list[0]?.total ?? 0),
    rows: list.map((row) => ({
      organizationId: row.organization_id,
      turns: Number(row.turns),
      defectTurns: Number(row.defect_turns),
      errorTurns: Number(row.error_turns),
    })),
  }
}

const RECENT_LIMIT = 25

/** The newest defect rows — the drill-down list ("show me the last failures"). */
export async function listRecentDefects(
  start: Date,
  limit = RECENT_LIMIT
): Promise<CitationEvent[]> {
  const db = getDb()
  return db
    .select()
    .from(citationEvents)
    .where(
      and(
        gte(citationEvents.createdAt, start),
        ne(citationEvents.kind, CITATION_BASELINE_KIND),
        ne(citationEvents.kind, CITATION_PRECISION_KIND)
      )
    )
    .orderBy(desc(citationEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), RECENT_LIMIT))
}

/** Hard ceiling on export rows; the service reports when it was reached. */
export const EXPORT_ROW_CAP = 5000

/**
 * Every event in the window, oldest first — the raw feed behind the
 * diagnostic export. Capped so a wide window cannot stream unbounded rows;
 * the service reports when the cap was hit rather than truncating silently.
 */
export async function listEventsForExport(
  start: Date,
  limit = EXPORT_ROW_CAP
): Promise<CitationEvent[]> {
  const db = getDb()
  return (
    db
      .select()
      .from(citationEvents)
      .where(gte(citationEvents.createdAt, start))
      .orderBy(citationEvents.createdAt)
      // One row over the cap, so the caller can tell "exactly full" from "truncated".
      .limit(Math.min(Math.max(limit, 1), EXPORT_ROW_CAP) + 1)
  )
}
