'use client'

/**
 * Platform maintenance: the orphaned-vector sweep.
 *
 * The only control in the product that deletes from the shared vector store,
 * across every organization at once. The operator who reaches for it is
 * already confused (retrieval cites something the catalog says does not
 * exist), so the card explains what reconciling does, when it is needed and
 * what it never touches, and keeps the run's counts on screen until the page
 * is left. Nothing records a run, so a reload loses them.
 *
 * The anatomy (confirm, abortable request, result tables, read-only gate) is
 * the shared `MaintenanceActionCard`; this file is the endpoint, the copy and
 * how to read a `VectorReconcileResult`.
 */

import type { JSX } from 'react'
import { useMemo } from 'react'
import { Brush } from 'lucide-react'
import {
  MaintenanceActionCard,
  type MaintenanceActionCopy,
  type MaintenanceFailure,
  type MaintenanceMeasure,
  type MaintenanceOutcome,
} from '@/features/platform/components/maintenance-action-card'
import { useLocale, useTranslations } from '@/i18n'

/** Mirrors `VectorReconcileResult` in `@/lib/platform/vector-reconcile`. */
export interface ReconcileResult {
  collectionsScanned: number
  orphansFound: number
  orphansDeleted: number
  summariesForgotten: number
  failures: { collectionName: string; error: string }[]
}

/**
 * A sweep that has not answered in this long is not going to. Aborting only
 * releases the UI; the server-side sweep may still complete, which the failure
 * copy says.
 */
const RECONCILE_TIMEOUT_MS = 120_000

/** A BFF older than this panel (rolling deploy) may omit `failures` or `summariesForgotten`. */
function parseReconcile(body: unknown): ReconcileResult {
  const raw = (body ?? {}) as Partial<ReconcileResult>
  return {
    collectionsScanned: raw.collectionsScanned ?? 0,
    orphansFound: raw.orphansFound ?? 0,
    orphansDeleted: raw.orphansDeleted ?? 0,
    summariesForgotten: raw.summariesForgotten ?? 0,
    failures: raw.failures ?? [],
  }
}

export interface VectorMaintenanceProps {
  /** Seeds the last-run panel, for the dev preview and tests only. */
  initialResult?: ReconcileResult | null
}

export function VectorMaintenance({ initialResult = null }: VectorMaintenanceProps): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()

  const copy = useMemo<MaintenanceActionCopy>(
    () => ({
      title: t('vectorMaintenance.title'),
      description: t('vectorMaintenance.description'),
      run: t('vectorMaintenance.run'),
      running: t('vectorMaintenance.running'),
      explainers: [
        { key: 'how', term: t('vectorMaintenance.howTitle'), body: t('vectorMaintenance.howBody') },
        {
          key: 'when',
          term: t('vectorMaintenance.whenTitle'),
          body: t('vectorMaintenance.whenBody'),
        },
        {
          key: 'scope',
          term: t('vectorMaintenance.scopeTitle'),
          body: t('vectorMaintenance.scopeBody'),
        },
      ],
      lastRunTitle: t('vectorMaintenance.lastRunTitle'),
      lastRunHint: t('vectorMaintenance.lastRunHint'),
      neverRunTitle: t('vectorMaintenance.neverRunTitle'),
      neverRunBody: t('vectorMaintenance.neverRunBody'),
      confirmTitle: t('vectorMaintenance.confirmTitle'),
      confirmDescription: t('vectorMaintenance.confirmDescription'),
      confirmWarning: t('vectorMaintenance.confirmWarning'),
      confirmCta: t('vectorMaintenance.confirmCta'),
      cancel: t('vectorMaintenance.cancel'),
      failed: t('vectorMaintenance.failed'),
      failedHint: t('vectorMaintenance.failedHint'),
      colMeasure: t('vectorMaintenance.colMeasure'),
      colCount: t('vectorMaintenance.colCount'),
      failuresTitle: (count) => t('vectorMaintenance.failuresTitle', { count }),
      failuresHint: t('vectorMaintenance.failuresHint'),
      colFailureId: t('vectorMaintenance.colCollection'),
      colFailureError: t('vectorMaintenance.colError'),
      readOnly: t('vectorMaintenance.readOnly'),
    }),
    [t]
  )

  const outcome = useMemo(
    () =>
      (result: ReconcileResult): MaintenanceOutcome => ({
        changed: result.orphansDeleted > 0,
        title:
          result.orphansDeleted > 0
            ? t('vectorMaintenance.outcomeRemoved', {
                chunks: result.orphansDeleted.toLocaleString(locale),
                collections: result.collectionsScanned.toLocaleString(locale),
              })
            : t('vectorMaintenance.outcomeClean'),
      }),
    [locale, t]
  )

  const measures = useMemo(
    () =>
      (result: ReconcileResult): MaintenanceMeasure[] => [
        {
          key: 'collections',
          label: t('vectorMaintenance.measureCollections'),
          hint: t('vectorMaintenance.measureCollectionsHint'),
          value: result.collectionsScanned,
        },
        {
          key: 'found',
          label: t('vectorMaintenance.measureFound'),
          hint: t('vectorMaintenance.measureFoundHint'),
          value: result.orphansFound,
        },
        {
          key: 'deleted',
          label: t('vectorMaintenance.measureDeleted'),
          hint: t('vectorMaintenance.measureDeletedHint'),
          value: result.orphansDeleted,
        },
        {
          key: 'summaries',
          label: t('vectorMaintenance.measureSummaries'),
          hint: t('vectorMaintenance.measureSummariesHint'),
          value: result.summariesForgotten,
        },
      ],
    [t]
  )

  return (
    <MaintenanceActionCard
      copy={copy}
      icon={Brush}
      endpoint="/api/platform/maintenance/reconcile-vectors"
      timeoutMs={RECONCILE_TIMEOUT_MS}
      parse={parseReconcile}
      outcome={outcome}
      measures={measures}
      failures={reconcileFailures}
      initialResult={initialResult}
      testId="vector-maintenance"
      idPrefix="reconcile"
    />
  )
}

function reconcileFailures(result: ReconcileResult): MaintenanceFailure[] {
  return result.failures.map((failure) => ({ id: failure.collectionName, error: failure.error }))
}
