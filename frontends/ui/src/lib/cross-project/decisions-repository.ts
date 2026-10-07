/**
 * The decisions other projects recorded, for the cross-project search
 * (docs/roadmap/office-experience.md, „Entscheidungen"): the active `decision`
 * and `constraint` items of their project memory, the experience the project
 * itself wrote down while it ran (`remember`, reflection, a person in the
 * memory panel). Shorter and more comparable than a passage, and they say why.
 *
 * Matched with Postgres' German full-text search (stemming, stop words), with
 * OR semantics over the question's words so a natural question („Wie haben wir
 * das Stiegenhaus gelöst?") still matches, ranked by `ts_rank_cd`. Each
 * project's items are filtered by what the reader may see of that project's
 * memory, exactly as its own memory panel filters them (`memoryVisibleTo`):
 * restricted items only for a reader cleared for every folder they came from.
 */

import 'server-only'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projectMemory, type ProjectMemoryKind } from '@/lib/db/schema'
import { memoryVisibleTo } from '@/lib/projects/memory-service'

/** The memory kinds that are experience another project can use. */
export const DECISION_KINDS: readonly ProjectMemoryKind[] = ['decision', 'constraint']

/** How many decisions one search returns at most, across every project it searched. */
export const CROSS_PROJECT_MAX_DECISIONS = 6

/** A project to search, and the folders whose restricted memory the reader may see (empty: open memory only). */
export interface DecisionScope {
  projectId: string
  readableFolderIds: readonly string[]
}

export interface FoundDecision {
  projectId: string
  kind: ProjectMemoryKind
  content: string
  /** A person confirmed, pinned or wrote it: not only the agent's reading. */
  confirmed: boolean
  updatedAt: Date
  /** The restricted folders it came from, for the hand-out record; null for open memory. */
  restrictedFolderIds: string[] | null
}

/**
 * The question's words as a German OR query: `plainto_tsquery` stems and drops
 * stop words, and its AND becomes OR so one shared subject is enough to match.
 */
function anyWordOf(question: string) {
  return sql`replace(plainto_tsquery('german', ${question})::text, '&', '|')::tsquery`
}

/** The decisions of these projects that match the question, best first; none for an empty scope or question. */
export async function searchProjectDecisions(
  organizationId: string,
  scopes: readonly DecisionScope[],
  question: string,
  limit: number = CROSS_PROJECT_MAX_DECISIONS
): Promise<FoundDecision[]> {
  if (scopes.length === 0 || !question.trim()) return []
  const query = anyWordOf(question)
  const document = sql`to_tsvector('german', ${projectMemory.content})`
  const visible = or(
    ...scopes.map((scope) => and(eq(projectMemory.projectId, scope.projectId), memoryVisibleTo(scope.readableFolderIds)))
  )
  const rows = await getDb()
    .select({
      projectId: projectMemory.projectId,
      kind: projectMemory.kind,
      content: projectMemory.content,
      verification: projectMemory.verification,
      provenanceType: projectMemory.provenanceType,
      pinned: projectMemory.pinned,
      updatedAt: projectMemory.updatedAt,
      restrictedFolderIds: projectMemory.restrictedFolderIds,
      rank: sql<number>`ts_rank_cd(${document}, ${query})`,
    })
    .from(projectMemory)
    .where(
      and(
        eq(projectMemory.organizationId, organizationId),
        eq(projectMemory.scope, 'project'),
        eq(projectMemory.status, 'active'),
        inArray(projectMemory.kind, [...DECISION_KINDS]),
        visible,
        sql`${document} @@ ${query}`
      )
    )
    .orderBy(desc(sql`ts_rank_cd(${document}, ${query})`), desc(projectMemory.updatedAt))
    .limit(limit)
  // Raw values are not runtime-validated: coerced at the boundary.
  return rows.map((row) => ({
    projectId: String(row.projectId),
    kind: row.kind,
    content: row.content,
    confirmed: row.pinned || row.verification === 'user_confirmed' || row.provenanceType === 'user',
    updatedAt: new Date(row.updatedAt),
    restrictedFolderIds: row.restrictedFolderIds && row.restrictedFolderIds.length > 0 ? [...row.restrictedFolderIds] : null,
  }))
}
