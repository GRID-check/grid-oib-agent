/**
 * Which E-Mail-Verlauf a mail belongs to, and whether the place it seems to
 * belong is offered pre-selected (ADR-0134, DECISION D11, RT-S1). Pure: the
 * receive job, the decision service and the archive import call it with rows
 * they loaded, so the ladder is written once and tested here.
 *
 * **The ladder** follows the standards. Membership is JMAP's rule (RFC 8621
 * §3): a Message-ID the thread holds, named in In-Reply-To or References,
 * *and* an equal base subject (RFC 5256 §2.1, extended with the German and
 * Outlook prefixes and the gateway tags offices put in front). Two fallbacks
 * cover clients that drop References: Outlook's Thread-Index conversation GUID
 * (MS-OXOMSG PidTagConversationIndex) with an equal subject, and an equal
 * subject with a shared participant. No maintained JavaScript implementation
 * of JWZ or JMAP threading exists (checked 2026-10-22), and the rule is a
 * dozen lines, so it is ours.
 *
 * **Matching proposes, trust decides what is pre-selected.** Every header the
 * ladder reads is one a stranger can write. A thread is offered pre-selected
 * only on a strong match from a sender whose domain signed the header the
 * match used ({@link threadPreselection}); everything else is offered
 * unchecked, with its reason, and appending it needs the `unverified_thread`
 * acknowledgement on the server.
 *
 * Thread identity is per project: the caller passes only the receiving
 * project's threads, because a match across projects would tell project B's
 * reviewers that project A holds the conversation.
 */

import { VERIFIED_SENDER_TRUSTS, type SenderTrust } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { type ThreadMatchHeader, type ThreadMatchStrength } from './mail-thread-vocabulary'

/**
 * A sender's trust (DECISION D4), and the trusts that are an aligned DKIM pass.
 * Declared beside the CHECK they mirror (`inbound-mail-vocabulary.ts`,
 * migration 0186), re-exported here so the thread core reads as one module.
 */
export { SENDER_TRUSTS, VERIFIED_SENDER_TRUSTS, type SenderTrust } from '@/lib/inbound-mail/inbound-mail-vocabulary'

/**
 * How strongly a mail matched a thread, strongest first, and the headers a
 * match can rest on (`./mail-thread-vocabulary.ts`, the column
 * `inbound_mails.thread_match` holds them).
 *
 * - `reference`: In-Reply-To or References names a message the thread
 *   received, and the base subjects are equal.
 * - `thread_index`: no such reference, but the Outlook conversation GUID and
 *   the base subject are equal.
 * - `reference_subject_changed`: a reference hit under another subject. RFC
 *   8621 §3's reason for not threading it: someone answered an old mail to
 *   start a new topic.
 * - `subject`: an equal base subject and a shared participant, the thread
 *   active within {@link SUBJECT_MATCH_WINDOW_DAYS} days; or an equal subject
 *   with a reference only to a message the thread knows by citation.
 */
export {
  THREAD_MATCH_HEADERS,
  THREAD_MATCH_STRENGTHS,
  type ThreadMatchHeader,
  type ThreadMatchStrength,
} from './mail-thread-vocabulary'

/** The strengths a thread can be pre-selected on. The others are always offered unchecked. */
export const PRESELECTABLE_STRENGTHS: readonly ThreadMatchStrength[] = ['reference', 'thread_index']

/** How long a thread stays a subject candidate after its last entry. */
export const SUBJECT_MATCH_WINDOW_DAYS = 60

/** How many candidates a person is shown, after they were filtered for that person (D9). */
export const MAX_SHOWN_THREAD_CANDIDATES = 3

/** RFC 5322 bounds a line at 998 characters; a Message-ID longer than that is not one. */
const MAX_MESSAGE_ID = 998
const MAX_IN_REPLY_TO = 5
const MAX_REFERENCES = 50
const MAX_BASE_SUBJECT = 500
const DAY_MS = 86_400_000

// ------------------------------------------------------------ message ids

/**
 * A Message-ID as the thread tables key it: without its angle brackets, the
 * domain part lower-cased and the left part as sent (RFC 5322 §3.6.4: the left
 * part is case-sensitive). `null` for anything that is not one.
 */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null
  let id = raw.trim()
  if (id.startsWith('<') && id.endsWith('>')) id = id.slice(1, -1).trim()
  if (id.length < 3 || id.length > MAX_MESSAGE_ID) return null
  // No white space, no brackets, no control characters: a token, or nothing.
  if (/[\s<>\p{Cc}]/u.test(id)) return null
  const at = id.lastIndexOf('@')
  return at > 0 ? `${id.slice(0, at)}@${id.slice(at + 1).toLowerCase()}` : id
}

