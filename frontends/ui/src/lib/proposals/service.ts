/**
 * Proposed changes — the rules (ADR-0105; `docs/architecture/proposed-changes.md`).
 *
 * Piloti proposes on behalf of the person whose turn it is; a person decides.
 *
 * - **Reading** takes `project:view` on the proposal's project AND `viewer` on
 *   the conversation it was made in. The card in that conversation is the
 *   proposal's surface, and its payload names files and folders; a reader who
 *   cannot see the conversation (a restricted folder's audience, a private
 *   chat) learns nothing from the id. Every refusal is a 404.
 * - **Deciding** (apply, dismiss) takes the read, plus the right the KIND
 *   writes with (`./kinds` `DECIDE_PERMISSIONS`): the project's documents
 *   (`project:documents:write`) for a file operation, its memory
 *   (`project:memory:write`) for a note or a profile change, `project:edit`
 *   for all three. A reader without it gets a 403. A closed project is
 *   read-only and refuses with its own 403.
 * - **After a decision** (committed, never awaited, never failing it) four
 *   things follow: the live channel `proposal:<id>` hears of it, so every open
 *   card re-reads (`lib/realtime/proposal-channel.ts`); the inbox is told
 *   nothing waits any more (`./attention`); the organization's audit trail
 *   records who decided and how (`./audit`); and the decision is a score on
 *   the trace of the turn that proposed it (`lib/langfuse/decision-score.ts`).
 *   Filing a proposal is in the trail too, once per card.
 * - **Applying** runs the kind's applier in the DECIDING person's session:
 *   the document, folder and assignment services for a file operation
 *   (`./executors`), the memory and profile services for the other two
 *   (`./appliers`), so every check they make by hand is made again. It is a
 *   compare-and-swap on `proposed`: the claim is committed before the first
 *   item runs and the settle clears it, so a double click or a second tab is a
 *   409. An applier that throws (a refusal of the decider) gives the claim back.
 * - **Creating** is idempotent per card: with the answer's message id and the
 *   card's index, the same card twice returns the first proposal.
 * - **The Büroablage** (0146): a proposal with no project is the office
 *   shelf's, and can only move its documents. Any member reads the Büroablage,
 *   so reading needs no project right; deciding needs its curators' right
 *   (`canManageOfficeShelf`), the one every write to it asks.
 * - **The organization** (0176): a proposal with no project that is not the
 *   Büroablage's is an `operation` Piloti proposed in a turn outside any
 *   project (the office's memory, a skill). It is read like a project's, by
 *   `viewer` on its conversation (or, made in none, by the person it was made
 *   for alone), and decided by anyone who reads it: it asks no project right,
 *   because the operation's own route, run in the decider's session, is the
 *   gate (ADR-0122).
 * - **A proposal no conversation made** (a filing suggestion, `lib/filing`)
 *   has no card to borrow a reader from, so it is read through the documents
 *   it names: every one must resolve for the reader on their shelf, or it is
 *   a 404. A document still held by its screening (ADR-0086), or in a folder
 *   the reader may not open (ADR-0087), is not named to them through it.
 * - **Withdrawing** is Piloti's, never a person's: an undecided proposal its
 *   own later reading no longer supports is deleted, and nothing waits on
 *   anybody any more. A decided proposal is a record and stays.
 */

