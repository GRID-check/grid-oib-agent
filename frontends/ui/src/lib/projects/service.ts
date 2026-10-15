/**
 * Projects service — business logic for the projects domain.
 *
 * Owns authorization (org tenancy + per-project FGA), orchestration across
 * the repository, WorkOS, and the audit trail. Route handlers stay thin:
 * they validate input shape and delegate here. Failures are signalled with
 * typed errors from `@/lib/api/errors`.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import { requireProjectAccess, type ProjectPermission } from '@/lib/authz/projects'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { checkResourcePermission } from '@/lib/authz/resource-check'
import { recordAuditEvent } from '@/lib/audit/service'
import { neutralizeCollaborationForProject } from '@/lib/collaboration/cleanup'
import {
  lastProjectActivityByUser,
  listConversationIdsForProject,
} from '@/lib/conversations/repository'
import { countDocumentsByProject } from '@/lib/documents/repository'
import { computePurgeAfter, projectGraceDays } from '@/lib/deletion/policy'
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type {
  Project,
  ProjectMemoryConfidence,
  ProjectMemoryItem,
  ProjectMemoryKind,
} from '@/lib/db/schema'
import { getProjectOverviewData, type ProjectOverviewReader } from './overview-query'
import {
  abschlussProblem,
  canTransition,
  isProjectClosed,
  keptWhenClosed,
  openToOrganizationWhenClosed,
  type ProjectOutcome,
} from './project-status'
import { currentMonth, dateToMonth, isMonth, monthToDate, type Month } from './month'
import type { ProjectSetup } from './create-project-schema'
import { startProjectIntake } from './intake-seed'
import type { GeocodeResult } from '@/lib/geocoding/types'
import { rearmOneShotsSkippedWhileParked } from '@/lib/tasks/repository'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { memberReader } from '@/lib/documents/visibility'
import { withServedEvidence } from './memory-evidence'
import { syncProjectFacts } from '@/lib/cross-project/project-facts-mirror'
import {
  clearanceOf,
  customFolderNames,
  getHiddenFolderIds,
  purgedFolderDates,
  readableFolderIdsFor,
} from '@/lib/authz/folder-access'
import {
  createProjectMemoryItem,
  deleteProjectMemoryItem,
  listProjectMemory,
  updateProjectMemoryItem,
  type CreateMemoryOptions,
} from './memory-service'
import {
  deleteProjectRow,
  findProjectCollectionName,
  findProjectInOrg,
  insertProject,
  listProjectsInOrg,
  renameProjectInOrg,
  restoreProjectIfPending,
  setProjectStatusInOrg,
  setProjectWorkosResourceId,
  softDeleteProjectAndEnqueue,
  type ProjectStatusWrite,
} from './repository'

/**
 * Projects the caller can actually reach, not merely the ones their tenant owns.
 *
 * The listing used to return every non-deleted project in the organization while
 * `getProject` gated on per-project FGA — so the detail view was protected and
 * the list that fed it was not. Any member enumerated every project name and id
 * in the tenant, which is exactly the distinction `project-viewer` /
 * `project-editor` / `project-admin` exist to draw (ADR-0038).
 *
 * Callers holding `org:projects:administer` keep seeing everything (the same
 * named bypass `requireProjectAccess` applies), and the checks run concurrently so the page costs one round of
 * parallel FGA calls rather than a serial walk. Each check **fails closed**
 * independently: a project whose check errors is omitted rather than shown.
 */
export async function listProjects(
  session: AuthorizedSession,
  order: 'newest' | 'oldest' = 'newest'
): Promise<Project[]> {
  return listProjectsHolding(session, ['project:view'], order)
}

/**
 * The projects the caller may CHAT in: the reach of the cross-project lookups
 * (ADR-0094). Pointing the agent at a project's corpus is chatting in it, which
 * the turn scope gates on `project:chat` (or the legacy `project:edit`) and not
 * on `project:view` (`collection-scope-request.ts`): a reader gets a project's
 * documents through the documents API, not the agent. Same bypass, same
 * fail-closed checks as {@link listProjects}.
 */
export async function listChatProjects(
  session: AuthorizedSession,
  order: 'newest' | 'oldest' = 'newest'
): Promise<Project[]> {
  return listProjectsHolding(session, CHAT_PERMISSIONS, order)
}

