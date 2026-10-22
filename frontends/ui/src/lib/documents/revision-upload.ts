/**
 * Checking a „Als neue Fassung von X ablegen" that arrives with an upload
 * (CONTEXT.md, „Fassung"; ADR-0099), before a byte is stored.
 *
 * The browser sends the id of the older document the reader ticked. Python
 * writes the link once the new file has been read, from the older document's
 * FILE NAME, so everything that must be true is decided here first, by the
 * same rules `PUT /api/documents/{id}/revision-links` applies to the older document
 * (`revision-service.ts`): the caller may change it (write on its shelf and
 * folder), it is past screening, it is a person's upload and not archived, and
 * it lives on the shelf and in the collection the new file is going to.
 *
 * The choice is an addition to the upload, never its gate. A choice that may not
 * be honoured (the older document moved into a restricted folder meanwhile, was
 * archived, is not this reader's to change) is dropped and reported
 * (`ignored`), and the file is stored as a document of its own: refusing the
 * upload lost the file over a link a person can still confirm from the preview.
 * A document the reader may not see and one they may not change are reported
 * alike (`unavailable`), so the answer says nothing about which it was.
 *
 * What it answers is the older file's name for the ingest job, or `null` when
 * there is nothing to link: no choice was made, the choice was dropped, or the
 * new file has the older one's own name, which is a new version of it
 * (ADR-0054) and never a Fassung.
 */

import 'server-only'
import { z } from 'zod'
import { BadRequestError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'
import { getAccessibleDocument } from './access'
import { collectionFileRef } from './collection-file-ref'
import { hasPassedScreening, SCREENED_ONLY } from './document-reader'
import { findDocumentInOrg } from './repository'
import { documentNameKey } from './name-match'
import { documentShelf, type DocumentShelf } from './shelf'

const olderIdSchema = z.string().uuid()

/**
 * The `revisionOf` form field of an upload: the older document's id, or `null`
 * when the field is absent or empty. Anything else is a malformed request, not
 * a choice to quietly drop.
 */
export function readRevisionOf(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = olderIdSchema.safeParse(value.trim())
  if (!parsed.success) throw new BadRequestError('revisionOf must be a document id', { reason: 'invalid_revision_of' })
  return parsed.data
}

/** Where the new file is going, as the upload has decided it. */
export interface RevisionUploadTarget {
  shelf: DocumentShelf
  /** The collection the new file will be indexed into (a restricted folder has its own, ADR-0087). */
  collectionName: string
  /** The new file's stored name. */
  filename: string
}

function sameShelf(a: DocumentShelf, b: DocumentShelf | null): boolean {
  if (!b || a.kind !== b.kind) return false
  return a.kind === 'office_shelf' || (b.kind === 'project' && a.projectId === b.projectId)
}

/** Why a Fassung choice was dropped. `unavailable` covers not found, held, not this reader's to change, and machine-authored. */
export const REVISION_OF_IGNORED_REASONS = ['unavailable', 'different_shelf', 'archived', 'different_collection'] as const
export type RevisionOfIgnoredReason = (typeof REVISION_OF_IGNORED_REASONS)[number]

/** The checked choice: the older file's name to link, or why the choice was dropped. */
export interface ResolvedRevisionOf {
  /** The older file's name for the ingest job; null for nothing to link. */
  revisionOf: string | null
  /** Set when a choice was made and dropped; the upload goes on without it. */
  ignored: RevisionOfIgnoredReason | null
}

const NOTHING: ResolvedRevisionOf = { revisionOf: null, ignored: null }
const ignoredFor = (reason: RevisionOfIgnoredReason): ResolvedRevisionOf => ({ revisionOf: null, ignored: reason })

/** The older document, or null when this reader may not see or change it. Anything else still throws. */
async function olderForLinking(session: AuthorizedSession, olderId: string) {
  try {
    return await getAccessibleDocument(session, olderId, 'write')
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return null
    throw error
  }
}

/** Check a Fassung choice. Never throws over the choice itself: one that may not be honoured comes back `ignored`. */
export async function resolveRevisionOf(
  session: AuthorizedSession,
  olderId: string | null | undefined,
  target: RevisionUploadTarget,
): Promise<ResolvedRevisionOf> {
  if (!olderId) return NOTHING
  const older = await olderForLinking(session, olderId)
  // A held upload is its uploader's and the reviewers' alone (ADR-0086), and a link would carry its
  // name, and through the change summary what it holds, into documents everyone reads.
  if (!older) return ignoredFor('unavailable')
  return linkableRevisionOf(older, target)
}

/**
 * The upload checks again, when a reviewer releases a held upload (ADR-0086):
 * the older document's CURRENT file name, or `null` when the choice no longer
 * resolves.
 *
 * The release can come days after the upload, and the choice recorded with it
 * (`./filing-choice`) names the older document by id, never by name: meanwhile
 * it may have been archived, renamed, or deleted and another file filed under
 * its name. Read for no particular person, whoever the reviewer is: the
 * uploader's right to change the older document was checked at upload, and the
 * reviewer releasing is not the one filing.
 */
export async function resolveReleasedRevisionOf(
  organizationId: string,
  olderId: string,
  released: Pick<Document, 'scope' | 'projectId' | 'collectionName' | 'filename'>,
): Promise<string | null> {
  // Screened rows only: a held document is never a Fassung to link (see `linkableRevisionOf`).
  const older = await findDocumentInOrg(olderId, organizationId, SCREENED_ONLY)
  const shelf = documentShelf(released)
  if (!older || !shelf) return null
  return linkableRevisionOf(older, {
    shelf,
    collectionName: released.collectionName,
    filename: released.filename,
  }).revisionOf
}

/** Every check on the older document but the reader's right to change it. */
function linkableRevisionOf(older: Document, target: RevisionUploadTarget): ResolvedRevisionOf {
  if (!hasPassedScreening(older)) return ignoredFor('unavailable')
  if (!sameShelf(target.shelf, documentShelf(older))) return ignoredFor('different_shelf')
  if (older.lifecycle !== 'active') return ignoredFor('archived')
  // A restricted folder is its own collection (ADR-0087); the link lives in one.
  if (older.collectionName !== target.collectionName) return ignoredFor('different_collection')
  // The same gate as every `(collection, filename)` call: a machine-authored row owns no chunks over there.
  if (!collectionFileRef(older)) return ignoredFor('unavailable')
  if (documentNameKey(older.filename) === documentNameKey(target.filename)) return NOTHING
  return { revisionOf: older.filename, ignored: null }
}