import 'server-only'
import { defaultLocale, type Locale } from '@/i18n/config'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canManageOfficeShelf } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { findOperation } from '@/lib/agent-api/catalog'
import { describeTargets, requireTargetsReadable, TooManyTargetsError, targetsOf } from '@/lib/agent-api/operation-targets'
import { requireResourceAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { recordDecisionScore, type Decision } from '@/lib/langfuse/decision-score'
import { onProposalCreated, onProposalDecided } from './attention'
import { auditProposalCreated, auditProposalDecided } from './audit'
import { resolveItemDocuments } from './executors'
import {
  applyKind,
  DECIDE_PERMISSIONS,
  noticeVariantOf,
  ORGANIZATION_KINDS,
  parseKindPayload,
  requireProposable,
  summaryOf,
  type KindPayload,
} from './kinds'
import { publishProposalDecided } from './live'
import {
  claimProposedChange,
  deleteUndecidedProposedChange,
  dismissProposedChange,
  findOpenOperationProposal,
  findProposedChange,
  insertProposedChange,
  listShelfProposals,
  releaseProposedChange,
  settleProposedChange,
  type ProposalShelf,
  type ProposedChangeRow,
} from './repository'
import {
  type ApplyProposalRequest,
  type ListedProposal,
  type ParsedProposalListQuery,
  type ProposalListResponse,
  type ProposalScope,
  type ProposedChangeKind,
  type ProposedChangeResult,
  type ProposedChangeStatus,
  type ProposedChangeView,
} from './types'

/**
 * How long an apply may hold its claim before another decision may take over.
 * Twenty items of a few service calls each finish in seconds; a claim this old
 * belongs to a request that died.
 */
export const APPLY_CLAIM_TTL_MS = 5 * 60 * 1000

const staleBefore = (now = Date.now()) => new Date(now - APPLY_CLAIM_TTL_MS)

const claimIsLive = (row: ProposedChangeRow, now = Date.now()) =>
  row.applyingSince !== null && row.applyingSince.getTime() >= now - APPLY_CLAIM_TTL_MS

/** The shelf a proposal with this payload and this project is on. */
function scopeOf(projectId: string | null, typed: KindPayload): ProposalScope {
  if (projectId) return 'project'
  return ORGANIZATION_KINDS.has(typed.kind) ? 'organization' : 'office_shelf'
}

export interface CreateProposalInput {
  /**
   * The project. Null files it on the Büroablage (0146), where only a move of
   * its documents is proposable, or, for an `operation`, on the organization (0176).
   */
  projectId: string | null
  kind: ProposedChangeKind
  /** The contract's payload for `kind`; parsed here. */
  payload: unknown
  /** The turn's conversation, from the signed envelope; null for a turn outside one. */
  conversationId: string | null
  answerMessageId: string | null
  /** Which card of that answer; with `answerMessageId` the create is idempotent. */
  originCardIndex?: number | null
  /** The Langfuse trace of the judgement that proposed it, when no turn did; the decision is scored on it. */
  originTraceId?: string | null
}

/**
 * File Piloti's proposal on behalf of `session`'s person, in a project they can
 * read. Proposing changes nothing, so reading is enough; deciding takes the
 * kind's write. The same card of the same answer a second time returns the
 * first proposal as it stands, and tells nobody again; so does an operation
 * proposal repeated in its conversation for the same person while the first is
 * still `proposed` (the same operation, the same input, 0176 and 0178).
 */
export async function createProposal(session: AuthorizedSession, input: CreateProposalInput): Promise<ProposedChangeRow> {
  // Any member reads the Büroablage; a project is read with `project:view`.
  if (input.projectId) await requireProjectAccess(session, input.projectId, 'project:view')
  const typed = parseKindPayload(input.kind, input.payload)
  const scope = scopeOf(input.projectId, typed)
  requireProposable(typed, scope)
  if (input.conversationId) {
    const conversation = await findConversationInOrg(input.conversationId, session.organizationId)
    if (!conversation) throw new NotFoundError('Conversation not found')
    if (typed.kind === 'operation') {
      const open = await findOpenOperationProposal(session.organizationId, input.conversationId, session.userId, typed.payload)
      if (open) return open
    }
  }
  const { row, created } = await insertProposedChange({
    organizationId: session.organizationId,
    projectId: input.projectId,
    scope,
    kind: typed.kind,
    payload: typed.payload,
    proposedByKind: 'piloti',
    onBehalfOf: session.userId,
    originConversationId: input.conversationId,
    originMessageId: input.answerMessageId,
    originCardIndex: input.answerMessageId ? (input.originCardIndex ?? null) : null,
    originTraceId: input.originTraceId ?? null,
  })
  if (!created) {
    // The card's key is (answer, card index), and the answer id comes from the
    // request: a repeat may only get back ITS OWN first proposal. One filed for
    // another project, conversation or kind is somebody else's, never returned.
    if (
      row.projectId !== input.projectId ||
      row.originConversationId !== input.conversationId ||
      row.kind !== typed.kind
    ) {
      throw new ConflictError('This card already names another proposal', { reason: 'proposal-card-taken' })
    }
    return row
  }
  auditProposalCreated(session, row, typed)
  bestEffort('attention (created)', () =>
    onProposalCreated({
      organizationId: row.organizationId,
      projectId: row.projectId,
      proposalId: row.id,
      originConversationId: row.originConversationId,
      onBehalfOf: row.onBehalfOf,
      summary: summaryOf(typed),
      variant: noticeVariantOf(typed),
    })
  )
  return row
}

/** Run a side effect of a write that has committed, and never let it reach the write: a failure is logged. */
function bestEffort(what: string, run: () => Promise<unknown>): void {
  void Promise.resolve()
    .then(run)
    .catch((error: unknown) => {
      console.warn(`[proposals] ${what} failed (non-fatal):`, error)
    })
}

/**
 * What follows a committed decision. A fully or partly applied proposal is
 * `accepted` and a dismissed one `dismissed`; one where nothing went through
 * (`failed`) was neither taken nor refused, so it is not scored.
 */
function afterDecision(session: AuthorizedSession, row: ProposedChangeRow): void {
  const status = row.status
  if (status === 'proposed') return
  bestEffort('live publish', () => publishProposalDecided(row.id, status))
  bestEffort('attention (decided)', () => onProposalDecided({ organizationId: row.organizationId, proposalId: row.id }))
  auditProposalDecided(session, row)
  const decision: Decision | null =
    status === 'dismissed' ? 'dismissed' : status === 'failed' ? null : 'accepted'
  if (!decision) return
  bestEffort('decision score', () =>
    recordDecisionScore({
      organizationId: row.organizationId,
      subject: 'proposal',
      subjectId: row.id,
      decision,
      decidedBy: session.userId,
      origin:
        row.originConversationId && row.originMessageId
          ? { conversationId: row.originConversationId, messageId: row.originMessageId }
          : null,
      traceId: row.originTraceId,
    })
  )
}

/**
 * The documents a file operation names, as this reader resolves them on their
 * shelf, or null when one of them does not resolve for them. Empty for a kind
 * that names no document.
 */
async function documentsFor(
  session: AuthorizedSession,
  row: ProposedChangeRow,
  typed: KindPayload = parseKindPayload(row.kind, row.payload)
): Promise<ListedProposal['documents'] | null> {
  if (typed.kind !== 'file_operation') return []
  return resolveItemDocuments(session, row.projectId, typed.payload.operations)
}

/**
 * An organization-scoped proposal made in no conversation (0176) has no card to
 * borrow a reader from and names nothing a reader could be checked against: it
 * is read by the person it was made for and nobody else.
 */
const hiddenFromOthers = (session: AuthorizedSession, row: ProposedChangeRow) =>
  row.scope === 'organization' && !row.originConversationId && row.onBehalfOf !== session.userId

/** Whether `session` may read the row, as {@link requireReadableProposal} decides it, without throwing. */
async function readableBy(session: AuthorizedSession, row: ProposedChangeRow): Promise<boolean> {
  try {
    await assertReadable(session, row)
    return true
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return false
    throw error
  }
}

/**
 * The proposal, if `session` may read it; a 404 for "missing" and "not yours"
 * alike. A project's needs `project:view`; one made in a conversation needs
 * `viewer` on it, and one made in none needs every document it names to
 * resolve for the reader. The Büroablage is every member's to read. An
 * organization's (0176) is read through its conversation, or by the person it
 * was made for.
 */
export async function requireReadableProposal(session: AuthorizedSession, id: string): Promise<ProposedChangeRow> {
  const row = await findProposedChange(session.organizationId, id)
  if (!row) throw new NotFoundError()
  await assertReadable(session, row)
  return row
}

async function assertReadable(session: AuthorizedSession, row: ProposedChangeRow): Promise<void> {
  if (row.projectId) await requireProjectAccess(session, row.projectId, 'project:view')
  if (row.originConversationId) {
    await requireResourceAccess(session, 'conversation', row.originConversationId, 'viewer')
  } else if (hiddenFromOthers(session, row) || (await documentsFor(session, row)) === null) {
    throw new NotFoundError()
  }
}

const deciderNeedsWrite = (kind: ProposedChangeKind) =>
  new ForbiddenError('Only someone who may make this change in the project can decide this proposal', {
    reason: 'proposal-decider-needs-write',
    kind,
  })

/** Refuse a decision from a reader without the kind's right: 403, or the closed project's own 403. */
async function requireDecider(session: AuthorizedSession, row: ProposedChangeRow): Promise<void> {
  if (!row.projectId) {
    // The organization's (0176): the operation's own route, run as the decider, is the gate.
    if (row.scope === 'organization' && ORGANIZATION_KINDS.has(row.kind)) return
    // The Büroablage: its curators write it, so they decide what moves in it.
    if (!canManageOfficeShelf(session)) throw deciderNeedsWrite(row.kind)
    return
  }
  try {
    await requireProjectAccess(session, row.projectId, DECIDE_PERMISSIONS[row.kind])
  } catch (error) {
    if (error instanceof NotFoundError) throw deciderNeedsWrite(row.kind)
    throw error
  }
}

/** Whether `session` holds the right this kind is decided with; a closed project or no grant is a no. */
async function mayDecide(session: AuthorizedSession, row: ProposedChangeRow): Promise<boolean> {
  try {
    await requireDecider(session, row)
    return true
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) return false
    throw error
  }
}

