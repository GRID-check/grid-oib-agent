/**
 * @vitest-environment node
 */
/**
 * Which other projects a lookup may search: what EVERYONE who reads the
 * conversation may open (docs/design/cross-project-escalation.md). A solo chat
 * reaches what its asker may chat in, restricted folders included; a chat
 * shared with named people reaches the closed projects and the active ones
 * every one of them may open, no restricted folder; one visible to the project
 * reaches the closed projects alone; the reach carries the audience it was
 * computed for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { ConversationAudienceRow } from '@/lib/conversations/restricted-use-repository'
import type { Project } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))

const OWNER = 'user_owner'
const INA = 'user_ina'

const state = vi.hoisted(() => ({
  audience: null as unknown as ConversationAudienceRow,
  chat: [] as Project[],
  /** Who may open which project: `${userId}:${projectId}`. */
  opens: new Set<string>(),
  checks: 0,
}))

vi.mock('@/lib/db', () => ({ getDb: () => ({}) }))
vi.mock('@/lib/conversations/restricted-use-repository', () => ({
  readConversationAudience: vi.fn(async () => state.audience),
}))
vi.mock('@/lib/projects/service', () => ({ listChatProjects: vi.fn(async () => state.chat) }))
vi.mock('@/lib/authz/project-membership', () => ({
  userHoldsProjectPermission: vi.fn(async (_session: unknown, projectId: string, userId: string) => {
    state.checks += 1
    return state.opens.has(`${userId}:${projectId}`)
  }),
}))

import { audienceKey } from '@/lib/conversations/cross-project-use'
import { audienceReach, REACH_MAX_OTHER_READERS } from './audience-reach'

const session = { userId: OWNER, organizationId: 'org_1' } as AuthorizedSession
const solo: ConversationAudienceRow = { exists: true, projectId: 'own', createdBy: OWNER, visibility: 'private', grantees: [] }
const project = (id: string, status: 'active' | 'closed' = 'active') => ({ id, status }) as Project

beforeEach(() => {
  state.audience = solo
  state.chat = [project('own'), project('running'), project('foreign'), project('archive', 'closed')]
  state.opens = new Set()
  state.checks = 0
})

const ids = (projects: readonly Project[]) => projects.map((found) => found.id)

describe('audienceReach', () => {
  it('reaches everything the asker may chat in from a solo chat, restricted folders included', async () => {
    const reach = await audienceReach(session, 's_conv')

    expect(ids(reach.projects)).toEqual(['own', 'running', 'foreign', 'archive'])
    expect(reach).toMatchObject({ restrictedFolders: true, key: audienceKey(solo) })
    expect(state.checks).toBe(0)
  })

  it('reaches, from a chat shared with a colleague, the closed projects and the active ones the colleague may open', async () => {
    state.audience = { ...solo, grantees: [INA] }
    state.opens = new Set([`${INA}:running`])

    const reach = await audienceReach(session, 's_conv')

    expect(ids(reach.projects)).toEqual(['running', 'archive'])
    expect(reach).toMatchObject({ restrictedFolders: false, key: audienceKey(state.audience) })
  })

  it('reaches only the closed projects from a chat the project reads, asking nobody', async () => {
    state.audience = { ...solo, visibility: 'project' }

    const reach = await audienceReach(session, 's_conv')

    expect(ids(reach.projects)).toEqual(['archive'])
    expect(reach.restrictedFolders).toBe(false)
    expect(state.checks).toBe(0)
  })

  it('reaches only the closed projects when more people read the chat than it asks about', async () => {
    state.audience = { ...solo, grantees: Array.from({ length: REACH_MAX_OTHER_READERS + 1 }, (_, index) => `user_${index}`) }

    expect(ids((await audienceReach(session, 's_conv')).projects)).toEqual(['archive'])
    expect(state.checks).toBe(0)
  })

  it('counts the creator as a reader when a colleague asks in a chat shared with them', async () => {
    state.audience = { ...solo, createdBy: INA, grantees: [OWNER] }
    state.opens = new Set([`${INA}:foreign`])

    expect(ids((await audienceReach(session, 's_conv')).projects)).toEqual(['foreign', 'archive'])
  })
})
