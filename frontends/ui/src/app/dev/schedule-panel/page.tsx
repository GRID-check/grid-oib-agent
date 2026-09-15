'use client'

/**
 * Dev preview — the Zeitplan tab: the timetable over the schedule cards.
 *
 * What this is evidence of is the ARRANGEMENT, which is the only thing the grid
 * can show and a list cannot. The fixture is built for it: two schedules fire
 * at Monday 06:00, so the collision renders as two blocks side by side in one
 * column; Tuesday and Thursday carry an afternoon block, so the band has to
 * crop to roughly 05:00–17:30 rather than paint sixteen empty hours; one
 * schedule is paused and one is manual-only, so both are absent from the grid
 * and present in the cards — which is the pairing a reader has to be able to
 * make sense of without being told.
 *
 * The cards below carry the same colour swatch as their blocks. That is the
 * whole legend mechanism, and it is why the two orderings are derived from one
 * rule rather than written twice.
 *
 * Pinned to German: the copy under review is the German copy. 404s outside
 * development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { SchedulePanel } from '@/features/jobs/components/schedule-panel'
import { installScheduleShim } from '../_fixtures/schedules'

installScheduleShim('__schedulePanelShim')

export default function SchedulePanelPreview(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      {/* `min-h-dvh`, not `h-dvh`: the real pane scrolls internally, and a
          screenshot of an internal scroller can only ever show its first
          screen. Letting the page grow puts the grid and the cards in one shot. */}
      <main
        data-testid="schedule-panel-preview"
        className="bg-background text-foreground flex min-h-dvh flex-col"
      >
        <SchedulePanel projectId="p1" projectCollection="proj_1" canManageJobs />
      </main>
    </I18nProvider>
  )
}
