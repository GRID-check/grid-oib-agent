/**
 * The decision a person is making about one held mail, before they press the
 * button, and the request it becomes (`inbound-mail-file`, D26).
 *
 * The draft starts as Piloti's suggestion and the server's candidates
 * (`initialDraft`), so pressing „Ablegen“ IS taking the suggestion over
 * (CONTEXT: Piloti's findings are Vorschläge until a person takes them over);
 * every field the person edits stops being Piloti's (`suggested`). The button
 * label, the bulk confirmation and the request are all read off the same
 * draft (`draftSummary`, `decisionOf`), so what the bar says is what is sent.
 *
 * Pure. Each function returns a new draft; nothing here mutates.
 */

import type { DocumentTypeTag } from '@/lib/documents/tag-vocabulary'
import type {
  InboundMailDecision,
  InboundMailPartDecision,
  InboundMailThreadCandidateView,
  InboundMailView,
} from '@/lib/inbound-mail/inbound-mail-wire'
import { attachmentCase, type AttachmentCase } from './attachment-case'
import { senderNeedsAcknowledgement } from './sender'
import { displaySubject } from './subject'
import { readSuggestion, type PartSuggestion } from './suggestion'

/** A folder of the project the person may see, with its full path and whether they may file into it. */
export interface FolderOption {
  id: string
  parentId: string | null
  name: string
  /** The path as the project names it, segments joined by `/`. */
  path: string
  writable: boolean
}

/** Where something is filed: a folder that exists (null id: the project root), or a path filing creates. */
export type FolderTarget = { kind: 'existing'; folderId: string | null; path: string } | { kind: 'new'; path: string }

export const ROOT_TARGET: FolderTarget = { kind: 'existing', folderId: null, path: '' }

export interface AttachmentDraft {
  partId: string
  checked: boolean
  name: string
  /** Null until a folder is chosen: Piloti suggested none, and filing waits for the person. */
  folder: FolderTarget | null
  documentType: DocumentTypeTag | null
  /** File as the next Fassung of this document. */
  revisionOf: string | null
  /** „Trotzdem ablegen“ on a name the name check stopped. */
  releaseName: boolean
  /** The person accepted the part's risk flag (macro, type mismatch, an unconfirmed Fassung). */
  acknowledgeRisk: boolean
  /** Which fields still hold Piloti's value. */
  suggested: { folder: boolean; name: boolean; documentType: boolean }
}

export type MessageTarget =
  | { kind: 'append'; threadId: string }
  | { kind: 'create'; name: string; folder: FolderTarget; releaseName: boolean }

/**
 * What to do with a text the content check found something in (D13): file it
 * with the findings made unrecognizable (the default), as a thread of its own,
 * or whole into the thread, which holds the thread until someone checks it.
 */
export type ContentFindingChoice = 'masked' | 'own_thread' | 'full'

export interface MessageDraft {
  partId: string
  checked: boolean
  target: MessageTarget
  findingChoice: ContentFindingChoice | null
  /** The person accepted appending to a thread the sender could not vouch for (`unverified_thread`). */
  acknowledgeThread: boolean
}

export interface MailDraft {
  mailId: string
  ifMatch: string
  attachments: AttachmentDraft[]
  message: MessageDraft | null
  /** „Domain nicht bestätigt. Trotzdem ablegen“. */
  acknowledgeSender: boolean
}

export interface DraftCopy {
  /** The name a nameless attachment is filed under, by its position. */
  unnamedAttachment: (position: number) => string
  /** The name of a new thread when the mail has no subject. */
  untitledThread: string
}

/** Folder names the office files correspondence in, for a new thread's default folder. */
const CORRESPONDENCE_FOLDER = /(?:^|\/)\s*(?:korrespondenz|schriftverkehr|correspondence|e-?mails?)\s*$/iu

/** The target a suggested path resolves to: the folder that has it, or a folder filing creates. */
export function targetForPath(path: string, folders: readonly FolderOption[], folderId: string | null = null): FolderTarget {
  const normalized = path.split('/').map((part) => part.trim()).filter(Boolean).join('/')
  if (normalized === '') return ROOT_TARGET
  const byId = folderId ? folders.find((folder) => folder.id === folderId) : undefined
  const existing = byId ?? folders.find((folder) => folder.path.localeCompare(normalized, undefined, { sensitivity: 'accent' }) === 0)
  return existing ? { kind: 'existing', folderId: existing.id, path: existing.path } : { kind: 'new', path: normalized }
}

