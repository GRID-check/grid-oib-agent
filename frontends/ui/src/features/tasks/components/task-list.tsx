'use client'

/**
 * The project's delegated work as ONE list with two shapes (ADR-0051).
 *
 * Templates are recurring schedules — jobs with a cron — and instances are
 * single runs, each of which happened once. The two are deliberately NOT one
 * row shape: a template answers "when does this fire next, and is it paused"
 * (cadence chip + next fire + enable switch inline), an instance answers
 * "where did this one get to, how was it judged, where is its result" (planner
 * status + review + result link). A shared row would average both questions
 * into neither.
 *
 * Read-only except the template's pause switch. Reviewing happens in the
 * inbox, where the person was told about the result; editing a schedule
 * happens on the Jobs tab, which is the schedule management.
 *
 * A failed tasks load errors INLINE in the instances group — a task-fail never
 * hides healthy schedules. Only the templates group answers to the jobs load
 * (`jobsLoading` / `jobsFailed`); the two fetches fail independently, so the
 * two groups report independently.
 */

import { CalendarClock, CheckCircle2, CircleDashed, FileText, MessageSquare, XCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useState } from 'react'

import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import type { TaskStatus } from '@/lib/tasks/task-vocabulary'
import { updateJob, type Job } from '@/adapters/api/jobs-client'
import { scheduleSummary } from '@/features/jobs/components/job-list'
import type { TaskWireRow } from '../lib/task-view'

/**
 * The chip tone per status — a `Record`, so a status added to the tuple has to
 * be given a colour before this compiles.
 *
 * `interrupted` is a warning and not an error on purpose: the run was stopped,
 * which is a thing a person did or a budget did, and painting it red would put
 * it beside the failures a person has to look into.
 */
const STATUS_TONE: Record<TaskStatus, 'muted' | 'info' | 'success' | 'destructive' | 'warning'> = {
  queued: 'muted',
  running: 'info',
  succeeded: 'success',
  failed: 'destructive',
  interrupted: 'warning',
}

const REVIEW_ICON: Record<'accepted' | 'rejected', LucideIcon> = {
  accepted: CheckCircle2,
  rejected: XCircle,
}

export interface TaskListProps {
  projectId: string
  tasks: readonly TaskWireRow[]
  /** All of the project's jobs; the recurring ones render as the templates group. */
  jobs: readonly Job[]
  jobsLoading?: boolean
  jobsFailed?: boolean
  onRetryJobs?: () => void
  loading?: boolean
  failed?: boolean
  /** Whether this member may pause/resume schedules (`project:skills:manage`). */
  canManageJobs?: boolean
  onJobChanged?: (job: Job) => void
  onSelectTask?: (task: TaskWireRow) => void
  onSelectJob?: (job: Job) => void
}

/**
 * The recurring schedules among the jobs: a template is a job WITH a timer.
 * A manual-only job has no cadence to show inline and stays on the Jobs tab,
 * which is the schedule management — putting it here would be a template row
 * with nothing a template row promises.
 */
export function recurringJobs(jobs: readonly Job[]): Job[] {
  return jobs.filter((job) => job.scheduleCron !== null)
}

