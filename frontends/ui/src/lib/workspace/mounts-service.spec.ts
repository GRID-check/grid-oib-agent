/**
 * @vitest-environment node
 */
/**
 * The mounts service: the one place the mount permission is checked and the one
 * place the cap is enforced (ADR-0054, spec MT-2…MT-9, MT-13, MT-14).
 *
 * Two adapters call it — the session route a person's scope tree uses and the
 * internal twin `open_project` uses — so every claim here is a claim about both.
 * The repository is mocked because none of these are claims about SQL; the
 * database's own half (the composite keys, the actor biconditional, the cascade)
 * is asserted against a real Postgres in `db/tenant-isolation.integration.spec.ts`.
 *
 * `./grant` and `./config` are deliberately NOT mocked: the grant a mount hands
 * back is part of the answer this service gives, and the cap is the number it
 * refuses on. Stubbing either would leave the two things a caller actually acts
 * on untested.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationInOrg: vi.fn() }))
vi.mock('@/lib/conversations/service', () => ({ createConversation: vi.fn() }))
vi.mock('@/lib/authz/membership-role', () => ({ resolveMembershipRole: vi.fn() }))
vi.mock('./mounts-repository', () => ({
  listConversationMounts: vi.fn(),
  insertConversationMount: vi.fn(),
  deleteConversationMount: vi.fn(),
}))
// The participant set and the per-person project check the AC-8 gate runs on.
// Mocked because both reach WorkOS; the RULE — who is asked about, and what a
// refusal says — is what these tests are about.
vi.mock('@/lib/sharing/service', () => ({ resolveParticipants: vi.fn() }))
vi.mock('@/lib/sharing/directory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sharing/directory')>()),
  resolvePeople: vi.fn(),
}))
vi.mock('./conversation-sharing', () => ({ usersExcludedByProject: vi.fn() }))
// The Sammlung the set mount expands. Mocked because reading a set is
// `project-sets-service`'s claim to make; what this suite asserts is what the
// MOUNT does with the membership it is handed.
vi.mock('./project-sets-service', () => ({ projectSetForMount: vi.fn() }))

import { BadRequestError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { resolveMembershipRole } from '@/lib/authz/membership-role'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { createConversation } from '@/lib/conversations/service'
import type { Conversation } from '@/lib/db/schema'
import { requireResourceAccess } from '@/lib/sharing/access'
import { resolvePeople } from '@/lib/sharing/directory'
import { resolveParticipants } from '@/lib/sharing/service'
import { usersExcludedByProject } from './conversation-sharing'
import { projectSetForMount } from './project-sets-service'
import type { ProjectSetMemberRow, ProjectSetRow } from './project-sets-repository'
import { MOUNT_GRANT_TTL_SECONDS, verifyMountGrant } from './grant'
import {
  deleteConversationMount,
  insertConversationMount,
  listConversationMounts,
  type MountRow,
} from './mounts-repository'
import {
  listAuthorizedMounts,
  listMounts,
  mountProject,
  mountProjectSet,
  sessionForInternalMount,
  unmountProject,
  WorkspaceMountCapError,
  WorkspaceMountExclusionError,
} from './mounts-service'

const ORG = 'org_1'
const CONVERSATION = 'conv_buero'
const PROJECT = '11111111-1111-1111-1111-111111111111'
const SECRET = 'the-shared-internal-token'

const session = (): AuthorizedSession =>
  ({
    userId: 'user_1',
    email: 'a@b.test',
    name: null,
    accessToken: 'tok',
    organizationId: ORG,
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
    featureFlags: null,
  }) as AuthorizedSession

const mountRow = (overrides: Partial<MountRow> = {}): MountRow => ({
  projectId: PROJECT,
  projectName: 'Seestadt',
  collectionName: `proj_${PROJECT}`,
  mountedBy: 'user',
  mountedByUserId: 'user_1',
  mountedAt: new Date('2026-09-08T10:00:00.000Z'),
  ...overrides,
})

/** A workspace conversation that already exists. */
const workspaceConversation = () =>
  ({ id: CONVERSATION, organizationId: ORG, scope: 'workspace' }) as unknown as Conversation

