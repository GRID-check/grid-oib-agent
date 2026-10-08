/**
 * The signed context a request about a backend job carries (ADR-0084).
 *
 * The backend cannot ask WorkOS who belongs to a project, so it does not decide
 * project access. This tier does, and signs what it decided: the project it
 * checked `CHAT_PERMISSIONS` on and the conversation it checked `viewer` on. The
 * backend then lets the caller reach a job that lies inside that scope, in the
 * same organization (`aiq_api/jobs/access.py`): read and steer it through the
 * project, only read it through the conversation.
 *
 * Every producer of such a request builds its envelope here: the async-job proxy
 * on every method, and the run controls in `lib/runs/service.ts`. A producer
 * with its own copy would be one that forgets `issuedAt`, and the backend
 * refuses an envelope without one as a grant.
 */

import type { GridSession } from '@/lib/auth/types'
import type { ScopedCollection } from '@/lib/collection-scope'
import {
  buildGridRequestContextWireHeaders,
  type GridRequestContextInput,
} from '@/lib/request-context'

/**
 * What the BFF authorized for one request: `buildCollectionScopeFromRequest`'s
 * answer, of which the envelope signs only the parts it checked.
 */
export interface AuthorizedJobScope {
  /** The project `CHAT_PERMISSIONS` was checked on, when there is one. */
  projectId: string | undefined
  /** The collections the request may retrieve against, shelves attached. */
  scopedCollections: ScopedCollection[]
  /** A conversation that exists and the caller may view. */
  verifiedConversationId: string | undefined
  /**
   * The caller reads the project only because it is closed (ADR-0089). Such a
   * caller steers no run but their own, so the project is not signed: the
   * backend then lets them reach the jobs they own and, through a conversation
   * they may view, read the others. Absent on a scope built before the project
   * was checked, which signs as before.
   */
  projectReadOnly?: boolean
}

/**
 * The fields beyond the scope that only a submit carries: what the run is
 * configured with (model overrides, the organization's instructions, the
 * project's Bundesland). A read or a control has no run to configure.
 */
export type JobSubmitContext = Pick<
  GridRequestContextInput,
  'modelOverrides' | 'orgInstructions' | 'bundesland'
>

/**
 * The header set for one job request: the individual `X-Grid-*` headers and the
 * signed envelope, stamped with the time it was minted.
 */
export function signJobRequestContext(
  session: GridSession | null,
  scope: AuthorizedJobScope,
  submit: JobSubmitContext = {},
  now: number = Date.now()
): Record<string, string> {
  // The backend reads the project a scope grants from its project-shelf
  // collections (`derive_project_collection`), so withholding the project means
  // withholding those too, not only the id.
  const signsProject = !scope.projectReadOnly
  const input: GridRequestContextInput = {
    organizationId: session?.organizationId ?? null,
    userId: session?.userId ?? null,
    projectId: signsProject ? (scope.projectId ?? null) : null,
    collectionScope: signsProject
      ? scope.scopedCollections
      : scope.scopedCollections.filter((entry) => entry.shelf !== 'project'),
    conversationId: scope.verifiedConversationId ?? null,
    issuedAt: now,
    ...submit,
  }
  return buildGridRequestContextWireHeaders(input, process.env.GRID_INTERNAL_API_TOKEN)
}
