/**
 * @vitest-environment node
 */
/**
 * Assignment candidates (ADR-0047): who a collaborator may put on the hook.
 *
 * The property under test is the floor — `collaborator`, not `owner`. Share
 * invite candidates require owner because that list exists to change the
 * roster. A project member on a project-visible document is a collaborator
 * and must still be able to name who is responsible.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/feature-flags', () => ({
  isCollaborationEnabled: vi.fn(() => true),
}))

vi.mock('@/lib/sharing/access', () => ({
  requireResourceAccess: vi.fn(),
  requireResourceWriteAccess: vi.fn(),
}))

vi.mock('@/lib/sharing/directory', () => ({
  loadOrganizationDirectory: vi.fn(),
  unknownPerson: (userId: string) => ({ userId, email: null, name: userId, profilePictureUrl: null }),
}))

vi.mock('@/lib/authz/project-membership', () => ({ PERMISSION_CHECKS_AT_ONCE: 8,
  userHoldsProjectPermission: vi.fn(),
  resolveSubjectMembership: vi.fn(),
  filterUsersWithProjectAccess: vi.fn(),
}))

vi.mock('@/lib/documents/access', () => ({ findDocumentForSession: vi.fn() }))

vi.mock('@/lib/authz/folder-access', () => ({
  filterUsersWhoMayReadFolder: vi.fn(
    async (_org: string, _project: string, _folder: string | null, userIds: readonly string[]) => new Set(userIds),
  ),
}))

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn().mockResolvedValue(1),
}))

vi.mock('@/lib/sharing/registry', () => ({
  describeResource: vi.fn(() => ({
    describeRef: vi.fn().mockResolvedValue({ title: 'Plan.pdf' }),
  })),
}))

vi.mock('./repository', () => ({
  insertAssignment: vi.fn(),
  deleteAssignment: vi.fn(),
  listAssignmentsForResources: vi.fn().mockResolvedValue([]),
}))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isCollaborationEnabled } from '@/lib/authz/feature-flags'
import { filterUsersWhoMayReadFolder } from '@/lib/authz/folder-access'
import { filterUsersWithProjectAccess, resolveSubjectMembership, userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { Document, ResourceRole } from '@/lib/db/schema'
import { findDocumentForSession } from '@/lib/documents/access'
import { requireResourceAccess, requireResourceWriteAccess } from '@/lib/sharing/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import {
  addResourceAssignment,
  listAssignmentCandidates,
  listResourceAssignments,
  removeResourceAssignment,
} from './service'
import { deleteAssignment, insertAssignment, listAssignmentsForResources } from './repository'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

function person(userId: string, name: string) {
  return { userId, email: `${name.toLowerCase()}@grid.test`, name, profilePictureUrl: null }
}

function stubCallerRole(role: ResourceRole, projectId: string | null = 'proj_1'): void {
  vi.mocked(requireResourceAccess).mockResolvedValue({
    role,
    reason: 'visibility-project',
    visibility: 'project',
    container: { organizationId: 'org_1', projectId },
    canEscalate: false,
    contentLocked: false,
  })
}

beforeEach(() => {
  vi.mocked(isCollaborationEnabled).mockReturnValue(true)
  stubCallerRole('collaborator')
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([
      ['user_me', person('user_me', 'Matthias')],
      ['user_anna', person('user_anna', 'Anna')],
      ['user_bob', person('user_bob', 'Bob')],
      ['user_carol', person('user_carol', 'Carol')],
    ]),
  )
  vi.mocked(filterUsersWithProjectAccess).mockResolvedValue(new Set(['user_anna', 'user_bob']))
  // Anna and Bob are in the project; Carol is not.
  vi.mocked(userHoldsProjectPermission).mockImplementation(async (_session, _project, userId) => userId !== 'user_carol')
  vi.mocked(findDocumentForSession).mockResolvedValue(projectDocument(null))
  vi.mocked(filterUsersWhoMayReadFolder).mockImplementation(async (_org, _project, _folder, userIds) => new Set(userIds))
})

/** A document filed in a project, in `folderId` (null: the project root). */
function projectDocument(folderId: string | null): Document {
  return { id: 'doc_1', scope: 'project', projectId: 'proj_1', folderId } as Partial<Document> as Document
}

