/**
 * Reading a raw message: its header block, its thread headers and
 * participants, and which of its MIME parts a person decides on (ADR-0134,
 * receive job step 5).
 *
 * `postal-mime` parses and `file-type` sniffs; this module owns only the
 * product decisions on top of them: which parts a sender meant to send, what
 * they are called, what is suspicious about them, and why the others were left
 * out. The body text is never read here (the Python reader owns it), and
 * nothing here throws: a message the parser refuses is `unreadable`, and the
 * mail still waits with its original (`readMime`).
 *
 * ## What is a part
 *
 * Every attachment postal-mime reports, whatever its disposition: Apple Mail
 * sends PDFs and text files inline, and the iPhone sends photos inline as
 * `IMG_1234.jpeg`. A text part that names itself is kept as an attachment,
 * where postal-mime would fold it into the body (`AttachmentParser`). A
 * nameless part keeps no name (`filename: null`); its extension comes from its
 * bytes when they say what it is, and the person names it when filing. A
 * forwarded message is opened {@link MAX_FORWARD_DEPTH} levels deep and its
 * parts carry `forwarded_inner`; the forward itself stays in the original.
 *
 * ## What is not staged (`NOT_STAGED_REASONS`, exact codes)
 *
 * - `embedded`: part of the message's own layout. Referenced by Content-ID
 *   from the HTML and nameless; or named the way mail clients auto-name pasted
 *   images (`image001.png`, `Outlook-….png`, `~WRL….png`); or an image under
 *   2 KiB (a tracking pixel).
 * - `tnef` (`winmail.dat`), `signature` (S/MIME `.p7s`, PGP signature),
 *   `encrypted` (S/MIME `.p7m`, anything under PGP/MIME), `calendar` (the
 *   Python reader renders an invitation into the text), `empty`.
 * - `archive`: an archive the office does not accept as a file. It is never
 *   expanded, so a zip bomb costs a sniff of its first bytes.
 * - `size`: larger than {@link MAX_PART_BYTES}. `limit`: past
 *   {@link MAX_STAGED_PARTS}, or a forward too deep or too large to open.
 *
 * ## What is flagged (`PART_RISK_FLAGS`)
 *
 * `type_not_accepted` (shown, not fileable: the office's accepted types, the
 * list the upload enforces), `type_mismatch` (the bytes contradict the name:
 * an `.exe` called `.pdf`), `encrypted` (a password-protected PDF, Office file
 * or zip), `macro` (a macro-enabled Office type, only where the office accepts
 * one) and `forwarded_inner`.
 *
 * ## Budgets
 *
 * Every pass is bounded by counted work, never by time: the header block is
 * read to {@link MAX_HEADER_BLOCK_BYTES}, a sniff sees {@link SNIFF_BYTES},
 * the parts of all forwards together stop at {@link MAX_TOTAL_PARTS}, and the
 * result reports what was done (`MimeWork`) so the hostile corpus can assert it.
 */

import { createHash } from 'node:crypto'
import { fileTypeFromBuffer } from 'file-type'
import PostalMime, { addressParser, type Address, type Attachment, type Email } from 'postal-mime'
import { splitDocumentName, MAX_DOCUMENT_NAME_LENGTH } from '@/lib/documents/display-name'
import { documentNameKey } from '@/lib/documents/name-match'
import { numberedFilename } from '@/lib/mail-import/naming'
import { domainOf, normalizeMessageId, parseInReplyTo, parseReferences, threadIndexGuid } from '@/lib/mail-thread/mail-threading'
import { singleLine, truncateGraphemes } from '@/lib/text/graphemes'
import { uploadExtensionOf } from '@/shared/config/file-upload'
import { asciiLower } from './address'
import type { NotStagedReason, PartRiskFlag } from './contract'

/** Forwarded mails are opened this many levels deep. */
export const MAX_FORWARD_DEPTH = 3

/** Parts a person decides on, per mail. */
export const MAX_STAGED_PARTS = 100

/** Not-staged parts listed by name, per mail; the rest are only counted. */
export const MAX_NOT_STAGED_LISTED = 100

