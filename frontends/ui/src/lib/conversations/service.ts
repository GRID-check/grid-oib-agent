/**
 * Conversations service — business logic for the conversations domain.
 *
 * **Authorization lives here, and it is the security-critical part of the
 * collaboration feature.** Every session-carrying read or write of a
 * conversation or its messages resolves effective access through
 * `requireResourceAccess(session, 'conversation', id, <minRole>)`
 * (`@/lib/sharing/access`, ADR-0032), which enforces, in this order: tenancy →
 * container (project) access → the strongest of visibility and explicit grants.
 * The minimum roles are:
 *
 *   - `viewer`       — read the conversation, list its messages, mark it read;
 *   - `collaborator` — append messages, record a card decision;
 *   - `owner`        — rename, delete.
 *
 * This replaces resolving conversations **org-scoped only**
 * (`findConversationInOrg`), which is why any signed-in colleague holding a
 * conversation id could read its messages and why the unfiltered list returned
 * every chat in the organization (spec §3 fact 1, MG-1). Denials are
 * `NotFoundError`, so a response never confirms the existence of a conversation
 * the caller may not see. The org-scoped lookup survives for the session-less
 * internal (service-token) path only, which has no session to resolve.
 *
 * Route handlers stay thin: they validate input shape and delegate here.
 */

import 'server-only'
import { requireProjectAccess } from '@/lib/authz/projects'
import { FEATURE_FLAGS, isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { getBackendUrl } from '@/lib/backend-proxy'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type {
  Conversation,
  ConversationEngagement,
  ConversationRead,
  Message,
  ResourceRole,
  ResourceVisibility,
} from '@/lib/db/schema'
import { purgeConversationCollaboration } from '@/lib/collaboration/cleanup'
import { publishToUsers } from '@/lib/events/bus'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, markResourceItemsReadFor } from '@/lib/inbox/service'
import {
  applyMessageMentions,
  resolveRequestsOnReply,
  threadIsAwaitingHuman,
} from '@/lib/mentions/service'
import type { AddresseeSet, MentionInput, PersistedMessageResult } from '@/lib/mentions/types'
import { isShared, requireResourceAccess } from '@/lib/sharing/access'
import { countGrantsForResource } from '@/lib/sharing/repository'
import { resolveParticipants } from '@/lib/sharing/service'
import {
  resolveEngagement,
  resolveEngagementFor,
  setEngagement,
  type EngagementState,
} from './engagement'
import { sanitizeProvenance } from './message-provenance'
import { CONVERSATION_TAG_KEYS, normalizeConversationTags } from './tags'
import {
  deleteConversationInOrg,
  findConversationInOrg,
  findConversationRead,
  findConversationTenancy,
  findMessageInConversation,
  insertConversation,
  insertMessages,
  listMessagesForConversation,
  listVisibleConversations,
  mergeMessageMetadata,
  updateConversationMetaInOrg,
  updateConversationTitleInOrg,
  upsertConversationRead,
} from './repository'

/**
 * Bound the naming call so an unreachable backend rejects promptly instead of
 * hanging into a Cloudflare 504. MUST stay above the backend's own 30s LLM
 * timeout so the BFF does not abort a call the backend then completes and
 * throws away (same reasoning as GENERATE_SUMMARY_TIMEOUT_MS in profile-service).
 */
const GENERATE_TITLE_TIMEOUT_MS = 35_000

export interface ConversationTitleMessageInput {
  role: 'user' | 'assistant'
  content: string
}

export interface GenerateConversationTitleResult {
  title: string
  tags: string[]
  error?: string
}

export interface CreateConversationInput {
  id: string
  title?: string | null
  projectId?: string | null
}

export interface CreateMessageInput {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  messageType?: string
  metadata?: Record<string, unknown>
  createdAt?: string
  /**
   * Structured mentions carried by this message (spec MN-3). Untrusted: the
   * addressee set is resolved server-side from these, never taken from the
   * client (spec MN-2).
   */
  mentions?: MentionInput[]
  /** The asker's question, which becomes the recipient's inbox body (spec MN-12). */
  mentionNote?: string | null
}

/** A persisted message plus the server's ruling on who it was for (ADR-0034). */
export interface PersistedMessage extends Message, PersistedMessageResult {}

/**
 * A conversation plus the sharing facts the client needs to pick a code path.
 *
 * `shared` is what decides whether the SERVER is authoritative for the message
 * list (ADR-0033): a private thread with no grants keeps the existing
 * local-first path, everything else must be loaded from and reconciled with the
 * server, because a browser cache cannot know what a colleague just wrote.
 */
