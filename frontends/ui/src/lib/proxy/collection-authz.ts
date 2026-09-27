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
 * - `s_*` (session) collections must match the active conversation id, and a
 *   WRITE (anything but GET) needs the conversation to exist and `collaborator`
 *   on it — a viewer of a shared chat may read its attachments, not delete
 *   them, and a conversation id nobody created is not a place to upload to;
 * - a whole collection is never deleted through the proxy, except a chat's own
 *   (`s_*`), and that one only by whoever may delete the chat itself;
 * - a proxied upload into a project or the Archiv is refused: those shelves
 *   have first-party routes that write the document row and run the file-type
 *   and storage-quota admission, and the raw ingest path runs neither;
 * - `GET /v1/collections` (every collection of every tenant) is refused;
 * - anything else is rejected.
 *
 * Session/DB/WorkOS lookups are injectable (`CollectionAuthzDeps`) so the
 * decision logic is unit-testable without a database.
 */

import { findProjectIdByCollectionName } from '@/lib/projects/repository'
import { requireProjectAccess, type ProjectPermission } from '@/lib/authz/projects'
import { requireResourceAccess } from '@/lib/sharing/access'
import { requireConversationDeleteAccess } from '@/lib/conversations/service'

/** Writes into a project's corpus, accepting the pre-split umbrella too. */
const PROJECT_UPLOAD: readonly ProjectPermission[] = ['project:documents:write', 'project:edit']
import { canManageArchiv } from '@/lib/authz/organizations'
import { archivCollectionName } from '@/lib/archiv/collection'
import { sessionCollectionName } from '@/lib/collection-scope'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'
import { errorEnvelope, handleAuthzError } from '@/lib/backend-proxy'