beforeEach(() => {
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', SECRET)
  vi.mocked(findConversationInOrg).mockResolvedValue(workspaceConversation())
  vi.mocked(requireResourceAccess).mockResolvedValue({ role: 'collaborator' } as never)
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' } as never)
  vi.mocked(listConversationMounts).mockResolvedValue([])
  vi.mocked(insertConversationMount).mockResolvedValue(true)
  vi.mocked(deleteConversationMount).mockResolvedValue(true)
  // The ordinary Büro thread: nobody but its creator is party to it, so the
  // AC-8 gate has nobody to ask about.
  vi.mocked(resolveParticipants).mockResolvedValue(['user_1'])
  vi.mocked(usersExcludedByProject).mockResolvedValue([])
  vi.mocked(resolvePeople).mockResolvedValue(new Map())
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('mountProject — the gate (MT-2, MT-3)', () => {
  it('demands the conversation as a collaborator and the project as a chatter, then writes the row', async () => {
    vi.mocked(listConversationMounts).mockResolvedValueOnce([]).mockResolvedValueOnce([mountRow()])

    const result = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    })

    expect(requireResourceAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      'conversation',
      CONVERSATION,
      'collaborator'
    )
    // `project:chat` — the permission the project scope builder demands. A
    // reader gets a project's documents through the documents API; they do not
    // get the agent pointed at them.
    expect(requireProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      PROJECT,
      expect.arrayContaining(['project:chat'])
    )
    expect(result.created).toBe(true)
    expect(result.mount).toEqual({
      projectId: PROJECT,
      projectName: 'Seestadt',
      mountedBy: 'user',
      mountedAt: '2026-09-08T10:00:00.000Z',
    })
  })

  it('refuses a project the caller cannot see AT ALL as if it did not exist (MT-4)', async () => {
    // Both probes fail: `project:chat` and the `project:view` fallback. The
    // caller learns nothing about whether the project is real.
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())

    await expect(
      mountProject({
        session: session(),
        conversationId: CONVERSATION,
        projectId: PROJECT,
        mountedBy: 'agent',
      })
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(insertConversationMount).not.toHaveBeenCalled()
  })

  it('tells a caller who may VIEW the project that the refusal is about chat (OQ-7)', async () => {
    // The one deliberate exception to MT-4, implemented as an exception: this
    // caller can already see the project on their own projects page, so a 404
    // would be a lie that costs them the reason.
    vi.mocked(requireProjectAccess).mockImplementation(async (_session, _projectId, permission) =>
      permission === 'project:view'
        ? ({ role: 'project-viewer' } as never)
        : Promise.reject(new NotFoundError())
    )

    const failure = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ForbiddenError)
    expect((failure as ForbiddenError).message).toContain('project:chat')
    expect(insertConversationMount).not.toHaveBeenCalled()
  })

  it('creates the conversation through the service that checks org:chat when it does not exist yet', async () => {
    // Conversation ids are client-generated and the row appears with the first
    // message, so "mount before the first turn is persisted" is the ordinary
    // case — the `?mount=` deep link lands on an empty Büro (MT-16).
    vi.mocked(findConversationInOrg).mockResolvedValue(null)
    vi.mocked(listConversationMounts).mockResolvedValueOnce([]).mockResolvedValueOnce([mountRow()])

    await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    })

    expect(createConversation).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1' }), {
      id: CONVERSATION,
      scope: 'workspace',
    })
    // The conversation-level share check is what `createConversation` replaces
    // here: there is no row to be a collaborator on yet.
    expect(requireResourceAccess).not.toHaveBeenCalled()
  })

  it('refuses to mount into a PROJECT conversation, which already has its project', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      id: CONVERSATION,
      organizationId: ORG,
      scope: 'project',
    } as unknown as Conversation)

    await expect(
      mountProject({
        session: session(),
        conversationId: CONVERSATION,
        projectId: PROJECT,
        mountedBy: 'user',
      })
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(insertConversationMount).not.toHaveBeenCalled()
  })
})

