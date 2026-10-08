/**
 * Which restricted folders a conversation drew on, and who may therefore read
 * it (ADR-0087, ADR-0088). The one place that decides.
 *
 * Product rule (product owner, 2026-10-02): a conversation is restricted only
 * by what it actually USED, and per person: different people may read
 * different folders. So:
 *
 *   * a folder is USED when content from it enters the model's context in a
 *     turn (a retrieval hit, an opened document, a restricted memory line the
 *     digest served). Listing is not use: restricted documents are not in the
 *     inventory block or `list_files`. Every use of a folder that not every
 *     project member can read is recorded here first ({@link admitRestrictedUse},
 *     `conversation_restricted_folders`), by the SOURCE FOLDER's id;
 *   * a turn may draw on such a folder only if its asker AND everyone the
 *     conversation is currently shared with may READ it
 *     ({@link drawableRestrictedCollections}). A conversation visible to the
 *     whole project has an audience nobody can enumerate (members join later),
 *     so it draws on none;
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
 * Admission and widening take the same per-conversation lock
 * (`lockConversationAudience`), so a share cannot slip between an admission's
 * check and its record, nor a use between a share's check and its write.
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
  ANY_MEMBER,
  atLeast,
  clearanceOf,
  clearanceOfMember,
  computeFolderAccess,
  customFolderNames,
  effectiveFolderLevel,
  folderTree,
  readableByEveryMember,
  type AccessFolder,
  type FolderClearance,
  type FolderTree,
} from '@/lib/authz/folder-access'
import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import type { DbExecutor } from '@/lib/db/executor'
import { findProjectCollectionName } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { SHARING_ERROR_REASONS } from '@/lib/sharing/types'
import {
  listRecordedSourceFolders,
  listRecordedSourceFoldersFor,
  listRecordedSourceProjects,
  listRecordedSourceProjectsFor,
  lockConversationAudience,
  markAnswerRestrictedUse,
  projectsOfFolders,
  readConversationAudience,
  recordSourceFolders,
  type ConversationAudienceRow,
} from './restricted-use-repository'

/** Most restricted collections or folders one admission names; a project has a handful. */
export const ADMISSION_MAX_COLLECTIONS = 50

/** Everyone who reads the conversation if it is private: the asker, its creator, its grantees. */
function audiencePeople(audience: ConversationAudienceRow, askerUserId: string | null): string[] {
  return [
    ...new Set([askerUserId, audience.createdBy, ...audience.grantees].filter((id): id is string => Boolean(id))),
  ]
}

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

/**
 * What judges a record: one folder tree holding the conversation's own
 * project's folders and those of every project a recorded folder belongs to
 * (a cross-project lookup, ADR-0093, records folders of OTHER projects, and a
 * conversation with no project has no tree of its own), and which project owns
 * each folder. Folder ids are unique across projects, so the trees merge into
 * one map. The owner matters because a clearance is one project's (ADR-0089:
 * someone who reads a closed project only because it is closed clears
 * less there), so a folder is judged with the reader's clearance IN ITS OWN
 * project. A folder no project owns stays unknown: nobody reads it.
 */
interface RecordView {
  tree: FolderTree
  /** Folder id → the project that owns it. */
  ownerOf: ReadonlyMap<string, string>
}

async function recordView(
  organizationId: string,
  projectId: string | null,
  folderIds: readonly string[]
): Promise<RecordView> {
  const merged = new Map<string, AccessFolder>()
  const ownerOf = new Map<string, string>()
  const load = async (owner: string) => {
    for (const folder of await listProjectFolderTree(organizationId, owner)) {
      merged.set(folder.id, folder)
      ownerOf.set(folder.id, owner)
    }
  }
  if (projectId) await load(projectId)
  const missing = folderIds.filter((folderId) => !merged.has(folderId))
  if (missing.length === 0) return { tree: merged, ownerOf }
  const owners = new Set((await projectsOfFolders(getDb(), organizationId, missing)).values())
  owners.delete(projectId ?? '')
  for (const owner of owners) await load(owner)
  return { tree: merged, ownerOf }
}