/** Every MIME part of the message and its forwards together. postal-mime's own default per parse. */
export const MAX_TOTAL_PARTS = 10_000

/** One part may be at most this large. The whole message is at most 26 MiB, so this rarely binds. */
export const MAX_PART_BYTES = 25 * 1024 * 1024

/** The header block is read this far for {@link rawHeaderFields}; postal-mime's own header cap. */
export const MAX_HEADER_BLOCK_BYTES = 2 * 1024 * 1024

/** A sniff sees at most this much of a part: magic numbers and the first entries of a zip. */
export const SNIFF_BYTES = 256 * 1024

/** A PDF's encryption dictionary is looked for in this many bytes at its end, where the trailer is. */
const PDF_TRAILER_BYTES = 1024 * 1024

/** Participants kept, and their distinct domains. */
const MAX_PARTICIPANTS = 200
const MAX_PARTICIPANT_DOMAINS = 50

/** Display texts: a subject and a display name. */
const MAX_SUBJECT_LENGTH = 1000
const MAX_DISPLAY_NAME_LENGTH = 200

/** Below this, an image is a tracking pixel or a spacer. */
const TRACKING_PIXEL_MAX_BYTES = 2 * 1024

/** An extension is at most this long, the dot included; past it the name has none worth keeping. */
const MAX_EXTENSION_LENGTH = 16

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
const ENCRYPTED_TYPES = new Set(['application/pkcs7-mime', 'application/x-pkcs7-mime', 'application/pgp-encrypted'])
const CALENDAR_TYPES = new Set(['text/calendar', 'application/ics'])

/** Archive formats by sniffed extension and by name. */
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.zst', '.cab'])

/** Office types that carry macros by design (`[Content_Types].xml` with a macro-enabled main part). */
const MACRO_EXTENSIONS = new Set(['.docm', '.dotm', '.xlsm', '.xltm', '.xlam', '.pptm', '.potm', '.ppsm', '.ppam'])

/** The Office Open XML family: a zip of XML, or a CFB container once a password encrypts it. */
const OOXML_EXTENSIONS = new Set(['.docx', '.dotx', '.xlsx', '.xltx', '.pptx', '.potx', '.ppsx', ...MACRO_EXTENSIONS])

/**
 * What `file-type` may call the bytes of a name with this extension, for the
 * types whose bytes have a signature. An OOXML file may sniff as a bare `zip`
 * when its type-revealing entry lies past {@link SNIFF_BYTES}.
 */
const EXPECTED_SNIFFS: Readonly<Record<string, readonly string[]>> = {
  '.pdf': ['pdf'],
  '.png': ['png'],
  '.jpg': ['jpg'],
  '.jpeg': ['jpg'],
  '.gif': ['gif'],
  '.webp': ['webp'],
  '.tif': ['tif'],
  '.tiff': ['tif'],
  '.heic': ['heic'],
  '.bmp': ['bmp'],
  '.doc': ['cfb'],
  '.xls': ['cfb'],
  '.ppt': ['cfb'],
  '.msg': ['cfb'],
  '.zip': ['zip'],
  '.7z': ['7z'],
  '.rar': ['rar'],
  '.gz': ['gz'],
  '.dwg': ['dwg'],
  '.docx': ['docx', 'zip'],
  '.dotx': ['docx', 'zip'],
  '.docm': ['docm', 'docx', 'zip'],
  '.dotm': ['docm', 'docx', 'zip'],
  '.xlsx': ['xlsx', 'zip'],
  '.xltx': ['xlsx', 'zip'],
  '.xlsm': ['xlsm', 'xlsx', 'zip'],
  '.xltm': ['xlsm', 'xlsx', 'zip'],
  '.xlam': ['xlsm', 'xlsx', 'zip'],
  '.pptx': ['pptx', 'zip'],
  '.potx': ['pptx', 'zip'],
  '.ppsx': ['pptx', 'zip'],
  '.pptm': ['pptm', 'pptx', 'zip'],
  '.potm': ['pptm', 'pptx', 'zip'],
  '.ppsm': ['pptm', 'pptx', 'zip'],
  '.ppam': ['pptm', 'pptx', 'zip'],
}

