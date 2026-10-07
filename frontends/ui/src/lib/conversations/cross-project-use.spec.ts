/**
 * @vitest-environment node
 */
/**
 * The record a cross-project lookup writes before it answers (ADR-0085), with
 * the store mocked: the solo rule, read under the lock; the projects and
 * restricted folders recorded in one transaction; nothing recorded and a typed
 * refusal once the chat is not the asker's alone. And the memory writer's
 * refusal for such a conversation. Against Postgres:
 * `cross-project-use.integration.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationAudienceRow } from './restricted-use-repository'

vi.mock('server-only', () => ({}))

const ORG = 'org_1'
const CONV = 's_conv_1'
const OWNER = 'user_owner'
const OTHER = '22222222-0000-4000-8000-000000000002'
const HONORARE_ID = 'abcdef01-2345-4678-89ab-cdef01234567'

const state = vi.hoisted(() => ({
  audiences: [] as ConversationAudienceRow[],
  steps: [] as string[],
  recordedProjects: [] as string[],
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
  listRecordedSourceProjects: vi.fn(async () => [...state.recordedProjects]),
}))

import { CrossProjectMemoryError, CrossProjectSharedChatError } from '@/lib/api/errors'
import { isSoloAudience, recordCrossProjectHandOut, requireMayRememberFrom } from './cross-project-use'

const solo: ConversationAudienceRow = { exists: true, projectId: null, createdBy: OWNER, visibility: 'private', grantees: [] }
const party = { organizationId: ORG, userId: OWNER, conversationId: CONV }

beforeEach(() => {
  vi.clearAllMocks()
  state.audiences = [solo]
  state.steps = []
  state.recordedProjects = []
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

describe('recordCrossProjectHandOut', () => {
  it('records the projects and the restricted folders, deduplicated, after the solo check under the lock', async () => {
    await recordCrossProjectHandOut(party, { projectIds: [OTHER, OTHER], folderIds: [HONORARE_ID, HONORARE_ID] })

    expect(state.steps).toEqual(['lock', 'audience', `projects:${OTHER}`, `folders:${HONORARE_ID}`])
  })

  it('refuses with the typed 409 and records nothing once the chat is shared, as read under the lock', async () => {
    state.audiences = [{ ...solo, grantees: ['user_ina'] }]

    const error = await recordCrossProjectHandOut(party, { projectIds: [OTHER], folderIds: [] }).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(CrossProjectSharedChatError)
    expect((error as CrossProjectSharedChatError).status).toBe(409)
    expect((error as CrossProjectSharedChatError).message).toContain('neuen Chat')
    expect(state.steps).toEqual(['lock', 'audience'])
  })
})

describe('requireMayRememberFrom', () => {
  it('refuses a memory from a conversation that drew on another project, in German', async () => {
    state.recordedProjects = [OTHER]

    const error = await requireMayRememberFrom(CONV, ORG).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CrossProjectMemoryError)
    expect((error as CrossProjectMemoryError).status).toBe(409)
    expect((error as CrossProjectMemoryError).message).toContain('andere Projekte')
  })

  it('lets every other write through', async () => {
    await expect(requireMayRememberFrom(CONV, ORG)).resolves.toBeUndefined()
    await expect(requireMayRememberFrom(undefined, ORG)).resolves.toBeUndefined()
  })
})
