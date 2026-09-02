import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projectMemory, projects } from '@/lib/db/schema'
import type {
  NewProjectMemoryItem,
  ProjectMemoryConfidence,
  ProjectMemoryItem,
} from '@/lib/db/schema'
import {
  NEAR_DUP_JACCARD_THRESHOLD,
  NEAR_DUP_MIN_TOKENS,
  contentTokens,
  jaccardSimilarity,
  normalizeContent,
  polaritySignature,
} from '@/lib/knowledge/consolidation'
import { formatBoundedDigest } from '@/lib/knowledge/digest-format'
import {
  cosineSimilaritySql,
  embedNote,
  embedNotes,
  enrichForEmbedding,
  toVectorLiteral,
  type EmbeddedNote,
} from '@/lib/knowledge/embeddings'
import { daysSince, fuseHybridRelevance, rankByRecallScore } from '@/lib/knowledge/recall-scoring'

/**
 * Memory service — system-of-record CRUD plus the bounded "core digest"
 * that is injected into the agent's context on every WebSocket handshake.
 *
 * Two scopes (see docs/architecture/project-memory-design.md):
 * - 'project'      — findings about one project (project_id set)
 * - 'organization' — cross-cutting knowledge shared by every project in the
 *                    org (project_id NULL). Never cross-organization.
 *
 * This module is the ONLY writer of the project_memory table — the backend's
 * `remember` tool goes through the internal BFF endpoint, not the DB.
 */

/** Digest budget in characters. Kept small: this rides a header on every turn. */
const DIGEST_MAX_CHARS = 1800
/** Max items considered for the digest (pinned first, then most recent). */
const DIGEST_MAX_ITEMS = 20

const CONFIDENCE_RANK: Record<ProjectMemoryConfidence, number> = { low: 0, medium: 1, high: 2 }

/**
 * A normalized-content equality condition (Postgres side of `normalizeContent`).
 * `btrim(regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g'))`.
 */
function normalizedContentEquals(content: string) {
  return sql`btrim(regexp_replace(lower(${projectMemory.content}), '[^a-z0-9]+', ' ', 'g')) = ${normalizeContent(content)}`
}

/** Scope-exact owner condition shared by both dedup passes. */
function memoryOwnerCondition(
  values: Pick<NewProjectMemoryItem, 'scope' | 'projectId' | 'organizationId'>
) {
  return values.scope === 'organization'
    ? and(
        eq(projectMemory.scope, 'organization'),
        eq(projectMemory.organizationId, values.organizationId),
        isNull(projectMemory.projectId)
      )
    : and(
        eq(projectMemory.scope, 'project'),
        eq(projectMemory.projectId, values.projectId as string)
      )
}

/**
 * The write-time de-duplication gate (a pragmatic first slice of design §3.2).
 * Finds an existing ACTIVE item in the same scope whose content normalizes to
 * the same string, so a repeated finding updates in place instead of adding a
 * duplicate row. Scope-exact: project items match the project; org items match
 * the org and require project_id IS NULL.
 */
async function findActiveDuplicate(
  values: Pick<NewProjectMemoryItem, 'scope' | 'projectId' | 'organizationId' | 'content'>
): Promise<ProjectMemoryItem | null> {
  const db = getDb()
  const [existing] = await db
    .select()
    .from(projectMemory)
    .where(
      and(
        memoryOwnerCondition(values),
        eq(projectMemory.status, 'active'),
        normalizedContentEquals(values.content)
      )
    )
    .orderBy(desc(projectMemory.updatedAt))
    .limit(1)
  return existing ?? null
}

// Normalization, tokenization, Jaccard, the polarity split and the shared
// thresholds live in `@/lib/knowledge/consolidation` — one engine for every
// store that consolidates free-text findings (project memory here, platform
// lessons in `lib/platform-lessons`). `normalizeContent` there is the ASCII
// fold that must stay in lock-step with the 0010 index expressions.

/** Bound on the candidate scan (most recently updated active items in scope). */
const NEAR_DUP_CANDIDATE_LIMIT = 200

/** A near-identical existing item, and whether it asserts the OPPOSITE. */
interface NearMatch {
  item: ProjectMemoryItem
  /** True when the two contents are near-identical but disagree in polarity. */
  opposedPolarity: boolean
}

/**
 * Paraphrase-level dedup: finds an ACTIVE item in the same scope AND of the
 * same kind whose token set nearly matches the incoming content. Kind-exact
 * because a decision and a constraint about the same subject are different
 * findings even when they share most words. Pure JS over a bounded candidate
 * list — the §3.2 embed-based consolidation still supersedes this later.
 *
 * The match is classified rather than merged blindly: at this overlap the item
 * is either the same fact restated (→ merge) or the same fact CORRECTED
 * (→ supersede). See NEGATION_TOKENS.
 */
