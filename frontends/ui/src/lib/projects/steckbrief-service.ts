/**
 * The Steckbrief of a project (ADR-0089): address, period, and everyone who
 * worked on it. The address is the profile fact `standort_adresse` and is
 * edited where every fact is, in the intake wizard; this service owns the
 * period and the people.
 *
 * Who may do what:
 *   - read: `project:view`, so every member of the office reads a closed
 *     project's Steckbrief (ADR-0088);
 *   - change the period or a person: the profile's write permissions, refused
 *     in a closed project like every other write;
 *   - delete a person: the same in an active project, and `project:manage` in a
 *     closed one, because deleting a person is how their data is erased (GDPR
 *     Art. 17) and erasure cannot wait for a reopen.
 *
 * People are personal data of people who mostly never gave it. They are kept
 * here and nowhere else: not in the profile, so never in the agent's prompt
 * (`lib/project-profile/prompt-view.ts` reads only the profile), and the audit
 * trail names a person by id, never by name.
 */

import 'server-only'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess, type ProjectPermission } from '@/lib/authz/projects'
import { isUserInOrganization } from '@/lib/authz/project-membership'
import { recordAuditEvent } from '@/lib/audit/service'
import type { ProjectPersonRow } from '@/lib/db/schema'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { findProjectProfile } from './repository'
import { dateToMonth, monthToDate, type Month } from './month'
import {
  deleteProjectPersonRow,
  findProjectPeriod,
  insertProjectPerson,
  listProjectPeople,
  updateProjectPeriod,
  updateProjectPersonRow,
  type ProjectPersonValues,
} from './steckbrief-repository'
import type { ProjectPeriodInput, ProjectPersonInput, ProjectPersonView, SteckbriefView } from './steckbrief-types'

/** The profile's write permissions: the Steckbrief is part of the profile (`profile-service.ts`). */
const STECKBRIEF_WRITE: readonly ProjectPermission[] = ['project:memory:write', 'project:edit']

const toDate = (month: Month | null): string | null => (month ? monthToDate(month) : null)

async function mayWrite(session: AuthorizedSession, projectId: string): Promise<boolean> {
  return requireProjectAccess(session, projectId, STECKBRIEF_WRITE).then(
    () => true,
    () => false
  )
}

async function mayErase(session: AuthorizedSession, projectId: string, closed: boolean): Promise<boolean> {
  if (!closed) return mayWrite(session, projectId)
  return requireProjectAccess(session, projectId, 'project:manage', { evenWhenClosed: true }).then(
    () => true,
    () => false
  )
}

function personView(row: ProjectPersonRow, accounts: ReadonlyMap<string, { name: string }>): ProjectPersonView {
  const account = row.userId ? accounts.get(row.userId) : undefined
  return {
    id: row.id,
    name: row.name,
    function: row.function,
    company: row.company,
    startedOn: dateToMonth(row.startedOn),
    endedOn: dateToMonth(row.endedOn),
    account: row.userId && account ? { userId: row.userId, name: account.name } : null,
  }
}

