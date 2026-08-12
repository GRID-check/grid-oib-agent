import type { GridSession } from './auth/types'

/**
 * The shelf a retrieval collection sits on, carried explicitly on the wire
 * (ADR-0047). Nothing derives it from an `archiv_`/`proj_`/`s_` name prefix.
 *
 * The four members are the WIRE shelf enum, deliberately NOT the same set as
 * `documents.scope` (the DB shelf) or the ADR-0026 display taxonomy. Each
 * runtime owns its own small, total enum (ADR-0047 decision 3); the Python
 * reader declares its own mirror without importing this one.
 *
 * Declared in this near-leaf module rather than in `collection-scope-request`
 * so the low-level request-context contract can name the type without taking a
 * dependency on the service-heavy builder that produces it.
 */
export type CollectionShelf = 'archiv' | 'project' | 'session' | 'base'

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

  if (context.conversationId) {
    scope.push(context.conversationId.startsWith('s_') ? context.conversationId : `s_${context.conversationId}`)
  }

  return [...new Set(scope)]
}

export function buildCollectionScopeHeader(scope: string[]): string {
  return Buffer.from(JSON.stringify(scope)).toString('base64url')
}
