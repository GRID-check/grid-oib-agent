/**
 * Veröffentlichen — this version becomes the document.
 *
 * Three things happen in ONE transaction, because the database refuses the
 * intermediate state: the previously published version becomes `superseded`,
 * this one becomes `published`, and `documents.published_version_id` plus the
 * item's storage columns move here. The superseded version KEEPS ITS BYTES; it
 * is history, and history you cannot open is a list of dates.
 *
 * Only an `approved` version can be published, and only a version a person
 * approved can be `approved` — `document_versions_published_is_approved` says
 * so as a row invariant. That is what makes "only a published version is ever
 * indexed" (slice 4) mean "only something a human signed off is ever citable".
 */

import { apiRoute } from '@/lib/api/handler'
import { toDocumentVersionView, transitionDocumentVersion } from '@/lib/documents/lifecycle'

type Params = { id: string; versionId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const version = await transitionDocumentVersion(session, params.id, params.versionId, 'publish', {
      request,
    })
    return { version: toDocumentVersionView(version) }
  },
  { authz: { enforcedBy: 'transitionDocumentVersion(publish) -> getAccessibleDocument + requireProjectAccess (project:documents:write | project:edit)' } }
)
