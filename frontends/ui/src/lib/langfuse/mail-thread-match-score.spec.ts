/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const api = vi.hoisted(() => ({ batch: vi.fn() }))
vi.mock('@langfuse/client', () => ({
  LangfuseClient: class {
    api = { ingestion: { batch: api.batch } }
  },
}))

import type { SenderEvidence, ThreadMatch } from '@/lib/mail-thread/mail-threading'
import { isTraceId } from './config'
import {
  MAIL_THREAD_MATCH_SCORE_NAME,
  mailThreadMatchBatch,
  mailThreadMatchIds,
  mailThreadMatchValue,
  recordMailThreadMatchScore,
  type MailThreadMatchRecord,
} from './mail-thread-match-score'

const STRONG = '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b'
const WEAK = '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c'
const MATCHES: ThreadMatch[] = [
  { threadId: STRONG, strength: 'reference', headers: ['in-reply-to', 'references'] },
  { threadId: WEAK, strength: 'subject', headers: [] },
]
const SENDER: SenderEvidence = {
  senderTrust: 'member_verified',
  senderFlags: [],
  signedHeaders: ['from', 'subject', 'in-reply-to', 'references'],
}

const record = (patch: Partial<MailThreadMatchRecord> = {}): MailThreadMatchRecord => ({
  organizationId: 'org_1',
  projectId: 'project-1',
  mailId: 'mail-1',
  partId: 'part-1',
  matches: MATCHES,
  sender: SENDER,
  choice: { action: 'append', mailThreadId: STRONG },
  via: 'app',
  decidedAt: new Date('2026-10-22T09:00:00.000Z'),
  ...patch,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.batch.mockResolvedValue({})
  vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-1')
  vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-1')
  vi.stubEnv('LANGFUSE_HOST', 'http://langfuse-web:3000')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the value', () => {
  it('is followed for the strongest match, other_thread for another, new_thread for a new Verlauf', () => {
    expect(mailThreadMatchValue(MATCHES, { action: 'append', mailThreadId: STRONG })).toBe('followed')
    expect(mailThreadMatchValue(MATCHES, { action: 'append', mailThreadId: WEAK })).toBe('other_thread')
    expect(mailThreadMatchValue(MATCHES, { action: 'append', mailThreadId: 'unmatched' })).toBe('other_thread')
    expect(mailThreadMatchValue(MATCHES, { action: 'create' })).toBe('new_thread')
  })

  it('is nothing without a match: such a decision says nothing about matching', () => {
    expect(mailThreadMatchValue([], { action: 'create' })).toBeNull()
    expect(mailThreadMatchBatch(record({ matches: [] }), ['e1', 'e2'])).toBeNull()
  })
})

describe('the batch', () => {
  it('is its own trace and one categorical score, with ids and codes only', () => {
    const batch = mailThreadMatchBatch(record({ choice: { action: 'append', mailThreadId: WEAK }, via: 'agent' }), ['e1', 'e2'])
    const { traceId, scoreId } = mailThreadMatchIds('part-1')
    expect(isTraceId(traceId)).toBe(true)
    expect(batch?.batch).toHaveLength(2)
    const [trace, score] = batch?.batch ?? []
    expect(trace).toMatchObject({ type: 'trace-create', id: 'e1', body: { id: traceId, name: MAIL_THREAD_MATCH_SCORE_NAME } })
    expect(score).toMatchObject({
      type: 'score-create',
      id: 'e2',
      body: {
        id: scoreId,
        traceId,
        name: 'mail-thread-match',
        dataType: 'CATEGORICAL',
        value: 'other_thread',
        metadata: {
          mail_id: 'mail-1',
          part_id: 'part-1',
          strength: 'reference',
          preselected: true,
          candidates: 2,
          chosen_rank: 1,
          sender_trust: 'member_verified',
          via: 'agent',
        },
      },
    })
  })

  it('derives both ids from the text part, so a second decision overwrites', () => {
    expect(mailThreadMatchIds('part-1')).toEqual(mailThreadMatchIds('part-1'))
    expect(mailThreadMatchIds('part-1').traceId).not.toBe(mailThreadMatchIds('part-2').traceId)
  })

  it('says a stranger’s match was not pre-selected', () => {
    const stranger: SenderEvidence = { senderTrust: 'external_unverified', senderFlags: [], signedHeaders: [] }
    const [, score] = mailThreadMatchBatch(record({ sender: stranger, via: 'follow' }), ['e1', 'e2'])?.batch ?? []
    expect(score).toMatchObject({ body: { value: 'followed', metadata: { preselected: false, via: 'follow' } } })
  })
})

describe('recording', () => {
  it('posts one batch and never rejects', async () => {
    await recordMailThreadMatchScore(record())
    expect(api.batch).toHaveBeenCalledTimes(1)
    api.batch.mockRejectedValueOnce(new Error('langfuse down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(recordMailThreadMatchScore(record())).resolves.toBeUndefined()
  })

  it('sends nothing with Langfuse unconfigured, or with no match', async () => {
    await recordMailThreadMatchScore(record({ matches: [] }))
    vi.unstubAllEnvs()
    vi.stubEnv('LANGFUSE_HOST', '')
    await recordMailThreadMatchScore(record())
    expect(api.batch).not.toHaveBeenCalled()
  })
})