export function TaskList({
  projectId,
  tasks,
  jobs,
  jobsLoading,
  jobsFailed,
  onRetryJobs,
  loading,
  failed,
  canManageJobs,
  onJobChanged,
  onSelectTask,
  onSelectJob,
}: TaskListProps): JSX.Element {
  const t = useTranslations('tasks')
  const tj = useTranslations('jobs')
  const { locale } = useLocale()
  const templates = recurringJobs(jobs)

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4 md:p-6" data-testid="task-list-loading">
        {[0, 1, 2].map((row) => (
          <div key={row} className="rounded-lg border p-3">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="mt-2 h-3.5 w-full" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6" data-testid="task-list">
      <section aria-label={t('groups.templates')} data-testid="task-templates">
        <SectionLabel as="h2">{t('groups.templates')}</SectionLabel>
        {jobsLoading ? (
          <div className="mt-2 flex flex-col gap-2" data-testid="template-list-loading" aria-hidden="true">
            {[0, 1].map((row) => (
              <div key={row} className="rounded-lg border p-3">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="mt-2 h-3.5 w-3/5" />
              </div>
            ))}
          </div>
        ) : jobsFailed ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground text-sm">{t('groups.templatesError')}</p>
            {onRetryJobs && (
              <button
                type="button"
                onClick={onRetryJobs}
                className="text-primary text-sm font-medium hover:underline"
              >
                {tj('tryAgain')}
              </button>
            )}
          </div>
        ) : templates.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">{t('groups.templatesEmpty')}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {templates.map((job) => (
              <TemplateRow
                key={job.id}
                job={job}
                canManage={canManageJobs ?? false}
                onChanged={onJobChanged}
                onSelect={onSelectJob}
                tj={tj}
                locale={locale}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t('groups.instances')}>
        <SectionLabel as="h2">{t('groups.instances')}</SectionLabel>
        {failed ? (
          // Inline, never whole-list: the schedules above are healthy — their
          // load already answered — and hiding them behind a task failure
          // would report on work this error says nothing about.
          <div className="mt-2">
            <EmptyState
              icon={CircleDashed}
              tone="destructive"
              title={t('list.errorTitle')}
              description={t('list.errorDescription')}
            />
          </div>
        ) : tasks.length === 0 ? (
          <div className="mt-2">
            <EmptyState
              icon={CircleDashed}
              title={t('list.emptyTitle')}
              description={t('list.emptyDescription')}
            />
          </div>
        ) : (
          <ul className="mt-2 flex flex-col gap-2" data-testid="task-instances">
            {tasks.map((task) => (
              <InstanceRow
                key={task.id}
                projectId={projectId}
                task={task}
                onSelect={onSelectTask}
                t={t}
                locale={locale}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

type Translate = ReturnType<typeof useTranslations>

/**
 * One recurring schedule. Cadence chip + next fire + the pause switch inline —
 * everything a template promises, nothing an instance carries (no planner
 * status: a schedule is not work, so it has no lifecycle to report).
 */
function TemplateRow({
  job,
  canManage,
  onChanged,
  onSelect,
  tj,
  locale,
}: {
  job: Job
  canManage: boolean
  onChanged: ((job: Job) => void) | undefined
  onSelect: ((job: Job) => void) | undefined
  tj: Translate
  locale: string
}): JSX.Element {
  const nextRun = job.nextRunAt
    ? tj('list.nextRun', { time: formatRelativeTime(job.nextRunAt, locale) })
    : null
  const lastRun = job.lastRunAt
    ? tj('list.lastRun', { time: formatRelativeTime(job.lastRunAt, locale) })
    : tj('list.neverRun')

  return (
    <li className="rounded-lg border bg-card p-3" data-testid="template-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onSelect?.(job)}
              className="text-foreground min-w-0 truncate text-sm font-semibold hover:underline"
              title={job.name}
              data-testid="template-title"
            >
              {job.name}
            </button>
            {!job.enabled && (
              <Chip size="sm" variant="outline" data-testid="template-disabled">
                {tj('list.disabled')}
              </Chip>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Chip size="sm" variant="info" data-testid="template-cadence">
              <CalendarClock aria-hidden className="size-3.5" />
              {scheduleSummary(tj, job.scheduleCron, job.scheduleTimezone)}
            </Chip>
            <span
              className="card-caption text-muted-foreground"
              data-testid="template-next"
              title={job.nextRunAt ? formatAbsoluteTime(job.nextRunAt, locale) : undefined}
            >
              {nextRun ? `${nextRun} · ${lastRun}` : lastRun}
            </span>
          </div>
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center pt-0.5">
            <ScheduleEnableSwitch job={job} onChanged={onChanged} tj={tj} />
          </div>
        )}
      </div>
    </li>
  )
}

/**
 * The pause switch a template row and the template detail share. Optimistic —
 * reverts on failure — exactly like the Jobs tab's own switch, because it IS
 * the same decision about the same schedule.
 */
export function ScheduleEnableSwitch({
  job,
  onChanged,
  tj,
}: {
  job: Job
  onChanged: ((job: Job) => void) | undefined
  tj: Translate
}): JSX.Element {
  const [toggling, setToggling] = useState(false)

  const toggleEnabled = async (enabled: boolean) => {
    setToggling(true)
    onChanged?.({ ...job, enabled })
    try {
      const updated = await updateJob(job.projectId, job.id, { enabled })
      onChanged?.(updated)
    } catch {
      onChanged?.({ ...job, enabled: !enabled })
      toast.error(tj('list.toggleError'))
    } finally {
      setToggling(false)
    }
  }

  return (
    <>
      {toggling && <Spinner size="sm" />}
      <Switch
        checked={job.enabled}
        disabled={toggling}
        onCheckedChange={(checked) => void toggleEnabled(checked)}
        aria-label={
          job.enabled
            ? tj('list.disableAria', { name: job.name })
            : tj('list.enableAria', { name: job.name })
        }
      />
    </>
  )
}

function InstanceRow({
  projectId,
  task,
  onSelect,
  t,
  locale,
}: {
  projectId: string
  task: TaskWireRow
  onSelect: ((task: TaskWireRow) => void) | undefined
  t: Translate
  locale: string
}): JSX.Element {
  const requester = task.requesterName
  const ReviewIcon = task.review ? REVIEW_ICON[task.review] : null
  // Canonical homes, not history: a filed result lives in the project's files,
  // a chat run is continued in the project's chat. The old `/documents/…` and
  // `/chat/…` hrefs named routes that do not exist.
  const documentHref = task.filedDocumentId
    ? `/app/projects/${encodeURIComponent(projectId)}/files?doc=${encodeURIComponent(task.filedDocumentId)}`
    : null
  const conversationHref = task.conversationId
    ? `/app/projects/${encodeURIComponent(projectId)}/chat?session=${encodeURIComponent(task.conversationId)}`
    : null

  return (
    <li className="rounded-lg border p-3" data-testid="task-row">
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="outline" data-testid="task-kind">
          {t(`kind.${task.kind}`)}
        </Chip>
        <button
          type="button"
          onClick={() => onSelect?.(task)}
          className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
          title={task.title}
          data-testid="task-title"
        >
          {task.title}
        </button>
        <Chip size="sm" variant={STATUS_TONE[task.status]} data-testid="task-status">
          {t(`status.${task.status}`)}
        </Chip>
        {ReviewIcon && task.review && (
          <Chip
            size="sm"
            variant={task.review === 'accepted' ? 'success' : 'destructive'}
            data-testid="task-review"
          >
            <ReviewIcon aria-hidden />
            {t(`review.${task.review}`)}
          </Chip>
        )}
      </div>

      {/* The requester's own sentence. A job-fired run has none — its title IS
          the job's name — and an empty line is better than the prompt. */}
      {task.goal && <p className="card-caption mt-1.5 text-muted-foreground">{task.goal}</p>}

      {/* What a reviewer said when they sent it back. The words are theirs and
          are never paraphrased: the next run reads exactly this string. */}
      {task.review === 'rejected' && task.reviewReason && (
        <p className="card-caption mt-1.5 text-muted-foreground" data-testid="task-review-reason">
          {task.reviewReason}
        </p>
      )}

      {task.status === 'failed' && task.error && (
        <p className="card-caption mt-1.5 text-error" data-testid="task-error">
          {task.error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="card-caption text-muted-foreground">
          {requester
            ? t('meta.byOn', { name: requester, when: formatRelativeTime(task.createdAt, locale) })
            : t('meta.on', { when: formatRelativeTime(task.createdAt, locale) })}
        </span>
        {/* Where the result IS. The one thing a list of finished work has to
            answer, and the reason the row does not try to summarise it. */}
        {documentHref && (
          <a
            className="card-caption text-primary inline-flex items-center gap-1 hover:underline"
            href={documentHref}
            data-testid="task-document-link"
          >
            <FileText aria-hidden className="size-3.5" />
            {t('meta.document')}
          </a>
        )}
        {conversationHref && (
          <a
            className="card-caption text-primary inline-flex items-center gap-1 hover:underline"
            href={conversationHref}
            data-testid="task-conversation-link"
          >
            <MessageSquare aria-hidden className="size-3.5" />
            {t('detail.continueChat')}
          </a>
        )}
      </div>
    </li>
  )
}