/** The organization's projects on which the caller holds ANY of `permissions`; see {@link listProjects}. */
async function listProjectsHolding(
  session: AuthorizedSession,
  permissions: readonly ProjectPermission[],
  order: 'newest' | 'oldest'
): Promise<Project[]> {
  const projects = await listProjectsInOrg(session.organizationId, { order })
  return projectsHolding(session, projects, permissions)
}

/**
 * Of `projects`, the ones on which the caller holds ANY of `permissions`; the
 * filter {@link listProjects} applies, for a caller that already has its
 * candidates (the same-address lookup asks about its few matches, not all of
 * them).
 */
export async function projectsHolding<T extends Pick<Project, 'id' | 'status'>>(
  session: AuthorizedSession,
  projects: readonly T[],
  permissions: readonly ProjectPermission[] = ['project:view']
): Promise<T[]> {
  // The same permission-gated bypass `requireProjectAccess` applies, checked the
  // same way — if these two ever disagreed the grid would list projects the
  // detail view then refuses, or hide ones it would have opened.
  if (hasPermission(session, ORG_PERMISSIONS.projectsAdminister)) return [...projects]

  const holds = async (project: T): Promise<boolean> => {
    // A closed project (ADR-0090), decided as `requireProjectAccess` decides it:
    // only what a closed project still allows is asked, and what is open to the
    // whole organization (reading, chatting) every member holds.
    const closed = isProjectClosed(project)
    const asked = closed ? keptWhenClosed(permissions) : permissions
    if (asked.length === 0) return false
    if (closed && openToOrganizationWhenClosed(asked)) return true
    for (const permissionSlug of asked) {
      const allowed = await checkResourcePermission({
        organizationMembershipId: session.organizationMembershipId,
        organizationId: session.organizationId,
        permissionSlug,
        resourceExternalId: project.id,
        resourceTypeSlug: 'project',
      })
      if (allowed) return true
    }
    return false
  }
  const held = await Promise.all(projects.map(holds))
  return projects.filter((_, index) => held[index])
}

/**
 * Everything the projects grid renders: the reachable projects, their document
 * counts, and when the caller themselves last worked in each of them.
 *
 * Exists so the page has a service call for its whole view instead of a reason
 * to open the database itself. The page previously ran its own
 * `select().from(projects)` filtered only by organization, which bypassed the
 * FGA filtering in {@link listProjects} and put every project in the tenant on
 * screen for every member — the precise regression ADR-0038 closed. Counting is
 * derived from the filtered list for the same reason.
 *
 * `viewerActivity` is per-CALLER by construction (see
 * {@link lastProjectActivityByUser}) and asked only for projects that survived
 * the FGA filter, so it can neither leak another member's working pattern nor
 * name a project the caller cannot open. Both derived reads run against the
 * filtered list, concurrently — they do not depend on each other.
 */
export async function getProjectsGridData(
  session: AuthorizedSession,
  order: 'newest' | 'oldest' = 'newest'
): Promise<{
  projects: Project[]
  documentCounts: Record<string, number>
  /** ISO timestamp of the caller's own last activity, keyed by project id. */
  viewerActivity: Record<string, string>
}> {
  const visible = await listProjects(session, order)
  const visibleIds = visible.map((project) => project.id)
  // A card's number counts what the project's own list shows this viewer, so
  // the documents in folders they may not read are left out of it (ADR-0088).
  const hiddenFolderIds = (await Promise.all(visibleIds.map((id) => getHiddenFolderIds(session, id)))).flat()
  // Nor does it count a held file the viewer neither uploaded nor reviews
  // (ADR-0086); each project asks its own reviewers.
  const readers = await Promise.all(visibleIds.map((projectId) => shelfReaderFor(session, { scope: 'project', projectId })))
  const reviewedProjectIds = visibleIds.filter((_, index) => readers[index].kind === 'reviewer')
  const [documentCounts, viewerActivity] = await Promise.all([
    countDocumentsByProject(session.organizationId, visibleIds, hiddenFolderIds, {
      kind: 'projects',
      userId: session.userId,
      reviewedProjectIds,
    }),
    lastProjectActivityByUser(session.organizationId, session.userId, visibleIds),
  ])
  return { projects: visible, documentCounts, viewerActivity }
}

/**
 * How a past project created as closed ended (ADR-0098): the same outcome and
 * Abschluss a close names, plus the Beginn, which a new row has not got yet.
 */
