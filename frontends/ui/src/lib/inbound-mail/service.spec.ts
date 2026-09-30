/**
 * @vitest-environment node
 */
/**
 * Filing a mail, end to end at the service seam: the token resolution, the
 * sender's membership in ONE organization, the permission on ONE project, the
 * idempotency record and the upload path. The repository is an in-memory fake
 * with the same keys the migration declares (token unique, message unique per
 * ADDRESS), so the Chinese-wall cases exercise the real lookups' shape; the
 * database's own refusal is `repository.integration.spec.ts`.
 *
 * Sender verification is its own spec against real DKIM signatures; here it is
 * a switch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const tenantCalls: string[] = []
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (scope: { organizationId: string }, fn: () => unknown) => {
    tenantCalls.push(scope.organizationId)
    return await fn()
  }),
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => await fn()),
}))
vi.mock('./sender-auth', () => ({ verifySender: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({ userHoldsProjectPermission: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/documents/service', () => ({ uploadDocument: vi.fn() }))
vi.mock('@/lib/projects/folder-service', () => ({ ensureProjectFolderPaths: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn() }))
vi.mock('@/lib/limits', () => ({
  enforceLimit: vi.fn(),
  INBOUND_MAIL_ADDRESS_LIMIT: { name: 'inbound-mail-address', limit: 60, windowMs: 3_600_000 },
  INBOUND_MAIL_ORG_LIMIT: { name: 'inbound-mail-org', limit: 600, windowMs: 3_600_000 },
}))

/* ------------------------------------------------------------------------- */
/* The in-memory repository                                                  */
/* ------------------------------------------------------------------------- */

interface FakeAddress {
  id: string
  organizationId: string
  projectId: string
  token: string
  slug: string
  revokedAt: Date | null
}
interface FakeMessage {
  id: string
  addressId: string
  hash: string
  status: 'processing' | 'filed' | 'failed'
  filedCount: number
  updatedAt: Date
}
const store = { addresses: [] as FakeAddress[], messages: [] as FakeMessage[] }

vi.mock('./repository', () => ({
  STALE_PROCESSING_MS: 15 * 60 * 1000,
  findActiveAddressByToken: vi.fn(async (token: string) => {
    const row = store.addresses.find((a) => a.token === token && !a.revokedAt)
    return row ? { addressId: row.id, organizationId: row.organizationId, projectId: row.projectId } : null
  }),
  findActiveAddressForProject: vi.fn(async (organizationId: string, projectId: string) => {
    return (
      store.addresses.find(
        (a) => a.organizationId === organizationId && a.projectId === projectId && !a.revokedAt
      ) ?? null
    )
  }),
  insertAddress: vi.fn(async (input: Omit<FakeAddress, 'id' | 'revokedAt'>) => {
    const row = { ...input, id: `addr-${store.addresses.length + 1}`, revokedAt: null }
    store.addresses.push(row)
    return { ok: true, row }
  }),
  rotateAddress: vi.fn(async (input: Omit<FakeAddress, 'id' | 'revokedAt'>) => {
    for (const a of store.addresses) {
      if (a.projectId === input.projectId && a.organizationId === input.organizationId && !a.revokedAt) {
        a.revokedAt = new Date()
      }
    }
    const row = { ...input, id: `addr-${store.addresses.length + 1}`, revokedAt: null }
    store.addresses.push(row)
    return { ok: true, row }
  }),
  claimMessage: vi.fn(async (input: { addressId: string; messageIdHash: string }, now = new Date()) => {
    const existing = store.messages.find((m) => m.addressId === input.addressId && m.hash === input.messageIdHash)
    if (!existing) {
      const row: FakeMessage = {
        id: `msg-${store.messages.length + 1}`,
        addressId: input.addressId,
        hash: input.messageIdHash,
        status: 'processing',
        filedCount: 0,
        updatedAt: now,
      }
      store.messages.push(row)
      return { kind: 'claimed', messageRowId: row.id }
    }
    if (existing.status === 'filed') {
      return { kind: 'duplicate', messageRowId: existing.id, filedCount: existing.filedCount }
    }
    const stale = now.getTime() - existing.updatedAt.getTime() > 15 * 60 * 1000
    if (existing.status === 'failed' || stale) {
      existing.status = 'processing'
      existing.updatedAt = now
      return { kind: 'claimed', messageRowId: existing.id }
    }
    return { kind: 'busy' }
  }),
  markMessageFiled: vi.fn(async (id: string, outcome: { filedCount: number }) => {
    const row = store.messages.find((m) => m.id === id)
    if (row) Object.assign(row, { status: 'filed', filedCount: outcome.filedCount })
  }),
  markMessageFailed: vi.fn(async (id: string) => {
    const row = store.messages.find((m) => m.id === id)
    if (row) row.status = 'failed'
  }),
}))