/**
 * Refuse a decider who may not read everything an `operation` proposal names
 * (ADR-0122: a card names each target for its reader). Their apply would run as
 * them, the route would answer 404, and the card would end `failed` for
 * everyone; asked first, the proposal stays open for somebody who can read it.
 */
async function requireTargetsOfOperationReadable(session: AuthorizedSession, row: ProposedChangeRow): Promise<void> {
  if (row.kind !== 'operation') return
  const typed = parseKindPayload(row.kind, row.payload)
  if (typed.kind !== 'operation') return
  const op = findOperation(typed.payload.operation)
  // An operation that left the catalog fails at the applier, with its reason, for everyone alike.
  if (!op) return
  try {
    await requireTargetsReadable(session, targetsOf(op, typed.payload.input))
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError || error instanceof TooManyTargetsError) {
      throw new ForbiddenError('This change names something you cannot open, so somebody who can must decide it', {
        reason: 'proposal-decider-cannot-read-target',
      })
    }
    throw error
  }
}

/** Whether `session`'s person may read every target of `row` (true for a kind that is not an operation). */
async function readsEveryTarget(session: AuthorizedSession, row: ProposedChangeRow): Promise<boolean> {
  try {
    await requireTargetsOfOperationReadable(session, row)
    return true
  } catch (error) {
    if (error instanceof ForbiddenError) return false
    throw error
  }
}