/**
 * The Message-IDs an In-Reply-To or References field names, in order and
 * once each. Tokens come from a tolerant `<…>` scan, because clients fold,
 * comment and mangle these headers; a bare id without brackets counts only
 * when it is the whole field (Lotus and some ERP mailers send that).
 */
export function parseMessageIdList(field: string | null | undefined): string[] {
  if (!field) return []
  const bracketed = [...field.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1])
  const tokens = bracketed.length > 0 ? bracketed : /^\s*[^<>\s]+\s*$/.test(field) ? [field] : []
  const ids: string[] = []
  for (const token of tokens) {
    const id = normalizeMessageId(token)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** In-Reply-To's ids, at most five (a reply names one; a merge names a few). */
export function parseInReplyTo(field: string | null | undefined): string[] {
  return parseMessageIdList(field).slice(0, MAX_IN_REPLY_TO)
}

/**
 * References' ids, at most fifty: the first (the thread's root) and the last
 * forty-nine (the nearest ancestors), the trimming RFC 5322 §3.6.4 suggests.
 */
export function parseReferences(field: string | null | undefined): string[] {
  const ids = parseMessageIdList(field)
  return ids.length <= MAX_REFERENCES ? ids : [ids[0], ...ids.slice(-(MAX_REFERENCES - 1))]
}

// ------------------------------------------------------------ base subject

/** Reply and forward leaders across the languages Austrian offices receive, with Outlook's counters (`AW[2]:`). */
const LEADER =
  /^(?:re|aw|antw|antwort|wg|fw|fwd|wtr|tr|sv|vs|rif|r|rv|enc|odp|pd|doorst|vl|ynt)(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/iu
/** Gateway tags a mail server puts in front of outside mail, with their separator when unbracketed. */
const GATEWAY = /^(?:\[\s*(?:extern|external|ext|extern\s*e-mail|caution)\s*\]|(?:extern|external|caution)\s*[:\-–])\s*/iu
/** RFC 5256 subj-trailer. */
const TRAILER = /\s*\((?:fwd|fw)\)\s*$/iu
/** RFC 5256 subj-blob: a bracketed tag at the start, stripped only when text remains after it. */
const BLOB = /^\[[^[\]]*\]\s*/u
/** RFC 5256 subj-fwd: `[Fwd: …]` around the whole subject. */
const FORWARD_WRAPPER = /^\[(?:fwd|fw|wg)\s*:\s*(.*)\]$/iu

/**
 * The subject a thread is matched on: RFC 5256 §2.1's base subject, extended
 * with `AW:`, `WG:`, `Antw:`, Outlook's counters and gateway tags such as
 * `[EXTERN]`, then NFC and case-folded. Stored for matching only, never shown
 * (a person sees the subject as sent).
 */
export function baseSubject(subject: string | null | undefined): string {
  let current = (subject ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim()
  for (let previous = ''; previous !== current; ) {
    previous = current
    current = current.replace(TRAILER, '')
    const withoutBlob = current.replace(BLOB, '')
    if (withoutBlob) current = withoutBlob
    current = current.replace(LEADER, '').replace(GATEWAY, '')
    const wrapped = FORWARD_WRAPPER.exec(current)
    if (wrapped) current = wrapped[1]
    current = current.trim()
  }
  return caseFold(current).slice(0, MAX_BASE_SUBJECT)
}

/** Unicode case folding where JavaScript's lower-casing differs from it for German: `ß` folds to `ss`. */
function caseFold(value: string): string {
  return value.toLowerCase().replace(/ß/gu, 'ss')
}

// ------------------------------------------------------------ thread index

/**
 * The conversation GUID in an Outlook Thread-Index header, or in the archive's
 * `PR_CONVERSATION_INDEX`, which holds the same bytes. MS-OXOMSG 2.2.1.3: one
 * reserved byte, five bytes of FILETIME, sixteen bytes of GUID, then five-byte
 * child blocks. Rendered as lower-case hex in byte order, `8-4-4-4-12`, so
 * both sources give the same string. Anything malformed is `null`, never an
 * error: the header is a stranger's.
 */
export function threadIndexGuid(base64: string | null | undefined): string | null {
  if (!base64) return null
  const compact = base64.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length > 4096) return null
  let binary: string
  try {
    binary = atob(compact)
  } catch {
    return null
  }
  return threadIndexGuidFromBytes(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

/** {@link threadIndexGuid} over the raw bytes. */
export function threadIndexGuidFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 22) return null
  const guid = bytes.subarray(6, 22)
  if (guid.every((byte) => byte === 0)) return null
  const hex = Array.from(guid, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ------------------------------------------------------------ matching

/** What the ladder reads of a mail. Ids normalized, addresses lower-cased, the project's own addresses removed. */
export interface ThreadingMessage {
  messageId: string | null
  inReplyTo: readonly string[]
  references: readonly string[]
  threadIndexGuid: string | null
  /** {@link baseSubject} of the mail's subject. */
  baseSubject: string
  /** From, Reply-To, To and Cc addresses. */
  participants: readonly string[]
  /** The clamped send time ({@link clampSentAt}). */
  sentAt: Date
}

/** What the ladder reads of one thread of the receiving project. */
export interface ThreadCandidate {
  threadId: string
  baseSubject: string
  threadIndexGuid: string | null
  /** Message-IDs of the thread's entries (`mail_thread_message_ids`, state `received`). */
  receivedIds: readonly string[]
  /** Message-IDs the entries cite but the thread never received (state `referenced`). */
  referencedIds: readonly string[]
  /** Every address that took part in a filed entry, lower-cased. */
  participants: readonly string[]
  lastEntryAt: Date | null
}

/** One thread a mail matched, as `inbound_mails.thread_match` stores it (ids and strengths only). */
export interface ThreadMatch {
  threadId: string
  strength: ThreadMatchStrength
  /** The headers the match rests on; pre-selection and following ask whether one of them was signed. */
  headers: ThreadMatchHeader[]
}

const STRENGTH_RANK: Readonly<Record<ThreadMatchStrength, number>> = {
  reference: 0,
  thread_index: 1,
  reference_subject_changed: 2,
  subject: 3,
}

/**
 * Every thread of the project the mail matched, strongest first, then the
 * most recently active. Each thread appears once, at its strongest rung. The
 * caller filters the list for the viewer (D9) before it shows
 * {@link MAX_SHOWN_THREAD_CANDIDATES} of it; „Als neuen E-Mail-Verlauf
 * ablegen“ is always offered beside it.
 */
export function matchThread(message: ThreadingMessage, candidates: readonly ThreadCandidate[]): ThreadMatch[] {
  const matches: Array<{ match: ThreadMatch; lastEntryAt: number }> = []
  for (const candidate of candidates) {
    const match = matchOne(message, candidate)
    if (match) matches.push({ match, lastEntryAt: candidate.lastEntryAt?.getTime() ?? 0 })
  }
  return matches
    .sort(
      (a, b) =>
        STRENGTH_RANK[a.match.strength] - STRENGTH_RANK[b.match.strength] ||
        b.lastEntryAt - a.lastEntryAt ||
        a.match.threadId.localeCompare(b.match.threadId)
    )
    .map(({ match }) => match)
}

function matchOne(message: ThreadingMessage, thread: ThreadCandidate): ThreadMatch | null {
  const sameSubject = message.baseSubject === thread.baseSubject
  const received = new Set(thread.receivedIds)
  // A mail's own id is the question of reuse (`message_id_reused`), never evidence it belongs.
  const cites = (ids: readonly string[], within: ReadonlySet<string>) =>
    ids.some((id) => id !== message.messageId && within.has(id))

  const headers: ThreadMatchHeader[] = []
  if (cites(message.inReplyTo, received)) headers.push('in-reply-to')
  if (cites(message.references, received)) headers.push('references')
  if (headers.length > 0)
    return { threadId: thread.threadId, strength: sameSubject ? 'reference' : 'reference_subject_changed', headers }

  if (sameSubject && message.threadIndexGuid && message.threadIndexGuid === thread.threadIndexGuid)
    return { threadId: thread.threadId, strength: 'thread_index', headers: ['thread-index'] }

  if (!sameSubject || !message.baseSubject) return null
  // A reply that cites only an ancestor the thread knows by quotation (Piloti was put in Cc mid-thread).
  const referenced = new Set(thread.referencedIds)
  const citesAncestor = cites(message.inReplyTo, referenced) || cites(message.references, referenced)
  if (citesAncestor || (sharesParticipant(message, thread) && activeWithin(message, thread)))
    return { threadId: thread.threadId, strength: 'subject', headers: ['subject'] }
  return null
}

function sharesParticipant(message: ThreadingMessage, thread: ThreadCandidate): boolean {
  const known = new Set(thread.participants.map((address) => address.toLowerCase()))
  return message.participants.some((address) => known.has(address.toLowerCase()))
}

function activeWithin(message: ThreadingMessage, thread: ThreadCandidate): boolean {
  if (!thread.lastEntryAt) return false
  return Math.abs(message.sentAt.getTime() - thread.lastEntryAt.getTime()) <= SUBJECT_MATCH_WINDOW_DAYS * DAY_MS
}

// ------------------------------------------------------------ pre-selection

/** What the receive job established about the sender (DECISION D4). */
export interface SenderEvidence {
  senderTrust: SenderTrust
  /** `inbound_mails.sender_flags`; unknown values are ignored here. */
  senderFlags: readonly string[]
  /** mailauth's `signingHeaders.keys` of the aligned passing signature, any case. */
  signedHeaders: readonly string[]
}

/**
 * Why a candidate is offered unchecked. Each has its own line of copy
 * („Verweist auf den Verlauf, aber der Absender ist nicht bestätigt“), owned
 * by the dictionaries.
 */
export const PRESELECTION_BLOCKS = [
  'weak_match',
  'sender_not_verified',
  'header_not_signed',
  'not_addressed_to_project',
  'stale_date',
  'date_out_of_range',
] as const
export type PreselectionBlock = (typeof PRESELECTION_BLOCKS)[number]

/** The outcome for one candidate: pre-selected, or offered unchecked for these reasons. */
export interface ThreadPreselection {
  preselected: boolean
  blocks: PreselectionBlock[]
}

/** Lower-cased signed header names, for membership tests. */
export function signedHeaderSet(sender: Pick<SenderEvidence, 'signedHeaders'>): ReadonlySet<string> {
  return new Set(sender.signedHeaders.map((header) => header.trim().toLowerCase()))
}

/**
 * The Bcc case of D4: a member's own copy, DKIM-verified and recent, is not
 * „addressed to someone else“, so it is pre-selected like any member mail. It
 * is never followable; `followEligibility` refuses `bcc_own` itself.
 */
export function isOwnBccCopy(sender: Pick<SenderEvidence, 'senderTrust' | 'senderFlags'>): boolean {
  return sender.senderTrust === 'member_verified' && sender.senderFlags.includes('bcc_own')
}

/**
 * Why this mail's sender keeps every candidate unchecked, whatever matched:
 * an unverified domain, a mail addressed to others (outside the Bcc case), a
 * Date more than seven days old, or a Date outside the clamp. Empty when the
 * sender qualifies. A Fassung of an attachment (`revisionOf`) on a mail with
 * any of these needs the `unverified_thread` acknowledgement too (D11).
 */
export function senderPreselectionBlocks(
  sender: Pick<SenderEvidence, 'senderTrust' | 'senderFlags'>
): PreselectionBlock[] {
  const blocks: PreselectionBlock[] = []
  if (!VERIFIED_SENDER_TRUSTS.includes(sender.senderTrust)) blocks.push('sender_not_verified')
  if (sender.senderFlags.includes('not_addressed_to_project') && !isOwnBccCopy(sender))
    blocks.push('not_addressed_to_project')
  if (sender.senderFlags.includes('stale_date')) blocks.push('stale_date')
  if (sender.senderFlags.includes('date_out_of_range')) blocks.push('date_out_of_range')
  return blocks
}

/**
 * The trust-dependent pre-selection matrix (D11, RT-S1). A candidate is
 * pre-selected only when all of these hold:
 *
 * - the match is `reference` or `thread_index`;
 * - the sender is `member_verified`, or `external_verified` with a header the
 *   match rests on inside the signed header set (a header added outside `h=`
 *   proves nothing about the signing domain);
 * - none of the sender blocks of {@link senderPreselectionBlocks}.
 *
 * A member's verified domain vouches for the whole mail it signed, so a
 * member's unsigned References still pre-select; a stranger's do not.
 */
export function threadPreselection(match: ThreadMatch, sender: SenderEvidence): ThreadPreselection {
  const blocks = senderPreselectionBlocks(sender)
  if (!PRESELECTABLE_STRENGTHS.includes(match.strength)) blocks.unshift('weak_match')
  if (sender.senderTrust === 'external_verified' && !restsOnSignedHeader(match, sender)) blocks.push('header_not_signed')
  return { preselected: blocks.length === 0, blocks }
}

/** Whether one of the headers the match rests on was signed. */
export function restsOnSignedHeader(match: ThreadMatch, sender: Pick<SenderEvidence, 'signedHeaders'>): boolean {
  const signed = signedHeaderSet(sender)
  return match.headers.some((header) => signed.has(header))
}

/**
 * Whether appending this mail's text to a thread needs the part's id in
 * `acknowledgeRisk` under `unverified_thread` (D11's server rule): when the
 * sender would keep any candidate unchecked, or when the chosen thread was
 * matched only through a header the sender's domain did not sign. A person's
 * own choice of an unrelated thread for a qualifying sender needs none:
 * nothing a stranger wrote put it there.
 */
export function appendNeedsAcknowledgement(sender: SenderEvidence, match: ThreadMatch | undefined): boolean {
  if (senderPreselectionBlocks(sender).length > 0) return true
  if (!match || match.strength === 'subject') return false
  return sender.senderTrust === 'external_verified' && !restsOnSignedHeader(match, sender)
}

// ------------------------------------------------------------ dates

/** How far before its receipt a mail's Date may lie before it is not believed (D11). */
export const SENT_AT_WINDOW_DAYS = 30

/**
 * How far after its receipt a mail's Date may lie and still be an honest clock
 * that runs fast (a laptop off NTP, a drifting Exchange server) rather than a
 * forged position: such a Date is put at the receipt WITHOUT `outOfRange`.
 */
export const SENT_AT_CLOCK_SKEW_MINUTES = 15

const MINUTE_MS = 60_000

/**
 * The send time a thread orders and headings by: the Date header, believed
 * only within `[receivedAt − 30 days, receivedAt]`. A Date up to
 * {@link SENT_AT_CLOCK_SKEW_MINUTES} after the receipt is a fast clock: the
 * receipt time is used, and nothing is flagged, so a member's genuine reply
 * keeps its pre-selection and its follow. Further out, before the window, or
 * without a Date, the receipt time is used and `outOfRange` is set, which is
 * the `date_out_of_range` flag. A future Date is the commonest forgery of
 * position in a thread, a very old one the replay's; the skew allowance gives a
 * forger nothing, because the time shown is the receipt's either way.
 */
export function clampSentAt(sentAt: Date | null, receivedAt: Date): { sentAt: Date; outOfRange: boolean } {
  const time = sentAt?.getTime()
  if (time === undefined || Number.isNaN(time)) return { sentAt: receivedAt, outOfRange: true }
  const received = receivedAt.getTime()
  if (time < received - SENT_AT_WINDOW_DAYS * DAY_MS) return { sentAt: receivedAt, outOfRange: true }
  if (time > received) {
    return { sentAt: receivedAt, outOfRange: time > received + SENT_AT_CLOCK_SKEW_MINUTES * MINUTE_MS }
  }
  return { sentAt: new Date(time), outOfRange: false }
}

// ------------------------------------------------------------ domains

/**
 * The domain of an address as threads compare it: after the last `@`, without
 * a trailing dot, in ONE form: the ASCII (A-label, punycode) form of an
 * internationalized domain name, lower-cased. `null` without one.
 *
 * A domain has two spellings once it holds a non-ASCII letter: `müller.at` as a
 * person types it (RFC 6532 lets a header carry it so) and `xn--mller-kva.at`
 * as DNS, a DKIM `d=` and most mail clients write it. Compared as text they are
 * two domains, so a reply of the same office would count as a new participant
 * (no follow, D31 condition 5) and one office would show twice. The form is
 * the A-label because DNS and DKIM speak it; a person's screen may render the
 * U-label. The conversion is UTS #46 as the WHATWG URL parser applies it
 * (`new URL`), in the browser and in Node alike: it also folds case and width
 * (`MÜLLER.AT`, full-width letters) onto the same name. A domain the parser
 * refuses (a space, a stray `<`) is kept lower-cased as it was: it cannot be a
 * spelling of any registrable domain, so it can match nothing but itself.
 */
export function domainOf(address: string | null | undefined): string | null {
  if (!address) return null
  const at = address.lastIndexOf('@')
  if (at < 0) return null
  const domain = address
    .slice(at + 1)
    .trim()
    .replace(/>$/, '')
    .replace(/\.$/, '')
  if (!domain) return null
  return asciiDomain(domain) ?? domain.toLowerCase()
}

/** The A-label form of `domain` by UTS #46 (WHATWG URL host parsing), or null when it is not a host name. */
function asciiDomain(domain: string): string | null {
  // An address literal (`[192.0.2.1]`) or a bare number is not a name, and the
  // parser would read it as an IP address (`1.2.3` becomes `1.2.0.3`). A
  // character that ends or escapes a host (`/ ? # \\ @ :`, `%`) would make it
  // parse something other than the domain.
  if (/^\[|^[\d.]+$|[/?#\\@:%]/.test(domain)) return null
  try {
    return new URL(`http://${domain}/`).hostname || null
  } catch {
    return null
  }
}