function attachmentDraft(entry: AttachmentCase, folders: readonly FolderOption[], copy: DraftCopy): AttachmentDraft {
  const { part } = entry
  const suggestion: PartSuggestion | null = readSuggestion(part.suggestion)
  const revision = part.revisionCandidate
  const revisionChosen = revision !== null && entry.defaultChecked
  const folder = revisionChosen
    ? targetForPath(revision.folderPath ?? '', folders)
    : suggestion?.folder !== undefined && suggestion?.folder !== null
      ? targetForPath(suggestion.folder, folders, suggestion.folderId)
      : null
  return {
    partId: part.id,
    checked: entry.defaultChecked,
    name: suggestion?.name ?? part.filename ?? copy.unnamedAttachment(part.position),
    folder,
    documentType: suggestion?.documentType ?? null,
    revisionOf: revisionChosen ? revision.documentId : null,
    releaseName: false,
    acknowledgeRisk: false,
    suggested: {
      folder: folder !== null && !revisionChosen,
      name: suggestion?.name != null,
      documentType: suggestion?.documentType != null,
    },
  }
}

/** The candidate the text goes to by default: a pre-selected thread with room (D11). */
export function defaultThread(view: Pick<InboundMailView, 'threadCandidates'>): InboundMailThreadCandidateView | null {
  return view.threadCandidates.find((candidate) => candidate.preselected && !candidate.full) ?? null
}

/** The folder a new thread goes to by default: a correspondence folder the person may write, else the root. */
export function defaultThreadFolder(folders: readonly FolderOption[]): FolderTarget {
  const folder = folders.find((option) => option.writable && CORRESPONDENCE_FOLDER.test(option.path))
  return folder ? { kind: 'existing', folderId: folder.id, path: folder.path } : ROOT_TARGET
}

/**
 * A new thread for the text: named after the subject (the person confirms it),
 * in the folder Piloti suggested for the text where it did (D14: only when no
 * thread matched), else a correspondence folder, else the root.
 */
export function newThreadTarget(view: Pick<InboundMailView, 'subject' | 'parts'>, folders: readonly FolderOption[], copy: DraftCopy): MessageTarget {
  const suggested = readSuggestion(view.parts.find((part) => part.kind === 'message')?.suggestion)
  const folder = suggested?.folder != null ? targetForPath(suggested.folder, folders, suggested.folderId) : defaultThreadFolder(folders)
  return { kind: 'create', name: displaySubject(view.subject) ?? copy.untitledThread, folder, releaseName: false }
}

/** Whether the mail's own text can be filed at all: waiting, read, and the project open. */
export function messageSelectable(view: InboundMailView): boolean {
  const part = view.parts.find((candidate) => candidate.kind === 'message')
  return !!part && part.state === 'waiting' && !part.riskFlags.includes('unreadable') && !view.projectClosed
}

export function initialDraft(view: InboundMailView, folders: readonly FolderOption[], copy: DraftCopy): MailDraft {
  const attachments = view.parts
    .filter((part) => part.kind === 'attachment')
    .map((part) => attachmentDraft(attachmentCase(part, view), folders, copy))
  const messagePart = view.parts.find((part) => part.kind === 'message')
  let message: MessageDraft | null = null
  if (messagePart) {
    const thread = defaultThread(view)
    const alreadyFiled = view.sender?.flags.includes('already_filed') ?? false
    message = {
      partId: messagePart.id,
      checked: messageSelectable(view) && !alreadyFiled,
      target: thread ? { kind: 'append', threadId: thread.threadId } : newThreadTarget(view, folders, copy),
      findingChoice: messagePart.contentFindings.length > 0 ? 'masked' : null,
      acknowledgeThread: false,
    }
  }
  return { mailId: view.id, ifMatch: view.ifMatch, attachments, message, acknowledgeSender: false }
}

// ------------------------------------------------------------ edits

function sameTarget(a: FolderTarget | null, b: FolderTarget | null): boolean {
  if (a === null || b === null) return a === b
  return a.kind === b.kind && a.path === b.path && (a.kind === 'new' || b.kind === 'new' || a.folderId === b.folderId)
}

