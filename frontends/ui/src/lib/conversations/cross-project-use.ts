/**
 * What a solo chat drew on from OTHER projects (ADR-0082): the record the
 * cross-project lookups write, and what it refuses.
 *
 * ## Recorded when the BFF hands the content out
 *
 * A lookup (`lib/cross-project/service.ts`) answers the agent with passages,
 * names and facts of projects the turn's signed scope does not hold. Before the
 * answer leaves the BFF, {@link recordCrossProjectHandOut} records it, in one
 * transaction under the per-conversation lock every share, visibility change
 * and escalation takes:
 *
 *   * the conversation must still be its asker's alone ({@link isSoloAudience}),
 *     read under that lock, so a share cannot slip between the check and the
 *     record; otherwise the lookup is refused and nothing is handed out;
 *   * each project the answer says anything about is recorded in
 *     `conversation_source_projects` (migration 0120);
 *   * each restricted folder a passage came from is recorded by id in
 *     `conversation_restricted_folders`, beside the conversation's own folders.
 *
 * The record therefore exists before the content can reach the model, whatever
 * the agent does with it, and without depending on a tool reporting what it
 * read (the residual ADR-0081 names for the conversation's own project). A
 * result the agent then drops still counts as used: the safe direction.
 *
 * From then on the record decides who may read the conversation (only people
 * who may open every recorded project and read every recorded folder,
 * `restricted-use.ts`), what may leave it (no run, task, profile patch or
 * filing, `restricted-egress.ts`) and what may be remembered from it (nothing,
 * {@link requireMayRememberFrom}).
 */

import 'server-only'
import { CrossProjectMemoryError, CrossProjectSharedChatError } from '@/lib/api/errors'
import { getDictionary } from '@/i18n/dictionaries'
import { getDb } from '@/lib/db'
import { AGENT_REFUSAL_LOCALE } from './restricted-egress'
import {
  listRecordedSourceProjects,
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

/** The refusal of a lookup from a conversation that is not its asker's alone, in the language the agent relays. */
export function sharedChatRefusal(): CrossProjectSharedChatError {
  return new CrossProjectSharedChatError(getDictionary(AGENT_REFUSAL_LOCALE).errors.crossProject.sharedChat)
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
 * docstring. Throws {@link CrossProjectSharedChatError} when the conversation
 * is not its asker's alone any more; records nothing then.
 */
export async function recordCrossProjectHandOut(party: HandOutParty, handOut: CrossProjectHandOut): Promise<void> {
  const { organizationId, conversationId } = party
  const solo = await getDb().transaction(async (tx) => {
    await lockConversationAudience(tx, organizationId, conversationId)
    const audience = await readConversationAudience(tx, organizationId, conversationId)
    if (!isSoloAudience(audience, party.userId)) return false
    await recordSourceProjects(tx, organizationId, conversationId, [...new Set(handOut.projectIds)])
    await recordSourceFolders(tx, organizationId, conversationId, [...new Set(handOut.folderIds)])
    return true
  })
  if (!solo) throw sharedChatRefusal()
}

/** Whether this conversation drew on another project (ADR-0082): what a turn reads to know its doors are shut. */
export async function drewOnOtherProjects(conversationId: string, organizationId: string): Promise<boolean> {
  return (await listRecordedSourceProjects(getDb(), organizationId, conversationId)).length > 0
}

/**
 * Refuse a memory write from a conversation that drew on another project.
 * Project and organization memory are read by everyone in the project, and a
 * note's words can carry what the other project's documents said; no folder of
 * this project is narrow enough for that, so nothing is remembered from such a
 * conversation. Both agent writers (`remember` and the reflection stage) name
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
