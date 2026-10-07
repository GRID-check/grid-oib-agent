/**
 * What a chat drew on from OTHER projects (ADR-0085): the record the
 * cross-project lookups write, and what it refuses.
 *
 * ## Recorded when the BFF hands the content out
 *
 * A lookup (`lib/cross-project/service.ts`) answers the agent with passages,
 * names and facts of projects the turn's signed scope does not hold. It
 * searches AS THE AUDIENCE: only what everyone who reads the conversation may
 * open (`lib/cross-project/audience-reach.ts`). Before the answer leaves the
 * BFF, {@link recordCrossProjectHandOut} records it, in one transaction under
 * the per-conversation lock every share, visibility change and escalation
 * takes:
 *
 *   * the audience must still be the one the reach was computed for
 *     ({@link audienceKey}), read under that lock, so a share cannot slip
 *     between the search and the record; otherwise nothing is handed out;
 *   * each project the answer says anything about is recorded in
 *     `conversation_source_projects` (migration 0116);
 *   * each restricted folder a passage came from is recorded by id in
 *     `conversation_restricted_folders`, beside the conversation's own folders.
 *
 * The record therefore exists before the content can reach the model, whatever
 * the agent does with it. A result the agent then drops still counts as used.
 *
 * From then on the record decides who may read the conversation, what may
 * leave it (`restricted-egress.ts`) and what may be remembered from it
 * ({@link requireMayRememberFrom}). A project closed NOW restricts nobody: every
 * office member reads its open folders (ADR-0082). It stays recorded, so a
 * reopen restricts again; the judges read `listRestrictingSourceProjects`.
 */

import 'server-only'
import { CrossProjectAudienceChangedError, CrossProjectMemoryError } from '@/lib/api/errors'
import { getDictionary } from '@/i18n/dictionaries'
import { getDb } from '@/lib/db'
import { AGENT_REFUSAL_LOCALE } from './restricted-egress'
import {
  listRestrictingSourceProjects,
  lockConversationAudience,
  readConversationAudience,
  recordSourceFolders,
  recordSourceProjects,
  type ConversationAudienceRow,
} from './restricted-use-repository'

/**
 * Whether a conversation is its asker's alone: not yet created (its first turn
 * creates it, private, for this asker), or private, created by the asker and
 * granted to nobody else.
 */
export function isSoloAudience(audience: ConversationAudienceRow, userId: string): boolean {
  if (!audience.exists) return true
  if (audience.visibility !== 'private' || audience.createdBy !== userId) return false
  return audience.grantees.every((grantee) => grantee === userId)
}

/**
 * Who reads a conversation, as one comparable string: its visibility, its
 * creator and its grantees. Two equal keys mean the same readers, so a reach
 * computed for one is valid for the other.
 */
export function audienceKey(audience: ConversationAudienceRow): string {
  if (!audience.exists) return 'new'
  return [audience.visibility, audience.createdBy ?? '', ...[...audience.grantees].sort()].join('|')
}

/** The refusal of a lookup whose conversation changed readers mid-lookup, in the language the agent relays. */
export function audienceChangedRefusal(): CrossProjectAudienceChangedError {
  return new CrossProjectAudienceChangedError(getDictionary(AGENT_REFUSAL_LOCALE).errors.crossProject.audienceChanged)
}

/** Who hands content out, into which conversation. */
export interface HandOutParty {
  organizationId: string
  userId: string
  conversationId: string
}

/** What an answer says about other projects: the projects, and the restricted folders its passages came from. */
export interface CrossProjectHandOut {
  projectIds: readonly string[]
  folderIds: readonly string[]
}

/**
 * Record what a lookup is about to hand out, or refuse it. See the module
 * docstring. `searchedFor` is the {@link audienceKey} the reach was computed
 * for; throws {@link CrossProjectAudienceChangedError} when the conversation's
 * readers differ now, and records nothing then.
 */
export async function recordCrossProjectHandOut(
  party: HandOutParty,
  handOut: CrossProjectHandOut,
  searchedFor: string
): Promise<void> {
  const { organizationId, conversationId } = party
  const unchanged = await getDb().transaction(async (tx) => {
    await lockConversationAudience(tx, organizationId, conversationId)
    const audience = await readConversationAudience(tx, organizationId, conversationId)
    // A conversation created mid-lookup by its first turn is still the asker's alone.
    const now = audienceKey(audience)
    if (now !== searchedFor && !(searchedFor === 'new' && isSoloAudience(audience, party.userId))) return false
    await recordSourceProjects(tx, organizationId, conversationId, [...new Set(handOut.projectIds)])
    await recordSourceFolders(tx, organizationId, conversationId, [...new Set(handOut.folderIds)])
    return true
  })
  if (!unchanged) throw audienceChangedRefusal()
}

/**
 * Whether this conversation drew on another project that still restricts its
 * readers (ADR-0085): an active one, or a folder of one. What a turn reads to
 * know its doors are shut. Content from a project closed now does not count.
 */
export async function drewOnOtherProjects(conversationId: string, organizationId: string): Promise<boolean> {
  return (await listRestrictingSourceProjects(getDb(), organizationId, conversationId)).length > 0
}

/**
 * Refuse a memory write from a conversation that drew on another project still
 * restricting its readers. Project and organization memory are read by
 * everyone in the project, and a note's words can carry what the other
 * project's documents said; no folder of this project is narrow enough for
 * that, so nothing is remembered from such a conversation. A lesson from a
 * closed project may be remembered: every office member reads it anyway. Both agent writers (`remember` and the reflection stage) name
 * the conversation; a write that names none is not one a chat turn made.
 */
export async function requireMayRememberFrom(
  conversationId: string | null | undefined,
  organizationId: string | null | undefined
): Promise<void> {
  if (!conversationId || !organizationId) return
  if (!(await drewOnOtherProjects(conversationId, organizationId))) return
  throw new CrossProjectMemoryError(getDictionary(AGENT_REFUSAL_LOCALE).errors.crossProject.memory)
}
