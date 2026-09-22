/**
 * What the lifecycle looks like from the reader's side: when the state badge
 * appears, and which review controls this reader gets on this version.
 *
 * ## There is no second transition table here
 *
 * Every answer below is FILTERED out of `DOCUMENT_VERSION_TRANSITIONS`
 * (`@/lib/documents/lifecycle-types`), which is the same table the routes and
 * the service read. A control appears because a row says this state can go
 * there, this actor may do it, and the reader holds one of the permissions the
 * row names — never because a second list in the UI agreed with the first. That
 * is the whole reason the table is data: ADR-0054's "a new state is one row,
 * one CHECK edit and one i18n key" is only true while nobody restates it.
 *
 * The one thing that is not in the table is `archive`, and it is not an
 * oversight: archiving is ITEM-level (`documents.lifecycle`), not a version
 * state, so it has no `from`/`to` row to filter. Its permission is stated below
 * with a pointer to the service function that enforces it.
 *
 * Pure and outside the components, like `file-filters.ts` beside it: a
 * visibility rule tested through a mounted React tree is a rule nobody reads.
 */

import {
  DOCUMENT_VERSION_TRANSITIONS,
  transitionsForOp,
  type DocumentLifecyclePermission,
  type DocumentVersionOp,
  type DocumentVersionState,
  type DocumentVersionTransition,
  type DocumentVersionView,
} from '@/lib/documents/lifecycle-types'
import type { DocumentAuthor } from '@/lib/db/schema'

/**
 * The ops a REVIEW surface offers.
 *
 * `upload`, `create` and `update` are missing on purpose: all three write bytes,
 * and bytes are written by the upload path and by the agent's working directory
 * — never by a pane that is looking at a version. Filtered against the op union
 * so a new op cannot be silently forgotten here: adding one to
 * `DOCUMENT_VERSION_OPS` leaves this list still compiling, but the reviewer of
 * that change reads this comment.
 */
export const DOCUMENT_REVIEW_OPS = [
  'submit',
  'approve',
  'request_changes',
  'reject',
  'publish',
] as const satisfies readonly DocumentVersionOp[]

export type DocumentReviewOp = (typeof DOCUMENT_REVIEW_OPS)[number]

/** Every gesture the pane can offer, including the item-level one. */
export type DocumentLifecycleAction = DocumentReviewOp | 'archive'

/**
 * `archiveDocument`'s own check, restated as the ONE thing the UI cannot read
 * off the transition table (`lib/documents/lifecycle.ts`: `requireProjectAccess`
 * with `['project:documents:write', 'project:edit']`). An any-of list, like the
 * table's `permission` field, and for the same ADR-0038 reason: a custom role
 * provisioned before the split holds only the umbrella.
 */
export const DOCUMENT_ARCHIVE_PERMISSIONS: readonly DocumentLifecyclePermission[] = [
  'project:documents:write',
  'project:edit',
]

/** Who is looking, in the only two terms the decision needs. */
export interface DocumentLifecycleViewer {
  /** Resolved on the server (`lib/documents/lifecycle-permissions.ts`). */
  permissions: readonly DocumentLifecyclePermission[]
  /** WorkOS user id, for the rows that require "not the submitter". */
  userId?: string | null
}

function holdsAny(
  viewer: DocumentLifecycleViewer,
  accepted: readonly DocumentLifecyclePermission[],
): boolean {
  return accepted.some((permission) => viewer.permissions.includes(permission))
}

/**
 * The review controls to show for one version.
 *
 * Order is the table's, which is the order a document walks the states — so
 * Freigeben stands before Änderungen anfordern before Ablehnen, wherever they
 * appear together.
 */
