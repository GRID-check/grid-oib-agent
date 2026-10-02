/**
 * What may leave a conversation that drew on a folder with restricted access
 * (ADR-0078).
 *
 * Product rule: restricted-folder content must not reach colleagues not cleared
 * for that folder. Such a conversation already cannot be shared
 * (`sharing/registry.ts`, `confinedToOwner`). This module holds the other doors
 * an answer could leave by, each of which writes something the whole project
 * reads:
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
 * One predicate, {@link isConversationConfined}, the same the share refusal
 * asks: the conversation ran a turn with a restricted collection in its signed
 * scope (`conversation_restricted_turns`, written at turn START by the
 * confinement route), or a stored answer cites or read a restricted collection.
 * A caller holding the turn's verified envelope also passes the envelope's own
 * restricted collections, which refuse on their own: that is the turn's scope
 * as signed, with no read in between.
 *
 * ## Why every restricted collection of the project, for filing
 *
 * The mark records that a restricted turn ran, not which restricted collections
 * its scope held, and the inventory block names every in-scope document with
 * its summary, so an answer can carry a folder it never cited. A conversation's
 * content is therefore taken to depend on every restricted collection the
 * project has now (a lifted restriction left its documents open, so it drops
 * out). That over-restricts a member cleared for only some folders; it never
 * under-restricts, and it does not depend on what a member is cleared for today.
 */

import 'server-only'
import { ConversationConfinedError } from '@/lib/api/errors'
import { getDictionary } from '@/i18n/dictionaries'
import type { Locale } from '@/i18n/config'
import {
  currentRestrictedCollections,
  restrictedCollectionBase,
  restrictedCollectionsAbove,
} from '@/lib/authz/folder-access'
import { hasRestrictedTurn, listRestrictedAnswerCollections } from './repository'

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

/** Whether this conversation drew on a folder with restricted access. */
export async function isConversationConfined(conversationId: string, organizationId: string): Promise<boolean> {
  if (await hasRestrictedTurn(conversationId, organizationId)) return true
  const collections = await listRestrictedAnswerCollections(conversationId, organizationId)
  return collections.some((collection) => restrictedCollectionBase(collection) !== null)
}

/** The restricted-folder collections among a verified envelope's scope names. */
export function restrictedCollectionsIn(scope: readonly string[]): string[] {
  return scope.filter((collection) => restrictedCollectionBase(collection) !== null)
}

/** Where content is about to come from: a conversation, the turn's signed scope, or both. */
export interface ConversationOrigin {
  /** The conversation, from a verified envelope or an authorized body field. */
  conversationId: string | null
  /** The restricted collections in the turn's VERIFIED envelope, when the caller holds one. */
  signedRestrictedCollections?: readonly string[]
  /** The language of the refusal. The agent's routes pass {@link AGENT_REFUSAL_LOCALE}. */
  locale: Locale
}

async function originIsConfined(origin: ConversationOrigin, organizationId: string): Promise<boolean> {
  if ((origin.signedRestrictedCollections ?? []).length > 0) return true
  if (!origin.conversationId) return false
  return isConversationConfined(origin.conversationId, organizationId)
}

/**
 * Refuse a door that writes something every project member reads: a
 * deep-research run, a task, the project profile. No folder is narrow enough
 * for these, so a confined origin is refused outright.
 */
export async function requireMayLeaveConversation(
  origin: ConversationOrigin,
  organizationId: string,
  action: Exclude<ConfinedAction, 'filing'>
): Promise<void> {
  if (await originIsConfined(origin, organizationId)) throw confinementRefusal(action, origin.locale)
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
 * Refuse filing content from a confined origin into a folder that someone not
 * cleared for one of the project's restricted folders can read.
 *
 * Allowed only when every current restricted collection of the project is on
 * the destination's path (`restrictedCollectionsOnPath`): then anyone who can
 * open the document is cleared for everything the conversation could have
 * drawn on. A project that restricts nothing any more allows it.
 */
export async function requireMayFileFrom(origin: ConversationOrigin, destination: FilingDestination): Promise<void> {
  if (!(await originIsConfined(origin, destination.organizationId))) return
  const { organizationId, projectId, projectCollection, folderId } = destination
  if (projectId === null) throw confinementRefusal('filing', origin.locale)
  const required = await currentRestrictedCollections(organizationId, projectId, projectCollection)
  if (required.length === 0) return
  const covered = new Set(await restrictedCollectionsAbove(organizationId, projectId, projectCollection, folderId))
  if (required.every((collection) => covered.has(collection))) return
  throw confinementRefusal('filing', origin.locale)
}
