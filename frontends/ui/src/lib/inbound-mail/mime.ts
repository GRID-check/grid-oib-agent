/**
 * Reading a raw message, and deciding which of its parts are files (ADR-0074).
 *
 * `postal-mime` parses and `file-type` sniffs; this module owns only the
 * product decisions on top of them: which parts a member meant to send, what
 * they are called, and why the others were left out. The body text is never
 * read back out of here, and a forwarded mail is opened for its attachments
 * but never filed as an `.eml`.
 *
 * ## What is a file
 *
 * Every part that names itself (a Content-Disposition `filename` or a
 * Content-Type `name`), whatever its disposition: Apple Mail sends PDFs and
 * text files inline, and the iPhone sends photos inline as `IMG_1234.jpeg`.
 * A nameless part is filed as `Anhang.<ext>` when its bytes say what it is.
 *
 * ## What is not (the skip reasons, exact codes)
 *
 * - `embedded`: part of the message's own layout. Referenced by `cid:` from
 *   the HTML and nameless; or named the way mail clients auto-name pasted
 *   images (`image001.png`, `Outlook-….png`, `~WRL….png`, the filename
 *   patterns Paperless-ngx uses); or an image under 2 KB (a tracking pixel).
 * - `tnef` (`winmail.dat`), `signature` (S/MIME `.p7s`, PGP signature),
 *   `encrypted` (S/MIME `.p7m`, anything under PGP/MIME), `calendar`.
 * - `empty`: no bytes. `unknown-type`: nameless and unrecognisable.
 * - `limit`: past `maxFiles` kept files, or a forward nested deeper than
 *   {@link MAX_FORWARD_DEPTH}.
 *
 * The cap is applied while selecting, so a mail with twenty thousand parts
 * costs one parse and a counter, not twenty thousand sniffs and hashes.
 */

import { createHash } from 'node:crypto'
import { fileTypeFromBuffer } from 'file-type'
import PostalMime, { type Attachment, type Email } from 'postal-mime'
import { documentNameKey, numberedDocumentName } from '@/lib/documents/name-match'
import { stripFormatControls, truncateGraphemes } from '@/lib/text/graphemes'
import type { ParsedMail, SelectedAttachment, SkipReason } from './types'

/** Forwarded mails are opened this many levels deep. */
export const MAX_FORWARD_DEPTH = 3

/** Below this, an image is a tracking pixel or a spacer. */
const TRACKING_PIXEL_MAX_BYTES = 2 * 1024

/** Longest filename kept; the rest of the stem is cut before the extension. */
const FILENAME_MAX_LENGTH = 200

/** The subject is cut to this, an ellipsis included. */
const SUBJECT_MAX_LENGTH = 120

/** What a nameless file is called, before its sniffed extension. */
const NAMELESS_STEM = 'Anhang'

/** How mail clients name the images they paste into the HTML body. */
const AUTO_NAMED_IMAGE = [
  /^image\d{3,}\.(png|jpe?g|gif|bmp)$/i,
  /^Outlook-.*\.(png|jpe?g|gif|bmp)$/i,
  /^~WRL.*\.(png|jpe?g|gif|bmp)$/i,
]

const TNEF_TYPES = new Set(['application/ms-tnef', 'application/vnd.ms-tnef'])
const SIGNATURE_TYPES = new Set([
  'application/pkcs7-signature',
  'application/x-pkcs7-signature',
  'application/pgp-signature',
])
const ENCRYPTED_TYPES = new Set([
  'application/pkcs7-mime',
  'application/x-pkcs7-mime',
  'application/pgp-encrypted',
])
const CALENDAR_TYPES = new Set(['text/calendar', 'application/ics'])

/** Reply and forward markers, in the languages the offices write in. */
const SUBJECT_PREFIX = /^\s*(re|aw|wg|fw|fwd|antw|wtr|tr|sv|vs|rv|enc)\s*(\[\d+\])?\s*:\s*/i

const PARSE_OPTIONS = { forceRfc822Attachments: true, attachmentEncoding: 'arraybuffer' } as const

/** The part of postal-mime's MIME node the text hook reads. */
interface MimeNodeHeaders {
  contentType?: { parsed?: { value?: string; params?: Record<string, string | undefined> } }
  contentDisposition?: { parsed?: { value?: string; params?: Record<string, string | undefined> } }
}

/**
 * postal-mime folds every text/plain and text/html part that is not
 * `disposition=attachment` into the body, so an inline `Massenliste.txt`
 * vanishes. It has no option for that; its internal `isInlineTextNode` hook
 * (present in 3.x and 4.x, pinned exactly in package.json) decides, and this
 * override keeps a text part that names itself as an attachment.
 * `mime.spec.ts` fails if a postal-mime upgrade stops calling it.
 */