/** The projects that own `folderIds` in this view; a folder no project owns is left out (nobody reads it). */
function ownersOf(view: RecordView, folderIds: readonly string[]): string[] {
  return [...new Set(folderIds.map((folderId) => view.ownerOf.get(folderId)).filter((owner): owner is string => !!owner))]
}

/**
 * Whether every one of `folderIds` may be read with the clearance its own
 * project gives (`clearanceIn`). A folder no project owns, or a project with
 * no clearance known, reads as not readable.
 */
function mayReadEvery(
  view: RecordView,
  clearanceIn: (projectId: string) => FolderClearance | undefined,
  folderIds: readonly string[]
): boolean {
  return folderIds.every((folderId) => {
    const owner = view.ownerOf.get(folderId)
    const clearance = owner ? clearanceIn(owner) : undefined
    return clearance !== undefined && mayReadFolder(view.tree, clearance, folderId)
  })
}

/** How many people one question about a conversation's readers asks about projects at the same time. */
const PROJECT_CHECK_CONCURRENCY = 20

/**
 * The people among `people` who may open every one of `projectIds` now: the
 * question a cross-project record (ADR-0093) puts to everyone who would read
 * the conversation. Asked of WorkOS the way an invitation asks
 * (`userHoldsProjectPermission`, `project:view`, the admin bypass mirrored),
 * failing closed. Per person the projects are asked one after another and the
 * first refusal ends that person's questions, so a roster costs at most
 * people × projects checks and usually far fewer; people are asked a bounded
 * number at a time.
 */
async function peopleWhoMayOpen(
  organizationId: string,
  people: readonly string[],
  projectIds: readonly string[]
): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set(people)
  const opensAll = async (person: string): Promise<boolean> => {
    for (const projectId of projectIds) {
      if (!(await userHoldsProjectPermission({ organizationId }, projectId, person, 'project:view'))) return false
    }
    return true
  }
  const opening = new Set<string>()
  for (let start = 0; start < people.length; start += PROJECT_CHECK_CONCURRENCY) {
    const chunk = people.slice(start, start + PROJECT_CHECK_CONCURRENCY)
    const verdicts = await Promise.all(chunk.map(opensAll))
    chunk.forEach((person, index) => {
      if (verdicts[index]) opening.add(person)
    })
  }
  return opening
}

/** Whether the session may open every one of `projectIds` now, remembering each answer in `known`. */
async function sessionMayOpenAll(
  session: AuthorizedSession,
  projectIds: readonly string[],
  known: Map<string, boolean>
): Promise<boolean> {
  for (const projectId of projectIds) {
    let opens = known.get(projectId)
    if (opens === undefined) {
      opens = await requireProjectAccess(session, projectId, 'project:view').then(
        () => true,
        () => false
      )
      known.set(projectId, opens)
    }
    if (!opens) return false
  }
  return true
}

/** How many people one clearance read asks WorkOS about at the same time. */
const CLEARANCE_CONCURRENCY = 20

/**
 * Each person's clearance. `known` supplies one the caller already holds (the
 * session's own); everyone else is asked of WorkOS (at most a minute old), a
 * bounded number at a time so a question about a whole roster is not a burst.
 */
async function clearancesOf(
  organizationId: string,
  projectId: string | null,
  people: readonly string[],
  known: ReadonlyMap<string, FolderClearance> = new Map()
): Promise<Map<string, FolderClearance>> {
  const clearances = new Map<string, FolderClearance>()
  for (let start = 0; start < people.length; start += CLEARANCE_CONCURRENCY) {
    const chunk = people.slice(start, start + CLEARANCE_CONCURRENCY)
    const found = await Promise.all(
      // No project: no folder is known, so no clearance could read one.
      chunk.map((person) => known.get(person) ?? (projectId ? clearanceOfMember(organizationId, person, projectId) : ANY_MEMBER))
    )
    chunk.forEach((person, index) => clearances.set(person, found[index]))
  }
  return clearances
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
  // A folder no project holds any more (or a record whose conversation never
  // got its row and names no other project) stays: unknown counts as restricting.
  return stillRestricting((await recordView(organizationId, audience.projectId, recorded)).tree, recorded)
}

/**
 * Mark the answer a turn is writing when its conversation already drew on a
 * folder with restricted access, by the database's rule
 * (`grid_conversation_restricted_use`, ADR-0092). Asked at turn start, before
 * the model reads the conversation's history: the answer can quote what an
 * earlier turn admitted, and a vote on it names it by this id whether or not
 * the answer is ever persisted. Without an answer id, nothing to mark.
 */
