/**
 * An E-Mail-Verlauf's bytes: the Markdown rendition one Fassung of the thread
 * document holds (ADR-0134, DECISION D11, D12). Pure and deterministic, over
 * the thread's `mail_thread_entries` rows and nothing else, so a retry or two
 * concurrent filings give the same bytes, and the second hits the upload
 * path's unchanged digest.
 *
 * **One `##` section per message.** The knowledge layer's Markdown chunker
 * cuts a section at every ATX heading (`text_formats.py`) and cites it by its
 * heading, so each message is one citable passage. Sections are ordered by the
 * clamped send time; a late message is inserted at its date.
 *
 * **The superset invariant.** Fassung N+1 holds every section of Fassung N
 * byte for byte, so a citation into an earlier Fassung stays true. What makes
 * it hold:
 * - a section is rendered from its own row only, with two references to other
 *   entries, both to entries filed *before* it (a quote folded because it
 *   reproduces one, and „Antwort auf“): an entry filed later never changes an
 *   earlier section;
 * - headings are stored on the row when it is inserted
 *   ({@link mailThreadEntryHeading}) and never recomputed;
 * - attachment lines are frozen on their rows when the entry is inserted
 *   (`mail_thread_entry_attachments.section_*`, decided by
 *   {@link sectionAttachment});
 * - the words are a versioned table, in the thread's one locale
 *   (`./render-copy.ts`).
 *
 * The one recorded exception is detach (D34): the next Fassung leaves the
 * detached message's section out, and a section that folded a quote of it, or
 * answered it, shows the quote again or loses the „Antwort auf“ line. Earlier
 * Fassungen still hold all of it.
 *
 * **Nothing a stranger wrote becomes structure.** Every name, domain, subject
 * and body goes through `lib/text/markdown-escape.ts`, after every line
 * terminator Python's `splitlines()` honours has become `\n` and every other
 * control character is gone. A body line `## 14.10.2026 · MA 37` stays a line
 * of its real sender's section.
 *
 * **Authority is never laundered** (RT-S2). A heading names the signing
 * domain only when a signature confirmed it, and otherwise says „Domain nicht
 * bestätigt“ or „aus dem Outlook-Archiv“; a kept quote is labelled by the
 * message that quoted it, never by whom it claims to quote. A name cannot fake
 * a domain: brackets are taken out of names and domains alike.
 *
 * **What is not written** (RT-S13, ingestion §8): no address beyond its
 * domain, no Bcc, no attachment name from a folder less visible than the
 * thread, no name the Namensprüfung stopped.
 */

import type { Locale } from '@/i18n/config'
import { SCREENING_PLACEHOLDERS } from '@/lib/upload-screening/content-screen'
import { escapeInline, escapeMarkdown } from '@/lib/text/markdown-escape'
import { clampSentAt, VERIFIED_SENDER_TRUSTS, type SenderTrust } from './mail-threading'
import type {
  MailThreadAttachmentDisposition,
  MailThreadCalendarEvent,
  MailThreadEntrySource,
  MailThreadMaskedSpan,
  MailThreadParticipant,
  MailThreadQuote,
  MailThreadSectionAttachment,
} from './mail-thread-wire'
import { MAIL_THREAD_RENDER_COPY, type MailThreadRenderCopy } from './render-copy'

/** The most own text one section prints; the rest is in the original, and the section says so. */
export const MAX_SECTION_TEXT_CHARS = 100_000
/** A name longer than this is cut: a display name is a label, not a paragraph. */
const MAX_NAME_CHARS = 80
/** Names a recipient line lists before it counts the rest. */
const MAX_LISTED_RECIPIENTS = 10
/** Below this, an entry's text is too short to say a quote reproduces it („Danke“). */
const MIN_FOLD_CHARS = 20
/** What a folded quote may hold besides the entries it reproduces: the quote header a client writes per message. */
const FOLD_RESIDUE_PER_ENTRY = 200

/** What the renderer reads of a heading's sender. Every field is fixed when the entry is inserted. */
export interface MailThreadHeadingFields {
  source: MailThreadEntrySource
  sentAt: Date
  receivedAt: Date
  senderName: string | null
  senderAddress: string | null
  senderDomain: string | null
  signerDomain: string | null
  senderTrust: SenderTrust
}