const alreadyDecided = (row: ProposedChangeRow) =>
  new ConflictError('This proposal has already been decided', { reason: 'proposal-decided', status: row.status })

const beingApplied = () => new ConflictError('This proposal is being applied', { reason: 'proposal-applying' })

/** The project of a proposal on a project's shelf; `proposed_changes_scope_owner` makes a miss a bug. */
function projectOf(row: ProposedChangeRow): string {
  if (!row.projectId) throw new Error(`A ${row.kind} proposal without a project`)
  return row.projectId
}

async function toView(
  session: AuthorizedSession,
  row: ProposedChangeRow,
  decides: (row: ProposedChangeRow) => Promise<boolean> = (candidate) => mayDecide(session, candidate)
): Promise<ProposedChangeView> {
  const directory = await loadOrganizationDirectory(session.organizationId)
  const nameOf = (userId: string | null) => (userId ? (directory.get(userId)?.name ?? null) : null)
  const undecided = row.status === 'proposed' && !claimIsLive(row)
  const base = {
    id: row.id,
    status: row.status,
    proposedByKind: row.proposedByKind,
    onBehalfOf: row.onBehalfOf,
    onBehalfOfName: nameOf(row.onBehalfOf),
    originConversationId: row.originConversationId,
    originMessageId: row.originMessageId,
    createdAt: row.createdAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedByName: nameOf(row.decidedBy),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    results: row.results ?? null,
    canDecide: undecided && (await decides(row)) && (await readsEveryTarget(session, row)),
  }
  // Only a project's proposal has a project; the Büroablage's and the organization's have none.
  const projectId = row.scope === 'project' ? projectOf(row) : row.projectId
  const typed = parseKindPayload(row.kind, row.payload)
  if (typed.kind !== 'operation') return { ...base, ...typed, projectId }
  // What the call names, by name where THIS reader may read it, so the card never shows only an id.
  const op = findOperation(typed.payload.operation)
  const targets = op ? await describeTargets(session, op, typed.payload.input) : []
  return { ...base, ...typed, projectId, targets }
}