export interface ConversationWithAccess extends Conversation {
  shared: boolean
  /** The caller's effective role, so the UI can hide what they may not do. */
  myRole: ResourceRole | null
  /** Blanket visibility, as resolved by the access check (same value as the row). */
  visibility: ResourceVisibility
  /** The caller's own read high-water mark, for the unread separator (CC-19). */
  myReadState: { lastReadAt: Date; lastReadMessageId: string | null } | null
  /**
   * The mode in force for a message that tags nobody (ADR-0036), already resolved
   * — the client is told the answer rather than deriving it, so the composer's
   * statement of who receives the next message cannot disagree with the routing.
   *
   * `engagementStored` is null while the mode is derived rather than chosen, which
   * is what lets the UI say "this is the rule" instead of "this is your setting".
   */
  engagementMode: ConversationEngagement
  engagementStored: ConversationEngagement | null
  /**
   * A mode worth OFFERING, or null. Never applied on its own: `ask` stays the
   * default however many people are in the thread, because Piloti is the point of
   * the product rather than a guest in it, and a thread must not rewire who
   * answers next because a colleague typed "danke".
   */
  engagementSuggestion: ConversationEngagement | null
}

export interface ListConversationsFilter {
  /** Scope the list to one project's conversations (plus legacy unscoped rows). */
  projectId?: string
}

/**
 * List the conversations the caller may see (spec SH-4).
 *
 * With `filter.projectId` the caller must be able to see that project (same
 * guard as `createConversation` — otherwise any org member could probe/list
 * conversations of arbitrary project ids). That proof is what lets the
 * repository resolve `project` visibility in SQL instead of per row.
 *
 * Without a project the list is narrowed to rows the caller created, holds a
 * grant on, or that are `organization`-visible. That is a **deliberate
 * tightening** (spec MG-1): the unscoped list used to return every conversation
 * in the organization. See `listVisibleConversations` for why it is not an FGA
 * probe per row.
 */
export async function listConversations(
  session: AuthorizedSession,
  filter: ListConversationsFilter = {},
): Promise<Conversation[]> {
  if (filter.projectId) {
    await requireProjectAccess(session, filter.projectId, 'project:view')
  }
  return listVisibleConversations(session.organizationId, session.userId, {
    projectId: filter.projectId,
  })
}

/**
 * Read one conversation, with its sharing state attached (ADR-0033).
 *
 * The org-scoped row read runs AFTER `requireResourceAccess` has authorized —
 * belt and braces, not the gate. Fields are only ever added to the payload, so
 * clients that predate sharing keep working.
 */
export async function getConversation(
  session: AuthorizedSession,
  conversationId: string,
): Promise<ConversationWithAccess> {
  const access = await requireResourceAccess(session, 'conversation', conversationId, 'viewer')

  const [conversation, grantCount, readMark] = await Promise.all([
    findConversationInOrg(conversationId, session.organizationId),
    countGrantsForResource('conversation', conversationId),
    findConversationRead(conversationId, session.userId),
  ])
  if (!conversation) throw new NotFoundError()

  const shared = isShared(access.visibility, grantCount)
  // Derived only for a shared thread, and only on open. A solo thread is always
  // `ask` by definition — one author — so it pays for no aggregate.
  const engagement = shared
    ? await resolveEngagement(conversationId, conversation.engagement, { withSuggestion: true })
    : { mode: 'ask' as const, stored: conversation.engagement, suggestion: null }

  return {
    ...conversation,
    shared,
    myRole: access.role,
    visibility: access.visibility,
    myReadState: readMark
      ? { lastReadAt: readMark.lastReadAt, lastReadMessageId: readMark.lastReadMessageId }
      : null,
    engagementMode: engagement.mode,
    engagementStored: engagement.stored,
    engagementSuggestion: engagement.suggestion,
  }
}

/**
 * Change when the agent answers a message that tags nobody (ADR-0036).
 *
 * `collaborator`, not `owner`: the mode governs how the thread behaves for
 * everyone in it, and a discussion stuck answering the wrong person must be
 * fixable by whoever is in the room — the same reasoning as releasing a wait
 * (spec MN-9.2). It cannot leak anything: the value is two words, and the caller
 * already has to be able to write here.
 */
export async function updateConversationEngagement(
  session: AuthorizedSession,
  conversationId: string,
  mode: ConversationEngagement,
): Promise<ConversationWithAccess> {
  await requireResourceAccess(session, 'conversation', conversationId, 'collaborator')
  await setEngagement(conversationId, session.organizationId, mode)
  return getConversation(session, conversationId)
}