async function findActiveNearMatch(
  values: Pick<NewProjectMemoryItem, 'scope' | 'projectId' | 'organizationId' | 'content' | 'kind'>
): Promise<NearMatch | null> {
  const incomingTokens = contentTokens(values.content)
  if (incomingTokens.size < NEAR_DUP_MIN_TOKENS) return null
  const db = getDb()
  const candidates = await db
    .select()
    .from(projectMemory)
    .where(
      and(
        memoryOwnerCondition(values),
        eq(projectMemory.status, 'active'),
        eq(projectMemory.kind, values.kind)
      )
    )
    .orderBy(desc(projectMemory.updatedAt))
    .limit(NEAR_DUP_CANDIDATE_LIMIT)
  let best: ProjectMemoryItem | null = null
  let bestScore = NEAR_DUP_JACCARD_THRESHOLD
  for (const candidate of candidates) {
    const score = jaccardSimilarity(incomingTokens, contentTokens(candidate.content))
    if (score >= bestScore) {
      best = candidate
      bestScore = score
    }
  }
  if (!best) return null
  return {
    item: best,
    opposedPolarity: polaritySignature(values.content) !== polaritySignature(best.content),
  }
}

/**
 * Cosine above which two same-kind findings are treated as the same fact.
 *
 * Calibrated deliberately toward SEPARATION, the way issue-grouping systems
 * calibrate a merge threshold: a wrong merge silently destroys a finding and
 * is hard to notice, while a missed merge costs one redundant row a curator
 * can prune. 0.90 on a normalized embedding is "restatement", not "related".
 */
const SEMANTIC_DUP_THRESHOLD = 0.9

/**
 * Paraphrase dedup that actually sees paraphrase.
 *
 * The Jaccard pass below cannot: "der Bauherr wünscht ein Flachdach" and
 * "Flachdach ist gewünscht" share no tokens and score 0.0, so the store grew a
 * second row for the same fact every time somebody rephrased it. This is the
 * embed-based consolidation gate the design named as essential and never got
 * (memory-system-audit-2026-07 F2).
 *
 * Scope-exact like its lexical sibling but NOT kind-bound: at 0.90 cosine the
 * incoming note is the same statement, and the same statement filed once as a
 * `constraint` and once as a `derived_fact` is one fact with two rows — the
 * "there should be only one entry" a reviewer sees. It carries the same
 * polarity check: at this similarity the incoming finding is either the same
 * fact restated (merge) or the same fact CORRECTED (supersede), and merging a
 * correction is how memory becomes uncorrectable. Cosine is computed in SQL so
 * candidate vectors never cross the wire.
 *
 * Returns null when the embedder is unavailable, when nothing is embedded yet,
 * or when nothing clears the threshold — every one of which just means "fall
 * through to the lexical pass".
 */
async function findSemanticNearMatch(
  values: Pick<NewProjectMemoryItem, 'scope' | 'projectId' | 'organizationId' | 'content' | 'kind'>,
  embedded: EmbeddedNote | null
): Promise<NearMatch | null> {
  if (!embedded) return null
  const db = getDb()
  // Raw SQL so the vector literal travels once (WHERE + ORDER BY + projection
  // would otherwise carry three copies at embedding dimensionality). The scope
  // condition is inlined per branch; RLS remains the backstop underneath.
  const owner =
    values.scope === 'organization'
      ? sql`m.scope = 'organization' and m.organization_id = ${values.organizationId} and m.project_id is null`
      : sql`m.scope = 'project' and m.project_id = ${values.projectId as string}`
  const result = await db.execute(sql`
    with scored as (
      select m.*, grid_cosine_similarity(m.embedding, ${toVectorLiteral(embedded.vector)}::real[]) as similarity
      from project_memory m
      where ${owner}
        and m.status = 'active'
        and m.embedding_model = ${embedded.fingerprint}
    )
    select * from scored
    where similarity >= ${SEMANTIC_DUP_THRESHOLD}
    order by similarity desc
    limit 1
  `)
  const rows = (result as { rows?: Record<string, unknown>[] })?.rows ?? []
  if (rows.length === 0) return null
  const raw = rows[0]
  // The consolidation path reads id/content/pinned/verification/provenance —
  // coerce those; the rest rides through for the supersede link.
  const item = {
    id: String(raw.id),
    content: String(raw.content),
    pinned: Boolean(raw.pinned),
    verification: raw.verification,
    provenanceType: raw.provenance_type,
    // The refresh compares confidence; without it the merge could never raise one.
    confidence: (raw.confidence as ProjectMemoryConfidence | undefined) ?? 'medium',
    supersedesId: (raw.supersedes_id as string | null) ?? null,
  } as ProjectMemoryItem
  return {
    item,
    opposedPolarity: polaritySignature(values.content) !== polaritySignature(item.content),
  }
}

