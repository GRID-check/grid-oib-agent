import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/mail-import-send', () => ({ MailImportSendBusyError: class MailImportSendBusyError extends Error {} }))

import { MailImportRequestError } from '@/lib/mail-import/client'
import { MailImportSendBusyError } from '../lib/mail-import-send'
import { sendErrorKind } from './use-mail-imports'

describe('sendErrorKind', () => {
  const at = (status: number, code: string | null = null) => new MailImportRequestError('English text', status, code)

  it('words a refused start and a refused send apart, never with the server’s text', () => {
    expect(sendErrorKind({ stage: 'start', error: at(409, 'CONFLICT') })).toBe('alreadyRunning')
    expect(sendErrorKind({ stage: 'send', error: at(409, 'CONFLICT') })).toBe('cancelled')
    expect(sendErrorKind({ stage: 'start', error: at(507, 'STORAGE_QUOTA_EXCEEDED') })).toBe('quota')
    expect(sendErrorKind({ stage: 'start', error: at(403, 'FORBIDDEN') })).toBe('forbidden')
    expect(sendErrorKind({ stage: 'start', error: at(400, 'BAD_REQUEST') })).toBe('rejected')
    expect(sendErrorKind({ stage: 'start', error: new MailImportSendBusyError() })).toBe('busy')
  })

  it('reads a broken connection, a part that kept failing and an outage as resumable', () => {
    expect(sendErrorKind({ stage: 'send', error: new TypeError('Failed to fetch') })).toBe('connection')
    expect(sendErrorKind({ stage: 'send', error: at(503, 'PART_FAILED') })).toBe('connection')
    expect(sendErrorKind({ stage: 'send', error: at(502) })).toBe('connection')
    expect(sendErrorKind({ stage: 'send', error: at(418) })).toBe('unknown')
  })
})
