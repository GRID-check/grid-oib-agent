/**
 * INTERNAL sweep — settle the uploads nobody is reading any more (ADR-0085,
 * `lib/upload-batches/sweep.ts`). Called by the job scheduler on its tick, the
 * same shape as the run reconciler. Replica-safe: completion is a guarded
 * UPDATE, so a batch is announced to its uploader once.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { sweepUploadBatches } from '@/lib/upload-batches/sweep'

export const POST = internalApiRoute('Upload Sweep', () => sweepUploadBatches(), {
  tenancy: {
    crossTenant:
      'discovery only: lists the open upload batches of every organization; each batch is sealed, reconciled ' +
      'and settled inside withTenant for its own organization, so every write is subject to row-level security',
  },
})