/** One `mail_thread_entries` row, its JSON columns parsed through the wire schemas. */
export interface MailThreadRenderEntry extends MailThreadHeadingFields {
  id: string
  /** As stored when the entry was inserted. */
  heading: string
  filedAt: Date
  inReplyToEntryId: string | null
  participants: readonly MailThreadParticipant[]
  ownText: string
  /** Set when the person chose „Unkenntlich ablegen“ (D13). */
  maskedSpans: readonly MailThreadMaskedSpan[] | null
  quoted: readonly MailThreadQuote[]
  calendar: readonly MailThreadCalendarEvent[]
  /** In the message's order, as frozen on the entry's attachment rows. */
  attachments: readonly MailThreadSectionAttachment[]
}

export interface MailThreadRenderInput {
  /** The thread document's name as a person confirmed it, without `.md`. */
  title: string
  /** The thread's locale, fixed at its creation. */
  locale: Locale
  /** The thread this one continues past the cap („Als Fortsetzung ablegen“), by name. */
  continues: string | null
  entries: readonly MailThreadRenderEntry[]
}

export interface MailThreadRendition {
  markdown: string
  /** UTF-8 length, for the thread's byte cap. */
  bytes: number
  /** The sections in document order. */
  sections: Array<{ entryId: string; heading: string }>
}

/** A row the renderer refuses to write: a bug upstream, never a stranger's input. */
export class MailThreadRenderError extends Error {
  constructor(
    readonly code: 'heading_mismatch' | 'duplicate_heading',
    readonly entryId: string
  ) {
    super(`Mail thread entry ${entryId} cannot be rendered: ${code}`)
    this.name = 'MailThreadRenderError'
  }
}

// ------------------------------------------------------------ headings

/**
 * The heading a new entry is stored with: its base ({@link entryHeadingBase})
 * or, when the thread already has that heading (same minute, same sender),
 * the base with ` (2)`, ` (3)`. Never a running number: an out-of-order
 * message would renumber every later one and break their citations.
 */
export function mailThreadEntryHeading(
  fields: MailThreadHeadingFields,
  taken: Iterable<string>,
  locale: Locale
): string {
  const base = entryHeadingBase(fields, locale)
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n += 1) if (!used.has(`${base} (${n})`)) return `${base} (${n})`
}

/**
 * `{date time} · {name} ({signing domain})` for a verified mail,
 * `… ({from domain}, Domain nicht bestätigt)` for an unverified one and
 * `… ({from domain}, aus dem Outlook-Archiv)` for an archive entry (D11).
 * The time is the clamped send time, in Vienna.
 */
export function entryHeadingBase(fields: MailThreadHeadingFields, locale: Locale): string {
  const copy = MAIL_THREAD_RENDER_COPY[locale]
  const at = clampSentAt(fields.sentAt, fields.receivedAt).sentAt
  const who = displayName(fields.senderName, fields.senderAddress, copy)
  return `${copy.dateTime(at)} · ${who} (${headingAuthority(fields, copy)})`
}

function headingAuthority(fields: MailThreadHeadingFields, copy: MailThreadRenderCopy): string {
  const fromDomain = cleanDomain(fields.senderDomain)
  if (fields.source === 'archive') return [fromDomain, copy.fromArchive].filter(Boolean).join(', ')
  const signer = cleanDomain(fields.signerDomain)
  if (VERIFIED_SENDER_TRUSTS.includes(fields.senderTrust) && signer) return signer
  return [fromDomain, copy.unverifiedDomain].filter(Boolean).join(', ')
}

/** Whether a stored heading is what the entry's own fields make, possibly numbered. */
export function headingMatchesEntry(entry: MailThreadRenderEntry, locale: Locale): boolean {
  const base = entryHeadingBase(entry, locale)
  if (entry.heading === base) return true
  if (!entry.heading.startsWith(`${base} (`)) return false
  return /^\d+\)$/.test(entry.heading.slice(base.length + 2))
}

// ------------------------------------------------------------ the thread

