/**
 * Open an upload batch (ADR-0077): the browser does this before it sends the
 * first file of an upload, so the server can tell the uploader when it has all
 * been read, and keep the project's upload history.
 *
 * `excluded` carries what the office's screening kept on the uploader's
 * machine as terms and counts only — never file names.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { UPLOAD_BATCH_SCOPES } from '@/lib/db/schema'
import { openUploadBatch, UPLOAD_BATCH_MAX_FILES } from '@/lib/upload-batches/service'

const bodySchema = z
  .object({
    id: z.string().uuid(),
    scope: z.enum(UPLOAD_BATCH_SCOPES),
    projectId: z.string().uuid().nullable().default(null),
    conversationId: z.string().min(1).max(200).nullable().default(null),
    expectedCount: z.number().int().min(0).max(UPLOAD_BATCH_MAX_FILES),
    excluded: z
      .array(z.object({ term: z.string().trim().min(1).max(80), count: z.number().int().min(1).max(UPLOAD_BATCH_MAX_FILES) }))
      .max(200)
      .default([]),
  })
  .strict()

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, bodySchema)
    await openUploadBatch(session, input)
    return { id: input.id }
  },
  {
    authz: {
      enforcedBy:
        'openUploadBatch (project: requireProjectAccess project:documents:write; Büroablage: canManageArchiv; chat: each upload is authorized on its own and the batch grants nothing)',
    },
  }
)
