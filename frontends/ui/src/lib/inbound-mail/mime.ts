/**
 * Reading a raw message, and deciding which of its parts are files (ADR-0074).
 *
 * `postal-mime` does the parsing; this module owns only the product decisions
 * on top of it: which parts are attachments a member meant to send, what they
 * are called, and why the others were left out. The body text is never read
 * back out of here — v1 does not store it.
 */

import PostalMime from 'postal-mime'
import type { Attachment, Email } from 'postal-mime'
import { uniqueFilenames } from './folder-name'

/** Below this, an inline image with a Content-ID is a signature logo, not a file. */
export const INLINE_IMAGE_MAX_BYTES = 50 * 1024

/** Longest filename kept; the rest of the name is cut before the extension. */
const FILENAME_MAX_LENGTH = 200

/**
 * Why a part was not filed. The first three are decided here, `limit` by the
 * service's per-mail file cap, and the rest are `uploadDocument`'s refusals,
 * translated by the service.
 */
export type SkipReason =
  | 'inline'
  | 'empty'
  | 'tnef'
  | 'limit'
  | 'type'
  | 'size'
  | 'quota'
  | 'rejected'

export interface SkippedPart {
  filename: string
  reason: SkipReason
}

export interface MailFile {
  filename: string
  mimeType: string
  bytes: Uint8Array<ArrayBuffer>
}

export interface ParsedMail {
  messageId: string | null
  subject: string | undefined
  dateHeader: string | undefined
  fromName: string | undefined
  files: MailFile[]
  skipped: SkippedPart[]
}

/** Extensions for a nameless attachment whose type says what it is. */
const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/tiff': '.tif',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
}

const TNEF_TYPES = new Set(['application/ms-tnef', 'application/vnd.ms-tnef'])

function byteLength(content: Attachment['content']): number {
  return typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength
}

/** A copy on a plain `ArrayBuffer`, which is what `File` accepts as a part. */
function toBytes(content: Attachment['content']): Uint8Array<ArrayBuffer> {
  if (typeof content === 'string') return new Uint8Array(Buffer.from(content))
  if (content instanceof ArrayBuffer) return new Uint8Array(content)
  const copy = new Uint8Array(content.byteLength)
  copy.set(content)
  return copy
}

/**
 * A filename that is safe to file: the last path segment only (some mailers
 * send `C:\Users\…\Plan.pdf`), no control characters, bounded, and never empty.
 */
export function safeFilename(raw: string | null, mimeType: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/^\.+/, '')
  const name = clean || `Anhang${EXTENSION_BY_TYPE[mimeType.toLowerCase()] ?? ''}`
  if (name.length <= FILENAME_MAX_LENGTH) return name
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
  return name.slice(0, FILENAME_MAX_LENGTH - extension.length) + extension
}

function isTnef(attachment: Attachment, filename: string): boolean {
  return TNEF_TYPES.has(attachment.mimeType.toLowerCase()) || filename.toLowerCase() === 'winmail.dat'
}

/** A signature logo: inline, referenced by Content-ID, an image, and small. */
function isInlineImage(attachment: Attachment): boolean {
  return (
    attachment.disposition === 'inline' &&
    Boolean(attachment.contentId) &&
    attachment.mimeType.toLowerCase().startsWith('image/') &&
    byteLength(attachment.content) < INLINE_IMAGE_MAX_BYTES
  )
}

/** Sort a message's parts into files to file and parts to skip, with the reason. */
export function selectAttachments(attachments: readonly Attachment[]): {
  files: MailFile[]
  skipped: SkippedPart[]
} {
  const skipped: SkippedPart[] = []
  const kept: { name: string; attachment: Attachment }[] = []
  for (const attachment of attachments) {
    const name = safeFilename(attachment.filename, attachment.mimeType)
    if (isTnef(attachment, name)) skipped.push({ filename: name, reason: 'tnef' })
    else if (byteLength(attachment.content) === 0) skipped.push({ filename: name, reason: 'empty' })
    else if (isInlineImage(attachment)) skipped.push({ filename: name, reason: 'inline' })
    else kept.push({ name, attachment })
  }
  const names = uniqueFilenames(kept.map((entry) => entry.name))
  const files = kept.map(({ attachment }, index) => ({
    filename: names[index],
    mimeType: attachment.mimeType,
    bytes: toBytes(attachment.content),
  }))
  return { files, skipped }
}

/** Parse a raw RFC 822 message and select its files. */
export async function parseMail(raw: Uint8Array): Promise<ParsedMail> {
  const email: Email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' })
  const { files, skipped } = selectAttachments(email.attachments)
  const from = email.from && !email.from.group ? email.from : undefined
  return {
    messageId: email.messageId?.trim() || null,
    subject: email.subject,
    dateHeader: email.date,
    fromName: from?.name || undefined,
    files,
    skipped,
  }
}
