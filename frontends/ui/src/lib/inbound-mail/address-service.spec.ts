/**
 * @vitest-environment node
 */
/**
 * A project's address (ADR-0135): reading never mints one (the PR this ports
 * did, so a read wrote); creating is idempotent; replacing and switching off
 * end every follow on the project, in the trail as the person who did it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const store = vi.hoisted(() => ({ active: null as unknown, domain: 'piloti.at' as string | null }))

vi.mock('./access', () => ({
  requireMailReviewer: vi.fn(async () => ({ closed: false })),
  requireAddressManager: vi.fn(async () => undefined),
  managesProject: vi.fn(async () => true),
}))
vi.mock('./address', async () => {
  const actual = await vi.importActual<typeof import('./address')>('./address')
  return { ...actual, inboundMailDomain: () => store.domain, mintToken: () => 'abcdefgh2345' }
})
vi.mock('./repository', () => ({
  findActiveAddress: vi.fn(async () => store.active),
  addressActivity: vi.fn(async () => ({ lastReceivedAt: null, droppedLast30Days: 2 })),
  ownDomainVerifiedShare: vi.fn(async () => 0.75),
  insertAddress: vi.fn(async (input: { token: string; slug: string }) => {
    store.active = { id: 'addr-1', ...input }
    return { ok: true, value: store.active }
  }),
  replaceAddress: vi.fn(async (input: { token: string; slug: string }) => {
    store.active = { id: 'addr-2', ...input }
    return {
      ok: true,
      value: { row: store.active, previousAddressId: 'addr-1', followsEnded: [{ id: 'f-1', threadId: 't-1', userId: 'user_01JCX0R4D8M2W6YB3N5Q7T9V1B' }] },
    }
  }),
  switchOffAddress: vi.fn(async () => {
    store.active = null
    return { previousAddressId: 'addr-2', followsEnded: [] }
  }),
}))
vi.mock('./audit', () => ({ auditFollowsEnded: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn(async () => ({ name: 'Wohnhaus Mödling' })) }))
vi.mock('@/lib/audit/after-commit', () => ({ recordAuditEventAfterCommit: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/realtime/door-events', () => ({ publishProjectChanged: vi.fn() }))

import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  createInboundMailAddress,
  deleteInboundMailAddress,
  getInboundMailAddress,
  rotateInboundMailAddress,
} from './address-service'
import { auditFollowsEnded } from './audit'
import { insertAddress } from './repository'

const session = { userId: 'user_01JCX0R4D8M2W6YB3N5Q7T9V1A', organizationId: 'org_1', email: 'm@example.test' } as AuthorizedSession
const PROJECT = '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

beforeEach(() => {
  vi.clearAllMocks()
  store.active = null
  store.domain = 'piloti.at'
})

describe('the project address', () => {
  it('is read without minting one: "none" until a manager creates it', async () => {
    expect(await getInboundMailAddress(session, PROJECT)).toEqual({
      state: 'none',
      address: null,
      canManage: true,
      lastReceivedAt: null,
      droppedLast30Days: 2,
      ownDomainVerifiedShare: 0.75,
    })
    expect(insertAddress).not.toHaveBeenCalled()
  })

  it('says "unavailable" where the deployment receives no mail, and refuses to create one there', async () => {
    store.domain = null
    expect((await getInboundMailAddress(session, PROJECT)).state).toBe('unavailable')
    await expect(createInboundMailAddress(session, PROJECT)).rejects.toMatchObject({ details: { reason: 'mail_not_received_here' } })
  })

  it('is created once, under the project’s slug, and a second create answers the same one', async () => {
    expect((await createInboundMailAddress(session, PROJECT)).address).toBe('wohnhaus-moedling.abcdefgh2345@piloti.at')
    expect(await createInboundMailAddress(session, PROJECT)).toMatchObject({ state: 'active' })
    expect(insertAddress).toHaveBeenCalledTimes(1)
    expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(expect.objectContaining({ action: 'inbound_mail_address.created' }))
  })

  it('is replaced with the follows it ended in the trail', async () => {
    await rotateInboundMailAddress(session, PROJECT)
    expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'inbound_mail_address.rotated',
        metadata: { projectId: PROJECT, previousAddressId: 'addr-1', followsEnded: 1 },
      }),
    )
    expect(auditFollowsEnded).toHaveBeenCalledWith('org_1', PROJECT, session.userId, [expect.objectContaining({ id: 'f-1' })])
  })

  it('is switched off, and switching off nothing changes nothing', async () => {
    expect((await deleteInboundMailAddress(session, PROJECT)).state).toBe('none')
    expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(expect.objectContaining({ action: 'inbound_mail_address.deleted', targetId: 'addr-2' }))
  })
})
