/**
 * Document re-ingest API — re-dispatch a previously-failed document to the
 * backend ingest pipeline. Thin handler; all logic (access checks, status
 * guard, dispatch) lives in `@/lib/documents/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { reingestDocument } from '@/lib/documents/service'

type Params = { id: string }

export const POST = apiRoute<Params>(async ({ session, params }) => reingestDocument(session, params.id))
