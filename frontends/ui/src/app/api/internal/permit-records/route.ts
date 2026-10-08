/**
 * INTERNAL — the ingest pipeline hands over what a model read out of a
 * Bescheid (docs/design/permitting-memory.md, ADR-0086), and the BFF keeps it
 * as the document's permit record and its requirements.
 *
 * Sent once per document typed `Bescheid`, after it is indexed. `record: null`
 * removes the document's record (it is no longer a Bescheid, or nothing was
 * extracted). A document the BFF does not know answers 200 `{ stored: false }`,
 * like `document-exists`: the pipeline treats the call as best effort and a
 * 404 is also what a BFF that predates this route answers.
 *
 * `documentId` is optional: the backfill knows only a collection and a file
 * name, and a live file name is unique per collection, so it finds the row.
 *
 * Service-to-service only: `GRID_INTERNAL_API_TOKEN` via `internalApiRoute`,
 * fail-closed when unconfigured. The organization is the one the ingest was
 * dispatched for; the project and the folder restriction are the document's
 * own (`lib/permits/service.ts`), never the body's.
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { storePermitRecord } from '@/lib/permits/service'
import { storePermitRecordRequestSchema } from '@/lib/permits/types'

export const POST = internalApiRoute(
  'permit-records',
  async ({ request }) => storePermitRecord(await parseJsonBody(request, storePermitRecordRequestSchema)),
  { tenancy: { fromPayload: 'body.organizationId, the org the ingest was dispatched for' } }
)