export function availableReviewOps(
  version: Pick<DocumentVersionView, 'state' | 'submittedBy'>,
  viewer: DocumentLifecycleViewer,
): DocumentReviewOp[] {
  // Widened to the row INTERFACE before filtering. `DOCUMENT_VERSION_TRANSITIONS`
  // is `as const`, so its members are literal types and only the rows that
  // happen to carry `alsoRequires` (or `requires.notSubmitter`) declare it —
  // reading those fields off the raw union does not compile. The table still
  // checks itself: `as const satisfies readonly DocumentVersionTransition[]` at
  // the declaration is what makes this widening safe rather than a cast.
  const rows: readonly DocumentVersionTransition[] = DOCUMENT_VERSION_TRANSITIONS
  const ops = rows.filter((row) => {
    if (!(DOCUMENT_REVIEW_OPS as readonly string[]).includes(row.op)) return false
    if (row.from !== version.state) return false
    if (!holdsAny(viewer, row.permission)) return false
    if (row.alsoRequires && !viewer.permissions.includes(row.alsoRequires)) return false
    // „not the submitter": approval is the office asserting the content, and an
    // assertion nobody but the author has read is not one. Hidden rather than
    // disabled — the reader cannot become somebody else, so a greyed Freigeben
    // is a control with no path to being pressed.
    if (row.requires.notSubmitter && version.submittedBy && version.submittedBy === viewer.userId) {
      return false
    }
    return true
  }).map((row) => row.op as DocumentReviewOp)

  return [...new Set(ops)]
}

/**
 * Whether this op's request must carry words.
 *
 * Read off `requires.comment`, and asserted across EVERY row for the op: if one
 * path into `rejected` needed a reason and another did not, the form would have
 * to ask which one this is, and that question belongs in the table rather than
 * in a textarea's `required` attribute.
 */
export function reviewOpRequiresComment(op: DocumentReviewOp): boolean {
  const rows = transitionsForOp(op)
  return rows.length > 0 && rows.every((row) => row.requires.comment === true)
}

/** Archivieren, for an item that is not archived already. */
export function canArchiveDocument(
  lifecycle: 'active' | 'archived',
  viewer: DocumentLifecycleViewer,
): boolean {
  return lifecycle === 'active' && holdsAny(viewer, DOCUMENT_ARCHIVE_PERMISSIONS)
}

/** Every gesture to offer, review ops first and the item-level one last. */
export function availableLifecycleActions(
  version: Pick<DocumentVersionView, 'state' | 'submittedBy'> | null,
  lifecycle: 'active' | 'archived',
  viewer: DocumentLifecycleViewer,
): DocumentLifecycleAction[] {
  const review = version ? availableReviewOps(version, viewer) : []
  return canArchiveDocument(lifecycle, viewer) ? [...review, 'archive'] : review
}

/**
 * „Piloti überarbeiten lassen" — the reviewer's third decision, and NOT a
 * fourth op.
 *
 * The version moves to `changes_requested` either way and the comment is
 * required either way; what this adds is `delegateRevision` on the request, so
 * Piloti is additionally asked to write the next draft and submit it
 * (`openRevisionTask`, ADR-0054). `lifecycle-types.ts` argues why that is a
 * FIELD rather than an op — a fourth row of the transition table would be
 * identical to `request_changes` in every column that decides anything — and
 * this module has to hold the same line, because a second op invented here
 * would be exactly the second table the file header forbids.
 *
 * So the surface draws one more BUTTON than there are ops, and the mapping back
 * to an op is {@link lifecycleRequestFor}, one function, in one place.
 */
export const DELEGATE_REVISION = 'delegate_revision'

/** What a review surface draws: every action, plus the one that is not an op. */
export type DocumentLifecycleGesture = DocumentLifecycleAction | typeof DELEGATE_REVISION

/** What a gesture SENDS: an op, and whether it hands the revision to Piloti. */
export interface DocumentLifecycleRequest {
  action: DocumentLifecycleAction
  delegateRevision: boolean
}

/** The gesture, resolved to the request the typed client takes. */
export function lifecycleRequestFor(gesture: DocumentLifecycleGesture): DocumentLifecycleRequest {
  return gesture === DELEGATE_REVISION
    ? { action: 'request_changes', delegateRevision: true }
    : { action: gesture, delegateRevision: false }
}

/**
 * The gestures to draw, in the order the buttons stand.
 *
 * „Piloti überarbeiten lassen" sits immediately BESIDE „Änderungen anfordern"
 * and appears under exactly the same condition — it is the same transition, so
 * a reader who may not send a version back may not delegate its revision
 * either, and there is no second permission to read.
 */