/**
 * Create a conversation. When the caller links it to a project, they must be
 * able to see that project — otherwise any org member could attach
 * conversations to (and probe the existence of) arbitrary project ids.
 *
 * Visibility is NOT set here: the column defaults to `private`, which is the
 * conversation descriptor's `defaultVisibility` (spec MG-2, ADR-0032). Sharing
 * is a deliberate act, so that the access chip means something.
 */
export async function createConversation(
  session: AuthorizedSession,
  input: CreateConversationInput,
): Promise<Conversation> {
  if (input.projectId) {
    await requireProjectAccess(session, input.projectId, 'project:view')
  }

  const inserted = await insertConversation({
    id: input.id,
    organizationId: session.organizationId,
    createdBy: session.userId,
    title: input.title ?? null,
    projectId: input.projectId ?? null,
  })
  if (inserted) return inserted

  // Id conflict. The client fires create-if-missing per appended message, so a
  // concurrent create from this caller — or from a colleague contributing to a
  // thread they share — must succeed idempotently. Anything else is an id that
  // is not theirs to reach, and it must not hand back somebody's title and
  // project by return value: authorize before returning the existing row.
  await requireResourceAccess(session, 'conversation', input.id, 'collaborator')
  const existing = await findConversationInOrg(input.id, session.organizationId)
  if (!existing) throw new NotFoundError()
  return existing
}

/** Rename a conversation. Naming a shared thread is an owner's call (spec SH-10). */
export async function updateConversationTitle(
  session: AuthorizedSession,
  conversationId: string,
  title: string,
): Promise<Conversation> {
  await requireResourceAccess(session, 'conversation', conversationId, 'owner')

  const conversation = await updateConversationTitleInOrg(conversationId, session.organizationId, title)
  if (!conversation) throw new NotFoundError()
  return conversation
}

/**
 * ChatGPT-style conversation naming + OIB topic tagging.
 *
 * Calls the Python backend to turn the opening exchange into a concise title
 * and 0–3 topic tags (from the fixed vocabulary), then persists both on the
 * conversation row so Historie can name and filter the chat. 404 for a missing
 * or cross-org conversation.
 *
 * Fail-open like every other generation call: a backend outage, a missing LLM
 * credential, or an empty result degrades to `{ title: '', tags: [] }` with a
 * diagnosable code — the caller keeps its provisional (first-message) title.
 * An empty title is NEVER persisted, so a failure can't clobber a good name.
 *
 * Requires `owner`, like the manual rename: this writes the conversation's name,
 * and in practice the person whose opening exchange is being named is its
 * creator, who is always an owner.
 */
export async function generateConversationTitle(
  session: AuthorizedSession,
  conversationId: string,
  input: { messages: ConversationTitleMessageInput[]; locale?: string },
): Promise<GenerateConversationTitleResult> {
  await requireResourceAccess(session, 'conversation', conversationId, 'owner')

  const messages = input.messages
    .map((m) => ({ role: m.role, content: (m.content ?? '').trim() }))
    .filter((m) => m.content.length > 0)
  if (messages.length === 0) {
    return { title: '', tags: [] }
  }

  let backendRes: Response
  try {
    backendRes = await fetch(`${getBackendUrl()}/v1/generate-conversation-title`, {
      method: 'POST',
      // Forward the org id so the backend can resolve this org's BYOK LLM
      // credential (falls back to the platform env chain when unset).
      headers: { 'Content-Type': 'application/json', 'x-grid-organization-id': session.organizationId },
      body: JSON.stringify({
        messages,
        allowed_tags: CONVERSATION_TAG_KEYS,
        locale: input.locale ?? 'de',
      }),
      signal: AbortSignal.timeout(GENERATE_TITLE_TIMEOUT_MS),
    })
  } catch (e) {
    console.error('[GenerateConversationTitle] Backend unreachable (non-fatal):', e)
    return { title: '', tags: [], error: 'backend_unreachable' }
  }

  if (!backendRes.ok) {
    const errorText = await backendRes.text().catch(() => '')
    console.error('[GenerateConversationTitle] Backend error:', backendRes.status, errorText)
    return { title: '', tags: [], error: 'backend_error' }
  }

  const { title, tags, error } = (await backendRes.json()) as {
    title: string
    tags?: string[]
    error?: string | null
  }

  if (error) {
    console.error('[GenerateConversationTitle] Generation failed:', error)
    return { title: '', tags: [], error }
  }

  const cleanTitle = (title ?? '').trim()
  // Defense-in-depth: never trust the tag list from over the wire — keep only
  // known keys so the row (and the Historie filter) can't hold an unknown chip.
  const cleanTags = normalizeConversationTags(tags ?? [])

  // Only persist a real title — an empty result must never clobber the
  // provisional first-message name the client already set.
  if (cleanTitle) {
    await updateConversationMetaInOrg(conversationId, session.organizationId, {
      title: cleanTitle,
      tags: cleanTags,
    })
  }

  return { title: cleanTitle, tags: cleanTags }
}

