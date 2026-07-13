/**
 * Internal commit-upload endpoint.
 *
 * Service-to-service (`x-grid-internal-token`). The file-gateway calls this when a
 * file written through the mounted drive is complete, so the drive upload runs the
 * SAME document lifecycle as a web upload — a `documents` row + async ingest into
 * the agent — instead of being a lifecycle-less S3 orphan. Authorizes the caller
 * as `project:edit` (the same brain as the web path), then commits.
 */

import { z } from 'zod'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { checkFileAccess } from '@/lib/authz/file-access'
import { commitUploadedFile } from '@/lib/documents/service'
import { NotFoundError } from '@/lib/api/errors'

const requestSchema = z.object({
  userId: z.string().regex(/^user_[A-Za-z0-9]+$/),
  organizationId: z.string().regex(/^org_[A-Za-z0-9]+$/),
  projectId: z.string().uuid(),
  folderId: z.string().uuid().nullish(),
  filename: z.string().min(1).max(512),
  objectKey: z.string().min(1),
  fileSize: z.number().int().nonnegative().nullish(),
  contentType: z.string().max(255).nullish(),
})

const responseSchema = z.object({
  documentId: z.string(),
  status: z.enum(['pending', 'uploaded', 'failed']),
})

export const POST = internalApiRoute('commit-upload', async ({ request }) => {
  const input = await parseJsonBody(request, requestSchema)

  // The drive user must have write access to the project (project:edit). Denials
  // surface as 404 to avoid confirming existence — consistent with the web path.
  const { allow } = await checkFileAccess({
    userId: input.userId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    permission: 'project:edit',
  })
  if (!allow) throw new NotFoundError()

  return responseSchema.parse(
    await commitUploadedFile({
      userId: input.userId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      folderId: input.folderId ?? null,
      filename: input.filename,
      objectKey: input.objectKey,
      fileSize: input.fileSize ?? null,
      contentType: input.contentType ?? null,
    }),
  )
})