export function availableLifecycleGestures(
  version: Pick<DocumentVersionView, 'state' | 'submittedBy'> | null,
  lifecycle: 'active' | 'archived',
  viewer: DocumentLifecycleViewer,
): DocumentLifecycleGesture[] {
  return availableLifecycleActions(version, lifecycle, viewer).flatMap((action) =>
    action === 'request_changes' ? [action, DELEGATE_REVISION] : [action],
  )
}

/**
 * What the badge says about a document as a whole.
 *
 * `archived` is not a version state (ADR-0054: „archiviert" is a statement about
 * the FILE), so the two are folded here, at the one point that renders a single
 * word — and the item wins, because a reader looking at an archived document is
 * not interested in which version was live when it left the working set.
 */
export type DocumentBadgeState = DocumentVersionState | 'archived'

export interface DocumentVersionBadgeSubject {
  /** The newest version's state; `null` on a listing that did not read it. */
  versionState?: DocumentVersionState | null
  /** How many versions the document has; `null` when unknown. */
  versionCount?: number | null
  lifecycle?: 'active' | 'archived'
  authoredBy?: DocumentAuthor | null
}

/**
 * Whether the file card and the pane header show a state badge at all.
 *
 * **The rule: history, or a machine wrote it.** A person's upload is born
 * `published` and born approved — the person who uploaded it IS the assertion
 * (ADR-0054) — so a badge on it would appear on every row of every folder and
 * distinguish nothing, which is the same reason „Zitierbar" is not a chip. It
 * earns its place exactly when there is something to know: the document has more
 * than one version (somebody has revised it, so which one is live is a real
 * question), or Piloti wrote it (in which case the state is the whole story —
 * Entwurf, In Prüfung, Freigegeben).
 *
 * A third clause would be redundant and is deliberately absent: a single-version
 * human document is always `published`, because `upload` is the only transition
 * with `from: null` a person can reach.
 *
 * An ARCHIVED document always shows, whatever its history: it has left the
 * working set, and that is the one fact a reader who found it anyway needs.
 */
export function showsVersionStateBadge(subject: DocumentVersionBadgeSubject): boolean {
  if (subject.lifecycle === 'archived') return true
  if (!subject.versionState) return false
  return (subject.versionCount ?? 0) > 1 || subject.authoredBy === 'agent'
}

/** The word the badge carries, or `null` when it carries none. */
export function documentBadgeState(
  subject: DocumentVersionBadgeSubject,
): DocumentBadgeState | null {
  if (!showsVersionStateBadge(subject)) return null
  if (subject.lifecycle === 'archived') return 'archived'
  return subject.versionState ?? null
}

/**
 * The stages a version walks, as a progress track.
 *
 * The whole reason this exists: „Entwurf", „In Prüfung", „Freigegeben" and
 * „Veröffentlicht" are four words a reader has to have been TOLD the order of.
 * A track shows the order, so the badge stops being trivia and becomes a
 * position. Four segments, no chroma — ink for what is behind the document,
 * paper for what is ahead, which is the same vocabulary the diff uses and for
 * the same reason (`docs/design/grid-design-language.md`: colour is provenance).
 *
 * Off-track states map ONTO the track rather than adding segments to it:
 * „Änderungen erbeten" is a draft that has been round once, „Abgelehnt" is a
 * review that ended. Both carry {@link LifecycleProgress.halted}, which is what
 * the rendering turns into a stopped segment — a fifth and sixth segment would
 * say the document has further to walk, and it does not.
 */
export const LIFECYCLE_STAGES = ['draft', 'in_review', 'approved', 'published'] as const

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number]

/**
 * What the walked part of the track is coloured by.
 *
 * Not one value per state: three, because the reader is being told one thing —
 * has anything happened to this document yet, and was it good or a stop.
 * `moving` is neutral ink and the common case; a version in flight has asserted
 * nothing, and a colour on it would be decoration rather than signal.
 */
export type LifecycleTone = 'moving' | 'settled' | 'stopped' | 'retired'

export interface LifecycleProgress {
  /** Segments behind the document, `0`–`4`. */
  reached: number
  /** The track stopped here: the version was sent back or refused. */
  halted: boolean
  /** The item left the working set, so the track is history whatever it says. */
  archived: boolean
  /** The walked segments' register. `retired` outranks every version-level one. */
  tone: LifecycleTone
}

