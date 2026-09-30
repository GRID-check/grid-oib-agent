/**
 * Where a mail's files are filed, and under which names (ADR-0074).
 *
 * One folder per mail under the top-level `E-Mail-Eingang`:
 * `E-Mail-Eingang/<YYYY-MM-DD> <subject> – <sender>`. The date comes from the
 * mail's own Date header, not from when it arrived, so a redelivery lands in
 * the same folder and `uploadDocument` recognises the same bytes as unchanged.
 *
 * Pure: the folder rules themselves are `lib/projects/folders`
 * (`normalizeFolderName`), applied here so the name this module builds is one
 * `ensureProjectFolderPaths` accepts as it stands.
 */

import { normalizeFolderName } from '@/lib/projects/folders'

/** The top-level folder every mail is filed under. */
export const INBOUND_MAIL_ROOT_FOLDER = 'E-Mail-Eingang'

/** What an empty subject is filed as. */
export const EMPTY_SUBJECT = '(ohne Betreff)'

/** The subject is cut to this many characters (an ellipsis included). */
export const SUBJECT_MAX_LENGTH = 60

/** The sender part is cut to this many, so the whole name stays under 120. */
const SENDER_MAX_LENGTH = 40

/**
 * The calendar the folder date is read in. The offices this serves are in
 * Austria, and a mail sent at 00:30 local time on the 1st is a mail of the
 * 1st to them, not of the 31st in UTC.
 */
export const FOLDER_TIME_ZONE = 'Europe/Vienna'

/** Characters that are legal in a folder name here but trouble on the desktop a folder is synced to. */
const DESKTOP_UNSAFE = /[<>:"|?*\\/\u0000-\u001f\u007f]/g

/** `YYYY-MM-DD` in {@link FOLDER_TIME_ZONE}. */
export function folderDate(date: Date): string {
  // en-CA formats as ISO `YYYY-MM-DD`.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FOLDER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/**
 * The mail's own date, or the receipt time when the header is missing or not a
 * date. `postal-mime` hands the header over as ISO when it parsed, and as the
 * original string when it did not.
 */
export function mailDate(dateHeader: string | undefined, receivedAt: Date): Date {
  if (!dateHeader) return receivedAt
  const parsed = new Date(dateHeader)
  return Number.isNaN(parsed.getTime()) ? receivedAt : parsed
}

/** A header value made safe to be part of a folder name, and cut to `max`. */
function sanitize(value: string, max: number): string {
  const clean = normalizeFolderName(value.replace(DESKTOP_UNSAFE, ' '))
    // Leading and trailing dots would make `.` / `..` segments or hidden folders.
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trimEnd()}…`
}

/** The subject as filed: sanitized, truncated, `(ohne Betreff)` when empty. */
export function subjectForFolder(subject: string | undefined): string {
  const clean = sanitize(subject ?? '', SUBJECT_MAX_LENGTH)
  return clean || EMPTY_SUBJECT
}

/** The sender as filed: the display name, or the local part of the address. */
export function senderForFolder(name: string | undefined, address: string): string {
  const fromName = sanitize(name ?? '', SENDER_MAX_LENGTH)
  if (fromName) return fromName
  const local = address.slice(0, Math.max(0, address.lastIndexOf('@'))) || address
  return sanitize(local, SENDER_MAX_LENGTH) || 'unbekannt'
}

export interface MailFolderInput {
  subject: string | undefined
  dateHeader: string | undefined
  receivedAt: Date
  senderName: string | undefined
  senderAddress: string
}

/** `<YYYY-MM-DD> <subject> – <sender>`: the mail's own folder. */
export function mailFolderName(input: MailFolderInput): string {
  const date = folderDate(mailDate(input.dateHeader, input.receivedAt))
  const subject = subjectForFolder(input.subject)
  const sender = senderForFolder(input.senderName, input.senderAddress)
  return `${date} ${subject} – ${sender}`
}

/** The path `ensureProjectFolderPaths` is asked for. */
export function mailFolderPath(input: MailFolderInput): string {
  return `${INBOUND_MAIL_ROOT_FOLDER}/${mailFolderName(input)}`
}

/**
 * One mail's filenames, made distinct: the second `Plan.pdf` becomes
 * `Plan (2).pdf`, the third `Plan (3).pdf`.
 *
 * Compared case- and Unicode-form-insensitively, because the filing below
 * treats `Plan.pdf` and `plan.pdf` as candidates for the same document on a
 * case-insensitive desktop, and a mail is one gesture: its attachments should
 * all arrive side by side, never as versions of each other.
 */
export function uniqueFilenames(names: readonly string[]): string[] {
  const taken = new Set<string>()
  const key = (name: string) => name.normalize('NFC').toLowerCase()
  return names.map((name) => {
    if (!taken.has(key(name))) {
      taken.add(key(name))
      return name
    }
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''
    for (let n = 2; ; n += 1) {
      const candidate = `${stem} (${n})${extension}`
      if (!taken.has(key(candidate))) {
        taken.add(key(candidate))
        return candidate
      }
    }
  })
}