export async function markTurnAnswer(request: RestrictedUseRequest): Promise<void> {
  if (!request.answerMessageId) return
  await markAnswerRestrictedUse(getDb(), request.organizationId, request.conversationId, request.answerMessageId)
}

/**
 * The other projects this conversation drew on through a cross-project lookup
 * (ADR-0093), sorted. Every one counts, whoever may open it now: the doors a
 * whole project reads (`restricted-egress.ts`) cannot enumerate their readers,
 * so none of them may carry another project's content.
 */
export async function recordedSourceProjects(conversationId: string, organizationId: string): Promise<string[]> {
  return listRecordedSourceProjects(getDb(), organizationId, conversationId)
}

/**
 * How many people one question about who may read a conversation evaluates.
 * The roster of a conversation is capped at 200 and a project has fewer
 * members; anybody beyond the bound is reported as not reading, the safe side
 * for a share (the server refuses a grant on its own check regardless).
 */
export const READERS_MAX_PEOPLE = 200

/**
 * The people among `userIds` who may read what this conversation drew on NOW:
 * every source folder it recorded that still restricts someone, by their roles
 * as WorkOS reports them (at most a minute old), or by `known` for those the
 * caller already holds a clearance for (the session's own).
 *
 * The question behind the share dialog's picker, the roster's "no longer has
 * access" and the open chat's "you no longer have the rights". Nothing is
 * stored about who reads: a role given back opens the chat again. A
 * conversation that recorded nothing restricting costs one indexed read and
 * answers everyone; one with a record the tree cannot answer (no project, an
 * unknown folder) answers nobody.
 */
export async function peopleWhoMayRead(
  organizationId: string,
  conversationId: string,
  userIds: readonly string[],
  known: ReadonlyMap<string, FolderClearance> = new Map(),
  /** The session asking, whose clearance is read from it rather than from WorkOS. */
  asker?: AuthorizedSession
): Promise<Set<string>> {
  const [recorded, projects] = await Promise.all([
    listRecordedSourceFolders(getDb(), organizationId, conversationId),
    listRecordedSourceProjects(getDb(), organizationId, conversationId),
  ])
  if (recorded.length === 0 && projects.length === 0) return new Set(userIds)
  const audience = await readConversationAudience(getDb(), organizationId, conversationId)
  const view = await recordView(organizationId, audience.projectId, recorded)
  const restricting = stillRestricting(view.tree, recorded)
  if (restricting.length === 0 && projects.length === 0) return new Set(userIds)
  const asked = [...new Set(userIds)].slice(0, READERS_MAX_PEOPLE)
  // A cross-project record (ADR-0093): only people who may open every project it names.
  const opening = await peopleWhoMayOpen(organizationId, asked, projects)
  if (restricting.length === 0) return opening
  // Each folder is judged with each person's clearance in the folder's own project.
  const clearancesByProject = new Map<string, Map<string, FolderClearance>>()
  for (const owner of ownersOf(view, restricting)) {
    const knownHere = new Map(owner === audience.projectId ? known : [])
    if (asker) knownHere.set(asker.userId, await clearanceOf(asker, owner))
    clearancesByProject.set(owner, await clearancesOf(organizationId, owner, asked, knownHere))
  }
  return new Set(
    asked.filter(
      (person) =>
        opening.has(person) &&
        mayReadEvery(view, (owner) => clearancesByProject.get(owner)?.get(person), restricting)
    )
  )
}

/** A conversation as a list knows it. */
export interface ListedConversationRef {
  id: string
  projectId: string | null
}

/**
 * The conversations of a list whose content the session may not read now: each
 * recorded a folder, still restricting someone, that the session's roles do not
 * reach. One read for the whole list, and the folder tree once per project; a
 * list in which nothing recorded a folder costs the one read. Judged at read
 * time: there is no stored "locked", so a role given back unlocks the chat.
 */