/**
 * Delete a conversation. Requires `owner`.
 *
 * **This function reports the truth and answers `NotFoundError` for both "no such
 * conversation" and "not yours to delete" — the caller decides what the client
 * sees.** It used to short-circuit on a missing row and return silently, which
 * made the two cases tell a signed-in colleague apart from the outside: 204 for an
 * id that exists nowhere, 404 for one that exists in another tenant or belongs to
 * somebody else. That is a cross-tenant existence oracle, and it contradicts spec
 * SH-6.
 *
 * Reconciling it needs both halves, and the route holds the other one: the chat
 * store deletes server rows for conversations that may only ever have lived in a
 * browser, so a genuinely-absent id must not surface an error to that client. The
 * DELETE handler therefore answers **204 for `NotFoundError` either way** — one
 * response for both, which is what SH-6 actually demands — while this function
 * stays honest for every internal caller and every test.
 */
export async function deleteConversation(session: AuthorizedSession, conversationId: string): Promise<void> {
  await requireResourceAccess(session, 'conversation', conversationId, 'owner')
  await deleteConversationInOrg(conversationId, session.organizationId)

  // `messages` and `conversation_reads` cascade through their foreign keys;
  // grants, mention requests and inbox items CANNOT, because they address their
  // target as a polymorphic (resource_type, resource_id) pair with no FK. Purge
  // them explicitly or they orphan (spec SH-13, IB-15) — harmless for access, but
  // they leave permanently redacted rows in people's inboxes.
  await purgeConversationCollaboration(conversationId)
}

/**
 * List a conversation's messages, oldest first. Requires `viewer`.
 *
 * Legacy rows written before authorship existed carry `role: 'user'` with no
 * author. They are attributed to the conversation's creator **at read time**,
 * never backfilled, so the data never claims a precision it does not have
 * (spec CC-3, MG-3).
 */
export async function listConversationMessages(
  session: AuthorizedSession,
  conversationId: string,
): Promise<Message[]> {
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')

  const [rows, tenancy] = await Promise.all([
    listMessagesForConversation(conversationId),
    findConversationTenancy(conversationId),
  ])
  return rows.map((row) => attributeLegacyAuthor(row, tenancy?.createdBy ?? null))
}

/**
 * Attribute an unstamped human message to the conversation's creator (MG-3).
 * A NULL author on an assistant/system/tool row is correct and left alone.
 */
function attributeLegacyAuthor(row: Message, createdBy: string | null): Message {
  if (row.role !== 'user' || row.authorUserId || !createdBy) return row
  return { ...row, authorUserId: createdBy }
}

/**
 * Record what a message carries beyond its text: the user's answers to its
 * interactive cards (`accepted`, `dismissed`, …), and the answer's own provenance.
 *
 * Merged into `metadata.cardInteractions` so it rides along with the `cards`
 * payload already stored there: when a history is rehydrated from the server
 * (localStorage wiped, other device) an applied `project_profile_patch` or a
 * saved `memory_proposal` comes back settled instead of re-offering buttons
 * that would apply it a second time. Tenancy is enforced by resolving the
 * conversation org-scoped FIRST; both a cross-org conversation and a message
 * that is not part of it surface as 404.
 */
export async function updateMessageDetail(
  session: AuthorizedSession,
  conversationId: string,
  messageId: string,
  patch: { cardInteractions?: Record<string, unknown>; provenance?: unknown },
): Promise<Message> {
  // Answering a card, or recording what an answer rested on, is contributing to
  // the thread rather than reading it.
  await requireResourceAccess(session, 'conversation', conversationId, 'collaborator')

  const metadata: Record<string, unknown> = {}
  const deepMergeKeys: string[] = []

  if (patch.cardInteractions) {
    metadata.cardInteractions = patch.cardInteractions
    deepMergeKeys.push('cardInteractions')
  }

  if (patch.provenance !== undefined) {
    // Whitelisted and bounded HERE, never trusted from the client: this lands in
    // a jsonb column (ADR-0037). A payload with nothing usable in it is dropped
    // rather than stamped on as an empty object.
    const provenance = sanitizeProvenance(patch.provenance)
    if (provenance) metadata.provenance = provenance
  }

  // Nothing survived sanitisation and no cards were sent — the row is already
  // right, so return it rather than performing a no-op write under a row lock.
  if (Object.keys(metadata).length === 0) {
    const existing = await findMessageInConversation(conversationId, messageId)
    if (!existing) throw new NotFoundError()
    return existing
  }

  // Deep-merged per card key: a second client PATCHing the map it knows about
  // must not erase a decision it never saw (see `mergeMessageMetadata`).
  const row = await mergeMessageMetadata(conversationId, messageId, metadata, deepMergeKeys)
  if (!row) throw new NotFoundError()
  return row
}

