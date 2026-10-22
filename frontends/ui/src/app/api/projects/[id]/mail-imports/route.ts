/**
 * A project's Outlook archive imports (ADR-0085): list them a page at a time
 * (`?limit=`, `?cursor=` from the previous page's `nextCursor`), or start one.
 * Thin handlers; all logic lives in `@/lib/mail-import/service`.
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { listMailImports, startMailImport } from '@/lib/mail-import/service'
import { mailImportListQuerySchema, startMailImportSchema } from '@/lib/mail-import/types'

type Params = { id: string }

export const GET = apiRoute<Params>(
  ({ session, params, request }) => listMailImports(session, params.id, parseQuery(request, mailImportListQuerySchema)),
  { authz: { enforcedBy: 'listMailImports (requireProjectAccess project:view)' } },
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) =>
    startMailImport(session, params.id, await parseJsonBody(request, startMailImportSchema)),
  {
    status: 201,
    authz: { enforcedBy: 'startMailImport (mail-import flag, requireShelfWrite project:documents:write)' },
  },
)
