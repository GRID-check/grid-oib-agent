import 'server-only'
/**
 * Whether a person's decision about a held mail may be written, check by check
 * (ADR-0134, DECISION §4 C2), and the decision rows it becomes.
 *
 * A decision is the filing job's only instruction: the job reads what to file,
 * where, under which name and with which acknowledgements from the rows this
 * module plans, and from nowhere else. So every check a person must have
 * passed is made here, synchronously, with a code the UI and an agent can act
 * on, before a row exists:
 *
 * | Code | The check |
 * |---|---|
 * | `stale`, `part_not_waiting`, `part_unknown` | the mail is the one the person read (`ifMatch`), each part is this mail's and waits |
 * | `scan_not_clean` | an attachment's scan said clean (the job re-scans one older than a day) |
 * | `type_not_accepted` | the office accepts the type, of the part and of the name it is filed under |
 * | `name_stop` | the name check passes the file name, the thread name and a new folder path, or the person released it |
 * | `risk_not_acknowledged` | a `macro` or `type_mismatch` part, an append to a thread the sender could not vouch for, a Fassung of an earlier document from such a sender: the part's id is in `acknowledgeRisk` |
 * | `sender_not_acknowledged` | an unconfirmed sender the person must accept: `member_unverified`, a DKIM `fail` or `policy`, a mail addressed to others (outside the Bcc case), a stale date |
 * | `acknowledgement_in_bulk` | acknowledgements only in a request about one mail (RT-S5) |
 * | `card_carries_acknowledgement` | a Piloti card carries none (RT-S5; the database refuses it too) |
 * | `target_unknown`, `thread_full` | the thread or the earlier document is one the person may read, and the thread has room |
 * | `name_taken` | the name is free in the project, or the person files the part as that document's next Fassung |
 * | `unreadable`, `nothing_to_mask` | the text was read, and masking has something to mask |
 *
 * The folder rights (`requireFolderWrite` on every target) are asked last, as
 * the person, by {@link requireDecisionRights}; the filing job asks them again
 * when it uploads as that person.
 */

import { createHash, randomUUID } from 'node:crypto'
import { ConflictError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireFolderWrite } from '@/lib/authz/folder-access'
import type { InboundMailPartRow, InboundMailRow, NewInboundMailDecisionRow } from '@/lib/db/schema'
import { isAcceptedType } from '@/lib/documents/accepted-types'
import { documentNameKey } from '@/lib/documents/name-match'
import { appendNeedsAcknowledgement, isOwnBccCopy, senderPreselectionBlocks } from '@/lib/mail-thread/mail-threading'
import { normalizeFolderPath } from '@/lib/projects/folders'
import { senderEvidenceOf, threadIsFull, type ViewerCandidates } from './candidates'
import type { InboundMailRefusal } from './inbound-mail-wire'
import type { InboundMailDecision, InboundMailPartDecision } from './inbound-mail-wire'
import type { DecisionActor } from './repository'
import { findDocumentIdByStoredName, type CandidateDocument, type ThreadDocument } from './repository'

/** The Dokumentart a filed mail text's thread document carries (D14). */
export const THREAD_DOCUMENT_TYPE = 'correspondence' as const

/** Risk flags whose part is filed only with its id in `acknowledgeRisk` (D17); `unverified_thread` is judged per target. */
const ACKNOWLEDGED_RISK_FLAGS = ['macro', 'type_mismatch'] as const

/** A refusal with its code (`details.reason`) and what it names: ids and terms, never text. */
export function refusal(
  reason: InboundMailRefusal,
  message: string,
  details: Record<string, string | string[] | number> = {},
): ConflictError {
  return new ConflictError(message, { reason, ...details })
}

/**
 * The compare-and-set token of a mail as a person read it (C3): a digest of
 * the mail's and each part's state and change time. A decision carries it back,
 * and is refused when anything changed since (another person decided, a part
 * was filed, a scan finished).
 */
