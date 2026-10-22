/**
 * Piloti's suggestion for one part, as the E-Mail-Eingang reads it (D21).
 *
 * The wire carries the suggestion as the suggest job stored it
 * (`InboundMailPartView.suggestion`, a JSON object) and promises nothing about
 * its keys, so it is parsed here and never trusted: a key that is missing or
 * of the wrong type is no suggestion for that field, a Dokumentart outside
 * the vocabulary is dropped, and a name is never longer than the decision
 * route accepts. The keys are the suggest job's (`lib/inbound-mail/suggest.ts`:
 * `folderId`, `folderPath`, `newFolder`, `documentType`, `reason`), and the
 * filing judgement's own words (`folder`, `new`) are read too.
 *
 * Pure.
 */

import { DOCUMENT_TYPE_TAGS, type DocumentTypeTag } from '@/lib/documents/tag-vocabulary'
import { INBOUND_MAIL_FILE_NAME_MAX, INBOUND_MAIL_FOLDER_PATH_MAX } from '@/lib/inbound-mail/inbound-mail-wire'

export interface PartSuggestion {
  /** The folder path, `''` for the project root; null when Piloti suggested no folder. */
  folder: string | null
  /** The folder's id when it exists; null for a folder the filing would create, or when unknown. */
  folderId: string | null
  /** Filing creates the folder (an office convention the project does not have yet). */
  isNew: boolean
  documentType: DocumentTypeTag | null
  name: string | null
  /** Piloti's one line of why. */
  reason: string | null
}

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : null

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The suggestion, or null when the stored object holds nothing usable. */
export function readSuggestion(raw: Record<string, unknown> | null | undefined): PartSuggestion | null {
  if (!raw || typeof raw !== 'object') return null
  const folderValue = raw.folder ?? raw.folderPath
  const folder = folderValue === '' ? '' : text(folderValue, INBOUND_MAIL_FOLDER_PATH_MAX)
  const folderId = typeof raw.folderId === 'string' && UUID.test(raw.folderId) ? raw.folderId : null
  const typeValue = raw.documentType ?? raw.type
  const documentType =
    typeof typeValue === 'string' && (DOCUMENT_TYPE_TAGS as readonly string[]).includes(typeValue)
      ? (typeValue as DocumentTypeTag)
      : null
  const name = text(raw.name, INBOUND_MAIL_FILE_NAME_MAX)
  const reason = text(raw.reason, 500)
  if (folder === null && documentType === null && name === null) return null
  return {
    folder,
    folderId,
    isNew: raw.newFolder === true || raw.new === true || raw.isNew === true,
    documentType,
    name,
    reason,
  }
}

/** The last segment of a folder path, as a chip names it („Behörde/Bescheide“ → „Bescheide“). */
export function folderLeaf(path: string): string {
  const parts = path.split('/').filter((part) => part.trim() !== '')
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/** Piloti does not suggest for unconfirmed strangers or machines (D21); a fresh mail may still be read. */
export const SUGGESTION_GRACE_MS = 10 * 60 * 1000

/**
 * Why a part shows no suggestion: Piloti is still reading it (a fresh mail),
 * Piloti never suggests for this mail (unconfirmed stranger, automatic), or
 * it had none.
 */
export function missingSuggestionReason(
  mail: { automatic: boolean; senderTrust: string | null; receivedAt: string },
  now: number = Date.now(),
): 'pending' | 'skipped' | 'none' {
  if (mail.automatic || mail.senderTrust === 'external_unverified') return 'skipped'
  return now - Date.parse(mail.receivedAt) < SUGGESTION_GRACE_MS ? 'pending' : 'none'
}
