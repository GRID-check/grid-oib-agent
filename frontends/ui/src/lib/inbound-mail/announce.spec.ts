/**
 * @vitest-environment node
 *
 * Who hears that mail waits (D9, RT-S14), and what the row may say: the
 * project's name and a count, never the mail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/project-membership', () => ({ userHoldsProjectPermission: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn(async (rows: unknown[]) => rows.length) }))

import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { emitInboxItems, type InboxEmission } from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { announceWaiting, notifiesSender, type WaitingMail } from './announce'

const ORG = 'org_01ANNOUNCE'
const PROJECT = '0e5b4f2e-1d7c-4c3a-9a51-2f0d8c6b7a10'
const MEMBER = 'user_01HZX3Y4Z5A6B7C8D9E0F1G2H3'
const MANAGER = 'user_01HZX3Y4Z5A6B7C8D9E0F1G2M1'
const OTHER = 'user_01HZX3Y4Z5A6B7C8D9E0F1G2O1'

const mail = (overrides: Partial<WaitingMail> = {}): WaitingMail => ({
  organizationId: ORG,
  projectId: PROJECT,
  mailId: '3c2b1a00-0000-4000-8000-00000000a001',
  senderTrust: 'member_verified',
  senderUserId: MEMBER,
  senderFlags: [],
  automatic: false,
  ...overrides,
})

const emitted = () => (vi.mocked(emitInboxItems).mock.calls[0]?.[0] ?? []) as InboxEmission[]

beforeEach(() => {
  vi.mocked(findProjectInOrg).mockResolvedValue({ id: PROJECT, name: 'Wohnbau Hietzing' } as never)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([MEMBER, MANAGER, OTHER].map((userId) => [userId, { userId, email: null, name: userId, profilePictureUrl: null }])),
  )
  vi.mocked(userHoldsProjectPermission).mockImplementation(async (_session, _project, userId, permission) =>
    permission === 'project:view' ? userId !== OTHER : userId === MANAGER,
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('inbound_mail.waiting', () => {
  it('tells a verified member about their own mail to the project, and nobody else', async () => {
    await announceWaiting(mail())

    expect(emitted().map((row) => row.recipientUserId)).toEqual([MEMBER])
  })

  it('tells the member about their own Bcc copy, but the managers about a replay to someone else', () => {
    expect(notifiesSender(mail({ senderFlags: ['not_addressed_to_project', 'bcc_own'] }))).toBe(true)
    expect(notifiesSender(mail({ senderFlags: ['not_addressed_to_project'] }))).toBe(false)
  })

  it('never tells the member a mail with an unverified domain names: the managers hear of it (RT-S14)', async () => {
    await announceWaiting(mail({ senderTrust: 'member_unverified' }))

    expect(emitted().map((row) => row.recipientUserId)).toEqual([MANAGER])
  })

  it('tells the managers about a stranger’s mail, and about a member’s when the member may not read the project', async () => {
    await announceWaiting(mail({ senderTrust: 'external_verified', senderUserId: null }))
    expect(emitted().map((row) => row.recipientUserId)).toEqual([MANAGER])

    vi.mocked(emitInboxItems).mockClear()
    vi.mocked(userHoldsProjectPermission).mockImplementation(async (_s, _p, userId, permission) =>
      permission === 'project:manage' && userId === MANAGER,
    )
    await announceWaiting(mail())
    expect(emitted().map((row) => row.recipientUserId)).toEqual([MANAGER])
  })

  it('names the project and never the mail, and says when the domain is unconfirmed or the mail automatic', async () => {
    await announceWaiting(mail({ senderTrust: 'external_unverified', senderUserId: null }))
    await announceWaiting(mail({ automatic: true }))
    await announceWaiting(mail())

    const [unverified, automatic, verified] = vi.mocked(emitInboxItems).mock.calls.map(([rows]) => rows[0])
    expect(unverified.payload).toEqual({ subject: 'Wohnbau Hietzing', variant: 'unconfirmed' })
    expect(automatic.payload).toEqual({ subject: 'Wohnbau Hietzing', variant: 'unconfirmed' })
    expect(verified.payload).toEqual({ subject: 'Wohnbau Hietzing' })
    // One counted row per recipient and project, whatever the mail.
    expect(new Set([unverified, automatic, verified].map((row) => row.groupKey))).toEqual(
      new Set([`inbound_mail.waiting:project:${PROJECT}`]),
    )
    expect(verified).toMatchObject({ type: 'inbound_mail.waiting', resourceType: 'project', resourceId: PROJECT, actorUserId: null })
  })

  it('never throws into the job: a failed write costs a row, not the mail', async () => {
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(announceWaiting(mail())).resolves.toBe(false)
  })
})
