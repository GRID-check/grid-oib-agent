/**
 * @vitest-environment node
 */
/**
 * The webhook's half of the project mail inbox: the order of work, which
 * answers carry the reject verdict (the only ones the Worker bounces), which
 * are retries, and the dedupe that answers before anything is stored.
 *
 * Sender verification and MIME selection have their own specs against real
 * mail; here they are switches. The database's own refusals (token unique,
 * delivery key unique per address) are `repository.integration.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

const scopes: string[] = []
vi.mock('@/lib/db/tenant-context', () => ({
  runWithTenantSlot: vi.fn((fn: () => unknown) => fn()),
  withTenant: vi.fn(async (scope: { organizationId: string }, fn: () => unknown) => {
    scopes.push(`tenant:${scope.organizationId}`)
    return await fn()
  }),
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => {
    scopes.push('platform')
    return await fn()
  }),
}))
vi.mock('./sender-auth', () => ({ verifySender: vi.fn() }))
vi.mock('./mime', () => ({ parseMail: vi.fn(), deliveryKey: vi.fn() }))
vi.mock('@/lib/mail-import/naming', () => ({ mailFolderName: vi.fn(() => '2026-09-30 10.15 – Anna Berger') }))
vi.mock('./job', () => ({ enqueueDelivery: vi.fn() }))
vi.mock('@/lib/storage/upload-limit', () => ({ assertFileSizeAllowed: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isProjectMailInboxEnabledForOrg: vi.fn() }))
vi.mock('@/lib/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/limits')>()),
  enforceLimit: vi.fn(),
}))
vi.mock('./repository', () => ({
  findActiveAddressByToken: vi.fn(),
  findDelivery: vi.fn(),
  queueDelivery: vi.fn(),
}))
vi.mock('./staging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./staging')>()),
  stageAttachments: vi.fn(),
  deleteStagedObjects: vi.fn(),
}))

import { FileTooLargeError, NotFoundError, TooManyRequestsError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { TransientAuthzError } from '@/lib/authz/errors'
import { requireProjectAccess } from '@/lib/authz/projects'
import { enforceLimit } from '@/lib/limits'
import { loadOrganizationDirectory, type DirectoryPerson } from '@/lib/sharing/directory'
import { assertFileSizeAllowed } from '@/lib/storage/upload-limit'
import { isProjectMailInboxEnabledForOrg } from '@/lib/workos/feature-flags'
import { enqueueDelivery } from './job'
import { deliveryKey, parseMail } from './mime'
import { findActiveAddressByToken, findDelivery, queueDelivery } from './repository'
import { MAX_MESSAGE_BYTES, receiveInboundMail } from './receive'
import { verifySender } from './sender-auth'
import { deleteStagedObjects, stageAttachments } from './staging'
import type { ParsedMail, SelectedAttachment } from './types'

const DOMAIN = 'piloti-post.at'
const TOKEN_A = 'abcdefgh2345'
const TOKEN_B = 'bbbbbbbb2345'
const ADDRESS_A = { addressId: 'addr-a', organizationId: 'org_A', projectId: 'project-a' }
const ADDRESS_B = { addressId: 'addr-b', organizationId: 'org_B', projectId: 'project-b' }
const KEY = 'a'.repeat(64)
const ANNA: DirectoryPerson = { userId: 'user-anna', email: 'Anna@Buero-A.at', name: 'Anna Berger', profilePictureUrl: null }

const attachment = (filename: string): SelectedAttachment => ({
  filename,
  contentType: 'application/pdf',
  content: new TextEncoder().encode(`%PDF ${filename}`),
  sha256: filename.padEnd(64, '0').slice(0, 64),
})

const MAIL: ParsedMail = {
  messageId: '<m1@buero-a.at>',
  subject: 'Pläne Bauteil A',
  fromName: 'Anna Berger',
  attachments: [attachment('Plan.pdf'), attachment('Statik.pdf')],
  skipped: [{ filename: 'image001.png', reason: 'embedded' }],
}

const sessionFor = (userId: string, organizationId: string) =>
  ({ userId, organizationId, organizationMembershipId: `om-${userId}`, permissions: [] }) as unknown as AuthorizedSession

/** A request whose body records whether anybody read it. */
function delivery(
  options: { to?: string | null; body?: Uint8Array | string; headers?: Record<string, string> } = {}
): { request: Request; bodyRead: () => boolean } {
  let read = false
  const bytes = typeof options.body === 'string' || options.body === undefined
    ? new TextEncoder().encode(options.body ?? 'From: anna@buero-a.at\r\n\r\nHallo\r\n')
    : options.body
  // highWaterMark 0: the stream pulls only when somebody reads, never to fill a queue.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read = true
        controller.enqueue(bytes)
        controller.close()
      },
    },
    { highWaterMark: 0 }
  )
  const headers: Record<string, string> = { ...options.headers }
  if (options.to !== null) headers['x-envelope-to'] = options.to ?? `wohnbau.${TOKEN_A}@${DOMAIN}`
  const request = new Request('https://grid.test/api/internal/inbound-mail', {
    method: 'POST',
    headers,
    body,
    ...({ duplex: 'half' } as RequestInit),
  })
  return { request, bodyRead: () => read }
}

