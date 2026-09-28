'use client'

/**
 * One schedule in detail, as a drawer over the Zeitplan tab.
 *
 * The drawer holds no copy of its own — the panel resolves the selection
 * against the live list on every render, so a poll landing while it is open
 * moves it, and a schedule deleted elsewhere reads as gone rather than as a
 * stale snapshot.
 *
 * The three upcoming fire times at the top are the point of the surface. A cron
 * expression, and even the sentence built from one, is a CLAIM the reader
 * cannot check: „Monatlich am 1. um 06:00" is right up until the month it is
 * not. Three real dates turn it into something checkable at a glance, and they
 * come from the same library the scheduler advances the row with — so what is
 * shown is what will happen, not a second opinion about it.
 *
 * Delete lives here rather than on the card. It is the one irreversible thing
 * in this section (the run history goes with it), and an irreversible control
 * does not belong on a surface a person scans.
 */

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { CalendarClock, Pencil, Play, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SectionLabel } from '@/components/ui/section-label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { deleteJob, runJob, JobApiError, type Job } from '@/adapters/api/jobs-client'
import { capturePosthog } from '@/lib/analytics/posthog'
import { JobRunHistory } from './job-run-history'
import { ScheduleEnableSwitch } from './schedule-card'
import { nextOccurrences } from '../lib/occurrences'
import { whenSummary } from '../lib/schedule'

/** How many upcoming fire times the drawer proves the schedule with. */
const PREVIEW_COUNT = 3

interface ScheduleDetailProps {
  projectId: string
  projectCollection: string | null
  /** The schedule the drawer is showing, or null when it is shut or gone. */
  job: Job | null
  open: boolean
  /** Whether this member may pause/edit/run/delete (`project:skills:manage`). */
  canManage: boolean
  /**
   * Why the selection resolves to nothing. `deleted` is a row the drawer saw
   * and that left; `unresolved` is a deep link that never matched one here.
   */
  goneReason?: 'deleted' | 'unresolved'
  /** The deep link has not been checked against a loaded list yet. */
  resolving?: boolean
  onChanged?: (job: Job) => void
  onDeleted?: (jobId: string) => void
  onEdit?: (job: Job) => void
  onClose: () => void
}

export function ScheduleDetail({
  projectId,
  projectCollection,
  job,
  open,
  canManage,
  goneReason = 'deleted',
  resolving = false,
  onChanged,
  onDeleted,
  onEdit,
  onClose,
}: ScheduleDetailProps): JSX.Element {
  const t = useTranslations('tasks')
  const tj = useTranslations('jobs')
  const tCommon = useTranslations('common')

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        closeLabel={t('detail.close')}
        data-testid="schedule-detail"
        className="flex flex-col"
      >
        {job ? (
          <ScheduleDetailBody
            projectId={projectId}
            projectCollection={projectCollection}
            job={job}
            canManage={canManage}
            onChanged={onChanged}
            onDeleted={onDeleted}
            onEdit={onEdit}
          />
        ) : (
          <div className="py-8">
            <SheetHeader>
              <SheetTitle>{resolving ? t('detail.loadingTitle') : t('detail.goneTitle')}</SheetTitle>
            </SheetHeader>
            {resolving ? (
              <p className="text-muted-foreground mt-2 flex items-center gap-2 text-sm">
                <Spinner size="sm" aria-hidden />
                {tCommon('states.loading')}
              </p>
            ) : (
              <p className="text-muted-foreground mt-2 text-sm">
                {goneReason === 'unresolved' ? t('detail.goneUnresolved') : t('detail.gone')}
              </p>
            )}
          </div>
        )}
        <span className="sr-only">{tj('title')}</span>
      </SheetContent>
    </Sheet>
  )
}

