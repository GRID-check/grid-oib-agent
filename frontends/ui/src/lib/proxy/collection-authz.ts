/**
 * Collection-name authorization for the backend proxy routes.
 *
 * The `/api/v1/[...path]` proxy forwards collection-scoped requests (uploads,
 * document listings, deletions) to the backend. Before forwarding, the
 * collection named in the path must be authorized against the caller:
 *
 * - the base corpus is never writable through the proxy;
 * - `proj_*` collections must belong to a project in the caller's org AND the
 *   caller needs `project:edit` on that project;
 * - `s_*` (session) collections must match the active conversation id;
 * - anything else is rejected.
 *
 * Session/DB/WorkOS lookups are injectable (`CollectionAuthzDeps`) so the
 * decision logic is unit-testable without a database.
 */

import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projects } from '@/lib/db/schema'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import { errorEnvelope, handleAuthzError } from '@/lib/backend-proxy'

/** The projectId/conversationId context a proxy request was made in. */
export interface ProxyRequestContext {
  projectId?: string
  conversationId?: string
}

/** Extract the request context from query parameters. */
export function parseQueryContext(searchParams: URLSearchParams): ProxyRequestContext {
  return {
    projectId: searchParams.get('projectId') || undefined,
    conversationId: searchParams.get('conversationId') || undefined,
  }
}

/**
 * Extract the request context from a parsed JSON body. Accepts the backend's
 * `session_id` alias for the conversation id.
 */
export function parseBodyContext(parsedBody: Record<string, unknown> | undefined): ProxyRequestContext {
  return {
    projectId: typeof parsedBody?.projectId === 'string' ? parsedBody.projectId : undefined,
    conversationId:
      typeof parsedBody?.conversationId === 'string'
        ? parsedBody.conversationId
        : typeof parsedBody?.session_id === 'string'
          ? parsedBody.session_id
          : undefined,
  }
}

/** Resolve the request context, preferring body fields over query parameters. */
export function resolveRequestContext(
  searchParams: URLSearchParams,
  parsedBody?: Record<string, unknown>,
): ProxyRequestContext {
  const queryContext = parseQueryContext(searchParams)

  if (!parsedBody) {
    return queryContext
  }

  const bodyContext = parseBodyContext(parsedBody)
  return {
    projectId: bodyContext.projectId ?? queryContext.projectId,
    conversationId: bodyContext.conversationId ?? queryContext.conversationId,
  }
}

export function normalizeSessionCollectionName(value: string): string {
  return value.startsWith('s_') ? value : `s_${value}`
}

/** Injectable data/authz lookups so the decision logic is unit-testable. */
export interface CollectionAuthzDeps {
  /** Find the project id owning `collectionName` inside `organizationId`, or null. */
  findProjectIdByCollection(collectionName: string, organizationId: string): Promise<string | null>
  /** Throws (NotFoundError) when the session lacks the permission on the project. */
  requireProjectAccess(session: AuthorizedSession, projectId: string, permission: 'project:edit'): Promise<unknown>
}

const defaultDeps: CollectionAuthzDeps = {
  async findProjectIdByCollection(collectionName, organizationId) {
    const db = getDb()
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.collectionName, collectionName), eq(projects.organizationId, organizationId)))
      .limit(1)
    return project?.id ?? null
  },
  requireProjectAccess: (session, projectId, permission) => requireProjectAccess(session, projectId, permission),
}

/**
 * Authorize the collection named in a `/v1/collections/<name>/...` proxy path.
 * Returns an error `Response` (proxy error envelope) to short-circuit with,
 * or null when the request may proceed. Paths that are not collection-scoped
 * always pass.
 */
export async function validateCollectionName(
  path: string[],
  session: GridSession | null,
  context: ProxyRequestContext,
  deps: CollectionAuthzDeps = defaultDeps,
): Promise<Response | null> {
  if (path.length < 2 || path[0] !== 'collections') {
    return null
  }

  const collectionName = path[1]
  const baseName = process.env.BASE_COLLECTION_NAME || 'oib_knowledge'

  if (collectionName === baseName) {
    return errorEnvelope(400, 'INVALID_COLLECTION', 'Uploads to the base corpus are not allowed')
  }

  if (collectionName.startsWith('proj_')) {
    if (!session?.organizationId) {
      return handleAuthzError(new Error('Forbidden'))
    }
    try {
      const projectId = await deps.findProjectIdByCollection(collectionName, session.organizationId)

      if (!projectId) {
        return handleAuthzError(new Error('Not found'))
      }

      await deps.requireProjectAccess(session as AuthorizedSession, projectId, 'project:edit')
    } catch (error) {
      return handleAuthzError(error)
    }
    return null
  }

  if (collectionName.startsWith('s_')) {
    if (!context.conversationId || normalizeSessionCollectionName(context.conversationId) !== collectionName) {
      return errorEnvelope(400, 'INVALID_COLLECTION', 'Collection does not match active conversation')
    }
    return null
  }

  return errorEnvelope(400, 'INVALID_COLLECTION', 'Invalid collection name')
}
