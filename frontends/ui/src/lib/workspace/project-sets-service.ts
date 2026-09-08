/**
 * Sammlungen — a named, reusable set of projects, and the one place their
 * permissions are decided (ADR-0054, spec GR-2).
 *
 * A Bezirk, a client, a year. The set exists so that "vergleiche die
 * Brandschutzkonzepte der Bezirk-3-Projekte" is one gesture instead of five,
 * and GR-2 demands that it be "one table and no new mechanism": mounting a
 * Sammlung writes the SAME `conversation_mounts` rows a person's five clicks
 * would have written, through `mounts-service`, with the same per-project
 * permission and the same cap. Nothing here mounts anything; the mount half
 * lives beside the mount rules, where the cap already is.
 *
 * ## Who may do what, and why it is not one permission
 *
 * A Sammlung is a LABEL over projects, not access to them. Naming five projects
 * grants nobody anything — the mount still asks `project:chat` per project, and
 * reading the set still asks `project:view` per project — so the right to
 * create one is the ordinary right to use the Büro at all:
 *
 *   - **`org:chat`** to see the Sammlungen and to create one. Every member
 *     holds it by default; withholding it is how an organization keeps chat
 *     inside projects, and somebody who may not open the Büro has no use for a
 *     set of projects to open it with.
 *   - **its creator, or `org:projects:administer`**, to rename, re-describe,
 *     add to, remove from or delete one. Personal shorthand should not need an
 *     administrator, and the office's shared vocabulary should not be editable
 *     by whoever happens to open it. The administrator half is a PERMISSION,
 *     never the role slug `admin` (ADR-0038).
 *   - **`project:view` on the project**, to put it in a set at all. Otherwise
 *     the set would be a way to publish a project's NAME to people who may not
 *     see the project — the leak spec AC-3/AC-4 close for the register, arriving
 *     through a different door.
 *
 * ## Readability is computed per caller, never stored
 *
 * A set's membership is one fact; what a given member may see of it is not.
 * Every read here therefore runs the membership through
 * {@link filterReadableProjects} — the SAME per-project check the projects grid
 * and the register recall use — so the Sammlung cannot name a project the grid
 * hides. A member of a firm-wide "Bezirk 3" sees the three projects they are on,
 * and learns nothing about the other seven: not their names, not their ids, not
 * that they exist. `projectCount` is the READABLE count for the same reason —
 * it is the number the Büro will actually mount, so a UI that measures it
 * against the cap is measuring the right thing.
 */

import 'server-only'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { filterReadableProjects, requireProjectAccess } from '@/lib/authz/projects'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  deleteProjectSetMembers,
  deleteProjectSetRow,
  findProjectSetInOrg,
  insertProjectSet,
  insertProjectSetMembers,
  listMembersOfProjectSets,
  listProjectSetMembers,
  listProjectSetsInOrg,
  updateProjectSetRow,
  type ProjectSetMemberRow,
  type ProjectSetRow,
} from './project-sets-repository'

/**
 * The longest name a Sammlung may carry.
 *
 * It is a label in a tree and a noun in a refusal sentence ("Bezirk 3 hat mehr
 * Projekte als …"), and both stop working long before this. The database
 * enforces only that it is not blank; length is a product judgement, so it is
 * here.
 */
export const PROJECT_SET_NAME_MAX = 120

/** The longest description. One line of context, not a project brief. */
export const PROJECT_SET_DESCRIPTION_MAX = 500

/** How many projects one call may add to or remove from a Sammlung. */
export const PROJECT_SET_BATCH_MAX = 100

/** One Sammlung as the wire carries it, with the caller's own view of its size. */
export interface ProjectSetSummary {
  id: string
  name: string
  description: string | null
  createdBy: string
  /** ISO-8601 instants. */
  createdAt: string
  updatedAt: string
  /**
   * How many of its projects THIS caller may read — which is how many the Büro
   * would mount, so the number a UI measures against the cap.
   */
  projectCount: number
  /** Whether this caller may rename, edit or delete it. */
  editable: boolean
}

/** One Sammlung with the members this caller may see. */
export interface ProjectSetDetail extends ProjectSetSummary {
  projects: Array<{ id: string; name: string }>
}