function ScheduleDetailBody({
  projectId,
  projectCollection,
  job,
  canManage,
  onChanged,
  onDeleted,
  onEdit,
}: {
  projectId: string
  projectCollection: string | null
  job: Job
  canManage: boolean
  onChanged: ((job: Job) => void) | undefined
  onDeleted: ((jobId: string) => void) | undefined
  onEdit: ((job: Job) => void) | undefined
}): JSX.Element {
  const t = useTranslations('tasks')
  const tj = useTranslations('jobs')
  const { locale } = useLocale()
  const [running, setRunning] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Remounts the run history so a just-started run shows up immediately.
  const [historyToken, setHistoryToken] = useState(0)
  const upcoming = useUpcoming(job)

  const runNow = async () => {
    setRunning(true)
    try {
      const result = await runJob(projectId, job.id)
      if (result.status === 'submitted') {
        // Carried over from the retired job card, unchanged.
        capturePosthog('job_run_submitted', { output: job.output })
        // Retry with the same plan: the schedule, prompt and skill are
        // untouched, only a new run is fired — it appears in the history below.
        toast.success(tj('run.submitted'), { description: tj('run.submittedDetail') })
        setHistoryToken((token) => token + 1)
        onChanged?.({ ...job, lastRunAt: new Date().toISOString() })
      } else if (result.status === 'skipped') {
        toast.warning(tj('run.skipped'), { description: result.detail ?? undefined })
      } else {
        toast.error(tj('run.error'), { description: result.detail ?? undefined })
      }
    } catch (err) {
      if (err instanceof JobApiError && err.status === 409) {
        // The row was stale-enabled: the schedule is paused server-side, so it
        // moves now rather than on the next poll — the paused chip, the switch
        // and the disabled retry all render from this one object.
        onChanged?.({ ...job, enabled: false })
        toast.error(tj('run.disabled'))
      } else {
        toast.error(tj('run.error'))
      }
    } finally {
      setRunning(false)
    }
  }

  const confirmDelete = async () => {
    setDeleting(true)
    try {
      await deleteJob(projectId, job.id)
      capturePosthog('job_deleted', { output: job.output })
      setConfirmOpen(false)
      onDeleted?.(job.id)
    } catch {
      toast.error(tj('deleteDialog.error'))
    } finally {
      setDeleting(false)
    }
  }

  const lastRun = job.lastRunAt
    ? tj('list.lastRun', { time: formatRelativeTime(job.lastRunAt, locale) })
    : tj('list.neverRun')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-2 pr-1">
      <SheetHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="secondary">
            {tj(`list.output.${job.output}`)}
          </Chip>
          {!job.enabled && (
            <Chip size="sm" variant="outline">
              {tj('list.disabled')}
            </Chip>
          )}
        </div>
        <SheetTitle className="mt-2 text-left">{job.name}</SheetTitle>
        <SheetDescription className="text-left" data-testid="schedule-detail-cadence">
          {whenSummary(tj, job, locale)}
        </SheetDescription>
      </SheetHeader>

      <section aria-label={t('detail.schedule')}>
        <div className="flex items-center justify-between gap-3">
          <SectionLabel as="h2">{t('detail.schedule')}</SectionLabel>
          {canManage && <ScheduleEnableSwitch job={job} onChanged={onChanged} t={tj} />}
        </div>

        {/* The claim, made checkable. See the module docstring. */}
        <div className="bg-muted mt-2 rounded-lg p-3" data-testid="schedule-detail-upcoming">
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <CalendarClock className="size-3.5 shrink-0" aria-hidden />
            {tj('builder.upcomingLabel')}
          </p>
          {upcoming === null ? (
            <p className="text-muted-foreground mt-1.5 flex items-center gap-2 text-sm">
              <Spinner size="sm" aria-hidden />
            </p>
          ) : upcoming.length === 0 ? (
            <p className="text-muted-foreground mt-1.5 text-sm">{tj('builder.upcomingNone')}</p>
          ) : (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {upcoming.map((at) => (
                <li key={at.toISOString()} className="text-foreground text-sm tabular-nums">
                  {formatAbsoluteTime(at.toISOString(), locale)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-muted-foreground mt-2 text-xs">{lastRun}</p>
        <p className="text-muted-foreground mt-1.5 flex min-w-0 items-center gap-1.5 text-xs">
          <Sparkles className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {job.skillName ? tj('list.withSkill', { name: job.skillName }) : tj('list.noSkill')}
          </span>
        </p>

        {canManage && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void runNow()} disabled={running || !job.enabled} aria-busy={running}>
              {running ? <Spinner size="sm" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
              {tj('actions.runNow')}
            </Button>
            {onEdit && (
              <Button size="sm" variant="outline" onClick={() => onEdit(job)} data-testid="schedule-detail-edit">
                <Pencil className="size-3.5" aria-hidden />
                {t('detail.edit')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive ml-auto"
              onClick={() => setConfirmOpen(true)}
              data-testid="schedule-detail-delete"
            >
              <Trash2 className="size-3.5" aria-hidden />
              {tj('actions.delete')}
            </Button>
          </div>
        )}
      </section>

      <section aria-label={t('detail.prompt')}>
        <SectionLabel as="h2">{t('detail.prompt')}</SectionLabel>
        <p
          className="bg-muted mt-2 whitespace-pre-wrap rounded-lg p-3 font-mono text-xs leading-relaxed"
          data-testid="schedule-detail-prompt"
        >
          {job.prompt}
        </p>
      </section>

      <section aria-label={t('detail.runs')}>
        <SectionLabel as="h2">{t('detail.runs')}</SectionLabel>
        <div className="mt-2" data-testid="schedule-detail-runs">
          <JobRunHistory
            key={historyToken}
            projectId={projectId}
            projectCollection={projectCollection}
            jobId={job.id}
          />
        </div>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tone="destructive"
        title={tj('deleteDialog.title')}
        description={tj('deleteDialog.description', { name: job.name })}
        confirmLabel={tj('deleteDialog.confirm')}
        cancelLabel={tj('deleteDialog.cancel')}
        pending={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

/**
 * The next few fire times, or `null` while they are being computed.
 *
 * `null` rather than an empty array during the load, because the two mean
 * different things: "not worked out yet" is a spinner and "never fires again"
 * is a sentence, and showing the sentence first would be a claim the drawer has
 * not earned.
 */
function useUpcoming(job: Job): Date[] | null {
  const [upcoming, setUpcoming] = useState<Date[] | null>(null)
  const cron = job.scheduleCron
  const timezone = job.scheduleTimezone
  const enabled = job.enabled

  useEffect(() => {
    if (!cron || !enabled) {
      setUpcoming([])
      return
    }
    let cancelled = false
    setUpcoming(null)
    void nextOccurrences(cron, timezone, PREVIEW_COUNT).then((dates) => {
      if (!cancelled) setUpcoming(dates)
    })
    return () => {
      cancelled = true
    }
  }, [cron, timezone, enabled])

  return upcoming
}
