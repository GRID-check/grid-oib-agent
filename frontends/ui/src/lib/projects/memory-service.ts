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

function contentTokens(content: string): Set<string> {
  return new Set(normalizeContent(content).split(' ').filter(Boolean))
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared++
  return shared / (a.size + b.size - shared)
}

/**
 * Paraphrase-level dedup: finds an ACTIVE item in the same scope AND of the
 * same kind whose token set nearly matches the incoming content. Kind-exact
 * because a decision and a constraint about the same subject are different
 * findings even when they share most words. Pure JS over a bounded candidate
 * list — the §3.2 embed-based consolidation still supersedes this later.
 */
async function findActiveNearDuplicate(
  values: Pick<NewProjectMemoryItem, 'scope' | 'projectId' | 'organizationId' | 'content' | 'kind'>,
): Promise<ProjectMemoryItem | null> {
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
  return best
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

export async function createProjectMemoryItem(values: NewProjectMemoryItem): Promise<ProjectMemoryItem> {
  const db = getDb()

  // Write-time de-duplication: a repeated finding refreshes the existing row
  // (recency + best-known confidence) instead of adding a duplicate. Exact
  // normalized equality first, then a same-kind paraphrase (token-overlap)
  // pass so a restated finding merges too (design §3.2). This is the single
  // writer, so an app-level check is race-safe enough here; a DB uniqueness
  // constraint is a hardening follow-up (design §3.2).
  const duplicate = (await findActiveDuplicate(values)) ?? (await findActiveNearDuplicate(values))
  if (duplicate) {
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

  try {
    const [item] = await db.insert(projectMemory).values(values).returning()
    return item
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
): Promise<ProjectMemoryItem | null> {
  const db = getDb()
  const [project] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!project) return null

  return createProjectMemoryItem({
    ...values,
    scope: 'project',
    projectId,
    organizationId: project.organizationId,
  })
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