export async function lockedConversationIds(
  session: AuthorizedSession,
  conversations: readonly ListedConversationRef[]
): Promise<Set<string>> {
  const ids = conversations.map((conversation) => conversation.id)
  const [recorded, projects] = await Promise.all([
    listRecordedSourceFoldersFor(getDb(), session.organizationId, ids),
    listRecordedSourceProjectsFor(getDb(), session.organizationId, ids),
  ])
  const locked = new Set<string>()
  if (recorded.size === 0 && projects.size === 0) return locked
  const views = new Map<string | null, RecordView>()
  const opens = new Map<string, boolean>()
  // A clearance is one project's; asked once per project for the whole list.
  const clearances = new Map<string, FolderClearance>()
  for (const conversation of conversations) {
    const foreign = projects.get(conversation.id) ?? []
    if (foreign.length > 0 && !(await sessionMayOpenAll(session, foreign, opens))) {
      locked.add(conversation.id)
      continue
    }
    const folders = recorded.get(conversation.id)
    if (!folders) continue
    const view = await listView(session.organizationId, conversation.projectId, folders, views)
    const restricting = stillRestricting(view.tree, folders)
    for (const owner of ownersOf(view, restricting)) {
      if (!clearances.has(owner)) clearances.set(owner, await clearanceOf(session, owner))
    }
    if (!mayReadEvery(view, (owner) => clearances.get(owner), restricting)) locked.add(conversation.id)
  }
  return locked
}

/**
 * The view for one listed conversation's record: its project's, cached for the
 * list, unless the record names a folder of another project (ADR-0093), which
 * gets a view of its own.
 */
async function listView(
  organizationId: string,
  projectId: string | null,
  folders: readonly string[],
  views: Map<string | null, RecordView>
): Promise<RecordView> {
  const own = views.get(projectId) ?? (await recordView(organizationId, projectId, []))
  views.set(projectId, own)
  return folders.every((folderId) => own.tree.has(folderId)) ? own : recordView(organizationId, projectId, folders)
}

/** Who asks about a conversation's restricted use, and in which project. */
export interface RestrictedUseRequest {
  organizationId: string
  conversationId: string
  /** The asker, as the BFF signed it into the turn's envelope. */
  userId: string
  /** The project the turn runs in; used only when the conversation has no row yet. */
  projectId: string | null
  /**
   * The id of the answer this turn is writing, when the agent sends it. The
   * agent derives it from the conversation and the turn
   * (`aiq_agent.turn.response.answer_message_id`), the same id it streams and
   * persists, so the server can mark that answer at admission, before the
   * model reads anything (ADR-0092). Absent off the chat path.
   */
  answerMessageId?: string | null
}

/** The folder each restricted collection is the collection of, for the collections that are current ones. */
function sourceFolders(tree: FolderTree, project: ProjectRef, collections: readonly string[]): Map<string, string> {
  const access = computeFolderAccess([...tree.values()], { roles: [], seesEverything: true }, project.projectCollection)
  const found = new Map<string, string>()
  for (const collection of collections) {
    const folderId = access.sourceFolderOf(collection)
    if (folderId) found.set(collection, folderId)
  }
  return found
}

/**
 * The restricted collections among `candidates` a turn of this conversation may
 * draw on right now: current restricted collections of its project whose folder
 * the asker and everyone the conversation is shared with may read. A read;
 * nothing is recorded.
 */
export async function drawableRestrictedCollections(
  request: RestrictedUseRequest,
  candidates: readonly string[]
): Promise<string[]> {
  if (candidates.length === 0) return []
  const audience = await readConversationAudience(getDb(), request.organizationId, request.conversationId)
  const project = await projectOf(request.organizationId, audience, request.projectId)
  if (!project) return []
  const tree = await treeOf(request.organizationId, project)
  const folders = sourceFolders(tree, project, candidates)
  const people = audiencePeople(audience, request.userId)
  const clearances = await clearancesOf(request.organizationId, project.projectId, people)
  const readable = new Set(foldersEveryoneMayRead(tree, [...folders.values()], audience, people, clearances))
  return candidates.filter((collection) => readable.has(folders.get(collection) ?? ''))
}

/**
 * The restricted collections an interactive chat socket of this session may be
 * signed (the WebSocket upgrade, `collection-scope-request.ts`): the ones the
 * session may read, narrowed to those everyone the conversation is shared with
 * may read. The session's own clearance is its roles; everyone else's is
 * WorkOS's.
 */