/**
 * A message arrived carrying collaboration input in a deployment where
 * collaboration is off (spec NF-8).
 *
 * **Refused, not silently ignored.** Dropping the mentions would let the author
 * believe they had handed the thread to a colleague — the composer would show the
 * agent staying quiet, nobody would be asked, and no inbox item would ever
 * arrive. A stated refusal is the only outcome that does not invent a hand-off
 * that never happened. The chat path itself is untouched: a message WITHOUT
 * mentions behaves exactly as it did before this feature existed, which is the
 * whole point of the flag.
 *
 * Subclassed from `ForbiddenError` (which takes no `details`) so the reason is
 * machine-readable, mirroring the `feature-disabled` envelope
 * `requireCollaborationEnabled` answers with on every other collaboration route.
 */
class CollaborationDisabledError extends ForbiddenError {
  constructor() {
    super('Collaboration is not enabled here, so a message cannot mention anyone.')
    // `ApiError.details` is a readonly constructor property, so it is attached
    // rather than passed through a constructor that does not accept it.
    Object.assign(this, {
      details: { reason: 'feature-disabled', feature: FEATURE_FLAGS.collaboration },
    })
  }
}

/** The agent answers — no mentions, today's behaviour unchanged (spec MN-1). */
const AGENT_ADDRESSED: AddresseeSet = { agent: true, users: [] }

/**
 * A message that is a remark to the PEOPLE in the thread: the agent is not
 * addressed, and nobody new is being asked.
 *
 * This is what a plain message becomes while the thread is waiting on a human
 * (ADR-0034 addendum). Without it, the colleague's answer — a message with no
 * mentions — would satisfy "no mentions means ask the agent" and Piloti would
 * answer a reply that was written to a person.
 */
const THREAD_ADDRESSED: AddresseeSet = { agent: false, users: [] }
/** Nothing is addressed: what the agent itself wrote, and system/tool rows. */
const NOBODY_ADDRESSED: AddresseeSet = { agent: false, users: [] }

/** How much of a message travels into a mention recipient's inbox as context. */
const MENTION_EXCERPT_MAX = 280

/** One input, with the addressee ruling resolved for it (null = the agent wrote it). */
interface PreparedMessage {
  input: CreateMessageInput
  addressees: AddresseeSet | null
  createdRequests: number
}

/**
 * Map a validated message input to an insertable row. `messageType` lives in
 * metadata (no dedicated column) so the client can route rehydrated history to
 * the right renderer. Shared by the session-authenticated and internal
 * (token-guarded) persist paths so both write identical rows.
 *
 * `authorUserId` records WHICH person wrote a human message (spec CC-3). It stays
 * NULL for assistant/system/tool rows — the agent wrote those — and on the
 * internal path, which has no session and only ever persists the agent's turn.
 */
function buildMessageRow(conversationId: string, prepared: PreparedMessage, authorUserId: string | null) {
  const { input } = prepared
  // `addressees` is the SERVER's ruling on who a message was for, and only the
  // server may ever write it (spec MN-2). Stripped from the client's metadata
  // unconditionally rather than merely overwritten: the spread below writes a
  // ruling only when there IS one, and there is none for an assistant/system/tool
  // row or on the internal path — so a client-supplied value used to survive on
  // exactly those rows, and `storedAddressees` would then read it back as
  // authoritative on a replay.
  const { addressees: _clientRuling, ...clientMetadata } = input.metadata ?? {}
  return {
    id: input.id,
    conversationId,
    role: input.role,
    authorUserId: input.role === 'user' ? authorUserId : null,
    content: input.content,
    metadata: {
      ...clientMetadata,
      ...(input.messageType ? { messageType: input.messageType } : {}),
      // The server's ruling, stored once at persist time and never re-derived
      // from the text later (spec MN-2). Written LAST so a client cannot supply
      // its own addressee set.
      ...(prepared.addressees ? { addressees: prepared.addressees } : {}),
    },
    createdAt: input.createdAt ? new Date(input.createdAt) : new Date(),
  }
}

