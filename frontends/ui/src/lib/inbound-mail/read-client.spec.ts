/**
 * @vitest-environment node
 *
 * The Python reader's contract (handoffs D4→D7): a 200 always carries a read,
 * a 422 is permanent, everything else is retried; snake_case mapped onto this
 * tier; B8 redaction reaches every text a person is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://aiq-api.test' }))

import { redactProjectAddresses } from './address'
import { MAIL_READ_TIMEOUT_MS, MailReadRefusedError, readMail, redactRead, unreadableRead } from './read-client'

const WIRE = {
  reader_version: 1,
  body_source: 'html',
  own_text: 'Guten Tag, anbei der Plan.',
  own_text_truncated: false,
  split: true,
  signature_removed: true,
  quoted: [{ header: 'Am 02.10.2026 schrieb Huber <huber@ma37.wien.gv.at>:', text: 'Bitte um Nachreichung.' }],
  quoted_truncated: false,
  calendar: [
    {
      method: 'REQUEST',
      summary: 'Begehung',
      start: '2026-11-03T09:00:00+01:00',
      end: null,
      all_day: false,
      location: 'Baustelle',
      status: 'CONFIRMED',
      organizer_name: 'Huber, Anna',
      uid: 'u1',
      sequence: 0,
      recurring: false,
    },
  ],
  calendar_truncated: false,
  encrypted: false,
  unreadable_reasons: [],
  unreadable: false,
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'internal-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fetchMock.mockReset()
})

describe('readMail', () => {
  it('posts the file_ref with the service token and a deadline of at least a minute, and maps the read', async () => {
    fetchMock.mockResolvedValue(Response.json(WIRE))

    const read = await readMail('http://seaweed.test/presigned')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://aiq-api.test/v1/mail/read')
    expect(JSON.parse(init.body)).toEqual({ file_ref: 'http://seaweed.test/presigned' })
    expect(init.headers['x-grid-internal-token']).toBe('internal-token')
    expect(init.redirect).toBe('manual')
    expect(MAIL_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
    expect(read).toMatchObject({
      bodySource: 'html',
      ownText: 'Guten Tag, anbei der Plan.',
      quoted: [{ header: expect.stringContaining('schrieb'), text: 'Bitte um Nachreichung.' }],
      calendar: [{ allDay: false, organizerName: 'Huber, Anna', start: '2026-11-03T09:00:00+01:00' }],
      unreadable: false,
    })
  })

  it('refuses for good on a 422, and throws for a retry on anything else', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 422 }))
    await expect(readMail('u')).rejects.toBeInstanceOf(MailReadRefusedError)

    fetchMock.mockResolvedValue(new Response('{}', { status: 502 }))
    await expect(readMail('u')).rejects.not.toBeInstanceOf(MailReadRefusedError)
  })

  it('refuses an answer that is not a read rather than stage it', async () => {
    fetchMock.mockResolvedValue(Response.json({ ...WIRE, own_text: 7 }))
    await expect(readMail('u')).rejects.toThrow()
  })
})

describe('redactRead (B8)', () => {
  const OTHER = 'nachbar.zzzzzzzzzzzz@piloti.at'
  const OWN = 'wohnbau.abcdefgh2345@piloti.at'

  it('redacts another project’s token in the text, every quote and its header, and the invitation; keeps the receiving one', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...WIRE,
        own_text: `An ${OTHER} und ${OWN}`,
        quoted: [{ header: `Von: ${OTHER}`, text: `cc ${OTHER}` }],
        calendar: [{ ...WIRE.calendar[0], summary: OTHER, location: OTHER, organizer_name: OTHER }],
      }),
    )
    const read = redactRead(await readMail('u'), (text) => redactProjectAddresses(text, 'piloti.at', 'abcdefgh2345'))

    expect(JSON.stringify(read)).not.toContain('zzzzzzzzzzzz')
    expect(read.ownText).toContain(OWN)
    expect(read.quoted[0].header).toBe('Von: nachbar.…@piloti.at')
  })
})

describe('unreadableRead', () => {
  it('is an empty read flagged unreadable, with the reason', () => {
    expect(unreadableRead('timeout')).toMatchObject({ ownText: '', unreadable: true, unreadableReasons: ['timeout'] })
  })
})