const verdictOf = (response: Response) => response.headers.get('x-inbound-verdict')

let logs: { info: string[]; warn: string[]; error: string[] }

beforeEach(() => {
  vi.clearAllMocks()
  scopes.length = 0
  vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', DOMAIN)
  logs = { info: [], warn: [], error: [] }
  vi.spyOn(console, 'info').mockImplementation((line: string) => void logs.info.push(line))
  vi.spyOn(console, 'warn').mockImplementation((line: string) => void logs.warn.push(line))
  vi.spyOn(console, 'error').mockImplementation((line: string) => void logs.error.push(String(line)))

  vi.mocked(findActiveAddressByToken).mockImplementation(async (token) =>
    token === TOKEN_A ? ADDRESS_A : token === TOKEN_B ? ADDRESS_B : null
  )
  vi.mocked(isProjectMailInboxEnabledForOrg).mockResolvedValue(true)
  vi.mocked(verifySender).mockResolvedValue({ verdict: 'pass', fromAddress: 'anna@buero-a.at', fromName: 'Anna Berger' })
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map([[ANNA.userId, ANNA]]))
  vi.mocked(resolvePinnedRequesterSession).mockImplementation(async (requester) =>
    sessionFor(requester.userId, requester.organizationId)
  )
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' })
  vi.mocked(parseMail).mockResolvedValue(MAIL)
  vi.mocked(deliveryKey).mockReturnValue(KEY)
  vi.mocked(findDelivery).mockResolvedValue(null)
  vi.mocked(enforceLimit).mockResolvedValue({} as never)
  vi.mocked(stageAttachments).mockImplementation(async (where, attachments) => ({
    bucket: 'grid-documents',
    staged: attachments.map((a, i) => ({
      key: `org/${where.organizationId}/project/${where.projectId}/inbound-mail/${where.deliveryId}/${i + 1}`,
      filename: a.filename,
      contentType: a.contentType,
      sha256: a.sha256,
      size: a.content.byteLength,
    })),
  }))
  vi.mocked(deleteStagedObjects).mockResolvedValue([])
  vi.mocked(queueDelivery).mockImplementation(async (input) => input.id)
  vi.mocked(assertFileSizeAllowed).mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('accepting a mail', () => {
  it('stages the selected attachments under the project prefix, queues the row and answers 202', async () => {
    const response = await receiveInboundMail(delivery().request)

    expect(response.status).toBe(202)
    expect(verdictOf(response)).toBeNull()
    expect(await response.json()).toEqual({ status: 'queued', files: 2, skipped: 1 })

    const [where, staged] = vi.mocked(stageAttachments).mock.calls[0]
    expect(where).toMatchObject({ organizationId: 'org_A', projectId: 'project-a' })
    expect(staged).toEqual(MAIL.attachments)
    const row = vi.mocked(queueDelivery).mock.calls[0][0]
    expect(row).toMatchObject({
      ...ADDRESS_A,
      id: where.deliveryId,
      deliveryKey: KEY,
      senderUserId: 'user-anna',
      folderName: '2026-09-30 10.15 – Anna Berger',
      subject: 'Pläne Bauteil A',
      stagingBucket: 'grid-documents',
      skipped: [{ filename: 'image001.png', reason: 'embedded' }],
    })
    expect(row.staged.map((s) => s.key)).toEqual([
      `org/org_A/project/project-a/inbound-mail/${where.deliveryId}/1`,
      `org/org_A/project/project-a/inbound-mail/${where.deliveryId}/2`,
    ])
    expect(deleteStagedObjects).not.toHaveBeenCalled()
    // ...and hands the row to a job on the BFF's queue, in the address's organization.
    expect(enqueueDelivery).toHaveBeenCalledWith('org_A', { deliveryId: where.deliveryId, projectId: 'project-a' })
  })

  it('still answers 202 when the job could not be enqueued: the row is durable, the sweep enqueues one', async () => {
    vi.mocked(enqueueDelivery).mockRejectedValueOnce(new Error('database gone'))

    const response = await receiveInboundMail(delivery().request)

    expect(response.status).toBe(202)
    expect(deleteStagedObjects).not.toHaveBeenCalled()
    expect(logs.warn).toEqual([expect.stringContaining('the filing job was not enqueued')])
  })

  it('skips an attachment over the organization’s upload limit as size, before staging it', async () => {
    vi.mocked(assertFileSizeAllowed).mockImplementation(async (_org, size, filename) => {
      if (filename === MAIL.attachments[1].filename) throw new FileTooLargeError({ fileSize: size, maxSizeBytes: 1 })
    })

    const response = await receiveInboundMail(delivery().request)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'queued', files: 1, skipped: 2 })
    expect(assertFileSizeAllowed).toHaveBeenCalledWith('org_A', MAIL.attachments[0].content.byteLength, MAIL.attachments[0].filename)
    expect(vi.mocked(stageAttachments).mock.calls[0][1]).toEqual([MAIL.attachments[0]])
    expect(vi.mocked(queueDelivery).mock.calls[0][0].skipped).toEqual([
      { filename: 'image001.png', reason: 'embedded' },
      { filename: MAIL.attachments[1].filename, reason: 'size' },
    ])
    // The key is the whole mail's: the limit does not decide what a redelivery is.
    expect(deliveryKey).toHaveBeenCalledWith(MAIL.messageId, MAIL.attachments.map((a) => a.sha256))
  })

  it('retries when the upload limit could not be read', async () => {
    vi.mocked(assertFileSizeAllowed).mockRejectedValueOnce(new Error('database gone'))

    const response = await receiveInboundMail(delivery().request)

    expect(response.status).toBe(503)
    expect(stageAttachments).not.toHaveBeenCalled()
  })

  it('takes the twelve steps in order: token before body, switch before body, dedupe before budgets', async () => {
    const order: string[] = []
    vi.mocked(findActiveAddressByToken).mockImplementation(async () => (order.push('token'), ADDRESS_A))
    vi.mocked(isProjectMailInboxEnabledForOrg).mockImplementation(async () => (order.push('switch'), true))
    vi.mocked(verifySender).mockImplementation(async () => {
      order.push('verify')
      return { verdict: 'pass', fromAddress: 'anna@buero-a.at', fromName: null }
    })
    vi.mocked(requireProjectAccess).mockImplementation(async () => (order.push('permission'), { role: 'project-editor' }))
    vi.mocked(parseMail).mockImplementation(async () => (order.push('parse'), MAIL))
    vi.mocked(findDelivery).mockImplementation(async () => (order.push('dedupe'), null))
    vi.mocked(enforceLimit).mockImplementation(async () => (order.push('limit'), {} as never))
    vi.mocked(stageAttachments).mockImplementation(async () => (order.push('stage'), { bucket: 'b', staged: [] }))
    vi.mocked(queueDelivery).mockImplementation(async (input) => (order.push('queue'), input.id))

    const { request, bodyRead } = delivery()
    const readAt: string[] = []
    const response = await receiveInboundMail(
      new Proxy(request, {
        get(target, prop) {
          if (prop === 'body') readAt.push(order.at(-1) ?? 'start')
          const value = Reflect.get(target, prop)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    )

    expect(response.status).toBe(202)
    expect(bodyRead()).toBe(true)
    expect(order).toEqual(['token', 'switch', 'verify', 'permission', 'parse', 'dedupe', 'limit', 'limit', 'stage', 'queue'])
    // The body was first touched after the switch and before the sender.
    expect(readAt[0]).toBe('switch')
    expect(scopes).toEqual(['platform', 'tenant:org_A'])
  })

  it('never reads the body of a mail to an unknown token', async () => {
    const { request, bodyRead } = delivery({ to: `wohnbau.zzzzzzzzzzzz@${DOMAIN}` })
    const response = await receiveInboundMail(request)
    expect(response.status).toBe(404)
    expect(bodyRead()).toBe(false)
    expect(verifySender).not.toHaveBeenCalled()
  })

  it('never reads the body while the organization switch is off', async () => {
    vi.mocked(isProjectMailInboxEnabledForOrg).mockResolvedValue(false)
    const { request, bodyRead } = delivery()
    const response = await receiveInboundMail(request)
    expect(response.status).toBe(404)
    expect(verdictOf(response)).toBe('reject')
    expect(bodyRead()).toBe(false)
  })

  it('writes one PII-free log line per delivery', async () => {
    await receiveInboundMail(delivery().request)
    expect(logs.info).toHaveLength(1)
    const [line] = logs.info
    expect(line).toMatch(/^\[inbound-mail\] outcome=accepted address=addr-a row=[0-9a-f-]{36} files=2 skipped=1 ms=\d+$/)
    expect(line).not.toMatch(/anna|Pläne|Plan\.pdf/i)
  })
})

describe('the reject verdict: permanent refusals only', () => {
  const cases: [string, () => void, number, Parameters<typeof delivery>[0]?][] = [
    ['an unknown or revoked token', () => vi.mocked(findActiveAddressByToken).mockResolvedValue(null), 404],
    ['an address in our domain with no token in it', () => undefined, 404, { to: `wohnbau.nope@${DOMAIN}` }],
    ['the organization switch off', () => vi.mocked(isProjectMailInboxEnabledForOrg).mockResolvedValue(false), 404],
    ['a declared size over the cap', () => undefined, 413, { headers: { 'x-inbound-raw-size': String(MAX_MESSAGE_BYTES + 1) } }],
    ['a sender verification fail', () => vi.mocked(verifySender).mockResolvedValue({ verdict: 'fail', reason: 'dkim' }), 403],
    ['a sender who is not a member', () => vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map([['x', { ...ANNA, userId: 'x', email: 'x@y.at' }]])), 403],
    ['a member who left since the roster was cached', () => vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null), 403],
    ['a member without document write', () => vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError()), 403],
  ]
  for (const [label, arrange, status, options] of cases) {
    it(`${label}: ${status} with x-inbound-verdict: reject, a WARN, nothing stored`, async () => {
      arrange()
      const response = await receiveInboundMail(delivery(options).request)
      expect(response.status).toBe(status)
      expect(verdictOf(response)).toBe('reject')
      expect(stageAttachments).not.toHaveBeenCalled()
      expect(queueDelivery).not.toHaveBeenCalled()
      expect(logs.warn).toEqual([expect.stringMatching(/^\[inbound-mail\] outcome=refused-/)])
    })
  }

  it('refuses a stream over the cap when no size was declared', async () => {
    const response = await receiveInboundMail(delivery({ body: new Uint8Array(MAX_MESSAGE_BYTES + 1) }).request)
    expect(response.status).toBe(413)
    expect(verdictOf(response)).toBe('reject')
  })

  it('retries, never bounces, a body bigger than the small size the Worker declared', async () => {
    // The header is the Worker's claim; a mismatch is our bug, not the sender's.
    const response = await receiveInboundMail(
      delivery({ body: new Uint8Array(2 * 1024 * 1024), headers: { 'x-inbound-raw-size': '10' } }).request
    )
    expect(response.status).toBe(503)
    expect(verdictOf(response)).toBeNull()
  })

  it('compares the sender with ASCII lowercasing only', async () => {
    // U+212A KELVIN SIGN lowercases to `k` under Unicode rules, not ASCII ones.
    vi.mocked(verifySender).mockResolvedValue({ verdict: 'pass', fromAddress: 'anna@buero-a.at', fromName: null })
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([['user-k', { ...ANNA, userId: 'user-k', email: 'anna@buero-a.at' }]])
    )
    expect((await receiveInboundMail(delivery().request)).status).toBe(202)
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([['user-k', { ...ANNA, userId: 'user-k', email: 'anna@buero-Ka.at' }]])
    )
    vi.mocked(verifySender).mockResolvedValue({ verdict: 'pass', fromAddress: 'anna@buero-ka.at', fromName: null })
    expect((await receiveInboundMail(delivery().request)).status).toBe(403)
  })
})

