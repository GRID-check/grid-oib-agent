import 'server-only'
/**
 * What a held mail's candidates are FOR THE VIEWER (ADR-0134, D9, RT-S13,
 * RT-X8): the threads it may belong to, the document its attachment
 * duplicates, the document it may be the next Fassung of.
 *
 * The receive job stores ids only (`thread_match`, `duplicate_of_document_id`,
 * `revision_candidate_document_id`), and only of screened documents; it
 * cannot know who will read the mail. Each read decides here, for the person
 * reading:
 *
 * - a document whose screening has not passed, or that is in the bin, is no
 *   candidate for anyone (the repository reads with `documentVisibleTo(SCREENED_ONLY)`);
 * - a document in a folder the viewer may not read is never named: a thread
 *   there is counted (`hiddenThreadCandidates`), a possible earlier Fassung
 *   says only that one exists („1 mögliche Fassung in einem Ordner, den Sie
 *   nicht sehen“), and an identical file there says nothing at all, since
 *   „you may not see a copy of these bytes“ is itself the leak.
 *
 * Pre-selection is the thread core's (`threadPreselection`), from the stored
 * sender evidence, so a stranger's References never pre-select (RT-S1).
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import type { InboundMailPartRow, InboundMailRow } from '@/lib/db/schema'
import { MAIL_THREAD_MAX_ENTRIES, MAIL_THREAD_MAX_RENDERED_BYTES } from '@/lib/mail-thread/mail-thread-vocabulary'
import {
  MAX_SHOWN_THREAD_CANDIDATES,
  threadPreselection,
  type SenderEvidence,
  type ThreadMatch,
} from '@/lib/mail-thread/mail-threading'
import type {
  InboundMailDocumentRefView,
  InboundMailThreadCandidateView,
} from './inbound-mail-wire'
import { findCandidateDocuments, findThreadDocuments, type CandidateDocument, type ThreadDocument } from './repository'

/** What the stored sender evidence of a mail says, in the shape the thread core reads. */
export function senderEvidenceOf(mail: Pick<InboundMailRow, 'senderTrust' | 'senderFlags' | 'signedHeaders'>): SenderEvidence {
  return {
    // A mail a person can read always has its trust (`inbound_mails_trust_when_shown`).
    senderTrust: mail.senderTrust ?? 'external_unverified',
    senderFlags: mail.senderFlags,
    signedHeaders: mail.signedHeaders,
  }
}

/** Whether a thread can take one more message, or only a continuation („Als Fortsetzung ablegen“, D11). */
export function threadIsFull(thread: Pick<ThreadDocument, 'entryCount' | 'renderedBytes'>): boolean {
  return thread.entryCount >= MAIL_THREAD_MAX_ENTRIES || thread.renderedBytes >= MAIL_THREAD_MAX_RENDERED_BYTES
}

/** Whether the viewer may read something filed in `folderId` (null: the project root). */
const readable = (folderId: string | null, hidden: ReadonlySet<string>): boolean => folderId === null || !hidden.has(folderId)

/**
 * The thread candidates of one mail for this viewer, strongest first, at most
 * {@link MAX_SHOWN_THREAD_CANDIDATES}, and how many it may not see. Pure: the
 * caller loads the threads' documents and the viewer's hidden folders once for
 * a whole page. A matched thread without a live, screened document is dropped
 * for everyone; one in a hidden folder is counted, never named.
 */
export function threadCandidatesFor(
  matches: readonly ThreadMatch[],
  sender: SenderEvidence,
  threads: ReadonlyMap<string, ThreadDocument>,
  hiddenFolders: ReadonlySet<string>,
): { shown: InboundMailThreadCandidateView[]; hidden: number } {
  const shown: InboundMailThreadCandidateView[] = []
  let hidden = 0
  for (const match of matches) {
    const thread = threads.get(match.threadId)
    if (!thread) continue
    if (!readable(thread.folderId, hiddenFolders)) {
      hidden += 1
      continue
    }
    if (shown.length >= MAX_SHOWN_THREAD_CANDIDATES) continue
    const full = threadIsFull(thread)
    const { preselected, blocks } = threadPreselection(match, sender)
    shown.push({
      threadId: thread.threadId,
      documentId: thread.documentId,
      name: thread.name,
      folderPath: thread.folderPath,
      nextVersion: thread.nextVersion,
      strength: match.strength,
      preselected: preselected && !full,
      blocks,
      full,
    })
  }
  return { shown, hidden }
}