export interface ProjectClosing {
  outcome: ProjectOutcome
  endedOn: Month
  startedOn: Month | null
}

/**
 * `setup` says how a new project is set up. `piloti`: Piloti reads the
 * documents and the person reviews (ADR-0111); the project gets its
 * `project_intakes` row. `self`: no intake, the wizard fills the profile.
 */
export interface CreateProjectInput {
  name: string
  closing?: ProjectClosing
  /** Absent means `self`: the person-facing callers (the route, the form's action) default to `piloti`. */
  setup?: ProjectSetup
  /** „Worum geht es?", at most 500 characters. Kept with the intake. */
  description?: string
  /** The address search's hit. Seeds the profile (address, country, Bundesland). */
  location?: GeocodeResult
  /** A Bundesland token chosen by hand when no geocoder is configured. */
  bundesland?: string
}

/**
 * Create a project, register it as a WorkOS FGA resource, and make the
 * creator its project-admin. With `closing`, the project is a past one added
 * as the office's reference (ADR-0098): it is created and then closed at once,
 * with the outcome, Beginn and Abschluss given here.
 *
 * ## Why the compensating delete
 *
 * Four steps across two systems that share no transaction: insert the row,
 * create the FGA resource, store its id, grant the creator `project-admin`. A
 * failure after the first one used to leave a project row with no FGA resource
 * and no admin — which, because per-project access is FGA, is a project its own
 * creator cannot open. The only way back in was the org-wide bypass, and there
 * is no repair path in the product, so the project was simply lost while still
 * counting against the tenant.
 *
 * Postgres is the side that can be undone cleanly, so it is: on any failure the
 * row is removed and the caller sees the error. A leaked WorkOS resource with no
 * row pointing at it is inert (nothing resolves it, and project ids are UUIDs so
 * it can never be re-hit), which makes it the right thing to leak of the two.
 *
 * ## Creating a closed project
 *
 * The Abschluss is checked before anything is written, against the same
 * bounds a close uses. The close itself is the repository write, not
 * {@link setProjectStatus}: that one asks FGA for `project:manage`, and the
 * grant made a moment ago may not have reached the check yet. The creator is
 * the one who may close it by construction. A close that fails is undone like
 * a failed WorkOS step, so no half-created active project is left behind. It
 * skips the debrief and the clear-out of an ordinary close: a project created
 * this second has no memory and no files to review.
 *
 * ## Piloti sets it up
 *
 * With `setup: 'piloti'` the project gets its intake row, status
 * `waiting`, and the profile facts the chosen address decides, in one write
 * after the FGA steps and inside the same compensating delete (the intake row
 * cascades with the project). A closing given with it is NOT carried out: the
 * project stays active while its documents are read and is closed when the
 * person finishes the review, so the intake keeps the closing as an intent.
 * Without it this is the function it always was.
 */
export async function createProject(
  session: AuthorizedSession,
  input: CreateProjectInput,
  // Optional because the projects-page server action has no `Request` to pass.
  // `recordAuditEvent` already treats it as optional (it only enriches the event
  // context with IP + user agent), so requiring it here was the sole reason that
  // action re-implemented this whole function instead of calling it.
  request?: Request,
  now: Date = new Date()
): Promise<Project> {
  const closing = input.closing ? closingOrRefuse(input.closing, currentMonth(now)) : undefined
  const piloti = input.setup === 'piloti'
  // A closing Piloti sets up is carried out when the review is finished.
  const closeNow = closing && !piloti ? closing : undefined
  const workos = getWorkOS()

  const inserted = await insertProject({
    organizationId: session.organizationId,
    name: input.name,
    createdBy: session.userId,
    collectionName: `proj_${crypto.randomUUID()}`,
    // The Beginn is the person's answer, whoever sets the project up: closing it
    // waits for the review, the month it began does not.
    ...(closing?.startedOn ? { startedOn: monthToDate(closing.startedOn) } : {}),
  })

  let project = inserted
  try {
    const resource = await workos.authorization.createResource({
      resourceTypeSlug: 'project',
      externalId: inserted.id,
      organizationId: session.organizationId,
      name: input.name,
    })

    await setProjectWorkosResourceId(inserted.id, session.organizationId, resource.id)

    await workos.authorization.assignRole({
      organizationMembershipId: session.organizationMembershipId,
      resourceExternalId: inserted.id,
      resourceTypeSlug: 'project',
      roleSlug: 'project-admin',
    })

    if (piloti) {
      await startProjectIntake(
        session,
        inserted,
        {
          description: input.description,
          location: input.location,
          bundesland: input.bundesland,
          closing: closing && { outcome: closing.outcome, startedOn: closing.startedOn, endedOn: closing.endedOn },
        },
        now
      )
    }
    if (closeNow) project = await closeNewProject(session, inserted.id, closeNow, now)
  } catch (error) {
    // Best-effort undo. If even this fails the row survives unreachable, which is
    // the state we are trying to avoid — so say so loudly rather than swallow it.
    await deleteProjectRow(inserted.id, session.organizationId).catch((cleanupError) => {
      console.error(
        `[projects] project ${inserted.id} was created half-way and could not be rolled back:`,
        cleanupError
      )
    })
    throw error
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.created',
    targetType: 'project',
    targetId: project.id,
    metadata: piloti ? { name: input.name, setup: 'piloti' } : { name: input.name },
    request,
  })
  if (closeNow) {
    await recordAuditEvent({
      organizationId: session.organizationId,
      actor: { userId: session.userId, email: session.email },
      action: 'project.closed',
      targetType: 'project',
      targetId: project.id,
      metadata: { name: project.name, from: 'active', outcome: closeNow.outcome, endedOn: closeNow.endedOn },
      request,
    })
  }

  return project
}