function addressOf(profile: Awaited<ReturnType<typeof findProjectProfile>>): string | null {
  const value = profile?.facts?.standort_adresse?.value
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export async function getSteckbrief(session: AuthorizedSession, projectId: string): Promise<SteckbriefView> {
  const { closed } = await requireProjectAccess(session, projectId, 'project:view')
  const [period, profile, rows, canEdit, canErase] = await Promise.all([
    findProjectPeriod(projectId, session.organizationId),
    findProjectProfile(projectId, session.organizationId),
    listProjectPeople(projectId, session.organizationId),
    mayWrite(session, projectId),
    mayErase(session, projectId, closed),
  ])
  if (!period) throw new NotFoundError()
  // Names for linked accounts only; the directory is cached and fails soft.
  const accounts = rows.some((row) => row.userId) ? await loadOrganizationDirectory(session.organizationId) : new Map()
  return {
    address: addressOf(profile),
    startedOn: dateToMonth(period.startedOn),
    endedOn: dateToMonth(period.endedOn),
    people: rows.map((row) => personView(row, accounts)),
    canEdit,
    canErase,
  }
}

export async function setProjectPeriod(
  session: AuthorizedSession,
  projectId: string,
  input: ProjectPeriodInput,
  request?: Request
): Promise<{ startedOn: Month | null; endedOn: Month | null }> {
  await requireProjectAccess(session, projectId, STECKBRIEF_WRITE)
  const row = await updateProjectPeriod(projectId, session.organizationId, {
    startedOn: toDate(input.startedOn),
    endedOn: toDate(input.endedOn),
  })
  if (!row) throw new NotFoundError()
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.period.changed',
    targetType: 'project',
    targetId: projectId,
    metadata: { startedOn: input.startedOn ?? '', endedOn: input.endedOn ?? '' },
    request,
  })
  return { startedOn: dateToMonth(row.startedOn), endedOn: dateToMonth(row.endedOn) }
}

/** The stored values of a person, the account link checked: it must name a member of this organization. */
async function personValues(session: AuthorizedSession, input: ProjectPersonInput): Promise<ProjectPersonValues> {
  if (input.userId && !(await isUserInOrganization(session, input.userId))) {
    throw new BadRequestError('The linked account is not a member of this organization.', { reason: 'unknown-account' })
  }
  return {
    name: input.name,
    function: input.function,
    company: input.company,
    startedOn: toDate(input.startedOn),
    endedOn: toDate(input.endedOn),
    userId: input.userId,
  }
}

async function auditPerson(
  session: AuthorizedSession,
  projectId: string,
  action: 'project.person.added' | 'project.person.updated' | 'project.person.deleted',
  personId: string,
  request?: Request
): Promise<void> {
  // By id only: the audit log outlives an erasure, and a name in it would not.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action,
    targetType: 'project',
    targetId: projectId,
    metadata: { personId },
    request,
  })
}

export async function addProjectPerson(
  session: AuthorizedSession,
  projectId: string,
  input: ProjectPersonInput,
  request?: Request
): Promise<ProjectPersonView> {
  await requireProjectAccess(session, projectId, STECKBRIEF_WRITE)
  const row = await insertProjectPerson(projectId, session.organizationId, session.userId, await personValues(session, input))
  await auditPerson(session, projectId, 'project.person.added', row.id, request)
  return personView(row, row.userId ? await loadOrganizationDirectory(session.organizationId) : new Map())
}

export async function updateProjectPerson(
  session: AuthorizedSession,
  projectId: string,
  personId: string,
  input: ProjectPersonInput,
  request?: Request
): Promise<ProjectPersonView> {
  await requireProjectAccess(session, projectId, STECKBRIEF_WRITE)
  const row = await updateProjectPersonRow(projectId, session.organizationId, personId, await personValues(session, input))
  if (!row) throw new NotFoundError('Person not found')
  await auditPerson(session, projectId, 'project.person.updated', row.id, request)
  return personView(row, row.userId ? await loadOrganizationDirectory(session.organizationId) : new Map())
}

/** Delete a person outright (the erasure). Possible in a closed project for whoever manages it. */
export async function deleteProjectPerson(
  session: AuthorizedSession,
  projectId: string,
  personId: string,
  request?: Request
): Promise<void> {
  const { closed } = await requireProjectAccess(session, projectId, 'project:view')
  if (closed) {
    await requireProjectAccess(session, projectId, 'project:manage', { evenWhenClosed: true })
  } else {
    await requireProjectAccess(session, projectId, STECKBRIEF_WRITE)
  }
  if (!(await deleteProjectPersonRow(projectId, session.organizationId, personId))) {
    throw new NotFoundError('Person not found')
  }
  await auditPerson(session, projectId, 'project.person.deleted', personId, request)
}