import { BadRequestError, InsufficientStorageError, NotFoundError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { requireProjectAccess } from '@/lib/authz/projects'
import { uploadDocument } from '@/lib/documents/service'
import { emitInboxItems } from '@/lib/inbox/service'
import { enforceLimit } from '@/lib/limits'
import { ensureProjectFolderPaths } from '@/lib/projects/folder-service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory, type DirectoryPerson } from '@/lib/sharing/directory'
import type { Project } from '@/lib/db/schema'
import { TooManyRequestsError } from '@/lib/api/errors'
import { findActiveAddressByToken } from './repository'
import { verifySender } from './sender-auth'
import {
  getInboundAddress,
  messageHash,
  receiveInboundMail,
  refusalReason,
  rotateInboundAddress,
  tokenForRecipient,
  type InboundMailResult,
} from './service'

/* ------------------------------------------------------------------------- */
/* The world: two organizations whose projects share a name                  */
/* ------------------------------------------------------------------------- */

const DOMAIN = 'piloti-post.at'
const ORG_A = 'org_A'
const ORG_B = 'org_B'
const PROJECT_A = 'project-a'
const PROJECT_B = 'project-b'

const people: Record<string, DirectoryPerson[]> = {
  [ORG_A]: [{ userId: 'user-anna', email: 'anna@buero-a.at', name: 'Anna', profilePictureUrl: null }],
  [ORG_B]: [
    { userId: 'user-anna', email: 'anna@buero-a.at', name: 'Anna', profilePictureUrl: null },
    { userId: 'user-bert', email: 'bert@buero-b.at', name: 'Bert', profilePictureUrl: null },
  ],
}

/** Who holds which project permission, by `${userId}:${projectId}`. */
let grants: Record<string, string[]> = {}

function sessionFor(userId: string, organizationId: string): AuthorizedSession {
  return {
    userId,
    email: '',
    name: null,
    accessToken: '',
    organizationId,
    organizationMembershipId: `om-${userId}-${organizationId}`,
    role: 'member',
    permissions: [],
    featureFlags: null,
  } as AuthorizedSession
}

function mail(options: { from?: string; messageId?: string | null; files?: string[] } = {}): Uint8Array {
  const boundary = 'b'
  const headers = [
    `From: ${options.from ?? 'Anna <anna@buero-a.at>'}`,
    'To: wohnbau.aaaaaaaaaaaa@piloti-post.at',
    'Subject: Pläne',
    'Date: Mon, 28 Sep 2026 10:15:00 +0200',
    ...(options.messageId === null ? [] : [`Message-ID: ${options.messageId ?? '<m1@buero-a.at>'}`]),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ]
  const lines = [...headers, '', `--${boundary}`, 'Content-Type: text/plain', '', 'Hallo']
  for (const name of options.files ?? ['Plan.pdf']) {
    lines.push(
      `--${boundary}`,
      'Content-Type: application/pdf',
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(`%PDF ${name}`).toString('base64')
    )
  }
  lines.push(`--${boundary}--`, '')
  return new Uint8Array(Buffer.from(lines.join('\r\n')))
}

const request = new Request('https://grid.test/api/internal/inbound-mail', { method: 'POST' })

/** What the route does: token → platform lookup → tenant scope → service. */
async function deliver(envelopeTo: string, raw: Uint8Array): Promise<InboundMailResult> {
  const token = tokenForRecipient(envelopeTo)
  const address = await findActiveAddressByToken(token)
  if (!address) throw new NotFoundError('Unknown address')
  return receiveInboundMail(address, raw, request)
}

function uploadedOrgs(): string[] {
  return vi.mocked(uploadDocument).mock.calls.map(([session]) => session.organizationId)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', DOMAIN)
  tenantCalls.length = 0
  store.messages = []
  // Both projects are called „Wohnbau", so both addresses carry the slug
  // `wohnbau`. Only the token tells them apart.
  store.addresses = [
    { id: 'addr-a', organizationId: ORG_A, projectId: PROJECT_A, token: 'aaaaaaaaaaaa', slug: 'wohnbau', revokedAt: null },
    { id: 'addr-b', organizationId: ORG_B, projectId: PROJECT_B, token: 'bbbbbbbbbbbb', slug: 'wohnbau', revokedAt: null },
  ]
  grants = {
    [`user-anna:${PROJECT_A}`]: ['project:documents:write'],
    [`user-anna:${PROJECT_B}`]: ['project:edit'],
    [`user-bert:${PROJECT_B}`]: ['project:documents:write'],
  }

  vi.mocked(verifySender).mockImplementation(async (raw) => {
    const from = /^From:.*?<?([^<>\s]+@[^<>\s]+)>?\s*$/m.exec(Buffer.from(raw).toString())
    return { verified: true, fromAddress: (from?.[1] ?? '').toLowerCase(), via: 'aligned-dkim' }
  })
  vi.mocked(loadOrganizationDirectory).mockImplementation(
    async (organizationId) => new Map((people[organizationId] ?? []).map((p) => [p.userId, p]))
  )
  vi.mocked(resolvePinnedRequesterSession).mockImplementation(async ({ userId, organizationId }) =>
    (people[organizationId] ?? []).some((p) => p.userId === userId) ? sessionFor(userId, organizationId) : null
  )
  vi.mocked(userHoldsProjectPermission).mockImplementation(async (session, projectId, userId, permission) =>
    (grants[`${userId}:${projectId}`] ?? []).includes(permission)
  )
  vi.mocked(ensureProjectFolderPaths).mockImplementation(async (input) => ({
    ok: true,
    folders: [],
    folderIdByPath: Object.fromEntries(input.paths.map((path) => [path, `folder-${input.projectId}`])),
  }))
  vi.mocked(uploadDocument).mockImplementation(async (_session, input) => ({
    documentId: `doc-${input.file.name}`,
    jobId: null,
    status: 'uploaded',
    filename: input.file.name,
  }))
  vi.mocked(findProjectInOrg).mockImplementation(
    async (projectId) => ({ id: projectId, name: 'Wohnbau' }) as Project
  )
  vi.mocked(emitInboxItems).mockResolvedValue(1)
  vi.mocked(enforceLimit).mockResolvedValue({
    allowed: true,
    rule: 'x',
    remaining: 1,
    limit: 1,
    retryAfterSeconds: 0,
    degraded: false,
  })
})

