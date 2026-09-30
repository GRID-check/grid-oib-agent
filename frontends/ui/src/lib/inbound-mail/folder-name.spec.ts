/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { validateFolderName } from '@/lib/projects/folders'
import { folderTimestamp, mailFolderName, senderLabel } from './folder-name'

const ANNA = { name: 'Anna Berger', address: 'anna@buero-berger.at' }

describe('mailFolderName', () => {
  it('names the folder for when it arrived and who sent it, in Vienna time, with no subject', () => {
    expect(mailFolderName(new Date('2026-09-30T08:15:00Z'), ANNA)).toBe(
      '2026-09-30 10.15 – Anna Berger'
    )
  })

  it('reads the day in Vienna, where 00:30 on the 1st is the 1st', () => {
    expect(folderTimestamp(new Date('2026-09-30T22:30:00Z'))).toBe('2026-10-01 00.30')
    expect(folderTimestamp(new Date('2026-12-31T23:05:00Z'))).toBe('2027-01-01 00.05')
  })

  it('follows daylight saving time', () => {
    expect(folderTimestamp(new Date('2026-01-15T11:00:00Z'))).toBe('2026-01-15 12.00')
    expect(folderTimestamp(new Date('2026-07-15T11:00:00Z'))).toBe('2026-07-15 13.00')
  })

  it('falls back to the local part, then to "unbekannt"', () => {
    expect(senderLabel({ name: null, address: 'anna.berger@buero-berger.at' })).toBe('anna.berger')
    expect(senderLabel({ name: '  ', address: 'anna@buero-berger.at' })).toBe('anna')
    expect(senderLabel({ name: '..', address: '...@buero-berger.at' })).toBe('unbekannt')
  })

  it('strips bidi overrides and zero-width characters (A8)', () => {
    const name = senderLabel({ name: '‮evil​ Büro', address: 'x@y.at' })
    expect(name).toBe('evil Büro')
  })

  it('keeps the folder rules: no separators, no control characters, no trailing dots', () => {
    const name = mailFolderName(new Date('2026-09-30T08:15:00Z'), {
      name: 'Büro / Plan\\ung\u0000 GmbH. ',
      address: 'x@y.at',
    })
    expect(name).toBe('2026-09-30 10.15 – Büro Plan ung GmbH')
    expect(validateFolderName(name)).toEqual({ ok: true, name })
  })

  it('cuts a long name between graphemes and leaves room for " (n)"', () => {
    const name = mailFolderName(new Date('2026-09-30T08:15:00Z'), {
      name: `${'x'.repeat(78)}👨‍👩‍👧 Architekten`,
      address: 'x@y.at',
    })
    expect(name.length).toBeLessThanOrEqual(110)
    expect(name.endsWith('…')).toBe(true)
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    expect(validateFolderName(`${name} (99)`).ok).toBe(true)
  })

  it('writes decomposed umlauts composed, so two mails from one sender read alike', () => {
    const nfd = senderLabel({ name: 'Jürgen'.normalize('NFD'), address: 'j@y.at' })
    expect(nfd).toBe('Jürgen'.normalize('NFC'))
  })
})
