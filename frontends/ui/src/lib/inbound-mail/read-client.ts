/**
 * The Python mail reader, as the receive job calls it (ADR-0134, D12):
 * `POST /v1/mail/read` (`frontends/aiq_api/src/aiq_api/routes/mail.py`).
 *
 * TypeScript decides what the attachments are (`./mime`); Python decides what
 * the body is: which of plain, HTML or RTF, the sender's own text with the
 * signature and the quoted replies split off, and calendar invitations. The
 * reader fetches the raw message itself through a presigned GET of the staged
 * object (`file_ref`, an `ObjectStoreUrl` it refuses off the store), so the
 * bytes never travel twice.
 *
 * What comes back is parsed here, at the boundary, and mapped onto this tier's
 * names; the job stages it as the mail's `read.json` once other tenants'
 * addresses are redacted (B8). No model reads it: `/v1/mail/read` makes no
 * model call, and a held mail's text reaches people only (D7).
 */

import 'server-only'
import { z } from 'zod'
import { getBackendUrl } from '@/lib/backend-proxy'

/**
 * How long a read may take, queueing included. The reader caps one read at
 * 20 s and runs two at once per process, so a read behind others waits; the
 * reader's handoff asks for at least 60 s.
 */
export const MAIL_READ_TIMEOUT_MS = 90_000

const quotedBlockSchema = z.object({ header: z.string().max(4096), text: z.string().max(524_288) })

const calendarEventSchema = z.object({
  method: z.string().max(40).nullable(),
  summary: z.string().max(500).nullable(),
  start: z.string().max(64).nullable(),
  end: z.string().max(64).nullable(),
  all_day: z.boolean(),
  location: z.string().max(500).nullable(),
  status: z.string().max(40).nullable(),
  organizer_name: z.string().max(300).nullable(),
  uid: z.string().max(500).nullable(),
  sequence: z.number().int().nullable(),
  recurring: z.boolean(),
})

/** Why part of a message was not read (`aiq_api.mail.models.UnreadableReason`). */
export const MAIL_READ_UNREADABLE_REASONS = [
  'message_too_large',
  'html_too_large',
  'rtf_too_large',
  'calendar_too_large',
  'calendar_malformed',
  'timeout',
  'failed',
] as const

/** The reader's answer as it is on the wire (snake_case, `aiq_api.mail.models.MailRead`). */
const wireMailReadSchema = z.object({
  reader_version: z.number().int().positive(),
  body_source: z.enum(['plain', 'html', 'rtf', 'none']),
  own_text: z.string().max(524_288),
  own_text_truncated: z.boolean(),
  split: z.boolean(),
  signature_removed: z.boolean(),
  quoted: z.array(quotedBlockSchema).max(50),
  quoted_truncated: z.boolean(),
  calendar: z.array(calendarEventSchema).max(20),
  calendar_truncated: z.boolean(),
  encrypted: z.boolean(),
  unreadable_reasons: z.array(z.enum(MAIL_READ_UNREADABLE_REASONS)),
  unreadable: z.boolean(),
})

/**
 * What the reader made of a message, in this tier's names: the shape of a held
 * mail's staged `read.json`, which the review service reads back
 * (`inbound-mail-text-get`) and the filing job copies into a thread entry.
 */
export const mailReadSchema = z.object({
  readerVersion: z.number().int().positive(),
  bodySource: z.enum(['plain', 'html', 'rtf', 'none']),
  /** The sender's own text, signature and disclaimer removed. */
  ownText: z.string().max(524_288),
  ownTextTruncated: z.boolean(),
  /** False when the body was too long to split: quotes and signature are then inside `ownText`. */
  split: z.boolean(),
  signatureRemoved: z.boolean(),
  /** Quoted earlier messages, each with the line that introduced it (it names people and addresses). */
  quoted: z.array(quotedBlockSchema).max(50),
  quotedTruncated: z.boolean(),
  calendar: z
    .array(
      z.object({
        method: z.string().nullable(),
        summary: z.string().nullable(),
        /** ISO 8601 with the Europe/Vienna offset. */
        start: z.string().nullable(),
        end: z.string().nullable(),
        allDay: z.boolean(),
        location: z.string().nullable(),
        status: z.string().nullable(),
        organizerName: z.string().nullable(),
        recurring: z.boolean(),
      }),
    )
    .max(20),
  calendarTruncated: z.boolean(),
  encrypted: z.boolean(),
  unreadableReasons: z.array(z.enum(MAIL_READ_UNREADABLE_REASONS)),
  unreadable: z.boolean(),
})
export type MailRead = z.infer<typeof mailReadSchema>