/** A part's matched documents for this viewer. */
export interface PartCandidates {
  duplicateOf: InboundMailDocumentRefView | null
  revisionCandidate: (InboundMailDocumentRefView & { nextVersion: number }) | null
  revisionCandidateHidden: boolean
}

const refOf = (document: CandidateDocument): InboundMailDocumentRefView => ({
  documentId: document.documentId,
  name: document.name,
  folderPath: document.folderPath,
})

/** {@link PartCandidates} of one part. Pure, like {@link threadCandidatesFor}. */
export function partCandidatesFor(
  part: Pick<InboundMailPartRow, 'duplicateOfDocumentId' | 'revisionCandidateDocumentId'>,
  documents: ReadonlyMap<string, CandidateDocument>,
  hiddenFolders: ReadonlySet<string>,
): PartCandidates {
  const duplicate = part.duplicateOfDocumentId ? documents.get(part.duplicateOfDocumentId) : undefined
  const revision = part.revisionCandidateDocumentId ? documents.get(part.revisionCandidateDocumentId) : undefined
  const revisionReadable = revision !== undefined && readable(revision.folderId, hiddenFolders)
  return {
    // Identical bytes in a folder the viewer cannot read: nothing at all (§9's case table).
    duplicateOf: duplicate && readable(duplicate.folderId, hiddenFolders) ? refOf(duplicate) : null,
    revisionCandidate: revision && revisionReadable ? { ...refOf(revision), nextVersion: revision.nextVersion } : null,
    revisionCandidateHidden: revision !== undefined && !revisionReadable,
  }
}

/** Everything one read needs to judge candidates for its viewer, loaded once for a page of mails. */
export interface ViewerCandidates {
  threads(mail: Pick<InboundMailRow, 'threadMatch' | 'senderTrust' | 'senderFlags' | 'signedHeaders'>): {
    shown: InboundMailThreadCandidateView[]
    hidden: number
  }
  part(part: Pick<InboundMailPartRow, 'duplicateOfDocumentId' | 'revisionCandidateDocumentId'>): PartCandidates
  /** Whether the viewer may read a document filed in this folder. */
  readsFolder(folderId: string | null): boolean
  /** Whether the viewer may read this document, one of the parts' (`documentId` included): screened, live, in a folder they see. */
  readsDocument(documentId: string): boolean
}

/**
 * Load the candidates of these mails and parts for `session`: the matched
 * threads' documents, the parts' matched documents, and the folders the viewer
 * may not read, three reads for the whole page.
 */
export async function candidatesFor(
  session: AuthorizedSession,
  projectId: string,
  mails: ReadonlyArray<Pick<InboundMailRow, 'threadMatch'>>,
  parts: ReadonlyArray<Pick<InboundMailPartRow, 'duplicateOfDocumentId' | 'revisionCandidateDocumentId' | 'documentId'>>,
): Promise<ViewerCandidates> {
  const threadIds = mails.flatMap((mail) => mail.threadMatch.map((match) => match.threadId))
  const documentIds = parts.flatMap((part) =>
    [part.duplicateOfDocumentId, part.revisionCandidateDocumentId, part.documentId].filter((id): id is string => id !== null),
  )
  const [threadRows, documentRows, hiddenIds] = await Promise.all([
    findThreadDocuments(projectId, threadIds),
    findCandidateDocuments(projectId, documentIds),
    getHiddenFolderIds(session, projectId),
  ])
  const threads = new Map(threadRows.map((thread) => [thread.threadId, thread]))
  const documents = new Map(documentRows.map((document) => [document.documentId, document]))
  const hidden = new Set(hiddenIds)
  return {
    threads: (mail) => threadCandidatesFor(mail.threadMatch, senderEvidenceOf(mail), threads, hidden),
    part: (part) => partCandidatesFor(part, documents, hidden),
    readsFolder: (folderId) => readable(folderId, hidden),
    readsDocument: (documentId) => {
      const document = documents.get(documentId)
      return document !== undefined && readable(document.folderId, hidden)
    },
  }
}
