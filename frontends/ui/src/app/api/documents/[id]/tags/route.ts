/**
 * Document tag-edit API — replace a document's controlled ingestion tags.
 * Thin handler; access checks, vocabulary validation, and the backend proxy
 * live in `@/lib/documents/service`. The backend remains the authority on the
 * tag vocabulary; the zod schema here only guards request shape + basic bounds.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { updateDocumentTags } from '@/lib/documents/service'
import { MAX_TAGS } from '@/lib/documents/tag-vocabulary'

type Params = { id: string }

const updateTagsSchema = z.object({
  // Empty list is allowed (clears tags). Vocabulary membership is enforced in
  // the service against the mirrored ALLOWED_TAGS and, authoritatively, the
  // backend — the schema only bounds shape and count.
  tags: z.array(z.string().min(1).max(128)).max(MAX_TAGS),
})

export const PATCH = apiRoute<Params>(async ({ session, request, params }) => {
  const { tags } = await parseJsonBody(request, updateTagsSchema)
  return updateDocumentTags(session, params.id, tags)
})