export async function getProposal(session: AuthorizedSession, id: string): Promise<ProposedChangeView> {
  return toView(session, await requireReadableProposal(session, id))
}

const outcomeOf = (results: readonly ProposedChangeResult[]) => {
  const applied = results.filter((result) => result.ok).length
  if (applied === results.length) return 'applied' as const
  return applied === 0 ? ('failed' as const) : ('partially_applied' as const)
}

/** What the deciding person brings to an apply besides their session. */
export interface ApplyProposalOptions extends ApplyProposalRequest {
  /** Their language, for a refusal they read (the profile's confinement). */
  locale?: Locale
}

/**
 * Apply the proposal as `session`'s person: claim it, run the kind's applier,
 * record each result, settle. 409 when it is no longer `proposed` or somebody
 * is applying it right now. `memoryScope: 'project'` files an organization
 * note in the project instead; other kinds ignore it.
 */
export async function applyProposal(
  session: AuthorizedSession,
  id: string,
  request: Request,
  options: ApplyProposalOptions = {}
): Promise<ProposedChangeView> {
  const row = await requireReadableProposal(session, id)
  if (row.status !== 'proposed') throw alreadyDecided(row)
  await requireDecider(session, row)
  await requireTargetsOfOperationReadable(session, row)
  const claim = await claimProposedChange(session.organizationId, id, session.userId, staleBefore())
  if (!claim) {
    const now = await findProposedChange(session.organizationId, id)
    throw now && now.status === 'proposed' ? beingApplied() : alreadyDecided(now ?? row)
  }
  let results: ProposedChangeResult[]
  try {
    results = await applyKind(parseKindPayload(claim.kind, claim.payload), {
      session,
      projectId: claim.projectId,
      request,
      originConversationId: claim.originConversationId,
      locale: options.locale ?? defaultLocale,
      memoryScope: options.memoryScope,
      proposalId: claim.id,
    })
  } catch (error) {
    await releaseProposedChange(session.organizationId, claim)
    throw error
  }
  const settled = await settleProposedChange(session.organizationId, claim, { status: outcomeOf(results), results })
  // Only reachable when this apply outlived its claim and somebody else decided
  // in the meantime: the items ran, and the record belongs to the other decision.
  if (!settled) throw new ConflictError('This proposal was decided while it was being applied', { reason: 'proposal-decided' })
  afterDecision(session, settled)
  return toView(session, settled)
}

/** Dismiss the proposal as `session`'s person. 409 when it is no longer `proposed` or is being applied. */
export async function dismissProposal(session: AuthorizedSession, id: string): Promise<ProposedChangeView> {
  const row = await requireReadableProposal(session, id)
  if (row.status !== 'proposed') throw alreadyDecided(row)
  await requireDecider(session, row)
  const dismissed = await dismissProposedChange(session.organizationId, id, session.userId, staleBefore())
  if (!dismissed) {
    const now = await findProposedChange(session.organizationId, id)
    throw now && now.status === 'proposed' ? beingApplied() : alreadyDecided(now ?? row)
  }
  afterDecision(session, dismissed)
  return toView(session, dismissed)
}

