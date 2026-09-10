import type { GridSession } from './auth/types'

/**
 * The shelf a retrieval collection sits on, carried explicitly on the wire
 * (ADR-0047). Nothing derives it from an `archiv_`/`proj_`/`s_` name prefix.
 *
 * The five members are the WIRE shelf enum, deliberately NOT the same set as
 * `documents.scope` (the DB shelf) or the ADR-0026 display taxonomy. Each
 * runtime owns its own small, total enum (ADR-0047 decision 3); the Python
 * reader declares its own mirror without importing this one.
 *
 * Declared in this near-leaf module rather than in `collection-scope-request`
 * so the low-level request-context contract can name the type without taking a
 * dependency on the service-heavy builder that produces it.
 */
export type CollectionShelf = 'archiv' | 'project' | 'register' | 'session' | 'base'

/**
 * One entry of the `X-Grid-Collection-Scope` payload and of the signed
 * envelope's `collectionScope`.
 *
 * `shelf` is OMITTED, never guessed, when the BFF cannot attribute the
 * collection: a missing shelf reads downstream as *unknown* and renders
 * unattributed. Defaulting it to `base`/`baurecht` is the fail-open ADR-0047
 * exists to remove.
 */
export interface ScopedCollection {
  collection: string
  shelf?: CollectionShelf
  /**
   * WHICH project this collection belongs to, when it is a project collection
   * (ADR-0054, spec KH-13).
   *
   * The shelf says a chunk came from *a* project; in the Büro that is not
   * enough, because a turn can read five of them and a citation that cannot
   * name its project is a citation nobody can act on. Both fields are set at
   * the one point where they are known for free — the BFF builds the scope, so
   * it holds the project's id and name already — and travel as DATA the whole
   * way down, exactly as the shelf does (ADR-0047). Nothing downstream parses
   * `proj_<uuid>` to recover them.
   *
   * Optional because the other four shelves have no project: absent means "not
   * a project collection", never "we could not tell".
   */
  projectId?: string
  projectName?: string
}

/**
 * The retrieval collection a conversation's private attachments live in.
 *
 * A conversation id is already minted as `s_<uuid>` (see `messages-store.ts`
 * and `jobs/service.ts`), so for every id the app produces this is the identity
 * function; the prefix is added only for a caller that passed a bare id. That
 * is why it is a NORMALISER and not shelf inference — the shelf is `session`
 * because the caller said so, never because the name starts with `s_`.
 *
 * Declared once here, in the leaf module the wire contract already lives in.
 * There were three copies — the scope builder, the request builder and the
 * proxy's collection authorization — and a fourth was about to be written for
 * session documents. A private copy of a name rule is a fork, and this
 * particular rule decides which collection a file is written into and which
 * one a request is allowed to touch: the copies disagreeing is a
 * cross-conversation read.
 */
export function sessionCollectionName(conversationId: string): string {
  return conversationId.startsWith('s_') ? conversationId : `s_${conversationId}`
}

export interface ScopeContext {
  projectId?: string
  projectCollectionName?: string
  includeProject?: boolean
  conversationId?: string
  baseCollection?: string
  /**
   * The org-wide Archiv collection (`archiv_<orgId>`), when the feature is
   * enabled for the caller's org. Added to every scope alongside the base
   * corpus so every project's retrieval also sees the shared Archiv (ADR-0024).
   */
  archivCollectionName?: string
  /**
   * The collections of the projects this conversation has MOUNTED (ADR-0054),
   * already re-authorized by the caller.
   *
   * Passed in rather than resolved here, because deciding which mounts survive
   * is an authorization question and this function is pure. Their position in
   * the array is the hierarchy's: after the office's own shelves, before the
   * conversation's private one.
   */
  mountedCollectionNames?: readonly string[]
}

export function computeCollectionScope(
  _session: GridSession | null,
  context: ScopeContext,
): string[] {
  const scope: string[] = []
  const base = context.baseCollection || process.env.BASE_COLLECTION_NAME || 'oib_knowledge'
  scope.push(base)

  // Org-wide Archiv: shared across every project in the org, so it rides in the
  // scope right next to the base corpus (independent of the active project).
  if (context.archivCollectionName) {
    scope.push(context.archivCollectionName)
  }

  if (context.includeProject !== false) {
    const projectCollectionName = context.projectCollectionName || (context.projectId ? `proj_${context.projectId}` : undefined)
    if (projectCollectionName) {
      scope.push(projectCollectionName)
    }
  }

  for (const mounted of context.mountedCollectionNames ?? []) {
    scope.push(mounted)
  }

  if (context.conversationId) {
    scope.push(sessionCollectionName(context.conversationId))
  }

  return [...new Set(scope)]
}

export function buildCollectionScopeHeader(scope: string[]): string {
  return Buffer.from(JSON.stringify(scope)).toString('base64url')
}