export async function restrictedCollectionsForChatScope(
  session: AuthorizedSession,
  conversationId: string,
  project: ProjectRef,
  sessionCleared: readonly string[]
): Promise<string[]> {
  if (sessionCleared.length === 0) return []
  const audience = await readConversationAudience(getDb(), session.organizationId, conversationId)
  if (audience.exists && audience.projectId !== project.projectId) return []
  const tree = await treeOf(session.organizationId, project)
  const folders = sourceFolders(tree, project, sessionCleared)
  const people = audiencePeople(audience, session.userId)
  const clearances = await clearancesOf(
    session.organizationId,
    project.projectId,
    people,
    new Map([[session.userId, await clearanceOf(session, project.projectId)]])
  )
  const readable = new Set(foldersEveryoneMayRead(tree, [...folders.values()], audience, people, clearances))
  return sessionCleared.filter((collection) => readable.has(folders.get(collection) ?? ''))
}

export interface FolderAdmission {
  /** Recorded (or open to every member): content from these folders may enter the turn. */
  admitted: string[]
  /** Not: their content must be dropped from the turn. */
  refused: string[]
  /** Every source folder the conversation recorded after this admission that still restricts someone. */
  recorded: string[]
}

/**
 * Admit content from these source folders into a turn: record each folder the
 * asker and everyone the conversation is shared with may read, and refuse the
 * rest. A folder every project member may read needs no record and is
 * admitted; one the tree does not know is refused. Called before the content
 * enters the model's context.
 *
 * The audience is read twice. The clearances are computed outside the lock
 * (they ask WorkOS); inside it the audience is read again and anyone who was
 * not asked about counts as reading nothing restricted, so a grant committed in
 * between refuses rather than slips through. The record is written in the same
 * transaction, under the lock every widening takes.
 */
export async function admitSourceFolders(request: RestrictedUseRequest, folderIds: readonly string[]): Promise<FolderAdmission> {
  const { organizationId, conversationId } = request
  const asked = [...new Set(folderIds)].slice(0, ADMISSION_MAX_COLLECTIONS)
  const before = await readConversationAudience(getDb(), organizationId, conversationId)
  const project = await projectOf(organizationId, before, request.projectId)
  const tree: FolderTree = project ? await treeOf(organizationId, project) : new Map()
  const open = asked.filter((folderId) => tree.has(folderId) && readableByEveryMember(tree, folderId))
  const restricted = asked.filter((folderId) => tree.has(folderId) && !open.includes(folderId))
  const clearances =
    restricted.length > 0 && project
      ? await clearancesOf(organizationId, project.projectId, audiencePeople(before, request.userId))
      : new Map()
  return getDb().transaction(async (tx) => {
    await lockConversationAudience(tx, organizationId, conversationId)
    const audience = await readConversationAudience(tx, organizationId, conversationId)
    const admitted = foldersEveryoneMayRead(tree, restricted, audience, audiencePeople(audience, request.userId), clearances)
    await recordSourceFolders(tx, organizationId, conversationId, admitted)
    if (request.answerMessageId) {
      await markAnswerRestrictedUse(tx, organizationId, conversationId, request.answerMessageId)
    }
    const recorded = await listRecordedSourceFolders(tx, organizationId, conversationId)
    const kept = new Set([...open, ...admitted])
    return {
      admitted: asked.filter((folderId) => kept.has(folderId)),
      refused: asked.filter((folderId) => !kept.has(folderId)),
      // As `recordedRestrictedFolders` answers: a folder opened to everyone drops out.
      recorded: project ? stillRestricting(tree, recorded) : recorded,
    }
  })
}

export interface AdmissionResult {
  /** Admitted: content from these collections may enter the turn. */
  admitted: string[]
  /** Not: their content must be dropped from the turn. */
  refused: string[]
  /** The source folders the conversation recorded that still restrict someone. */
  recorded: string[]
}

/**
 * {@link admitSourceFolders} for the agent, which knows retrieval collections:
 * each restricted collection is admitted as its source folder. A name that is
 * not a current restricted collection of the conversation's project is refused.
 */