/** Read back an addressee ruling a previous attempt already stored (MN-2). */
function storedAddressees(row: Message | null): AddresseeSet | null {
  const stored = (row?.metadata as { addressees?: unknown } | null)?.addressees
  if (!stored || typeof stored !== 'object') return null
  const candidate = stored as Partial<AddresseeSet>
  if (typeof candidate.agent !== 'boolean' || !Array.isArray(candidate.users)) return null
  return { agent: candidate.agent, users: candidate.users.filter((id): id is string => typeof id === 'string') }
}

/**
 * Resolve who one message is for, before it is written.
 *
 * Mentions are applied BEFORE the insert on purpose: a mention that must be
 * refused (the target cannot reach the project, or the actor may not invite them
 * — spec MN-5, MN-6) has to fail the whole send, not leave a stored message whose
 * mention silently did nothing.
 */
async function prepareMessage(
  session: AuthorizedSession,
  conversationId: string,
  input: CreateMessageInput,
  context: { shared: boolean; engagement: () => Promise<EngagementState> },
): Promise<PreparedMessage> {
  if (input.role !== 'user') {
    return { input, addressees: null, createdRequests: 0 }
  }

  const mentions = input.mentions ?? []
  if (mentions.length === 0) {
    // A plain message in a SOLO thread asks Piloti — that is the product's whole
    // point, and this path stays query-free so it costs nothing. Nearly every
    // message in the product takes this line and stops here.
    if (!context.shared) {
      return { input, addressees: AGENT_ADDRESSED, createdRequests: 0 }
    }

    // While the thread is WAITING on a named person, a plain message is a remark
    // to the people in it, not a question for the agent. Otherwise the
    // colleague's answer (which carries no mentions) would wake Piloti to answer
    // a message written to a human — and so would "thanks, take your time" from
    // the asker. Checked first because it outranks the mode: a thread that is
    // explicitly waiting on Anna is not asking the assistant anything.
    if (await threadIsAwaitingHuman('conversation', conversationId)) {
      return { input, addressees: THREAD_ADDRESSED, createdRequests: 0 }
    }

    // Otherwise the thread's engagement mode decides (ADR-0036). Deterministic
    // and inspectable: a thread where two or more people have written is a
    // conversation between people, and the assistant stops assuming every
    // sentence is for it. `@Piloti` remains the explicit way to ask.
    const { mode } = await context.engagement()
    return {
      input,
      addressees: mode === 'mention' ? THREAD_ADDRESSED : AGENT_ADDRESSED,
      createdRequests: 0,
    }
  }

  // The mention path is the collaboration feature, and it must not switch itself
  // on where an operator has not chosen it (spec NF-8). Checked BEFORE the
  // replay lookup and before `applyMessageMentions`, so a flag-off send writes no
  // grant, no request and no inbox row.
  if (!isCollaborationEnabled(session)) throw new CollaborationDisabledError()

  // A replayed client-generated id must not create a second request or a second
  // notification. The first attempt's ruling is authoritative — read it back
  // rather than resolving again.
  const existing = storedAddressees(await findMessageInConversation(conversationId, input.id))
  if (existing) return { input, addressees: existing, createdRequests: 0 }

  const applied = await applyMessageMentions({
    session,
    resourceType: 'conversation',
    resourceId: conversationId,
    anchorId: input.id,
    mentions,
    note: input.mentionNote ?? null,
    excerpt: input.content.slice(0, MENTION_EXCERPT_MAX),
  })
  return { input, addressees: applied.addressees, createdRequests: applied.createdRequests }
}

/**
 * Append one or more messages to a conversation. Requires `collaborator`.
 *
 * Returns the persisted rows, each carrying the server's addressee ruling. The
 * client reads `addressees.agent` to decide whether to open an agent turn — the
 * server decides, the client executes (ADR-0034). The array shape is unchanged,
 * so callers that ignore the ruling keep working.
 */
