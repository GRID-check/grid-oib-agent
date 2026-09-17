'use client'

/**
 * Dev preview — the three-step schedule wizard, at the step `?step=` names.
 *
 * Three steps means three screens and one screenshot each, so the page drives
 * itself to the requested one by pressing the wizard's own "Weiter" — the same
 * path a person takes, which is also the only way the step's state is real
 * (step 3 summarises what steps 1–2 answered, and a wizard teleported to it
 * would summarise nothing).
 *
 * `?step=1` is the default and is what the flow opens on: one required answer,
 * a name that proposes itself, and nothing else on the screen. `?step=2` is the
 * one worth the most attention — the cadence chips, the time, and the three
 * real fire times underneath that turn the setting into something a person can
 * check before committing to it.
 *
 * Pinned to German: the copy under review is the German copy. 404s outside
 * development.
 */

import { useEffect, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { ScheduleWizard } from '@/features/jobs/components/schedule-wizard'
import { SCHEDULES, installScheduleShim } from '../_fixtures/schedules'

installScheduleShim('__scheduleWizardShim')

/** The fullest schedule in the fixture — a source and a monthly cadence. */
const EDITING = SCHEDULES[1]

export default function ScheduleWizardPreview(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="schedule-wizard-preview"
        className="bg-background text-foreground flex min-h-dvh flex-col p-6"
      >
        <WizardAtStep />
      </main>
    </I18nProvider>
  )
}

function WizardAtStep(): JSX.Element {
  const params = useSearchParams()
  const target = Number(params?.get('step') ?? '1')
  const [advanced, setAdvanced] = useState(0)

  // One press per frame until the requested step is reached. The button is the
  // real one and it only exists once the step before it has rendered, so the
  // loop looks it up each frame rather than holding a node.
  useEffect(() => {
    if (!Number.isFinite(target) || advanced >= target - 1) return
    let stopped = false
    const tick = (): void => {
      if (stopped) return
      const next = document.querySelector<HTMLButtonElement>('[data-testid="wizard-next"]')
      if (next && !next.disabled) {
        next.click()
        setAdvanced((count) => count + 1)
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return () => {
      stopped = true
    }
  }, [target, advanced])

  return (
    <ScheduleWizard
      projectId="p1"
      job={EDITING}
      onSaved={() => {}}
      onCancel={() => {}}
    />
  )
}
