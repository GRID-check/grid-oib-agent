/**
 * The organization's download log (ADR-0087): who took which document out, and
 * who opened one in a folder with its own access list.
 *
 * GET — `org:downloads:view` (organization admins, or a custom role given it). Newest first, paginated by
 *       an opaque `cursor`, filtered by person (`userId`), document (`document`:
 *       an id, or part of the name it had) and day (`from`, `to`). Every read is
 *       recorded in the audit trail first, and refused if it cannot be. The
 *       permission clears no folder: a row in a folder the reader may not read
 *       comes without its document and folder names (`nameWithheld`).
 * Thin handler; logic, authorization and the audit event live in
 * `@/lib/download-log/service`.
 */

import { z } from 'zod'
import { apiRoute, parseQuery } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { ACCESS_LOG_MAX_LIMIT, DOWNLOAD_LOG_KINDS } from '@/lib/download-log/kinds'
import { listDownloadLog } from '@/lib/download-log/service'

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .refine((date) => !Number.isNaN(date.getTime()))

const querySchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  document: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(DOWNLOAD_LOG_KINDS).optional(),
  /** First day shown (UTC), inclusive. */
  from: day.optional(),
  /** Last day shown (UTC), inclusive: the query is below the start of the day after. */
  to: day.optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(ACCESS_LOG_MAX_LIMIT).optional(),
})

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export const GET = apiRoute(
  async ({ session, request }) => {
    const { to, ...query } = parseQuery(request, querySchema)
    return listDownloadLog(
      session,
      { ...query, ...(to ? { to: new Date(to.getTime() + ONE_DAY_MS) } : {}) },
      request
    )
  },
  { authz: { permission: ORG_PERMISSIONS.downloadLogView } }
)
