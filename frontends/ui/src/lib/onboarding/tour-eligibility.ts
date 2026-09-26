/**
 * Which product tours may start by themselves for the signed-in reader.
 *
 * This is the joiner's road into the tours (see `features/onboarding/lib/
 * product-tour.ts`): an invited member or someone added to a project passes
 * through no hand-over URL, so the server decides from two facts — has this
 * person written anything in the organization, and have they seen the tour.
 * The rule itself is pure and lives beside the tours
 * ({@link tourEligibility}); this is only the two reads.
 *
 * The preferences are read first, and the message probe is skipped once both
 * tours are seen: this runs on every hard load of the frame, and for everyone
 * past their first days the answer is already in the preferences row.
 *
 * Tolerant like the rest of the shell chrome it feeds: any failure means no
 * tour, never a broken frame.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { hasWrittenInOrganization } from '@/lib/conversations/repository'
import { getUserPreferences } from '@/lib/user-preferences/service'
import { NO_TOURS, tourEligibility, type TourEligibility } from '@/features/onboarding/lib/product-tour'

export async function resolveTourEligibility(session: AuthorizedSession): Promise<TourEligibility> {
  try {
    const prefs = await getUserPreferences(session)
    const unseen = tourEligibility(prefs, false)
    if (!unseen.welcome && !unseen.project) return NO_TOURS
    const hasWritten = await hasWrittenInOrganization(session.organizationId, session.userId)
    return tourEligibility(prefs, hasWritten)
  } catch {
    return NO_TOURS
  }
}
