/**
 * What a mail filed into a project is called, and what an imported mail's note
 * says. Pure. One naming for both ways a mail arrives: an Outlook archive
 * (ADR-0085) and the project mail inbox (ADR-0075).
 *
 * **No subject in a name.** A folder name and a filename become storage keys,
 * audit targets and search titles, and a subject is the one header that carries
 * content ("Kündigung Frau M.", "Befund Statik"). So names carry only the date
 * and the sender, as the project mail inbox (#831) decided; the subject is
 * inside the note, which is a document like any other and goes where documents
 * go.
 *
 * **The sender is a name, never a domain.** The display name, else the
 * address's local part: a folder name is shown to everyone in the project and
 * reaches the assistant's grounding block, and the local part is enough to tell
 * two senders apart (data minimisation, inbound-mail review F5). It is somebody
 * else's text, so invisible format characters go (a bidi override, U+202E,
 * makes `Rechnung<U+202E>fdp.exe` read `Rechnungexe.pdf`) and a cut falls
 * between graphemes.
 *
 * **Names are unique per project, not per folder.** A document is identified by
 * its filename across the whole project (`uniq_documents_live_name_per_collection`),
 * so two mails' `Rechnung.pdf` would be one document with two versions. Every
 * file of a mail is therefore prefixed with the mail's own folder name, and the
 * filer numbers whatever still collides.
 */

import { normalizeFolderName } from '@/lib/projects/folders'
import { stripFormatControls, truncateGraphemes } from '@/lib/text/graphemes'

const VIENNA = 'Europe/Vienna'
const MAX_FOLDER_NAME = 120
const MAX_FILENAME = 240
/** The sender part of a folder name: with the 19-character stamp, the name stays under 100. */
const MAX_SENDER = 80

export interface MailAddress {
  name: string
  address: string
}

export interface MailForNote {
  subject: string
  sender: MailAddress | null
  to: MailAddress[]
  cc: MailAddress[]
  sentAt: string | null
  receivedAt: string | null
  folderPath: string[]
  body: { text: string; truncated: boolean }
}