describe('retries: no verdict header, so the sending server tries again', () => {
  const retries: [string, () => void, number, Parameters<typeof delivery>[0]?][] = [
    ['a foreign domain (routing is misconfigured)', () => undefined, 503, { to: 'wohnbau.abcdefgh2345@example.com' }],
    ['an unset inbound domain', () => vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', ''), 503],
    ['a missing recipient header', () => undefined, 503, { to: null }],
    ['a DNS temperror', () => vi.mocked(verifySender).mockResolvedValue({ verdict: 'temperror', reason: 'dns' }), 503],
    ['a switch that could not be read', () => vi.mocked(isProjectMailInboxEnabledForOrg).mockRejectedValue(new TransientAuthzError('feature-flags')), 503],
    ['an FGA check that could not complete', () => vi.mocked(requireProjectAccess).mockRejectedValue(new TransientAuthzError('fga-check')), 503],
    ['a membership lookup that could not complete', () => vi.mocked(resolvePinnedRequesterSession).mockRejectedValue(new TransientAuthzError('membership')), 503],
    ['a roster that could not be read', () => vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map()), 503],
    ['a spent budget', () => vi.mocked(enforceLimit).mockRejectedValue(new TooManyRequestsError({ allowed: false, rule: 'inbound-mail-address', remaining: 0, limit: 60, retryAfterSeconds: 60, degraded: false })), 429],
  ]
  for (const [label, arrange, status, options] of retries) {
    it(`${label}: ${status}`, async () => {
      arrange()
      const response = await receiveInboundMail(delivery(options).request)
      expect(response.status).toBe(status)
      expect(verdictOf(response)).toBeNull()
      expect(queueDelivery).not.toHaveBeenCalled()
    })
  }

  it('logs a misconfigured domain at ERROR', async () => {
    vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', '')
    await receiveInboundMail(delivery().request)
    expect(logs.error).toEqual([expect.stringContaining('outcome=retry-config')])
  })

  it('answers a database error with 503, logs its class and never its message, and deletes the staging', async () => {
    const drizzle = new Error('Failed query: insert into inbound_mail_messages params: anna@buero-a.at,Pläne')
    vi.mocked(queueDelivery).mockRejectedValue(drizzle)

    const response = await receiveInboundMail(delivery().request)

    expect(response.status).toBe(503)
    expect(verdictOf(response)).toBeNull()
    expect(deleteStagedObjects).toHaveBeenCalledWith('grid-documents', expect.arrayContaining([expect.objectContaining({ filename: 'Plan.pdf' })]))
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join('\n')
    expect(logged).toContain('outcome=retry-error')
    expect(logged).toContain('error=Error')
    expect(logged).not.toContain('Failed query')
    expect(logged).not.toContain('anna@')
  })

  it('holds at most two large parses at once; the third is a 503', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.mocked(verifySender).mockImplementation(async () => {
      await gate
      return { verdict: 'pass', fromAddress: 'anna@buero-a.at', fromName: null }
    })
    const large = () => delivery({ body: new Uint8Array(2 * 1024 * 1024) }).request

    const first = receiveInboundMail(large())
    const second = receiveInboundMail(large())
    await vi.waitFor(() => expect(verifySender).toHaveBeenCalledTimes(2))
    // The slot is taken on the declared size, before a byte is read.
    const refused = delivery({ body: new Uint8Array(2 * 1024 * 1024) })
    const third = await receiveInboundMail(refused.request)
    expect(third.status).toBe(503)
    expect(verdictOf(third)).toBeNull()
    expect(refused.bodyRead()).toBe(false)

    // A mail declared small does not wait for a slot.
    const smallBody = new TextEncoder().encode('From: anna@buero-a.at\r\n\r\nHallo\r\n')
    const small = receiveInboundMail(
      delivery({ body: smallBody, headers: { 'x-inbound-raw-size': String(smallBody.byteLength) } }).request
    )
    release()
    expect((await first).status).toBe(202)
    expect((await second).status).toBe(202)
    expect((await small).status).toBe(202)
    // The slots are free again.
    expect((await receiveInboundMail(large())).status).toBe(202)
  })
})

