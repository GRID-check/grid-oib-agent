/**
 * A project's Outlook archive imports (ADR-0085): list them, or start one.
 * Thin handlers; all logic lives in `@/lib/mail-import/service`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { listMailImports, startMailImport } from '@/lib/mail-import/service'
import { startMailImportSchema } from '@/lib/mail-import/types'

type Params = { id: string }

export const GET = apiRoute<Params>(({ session, params }) => listMailImports(session, params.id), {
  authz: { enforcedBy: 'listMailImports (requireProjectAccess project:view)' },
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) =>
    startMailImport(session, params.id, await parseJsonBody(request, startMailImportSchema)),
  {
    status: 201,
    authz: { enforcedBy: 'startMailImport (mail-import flag, requireShelfWrite project:documents:write)' },
  },
)
