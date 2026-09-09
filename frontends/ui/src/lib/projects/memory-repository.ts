/**
 * Memory repository — the SQL behind reading `project_memory`.
 *
 * It exists because ADR-0055 gave the recall query a SECOND caller. The digest
 * (`buildProjectMemoryDigestReport`) and the `search_memory` tool
 * (`searchProjectMemory`) must agree on what is relevant and on what is in
 * scope, and two hand-written queries would agree only until the first one was
 * edited. One statement, two callers, so the tool cannot see a note the digest
 * cannot — nor the reverse, which is the failure that matters: a scope rule
 * that lives in two places is a scope rule that leaks in one of them.
 *
 * Boundaries, per `frontends/ui/AGENTS.md`: this module owns the statement and
 * the bound; the service owns ranking, capping and formatting. Raw `sql<T>`
 * results are coerced here, at the boundary, because `tsc` believes the
 * annotation and Postgres does not.
 */

import 'server-only'
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projectMemory } from '@/lib/db/schema'
import type {
  ProjectMemoryConfidence,
  ProjectMemoryKind,
  ProjectMemoryScope,
  ProjectMemoryVerification,
} from '@/lib/db/schema'
import { cosineSimilaritySql } from '@/lib/knowledge/embeddings'

/**
 * Candidates considered before ranking. Bounded like every list here; past
 * this the tail is by definition the least relevant (with a query vector) or
 * the least recently touched (without one).
 */
export const RECALL_CANDIDATE_LIMIT = 200

/** Who the read is for. A project id without an organization is anonymous mode. */
export interface MemoryScope {
  projectId?: string
  organizationId?: string
}

/**
 * The scope rule, in one place, for every read of this table.
 *
 * With a project: that project's notes PLUS the organization's. Without one:
 * organization-scoped notes ONLY. Never another project's, in either
 * direction — which is why the project branch is additionally pinned to the
 * organization whenever the caller knows it: a project id from another tenant
 * then matches nothing rather than matching its own row.
 *
 * Returns undefined when the caller named neither, which is not a scope but an
 * unbounded read; every caller must treat it as "nothing to read".
 */
export function memoryScopeCondition(scope: MemoryScope): SQL | undefined {
  const branches: (SQL | undefined)[] = []
  if (scope.projectId) {
    branches.push(
      scope.organizationId
        ? and(
            eq(projectMemory.projectId, scope.projectId),
            eq(projectMemory.organizationId, scope.organizationId)
          )
        : eq(projectMemory.projectId, scope.projectId)
    )
  }
  if (scope.organizationId) {
    branches.push(
      and(
        eq(projectMemory.scope, 'organization'),
        eq(projectMemory.organizationId, scope.organizationId),
        isNull(projectMemory.projectId)
      )
    )
  }
  if (branches.length === 0) return undefined
  return branches.length > 1 ? or(...branches) : branches[0]
}

/** One active note, with everything the recall scorer and the two callers need. */
export interface RecallCandidateRow {
  id: string
  scope: ProjectMemoryScope
  kind: ProjectMemoryKind
  content: string
  confidence: ProjectMemoryConfidence
  verification: ProjectMemoryVerification
  pinned: boolean
  salience: number
  lastReferencedAt: Date | null
  recallCount: number
  updatedAt: Date
  /** Cosine to the query vector, or null when this row has no comparable vector. */
  relevance: number | null
  /** Whether this row already carries a vector from the CURRENT embedder. */
  embeddedByCurrentModel: boolean
}

export interface RecallCandidates {
  rows: RecallCandidateRow[]
  /**
   * Active notes in scope, before ranking and before the candidate bound —
   * `count(*) over ()` on the same statement, so it costs no second query and
   * cannot disagree with the rows it describes.
   */
  total: number
}

/**
 * Active notes in scope, most relevant first when a query vector is supplied
 * and most recently updated first otherwise, bounded at
 * {@link RECALL_CANDIDATE_LIMIT}.
 *
 * The window is the ceiling on everything above it: ranking, capping and the
 * digest's disclosure all run over these rows. With a query the database ranks
 * by similarity first so a relevant OLD note is reachable; without one recency
 * is still the order, which is what every caller got before embeddings existed.
 */
