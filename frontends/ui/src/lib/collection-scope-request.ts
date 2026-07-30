import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projects, userPreferences } from '@/lib/db/schema'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import {
  buildCollectionScopeHeader,
  computeCollectionScope,
  type ScopeContext,
} from '@/lib/collection-scope'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { archivCollectionName } from '@/lib/archiv/collection'
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

/**
 * Authorize a caller-supplied `conversationId` before it becomes chat scope.
 *
 * This is the gate on the WebSocket upgrade, and it is the only thing standing
 * between "I know a conversation id" and "my prompt runs inside that thread".
 * The finished assistant turn is persisted through the internal service path,
 * whose only tenancy gate is `findConversationInOrg` — so without this check any
 * signed-in org member could open a turn on a colleague's private conversation
 * and have the answer written into it and fanned out to its real participants.
 * ADR-0034 accepts an unenforced agent turn only on the premise that the thread
 * is one the caller can already reach; this is that premise, enforced.
 *
 * **Absent is fine; existing-but-unreachable is not.** Conversation ids are
 * client-generated and the row is created by the first message, so the normal
 * first-message upgrade legitimately names an id that does not exist yet.
 * `requireResourceAccess` cannot make that distinction on its own — it answers
 * `NotFoundError` for "missing" and "not yours" alike, deliberately (spec SH-6) —
 * so existence is probed first and only an EXISTING row is authorized. The cost
 * is one extra indexed lookup per upgrade that carries a conversation id.
 *
 * Requires `viewer`: opening a turn is not contributing yet (the message POST
 * demands `collaborator` in its own right), but reading the thread's context is
 * the least the caller must be entitled to.
 */
async function authorizeConversationScope(
  session: AuthorizedSession,
  conversationId: string,
): Promise<void> {
  const tenancy = await findConversationTenancy(conversationId)
  if (!tenancy) return
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')
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

  // The conversation is authorized as well as the project. Both are
  // caller-supplied, and until this ran only the project was ever checked.
  if (conversationId && session && !anonymous) {
    await authorizeConversationScope(session as AuthorizedSession, conversationId)
  }

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

  // Inject the org-wide Archiv collection for every authenticated request in an
  // org that has the feature enabled — this is what makes the Archiv "shared
  // across every project" (ADR-0024). Anonymous requests have no org, so none.
  const archivCollection =
    session?.organizationId && !anonymous && isFeatureEnabled(session, FEATURE_FLAGS.orgArchiv)
      ? archivCollectionName(session.organizationId)
      : undefined

  const scope = computeCollectionScope(session, {
    projectId,
    projectCollectionName,
    includeProject,
    conversationId,
    archivCollectionName: archivCollection,
  } satisfies ScopeContext)

  return {
    scope,
    headerValue: buildCollectionScopeHeader(scope),
    projectId,
    projectCollectionName,
    conversationId,
  }
}
