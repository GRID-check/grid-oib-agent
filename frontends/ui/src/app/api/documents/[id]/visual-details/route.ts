/**
 * Document visual-details API — per-page VLM descriptions of a document's
 * visual chunks (drawings / images / charts), the "detailed information" the
 * one-line summary is distilled from. Thin handler; access check and the
 * backend proxy live in `@/lib/documents/service`. Read-only, fail-soft.
 */

import { apiRoute } from '@/lib/api/handler'
import { getDocumentVisualDetails } from '@/lib/documents/service'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getDocumentVisualDetails(session, params.id))
