/**
 * @vitest-environment node
 *
 * The inbound-mail webhook end to end through the route factory: requests
 * signed by the maintained library (`@/test-utils/signed-request`), the
 * transport's real parsers and checks, the database and the object store
 * stood in for. What these hold:
 *
 * - the gate order of DECISION §6 (Receive): nothing past a refusal runs, and
 *   no byte of the body is read before every gate before the body passed;
 * - the verdict contract (`shared/inbound-mail-contract.json`): only an unknown
 *   address, an office switched off and a message too large answer a 4xx with
 *   `x-inbound-verdict: reject`, the one answer the Worker bounces; everything
 *   else is retried by the sending server;
 * - a second delivery answers 200 and leaves no second copy;
 * - the NEGATIVE: the webhook judges no sender. A mail whose DKIM signature
 *   fails is accepted (202) and held like any other; review decides, never the
 *   transport.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/inbound-mail/repository', () => ({
  findActiveAddressByToken: vi.fn(),
  stagedBytes: vi.fn(),
  insertReception: vi.fn(),
  findMailIdByDeliveryKey: vi.fn(),
  completeReception: vi.fn(),
  forgetReceptionObject: vi.fn(),
}))
vi.mock('@/lib/inbound-mail/staging', () => ({
  stagingBucketFor: vi.fn(),
  putRawMessage: vi.fn(),
  eraseStagedObjects: vi.fn(),
}))
vi.mock('@/lib/workos/feature-flags', () => ({ enabledFlagsForOrganization: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))

import { createInProcessStore, setLimitStore } from '@/lib/limits/store'
import { captureServer } from '@/lib/analytics/posthog-server'
import { deliveryOutcome, VERDICT_HEADER } from '@/lib/inbound-mail/contract'
import { deliveryKey } from '@/lib/inbound-mail/mime'
import {
  completeReception,
  findActiveAddressByToken,
  findMailIdByDeliveryKey,
  forgetReceptionObject,
  insertReception,
  stagedBytes,
} from '@/lib/inbound-mail/repository'
import { eraseStagedObjects, putRawMessage, stagingBucketFor } from '@/lib/inbound-mail/staging'
import { enabledFlagsForOrganization } from '@/lib/workos/feature-flags'
import { signedRequest, TEST_KEY_ID, TEST_SIGNING_SECRET, type SignedRequestOptions } from '@/test-utils/signed-request'
import { POST } from './route'

const NOW = new Date('2026-10-22T12:00:00Z')
const URL_SIGNED = 'https://app.piloti.test/api/internal/signed/inbound-mail'
const ORG = 'org_01MAILTEST'
const PROJECT = '0e5b4f2e-1d7c-4c3a-9a51-2f0d8c6b7a10'
const ADDRESS = '7a1f5c3e-8b2d-4e6f-9a0b-1c2d3e4f5a6b'
const RECIPIENT = 'wohnbau-hietzing.k3m7q2xw4pab@piloti.at'
const SENDER = 'sekretariat@statik-weber.at'
const MESSAGE =
  'From: Statik Weber <sekretariat@statik-weber.at>\r\n' +
  `To: ${RECIPIENT}\r\n` +
  'Subject: Plan S-101 Index C\r\n' +
  'Date: Thu, 22 Oct 2026 11:58:00 +0000\r\n' +
  'Message-ID: <abc123@statik-weber.at>\r\n' +
  '\r\n' +
  'Anbei der Plan.\r\n'

const CONTRACT = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'shared', 'inbound-mail-contract.json'), 'utf8')) as {
  rejectText: string
}

/** What each step was asked, in order, so the gate order can be read off one array. */
const calls: string[] = []
/** The bytes the store received. */
let stored: Uint8Array | null = null

function sign(overrides: Partial<SignedRequestOptions> = {}, envelope: Record<string, string> = {}) {
  return signedRequest({
    url: URL_SIGNED,
    body: MESSAGE,
    created: NOW,
    headers: { 'x-envelope-to': RECIPIENT, 'x-envelope-from': SENDER, ...envelope },
    ...overrides,
  })
}

/** The INFO lines (the per-delivery operator trail), through the spy rather than `console`. */
let infoSpy: ReturnType<typeof vi.spyOn>
const infoLines = () => infoSpy

