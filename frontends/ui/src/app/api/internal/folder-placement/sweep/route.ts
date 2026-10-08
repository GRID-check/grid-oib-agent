/**
 * INTERNAL sweep — move the documents a backend outage left in the wrong
 * retrieval collection (ADR-0084, `lib/projects/placement-sweep.ts`). Called by
 * the job scheduler on its tick, like the upload sweep.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { sweepCollectionPlacement } from '@/lib/projects/placement-sweep'

export const POST = internalApiRoute('Folder Placement Sweep', () => sweepCollectionPlacement(), {
  tenancy: {
    crossTenant:
      'discovery only: lists the projects of every organization that restrict a folder; each project is placed ' +
      'inside withTenant for its own organization, so every write is subject to row-level security',
  },
})