describe('mountProject — the cap, here and nowhere else (MT-8, MT-9)', () => {
  it('refuses cap+1 with the cap and the mounted NAMES, and writes nothing', async () => {
    vi.stubEnv('GRID_WORKSPACE_MAX_MOUNTED_PROJECTS', '2')
    vi.mocked(listConversationMounts).mockResolvedValue([
      mountRow({ projectId: 'p-a', projectName: 'Seestadt' }),
      mountRow({ projectId: 'p-b', projectName: 'Nordbahnhof' }),
    ])

    const failure = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'agent',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WorkspaceMountCapError)
    const capError = failure as WorkspaceMountCapError
    expect(capError.status).toBe(409)
    expect(capError.code).toBe('WORKSPACE_MOUNT_CAP')
    // Both facts, because both surfaces render the same sentence: the UI's
    // disabled add row and the tool's refusal string (MT-9).
    expect(capError.cap).toBe(2)
    expect(capError.mounted).toEqual(['Seestadt', 'Nordbahnhof'])
    // The refusal and a row are not two outcomes of one call.
    expect(insertConversationMount).not.toHaveBeenCalled()
  })

  it('lets a RE-mount through at the cap: the same project twice is not a second mount', async () => {
    vi.stubEnv('GRID_WORKSPACE_MAX_MOUNTED_PROJECTS', '1')
    vi.mocked(listConversationMounts).mockResolvedValue([mountRow()])

    const result = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'agent',
    })

    expect(result.created).toBe(false)
    expect(insertConversationMount).not.toHaveBeenCalled()
    // The STORED attribution survives: whoever mounted it first is who a reader
    // is owed, not whoever re-mounted it (MT-5).
    expect(result.mount.mountedBy).toBe('user')
    // …and the answer still carries a working grant, so an agent re-opening a
    // project it opened last turn can actually read it.
    expect(verifyMountGrant(result.grant)).not.toBeNull()
  })

  it('defaults the cap to five when the deployment says nothing', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue(
      Array.from({ length: 5 }, (_unused, index) =>
        mountRow({ projectId: `p-${index}`, projectName: `Projekt ${index}` })
      )
    )

    const failure = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    }).catch((error: unknown) => error)

    expect((failure as WorkspaceMountCapError).cap).toBe(5)
  })
})

describe('mountProject — a mount never evicts a participant (spec AC-8)', () => {
  const OTHER = 'user_colleague'

  it('refuses the mount, NAMES who would lose the thread, and writes nothing', async () => {
    vi.mocked(resolveParticipants).mockResolvedValue(['user_1', OTHER])
    vi.mocked(usersExcludedByProject).mockResolvedValue([OTHER])
    vi.mocked(resolvePeople).mockResolvedValue(
      new Map([
        [OTHER, { userId: OTHER, email: null, name: 'Anna Meier', profilePictureUrl: null }],
      ])
    )

    const failure = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'agent',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WorkspaceMountExclusionError)
    // Names, because neither surface can render an id at somebody: the UI puts
    // them beside the add row and the agent puts them in a sentence.
    expect((failure as WorkspaceMountExclusionError).excluded).toEqual(['Anna Meier'])
    expect((failure as WorkspaceMountExclusionError).code).toBe('WORKSPACE_MOUNT_WOULD_EXCLUDE')
    expect(insertConversationMount).not.toHaveBeenCalled()
  })

  it('falls back to the id when the directory cannot name somebody', async () => {
    vi.mocked(resolveParticipants).mockResolvedValue(['user_1', OTHER])
    vi.mocked(usersExcludedByProject).mockResolvedValue([OTHER])
    vi.mocked(resolvePeople).mockResolvedValue(new Map())

    const failure = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    }).catch((error: unknown) => error)

    // A WorkOS hiccup must not turn a refusal into a crash: the person is named
    // by id rather than not named at all.
    expect((failure as WorkspaceMountExclusionError).excluded).toEqual([OTHER])
  })

  it('never asks about the person doing the mounting', async () => {
    vi.mocked(resolveParticipants).mockResolvedValue(['user_1'])
    vi.mocked(listConversationMounts).mockResolvedValueOnce([]).mockResolvedValueOnce([mountRow()])

    await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    })

    // They just proved `project:chat` on this project, which is more than the
    // `project:view` everyone else is being asked for — and a private thread
    // has exactly this one participant, so the gate costs it no round trip.
    expect(usersExcludedByProject).not.toHaveBeenCalled()
  })

  it('does not re-check an idempotent re-mount — the same mount, said twice', async () => {
    vi.mocked(resolveParticipants).mockResolvedValue(['user_1', OTHER])
    vi.mocked(listConversationMounts).mockResolvedValue([mountRow()])

    const result = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    })

    // Re-mounting changes nobody's access, so a participant who lost the
    // project since must not turn a no-op into a refusal.
    expect(result.created).toBe(false)
    expect(usersExcludedByProject).not.toHaveBeenCalled()
  })

  it('lets the mount through when every participant may view the project', async () => {
    vi.mocked(resolveParticipants).mockResolvedValue(['user_1', OTHER])
    vi.mocked(usersExcludedByProject).mockResolvedValue([])
    vi.mocked(listConversationMounts).mockResolvedValueOnce([]).mockResolvedValueOnce([mountRow()])

    const result = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    })

    expect(result.created).toBe(true)
    expect(usersExcludedByProject).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      PROJECT,
      [OTHER]
    )
  })
})