export async function selectRecallCandidates(
  scope: MemoryScope,
  options: { queryVector?: number[] | null; fingerprint?: string | null } = {}
): Promise<RecallCandidates> {
  const scopeCondition = memoryScopeCondition(scope)
  if (!scopeCondition) return { rows: [], total: 0 }

  // Cosine is computed in SQL so vectors never cross the wire — a
  // 3072-dimension array per row would dominate this query's cost.
  const relevanceColumn = options.queryVector
    ? cosineSimilaritySql(projectMemory.embedding, options.queryVector)
    : sql<number | null>`null::double precision`

  const rows = await getDb()
    .select({
      id: projectMemory.id,
      scope: projectMemory.scope,
      kind: projectMemory.kind,
      content: projectMemory.content,
      confidence: projectMemory.confidence,
      verification: projectMemory.verification,
      pinned: projectMemory.pinned,
      salience: projectMemory.salience,
      lastReferencedAt: projectMemory.lastReferencedAt,
      recallCount: projectMemory.recallCount,
      updatedAt: projectMemory.updatedAt,
      relevance: relevanceColumn,
      // Only compare vectors from the model that produced them: a same-size
      // vector from another embedder is noise wearing the right shape.
      embeddingModel: projectMemory.embeddingModel,
      // Window functions run before LIMIT, so this is the count of everything
      // the WHERE matched — the honest denominator for "carried N of M".
      total: sql<number>`count(*) over ()`,
    })
    .from(projectMemory)
    .where(and(scopeCondition, eq(projectMemory.status, 'active')))
    .orderBy(
      ...(options.queryVector ? [sql`${relevanceColumn} desc nulls last`] : []),
      desc(projectMemory.updatedAt)
    )
    .limit(RECALL_CANDIDATE_LIMIT)

  const fingerprint = options.fingerprint ?? null
  const candidates = rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    content: row.content,
    confidence: row.confidence,
    verification: row.verification,
    pinned: row.pinned,
    // Raw sql<T> results are not runtime-validated — coerce at the boundary.
    salience: Number(row.salience),
    lastReferencedAt: row.lastReferencedAt ? new Date(row.lastReferencedAt) : null,
    recallCount: Number(row.recallCount),
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : new Date(0),
    relevance:
      fingerprint && row.embeddingModel === fingerprint && row.relevance !== null
        ? Number(row.relevance)
        : null,
    embeddedByCurrentModel: !!fingerprint && row.embeddingModel === fingerprint,
  }))

  return { rows: candidates, total: coerceTotal(rows, candidates.length) }
}

/**
 * `count(*) over ()` off the first row, defended against a driver (or a test
 * double) that did not return the column: the row count is then the only
 * honest answer available, and it is never larger than the truth.
 */
function coerceTotal(rows: { total?: number }[], fallback: number): number {
  if (rows.length === 0) return 0
  const total = Number(rows[0]?.total)
  return Number.isFinite(total) && total >= fallback ? total : fallback
}

/** One end of a supersession link, as the reader needs to see it. */
export interface SupersessionRef {
  id: string
  content: string
}

/**
 * Resolve the notes on the other end of a supersession, for rows the caller
 * already holds.
 *
 * Two lookups, both bounded by the caller's own row count and both skipped
 * when nothing needs them:
 *
 * - `targets` — the notes these rows retired (`supersedes_id`), for the ids the
 *   caller does not already hold. A caller listing one scope usually holds both
 *   ends already, so this is normally zero rows.
 * - `replacements` — the notes that retired these rows, found by asking which
 *   rows point AT them. Only ACTIVE replacements count: after a restore
 *   (`POST …/memory/:itemId/restore`) the replacement is itself retired and its
 *   `supersedes_id` becomes history rather than a live correction, and a reader
 *   shown "superseded by" a retired note would be told the opposite of what is
 *   true.
 */