export function updateAttachment(draft: MailDraft, partId: string, change: Partial<Omit<AttachmentDraft, 'partId' | 'suggested'>>): MailDraft {
  return {
    ...draft,
    attachments: draft.attachments.map((attachment) =>
      attachment.partId !== partId
        ? attachment
        : {
            ...attachment,
            ...change,
            // A field stays Piloti's until the person gives it another value.
            suggested: {
              folder: attachment.suggested.folder && (change.folder === undefined || sameTarget(change.folder, attachment.folder)),
              name: attachment.suggested.name && (change.name === undefined || change.name === attachment.name),
              documentType:
                attachment.suggested.documentType && (change.documentType === undefined || change.documentType === attachment.documentType),
            },
          }
    ),
  }
}

export function updateMessage(draft: MailDraft, change: Partial<Omit<MessageDraft, 'partId'>>): MailDraft {
  return draft.message ? { ...draft, message: { ...draft.message, ...change } } : draft
}

/** The content-check choice also decides the target: „Als eigenen E-Mail-Verlauf ablegen“ makes a new one. */
export function chooseFinding(
  draft: MailDraft,
  choice: ContentFindingChoice,
  view: InboundMailView,
  folders: readonly FolderOption[],
  copy: DraftCopy,
): MailDraft {
  if (!draft.message) return draft
  const target =
    choice === 'own_thread' && draft.message.target.kind !== 'create' ? newThreadTarget(view, folders, copy) : draft.message.target
  return updateMessage(draft, { findingChoice: choice, target })
}

// ------------------------------------------------------------ what it needs and says

/** The candidate a draft's text appends to, when it appends. */
export function appendCandidate(view: Pick<InboundMailView, 'threadCandidates'>, draft: MailDraft): InboundMailThreadCandidateView | null {
  const target = draft.message?.target
  return target?.kind === 'append' ? (view.threadCandidates.find((candidate) => candidate.threadId === target.threadId) ?? null) : null
}

/**
 * Whether appending to this candidate needs the `unverified_thread` yes: any
 * block but a weak match (a subject match from a confirmed sender is merely
 * not pre-selected; everything else is the sender failing to vouch, D11).
 */
export function appendNeedsAcknowledgement(candidate: InboundMailThreadCandidateView): boolean {
  return candidate.blocks.some((block) => block !== 'weak_match')
}

/** Why the button cannot file yet, in the order the reader resolves them. */
export type DraftBlocker =
  | { kind: 'project_closed' }
  | { kind: 'folder_missing'; count: number }
  | { kind: 'name_stop'; count: number }
  | { kind: 'risk'; count: number }
  | { kind: 'thread_name_missing' }
  | { kind: 'sender' }

export interface DraftSummary {
  files: number
  text: boolean
  /** The text appends to this thread and becomes its Fassung N. */
  thread: { name: string; nextVersion: number } | null
  /** Nothing is filed, so the original is erased when the mail settles (D6). */
  originalErased: boolean
  needsSenderAcknowledgement: boolean
  blockers: DraftBlocker[]
}

export function draftSummary(view: InboundMailView, draft: MailDraft): DraftSummary {
  const cases = new Map(view.parts.map((part) => [part.id, attachmentCase(part, view)]))
  const checked = draft.attachments.filter((attachment) => attachment.checked && cases.get(attachment.partId)?.selectable)
  const text = !!draft.message?.checked && messageSelectable(view)
  const candidate = text ? appendCandidate(view, draft) : null
  const files = checked.length
  const needsSender = files + (text ? 1 : 0) > 0 && !!view.sender && senderNeedsAcknowledgement(view.sender)

  const blockers: DraftBlocker[] = []
  if (view.projectClosed) blockers.push({ kind: 'project_closed' })
  const folderMissing = checked.filter((attachment) => attachment.folder === null && attachment.revisionOf === null).length
  if (folderMissing > 0) blockers.push({ kind: 'folder_missing', count: folderMissing })
  const nameStops = checked.filter((attachment) => cases.get(attachment.partId)?.part.riskFlags.includes('name_stop') && !attachment.releaseName).length
  if (nameStops > 0) blockers.push({ kind: 'name_stop', count: nameStops })
  const risks =
    checked.filter((attachment) => attachmentNeedsAcknowledgement(view, attachment, cases.get(attachment.partId)) && !attachment.acknowledgeRisk)
      .length + (candidate && appendNeedsAcknowledgement(candidate) && !draft.message?.acknowledgeThread ? 1 : 0)
  if (risks > 0) blockers.push({ kind: 'risk', count: risks })
  if (text && draft.message?.target.kind === 'create' && draft.message.target.name.trim() === '') blockers.push({ kind: 'thread_name_missing' })
  if (needsSender && !draft.acknowledgeSender) blockers.push({ kind: 'sender' })

  return {
    files,
    text,
    thread: candidate ? { name: candidate.name, nextVersion: candidate.nextVersion } : null,
    originalErased: !text,
    needsSenderAcknowledgement: needsSender,
    blockers,
  }
}