describe('mountProject — the row and the grant (MT-5, MT-6)', () => {
  it('names the user on a user mount and nobody on an agent mount (the 0083 biconditional)', async () => {
    vi.mocked(listConversationMounts).mockResolvedValueOnce([]).mockResolvedValueOnce([mountRow()])
    await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    })
    expect(insertConversationMount).toHaveBeenCalledWith(
      expect.objectContaining({ mountedBy: 'user', mountedByUserId: 'user_1' })
    )

    vi.mocked(insertConversationMount).mockClear()
    vi.mocked(listConversationMounts)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([mountRow({ mountedBy: 'agent', mountedByUserId: null })])
    await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'agent',
    })
    expect(insertConversationMount).toHaveBeenCalledWith(
      expect.objectContaining({ mountedBy: 'agent', mountedByUserId: null })
    )
  })

  it('mints a grant that verifies, names the collection and its project, and expires', async () => {
    vi.mocked(listConversationMounts).mockResolvedValueOnce([]).mockResolvedValueOnce([mountRow()])

    const { grant } = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    })

    const payload = verifyMountGrant(grant)
    expect(payload).toEqual({
      v: 1,
      collection: `proj_${PROJECT}`,
      shelf: 'project',
      projectId: PROJECT,
      projectName: 'Seestadt',
      conversationId: CONVERSATION,
      organizationId: ORG,
      exp: expect.any(Number),
    })

    // Short-lived by design: the window a revoked permission can be replayed in
    // is bounded by this, not by the mount row (MT-7).
    const past = new Date((payload?.exp ?? 0) * 1000 - 1000)
    const future = new Date((payload?.exp ?? 0) * 1000 + 1000)
    expect(verifyMountGrant(grant, { now: past })).not.toBeNull()
    expect(verifyMountGrant(grant, { now: future })).toBeNull()
    expect(MOUNT_GRANT_TTL_SECONDS).toBe(900)
  })

  it('refuses a tampered grant — the payload and the signature are one thing', async () => {
    vi.mocked(listConversationMounts).mockResolvedValueOnce([]).mockResolvedValueOnce([mountRow()])
    const { grant } = await mountProject({
      session: session(),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'user',
    })

    // Widen the grant by hand: same signature, a different collection.
    const decoded: unknown = JSON.parse(Buffer.from(grant.grant, 'base64url').toString('utf8'))
    const widened = { ...(decoded as Record<string, unknown>), collection: 'proj_somebody_elses' }
    const forged = {
      grant: Buffer.from(JSON.stringify(widened), 'utf8').toString('base64url'),
      sig: grant.sig,
    }

    expect(verifyMountGrant(forged)).toBeNull()
    // And a signature from a different deployment's secret is no better.
    expect(verifyMountGrant(grant, { secret: 'another-deployments-token' })).toBeNull()
  })

  it('says nothing at all when the project was purged between the insert and the read-back', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue([])

    await expect(
      mountProject({
        session: session(),
        conversationId: CONVERSATION,
        projectId: PROJECT,
        mountedBy: 'user',
      })
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('listMounts', () => {
  it('reads as a VIEWER — the mounted set is a property of the conversation (MT-14)', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue([mountRow()])

    const result = await listMounts(session(), CONVERSATION)

    expect(requireResourceAccess).toHaveBeenCalledWith(
      expect.anything(),
      'conversation',
      CONVERSATION,
      'viewer'
    )
    expect(result.mounts).toEqual([
      {
        projectId: PROJECT,
        projectName: 'Seestadt',
        mountedBy: 'user',
        mountedAt: '2026-09-08T10:00:00.000Z',
      },
    ])
    // The cap travels with the list so the UI never has to guess the number it
    // is about to refuse against.
    expect(result.cap).toBe(5)
  })

  it('answers an empty list for a conversation that does not exist yet, without a share check', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue(null)

    await expect(listMounts(session(), CONVERSATION)).resolves.toEqual({ mounts: [], cap: 5 })
    expect(requireResourceAccess).not.toHaveBeenCalled()
    expect(listConversationMounts).not.toHaveBeenCalled()
  })
})

