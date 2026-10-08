/**
 * Which restricted folders a conversation drew on, and who may therefore read
 * it (ADR-0084, ADR-0085). The one place that decides.
 *
 * Product rule (product owner, 2026-10-02): a conversation is restricted only
 * by what it actually USED, and per person: different people may read
 * different folders. So:
 *
 *   * a folder is USED when content from it enters the model's context in a
 *     turn (a retrieval hit, an opened document). Every use of a folder that
 *     not every project member can read is recorded in
 *     `conversation_restricted_folders`, by the SOURCE FOLDER's id;
 *   * the conversation may be shared with person P iff P may read every folder
 *     it recorded ({@link widenConversationAudience}); it may be made visible to
 *     the project only while every folder it recorded is one every member reads.
 *
 * Every one of those questions is asked of the folders' access as it is NOW
 * (`effectiveFolderLevel`), never of a stored role list or collection name: a
 * loosened folder opens the conversation, a tightened one closes it, and a
 * deleted folder's tombstone keeps the access it had. A folder id the tree does
 * not know is a folder nobody may read.
 *
 * Widening takes a per-conversation lock (`lockConversationAudience`), so a
 * use recorded under the same lock cannot slip between a share's check and its
 * write.
 *
 * What a conversation recorded also decides what may LEAVE it into something
 * the whole project reads (`restricted-egress.ts`): {@link recordedRestrictedFolders}
 * is that answer, and the one function a later caller (runs and tasks that
 * inherit the restriction) should read.
 */

import 'server-only'
import { ConflictError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  atLeast,
  clearanceOf,
  clearanceOfMember,
  customFolderNames,
  effectiveFolderLevel,
  folderTree,
  readableByEveryMember,
  type FolderClearance,
  type FolderTree,
} from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { getDb } from '@/lib/db'
import type { DbExecutor } from '@/lib/db/executor'
import { findProjectCollectionName } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { SHARING_ERROR_REASONS } from '@/lib/sharing/types'
import {
  listRecordedSourceFolders,
  lockConversationAudience,
  readConversationAudience,
  type ConversationAudienceRow,
} from './restricted-use-repository'

/** Whether `clearance` may read `folderId` now (a tombstone included; an unknown id never). */
export function mayReadFolder(tree: FolderTree, clearance: FolderClearance, folderId: string): boolean {
  return atLeast(effectiveFolderLevel(tree, clearance, folderId), 'read')
}

/**
 * The folders among `candidates` every person may read. A conversation visible
 * beyond its people (the project) gets none: its readers cannot be enumerated,
 * and a member who joins the project tomorrow reads it too. A person whose
 * clearance is unknown reads nothing that is restricted.
 */
export function foldersEveryoneMayRead(
  tree: FolderTree,
  candidates: readonly string[],
  audience: Pick<ConversationAudienceRow, 'visibility'>,
  people: readonly string[],
  clearances: ReadonlyMap<string, FolderClearance>
): string[] {
  if (audience.visibility !== 'private') return []
  return candidates.filter((folderId) =>
    people.every((person) => {
      const clearance = clearances.get(person)
      return clearance !== undefined && mayReadFolder(tree, clearance, folderId)
    })
  )
}

/** The project a conversation belongs to: its row's, else (not created yet) the one the caller states. */
export interface ProjectRef {
  projectId: string
  projectCollection: string
}

async function projectOf(
  organizationId: string,
  audience: ConversationAudienceRow,
  statedProjectId: string | null
): Promise<ProjectRef | null> {
  const projectId = audience.exists ? audience.projectId : statedProjectId
  if (!projectId) return null
  const projectCollection = await findProjectCollectionName(projectId, organizationId)
  return projectCollection ? { projectId, projectCollection } : null
}

async function treeOf(organizationId: string, project: ProjectRef): Promise<FolderTree> {
  return folderTree(await listProjectFolderTree(organizationId, project.projectId))
}

/** The recorded folders that still restrict someone: not readable by every member now, or unknown. */
function stillRestricting(tree: FolderTree, recorded: readonly string[]): string[] {
  return recorded.filter((folderId) => !readableByEveryMember(tree, folderId))
}

/**
 * The source folders this conversation recorded that not every project member
 * may read NOW, sorted. A folder since opened to everyone drops out; a deleted
 * folder's tombstone stays as restricted as it was; an unknown id stays.
 *
 * The answer to "did this conversation draw on restricted content, and from
 * where": the share check, every egress refusal and a later caller that must
 * inherit the restriction (a run or a task commissioned from the conversation)
 * read it.
 */
export async function recordedRestrictedFolders(conversationId: string, organizationId: string): Promise<string[]> {
  const recorded = await listRecordedSourceFolders(getDb(), organizationId, conversationId)
  if (recorded.length === 0) return []
  const audience = await readConversationAudience(getDb(), organizationId, conversationId)
  const project = await projectOf(organizationId, audience, null)
  // A record whose conversation is gone (or never got its row) still refuses:
  // without a project there is no access to read, so all of it counts.
  if (!project) return recorded
  return stillRestricting(await treeOf(organizationId, project), recorded)
}

