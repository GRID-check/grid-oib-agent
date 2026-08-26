import { findProjectCollectionName } from '@/lib/projects/repository'
import { findUserPreferencesForSession } from '@/lib/user-preferences/repository'
import { requireProjectAccess } from '@/lib/authz/projects'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import {
  computeCollectionScope,
  sessionCollectionName,
  type CollectionShelf,
  type ScopeContext,
  type ScopedCollection,
} from '@/lib/collection-scope'
import { FEATURE_FLAGS, isFeatureEnabled } from '@/lib/authz/feature-flags'
import { archivCollectionName } from '@/lib/archiv/collection'
import type { AuthorizedSession, GridSession } from '@/lib/auth/types'

export interface RequestContext {
  projectId?: string
  includeProject?: boolean
  conversationId?: string
}

/**
 * Which shelf a retrieved chunk came from (ADR-0047, "The contract").
 *
 * Re-exported from `collection-scope.ts`, which owns the declaration so the
 * request-context contract can name the type without depending on this
 * service-heavy builder. Kept exported here because this module is where
 * callers meet the shelf.
 */
export type { CollectionShelf, ScopedCollection } from '@/lib/collection-scope'

/**
 * The base knowledge corpus name, resolved ONCE here and handed to
 * `computeCollectionScope` explicitly, so the name that lands in the scope
 * array is by construction the same string this module labelled `base`. The
 * literal mirrors `collection-scope.ts`'s fallback; passing it through means
 * only one of the two values is ever live at runtime.
 */
function resolveBaseCollectionName(): string {
  return process.env.BASE_COLLECTION_NAME || 'oib_knowledge'
}

/**
 * `base64url(JSON.stringify(ScopedCollection[]))` — same header name, same
 * framing as the legacy bare `string[]` payload, so a reader can accept both
 * during rollout (ADR-0047 consequences: "the reader tolerates a missing
 * shelf").
 */
export function encodeCollectionScopeHeader(collections: ScopedCollection[]): string {
  return Buffer.from(JSON.stringify(collections)).toString('base64url')
}

function isAuthRequired(): boolean {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

export async function resolveActiveProjectId(
  session: GridSession | null,
  explicitProjectId?: string
): Promise<string | undefined> {
  if (explicitProjectId) {
    return explicitProjectId
  }

  if (!session) {
    return undefined
  }

  const prefs = await findUserPreferencesForSession(session.userId, session.organizationId)

  if (prefs && typeof prefs === 'object') {
    const activeId = prefs.active_project_id
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
  conversationId: string
): Promise<void> {
  const tenancy = await findConversationTenancy(conversationId)
  if (!tenancy) return
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')
}

async function resolveProjectCollectionName(
  projectId: string | undefined,
  organizationId: string | undefined
): Promise<string | undefined> {
  if (!projectId || !organizationId) {
    return undefined
  }

  return (await findProjectCollectionName(projectId, organizationId)) ?? undefined
}

/**
 * Resolve (and authorize) the retrieval scope for a request, and encode it for
 * the wire.
 *
 * `headerValue` is the `X-Grid-Collection-Scope` payload:
 * `base64url(JSON.stringify([{ collection, shelf? }, ...]))`. It used to be a
 * bare `string[]`, which erased the shelf at this boundary and forced two
 * downstream re-derivations from `archiv_`/`proj_`/`s_` name prefixes
 * (ADR-0047). The framing is unchanged so a reader can accept both shapes
 * during rollout.
 *
 * `scope` stays a bare id list — it is what callers echo back to clients and
 * what non-shelf-aware paths pass along; the shelves live on the header.
 */
export async function buildCollectionScopeFromRequest(
  session: GridSession | null,
  context: RequestContext
): Promise<{
  scope: string[]
  scopedCollections: ScopedCollection[]
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
      // The collection scope is what a chat request retrieves against, so
      // reaching it is chatting in the project — `project:chat`, not
      // `project:view`. A reader gets the project's documents through the
      // documents API; they do not get the agent pointed at them.
      await requireProjectAccess(session as AuthorizedSession, projectId, CHAT_PERMISSIONS)
    } else {
      // Implicit fallback from the stored active_project_id preference, which
      // can go stale (project soft-deleted, membership revoked) and is never
      // cleaned up. Throwing here would break every request that omits
      // projectId — global listings 404, general chat WS upgrades 403 — so
      // degrade to an unscoped request instead of failing.
      try {
        await requireProjectAccess(session as AuthorizedSession, projectId, CHAT_PERMISSIONS)
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

  // Every collection below is BUILT here, so its shelf is known here (ADR-0047:
  // the shelf travels as data). Nothing re-reads a name to recover it — the map
  // is keyed by the exact string this function just constructed, and a name it
  // did not construct simply has no entry and therefore no shelf.
  const baseCollection = resolveBaseCollectionName()
  const projectCollection = includeProject
    ? (projectCollectionName ?? (projectId ? `proj_${projectId}` : undefined))
    : undefined
  const sessionCollection = conversationId ? sessionCollectionName(conversationId) : undefined

  const shelfByCollection = new Map<string, CollectionShelf>()
  // The base knowledge corpus, and nothing else, is `base`.
  shelfByCollection.set(baseCollection, 'base')
  if (archivCollection) shelfByCollection.set(archivCollection, 'archiv')
  if (projectCollection) shelfByCollection.set(projectCollection, 'project')
  if (sessionCollection) shelfByCollection.set(sessionCollection, 'session')

  const scope = computeCollectionScope(session, {
    projectId,
    projectCollectionName: projectCollection,
    includeProject,
    conversationId: sessionCollection,
    archivCollectionName: archivCollection,
    baseCollection,
  } satisfies ScopeContext)

  const scopedCollections: ScopedCollection[] = scope.map((collection) => {
    const shelf = shelfByCollection.get(collection)
    // No shelf → omit the field. Unknown stays unknown; it is never defaulted.
    return shelf ? { collection, shelf } : { collection }
  })

  return {
    scope,
    // The shelf-bearing form, for the SIGNED envelope as well as the raw
    // header. The envelope is the authoritative copy — `scoping.py` honours the
    // raw header only when no valid envelope is present — so a shelf that rode
    // the header alone would never reach an authenticated turn (ADR-0047).
    scopedCollections,
    headerValue: encodeCollectionScopeHeader(scopedCollections),
    projectId,
    projectCollectionName,
    conversationId,
  }
}