export async function createConversationMessages(
  session: AuthorizedSession,
  conversationId: string,
  inputs: CreateMessageInput[],
): Promise<PersistedMessage[]> {
  const access = await requireResourceAccess(session, 'conversation', conversationId, 'collaborator')

  // Shared-ness decides two things: whether anything fans out at all, and whether
  // a plain message can possibly be a remark rather than a question for Piloti
  // (a solo thread cannot hold an open request). Resolved once here so neither
  // decision costs a second query.
  const grantCount = await countGrantsForResource('conversation', conversationId)
  const shared = isShared(access.visibility, grantCount)

  // The engagement mode (ADR-0036), resolved AT MOST ONCE per call and only if a
  // plain message in this batch actually needs it. Memoized rather than fetched
  // up front because the overwhelmingly common shape — a solo thread, or a
  // message that tags someone — never asks the question at all.
  let engagementState: EngagementState | null = null
  const engagement = async (): Promise<EngagementState> =>
    (engagementState ??= await resolveEngagementFor(conversationId))

  // Sequential, not parallel: mention application writes grants and requests,
  // and a batch must not race itself over the same conversation.
  const prepared: PreparedMessage[] = []
  for (const input of inputs) {
    prepared.push(await prepareMessage(session, conversationId, input, { shared, engagement }))
  }

  const rows = await insertMessages(prepared.map((entry) => buildMessageRow(conversationId, entry, session.userId)))

  const rulingById = new Map(prepared.map((entry) => [entry.input.id, entry]))
  const persisted: PersistedMessage[] = rows.map((row) => {
    const entry = rulingById.get(row.id)
    return {
      ...row,
      addressees: entry?.addressees ?? NOBODY_ADDRESSED,
      createdRequests: entry?.createdRequests ?? 0,
    }
  })

  const humanMessages = persisted.filter((message) => message.role === 'user')

  // A contribution from a human closes whatever that person was asked in this
  // thread (spec MN-9.1, MN-16). Best-effort: the message is already stored, and
  // the awaiting state is derived, so it re-converges on the next read.
  if (humanMessages.length > 0) {
    try {
      await resolveRequestsOnReply({
        organizationId: session.organizationId,
        resourceType: 'conversation',
        resourceId: conversationId,
        authorUserId: session.userId,
        // Whom these messages addressed, so a question put BACK to the asker is
        // recorded as that rather than as an answer they never gave.
        addressedUserIds: [
          ...new Set(humanMessages.flatMap((message) => message.addressees.users)),
        ],
      })
    } catch (error) {
      console.warn('[conversations] resolving mention requests on reply failed (non-fatal):', error)
    }
  }

  await fanOutMessageActivity({
    shared,
    organizationId: session.organizationId,
    conversationId,
    visibility: access.visibility,
    actorUserId: session.userId,
    rows: persisted,
    // Only a message the agent is addressed on opens a turn — a message that
    // hands off to a human starts nothing at all (spec MN-7).
    turnStartedFor: humanMessages.filter((message) => message.addressees.agent).map((message) => message.id),
    emitAmbient: true,
  })

  return persisted
}

interface FanOutInput {
  /** Pre-resolved shared-ness, when the caller already knows it. */
  shared?: boolean
  organizationId: string
  conversationId: string
  visibility: ResourceVisibility
  /** Who caused this, so they are not notified about their own writing. */
  actorUserId: string | null
  rows: Message[]
  /** Ids of messages that open an agent turn. */
  turnStartedFor: readonly string[]
  /** Whether to fold an ambient "activity in this thread" item (CC-20). */
  emitAmbient: boolean
}

/**
 * Tell the other participants that something happened (spec CC-9, CC-13, CC-20).
 *
 * **A solo thread produces nothing at all.** A `private` conversation with no
 * grants emits no events and no notifications, so a user who never shares
 * anything cannot notice this feature exists (spec NF-8) — which is also why the
 * grant count is only queried when visibility alone cannot answer the question.
 *
 * Entirely best-effort. Live delivery is latency, not mechanism: every state a
 * participant can observe is reachable by a plain fetch (spec RT-4, CC-10), so a
 * failure here must never fail the message write that caused it.
 */