/** The thread's rendition. Throws {@link MailThreadRenderError} on a row whose heading lies about its sender. */
export function renderMailThread(input: MailThreadRenderInput): MailThreadRendition {
  const copy = MAIL_THREAD_RENDER_COPY[input.locale]
  const headings = new Set<string>()
  for (const entry of input.entries) {
    if (!headingMatchesEntry(entry, input.locale)) throw new MailThreadRenderError('heading_mismatch', entry.id)
    if (headings.has(entry.heading)) throw new MailThreadRenderError('duplicate_heading', entry.id)
    headings.add(entry.heading)
  }

  const ordered = [...input.entries].sort(documentOrder)
  const filingRank = new Map([...input.entries].sort(filingOrder).map((entry, index) => [entry.id, index]))
  const byId = new Map(input.entries.map((entry) => [entry.id, entry]))
  const filedBefore = (entry: MailThreadRenderEntry) =>
    input.entries.filter((other) => (filingRank.get(other.id) ?? 0) < (filingRank.get(entry.id) ?? 0))

  const blocks = [preamble(input, ordered, copy)]
  for (const entry of ordered) {
    const answered = entry.inReplyToEntryId ? byId.get(entry.inReplyToEntryId) : undefined
    const earlier = filedBefore(entry)
    blocks.push(section(entry, answered && earlier.includes(answered) ? answered : undefined, earlier, copy))
  }
  const markdown = `${blocks.join('\n\n')}\n`
  return {
    markdown,
    bytes: new TextEncoder().encode(markdown).length,
    sections: ordered.map((entry) => ({ entryId: entry.id, heading: entry.heading })),
  }
}

/** By clamped send time, then receipt, then id: the reading order. */
function documentOrder(a: MailThreadRenderEntry, b: MailThreadRenderEntry): number {
  return (
    clampSentAt(a.sentAt, a.receivedAt).sentAt.getTime() - clampSentAt(b.sentAt, b.receivedAt).sentAt.getTime() ||
    a.receivedAt.getTime() - b.receivedAt.getTime() ||
    a.id.localeCompare(b.id)
  )
}

/** By filing time, then id: which entries a section may lean on. */
function filingOrder(a: MailThreadRenderEntry, b: MailThreadRenderEntry): number {
  return a.filedAt.getTime() - b.filedAt.getTime() || a.id.localeCompare(b.id)
}

function preamble(
  input: MailThreadRenderInput,
  ordered: readonly MailThreadRenderEntry[],
  copy: MailThreadRenderCopy
): string {
  const title = oneLine(input.title) || copy.unknownSender
  const lines = [`# ${escapeInline(title)}`]
  if (ordered.length > 0) {
    const first = clampSentAt(ordered[0].sentAt, ordered[0].receivedAt).sentAt
    const last = clampSentAt(ordered.at(-1)!.sentAt, ordered.at(-1)!.receivedAt).sentAt
    lines.push('', `*${escapeInline(copy.summary(ordered.length, first, last))}*`)
  }
  if (input.continues) lines.push('', `*${escapeInline(copy.continues(oneLine(input.continues)))}*`)
  return lines.join('\n')
}

function section(
  entry: MailThreadRenderEntry,
  answered: MailThreadRenderEntry | undefined,
  earlier: readonly MailThreadRenderEntry[],
  copy: MailThreadRenderCopy
): string {
  const heading = escapeInline(oneLine(entry.heading))
  const parts = [`## ${heading}`, `*${escapeInline(copy.received(entry.receivedAt))}*`]
  if (clampSentAt(entry.sentAt, entry.receivedAt).outOfRange) parts.push(`*${escapeInline(copy.dateOutOfRange)}*`)

  const facts = factLines(entry, answered, copy)
  if (facts.length > 0) parts.push(facts.join('\n'))
  parts.push(bodyText(masked(entry.ownText, entry.maskedSpans), copy))

  const quoteHeadings = new Set<string>()
  for (const quote of entry.quoted) {
    if (foldsInto(quote, earlier)) continue
    let label = copy.quoteIn(oneLine(entry.heading))
    for (let n = 2; quoteHeadings.has(label); n += 1) label = `${copy.quoteIn(oneLine(entry.heading))} (${n})`
    quoteHeadings.add(label)
    parts.push(`### ${escapeInline(label)}`, bodyText(quote.text, copy))
  }
  return parts.join('\n\n')
}

