import { describe, expect, it, vi } from 'vitest'
import {
  documentStatusLabel,
  isCitableStatus,
  isFailedStatus,
  isSettlingStatus,
} from './document-status'

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

describe('documentStatusLabel', () => {
  // Returns the key itself, so every assertion is about WHICH key was picked.
  const t = (key: string): string => key

  it('labels declared statuses from the table', () => {
    expect(documentStatusLabel('ready', t)).toBe('status.ready')
    expect(documentStatusLabel(null, t)).toBe('status.unknown')
  })

  it('never renders a verbatim wire word for an undeclared status', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(documentStatusLabel('quasi-ready', t)).toBe('status.unknown')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})