/** The closing of a project being created, or a 400: months, and an Abschluss within `abschlussBounds`. */
function closingOrRefuse(closing: ProjectClosing, thisMonth: Month): ProjectClosing {
  if (closing.startedOn !== null && !isMonth(closing.startedOn)) {
    throw new BadRequestError('The Beginn must be a month, YYYY-MM.', { reason: 'invalid-month' })
  }
  abschlussOrRefuse(closing.endedOn, closing.startedOn, thisMonth)
  return closing
}

/** Close the row just created and granted; throws when the write changed nothing, so the caller rolls back. */
async function closeNewProject(
  session: AuthorizedSession,
  projectId: string,
  closing: ProjectClosing,
  now: Date
): Promise<Project> {
  const closed = await setProjectStatusInOrg(projectId, session.organizationId, 'active', {
    status: 'closed',
    at: now,
    closedBy: session.userId,
    outcome: closing.outcome,
    endedOn: monthToDate(closing.endedOn),
  })
  if (!closed) throw new Error('The project was created but could not be closed, so it was not kept.')
  return closed
}

export async function getProject(session: AuthorizedSession, projectId: string): Promise<Project> {
  await requireProjectAccess(session, projectId, 'project:view')
  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError()
  return project
}

export async function updateProjectName(
  session: AuthorizedSession,
  projectId: string,
  name: string
): Promise<Project> {
  await requireProjectAccess(session, projectId, 'project:manage')
  const project = await renameProjectInOrg(projectId, session.organizationId, name)
  if (!project) throw new NotFoundError()
  return project
}

/**
 * Soft-delete a project (name confirmation required) and enqueue the purge.
 * Returns the purge deadline for the 202 response.
 */
export async function deleteProject(
  session: AuthorizedSession,
  projectId: string,
  confirmName: string,
  request: Request
): Promise<{ purgeAfter: Date }> {
  // A closed project can still be deleted (ADR-0090): deletion is the GDPR
  // path, and it is soft, with its grace period, exactly as for an active one.
  await requireProjectAccess(session, projectId, 'project:manage', { evenWhenClosed: true })

  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError()
  if (confirmName !== project.name) {
    throw new BadRequestError('Project name does not match.')
  }

  const purgeAfter = computePurgeAfter(new Date(), projectGraceDays())
  await softDeleteProjectAndEnqueue(project, session.userId, purgeAfter)

  // Every conversation in the project just became unreachable, so collaboration
  // state that assumes someone can READ those threads must be settled: open
  // mention requests are voided (nobody can answer a thread they cannot open, and
  // the hand-off banner would otherwise wait forever) and inbox items go inert
  // with their payloads wiped, so a quoted snippet cannot outlive access to the
  // thread it came from.
  //
  // Grants are deliberately KEPT: a soft delete may be restored during the grace
  // period, and the project should come back with its threads shared exactly as
  // they were (spec SH-13). Best-effort — a deletion must not fail on bookkeeping.
  try {
    const conversationIds = await listConversationIdsForProject(projectId, session.organizationId)
    await neutralizeCollaborationForProject(session.organizationId, projectId, conversationIds)
  } catch (error) {
    console.warn('[projects] collaboration neutralization on project delete failed:', error)
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.deleted',
    targetType: 'project',
    targetId: projectId,
    metadata: { name: project.name, purgeAfter: purgeAfter.toISOString() },
    request,
  })

  return { purgeAfter }
}

