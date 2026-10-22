/**
 * The words an E-Mail-Verlauf's rendition is written in, per locale (ADR-0134).
 *
 * This is document text, not interface copy, and it lives here rather than in
 * the i18n dictionaries for one reason: the superset invariant. Every Fassung
 * of a thread repeats every earlier section byte for byte, and a citation
 * stored against Fassung 3 must still resolve in Fassung 9. A dictionary is
 * edited for tone at any time; a word changed here rewrites every section of
 * every thread at its next filing. So a change to this table is a change to
 * the rendition's format: bump {@link MAIL_THREAD_RENDER_VERSION} in the same
 * commit, and the render spec's golden files show what moved.
 *
 * A thread is rendered in one locale for its whole life (the office's, chosen
 * when the thread is created), never in the locale of whoever files next.
 *
 * Dates are built from `formatToParts` with every field numeric and a 24-hour
 * clock, never from a locale's whole pattern, because ICU updates change
 * those patterns (the narrow no-break space in English times) and would
 * change bytes the invariant holds.
 */

import { OFFICE_TIME_ZONE } from '@/lib/format'
import type { Locale } from '@/i18n/config'

/** The rendition's format version. A change to this table or to `render.ts`'s layout bumps it. */
export const MAIL_THREAD_RENDER_VERSION = 1

export interface MailThreadRenderCopy {
  /** The heading suffix for an inbound sender whose domain no signature confirmed. */
  unverifiedDomain: string
  /** The heading suffix for an entry from an Outlook archive, whose sender nobody checked. */
  fromArchive: string
  /** A sender with neither a usable name nor an address. */
  unknownSender: string
  /** `dd.mm.yyyy HH:MM` or its locale's equivalent, Vienna time. */
  dateTime: (at: Date) => string
  /** The day alone. */
  date: (at: Date) => string
  /** The line under the title. */
  summary: (count: number, first: Date, last: Date) => string
  /** The line naming the thread this one continues. */
  continues: (name: string) => string
  /** When the message reached the office (RT-X16). */
  received: (at: Date) => string
  /** Said when the mail's own Date was not believed and the receipt orders it. */
  dateOutOfRange: string
  replyTo: string
  to: string
  cc: string
  /** More names than a line lists. */
  more: (count: number) => string
  meeting: string
  cancelled: string
  until: string
  attachments: string
  /** Where a named attachment was filed. */
  filedIn: (folderPath: string) => string
  /** The attachments a section counts and does not name. */
  unnamedAttachments: (count: number) => string
  /** A quoted block kept in the section, labelled by the message that quoted it, never by whom it quotes. */
  quoteIn: (heading: string) => string
  noText: string
  truncated: string
}

/** The office's clock as numeric parts. */
function viennaParts(at: Date): Record<'year' | 'month' | 'day' | 'hour' | 'minute', string> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: OFFICE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00'
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') }
}

const germanDate = (at: Date) => {
  const p = viennaParts(at)
  return `${p.day}.${p.month}.${p.year}`
}
const germanDateTime = (at: Date) => {
  const p = viennaParts(at)
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`
}
const isoDate = (at: Date) => {
  const p = viennaParts(at)
  return `${p.year}-${p.month}-${p.day}`
}
const isoDateTime = (at: Date) => {
  const p = viennaParts(at)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

export const MAIL_THREAD_RENDER_COPY: Readonly<Record<Locale, MailThreadRenderCopy>> = {
  de: {
    unverifiedDomain: 'Domain nicht bestätigt',
    fromArchive: 'aus dem Outlook-Archiv',
    unknownSender: 'Unbekannt',
    dateTime: germanDateTime,
    date: germanDate,
    summary: (count, first, last) =>
      `E-Mail-Verlauf · ${count === 1 ? '1 E-Mail' : `${count} E-Mails`} · ` +
      (germanDate(first) === germanDate(last) ? germanDate(first) : `${germanDate(first)} bis ${germanDate(last)}`),
    continues: (name) => `Fortsetzung von „${name}“`,
    received: (at) => {
      const p = viennaParts(at)
      return `eingegangen ${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}`
    },
    dateOutOfRange: 'Das Datum der E-Mail war nicht plausibel; sie ist nach dem Eingang eingeordnet.',
    replyTo: 'Antwort auf',
    to: 'An',
    cc: 'Cc',
    more: (count) => `und ${count} weitere`,
    meeting: 'Termin',
    cancelled: 'abgesagt',
    until: 'bis',
    attachments: 'Anhänge',
    filedIn: (folderPath) => `abgelegt in ${folderPath}`,
    unnamedAttachments: (count) =>
      count === 1 ? '1 Anhang nur im Original' : `${count} Anhänge nur im Original`,
    quoteIn: (heading) => `Zitat in der Nachricht von ${heading}`,
    noText: '(ohne Text)',
    truncated: '(gekürzt; der ganze Text steht im Original)',
  },
  en: {
    unverifiedDomain: 'domain not verified',
    fromArchive: 'from the Outlook archive',
    unknownSender: 'Unknown',
    dateTime: isoDateTime,
    date: isoDate,
    summary: (count, first, last) =>
      `Mail thread · ${count === 1 ? '1 mail' : `${count} mails`} · ` +
      (isoDate(first) === isoDate(last) ? isoDate(first) : `${isoDate(first)} to ${isoDate(last)}`),
    continues: (name) => `Continues “${name}”`,
    received: (at) => `received ${isoDateTime(at)}`,
    dateOutOfRange: "The mail's date was not plausible; it is placed by its receipt.",
    replyTo: 'Reply to',
    to: 'To',
    cc: 'Cc',
    more: (count) => `and ${count} more`,
    meeting: 'Meeting',
    cancelled: 'cancelled',
    until: 'to',
    attachments: 'Attachments',
    filedIn: (folderPath) => `filed in ${folderPath}`,
    unnamedAttachments: (count) =>
      count === 1 ? '1 attachment only in the original' : `${count} attachments only in the original`,
    quoteIn: (heading) => `Quoted in the message of ${heading}`,
    noText: '(no text)',
    truncated: '(shortened; the whole text is in the original)',
  },
}