export function mailIfMatch(
  mail: Pick<InboundMailRow, 'id' | 'status' | 'updatedAt'>,
  parts: ReadonlyArray<Pick<InboundMailPartRow, 'id' | 'state' | 'scanStatus' | 'lastFailure' | 'updatedAt'>>,
): string {
  const facts = [
    mail.id,
    mail.status,
    new Date(mail.updatedAt).toISOString(),
    ...[...parts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((part) => `${part.id}:${part.state}:${part.scanStatus}:${part.lastFailure ?? ''}:${new Date(part.updatedAt).toISOString()}`),
  ]
  return createHash('sha256').update(facts.join('\n')).digest('base64url').slice(0, 27)
}

/**
 * Whether filing anything of this mail needs the person to accept its sender
 * (`acknowledgeSender`, C2): a member's address without their domain's
 * signature, a signature that failed or a policy that refused it, a verified
 * mail addressed to someone else (the replay of RT-S12, except a member's own
 * recent Bcc copy), or a Date more than seven days old. A plain unsigned mail
 * from a stranger needs none: it is labelled, never pre-selected (RT-X6).
 */
export function senderNeedsAcknowledgement(
  mail: Pick<InboundMailRow, 'senderTrust' | 'senderReason' | 'senderFlags'>,
): boolean {
  if (mail.senderTrust === 'member_unverified') return true
  if (mail.senderReason === 'dkim_fail' || mail.senderReason === 'dkim_policy') return true
  const sender = { senderTrust: mail.senderTrust ?? 'external_unverified', senderFlags: mail.senderFlags } as const
  if (mail.senderFlags.includes('not_addressed_to_project') && !isOwnBccCopy(sender)) return true
  return mail.senderFlags.includes('stale_date')
}

/** What a decision is checked against: the request, the office's rules, and the viewer's candidates. */
export interface DecisionContext {
  actor: DecisionActor
  /** More than one mail in the request: no acknowledgement may ride along (RT-S5). */
  bulk: boolean
  /** The office's accepted file extensions (`acceptedTypesForOrganization`). */
  acceptedTypes: readonly string[]
  /** The office's name terms a file name, in a folder path, matches; empty when it may pass. */
  nameStops(filename: string, folderPath: string | null): string[]
  candidates: ViewerCandidates
  /** The project's live folders the request names, each with its path. */
  folders: ReadonlyMap<string, string>
  /** The matched and named threads with a live document, as the viewer may or may not see them. */
  threads: ReadonlyMap<string, ThreadDocument>
  /** The documents `revisionOf` names, screened and live. */
  documents: ReadonlyMap<string, CandidateDocument>
}

/** One mail's decision, planned: the `file` rows, and what the person must still be allowed. */
export interface PlannedMailDecision {
  mailId: string
  ifMatch: string
  files: NewInboundMailDecisionRow[]
  /** Every folder a part goes into (null: the project root); the person must write in each. */
  writeFolders: Array<string | null>
  /** Names filed fresh (not as a Fassung): each must be free in the project. */
  freshNames: Array<{ partId: string; storedName: string }>
}

const refuseRisk = (partId: string, flag: string) =>
  refusal('risk_not_acknowledged', `Filing this part needs its risk accepted (${flag}): add its id to acknowledgeRisk`, {
    partId,
    flag,
  })

/** A target folder: an existing folder by id, a path to create, or the root. Throws `target_unknown` for a folder that is gone. */
function folderTarget(
  target: { folderId: string | null; newFolderPath: string | null },
  context: DecisionContext,
): { folderId: string | null; folderPath: string } {
  if (target.folderId) {
    const path = context.folders.get(target.folderId)
    if (path === undefined || !context.candidates.readsFolder(target.folderId)) {
      throw refusal('target_unknown', 'The folder was not found', { folderId: target.folderId })
    }
    return { folderId: target.folderId, folderPath: path }
  }
  return { folderId: null, folderPath: normalizeFolderPath(target.newFolderPath) }
}

/** The name check on a name filed into a folder path, unless the person released it. */
function requireNamePasses(
  name: string,
  folderPath: string,
  released: boolean,
  partId: string,
  context: DecisionContext,
): void {
  const terms = context.nameStops(name, folderPath || null)
  if (terms.length > 0 && !released) {
    throw refusal('name_stop', 'The name check stopped this name; file it under another name or release it (screeningRelease)', {
      partId,
      terms,
    })
  }
}

function planAttachment(
  mail: InboundMailRow,
  part: InboundMailPartRow,
  decision: InboundMailPartDecision,
  acknowledgedRisk: ReadonlySet<string>,
  context: DecisionContext,
): { row: NewInboundMailDecisionRow; writeFolder: string | null; freshName: string | null } {
  if (part.scanStatus !== 'clean') throw refusal('scan_not_clean', 'This attachment has no clean scan', { partId: part.id })
  if (part.riskFlags.includes('type_not_accepted') || !isAcceptedType(decision.name, context.acceptedTypes)) {
    throw refusal('type_not_accepted', 'The office does not file this file type', { partId: part.id })
  }
  for (const flag of ACKNOWLEDGED_RISK_FLAGS) {
    if (part.riskFlags.includes(flag) && !acknowledgedRisk.has(part.id)) throw refuseRisk(part.id, flag)
  }

  let target: { folderId: string | null; folderPath: string }
  if (decision.revisionOf) {
    const earlier = context.documents.get(decision.revisionOf)
    if (!earlier || !context.candidates.readsFolder(earlier.folderId)) {
      throw refusal('target_unknown', 'The document to file a new Fassung of was not found', { partId: part.id })
    }
    // A Fassung of a project document on a stranger's word is the unverified-thread case of D11.
    if (senderPreselectionBlocks(senderEvidenceOf(mail)).length > 0 && !acknowledgedRisk.has(part.id)) {
      throw refuseRisk(part.id, 'unverified_thread')
    }
    target = { folderId: earlier.folderId, folderPath: earlier.folderPath ?? '' }
  } else {
    target = folderTarget(decision, context)
  }
  requireNamePasses(decision.name, target.folderPath, decision.screeningRelease === 'name', part.id, context)

  return {
    row: {
      ...baseRow(mail, part.id, context.actor),
      folderId: target.folderId,
      folderPath: target.folderPath,
      fileName: decision.name,
      targetDocumentId: decision.revisionOf ?? null,
      documentType: decision.documentType ?? null,
      screeningRelease: decision.screeningRelease === 'name',
      acknowledgedRisk: acknowledgedRisk.has(part.id),
    },
    writeFolder: target.folderId,
    freshName: decision.revisionOf ? null : documentNameKey(decision.name),
  }
}

function planMessage(
  mail: InboundMailRow,
  part: InboundMailPartRow,
  message: NonNullable<InboundMailDecision['message']>,
  acknowledgedRisk: ReadonlySet<string>,
  context: DecisionContext,
): { row: NewInboundMailDecisionRow; writeFolder: string | null } {
  if (!mail.readStorageKey || part.riskFlags.includes('unreadable')) {
    throw refusal('unreadable', 'The text of this mail could not be read; download its original instead', { partId: part.id })
  }
  if (message.text === 'masked' && part.contentFindings.length === 0) {
    throw refusal('nothing_to_mask', 'The content check found nothing to mask in this text; file it as "full"', { partId: part.id })
  }
  const base = { ...baseRow(mail, part.id, context.actor), messageText: message.text, documentType: THREAD_DOCUMENT_TYPE }

  if (message.thread.action === 'append') {
    const threadId = message.thread.mailThreadId
    const thread = context.threads.get(threadId)
    if (!thread || !context.candidates.readsFolder(thread.folderId)) {
      throw refusal('target_unknown', 'The mail thread was not found', { partId: part.id, mailThreadId: threadId })
    }
    if (threadIsFull(thread)) {
      throw refusal('thread_full', 'The mail thread is full; file the message as a new thread that continues it', {
        partId: part.id,
        mailThreadId: threadId,
      })
    }
    const match = mail.threadMatch.find((candidate) => candidate.threadId === threadId)
    if (appendNeedsAcknowledgement(senderEvidenceOf(mail), match) && !acknowledgedRisk.has(part.id)) {
      throw refuseRisk(part.id, 'unverified_thread')
    }
    return {
      row: { ...base, threadAction: 'append', mailThreadId: threadId, acknowledgedRisk: acknowledgedRisk.has(part.id) },
      writeFolder: thread.folderId,
    }
  }

  const target = folderTarget(message.thread, context)
  const released = message.thread.screeningRelease === 'name'
  requireNamePasses(message.thread.name, target.folderPath, released, part.id, context)
  return {
    row: {
      ...base,
      threadAction: 'create',
      folderId: target.folderId,
      folderPath: target.folderPath,
      fileName: message.thread.name,
      screeningRelease: released,
      acknowledgedRisk: acknowledgedRisk.has(part.id),
    },
    writeFolder: target.folderId,
  }
}

function baseRow(
  mail: Pick<InboundMailRow, 'id' | 'organizationId' | 'projectId'>,
  partId: string,
  actor: DecisionActor,
): NewInboundMailDecisionRow {
  return {
    id: randomUUID(),
    organizationId: mail.organizationId,
    projectId: mail.projectId,
    mailId: mail.id,
    partId,
    action: 'file',
    decidedBy: actor.decidedBy,
    via: actor.via,
    proposalId: actor.proposalId,
  }
}

/** The part a decision names, if it is this mail's, of this kind, and still waiting. */
function waitingPart(parts: ReadonlyMap<string, InboundMailPartRow>, partId: string, kind: 'message' | 'attachment'): InboundMailPartRow {
  const part = parts.get(partId)
  if (!part || part.kind !== kind) throw refusal('part_unknown', `No ${kind} part of this mail has this id`, { partId })
  if (part.state !== 'waiting') throw refusal('part_not_waiting', 'This part is no longer waiting; read the mail again', { partId })
  return part
}

/**
 * Plan one mail's decision, or throw the first refusal with its code. Pure
 * apart from minting the decision ids; the caller loaded `mail`, its `parts`
 * and the context for the whole request.
 */
export function planMailDecision(
  mail: InboundMailRow,
  parts: readonly InboundMailPartRow[],
  decision: InboundMailDecision,
  context: DecisionContext,
): PlannedMailDecision {
  if (mail.status !== 'waiting' || mailIfMatch(mail, parts) !== decision.ifMatch) {
    throw refusal('stale', 'The mail changed since it was read; read it again and decide again', { mailId: mail.id })
  }
  const acknowledged = Boolean(decision.acknowledgeSender) || (decision.acknowledgeRisk?.length ?? 0) > 0
  if (acknowledged && context.bulk) {
    throw refusal('acknowledgement_in_bulk', 'Acknowledgements are a single mail’s decision; decide this mail on its own', {
      mailId: mail.id,
    })
  }
  const released =
    decision.parts.some((part) => part.screeningRelease) ||
    (decision.message?.thread.action === 'create' && decision.message.thread.screeningRelease !== undefined)
  if (context.actor.via === 'piloti_proposal' && (acknowledged || released)) {
    throw refusal('card_carries_acknowledgement', 'A card Piloti proposed files clean, unflagged parts only; the person decides the rest', {
      mailId: mail.id,
    })
  }

  const byId = new Map(parts.map((part) => [part.id, part]))
  const acknowledgedRisk = new Set(decision.acknowledgeRisk ?? [])
  const files: NewInboundMailDecisionRow[] = []
  const writeFolders: Array<string | null> = []
  const freshNames: PlannedMailDecision['freshNames'] = []
  for (const partDecision of decision.parts) {
    const part = waitingPart(byId, partDecision.partId, 'attachment')
    const planned = planAttachment(mail, part, partDecision, acknowledgedRisk, context)
    files.push(planned.row)
    writeFolders.push(planned.writeFolder)
    if (planned.freshName) freshNames.push({ partId: part.id, storedName: planned.freshName })
  }
  if (decision.message) {
    const part = waitingPart(byId, decision.message.partId, 'message')
    const planned = planMessage(mail, part, decision.message, acknowledgedRisk, context)
    files.push(planned.row)
    writeFolders.push(planned.writeFolder)
  }

  if (files.length > 0 && senderNeedsAcknowledgement(mail) && !decision.acknowledgeSender) {
    throw refusal('sender_not_acknowledged', 'This sender is not confirmed; filing needs acknowledgeSender', { mailId: mail.id })
  }
  const acknowledgedSender = files.length > 0 && Boolean(decision.acknowledgeSender)
  return {
    mailId: mail.id,
    ifMatch: decision.ifMatch,
    files: files.map((row) => ({ ...row, acknowledgedSender })),
    writeFolders,
    freshNames,
  }
}

/**
 * What the planned decisions need of the person and the project, asked last:
 * write in every target folder (404 for a folder they may not read, 403 for
 * one they may only read, the project-closed refusal for a closed project),
 * and every name filed fresh free in the project (`name_taken`; the name is
 * the person's own, the document is not named, since it may sit where they
 * cannot read).
 */
export async function requireDecisionRights(
  session: AuthorizedSession,
  projectId: string,
  plans: readonly PlannedMailDecision[],
): Promise<void> {
  const folders = plans.flatMap((plan) => plan.writeFolders)
  if (folders.length > 0) await requireFolderWrite(session, projectId, folders)
  for (const plan of plans) {
    for (const fresh of plan.freshNames) {
      const taken = await findDocumentIdByStoredName(projectId, fresh.storedName)
      if (!taken) continue
      throw refusal(
        'name_taken',
        'A document of this name is already in the project; file the part as its next Fassung (revisionOf) or rename it',
        { partId: fresh.partId },
      )
    }
  }
}
