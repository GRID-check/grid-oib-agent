'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowRight, Telescope } from 'lucide-react'
import { Stagger, StaggerItem } from '@/components/motion'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { EmptyState } from '@/components/ui/empty-state'
import { listResearchRuns, type ResearchRun } from '@/adapters/api/research-runs-client'
import { useTranslations } from '@/i18n'

const DEFAULT_LIMIT = 50

interface ResearchRunsListProps {
  projectId: string
  projectCollection: string
}

const STATUS_BADGE_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  running: 'info',
  submitted: 'info',
  pending: 'info',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
}

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

const KNOWN_STATUSES = ['running', 'submitted', 'pending', 'completed', 'failed', 'cancelled']

const shortJobId = (jobId: string): string => jobId.slice(0, 8)

const formatRelativeTime = (isoDate: string): string => {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate

  const diffMs = date.getTime() - Date.now()
  const diffSeconds = Math.round(diffMs / 1000)
  const absSeconds = Math.abs(diffSeconds)

  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  const thresholds: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [2592000, 'day'],
    [31536000, 'month'],
    [Infinity, 'year'],
  ]

  const divisors: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000,
    year: 31536000,
    quarter: 7776000,
  }

  for (const [limit, unit] of thresholds) {
    if (absSeconds < limit) {
      const divisor = divisors[unit]
      const value = Math.round(diffSeconds / divisor)
      return rtf.format(value, unit)
    }
  }

  return rtf.format(Math.round(diffSeconds / divisors.year), 'year')
}

export function ResearchRunsList({ projectId, projectCollection }: ResearchRunsListProps): JSX.Element {
  const t = useTranslations('projects')
  const [jobs, setJobs] = useState<ResearchRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const statusLabel = (status: string): string =>
    KNOWN_STATUSES.includes(status) ? t(`researchRuns.status.${status}`) : capitalize(status)

  const statusHint = (status: string): string => {
    if (status === 'running' || status === 'submitted' || status === 'pending') {
      return t('researchRuns.hint.reportPending')
    }
    if (status === 'failed' || status === 'cancelled') {
      return t('researchRuns.hint.noReport')
    }
    return ''
  }

  const load = useCallback(
    (signal: { cancelled: boolean }) => {
      setJobs(null)
      setError(null)

      listResearchRuns({ projectCollection, limit: DEFAULT_LIMIT })
        .then((response) => {
          if (signal.cancelled) return
          setJobs(response.jobs)
        })
        .catch((err: unknown) => {
          if (signal.cancelled) return
          setError(err instanceof Error ? err.message : t('researchRuns.loadError'))
        })
    },
    [projectCollection],
  )

  useEffect(() => {
    const signal = { cancelled: false }
    load(signal)
    return () => {
      signal.cancelled = true
    }
  }, [load])

  if (error) {
    return (
      <Alert variant="destructive" className="mt-8">
        <AlertCircle />
        <AlertTitle>{t('researchRuns.errorTitle')}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const signal = { cancelled: false }
              load(signal)
            }}
          >
            {t('researchRuns.tryAgain')}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (jobs === null) {
    return (
      <div className="mt-8 overflow-hidden rounded-2xl border bg-card shadow-xs">
        <div className="divide-y divide-border">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex items-center justify-between gap-4 px-6 py-3.5">
              <div className="flex items-center gap-3">
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-4 w-24" />
              </div>
              <Skeleton className="h-8 w-28 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <EmptyState
        className="mt-8"
        icon={Telescope}
        title={t('researchRuns.emptyTitle')}
        description={t('researchRuns.emptyDescription')}
        action={
          <Button asChild>
            <Link href={`/app/projects/${projectId}/chat`}>{t('researchRuns.emptyAction')}</Link>
          </Button>
        }
      />
    )
  }

  return (
    <div className="mt-8 overflow-hidden rounded-2xl border bg-card shadow-xs">
      <Stagger className="divide-y divide-border">
        {jobs.map((job) => {
          const isCompleted = job.status === 'completed'
          return (
            <StaggerItem
              key={job.job_id}
              className="flex items-center justify-between gap-4 px-6 py-3.5 transition-colors duration-200 ease-out hover:bg-accent/40"
            >
              <div className="flex min-w-0 items-center gap-4">
                <Badge variant={STATUS_BADGE_VARIANT[job.status] ?? 'secondary'}>
                  {statusLabel(job.status)}
                </Badge>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-xs text-muted-foreground">
                    {shortJobId(job.job_id)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(job.created_at)}
                  </span>
                </div>
              </div>

              {isCompleted ? (
                <Button asChild size="sm" className="shrink-0">
                  <Link href={`/app/projects/${projectId}/chat?job=${job.job_id}`}>
                    {t('researchRuns.viewReport')}
                    <ArrowRight />
                  </Link>
                </Button>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {statusHint(job.status)}
                </span>
              )}
            </StaggerItem>
          )
        })}
      </Stagger>
    </div>
  )
}
