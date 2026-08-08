/**
 * Mention + hand-off wire types (ADR-0034).
 *
 * No `'server-only'`: the composer's mention picker, the awaiting-input banner
 * and the message renderer all import these.
 */

import type { DirectoryPerson } from '@/lib/sharing/types'

export type { DirectoryPerson }

/**
 * The agent as a mention target. A literal id rather than a magic string
 * scattered through the code: tagging the agent is how you bring it back into a
 * thread that is waiting on a human (spec MN-1).
 */
export const AGENT_MENTION_ID = 'agent:piloti'

/** A structured mention, as sent by the client and validated by the server. */
export interface MentionInput {
  /** WorkOS user id, or `AGENT_MENTION_ID`. */
  targetId: string
}

/**
 * Who a message is addressed to — computed ONCE server-side at persist time and
 * stored on the message (spec MN-2). Never re-derived from the text.
 */
export interface AddresseeSet {
  /** Whether the agent should answer this message. */
  agent: boolean
  /** WorkOS user ids whose input is requested. */
  users: string[]
}

/** `POST /api/conversations/:id/messages` response addition. */
export interface PersistedMessageResult {
  id: string
  /**
   * The server's ruling on who this message is for. The client uses
   * `addressees.agent` to decide whether to open an agent turn — the server is
   * the decider, the client is the executor (ADR-0034).
   */
  addressees: AddresseeSet
  /** Requests created by this message, if any. */
  createdRequests: number
}

/** One outstanding request, as the thread banner renders it. */
export interface PendingMentionView {
  id: string
  /** Who is being waited on. */
  person: DirectoryPerson
  /** Who asked. */
  requestedBy: DirectoryPerson | null
  note: string | null
  anchorId: string | null
  createdAt: string
}

/** `GET /api/conversations/:id/awaiting` — the derived hand-off state. */
export interface AwaitingStateResponse {
  /**
   * Outstanding requests on this conversation. Empty means the agent is free to
   * answer; non-empty means the thread is visibly waiting for a human and the
   * agent stays silent (spec MN-7, MN-8).
   */
  pending: PendingMentionView[]
  /** Whether the CALLER is one of the people being waited on. */
  awaitingMe: boolean
}

/** A candidate for the `@` picker. */
export interface MentionCandidate {
  /** WorkOS user id, or `AGENT_MENTION_ID` for the agent. */
  targetId: string
  person: DirectoryPerson
  /** The agent, rendered distinctly and never needing an invitation. */
  isAgent: boolean
  /** Already a participant — mentioning them needs no invitation. */
  isParticipant: boolean
  /**
   * Mentioning them would require inviting them first. Only offered to owners;
   * collaborators see them disabled (spec MN-5, OQ-3).
   */
  needsInvite: boolean
}

/** `GET /api/conversations/:id/mention-candidates` */
export interface MentionCandidatesResponse {
  candidates: MentionCandidate[]
  /** Whether the caller may invite, which decides if `needsInvite` is actionable. */
  canInvite: boolean
}

/** Why a mention was refused, for localisable UI. */
export const MENTION_ERROR_REASONS = {
  /** Caller is not an owner and the target is not yet a participant. */
  inviteRequiresOwner: 'mention-invite-requires-owner',
  /** Target cannot reach the container project at all. */
  containerAccessRequired: 'container-access-required',
  /** Too many mentions in one message, or too many this hour. */
  rateLimited: 'mention-rate-limited',
} as const
