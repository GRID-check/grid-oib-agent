/**
 * What may leave a conversation that drew on a folder with restricted access
 * (ADR-0080, ADR-0081).
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
 *     least as narrowly, see {@link requireMayFileFrom}.
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
import { folderTree } from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { recordedRestrictedFolders, recordedSourceProjects } from './restricted-use'

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
 * The other projects the origin's conversation drew on through a cross-project
 * lookup (ADR-0082); none without a conversation. Every one counts: a door a
 * whole project reads cannot enumerate whether each of its readers may open
 * them, so content from another project leaves by none of these doors.
 */
async function originProjects(origin: ConversationOrigin, organizationId: string): Promise<string[]> {
  if (!origin.conversationId) return []
  return recordedSourceProjects(origin.conversationId, organizationId)
}

/**
 * Refuse a door that writes something every project member reads: a
 * deep-research run, a task, the project profile. No folder is narrow enough
 * for these, so a confined origin is refused outright, and so is one that drew
 * on another project.
 */
export async function requireMayLeaveConversation(
  origin: ConversationOrigin,
  organizationId: string,
  action: Exclude<ConfinedAction, 'filing'>
): Promise<void> {
  const [folders, projects] = await Promise.all([
    originFolders(origin, organizationId),
    originProjects(origin, organizationId),
  ])
  if (folders.length > 0 || projects.length > 0) throw confinementRefusal(action, origin.locale)
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
  // No folder of this project is narrow enough for another project's content (ADR-0082).
  if ((await originProjects(origin, organizationId)).length > 0) throw confinementRefusal('filing', origin.locale)
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
