/**
 * "May this session touch this document, and how?" — one answer, for every
 * shelf.
 *
 * Lifted out of `./service` unchanged when the lifecycle arrived, because a
 * SECOND caller now needs it (`./lifecycle`) and the service already imports the
 * lifecycle for the upload path. Two modules that need each other is a cycle;
 * the shared question moving down a layer is not.
 *
 * It resolves the permission FROM THE ROW, which is what lets the item routes
 * under `/api/documents/[id]` serve a project document, an org-wide Archiv
 * document and a chat attachment without the route knowing which it has.
 */

import 'server-only'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { requireResourceAccess } from '@/lib/sharing/access'
import { canManageArchiv } from '@/lib/authz/organizations'
import type { Document } from '@/lib/db/schema'
import { findDocumentInOrg } from './repository'

/** Whether the caller intends to read the row or to change it. */
export type DocumentAccessIntent = 'read' | 'write'

/**
 * The document, if this session may touch it with this intent.
 *
 * Denials are `NotFoundError` wherever confirming existence would leak, and the
 * unknown-scope arm is deliberately a 404 rather than a guess: `scope` is a
 * plain `text` column, so a row can hold a value no version of this code knows,
 * and defaulting to another shelf's rule is how a private document becomes an
 * org-wide one.
 */
export async function getAccessibleDocument(
  session: AuthorizedSession,
  documentId: string,
  intent: DocumentAccessIntent = 'read',
): Promise<Document> {
  const doc = await findDocumentInOrg(documentId, session.organizationId)
  if (!doc) throw new NotFoundError()

  switch (doc.scope) {
    case 'archiv': {
      // Org-scoped: findDocumentInOrg already confirmed the row belongs to the
      // caller's org (so any member may read it). Only mutations need the
      // manage permission.
      if (intent === 'write' && !canManageArchiv(session)) throw new ForbiddenError()
      return doc
    }
    case 'session': {
      // A row that contradicts `documents_session_requires_conversation`
      // (migration 0049) is not something to guess about — it is unattributable,
      // so it is not found.
      if (!doc.conversationId) throw new NotFoundError()
      await requireResourceAccess(
        session,
        'conversation',
        doc.conversationId,
        intent === 'write' ? 'collaborator' : 'viewer',
      )
      return doc
    }
    case 'project': {
      // A `project` row with no project is a corrupt row, not an org-wide one.
      if (doc.projectId === null) throw new NotFoundError()
      await requireProjectAccess(
        session,
        doc.projectId,
        intent === 'write' ? ['project:documents:write', 'project:edit'] : 'project:view',
      )
      return doc
    }
    default: {
      // Two jobs. At COMPILE time the `never` annotation is the exhaustiveness
      // check ADR-0047 decision 3 asks for: add a shelf to `DocumentScope` and
      // this line stops type-checking until it has a rule here. At RUN time it
      // catches what the type cannot.
      const unhandledScope: never = doc.scope
      void unhandledScope
      throw new NotFoundError()
    }
  }
}