/** The bulleted lines under a heading: what it answers, who it went to, invitations, attachments. */
function factLines(
  entry: MailThreadRenderEntry,
  answered: MailThreadRenderEntry | undefined,
  copy: MailThreadRenderCopy
): string[] {
  const lines: string[] = []
  const fact = (label: string, value: string) => lines.push(`- **${escapeInline(label)}:** ${escapeInline(value)}`)
  if (answered) fact(copy.replyTo, oneLine(answered.heading))
  for (const role of ['to', 'cc'] as const) {
    const names = entry.participants.filter((p) => p.role === role).map((p) => recipient(p, copy))
    if (names.length === 0) continue
    const listed = names.slice(0, MAX_LISTED_RECIPIENTS).join(', ')
    const rest = names.length - MAX_LISTED_RECIPIENTS
    fact(copy[role], rest > 0 ? `${listed} ${copy.more(rest)}` : listed)
  }
  for (const event of entry.calendar) fact(copy.meeting, meetingLine(event, copy))
  const attachments = attachmentLine(entry.attachments, copy)
  if (attachments) fact(copy.attachments, attachments)
  return lines
}

function recipient(participant: MailThreadParticipant, copy: MailThreadRenderCopy): string {
  const name = displayName(participant.name, participant.address, copy)
  const domain = cleanDomain(participant.address.slice(participant.address.lastIndexOf('@') + 1))
  return domain ? `${name} (${domain})` : name
}

function meetingLine(event: MailThreadCalendarEvent, copy: MailThreadRenderCopy): string {
  const parts: string[] = []
  if (event.summary) parts.push(oneLine(event.summary))
  if (event.start) {
    const start = new Date(event.start)
    const format = event.allDay ? copy.date : copy.dateTime
    let when = format(start)
    if (event.end && !event.allDay) {
      const end = new Date(event.end)
      const endText = copy.date(end) === copy.date(start) ? copy.dateTime(end).slice(-5) : copy.dateTime(end)
      when += ` ${copy.until} ${endText}`
    }
    parts.push(when)
  }
  if (event.location) parts.push(oneLine(event.location))
  const cancelled = event.method?.toUpperCase() === 'CANCEL' || event.status?.toUpperCase() === 'CANCELLED'
  const line = parts.join(', ') || copy.meeting
  return cancelled ? `${line} (${copy.cancelled})` : line
}

/** Named where its frozen line names it; the rest counted. */
function attachmentLine(attachments: readonly MailThreadSectionAttachment[], copy: MailThreadRenderCopy): string {
  const named: string[] = []
  let unnamed = 0
  for (const attachment of attachments) {
    const name = attachment.name ? oneLine(attachment.name) : ''
    if (!name) {
      unnamed += 1
      continue
    }
    named.push(attachment.folderPath ? `${name} (${copy.filedIn(oneLine(attachment.folderPath))})` : name)
  }
  if (unnamed > 0) named.push(copy.unnamedAttachments(unnamed))
  return named.join('; ')
}

/** What the filing knew about one attachment when its message was filed. */
export interface MailThreadAttachmentFiling {
  disposition: MailThreadAttachmentDisposition
  /** The name the document has (filed, or already present); null for a file without one. */
  name: string | null
  /** The document's folder path at filing, '' or null for the project root. */
  folderPath: string | null
  /** Its folder is at least as visible as the thread document's (judged by the filing). */
  visibleWithThread: boolean
  /** It was filed under a name the Namensprüfung stopped, which a person released. */
  nameReleased: boolean
}

/**
 * What a thread's section will print for one attachment, for ever (RT-S13):
 * its name and folder only when it is a document, in a folder at least as
 * visible as the thread document's, under a name the Namensprüfung passed
 * without a release; otherwise nothing, and the section counts it. Decided
 * once, when the entry is inserted, and frozen on its row
 * (`mail_thread_entry_attachments.section_*`): an attachment filed later, or a
 * document renamed, never rewrites an earlier section.
 */
export function sectionAttachment(filing: MailThreadAttachmentFiling): MailThreadSectionAttachment {
  const name = filing.name ? oneLine(filing.name).slice(0, 500) : ''
  if (filing.disposition === 'not_filed' || !name || !filing.visibleWithThread || filing.nameReleased) {
    return { name: null, folderPath: null }
  }
  const folderPath = filing.folderPath ? oneLine(filing.folderPath).slice(0, 1000) : ''
  return { name, folderPath: folderPath || null }
}

// ------------------------------------------------------------ text

