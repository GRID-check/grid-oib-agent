/**
 * The original `.eml` of one filed message (ADR-0134, D6): evidence, kept
 * beside its section of the E-Mail-Verlauf.
 *
 * GET — scanned whole on this request; served only on a clean answer (409
 *       `original_not_clean` otherwise; `gone` for a message that has none, an
 *       archive entry), never sniffed or run, and audited
 *       (`mail_thread.original_read`). Whoever may read the thread downloads
 *       it; no agent door offers it (withheld, `evidence`). The scanning is
 *       bounded per person (`MAIL_ORIGINAL_DOWNLOAD_LIMIT`).
 *
 * Thin handler; the logic is `@/lib/mail-thread/originals`.
 */

import { apiRoute } from '@/lib/api/handler'
import { MAIL_ORIGINAL_DOWNLOAD_LIMIT } from '@/lib/limits/catalog'
import { readEntryOriginal } from '@/lib/mail-thread/originals'

type Params = { id: string; threadId: string; entryId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) =>
    readEntryOriginal(session, params.id, params.threadId, params.entryId),
  {
    authz: {
      enforcedBy:
        'readEntryOriginal -> readableEntry (inbound-mail entitlement; project:view; the thread document screened and in a folder the caller sees)',
    },
    limits: { rule: MAIL_ORIGINAL_DOWNLOAD_LIMIT },
  }
)
