/**
 * Document status API — read one document's ingestion status (lazily
 * reconciled with the backend).
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getDocumentStatus } from '@/lib/documents/service'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getDocumentStatus(session, params.id))
