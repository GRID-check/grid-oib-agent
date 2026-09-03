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
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
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

/**
 * The card grid, and why it breaks where it does.
 *
 * A job card's floor is its action row — run / edit / delete side by side is
 * ~376px of buttons, and it must not wrap. Two columns therefore start at `lg`
 * (1024px → ~440px of card interior) rather than `md`, where 2-up would leave
 * ~320px and split the actions over two lines; three columns start at `2xl`
 * (1536px → ~450px) rather than `xl`, where 3-up would leave ~365px and do the
 * same. So the widths are chosen by what has to fit, not by the breakpoint
 * names.
 */
const GRID_CLASS = 'grid gap-4 lg:grid-cols-2 2xl:grid-cols-3'

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
    // The product's card anatomy (components/ui/raised-card): a white block
    // laid into a subtler tray, with the quiet metadata showing on the tray
    // beneath it. Not `interactive` — a job card is a container with its own
    // buttons, and a hover-lift would promise a click on the card that does
    // not exist.
    <RaisedCard>
      <RaisedCardBody className="flex flex-1 flex-col gap-4 px-4 pb-4 pt-4 sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <div
            className={cn(
              'min-w-0 space-y-1.5 transition-opacity duration-quick ease-out motion-reduce:transition-none',
              !job.enabled && 'opacity-45',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-foreground truncate text-sm font-semibold">{job.name}</h3>
              <Badge variant="secondary">{t(`list.output.${job.output}`)}</Badge>
              {!job.enabled && <Badge variant="outline">{t('list.disabled')}</Badge>}
            </div>
            {/* The prompt, verbatim and clamped to a fixed three lines: in a
                grid the card is a third of the page wide, and an unclamped
                prompt would set the height of every card in its row. */}
            <p className="text-muted-foreground line-clamp-3 text-sm">{job.prompt}</p>
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

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <CalendarClock className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {scheduleSummary(t, job.scheduleCron, job.scheduleTimezone)}
            </span>
          </span>
          {/* No skill is the common case, and it is stated rather than left
              blank: a missing line reads as missing information. A skill name
              is user-chosen and can be long, so it truncates rather than
              pushing the rest of the row onto another line. */}
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <Sparkles className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {job.skillName ? t('list.withSkill', { name: job.skillName }) : t('list.noSkill')}
            </span>
          </span>
        </div>

        {/* `mt-auto` pins the actions to the bottom of the white block, so in
            a grid row of unequal content the buttons line up across cards
            instead of floating at whatever height the prompt above them
            happened to end. */}
        <div className="mt-auto">
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => void runNow()}
                disabled={running || !job.enabled}
                aria-busy={running}
              >
                {/* Both labels stay mounted so the button width does not jump
                    when "Run now" becomes "Running…". */}
                <span className="inline-grid justify-items-start">
                  <span
                    className={cn(
                      'col-start-1 row-start-1 inline-flex items-center gap-2',
                      running && 'invisible',
                    )}
                    aria-hidden={running}
                  >
                    <Play className="size-3.5" aria-hidden />
                    {t('actions.runNow')}
                  </span>
                  <span
                    className={cn(
                      'col-start-1 row-start-1 inline-flex items-center gap-2',
                      !running && 'invisible',
                    )}
                    aria-hidden={!running}
                  >
                    <Spinner size="sm" aria-hidden />
                    {t('actions.running')}
                  </span>
                </span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="job-edit"
                onClick={() => onEdit(job)}
              >
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
        </div>
      </RaisedCardBody>

      {/* The tray showing beneath the block: when it next runs, when it last
          did, and the way into the history. Quiet, temporal, secondary — the
          same role size · time plays on a file card. No divider: the surface
          change IS the separation. */}
      <RaisedCardFooter>
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen} className="w-full">
          {/* ONE row, never two. The meta and the disclosure share a line the
              way `size · time` does on a file card, so the tray reads the same
              on every card whether a job has a next run, a last run or neither.
              That is why the labels are terse ("Nächster Lauf", "Verlauf") and
              the times are joined by a middot rather than spaced apart: at grid
              width (~440px of interior) the full phrasings did not fit, and a
              row that wraps on some cards and not others is what made the grid
              look ragged. The meta truncates and the trigger never shrinks —
              if something has to give, it is the text that also exists in the
              history panel one click away. */}
          <div className="flex w-full items-center gap-2">
            <span
              className="min-w-0 truncate"
              title={job.lastRunAt ? formatAbsoluteTime(job.lastRunAt, locale) : undefined}
            >
              {nextRun ? `${nextRun} · ${lastRun}` : lastRun}
            </span>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground -my-1 ml-auto h-7 shrink-0 px-2"
              >
                <History className="size-3.5" aria-hidden />
                {t('actions.history')}
                <ChevronDown
                  className={cn(
                    'size-3.5 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
                    historyOpen && 'rotate-180',
                  )}
                  aria-hidden
                />
              </Button>
            </CollapsibleTrigger>
          </div>
          {/* Height comes from the Collapsible primitive — no entrance fade
              here, which would double-animate against it. */}
          <CollapsibleContent className="pt-1 duration-base ease-out motion-reduce:animate-none">
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
      </RaisedCardFooter>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tone="destructive"
        title={t('deleteDialog.title')}
        description={t('deleteDialog.description', { name: job.name })}
        confirmLabel={t('deleteDialog.confirm')}
        cancelLabel={t('deleteDialog.cancel')}
        pending={deleting}
        onConfirm={confirmDelete}
      />
    </RaisedCard>
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
    // The panel's bar owns the heading and the New-job action, so the list is
    // the cards and nothing else. `max-w` is a readability cap, not a column:
    // past ~1800px a third card would only make each one wider than a prompt
    // is worth reading.
    <section className="mx-auto w-full max-w-[1800px]" aria-label={t('list.heading')}>
      {jobs === null && !error && (
        // Structured card skeletons: each mirrors the card's own header row
        // (title + switch), two text rows and the action row, so the loading
        // state reads as jobs rather than slabs.
        <div className={GRID_CLASS} data-testid="jobs-loading" aria-hidden="true">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex h-52 flex-col gap-3 rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-4">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="size-6 shrink-0 rounded-full" />
              </div>
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
              <div className="mt-auto flex gap-2">
                <Skeleton className="h-8 w-24 rounded-md" />
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <Alert variant="destructive" className="mt-0">
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
        <div
          className={cn(
            GRID_CLASS,
            'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none',
          )}
        >
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