/**
 * How closely a caller-named supersede target must match an existing item.
 * The caller quotes the entry verbatim from the digest it was shown, so an
 * exact normalized match is the common case; the fuzzy fallback tolerates
 * re-wrapping and truncation but stays strict — resolving to the WRONG item
 * would retire a finding that is still true.
 */
const SUPERSEDE_MATCH_THRESHOLD = 0.7

/**
 * Resolve the item a caller says its finding makes obsolete, from the verbatim
 * content it quoted back. Kind-agnostic (a `derived_fact` may well overturn a
 * `constraint`) and scope-exact. Returns null when nothing matches closely
 * enough — an unresolvable quote is ignored, never guessed at.
 */
async function resolveSupersedeTarget(
  values: Pick<NewProjectMemoryItem, 'scope' | 'projectId' | 'organizationId'>,
  supersedesContent: string
): Promise<ProjectMemoryItem | null> {
  const db = getDb()
  const candidates = await db
    .select()
    .from(projectMemory)
    .where(and(memoryOwnerCondition(values), eq(projectMemory.status, 'active')))
    .orderBy(desc(projectMemory.updatedAt))
    .limit(NEAR_DUP_CANDIDATE_LIMIT)

  const normalized = normalizeContent(supersedesContent)
  if (!normalized) return null
  // An exact quote resolves against the WHOLE scope, through the same
  // normalisation the 0010 unique index is built on, so a correction of a
  // note older than the fuzzy window below still lands on it.
  const [exactInScope] = await db
    .select()
    .from(projectMemory)
    .where(
      and(
        memoryOwnerCondition(values),
        eq(projectMemory.status, 'active'),
        sql`btrim(regexp_replace(lower(${projectMemory.content}), '[^a-z0-9]+', ' ', 'g')) = ${normalized}`
      )
    )
    .orderBy(desc(projectMemory.updatedAt))
    .limit(1)
  // Re-checked in JS: the row is what the index expression says it is, and
  // the two normalisations are kept in lock-step by exactly this comparison.
  if (exactInScope && normalizeContent(exactInScope.content) === normalized) return exactInScope
  const exact = candidates.find((candidate) => normalizeContent(candidate.content) === normalized)
  if (exact) return exact

  const wanted = contentTokens(supersedesContent)
  if (wanted.size < NEAR_DUP_MIN_TOKENS) return null
  let best: ProjectMemoryItem | null = null
  let bestScore = SUPERSEDE_MATCH_THRESHOLD
  for (const candidate of candidates) {
    const score = jaccardSimilarity(wanted, contentTokens(candidate.content))
    if (score >= bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

/**
 * Whether an agent may retire this item on its own. Design §3.2: never
 * silently overwrite what a human curated — a pinned, user-confirmed, or
 * user-authored item is only ever retired by a human, in the memory panel.
 */
function isAgentSupersedable(item: ProjectMemoryItem): boolean {
  return !item.pinned && item.verification !== 'user_confirmed' && item.provenanceType !== 'user'
}

export async function listProjectMemory(
  projectId: string,
  options: {
    includeArchived?: boolean
    organizationId?: string
    sourceConversationId?: string
  } = {}
): Promise<ProjectMemoryItem[]> {
  const db = getDb()

  // Project items, plus the org-wide items that apply to every project.
  // Defense-in-depth: when the caller knows the organization, the project
  // branch is additionally constrained to that org so a projectId from
  // another tenant can never match.
  const projectCondition = options.organizationId
    ? and(
        eq(projectMemory.projectId, projectId),
        eq(projectMemory.organizationId, options.organizationId)
      )
    : eq(projectMemory.projectId, projectId)
  const scopeCondition = options.organizationId
    ? or(
        projectCondition,
        and(
          eq(projectMemory.scope, 'organization'),
          eq(projectMemory.organizationId, options.organizationId),
          isNull(projectMemory.projectId)
        )
      )
    : projectCondition

  const conditions = [scopeCondition]
  if (!options.includeArchived) {
    conditions.push(eq(projectMemory.status, 'active'))
  }
  if (options.sourceConversationId) {
    // Used by the chat "Piloti noted N" chip to show only what this turn recorded.
    conditions.push(eq(projectMemory.sourceConversationId, options.sourceConversationId))
  }
  return db
    .select()
    .from(projectMemory)
    .where(and(...conditions))
    .orderBy(desc(projectMemory.pinned), desc(projectMemory.updatedAt))
}

export async function listOrganizationMemory(
  organizationId: string,
  options: { includeArchived?: boolean } = {}
): Promise<ProjectMemoryItem[]> {
  const db = getDb()
  const conditions = [
    eq(projectMemory.scope, 'organization'),
    eq(projectMemory.organizationId, organizationId),
  ]
  if (!options.includeArchived) {
    conditions.push(eq(projectMemory.status, 'active'))
  }
  return db
    .select()
    .from(projectMemory)
    .where(and(...conditions))
    .orderBy(desc(projectMemory.pinned), desc(projectMemory.updatedAt))
}

export interface CreateMemoryOptions {
  /**
   * Verbatim content of an existing entry the caller believes this finding
   * makes obsolete, quoted back from the digest it was shown (the reflection
   * stage and the `remember` tool both supply it). Resolved fuzzily against
   * active items in the same scope; ignored when nothing matches closely
   * enough or when the target is human-curated.
   */
  supersedesContent?: string | null
  /**
   * Called with the id of the entry THIS call retired. Callers that report the
   * retirement (the internal endpoint's `supersededId`) must not read it off
   * the returned row: a duplicate/paraphrase refresh returns an EXISTING row,
   * whose `supersedesId` may record a retirement from an earlier correction.
   */
  onSuperseded?: (supersededId: string) => void
}

/** Refresh a duplicate in place: recency + the best-known confidence. */
async function refreshDuplicate(
  duplicate: ProjectMemoryItem,
  values: NewProjectMemoryItem
): Promise<ProjectMemoryItem> {
  const db = getDb()
  const incoming = (values.confidence ?? 'medium') as ProjectMemoryConfidence
  const best =
    CONFIDENCE_RANK[incoming] > CONFIDENCE_RANK[duplicate.confidence]
      ? incoming
      : duplicate.confidence
  const [updated] = await db
    .update(projectMemory)
    .set({ confidence: best, lastReferencedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectMemory.id, duplicate.id))
    .returning()
  return updated ?? duplicate
}

export async function createProjectMemoryItem(
  values: NewProjectMemoryItem,
  options: CreateMemoryOptions = {}
): Promise<ProjectMemoryItem> {
  const db = getDb()

  // Write-time consolidation (design §3.2). Three outcomes, in order:
  //
  //  1. Exact normalized duplicate → refresh in place, no new row.
  //  2. Same-kind paraphrase → refresh in place IF it says the same thing;
  //     if it says the OPPOSITE it is a correction, so it supersedes instead.
  //  3. A caller-named supersede target → that entry is retired.
  //
  // Without (2)'s polarity split a correction scores as a duplicate and is
  // silently dropped while the stale row gets a fresh timestamp — memory then
  // can never be corrected, only appended to.
  const exact = await findActiveDuplicate(values)
  if (exact) return refreshDuplicate(exact, values)

  // One embedding per write, reused for BOTH the semantic dedup probe and the
  // stored vector — so consolidation and future recall cost one call between
  // them, not two. Null (no embedder) degrades to the lexical path only.
  const embedded = await embedNote(enrichForEmbedding(values.content, [values.kind]))

  // Semantic first, lexical second: the semantic pass sees everything the
  // lexical one does plus paraphrase, so reaching the Jaccard scan means the
  // embedder had nothing to say.
  const near =
    (await findSemanticNearMatch(values, embedded)) ?? (await findActiveNearMatch(values))
  const named = options.supersedesContent?.trim()
    ? await resolveSupersedeTarget(values, options.supersedesContent)
    : null
  if (near && !near.opposedPolarity) {
    const refreshed = await refreshDuplicate(near.item, values)
    // The finding restates a row we already hold — and the caller ALSO named
    // the entry it makes obsolete. Merging must not swallow that: the named
    // row was left live beside the refreshed one, which is exactly the
    // duplicate the caller was trying to close.
    if (named && named.id !== refreshed.id && isAgentSupersedable(named)) {
      const retired = await db
        .update(projectMemory)
        .set({ status: 'superseded', updatedAt: new Date() })
        .where(and(eq(projectMemory.id, named.id), eq(projectMemory.status, 'active')))
        .returning({ id: projectMemory.id })
      if (retired.length > 0) options.onSuperseded?.(named.id)
    }
    return refreshed
  }

  const candidate = near?.item ?? named

  let supersedeTarget: ProjectMemoryItem | null = null
  let conflictsWithId: string | null = null
  if (candidate) {
    if (isAgentSupersedable(candidate)) {
      supersedeTarget = candidate
    } else {
      // Both stay active and the user resolves it in the memory panel — the
      // new finding is still recorded, it just doesn't retire a human's entry.
      // Recorded ON THE ROW, not only in this log line: the contradiction is a
      // fact about the project (two live notes disagree, and a person's wins
      // until a person says otherwise), and a panel can only show a conflict
      // the database remembers.
      conflictsWithId = candidate.id
      console.warn(
        `[memory] Not superseding human-curated item ${candidate.id} (pinned/user-confirmed/user-authored)`
      )
    }
  }

  const withVector: NewProjectMemoryItem = embedded
    ? {
        ...values,
        embedding: embedded.vector,
        embeddingModel: embedded.fingerprint,
        embeddedAt: new Date(),
      }
    : values
  const insertValues: NewProjectMemoryItem = supersedeTarget
    ? { ...withVector, supersedesId: supersedeTarget.id }
    : conflictsWithId
      ? { ...withVector, conflictsWithId }
      : withVector

  try {
    if (!supersedeTarget) {
      const [item] = await db.insert(projectMemory).values(insertValues).returning()
      return item
    }
    // One transaction: the replacement must never land without the old entry
    // being retired (two live contradictory entries), nor the retirement
    // without the replacement (a fact silently disappearing from the digest).
    return await db.transaction(async (tx) => {
      const [item] = await tx.insert(projectMemory).values(insertValues).returning()
      const retired = await tx
        .update(projectMemory)
        .set({ status: 'superseded', updatedAt: new Date() })
        .where(and(eq(projectMemory.id, supersedeTarget.id), eq(projectMemory.status, 'active')))
        .returning({ id: projectMemory.id })
      // Reported only for a retirement this call performed (a concurrent writer
      // may have retired the target first, matching zero rows).
      if (retired.length > 0) options.onSuperseded?.(supersedeTarget.id)
      return item
    })
  } catch (err) {
    // Race backstop: a concurrent write may have inserted the same normalized
    // content between our check and this insert, tripping the partial unique
    // index (migration 0010). Treat that as a duplicate and return the winner.
    if ((err as { code?: string } | null)?.code === '23505') {
      const winner = await findActiveDuplicate(values)
      if (winner) return winner
    }
    throw err
  }
}

/**
 * Create a project-scoped item deriving organization_id from the project row
 * (tenancy-safe for callers that only know the project id, e.g. the internal
 * endpoint used by the agent's `remember` tool). Returns null when the
 * project does not exist.
 */
/**
 * The organization a project belongs to, or null if there is no such project.
 *
 * Exists so a caller holding only a project id can ESTABLISH a tenant context
 * rather than read without one. The lookup itself needs platform scope — that
 * is the point: it reads exactly one column of one row, and everything after it
 * runs inside the tenant that row names.
 */
export async function resolveProjectOrganization(projectId: string): Promise<string | null> {
  const [project] = await getDb()
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  return project?.organizationId ?? null
}

export async function createProjectMemoryItemForProject(
  projectId: string,
  values: Omit<NewProjectMemoryItem, 'projectId' | 'organizationId' | 'scope'>,
  options: CreateMemoryOptions = {}
): Promise<ProjectMemoryItem | null> {
  const db = getDb()
  const [project] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!project) return null

  return createProjectMemoryItem(
    {
      ...values,
      scope: 'project',
      projectId,
      organizationId: project.organizationId,
    },
    options
  )
}

/**
 * Update an item. Tenancy guard: `owner` must match the item's own scope —
 * a projectId for project items, or an organizationId for org items.
 */
export async function updateProjectMemoryItem(
  owner: { projectId: string } | { organizationId: string },
  itemId: string,
  patch: Partial<
    Pick<
      ProjectMemoryItem,
      'content' | 'kind' | 'status' | 'confidence' | 'verification' | 'pinned' | 'salience'
    >
  >
): Promise<ProjectMemoryItem | null> {
  const db = getDb()
  const ownerCondition =
    'projectId' in owner
      ? eq(projectMemory.projectId, owner.projectId)
      : and(
          eq(projectMemory.scope, 'organization'),
          eq(projectMemory.organizationId, owner.organizationId)
        )
  const [item] = await db
    .update(projectMemory)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(projectMemory.id, itemId), ownerCondition))
    .returning()
  return item ?? null
}