/**
 * The open proposals of one shelf this reader may read, newest first, each with
 * the documents it names as they resolve for the reader (a file operation's).
 * One the reader may not read is left out rather than refused: the list is a
 * view of what waits, not a probe. Whether the reader may decide is asked once
 * per kind, because it is a property of the shelf and the kind, not the row.
 * The organization's shelf (0176) lists the open organization-scoped operations
 * this reader may read.
 */
export async function listOpenProposals(session: AuthorizedSession, query: ParsedProposalListQuery): Promise<ProposalListResponse> {
  const shelf: ProposalShelf = query.projectId
    ? { scope: 'project', projectId: query.projectId }
    : { scope: query.shelf === 'organization' ? 'organization' : 'office_shelf' }
  if (shelf.scope === 'project') await requireProjectAccess(session, shelf.projectId, 'project:view')
  const rows = await listShelfProposals(session.organizationId, shelf, {
    statuses: ['proposed'],
    kind: query.kind,
    after: query.cursor,
    // One more than a page: the extra row says a further page exists, without a count.
    limit: query.limit + 1,
  })
  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : rows
  const decidesByKind = new Map<ProposedChangeKind, Promise<boolean>>()
  const decides = (row: ProposedChangeRow): Promise<boolean> => {
    let pending = decidesByKind.get(row.kind)
    if (!pending) {
      pending = mayDecide(session, row)
      decidesByKind.set(row.kind, pending)
    }
    return pending
  }
  const listed = await Promise.all(
    page.map(async (row): Promise<ListedProposal | null> => {
      if (row.originConversationId && !(await readableBy(session, row))) return null
      if (hiddenFromOthers(session, row)) return null
      const documents = await documentsFor(session, row)
      if (documents === null) return null
      return { proposal: await toView(session, row, decides), documents }
    })
  )
  return {
    proposals: listed.filter((entry): entry is ListedProposal => entry !== null),
    // The cursor follows the rows read, not the rows shown: a page of hidden proposals still moves on.
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  }
}

/** A proposal on a shelf as Piloti's own filing reads its record: its payload parsed, its state. */
export interface ShelfProposalRecord {
  id: string
  status: ProposedChangeStatus
  typed: KindPayload
  originConversationId: string | null
  /** Whether nobody is applying it right now, so it could be withdrawn. */
  claimed: boolean
}

/**
 * The open and dismissed file operations on a shelf, newest first and bounded
 * (`listShelfProposals`), for Piloti's filing to ask „already proposed?" and
 * „already refused?". Organization-scoped and unauthorized: the caller acts
 * for the system, and what it learns is only whether to propose. A row whose
 * payload no longer parses is left out.
 */
export async function listShelfFileProposals(
  organizationId: string,
  shelf: ProposalShelf
): Promise<ShelfProposalRecord[]> {
  const rows = await listShelfProposals(organizationId, shelf, {
    statuses: ['proposed', 'dismissed'],
    kind: 'file_operation',
    limit: 500,
  })
  return rows.flatMap((row) => {
    try {
      return [
        {
          id: row.id,
          status: row.status,
          typed: parseKindPayload(row.kind, row.payload),
          originConversationId: row.originConversationId,
          claimed: claimIsLive(row),
        },
      ]
    } catch {
      return []
    }
  })
}

/**
 * Piloti takes back its own undecided proposal: deleted while still
 * `proposed` and unclaimed, and the inbox is told nothing waits any more.
 * Whether it went. A person's decision is never undone this way: a decided
 * proposal does not match.
 */
export async function withdrawProposal(organizationId: string, id: string): Promise<boolean> {
  const withdrawn = await deleteUndecidedProposedChange(organizationId, id, staleBefore())
  if (withdrawn) bestEffort('attention (withdrawn)', () => onProposalDecided({ organizationId, proposalId: id }))
  return withdrawn
}
