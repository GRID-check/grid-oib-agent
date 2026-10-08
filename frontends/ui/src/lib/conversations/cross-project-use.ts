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
 * reopen restricts again; the judges read `listRestrictingSourceProjects`. Its
 * restricted folders are judged on their own (`recordedForeignRestrictedFolders`)
 * and still restrict the turn's doors ({@link drewOnOtherProjects}).
 */

import 'server-only'
import { CrossProjectAudienceChangedError, CrossProjectMemoryError } from '@/lib/api/errors'
import { getDictionary } from '@/i18n/dictionaries'
import { getDb } from '@/lib/db'
import { AGENT_REFUSAL_LOCALE } from './restricted-egress'
import { isUuid } from '@/lib/ids'
import { recordedForeignRestrictedFolders, recordedForeignRestrictedProjects } from './restricted-use'
import {
  listProjectNames,
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
 * Whether this conversation drew on another project in a way that still
 * restricts its readers (ADR-0085): an active project, or a restricted folder
 * of ANY other project, closed or not. What a turn reads to know its doors are
 * shut. A closed project restricts nobody for its open folders, but a folder
 * with its own access list still does: every office member may open the closed
 * project, not every one may read that folder. A folder of the conversation's
 * own project is not counted here; the per-folder memory rules govern it.
 */
export async function drewOnOtherProjects(conversationId: string, organizationId: string): Promise<boolean> {
  if ((await listRestrictingSourceProjects(getDb(), organizationId, conversationId)).length > 0) return true
  return (await recordedForeignRestrictedFolders(conversationId, organizationId)).length > 0
}

/** An other project that restricts a conversation now; `name` is null when the project is deleted or gone. */
export interface RestrictingOtherProject {
  id: string
  name: string | null
}

/**
 * The other projects that restrict this conversation NOW, for the notice that
 * says so: every recorded project that is not closed, plus the owner of every
 * recorded restricted folder of another project, a closed one included. The
 * same two reads as {@link drewOnOtherProjects}, so the notice and the turn's
 * doors agree: it is empty exactly when that is false. Judged at read time, so
 * a project closed since the answer drops out and a reopened one is back.
 * Sorted by name.
 */
export async function restrictingOtherProjects(
  conversationId: string,
  organizationId: string
): Promise<RestrictingOtherProject[]> {
  const [recorded, owners] = await Promise.all([
    listRestrictingSourceProjects(getDb(), organizationId, conversationId),
    recordedForeignRestrictedProjects(conversationId, organizationId),
  ])
  const ids = [...new Set([...recorded, ...owners])]
  const names = await listProjectNames(getDb(), organizationId, ids.filter(isUuid))
  return ids
    .map((id) => ({ id, name: names.get(id) ?? null }))
    .sort((a, b) => (a.name ?? '\uffff').localeCompare(b.name ?? '\uffff') || a.id.localeCompare(b.id))
}

/**
 * Refuse a memory write from a conversation that drew on another project still
 * restricting its readers. Project and organization memory are read by
 * everyone in the project, and a note's words can carry what the other
 * project's documents said; no folder of this project is narrow enough for
 * that, so nothing is remembered from such a conversation. A lesson from a
 * closed project's open folders may be remembered: every office member reads
 * them anyway; a restricted folder of any other project may not. Both agent
 * writers (`remember` and the reflection stage) name the conversation; a write
 * that names none is not one a chat turn made.
 */
export async function requireMayRememberFrom(
  conversationId: string | null | undefined,
  organizationId: string | null | undefined
): Promise<void> {
  if (!conversationId || !organizationId) return
  if (!(await drewOnOtherProjects(conversationId, organizationId))) return
  throw new CrossProjectMemoryError(getDictionary(AGENT_REFUSAL_LOCALE).errors.crossProject.memory)
}
