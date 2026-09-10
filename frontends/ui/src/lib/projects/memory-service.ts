import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { ConflictError, OrgMemoryDisabledError } from '@/lib/api/errors'
import { resolveMembershipRole } from '@/lib/authz/membership-role'
import { orgRoleHoldsPermission } from '@/lib/authz/org-role-permissions'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { getDb } from '@/lib/db'
import { executeRows } from '@/lib/db/execute-rows'
import { projectMemory, projects } from '@/lib/db/schema'
import type {
  NewProjectMemoryItem,
  ProjectMemoryConfidence,
  ProjectMemoryItem,
  ProjectMemoryKind,
  ProjectMemoryScope,
  ProjectMemoryVerification,
} from '@/lib/db/schema'
import {
  NEAR_DUP_JACCARD_THRESHOLD,
  NEAR_DUP_MIN_TOKENS,
  contentTokens,
  jaccardSimilarity,
  normalizeContent,
  polaritySignature,
} from '@/lib/knowledge/consolidation'
import { renderBoundedDigest } from '@/lib/knowledge/digest-format'
import { markProjectRegisterStale } from '@/lib/workspace/register-service'
import {
  embedNote,
  embedNotes,
  enrichForEmbedding,
  toVectorLiteral,
  type EmbeddedNote,
} from '@/lib/knowledge/embeddings'
import { daysSince, fuseHybridRelevance, rankByRecallScore } from '@/lib/knowledge/recall-scoring'
import {
  findRestorePair,
  restoreSupersededItem,
  selectRecallCandidates,
  selectSupersessionLinks,
  type RecallCandidateRow,
  type SupersessionRef,
} from './memory-repository'

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
  const rows = executeRows(result)
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

/**
 * The statuses a reader sees by default.
 *
 * `superseded` is in the list because ADR-0055 makes a correction a STATED
 * event: the write path has always recorded `supersedes_id`, nothing ever read
 * it, and a retired note simply vanished from the panel — so the correction
 * could be neither seen nor undone (memory-reflection-audit.md). Retired rows
 * now come back carrying the `status` they already had; `dismissed` and
 * `proposed` still need `includeArchived`, because those were never part of
 * what the agent held.
 */
export const READER_VISIBLE_STATUSES = ['active', 'superseded'] as const

/** A memory item with both ends of its supersession resolved for the reader. */
export interface ProjectMemoryItemWithSupersession extends ProjectMemoryItem {
  /** The ACTIVE note that retired this one. Absent unless this note is retired. */
  supersededBy?: SupersessionRef
  /** The note this one retired, through the `supersedes_id` the write recorded. */
  supersedes?: SupersessionRef
}

/**
 * Attach both ends of the supersession chain to a page of rows.
 *
 * Direction is read off the STATUSES, not off which row holds the pointer:
 * `supersedes_id` records what happened once, and a restore is a second event
 * rather than a rewriting of the first, so "superseded by" is reported only
 * while the replacement is still live. That is what makes a restore reversible
 * and idempotent (see `restoreSupersededItem`).
 */
async function withSupersessionLinks(
  rows: ProjectMemoryItem[]
): Promise<ProjectMemoryItemWithSupersession[]> {
  if (rows.length === 0) return []
  const held = new Map(rows.map((row) => [row.id, row] as const))
  const { targets, replacements } = await selectSupersessionLinks(rows)
  return rows.map((row) => {
    const local = row.supersedesId ? held.get(row.supersedesId) : undefined
    const supersedes = row.supersedesId
      ? (local ? { id: local.id, content: local.content } : targets.get(row.supersedesId))
      : undefined
    const supersededBy = replacements.get(row.id)
    return {
      ...row,
      ...(supersedes ? { supersedes } : {}),
      ...(supersededBy ? { supersededBy } : {}),
    }
  })
}

