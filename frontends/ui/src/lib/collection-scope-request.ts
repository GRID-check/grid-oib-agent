import { findProjectCollectionName } from '@/lib/projects/repository'
import { findUserPreferencesForSession } from '@/lib/user-preferences/repository'
import { requireProjectAccess } from '@/lib/authz/projects'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { restrictedCollectionsForChatScope } from '@/lib/conversations/restricted-use'
import { getProjectFolderAccess } from '@/lib/authz/folder-access'
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
  /**
   * The scope is for an interactive chat turn: the WebSocket upgrade, and
   * nothing else. Only such a scope may carry the restricted-folder collections
   * the session, and everyone the conversation is shared with, is cleared for
   * (ADR-0086). Deep research and scheduled runs file their reports for the
   * whole project, so every other caller leaves this unset and gets none,
   * whoever is asking.
   */
  interactiveChat?: boolean
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
 *
 * Answers whether a row was found and authorized. An absent row passes for the
 * scope above, but it is not a conversation anybody checked, so it is never one
 * the BFF signs as reachable (`verifiedConversationId`, ADR-0084).
 */
async function authorizeConversationScope(
  session: AuthorizedSession,
  conversationId: string
): Promise<boolean> {
  const tenancy = await findConversationTenancy(conversationId)
  if (!tenancy) return false
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')
  return true
}

/**
 * The restricted-folder collections (ADR-0086) an interactive chat turn may
 * search: those `folder-access.ts` clears this session for, narrowed to the ones
 * everyone the conversation is shared with is cleared for too, and none on a
 * conversation visible to the whole project (`restricted-use.ts`). A turn with
 * no conversation id gets none: the product's socket always names one, and an
 * anonymous turn could land anywhere.
 *
 * Signing a collection into the scope is not using it. The turn records a
 * collection only when content from it enters the model's context, and that
 * admission checks the conversation's audience again, so a share made while
 * this socket is open cannot carry restricted content to someone not cleared.
 */
async function resolveRestrictedCollections(
  session: AuthorizedSession,
  projectId: string,
  projectCollection: string,
  conversationId: string | undefined
): Promise<string[]> {
  if (!conversationId) return []
  const access = await getProjectFolderAccess(session, projectId, projectCollection)
  if (access.clearedRestrictedCollections.length === 0) return []
  return restrictedCollectionsForChatScope(
    session,
    conversationId,
    { projectId, projectCollection },
    access.clearedRestrictedCollections
  )
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
  /**
   * The conversation only when a row exists and the caller holds `viewer` on
   * it. `conversationId` above is also set for a conversation whose first
   * message has not created the row yet; this one is what the job envelope may
   * sign as reachable (ADR-0084).
   */
  verifiedConversationId: string | undefined
  /**
   * The caller reaches the project only because it is closed (ADR-0088): they
   * may read it and chat about it, and steer no run but their own. The job
   * envelope signs no project for them (`signJobRequestContext`). Always set
   * here; optional so a stand-in that predates it reads as a member.
   */
  projectReadOnly?: boolean
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
  const conversationVerified =
    conversationId && session && !anonymous
      ? await authorizeConversationScope(session as AuthorizedSession, conversationId)
      : false

  let projectReadOnly = false
  if (projectId && session && !anonymous) {
    if (explicitProject) {
      // The collection scope is what a chat request retrieves against, so
      // reaching it is chatting in the project — `project:chat`, not
      // `project:view`. A reader gets the project's documents through the
      // documents API; they do not get the agent pointed at them.
      const access = await requireProjectAccess(
        session as AuthorizedSession,
        projectId,
        CHAT_PERMISSIONS
      )
      projectReadOnly = access.readsBecauseClosed
    } else {
      // Implicit fallback from the stored active_project_id preference, which
      // can go stale (project soft-deleted, membership revoked) and is never
      // cleaned up. Throwing here would break every request that omits
      // projectId — global listings 404, general chat WS upgrades 403 — so
      // degrade to an unscoped request instead of failing.
      try {
        const access = await requireProjectAccess(
          session as AuthorizedSession,
          projectId,
          CHAT_PERMISSIONS
        )
        projectReadOnly = access.readsBecauseClosed
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

  // Restricted folders (ADR-0086): an interactive chat turn of a cleared
  // session, in a project whose row was found, on a conversation whose every
  // reader is cleared for them. Every other scope — deep research, scheduled
  // runs, the proxies, an anonymous deployment — carries none.
  const restrictedCollections =
    context.interactiveChat && session && !anonymous && projectId && projectCollectionName
      ? await resolveRestrictedCollections(
          session as AuthorizedSession,
          projectId,
          projectCollectionName,
          conversationId
        )
      : []

  const shelfByCollection = new Map<string, CollectionShelf>()
  // The base knowledge corpus, and nothing else, is `base`.
  shelfByCollection.set(baseCollection, 'base')
  if (archivCollection) shelfByCollection.set(archivCollection, 'archiv')
  if (projectCollection) shelfByCollection.set(projectCollection, 'project')
  // A restricted folder's collection is the project's knowledge, filed apart.
  for (const restricted of restrictedCollections) shelfByCollection.set(restricted, 'project')
  if (sessionCollection) shelfByCollection.set(sessionCollection, 'session')

  const scope = computeCollectionScope(session, {
    projectId,
    projectCollectionName: projectCollection,
    includeProject,
    conversationId: sessionCollection,
    archivCollectionName: archivCollection,
    baseCollection,
    restrictedCollections,
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
    verifiedConversationId: conversationVerified ? conversationId : undefined,
    projectReadOnly: Boolean(projectId) && projectReadOnly,
  }
}
