/**
 * Who may look at a held document (ADR-0083), asked of a session.
 *
 * A person's upload is held back until the content gate passes it, and a
 * quarantined one until a reviewer releases it: it is not the project's yet, so
 * only the person who uploaded it and the people who decide about it may open
 * it. Everyone else is told it does not exist, on every item path
 * (`findDocumentForSession`) and in every listing (`shelfReaderFor` names the
 * reader the query's `documentVisibleTo` narrows by).
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
import {
  hasPassedScreening,
  memberReader,
  REVIEWER_READER,
  type ScreeningFacts,
  type ShelfReader,
} from '@/lib/documents/document-reader'

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
  // review it: they could not see it anywhere else either (ADR-0084).
  return isFolderVisibleTo(session, doc.projectId, doc.folderId).catch(() => false)
}

/**
 * Whether this session may see this held document (ADR-0083): its uploader, or
 * one of its reviewers. Asked only of a row that is held; the shelf's own rule
 * still applies on top of it.
 */
export async function maySeeHeld(
  session: AuthorizedSession,
  doc: ReviewedDocument & Pick<Document, 'createdBy'>
): Promise<boolean> {
  return doc.createdBy === session.userId || mayReviewQuarantine(session, doc)
}

/**
 * The reader a listing of `place` takes for this session (ADR-0083): a
 * reviewer of that place's quarantine, who sees every row, or a member, who
 * sees the screened rows and the held rows they uploaded.
 *
 * `place` is the shelf, not a row. A listing already leaves out the folders the
 * reader may not see, so the folder half of the reviewer rule is answered by
 * the root (`folderId: null`) for every row that is left.
 */
export async function shelfReaderFor(
  session: AuthorizedSession,
  place: Pick<Document, 'scope' | 'projectId'>
): Promise<ShelfReader> {
  return (await mayReviewQuarantine(session, { ...place, folderId: null })) ? REVIEWER_READER : memberReader(session.userId)
}

/** `details.reason` of the 409 a re-upload onto one's own quarantined file answers. */
export const QUARANTINED_REPLACE_REASON = 'quarantined'

/** The row a re-upload would replace, as `findLiveDocumentByFilename` reads it. */
type SupersededDocument = ReviewedDocument & ScreeningFacts & Pick<Document, 'createdBy'>

/**
 * Refuse an upload that would replace a held document this session may not
 * see, and a quarantined one whoever uploads.
 *
 * A re-upload keeps the document's id and its history (ADR-0054): the bytes it
 * replaces stay readable as an earlier version of whatever the new upload
 * becomes, and the new uploader becomes the row's `createdBy`. Over somebody
 * else's unscreened file, the new uploader would see that file's history, and
 * once their own bytes passed, so would everyone. A quarantined file is refused
 * to its uploader's own cleaned copy as well: once the new bytes settle the row
 * is no longer quarantined, so the held-back bytes would be a version every
 * member can open as text.
 *
 * Somebody who may not see the file is refused like a name that is taken,
 * learning nothing about the hold. Its uploader and its reviewers may replace a
 * file still on its way through the gate (a corrected copy), and are told what
 * to do about a quarantined one: delete it (or have it released), then upload.
 */
export async function assertMayReplaceHeld(
  session: AuthorizedSession,
  superseded: SupersededDocument,
  filename: string
): Promise<void> {
  if (hasPassedScreening(superseded)) return
  const visible = await maySeeHeld(session, superseded)
  if (visible && superseded.status !== 'quarantined') return
  if (visible) {
    throw new ConflictError(
      `"${filename}" is waiting in quarantine. Delete it, or have it released, before uploading a new version.`,
      { reason: QUARANTINED_REPLACE_REASON }
    )
  }
  throw new ConflictError(`A document named "${filename}" already exists here. Rename the file to upload it.`)
}