export async function admitRestrictedUse(
  request: RestrictedUseRequest,
  collections: readonly string[]
): Promise<AdmissionResult> {
  const asked = [...new Set(collections)].slice(0, ADMISSION_MAX_COLLECTIONS)
  const audience = await readConversationAudience(getDb(), request.organizationId, request.conversationId)
  const project = await projectOf(request.organizationId, audience, request.projectId)
  const folders = project ? sourceFolders(await treeOf(request.organizationId, project), project, asked) : new Map<string, string>()
  const admission = await admitSourceFolders(request, [...new Set(folders.values())])
  const admitted = new Set(admission.admitted)
  return {
    admitted: asked.filter((collection) => admitted.has(folders.get(collection) ?? '')),
    refused: asked.filter((collection) => !admitted.has(folders.get(collection) ?? '')),
    recorded: admission.recorded,
  }
}

/** A widening of a conversation's audience. */
export type AudienceWidening =
  /** A grant to one person; `self` when a project admin escalates to owner. */
  | { kind: 'person'; userId: string; self: boolean }
  /** A visibility wider than `private`. */
  | { kind: 'visibility' }

/** What a widening would expose to someone who may not read it. */
interface Uncovered {
  /** Recorded folders that still restrict someone and the person may not read. */
  folders: string[]
  /** Recorded other projects (ADR-0093) the person may not open; every one for a visibility widening. */
  projects: string[]
}

function isCovered(missing: Uncovered): boolean {
  return missing.folders.length === 0 && missing.projects.length === 0
}

/** The refusal, naming the folders only to a sharer who may read them, and never naming a project. */
async function wideningRefusal(
  session: AuthorizedSession,
  widening: AudienceWidening,
  missing: Uncovered,
  context: WideningContext
): Promise<ConflictError> {
  const crossProject = missing.projects.length > 0
  if (widening.kind === 'visibility') {
    return crossProject
      ? new ConflictError(
          'This conversation draws on another project and cannot be made visible to the whole project.',
          { reason: SHARING_ERROR_REASONS.crossProjectContentProject }
        )
      : new ConflictError(
          'This conversation draws on a folder with restricted access and cannot be made visible to the whole project.',
          { reason: SHARING_ERROR_REASONS.restrictedContentProject }
        )
  }
  if (widening.self) {
    return crossProject
      ? new ConflictError('You may not open every project this conversation draws on.', {
          reason: SHARING_ERROR_REASONS.crossProjectContentSelf,
        })
      : new ConflictError('You may not read every restricted folder this conversation draws on.', {
          reason: SHARING_ERROR_REASONS.restrictedContentSelf,
        })
  }
  const directory = await loadOrganizationDirectory(session.organizationId)
  const person = directory.get(widening.userId)?.name ?? null
  if (crossProject) {
    return new ConflictError('That person may not open every project this conversation draws on.', {
      reason: SHARING_ERROR_REASONS.crossProjectContent,
      ...(person ? { person } : {}),
    })
  }
  const folders = context.project ? await folderNamesReadableBy(session, context, missing.folders) : []
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
  const sharer = await clearanceOf(session, context.project.projectId)
  return folderIds
    .filter((folderId) => mayReadFolder(context.view.tree, sharer, folderId))
    .map((folderId) => names.get(folderId))
    .filter((name): name is string => Boolean(name))
}

/**
 * What of the record a widening would expose to someone who may not read it.
 * A visibility widening exposes everything: its readers cannot be enumerated.
 * A project recorded after the context was built is one the person was not
 * asked about, so it counts as not opened, and the widening is refused.
 */
function uncovered(
  widening: AudienceWidening,
  restricted: readonly string[],
  projects: readonly string[],
  context: WideningContext
): Uncovered {
  if (widening.kind === 'visibility') return { folders: [...restricted], projects: [...projects] }
  const clearances = context.personClearances
  return {
    folders: restricted.filter(
      (folderId) => !clearances || !mayReadEvery(context.view, (owner) => clearances.get(owner), [folderId])
    ),
    projects: projects.filter((projectId) => !context.personOpens.has(projectId)),
  }
}

interface WideningContext {
  project: ProjectRef | null
  view: RecordView
  /**
   * The clearance of the person being let in, in each project that owns a
   * recorded folder (a clearance is one project's); null for a visibility widening.
   */
  personClearances: ReadonlyMap<string, FolderClearance> | null
  /** The recorded other projects (ADR-0093) the person being let in may open; empty for a visibility widening. */
  personOpens: ReadonlySet<string>
}