/**
 * Sammlungen of the organization, each measured by what this caller may read.
 *
 * One member query for the whole page and one readability pass over the
 * DISTINCT projects in it, rather than a pass per set: a member on three
 * projects who is looking at eight Sammlungen should not pay eight times for
 * the same three answers.
 */
export async function listProjectSets(session: AuthorizedSession): Promise<ProjectSetSummary[]> {
  requireWorkspaceChat(session)
  const sets = await listProjectSetsInOrg(session.organizationId)
  if (sets.length === 0) return []

  const members = await listMembersOfProjectSets(
    sets.map((set) => set.id),
    session.organizationId
  )
  const readable = await readableProjectIds(session, members)

  return sets.map((set) => ({
    ...toSummary(session, set),
    projectCount: members.filter(
      (member) => member.setId === set.id && readable.has(member.projectId)
    ).length,
  }))
}

/** One Sammlung and the projects this caller may see in it. */
export async function getProjectSet(
  session: AuthorizedSession,
  setId: string
): Promise<ProjectSetDetail> {
  requireWorkspaceChat(session)
  const set = await requireSet(session, setId)
  return withReadableMembers(session, set)
}

export interface CreateProjectSetInput {
  name: string
  description?: string | null
}

/**
 * Create a Sammlung. Any member who may use the Büro may name one.
 *
 * The unique violation is caught rather than pre-checked: "does this name
 * exist?" followed by an insert is two statements two people can interleave,
 * and `uniq_project_sets_org_name` is what actually decides. Same shape as the
 * project folders' get-or-create (`lib/projects/folder-service.ts`).
 */
export async function createProjectSet(
  session: AuthorizedSession,
  input: CreateProjectSetInput
): Promise<ProjectSetDetail> {
  requireWorkspaceChat(session)
  const name = requireName(input.name)
  const description = normalizeDescription(input.description)

  try {
    const set = await insertProjectSet({
      organizationId: session.organizationId,
      name,
      description,
      createdBy: session.userId,
    })
    return { ...toSummary(session, set), projectCount: 0, projects: [] }
  } catch (error) {
    throw asNameConflict(error, name)
  }
}

export interface UpdateProjectSetInput {
  name?: string
  description?: string | null
}

/** Rename or re-describe a Sammlung. Its creator, or an org project admin. */
export async function updateProjectSet(
  session: AuthorizedSession,
  setId: string,
  input: UpdateProjectSetInput
): Promise<ProjectSetDetail> {
  requireWorkspaceChat(session)
  const existing = await requireSet(session, setId)
  requireSetEditor(session, existing)

  const name = input.name === undefined ? undefined : requireName(input.name)
  const description =
    input.description === undefined ? undefined : normalizeDescription(input.description)
  if (name === undefined && description === undefined) {
    throw new BadRequestError('Nothing to update: name or description is required')
  }

  let updated: ProjectSetRow | null
  try {
    updated = await updateProjectSetRow(setId, session.organizationId, { name, description })
  } catch (error) {
    throw asNameConflict(error, name ?? existing.name)
  }
  // Gone between the read and the write. The caller established that it existed
  // and that they may edit it, so this is a concurrent delete rather than an
  // authorization answer — and "it is not there" is the honest one.
  if (!updated) throw new NotFoundError()

  return withReadableMembers(session, updated)
}

/**
 * Put projects into a Sammlung — all of them, or none.
 *
 * Every id is checked for `project:view` FIRST and the whole call is refused if
 * any fails, rather than adding what the caller may see and dropping the rest.
 * A half-applied add is the worst of the three outcomes: the caller believes the
 * set holds seven projects, it holds five, and the two disagree silently on
 * every mount from then on.
 *
 * The refusal is a `NotFoundError` and names nothing (spec MT-4's reasoning): a
 * caller may not learn, by adding ids to their own Sammlung, which project ids
 * this organization holds.
 *
 * Idempotent: a project already in the set is not an error and writes nothing.
 */