/** The reader refused the request itself: our URL is not the store's, or the body is not its shape. Retrying cannot help. */
export class MailReadRefusedError extends Error {
  constructor(status: number) {
    super(`the mail reader refused the request (${status})`)
    this.name = 'MailReadRefusedError'
  }
}

/**
 * Read one staged raw message. `fileRef` is a presigned GET of it.
 *
 * A 200 always carries a read, whatever the bytes were: parser trouble is in
 * the read (`unreadable`), never a status. A 422 is {@link MailReadRefusedError}
 * (permanent). Anything else (502 from the store, 503 while the API restarts, a
 * timeout) throws for the job's queue to retry.
 */
export async function readMail(fileRef: string): Promise<MailRead> {
  const response = await fetch(`${getBackendUrl()}/v1/mail/read`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-grid-internal-token': process.env.GRID_INTERNAL_API_TOKEN ?? '',
    },
    body: JSON.stringify({ file_ref: fileRef }),
    redirect: 'manual',
    signal: AbortSignal.timeout(MAIL_READ_TIMEOUT_MS),
  })
  if (response.status === 422) throw new MailReadRefusedError(422)
  if (!response.ok) throw new Error(`the mail reader answered ${response.status}`)
  return fromWire(wireMailReadSchema.parse(await response.json()))
}

function fromWire(read: z.infer<typeof wireMailReadSchema>): MailRead {
  return {
    readerVersion: read.reader_version,
    bodySource: read.body_source,
    ownText: read.own_text,
    ownTextTruncated: read.own_text_truncated,
    split: read.split,
    signatureRemoved: read.signature_removed,
    quoted: read.quoted,
    quotedTruncated: read.quoted_truncated,
    calendar: read.calendar.map((event) => ({
      method: event.method,
      summary: event.summary,
      start: event.start,
      end: event.end,
      allDay: event.all_day,
      location: event.location,
      status: event.status,
      organizerName: event.organizer_name,
      recurring: event.recurring,
    })),
    calendarTruncated: read.calendar_truncated,
    encrypted: read.encrypted,
    unreadableReasons: read.unreadable_reasons,
    unreadable: read.unreadable,
  }
}

/**
 * The read with every project address but `keep`'s replaced (B8), in every
 * text a person is shown: the own text, each quoted block and the line that
 * introduced it (a quote header names the addresses of the earlier message),
 * and the calendar's summary, location and organizer. `redact` is
 * `redactProjectAddresses` bound to the deployment's domain.
 */
export function redactRead(read: MailRead, redact: (text: string) => string): MailRead {
  const optional = (text: string | null) => (text === null ? null : redact(text))
  return {
    ...read,
    ownText: redact(read.ownText),
    quoted: read.quoted.map((block) => ({ header: redact(block.header), text: redact(block.text) })),
    calendar: read.calendar.map((event) => ({
      ...event,
      summary: optional(event.summary),
      location: optional(event.location),
      organizerName: optional(event.organizerName),
    })),
  }
}

/** The read of a message nobody could read: the mail still waits, with its original (D6). */
export function unreadableRead(reason: (typeof MAIL_READ_UNREADABLE_REASONS)[number]): MailRead {
  return {
    readerVersion: 1,
    bodySource: 'none',
    ownText: '',
    ownTextTruncated: false,
    split: false,
    signatureRemoved: false,
    quoted: [],
    quotedTruncated: false,
    calendar: [],
    calendarTruncated: false,
    encrypted: false,
    unreadableReasons: [reason],
    unreadable: true,
  }
}
