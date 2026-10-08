/**
 * @vitest-environment node
 */
/**
 * The record a cross-project lookup writes before it answers (ADR-0093), with
 * the store mocked: the audience the reach was computed for, compared under
 * the lock; the projects and restricted folders recorded in one transaction;
 * nothing recorded and a typed refusal once the audience changed. And the
 * memory writer's refusal for a conversation that drew on a running project. Against Postgres:
 * `cross-project-use.integration.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationAudienceRow } from './restricted-use-repository'

vi.mock('server-only', () => ({}))

const ORG = 'org_1'
const CONV = 's_conv_1'
const OWNER = 'user_owner'
const OTHER = '22222222-0000-4000-8000-000000000002'
const OWN = '11111111-0000-4000-8000-000000000001'
const HONORARE_ID = 'abcdef01-2345-4678-89ab-cdef01234567'
const ANSWER = '5a5a5a5a-0000-4000-8000-000000000001'

const state = vi.hoisted(() => ({
  audiences: [] as ConversationAudienceRow[],
  steps: [] as string[],
  recordedProjects: [] as string[],
  recordedFolders: [] as string[],
  folderProjects: new Map<string, string>(),
  names: new Map<string, string>(),
  nameQueries: [] as string[][],
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({ transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }) }),
}))
vi.mock('./restricted-use-repository', () => ({
  lockConversationAudience: vi.fn(async () => {
    state.steps.push('lock')
  }),
  readConversationAudience: vi.fn(async () => {
    state.steps.push('audience')
    return state.audiences.length > 1 ? state.audiences.shift()! : state.audiences[0]
  }),
  recordSourceProjects: vi.fn(async (_tx: unknown, _org: string, _id: string, ids: string[]) => {
    state.steps.push(`projects:${ids.join(',')}`)
  }),
  recordSourceFolders: vi.fn(async (_tx: unknown, _org: string, _id: string, ids: string[]) => {
    state.steps.push(`folders:${ids.join(',')}`)
  }),
  markAnswerRestrictedUse: vi.fn(async (tx: unknown, _org: string, _id: string, messageId: string) => {
    state.steps.push(`mark:${messageId}:${JSON.stringify(tx)}`)
  }),
  listRestrictingSourceProjects: vi.fn(async () => [...state.recordedProjects]),
  listRecordedSourceFolders: vi.fn(async () => [...state.recordedFolders]),
  projectsOfFolders: vi.fn(async (_db: unknown, _org: string, ids: readonly string[]) => {
    return new Map(ids.flatMap((id) => (state.folderProjects.has(id) ? [[id, state.folderProjects.get(id)!] as const] : [])))
  }),
  listProjectNames: vi.fn(async (_db: unknown, _org: string, ids: string[]) => {
    state.nameQueries.push([...ids])
    return new Map(ids.filter((id) => state.names.has(id)).map((id) => [id, state.names.get(id)!]))
  }),
}))

import { CrossProjectAudienceChangedError, CrossProjectMemoryError } from '@/lib/api/errors'
import {
  audienceKey,
  drewOnOtherProjects,
  isSoloAudience,
  recordCrossProjectHandOut,
  restrictingOtherProjects,
  requireMayRememberFrom,
} from './cross-project-use'

const solo: ConversationAudienceRow = { exists: true, projectId: null, createdBy: OWNER, visibility: 'private', grantees: [] }
const party = { organizationId: ORG, userId: OWNER, conversationId: CONV }

beforeEach(() => {
  vi.clearAllMocks()
  state.audiences = [solo]
  state.steps = []
  state.recordedProjects = []
  state.recordedFolders = []
  state.folderProjects = new Map()
})

describe('isSoloAudience', () => {
  it.each([
    ['a chat that does not exist yet', { ...solo, exists: false, createdBy: null }, true],
    ['the asker’s private chat', solo, true],
    ['one the asker is also listed on', { ...solo, grantees: [OWNER] }, true],
    ['one shared with a colleague', { ...solo, grantees: ['user_ina'] }, false],
    ['one visible to the project', { ...solo, visibility: 'project' as const }, false],
    ['somebody else’s', { ...solo, createdBy: 'user_ina' }, false],
  ])('%s → %s', (_label, audience, expected) => {
    expect(isSoloAudience(audience, OWNER)).toBe(expected)
  })
})

describe('audienceKey', () => {
  it('is the same for the same readers, whatever the grant order, and differs for any other', () => {
    const shared = { ...solo, grantees: ['user_b', 'user_a'] }
    expect(audienceKey(shared)).toBe(audienceKey({ ...solo, grantees: ['user_a', 'user_b'] }))
    expect(audienceKey(shared)).not.toBe(audienceKey(solo))
    expect(audienceKey({ ...solo, visibility: 'project' })).not.toBe(audienceKey(solo))
    expect(audienceKey({ ...solo, exists: false, createdBy: null })).toBe('new')
  })
})

describe('recordCrossProjectHandOut', () => {
  it('records the projects and the restricted folders, deduplicated, after the audience check under the lock', async () => {
    await recordCrossProjectHandOut(
      party,
      { projectIds: [OTHER, OTHER], folderIds: [HONORARE_ID, HONORARE_ID] },
      audienceKey(solo)
    )

    expect(state.steps).toEqual(['lock', 'audience', `projects:${OTHER}`, `folders:${HONORARE_ID}`])
  })

  it('marks the answer the turn is writing in the same transaction, after the record (ADR-0092)', async () => {
    await recordCrossProjectHandOut(
      { ...party, answerMessageId: ANSWER },
      { projectIds: [OTHER], folderIds: [HONORARE_ID] },
      audienceKey(solo)
    )

    // In the transaction (`{ tx: true }`), after the folder: the database marks
    // it only when the conversation now holds a restricted-use record, so open
    // content of another project marks nothing (cross-project-use.integration.spec.ts).
    expect(state.steps).toEqual([
      'lock',
      'audience',
      `projects:${OTHER}`,
      `folders:${HONORARE_ID}`,
      `mark:${ANSWER}:{"tx":true}`,
    ])
  })

  it('marks nothing without an answer id, and nothing when the chat is refused', async () => {
    await recordCrossProjectHandOut(party, { projectIds: [OTHER], folderIds: [HONORARE_ID] }, audienceKey(solo))
    state.audiences = [{ ...solo, grantees: ['user_ina'] }]
    const refused = recordCrossProjectHandOut(
      { ...party, answerMessageId: ANSWER },
      { projectIds: [OTHER], folderIds: [] },
      audienceKey(solo)
    )
    await refused.catch(() => undefined)

    expect(state.steps.filter((step) => step.startsWith('mark:'))).toEqual([])
  })

  it('records into a shared chat whose readers are the ones the reach was computed for', async () => {
    const shared = { ...solo, grantees: ['user_ina'] }
    state.audiences = [shared]

    await recordCrossProjectHandOut(party, { projectIds: [OTHER], folderIds: [] }, audienceKey(shared))

    expect(state.steps).toEqual(['lock', 'audience', `projects:${OTHER}`, 'folders:'])
  })

  it('records into a chat its first turn created mid-lookup, still the asker’s alone', async () => {
    await recordCrossProjectHandOut(party, { projectIds: [OTHER], folderIds: [] }, 'new')

    expect(state.steps).toContain(`projects:${OTHER}`)
  })

  it('refuses with the typed 409 and records nothing once the audience changed, as read under the lock', async () => {
    state.audiences = [{ ...solo, grantees: ['user_ina'] }]

    const error = await recordCrossProjectHandOut(party, { projectIds: [OTHER], folderIds: [] }, audienceKey(solo)).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(CrossProjectAudienceChangedError)
    expect((error as CrossProjectAudienceChangedError).status).toBe(409)
    expect((error as CrossProjectAudienceChangedError).message).toContain('noch einmal')
    expect(state.steps).toEqual(['lock', 'audience'])
  })
})

describe('requireMayRememberFrom', () => {
  it('refuses a memory from a conversation that drew on a running project, in German', async () => {
    state.recordedProjects = [OTHER]

    const error = await requireMayRememberFrom(CONV, ORG).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CrossProjectMemoryError)
    expect((error as CrossProjectMemoryError).status).toBe(409)
    expect((error as CrossProjectMemoryError).message).toContain('laufende andere Projekte')
  })

  it('refuses one that drew on a restricted folder of another project, closed or not (ADR-0089)', async () => {
    // The project is closed (not restricting), the folder of it still is: the
    // agent's own restriction evidence only knows this project's folders.
    state.audiences = [{ ...solo, projectId: OWN }]
    state.recordedFolders = [HONORARE_ID]
    state.folderProjects = new Map([[HONORARE_ID, OTHER]])

    await expect(requireMayRememberFrom(CONV, ORG)).rejects.toBeInstanceOf(CrossProjectMemoryError)
  })

  it('leaves a restricted folder of the conversation’s own project to the restricted-use record', async () => {
    state.audiences = [{ ...solo, projectId: OWN }]
    state.recordedFolders = [HONORARE_ID]
    state.folderProjects = new Map([[HONORARE_ID, OWN]])

    await expect(requireMayRememberFrom(CONV, ORG)).resolves.toBeUndefined()
  })

  it('lets every other write through', async () => {
    await expect(requireMayRememberFrom(CONV, ORG)).resolves.toBeUndefined()
    await expect(requireMayRememberFrom(undefined, ORG)).resolves.toBeUndefined()
  })
})

describe('drewOnOtherProjects', () => {
  it('is true for a restricting project, or for a restricted folder of another project, and false for neither', async () => {
    state.audiences = [{ ...solo, projectId: OWN }]
    expect(await drewOnOtherProjects(CONV, ORG)).toBe(false)

    state.recordedProjects = [OTHER]
    expect(await drewOnOtherProjects(CONV, ORG)).toBe(true)

    state.recordedProjects = []
    state.recordedFolders = [HONORARE_ID]
    state.folderProjects = new Map([[HONORARE_ID, OTHER]])
    expect(await drewOnOtherProjects(CONV, ORG)).toBe(true)
  })
})

describe('restrictingOtherProjects', () => {
  const LINZ = '33333333-0000-4000-8000-000000000003'
  const GONE = '44444444-0000-4000-8000-000000000004'

  beforeEach(() => {
    state.audiences = [{ ...solo, projectId: OWN }]
    state.names = new Map([
      [OTHER, 'Wohnbau Graz'],
      [LINZ, 'Schule Linz'],
    ])
    state.nameQueries = []
  })

  it('is empty exactly when drewOnOtherProjects is false, and asks for no names then', async () => {
    expect(await restrictingOtherProjects(CONV, ORG)).toEqual([])
    expect(await drewOnOtherProjects(CONV, ORG)).toBe(false)
    expect(state.nameQueries).toEqual([[]])
  })

  it('lists a recorded project that restricts, named', async () => {
    state.recordedProjects = [LINZ]

    expect(await restrictingOtherProjects(CONV, ORG)).toEqual([{ id: LINZ, name: 'Schule Linz' }])
  })

  it('lists the project that owns a recorded restricted folder, although the project is closed and not in the restricting record', async () => {
    state.recordedFolders = [HONORARE_ID]
    state.folderProjects = new Map([[HONORARE_ID, OTHER]])

    expect(await restrictingOtherProjects(CONV, ORG)).toEqual([{ id: OTHER, name: 'Wohnbau Graz' }])
    expect(await drewOnOtherProjects(CONV, ORG)).toBe(true)
  })

  it('does not list the conversation’s own project for a folder of its own', async () => {
    state.recordedFolders = [HONORARE_ID]
    state.folderProjects = new Map([[HONORARE_ID, OWN]])

    expect(await restrictingOtherProjects(CONV, ORG)).toEqual([])
    expect(await drewOnOtherProjects(CONV, ORG)).toBe(false)
  })

  it('names a project once when the record and a folder both say it, sorted by name', async () => {
    state.recordedProjects = [LINZ, OTHER]
    state.recordedFolders = [HONORARE_ID]
    state.folderProjects = new Map([[HONORARE_ID, OTHER]])

    expect((await restrictingOtherProjects(CONV, ORG)).map((project) => project.name)).toEqual([
      'Schule Linz',
      'Wohnbau Graz',
    ])
  })

  it('keeps a project that is deleted or gone, nameless, because it still restricts', async () => {
    state.recordedProjects = [GONE]

    expect(await restrictingOtherProjects(CONV, ORG)).toEqual([{ id: GONE, name: null }])
  })

  it('counts a restricted folder no project holds any more, standing in nameless for its project', async () => {
    state.recordedFolders = [HONORARE_ID]

    const found = await restrictingOtherProjects(CONV, ORG)

    expect(found).toEqual([{ id: HONORARE_ID, name: null }])
    expect(await drewOnOtherProjects(CONV, ORG)).toBe(true)
  })
})
