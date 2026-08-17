'use client'

/**
 * Per-job run history. Lists append-only `job_runs` (newest first): a trigger
 * badge (manual/scheduled), a status badge, a relative timestamp and a link
 * into the research panel.
 *
 * `job_runs.status` only records how the SUBMISSION went — the run's actual
 * fate lives in the backend job store. So rows that produced a job are joined
 * against the project's research runs (`GET /v1/jobs/async/jobs`, the same
 * list the History page uses) to show the live job status, and that status
 * picks the row's action: follow a run that is still going, open the CHAT a
 * finished `chat` run landed in, open the report of a finished report run, or
 * inspect the thinking of one that failed. The join is best-effort — without
 * it a row falls back to its submission badge.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, ArrowRight, CalendarClock, Hand } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemActions, ItemContent, ItemList } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { listResearchRuns } from '@/adapters/api/research-runs-client'
import { listJobRuns, type JobRun, type JobRunStatus } from '@/adapters/api/jobs-client'

interface JobRunHistoryProps {
  projectId: string
  jobId: string
  /** Qdrant collection scoping the live job-status join; null disables it. */
  projectCollection: string | null
}

const STATUS_VARIANT: Record<JobRunStatus, NonNullable<BadgeProps['variant']>> = {
  submitted: 'info',
  skipped: 'warning',
  error: 'destructive',
}

/** Backend job statuses the run history renders, with their badge variants. */
const JOB_STATUS_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  submitted: 'info',
  pending: 'info',
  running: 'info',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
}

/** Statuses that mean the job is still on its way to an outcome. */
const ACTIVE_JOB_STATUSES = new Set(['submitted', 'pending', 'running'])

/** How often live job statuses refresh while a run is still active. */
const JOB_STATUS_POLL_MS = 10000

/** Newest jobs to join against; runs older than this fall back to their badge. */
const JOB_STATUS_LOOKUP_LIMIT = 200

/**
 * The conversation a run landed in, or null when it produced no chat.
 *
 * Two sources, because the run row and the job are written at different times:
 * `job_runs.conversation_id` is recorded when the submission already knows the
 * conversation, and the joined job carries it when the conversation was minted
 * during the run. Either one means the same thing — this run's output is a
 * chat, not a report.
 */
function conversationFor(run: JobRun, byJobId: Record<string, string>): string | null {
  if (run.conversationId) return run.conversationId
  return (run.jobId && byJobId[run.jobId]) || null
}