export async function listProjectMemory(
  projectId: string,
  options: {
    includeArchived?: boolean
    organizationId?: string
    sourceConversationId?: string
  } = {}
): Promise<ProjectMemoryItemWithSupersession[]> {
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
    conditions.push(inArray(projectMemory.status, [...READER_VISIBLE_STATUSES]))
  }
  if (options.sourceConversationId) {
    // Used by the chat "Piloti noted N" chip to show only what this turn recorded.
    conditions.push(eq(projectMemory.sourceConversationId, options.sourceConversationId))
  }
  const rows = await db
    .select()
    .from(projectMemory)
    .where(and(...conditions))
    .orderBy(desc(projectMemory.pinned), desc(projectMemory.updatedAt))
  return withSupersessionLinks(rows)
}

export async function listOrganizationMemory(
  organizationId: string,
  options: { includeArchived?: boolean } = {}
): Promise<ProjectMemoryItemWithSupersession[]> {
  const db = getDb()
  const conditions = [
    eq(projectMemory.scope, 'organization'),
    eq(projectMemory.organizationId, organizationId),
  ]
  if (!options.includeArchived) {
    // The same reader view as `listProjectMemory`, and for the same reason: the
    // project panel already lists org-wide notes through that call, so an org
    // note whose correction is visible in one surface and invisible in the
    // other would be one store telling two stories.
    conditions.push(inArray(projectMemory.status, [...READER_VISIBLE_STATUSES]))
  }
  const rows = await db
    .select()
    .from(projectMemory)
    .where(and(...conditions))
    .orderBy(desc(projectMemory.pinned), desc(projectMemory.updatedAt))
  return withSupersessionLinks(rows)
}

/**
 * Undo a supersession: the retired note becomes active again and the note that
 * replaced it is retired (ADR-0055).
 *
 * Owner-scoped exactly like every other single-item mutation here. Returns
 * `null` when there is no such item in this owner's scope, and throws
 * {@link ConflictError} when there is nothing to undo — the item is not
 * retired, or no live note claims to have replaced it — because those two are
 * different answers and a bare 404 would report the first as the second.
 */
