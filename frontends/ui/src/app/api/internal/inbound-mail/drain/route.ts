/**
 * INTERNAL sweep — file the mail the project inboxes accepted
 * (`lib/inbound-mail/drain.ts`, ADR-0074).
 *
 * Token-guarded housekeeping with the shared service token: the caller is the
 * job scheduler (`scheduler/index.js`), which POSTs here every tick the way it
 * POSTs the run reconciler. There is no general-purpose cron inside the BFF, so
 * the work is a call a timer makes.
 *
 * Safe from several scheduler replicas at once and more often than needed:
 * each delivery is claimed with `FOR UPDATE SKIP LOCKED` and a fresh claim
 * token that fences every later write, so two sweeps take different rows and a
 * stalled one cannot write over the one that took its row over. The counts
 * come back in the body for the caller's log.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { drainInboundMail } from '@/lib/inbound-mail/drain'

export const POST = internalApiRoute('Inbound Mail Drain', () => drainInboundMail(), {
  tenancy: {
    crossTenant:
      'discovery only: claims the due mail deliveries of every organization, reaps stalled attempts and sweeps ' +
      'retention. Each claimed delivery is filed inside withTenant for its own organization, so the folder, ' +
      'document, row and inbox writes are subject to row-level security',
  },
})