/** A move of the lifecycle as a caller asks for it (ADR-0098). Closing names how and when it ended. */
export type ProjectStatusChange =
  | { status: 'active' }
  | { status: 'paused' }
  | { status: 'closed'; outcome: ProjectOutcome; endedOn: Month }

/**
 * Move a project through its lifecycle (ADR-0098): pause, resume, close,
 * reopen. `project:manage`, asked as if the project were active: it is the one
 * write a closed project allows. Closing deletes and purges nothing; it makes
 * the project read-only and opens it to every member of the organization for
 * reading, with every folder that has its own role list as restricted as before
 * (ADR-0090). It names the outcome and the Abschluss month, which may not lie
 * in the future or before the Beginn.
 *
 * A move the lifecycle does not have (pausing a closed project, closing a
 * closed one) is a 409 `invalid-transition`; so is a move that lost a race, so
 * a double click writes one event. Every move is audited under its own name.
 */
export async function setProjectStatus(
  session: AuthorizedSession,
  projectId: string,
  change: ProjectStatusChange,
  request?: Request,
  now: Date = new Date()
): Promise<Project> {
  await requireProjectAccess(session, projectId, 'project:manage', { evenWhenClosed: true })
  const current = await findProjectInOrg(projectId, session.organizationId)
  if (!current) throw new NotFoundError()
  const from = current.status
  if (!canTransition(from, change.status)) {
    throw new ConflictError(`A ${from} project cannot become ${change.status}.`, {
      reason: 'invalid-transition',
      from,
      to: change.status,
    })
  }

  const write: ProjectStatusWrite =
    change.status === 'closed'
      ? {
          status: 'closed',
          at: now,
          closedBy: session.userId,
          outcome: change.outcome,
          endedOn: monthToDate(abschlussOrRefuse(change.endedOn, dateToMonth(current.startedOn), currentMonth(now))),
        }
      : change.status === 'paused'
        ? { status: 'paused', at: now }
        : { status: 'active' }
  const project = await setProjectStatusInOrg(projectId, session.organizationId, from, write)
  if (!project) {
    throw new ConflictError('The project changed meanwhile.', { reason: 'invalid-transition', from, to: change.status })
  }
  if (change.status === 'active') await rearmParkedOneShots(projectId, session.organizationId)
  // The status is on every chunk of the project, for the cross-project search's
  // filters (design §7). Never throws; the weekly sync repairs a failed copy.
  await syncProjectFacts(session.organizationId, projectId)

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    // Each move under the name a person would give it. Literals at the call
    // site, so the audit registry's coverage scan (`schemas.spec.ts`) sees them.
    action:
      change.status === 'closed'
        ? 'project.closed'
        : change.status === 'paused'
          ? 'project.paused'
          : from === 'closed'
            ? 'project.reopened'
            : 'project.resumed',
    targetType: 'project',
    targetId: projectId,
    metadata:
      change.status === 'closed'
        ? { name: project.name, from, outcome: change.outcome, endedOn: change.endedOn }
        : { name: project.name, from },
    request,
  })
  return project
}

/**
 * The dated one-shots a pause or close retired, due again now that the project
 * runs (ADR-0098). After the move has committed, so a failure here is logged,
 * not turned into an error for a move that happened.
 */
async function rearmParkedOneShots(projectId: string, organizationId: string): Promise<void> {
  try {
    await rearmOneShotsSkippedWhileParked(projectId, organizationId)
  } catch (error) {
    console.error('[projects] re-arming one-shots skipped while the project was not active failed:', error)
  }
}

/** The Abschluss a close names, or a 400: a month within `abschlussBounds`, so not after this month unless the Beginn is, and never before the Beginn. */
function abschlussOrRefuse(endedOn: Month, startedOn: Month | null, thisMonth: Month): Month {
  const problem = abschlussProblem(endedOn, startedOn, thisMonth)
  if (problem === 'invalid') {
    throw new BadRequestError('The Abschluss must be a month, YYYY-MM.', { reason: 'invalid-month' })
  }
  if (problem === 'future') {
    throw new BadRequestError('The Abschluss cannot lie in the future.', { reason: 'abschluss-in-future' })
  }
  if (problem === 'beforeStart') {
    throw new BadRequestError('The Abschluss cannot lie before the Beginn.', { reason: 'abschluss-before-beginn' })
  }
  return endedOn
}