export async function selectSupersessionLinks(
  rows: { id: string; supersedesId: string | null }[]
): Promise<{
  targets: Map<string, SupersessionRef>
  replacements: Map<string, SupersessionRef>
}> {
  const targets = new Map<string, SupersessionRef>()
  const replacements = new Map<string, SupersessionRef>()
  if (rows.length === 0) return { targets, replacements }

  const held = new Set(rows.map((row) => row.id))
  const db = getDb()

  const missingTargets = [
    ...new Set(
      rows.map((row) => row.supersedesId).filter((id): id is string => !!id && !held.has(id))
    ),
  ]
  if (missingTargets.length > 0) {
    const found = await db
      .select({ id: projectMemory.id, content: projectMemory.content })
      .from(projectMemory)
      .where(inArray(projectMemory.id, missingTargets))
      .limit(missingTargets.length)
    for (const row of found) targets.set(row.id, { id: row.id, content: row.content })
  }

  const ids = rows.map((row) => row.id)
  const pointingAtUs = await db
    .select({
      id: projectMemory.id,
      content: projectMemory.content,
      supersedesId: projectMemory.supersedesId,
    })
    .from(projectMemory)
    .where(and(inArray(projectMemory.supersedesId, ids), eq(projectMemory.status, 'active')))
    .limit(ids.length)
  for (const row of pointingAtUs) {
    if (!row.supersedesId) continue
    replacements.set(row.supersedesId, { id: row.id, content: row.content })
  }

  return { targets, replacements }
}

/** The two rows a restore swaps, as the service needs to judge them. */
export interface RestorePair {
  retired: { id: string; content: string; status: string }
  replacement: { id: string; content: string } | null
}

/**
 * Find the retired note `itemId` and the ACTIVE note that retired it.
 *
 * Owner-scoped exactly like every other single-item read here: a project id for
 * project items, an organization id for organization items, so an item id from
 * another project resolves to nothing rather than to its own row.
 */
export async function findRestorePair(
  owner: { projectId: string } | { organizationId: string },
  itemId: string
): Promise<RestorePair | null> {
  const db = getDb()
  const ownerCondition =
    'projectId' in owner
      ? eq(projectMemory.projectId, owner.projectId)
      : and(
          eq(projectMemory.scope, 'organization'),
          eq(projectMemory.organizationId, owner.organizationId),
          isNull(projectMemory.projectId)
        )

  const [retired] = await db
    .select({
      id: projectMemory.id,
      content: projectMemory.content,
      status: projectMemory.status,
    })
    .from(projectMemory)
    .where(and(eq(projectMemory.id, itemId), ownerCondition))
    .limit(1)
  if (!retired) return null

  const [replacement] = await db
    .select({ id: projectMemory.id, content: projectMemory.content })
    .from(projectMemory)
    .where(
      and(
        eq(projectMemory.supersedesId, itemId),
        eq(projectMemory.status, 'active'),
        ownerCondition
      )
    )
    .orderBy(desc(projectMemory.updatedAt))
    .limit(1)

  return { retired, replacement: replacement ?? null }
}

/**
 * Swap a supersession back: the retired note becomes active again and the note
 * that replaced it is retired.
 *
 * ONE transaction, for the reason the forward direction is one: the store must
 * never hold both notes live (two contradictory findings in every digest) nor
 * neither (the fact disappears). The `supersedes_id` link is deliberately NOT
 * rewritten — it records what happened, and a restore is a second event rather
 * than a rewriting of the first. `selectSupersessionLinks` reads the direction
 * off the statuses instead, which keeps a restore idempotent and reversible.
 *
 * Both updates are conditional on the status they expect, so two concurrent
 * restores settle rather than double-apply; returns false when either row had
 * already moved.
 */
export async function restoreSupersededItem(
  itemId: string,
  replacementId: string
): Promise<boolean> {
  try {
    return await getDb().transaction(async (tx) => {
      const reinstated = await tx
        .update(projectMemory)
        .set({ status: 'active', updatedAt: new Date() })
        .where(and(eq(projectMemory.id, itemId), eq(projectMemory.status, 'superseded')))
        .returning({ id: projectMemory.id })
      if (reinstated.length === 0) throw new RestoreRaceError()

      const retired = await tx
        .update(projectMemory)
        .set({ status: 'superseded', updatedAt: new Date() })
        .where(and(eq(projectMemory.id, replacementId), eq(projectMemory.status, 'active')))
        .returning({ id: projectMemory.id })
      // The replacement moved under us. Leaving the pair BOTH live is the one
      // outcome this must not produce, so the reinstatement goes back too.
      if (retired.length === 0) throw new RestoreRaceError()
      return true
    })
  } catch (error) {
    if (error instanceof RestoreRaceError) return false
    throw error
  }
}

/**
 * Thrown to roll the transaction back when a concurrent writer already moved
 * one of the two rows. Private: it never leaves this module — the caller sees
 * `false`, which is "somebody else got there first", not a failure.
 */
class RestoreRaceError extends Error {}
