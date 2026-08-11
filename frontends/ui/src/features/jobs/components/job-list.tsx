'use client'

/**
 * The project's jobs. One card per job: name, the prompt it sends, what a run
 * produces, the attached skill (or the fact that there is none), an enable
 * switch (PATCH, optimistic), a humanized schedule summary, next/last run, and
 * actions (run now, edit, delete, and an expandable run history).
 *
 * The PROMPT is on the card because it is what the job IS — a row that named
 * only a skill would be describing the optional part and hiding the required
 * one. Run-now and all mutations require project:skills:manage; without it the
 * card is read-only.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  History,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import {
  deleteJob,
  listJobs,
  runJob,
  updateJob,
  JobApiError,
  type Job,
} from '@/adapters/api/jobs-client'
import { ConfirmDeleteDialog } from '@/features/skills/components/confirm-delete-dialog'
import { presetForCron } from '../lib/schedule'
import { JobRunHistory } from './job-run-history'

interface JobListProps {
  projectId: string
  /** Qdrant collection of this project — scopes the run history's live job statuses. */
  projectCollection: string | null
  /** Whether this member may create/edit/delete/run jobs (project:skills:manage). */
  canManage: boolean
  onCreate: () => void
  onEdit: (job: Job) => void
}

type Translate = ReturnType<typeof useTranslations>

/** Humanized schedule summary for a card, including the timezone. */
function scheduleSummary(t: Translate, cron: string | null, timezone: string): string {
  if (!cron) return t('list.manualOnly')
  const preset = presetForCron(cron)
  const summary =
    preset === 'hourly'
      ? t('schedule.summaryHourly')
      : preset === 'daily'
        ? t('schedule.summaryDaily')
        : preset === 'weekly'
          ? t('schedule.summaryWeekly')
          : preset === 'monthly'
            ? t('schedule.summaryMonthly')
            : t('schedule.summaryCustom', { cron })
  return t('schedule.inTimezone', { summary, timezone })
}

