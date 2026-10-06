/**
 * A project's upload history (ticket „Verlauf/Protokoll", ADR-0079): who
 * brought how many files in when, and how they ended. The per-file detail
 * stays in each uploader's summary.
 */

import { apiRoute } from '@/lib/api/handler'
import { listProjectUploadHistory } from '@/lib/upload-batches/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({ uploads: await listProjectUploadHistory(session, params.id) }),
  { authz: { enforcedBy: 'listProjectUploadHistory -> requireProjectAccess (project:view)' } }
)
