/**
 * The quarantine queue (ADR-0083): documents the content check held back, that
 * this session may release or delete. Org admins see the organization's queue,
 * project admins their projects' part of it, everyone else an empty list.
 */

import { apiRoute } from '@/lib/api/handler'
import { listQuarantineQueue } from '@/lib/upload-screening/review'

export const GET = apiRoute(async ({ session }) => ({ items: await listQuarantineQueue(session) }), {
  authz: {
    sessionOnly: true,
    why: 'the list is filtered per row by mayReviewQuarantine (org:projects:administer, project:manage on the project, org:archiv:manage), so a member without either sees an empty queue',
  },
})