describe('unmountProject (MT-13)', () => {
  it('needs the conversation as a collaborator and no project permission at all', async () => {
    await unmountProject(session(), CONVERSATION, PROJECT)

    expect(requireResourceAccess).toHaveBeenCalledWith(
      expect.anything(),
      'conversation',
      CONVERSATION,
      'collaborator'
    )
    // Narrowing a thread's scope is contributing to it; it cannot require a
    // permission on the project being removed, or a revoked member could never
    // clean up after themselves.
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(deleteConversationMount).toHaveBeenCalledWith(CONVERSATION, PROJECT, ORG)
  })

  it('is refused for someone who may only read the thread', async () => {
    vi.mocked(requireResourceAccess).mockRejectedValue(new NotFoundError())

    await expect(unmountProject(session(), CONVERSATION, PROJECT)).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(deleteConversationMount).not.toHaveBeenCalled()
  })
})

describe('listAuthorizedMounts — the revocation path (MT-7)', () => {
  it('re-authorizes every mount and drops only the ones that fail', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue([
      mountRow({ projectId: 'p-kept', projectName: 'Seestadt' }),
      mountRow({ projectId: 'p-revoked', projectName: 'Nordbahnhof' }),
    ])
    vi.mocked(requireProjectAccess).mockImplementation(async (_session, projectId) =>
      projectId === 'p-revoked'
        ? Promise.reject(new NotFoundError())
        : ({ role: 'project-editor' } as never)
    )

    const survivors = await listAuthorizedMounts(session(), CONVERSATION)

    expect(survivors.map((row) => row.projectId)).toEqual(['p-kept'])
    expect(requireProjectAccess).toHaveBeenCalledTimes(2)
  })

  it('never throws: an unreadable mounts table costs the turn its projects, not its answer', async () => {
    vi.mocked(listConversationMounts).mockRejectedValue(new Error('database is away'))

    await expect(listAuthorizedMounts(session(), CONVERSATION)).resolves.toEqual([])
  })

  it('asks nothing when nothing is mounted', async () => {
    vi.mocked(listConversationMounts).mockResolvedValue([])

    await expect(listAuthorizedMounts(session(), CONVERSATION)).resolves.toEqual([])
    expect(requireProjectAccess).not.toHaveBeenCalled()
  })
})

describe('sessionForInternalMount — the agent authorizes AS THE USER (MT-3)', () => {
  it('carries the envelope identity and the role resolved from the membership', async () => {
    vi.mocked(resolveMembershipRole).mockResolvedValue('admin')

    const reconstructed = await sessionForInternalMount({
      organizationId: ORG,
      userId: 'user_7',
      organizationMembershipId: 'om_7',
    })

    expect(resolveMembershipRole).toHaveBeenCalledWith(ORG, 'om_7')
    expect(reconstructed).toMatchObject({
      userId: 'user_7',
      organizationId: ORG,
      organizationMembershipId: 'om_7',
      role: 'admin',
      // Empty on purpose: the envelope carries no claims, and inventing them
      // would make this look like a session rather than the reconstruction it is.
      permissions: [],
    })
  })

  it('falls back to no role when the membership cannot be resolved, which denies rather than widens', async () => {
    vi.mocked(resolveMembershipRole).mockResolvedValue(null)

    const reconstructed = await sessionForInternalMount({
      organizationId: ORG,
      userId: 'user_7',
      organizationMembershipId: 'om_unknown',
    })

    expect(reconstructed.role).toBe('')
  })
})

/**
 * Mounting a Sammlung (spec GR-2).
 *
 * The claim under test is that a set is NOT a second mechanism: it expands to
 * the same rows through the same write, and every refusal a single mount can
 * make is evaluated over the whole set BEFORE any of it is written. So each
 * test here is about the difference the plural makes — the cap counted once,
 * the exclusion union, and the three-way verdict per member — and never about
 * the mount rules themselves, which the suites above already own.
 */