export async function restoreSupersededMemoryItem(
  owner: { projectId: string } | { organizationId: string },
  itemId: string
): Promise<{ restoredId: string; retiredId: string } | null> {
  const pair = await findRestorePair(owner, itemId)
  if (!pair) return null
  if (pair.retired.status !== 'superseded') {
    throw new ConflictError('This note is not retired, so there is nothing to restore')
  }
  if (!pair.replacement) {
    throw new ConflictError('No live note claims to have replaced this one')
  }
  const swapped = await restoreSupersededItem(itemId, pair.replacement.id)
  if (!swapped) {
    throw new ConflictError('This supersession was changed by someone else; reload and try again')
  }
  return { restoredId: itemId, retiredId: pair.replacement.id }
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
   * Called with the entry THIS call retired. Callers that report the
   * retirement (the internal endpoint's `supersededId`) must not read it off
   * the returned row: a duplicate/paraphrase refresh returns an EXISTING row,
   * whose `supersedesId` may record a retirement from an earlier correction.
   *
   * The retired entry's own `content` rides along with its id, because the
   * transcript half of ADR-0055 renders the note's words ("Bisher: …") and this
   * is the one moment they are already in hand. Deriving them anywhere later
   * costs a read of a row that was just loaded here — and in the polarity case
   * the caller never quoted the retired entry at all, so there is nothing
   * downstream to derive them FROM.
   */
  onSuperseded?: (superseded: { id: string; content: string }) => void
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
      if (retired.length > 0) options.onSuperseded?.({ id: named.id, content: named.content })
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
      // A memory write changes the Steckbrief's headline (spec PR-6). DEBOUNCED
      // on purpose: stamped stale, never rebuilt inline — `remember` fires
      // several times in one turn and a rebuild embeds 3000 characters. Never
      // throws, so a register outage cannot cost a note its write.
      void markProjectRegisterStale(values.projectId, values.organizationId)
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
      if (retired.length > 0)
        options.onSuperseded?.({ id: supersedeTarget.id, content: supersedeTarget.content })
      void markProjectRegisterStale(values.projectId, values.organizationId)
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
  const rendered = renderDigest(items)
  return rendered ? withOmissionNotice(rendered.text, omitted) : null
}

/**
 * The escaping/bounding mechanics live in the shared formatter; this decides
 * the header and the per-item tag set, and reports which items reached the
 * text so a caller can name exactly those (ADR-0055).
 */
function renderDigest(items: DigestItem[]) {
  return renderBoundedDigest(
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
}

/**
 * A cap says so in the text the MODEL reads, not only in the operator's log —
 * otherwise the agent presents a truncated shelf as the whole shelf and answers
 * "what do you remember" confidently and wrongly (gotchas.md). ADR-0055 adds
 * the other half: the same number now reaches the READER, through the digest
 * route's `omitted`, so the two are told the same thing.
 */
function withOmissionNotice(text: string, omitted: number): string {
  return omitted > 0
    ? `${text}\n(+${omitted} weitere Notizen zu diesem Projekt, hier nicht gezeigt — frag nach, wenn eine davon zählen könnte.)`
    : text
}

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

export interface MemoryDigestOptions {
  /**
   * The turn's question. When present (and the embedder is reachable) recall
   * is relevance-ranked against it; when absent the digest falls back to
   * pinned-then-recent, which is what every caller got before.
   */
  query?: string | null
}

/** One note the digest carried, as the reader is finally shown it. */
export interface CarriedMemoryNote {
  id: string
  kind: ProjectMemoryKind
  /** Truncated to {@link CARRIED_CONTENT_MAX_CHARS}: this is a label, not the note. */
  content: string
}

/**
 * What a digest build produced — the text for the model, and the same
 * selection as data for the reader.
 *
 * ADR-0055's inversion in one type: the digest used to tell the MODEL how many
 * notes were dropped and the reader nothing at all. `carried` names exactly the
 * notes that reached the text (not the ones selected for it — the character
 * budget can still drop a tail), and `omitted` is the very number the text
 * discloses, so the two audiences cannot be told different things.
 */
export interface MemoryDigestReport {
  text: string
  carried: CarriedMemoryNote[]
  /** Active notes in scope that the text does not carry. */
  omitted: number
  /** Active notes in scope, full stop. `carried.length + omitted`. */
  total: number
}

/** A carried note is a label in a list, not the note itself. */
const CARRIED_CONTENT_MAX_CHARS = 120

/** Collapse whitespace and cut to the label budget, with an ellipsis when cut. */
function toCarriedNote(item: { id: string; kind: ProjectMemoryKind; content: string }) {
  const content = item.content.replace(/\s+/g, ' ').trim()
  return {
    id: item.id,
    kind: item.kind,
    content:
      content.length > CARRIED_CONTENT_MAX_CHARS
        ? `${content.slice(0, CARRIED_CONTENT_MAX_CHARS - 1).trimEnd()}…`
        : content,
  }
}

/**
 * Build the bounded "core memory" digest injected as the
 * `x-grid-project-memory` header and re-fetched live per turn, AND the report
 * of what it carried.
 *
 * Two tiers, which is the shape every shipping agent-memory system converged
 * on (see docs/architecture/semantic-notes.md): a small ALWAYS-carried core —
 * the user's pins — plus a RECALLED remainder chosen for this question.
 * Selection is `lib/knowledge/recall-scoring.ts` (relevance + importance +
 * recency, reinforced by past use); the candidate statement and the scope rule
 * are `lib/projects/memory-repository.ts`, shared with `searchProjectMemory` so
 * the tool and the digest cannot disagree about either.
 *
 * This replaces `ORDER BY pinned, updated_at LIMIT 20`, which the memory audit
 * called "an effectively random-by-recency subset" past twenty items (F3), and
 * under which `salience` and `last_referenced_at` were both written and never
 * read. It also stops silently truncating: when candidates do not fit, the
 * digest says so in the text the model reads AND in `omitted`, which is the
 * same number, per the repo's rule that a cap must be visible — now to the
 * reader too, which is the half ADR-0055 adds.
 *
 * Returns null when there is no active memory (header is then omitted).
 */
export async function buildProjectMemoryDigestReport(
  projectId: string | undefined,
  organizationId: string | undefined,
  options: MemoryDigestOptions = {}
): Promise<MemoryDigestReport | null> {
  if (!projectId && !organizationId) return null

  // The query vector, when there is a question and an embedder. Fail-open:
  // null simply means the dense channel contributes nothing. The timeout is
  // deliberately ~1s — this sits on the turn's critical path, ahead of the
  // agent's own answer, and the Python side stops waiting for the whole
  // digest at 2.5s; a slower embed is worth less than nothing here.
  const queryText = options.query?.trim()
  const embedded = queryText ? await embedNote(queryText, { timeoutMs: 1000 }) : null

  const { rows: candidates, total } = await selectRecallCandidates(
    { projectId, organizationId },
    { queryVector: embedded?.vector ?? null, fingerprint: embedded?.fingerprint ?? null }
  )
  if (candidates.length === 0) return null

  const pinned = candidates.filter((candidate) => candidate.pinned)
  const unpinned = candidates.filter((candidate) => !candidate.pinned)

  const keptPinned = pinned.slice(0, DIGEST_MAX_PINNED)
  const recallSlots = Math.max(0, DIGEST_MAX_ITEMS - keptPinned.length)

  const ranked = rankMemoryByRelevance(unpinned, queryText ?? null)
  const keptRecalled = ranked.slice(0, recallSlots).map((entry) => unpinned[entry.index])

  // Self-healing backfill: rows written while the embedder was down (or before
  // it existed) stay on the lexical path until something embeds them. This is
  // that something — a bounded, fire-and-forget batch per digest build, so an
  // ACTIVE project heals itself and a dormant one costs nothing.
  if (embedded) {
    const unembedded = candidates
      .filter((candidate) => !candidate.embeddedByCurrentModel)
      .slice(0, MEMORY_BACKFILL_BATCH)
    if (unembedded.length > 0) void backfillMemoryEmbeddings(unembedded)
  }

  const kept = [...keptPinned, ...keptRecalled]

  // Recall FOR A QUESTION is the reinforcement event: what was surfaced against
  // a query decays more slowly next time. The query-less handshake build
  // (opening a chat, typing nothing) used to reinforce exactly as hard, and
  // under it the selection is pinned-then-recent — so recency reinforced
  // recency and whatever was already winning compounded. Fire-and-forget — a
  // bookkeeping write must never delay a turn, and losing one is a slightly
  // colder score, not a wrong answer.
  if (queryText) void markMemoryRecalled(kept.map((item) => item.id))

  // Rendered FIRST, then counted: the character budget decides what the model
  // actually sees, so anything counted before it is a claim about a different
  // digest than the one being sent.
  const rendered = renderDigest(kept)
  if (!rendered) return null
  const carried = rendered.included.map((index) => toCarriedNote(kept[index]))
  const omitted = Math.max(0, total - carried.length)

  return { text: withOmissionNotice(rendered.text, omitted), carried, omitted, total }
}

/**
 * The digest text alone, for the callers that inject it and report nothing
 * (the WebSocket handshake, the Büro digest, a scheduled job's prompt).
 */
export async function buildProjectMemoryDigest(
  projectId: string | undefined,
  organizationId: string | undefined,
  options: MemoryDigestOptions = {}
): Promise<string | null> {
  const report = await buildProjectMemoryDigestReport(projectId, organizationId, options)
  return report?.text ?? null
}

/**
 * The hybrid ranking both readers share.
 *
 * Relevance is HYBRID: the dense (cosine) channel fused by reciprocal rank
 * with a lexical token-overlap channel. Dense alone misses exactly the
 * queries this product lives on — "OIB-RL 6", "§ 4 Abs. 2" — and lexical
 * alone misses paraphrase; fused, each covers the other's blind side. The
 * lexical channel also means recall keeps working with no embedder at all.
 *
 * Exported shape is the scorer's own: indices into `candidates`, best first,
 * with the score, so a caller keeps its own rows and can report the score
 * (`search_memory` does; the digest does not).
 */
function rankMemoryByRelevance(
  candidates: RecallCandidateRow[],
  queryText: string | null
): { index: number; score: number }[] {
  const queryTokens = queryText ? contentTokens(queryText) : null
  const lexical = candidates.map((candidate) =>
    queryTokens ? jaccardSimilarity(queryTokens, contentTokens(candidate.content)) : 0
  )
  const relevance = fuseHybridRelevance(
    candidates.map((candidate) => candidate.relevance),
    lexical
  )
  return rankByRecallScore(
    candidates.map((candidate, index) => ({
      relevance: relevance[index],
      importance: candidate.salience,
      daysSinceUse: daysSince(candidate.lastReferencedAt),
      timesUsed: candidate.recallCount,
    }))
  )
}

/** Default and ceiling for a `search_memory` page (ADR-0055, contract C1). */
export const MEMORY_SEARCH_DEFAULT_LIMIT = 8
export const MEMORY_SEARCH_MAX_LIMIT = 20

/** One note the recall tool found, ranked against the caller's question. */
export interface MemorySearchHit {
  id: string
  kind: ProjectMemoryKind
  /**
   * The note, in full. NOT truncated the way the digest's `carried` is: that
   * one is a label in a list the reader scans, this one is the content the
   * agent asked for and has to reason about, and a finding cut at 120
   * characters is a finding that answers nothing. The column bounds it at 2000.
   */
  content: string
  confidence: ProjectMemoryConfidence
  verification: ProjectMemoryVerification
  pinned: boolean
  scope: ProjectMemoryScope
  updatedAt: string
  score: number
}

export interface MemorySearchResult {
  items: MemorySearchHit[]
  /** Active notes in scope, before ranking. */
  total: number
  returned: number
}

/**
 * The READ path the store never had (ADR-0055): recall against a question,
 * bounded, over the same candidates and the same hybrid ranking the digest
 * uses.
 *
 * Why it shares `selectRecallCandidates` and `rankMemoryByRelevance` rather
 * than growing its own: the digest is the working set, this is the way past it,
 * and a second opinion about relevance would make "the digest said N were
 * omitted, ask for them" a lie. It is also what keeps the SCOPE rule single —
 * a project turn reaches its project plus the organization, a project-less turn
 * reaches organization notes only, and neither can reach another project's,
 * because there is one condition and both callers use it.
 *
 * Pins do NOT jump the queue here. In the digest they are the always-carried
 * core because nobody asked a question; here somebody did, and a pin that
 * answers it wins on relevance like any other note.
 */
export async function searchProjectMemory(input: {
  projectId?: string
  organizationId: string
  query: string
  limit?: number
}): Promise<MemorySearchResult> {
  const query = input.query.trim()
  const limit = Math.min(
    Math.max(input.limit ?? MEMORY_SEARCH_DEFAULT_LIMIT, 1),
    MEMORY_SEARCH_MAX_LIMIT
  )

  const embedded = query ? await embedNote(query, { timeoutMs: 1000 }) : null
  const { rows: candidates, total } = await selectRecallCandidates(
    { projectId: input.projectId, organizationId: input.organizationId },
    { queryVector: embedded?.vector ?? null, fingerprint: embedded?.fingerprint ?? null }
  )
  if (candidates.length === 0) return { items: [], total, returned: 0 }

  const ranked = rankMemoryByRelevance(candidates, query).slice(0, limit)
  const items = ranked.map((entry) => {
    const candidate = candidates[entry.index]
    return {
      id: candidate.id,
      kind: candidate.kind,
      content: candidate.content,
      confidence: candidate.confidence,
      verification: candidate.verification,
      pinned: candidate.pinned,
      scope: candidate.scope,
      updatedAt: candidate.updatedAt.toISOString(),
      score: entry.score,
    }
  })

  // Reading for a question reinforces, exactly as the digest's query-driven
  // build does — otherwise a note reachable only through the tool would decay
  // as though nothing ever used it.
  void markMemoryRecalled(items.map((item) => item.id))

  return { items, total, returned: items.length }
}

/** Backfill batch per digest build — small on purpose; the next build continues. */
const MEMORY_BACKFILL_BATCH = 8

/**
 * Embed and store vectors for notes that missed theirs. Fire-and-forget and
 * tenant-scoped: called inside the digest's `withTenant` scope, and the async
 * continuation inherits it, so RLS still applies to the update.
 */
async function backfillMemoryEmbeddings(
  items: { id: string; kind: ProjectMemoryKind; content: string }[]
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

/** Who the agent's org-scoped write is acting FOR, as the turn's envelope carries it. */
export interface AgentMemoryActor {
  organizationId: string
  /** The `(user, organization)` pair WorkOS keys a role on. Absent ⇒ refused. */
  organizationMembershipId?: string | null
}

/**
 * The acting user's right to have the agent write ORGANIZATION memory
 * (spec AG-8, ADR-0008's open follow-up, audit finding S1).
 *
 * ## Why the ACTING USER and not the service token
 *
 * `POST /api/internal/memory` is authenticated by the shared service token,
 * which proves the caller is the backend and says nothing about the person
 * whose turn is running. An org item lands in every project's digest across
 * the tenant, so a check on the token alone would make "remember that we
 * always use GK5" a firm-wide write available to anyone who can get that
 * sentence into a prompt. The envelope carries the identity; this resolves
 * that identity's org role and asks the catalog what it holds — the same
 * membership-id path the internal mounts twin takes (`lib/authz/membership-role`).
 *
 * ## Every uncertainty refuses
 *
 * No membership id, an unknown or inactive membership, a membership in another
 * organization, a WorkOS outage: each resolves to a role of `null`, which holds
 * nothing. That is deliberate — the refusal is not an error the agent reports,
 * it is the AG-9 degrade: `remember` turns `ORG_MEMORY_DISABLED` into a
 * proposal card, so the finding reaches the user as an offer rather than
 * silently landing firm-wide.
 *
 * The error code is the one the Python client already recognises
 * (`OrgMemoryDisabledError`), and it is deliberately the SAME code the
 * `GRID_ALLOW_AGENT_ORG_MEMORY` deployment gate emits: to the agent both are
 * "policy says no", and a second code would need a second branch on a path
 * whose whole point is to degrade identically. The MESSAGES differ, and that
 * is the point of them: this one names the missing permission, the deployment
 * gate names the deployment. This check runs FIRST (ADR-0055) so the sentence a
 * person is finally shown is the one that is true about them — the ordering
 * used to be the other way round, and with the off-switch defaulting to off
 * every permission denial in every ordinary deployment reached the user as
 * "this feature is switched off".
 */
export async function assertAgentMayWriteOrgMemory(actor: AgentMemoryActor): Promise<void> {
  const role = await resolveMembershipRole(actor.organizationId, actor.organizationMembershipId)
  if (await orgRoleHoldsPermission(role, ORG_PERMISSIONS.memoryWrite)) return

  console.warn(
    `[memory] Refused an agent organization-scoped write: the acting membership ` +
      `does not hold ${ORG_PERMISSIONS.memoryWrite}`
  )
  throw new OrgMemoryDisabledError(
    `The acting user may not record organization-wide memory: their role does not hold ` +
      `${ORG_PERMISSIONS.memoryWrite}`
  )
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
    return executeRows(result).length
  } catch (error) {
    console.warn('[memory] Feedback implication failed (non-fatal):', error)
    return 0
  }
}