/**
 * Where each state stands on the track. A map over the state union, so a new
 * state does not compile until somebody has placed it.
 */
const STAGE_PROGRESS: Record<
  DocumentVersionState,
  { reached: number; halted: boolean; tone: LifecycleTone }
> = {
  draft: { reached: 1, halted: false, tone: 'moving' },
  in_review: { reached: 2, halted: false, tone: 'moving' },
  // Back at the draft it came from, and stopped: the next move is a new version.
  changes_requested: { reached: 1, halted: true, tone: 'stopped' },
  // The office has asserted the content — the first state that has earned a
  // colour, and it keeps it through publication.
  approved: { reached: 3, halted: false, tone: 'settled' },
  published: { reached: 4, halted: false, tone: 'settled' },
  // The review ran and ended. Two segments behind it, nothing ahead.
  rejected: { reached: 2, halted: true, tone: 'stopped' },
  // It was live once; a newer version took its place. The walk was completed.
  superseded: { reached: 4, halted: false, tone: 'settled' },
}

export function lifecycleProgress(
  version: Pick<DocumentVersionView, 'state'> | null,
  lifecycle: 'active' | 'archived',
): LifecycleProgress {
  const archived = lifecycle === 'archived'
  if (!version) return { reached: 0, halted: false, archived, tone: 'moving' }
  const stage = STAGE_PROGRESS[version.state]
  // The item-level fact outranks the version-level one, the same way the badge
  // and the waiting line let „Stillgelegt" win: a file that has left the
  // working set is not green, whatever its last version achieved.
  return { ...stage, archived, tone: archived ? 'retired' : stage.tone }
}

/**
 * What this version is waiting for, as an i18n leaf plus the one id the wording
 * may need.
 *
 * Extracted from the control strip because the STAND is now said in two places
 * — on the collapsed panel, where it is the only thing said, and under the
 * controls when the panel is open — and a second `switch` over the state union
 * is exactly the drift this module's header refuses for the transition table.
 *
 * Who was ASKED stays absent on purpose: the reviewer chain is resolved
 * server-side (`lib/documents/reviewers.ts`), so no name is invented for them.
 */
export interface LifecycleWaiting {
  /** Leaf under `files.lifecycle.waiting`. */
  key: string
  /** The submitter, when the wording names them. */
  submitterUserId?: string | null
}

export function lifecycleWaiting(
  version: Pick<DocumentVersionView, 'state' | 'submittedBy'> | null,
  lifecycle: 'active' | 'archived',
): LifecycleWaiting {
  if (lifecycle === 'archived') return { key: 'archived' }
  if (!version) return { key: 'none' }
  switch (version.state) {
    case 'draft':
      return { key: 'draft' }
    case 'in_review':
      return version.submittedBy
        ? { key: 'inReviewBy', submitterUserId: version.submittedBy }
        : { key: 'inReview' }
    case 'changes_requested':
      return { key: 'changesRequested' }
    case 'approved':
      return { key: 'approved' }
    case 'published':
      return { key: 'published' }
    case 'rejected':
      return { key: 'rejected' }
    case 'superseded':
      return { key: 'superseded' }
  }
}

/**
 * Whether the panel opens itself.
 *
 * „Need to know" is the whole point of the disclosure: a version list and a set
 * of review controls are not what a reader came to a file for, and on the great
 * majority of files (a person's upload, born published) there is nothing to
 * decide at all. So the section stays shut — UNLESS something is expected of
 * THIS reader, which is precisely „a gesture that moves the version is
 * available to them".
 *
 * `archive` is excluded, and that exclusion is the rule rather than a tweak: it
 * is offered on every active document to anybody who may write, so counting it
 * would open the panel on every file in the project and mean nothing.
 */
export function lifecycleNeedsReader(
  version: Pick<DocumentVersionView, 'state' | 'submittedBy'> | null,
  lifecycle: 'active' | 'archived',
  viewer: DocumentLifecycleViewer,
): boolean {
  return availableLifecycleGestures(version, lifecycle, viewer).some(
    (gesture) => gesture !== 'archive',
  )
}
