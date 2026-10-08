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
} from './naming'

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
    expect(mailFolderName('2026-09-30T08:15:00Z', { name: '', address: 'anna@buero.at' })).toBe(
      '2026-09-30 10.15 – anna@buero.at',
    )
    expect(mailFolderName(null, null)).toBe('ohne Datum – Unbekannt')
  })

  it('keeps a sender name with a slash from becoming a nested folder', () => {
    expect(mailFolderName('2026-09-30T08:15:00Z', { name: 'Bau/Amt Wien', address: '' })).toBe(
      '2026-09-30 10.15 – Bau-Amt Wien',
    )
  })

  it('numbers a taken name, before the extension for a file', () => {
    expect(numbered('Posteingang', 1)).toBe('Posteingang')
    expect(numbered('Posteingang', 3)).toBe('Posteingang (3)')
    expect(numberedFilename('Plan.pdf', 2)).toBe('Plan (2).pdf')
    expect(numberedFilename('README', 2)).toBe('README (2)')
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
