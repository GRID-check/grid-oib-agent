/**
 * The backend's archive reader, as the filing job calls it (ADR-0085).
 *
 * The backend reads; it decides nothing. What comes back is parsed here, at the
 * boundary, because the job trusts it for folder names, filenames and the
 * position it saves as its cursor.
 */

import 'server-only'
import { z } from 'zod'
import { getBackendUrl } from '@/lib/backend-proxy'

/** A page or an attachment can be a large read on a cold archive. */
const READ_TIMEOUT_MS = 120_000

const addressSchema = z.object({ name: z.string(), address: z.string() })

const attachmentSchema = z.object({
  index: z.number().int().nonnegative(),
  filename: z.string(),
  content_type: z.string().nullable(),
  size: z.number().int().nonnegative(),
  inline: z.boolean(),
  embedded_message: z.boolean(),
})

const messageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('other'),
    position: z.number().int().nonnegative(),
    message_class: z.string(),
    folder_path: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('mail'),
    position: z.number().int().nonnegative(),
    message_class: z.string(),
    folder_path: z.array(z.string()),
    subject: z.string(),
    sender: addressSchema.nullable(),
    to: z.array(addressSchema),
    cc: z.array(addressSchema),
    sent_at: z.string().nullable(),
    received_at: z.string().nullable(),
    message_id: z.string().nullable(),
    body: z.object({ text: z.string(), source: z.string(), truncated: z.boolean() }),
    attachments: z.array(attachmentSchema),
  }),
])

const pageSchema = z.object({
  total: z.number().int().nonnegative(),
  next_position: z.number().int().nonnegative().nullable(),
  messages: z.array(messageSchema),
})

export type ArchiveItem = z.infer<typeof messageSchema>
export type ArchiveMail = Extract<ArchiveItem, { kind: 'mail' }>
export type ArchiveAttachment = z.infer<typeof attachmentSchema>
export type ArchivePage = z.infer<typeof pageSchema>

export interface ArchiveRef {
  key: string
  url: string
  size: number
}

/** The file is not an archive the backend can read. Retrying will not change that. */
export class UnreadableArchiveError extends Error {
  constructor(detail: string) {
    super(`The archive could not be read: ${detail}`)
    this.name = 'UnreadableArchiveError'
  }
}

/** The backend refused one attachment as too large. The mail is still filed without it. */
export class AttachmentTooLargeError extends Error {
  constructor() {
    super('The attachment is too large to import')
    this.name = 'AttachmentTooLargeError'
  }
}

export async function readArchivePage(archive: ArchiveRef, start: number, limit: number): Promise<ArchivePage> {
  const response = await post('/v1/mail-archive/messages', { archive, start, limit })
  return pageSchema.parse(await response.json())
}

export async function readArchiveAttachment(archive: ArchiveRef, position: number, index: number): Promise<Uint8Array> {
  const response = await post('/v1/mail-archive/attachment', { archive, position, index })
  return new Uint8Array(await response.arrayBuffer())
}

async function post(path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${getBackendUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-grid-internal-token': process.env.GRID_INTERNAL_API_TOKEN ?? '',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (response.ok) return response
  const detail = await response.text().catch(() => '')
  if (response.status === 422) throw new UnreadableArchiveError(detailOf(detail))
  if (response.status === 413) throw new AttachmentTooLargeError()
  // Anything else (a 502 from the store, a 503 while the backend restarts) is
  // worth another attempt: the job's own retry takes it.
  throw new Error(`the archive reader answered ${response.status} on ${path}: ${detailOf(detail)}`)
}

function detailOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown }
    return typeof parsed.detail === 'string' ? parsed.detail : body.slice(0, 200)
  } catch {
    return body.slice(0, 200)
  }
}