/** The projectId/conversationId context a proxy request was made in. */
export interface ProxyRequestContext {
  projectId?: string
  conversationId?: string
  /** `POST /v1/collections` names the collection it creates in its body. */
  collectionName?: string
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
export function parseBodyContext(
  parsedBody: Record<string, unknown> | undefined
): ProxyRequestContext {
  return {
    projectId: typeof parsedBody?.projectId === 'string' ? parsedBody.projectId : undefined,
    conversationId:
      typeof parsedBody?.conversationId === 'string'
        ? parsedBody.conversationId
        : typeof parsedBody?.session_id === 'string'
          ? parsedBody.session_id
          : undefined,
    collectionName: typeof parsedBody?.name === 'string' ? parsedBody.name : undefined,
  }
}

/** Resolve the request context, preferring body fields over query parameters. */
export function resolveRequestContext(
  searchParams: URLSearchParams,
  parsedBody?: Record<string, unknown>
): ProxyRequestContext {
  const queryContext = parseQueryContext(searchParams)

  if (!parsedBody) {
    return queryContext
  }

  const bodyContext = parseBodyContext(parsedBody)
  return {
    projectId: bodyContext.projectId ?? queryContext.projectId,
    conversationId: bodyContext.conversationId ?? queryContext.conversationId,
    ...(bodyContext.collectionName ? { collectionName: bodyContext.collectionName } : {}),
  }
}

/**
 * Re-exported under the name this module's callers already use. The rule itself
 * lives in `@/lib/collection-scope` — one definition, because a disagreement
 * between the name a request is authorized against and the name it is written
 * to is a cross-conversation read.
 */
export { sessionCollectionName as normalizeSessionCollectionName }

/** Injectable data/authz lookups so the decision logic is unit-testable. */
export interface CollectionAuthzDeps {
  /** Find the project id owning `collectionName` inside `organizationId`, or null. */
  findProjectIdByCollection(collectionName: string, organizationId: string): Promise<string | null>
  /** Throws (NotFoundError) when the session lacks the permission on the project. */
  requireProjectAccess(
    session: AuthorizedSession,
    projectId: string,
    permission: readonly ProjectPermission[]
  ): Promise<unknown>
  /**
   * Throws (NotFoundError) unless the conversation exists and the caller holds
   * `collaborator` on it — the access attaching a file needs.
   */
  requireConversationCollaborator(session: AuthorizedSession, conversationId: string): Promise<unknown>
  /** Throws (NotFoundError) unless the caller may delete the conversation. */
  requireConversationDelete(session: AuthorizedSession, conversationId: string): Promise<unknown>
}

const defaultDeps: CollectionAuthzDeps = {
  async findProjectIdByCollection(collectionName, organizationId) {
    return findProjectIdByCollectionName(collectionName, organizationId)
  },
  requireProjectAccess: (session, projectId, permission) =>
    requireProjectAccess(session, projectId, permission),
  requireConversationCollaborator: (session, conversationId) =>
    requireResourceAccess(session, 'conversation', conversationId, 'collaborator'),
  requireConversationDelete: (session, conversationId) =>
    requireConversationDeleteAccess(session, conversationId),
}

export interface ValidateCollectionOptions {
  /** The HTTP method; reads and writes are authorized differently. Default GET. */
  method?: string
  deps?: CollectionAuthzDeps
}

/** Where a shelf's uploads go instead of the raw ingest path. */
const FIRST_PARTY_UPLOAD: Record<'proj_' | 'archiv_', string> = {
  proj_: '/api/documents/upload',
  archiv_: '/api/archiv/documents/upload',
}

function refuseWholeCollectionDelete(): Response {
  return errorEnvelope(403, 'FORBIDDEN', 'Deleting a whole collection is not allowed')
}

function refuseRawUpload(prefix: 'proj_' | 'archiv_'): Response {
  return errorEnvelope(403, 'FORBIDDEN', `Upload through ${FIRST_PARTY_UPLOAD[prefix]}`)
}

/**
 * Authorize the collection named in a `/v1/collections/<name>/...` proxy path.
 * Returns an error `Response` (proxy error envelope) to short-circuit with,
 * or null when the request may proceed. Paths that are not collection-scoped
 * always pass (`./v1-allowlist` decides whether they are forwarded at all).
 */
export async function validateCollectionName(
  path: string[],
  session: GridSession | null,
  context: ProxyRequestContext,
  options: ValidateCollectionOptions = {}
): Promise<Response | null> {
  if (path.length < 1 || path[0] !== 'collections') {
    return null
  }
  const method = (options.method ?? 'GET').toUpperCase()
  const deps = options.deps ?? defaultDeps

  if (path.length === 1) {
    // `GET /v1/collections` lists every collection in the vector store, every
    // tenant's project and chat ids among them.
    if (method !== 'POST') return errorEnvelope(404, 'NOT_FOUND', 'Not found')
    // Creating one is a write INTO the named collection, authorized as such.
    // It names itself, so a chat collection is its own conversation.
    const created = context.collectionName
    if (!created) return errorEnvelope(400, 'INVALID_COLLECTION', 'Collection name is required')
    return authorizeCollection(created, [], method, session, {
      ...context,
      conversationId: context.conversationId ?? created,
    }, deps)
  }

  const wholeCollection = path.length === 2
  // Deleting a whole collection names only itself, so a chat collection is,
  // again, its own conversation (the discard of an abandoned chat sends no
  // conversation id).
  const effectiveContext =
    wholeCollection && method === 'DELETE' && !context.conversationId
      ? { ...context, conversationId: path[1] }
      : context
  return authorizeCollection(path[1], path.slice(2), method, session, effectiveContext, deps)
}

async function authorizeCollection(
  collectionName: string,
  subPath: string[],
  method: string,
  session: GridSession | null,
  context: ProxyRequestContext,
  deps: CollectionAuthzDeps
): Promise<Response | null> {
  const wholeCollectionDelete = method === 'DELETE' && subPath.length === 0
  const upload = method === 'POST' && subPath[0] === 'documents'
  const baseName = process.env.BASE_COLLECTION_NAME || 'oib_knowledge'

  if (collectionName === baseName) {
    return errorEnvelope(400, 'INVALID_COLLECTION', 'Uploads to the base corpus are not allowed')
  }

  if (collectionName.startsWith('proj_')) {
    // A project collection is erased by the project purge, never from a browser.
    if (wholeCollectionDelete) return refuseWholeCollectionDelete()
    // No document row, no file-type gate, no quota: `/api/documents/upload` is
    // the one way bytes enter a project (and nothing in the product posts here).
    if (upload) return refuseRawUpload('proj_')
    if (!session?.organizationId) {
      return handleAuthzError(new Error('Forbidden'))
    }
    try {
      const projectId = await deps.findProjectIdByCollection(collectionName, session.organizationId)

      if (!projectId) {
        return handleAuthzError(new Error('Not found'))
      }

      // Proxy collection routes cover writes (upload/delete) into the project
      // corpus, so the permission is the document one; the umbrella stays
      // accepted for roles provisioned before the ADR-0038 split.
      await deps.requireProjectAccess(session as AuthorizedSession, projectId, PROJECT_UPLOAD)
    } catch (error) {
      return handleAuthzError(error)
    }
    return null
  }

  if (collectionName.startsWith('archiv_')) {
    // The org-wide Archiv collection (ADR-0024). It must be THIS org's Archiv,
    // and — because proxy collection routes cover writes (upload/delete) — the
    // caller needs the manage permission. Reads of the Archiv corpus go through
    // the dedicated `/api/archiv/documents` endpoint, not this proxy.
    if (wholeCollectionDelete) return refuseWholeCollectionDelete()
    if (upload) return refuseRawUpload('archiv_')
    if (!session?.organizationId) {
      return handleAuthzError(new Error('Forbidden'))
    }
    if (
      collectionName !== archivCollectionName(session.organizationId) ||
      !canManageArchiv(session)
    ) {
      return handleAuthzError(new Error('Forbidden'))
    }
    return null
  }

  if (collectionName.startsWith('s_')) {
    if (
      !context.conversationId ||
      sessionCollectionName(context.conversationId) !== collectionName
    ) {
      return errorEnvelope(
        400,
        'INVALID_COLLECTION',
        'Collection does not match active conversation'
      )
    }
    // Reads are authorized by the scope builder (`viewer` on an existing
    // conversation). A write is authorized HERE, on the conversation the
    // collection belongs to — which is the collection's own name, since a
    // conversation id is minted as `s_<uuid>` (`sessionCollectionName`).
    // Anonymous mode has no tenancy to check (and no session to check it with).
    if (method === 'GET' || !session) return null
    try {
      if (wholeCollectionDelete) {
        // The whole of a chat's attachments: the same authority as deleting
        // the chat (`owner`), which is what the discard of an abandoned chat is.
        await deps.requireConversationDelete(session as AuthorizedSession, collectionName)
      } else {
        // Upload, file delete, collection create: `collaborator`, and the row
        // must exist. `requireResourceAccess` answers 404 for a missing, a
        // deleted and a not-yours conversation alike.
        await deps.requireConversationCollaborator(session as AuthorizedSession, collectionName)
      }
    } catch (error) {
      return handleAuthzError(error)
    }
    return null
  }

  return errorEnvelope(400, 'INVALID_COLLECTION', 'Invalid collection name')
}
