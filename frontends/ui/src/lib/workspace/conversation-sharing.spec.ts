/**
 * @vitest-environment node
 */
/**
 * The one rule that lets a Büro conversation be shared at all (spec AC-7, AC-8,
 * AC-9): a person may be party to it only while they may view every project it
 * has mounted.
 *
 * Every case here is a way that rule could leak or vanish. The mount rows and
 * the two authorization seams are mocked — this is a spec about the rule, not
 * about SQL or WorkOS — and the integration twin
 * (`sharing/workspace-sharing.integration.spec.ts`) asserts the same claims
 * against a real database with a fake FGA.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/authz/project-membership', () => ({ canUserAccessProject: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('./mounts-repository', () => ({ listConversationMounts: vi.fn() }))

import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { canUserAccessProject } from '@/lib/authz/project-membership'
import { requireProjectAccess } from '@/lib/authz/projects'
import { listConversationMounts, type MountRow } from './mounts-repository'
import {
  assertMountedProjectsReadable,
  assertSubjectMayJoinConversation,
  unviewableMountedProjects,
  usersExcludedByProject,
} from './conversation-sharing'

const ORG = 'org_1'
const CONVERSATION = 'conv_buero'
const SEESTADT = '11111111-1111-1111-1111-111111111111'
const NORDBAHNHOF = '22222222-2222-2222-2222-222222222222'

const session = (): AuthorizedSession =>
  ({
    userId: 'user_me',
    email: 'me@grid.test',
    name: null,
    accessToken: 'tok',
    organizationId: ORG,
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
    featureFlags: null,
  }) as AuthorizedSession

const mount = (projectId: string, projectName: string): MountRow => ({
  projectId,
  projectName,
  collectionName: `proj_${projectId}`,
  mountedBy: 'user',
  mountedByUserId: 'user_me',
  mountedAt: new Date('2026-09-08T10:00:00.000Z'),
})

beforeEach(() => {
  vi.mocked(listConversationMounts).mockResolvedValue([])
  vi.mocked(canUserAccessProject).mockResolvedValue(true)
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-viewer' } as never)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('unviewableMountedProjects — asked of a third party', () => {
  it('names every mounted project the subject may not view', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue([
      mount(SEESTADT, 'Seestadt'),
      mount(NORDBAHNHOF, 'Nordbahnhof'),
    ])
    vi.mocked(canUserAccessProject).mockImplementation(
      async (_session, projectId) => projectId !== NORDBAHNHOF
    )

    await expect(unviewableMountedProjects(session(), CONVERSATION, 'user_them')).resolves.toEqual([
      'Nordbahnhof',
    ])
  })

  it('asks for project:view, not project:chat', async () => {
    // The question is what the person will be able to READ once they are in the
    // thread. `canUserAccessProject` is the one third-party `project:view`
    // answer in the codebase, and it mirrors the org-admin bypass, so the
    // office cannot disagree with the projects grid about who may see what.
    vi.mocked(listConversationMounts).mockResolvedValue([mount(SEESTADT, 'Seestadt')])

    await unviewableMountedProjects(session(), CONVERSATION, 'user_them')

    expect(canUserAccessProject).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_me' }),
      SEESTADT,
      'user_them'
    )
  })

  it('asks nothing at all when the conversation mounts nothing', async () => {
    await expect(unviewableMountedProjects(session(), CONVERSATION, 'user_them')).resolves.toEqual(
      []
    )
    expect(canUserAccessProject).not.toHaveBeenCalled()
  })
})

describe('assertSubjectMayJoinConversation — the grant-time gate (AC-7)', () => {
  it('refuses the invitation, naming the project and the remedy', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue([mount(SEESTADT, 'Seestadt')])
    vi.mocked(canUserAccessProject).mockResolvedValue(false)

    const failure = await assertSubjectMayJoinConversation(
      session(),
      CONVERSATION,
      'user_them'
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BadRequestError)
    expect((failure as BadRequestError).message).toContain('Seestadt')
    expect((failure as BadRequestError).details).toMatchObject({
      // The share dialog's copy for this reason IS the remedy here; the names
      // ride alongside for a surface that wants to say which project.
      reason: 'container-access-required',
      projects: ['Seestadt'],
    })
  })

  it('permits the invitation when every mounted project is viewable', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue([mount(SEESTADT, 'Seestadt')])

    await expect(
      assertSubjectMayJoinConversation(session(), CONVERSATION, 'user_them')
    ).resolves.toBeUndefined()
  })

  it('refuses when the check itself fails — an outage narrows, never widens', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue([mount(SEESTADT, 'Seestadt')])
    // `canUserAccessProject` fails closed by contract; this pins that the gate
    // depends on that and does not treat "we could not tell" as a yes.
    vi.mocked(canUserAccessProject).mockResolvedValue(false)

    await expect(
      assertSubjectMayJoinConversation(session(), CONVERSATION, 'user_them')
    ).rejects.toBeInstanceOf(BadRequestError)
  })
})

describe('assertMountedProjectsReadable — the read-time gate (AC-7, AC-9)', () => {
  it('refuses as NOT FOUND when the reader lost one mounted project', async () => {
    // The grant survived; `project:view` did not. This is the case a grant-time
    // check alone cannot catch, and the refusal is indistinguishable from the
    // conversation never having existed (AC-9).
    vi.mocked(listConversationMounts).mockResolvedValue([
      mount(SEESTADT, 'Seestadt'),
      mount(NORDBAHNHOF, 'Nordbahnhof'),
    ])
    vi.mocked(requireProjectAccess).mockImplementation(async (_session, projectId) =>
      projectId === NORDBAHNHOF
        ? Promise.reject(new NotFoundError())
        : ({ role: 'project-viewer' } as never)
    )

    await expect(assertMountedProjectsReadable(session(), CONVERSATION)).rejects.toBeInstanceOf(
      NotFoundError
    )
  })

  it('lets a reader through who may view every mounted project', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue([mount(SEESTADT, 'Seestadt')])

    await expect(
      assertMountedProjectsReadable(session(), CONVERSATION)
    ).resolves.toBeUndefined()
    expect(requireProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_me' }),
      SEESTADT,
      'project:view'
    )
  })

  it('costs a thread with no mounts nothing beyond the one read', async () => {
    // Every conversation read passes through here, so "no mounts" has to be
    // cheap: one indexed query and not a single FGA call.
    await expect(assertMountedProjectsReadable(session(), CONVERSATION)).resolves.toBeUndefined()
    expect(requireProjectAccess).not.toHaveBeenCalled()
  })
})

describe('usersExcludedByProject — the mount-time gate (AC-8)', () => {
  it('returns the ids that may not view the project about to be mounted', async () => {
    vi.mocked(canUserAccessProject).mockImplementation(
      async (_session, _projectId, userId) => userId !== 'user_them'
    )

    await expect(
      usersExcludedByProject(session(), SEESTADT, ['user_you', 'user_them'])
    ).resolves.toEqual(['user_them'])
  })

  it('asks nobody when there is nobody to ask', async () => {
    await expect(usersExcludedByProject(session(), SEESTADT, [])).resolves.toEqual([])
    expect(canUserAccessProject).not.toHaveBeenCalled()
  })
})