/** Restore a soft-deleted project during its grace period. */
export async function restoreProject(
  session: AuthorizedSession,
  projectId: string,
  request: Request
): Promise<void> {
  await requireProjectAccess(session, projectId, 'project:manage', { includeDeleted: true, evenWhenClosed: true })

  const restored = await restoreProjectIfPending(projectId, session.organizationId)
  if (!restored) {
    throw new ConflictError(
      'No pending deletion to restore (already purged, or purge in progress).'
    )
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.restored',
    targetType: 'project',
    targetId: projectId,
    request,
  })
}

/**
 * What the overview's count, size and recent list leave out for this session:
 * the folders hidden from it (ADR-0087) and the held files it neither
 * uploaded nor reviews (ADR-0086). One answer for every page that renders the
 * overview data, so a second reader dimension cannot reach one and miss the other.
 */
export async function projectOverviewReader(
  session: AuthorizedSession,
  projectId: string
): Promise<ProjectOverviewReader> {
  return {
    hiddenFolderIds: await getHiddenFolderIds(session, projectId),
    reader: await shelfReaderFor(session, { scope: 'project', projectId }),
  }
}

export async function getProjectOverview(session: AuthorizedSession, projectId: string) {
  await requireProjectAccess(session, projectId, 'project:view')
  const reader = await projectOverviewReader(session, projectId)
  const data = await getProjectOverviewData(projectId, session.organizationId, reader)
  if (!data) throw new NotFoundError('Project not found')
  return data
}

/** The fields a member may edit on an existing memory item. */
export type ProjectMemoryItemPatch = Partial<
  Pick<ProjectMemoryItem, 'content' | 'kind' | 'status' | 'confidence' | 'verification' | 'pinned'>
>

/**
 * A memory item as the panel receives it. A restricted item (ADR-0087) also
 * names the folders it is restricted to, for the lock; it only reaches a reader
 * already cleared for all of them.
 */
export type ProjectMemoryListItem = ProjectMemoryItem & {
  restrictedFolderNames?: string[]
  /**
   * When a folder the note came from was purged (ADR-0088): the panel's
   * „Quelle gelöscht am …". The earliest, when several were.
   */
  sourceDeletedAt?: string
}

/**
 * Every folder of the project (tombstones included) this session may read now
 * (ADR-0088): what restricted memory is shown against. A project not found in
 * the organization reads nothing restricted.
 */
export async function memoryClearance(
  session: AuthorizedSession,
  projectId: string
): Promise<{ cleared: readonly string[] }> {
  const projectCollection = await findProjectCollectionName(projectId, session.organizationId)
  if (!projectCollection) return { cleared: [] }
  return { cleared: await readableFolderIdsFor(session.organizationId, projectId, await clearanceOf(session, projectId)) }
}

/** Name the folders behind each restricted item; open items pass through untouched. */
async function labelRestrictions(
  session: AuthorizedSession,
  projectId: string,
  items: ProjectMemoryItem[]
): Promise<ProjectMemoryListItem[]> {
  if (!items.some((item) => (item.restrictedFolderIds?.length ?? 0) > 0)) return items
  const [names, purgedAt] = await Promise.all([
    customFolderNames(session.organizationId, projectId),
    purgedFolderDates(session.organizationId, projectId),
  ])
  return items.map((item) => {
    if (!item.restrictedFolderIds || item.restrictedFolderIds.length === 0) return item
    const deleted = item.restrictedFolderIds
      .flatMap((folderId) => {
        const at = purgedAt.get(folderId)
        return at ? [at.toISOString()] : []
      })
      .sort()
    return {
      ...item,
      restrictedFolderNames: item.restrictedFolderIds
        .map((folderId) => names.get(folderId))
        .filter((name): name is string => name !== undefined),
      ...(deleted.length > 0 ? { sourceDeletedAt: deleted[0] } : {}),
    }
  })
}

/**
 * List a project's memory items, including the org-wide items that apply to
 * every project in the org. A restricted item (ADR-0088) is listed only for a
 * session that may read all of its source folders now; for anyone else it is absent.
 */
