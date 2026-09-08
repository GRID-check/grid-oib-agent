/**
 * @vitest-environment node
 */
/**
 * Sammlungen: who may name one, who may change one, and what a member is
 * allowed to learn from one (ADR-0054, spec GR-2).
 *
 * The repository is mocked because none of these are claims about SQL — the
 * database's own half (the composite keys, the case-insensitive unique name,
 * the two cascades) is asserted against a real Postgres in
 * `db/tenant-isolation.integration.spec.ts`. What is under test here is the
 * three-part rule: `org:chat` to use the surface, creator-or-administrator to
 * change a set, and `project:view` per project both to put one IN a set and to
 * see it in one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/authz/projects', () => ({
  filterReadableProjects: vi.fn(),
  requireProjectAccess: vi.fn(),
}))
vi.mock('./project-sets-repository', () => ({
  deleteProjectSetMembers: vi.fn(),
  deleteProjectSetRow: vi.fn(),
  findProjectSetInOrg: vi.fn(),
  insertProjectSet: vi.fn(),
  insertProjectSetMembers: vi.fn(),
  listMembersOfProjectSets: vi.fn(),
  listProjectSetMembers: vi.fn(),
  listProjectSetsInOrg: vi.fn(),
  updateProjectSetRow: vi.fn(),
}))

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { filterReadableProjects, requireProjectAccess } from '@/lib/authz/projects'
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
import {
  addProjectsToSet,
  createProjectSet,
  deleteProjectSet,
  getProjectSet,
  listProjectSets,
  projectSetForMount,
  PROJECT_SET_NAME_MAX,
  removeProjectsFromSet,
  updateProjectSet,
} from './project-sets-service'

const ORG = 'org_1'
const SET = '99999999-9999-9999-9999-999999999999'
const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const PROJECT_B = '22222222-2222-2222-2222-222222222222'

const session = (overrides: Partial<AuthorizedSession> = {}): AuthorizedSession =>
  ({
    userId: 'user_1',
    email: 'a@b.test',
    name: null,
    accessToken: 'tok',
    organizationId: ORG,
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: ['org:chat'],
    featureFlags: null,
    ...overrides,
  }) as AuthorizedSession

const setRow = (overrides: Partial<ProjectSetRow> = {}): ProjectSetRow => ({
  id: SET,
  name: 'Bezirk 3',
  description: null,
  createdBy: 'user_1',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
  ...overrides,
})

const memberRow = (projectId: string, projectName: string): ProjectSetMemberRow => ({
  setId: SET,
  projectId,
  projectName,
  addedAt: new Date('2026-09-01T00:00:00.000Z'),
})

beforeEach(() => {
  vi.mocked(findProjectSetInOrg).mockResolvedValue(setRow())
  vi.mocked(listProjectSetsInOrg).mockResolvedValue([setRow()])
  vi.mocked(listProjectSetMembers).mockResolvedValue([])
  vi.mocked(listMembersOfProjectSets).mockResolvedValue([])
  vi.mocked(insertProjectSet).mockResolvedValue(setRow())
  vi.mocked(updateProjectSetRow).mockResolvedValue(setRow({ name: 'Bezirk 4' }))
  vi.mocked(deleteProjectSetRow).mockResolvedValue(true)
  vi.mocked(insertProjectSetMembers).mockResolvedValue(1)
  vi.mocked(deleteProjectSetMembers).mockResolvedValue(1)
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-viewer' } as never)
  // Readable by default; the tests that care narrow it.
  vi.mocked(filterReadableProjects).mockImplementation(
    async (_session, candidates) => [...candidates] as never
  )
})

afterEach(() => vi.clearAllMocks())

describe('org:chat gates the whole surface (spec AC-1, AC-2)', () => {
  const outsider = () => session({ permissions: [], role: 'restricted' })

  it('refuses every entry point to a member who may not use the Büro', async () => {
    await expect(listProjectSets(outsider())).rejects.toBeInstanceOf(ForbiddenError)
    await expect(getProjectSet(outsider(), SET)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(createProjectSet(outsider(), { name: 'x' })).rejects.toBeInstanceOf(ForbiddenError)
    await expect(deleteProjectSet(outsider(), SET)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(projectSetForMount(outsider(), SET)).rejects.toBeInstanceOf(ForbiddenError)
    // Nothing was even looked up: the refusal is about the surface, not the set.
    expect(findProjectSetInOrg).not.toHaveBeenCalled()
  })

  it('answers a set from another organization as if it did not exist', async () => {
    vi.mocked(findProjectSetInOrg).mockResolvedValue(null)
    await expect(getProjectSet(session(), SET)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('reading a Sammlung resolves its members per caller (spec AC-3, AC-4)', () => {
  it('hides a member this caller may not view, and counts only what is left', async () => {
    vi.mocked(listProjectSetMembers).mockResolvedValue([
      memberRow(PROJECT_A, 'Seestadt'),
      memberRow(PROJECT_B, 'Geheimprojekt'),
    ])
    vi.mocked(filterReadableProjects).mockResolvedValue([{ id: PROJECT_A }] as never)

    const detail = await getProjectSet(session(), SET)

    expect(detail.projects).toEqual([{ id: PROJECT_A, name: 'Seestadt' }])
    // `projectCount` is what the Büro would MOUNT, so it is the readable count
    // and not the row count — a UI measuring it against the cap is measuring
    // the right thing.
    expect(detail.projectCount).toBe(1)
    // A member must not learn a project name via a Sammlung.
    expect(JSON.stringify(detail)).not.toContain('Geheimprojekt')
  })

  it('asks about each project ONCE across a page of sets', async () => {
    const second = setRow({ id: 'set-2', name: 'Kunde Nord' })
    vi.mocked(listProjectSetsInOrg).mockResolvedValue([setRow(), second])
    vi.mocked(listMembersOfProjectSets).mockResolvedValue([
      memberRow(PROJECT_A, 'Seestadt'),
      { ...memberRow(PROJECT_A, 'Seestadt'), setId: 'set-2' },
      { ...memberRow(PROJECT_B, 'Nordbahnhof'), setId: 'set-2' },
    ])

    const sets = await listProjectSets(session())

    expect(sets.map((entry) => entry.projectCount)).toEqual([1, 2])
    // One member query and one readability pass over the DISTINCT projects: a
    // member on three projects looking at eight Sammlungen must not pay eight
    // times for the same three answers.
    expect(listMembersOfProjectSets).toHaveBeenCalledTimes(1)
    expect(filterReadableProjects).toHaveBeenCalledTimes(1)
    expect(filterReadableProjects).toHaveBeenCalledWith(expect.anything(), [
      { id: PROJECT_A },
      { id: PROJECT_B },
    ])
  })
})

describe('creating a Sammlung', () => {
  it('records the creator and trims the name', async () => {
    await createProjectSet(session(), { name: '  Bezirk 3  ', description: '  ' })

    expect(insertProjectSet).toHaveBeenCalledWith({
      organizationId: ORG,
      name: 'Bezirk 3',
      // A blank description is no description, not an empty string somebody
      // later has to render around.
      description: null,
      createdBy: 'user_1',
    })
  })

  it('refuses a blank or over-long name', async () => {
    await expect(createProjectSet(session(), { name: '   ' })).rejects.toBeInstanceOf(
      BadRequestError
    )
    await expect(
      createProjectSet(session(), { name: 'x'.repeat(PROJECT_SET_NAME_MAX + 1) })
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(insertProjectSet).not.toHaveBeenCalled()
  })

  it('turns the unique-name violation into a conflict a person can act on', async () => {
    // Wrapped the way drizzle wraps every driver failure: reading only the top
    // level is how this arrives at a user as an opaque 500.
    vi.mocked(insertProjectSet).mockRejectedValue(
      Object.assign(new Error('Failed query'), {
        cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
      })
    )

    const failure = await createProjectSet(session(), { name: 'Bezirk 3' }).catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(ConflictError)
    expect((failure as ConflictError).message).toContain('Bezirk 3')
  })

  it('lets an unrecognised database error through untouched', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: '08006' })
    vi.mocked(insertProjectSet).mockRejectedValue(boom)
    await expect(createProjectSet(session(), { name: 'Bezirk 3' })).rejects.toBe(boom)
  })
})

describe('who may change a Sammlung', () => {
  const stranger = () => session({ userId: 'user_other' })
  const orgAdmin = () =>
    session({ userId: 'user_other', permissions: ['org:chat', 'org:projects:administer'] })

  it('lets its creator rename, add, remove and delete', async () => {
    await updateProjectSet(session(), SET, { name: 'Bezirk 4' })
    await addProjectsToSet(session(), SET, [PROJECT_A])
    await removeProjectsFromSet(session(), SET, [PROJECT_A])
    await deleteProjectSet(session(), SET)

    expect(updateProjectSetRow).toHaveBeenCalled()
    expect(insertProjectSetMembers).toHaveBeenCalled()
    expect(deleteProjectSetMembers).toHaveBeenCalled()
    expect(deleteProjectSetRow).toHaveBeenCalled()
  })

  it('refuses another member, and tells them WHY rather than lying about existence', async () => {
    const failure = await updateProjectSet(stranger(), SET, { name: 'Bezirk 4' }).catch(
      (error: unknown) => error
    )

    // Forbidden, not NotFound: every member of the organization can see this
    // Sammlung, so a 404 would be a lie that costs them the reason.
    expect(failure).toBeInstanceOf(ForbiddenError)
    await expect(deleteProjectSet(stranger(), SET)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(addProjectsToSet(stranger(), SET, [PROJECT_A])).rejects.toBeInstanceOf(
      ForbiddenError
    )
    expect(updateProjectSetRow).not.toHaveBeenCalled()
    expect(deleteProjectSetRow).not.toHaveBeenCalled()
  })

  it('lets an org project administrator edit anybody’s Sammlung', async () => {
    // The PERMISSION `org:projects:administer`, never the role slug `admin`
    // (ADR-0038): a custom role holding it administers, a role merely named
    // admin does not.
    await updateProjectSet(orgAdmin(), SET, { description: 'Alle Projekte im 3. Bezirk' })
    expect(updateProjectSetRow).toHaveBeenCalled()
  })

  it('refuses an update that changes nothing', async () => {
    await expect(updateProjectSet(session(), SET, {})).rejects.toBeInstanceOf(BadRequestError)
    expect(updateProjectSetRow).not.toHaveBeenCalled()
  })

  it('reports a set deleted between the read and the write as gone', async () => {
    vi.mocked(updateProjectSetRow).mockResolvedValue(null)
    await expect(updateProjectSet(session(), SET, { name: 'x' })).rejects.toBeInstanceOf(
      NotFoundError
    )
  })
})

describe('what may go into a Sammlung', () => {
  it('demands project:view on every id and writes nothing when one fails', async () => {
    vi.mocked(requireProjectAccess).mockImplementation(async (_session, projectId) => {
      if (projectId === PROJECT_B) throw new NotFoundError()
      return { role: 'project-viewer' } as never
    })

    await expect(addProjectsToSet(session(), SET, [PROJECT_A, PROJECT_B])).rejects.toBeInstanceOf(
      NotFoundError
    )

    // All or nothing: a half-applied add leaves the caller believing the set
    // holds two projects when it holds one, and the two disagree on every mount
    // from then on.
    expect(insertProjectSetMembers).not.toHaveBeenCalled()
  })

  it('asks for project:view — the rung that reading a project’s documents sits on', async () => {
    await addProjectsToSet(session(), SET, [PROJECT_A])
    expect(requireProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      PROJECT_A,
      'project:view'
    )
  })

  it('de-duplicates the batch and refuses an empty one', async () => {
    await addProjectsToSet(session(), SET, [PROJECT_A, PROJECT_A])
    expect(insertProjectSetMembers).toHaveBeenCalledWith(SET, ORG, [PROJECT_A])

    await expect(addProjectsToSet(session(), SET, [])).rejects.toBeInstanceOf(BadRequestError)
  })

  it('needs no project permission to take something OUT', async () => {
    await removeProjectsFromSet(session(), SET, [PROJECT_A])

    // Narrowing a set edits the LABEL, not the project — so a member who has
    // since lost `project:view` on something in their own set can still remove
    // it. Same direction `unmountProject` takes.
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(deleteProjectSetMembers).toHaveBeenCalledWith(SET, ORG, [PROJECT_A])
  })
})

describe('projectSetForMount — the mount path gets the membership UNFILTERED', () => {
  it('hands over every member and leaves the three-way verdict to the mount', async () => {
    const members = [memberRow(PROJECT_A, 'Seestadt'), memberRow(PROJECT_B, 'Nordbahnhof')]
    vi.mocked(listProjectSetMembers).mockResolvedValue(members)

    const result = await projectSetForMount(session(), SET)

    // Filtering here would collapse "may view, may not chat" into "invisible"
    // and cost the caller the actionable half of the refusal.
    expect(result.members).toEqual(members)
    expect(filterReadableProjects).not.toHaveBeenCalled()
    expect(result.set.name).toBe('Bezirk 3')
  })
})

describe('the summary a client renders', () => {
  it('says whether THIS caller may edit the set', async () => {
    const mine = await getProjectSet(session(), SET)
    expect(mine.editable).toBe(true)

    const theirs = await getProjectSet(session({ userId: 'user_other' }), SET)
    expect(theirs.editable).toBe(false)
  })

  it('carries the instants as ISO-8601 strings', async () => {
    const detail = await getProjectSet(session(), SET)
    expect(detail.createdAt).toBe('2026-09-01T00:00:00.000Z')
    expect(detail.updatedAt).toBe('2026-09-02T00:00:00.000Z')
  })
})
