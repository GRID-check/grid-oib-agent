/**
 * One part of an Outlook archive being sent (ADR-0085): the raw bytes, written
 * through to the staged multipart upload. Sending a part again replaces it.
 * Thin handler; all logic lives in `@/lib/mail-import/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { DOCUMENT_UPLOAD_LIMIT } from '@/lib/limits'
import { putMailImportPart } from '@/lib/mail-import/service'

type Params = { id: string; importId: string; partNumber: string }

export const PUT = apiRoute<Params>(
  ({ session, params, request }) =>
    putMailImportPart(session, params.id, params.importId, Number(params.partNumber), request),
  {
    authz: { enforcedBy: 'putMailImportPart (requireShelfWrite project:documents:write, own import)' },
    // The upload budget, not the mutation default: a twenty-gigabyte archive is
    // 640 parts, sent a few at a time, and the default would stall it.
    limits: { rule: DOCUMENT_UPLOAD_LIMIT },
  },
)