export function JobRunHistory({
  projectId,
  jobId,
  projectCollection,
}: JobRunHistoryProps): JSX.Element {
  const t = useTranslations('jobs')
  const { locale } = useLocale()
  const [runs, setRuns] = useState<JobRun[] | null>(null)
  const [error, setError] = useState(false)
  const [jobStatuses, setJobStatuses] = useState<Record<string, string>>({})
  /** Conversation minted by a run, by backend job id — see `conversationFor`. */
  const [conversationIds, setConversationIds] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    setRuns(null)
    setError(false)
    listJobRuns(projectId, jobId, { limit: 20 })
      .then(setRuns)
      .catch(() => setError(true))
  }, [projectId, jobId])

  useEffect(() => {
    load()
  }, [load])

  // Live job statuses for the listed runs. One request covers every row (the
  // project's newest jobs), repeated while at least one run is still active.
  useEffect(() => {
    if (!projectCollection || !runs) return
    const backendJobIds = new Set(
      runs.map((run) => run.jobId).filter((id): id is string => Boolean(id)),
    )
    if (backendJobIds.size === 0) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async (): Promise<void> => {
      try {
        const { jobs } = await listResearchRuns({
          projectCollection,
          limit: JOB_STATUS_LOOKUP_LIMIT,
        })
        if (cancelled) return

        const next: Record<string, string> = {}
        const conversations: Record<string, string> = {}
        for (const job of jobs) {
          if (!backendJobIds.has(job.job_id)) continue
          next[job.job_id] = job.status
          // The run row is written at submission time, so a conversation minted
          // later is only knowable from the job itself.
          if (job.conversation_id) conversations[job.job_id] = job.conversation_id
        }
        setJobStatuses(next)
        setConversationIds(conversations)

        if (Object.values(next).some((status) => ACTIVE_JOB_STATUSES.has(status))) {
          timer = setTimeout(() => void poll(), JOB_STATUS_POLL_MS)
        }
      } catch {
        // Best-effort: rows keep their submission badge when the join fails.
      }
    }

    void poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [projectCollection, runs])

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
      <div className="space-y-2 py-2" data-testid="job-run-history-loading">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (runs.length === 0) {
    return <EmptyState variant="bare" title={t('history.empty')} />
  }

  return (
    <ItemList as="ul">
      {runs.map((run) => {
        const TriggerIcon = run.trigger === 'schedule' ? CalendarClock : Hand
        const jobStatus = run.jobId ? jobStatuses[run.jobId] : undefined
        const hasJob = run.status === 'submitted' && Boolean(run.jobId)
        const isActive = jobStatus !== undefined && ACTIVE_JOB_STATUSES.has(jobStatus)
        const hasReport = jobStatus === 'completed'
        // A finished `chat` run IS its conversation, and that is a different
        // destination from a report: `?session=` opens the thread so it can be
        // continued (the parameter the chat surface reads — see
        // `lib/sharing/registry.ts`), where `?job=` opens the research panel.
        // Only once the run is no longer active, because a conversation that
        // is still being written is followed as progress.
        const conversationId = !isActive ? conversationFor(run, conversationIds) : null
        // Unknown live status (join unavailable, or a run older than the
        // lookup window) keeps the previous behavior: offer the report.
        const link = isActive
          ? `/app/projects/${projectId}/chat?job=${run.jobId}&tab=tasks`
          : conversationId
            ? `/app/projects/${projectId}/chat?session=${encodeURIComponent(conversationId)}`
            : jobStatus === 'failed' || jobStatus === 'cancelled'
              ? `/app/projects/${projectId}/chat?job=${run.jobId}&tab=thinking`
              : `/app/projects/${projectId}/chat?job=${run.jobId}`
        const linkLabel = isActive
          ? t('history.viewProgress')
          : conversationId
            ? t('history.openChat')
            : hasReport || jobStatus === undefined
              ? t('history.viewReport')
              : t('history.viewThinking')

        return (
          <Item as="li" key={run.id} className="flex-wrap justify-between py-2.5">
            <ItemContent className="flex min-w-0 items-center gap-3">
              <Badge variant="secondary" className="gap-1">
                <TriggerIcon className="size-3" aria-hidden />
                {t(`history.trigger.${run.trigger}`)}
              </Badge>
              {jobStatus ? (
                <Badge variant={JOB_STATUS_VARIANT[jobStatus] ?? 'secondary'}>
                  {/* An unrecognized backend status is shown verbatim rather
                      than as a missing translation key. */}
                  {jobStatus in JOB_STATUS_VARIANT ? t(`history.jobStatus.${jobStatus}`) : jobStatus}
                </Badge>
              ) : (
                <Badge variant={STATUS_VARIANT[run.status]} title={run.detail ?? undefined}>
                  {t(`history.status.${run.status}`)}
                </Badge>
              )}
              <span
                className="text-xs text-muted-foreground"
                title={formatAbsoluteTime(run.createdAt, locale)}
              >
                {formatRelativeTime(run.createdAt, locale)}
              </span>
            </ItemContent>
            {hasJob && (
              <ItemActions>
                <Button asChild size="sm" variant="ghost" className="shrink-0">
                  <Link href={link}>
                    {linkLabel}
                    <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                </Button>
              </ItemActions>
            )}
          </Item>
        )
      })}
    </ItemList>
  )
}
