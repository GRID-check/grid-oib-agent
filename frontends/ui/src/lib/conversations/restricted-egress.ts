/**
 * What may leave a conversation that drew on a folder with restricted access
 * (ADR-0087, ADR-0088).
 *
 * Product rule: restricted-folder content must not reach colleagues not cleared
 * for that folder. Sharing such a conversation is decided per person
 * (`restricted-use.ts`: the person must be cleared for every folder it drew
 * on). This module holds the other doors an answer could leave by, each of
 * which writes something the whole project reads:
 *
 *   * a deep-research run (its title, plan and report are listed to every
 *     project member, and its prompt is model-written with restricted content in
 *     front of the model) — `commissionResearchRun`;
 *   * a task (`delegateTask`), for the same reason;
 *   * the project profile (`patchProjectProfile` from a `project_profile_patch`
 *     card);
 *   * a document filed into the project (`fileGeneratedDocument`, and the agent
 *     rewriting a draft's content): allowed only into a folder restricted at
 *     least as narrowly, see {@link requireMayFileFrom};
 *   * a revision task opened from a draft in a restricted folder, whatever its
 *     conversation, see {@link folderRestrictsReading};
 *   * a run's Unterlagen (`commissionResearchRun`, `addRunDocument`): a
 *     document's name and title are written into the run's plan and job stream
 *     and its report's „Nicht gelesene Unterlagen", which every member of the
 *     project reads (ADR-0084 lets every `project:chat` member read and steer
 *     every run of the project). A document from a folder not every member may
 *     read is refused there, whoever names it; see {@link requirePlanDocumentsOpen}.
 *     This door is about the DOCUMENT, not the conversation: a cleared member
 *     can pick one from their own inventory in an open thread.
 *
 * ## Which conversations
 *
 * Those that RECORDED a source folder not every member may read now: content
 * from it entered the model's context in some turn (`recordedRestrictedFolders`). The record is
 * written before the content enters the context, so it is current when the same
 * turn reaches for one of these doors. A conversation that could have searched
 * a restricted folder and never drew on one is not confined.
 *
 * ## Filing, by the record
 *
 * A document may be filed where everyone who can open it may read every
 * folder the conversation recorded: the destination's path must carry each of
 * them. A folder since opened to every member drops out, at read time.
 */

import 'server-only'
import { ConversationConfinedError } from '@/lib/api/errors'
import { getDictionary } from '@/i18n/dictionaries'
import type { Locale } from '@/i18n/config'
import { folderTree, readableByEveryMember } from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { internalRead } from '@/lib/documents/document-reader'
import { findProjectDocumentsByFilenames } from '@/lib/documents/repository'
import type { PlanDocument } from '@/lib/runs/plan-documents'
import { recordedRestrictedFolders } from './restricted-use'

export type ConfinedAction = ConversationConfinedError['action']

/**
 * The language the agent's internal routes refuse in. The tools relay the
 * error verbatim to the model, which relays it to a German-speaking office;
 * the request carries no cookie and no `Accept-Language` to say otherwise.
 */
export const AGENT_REFUSAL_LOCALE: Locale = 'de'

/** The typed refusal, its message in the reader's language. */
export function confinementRefusal(action: ConfinedAction, locale: Locale): ConversationConfinedError {
  return new ConversationConfinedError(action, getDictionary(locale).errors.confinement[action])
}

/** Where content is about to come from. */
export interface ConversationOrigin {
  /** The conversation, from a verified envelope or an authorized body field; null for none. */
  conversationId: string | null
  /** The language of the refusal. The agent's routes pass {@link AGENT_REFUSAL_LOCALE}. */
  locale: Locale
}

/** The source folders the origin's conversation recorded that still restrict someone; none without a conversation. */
async function originFolders(origin: ConversationOrigin, organizationId: string): Promise<string[]> {
  if (!origin.conversationId) return []
  return recordedRestrictedFolders(origin.conversationId, organizationId)
}

/**
 * Refuse a door that writes something every project member reads: a
 * deep-research run, a task, the project profile. No folder is narrow enough
 * for these, so a confined origin is refused outright.
 */
export async function requireMayLeaveConversation(
  origin: ConversationOrigin,
  organizationId: string,
  action: Exclude<ConfinedAction, 'filing' | 'planDocument'>
): Promise<void> {
  if ((await originFolders(origin, organizationId)).length > 0) throw confinementRefusal(action, origin.locale)
}

