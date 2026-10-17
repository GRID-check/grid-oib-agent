/**
 * What the server's refusal of one upload means, read off its error envelope
 * (`{ error, code, details }`), so the upload row says it in the reader's
 * language and knows whether a retry can help.
 *
 * The server's `error` is English and for logs. A refusal with a reason this
 * build knows is said from the dictionary; one with a reason it does not know
 * is said generically, never echoed, because its English was written for
 * whoever reads the log. Only a refusal with no reason at all (a file type, a
 * size) still shows the server's own words.
 */

import { FOLDER_READ_ONLY_REASON } from '@/lib/authz/folder-access-rule'
import { isProjectClosedBody } from '@/lib/projects/project-status'
import { isNameTakenBody } from '@/lib/documents/name-taken'
import { XhrUploadError } from '@/lib/http/xhr-upload'
import { isQuarantinedReplaceBody } from '@/lib/upload-screening/quarantine'
import type { NameMatch } from '@/lib/upload-screening/name-screen'
import { nameStopMatchesOf } from '@/lib/upload-screening/name-stop'

/**
 * Reasons that say the shelf changed under the upload (`unique-conflicts.ts`):
 * a concurrent first upload of the name, or the replaced document deleted
 * meanwhile. The server retries once; a retry from here meets the new state.
 */
/** The code of the server's 503 while it cannot read the office's list (`ScreeningPolicyUnavailableError`). */
const SCREENING_UNAVAILABLE_CODE = 'UPLOAD_SCREENING_UNAVAILABLE'

const CHANGED_MEANWHILE_REASONS: ReadonlySet<string> = new Set([
  'live_name_taken',
  'replaced_document_gone',
  'deleted_during_upload',
])

export type UploadRefusal =
  /**
   * The document this file would replace is held by the content check, and
   * this person may see it (ADR-0086). Not a failure: nothing can be sent
   * until somebody allows it through or deletes it.
   */
  | { kind: 'held-replace'; documentId: string | null; ownUpload: boolean }
  /** Another document holds the name; said exactly alike whatever the reason (`NAME_TAKEN_REASON`). */
  | { kind: 'name-taken' }
  /** The server's repeat of the name check stopped it (422 `UPLOAD_SCREENED`). */
  | { kind: 'name-stop'; matches: NameMatch[] }
  | { kind: 'project-closed' }
  /** The office's list could not be read, so nothing was stored (503); a retry may find it readable. */
  | { kind: 'screening-unavailable' }
  | { kind: 'folder-read-only' }
  | { kind: 'changed-meanwhile' }
  /** Anything else: `message` is the server's words only when it gave no reason. */
  | { kind: 'other'; message: string | null }

function parseBody(responseText: string): unknown {
  try {
    return JSON.parse(responseText)
  } catch {
    return null
  }
}

function reasonOf(body: unknown): unknown {
  const details = (body as { details?: unknown } | null)?.details
  return details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined
}

function heldReplaceOf(body: unknown): UploadRefusal {
  const details = (body as { details: { documentId?: unknown; ownUpload?: unknown } }).details
  return {
    kind: 'held-replace',
    documentId: typeof details.documentId === 'string' && details.documentId ? details.documentId : null,
    ownUpload: details.ownUpload === true,
  }
}

/** The refusal an upload request answered, or null when `error` is no answer from the server. */
export function uploadRefusalOf(error: unknown): UploadRefusal | null {
  if (!(error instanceof XhrUploadError)) return null
  const body = parseBody(error.responseText)
  if (error.status === 409 && isQuarantinedReplaceBody(body)) return heldReplaceOf(body)
  if (isNameTakenBody(body)) return { kind: 'name-taken' }
  const matches = nameStopMatchesOf(body)
  if (matches) return { kind: 'name-stop', matches }
  // A closed project (ADR-0090): it closed while this tab was open.
  if (isProjectClosedBody(body)) return { kind: 'project-closed' }
  if ((body as { code?: unknown } | null)?.code === SCREENING_UNAVAILABLE_CODE) return { kind: 'screening-unavailable' }
  const reason = reasonOf(body)
  if (reason === FOLDER_READ_ONLY_REASON) return { kind: 'folder-read-only' }
  if (typeof reason === 'string' && CHANGED_MEANWHILE_REASONS.has(reason)) return { kind: 'changed-meanwhile' }
  if (reason !== undefined) return { kind: 'other', message: null }
  const message = (body as { error?: unknown } | null)?.error
  return { kind: 'other', message: typeof message === 'string' && message ? message : null }
}

/** Whether sending the same bytes again can come out differently. */
export function mayRetryRefusal(refusal: UploadRefusal | null): boolean {
  if (!refusal) return true
  return refusal.kind === 'changed-meanwhile' || refusal.kind === 'screening-unavailable' || refusal.kind === 'other'
}
