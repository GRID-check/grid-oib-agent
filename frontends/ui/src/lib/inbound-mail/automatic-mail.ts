/**
 * Mail no person wrote (ADR-0134 check B1, receive job step 3).
 *
 * Two answers, kept apart on purpose:
 *
 * - **Dropped**: an auto-reply, a delivery or read report, or a loop through
 *   our own domain. Nobody wants it in front of the office, and it is the one
 *   kind of mail that answers an answer: a project address in Cc of a thread
 *   collects every out-of-office reply of every participant. Stored as
 *   `dropped` with the reason and counted, never shown, never answered.
 * - **Automatic**: list, bulk and machine-generated mail. Kept and held like
 *   any other, only flagged (`automatic`), which collapses its announcement
 *   and skips the model spend. A scanner's `Auto-Submitted: auto-generated`
 *   mail is exactly how a drawing arrives from a plotter room, and dropping it
 *   would lose the document.
 *
 * The signals are the published ones: RFC 3834 `Auto-Submitted` (§5) and its
 * advice on `Precedence` and list headers (§2), RFC 3464 and RFC 8098 reports
 * (`multipart/report`), RFC 2369/2919 list headers, the vendor auto-reply
 * headers in common use, and the null reverse-path RFC 5321 §4.5.5 reserves
 * for notifications. No library fits: mailauth and postal-mime expose headers
 * only, so this is the one pure function the decision lives in.
 *
 * We never originate mail, so nothing here decides whether to answer.
 */

import { asciiLower } from './address'
import type { DroppedReason } from './contract'
import type { HeaderField } from './mime'

/** Why a kept mail counts as automatic. English tokens, for logs and counts. */
export type AutomaticSignal =
  | 'auto_generated'
  | 'precedence_bulk'
  | 'list_headers'
  | 'auto_response_suppress'
  | 'null_sender'

export type AutomaticMailVerdict =
  | { outcome: 'drop'; reason: DroppedReason }
  | { outcome: 'keep'; automatic: boolean; signals: AutomaticSignal[] }

export interface AutomaticMailInput {
  /** The raw header block (`rawHeaderFields`); null when it could not be read. */
  headers: readonly HeaderField[] | null
  /** The envelope sender, decoded (`decodeEnvelopeAddress` of `x-envelope-from`); empty for the null reverse-path. */
  envelopeFrom: string | null
  /** The deployment's inbound domain (`inboundMailDomain`). */
  inboundDomain: string
}

/** Vendor headers that mark an auto-reply (Exchange, Postfix vacation, cPanel, Zimbra and the like). */
const AUTO_REPLY_HEADERS = ['x-autoreply', 'x-autorespond', 'x-autoresponder', 'x-auto-reply', 'x-vacation']

/** Local parts of the reporting agents (RFC 5321 §4.5.5, RFC 3464). */
const REPORTING_LOCAL_PARTS = new Set(['mailer-daemon'])

/** Report types that are about delivery or reading, not content (RFC 6522). */
const DELIVERY_REPORT_TYPES = new Set(['delivery-status', 'disposition-notification'])

function values(headers: readonly HeaderField[], name: string): string[] {
  return headers.filter((header) => header.name === name).map((header) => header.value.trim())
}

/** The address inside a header value or envelope, ASCII-lowercased, angle brackets and display name dropped. */
function bareAddress(value: string): string {
  const angle = /<([^<>]*)>/.exec(value)
  return asciiLower((angle ? angle[1] : value).trim())
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  return at === -1 ? '' : address.slice(at + 1)
}

/** Whether `domain` is the inbound domain or below it. */
function isOurs(domain: string, inboundDomain: string): boolean {
  const ours = asciiLower(inboundDomain)
  return ours !== '' && (domain === ours || domain.endsWith(`.${ours}`))
}

/** Why the mail is dropped, if it is. */
function dropReason(headers: readonly HeaderField[], input: AutomaticMailInput): DroppedReason | null {
  const from = values(headers, 'from').map(bareAddress)
  const envelope = bareAddress(input.envelopeFrom ?? '')
  if ([...from, envelope].some((address) => address !== '' && isOurs(domainOf(address), input.inboundDomain))) {
    return 'self_loop'
  }
  const contentType = asciiLower(values(headers, 'content-type')[0] ?? '')
  const reportType = /^\s*multipart\/report\b.*?\breport-type\s*=\s*"?([a-z-]+)/.exec(contentType)?.[1]
  if (reportType && DELIVERY_REPORT_TYPES.has(reportType)) return 'delivery_report'
  if (/^\s*message\/delivery-status\b/.test(contentType)) return 'delivery_report'
  if (from.some((address) => REPORTING_LOCAL_PARTS.has(address.slice(0, address.lastIndexOf('@'))))) {
    return 'delivery_report'
  }
  const autoSubmitted = asciiLower(values(headers, 'auto-submitted')[0] ?? '')
  if (/^auto-replied\b/.test(autoSubmitted)) return 'auto_reply'
  if (values(headers, 'precedence').some((value) => asciiLower(value) === 'auto_reply')) return 'auto_reply'
  if (AUTO_REPLY_HEADERS.some((name) => values(headers, name).some((value) => asciiLower(value) !== 'no'))) {
    return 'auto_reply'
  }
  return null
}

/** The signals that mark a kept mail automatic. */
function automaticSignals(headers: readonly HeaderField[], input: AutomaticMailInput): AutomaticSignal[] {
  const signals: AutomaticSignal[] = []
  const autoSubmitted = asciiLower(values(headers, 'auto-submitted')[0] ?? '')
  if (autoSubmitted !== '' && !/^no\b/.test(autoSubmitted)) signals.push('auto_generated')
  const precedence = values(headers, 'precedence').map(asciiLower)
  if (precedence.some((value) => value === 'bulk' || value === 'junk' || value === 'list')) signals.push('precedence_bulk')
  if (['list-id', 'list-unsubscribe', 'list-post'].some((name) => values(headers, name).length > 0)) signals.push('list_headers')
  if (values(headers, 'x-auto-response-suppress').length > 0) signals.push('auto_response_suppress')
  if (input.envelopeFrom !== null && bareAddress(input.envelopeFrom) === '') signals.push('null_sender')
  return signals
}

/**
 * Classify a mail by its headers and envelope. Pure. A mail whose header block
 * could not be read is kept and not automatic: the parser decides what it is,
 * and a person sees it.
 */
export function classifyAutomaticMail(input: AutomaticMailInput): AutomaticMailVerdict {
  if (!input.headers) return { outcome: 'keep', automatic: false, signals: [] }
  const reason = dropReason(input.headers, input)
  if (reason) return { outcome: 'drop', reason }
  const signals = automaticSignals(input.headers, input)
  return { outcome: 'keep', automatic: signals.length > 0, signals }
}
