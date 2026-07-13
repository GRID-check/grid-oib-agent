import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projects, userPreferences } from '@/lib/db/schema'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  buildCollectionScopeHeader,
  computeCollectionScope,
  type ScopeContext,
} from '@/lib/collection-scope'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'

export interface RequestContext {
  projectId?: string
  includeProject?: boolean
  conversationId?: string
}

function isAuthRequired(): boolean {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

export async function resolveActiveProjectId(
  session: GridSession | null,
  explicitProjectId?: string,
): Promise<string | undefined> {
  if (explicitProjectId) {
    return explicitProjectId
  }

  if (!session) {
    return undefined
  }

  const db = getDb()
  const [row] = await db
    .select({ prefs: userPreferences.prefs })
    .from(userPreferences)
    .where(eq(userPreferences.workosUserId, session.userId))
    .limit(1)

  if (row?.prefs && typeof row.prefs === 'object') {
    const activeId = (row.prefs as Record<string, unknown>).active_project_id
    if (typeof activeId === 'string' && activeId) {
      return activeId
    }
  }

  return undefined
}

async function resolveProjectCollectionName(
  projectId: string | undefined,
  organizationId: string | undefined,
): Promise<string | undefined> {
  if (!projectId || !organizationId) {
    return undefined
  }

  const db = getDb()
  const [project] = await db
    .select({ collectionName: projects.collectionName })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    .limit(1)

  return project?.collectionName
}

export async function buildCollectionScopeFromRequest(
  session: GridSession | null,
  context: RequestContext,
): Promise<{
  scope: string[]
  headerValue: string
  projectId: string | undefined
  projectCollectionName: string | undefined
  conversationId: string | undefined
}> {
  const anonymous = !isAuthRequired()

  const includeProject = context.includeProject !== false

  let projectId = includeProject ? context.projectId : undefined
  const explicitProject = Boolean(projectId)
  if (includeProject && !projectId && session && !anonymous) {
    projectId = await resolveActiveProjectId(session, undefined)
  }

  const conversationId = context.conversationId

  if (projectId && session && !anonymous) {
    if (explicitProject) {
      await requireProjectAccess(session as AuthorizedSession, projectId, 'project:view')
    } else {
      // Implicit fallback from the stored active_project_id preference, which
      // can go stale (project soft-deleted, membership revoked) and is never
      // cleaned up. Throwing here would break every request that omits
      // projectId — global listings 404, general chat WS upgrades 403 — so
      // degrade to an unscoped request instead of failing.
      try {
        await requireProjectAccess(session as AuthorizedSession, projectId, 'project:view')
      } catch {
        projectId = undefined
      }
    }
  }

  const projectCollectionName = includeProject
    ? await resolveProjectCollectionName(projectId, session?.organizationId ?? undefined)
    : undefined

  const scope = computeCollectionScope(session, {
    projectId,
    projectCollectionName,
    includeProject,
    conversationId,
  } satisfies ScopeContext)

  return {
    scope,
    headerValue: buildCollectionScopeHeader(scope),
    projectId,
    projectCollectionName,
    conversationId,
  }
}
