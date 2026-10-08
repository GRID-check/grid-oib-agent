/**
 * INTERNAL sweep — settle the uploads nobody is reading any more (ADR-0085,
 * `lib/upload-batches/sweep.ts`). Called by the job scheduler on its tick, the
 * same shape as the run reconciler. Replica-safe: completion is a guarded
 * UPDATE, so a batch is announced to its uploader once, and a quarantine
 * decision is one audit event however many sweeps send it (idempotency key).
 */

import { internalApiRoute } from '@/lib/api/handler'
import { sweepUploadBatches } from '@/lib/upload-batches/sweep'

export const POST = internalApiRoute('Upload Sweep', () => sweepUploadBatches(), {
  tenancy: {
    crossTenant:
      'discovery only: lists the open upload batches and the quarantine decisions owed to the audit trail of ' +
      'every organization; each batch is sealed, reconciled and settled, and each decision marked audited, ' +
      'inside withTenant for its own organization, so those writes are subject to row-level security. The one ' +
      'cross-tenant write is the retention: deleting the decisions the trail has, or older than a week',
  },
})
