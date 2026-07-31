import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projectMemory, projects } from '@/lib/db/schema'
import type {
  NewProjectMemoryItem,
  ProjectMemoryConfidence,
  ProjectMemoryItem,
} from '@/lib/db/schema'

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
 * Normalize content for duplicate detection: lowercase, non-alphanumerics
 * collapsed to single spaces, trimmed. Must stay in lock-step with the SQL
 * expression in `findActiveDuplicate` so JS and Postgres agree on equality.
 */
function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * A normalized-content equality condition (Postgres side of `normalizeContent`).
 * `btrim(regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g'))`.
 */
function normalizedContentEquals(content: string) {
  return sql`btrim(regexp_replace(lower(${projectMemory.content}), '[^a-z0-9]+', ' ', 'g')) = ${normalizeContent(content)}`
}

/** Scope-exact owner condition shared by both dedup passes. */
function memoryOwnerCondition(
  values: Pick<NewProjectMemoryItem, 'scope' | 'projectId' | 'organizationId'>,
) {
  return values.scope === 'organization'
    ? and(
        eq(projectMemory.scope, 'organization'),
        eq(projectMemory.organizationId, values.organizationId),
        isNull(projectMemory.projectId),
      )
    : and(eq(projectMemory.scope, 'project'), eq(projectMemory.projectId, values.projectId as string))
}

/**
 * The write-time de-duplication gate (a pragmatic first slice of design §3.2).
 * Finds an existing ACTIVE item in the same scope whose content normalizes to
 * the same string, so a repeated finding updates in place instead of adding a
 * duplicate row. Scope-exact: project items match the project; org items match
 * the org and require project_id IS NULL.
 */
async function findActiveDuplicate(
  values: Pick<NewProjectMemoryItem, 'scope' | 'projectId' | 'organizationId' | 'content'>,
): Promise<ProjectMemoryItem | null> {
  const db = getDb()
  const [existing] = await db
    .select()
    .from(projectMemory)
    .where(and(memoryOwnerCondition(values), eq(projectMemory.status, 'active'), normalizedContentEquals(values.content)))
    .orderBy(desc(projectMemory.updatedAt))
    .limit(1)
  return existing ?? null
}

/**
 * Token overlap above which two same-kind findings are the same fact restated
 * (paraphrase-level dedup, design §3.2). Deliberately high: a false positive
 * merges two distinct findings and loses one; a false negative only costs a
 * redundant row the user can prune.
 */
const NEAR_DUP_JACCARD_THRESHOLD = 0.8
/** Bound on the candidate scan (most recently updated active items in scope). */
const NEAR_DUP_CANDIDATE_LIMIT = 200
/** Very short findings have jumpy token sets; keep them exact-dup only. */
const NEAR_DUP_MIN_TOKENS = 3

/**
 * Negation particles whose presence flips what a finding asserts.
 *
 * A correction is token-wise almost identical to the claim it corrects:
 * "OIB-RL 2.1 is not applicable" vs "OIB-RL 2.1 is applicable" score 0.91
 * Jaccard, well over NEAR_DUP_JACCARD_THRESHOLD. Merging those keeps the OLD
 * row and only refreshes its confidence and timestamps — so the correction is
 * discarded and the stale claim survives looking freshly confirmed. Polarity is
 * therefore checked BEFORE any merge: opposed polarity is a contradiction, and
 * a contradiction supersedes instead of merging.
 */
const NEGATION_TOKENS = new Set([
  // English
  'not',
  'no',
  'never',
  'without',
  'cannot',
  'none',
  'neither',
  'nor',
  // German
  'nicht',
  'kein',
  'keine',
  'keinen',
  'keinem',
  'keiner',
  'keines',
  'nie',
  'niemals',
  'ohne',
  'weder',
])

/**
 * Boolean literals, which flip meaning the same way a negation does — findings
 * routinely carry flag values verbatim ("betriebsanlage=false").
 */
const BOOLEAN_TOKENS = new Set(['true', 'false', 'yes', 'ja', 'nein', 'wahr', 'falsch'])

function contentTokenList(content: string): string[] {
  return normalizeContent(content).split(' ').filter(Boolean)
}

function contentTokens(content: string): Set<string> {
  return new Set(contentTokenList(content))
}

/**
 * A comparable summary of what a content asserts: negation PARITY (double
 * negation reads positive again) plus the boolean literals it carries. Two
 * contents whose signatures differ assert opposite things.
 */