describe('dedupe', () => {
  for (const status of ['queued', 'filed'] as const) {
    it(`answers a mail already ${status} with 200, staging nothing and spending no budget`, async () => {
      vi.mocked(findDelivery).mockResolvedValue({ id: 'row-1', status })
      const response = await receiveInboundMail(delivery().request)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'duplicate' })
      expect(stageAttachments).not.toHaveBeenCalled()
      expect(enforceLimit).not.toHaveBeenCalled()
      expect(queueDelivery).not.toHaveBeenCalled()
      expect(logs.info).toEqual([expect.stringContaining('outcome=duplicate address=addr-a row=row-1')])
    })
  }

  it('queues a mail again whose earlier delivery was given up on', async () => {
    vi.mocked(findDelivery).mockResolvedValue({ id: 'row-1', status: 'failed' })
    vi.mocked(queueDelivery).mockResolvedValue('row-1')
    const response = await receiveInboundMail(delivery().request)
    expect(response.status).toBe(202)
    expect(stageAttachments).toHaveBeenCalled()
  })

  it('answers 200 and deletes its own staging when a concurrent delivery queued the mail first', async () => {
    vi.mocked(queueDelivery).mockResolvedValue(null)
    const response = await receiveInboundMail(delivery().request)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'duplicate' })
    expect(deleteStagedObjects).toHaveBeenCalledTimes(1)
  })

  it('keys the dedupe by the Message-ID and the attachment digests', async () => {
    await receiveInboundMail(delivery().request)
    expect(deliveryKey).toHaveBeenCalledWith('<m1@buero-a.at>', MAIL.attachments.map((a) => a.sha256))
    expect(findDelivery).toHaveBeenCalledWith('addr-a', KEY)
  })
})