/** Text formats: no signature to check, and anything `file-type` recognises in them is a contradiction. */
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.html', '.htm', '.xml', '.json', '.ifc', '.ics', '.vcf'])

/** What `file-type` may still find in a text file without the name lying. */
const TEXTUAL_SNIFFS = new Set(['xml', 'svg', 'html', 'ics', 'vcf'])

/** Executable formats: whatever a name says, these bytes contradict it. */
const EXECUTABLE_SNIFFS = new Set(['exe', 'elf', 'macho', 'msi', 'apk', 'dex', 'class', 'wasm', 'swf', 'deb', 'rpm'])

/** What a name may be on Windows, where these devices are not files. */
const WINDOWS_RESERVED_STEM = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

// ---------------------------------------------------------------------------
// The raw header block
// ---------------------------------------------------------------------------

/** One header field, its name lowercased, its value unfolded and otherwise as sent. */
export interface HeaderField {
  name: string
  value: string
}

/** The byte offset where the body starts (after the first empty line), or -1 when there is none within `limit`. */
function bodyOffset(bytes: Buffer, limit: number): number {
  const window = bytes.subarray(0, Math.min(bytes.length, limit))
  const lf = window.indexOf('\n\n')
  const crlf = window.indexOf('\n\r\n')
  const ends = [lf === -1 ? -1 : lf + 2, crlf === -1 ? -1 : crlf + 3].filter((index) => index !== -1)
  return ends.length > 0 ? Math.min(...ends) : -1
}

function asBuffer(raw: Uint8Array): Buffer {
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
}

/**
 * The header fields of the raw message, unfolded, in order, duplicates kept.
 * The block ends at the first empty line, as it does for mailauth's and
 * postal-mime's parsers. `null` when a line in it is neither a field nor a
 * continuation, or when no empty line ends it within
 * {@link MAX_HEADER_BLOCK_BYTES} (a message that is all header, or one
 * 8 MiB line).
 *
 * Read over the raw bytes rather than taken from either parser, because the
 * point of reading it is to catch where they would disagree: a DKIM verifier
 * signs the LAST instance of a field and a MIME parser reads the FIRST, and an
 * unsigned duplicate above a signature is how a signed mail gets a new
 * Subject, recipient or boundary. Linear in the block.
 */
export function rawHeaderFields(raw: Uint8Array): HeaderField[] | null {
  const bytes = asBuffer(raw)
  const offset = bodyOffset(bytes, MAX_HEADER_BLOCK_BYTES)
  const end = offset === -1 ? (bytes.length <= MAX_HEADER_BLOCK_BYTES ? bytes.length : -1) : offset
  if (end === -1) return null
  const lines = bytes.toString('utf8', 0, end).split('\n')
  const fields: HeaderField[] = []
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') break
    if (line[0] === ' ' || line[0] === '\t') {
      const last = fields.at(-1)
      if (!last) return null
      last.value += line
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) return null
    fields.push({ name: asciiLower(line.slice(0, colon).trim()), value: line.slice(colon + 1) })
  }
  return fields
}

/** The value of the first field named `name` (lowercase), unfolded and trimmed. */
export function headerValue(fields: readonly HeaderField[], name: string): string | null {
  return fields.find((field) => field.name === name)?.value.trim() ?? null
}

/**
 * What makes two deliveries of one mail the same mail (`delivery_key`): the
 * header fields an author writes (From, To, Cc, Subject, Date, Message-ID, as
 * sent) and the body bytes, hashed. Every relay on the way prepends its own
 * Received, ARC and Authentication-Results fields, so a retry by the sending
 * server after a lost answer has other raw bytes and still this key. A copy
 * that shares the key is the same mail in every part a person or a DKIM
 * signature reads, so holding the first and answering the second `duplicate`
 * loses nothing.
 */
