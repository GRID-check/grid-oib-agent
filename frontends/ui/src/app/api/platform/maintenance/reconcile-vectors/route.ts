/**
 * Platform maintenance — reconcile orphaned vectors: delete vector-store chunks
 * whose owning document row is gone (the residue of past deletes where the
 * chunk cleanup was skipped or missed). Platform owners only.
 */

import { NextResponse } from 'next/server'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { reconcileOrphanedVectors } from '@/lib/platform/vector-reconcile'

export const POST = platformApiRoute(async () => {
  const result = await reconcileOrphanedVectors()
  return NextResponse.json(result)
})