beforeEach(() => {
  calls.length = 0
  stored = null
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  vi.stubEnv('GRID_INBOUND_MAIL_SIGNING_KEYS', JSON.stringify({ [TEST_KEY_ID]: TEST_SIGNING_SECRET }))
  vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', 'piloti.at')
  vi.stubEnv('GRID_INBOUND_MAIL_PAUSED', 'false')
  vi.stubEnv('WORKOS_REDIRECT_URI', '')
  vi.stubEnv('REQUIRE_AUTH', 'true')
  setLimitStore(createInProcessStore())
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  vi.mocked(findActiveAddressByToken).mockImplementation(async (token) => {
    calls.push(`address:${token}`)
    return token === 'k3m7q2xw4pab' ? { addressId: ADDRESS, organizationId: ORG, projectId: PROJECT } : null
  })
  vi.mocked(enabledFlagsForOrganization).mockImplementation(async () => {
    calls.push('flags')
    return ['inbound-mail']
  })
  vi.mocked(stagedBytes).mockImplementation(async () => {
    calls.push('staged-bytes')
    return { address: 0, organization: 0 }
  })
  vi.mocked(stagingBucketFor).mockImplementation(async () => {
    calls.push('bucket')
    return 'grid-org-test'
  })
  vi.mocked(insertReception).mockImplementation(async () => {
    calls.push('insert')
  })
  vi.mocked(putRawMessage).mockImplementation(async (_bucket, _key, body) => {
    calls.push('store')
    const chunks: Uint8Array[] = []
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk)
    stored = new Uint8Array(Buffer.concat(chunks))
  })
  vi.mocked(findMailIdByDeliveryKey).mockImplementation(async () => {
    calls.push('dedupe')
    return null
  })
  vi.mocked(completeReception).mockImplementation(async () => {
    calls.push('received')
    return 'received'
  })
  vi.mocked(eraseStagedObjects).mockResolvedValue([])
})

