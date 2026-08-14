/**
 * The files the user attached to THIS chat session, as a turn signal (issue #429).
 *
 * An attachment is an act, not a piece of viewing state. Until now nothing on
 * the wire said one had happened: `collectSendMetadata` built a `messageFiles`
 * list for the display chips and the outgoing frame was byte-identical with and
 * without an attachment, so a user who dropped a PDF and asked "Fass den Inhalt
 * zusammen" gave the agent a subjectless message and got asked which file.
 *
 * Deliberately NOT an extension of `focusFileName`. The two differ in
 * cardinality (many vs one), origin (an act vs which file is on screen),
 * lifetime, and indexing state — an attachment may still be mid-ingest, which
 * `focusFileName` can never be. They also want different retrieval semantics, so
 * folding them together would force one answer on both.
 *
 * Logic lives in this module rather than in `use-websocket-chat`, following
 * `features/layout/lib/source-presets.ts`: a pure function gets a ~1ms spec
 * instead of a mounted-tree one (see AGENTS.md "fix causes, not symptoms").
 */

import type { TrackedFile } from '@/features/documents/types'

/**
 * How far along ingestion is for an attached file, as the backend needs to read
 * it — NOT a mirror of `TrackedFile.status`.
 *
 * The backend's `available_documents` inventory is written by the async ingest
 * job, so a file the user just dropped is routinely absent from it for a few
 * seconds. `indexing` is the frontend telling the backend "this document exists
 * and is the subject of this turn even though your inventory does not list it
 * yet"; `ready` says the inventory should already have it.
 */
export type SessionAttachmentState = 'ready' | 'indexing'

/** One file attached to the current chat session, as it travels on the wire. */
export interface SessionAttachment {
  fileName: string
  state: SessionAttachmentState
}

/**
 * `TrackedFile.status` → the state the backend cares about.
 *
 * Default-deny: only the statuses listed here produce an attachment. `failed`
 * never ingested, and `deleting`/`canceled` are on their way out — naming any of
 * them would point the turn at a document that is not there.
 */
const ATTACHMENT_STATES: Partial<Record<TrackedFile['status'], SessionAttachmentState>> = {
  success: 'ready',
  ingesting: 'indexing',
  // Included even though `messageFiles` excludes it: a large PDF dropped and
  // asked about immediately is the reported flow, and at that moment its bytes
  // are still crossing the wire. Excluding it would drop the signal in exactly
  // the case that needs it most.
  uploading: 'indexing',
}

/**
 * Upper bound on attachments named in one frame. A turn is about a handful of
 * documents; a user with fifty session files is not telling the agent that all
 * fifty are the subject, and an unbounded list is prompt cost paid per turn.
 */
export const MAX_SESSION_ATTACHMENTS = 10

/**
 * The session's attachments for the frame about to be sent.
 *
 * `sessionId` is compared against `TrackedFile.collectionName` directly, with no
 * `s_` prefixing: a conversation id already IS `s_<uuid>`
 * (`features/chat/stores/sessions-store.ts`) and `InputArea` configures
 * `useFileUpload({ collectionName: currentConversation?.id })`, so both sides of
 * this comparison hold the same string. Files belonging to a project or the
 * Archiv carry a different collection and are filtered out here.
 *
 * Deduplicated by file name, with `ready` beating `indexing` — if any copy of a
 * name has finished ingesting, the document IS retrievable, and saying
 * `indexing` about it would make the backend wait for something already there.
 * Order follows `trackedFiles`; the cap is applied last.
 */
export function selectSessionAttachments(
  trackedFiles: readonly TrackedFile[],
  sessionId: string | undefined
): SessionAttachment[] {
  if (!sessionId) return []

  const byName = new Map<string, SessionAttachment>()
  for (const file of trackedFiles) {
    if (file.collectionName !== sessionId) continue
    const state = ATTACHMENT_STATES[file.status]
    if (!state) continue
    const fileName = file.fileName?.trim()
    if (!fileName) continue

    const incumbent = byName.get(fileName)
    if (incumbent && (incumbent.state === 'ready' || state === 'indexing')) continue
    byName.set(fileName, { fileName, state })
  }

  return Array.from(byName.values()).slice(0, MAX_SESSION_ATTACHMENTS)
}
