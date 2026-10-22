/**
 * @vitest-environment node
 */
/**
 * The two ingest records of a filed mail (`./ingest-facts`) are what the
 * backend's forbid-extra models accept: the send time clamped as the heading
 * clamps it, a display name and domains only, never an address. The files
 * eval's fixture pins the bytes; this pins the edges.
 */
import { describe, expect, it } from 'vitest'
import {
  mailOriginIngestFacts,
  mailOriginIngestFactsSchema,
  mailThreadIngestFacts,
  mailThreadIngestFactsSchema,
  type MailIngestMessage,
} from './ingest-facts'

const received = new Date('2026-10-14T07:14:00.000Z')
const message = (overrides: Partial<MailIngestMessage> = {}): MailIngestMessage => ({
  sentAt: new Date('2026-10-14T07:12:30.400Z'),
  receivedAt: received,
  senderName: 'Mag. Anna Huber',
  senderDomain: 'MA37.Wien.GV.at.',
  signerDomain: 'ma37.wien.gv.at',
  senderTrust: 'external_verified',
  ...overrides,
})

describe('mail_origin', () => {
  it('says when and from whom, to the second, the domains as stored', () => {
    const facts = mailOriginIngestFacts(message(), {
      threadDocumentId: '6d1f0c4e-2b1a-4c3e-9a51-0000000000a0',
      locale: 'de',
    })
    expect(facts).toEqual({
      sent_at: '2026-10-14T07:12:30Z',
      received_at: '2026-10-14T07:14:00Z',
      from_name: 'Mag. Anna Huber',
      from_domain: 'ma37.wien.gv.at',
      signer_domain: 'ma37.wien.gv.at',
      sender_trust: 'external_verified',
      thread_document_id: '6d1f0c4e-2b1a-4c3e-9a51-0000000000a0',
      locale: 'de',
    })
    expect(mailOriginIngestFactsSchema.parse(facts)).toEqual(facts)
  })

  it('drops a display name that is an address, and leaves out what is not known', () => {
    const facts = mailOriginIngestFacts(
      message({ senderName: 'huber@ma37.wien.gv.at', signerDomain: null }),
      { threadDocumentId: null, locale: 'en' }
    )
    expect(facts).not.toHaveProperty('from_name')
    expect(facts).not.toHaveProperty('signer_domain')
    expect(facts).not.toHaveProperty('thread_document_id')
  })

  it('clamps a send time after the receipt to the receipt', () => {
    expect(
      mailOriginIngestFacts(message({ sentAt: new Date('2027-01-01T00:00:00Z') }), {
        threadDocumentId: null,
        locale: 'de',
      }).sent_at
    ).toBe('2026-10-14T07:14:00Z')
  })
})

describe('mail_thread', () => {
  it('names the newest message’s clamped time and how many this Fassung holds', () => {
    const facts = mailThreadIngestFacts(
      [message(), message({ sentAt: new Date('2026-10-13T08:00:00Z') })],
      'de'
    )
    expect(facts).toEqual({
      latest_sent_at: '2026-10-14T07:12:30Z',
      message_count: 2,
      locale: 'de',
    })
    expect(mailThreadIngestFactsSchema.parse(facts)).toEqual(facts)
  })

  it('refuses a Fassung with no message: a bug, never a document', () => {
    expect(() => mailThreadIngestFacts([], 'de')).toThrow()
  })
})
