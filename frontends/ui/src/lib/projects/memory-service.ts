import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projectMemory, projects } from '@/lib/db/schema'
import type {
  NewProjectMemoryItem,
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

export async function listProjectMemory(
  projectId: string,
  options: { includeArchived?: boolean; organizationId?: string } = {},
): Promise<ProjectMemoryItem[]> {
  const db = getDb()

  // Project items, plus the org-wide items that apply to every project.
  const scopeCondition = options.organizationId
    ? or(
        eq(projectMemory.projectId, projectId),
        and(
          eq(projectMemory.scope, 'organization'),
          eq(projectMemory.organizationId, options.organizationId),
          isNull(projectMemory.projectId),
        ),
      )
    : eq(projectMemory.projectId, projectId)

  const conditions = [scopeCondition]
  if (!options.includeArchived) {
    conditions.push(eq(projectMemory.status, 'active'))
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
  const [item] = await db.insert(projectMemory).values(values).returning()
  return item
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

/**
 * Build the bounded "core memory" digest injected as the
 * `x-grid-project-memory` header on the WS upgrade. Merges org-wide and
 * project items (pinned first, then most recently updated), each line tagged
 * with scope/kind/confidence/verification so the model can weigh it.
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
    scopeConditions.push(eq(projectMemory.projectId, projectId))
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

  if (items.length === 0) return null

  const lines: string[] = ['PROJECT_MEMORY v1']
  let used = lines[0].length
  for (const item of items) {
    const content = item.content.replace(/\s+/g, ' ').trim()
    if (!content) continue
    const scopeTag = item.scope === 'organization' ? 'org-wide | ' : ''
    const line = `- [${scopeTag}${item.kind} | ${item.confidence} | ${item.verification}] ${content}`
    if (used + line.length + 1 > DIGEST_MAX_CHARS) break
    lines.push(line)
    used += line.length + 1
  }

  return lines.length > 1 ? lines.join('\n') : null
}