function polaritySignature(content: string): string {
  let negations = 0
  const booleans: string[] = []
  for (const token of contentTokenList(content)) {
    if (NEGATION_TOKENS.has(token)) negations++
    else if (BOOLEAN_TOKENS.has(token)) booleans.push(token)
  }
  return `${negations % 2}|${[...new Set(booleans)].sort().join(',')}`
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return shared / (a.size + b.size - shared)
}

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
  values: Pick<NewProjectMemoryItem, 'scope' | 'projectId' | 'organizationId' | 'content' | 'kind'>,
): Promise<NearMatch | null> {
  const incomingTokens = contentTokens(values.content)
  if (incomingTokens.size < NEAR_DUP_MIN_TOKENS) return null
  const db = getDb()
  const candidates = await db
    .select()
    .from(projectMemory)
    .where(
      and(memoryOwnerCondition(values), eq(projectMemory.status, 'active'), eq(projectMemory.kind, values.kind)),
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
  supersedesContent: string,
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
  options: { includeArchived?: boolean; organizationId?: string; sourceConversationId?: string } = {},
): Promise<ProjectMemoryItem[]> {
  const db = getDb()

  // Project items, plus the org-wide items that apply to every project.
  // Defense-in-depth: when the caller knows the organization, the project
  // branch is additionally constrained to that org so a projectId from
  // another tenant can never match.
  const projectCondition = options.organizationId
    ? and(
        eq(projectMemory.projectId, projectId),
        eq(projectMemory.organizationId, options.organizationId),
      )
    : eq(projectMemory.projectId, projectId)
  const scopeCondition = options.organizationId
    ? or(
        projectCondition,
        and(
          eq(projectMemory.scope, 'organization'),
          eq(projectMemory.organizationId, options.organizationId),
          isNull(projectMemory.projectId),
        ),
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
  options: { includeArchived?: boolean } = {},
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
  values: NewProjectMemoryItem,
): Promise<ProjectMemoryItem> {
  const db = getDb()
  const incoming = (values.confidence ?? 'medium') as ProjectMemoryConfidence
  const best =
    CONFIDENCE_RANK[incoming] > CONFIDENCE_RANK[duplicate.confidence] ? incoming : duplicate.confidence
  const [updated] = await db
    .update(projectMemory)
    .set({ confidence: best, lastReferencedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectMemory.id, duplicate.id))
    .returning()
  return updated ?? duplicate
}

export async function createProjectMemoryItem(
  values: NewProjectMemoryItem,
  options: CreateMemoryOptions = {},
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

  const near = await findActiveNearMatch(values)
  if (near && !near.opposedPolarity) return refreshDuplicate(near.item, values)

  const candidate =
    near?.item ??
    (options.supersedesContent?.trim()
      ? await resolveSupersedeTarget(values, options.supersedesContent)
      : null)

  let supersedeTarget: ProjectMemoryItem | null = null
  if (candidate) {
    if (isAgentSupersedable(candidate)) {
      supersedeTarget = candidate
    } else {
      // Both stay active and the user resolves it in the memory panel — the
      // new finding is still recorded, it just doesn't retire a human's entry.
      console.warn(
        `[memory] Not superseding human-curated item ${candidate.id} (pinned/user-confirmed/user-authored)`
      )
    }
  }

  const insertValues: NewProjectMemoryItem = supersedeTarget
    ? { ...values, supersedesId: supersedeTarget.id }
    : values

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
export async function createProjectMemoryItemForProject(
  projectId: string,
  values: Omit<NewProjectMemoryItem, 'projectId' | 'organizationId' | 'scope'>,
  options: CreateMemoryOptions = {},
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
    options,
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
  >,
): Promise<ProjectMemoryItem | null> {
  const db = getDb()
  const ownerCondition =
    'projectId' in owner
      ? eq(projectMemory.projectId, owner.projectId)
      : and(eq(projectMemory.scope, 'organization'), eq(projectMemory.organizationId, owner.organizationId))
  const [item] = await db
    .update(projectMemory)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(projectMemory.id, itemId), ownerCondition))
    .returning()
  return item ?? null
}

export async function deleteProjectMemoryItem(
  owner: { projectId: string } | { organizationId: string },
  itemId: string,
): Promise<boolean> {
  const db = getDb()
  const ownerCondition =
    'projectId' in owner
      ? eq(projectMemory.projectId, owner.projectId)
      : and(eq(projectMemory.scope, 'organization'), eq(projectMemory.organizationId, owner.organizationId))
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
export function formatDigestLines(items: DigestItem[]): string | null {
  if (items.length === 0) return null

  const lines: string[] = ['PROJECT_MEMORY v1']
  let used = lines[0].length
  for (const item of items) {
    const content = item.content.replace(/\s+/g, ' ').trim()
    if (!content) continue
    const escaped = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const scopeTag = item.scope === 'organization' ? 'org-wide | ' : ''
    const line = `- [${scopeTag}${item.kind} | ${item.confidence} | ${item.verification}] "${escaped}"`
    if (used + line.length + 1 > DIGEST_MAX_CHARS) break
    lines.push(line)
    used += line.length + 1
  }

  return lines.length > 1 ? lines.join('\n') : null
}

/**
 * Build the bounded "core memory" digest injected as the
 * `x-grid-project-memory` header on the WS upgrade. Merges org-wide and
 * project items (pinned first, then most recently updated), each line tagged
 * with scope/kind/confidence/verification so the model can weigh it; the
 * content itself is quoted/escaped by formatDigestLines so it cannot forge
 * tag lines.
 *
 * Returns null when there is no active memory (header is then omitted).
 */
export async function buildProjectMemoryDigest(
  projectId: string | undefined,
  organizationId: string | undefined,
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
            eq(projectMemory.organizationId, organizationId),
          )
        : eq(projectMemory.projectId, projectId),
    )
  }
  if (organizationId) {
    scopeConditions.push(
      and(
        eq(projectMemory.scope, 'organization'),
        eq(projectMemory.organizationId, organizationId),
        isNull(projectMemory.projectId),
      ),
    )
  }

  const items = await db
    .select({
      scope: projectMemory.scope,
      kind: projectMemory.kind,
      content: projectMemory.content,
      confidence: projectMemory.confidence,
      verification: projectMemory.verification,
      pinned: projectMemory.pinned,
    })
    .from(projectMemory)
    .where(and(scopeConditions.length > 1 ? or(...scopeConditions) : scopeConditions[0], eq(projectMemory.status, 'active')))
    .orderBy(desc(projectMemory.pinned), desc(projectMemory.updatedAt))
    .limit(DIGEST_MAX_ITEMS)

  return formatDigestLines(items)
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
