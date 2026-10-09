/**
 * The reads behind the quality scope bar's pickers: which organizations had
 * any quality activity in a date range, and which projects those organizations
 * have.
 *
 * Cross-tenant on purpose (the platform owner picks among tenants), so only
 * reachable through `getQualityScopeOptions`, behind `platformApiRoute`'s
 * `platform:organizations:view` gate and its platform bypass. Every list is
 * bounded and each read is one statement.
 */

import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { executeRows } from '@/lib/db/execute-rows'

/** Most organizations the picker lists. Ordered by activity, so a cut drops the quietest. */
export const SCOPE_ORGANIZATION_LIMIT = 500

/** Most projects the picker lists for the chosen organizations. */
export const SCOPE_PROJECT_LIMIT = 200

function list(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )
}

/**
 * Organizations with any quality activity in `[start, endExclusive)`: a vote,
 * a citation check or a profiled span. The three tables are the three views on
 * the page, so an organization that appears in any of them can be picked.
 * Each half reads its own `(organization_id, created_at)` index; the union
 * dedupes and the busiest come first.
 */
export async function listActiveOrganizationIds(
  start: Date,
  endExclusive: Date,
  limit: number = SCOPE_ORGANIZATION_LIMIT,
): Promise<{ ids: string[]; truncated: boolean }> {
  const from = start.toISOString()
  const until = endExclusive.toISOString()
  const bounded = Math.max(0, Math.min(limit, SCOPE_ORGANIZATION_LIMIT))
  const db = getDb()
  const rows = executeRows(
    await db.execute(sql`
      select organization_id, sum(n) as activity
      from (
        select organization_id, count(*) as n from answer_feedback
        where created_at >= ${from}::timestamptz and created_at < ${until}::timestamptz
        group by organization_id
        union all
        select organization_id, count(*) from citation_events
        where organization_id is not null
          and created_at >= ${from}::timestamptz and created_at < ${until}::timestamptz
        group by organization_id
        union all
        select organization_id, count(*) from agent_profiler_spans
        where organization_id is not null
          and created_at >= ${from}::timestamptz and created_at < ${until}::timestamptz
        group by organization_id
      ) activity
      group by organization_id
      order by activity desc, organization_id
      limit ${bounded + 1}
    `),
  )
  const ids = rows.map((row) => String(row.organization_id))
  return { ids: ids.slice(0, bounded), truncated: ids.length > bounded }
}

export interface ScopeProjectRow {
  id: string
  name: string
  organizationId: string
}

/**
 * The projects of the chosen organizations, by name, plus any project id the
 * request already names (a deleted one keeps its name in the chip). At most
 * `SCOPE_PROJECT_LIMIT` + the named ones.
 */
export async function listScopeProjects(
  organizationIds: readonly string[],
  selectedProjectIds: readonly string[],
): Promise<{ projects: ScopeProjectRow[]; truncated: boolean }> {
  if (organizationIds.length === 0 && selectedProjectIds.length === 0) return { projects: [], truncated: false }
  const db = getDb()
  const listed = organizationIds.length
    ? executeRows(
        await db.execute(sql`
          select id, name, organization_id from projects
          where organization_id in (${list(organizationIds)})
            and deleted_at is null
          order by lower(name), id
          limit ${SCOPE_PROJECT_LIMIT + 1}
        `),
      )
    : []
  const named = selectedProjectIds.length
    ? executeRows(
        await db.execute(sql`
          select id, name, organization_id from projects
          where id in (${list(selectedProjectIds)})
          limit ${selectedProjectIds.length}
        `),
      )
    : []
  const truncated = listed.length > SCOPE_PROJECT_LIMIT
  const seen = new Set<string>()
  const projects: ScopeProjectRow[] = []
  for (const row of [...listed.slice(0, SCOPE_PROJECT_LIMIT), ...named]) {
    const id = String(row.id)
    if (seen.has(id)) continue
    seen.add(id)
    projects.push({ id, name: String(row.name), organizationId: String(row.organization_id) })
  }
  return { projects, truncated }
}
