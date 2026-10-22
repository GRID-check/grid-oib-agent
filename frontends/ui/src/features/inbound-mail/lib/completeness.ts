/**
 * Whether a mail can be filed „wie vorgeschlagen“ without anyone looking at
 * it (DECISION §9, RT-X10), and what a bulk filing of several will do.
 *
 * Complete means the default draft asks nothing of the person:
 *
 * - the sender needs no acknowledgement (a bulk request carries none, RT-S5);
 * - the text goes to a pre-selected thread with room, or the mail is a
 *   member's own Bcc copy with nothing attached (it then starts a thread);
 * - every attachment that waits is decided by its default: one offered
 *   checked has a folder (or is a confirmed Fassung), and none needs a person
 *   (name check, risk, an unconfirmed Fassung, a scan still running);
 * - the project is open and something waits.
 *
 * The bulk confirmation is computed from the same drafts the request is
 * built from (`decisionOf`), grouped by where things go.
 *
 * Pure.
 */

import type { InboundMailView } from '@/lib/inbound-mail/inbound-mail-wire'
import { isOwnBccCopy } from '@/lib/mail-thread/mail-threading'
import { attachmentCase } from './attachment-case'
import { appendCandidate, defaultThread, draftSummary, initialDraft, type DraftCopy, type FolderOption, type MailDraft } from './draft'
import { senderNeedsAcknowledgement } from './sender'

/** Why a mail is not complete, the first reason found; null when it is. */
export type IncompleteReason =
  | 'not_waiting'
  | 'project_closed'
  | 'sender'
  | 'no_thread'
  | 'needs_person'
  | 'scanning'
  | 'folder_missing'

export function incompleteReason(view: InboundMailView, folders: readonly FolderOption[], copy: DraftCopy): IncompleteReason | null {
  if (view.status !== 'waiting') return 'not_waiting'
  if (view.projectClosed) return 'project_closed'
  if (!view.sender || senderNeedsAcknowledgement(view.sender)) return 'sender'

  const attachments = view.parts.filter((part) => part.kind === 'attachment').map((part) => attachmentCase(part, view))
  const waiting = attachments.filter((entry) => entry.part.state === 'waiting')
  if (waiting.some((entry) => entry.status === 'scan_pending' || entry.status === 'scan_failed')) return 'scanning'
  if (
    waiting.some(
      (entry) =>
        entry.status === 'waiting' && !entry.defaultChecked && entry.notes.some((note) => note.kind !== 'duplicate' && note.kind !== 'last_failure')
    )
  ) {
    return 'needs_person'
  }

  const message = view.parts.find((part) => part.kind === 'message')
  if (message?.state === 'waiting') {
    const ownBcc = isOwnBccCopy({ senderTrust: view.sender.trust, senderFlags: view.sender.flags })
    if (!defaultThread(view) && !(ownBcc && waiting.length === 0)) return 'no_thread'
  }

  const draft = initialDraft(view, folders, copy)
  const summary = draftSummary(view, draft)
  if (summary.blockers.some((blocker) => blocker.kind === 'folder_missing')) return 'folder_missing'
  if (summary.blockers.length > 0) return 'needs_person'
  return null
}

/** One line of the bulk confirmation: where it goes, and how many go there. */
export interface BulkDestination {
  kind: 'folder' | 'new_folder' | 'thread' | 'new_thread'
  /** The folder path (`''` is the root) or the thread's name. */
  label: string
  count: number
}

export interface BulkPlan {
  mails: number
  files: number
  texts: number
  destinations: BulkDestination[]
}

/** What filing these drafts as suggested will do, for the `ConfirmDialog` grouped by folder. */
export function bulkPlan(entries: ReadonlyArray<{ view: InboundMailView; draft: MailDraft }>): BulkPlan {
  const destinations = new Map<string, BulkDestination>()
  const add = (kind: BulkDestination['kind'], label: string): void => {
    const key = `${kind}:${label}`
    const current = destinations.get(key)
    if (current) current.count += 1
    else destinations.set(key, { kind, label, count: 1 })
  }
  let files = 0
  let texts = 0
  for (const { view, draft } of entries) {
    const summary = draftSummary(view, draft)
    files += summary.files
    if (summary.text) texts += 1
    for (const attachment of draft.attachments) {
      if (!attachment.checked) continue
      if (attachment.revisionOf !== null) {
        const revision = view.parts.find((part) => part.id === attachment.partId)?.revisionCandidate
        add('folder', revision?.folderPath ?? '')
      } else if (attachment.folder) {
        add(attachment.folder.kind === 'new' ? 'new_folder' : 'folder', attachment.folder.path)
      }
    }
    if (summary.text) {
      const candidate = appendCandidate(view, draft)
      const target = draft.message?.target
      if (candidate) add('thread', candidate.name)
      else if (target?.kind === 'create') add('new_thread', target.name)
    }
  }
  const order: Record<BulkDestination['kind'], number> = { thread: 0, new_thread: 1, folder: 2, new_folder: 3 }
  return {
    mails: entries.length,
    files,
    texts,
    destinations: [...destinations.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.count - a.count || a.label.localeCompare(b.label)),
  }
}
