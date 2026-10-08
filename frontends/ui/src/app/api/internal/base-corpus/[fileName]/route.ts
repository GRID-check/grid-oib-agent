/**
 * INTERNAL service endpoint — deletes one base-corpus PDF from the platform
 * bucket (`base-corpus/<fileName>`, ADR-0082) when an admin removes a norm. The
 * backend holds a read-only credential, so the delete goes through the BFF's
 * write client. Idempotent: an object that is already gone is success.
 *
 * Service-to-service only: `GRID_INTERNAL_API_TOKEN` via `internalApiRoute`,
 * fail-closed when unconfigured. 400 for a name that is not a plain `.pdf`
 * basename. Next already URL-decodes the segment, so it is validated as given
 * (decoding again would corrupt a name with a literal `%`); an encoded `%2F`
 * arrives as `/` and is refused.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { deleteBaseCorpusObject } from '@/lib/knowledge/base-corpus-storage'

type Params = { fileName: string }

export const DELETE = internalApiRoute<Params>(
  'base-corpus-delete',
  async ({ params }) => deleteBaseCorpusObject(params.fileName),
  { tenancy: { crossTenant: 'the platform base corpus — reads no tenant rows' } }
)
