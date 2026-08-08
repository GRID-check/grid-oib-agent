'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowRight, Telescope } from 'lucide-react'
import { Stagger, StaggerItem } from '@/components/motion'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { EmptyState } from '@/components/ui/empty-state'
import { listResearchRuns, type ResearchRun } from '@/adapters/api/research-runs-client'
import { conversationsClient } from '@/adapters/api/conversations-client'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'

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

export function ResearchRunsList({ projectId, projectCollection }: ResearchRunsListProps): JSX.Element {
  const t = useTranslations('projects')
  const tr = useTranslations('research')
  const { locale } = useLocale()
  const [jobs, setJobs] = useState<ResearchRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // conversation_id -> conversation title, resolved best-effort so each run
  // gets a human-readable label instead of an opaque job-id hash. The original
  // research query is not stored server-side, so the originating chat session's
  // title is the closest meaningful identity available end-to-end.
  const [titles, setTitles] = useState<Record<string, string>>({})

  const statusLabel = (status: string): string =>
    KNOWN_STATUSES.includes(status) ? t(`researchRuns.status.${status}`) : capitalize(status)

  const statusHint = (status: string): string => {
    if (status === 'failed' || status === 'cancelled') {
      return t('researchRuns.hint.noReport')
    }
    return ''
  }

  // Primary row label: the originating session's title when resolvable,
  // otherwise a session-id or (last resort) generic label. The job-id hash is
  // demoted to metadata below.
  const runLabel = (job: ResearchRun): string => {
    const title = job.conversation_id ? titles[job.conversation_id] : undefined
    if (title) return title
    if (job.conversation_id) return tr('runsList.sessionLabel', { id: shortJobId(job.conversation_id) })
    return tr('runsList.untitledRun')
  }

  // Tracks the in-flight fetch (initial, prop-change, or retry) so a newer
  // load or unmount cancels it — a stale response must never overwrite a
  // newer project's list.
  const activeLoadRef = useRef<{ cancelled: boolean } | null>(null)

  const load = useCallback(
    () => {
      if (activeLoadRef.current) {
        activeLoadRef.current.cancelled = true
      }
      const signal = { cancelled: false }
      activeLoadRef.current = signal

      setJobs(null)
      setError(null)
      setTitles({})

      listResearchRuns({ projectCollection, limit: DEFAULT_LIMIT })
        .then((response) => {
          if (signal.cancelled) return
          setJobs(response.jobs)
        })
        .catch((err: unknown) => {
          if (signal.cancelled) return
          setError(err instanceof Error ? err.message : t('researchRuns.loadError'))
        })

      // Best-effort session-title resolution. Failure is non-fatal: rows fall
      // back to a session-id or job-id label rather than blocking the list.
      conversationsClient
        .list(projectId)
        .then((conversations) => {
          if (signal.cancelled) return
          const map: Record<string, string> = {}
          for (const conversation of conversations) {
            const title = conversation.title?.trim()
            if (conversation.id && title) {
              map[conversation.id] = title
            }
          }
          setTitles(map)
        })
        .catch(() => {
          // Non-fatal — labels degrade gracefully without titles.
        })
    },
    [projectCollection, projectId, t],
  )

  useEffect(() => {
    load()
    return () => {
      if (activeLoadRef.current) {
        activeLoadRef.current.cancelled = true
        activeLoadRef.current = null
      }
    }
  }, [load])

  if (error) {
    return (
      <Alert variant="destructive" className="mt-8">
        <AlertCircle />
        <AlertTitle>{t('researchRuns.errorTitle')}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => load()}>
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
          const isFailed = job.status === 'failed'
          // A run still in flight is watchable: the research panel attaches to
          // its live stream, which matters most for runs started outside chat
          // (workflow runs) that have no thread to follow.
          const isActive =
            job.status === 'running' || job.status === 'submitted' || job.status === 'pending'
          const label = runLabel(job)
          return (
            <StaggerItem
              key={job.job_id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 transition-colors duration-200 ease-out hover:bg-accent/40 sm:gap-4 sm:px-6"
            >
              <div className="flex min-w-0 items-center gap-4">
                <Badge variant={STATUS_BADGE_VARIANT[job.status] ?? 'secondary'}>
                  {statusLabel(job.status)}
                </Badge>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium" title={label}>
                    {label}
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-mono">{shortJobId(job.job_id)}</span>
                    <span aria-hidden>·</span>
                    <span title={formatAbsoluteTime(job.created_at, locale)}>
                      {formatRelativeTime(job.created_at, locale)}
                    </span>
                  </span>
                </div>
              </div>

              {isCompleted || isFailed || isActive ? (
                <Button
                  asChild
                  size="sm"
                  variant={isCompleted ? 'default' : 'outline'}
                  className="shrink-0"
                >
                  <Link
                    href={
                      isCompleted
                        ? `/app/projects/${projectId}/chat?job=${job.job_id}`
                        : isActive
                          ? `/app/projects/${projectId}/chat?job=${job.job_id}&tab=tasks`
                          : `/app/projects/${projectId}/chat?job=${job.job_id}&tab=thinking`
                    }
                  >
                    {isCompleted
                      ? t('researchRuns.viewReport')
                      : isActive
                        ? t('researchRuns.viewProgress')
                        : tr('runsList.viewThinking')}
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