/** Whether filing this attachment as drafted needs its risk accepted. */
export function attachmentNeedsAcknowledgement(
  view: Pick<InboundMailView, 'sender' | 'projectClosed'>,
  attachment: AttachmentDraft,
  entry: AttachmentCase | undefined,
): boolean {
  if (!entry) return false
  if (entry.risk) return true
  const revision = entry.notes.find((note) => note.kind === 'revision')
  return attachment.revisionOf !== null && revision?.kind === 'revision' && !revision.verified
}

// ------------------------------------------------------------ the request

function folderFields(target: FolderTarget | null): { folderId: string | null; newFolderPath: string | null } {
  if (!target) return { folderId: null, newFolderPath: null }
  return target.kind === 'existing' ? { folderId: target.folderId, newFolderPath: null } : { folderId: null, newFolderPath: target.path }
}

/**
 * The request for one mail. Unchecked parts are not named, so the server
 * dismisses them (D26). Acknowledgements ride only where the draft has them
 * and the mail needs them; `bulk` leaves every one out (RT-S5), which is why a
 * bulk decision is only offered for complete mails.
 */
export function decisionOf(view: InboundMailView, draft: MailDraft, options: { bulk?: boolean } = {}): InboundMailDecision {
  const cases = new Map(view.parts.map((part) => [part.id, attachmentCase(part, view)]))
  const acknowledged: string[] = []
  const parts: InboundMailPartDecision[] = draft.attachments
    .filter((attachment) => attachment.checked && cases.get(attachment.partId)?.selectable)
    .map((attachment) => {
      if (attachment.acknowledgeRisk && attachmentNeedsAcknowledgement(view, attachment, cases.get(attachment.partId))) {
        acknowledged.push(attachment.partId)
      }
      return {
        partId: attachment.partId,
        ...folderFields(attachment.folder),
        name: attachment.name.trim(),
        ...(attachment.documentType ? { documentType: attachment.documentType } : {}),
        ...(attachment.revisionOf ? { revisionOf: attachment.revisionOf } : {}),
        ...(attachment.releaseName ? { screeningRelease: 'name' as const } : {}),
      }
    })

  let message: InboundMailDecision['message'] = null
  const draftMessage = draft.message
  if (draftMessage?.checked && messageSelectable(view)) {
    const target = draftMessage.target
    const thread: NonNullable<InboundMailDecision['message']>['thread'] =
      target.kind === 'append'
        ? { action: 'append', mailThreadId: target.threadId }
        : {
            action: 'create',
            ...folderFields(target.folder),
            name: target.name.trim(),
            ...(target.releaseName ? { screeningRelease: 'name' as const } : {}),
          }
    message = { partId: draftMessage.partId, text: draftMessage.findingChoice === 'masked' ? 'masked' : 'full', thread }
    const candidate = appendCandidate(view, draft)
    if (candidate && appendNeedsAcknowledgement(candidate) && draftMessage.acknowledgeThread) acknowledged.push(draftMessage.partId)
  }

  const decision: InboundMailDecision = { mailId: view.id, ifMatch: draft.ifMatch, parts, message }
  if (options.bulk) return decision
  if (draft.acknowledgeSender && view.sender && senderNeedsAcknowledgement(view.sender) && (parts.length > 0 || message)) {
    decision.acknowledgeSender = true
  }
  if (acknowledged.length > 0) decision.acknowledgeRisk = acknowledged
  return decision
}