/* ------------------------------------------------------------------------- */

describe('receiving a mail', () => {
  it('files every attachment as the sender, into the mail folder, and tells them', async () => {
    const result = await deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail({ files: ['Plan.pdf', 'Plan.pdf'] }))

    expect(result).toEqual({ status: 'filed', filed: 2, skipped: [] })
    const [session, input] = vi.mocked(uploadDocument).mock.calls[0]
    expect(session).toMatchObject({ userId: 'user-anna', organizationId: ORG_A })
    expect(input).toMatchObject({ projectId: PROJECT_A, folderId: `folder-${PROJECT_A}` })
    expect(vi.mocked(uploadDocument).mock.calls.map(([, i]) => i.file.name)).toEqual(['Plan.pdf', 'Plan (2).pdf'])
    expect(vi.mocked(ensureProjectFolderPaths).mock.calls[0][0].paths).toEqual([
      'E-Mail-Eingang/2026-09-28 Pläne – Anna',
    ])

    const [emission] = vi.mocked(emitInboxItems).mock.calls[0][0]
    expect(emission).toMatchObject({
      organizationId: ORG_A,
      recipientUserId: 'user-anna',
      type: 'inbound_mail.filed',
      resourceType: 'project',
      resourceId: PROJECT_A,
      actorUserId: null,
      payload: { subject: 'Pläne', folderId: `folder-${PROJECT_A}`, params: { filed: 2, skipped: 0, project: 'Wohnbau' } },
    })
  })

  it('turns uploadDocument refusals into per-file skips without failing the mail', async () => {
    vi.mocked(uploadDocument).mockImplementation(async (_s, input) => {
      if (input.file.name === 'setup.exe') throw new BadRequestError('File type "exe" is not permitted', { extension: 'exe', accepted: ['pdf'] })
      if (input.file.name === 'huge.pdf') throw new BadRequestError('too big', { fileSize: 2, maxSizeBytes: 1 })
      if (input.file.name === 'full.pdf') throw new InsufficientStorageError()
      return { documentId: 'd', jobId: null, status: 'uploaded', filename: input.file.name }
    })

    const result = await deliver(
      `aaaaaaaaaaaa@${DOMAIN}`,
      mail({ files: ['Plan.pdf', 'setup.exe', 'huge.pdf', 'full.pdf'] })
    )

    expect(result.filed).toBe(1)
    expect(result.skipped).toEqual([
      { filename: 'setup.exe', reason: 'type' },
      { filename: 'huge.pdf', reason: 'size' },
      { filename: 'full.pdf', reason: 'quota' },
    ])
    expect(store.messages[0].status).toBe('filed')
  })

  it('answers 404 for a revoked token, a foreign domain and an unknown token alike', async () => {
    store.addresses[0].revokedAt = new Date()
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 404 })
    await expect(deliver('wohnbau.bbbbbbbbbbbb@example.com', mail())).rejects.toMatchObject({ status: 404 })
    await expect(deliver(`wohnbau.cccccccccccc@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 404 })
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('answers 404 when the feature is switched off', async () => {
    vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', '')
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 404 })
  })

  it('refuses an unverified sender with 403 and touches nothing', async () => {
    vi.mocked(verifySender).mockResolvedValue({ verified: false, reason: 'dkim-unaligned' })
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 403 })
    expect(loadOrganizationDirectory).not.toHaveBeenCalled()
    expect(store.messages).toEqual([])
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('answers 503, not 403, when the roster could not be read (so the sender retries)', async () => {
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 503 })
  })

  it('spends the address and organization budgets only for an authorized sender', async () => {
    await deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())
    expect(vi.mocked(enforceLimit).mock.calls.map(([rule, subject]) => [rule.name, subject])).toEqual([
      ['inbound-mail-address', `${ORG_A}:addr-a`],
      ['inbound-mail-org', ORG_A],
    ])

    vi.mocked(enforceLimit).mockClear()
    vi.mocked(verifySender).mockResolvedValue({ verified: false, reason: 'no-dkim-pass' })
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 403 })
    expect(enforceLimit).not.toHaveBeenCalled()
  })

  it('answers 429 over budget, before claiming the message', async () => {
    vi.mocked(enforceLimit).mockRejectedValueOnce(
      new TooManyRequestsError({ allowed: false, rule: 'inbound-mail-address', remaining: 0, limit: 60, retryAfterSeconds: 30, degraded: false })
    )
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 429 })
    expect(store.messages).toEqual([])
  })

  it('files a mail without attachments as nothing, creates no folder, and still tells the sender', async () => {
    const result = await deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail({ files: [] }))
    expect(result).toEqual({ status: 'filed', filed: 0, skipped: [] })
    expect(ensureProjectFolderPaths).not.toHaveBeenCalled()
    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0].payload).toMatchObject({ folderId: null })
  })

  it('does not fail the mail when the notification cannot be written', async () => {
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('inbox down'))
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).resolves.toMatchObject({ filed: 1 })
  })
})

describe('the Chinese wall', () => {
  it('(1) two orgs whose projects share a slug: a mail to org A’s token touches nothing in org B', async () => {
    await deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())

    expect(tenantCalls.every((org) => org === ORG_A)).toBe(true)
    expect(vi.mocked(loadOrganizationDirectory).mock.calls.map(([org]) => org)).toEqual([ORG_A])
    expect(vi.mocked(resolvePinnedRequesterSession).mock.calls.map(([r]) => r.organizationId)).toEqual([ORG_A])
    expect(vi.mocked(userHoldsProjectPermission).mock.calls.every(([s, p]) => s.organizationId === ORG_A && p === PROJECT_A)).toBe(true)
    expect(uploadedOrgs()).toEqual([ORG_A])
    expect(vi.mocked(uploadDocument).mock.calls[0][1].projectId).toBe(PROJECT_A)
    expect(store.messages.map((m) => m.addressId)).toEqual(['addr-a'])
  })

  it('(2) one mail CC’d to two tokens in two orgs is filed in both', async () => {
    const raw = mail({ messageId: '<same@buero-a.at>' })

    const first = await deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, raw)
    const second = await deliver(`wohnbau.bbbbbbbbbbbb@${DOMAIN}`, raw)

    expect(first.duplicate).toBeUndefined()
    expect(second.duplicate).toBeUndefined()
    expect(uploadedOrgs()).toEqual([ORG_A, ORG_B])
    expect(store.messages.map((m) => [m.addressId, m.status])).toEqual([
      ['addr-a', 'filed'],
      ['addr-b', 'filed'],
    ])
  })

  it('(3) a member of org B only, mailing org A’s address, is refused', async () => {
    const raw = mail({ from: 'Bert <bert@buero-b.at>' })
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, raw)).rejects.toMatchObject({ status: 403 })

    // The roster asked was org A's — never org B's, where Bert exists.
    expect(vi.mocked(loadOrganizationDirectory).mock.calls.map(([org]) => org)).toEqual([ORG_A])
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(store.messages).toEqual([])
  })

  it('(4) a member with only view permission is refused', async () => {
    grants[`user-anna:${PROJECT_A}`] = ['project:view']
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 403 })
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('accepts the legacy project:edit umbrella in place of documents:write', async () => {
    grants[`user-anna:${PROJECT_A}`] = ['project:edit']
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).resolves.toMatchObject({ filed: 1 })
  })

  it('refuses a member who left the organization since (no pinned session)', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 403 })
  })
})

describe('idempotency', () => {
  it('answers a redelivery of a filed mail as a duplicate and files nothing', async () => {
    const raw = mail()
    await deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, raw)
    vi.mocked(uploadDocument).mockClear()

    const again = await deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, raw)

    expect(again).toEqual({ status: 'filed', filed: 1, skipped: [], duplicate: true })
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(emitInboxItems).toHaveBeenCalledTimes(1)
  })

  it('re-runs a delivery that failed', async () => {
    const raw = mail()
    vi.mocked(uploadDocument).mockRejectedValueOnce(new Error('SeaweedFS unreachable'))

    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, raw)).rejects.toThrow('SeaweedFS unreachable')
    expect(store.messages[0].status).toBe('failed')

    const retry = await deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, raw)
    expect(retry).toEqual({ status: 'filed', filed: 1, skipped: [] })
    expect(store.messages).toHaveLength(1)
    expect(store.messages[0].status).toBe('filed')
  })

  it('answers 409 while another delivery of the same mail is still filing', async () => {
    store.messages.push({
      id: 'msg-x',
      addressId: 'addr-a',
      hash: messageHash('<m1@buero-a.at>', new Uint8Array()),
      status: 'processing',
      filedCount: 0,
      updatedAt: new Date(),
    })
    await expect(deliver(`wohnbau.aaaaaaaaaaaa@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 409 })
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('hashes the Message-ID, or the raw bytes when there is none', () => {
    const raw = mail({ messageId: null })
    expect(messageHash('<a@b>', raw)).toBe(messageHash('<a@b>', new Uint8Array([1, 2, 3])))
    expect(messageHash(null, raw)).not.toBe(messageHash(null, mail({ messageId: null, files: ['x.pdf'] })))
    expect(messageHash(null, raw)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('refusalReason', () => {
  it('maps refusals and lets real failures through', () => {
    expect(refusalReason(new InsufficientStorageError())).toBe('quota')
    expect(refusalReason(new BadRequestError('x', { maxSizeBytes: 1 }))).toBe('size')
    expect(refusalReason(new BadRequestError('x', { extension: 'exe' }))).toBe('type')
    expect(refusalReason(new NotFoundError())).toBe('rejected')
    expect(refusalReason(new Error('boom'))).toBeNull()
  })
})

describe('the project address', () => {
  const editor = sessionFor('user-anna', ORG_A)

  it('mints lazily on first read, then returns the same address', async () => {
    store.addresses = []
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' })

    const first = await getInboundAddress(editor, PROJECT_A)
    const second = await getInboundAddress(editor, PROJECT_A)

    expect(first.enabled).toBe(true)
    expect(first.canRotate).toBe(false)
    expect(first.address).toMatch(/^wohnbau\.[a-z2-7]{12}@eingang\.piloti\.at$/)
    expect(second.address).toBe(first.address)
    expect(store.addresses).toHaveLength(1)
    expect(requireProjectAccess).toHaveBeenCalledWith(editor, PROJECT_A, ['project:documents:write', 'project:edit'])
  })

  it('offers rotation to whoever holds project:manage', async () => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    expect((await getInboundAddress(editor, PROJECT_A)).canRotate).toBe(true)
  })

  it('reports disabled, and mints nothing, without a domain', async () => {
    vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', '')
    store.addresses = []
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' })
    expect(await getInboundAddress(editor, PROJECT_A)).toEqual({ enabled: false, address: null, canRotate: false })
    expect(store.addresses).toEqual([])
  })

  it('refuses a caller without write access (the access check throws 404)', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    await expect(getInboundAddress(editor, PROJECT_A)).rejects.toMatchObject({ status: 404 })
  })

  it('rotation requires project:manage, revokes the old token and mints a new one', async () => {
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-admin' })
    const oldToken = store.addresses[0].token

    const { address } = await rotateInboundAddress(editor, PROJECT_A)

    expect(requireProjectAccess).toHaveBeenCalledWith(editor, PROJECT_A, 'project:manage')
    expect(address).not.toContain(oldToken)
    // The old token is now the same as an unknown one.
    await expect(deliver(`wohnbau.${oldToken}@${DOMAIN}`, mail())).rejects.toMatchObject({ status: 404 })
    await expect(deliver(address, mail())).resolves.toMatchObject({ filed: 1 })
  })
})