describe('mountProjectSet — a Sammlung mounts as one unit (spec GR-2)', () => {
  const BEZIRK: ProjectSetRow = {
    id: '99999999-9999-9999-9999-999999999999',
    name: 'Bezirk 3',
    description: null,
    createdBy: 'user_1',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  }

  const member = (projectId: string, projectName: string): ProjectSetMemberRow => ({
    setId: BEZIRK.id,
    projectId,
    projectName,
    addedAt: new Date('2026-09-01T00:00:00.000Z'),
  })

  const withMembers = (members: ProjectSetMemberRow[]) =>
    vi.mocked(projectSetForMount).mockResolvedValue({ set: BEZIRK, members })

  const mountSet = () =>
    mountProjectSet({
      session: session(),
      conversationId: CONVERSATION,
      projectSetId: BEZIRK.id,
      mountedBy: 'user',
    })

  it('mounts every readable member through the same write, one grant each', async () => {
    withMembers([member('p-a', 'Seestadt'), member('p-b', 'Nordbahnhof')])
    vi.mocked(listConversationMounts)
      // the cap read, then one read-back per commit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([mountRow({ projectId: 'p-a', projectName: 'Seestadt' })])
      .mockResolvedValueOnce([
        mountRow({ projectId: 'p-a', projectName: 'Seestadt' }),
        mountRow({ projectId: 'p-b', projectName: 'Nordbahnhof' }),
      ])

    const result = await mountSet()

    expect(result.set).toEqual({ id: BEZIRK.id, name: 'Bezirk 3' })
    expect(result.mounts.map((entry) => entry.mount.projectId)).toEqual(['p-a', 'p-b'])
    // A grant per mount: the answer is worth nothing without one, and the set
    // gets no special grant of its own — there is no set-shaped scope.
    for (const entry of result.mounts) {
      expect(verifyMountGrant(entry.grant)).not.toBeNull()
      expect(entry.created).toBe(true)
    }
    expect(insertConversationMount).toHaveBeenCalledTimes(2)
    expect(result.skipped).toEqual([])
  })

  it('refuses a set larger than the cap, names the cap and the SET, and writes nothing', async () => {
    vi.stubEnv('GRID_WORKSPACE_MAX_MOUNTED_PROJECTS', '2')
    withMembers([
      member('p-a', 'Seestadt'),
      member('p-b', 'Nordbahnhof'),
      member('p-c', 'Donaufeld'),
    ])
    vi.mocked(listConversationMounts).mockResolvedValue([])

    const failure = await mountSet().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WorkspaceMountCapError)
    const capError = failure as WorkspaceMountCapError
    expect(capError.code).toBe('WORKSPACE_MOUNT_CAP')
    expect(capError.cap).toBe(2)
    // The set by name, because "Bezirk 3 passt nicht" is the sentence; a cap
    // refusal that named only the number would leave the person guessing which
    // of the two things they clicked was too big.
    expect(capError.set).toBe('Bezirk 3')
    // ONE cap decision over the resulting total, taken before any row: mounting
    // two of the three and then refusing is exactly the outcome this forbids.
    expect(insertConversationMount).not.toHaveBeenCalled()
  })

  it('counts the cap over existing + NEW distinct, so a partly mounted set still fits', async () => {
    vi.stubEnv('GRID_WORKSPACE_MAX_MOUNTED_PROJECTS', '2')
    withMembers([member('p-a', 'Seestadt'), member('p-b', 'Nordbahnhof')])
    const already = mountRow({ projectId: 'p-a', projectName: 'Seestadt' })
    vi.mocked(listConversationMounts)
      .mockResolvedValueOnce([already])
      .mockResolvedValue([already, mountRow({ projectId: 'p-b', projectName: 'Nordbahnhof' })])

    const result = await mountSet()

    // Two members, one of them already mounted: the total is two, not three.
    expect(result.mounts.map((entry) => entry.created)).toEqual([false, true])
    expect(insertConversationMount).toHaveBeenCalledTimes(1)
  })

  it('skips a member the caller may view but not chat in, and NAMES it', async () => {
    withMembers([member('p-a', 'Seestadt'), member('p-b', 'Nordbahnhof')])
    vi.mocked(requireProjectAccess).mockImplementation(async (_session, projectId, permission) => {
      if (projectId === 'p-b' && permission !== 'project:view') throw new NotFoundError()
      return { role: 'project-viewer' } as never
    })
    vi.mocked(listConversationMounts)
      .mockResolvedValueOnce([])
      .mockResolvedValue([mountRow({ projectId: 'p-a', projectName: 'Seestadt' })])

    const result = await mountSet()

    expect(result.mounts.map((entry) => entry.mount.projectId)).toEqual(['p-a'])
    // Named, because this caller already knows Nordbahnhof exists and already
    // knows what it is called — so the actionable half of the refusal costs
    // them nothing.
    expect(result.skipped).toEqual([
      { projectId: 'p-b', projectName: 'Nordbahnhof', reason: 'forbidden' },
    ])
  })

  it('leaves a member the caller may not see at all out of the answer ENTIRELY (MT-4)', async () => {
    withMembers([member('p-a', 'Seestadt'), member('p-secret', 'Geheimprojekt')])
    vi.mocked(requireProjectAccess).mockImplementation(async (_session, projectId) => {
      if (projectId === 'p-secret') throw new NotFoundError()
      return { role: 'project-editor' } as never
    })
    vi.mocked(listConversationMounts)
      .mockResolvedValueOnce([])
      .mockResolvedValue([mountRow({ projectId: 'p-a', projectName: 'Seestadt' })])

    const result = await mountSet()

    expect(result.mounts.map((entry) => entry.mount.projectId)).toEqual(['p-a'])
    // Not in `skipped`, not counted, not hinted at. A Sammlung must not become
    // the door through which somebody learns that a project they may not read
    // exists — the same rule the register recall keeps (spec AC-3, AC-4).
    expect(result.skipped).toEqual([])
    expect(JSON.stringify(result)).not.toContain('Geheimprojekt')
    expect(JSON.stringify(result)).not.toContain('p-secret')
  })

  it('applies the exclusion rule to the WHOLE set, refusing before any row', async () => {
    const OTHER = 'user_colleague'
    withMembers([member('p-a', 'Seestadt'), member('p-b', 'Nordbahnhof')])
    vi.mocked(listConversationMounts).mockResolvedValue([])
    vi.mocked(resolveParticipants).mockResolvedValue(['user_1', OTHER])
    // Excluded by the SECOND member only: one bad project refuses the set.
    vi.mocked(usersExcludedByProject).mockImplementation(async (_session, projectId) =>
      projectId === 'p-b' ? [OTHER] : []
    )
    vi.mocked(resolvePeople).mockResolvedValue(
      new Map([
        [OTHER, { userId: OTHER, email: null, name: 'Anna Meier', profilePictureUrl: null }],
      ])
    )

    const failure = await mountSet().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WorkspaceMountExclusionError)
    expect((failure as WorkspaceMountExclusionError).excluded).toEqual(['Anna Meier'])
    // The harmless half of the set is not already in the conversation.
    expect(insertConversationMount).not.toHaveBeenCalled()
  })

  it('names an excluded person once, however many projects would exclude them', async () => {
    const OTHER = 'user_colleague'
    withMembers([member('p-a', 'Seestadt'), member('p-b', 'Nordbahnhof')])
    vi.mocked(listConversationMounts).mockResolvedValue([])
    vi.mocked(resolveParticipants).mockResolvedValue(['user_1', OTHER])
    vi.mocked(usersExcludedByProject).mockResolvedValue([OTHER])
    vi.mocked(resolvePeople).mockResolvedValue(new Map())

    const failure = await mountSet().catch((error: unknown) => error)

    expect((failure as WorkspaceMountExclusionError).excluded).toEqual([OTHER])
  })

  it('takes the conversation gate before it even looks at the set', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      id: CONVERSATION,
      organizationId: ORG,
      scope: 'project',
    } as unknown as Conversation)

    await expect(mountSet()).rejects.toBeInstanceOf(BadRequestError)
    expect(projectSetForMount).not.toHaveBeenCalled()
  })

  it('answers an empty Sammlung with nothing mounted rather than an error', async () => {
    withMembers([])
    vi.mocked(listConversationMounts).mockResolvedValue([])

    const result = await mountSet()

    expect(result).toEqual({ set: { id: BEZIRK.id, name: 'Bezirk 3' }, mounts: [], skipped: [] })
    expect(insertConversationMount).not.toHaveBeenCalled()
  })
})