/** `2026-09-30 10.15`, Vienna time. Dots, not a colon: the name is also a path segment. */
export function mailTimestamp(iso: string | null): string {
  if (!iso) return 'ohne Datum'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'ohne Datum'
  const parts = new Intl.DateTimeFormat('de-AT', {
    timeZone: VIENNA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}.${part('minute')}`
}

/** The mail's folder: `<date time> – <sender>`. */
export function mailFolderName(when: string | null, sender: MailAddress | null): string {
  return `${mailTimestamp(when)} – ${senderLabel(sender)}`.slice(0, MAX_FOLDER_NAME).trim()
}

/** The sender as a name shows them: the display name, else the address's local part. */
export function senderLabel(sender: MailAddress | null): string {
  const name = senderSegment(sender?.name ?? '')
  if (name) return name
  const address = sender?.address ?? ''
  const at = address.lastIndexOf('@')
  return senderSegment(at > 0 ? address.slice(0, at) : address) || 'Unbekannt'
}

/** A display name or local part as one name segment: one Unicode form, no edge dots, cut by grapheme. */
function senderSegment(raw: string): string {
  const clean = cleanSegment(stripFormatControls(raw)).normalize('NFC').replace(/^[.\s]+|[.\s]+$/g, '')
  return truncateGraphemes(clean, MAX_SENDER, '…')
}

/**
 * `name`, `name (2)`, `name (3)`: the n-th candidate for a folder name that may
 * be taken, still within the folder-name limit once the number is on it.
 */
export function numbered(name: string, n: number): string {
  if (n <= 1) return name
  const suffix = ` (${n})`
  return `${name.slice(0, MAX_FOLDER_NAME - suffix.length).trim()}${suffix}`
}

/**
 * As {@link numbered}, with the number before the extension (`Plan (2).pdf`),
 * and still within the filename bound once the number is on it.
 */
export function numberedFilename(filename: string, n: number): string {
  if (n <= 1) return filename
  const suffix = ` (${n})`
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 && filename.length - dot <= 12 ? filename.slice(dot) : ''
  const stem = extension ? filename.slice(0, dot) : filename
  return `${stem.slice(0, MAX_FILENAME - suffix.length - extension.length).trim()}${suffix}${extension}`
}

/** Names `validateFolderName` refuses (the old DOS devices), which an Outlook folder may still carry. */
const RESERVED = new Set(['con', 'prn', 'aux', 'nul'])

/**
 * Outlook folder levels mirrored as project folders. Folder creation takes paths
 * of at most twelve segments (`MAX_ENSURE_DEPTH`); anything deeper is folded
 * into the last one, `Projekte – 2019 – Nord`, so a deep tree still files.
 */
const MAX_OUTLOOK_DEPTH = 12

/** The project folder path that mirrors an Outlook folder path. */
export function outlookFolderPath(segments: readonly string[]): string {
  const names = segments.map(outlookFolderName)
  if (names.length <= MAX_OUTLOOK_DEPTH) return names.join('/')
  const kept = names.slice(0, MAX_OUTLOOK_DEPTH - 1)
  const folded = outlookFolderName(names.slice(MAX_OUTLOOK_DEPTH - 1).join(' – '))
  return [...kept, folded].join('/')
}

/** An Outlook folder's name as a project folder name. */
export function outlookFolderName(raw: string): string {
  const name = cleanSegment(raw).slice(0, MAX_FOLDER_NAME).trim() || 'Ordner'
  return RESERVED.has(name.toLowerCase()) || /^\.+$/.test(name) ? `${name}_` : name
}

/** The note's filename: the mail's folder name, as Markdown. */
export function noteFilename(mailFolder: string): string {
  return `${mailFolder}.md`
}

/** An attachment's filename: the mail's folder name, then the file's own name. */
export function attachmentFilename(mailFolder: string, original: string): string {
  const name = cleanSegment(original) || 'Anhang'
  const full = `${mailFolder} – ${name}`
  if (full.length <= MAX_FILENAME) return full
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : ''
  return `${full.slice(0, MAX_FILENAME - extension.length).trim()}${extension}`
}

/** The archive's own name, without its extension, as the import's top folder. */
export function archiveFolderName(filename: string): string {
  const stem = filename.replace(/\.(pst|ost)$/i, '')
  return outlookFolderName(stem) || 'Outlook-Archiv'
}

/** The mail as a Markdown note: the headers a reader needs, then the text. */
export function mailNote(mail: MailForNote, attachments: string[]): string {
  const lines = [`# ${oneLine(mail.subject) || '(kein Betreff)'}`, '']
  const header: Array<[string, string]> = [
    ['Von', mail.sender ? formatAddress(mail.sender) : ''],
    ['An', mail.to.map(formatAddress).join(', ')],
    ['Cc', mail.cc.map(formatAddress).join(', ')],
    ['Gesendet', readableTime(mail.sentAt)],
    ['Empfangen', readableTime(mail.receivedAt)],
    ['Outlook-Ordner', mail.folderPath.join(' / ')],
    ['Anhänge', attachments.join(', ')],
  ]
  for (const [label, value] of header) {
    if (value) lines.push(`- **${label}:** ${value}`)
  }
  lines.push('', '---', '', mail.body.text || '*(Diese E-Mail hat keinen Text.)*')
  if (mail.body.truncated) lines.push('', '*(Der Text war länger und wurde beim Import gekürzt.)*')
  return `${lines.join('\n')}\n`
}

function formatAddress(address: MailAddress): string {
  const name = oneLine(address.name)
  if (!address.address || address.address === name) return name || address.address
  return name ? `${name} <${address.address}>` : `<${address.address}>`
}

function readableTime(iso: string | null): string {
  if (!iso) return ''
  const stamp = mailTimestamp(iso)
  return stamp === 'ohne Datum' ? '' : stamp.replace(/(\d{2})\.(\d{2})$/, '$1:$2')
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** One name segment: no separators, no control characters, one Unicode form. */
function cleanSegment(raw: string): string {
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[/\\]/g, '-')
  return normalizeFolderName(oneLine(flat))
}
