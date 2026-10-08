/**
 * The decisions other projects recorded, for the cross-project search
 * (docs/roadmap/office-experience.md, „Entscheidungen"): the active `decision`
 * and `constraint` items of their project memory, the experience the project
 * itself wrote down while it ran (`remember`, reflection, a person in the
 * memory panel). Shorter and more comparable than a passage, and they say why.
 *
 * Ranked as the project's own memory recall ranks (`buildProjectMemoryDigest`):
 * by meaning, the question's embedding against each item's stored one, fused by
 * reciprocal rank with a token-overlap channel that keeps identifiers („OIB-RL
 * 2", „REI 90") findable. No language's stemmer or stop words decide: a
 * question in English finds a decision written in German. Rank-only, like the
 * passage search beside it, the best few are returned and the model judges
 * which matter. Without an embedder the token channel alone answers.
 *
 * Each project's items are filtered by what the reader may see of that
 * project's memory, exactly as its own memory panel filters them
 * (`memoryVisibleTo`): restricted items only for a reader cleared for every
 * folder they came from.
 */

import 'server-only'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { contentTokens, jaccardSimilarity, normalizeContentGerman } from '@/lib/knowledge/consolidation'
import { cosineSimilaritySql, embedNote } from '@/lib/knowledge/embeddings'
import { fuseHybridRelevance } from '@/lib/knowledge/recall-scoring'
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

/** How many items one search ranks: its own bound, so a large office cannot widen it. */
const DECISION_CANDIDATES = 300

/** The decisions of these projects most relevant to the question, best first; none for an empty scope or question. */
export async function searchProjectDecisions(
  organizationId: string,
  scopes: readonly DecisionScope[],
  question: string,
  limit: number = CROSS_PROJECT_MAX_DECISIONS
): Promise<FoundDecision[]> {
  if (scopes.length === 0 || !question.trim()) return []
  // Fail-open: no embedder means the token channel alone ranks.
  const embedded = await embedNote(question, { timeoutMs: 1500 })
  const relevance = embedded
    ? cosineSimilaritySql(projectMemory.embedding, embedded.vector)
    : sql<number | null>`null::double precision`
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
      relevance,
      embeddingModel: projectMemory.embeddingModel,
    })
    .from(projectMemory)
    .where(
      and(
        eq(projectMemory.organizationId, organizationId),
        eq(projectMemory.scope, 'project'),
        eq(projectMemory.status, 'active'),
        inArray(projectMemory.kind, [...DECISION_KINDS]),
        visible
      )
    )
    .orderBy(...(embedded ? [sql`${relevance} desc nulls last`] : []), desc(projectMemory.updatedAt))
    .limit(DECISION_CANDIDATES)

  // A vector from another model is noise of the right shape: only the current one counts.
  const dense = rows.map((row) =>
    embedded && row.embeddingModel === embedded.fingerprint && row.relevance !== null ? Number(row.relevance) : null
  )
  // German-preserving: the ASCII fold splits „Mödling" into „m" and „dling", and names
  // are what this channel exists for. Both sides are tokenized here, so no index binds it.
  const asked = contentTokens(question, normalizeContentGerman)
  const lexical = rows.map((row) => jaccardSimilarity(asked, contentTokens(row.content, normalizeContentGerman)))
  const fused = fuseHybridRelevance(dense, lexical)

  // Raw values are not runtime-validated: coerced at the boundary.
  return rows
    .map((row, index) => ({ row, score: fused[index] }))
    .filter((entry): entry is { row: (typeof rows)[number]; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => ({
      projectId: String(row.projectId),
      kind: row.kind,
      content: row.content,
      confirmed: row.pinned || row.verification === 'user_confirmed' || row.provenanceType === 'user',
      updatedAt: new Date(row.updatedAt),
      restrictedFolderIds: row.restrictedFolderIds && row.restrictedFolderIds.length > 0 ? [...row.restrictedFolderIds] : null,
    }))
}
