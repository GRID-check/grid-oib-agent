/**
 * Every part of an Outlook archive is sent: join them and queue the filing job
 * (ADR-0085). Thin handler; all logic lives in `@/lib/mail-import/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { completeMailImportUpload } from '@/lib/mail-import/service'

type Params = { id: string; importId: string }

export const POST = apiRoute<Params>(
  ({ session, params }) => completeMailImportUpload(session, params.id, params.importId),
  {
    status: 202,
    authz: { enforcedBy: 'completeMailImportUpload (mail-import flag, requireShelfWrite, own import)' },
  },
)