async function fanOutMessageActivity(input: FanOutInput): Promise<void> {
  const { organizationId, conversationId, actorUserId } = input
  if (input.rows.length === 0) return

  try {
    // The session path already resolved shared-ness (it also decides whether a
    // plain message is a remark rather than a question for Piloti), so it passes
    // the answer in rather than paying for the same query twice. The internal
    // service-token path has no such context and still works it out here.
    const shared =
      input.shared ??
      isShared(
        input.visibility,
        input.visibility === 'private' ? await countGrantsForResource('conversation', conversationId) : 0,
      )
    if (!shared) return

    const participants = await resolveParticipants(organizationId, 'conversation', conversationId)
    if (participants.length === 0) return

    for (const row of input.rows) {
      await publishToUsers(participants, {
        kind: 'conversation.message',
        conversationId,
        authorUserId: row.authorUserId,
        messageId: row.id,
      })
      if (input.turnStartedFor.includes(row.id)) {
        await publishToUsers(participants, {
          kind: 'conversation.turn',
          conversationId,
          phase: 'started',
          actorUserId,
        })
      }
      // An assistant message landing IS the end of a turn — observers who never
      // saw the tokens get the completed answer and the banner clears (ADR-0033).
      if (row.role === 'assistant') {
        await publishToUsers(participants, {
          kind: 'conversation.turn',
          conversationId,
          phase: 'ended',
          actorUserId,
        })
      }
    }

    if (!input.emitAmbient) return

    // ONE grouped item per participant, however many messages just landed: the
    // group key collapses by design, so twenty messages are one row that counts
    // up and is cleared by reading the thread (spec CC-20, IB-8).
    // `emitInboxItems` already drops the actor's own copy.
    await emitInboxItems(
      participants.map((recipientUserId) => ({
        organizationId,
        recipientUserId,
        type: 'conversation.activity' as const,
        resourceType: 'conversation' as const,
        resourceId: conversationId,
        actorUserId,
        groupKey: inboxGroupKey('conversation.activity', 'conversation', conversationId),
      })),
    )
  } catch (error) {
    console.warn('[conversations] participant fan-out failed (non-fatal):', error)
  }
}

/**
 * Record how far the caller has read a conversation (spec CC-18), and clear the
 * ambient inbox items that pointed at it (spec IB-9).
 *
 * Requires `viewer`, not `collaborator`: reading is not contributing, and a
 * viewer's unread state is exactly as real as a collaborator's.
 *
 * Reading a thread NEVER resolves an actionable request — being seen is not
 * being answered (spec MN-16). That distinction lives in
 * `markResourceItemsReadFor`, which only touches informational items.
 *
 * The read MARK is ordinary chat state and is recorded whatever the collaboration
 * flag says — it is per person, it feeds the unread separator, and refusing it
 * would break the core path. Touching the INBOX is collaboration behaviour, so it
 * only happens where the feature is enabled (spec NF-8).
 */
export async function markConversationRead(
  session: AuthorizedSession,
  conversationId: string,
  input: { lastReadMessageId?: string | null } = {},
): Promise<ConversationRead> {
  await requireResourceAccess(session, 'conversation', conversationId, 'viewer')

  const mark = await upsertConversationRead({
    conversationId,
    userId: session.userId,
    lastReadMessageId: input.lastReadMessageId ?? undefined,
  })

  if (isCollaborationEnabled(session)) {
    try {
      await markResourceItemsReadFor(session, 'conversation', conversationId)
    } catch (error) {
      console.warn('[conversations] clearing ambient inbox items failed (non-fatal):', error)
    }
  }

  return mark
}

/**
 * Append messages via the INTERNAL (service-token) path — used by the backend
 * to persist a finished assistant turn when the client dropped mid-turn (a
 * long deep-research answer can outlive the browser's access token, so the old
 * cookie-replay POST silently 401'd and the answer vanished). There is no user
 * session here, so tenancy is enforced by resolving the conversation against
 * the caller-supplied `organizationId` (the backend forwards it on the WS
 * upgrade as `x-grid-organization-id`): a mismatched/unknown org surfaces as a
 * 404, exactly like the session path, so the token grants no cross-org bypass.
 *
 * Idempotent: `insertMessages` uses `onConflictDoNothing` on `messages.id`, and
 * the backend derives a deterministic per-turn id, so a double-write no-ops.
 *
 * No author is stamped and no addressee set is resolved: this path exists to
 * store what the AGENT produced (spec CC-3), and mentions are a property of a
 * human contribution. Participants are still told the turn landed, because that
 * is the event an observer of a shared thread is waiting for — but no ambient
 * inbox item is folded here: there is no actor to attribute it to, so the person
 * who asked the question would be notified about their own answer.
 */
export async function persistInternalConversationMessages(
  organizationId: string,
  conversationId: string,
  inputs: CreateMessageInput[],
): Promise<Message[]> {
  const conversation = await findConversationInOrg(conversationId, organizationId)
  if (!conversation) throw new NotFoundError()

  const rows = await insertMessages(
    inputs.map((input) => buildMessageRow(conversationId, { input, addressees: null, createdRequests: 0 }, null)),
  )

  await fanOutMessageActivity({
    organizationId,
    conversationId,
    visibility: conversation.visibility,
    actorUserId: null,
    rows,
    turnStartedFor: [],
    emitAmbient: false,
  })

  return rows
}
