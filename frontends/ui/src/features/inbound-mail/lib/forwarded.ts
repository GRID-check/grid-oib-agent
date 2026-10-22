/**
 * Who a forwarded mail originally came from, as its forwarded text says.
 *
 * A colleague forwards the Behörde's mail to the project: the sender is the
 * colleague, and the reader wants to know that the text inside is from MA 37.
 * That fact is only in the text, written by the colleague's mail program
 * („-----Ursprüngliche Nachricht----- Von: …“, „Begin forwarded message:
 * From: …“), so it is read here from the first quoted block of a mail whose
 * subject says it was forwarded, and shown as „Ursprünglich von … · nicht
 * geprüft“. Nothing verified it; the label must never look like the trust
 * line above it.
 *
 * Pure.
 */

import type { InboundMailTextView } from '@/lib/inbound-mail/inbound-mail-wire'
import { isForwardSubject } from './subject'

export interface ForwardedOrigin {
  name: string | null
  address: string | null
}

/** „Von:“, „From:“, „De :“, „Da:“ and the other header labels mail programs write, then the value. */
const FROM_LINE = /^\s*\**\s*(?:von|from|de|da|van|od|fra|från)\s*\**\s*[:：]\s*\**\s*(.+?)\s*$/imu
/** `Name <address>`, `"Name" <address>`, `Name [mailto:address]`, or a bare address. */
const NAMED = /^"?([^"<[]*?)"?\s*(?:<|\[mailto:)\s*([^<>\s[\]]+@[^<>\s[\]]+)\s*(?:>|\])\s*$/u
const BARE = /^<?([^<>\s@]+@[^<>\s@]+)>?$/u

/** The original sender of a forwarded mail, or null when the mail was not forwarded or no sender line is readable. */
export function forwardedOrigin(subject: string | null, text: Pick<InboundMailTextView, 'quoted'> | null): ForwardedOrigin | null {
  if (!text || !isForwardSubject(subject)) return null
  const first = text.quoted[0]
  if (!first) return null
  const match = FROM_LINE.exec(first.header) ?? FROM_LINE.exec(first.text.split('\n').slice(0, 8).join('\n'))
  if (!match) return null
  return parseAddressLine(match[1])
}

/** One header value as a name and an address; null when it holds neither. */
export function parseAddressLine(value: string): ForwardedOrigin | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const named = NAMED.exec(trimmed)
  if (named) return { name: named[1].trim() || null, address: named[2].toLowerCase() }
  const bare = BARE.exec(trimmed)
  if (bare) return { name: null, address: bare[1].toLowerCase() }
  return { name: trimmed, address: null }
}
