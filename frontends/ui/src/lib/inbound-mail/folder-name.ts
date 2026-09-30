/**
 * The folder a mail's files are filed in (ADR-0074).
 *
 * One folder per mail under the top-level `E-Mail-Eingang`, named for when it
 * arrived and who sent it: `2026-09-30 10.15 – Anna Berger`. The subject is
 * deliberately NOT part of it: a folder name reaches the assistant's grounding
 * block and the storage keys, and a subject is free text from outside.
 *
 * The time is the row's `received_at`, never the Date header, so every re-run
 * of the same delivery computes the same name. The caller persists the folder
 * it created and adds ` (2)` when another mail already holds the name; this
 * module only builds the leaf.
 *
 * Pure. The folder rules themselves are `lib/projects/folders`
 * (`normalizeFolderName`, `validateFolderName`), applied here so the name is
 * one `ensureProjectFolderPaths` accepts as it stands.
 */

import { normalizeFolderName } from '@/lib/projects/folders'
import { stripFormatControls, truncateGraphemes } from '@/lib/text/graphemes'

/** The top-level folder every mail is filed under. */
export const INBOUND_MAIL_ROOT_FOLDER = 'E-Mail-Eingang'

/**
 * The calendar the folder time is read in. The offices this serves are in
 * Austria, and a mail that arrived at 00:30 local time on the 1st is a mail of
 * the 1st to them, not of the 31st in UTC.
 */
const FOLDER_TIME_ZONE = 'Europe/Vienna'

/**
 * The sender part is cut to this many UTF-16 units. With the 19-character
 * time prefix the leaf stays at 99, well under the folder limit of 120 with
 * room for the caller's ` (n)`.
 */
const SENDER_MAX_LENGTH = 80

/** What a sender with neither a usable name nor local part is filed as. */
const UNKNOWN_SENDER = 'unbekannt'

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: FOLDER_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** `YYYY-MM-DD HH.mm` in {@link FOLDER_TIME_ZONE}. */
export function folderTimestamp(date: Date): string {
  const parts = formatter.formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}.${part('minute')}`
}

/**
 * A display name or local part made safe for a folder name: the folder rules,
 * no format characters, no leading or trailing dots, cut by grapheme.
 */
function sanitizeSender(value: string): string {
  const clean = normalizeFolderName(stripFormatControls(value).replace(/\u007f/g, ' '))
    .normalize('NFC')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return truncateGraphemes(clean, SENDER_MAX_LENGTH, '…')
}

/** The sender as filed: the display name, else the address's local part. */
export function senderLabel(sender: { name: string | null; address: string }): string {
  const name = sanitizeSender(sender.name ?? '')
  if (name) return name
  const at = sender.address.lastIndexOf('@')
  return sanitizeSender(at > 0 ? sender.address.slice(0, at) : sender.address) || UNKNOWN_SENDER
}

/** `<YYYY-MM-DD HH.mm> – <sender>`: the leaf, joined under {@link INBOUND_MAIL_ROOT_FOLDER} by the caller. */
export function mailFolderName(
  receivedAt: Date,
  sender: { name: string | null; address: string }
): string {
  return `${folderTimestamp(receivedAt)} – ${senderLabel(sender)}`
}