export async function deleteProjectMemoryItem(
  owner: { projectId: string } | { organizationId: string },
  itemId: string
): Promise<boolean> {
  const db = getDb()
  const ownerCondition =
    'projectId' in owner
      ? eq(projectMemory.projectId, owner.projectId)
      : and(
          eq(projectMemory.scope, 'organization'),
          eq(projectMemory.organizationId, owner.organizationId)
        )
  const deleted = await db
    .delete(projectMemory)
    .where(and(eq(projectMemory.id, itemId), ownerCondition))
    .returning({ id: projectMemory.id })
  return deleted.length > 0
}

/** The subset of a memory item the digest formatter needs. */
export type DigestItem = Pick<
  ProjectMemoryItem,
  'scope' | 'kind' | 'content' | 'confidence' | 'verification'
>

/**
 * Pure digest formatter (exported for tests). Each item becomes one line:
 *   - [scope-tag kind | confidence | verification] "content"
 * Content is whitespace-collapsed and wrapped in double quotes with internal
 * quotes escaped (\"), so stored content can never forge an additional
 * `- [...]` tag line or break out of its own entry. Lines are appended in
 * order until DIGEST_MAX_CHARS would be exceeded.
 */
export function formatDigestLines(items: DigestItem[], omitted = 0): string | null {
  // The escaping/bounding mechanics live in the shared formatter; this wrapper
  // decides the header, the per-item tag set, and the truncation notice.
  const digest = formatBoundedDigest(
    'PROJECT_MEMORY v1',
    items.map((item) => ({
      tags: [
        ...(item.scope === 'organization' ? ['org-wide'] : []),
        item.kind,
        item.confidence,
        item.verification,
      ],
      content: item.content,
    })),
    DIGEST_MAX_CHARS
  )
  if (!digest) return null
  // A cap says so in the text the MODEL reads, not only in the operator's log
  // — otherwise the agent presents a truncated shelf as the whole shelf and
  // answers "what do you remember" confidently and wrongly (gotchas.md).
  return omitted > 0
    ? `${digest}\n(+${omitted} weitere Notizen zu diesem Projekt, hier nicht gezeigt — frag nach, wenn eine davon zählen könnte.)`
    : digest
}

