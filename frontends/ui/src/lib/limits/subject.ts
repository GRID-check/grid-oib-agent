/**
 * Who a budget is charged to (ADR-0040 L2).
 *
 * One function, because the subject is the half of a rate limit that is easy to
 * get quietly wrong. Two failure modes, both silent:
 *
 *   - **Too coarse** — keying on the organization alone means one member's
 *     runaway client spends everybody's budget, and the limit reads as an
 *     outage to people who did nothing.
 *   - **Too narrow, or caller-controlled** — keying on anything the caller can
 *     vary (a header, a client-supplied id) means the limit is opt-out.
 *
 * `organizationId:userId` is the honest unit: the same person in two tenants is
 * two callers, so work in one org cannot throttle their work in the other, and
 * both halves come from the verified session.
 *
 * Deliberately its own module rather than living in `./enforce`: `@/lib/api/handler`
 * needs it, and `./enforce` pulls in the store (and therefore `server-only` and
 * ioredis), which is more than a key-building helper should drag along.
 */

import type { GridSession } from '@/lib/auth/types'

/** The bucket subject for a member acting inside their active organization. */
export function memberSubject(session: Pick<GridSession, 'organizationId' | 'userId'>): string {
  return `${session.organizationId ?? 'no-org'}:${session.userId}`
}