export async function addProjectsToSet(
  session: AuthorizedSession,
  setId: string,
  projectIds: readonly string[]
): Promise<ProjectSetDetail> {
  requireWorkspaceChat(session)
  const set = await requireSet(session, setId)
  requireSetEditor(session, set)
  const wanted = requireProjectIdBatch(projectIds)

  // Concurrent, and every one of them must say yes. `requireProjectAccess`
  // checks tenancy and soft-deletion before it asks FGA anything, so a project
  // from another organization is refused here and not merely by the composite
  // foreign key underneath.
  await Promise.all(
    wanted.map((projectId) => requireProjectAccess(session, projectId, 'project:view'))
  )

  await insertProjectSetMembers(setId, session.organizationId, wanted)
  return withReadableMembers(session, set)
}

/**
 * Take projects out of a Sammlung.
 *
 * No per-project permission, deliberately, for the reason unmounting needs
 * none: narrowing a set is editing the LABEL, not reaching the project. A
 * member who has since lost `project:view` on something in their own set must
 * still be able to take it out.
 *
 * Idempotent, and says nothing about whether a membership was there — the
 * caller asked for "this set no longer names those projects", which is true
 * either way, so the endpoint is no oracle for guessed project ids.
 */
export async function removeProjectsFromSet(
  session: AuthorizedSession,
  setId: string,
  projectIds: readonly string[]
): Promise<ProjectSetDetail> {
  requireWorkspaceChat(session)
  const set = await requireSet(session, setId)
  requireSetEditor(session, set)
  const wanted = requireProjectIdBatch(projectIds)

  await deleteProjectSetMembers(setId, session.organizationId, wanted)
  return withReadableMembers(session, set)
}

/**
 * Delete a Sammlung.
 *
 * Its memberships go by cascade and NOTHING ELSE MOVES: a conversation that
 * mounted this set holds ordinary mount rows, which are a property of the
 * conversation from the moment they are written (spec MT-14). Deleting the name
 * a person mounted through must not change what a thread reads, any more than
 * deleting a bookmark closes the page.
 */
export async function deleteProjectSet(session: AuthorizedSession, setId: string): Promise<void> {
  requireWorkspaceChat(session)
  const set = await requireSet(session, setId)
  requireSetEditor(session, set)
  await deleteProjectSetRow(setId, session.organizationId)
}

/**
 * The membership of a Sammlung, for the mount path (`./mounts-service`).
 *
 * Deliberately UNFILTERED: the mount has to distinguish three answers per
 * project — mountable, visible-but-not-chattable, invisible — and it makes that
 * distinction with the same `authorizeMountableProject` a single mount uses.
 * Filtering here first would collapse two of the three and cost the caller the
 * reason.
 *
 * `org:chat` is checked, and the set is resolved inside the caller's
 * organization; everything below that is the mount's decision to make.
 */
export async function projectSetForMount(
  session: AuthorizedSession,
  setId: string
): Promise<{ set: ProjectSetRow; members: ProjectSetMemberRow[] }> {
  requireWorkspaceChat(session)
  const set = await requireSet(session, setId)
  const members = await listProjectSetMembers(setId, session.organizationId)
  return { set, members }
}

/**
 * Chatting at the ORGANISATION level, as a permission rather than as a shape —
 * the same gate `lib/conversations/service.ts` puts in front of a Büro
 * conversation, applied to the vocabulary that conversation addresses projects
 * with (spec AC-1, AC-2).
 *
 * `ForbiddenError`, not `NotFoundError`: nothing about a Sammlung's existence
 * is leaked by refusing the whole surface to somebody who may not use the Büro
 * at all.
 */
function requireWorkspaceChat(session: AuthorizedSession): void {
  if (hasPermission(session, ORG_PERMISSIONS.chat)) return
  throw new ForbiddenError('Missing permission: org:chat')
}

/** Whether this session may change this Sammlung — its creator, or an org project admin. */
function canEditSet(session: AuthorizedSession, set: ProjectSetRow): boolean {
  return (
    set.createdBy === session.userId || hasPermission(session, ORG_PERMISSIONS.projectsAdminister)
  )
}

/**
 * `ForbiddenError`, not `NotFoundError`, and that is the deliberate exception
 * to the "a refusal reveals nothing" rule: the caller can already SEE this
 * Sammlung — every member of the organization can — so a 404 here would be a
 * lie that costs them the reason. The same judgement `mounts-service` makes for
 * a project the caller may view but not chat in.
 */
