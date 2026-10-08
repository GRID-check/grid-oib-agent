'use client'

/**
 * Platform maintenance: the kill switch for deep research.
 *
 * Stops every queued or running deep research in every organization and closes
 * each run as interrupted (`POST /api/platform/maintenance/kill-runs`,
 * `lib/runs/kill-all.ts`). The anatomy is the shared `MaintenanceActionCard`,
 * in its danger tone; this file is the endpoint, the copy and how to read a
 * `KillAllResult`.
 */

import type { JSX } from 'react'
import { useMemo } from 'react'
import { OctagonX } from 'lucide-react'
import {
  MaintenanceActionCard,
  type MaintenanceActionCopy,
  type MaintenanceMeasure,
  type MaintenanceOutcome,
} from '@/features/platform/components/maintenance-action-card'
import { useLocale, useTranslations } from '@/i18n'

/** Mirrors `KillAllResult` in `@/lib/runs/kill-all`. */
export interface KillResult {
  jobsFound: number
  jobsKilled: number
  jobsAlreadyFinished: number
  runsClosed: number
  failures: { id: string; error: string }[]
  truncated: boolean
}

/**
 * The backend stops up to a thousand jobs one after another; past this the
 * request is released so the dialog cannot hang. The kill itself is
 * server-owned and may still complete.
 */
const KILL_TIMEOUT_MS = 180_000

function parseKill(body: unknown): KillResult {
  const raw = (body ?? {}) as Partial<KillResult>
  return {
    jobsFound: raw.jobsFound ?? 0,
    jobsKilled: raw.jobsKilled ?? 0,
    jobsAlreadyFinished: raw.jobsAlreadyFinished ?? 0,
    runsClosed: raw.runsClosed ?? 0,
    failures: raw.failures ?? [],
    truncated: raw.truncated ?? false,
  }
}

export interface RunKillSwitchProps {
  /** Seeds the last-kill panel, for the dev preview and tests only. */
  initialResult?: KillResult | null
}

export function RunKillSwitch({ initialResult = null }: RunKillSwitchProps): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()

  const copy = useMemo<MaintenanceActionCopy>(
    () => ({
      title: t('runKillSwitch.title'),
      description: t('runKillSwitch.description'),
      run: t('runKillSwitch.run'),
      running: t('runKillSwitch.running'),
      explainers: [
        { key: 'what', term: t('runKillSwitch.whatTitle'), body: t('runKillSwitch.whatBody') },
        { key: 'when', term: t('runKillSwitch.whenTitle'), body: t('runKillSwitch.whenBody') },
        { key: 'loss', term: t('runKillSwitch.lossTitle'), body: t('runKillSwitch.lossBody') },
      ],
      lastRunTitle: t('runKillSwitch.lastRunTitle'),
      lastRunHint: t('runKillSwitch.lastRunHint'),
      neverRunTitle: t('runKillSwitch.neverRunTitle'),
      neverRunBody: t('runKillSwitch.neverRunBody'),
      confirmTitle: t('runKillSwitch.confirmTitle'),
      confirmDescription: t('runKillSwitch.confirmDescription'),
      confirmWarning: t('runKillSwitch.confirmWarning'),
      confirmCta: t('runKillSwitch.confirmCta'),
      cancel: t('runKillSwitch.cancel'),
      failed: t('runKillSwitch.failed'),
      failedHint: t('runKillSwitch.failedHint'),
      colMeasure: t('runKillSwitch.colMeasure'),
      colCount: t('runKillSwitch.colCount'),
      failuresTitle: (count) => t('runKillSwitch.failuresTitle', { count }),
      failuresHint: t('runKillSwitch.failuresHint'),
      colFailureId: t('runKillSwitch.colId'),
      colFailureError: t('runKillSwitch.colError'),
      readOnly: t('runKillSwitch.readOnly'),
    }),
    [t]
  )

  const outcome = useMemo(
    () =>
      (result: KillResult): MaintenanceOutcome => {
        const changed = result.jobsKilled + result.runsClosed > 0
        return {
          changed,
          title: changed
            ? t('runKillSwitch.outcomeKilled', {
                jobs: result.jobsKilled.toLocaleString(locale),
                runs: result.runsClosed.toLocaleString(locale),
              })
            : t('runKillSwitch.outcomeClean'),
          detail: result.truncated ? t('runKillSwitch.truncated') : undefined,
        }
      },
    [locale, t]
  )

  const measures = useMemo(
    () =>
      (result: KillResult): MaintenanceMeasure[] => [
        {
          key: 'found',
          label: t('runKillSwitch.measureFound'),
          hint: t('runKillSwitch.measureFoundHint'),
          value: result.jobsFound,
        },
        {
          key: 'killed',
          label: t('runKillSwitch.measureKilled'),
          hint: t('runKillSwitch.measureKilledHint'),
          value: result.jobsKilled,
        },
        {
          key: 'finished',
          label: t('runKillSwitch.measureFinished'),
          hint: t('runKillSwitch.measureFinishedHint'),
          value: result.jobsAlreadyFinished,
        },
        {
          key: 'closed',
          label: t('runKillSwitch.measureRunsClosed'),
          hint: t('runKillSwitch.measureRunsClosedHint'),
          value: result.runsClosed,
        },
      ],
    [t]
  )

  return (
    <MaintenanceActionCard
      copy={copy}
      icon={OctagonX}
      tone="danger"
      endpoint="/api/platform/maintenance/kill-runs"
      timeoutMs={KILL_TIMEOUT_MS}
      parse={parseKill}
      outcome={outcome}
      measures={measures}
      failures={killFailures}
      initialResult={initialResult}
      testId="run-kill-switch"
      idPrefix="kill-runs"
    />
  )
}

function killFailures(result: KillResult): KillResult['failures'] {
  return result.failures
}