/**
 * Candidates considered before ranking. Bounded like every list here; past
 * this the tail is by definition the least recently touched.
 */
const RECALL_CANDIDATE_LIMIT = 200

/**
 * How many of the digest's slots pinned items may take.
 *
 * Pinning used to be unbounded, which made it a silent foot-gun: pin
 * twenty-one items and every unpinned memory was evicted from the digest
 * forever, with nothing on screen or in the prompt saying so
 * (memory-system-audit-2026-07). Pins still win, but they can no longer starve
 * recall entirely, and the overflow is disclosed in the digest text.
 */
const DIGEST_MAX_PINNED = 12

/** What the digest builder needs per candidate row. */
interface RecallCandidate extends DigestItem {
  id: string
  pinned: boolean
  salience: number
  lastReferencedAt: Date | null
  recallCount: number
  relevance: number | null
}

export interface MemoryDigestOptions {
  /**
   * The turn's question. When present (and the embedder is reachable) recall
   * is relevance-ranked against it; when absent the digest falls back to
   * pinned-then-recent, which is what every caller got before.
   */
  query?: string | null
}

/**
 * Build the bounded "core memory" digest injected as the
 * `x-grid-project-memory` header and re-fetched live per turn.
 *
 * Two tiers, which is the shape every shipping agent-memory system converged
 * on (see docs/architecture/semantic-notes.md): a small ALWAYS-carried core —
 * the user's pins — plus a RECALLED remainder chosen for this question.
 * Selection is `lib/knowledge/recall-scoring.ts` (relevance + importance +
 * recency, reinforced by past use).
 *
 * This replaces `ORDER BY pinned, updated_at LIMIT 20`, which the memory audit
 * called "an effectively random-by-recency subset" past twenty items (F3), and
 * under which `salience` and `last_referenced_at` were both written and never
 * read. It also stops silently truncating: when candidates do not fit, the
 * digest says so in the text the model reads, per the repo's own rule that a
 * cap must be visible to the model and not only to the operator.
 *
 * Returns null when there is no active memory (header is then omitted).
 */