class FilingMimeParser extends PostalMime {
  isInlineTextNode(node: MimeNodeHeaders): boolean {
    const type = node.contentType?.parsed?.value
    if (node.contentDisposition?.parsed?.value === 'attachment') return false
    if (type !== 'text/plain' && type !== 'text/html') return false
    return !(
      node.contentDisposition?.parsed?.params?.filename || node.contentType?.parsed?.params?.name
    )
  }
}

function parseMessage(raw: Uint8Array | ArrayBuffer): Promise<Email> {
  return new FilingMimeParser(PARSE_OPTIONS).parse(raw)
}

function toBytes(content: Attachment['content']): Uint8Array {
  if (typeof content === 'string') return new Uint8Array(Buffer.from(content))
  return content instanceof ArrayBuffer ? new Uint8Array(content) : content
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Text a person will read: no control or format characters, one line. */
function cleanText(value: string): string {
  return stripFormatControls(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A filename that is safe to file: the last path segment only (some mailers
 * send `C:\Users\…\Plan.pdf`), NFC, no control or format characters, no
 * leading dots, no trailing dots or spaces, cut by grapheme before the
 * extension. `''` when nothing is left.
 */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  // U+FFFD is what an undeclared 8-bit name (a scanner's Latin-1) decodes to.
  const clean = documentNameKey(cleanText(base).replace(/\uFFFD/g, '_'))
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (clean.length <= FILENAME_MAX_LENGTH) return clean
  const dot = clean.lastIndexOf('.')
  const extension = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : ''
  return (
    truncateGraphemes(
      clean.slice(0, clean.length - extension.length),
      FILENAME_MAX_LENGTH - extension.length
    ) + extension
  )
}

/** The subject for the notification: markers stripped, cleaned, cut. */
export function cleanSubject(subject: string | undefined): string | null {
  let value = cleanText(subject ?? '')
  while (SUBJECT_PREFIX.test(value)) value = value.replace(SUBJECT_PREFIX, '')
  return truncateGraphemes(value.trim(), SUBJECT_MAX_LENGTH, '…') || null
}

/** Content-IDs the HTML body references, angle brackets stripped, lowercased. */
function referencedContentIds(html: string | undefined): Set<string> {
  const ids = new Set<string>()
  for (const match of (html ?? '').matchAll(/cid:([^"'\s)>]+)/gi)) {
    try {
      ids.add(decodeURIComponent(match[1]).toLowerCase())
    } catch {
      ids.add(match[1].toLowerCase())
    }
  }
  return ids
}

/** Whether a message's own Content-Type is PGP/MIME or S/MIME encryption. */
function isEncryptedMessage(email: Email): boolean {
  const contentType = email.headers.find((header) => header.key === 'content-type')?.value ?? ''
  return /^\s*multipart\/encrypted\b/i.test(contentType)
}

interface MessageContext {
  cids: Set<string>
  encrypted: boolean
}

/** A reason a part is not a file, decided from its headers and size alone. */
function structuralSkip(
  attachment: Attachment,
  name: string,
  size: number,
  context: MessageContext
): SkipReason | null {
  const type = attachment.mimeType.toLowerCase()
  const lower = name.toLowerCase()
  if (context.encrypted || ENCRYPTED_TYPES.has(type) || lower.endsWith('.p7m')) return 'encrypted'
  if (TNEF_TYPES.has(type) || lower === 'winmail.dat') return 'tnef'
  if (SIGNATURE_TYPES.has(type) || lower.endsWith('.p7s')) return 'signature'
  if (CALENDAR_TYPES.has(type) || lower.endsWith('.ics')) return 'calendar'
  if (size === 0) return 'empty'
  return isEmbedded(attachment, name, size, context) ? 'embedded' : null
}

function isEmbedded(
  attachment: Attachment,
  name: string,
  size: number,
  context: MessageContext
): boolean {
  const contentId = attachment.contentId?.replace(/^<|>$/g, '').toLowerCase()
  const referenced =
    Boolean(attachment.related) || (contentId !== undefined && context.cids.has(contentId))
  if (referenced && !name) return true
  if (AUTO_NAMED_IMAGE.some((pattern) => pattern.test(name))) return true
  return attachment.mimeType.toLowerCase().startsWith('image/') && size < TRACKING_PIXEL_MAX_BYTES
}

/**
 * Distinct names in one pass: the second `Plan.pdf` becomes `Plan (2).pdf`,
 * compared on the documents' own identity key (`documentNameKey`). The same
 * bytes under the same name are filed once. Linear: each name keeps the next
 * free number, so a thousand `image.png` never rescan from `(2)`.
 */
class NameLedger {
  private readonly taken = new Set<string>()
  private readonly digestsByName = new Map<string, Set<string>>()
  private readonly nextNumber = new Map<string, number>()

  /** The name to file under, or null when these bytes already went under this name. */
  claim(name: string, digest: string): string | null {
    const key = documentNameKey(name)
    const digests = this.digestsByName.get(key) ?? new Set<string>()
    if (digests.has(digest)) return null
    digests.add(digest)
    this.digestsByName.set(key, digests)
    const filename = this.taken.has(key) ? this.numbered(name, key) : name
    this.taken.add(documentNameKey(filename))
    return filename
  }

  private numbered(name: string, key: string): string {
    let n = this.nextNumber.get(key) ?? 2
    while (this.taken.has(numberedDocumentName(name, n))) n += 1
    this.nextNumber.set(key, n + 1)
    return numberedDocumentName(name, n)
  }
}

interface Selection {
  maxFiles: number
  attachments: SelectedAttachment[]
  skipped: { filename: string; reason: SkipReason }[]
  names: NameLedger
}

/** The name and type a part is filed under, or null when nothing says what it is. */
async function identify(
  attachment: Attachment,
  bytes: Uint8Array
): Promise<{ name: string; type: string } | null> {
  const name = safeFilename(attachment.filename ?? '')
  if (name) return { name, type: attachment.mimeType }
  const sniffed = await fileTypeFromBuffer(bytes)
  return sniffed ? { name: `${NAMELESS_STEM}.${sniffed.ext}`, type: sniffed.mime } : null
}

function isFull(selection: Selection): boolean {
  return selection.attachments.length >= selection.maxFiles
}

async function selectPart(
  attachment: Attachment,
  context: MessageContext,
  selection: Selection
): Promise<void> {
  const bytes = toBytes(attachment.content)
  const declaredName = safeFilename(attachment.filename ?? '')
  const shown = declaredName || NAMELESS_STEM
  const reason =
    structuralSkip(attachment, declaredName, bytes.byteLength, context) ??
    (isFull(selection) ? 'limit' : null)
  if (reason) {
    selection.skipped.push({ filename: shown, reason })
    return
  }
  const identity = await identify(attachment, bytes)
  if (!identity) {
    selection.skipped.push({ filename: shown, reason: 'unknown-type' })
    return
  }
  const digest = sha256(bytes)
  const filename = selection.names.claim(identity.name, digest)
  if (filename)
    selection.attachments.push({
      filename,
      contentType: identity.type,
      content: bytes,
      sha256: digest,
    })
}

async function selectForward(
  attachment: Attachment,
  depth: number,
  selection: Selection
): Promise<void> {
  const shown = safeFilename(attachment.filename ?? '') || 'Weitergeleitet.eml'
  if (depth >= MAX_FORWARD_DEPTH || isFull(selection)) {
    selection.skipped.push({ filename: shown, reason: 'limit' })
    return
  }
  const forwarded = await parseMessage(toBytes(attachment.content))
  await selectFrom(forwarded, depth + 1, selection)
}

async function selectFrom(email: Email, depth: number, selection: Selection): Promise<void> {
  const context: MessageContext = {
    cids: referencedContentIds(email.html),
    encrypted: isEncryptedMessage(email),
  }
  for (const attachment of email.attachments) {
    if (attachment.mimeType.toLowerCase() === 'message/rfc822' && !context.encrypted) {
      await selectForward(attachment, depth, selection)
    } else {
      await selectPart(attachment, context, selection)
    }
  }
}

/**
 * Parse a raw RFC 822 message and select its files. Throws when postal-mime
 * cannot parse it at all (its nesting and header-size limits).
 */
export async function parseMail(
  raw: Uint8Array,
  options: { maxFiles: number }
): Promise<ParsedMail> {
  const email = await parseMessage(raw)
  const selection: Selection = {
    maxFiles: options.maxFiles,
    attachments: [],
    skipped: [],
    names: new NameLedger(),
  }
  await selectFrom(email, 0, selection)
  const from = email.from && !email.from.group ? email.from : undefined
  return {
    messageId: email.messageId?.trim() || null,
    subject: cleanSubject(email.subject),
    fromName: cleanText(from?.name ?? '') || null,
    attachments: selection.attachments,
    skipped: selection.skipped,
  }
}

/**
 * What makes two deliveries the same mail: the Message-ID (trimmed, without
 * angle brackets, lowercased) and the sorted sha256 digests of the selected
 * attachments. A redelivery has the same key; a scanner that reuses its
 * Message-ID for every scan does not. With no Message-ID, the digests alone.
 */
export function deliveryKey(messageId: string | null, digests: readonly string[]): string {
  const id = messageId?.trim().replace(/^<|>$/g, '').trim().toLowerCase() || null
  const sorted = [...digests].sort()
  const material = id === null ? sorted.join('\n') : [id, ...sorted].join('\n')
  return sha256(new Uint8Array(Buffer.from(material, 'utf8')))
}