describe('the Chinese wall', () => {
  it('a mail to org A’s token is decided, staged and queued inside org A only', async () => {
    await receiveInboundMail(delivery().request)
    expect(scopes).toEqual(['platform', 'tenant:org_A'])
    expect(loadOrganizationDirectory).toHaveBeenCalledWith('org_A')
    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_A' }),
      { onError: 'throw' }
    )
  })

  it('one mail to two organizations is two deliveries, each queued in its own', async () => {
    vi.mocked(loadOrganizationDirectory).mockImplementation(async (org) =>
      new Map([[`anna-${org}`, { ...ANNA, userId: `anna-${org}` }]])
    )
    const a = await receiveInboundMail(delivery({ to: `wohnbau.${TOKEN_A}@${DOMAIN}` }).request)
    const b = await receiveInboundMail(delivery({ to: `wohnbau.${TOKEN_B}@${DOMAIN}` }).request)

    expect([a.status, b.status]).toEqual([202, 202])
    const rows = vi.mocked(queueDelivery).mock.calls.map(([row]) => row)
    expect(rows.map((row) => [row.organizationId, row.addressId, row.senderUserId])).toEqual([
      ['org_A', 'addr-a', 'anna-org_A'],
      ['org_B', 'addr-b', 'anna-org_B'],
    ])
    expect(rows[0].deliveryKey).toBe(rows[1].deliveryKey)
  })

  it('a member of org B only, mailing org A’s address, is refused permanently', async () => {
    vi.mocked(loadOrganizationDirectory).mockImplementation(async (org) =>
      org === 'org_B' ? new Map([[ANNA.userId, ANNA]]) : new Map([['other', { ...ANNA, userId: 'other', email: 'o@a.at' }]])
    )
    const response = await receiveInboundMail(delivery().request)
    expect(response.status).toBe(403)
    expect(verdictOf(response)).toBe('reject')
    expect(loadOrganizationDirectory).toHaveBeenCalledWith('org_A')
    expect(loadOrganizationDirectory).not.toHaveBeenCalledWith('org_B')
  })

  it('asks for document write with the throwing lookup, the gate uploadDocument applies', async () => {
    await receiveInboundMail(delivery().request)
    expect(requireProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-anna', organizationId: 'org_A' }),
      'project-a',
      ['project:documents:write', 'project:edit'],
      { onError: 'throw' }
    )
  })
})