export async function buildProjectMemoryDigest(
  projectId: string | undefined,
  organizationId: string | undefined,
  options: MemoryDigestOptions = {}
): Promise<string | null> {
  if (!projectId && !organizationId) return null
  const db = getDb()

  const scopeConditions = []
  if (projectId) {
    // Defense-in-depth: when the caller's organization is known, the project
    // branch is additionally pinned to that org so a foreign projectId can
    // never surface another tenant's memory.
    scopeConditions.push(
      organizationId
        ? and(
            eq(projectMemory.projectId, projectId),
            eq(projectMemory.organizationId, organizationId)
          )
        : eq(projectMemory.projectId, projectId)
    )
  }
  if (organizationId) {
    scopeConditions.push(
      and(
        eq(projectMemory.scope, 'organization'),
        eq(projectMemory.organizationId, organizationId),
        isNull(projectMemory.projectId)
      )
    )
  }

  const scope = and(
    scopeConditions.length > 1 ? or(...scopeConditions) : scopeConditions[0],
    eq(projectMemory.status, 'active')
  )

  // The query vector, when there is a question and an embedder. Fail-open:
  // null simply means the dense channel contributes nothing. The timeout is
  // deliberately ~1s — this sits on the turn's critical path, ahead of the
  // agent's own answer, and the Python side stops waiting for the whole
  // digest at 2.5s; a slower embed is worth less than nothing here.
  const queryText = options.query?.trim()
  const embedded = queryText ? await embedNote(queryText, { timeoutMs: 1000 }) : null

  // Cosine is computed in SQL so the vectors never cross the wire — a
  // 3072-dimension vector per row would dominate this query's cost.
  const relevanceColumn = embedded
    ? cosineSimilaritySql(projectMemory.embedding, embedded.vector)
    : sql<number | null>`null::double precision`

  const rows = await db
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
      relevance: relevanceColumn,
      // Only compare vectors from the model that produced them: a same-size
      // vector from another embedder is noise wearing the right shape.
      embeddingModel: projectMemory.embeddingModel,
    })
    .from(projectMemory)
    .where(scope)
    // The window is the whole quality mechanism's ceiling: everything below
    // (dedup, decay, hybrid fusion) runs over these rows only. Recency was the
    // only order it had, so past two hundred notes a relevant old one could
    // not be recalled at all. With a query, the database ranks by similarity
    // first and recency breaks ties; without one, recency is still the order.
    .orderBy(
      ...(embedded ? [sql`${relevanceColumn} desc nulls last`] : []),
      desc(projectMemory.updatedAt)
    )
    .limit(RECALL_CANDIDATE_LIMIT)

  if (rows.length === 0) return null

  const candidates: RecallCandidate[] = rows.map((row) => ({
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
    relevance:
      embedded && row.embeddingModel === embedded.fingerprint && row.relevance !== null
        ? Number(row.relevance)
        : null,
  }))

  const pinned = candidates.filter((candidate) => candidate.pinned)
  const unpinned = candidates.filter((candidate) => !candidate.pinned)

  const keptPinned = pinned.slice(0, DIGEST_MAX_PINNED)
  const recallSlots = Math.max(0, DIGEST_MAX_ITEMS - keptPinned.length)

  // Relevance is HYBRID: the dense (cosine) channel fused by reciprocal rank
  // with a lexical token-overlap channel. Dense alone misses exactly the
  // queries this product lives on — "OIB-RL 6", "§ 4 Abs. 2" — and lexical
  // alone misses paraphrase; fused, each covers the other's blind side. The
  // lexical channel also means recall keeps working with no embedder at all.
  const queryTokens = queryText ? contentTokens(queryText) : null
  const lexical = unpinned.map((candidate) =>
    queryTokens ? jaccardSimilarity(queryTokens, contentTokens(candidate.content)) : 0
  )
  const relevance = fuseHybridRelevance(
    unpinned.map((candidate) => candidate.relevance),
    lexical
  )

  const ranked = rankByRecallScore(
    unpinned.map((candidate, index) => ({
      relevance: relevance[index],
      importance: candidate.salience,
      daysSinceUse: daysSince(candidate.lastReferencedAt),
      timesUsed: candidate.recallCount,
    }))
  )
  const keptRecalled = ranked.slice(0, recallSlots).map((entry) => unpinned[entry.index])

  // Self-healing backfill: rows written while the embedder was down (or before
  // it existed) stay on the lexical path until something embeds them. This is
  // that something — a bounded, fire-and-forget batch per digest build, so an
  // ACTIVE project heals itself and a dormant one costs nothing.
  if (embedded) {
    const unembedded = candidates
      .filter((candidate) => candidate.relevance === null)
      .filter((candidate) => !embeddedFingerprintMatches(rows, candidate.id, embedded.fingerprint))
      .slice(0, MEMORY_BACKFILL_BATCH)
    if (unembedded.length > 0) void backfillMemoryEmbeddings(unembedded)
  }

  const kept = [...keptPinned, ...keptRecalled]
  const omitted = candidates.length - kept.length

  // Recall FOR A QUESTION is the reinforcement event: what was surfaced against
  // a query decays more slowly next time. The query-less handshake build
  // (opening a chat, typing nothing) used to reinforce exactly as hard, and
  // under it the selection is pinned-then-recent — so recency reinforced
  // recency and whatever was already winning compounded. Fire-and-forget — a
  // bookkeeping write must never delay a turn, and losing one is a slightly
  // colder score, not a wrong answer.
  if (queryText) void markMemoryRecalled(kept.map((item) => item.id))

  return formatDigestLines(kept, omitted)
}

