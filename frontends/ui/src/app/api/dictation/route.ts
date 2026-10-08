/**
 * Voice dictation — one recording from the chat composer in, cleaned text out.
 * Thin handler; the bounds and the backend call live in
 * `@/lib/dictation/service`. Multipart: `audio` (the recording), `durationMs`
 * and `locale` (the UI language, a wording hint only).
 */

import { z } from 'zod'
import { BadRequestError } from '@/lib/api/errors'
import { apiRoute, parseFormData } from '@/lib/api/handler'
import { transcribeDictation } from '@/lib/dictation/service'
import { DICTATION_LIMIT } from '@/lib/limits'

const fieldsSchema = z.object({
  durationMs: z.coerce.number().int().min(0).max(600_000).nullable(),
  locale: z
    .string()
    .max(16)
    .regex(/^[A-Za-z-]+$/)
    .nullable(),
})

export const POST = apiRoute(
  async ({ session, request }) => {
    const form = await parseFormData(request)
    const audio = form.get('audio')
    if (!(audio instanceof Blob)) throw new BadRequestError('A recording is required.')
    const fields = fieldsSchema.safeParse({ durationMs: form.get('durationMs'), locale: form.get('locale') })
    if (!fields.success) throw new BadRequestError('Invalid dictation fields.')
    return transcribeDictation(session, { audio, ...fields.data })
  },
  {
    authz: {
      sessionOnly: true,
      why: 'transcribes the caller’s own recording and returns it to them; it reads and writes no organization data',
    },
    // Unbilled and outside every budget, so this is the bound on its cost.
    limits: { rule: DICTATION_LIMIT },
  },
)