export async function getProjectMemory(
  session: AuthorizedSession,
  projectId: string,
  options: { includeArchived?: boolean; sourceConversationId?: string } = {}
): Promise<ProjectMemoryListItem[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  const { cleared } = await memoryClearance(session, projectId)
  const listed = await listProjectMemory(projectId, {
    ...options,
    organizationId: session.organizationId,
    readableFolderIds: cleared,
  })
  // An item's evidence names only the files this person may open now (memory-evidence.ts).
  const items = await withServedEvidence(session.organizationId, listed, {
    reader: memberReader(session.userId),
    clearanceIn: () => cleared,
  })
  return labelRestrictions(session, projectId, items)
}

/**
 * The rights that write a project's memory: the panel's add, edit and delete,
 * and the decision on a memory proposal (`lib/proposals/appliers.ts`), which
 * must not pass a gate this service then refuses.
 */
export const MEMORY_WRITE_PERMISSIONS: readonly ProjectPermission[] = ['project:memory:write', 'project:edit']

/** A note a person writes, or accepts from Piloti: user-authored and user-confirmed by definition. */
export interface PersonMemoryInput {
  kind: ProjectMemoryKind
  content: string
  confidence?: ProjectMemoryConfidence
  pinned?: boolean
  /**
   * The conversation the note was learned in, when it came from a proposal.
   * Purging a folder that conversation drew on deletes the note with it
   * (`deleteMemoryDrawnFrom`), so the link is not decoration.
   */
  sourceConversationId?: string | null
}

const personNote = (session: AuthorizedSession, input: PersonMemoryInput) => ({
  organizationId: session.organizationId,
  kind: input.kind,
  content: input.content,
  confidence: input.confidence ?? 'medium',
  pinned: input.pinned ?? false,
  provenanceType: 'user' as const,
  verification: 'user_confirmed' as const,
  createdBy: session.userId,
  ...(input.sourceConversationId ? { sourceConversationId: input.sourceConversationId } : {}),
})

/**
 * Manually add a memory item to a project. `options.supersedesContent` names
 * the note this one corrects (an accepted memory proposal's `supersedes`).
 */
export async function addProjectMemoryItem(
  session: AuthorizedSession,
  projectId: string,
  input: PersonMemoryInput,
  options: Pick<CreateMemoryOptions, 'supersedesContent'> = {}
): Promise<ProjectMemoryItem> {
  await requireProjectAccess(session, projectId, MEMORY_WRITE_PERMISSIONS)
  return createProjectMemoryItem({ scope: 'project', projectId, ...personNote(session, input) }, options)
}

/**
 * Add a note to the organization's memory, which every project of the tenant
 * reads. Any member may (the organization memory panel is deliberately not
 * admin-gated); the tenant is the session's. The panel's route and an accepted
 * organization memory proposal both write through here.
 */
export async function createOrganizationMemoryItem(
  session: AuthorizedSession,
  input: PersonMemoryInput,
  options: Pick<CreateMemoryOptions, 'supersedesContent'> = {}
): Promise<ProjectMemoryItem> {
  return createProjectMemoryItem({ scope: 'organization', projectId: null, ...personNote(session, input) }, options)
}

export async function editProjectMemoryItem(
  session: AuthorizedSession,
  projectId: string,
  itemId: string,
  patch: ProjectMemoryItemPatch
): Promise<ProjectMemoryItem> {
  await requireProjectAccess(session, projectId, ['project:memory:write', 'project:edit'])
  // A restricted item the session is not cleared for answers like a missing one.
  const { cleared } = await memoryClearance(session, projectId)
  const item = await updateProjectMemoryItem(
    { projectId, organizationId: session.organizationId, readableFolderIds: cleared },
    itemId,
    patch
  )
  if (!item) throw new NotFoundError()
  return item
}

export async function removeProjectMemoryItem(
  session: AuthorizedSession,
  projectId: string,
  itemId: string
): Promise<void> {
  await requireProjectAccess(session, projectId, ['project:memory:write', 'project:edit'])
  const { cleared } = await memoryClearance(session, projectId)
  const deleted = await deleteProjectMemoryItem(
    { projectId, organizationId: session.organizationId, readableFolderIds: cleared },
    itemId
  )
  if (!deleted) throw new NotFoundError()
}
