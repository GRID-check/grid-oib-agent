/**
 * What an upload's name check kept back, as the batch routes accept it
 * (ADR-0086): terms and counts, never a file name. One schema for the open and
 * the seal, so both bound it alike.
 */

import { z } from 'zod'
import { UPLOAD_BATCH_MAX_FILES } from '@/lib/upload-batches/service'

export const uploadBatchExclusionsSchema = z
  .array(
    z.object({ term: z.string().trim().min(1).max(80), count: z.number().int().min(1).max(UPLOAD_BATCH_MAX_FILES) }).strict()
  )
  .max(200)
  .default([])