export function deliveryKey(raw: Uint8Array): string {
  const bytes = asBuffer(raw)
  const offset = bodyOffset(bytes, bytes.length)
  const fields = rawHeaderFields(raw) ?? []
  const hash = createHash('sha256')
  for (const name of ['from', 'to', 'cc', 'subject', 'date', 'message-id']) {
    for (const field of fields) if (field.name === name) hash.update(`${name}:${field.value.trim()}\n`)
  }
  hash.update('\n')
  hash.update(offset === -1 ? bytes : bytes.subarray(offset))
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export interface MailMailbox {
  /** The display name, cleaned to one line, or null. Never evidence of who sent it. */
  name: string | null
  /** The address, ASCII-lowercased. */
  address: string
  /** The domain as threads compare it (`domainOf` of the thread core), or null. */
  domain: string | null
}

export type ParticipantRole = 'from' | 'sender' | 'reply_to' | 'to' | 'cc'

export interface MailParticipant extends MailMailbox {
  role: ParticipantRole
}

/** The headers the receive job stores and the thread matcher reads. */
export interface MailHeaders {
  /**
   * The thread headers, read by the thread core's own parsers
   * (`lib/mail-thread/mail-threading.ts`), so the receive job, the thread
   * tables and the archive import key messages identically: Message-ID
   * without brackets and with its domain lowercased; In-Reply-To (at most 5);
   * References (the root and the 49 most recent); Outlook's Thread-Index
   * conversation GUID.
   */
  messageId: string | null
  inReplyTo: string[]
  references: string[]
  threadIndexGuid: string | null
  /** The subject as a person reads it: one line, cut between graphemes. Prefixes are kept. */
  subject: string | null
  /** The Date header, or null when it is missing or not a date. Unclamped; see `clampSentAt`. */
  sentAtHeader: Date | null
  /** The single From mailbox, or null when there is none or more than one. */
  from: MailMailbox | null
  /** From, Sender, Reply-To, To and Cc, at most {@link MAX_PARTICIPANTS}. */
  participants: MailParticipant[]
  /** The distinct domains of the participants, at most {@link MAX_PARTICIPANT_DOMAINS}. */
  participantDomains: string[]
  /** How many addresses To and Cc name, counted before any cap. */
  recipientCount: number
}

/** One part a person decides on. */
export interface MailAttachment {
  /** 1-based, in message order. */
  position: number
  /** A name safe to file under, distinct within the mail, or null when the part named none. */
  filename: string | null
  /** The extension the upload reads (`.pdf`), from the name or else from the bytes; null when neither says. */
  extension: string | null
  /** The Content-Type as sent, lowercased. Never trusted. */
  declaredType: string
  /** What `file-type` found, or null. */
  sniffedType: string | null
  size: number
  /** Hex SHA-256 of `content`. */
  sha256: string
  content: Uint8Array
  riskFlags: PartRiskFlag[]
  /** 0 for the mail's own parts, n for a part of an n-level forward. */
  forwardDepth: number
}

/** A part that was not staged, and why. Its bytes are in the original. */
export interface NotStagedPart {
  filename: string | null
  reason: NotStagedReason
  size: number
}

/** Counted work, so a budget can be asserted without a clock. */
export interface MimeWork {
  /** Messages parsed: the mail and each forward opened. */
  messagesParsed: number
  /** Attachments postal-mime reported, across all of them. */
  partsVisited: number
  /** `file-type` calls. */
  sniffs: number
  /** Bytes handed to `file-type`. */
  bytesSniffed: number
  /** Bytes hashed for staged parts. */
  bytesHashed: number
}

/** Why a message could not be read at all. The mail still waits, with its original. */
export type UnreadableReason = 'header_size' | 'nesting' | 'part_count' | 'addresses' | 'malformed'

export type MimeRead =
  | {
      kind: 'read'
      headers: MailHeaders
      attachments: MailAttachment[]
      notStaged: NotStagedPart[]
      /** Not-staged parts past {@link MAX_NOT_STAGED_LISTED}, counted only. */
      notStagedOverflow: number
      work: MimeWork
    }
  | { kind: 'unreadable'; reason: UnreadableReason; work: MimeWork }

export interface MimeReadOptions {
  /** The office's accepted extensions, lowercased with the dot (`acceptedTypesForOrganization`). */
  acceptedTypes: readonly string[]
}

/** The part of postal-mime's MIME node the text hook reads. Internal to postal-mime, hence restated. */
interface MimeNodeHeaders {
  contentType?: { parsed?: { value?: string; params?: Record<string, string | undefined> } }
  contentDisposition?: { parsed?: { value?: string; params?: Record<string, string | undefined> } }
}

/**
 * postal-mime folds every text/plain and text/html part that is not
 * `disposition=attachment` into the body, so an inline `Massenliste.txt`
 * would vanish. It has no option for that; its `isInlineTextNode` hook
 * (internal, present in 3.x and 4.x) decides, and this override keeps a text
 * part that names itself as an attachment. `mime.spec.ts` fails if an upgrade
 * stops calling it.
 */
class AttachmentParser extends PostalMime {
  isInlineTextNode(node: MimeNodeHeaders): boolean {
    const type = node.contentType?.parsed?.value
    if (node.contentDisposition?.parsed?.value === 'attachment') return false
    if (type !== 'text/plain' && type !== 'text/html') return false
    return !(node.contentDisposition?.parsed?.params?.filename || node.contentType?.parsed?.params?.name)
  }
}

/** Thrown when the part budget across forwards is spent, so the forward is `limit` rather than the mail `unreadable`. */
class PartBudgetSpent extends Error {}

function newWork(): MimeWork {
  return { messagesParsed: 0, partsVisited: 0, sniffs: 0, bytesSniffed: 0, bytesHashed: 0 }
}

function unreadableReason(error: unknown): UnreadableReason {
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  if (code === 'EMAXHEADERSIZE') return 'header_size'
  if (code === 'EMAXNESTINGDEPTH') return 'nesting'
  if (code === 'EMAXPARTCOUNT') return 'part_count'
  if (code === 'EMAXFORWARDEDADDRESSES') return 'addresses'
  return 'malformed'
}

async function parseMessage(raw: Uint8Array, maxPartCount: number, work: MimeWork): Promise<Email> {
  work.messagesParsed += 1
  const parser = new AttachmentParser({
    forceRfc822Attachments: true,
    attachmentEncoding: 'arraybuffer',
    maxPartCount,
    maxRfc822NestingDepth: 0,
  })
  return parser.parse(raw)
}

function toBytes(content: Attachment['content']): Uint8Array {
  if (typeof content === 'string') return new Uint8Array(Buffer.from(content))
  return content instanceof ArrayBuffer ? new Uint8Array(content) : content
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A filename that is safe to file and to download: the last path segment only
 * (some mailers send `C:\Users\…\Plan.pdf`), one line without format or
 * control characters, NFC, no characters Windows refuses, no leading dots, no
 * trailing dots or spaces, no bare device name (`CON.pdf` becomes `CON_.pdf`),
 * cut between graphemes before the extension to
 * `MAX_DOCUMENT_NAME_LENGTH`. `''` when nothing is left.
 */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  // U+FFFD is what an undeclared 8-bit name (a scanner's Latin-1) decodes to.
  const clean = documentNameKey(singleLine(base).replace(/\uFFFD/g, '_').replace(/[<>:"|?*]/g, '_'))
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    // Windows reads `CON.pdf` and `con.tar.gz` as the device: the segment before the first dot counts.
    .replace(/^[^.]*/, (segment) => (WINDOWS_RESERVED_STEM.test(segment) ? `${segment}_` : segment))
  const { stem, extension } = splitDocumentName(clean)
  const kept = extension.length <= MAX_EXTENSION_LENGTH ? extension : ''
  const head = kept ? stem : clean
  if (head.length + kept.length <= MAX_DOCUMENT_NAME_LENGTH) return clean
  return truncateGraphemes(head, MAX_DOCUMENT_NAME_LENGTH - kept.length).replace(/[.\s]+$/, '') + kept
}

/**
 * Distinct names in one pass: the second `Plan.pdf` becomes `Plan (2).pdf`,
 * compared on the documents' own identity key (`documentNameKey`). The same
 * bytes under the same name are staged once. Linear: each name keeps its next
 * free number, so a thousand `image.png` never rescan from `(2)`.
 */
class NameLedger {
  private readonly taken = new Set<string>()
  private readonly digestsByName = new Map<string, Set<string>>()
  private readonly nextNumber = new Map<string, number>()

  /** The name to stage under, or null when these bytes already went under this name. */
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

  private readonly namelessDigests = new Set<string>()

  /** Whether these bytes, nameless, are new to this mail (and now claimed). */
  claimNameless(digest: string): boolean {
    if (this.namelessDigests.has(digest)) return false
    this.namelessDigests.add(digest)
    return true
  }

  private numbered(name: string, key: string): string {
    let n = this.nextNumber.get(key) ?? 2
    while (this.taken.has(documentNameKey(numberedFilename(name, n)))) n += 1
    this.nextNumber.set(key, n + 1)
    return documentNameKey(numberedFilename(name, n))
  }
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/** A Date header as a time, or null when it is not one. */
export function parseDateHeader(value: string | null | undefined): Date | null {
  if (!value) return null
  const time = Date.parse(value.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim())
  if (Number.isNaN(time)) return null
  const date = new Date(time)
  const year = date.getUTCFullYear()
  return year >= 1970 && year <= 9999 ? date : null
}

function mailboxesOf(addresses: readonly Address[] | Address | undefined): MailMailbox[] {
  const list = addresses === undefined ? [] : Array.isArray(addresses) ? addresses : [addresses]
  return list
    .flatMap((entry) => (entry.group ? entry.group : [entry]))
    .flatMap((mailbox) => {
      const address = asciiLower(singleLine(mailbox.address ?? ''))
      if (!address) return []
      const name = truncateGraphemes(singleLine(mailbox.name ?? ''), MAX_DISPLAY_NAME_LENGTH)
      return [{ name: name || null, address, domain: domainOf(address) }]
    })
}

/**
 * The From mailboxes, from every From field: postal-mime's `from` keeps only
 * the first address of the first field, which would hide a second author.
 */
function fromMailboxes(email: Email): MailMailbox[] {
  return email.headers
    .filter((header) => header.key === 'from')
    .flatMap((header) => mailboxesOf(addressParser(header.value, { flatten: true })))
}

function readHeaders(email: Email): MailHeaders {
  const fromBoxes = fromMailboxes(email)
  const to = mailboxesOf(email.to)
  const cc = mailboxesOf(email.cc)
  const roles: [ParticipantRole, MailMailbox[]][] = [
    ['from', fromBoxes],
    ['sender', mailboxesOf(email.sender)],
    ['reply_to', mailboxesOf(email.replyTo)],
    ['to', to],
    ['cc', cc],
  ]
  const participants = roles
    .flatMap(([role, boxes]) => boxes.map((box) => ({ ...box, role })))
    .slice(0, MAX_PARTICIPANTS)
  const domains = [...new Set(participants.flatMap((participant) => (participant.domain ? [participant.domain] : [])))]
  const threadIndex = email.headers.find((header) => header.key === 'thread-index')?.value
  const subject = truncateGraphemes(singleLine(email.subject ?? ''), MAX_SUBJECT_LENGTH, '…')
  return {
    messageId: normalizeMessageId(email.messageId),
    inReplyTo: parseInReplyTo(email.inReplyTo),
    references: parseReferences(email.references),
    threadIndexGuid: threadIndexGuid(threadIndex),
    subject: subject || null,
    sentAtHeader: parseDateHeader(email.headers.find((header) => header.key === 'date')?.value),
    from: fromBoxes.length === 1 ? fromBoxes[0] : null,
    participants,
    participantDomains: domains.slice(0, MAX_PARTICIPANT_DOMAINS),
    recipientCount: to.length + cc.length,
  }
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

interface MessageContext {
  encrypted: boolean
  depth: number
}

interface Selection {
  accepted: ReadonlySet<string>
  attachments: MailAttachment[]
  notStaged: NotStagedPart[]
  notStagedOverflow: number
  names: NameLedger
  work: MimeWork
}

function sha256(bytes: Uint8Array, work: MimeWork): string {
  work.bytesHashed += bytes.byteLength
  return createHash('sha256').update(bytes).digest('hex')
}

function skip(selection: Selection, filename: string | null, reason: NotStagedReason, size: number): void {
  if (selection.notStaged.length >= MAX_NOT_STAGED_LISTED) {
    selection.notStagedOverflow += 1
    return
  }
  selection.notStaged.push({ filename, reason, size })
}

/** Whether a message's own Content-Type is PGP/MIME or S/MIME encryption. */
function isEncryptedMessage(email: Email): boolean {
  const contentType = email.headers.find((header) => header.key === 'content-type')?.value ?? ''
  return /^\s*(multipart\/encrypted|application\/(x-)?pkcs7-mime)\b/i.test(contentType)
}

function isEmbedded(attachment: Attachment, name: string, size: number): boolean {
  if (attachment.related && !name) return true
  if (AUTO_NAMED_IMAGE.some((pattern) => pattern.test(name))) return true
  return attachment.mimeType.toLowerCase().startsWith('image/') && size < TRACKING_PIXEL_MAX_BYTES
}

/** A reason a part is not staged, decided from its headers, name and size alone. */
function structuralSkip(attachment: Attachment, name: string, size: number, context: MessageContext): NotStagedReason | null {
  const type = attachment.mimeType.toLowerCase()
  const lower = name.toLowerCase()
  if (context.encrypted || ENCRYPTED_TYPES.has(type) || lower.endsWith('.p7m')) return 'encrypted'
  if (TNEF_TYPES.has(type) || lower === 'winmail.dat') return 'tnef'
  if (SIGNATURE_TYPES.has(type) || lower.endsWith('.p7s')) return 'signature'
  if (CALENDAR_TYPES.has(type) || lower.endsWith('.ics')) return 'calendar'
  if (size === 0) return 'empty'
  if (size > MAX_PART_BYTES) return 'size'
  return isEmbedded(attachment, name, size) ? 'embedded' : null
}

async function sniff(bytes: Uint8Array, work: MimeWork): Promise<string | null> {
  const window = bytes.subarray(0, Math.min(bytes.byteLength, SNIFF_BYTES))
  work.sniffs += 1
  work.bytesSniffed += window.byteLength
  try {
    return (await fileTypeFromBuffer(window))?.ext ?? null
  } catch {
    // A sniffer error is no verdict about the bytes; the scan and the upload still look at them.
    return null
  }
}

/** Whether the bytes are a password-protected file of a kind that says so in its structure. */
function isEncryptedFile(bytes: Uint8Array, extension: string | null, sniffed: string | null): boolean {
  if (extension && OOXML_EXTENSIONS.has(extension) && sniffed === 'cfb') return true
  if (sniffed === 'zip' || extension === '.zip') {
    // The general-purpose bit 0 of the first local file header (APPNOTE 4.4.4).
    return bytes.byteLength > 6 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[6] & 1) === 1
  }
  if (sniffed === 'pdf') {
    const tail = asBuffer(bytes).subarray(Math.max(0, bytes.byteLength - PDF_TRAILER_BYTES))
    return tail.includes('/Encrypt')
  }
  return false
}

/** Whether the bytes contradict the name. */
function contradictsName(extension: string | null, sniffed: string | null): boolean {
  if (sniffed && EXECUTABLE_SNIFFS.has(sniffed)) return extension !== `.${sniffed}`
  if (!extension) return false
  const expected = EXPECTED_SNIFFS[extension]
  if (expected) return sniffed === null || !expected.includes(sniffed)
  if (TEXT_EXTENSIONS.has(extension)) return sniffed !== null && !TEXTUAL_SNIFFS.has(sniffed)
  return false
}

function riskFlagsOf(
  bytes: Uint8Array,
  extension: string | null,
  sniffed: string | null,
  accepted: ReadonlySet<string>,
  depth: number
): PartRiskFlag[] {
  const flags: PartRiskFlag[] = []
  const isAccepted = extension !== null && accepted.has(extension)
  if (!isAccepted) flags.push('type_not_accepted')
  const encrypted = isEncryptedFile(bytes, extension, sniffed)
  if (encrypted) flags.push('encrypted')
  else if (contradictsName(extension, sniffed)) flags.push('type_mismatch')
  if (isAccepted && extension && MACRO_EXTENSIONS.has(extension)) flags.push('macro')
  if (depth > 0) flags.push('forwarded_inner')
  return flags
}

async function selectPart(attachment: Attachment, context: MessageContext, selection: Selection): Promise<void> {
  const bytes = toBytes(attachment.content)
  const name = safeFilename(attachment.filename ?? '')
  const shown = name || null
  const reason = structuralSkip(attachment, name, bytes.byteLength, context)
  if (reason) return skip(selection, shown, reason, bytes.byteLength)
  if (selection.attachments.length >= MAX_STAGED_PARTS) return skip(selection, shown, 'limit', bytes.byteLength)

  const sniffed = await sniff(bytes, selection.work)
  const extension = (name ? uploadExtensionOf(name) : '') || (sniffed ? `.${sniffed}` : '') || null
  const isArchive = extension !== null && ARCHIVE_EXTENSIONS.has(extension)
  if (isArchive && !selection.accepted.has(extension)) return skip(selection, shown, 'archive', bytes.byteLength)

  const digest = sha256(bytes, selection.work)
  const filename = name ? selection.names.claim(name, digest) : null
  if (name && filename === null) return
  if (!name && !selection.names.claimNameless(digest)) return
  selection.attachments.push({
    position: selection.attachments.length + 1,
    filename,
    extension,
    declaredType: attachment.mimeType.toLowerCase(),
    sniffedType: sniffed,
    size: bytes.byteLength,
    sha256: digest,
    content: bytes,
    riskFlags: riskFlagsOf(bytes, extension, sniffed, selection.accepted, context.depth),
    forwardDepth: context.depth,
  })
}

async function selectForward(attachment: Attachment, depth: number, selection: Selection): Promise<void> {
  const bytes = toBytes(attachment.content)
  const shown = safeFilename(attachment.filename ?? '') || null
  const remaining = MAX_TOTAL_PARTS - selection.work.partsVisited
  if (depth >= MAX_FORWARD_DEPTH || remaining <= 1) return skip(selection, shown, 'limit', bytes.byteLength)
  let forwarded: Email
  try {
    forwarded = await parseMessage(bytes, remaining, selection.work)
  } catch {
    // A forward postal-mime refuses is still in the original; the mail itself is readable.
    return skip(selection, shown, 'limit', bytes.byteLength)
  }
  await selectFrom(forwarded, depth + 1, selection)
}

async function selectFrom(email: Email, depth: number, selection: Selection): Promise<void> {
  const context: MessageContext = { encrypted: isEncryptedMessage(email), depth }
  for (const attachment of email.attachments) {
    selection.work.partsVisited += 1
    if (selection.work.partsVisited > MAX_TOTAL_PARTS) throw new PartBudgetSpent()
    if (attachment.mimeType.toLowerCase() === 'message/rfc822' && !context.encrypted) {
      await selectForward(attachment, depth, selection)
    } else {
      await selectPart(attachment, context, selection)
    }
  }
}

/**
 * Read a raw RFC 5322 message: its headers and the parts a person decides on.
 * Never throws: what postal-mime refuses (nesting, header size, part count)
 * is `unreadable` with the reason, and the receive job keeps the mail waiting
 * with a message part whose original can be downloaded once it is scanned.
 */
export async function readMime(raw: Uint8Array, options: MimeReadOptions): Promise<MimeRead> {
  const work = newWork()
  let email: Email
  try {
    email = await parseMessage(raw, MAX_TOTAL_PARTS, work)
  } catch (error) {
    return { kind: 'unreadable', reason: unreadableReason(error), work }
  }
  const selection: Selection = {
    accepted: new Set(options.acceptedTypes.map((type) => type.toLowerCase())),
    attachments: [],
    notStaged: [],
    notStagedOverflow: 0,
    names: new NameLedger(),
    work,
  }
  try {
    await selectFrom(email, 0, selection)
  } catch (error) {
    if (!(error instanceof PartBudgetSpent)) return { kind: 'unreadable', reason: 'malformed', work }
    selection.notStagedOverflow += 1
  }
  return {
    kind: 'read',
    headers: readHeaders(email),
    attachments: selection.attachments,
    notStaged: selection.notStaged,
    notStagedOverflow: selection.notStagedOverflow,
    work,
  }
}