/** Where a document is about to be filed. */
export interface FilingDestination {
  organizationId: string
  /**
   * The project, or null for a document outside every project (the Archiv,
   * which every member of the organization reads and which restricts nothing).
   */
  projectId: string | null
  projectCollection: string
  /** The destination folder; null for a folder that does not exist yet (it would be created open, at the root). */
  folderId: string | null
}

/**
 * Refuse filing content from a conversation into a folder that someone who may
 * not read one of the folders it drew on can read.
 *
 * Allowed only when every source folder the conversation recorded (and that
 * still restricts someone) is on the destination's path, itself included:
 * nesting only narrows (`effectiveFolderLevel`), so whoever may read the
 * destination may read each of them. A deleted folder is on no living path,
 * so content drawn from one files nowhere new. A conversation that drew on
 * none files anywhere.
 */
export async function requireMayFileFrom(origin: ConversationOrigin, destination: FilingDestination): Promise<void> {
  const { organizationId, projectId, folderId } = destination
  const required = await originFolders(origin, organizationId)
  if (required.length === 0) return
  if (projectId === null || folderId === null) throw confinementRefusal('filing', origin.locale)
  const tree = folderTree(await listProjectFolderTree(organizationId, projectId))
  const path = new Set<string>()
  for (let current = tree.get(folderId); current && !current.deleted && !path.has(current.id); ) {
    path.add(current.id)
    current = current.parentId ? tree.get(current.parentId) : undefined
  }
  if (required.every((source) => path.has(source))) return
  throw confinementRefusal('filing', origin.locale)
}

/**
 * Whether a document filed in `folderId` of `projectId` is one some project
 * member may not read: its folder, or an ancestor, restricts reading. The test
 * a door that every member reads applies to a DOCUMENT rather than a
 * conversation: a revision task quotes the draft's text into its run, and its
 * goal and filename are listed to the whole project (`openRevisionTask`).
 *
 * False for the project root and for a document outside every project. A
 * folder the tree no longer holds counts as restricting: the safe direction.
 */
export async function folderRestrictsReading(
  organizationId: string,
  projectId: string | null,
  folderId: string | null
): Promise<boolean> {
  if (projectId === null || folderId === null) return false
  const tree = folderTree(await listProjectFolderTree(organizationId, projectId))
  return !readableByEveryMember(tree, folderId)
}

/** The Archiv is the organization's shelf: every member reads it, and no project folder restricts it. */
const ARCHIV_SHELF = 'archiv'

/**
 * Refuse a run's Unterlagen when one of them is a project document filed in a
 * folder not every member of the project may read.
 *
 * A plan document is a file name (ADR-0047) with a title beside it, and both
 * are shown to the whole project: in the run's plan, in its job stream (the
 * `job.document_added` event), and in the report's „Nicht gelesene
 * Unterlagen", because the run's scope holds no restricted collection and
 * cannot read the file. So the name is resolved against every document of the
 * project, restricted folders included and archived rows too, and refused when
 * any row by that name sits in such a folder. Names are not unique across
 * folders: a name that also exists in an open folder is refused as well, the
 * safe reading. An Archiv entry needs no check. A name the project does not
 * hold passes: there is nothing to leak.
 *
 * Refused, never dropped: the reader picked the document on purpose, and a
 * silent drop would leave them believing the run reads it.
 */
export async function requirePlanDocumentsOpen(
  organizationId: string,
  projectId: string,
  documents: readonly PlanDocument[],
  locale: Locale
): Promise<void> {
  const names = documents.filter((document) => document.shelf !== ARCHIV_SHELF).map((document) => document.name)
  if (names.length === 0) return
  const folders = await listProjectFolderTree(organizationId, projectId)
  // No folder has its own list, so every folder is read by every member.
  if (!folders.some((folder) => folder.accessMode === 'custom')) return
  const tree = folderTree(folders)
  // Every row by that name, held ones included (ADR-0086): the answer is only
  // ever a refusal, and a held file in a restricted folder is still there.
  const rows = await findProjectDocumentsByFilenames(projectId, organizationId, names, {
    includeArchived: true,
    reader: internalRead('identity'),
  })
  if (rows.some((row) => row.folderId !== null && !readableByEveryMember(tree, row.folderId))) {
    throw confinementRefusal('planDocument', locale)
  }
}
