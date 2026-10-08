/**
 * Who may look at a quarantined document (ADR-0085), asked of a session.
 *
 * A quarantined file is held back because its content matched the office's
 * sensitive-data list, so it is not the project's yet: only the person who
 * uploaded it and the people who decide about it may open it. Everyone else is
 * told it does not exist, on every byte path (`getAccessibleDocument`) and in
 * every listing (`quarantineReaderFor` narrows the query). The signed image
 * route has no session to ask this with, so its URL carries the answer the mint
 * got (`streamDocumentImage`, `@/lib/images/signed-image-url`).
 *
 * The reviewer rule lives here, apart from `./review`, because the documents
 * layer asks it on every item read, and `./review` imports the documents
 * service to release a file. One rule, two callers, no cycle.
 */

import 'server-only'
import { ConflictError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isFolderVisibleTo } from '@/lib/authz/folder-access'
import { canManageArchiv } from '@/lib/authz/organizations'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Document } from '@/lib/db/schema'
import { findDocumentInOrg } from '@/lib/documents/repository'

type ReviewedDocument = Pick<Document, 'scope' | 'projectId' | 'folderId'>

/** Whether this session may release or delete this quarantined document. Never throws. */
export async function mayReviewQuarantine(session: AuthorizedSession, doc: ReviewedDocument): Promise<boolean> {
  if (hasPermission(session, ORG_PERMISSIONS.projectsAdminister)) return true
  if (doc.scope === 'archiv') return canManageArchiv(session)
  if (doc.scope !== 'project' || !doc.projectId) return false
  try {
    await requireProjectAccess(session, doc.projectId, 'project:manage')
  } catch {
    return false
  }
  // A project admin who is not cleared for the document's folder does not
  // review it: they could not see it anywhere else either (ADR-0086).
  return isFolderVisibleTo(session, doc.projectId, doc.folderId).catch(() => false)
}

/**
 * Whether this session may open this quarantined document: its uploader, or
 * one of its reviewers. Asked only of a row that IS quarantined; the shelf's
 * own rule still applies on top of it.
 */
export async function maySeeQuarantined(
  session: AuthorizedSession,
  doc: ReviewedDocument & Pick<Document, 'createdBy'>
): Promise<boolean> {
  return doc.createdBy === session.userId || mayReviewQuarantine(session, doc)
}

/**
 * The `quarantineReader` a listing of `place` takes for this session: the
 * session's own id when it may not review that place's quarantine, so the
 * query keeps only the quarantined rows it uploaded; `undefined` for a
 * reviewer, who sees them all.
 *
 * `place` is the shelf, not a row. A listing already leaves out the folders the
 * reader may not see, so the folder half of the reviewer rule is answered by
 * the root (`folderId: null`) for every row that is left.
 */
export async function quarantineReaderFor(
  session: AuthorizedSession,
  place: Pick<Document, 'scope' | 'projectId'>
): Promise<string | undefined> {
  return (await mayReviewQuarantine(session, { ...place, folderId: null })) ? undefined : session.userId
}

/** `details.reason` of the 409 a re-upload onto one's own quarantined file answers. */
export const QUARANTINED_REPLACE_REASON = 'quarantined'

/**
 * Refuse an upload that would replace a quarantined document, whoever uploads.
 *
 * A re-upload keeps the document's id and its history (ADR-0054): the bytes it
 * replaces stay readable as an earlier version of whatever the new upload
 * becomes, and a version is served on the document's CURRENT status. Once the
 * new bytes settle the row is no longer quarantined, so the held-back bytes
 * would be a version every member can open as text, and a chat about the
 * document could still hand them to a model. That holds for the uploader's own
 * cleaned copy as much as for anybody else's upload.
 *
 * Somebody who may not see the file is refused like a name that is taken,
 * learning nothing about the quarantine. Its uploader and its reviewers are told
 * what to do instead: delete it (or have it released), then upload.
 */
export async function assertMayReplaceQuarantined(
  session: AuthorizedSession,
  superseded: { id: string; status: string | null },
  filename: string
): Promise<void> {
  if (superseded.status !== 'quarantined') return
  const doc = await findDocumentInOrg(superseded.id, session.organizationId)
  if (doc && (await maySeeQuarantined(session, doc))) {
    throw new ConflictError(
      `"${filename}" is waiting in quarantine. Delete it, or have it released, before uploading a new version.`,
      { reason: QUARANTINED_REPLACE_REASON }
    )
  }
  throw new ConflictError(`A document named "${filename}" already exists here. Rename the file to upload it.`)
}