/** A widening of a conversation's audience. */
export type AudienceWidening =
  /** A grant to one person; `self` when a project admin escalates to owner. */
  | { kind: 'person'; userId: string; self: boolean }
  /** A visibility wider than `private`. */
  | { kind: 'visibility' }

/** The refusal, naming the folders only to a sharer who may read them. */
async function wideningRefusal(
  session: AuthorizedSession,
  widening: AudienceWidening,
  missing: readonly string[],
  context: WideningContext
): Promise<ConflictError> {
  if (widening.kind === 'visibility') {
    return new ConflictError(
      'This conversation draws on a folder with restricted access and cannot be made visible to the whole project.',
      { reason: SHARING_ERROR_REASONS.restrictedContentProject }
    )
  }
  if (widening.self) {
    return new ConflictError('You may not read every restricted folder this conversation draws on.', {
      reason: SHARING_ERROR_REASONS.restrictedContentSelf,
    })
  }
  const directory = await loadOrganizationDirectory(session.organizationId)
  const person = directory.get(widening.userId)?.name ?? null
  const folders = context.project ? await folderNamesReadableBy(session, context, missing) : []
  return new ConflictError('That person may not read every restricted folder this conversation draws on.', {
    reason: SHARING_ERROR_REASONS.restrictedContent,
    ...(person ? { person } : {}),
    ...(folders.length > 0 ? { folders } : {}),
  })
}

/** The names of those of `folderIds` the session may read: what may be named to it. */
async function folderNamesReadableBy(
  session: AuthorizedSession,
  context: WideningContext,
  folderIds: readonly string[]
): Promise<string[]> {
  if (!context.project) return []
  const names = await customFolderNames(session.organizationId, context.project.projectId)
  const sharer = await clearanceOf(session)
  return folderIds
    .filter((folderId) => mayReadFolder(context.tree, sharer, folderId))
    .map((folderId) => names.get(folderId))
    .filter((name): name is string => Boolean(name))
}

/** The folders of `restricted` a widening would expose to someone who may not read them. */
function uncovered(widening: AudienceWidening, restricted: readonly string[], context: WideningContext): string[] {
  if (widening.kind === 'visibility') return [...restricted]
  const person = context.person
  return restricted.filter((folderId) => !person || !mayReadFolder(context.tree, person, folderId))
}

interface WideningContext {
  project: ProjectRef | null
  tree: FolderTree
  /** The clearance of the person being let in; null for a visibility widening. */
  person: FolderClearance | null
}

async function wideningContext(
  session: AuthorizedSession,
  conversationId: string,
  widening: AudienceWidening
): Promise<WideningContext> {
  const audience = await readConversationAudience(getDb(), session.organizationId, conversationId)
  const project = await projectOf(session.organizationId, audience, null)
  const tree: FolderTree = project ? await treeOf(session.organizationId, project) : new Map()
  if (widening.kind === 'visibility') return { project, tree, person: null }
  const person = widening.self ? await clearanceOf(session) : await clearanceOfMember(session.organizationId, widening.userId)
  return { project, tree, person }
}

/** The recorded folders that restrict someone, judged against the context's tree. */
function restrictedRecord(context: WideningContext, recorded: readonly string[]): string[] {
  return context.project ? stillRestricting(context.tree, recorded) : [...recorded]
}

/**
 * Refuse a widening the conversation's record forbids, before anything is
 * written or a rate limit spent. Not the guarantee: {@link widenConversationAudience}
 * checks again under the lock, with the write.
 */
export async function assertMayWidenConversation(
  session: AuthorizedSession,
  conversationId: string,
  widening: AudienceWidening
): Promise<void> {
  const context = await wideningContext(session, conversationId, widening)
  const recorded = restrictedRecord(context, await listRecordedSourceFolders(getDb(), session.organizationId, conversationId))
  const missing = uncovered(widening, recorded, context)
  if (missing.length > 0) throw await wideningRefusal(session, widening, missing, context)
}

/**
 * Widen the conversation's audience with `write`, under the lock admission
 * takes, after checking the record inside it: a person must be able to read
 * every folder the conversation recorded, and a project-wide visibility needs a
 * record that restricts nobody. `write` runs on the transaction's handle and
 * must not call `getDb()`.
 */
export async function widenConversationAudience<T>(
  session: AuthorizedSession,
  conversationId: string,
  widening: AudienceWidening,
  write: (executor: DbExecutor) => Promise<T>
): Promise<T> {
  const context = await wideningContext(session, conversationId, widening)
  const refusal: { missing: string[] } = { missing: [] }
  const result = await getDb().transaction(async (tx) => {
    await lockConversationAudience(tx, session.organizationId, conversationId)
    const recorded = restrictedRecord(context, await listRecordedSourceFolders(tx, session.organizationId, conversationId))
    refusal.missing = uncovered(widening, recorded, context)
    if (refusal.missing.length > 0) return null
    return { value: await write(tx) }
  })
  if (result === null) throw await wideningRefusal(session, widening, refusal.missing, context)
  return result.value
}