function JobCard({
  projectId,
  projectCollection,
  job,
  canManage,
  onEdit,
  onChanged,
  onDeleted,
}: {
  projectId: string
  projectCollection: string | null
  job: Job
  canManage: boolean
  onEdit: (job: Job) => void
  onChanged: (next: Job) => void
  onDeleted: (id: string) => void
}): JSX.Element {
  const t = useTranslations('jobs')
  const { locale } = useLocale()
  const router = useRouter()
  const [toggling, setToggling] = useState(false)
  const [running, setRunning] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Remounts the run history so a just-started run shows up immediately.
  const [historyToken, setHistoryToken] = useState(0)

  const toggleEnabled = async (enabled: boolean) => {
    setToggling(true)
    // Optimistic — revert on failure.
    onChanged({ ...job, enabled })
    try {
      const updated = await updateJob(projectId, job.id, { enabled })
      onChanged(updated)
    } catch {
      onChanged({ ...job, enabled: !enabled })
      toast.error(t('list.toggleError'))
    } finally {
      setToggling(false)
    }
  }

  const runNow = async () => {
    setRunning(true)
    try {
      const result = await runJob(projectId, job.id)
      if (result.status === 'submitted') {
        // The run is now a live job. Open the history (so the new row and its
        // status are visible right away) and offer a one-click jump into the
        // research panel that follows it.
        const backendJobId = result.jobId
        toast.success(t('run.submitted'), {
          description: t('run.submittedDetail'),
          ...(backendJobId
            ? {
                action: {
                  label: t('run.viewProgress'),
                  onClick: () =>
                    router.push(`/app/projects/${projectId}/chat?job=${backendJobId}&tab=tasks`),
                },
              }
            : {}),
        })
        setHistoryOpen(true)
        setHistoryToken((token) => token + 1)
        onChanged({ ...job, lastRunAt: new Date().toISOString() })
      } else if (result.status === 'skipped') {
        toast.warning(t('run.skipped'), { description: result.detail ?? undefined })
      } else {
        toast.error(t('run.error'), { description: result.detail ?? undefined })
      }
    } catch (err) {
      if (err instanceof JobApiError && err.status === 409) {
        toast.error(t('run.disabled'))
      } else {
        toast.error(t('run.error'))
      }
    } finally {
      setRunning(false)
    }
  }

  const confirmDelete = async () => {
    setDeleting(true)
    try {
      await deleteJob(projectId, job.id)
      setConfirmOpen(false)
      onDeleted(job.id)
    } catch {
      toast.error(t('deleteDialog.error'))
    } finally {
      setDeleting(false)
    }
  }

  const nextRun = job.nextRunAt
    ? t('list.nextRun', { time: formatRelativeTime(job.nextRunAt, locale) })
    : null
  const lastRun = job.lastRunAt
    ? t('list.lastRun', { time: formatRelativeTime(job.lastRunAt, locale) })
    : t('list.neverRun')

  return (
    <Card className={cn(!job.enabled && 'opacity-75')}>
      <CardContent className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground">{job.name}</h3>
              <Badge variant="secondary">{t(`list.output.${job.output}`)}</Badge>
              {!job.enabled && <Badge variant="outline">{t('list.disabled')}</Badge>}
            </div>
            {/* The prompt, verbatim and clamped. It is what the job sends. */}
            <p className="line-clamp-2 text-sm text-muted-foreground">{job.prompt}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {toggling && <Spinner size="sm" />}
            {canManage && (
              <Switch
                checked={job.enabled}
                disabled={toggling}
                onCheckedChange={(checked) => void toggleEnabled(checked)}
                aria-label={
                  job.enabled
                    ? t('list.disableAria', { name: job.name })
                    : t('list.enableAria', { name: job.name })
                }
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CalendarClock className="size-3.5" aria-hidden />
            {scheduleSummary(t, job.scheduleCron, job.scheduleTimezone)}
          </span>
          {/* No skill is the common case, and it is stated rather than left
              blank: a missing line reads as missing information. */}
          <span className="flex items-center gap-1.5">
            <Sparkles className="size-3.5" aria-hidden />
            {job.skillName ? t('list.withSkill', { name: job.skillName }) : t('list.noSkill')}
          </span>
          {nextRun && <span>{nextRun}</span>}
          <span title={job.lastRunAt ? formatAbsoluteTime(job.lastRunAt, locale) : undefined}>
            {lastRun}
          </span>
        </div>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void runNow()} disabled={running || !job.enabled}>
              {running ? <Spinner size="sm" /> : <Play className="size-3.5" aria-hidden />}
              {running ? t('actions.running') : t('actions.runNow')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onEdit(job)}>
              <Pencil className="size-3.5" aria-hidden />
              {t('actions.edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmOpen(true)}
            >
              <Trash2 className="size-3.5" aria-hidden />
              {t('actions.delete')}
            </Button>
          </div>
        )}

        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              <History className="size-3.5" aria-hidden />
              {t('actions.history')}
              <ChevronDown
                className={cn('size-3.5 transition-transform', historyOpen && 'rotate-180')}
                aria-hidden
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t border-border pt-1">
            {historyOpen && (
              <JobRunHistory
                key={historyToken}
                projectId={projectId}
                projectCollection={projectCollection}
                jobId={job.id}
              />
            )}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('deleteDialog.title')}
        description={t('deleteDialog.description', { name: job.name })}
        confirmLabel={t('deleteDialog.confirm')}
        cancelLabel={t('deleteDialog.cancel')}
        pending={deleting}
        onConfirm={confirmDelete}
      />
    </Card>
  )
}

export function JobList({
  projectId,
  projectCollection,
  canManage,
  onCreate,
  onEdit,
}: JobListProps): JSX.Element {
  const t = useTranslations('jobs')
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    setJobs(null)
    setError(false)
    listJobs(projectId)
      .then(setJobs)
      .catch(() => setError(true))
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  const handleChanged = useCallback((next: Job) => {
    setJobs((prev) => prev?.map((job) => (job.id === next.id ? next : job)) ?? prev)
  }, [])

  const handleDeleted = useCallback((id: string) => {
    setJobs((prev) => prev?.filter((job) => job.id !== id) ?? prev)
  }, [])

  return (
    <section className="space-y-4" aria-labelledby="jobs-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="jobs-heading" className="text-sm font-semibold text-foreground">
          {t('list.heading')}
        </h2>
        {canManage && (
          <Button size="sm" onClick={onCreate}>
            <Plus className="size-4" aria-hidden />
            {t('list.empty.action')}
          </Button>
        )}
      </div>

      {jobs === null && !error && (
        <div className="space-y-3" data-testid="jobs-loading">
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-36 w-full rounded-xl" />
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t('loadError')}</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={load}>
              {t('tryAgain')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {jobs !== null && !error && jobs.length === 0 && (
        <EmptyState
          icon={CalendarClock}
          title={t('list.empty.title')}
          description={t('list.empty.description')}
          action={
            canManage ? (
              <Button onClick={onCreate}>
                <Plus className="size-4" aria-hidden />
                {t('list.empty.action')}
              </Button>
            ) : undefined
          }
        />
      )}

      {jobs !== null && !error && jobs.length > 0 && (
        <div className="space-y-4">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              projectId={projectId}
              projectCollection={projectCollection}
              job={job}
              canManage={canManage}
              onEdit={onEdit}
              onChanged={handleChanged}
              onDeleted={handleDeleted}
            />
          ))}
        </div>
      )}
    </section>
  )
}