afterEach(() => {
  setLimitStore(null)
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/internal/signed/inbound-mail', () => {
  it('holds a signed delivery: staged whole, queued once, 202, in the order of DECISION §6', async () => {
    const response = await POST(await sign())

    expect(response.status).toBe(202)
    expect(response.headers.get(VERDICT_HEADER)).toBeNull()
    expect(await response.json()).toEqual({ status: 'accepted' })
    expect(calls).toEqual(['address:k3m7q2xw4pab', 'flags', 'staged-bytes', 'bucket', 'insert', 'store', 'dedupe', 'received'])
    expect(Buffer.from(stored ?? []).toString()).toBe(MESSAGE)

    const reception = vi.mocked(insertReception).mock.calls[0][0]
    expect(reception).toMatchObject({
      organizationId: ORG,
      projectId: PROJECT,
      addressId: ADDRESS,
      envelopeFrom: SENDER,
      rawSizeBytes: Buffer.byteLength(MESSAGE),
      stagingBucket: 'grid-org-test',
      rawStorageKey: `org/${ORG}/project/${PROJECT}/_inbound-mail/${reception.id}/raw.eml`,
    })
    expect(reception.expiresAt.getTime() - (reception.receivedAt as Date).getTime()).toBe(30 * 24 * 60 * 60 * 1000)
    expect(vi.mocked(completeReception).mock.calls[0][0]).toMatchObject({
      mailId: reception.id,
      deliveryKey: deliveryKey(new Uint8Array(Buffer.from(MESSAGE))),
      rawSizeBytes: Buffer.byteLength(MESSAGE),
    })
  })

  it('accepts a mail whose DKIM signature fails: the transport judges no sender, a person does (NEGATIVE)', async () => {
    const forged = `DKIM-Signature: v=1; a=rsa-sha256; d=statik-weber.at; s=sel; h=from:subject; bh=AAAA; b=BBBB\r\n${MESSAGE}`

    const response = await POST(await sign({ body: forged }))

    expect(response.status).toBe(202)
    expect(completeReception).toHaveBeenCalledTimes(1)
  })

  it('holds the mail of a closed project like any other: the address resolves, and the mail waits (RT-X13)', async () => {
    // `findActiveAddressByToken` answers for an active address of a live project, open or closed;
    // nothing on the receive side asks whether the project is closed.
    const response = await POST(await sign())

    expect(response.status).toBe(202)
  })

  it.each([
    ['an unknown token', { 'x-envelope-to': 'wohnbau.zzzzzzzzzzzz@piloti.at' }],
    ['a recipient that holds no token', { 'x-envelope-to': 'info@piloti.at' }],
  ])('rejects %s with the one bounce text, without reading the body', async (_, envelope) => {
    const response = await POST(await sign({}, envelope))

    expect(response.status).toBe(404)
    expect(response.headers.get(VERDICT_HEADER)).toBe('reject')
    expect(await response.json()).toMatchObject({ error: CONTRACT.rejectText })
    expect(insertReception).not.toHaveBeenCalled()
    expect(putRawMessage).not.toHaveBeenCalled()
    expect(captureServer).toHaveBeenCalledWith(expect.objectContaining({ event: 'inbound_mail_refused', properties: { reason: 'unknown_address' } }))
  })

  it('rejects mail to an office that has the feature off exactly like an unknown address', async () => {
    vi.mocked(enabledFlagsForOrganization).mockResolvedValue([])

    const response = await POST(await sign())

    expect(response.status).toBe(404)
    expect(response.headers.get(VERDICT_HEADER)).toBe('reject')
    expect(await response.json()).toMatchObject({ error: CONTRACT.rejectText })
    expect(insertReception).not.toHaveBeenCalled()
  })

  it('answers a failed flag lookup with a 503 the sender retries, never a bounce', async () => {
    vi.mocked(enabledFlagsForOrganization).mockRejectedValue(new Error('workos down'))

    const response = await POST(await sign())

    expect(response.status).toBe(503)
    expect(response.headers.get(VERDICT_HEADER)).toBeNull()
  })

  it('rejects a message larger than 26 MiB by its signed length, before the body is read', async () => {
    const response = await POST(await sign({ contentLength: String(26 * 1024 * 1024 + 1) }))

    expect(response.status).toBe(413)
    expect(response.headers.get(VERDICT_HEADER)).toBe('reject')
    expect(calls).toEqual(['address:k3m7q2xw4pab', 'flags'])
  })

  it('answers the pause switch with a 503 and asks nothing', async () => {
    vi.stubEnv('GRID_INBOUND_MAIL_PAUSED', 'true')

    const response = await POST(await sign())

    expect(response.status).toBe(503)
    expect(response.headers.get(VERDICT_HEADER)).toBeNull()
    expect(calls).toEqual([])
  })

  it.each([
    ['the recipient', { 'x-envelope-to': 'wohnbau.k3m7q2xw4pab%E0%A4%A@piloti.at' }],
    ['the envelope sender', { 'x-envelope-from': 'zo%C3@example.org' }],
  ])('answers a malformed escape in %s with 400 and no verdict, so the sender retries', async (_, envelope) => {
    const response = await POST(await sign({}, envelope))

    expect(response.status).toBe(400)
    expect(response.headers.get(VERDICT_HEADER)).toBeNull()
    expect(calls).toEqual([])
  })

  it('decodes both envelope headers as the Worker encodes them, and the null sender to ""', async () => {
    await POST(await sign({}, { 'x-envelope-to': 'wohnbau.k3m7q2xw4pab%2Bplaene@piloti.at', 'x-envelope-from': '<>' }))

    expect(calls[0]).toBe('address:k3m7q2xw4pab')
    expect(vi.mocked(insertReception).mock.calls[0][0].envelopeFrom).toBe('')
  })

  it('answers a recipient outside our domain with 503: our routing, never the sender', async () => {
    const response = await POST(await sign({}, { 'x-envelope-to': 'someone@example.org' }))

    expect(response.status).toBe(503)
    expect(response.headers.get(VERDICT_HEADER)).toBeNull()
    expect(findActiveAddressByToken).not.toHaveBeenCalled()
  })

  it('refuses a request whose envelope is not signed, before anything runs', async () => {
    const response = await POST(
      await sign({ components: ['@method', '@target-uri', 'content-digest', 'content-length', 'x-envelope-to'] }),
    )

    expect(response.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('answers a full byte cap with 429 and no verdict, before a byte is staged', async () => {
    vi.mocked(stagedBytes).mockResolvedValue({ address: 1024 * 1024 * 1024, organization: 1024 * 1024 * 1024 })

    const response = await POST(await sign())

    expect(response.status).toBe(429)
    expect(response.headers.get(VERDICT_HEADER)).toBeNull()
    expect(await response.json()).toMatchObject({ details: { reason: 'cap-reached' } })
    expect(insertReception).not.toHaveBeenCalled()
  })

  it('answers past an address rate limit with 429, and charges unknown tokens to a bucket of their own', async () => {
    for (let i = 0; i < 120; i++) expect((await POST(await sign())).status).toBe(202)
    const limited = await POST(await sign())
    expect(limited.status).toBe(429)
    expect(limited.headers.get(VERDICT_HEADER)).toBeNull()

    // A guesser's unknown tokens spend nothing of the address's budget, and theirs runs out on its own.
    const unknown = await POST(await sign({}, { 'x-envelope-to': 'x.zzzzzzzzzzzz@piloti.at' }))
    expect(unknown.status).toBe(404)
  })

  it('answers a second delivery of a held mail with 200 and erases its copy', async () => {
    vi.mocked(findMailIdByDeliveryKey).mockResolvedValue('5b8c0f1e-0000-4000-8000-000000000001')

    const response = await POST(await sign())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'duplicate' })
    const reception = vi.mocked(insertReception).mock.calls[0][0]
    expect(eraseStagedObjects).toHaveBeenCalledWith('grid-org-test', [reception.rawStorageKey])
    expect(forgetReceptionObject).toHaveBeenCalledWith(reception.id)
    expect(completeReception).not.toHaveBeenCalled()
  })

  it('answers a duplicate that won the race at the unique key with 200 too', async () => {
    vi.mocked(completeReception).mockResolvedValue('duplicate')

    const response = await POST(await sign())

    expect(response.status).toBe(200)
    expect(eraseStagedObjects).toHaveBeenCalledTimes(1)
  })

  it('answers a body shorter than its signed length with 503 body-truncated and keeps nothing', async () => {
    const response = await POST(await sign({ sentBody: MESSAGE.slice(0, 40) }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ details: { reason: 'body-truncated' } })
    expect(completeReception).not.toHaveBeenCalled()
    expect(eraseStagedObjects).toHaveBeenCalledTimes(1)
  })

  it('answers a body that does not hash to the signed digest with 401 and keeps nothing', async () => {
    const response = await POST(await sign({ sentBody: MESSAGE.replace('Plan.', 'Plon.') }))

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ details: { reason: 'bad-digest' } })
    expect(completeReception).not.toHaveBeenCalled()
  })

  it('answers a database fault with 503, and its message (which quotes the statement) reaches no log', async () => {
    vi.mocked(insertReception).mockRejectedValue(new Error(`insert into inbound_mails values ('${SENDER}')`))

    const response = await POST(await sign())

    expect(response.status).toBe(503)
    expect(response.headers.get(VERDICT_HEADER)).toBeNull()
    const logged = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls].flat().join(' ')
    expect(logged).not.toContain(SENDER)
    expect(JSON.stringify(await response.json())).not.toContain(SENDER)
  })

  it('logs one line per delivery with ids and codes, never the sender, the recipient or the token', async () => {
    await POST(await sign())
    await POST(await sign({}, { 'x-envelope-to': 'wohnbau.zzzzzzzzzzzz@piloti.at' }))

    const lines = [...infoLines().mock.calls, ...vi.mocked(console.warn).mock.calls].flat().map(String)
    expect(lines.filter((line) => line.startsWith('[inbound-mail] delivery'))).toHaveLength(2)
    for (const secret of [SENDER, 'k3m7q2xw4pab', 'zzzzzzzzzzzz', 'statik-weber', 'wohnbau']) {
      expect(lines.join('\n')).not.toContain(secret)
      expect(JSON.stringify(vi.mocked(captureServer).mock.calls)).not.toContain(secret)
    }
  })

  it('answers only what the Worker reads as the contract says: a bounce is a 4xx with the verdict, all else retries', async () => {
    const answers: Array<[string, Response]> = [
      ['accepted', await POST(await sign())],
      ['rejected', await POST(await sign({}, { 'x-envelope-to': 'x.zzzzzzzzzzzz@piloti.at' }))],
      ['rejected', await POST(await sign({ contentLength: String(27 * 1024 * 1024) }))],
      ['retry', await POST(await sign({ sentBody: MESSAGE.slice(0, 10) }))],
      ['retry', await POST(await sign({}, { 'x-envelope-to': '%E0' }))],
    ]
    for (const [outcome, response] of answers) {
      expect(deliveryOutcome(response.status, response.headers.get(VERDICT_HEADER)), `${response.status}`).toBe(outcome)
    }
  })
})