/** Rows already carrying a vector from the CURRENT model need no backfill. */
function embeddedFingerprintMatches(
  rows: { id: string; embeddingModel: string | null }[],
  id: string,
  fingerprint: string
): boolean {
  return rows.some((row) => row.id === id && row.embeddingModel === fingerprint)
}

/** Backfill batch per digest build — small on purpose; the next build continues. */
const MEMORY_BACKFILL_BATCH = 8

/**
 * Embed and store vectors for notes that missed theirs. Fire-and-forget and
 * tenant-scoped: called inside the digest's `withTenant` scope, and the async
 * continuation inherits it, so RLS still applies to the update.
 */
async function backfillMemoryEmbeddings(
  items: Pick<RecallCandidate, 'id' | 'kind' | 'content'>[]
): Promise<void> {
  try {
    const embedded = await embedNotes(
      items.map((item) => enrichForEmbedding(item.content, [item.kind]))
    )
    if (!embedded) return
    const db = getDb()
    for (let index = 0; index < items.length; index++) {
      await db
        .update(projectMemory)
        .set({
          embedding: embedded[index].vector,
          embeddingModel: embedded[index].fingerprint,
          embeddedAt: new Date(),
        })
        .where(eq(projectMemory.id, items[index].id))
    }
  } catch (error) {
    console.warn('[memory] Embedding backfill failed (non-fatal):', error)
  }
}

