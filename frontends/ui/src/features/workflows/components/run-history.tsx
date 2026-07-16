'use client'

/**
 * Per-workflow run history. Lists append-only `workflow_runs` (newest first):
 * a trigger badge (manual/scheduled), a status badge (submitted/skipped/error)
 * whose `title` surfaces the skip/error detail, a relative timestamp, and —
 * when a run produced a backend job — a link into the same research report
 * surface the Research tab uses (`/chat?job=<id>`).
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowRight, CalendarClock, Hand } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import {
  listWorkflowRuns,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '@/adapters/api/workflows-client'

interface RunHistoryProps {
  projectId: string
  workflowId: string
}

const STATUS_VARIANT: Record<WorkflowRunStatus, NonNullable<BadgeProps['variant']>> = {
  submitted: 'info',
  skipped: 'warning',
  error: 'destructive',
}

export function RunHistory({ projectId, workflowId }: RunHistoryProps): JSX.Element {
  const t = useTranslations('workflows')
  const { locale } = useLocale()
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    setRuns(null)
    setError(false)
    listWorkflowRuns(projectId, workflowId, { limit: 20 })
      .then(setRuns)
      .catch(() => setError(true))
  }, [projectId, workflowId])

  useEffect(() => {
    load()
  }, [load])

  if (error) {
    return (
      <Alert variant="destructive" className="mt-1">
        <AlertCircle className="size-4" aria-hidden />
        <AlertDescription className="flex flex-col items-start gap-2">
          {t('history.loadError')}
          <Button variant="outline" size="sm" onClick={load}>
            {t('tryAgain')}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (runs === null) {
    return (
      <div className="space-y-2 py-2" data-testid="run-history-loading">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (runs.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">{t('history.empty')}</p>
  }

  return (
    <ul className="divide-y divide-border">
      {runs.map((run) => {
        const TriggerIcon = run.trigger === 'schedule' ? CalendarClock : Hand
        const canOpenReport = run.status === 'submitted' && Boolean(run.jobId)
        return (
          <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <Badge variant="secondary" className="gap-1">
                <TriggerIcon className="size-3" aria-hidden />
                {t(`history.trigger.${run.trigger}`)}
              </Badge>
              <Badge
                variant={STATUS_VARIANT[run.status]}
                title={run.detail ?? undefined}
              >
                {t(`history.status.${run.status}`)}
              </Badge>
              <span
                className="text-xs text-muted-foreground"
                title={formatAbsoluteTime(run.createdAt, locale)}
              >
                {formatRelativeTime(run.createdAt, locale)}
              </span>
            </div>
            {canOpenReport && (
              <Button asChild size="sm" variant="ghost" className="shrink-0">
                <Link href={`/app/projects/${projectId}/chat?job=${run.jobId}`}>
                  {t('history.viewReport')}
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