function requireSetEditor(session: AuthorizedSession, set: ProjectSetRow): void {
  if (canEditSet(session, set)) return
  throw new ForbiddenError(
    'Only the person who created this Sammlung, or an organization project administrator, may change it'
  )
}

async function requireSet(session: AuthorizedSession, setId: string): Promise<ProjectSetRow> {
  const set = await findProjectSetInOrg(setId, session.organizationId)
  if (!set) throw new NotFoundError()
  return set
}

/** Everything about a Sammlung that does not depend on who is asking about it. */
function toSummary(
  session: AuthorizedSession,
  set: ProjectSetRow
): Omit<ProjectSetSummary, 'projectCount'> {
  return {
    id: set.id,
    name: set.name,
    description: set.description,
    createdBy: set.createdBy,
    createdAt: set.createdAt.toISOString(),
    updatedAt: set.updatedAt.toISOString(),
    editable: canEditSet(session, set),
  }
}

/** One set, plus the members this caller may read — the shape every write answers with. */
async function withReadableMembers(
  session: AuthorizedSession,
  set: ProjectSetRow
): Promise<ProjectSetDetail> {
  const members = await listProjectSetMembers(set.id, session.organizationId)
  const readable = await readableProjectIds(session, members)
  const projects = members
    .filter((member) => readable.has(member.projectId))
    .map((member) => ({ id: member.projectId, name: member.projectName }))
  return { ...toSummary(session, set), projectCount: projects.length, projects }
}

/**
 * The distinct projects among these memberships that this caller may view.
 *
 * Tenancy is already established — the membership rows come from a
 * tenant-scoped query INNER JOINed to `projects` — which is what
 * `filterReadableProjects` requires of its callers, and what makes it safe to
 * ask it about ids rather than about rows.
 */
async function readableProjectIds(
  session: AuthorizedSession,
  members: readonly ProjectSetMemberRow[]
): Promise<Set<string>> {
  const distinct = [...new Set(members.map((member) => member.projectId))]
  const readable = await filterReadableProjects(
    session,
    distinct.map((id) => ({ id }))
  )
  return new Set(readable.map((project) => project.id))
}

function requireName(raw: string): string {
  const name = raw.trim()
  if (!name) throw new BadRequestError('A Sammlung needs a name')
  if (name.length > PROJECT_SET_NAME_MAX) {
    throw new BadRequestError(`A Sammlung's name may be at most ${PROJECT_SET_NAME_MAX} characters`)
  }
  return name
}

function normalizeDescription(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const description = raw.trim()
  if (!description) return null
  if (description.length > PROJECT_SET_DESCRIPTION_MAX) {
    throw new BadRequestError(
      `A Sammlung's description may be at most ${PROJECT_SET_DESCRIPTION_MAX} characters`
    )
  }
  return description
}

/** The ids of one add/remove call, de-duplicated and bounded. */
function requireProjectIdBatch(projectIds: readonly string[]): string[] {
  const wanted = [...new Set(projectIds)]
  if (wanted.length === 0) throw new BadRequestError('Name at least one project')
  if (wanted.length > PROJECT_SET_BATCH_MAX) {
    throw new BadRequestError(`At most ${PROJECT_SET_BATCH_MAX} projects in one call`)
  }
  return wanted
}

/**
 * The unique-name violation, as the conflict a person can act on.
 *
 * `23505` is Postgres' unique violation; anything else is rethrown untouched,
 * because a repository error nobody recognised must not be reported as "that
 * name is taken".
 */
function asNameConflict(error: unknown, name: string): unknown {
  if (!isUniqueViolation(error)) return error
  return new ConflictError(`A Sammlung named “${name}” already exists in this organization`)
}

/**
 * Whether this is Postgres' unique violation — walking `.cause`, because
 * drizzle wraps every driver failure in a `DrizzleQueryError` whose own `code`
 * is undefined. Reading only the top level is how a conflict arrives at a user
 * as an opaque 500, for an action that is neither a bug nor a race.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: string }).code === '23505') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}
