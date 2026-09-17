'use client'

/**
 * Per-job run history. Lists this job's runs (newest first): a trigger badge
 * (manual/scheduled), a status badge, a relative timestamp and a link into the
 * thread the run wrote itself into.
 *
 * The run row's own status only records how the SUBMISSION went — the run's
 * actual fate lives in the backend job store. So rows that produced a job are
 * joined against the project's research runs (`GET /v1/jobs/async/jobs`, the
 * same list the History page uses) to show the live job status. The join is
 * best-effort — without it a row falls back to its submission badge.
 *
 * That status used to pick the row's DESTINATION as well: the report, the
 * thinking or the progress tab of the deep-research side panel, all of them
 * `?job=<backendJobId>`. There is one destination now, the run's message in
 * the thread that commissioned it (ADR-0062), and the status only picks the
 * words on the link. A run whose conversation this list cannot name gets no
 * link at all — see the row below for why that is the honest answer.
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
 * The conversation this run is narrated in, or null when nothing named one.
 *
 * Two sources, because the run row and the job are written at different times:
 * the run row's `conversation_id` is recorded when the submission already knows
 * the conversation, and the joined job carries it when the conversation was
 * minted during the run. Either one is the thread the run's message lives in.
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
    <ItemList as="ul" className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
      {runs.map((run) => {
        const TriggerIcon = run.trigger === 'schedule' ? CalendarClock : Hand
        const jobStatus = run.jobId ? jobStatuses[run.jobId] : undefined
        const isActive = jobStatus !== undefined && ACTIVE_JOB_STATUSES.has(jobStatus)
        // The thread, live run or finished one alike: progress, report and
        // failure are all the run's own message now (ADR-0062), so there is
        // nothing left for a status to choose between.
        //
        // `?session=` selects the conversation and `?run=` names the run inside
        // it — the id this list already holds, which the chat page resolves
        // through `GET /api/projects/[id]/runs/[runId]`. No `#message-` anchor:
        // this wire shape carries no run message id, so the reader lands in the
        // thread rather than ON the run. The `?job=` links that used to stand
        // here are gone with the side panel that read them.
        const conversationId = conversationFor(run, conversationIds)
        // No conversation, no thread — and a run history that cannot say where
        // a run went says nothing rather than offering a link that goes
        // nowhere. The badge still states what became of it.
        const link = conversationId
          ? `/app/projects/${projectId}/chat?session=${encodeURIComponent(conversationId)}&run=${encodeURIComponent(run.id)}`
          : null
        const linkLabel = isActive ? t('history.viewProgress') : t('history.openChat')

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
            {link && (
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