/** Only Anna may read the restricted folder `fld_hr`. */
function onlyAnnaReadsTheFolder(): void {
  vi.mocked(findDocumentForSession).mockResolvedValue(projectDocument('fld_hr'))
  vi.mocked(filterUsersWhoMayReadFolder).mockImplementation(
    async (_org, _project, _folder, userIds) => new Set(userIds.filter((userId) => userId === 'user_anna')),
  )
}

describe('listAssignmentCandidates', () => {
  it('lets a collaborator list project members, excluding themselves', async () => {
    const candidates = await listAssignmentCandidates(session, 'document', 'doc_1')

    expect(requireResourceAccess).toHaveBeenCalledWith(session, 'document', 'doc_1', 'collaborator')
    expect(candidates.map((person) => person.userId)).toEqual(['user_anna', 'user_bob'])
    expect(candidates.some((person) => person.userId === 'user_me')).toBe(false)
    expect(candidates.some((person) => person.userId === 'user_carol')).toBe(false)
  })

  it('does not require owner — assignment is not changing the roster', async () => {
    stubCallerRole('collaborator')

    await expect(listAssignmentCandidates(session, 'document', 'doc_1')).resolves.toHaveLength(2)
    expect(requireResourceAccess).toHaveBeenCalledWith(session, 'document', 'doc_1', 'collaborator')
    expect(requireResourceAccess).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'owner',
    )
  })

  it('refuses a viewer the same way assign/release does', async () => {
    vi.mocked(requireResourceAccess).mockRejectedValue(new NotFoundError())

    await expect(listAssignmentCandidates(session, 'document', 'doc_1')).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('leaves out a project member who may not read the folder the document is filed in', async () => {
    onlyAnnaReadsTheFolder()

    const candidates = await listAssignmentCandidates(session, 'document', 'doc_1')

    expect(candidates.map((person) => person.userId)).toEqual(['user_anna'])
    expect(filterUsersWhoMayReadFolder).toHaveBeenCalledWith('org_1', 'proj_1', 'fld_hr', ['user_anna', 'user_bob'])
  })

  it('still asks the project alone for a resource that is not a document', async () => {
    const candidates = await listAssignmentCandidates(session, 'conversation', 'conv_1')

    expect(filterUsersWithProjectAccess).toHaveBeenCalledWith(session, 'proj_1', ['user_anna', 'user_bob', 'user_carol'])
    expect(findDocumentForSession).not.toHaveBeenCalled()
    expect(candidates.map((person) => person.userId)).toEqual(['user_anna', 'user_bob'])
  })

  it('lists the org directory when the resource has no project container', async () => {
    stubCallerRole('collaborator', null)
    vi.mocked(findDocumentForSession).mockResolvedValue({ id: 'doc_1', scope: 'archiv', projectId: null, folderId: null } as Partial<Document> as Document)
    // Every person in the directory is a member; the Büroablage asks each membership, not a role.
    vi.mocked(resolveSubjectMembership).mockResolvedValue({ organizationMembershipId: 'om_1', role: 'member' })

    const candidates = await listAssignmentCandidates(session, 'document', 'doc_1')

    expect(filterUsersWithProjectAccess).not.toHaveBeenCalled()
    expect(candidates.map((person) => person.userId)).toEqual(['user_anna', 'user_bob', 'user_carol'])
  })

  it('is invisible when collaboration is off', async () => {
    vi.mocked(isCollaborationEnabled).mockReturnValue(false)

    await expect(listAssignmentCandidates(session, 'document', 'doc_1')).rejects.toBeInstanceOf(
      NotFoundError,
    )
    expect(requireResourceAccess).not.toHaveBeenCalled()
  })
})

describe('addResourceAssignment — container check', () => {
  it('asks project:view of the subject, in the caller’s organization', async () => {
    await addResourceAssignment(session, 'document', 'doc_1', 'user_anna')

    expect(userHoldsProjectPermission).toHaveBeenCalledWith({ organizationId: session.organizationId }, 'proj_1', 'user_anna', 'project:view')
  })

  it('refuses a project member who may not read the document’s folder, and writes nothing', async () => {
    onlyAnnaReadsTheFolder()

    await expect(addResourceAssignment(session, 'document', 'doc_1', 'user_bob')).rejects.toMatchObject({
      status: 400,
      details: { reason: 'container-access-required' },
    })
    expect(insertAssignment).not.toHaveBeenCalled()
  })
})

describe('assigning on a document is a write in its folder (ADR-0088)', () => {
  const readOnly = () => new ForbiddenError('You can read this folder but not change it.', { reason: 'folder-read-only' })

  it('asks for the write before adding anyone, and writes nothing when it is refused', async () => {
    vi.mocked(requireResourceWriteAccess).mockRejectedValueOnce(readOnly())

    await expect(addResourceAssignment(session, 'document', 'doc_1', 'user_anna')).rejects.toMatchObject({
      status: 403,
      details: { reason: 'folder-read-only' },
    })

    expect(requireResourceWriteAccess).toHaveBeenCalledWith(session, 'document', 'doc_1')
    expect(insertAssignment).not.toHaveBeenCalled()
  })

  it('asks for the write before taking anyone off, and deletes nothing when it is refused', async () => {
    vi.mocked(requireResourceWriteAccess).mockRejectedValueOnce(readOnly())

    await expect(removeResourceAssignment(session, 'document', 'doc_1', 'user_anna')).rejects.toMatchObject({
      status: 403,
    })

    expect(deleteAssignment).not.toHaveBeenCalled()
  })

  it('assigns as before for someone who may write', async () => {
    vi.mocked(requireResourceWriteAccess).mockResolvedValue(undefined)

    await addResourceAssignment(session, 'document', 'doc_1', 'user_anna')

    expect(insertAssignment).toHaveBeenCalledWith(expect.objectContaining({ subjectUserId: 'user_anna' }))
  })
})

describe('listResourceAssignments — the GET route', () => {
  beforeEach(() => {
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map([['user_anna', person('user_anna', 'Anna')]]))
    vi.mocked(listAssignmentsForResources).mockResolvedValue([
      { resourceId: 'doc_1', subjectUserId: 'user_anna', assignedBy: 'user_me' },
    ] as never)
  })

  it('requires viewer on the resource before reading who is assigned', async () => {
    stubCallerRole('viewer')

    const assignees = await listResourceAssignments(session, 'document', 'doc_1')

    expect(requireResourceAccess).toHaveBeenCalledWith(session, 'document', 'doc_1', 'viewer')
    expect(assignees.map((p) => p.userId)).toEqual(['user_anna'])
  })

  it('reads nothing for a resource the caller cannot reach (404)', async () => {
    vi.mocked(requireResourceAccess).mockRejectedValue(new NotFoundError())
    vi.mocked(listAssignmentsForResources).mockClear()

    await expect(listResourceAssignments(session, 'conversation', 's_private')).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(listAssignmentsForResources).not.toHaveBeenCalled()
  })

  it('is invisible when collaboration is off', async () => {
    vi.mocked(isCollaborationEnabled).mockReturnValueOnce(false)
    vi.mocked(requireResourceAccess).mockClear()

    await expect(listResourceAssignments(session, 'document', 'doc_1')).rejects.toBeInstanceOf(NotFoundError)
    expect(requireResourceAccess).not.toHaveBeenCalled()
  })
})
