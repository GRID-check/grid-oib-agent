import { describe, expect, it } from 'vitest'
import {
  archiveFolderName,
  attachmentFilename,
  mailFolderName,
  mailNote,
  mailTimestamp,
  numbered,
  numberedFilename,
  outlookFolderName,
  outlookFolderPath,
  senderLabel,
} from './naming'
import { validateFolderName } from '@/lib/projects/folders'

describe('mail names', () => {
  it('stamps a mail in Vienna time, with dots so the name is a path segment', () => {
    // 08:15 UTC on 30 September is 10:15 in Vienna (summer time).
    expect(mailTimestamp('2026-09-30T08:15:00+00:00')).toBe('2026-09-30 10.15')
    expect(mailTimestamp('2026-01-15T08:15:00+00:00')).toBe('2026-01-15 09.15')
    expect(mailTimestamp(null)).toBe('ohne Datum')
    expect(mailTimestamp('not a date')).toBe('ohne Datum')
  })

  it('names a mail folder by date and sender, never by subject', () => {
    expect(mailFolderName('2026-09-30T08:15:00Z', { name: 'Anna Berger', address: 'anna@buero.at' })).toBe(
      '2026-09-30 10.15 – Anna Berger',
    )
    expect(mailFolderName(null, null)).toBe('ohne Datum – Unbekannt')
  })

  it('reads the day in Vienna, where 00:30 on the 1st is the 1st, through daylight saving time', () => {
    expect(mailTimestamp('2026-09-30T22:30:00Z')).toBe('2026-10-01 00.30')
    expect(mailTimestamp('2026-12-31T23:05:00Z')).toBe('2027-01-01 00.05')
    expect(mailTimestamp('2026-07-15T11:00:00Z')).toBe('2026-07-15 13.00')
  })

  it('names the sender by the local part when there is no display name, never by the domain', () => {
    expect(senderLabel({ name: '', address: 'anna.berger@buero.at' })).toBe('anna.berger')
    expect(senderLabel({ name: '  ', address: 'anna@buero.at' })).toBe('anna')
    expect(senderLabel({ name: '..', address: '...@buero.at' })).toBe('Unbekannt')
    expect(mailFolderName('2026-09-30T08:15:00Z', { name: '', address: 'anna@buero.at' })).toBe(
      '2026-09-30 10.15 – anna',
    )
  })

  it('keeps a sender name with a slash from becoming a nested folder', () => {
    expect(mailFolderName('2026-09-30T08:15:00Z', { name: 'Bau/Amt Wien', address: '' })).toBe(
      '2026-09-30 10.15 – Bau-Amt Wien',
    )
    const name = mailFolderName('2026-09-30T08:15:00Z', { name: 'Büro / Plan\\ung\u0000 GmbH. ', address: 'x@y.at' })
    expect(validateFolderName(name)).toEqual({ ok: true, name })
  })

  it('drops bidi overrides and zero-width characters from a sender name', () => {
    expect(senderLabel({ name: '\u202Eevil\u200B Büro', address: 'x@y.at' })).toBe('evil Büro')
  })

  it('writes decomposed umlauts composed, so two mails from one sender read alike', () => {
    expect(senderLabel({ name: 'Jürgen'.normalize('NFD'), address: 'j@y.at' })).toBe('Jürgen'.normalize('NFC'))
  })

  it('cuts a long sender between graphemes and leaves room for " (n)"', () => {
    const name = mailFolderName('2026-09-30T08:15:00Z', {
      name: `${'x'.repeat(78)}👨\u200D👩\u200D👧 Architekten`,
      address: 'x@y.at',
    })
    expect(name.endsWith('…')).toBe(true)
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    expect(validateFolderName(numbered(name, 99)).ok).toBe(true)
  })

  it('keeps a numbered folder name within the 120-character limit', () => {
    const long = 'x'.repeat(120)
    expect(numbered(long, 2)).toHaveLength(120)
    expect(numbered(long, 2).endsWith(' (2)')).toBe(true)
  })

  it('folds an Outlook tree deeper than folder creation takes into its last level', () => {
    const deep = Array.from({ length: 14 }, (_, i) => `E${i + 1}`)
    const path = outlookFolderPath(deep).split('/')
    expect(path).toHaveLength(12)
    expect(path.at(-1)).toBe('E12 – E13 – E14')
    expect(outlookFolderPath(['Posteingang', 'Behörde'])).toBe('Posteingang/Behörde')
  })

  it('numbers a taken name, before the extension for a file', () => {
    expect(numbered('Posteingang', 1)).toBe('Posteingang')
    expect(numbered('Posteingang', 3)).toBe('Posteingang (3)')
    expect(numberedFilename('Plan.pdf', 2)).toBe('Plan (2).pdf')
    expect(numberedFilename('README', 2)).toBe('README (2)')
    const longest = `${'x'.repeat(236)}.pdf`
    expect(numberedFilename(longest, 50)).toHaveLength(240)
    expect(numberedFilename(longest, 50).endsWith(' (50).pdf')).toBe(true)
  })

  it('prefixes an attachment with its mail, and bounds a long name keeping the extension', () => {
    const folder = '2026-09-30 10.15 – Anna Berger'
    expect(attachmentFilename(folder, 'Plan.pdf')).toBe(`${folder} – Plan.pdf`)
    const long = attachmentFilename(folder, `${'x'.repeat(400)}.pdf`)
    expect(long.length).toBeLessThanOrEqual(240)
    expect(long.endsWith('.pdf')).toBe(true)
  })

  it('makes Outlook folder names safe project folder names', () => {
    expect(outlookFolderName('Posteingang')).toBe('Posteingang')
    expect(outlookFolderName('  ')).toBe('Ordner')
    expect(outlookFolderName('CON')).toBe('CON_')
    expect(outlookFolderName('..')).toBe('.._')
    expect(archiveFolderName('Büro 2019.PST')).toBe('Büro 2019')
  })
})

describe('mailNote', () => {
  const mail = {
    subject: 'Brandschutzplan  Stiege 2',
    sender: { name: 'Anna Berger', address: 'anna@buero.at' },
    to: [{ name: 'Bauamt', address: 'bauamt@wien.gv.at' }],
    cc: [],
    sentAt: '2026-09-30T08:15:00Z',
    receivedAt: null,
    folderPath: ['Posteingang', 'Behörde'],
    body: { text: 'Bitte um Prüfung.', truncated: false },
  }

  it('carries the subject and headers, then the text', () => {
    const note = mailNote(mail, ['2026-09-30 10.15 – Anna Berger – Plan.pdf'])
    expect(note).toContain('# Brandschutzplan Stiege 2')
    expect(note).toContain('- **Von:** Anna Berger <anna@buero.at>')
    expect(note).toContain('- **An:** Bauamt <bauamt@wien.gv.at>')
    expect(note).toContain('- **Gesendet:** 2026-09-30 10:15')
    expect(note).toContain('- **Outlook-Ordner:** Posteingang / Behörde')
    expect(note).toContain('- **Anhänge:** 2026-09-30 10.15 – Anna Berger – Plan.pdf')
    expect(note).not.toContain('Cc')
    expect(note.trimEnd().endsWith('Bitte um Prüfung.')).toBe(true)
  })

  it('says when a mail has no text, and when the text was cut', () => {
    expect(mailNote({ ...mail, body: { text: '', truncated: false } }, [])).toContain('keinen Text')
    expect(mailNote({ ...mail, body: { text: 'a', truncated: true } }, [])).toContain('gekürzt')
  })
})