/**
 * Record that these items were recalled: refresh `last_referenced_at` and
 * increment `recall_count` (MemoryBank's `t` reset and `S` increment).
 * Never throws.
 */
async function markMemoryRecalled(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    await getDb()
      .update(projectMemory)
      .set({
        lastReferencedAt: new Date(),
        recallCount: sql`${projectMemory.recallCount} + 1`,
      })
      .where(inArray(projectMemory.id, ids))
  } catch (error) {
    console.warn('[memory] Could not record recall reinforcement (non-fatal):', error)
  }
}

/**
 * True when at least one project belongs to the organization. Used by the
 * internal memory endpoint to validate org-scoped writes. Limitation: there
 * is no organizations table, so an org with zero projects is treated as
 * unknown — acceptable because org memory is only useful alongside projects.
 */
export async function organizationExists(organizationId: string): Promise<boolean> {
  const db = getDb()
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.organizationId, organizationId))
    .limit(1)
  return rows.length > 0
}

/**
 * How near a down-vote comment must sit to a note before the note is
 * implicated in the complaint. Deliberately higher than digest relevance needs
 * to be: relevance ranks candidates against each other, this one levies a
 * penalty, and penalizing a bystander note is worse than missing a culprit.
 */
const IMPLICATION_THRESHOLD = 0.78
/** At most this many notes are implicated per report — the closest matches. */
const IMPLICATION_LIMIT = 2
/**
 * Salience decays multiplicatively and floors above zero: one report dents a
 * note, repeated reports bury it, and nothing erases it — the recall floor
 * keeps even a buried note reachable when it is the only relevant one.
 */
const IMPLICATION_SALIENCE_DECAY = 0.6
const IMPLICATION_SALIENCE_FLOOR = 0.05

/**
 * The memory half of feedback attribution — the analog of the lesson
 * pipeline's effectiveness signal, inside one tenant's own scope.
 *
 * A down-vote with a comment is a human saying "this answer was wrong" in
 * their own words. When that complaint sits semantically next to an active
 * memory note, the note plausibly shaped the answer, so it takes the hit:
 * salience decays (recoverable — reflection can supersede it with a corrected
 * finding, and recall reinforcement still works) and confidence drops to
 * 'low', which is the digest's honest marker for "hold this loosely". Notes
 * are never deleted here, and PINNED notes are exempt: a pin is explicit
 * human intent, and one human's down-vote does not outrank another's pin.
 *
 * Runs fire-and-forget off the vote path, inside the caller's tenant scope —
 * the raw comment never leaves the org boundary (unlike the lesson pipeline,
 * which scrubs before distilling precisely because it crosses it).
 * Returns the number of implicated notes; never throws.
 */
export async function implicateMemoryFromFeedback(input: {
  organizationId: string
  projectId: string | null
  comment: string
}): Promise<number> {
  const text = input.comment.trim()
  if (!text) return 0
  try {
    const embedded = await embedNote(text.slice(0, 500))
    if (!embedded) return 0
    const db = getDb()
    const owner = input.projectId
      ? sql`m.organization_id = ${input.organizationId} and ((m.scope = 'project' and m.project_id = ${input.projectId}) or (m.scope = 'organization' and m.project_id is null))`
      : sql`m.organization_id = ${input.organizationId} and m.scope = 'organization' and m.project_id is null`
    // Vector literal travels once (scored CTE), same discipline as the
    // near-match query above; RLS remains the backstop under the org filter.
    const result = await db.execute(sql`
      with scored as (
        select m.id, grid_cosine_similarity(m.embedding, ${toVectorLiteral(embedded.vector)}::real[]) as similarity
        from project_memory m
        where ${owner}
          and m.status = 'active'
          and m.pinned = false
          and m.embedding_model = ${embedded.fingerprint}
      ),
      implicated as (
        select id from scored
        where similarity >= ${IMPLICATION_THRESHOLD}
        order by similarity desc
        limit ${IMPLICATION_LIMIT}
      )
      update project_memory p
      set salience = greatest(${IMPLICATION_SALIENCE_FLOOR}, p.salience * ${IMPLICATION_SALIENCE_DECAY}),
          confidence = 'low',
          updated_at = now()
      from implicated i
      where p.id = i.id
      returning p.id
    `)
    const rows = (result as { rows?: Record<string, unknown>[] })?.rows ?? []
    return rows.length
  } catch (error) {
    console.warn('[memory] Feedback implication failed (non-fatal):', error)
    return 0
  }
}