/** Every line terminator Python's `str.splitlines()` honours, `\r\n` first so it becomes one break. */
const LINE_TERMINATORS = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g
/** Control characters that are no line break: C0 but tab and newline, DEL, C1. */
const CONTROLS = /[\x00-\x08\x0e-\x1f\x7f-\x84\x86-\x9f]/g

/** One line of a header value: every terminator and control character a space, white space collapsed. */
function oneLine(value: string): string {
  return value.replace(LINE_TERMINATORS, ' ').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim()
}

/** A body or quote as escaped Markdown: one kind of line break, no controls, at most one blank line in a row. */
function bodyText(raw: string, copy: MailThreadRenderCopy): string {
  let text = raw
    .replace(LINE_TERMINATORS, '\n')
    .replace(CONTROLS, '')
    .replace(/[ \t]+$/gm, '')
  let cut = false
  if (text.length > MAX_SECTION_TEXT_CHARS) {
    text = text.slice(0, MAX_SECTION_TEXT_CHARS)
    cut = true
  }
  text = escapeMarkdown(text).replace(/\n{3,}/g, '\n\n').trim()
  if (!text) return `*${escapeInline(copy.noText)}*`
  return cut ? `${text}\n\n*${escapeInline(copy.truncated)}*` : text
}

/**
 * The own text with each masked span replaced by its placeholder, the way
 * `maskText` writes them (`[IBAN entfernt]`); overlapping spans merge. Spans
 * outside the text are ignored.
 */
function masked(text: string, spans: readonly MailThreadMaskedSpan[] | null): string {
  if (!spans || spans.length === 0) return text
  const ordered = spans
    .filter((span) => span.start < text.length)
    .map((span) => ({ ...span, end: Math.min(span.end, text.length) }))
    .sort((a, b) => a.start - b.start || b.end - a.end)
  let out = ''
  let cursor = 0
  for (const span of ordered) {
    if (span.end <= cursor) continue
    if (span.start >= cursor) out += text.slice(cursor, span.start) + SCREENING_PLACEHOLDERS[span.kind]
    cursor = span.end
  }
  return out + text.slice(cursor)
}

/** Text as a fold compares it: quote markers gone, white space collapsed, case-folded. */
function foldable(text: string): string {
  return text
    .normalize('NFC')
    .split(LINE_TERMINATORS)
    .map((line) => line.replace(/^\s*(?:>\s*)+/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Whether a quoted block only reproduces entries the thread held before this
 * one was filed, so leaving it out of the rendition loses nothing (D11). It
 * folds when it contains the whole text of at least one such entry and
 * little else: a quote header per reproduced entry, never a sentence of its
 * own. When in doubt it is kept: a repeated paragraph costs less than a lost
 * one, and a mid-thread first message's history exists only in its quote.
 */
function foldsInto(quote: MailThreadQuote, earlier: readonly MailThreadRenderEntry[]): boolean {
  let rest = foldable(quote.text)
  let reproduced = 0
  for (const entry of earlier) {
    const own = foldable(entry.ownText)
    if (own.length < MIN_FOLD_CHARS || !rest.includes(own)) continue
    rest = rest.replace(own, ' ')
    reproduced += 1
  }
  return reproduced > 0 && rest.replace(/\s+/g, ' ').trim().length <= FOLD_RESIDUE_PER_ENTRY * reproduced
}

// ------------------------------------------------------------ names

/** Brackets a name or domain could use to fake an authority: `Huber (ma37.wien.gv.at)`. */
const BRACKETS = /[()<>[\]{}]/g

/**
 * A sender's name as a heading prints it: one line, no brackets, no address.
 * A display name that is itself an address gives way to the address's local
 * part, so no full address is printed (ingestion §8).
 */
function displayName(name: string | null, address: string | null, copy: MailThreadRenderCopy): string {
  const clean = (value: string) => oneLine(value.replace(BRACKETS, ' ')).slice(0, MAX_NAME_CHARS).trim()
  const own = name && !name.includes('@') ? clean(name) : ''
  if (own) return own
  const local = address && address.includes('@') ? clean(address.slice(0, address.lastIndexOf('@'))) : ''
  return local || copy.unknownSender
}

/** A domain as printed: lower-case letters, digits, dots and hyphens only, so it cannot close a bracket or add a word. */
function cleanDomain(domain: string | null): string {
  if (!domain) return ''
  return domain
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/[^\p{L}\p{N}.-]/gu, '')
    .slice(0, 253)
}