async function wideningContext(
  session: AuthorizedSession,
  conversationId: string,
  widening: AudienceWidening
): Promise<WideningContext> {
  const { organizationId } = session
  const [audience, recorded, projects] = await Promise.all([
    readConversationAudience(getDb(), organizationId, conversationId),
    listRecordedSourceFolders(getDb(), organizationId, conversationId),
    listRecordedSourceProjects(getDb(), organizationId, conversationId),
  ])
  const project = await projectOf(organizationId, audience, null)
  const view = await recordView(organizationId, audience.projectId, recorded)
  if (widening.kind === 'visibility') return { project, view, personClearances: null, personOpens: new Set() }
  const owners = ownersOf(view, stillRestricting(view.tree, recorded))
  const clearanceIn = (owner: string) =>
    widening.self ? clearanceOf(session, owner) : clearanceOfMember(organizationId, widening.userId, owner)
  const [found, personOpens] = await Promise.all([
    Promise.all(owners.map(clearanceIn)),
    widening.self ? sessionOpens(session, projects) : peopleWhoMayOpenEach(organizationId, widening.userId, projects),
  ])
  const personClearances = new Map(owners.map((owner, index) => [owner, found[index]]))
  return { project, view, personClearances, personOpens }
}

/** The projects among `projectIds` the session may open now. */
async function sessionOpens(session: AuthorizedSession, projectIds: readonly string[]): Promise<Set<string>> {
  const opens = new Map<string, boolean>()
  for (const projectId of projectIds) await sessionMayOpenAll(session, [projectId], opens)
  return new Set(projectIds.filter((projectId) => opens.get(projectId) === true))
}

/** The projects among `projectIds` one person may open now. */
async function peopleWhoMayOpenEach(organizationId: string, userId: string, projectIds: readonly string[]): Promise<Set<string>> {
  const verdicts = await Promise.all(
    projectIds.map((projectId) => userHoldsProjectPermission({ organizationId }, projectId, userId, 'project:view'))
  )
  return new Set(projectIds.filter((_, index) => verdicts[index]))
}

/** The recorded folders that restrict someone, judged against the context's tree. */
function restrictedRecord(context: WideningContext, recorded: readonly string[]): string[] {
  return stillRestricting(context.view.tree, recorded)
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
  const { organizationId } = session
  const context = await wideningContext(session, conversationId, widening)
  const [recorded, projects] = await Promise.all([
    listRecordedSourceFolders(getDb(), organizationId, conversationId),
    listRecordedSourceProjects(getDb(), organizationId, conversationId),
  ])
  const missing = uncovered(widening, restrictedRecord(context, recorded), projects, context)
  if (!isCovered(missing)) throw await wideningRefusal(session, widening, missing, context)
}

/**
 * Widen the conversation's audience with `write`, under the lock admission
 * takes, after checking the record inside it: a person must be able to read
 * every folder the conversation recorded and open every other project it drew
 * on (ADR-0093), and a project-wide visibility needs a record that restricts
 * nobody and names no other project. `write` runs on the transaction's handle
 * and must not call `getDb()`.
 */
export async function widenConversationAudience<T>(
  session: AuthorizedSession,
  conversationId: string,
  widening: AudienceWidening,
  write: (executor: DbExecutor) => Promise<T>
): Promise<T> {
  const { organizationId } = session
  const context = await wideningContext(session, conversationId, widening)
  const refusal: { missing: Uncovered } = { missing: { folders: [], projects: [] } }
  const result = await getDb().transaction(async (tx) => {
    await lockConversationAudience(tx, organizationId, conversationId)
    const recorded = restrictedRecord(context, await listRecordedSourceFolders(tx, organizationId, conversationId))
    const projects = await listRecordedSourceProjects(tx, organizationId, conversationId)
    refusal.missing = uncovered(widening, recorded, projects, context)
    if (!isCovered(refusal.missing)) return null
    return { value: await write(tx) }
  })
  if (result === null) throw await wideningRefusal(session, widening, refusal.missing, context)
  return result.value
}
