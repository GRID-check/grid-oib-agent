import { describe, expect, it } from 'vitest'
import { FILING_CHOICE_METADATA_KEY, filingChoiceRecord, storedFilingChoice } from './filing-choice'
import { DOCUMENT_TYPE_TAGS } from './tag-vocabulary'
import type { MailOriginIngestFacts, MailThreadIngestFacts } from '@/lib/mail-thread/ingest-facts'

const TYPE = DOCUMENT_TYPE_TAGS[0]
const OLDER = '0b6c8a52-3f1e-4c7a-9d2b-5e8f1a2b3c4d'
const row = (metadata: unknown, contentHash: string | null = 'sha256:abc') => ({ metadata, contentHash })

describe('filingChoiceRecord', () => {
  it('records only what was chosen, and nothing when nothing was', () => {
    expect(filingChoiceRecord({ documentType: TYPE, revisionOfId: OLDER })).toEqual({
      documentType: TYPE,
      revisionOfId: OLDER,
    })
    expect(filingChoiceRecord({ documentType: TYPE, revisionOfId: null })).toEqual({ documentType: TYPE })
    expect(filingChoiceRecord({ documentType: null, revisionOfId: null })).toBeNull()
    expect(filingChoiceRecord({})).toBeNull()
  })
})

describe('storedFilingChoice', () => {
  const recorded = (choice: unknown, ingestContentHash = 'sha256:abc') => ({
    ingestJobId: 'job-1',
    ingestContentHash,
    [FILING_CHOICE_METADATA_KEY]: choice,
  })

  it('reads back what the dispatch of these bytes recorded', () => {
    expect(storedFilingChoice(row(recorded({ documentType: TYPE, revisionOfId: OLDER })))).toEqual({
      documentType: TYPE,
      revisionOfId: OLDER,
    })
    expect(storedFilingChoice(row(recorded({ revisionOfId: OLDER })))).toEqual({
      documentType: null,
      revisionOfId: OLDER,
    })
  })

  it('reads nothing for other bytes than the row holds, or a row with no digest', () => {
    expect(storedFilingChoice(row(recorded({ documentType: TYPE }, 'sha256:older')))).toBeNull()
    expect(storedFilingChoice(row(recorded({ documentType: TYPE }), null))).toBeNull()
  })

  it('reads nothing from a row with no choice, or metadata of another shape', () => {
    expect(storedFilingChoice(row({ ingestJobId: 'job-1', ingestContentHash: 'sha256:abc' }))).toBeNull()
    expect(storedFilingChoice(row(null))).toBeNull()
    expect(storedFilingChoice(row([TYPE]))).toBeNull()
    expect(storedFilingChoice(row(recorded('Grundriss')))).toBeNull()
  })

  it('drops a type outside the vocabulary and anything that is not a document id', () => {
    expect(storedFilingChoice(row(recorded({ documentType: 'retired-type' })))).toBeNull()
    expect(storedFilingChoice(row(recorded({ documentType: 'retired-type', revisionOfId: OLDER })))).toEqual({
      documentType: null,
      revisionOfId: OLDER,
    })
    expect(storedFilingChoice(row(recorded({ revisionOfId: 'Index_B.pdf' })))).toBeNull()
    expect(storedFilingChoice(row(recorded({ revisionOfId: '   ' })))).toBeNull()
    // A file name is no choice to re-send: the release re-resolves an id.
    expect(storedFilingChoice(row(recorded({ revisionOf: 'Index_B.pdf' })))).toBeNull()
  })
})

// A filed mail (ADR-0134, D36): a Verlauf the content screening holds keeps its
// lane and date through the release, and an attachment the mail it came with.
describe('a filed mail’s facts with the filing choice', () => {
  const MAIL_THREAD: MailThreadIngestFacts = { latest_sent_at: '2026-10-14T07:12:00Z', message_count: 4, locale: 'de' }
  const MAIL_ORIGIN: MailOriginIngestFacts = { sent_at: '2026-10-14T07:12:00Z', sender_trust: 'external_unverified', locale: 'de' }
  const stored = (choice: unknown) => storedFilingChoice(row({ ingestJobId: 'j', ingestContentHash: 'sha256:abc', [FILING_CHOICE_METADATA_KEY]: choice }))

  it('records and reads back a Verlauf’s thread and an attachment’s mail', () => {
    const thread = filingChoiceRecord({ documentType: 'correspondence', mailThread: MAIL_THREAD })
    expect(thread).toEqual({ documentType: 'correspondence', mailThread: MAIL_THREAD })
    expect(stored(thread)).toEqual({ documentType: 'correspondence', revisionOfId: null, mailThread: MAIL_THREAD })
    expect(stored(filingChoiceRecord({ mailOrigin: MAIL_ORIGIN }))).toEqual({
      documentType: null,
      revisionOfId: null,
      mailOrigin: MAIL_ORIGIN,
    })
  })

  it('reads a record the backend would refuse as none: an address, an unknown trust, both on one document', () => {
    expect(stored({ mailOrigin: { ...MAIL_ORIGIN, from_name: 'huber@ma37.wien.gv.at' } })).toBeNull()
    expect(stored({ mailOrigin: { ...MAIL_ORIGIN, sender_trust: 'trusted' } })).toBeNull()
    expect(stored({ mailThread: { ...MAIL_THREAD, message_count: 0 } })).toBeNull()
    expect(stored({ mailThread: MAIL_THREAD, mailOrigin: MAIL_ORIGIN })).toEqual({
      documentType: null,
      revisionOfId: null,
      mailThread: MAIL_THREAD,
    })
  })
})
