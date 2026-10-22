/**
 * Whether Piloti may spend on something nobody asked for (ADR-0130): the
 * person's budget status, FAIL-CLOSED. A spent scope, or a budget that cannot
 * be read, says no. A turn a person types fails the other way; this one is the
 * unasked kind, so the doubt goes against the spend.
 *
 * Work that runs as the system, for no person (Piloti's suggestion for a held
 * mail), passes `userId: null`: the organization's and the project's budgets
 * still decide, and no member's.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getBudgetStatus } from './service'

export async function unaskedSpendAllowed(
  session: Pick<AuthorizedSession, 'organizationId'> & { userId: string | null },
  projectId: string | null,
): Promise<boolean> {
  try {
    const status = await getBudgetStatus(session.organizationId, session.userId, projectId)
    return !status.blocked
  } catch (error) {
    console.warn('[budgets] the budget could not be read; not spending on unasked work', error)
    return false
  }
}
