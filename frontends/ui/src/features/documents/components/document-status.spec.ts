import { describe, expect, it } from 'vitest'
import { isCitableStatus, isFailedStatus, isSettlingStatus } from './document-status'

describe('document status families', () => {
  it('treats ingest-reconciled completed as citable (Ask must not stay grey)', () => {
    expect(isCitableStatus('completed')).toBe(true)
    expect(isCitableStatus('ready')).toBe(true)
    expect(isCitableStatus('ingested')).toBe(true)
    expect(isCitableStatus('processing')).toBe(false)
    expect(isCitableStatus(null)).toBe(false)
  })

  it('does not treat a failed ingest as still settling', () => {
    expect(isFailedStatus('failed')).toBe(true)
    expect(isFailedStatus('error')).toBe(true)
    expect(isSettlingStatus('failed')).toBe(false)
    expect(isSettlingStatus('pending')).toBe(true)
  })
})
