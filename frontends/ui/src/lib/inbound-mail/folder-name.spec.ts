/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { validateFolderName } from '@/lib/projects/folders'
import {
  EMPTY_SUBJECT,
  INBOUND_MAIL_ROOT_FOLDER,
  mailFolderName,
  mailFolderPath,
  subjectForFolder,
  uniqueFilenames,
} from './folder-name'

const RECEIVED = new Date('2026-09-30T12:00:00Z')

const base = {
  subject: 'Pläne Einreichung',
  dateHeader: '2026-09-28T08:15:00.000Z',
  receivedAt: RECEIVED,
  senderName: 'Anna Muster',
  senderAddress: 'anna@buero-muster.at',
}

describe('mailFolderName', () => {
  it('dates the folder from the Date header, not from receipt', () => {
    expect(mailFolderName(base)).toBe('2026-09-28 Pläne Einreichung – Anna Muster')
  })

  it('reads the date in Vienna, where 00:30 on the 1st is the 1st', () => {
    expect(mailFolderName({ ...base, dateHeader: '2026-09-30T22:30:00.000Z' })).toMatch(/^2026-10-01 /)
  })

  it('falls back to the receipt time when the header is missing or not a date', () => {
    expect(mailFolderName({ ...base, dateHeader: undefined })).toMatch(/^2026-09-30 /)
    expect(mailFolderName({ ...base, dateHeader: 'gestern' })).toMatch(/^2026-09-30 /)
  })

  it('gives the same folder to a redelivery of the same mail', () => {
    const later = new Date('2026-10-02T09:00:00Z')
    expect(mailFolderName({ ...base, receivedAt: later })).toBe(mailFolderName(base))
  })

  it('files an empty subject as (ohne Betreff)', () => {
    expect(subjectForFolder('')).toBe(EMPTY_SUBJECT)
    expect(subjectForFolder('   ')).toBe(EMPTY_SUBJECT)
    expect(subjectForFolder(undefined)).toBe(EMPTY_SUBJECT)
    expect(mailFolderName({ ...base, subject: undefined })).toBe(
      '2026-09-28 (ohne Betreff) – Anna Muster'
    )
  })

  it('sanitizes separators, control characters and desktop-unsafe characters', () => {
    const name = mailFolderName({ ...base, subject: 'AW: Pläne 03/2026\\v2 <final>?\u0007 "neu"' })
    expect(name).not.toMatch(/[\\/<>:"|?*\u0000-\u001f]/)
    expect(name).toBe('2026-09-28 AW Pläne 03 2026 v2 final neu – Anna Muster')
    expect(validateFolderName(name).ok).toBe(true)
  })

  it('never produces a dot segment from a subject of dots', () => {
    expect(subjectForFolder('...')).toBe(EMPTY_SUBJECT)
  })

  it('truncates the subject to 60 characters', () => {
    const subject = subjectForFolder('Einreichplanung '.repeat(10))
    expect(subject.length).toBeLessThanOrEqual(60)
    expect(subject.endsWith('…')).toBe(true)
    expect(validateFolderName(mailFolderName({ ...base, subject: 'x'.repeat(500), senderName: 'y'.repeat(500) })).ok).toBe(true)
  })

  it('names the sender by display name, else by the local part of the address', () => {
    expect(mailFolderName({ ...base, senderName: undefined })).toBe('2026-09-28 Pläne Einreichung – anna')
    expect(mailFolderName({ ...base, senderName: '  ' })).toBe('2026-09-28 Pläne Einreichung – anna')
  })

  it('files under the E-Mail-Eingang root', () => {
    expect(mailFolderPath(base)).toBe(`${INBOUND_MAIL_ROOT_FOLDER}/2026-09-28 Pläne Einreichung – Anna Muster`)
  })
})

describe('uniqueFilenames', () => {
  it('numbers duplicates before the extension', () => {
    expect(uniqueFilenames(['Plan.pdf', 'Plan.pdf', 'Plan.pdf', 'Schnitt.pdf'])).toEqual([
      'Plan.pdf',
      'Plan (2).pdf',
      'Plan (3).pdf',
      'Schnitt.pdf',
    ])
  })

  it('treats case and Unicode form as the same name', () => {
    expect(uniqueFilenames(['Pläne.pdf', 'PLÄNE.PDF'])).toEqual(['Pläne.pdf', 'PLÄNE (2).PDF'])
  })

  it('handles a name without an extension and a name that already looks numbered', () => {
    expect(uniqueFilenames(['README', 'README'])).toEqual(['README', 'README (2)'])
    expect(uniqueFilenames(['a (2).pdf', 'a.pdf', 'a.pdf'])).toEqual(['a (2).pdf', 'a.pdf', 'a (3).pdf'])
  })
})
